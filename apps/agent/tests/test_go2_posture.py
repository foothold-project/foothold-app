"""No SDK imports, DDS or robot access: measured posture and real output boundary."""
import asyncio
import threading
import time
from types import SimpleNamespace as NS
import pytest

from foothold_agent.go2_direct.approval import Approval
from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.sdk import SportBoundary
from foothold_agent.go2_direct.server import DriveSession, ServerSink
from foothold_agent.go2_direct.sink import Go2Sink, OutputError, ZERO
from foothold_agent.link.client import Client, Settings
from test_go2_direct import Clock, FakeSport, command
from test_go2_feedback import low, sport
from test_setup_pairing import rig as gate_rig, OfflineSink, SERIAL


class Sport(FakeSport):
    posture_code = 0

    def StandUp(self):
        self.calls.append(('StandUp', ()))
        return self.posture_code

    def BalanceStand(self):
        self.calls.append(('BalanceStand', ()))
        return self.posture_code

    def StandDown(self):
        self.calls.append(('StandDown', ()))
        return self.posture_code


def rig(mode=5):
    clock, normal, emergency = Clock(), Sport(), Sport()
    feedback = Feedback(SERIAL, now=clock)
    sink = Go2Sink(normal, emergency, now=clock, offline_test_mode=True)
    feedback.sink = sink
    session = DriveSession(feedback, now=clock)
    client = Client(session, ServerSink(sink, session), Settings('ws://127.0.0.1/ws', 'fake-token'))
    client._emit(session.connect())
    count = 0

    def measured(mode=mode, **values):
        nonlocal count
        count += 1
        feedback.lowstate(low(count))
        feedback.sportmodestate(sport(count, mode=mode, **values))
        return feedback.consume(client)

    def frame(t, **values):
        client._emit(session.receive(dict(t=t, **values)))

    measured()
    frame('lease', lease_id='fake-lease', holder_type='USER')
    measured()
    sink.drain()
    normal.calls.clear(); emergency.calls.clear()
    return clock, sink, normal, emergency, session, client, measured, frame


def request(frame, action='stand_up', request_id='request'):
    frame('posture', request_id=request_id, lease_id='fake-lease', action=action)


def test_real_sport_boundaries_renew_past_thirty_minutes_and_revoke():
    gate, session, client, inputs, wall, clock, _, _, _ = gate_rig()
    made = []

    def connect(approval, *_):
        pair = tuple(SportBoundary(Sport(), approval, now=clock, wall=wall) for _ in range(2))
        made.extend(pair)
        return pair

    session.receive(dict(t='field_approval', expires_at=wall()+1800))
    gate.activate(object(), connect=connect, sink_factory=OfflineSink)
    active, epoch = gate.active, gate.epoch
    for _ in range(62):
        wall.value += 60; clock.value += 60
        inputs.lowstate(low()); inputs.sportmodestate(sport())
        session.receive(dict(t='field_approval', expires_at=wall()+1800))
        assert gate.allowed() and gate.active is active and gate.epoch == epoch
        for boundary in made:
            assert boundary.Move(1.5, 0., 0.) == 0
    assert clock() > 3600 and len(made) == 2
    gate.revoke()
    for boundary in made:
        with pytest.raises(PermissionError):
            boundary.Move(1.5, 0., 0.)
        with pytest.raises(PermissionError):
            boundary.StandUp()
        assert boundary.StopMove() == 0


def test_boundary_identity_and_expiry_apply_to_posture_too():
    clock = Clock()
    boundary = SportBoundary(Sport(), Approval('fake-nic', SERIAL, 1100), now=clock, wall=clock)
    with pytest.raises(PermissionError):
        boundary.renew(Approval('other-nic', SERIAL, 1200), deadline=1200)
    clock.value = 1100
    for call in (lambda: boundary.Move(1., 0., 0.), boundary.StandUp, boundary.StandDown, boundary.BalanceStand):
        with pytest.raises(PermissionError): call()
    assert boundary.Move(*ZERO) == boundary.StopMove() == 0


@pytest.mark.parametrize('mode,height,state', [(5,.1,'LYING'), (0,.3,'STANDING'),
    (1,.3,'STANDING'), (3,.3,'STANDING'), (8,.15,'TRANSITIONING'),
    (7,.1,'UNKNOWN'), (6,.3,'UNKNOWN'), (42,.3,'UNKNOWN'), (0,.1,'UNKNOWN')])
def test_documented_modes_and_freshness(mode, height, state):
    clock, sink, _, _, session, _, measured, _ = rig()
    measured(mode, body_height=height)
    assert session._state()['posture'] == dict(state=state, mode=mode)
    clock.value += .201
    assert session._state()['posture'] == dict(state='UNKNOWN', mode=None)


def test_lying_keeps_session_stop_confirmation_and_ignores_motion_and_stop_rejection():
    _, sink, normal, emergency, session, _, measured, frame = rig()
    normal.result = emergency.result = 42
    frame('stop', stop_ref=25)
    measured()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[1.5, 0., 0.])
    sink.drain(); sink.emergency_stop()
    measured()
    assert session.connected and session.lease_confirmed and sink.error is None
    assert session._state()['stop_ref'] == 25
    assert session.core.intent == sink.pending == ZERO
    assert normal.calls == [('StopMove', ())]
    assert emergency.calls == [('StopMove', ())]


def test_standing_stop_rejection_remains_fatal():
    _, sink, normal, emergency, _, _, _, frame = rig(0)
    normal.result = emergency.result = 42
    frame('stop', stop_ref=25)
    with pytest.raises(OutputError): sink.drain()
    assert sink.error is not None
    assert normal.calls[:2] == [('Move', ZERO), ('StopMove', ())]


def test_stand_up_waits_for_measurements_then_balance_then_fresh_confirmation():
    _, sink, normal, _, session, _, measured, frame = rig()
    request(frame)
    assert sink.posture_result['status'] == 'RUNNING'
    sink.drain()
    assert ('StandUp', ()) in normal.calls
    measured(8); sink.drain()
    assert ('BalanceStand', ()) not in normal.calls
    measured(0); sink.drain()
    assert normal.calls[-1] == ('BalanceStand', ())
    sink.drain()
    assert sink.posture_result['status'] == 'RUNNING'
    measured(1); sink.drain()
    assert sink.posture_result['status'] == 'SUCCEEDED'
    assert session.core.latch and sink.latched
    assert not any(name == 'Move' and velocity != ZERO for name, velocity in normal.calls)


def test_stand_down_stops_before_lowering_and_requires_measured_lying():
    _, sink, normal, _, session, _, measured, frame = rig(0)
    request(frame, 'stand_down')
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    assert session.core.latch and sink.latched
    sink.drain()
    index = normal.calls.index(('StandDown', ()))
    assert normal.calls[index-1] == ('StopMove', ())
    assert sink.posture_result['status'] == 'RUNNING'
    measured(5, body_height=.1); sink.drain()
    assert sink.posture_result == dict(request_id='request', action='stand_down',
        status='SUCCEEDED', code='CONFIRMED', sdk_code=0)


def test_stand_down_prestop_rejection_keeps_code_and_faults_standing_output():
    _, sink, normal, _, _, _, measured, frame = rig(0)
    count = 0
    def stop():
        nonlocal count
        count += 1
        normal.calls.append(('StopMove', ()))
        return 43 if count == 2 else 0
    normal.StopMove = stop
    request(frame, 'stand_down')
    measured(0)  # fresh evidence for the STOP generation created by request
    with pytest.raises(OutputError): sink.drain()
    assert sink.posture_result['status'] == 'FAILED'
    assert sink.posture_result['sdk_code'] == 43
    assert sink.error is not None and ('StandDown', ()) not in normal.calls


@pytest.mark.parametrize('condition,code', [('lease','NOT_AUTHORIZED'), ('gate','NOT_AUTHORIZED'),
    ('input','MOVING'), ('ramp','MOVING'), ('measured','MOVING'), ('posture','WRONG_POSTURE')])
def test_posture_conditions(condition, code):
    _, sink, normal, _, session, _, measured, frame = rig()
    if condition == 'lease': session.lease_confirmed = False
    if condition == 'gate': session.posture_gate = lambda: False
    if condition == 'input': session.core.intent = (1.5, 0., 0.)
    if condition == 'ramp': sink._ramp_velocity = (.1, 0., 0.)
    if condition == 'measured': measured(5, velocity=(.1, 0., 0.))
    if condition == 'posture': measured(0)
    # Preserve intent until receive's normal _advance validates it: direct sink
    # test for ramp/measurement; session's nonzero output is separately covered.
    if condition == 'input':
        session.core.out = (.1, 0., 0.)
        sink.pending = (.1, 0., 0.)
    request(frame)
    assert sink.posture_result['status'] == 'REJECTED'
    assert sink.posture_result['code'] == code
    sink.drain()
    assert not any(name in ('StandUp', 'StandDown', 'BalanceStand') for name, _ in normal.calls)


def test_duplicate_is_rejected_and_stop_cancels_remaining_stages_only_stopmove():
    _, sink, normal, emergency, _, _, measured, frame = rig()
    request(frame)
    sink.drain()
    request(frame, request_id='duplicate')
    assert sink.posture_result['code'] == 'BUSY'
    frame('stop', stop_ref=20)
    sink.check_watchdog()
    assert emergency.calls == [('StopMove', ())]
    measured(0); sink.drain()
    assert sink.posture_result['code'] == 'STOPPED'
    assert ('BalanceStand', ()) not in normal.calls
    assert not any(name == 'Damp' for name, _ in normal.calls+emergency.calls)


def test_stop_during_blocked_posture_rpc_uses_independent_stopmove_lane():
    _, sink, normal, emergency, _, _, _, frame = rig()
    entered, release = threading.Event(), threading.Event()
    def stand_up():
        normal.calls.append(('StandUp', ()))
        entered.set()
        assert release.wait(1)
        return 0
    normal.StandUp = stand_up
    request(frame)
    worker = threading.Thread(target=sink.drain)
    worker.start()
    try:
        assert entered.wait(1)
        before = time.monotonic()
        frame('stop', stop_ref=20)
        sink.check_watchdog()
        assert time.monotonic()-before < .1
        assert emergency.calls == [('StopMove', ())]
        assert sink.posture_result['code'] == 'STOPPED'
    finally:
        release.set(); worker.join(1)
    assert not worker.is_alive() and ('BalanceStand', ()) not in normal.calls


def test_watchdog_cancels_posture_without_releasing_joint_forces():
    clock, sink, _, emergency, _, _, _, frame = rig()
    request(frame)
    sink.drain()
    clock.value += .301
    sink.check_watchdog()
    assert sink.posture_result['code'] == 'WATCHDOG'
    # Stale posture cannot excuse a rejected StopMove; this fake accepts it.
    assert emergency.calls == [('StopMove', ())]


@pytest.mark.parametrize('failure', ['sdk', 'authority', 'timeout'])
def test_posture_failure_reports_without_disconnecting(failure):
    clock, sink, normal, _, session, _, measured, frame = rig()
    request(frame)
    if failure == 'sdk': normal.posture_code = 73
    sink.drain()
    if failure == 'authority': session.lease_confirmed = False
    elif failure == 'timeout':
        clock.value += 16
        measured()
    sink.drain()
    assert sink.posture_result['status'] == 'FAILED'
    if failure == 'sdk': assert sink.posture_result['sdk_code'] == 73
    assert session.connected and sink.error is None


@pytest.mark.parametrize('motion_state', [0, 1004])
def test_lying_approval_keeps_live_workers_transport_camera_and_mapping(motion_state):
    from foothold_agent.setup.runtime import Inputs, run
    from foothold_agent.setup.view import Status
    from test_setup_pairing import credentials, NIC_VALUE
    from test_setup_approval_runtime import until

    async def scenario():
        stop, seen = asyncio.Event(), {}
        inputs, clients = Inputs(), (Sport(), Sport())
        for client in clients: client.result = 42
        counts = dict(media=0, mapping=0)
        sequence = 0

        def pulse():
            nonlocal sequence
            sequence += 1
            inputs.lowstate(low(sequence))
            inputs.sportmodestate(sport(sequence, mode=5, body_height=.1, error_code=motion_state))
            seen['pulse'] = asyncio.get_running_loop().call_later(.01, pulse)

        class FakeClient(Client):
            async def _network(self):
                seen['client'] = self
                self._emit(self.session.connect())
                while not stop.is_set():
                    self._emit(self.session.receive(dict(t='ping')))
                    await asyncio.sleep(.02)

        async def observe(kind, enabled):
            while not stop.is_set():
                if enabled(): counts[kind] += 1
                await asyncio.sleep(.01)

        def mapping(session, *_args, enabled, **_kwargs):
            session.mapping = NS(suspend=lambda: None, close=lambda: None)
            return asyncio.create_task(observe('mapping', enabled))

        def media(*args):
            return NS(source=NS(close=lambda: None), run=lambda: observe('media', args[-1]))

        recorder = NS(notice='', stopped=threading.Event(), start=lambda: None, close=lambda: None)
        pulse()
        task = asyncio.create_task(run(credentials(), NIC_VALUE, inputs, object(), ready=True,
            check_nic=lambda: True, status=Status(), stop=stop, client_factory=FakeClient,
            connect=lambda *_args: clients, mapping_factory=mapping, media_factory=media,
            recorder_factory=lambda *_args, **_kw: recorder))
        try:
            await until(lambda: 'client' in seen and inputs.feedback.sample() is not None, task)
            client = seen['client']
            client._emit(client.session.receive(dict(t='field_approval', expires_at=time.time()+60)))
            await until(lambda: client.sink.active is not None and counts['media'] > 3 and counts['mapping'] > 3, task)
            active = client.sink.active
            client._emit(client.session.receive(dict(t='lease', lease_id='fake-lease', holder_type='USER')))
            client._emit(client.session.receive(dict(t='cmd', lease_id='fake-lease', seq=1, axes=[1.5,0,0])))
            await asyncio.sleep(.15)
            assert client.sink.active is active and client.session.connected
            assert active.sink.error is None and active.sink.pending == ZERO
            assert counts['media'] > 10 and counts['mapping'] > 10
            assert all(name == 'StopMove' for sdk_client in clients for name, _ in sdk_client.calls)
        finally:
            stop.set()
            seen['pulse'].cancel()
            await asyncio.wait_for(task, 3)
    asyncio.run(scenario())

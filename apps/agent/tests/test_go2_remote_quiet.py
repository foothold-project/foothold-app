"""Lease/remote-state boundary replay: fake SDK, no DDS or robot access."""
import pytest

from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.remote import REMOTE_MOTION_STATES
from foothold_agent.go2_direct.server import DriveSession, ServerSink
from foothold_agent.go2_direct.sink import Go2Sink, QUIET_STOP_MAX_S, ZERO
from foothold_agent.link.client import Client, Settings
from foothold_agent.link.session import MotionCommand
from test_go2_actions import send
from test_go2_direct import Clock, FakeSport
from test_go2_feedback import low, sport
from test_go2_posture import rig as posture_rig
from test_phone import physical_h
from test_go2_server_drive import rig


def sample(feedback, client, seq, *, dq=0., **values):
    feedback.lowstate(low(seq, dq=dq))
    feedback.sportmodestate(sport(seq, **values))
    return feedback.consume(client)


def idle_rig():
    now, normal, emergency = Clock(), FakeSport(), FakeSport()
    sink = Go2Sink(normal, emergency, now=now, offline_test_mode=True)
    feedback = Feedback('1234-5678', now=now)
    feedback.sink = sink
    session = DriveSession(feedback, now=now)
    client = Client(session, ServerSink(sink, session), Settings('ws://127.0.0.1/ws', 'fake-token'))
    client._emit(session.connect())
    return now, sink, session, client


@pytest.mark.parametrize('code', [0, *sorted(REMOTE_MOTION_STATES), 9999])
def test_no_lease_never_outputs_or_relatches_on_feedback(code, caplog):
    now, sink, session, client = idle_rig()
    generation = session.core.stop_gen
    for seq in range(1, 51):
        now.value += .05
        sample(session.feedback, client, seq, error_code=code, dq=.155)
        client._emit(session.tick())
        sink.drain()
        sink.check_watchdog()
        session.feedback.telemetry()
    assert not sink.client.calls and not sink.emergency_client.calls
    assert session.core.stop_gen == generation
    assert caplog.text.count('조용히 시작') == 1
    assert caplog.text.count('리모컨 상태값') == int(code in REMOTE_MOTION_STATES)


@pytest.mark.parametrize('code', sorted(REMOTE_MOTION_STATES))
def test_owned_remote_state_blocks_motion_without_stop_or_feedback_loss(code):
    now, sink, normal, emergency, session, client, _, frame = rig()
    normal.calls.clear()
    emergency.calls.clear()
    generation = session.core.stop_gen
    for seq in range(100, 125):
        now.value += .05
        assert not sample(session.feedback, client, seq, error_code=code, progress=.5, mode=2)
        assert session.feedback.healthy()
        frame('cmd', seq=seq, lease_id='fake-lease', axes=[1.5, 0., 0.])
        sink.drain()
        sink.check_watchdog()
    assert not normal.calls and not emergency.calls
    assert not sink.latched and not session.core.latch
    assert session.core.stop_gen == generation and session.lease_confirmed
    assert any('리모컨 동작 중' in d['label'] for d in session._state()['devices_changed'])
    assert session.feedback.telemetry()['status_code'] == dict(
        raw=code, level='ACCEPTED', reason='REMOTE_MOTION_STATE')


@pytest.mark.parametrize('owned', [False, True])
@pytest.mark.parametrize('emergency', [False, True])
def test_explicit_stop_dominates_remote_state_and_quiet_without_lease(owned, emergency):
    if owned:
        _, sink, _, _, session, client, _, _ = rig()
    else:
        _, sink, session, client = idle_rig()
    sample(session.feedback, client, 100, error_code=2010)
    sink.client.calls.clear()
    sink.emergency_client.calls.clear()
    if emergency:
        sink.emergency_stop()
    else:
        client._emit(session.receive(dict(t='stop', cause='user_stop')))
        sink.check_watchdog()
    sink.drain()
    assert ('StopMove', ()) in sink.emergency_client.calls
    assert ('StopMove', ()) in sink.client.calls


@pytest.mark.parametrize('release', ['lease', 'disconnect', 'transport_closed'])
def test_release_stops_once_per_existing_lane_then_confirmation_is_sticky(release):
    now, sink, normal, emergency, session, client, _, frame = rig()
    normal.calls.clear()
    emergency.calls.clear()
    if release == 'lease':
        frame('lease', lease_id=None, holder_type=None)
    elif release == 'disconnect':
        client._emit(session.disconnect())
    else:
        client._emit(session.transport_closed(1006, retry=True))
    sink.check_watchdog()
    sink.drain()
    assert normal.calls == emergency.calls == [('Move', ZERO), ('StopMove', ())]
    sample(session.feedback, client, 100)
    sink.check_watchdog()
    sink.drain()
    for seq in range(101, 145):
        now.value += .05
        # Exercise #479 motion/noise/staleness and fresh Core STOP generations.
        if seq % 3:
            sample(session.feedback, client, seq, dq=.155, velocity=(.4, 0., 0.))
        client._emit(session.tick())
        sink.apply(MotionCommand('stop', stop_generation=seq), source='server', operator_stop=False)
        sink.drain()
        sink.check_watchdog()
    assert normal.calls == emergency.calls == [('Move', ZERO), ('StopMove', ())]


@pytest.mark.parametrize('failure', [3104, 3102, 'exception'])
def test_release_unconfirmed_retries_only_within_one_deadline_then_new_lease_restores_policy(failure):
    now, sink, normal, emergency, session, client, _, frame = rig()
    attempts = []
    def stop():
        attempts.append(now())
        if failure == 'exception':
            raise TimeoutError('fake send failure')
        return failure
    normal.StopMove = emergency.StopMove = stop
    frame('lease', lease_id=None, holder_type=None)
    started = now()
    for _ in range(30):
        client._emit(session.tick())
        sink.check_watchdog()
        sink.drain()
        now.value += .21
    assert len(attempts) == 10
    assert all(0 <= stamp-started < QUIET_STOP_MAX_S for stamp in attempts)
    assert sink.error is None
    normal.StopMove = emergency.StopMove = lambda: attempts.append(now()) or 0
    client._emit(session.connect())  # expired transport needs the ordinary handshake
    frame('lease', lease_id='new', holder_type='USER')
    sink.check_watchdog()
    sink.drain()
    assert len(attempts) > 10


def test_unknown_owned_state_retains_existing_error_lock_and_stop():
    _, sink, _, _, session, client, _, _ = rig()
    assert not sample(session.feedback, client, 100, error_code=9999)
    client._emit(session.feedback_lost())
    sink.check_watchdog()
    assert sink.latched and session.core.latch
    assert session.feedback.telemetry()['status_code']['level'] == 'ERROR'
    assert ('StopMove', ()) in sink.emergency_client.calls


def test_health_reads_new_dds_receipts_without_refreshing_core_or_requiring_consume():
    now, _, session, client = idle_rig()
    sample(session.feedback, client, 1)
    sequence = session.core.state_seq
    for seq, code, healthy in ((2, 0, True), (3, 9999, False), (4, 2010, True)):
        session.feedback.lowstate(low(seq))
        session.feedback.sportmodestate(sport(seq, error_code=code))
        assert session.feedback.healthy() is healthy
        assert session.core.state_seq == sequence
    now.value += .201
    assert not session.feedback.healthy()


def test_settled_sitting_confirms_stop_ref_before_new_lease_without_walk_permission():
    _, sink, session, client = idle_rig()
    client._emit(session.receive(dict(t='stop', cause='lease_take', stop_ref=42)))
    assert not sample(session.feedback, client, 1, mode=10)
    assert session.core.st['stop_requested'] and session._state()['stop_ref'] == 42
    client._emit(session.receive(dict(t='lease', lease_id='new', holder_type='USER')))
    assert session.lease_confirmed and session.core.controller == 'new'
    assert not session.feedback.posture_snapshot()['walkable']


@pytest.mark.parametrize('code', [0, 1002])
def test_settled_sitting_allows_only_risesit_to_recover(code):
    _, sink, normal, _, _, _, measured, frame = posture_rig(10)
    measured(10, error_code=code)
    calls = []
    normal.RiseSit = lambda: calls.append('RiseSit') or 0
    send(frame, 'RiseSit')
    sink.drain()
    assert calls == ['RiseSit'] and sink.actions.result['status'] == 'SUCCEEDED'


@pytest.mark.parametrize('action', ['RecoveryStand', 'StopMove', 'Hello'])
def test_sitting_still_rejects_other_existing_actions(action):
    _, sink, _, _, _, _, _, frame = posture_rig(10)
    send(frame, action)
    assert sink.actions.result['code'] == 'STANDING_REQUIRED'


def test_moving_sitting_rejects_risesit():
    _, sink, _, _, _, _, measured, frame = posture_rig(10)
    measured(10, velocity=(.1, 0., 0.))
    send(frame, 'RiseSit')
    assert sink.actions.result['code'] == 'MOVING'


@pytest.mark.parametrize('values', [dict(mode=10, progress=.5), dict(mode=5, body_height=.1)])
def test_unsettled_or_lying_posture_cannot_use_sitting_recovery(values):
    _, sink, _, _, _, _, measured, frame = posture_rig(10)
    measured(**values)
    send(frame, 'RiseSit')
    assert sink.actions.result['code'] == 'STANDING_REQUIRED'


def test_direct_phone_uses_the_same_quiet_release_and_explicit_stop_policy(physical_h):
    from foothold_agent.go2_direct.phone import Go2Hub, PhoneSink
    h = physical_h
    sink = Go2Sink(FakeSport(), FakeSport(), now=h.clock, offline_test_mode=True)
    feedback = Feedback('1234-5678', now=h.clock)
    feedback.sink = sink
    sink.posture_feedback = feedback.posture_snapshot  # live go2_direct.runtime binding
    adapter = PhoneSink(sink)
    hub = Go2Hub(h.verifier, adapter, feedback=feedback, policy_name='test', policy_version='1',
                 simulation=False, now=h.clock, wall=h.clock.wall)
    adapter.hub = h.hub = hub
    peer, _, _ = h.connect()
    sample(feedback, hub, 1, error_code=1002)
    sink.check_watchdog()
    sink.drain()
    assert not sink.client.calls and not sink.emergency_client.calls
    sample(feedback, hub, 2)
    assert h.take(peer)['ok']
    assert h.send(peer, 'lease.release')['ok']
    sink.check_watchdog()
    sink.drain()
    assert sink.client.calls == sink.emergency_client.calls == [('Move', ZERO), ('StopMove', ())]
    sample(feedback, hub, 3)
    sink.drain()
    sink.client.calls.clear()
    sink.emergency_client.calls.clear()
    for seq in range(4, 30):
        h.clock.t += .05
        sample(feedback, hub, seq, error_code=2010, dq=.155)
        hub.tick()
        sink.check_watchdog()
        sink.drain()
    assert not sink.client.calls and not sink.emergency_client.calls
    assert h.send(peer, 'stop')['ok']
    sink.check_watchdog()
    assert ('StopMove', ()) in sink.emergency_client.calls


def test_phone_runtime_remote_state_is_healthy_but_unknown_and_stale_feedback_still_stop(monkeypatch, physical_h):
    import asyncio
    import time
    from types import SimpleNamespace as NS
    from foothold_agent.go2_direct import runtime
    h = physical_h
    stop_calls, hubs = [], []
    normal, emergency = FakeSport(), FakeSport()

    class Channel:
        enabled, code, sequence = True, 0, 0
        def subscribe(self, feedback):
            self.feedback = feedback
            self.emit()
        def emit(self):
            if self.enabled and hasattr(self, 'feedback'):
                self.sequence += 1
                self.feedback.lowstate(low(self.sequence))
                self.feedback.sportmodestate(sport(self.sequence, error_code=self.code))
        def close(self):
            pass

    async def scenario():
        channel, stop = Channel(), asyncio.Event()
        class Phone:
            def __init__(self, hub, *args, **kwargs):
                hubs.append(hub)
                original = hub.stop
                def observed_stop(**values):
                    stop_calls.append(values)
                    return original(**values)
                hub.stop = observed_stop
            async def run(self):
                await stop.wait()
            async def close(self):
                pass
        config = NS(approval=NS(robot_serial='1234-5678', expires_at=time.time()+60),
                    phone=NS(host='127.0.0.1', port=0, policy_name='test', policy_version='1'),
                    verifier=h.verifier, link=None)
        monkeypatch.setattr(runtime.sdk, 'connect', lambda *args, **kwargs: (normal, emergency))
        task = asyncio.create_task(runtime.run(config, {}, stop=stop,
            channel_factory=lambda env: channel, server_factory=Phone))
        async def until(predicate):
            async with asyncio.timeout(2):
                while not predicate():
                    channel.emit()
                    await asyncio.sleep(.01)
                    if task.done():
                        task.result()
        try:
            await until(lambda: hubs and hubs[0].session.core.st is not None)
            assert not normal.calls and not emergency.calls  # startup has no lease
            channel.code = 2010
            await until(lambda: channel.feedback.telemetry()['error_code'] == 2010)
            for _ in range(5):
                channel.emit()
                await asyncio.sleep(.02)
            assert not stop_calls and channel.feedback.healthy()
            assert not channel.feedback._last_ready
            channel.code = 9999
            await until(lambda: len(stop_calls) == 1)
            channel.code = 0
            await until(channel.feedback.healthy)
            channel.enabled = False
            await until(lambda: len(stop_calls) == 2)
            assert not channel.feedback.healthy()
        finally:
            stop.set()
            await asyncio.wait_for(task, 3)
    asyncio.run(scenario())

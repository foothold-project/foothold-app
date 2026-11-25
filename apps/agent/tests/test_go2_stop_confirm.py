"""Slow-response STOP handling: offline fake SDK and identity-checked sample cache only."""
import asyncio
import logging
import re
import threading
from types import SimpleNamespace as NS

import pytest

from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.sink import Go2Sink, OutputError, ZERO
from foothold_agent.link.session import MotionCommand
from test_go2_direct import Clock, FakeSport
from test_go2_feedback import low, sport


def rig():
    clock, normal, emergency = Clock(), FakeSport(), FakeSport()
    sink = Go2Sink(normal, emergency, now=clock, offline_test_mode=True)
    sink.select_source('server')
    feedback = Feedback('1234-5678', now=clock, accept_error_codes=(100,))
    feedback.sink = sink
    sink.posture_feedback = feedback.posture_snapshot
    sink.apply(MotionCommand('stop', stop_generation=10), source='server')
    return clock, sink, feedback, normal, emergency


def measured(feedback, sequence=1, *, low_values=None, **values):
    feedback.lowstate(low(sequence, **(low_values or {})))
    feedback.sportmodestate(sport(sequence, **values))


def stop_code(client, code):
    def stop():
        client.calls.append(('StopMove', ()))
        return code
    client.StopMove = stop


@pytest.mark.parametrize('motion_state', [0, 100])
def test_timeout_with_current_measured_stop_keeps_connection_and_lock(motion_state):
    clock, sink, feedback, normal, emergency = rig()
    measured(feedback, error_code=motion_state, velocity=(.02, -.02, .06), yaw_speed=.03,
             low_values=dict(gyro=(.05, -.05, .05), dq=.10))
    stop_code(normal, 3104); stop_code(emergency, 3104)
    sink.drain(); sink.check_watchdog()
    assert sink.error is None and sink.latched and sink.pending == ZERO
    # The exception policy cannot fabricate a Core acknowledgement or unlock.
    assert sink._confirmed_generation is None
    states = []
    assert feedback.consume(NS(on_robot_state=states.append))
    assert states[-1]['stop_requested'] and sink.latched
    assert normal.calls == emergency.calls == [('Move', ZERO), ('StopMove', ())]


@pytest.mark.parametrize('lane', ['normal', 'emergency'])
@pytest.mark.parametrize('evidence', ['none', 'stale', 'stale-low', 'future', 'generation',
    'identity', 'vx', 'vy', 'vz', 'yaw', 'gyro', 'joint', 'new-motion'])
def test_timeout_without_fresh_physical_stop_keeps_connection(lane, evidence):
    clock, sink, feedback, normal, emergency = rig()
    if evidence != 'none':
        values = dict(velocity={'vx': (.020001, 0, 0), 'vy': (0, .020001, 0),
                                'vz': (0, 0, .060001)}.get(evidence, ZERO))
        if evidence == 'yaw': values['yaw_speed'] = .030001
        low_values = ({'gyro': (.050001, 0, 0)} if evidence == 'gyro' else
                      {'dq': .100001} if evidence == 'joint' else {})
        measured(feedback, low_values=low_values, **values)
        if evidence in ('stale', 'stale-low'):
            clock.value += .201
            if evidence == 'stale-low': feedback.sportmodestate(sport(2))
        elif evidence == 'future': clock.value -= .001
        elif evidence == 'generation':
            sink.apply(MotionCommand('stop', stop_generation=11), source='server')
        elif evidence == 'identity': feedback.lowstate(low(2, sn=(9, 9)))
        elif evidence == 'new-motion':
            assert feedback.consume(NS(on_robot_state=lambda _: None))
            feedback.sportmodestate(sport(2, velocity=(.4, 0, 0)))
    stop_code(normal if lane == 'normal' else emergency, 3104)
    sink.drain() if lane == 'normal' else sink.emergency_stop()
    assert sink.error is None and sink.latched and sink.pending == ZERO
    assert sink._confirmed_generation is None or evidence == 'new-motion'
    sink.apply(MotionCommand(), source='server')
    assert sink.response_health()['slow']


@pytest.mark.parametrize('code', [3102, 42, -1, None, False])
@pytest.mark.parametrize('lane', ['normal', 'emergency'])
def test_measured_stop_does_not_excuse_other_sdk_errors(code, lane):
    _, sink, feedback, normal, emergency = rig()
    measured(feedback)
    stop_code(normal if lane == 'normal' else emergency, code)
    with pytest.raises(OutputError):
        sink.drain() if lane == 'normal' else sink.emergency_stop()
    assert sink.error is not None and sink.latched


@pytest.mark.parametrize('confirmed', [False, True])
def test_repeated_generation_is_bounded_on_both_lanes(confirmed):
    clock, sink, feedback, normal, emergency = rig()
    generation = sink.generation
    for sequence in range(1, 101):
        clock.value = 1000. + sequence*.01
        sink.apply(MotionCommand('stop', stop_generation=10), source='server')
        if confirmed:
            measured(feedback, sequence)
            feedback.consume(NS(on_robot_state=lambda _: None))
        sink.drain(); sink.check_watchdog()
        assert sink.generation == generation and sink.latched
    counts = [sum(method == 'StopMove' for method, _ in client.calls)
              for client in (normal, emergency)]
    if confirmed:
        assert counts == [1, 1]
    else:
        assert all(4 <= count <= 6 for count in counts)
    # Standing now holds the entire output after the first per-lane STOP;
    # without measured confirmation the existing zero stream is unchanged.
    assert sum(method == 'Move' for method, _ in normal.calls) == (1 if confirmed else 100)
    assert sink.error is None


def test_new_stop_generation_always_outputs_on_both_lanes_and_requires_new_feedback():
    _, sink, feedback, normal, emergency = rig()
    measured(feedback); feedback.consume(NS(on_robot_state=lambda _: None))
    sink.drain(); sink.check_watchdog()
    old_generation = sink.generation
    for client in (normal, emergency): client.calls.clear()
    sink.apply(MotionCommand('stop', stop_generation=11), source='server')
    assert sink.generation > old_generation and sink._confirmed_generation is None
    sink.drain(); sink.check_watchdog()
    assert normal.calls == emergency.calls == [('Move', ZERO), ('StopMove', ())]
    assert sink.latched and sink._confirmed_generation is None


def test_missing_generation_preserves_conservative_stop_publication():
    _, sink, feedback, normal, emergency = rig()
    for sequence in range(1, 11):
        sink.apply(MotionCommand('stop'), source='server')
        measured(feedback, sequence)
        sink.drain(); sink.check_watchdog()
    assert all(sum(method == 'StopMove' for method, _ in client.calls) == 10
               for client in (normal, emergency))


def test_emergency_lane_retries_without_repeated_stop_input():
    clock, sink, _, _, emergency = rig()
    sink.check_watchdog()
    for tick in range(1, 101):
        clock.value = 1000.+tick*.01
        sink.check_watchdog()
    assert 4 <= sum(method == 'StopMove' for method, _ in emergency.calls) <= 6


def test_session_labels_retransmits_but_advances_every_new_stop():
    from foothold_agent.link.session import Session
    session = Session(now=Clock())
    initial = session.connect()
    generation = session.core.stop_gen
    def stop_generations(effects):
        return [command.stop_generation for command in effects.motion if command.kind == 'stop']
    assert stop_generations(initial) == [generation]
    assert stop_generations(session.tick()) == [generation]
    new = session.receive(dict(t='stop', stop_ref=7))
    assert session.core.stop_gen > generation
    assert stop_generations(new) == [session.core.stop_gen]
    assert stop_generations(session.tick()) == [session.core.stop_gen]


def test_replacement_feedback_is_not_required_to_tolerate_timeout():
    _, sink, feedback, normal, _ = rig()
    measured(feedback)
    feedback.sink = Go2Sink(FakeSport(), FakeSport(), offline_test_mode=True)
    stop_code(normal, 3104)
    sink.drain()
    assert sink.error is None and sink.latched


@pytest.mark.parametrize('fresh_on_return', [False, True])
def test_timeout_policy_reads_measurements_after_rpc_returns(fresh_on_return):
    clock, sink, feedback, normal, _ = rig()
    measured(feedback)
    def stop():
        normal.calls.append(('StopMove', ()))
        clock.value += .201
        if fresh_on_return: measured(feedback, 2)
        return 3104
    normal.StopMove = stop
    sink.drain()
    assert sink.error is None and sink.latched


def test_stand_down_prestop_timeout_refuses_only_posture_job():
    from test_go2_posture import rig as posture_rig, request
    _, sink, normal, _, _, _, measured, frame = posture_rig(0)
    count = 0
    def stop():
        nonlocal count
        count += 1
        normal.calls.append(('StopMove', ()))
        return 3104 if count == 2 else 0
    normal.StopMove = stop
    request(frame, 'stand_down')
    measured(0)  # request advances the STOP generation; use post-request evidence
    sink.drain()
    assert sink.error is None and ('StandDown', ()) not in normal.calls
    assert sink.posture_result['status'] == 'REJECTED'
    assert sink.posture_result['code'] == 'ROBOT_SLOW'
    assert sink.posture_result['sdk_code'] == 3104


def test_stop_diagnostics_include_each_result_latency_interval_and_failure_streak(caplog):
    _, sink, feedback, normal, _ = rig()
    measured(feedback)
    caplog.set_level(logging.WARNING, logger='foothold_agent.go2_direct.stop_rpc')
    for code in (3104, 3104, 0):
        stop_code(normal, code)
        sink._stop_output(normal, force=True)
    rows = [r.getMessage() for r in caplog.records if r.name.endswith('.stop_rpc')]
    assert len(rows) == 3
    for row, code, streak in zip(rows, (3104, 3104, 0), (1, 2, 0)):
        assert re.fullmatch(r'GO2_STOP_RESULT lane=normal elapsed_ms=\d+\.\d{3} '
            rf'code={code} consecutive_failures={streak} interval_ms=-?\d+\.\d{{3}}', row)


def test_cleanup_failure_cannot_mask_runtime_or_serve_diagnostic(monkeypatch, capsys):
    from foothold_agent.setup import runtime, __main__ as setup
    from foothold_agent.setup.view import Status
    from foothold_agent.link.client import Client, LocalPortError
    from test_setup_pairing import credentials, NIC_VALUE
    original = LocalPortError('motion sink failed')
    original.__cause__ = TimeoutError('private SDK details')
    class FailedClient(Client):
        async def run(self):
            self.session.gate.active = NS(sink=NS(error=original))
            raise original
    class FailedCleanup(runtime.Gate):
        def revoke(self):
            raise OutputError('adapter closed or failed')
    monkeypatch.setattr(runtime, 'Gate', FailedCleanup)
    async def fail(*args):
        await runtime.run(credentials(), NIC_VALUE, runtime.Inputs(), object(), ready=True,
            check_nic=lambda: True, status=Status(), stop=asyncio.Event(),
            client_factory=FailedClient, recorder_factory=lambda *args, **kw:
                NS(notice='', stopped=threading.Event(), close=lambda: None))
    async def scenario():
        with pytest.raises(LocalPortError) as caught: await fail()
        assert caught.value is original
        assert caught.value.__cause__.__class__ is TimeoutError
        monkeypatch.setattr(setup, 'connect', fail)
        monkeypatch.setattr(setup, 'install_stop_handlers', lambda _: lambda: None)
        stop = asyncio.Event(); stop.set()
        assert not await setup.serve(NS(), Status(), stop=stop)
    asyncio.run(scenario())
    assert ('SETUP_FAILURE type=LocalPortError reason=motion_sink_failed '
            'cause_type=TimeoutError') in capsys.readouterr().err


@pytest.mark.parametrize('lane', ['normal', 'emergency'])
def test_recorded_real_robot_sequence_keeps_sending_stop(lane):
    clock, sink, _, normal, emergency = rig()
    client = normal if lane == 'normal' else emergency
    for code in (0, 3104, 3104, 0, 3104):
        stop_code(client, code)
        sink.drain() if lane == 'normal' else sink.check_watchdog()
        assert sink.error is None and sink.latched
        clock.value += .21
    assert sum(name == 'StopMove' for name, _ in client.calls) == 5
    assert sum(name == 'Move' for name, _ in client.calls) == 5
    assert sink._confirmed_generation is None
    health = sink.response_health()
    assert health['slow'] and health['timeout_count'] == 3
    assert health['last_timed_out'] and health['last_timeout_at'] is not None
    clock.value += 3
    health = sink.response_health()
    assert not health['slow'] and health['timeout_count'] == 0
    assert health['last_ms'] is None and health['sample_count'] == 0


@pytest.mark.parametrize('lane', ['normal', 'emergency'])
def test_sdk_exceptions_stay_fatal(lane):
    _, sink, _, normal, emergency = rig()
    def stop(): raise TimeoutError('fake')
    (normal if lane == 'normal' else emergency).StopMove = stop
    with pytest.raises(OutputError):
        sink.drain() if lane == 'normal' else sink.emergency_stop()
    assert sink.error is not None


def test_health_is_display_only_on_server_state():
    from test_go2_posture import rig as posture_rig
    _, sink, normal, _, session, _, _, _ = posture_rig(0)
    stop_code(normal, 3104)
    sink._stop_output(normal, force=True)
    state = session._state()
    assert state['response_health']['timeout_count'] == 1
    assert sink.error is None and session.core.latch and sink.latched


def test_cleanup_emergency_failure_is_not_hidden_by_original_link_error(monkeypatch):
    from foothold_agent.setup import runtime
    from foothold_agent.setup.view import Status
    from foothold_agent.link.client import Client, LocalPortError
    from test_setup_pairing import credentials, NIC_VALUE
    class FailedClient(Client):
        async def run(self): raise LocalPortError('motion sink failed')
    class FailedCleanup(runtime.Gate):
        def revoke(self): raise OutputError('emergency SDK output failed')
    monkeypatch.setattr(runtime, 'Gate', FailedCleanup)
    async def scenario():
        with pytest.raises(OutputError, match='emergency SDK output failed'):
            await runtime.run(credentials(), NIC_VALUE, runtime.Inputs(), object(), ready=True,
                check_nic=lambda: True, status=Status(), stop=asyncio.Event(),
                client_factory=FailedClient, recorder_factory=lambda *args, **kw:
                    NS(notice='', stopped=threading.Event(), close=lambda: None))
    asyncio.run(scenario())


@pytest.mark.parametrize('lane', ['normal', 'emergency'])
def test_send_failure_stays_fatal_when_low_robot_is_moving(lane):
    from test_go2_posture import rig as posture_rig
    _, sink, normal, emergency, _, _, measured, _ = posture_rig(5)
    measured(5, velocity=(.3, 0., 0.))
    stop_code(normal if lane == 'normal' else emergency, 3102)
    sink.apply(MotionCommand('stop', stop_generation=99), source='server')
    with pytest.raises(OutputError):
        sink.drain() if lane == 'normal' else sink.emergency_stop(force=True)
    assert sink.error is not None

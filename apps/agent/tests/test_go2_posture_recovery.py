"""B1/B2 regression with numeric V2 states; fake SDK/clock only."""
import logging
import threading
import time

import pytest

from foothold_agent.go2_direct.sink import ZERO, OutputError
from test_go2_posture import rig, request
from test_go2_feedback import low, sport


@pytest.mark.parametrize('motion_state', [1004, 1005, 4294967295])
def test_v2_lying_state_does_not_gate_posture_or_stand_up(motion_state):
    _, sink, normal, emergency, session, _, measured, frame = rig()
    normal.result = emergency.result = 42
    measured(5, body_height=.1, error_code=motion_state)
    assert session._state()['posture'] == dict(state='LYING', mode=5)
    assert not session.feedback.error_allowed(motion_state)
    frame('cmd', lease_id='fake-lease', seq=1, axes=[1.5, 0., 0.])
    assert session.core.intent == sink.pending == ZERO
    request(frame); sink.drain()
    assert normal.calls == [('StandUp', ())]
    measured(6, error_code=motion_state); sink.drain()
    assert normal.calls[-1] == ('BalanceStand', ())
    assert session.connected and sink.error is None
    measured(1, error_code=0); sink.drain()
    assert sink.posture_result['status'] == 'SUCCEEDED'


@pytest.mark.parametrize('mode,height,code', [(5,.1,1004), (6,.3,1005), (8,.15,1004),
    (42,.3,1004), (0,.1,0), (0,.3,1004)])
def test_stop_rejection_only_faults_when_walkable_is_confirmed(mode, height, code):
    _, sink, normal, emergency, session, _, measured, frame = rig()
    normal.result = emergency.result = 43
    measured(mode, body_height=height, error_code=code)
    frame('stop', stop_ref=20)
    sink.drain(); sink.emergency_stop()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[1.5, 0., 0.])
    sink.drain()
    assert sink.error is None and session.connected
    assert sink.pending == session.core.intent == ZERO
    assert all(name == 'StopMove' or (name == 'Move' and args == ZERO)
        for name, args in normal.calls + emergency.calls)


def test_stale_posture_stop_rejection_keeps_connection_but_never_moves():
    clock, sink, normal, emergency, session, _, _, frame = rig(0)
    normal.result = emergency.result = 42
    clock.value += .201
    frame('stop', stop_ref=20)
    sink.drain(); sink.emergency_stop()
    assert sink.error is None and session.connected
    assert normal.calls == emergency.calls == [('Move', ZERO), ('StopMove', ())]


@pytest.mark.parametrize('action,method', [('stand_up', 'BalanceStand'), ('stand_down', 'StandDown')])
def test_mode_six_both_recovery_actions_after_stop(action, method):
    _, sink, normal, emergency, session, _, measured, frame = rig(6)
    normal.result = emergency.result = 42  # joint-lock does not accept StopMove
    measured(6, error_code=1005)
    frame('stop', stop_ref=21)
    measured(6, error_code=1005)
    assert session._state()['stop_ref'] == 21  # a new holder can obtain the lease
    request(frame, action); sink.drain()
    assert (method, ()) in normal.calls
    assert ('StandUp', ()) not in normal.calls
    assert sink.posture_result['status'] == 'RUNNING'
    measured(1 if action == 'stand_up' else 5, error_code=0 if action == 'stand_up' else 1004)
    sink.drain()
    assert sink.posture_result['status'] == 'SUCCEEDED' and sink.error is None
    assert session.core.latch and sink.latched


@pytest.mark.parametrize('mode,height,velocity', [(6,.19,(0.,0.,0.)), (6,.51,(0.,0.,0.)),
    (6,.3,(.1,0.,0.)), (7,.3,(0.,0.,0.))])
def test_joint_lock_recovery_requires_height_stillness_and_exact_mode(mode, height, velocity):
    _, sink, normal, _, _, _, measured, frame = rig()
    measured(mode, body_height=height, velocity=velocity, error_code=1005)
    request(frame)
    assert sink.posture_result['status'] == 'REJECTED'
    sink.drain()
    assert not any(name in ('StandUp', 'StandDown', 'BalanceStand') for name, _ in normal.calls)


@pytest.mark.parametrize('gap_mode', [None, 42])
def test_short_measurement_gap_waits_then_resumes_balance(gap_mode):
    clock, sink, normal, _, session, _, measured, frame = rig()
    request(frame); sink.drain()
    clock.value += .201
    if gap_mode is not None: measured(gap_mode, error_code=1004)
    frame('ping'); sink.drain()
    assert sink.posture_busy and sink.posture_result['status'] == 'RUNNING'
    assert ('BalanceStand', ()) not in normal.calls
    measured(6, error_code=1005); sink.drain()
    assert normal.calls[-1] == ('BalanceStand', ())
    measured(1); sink.drain()
    assert sink.posture_result['status'] == 'SUCCEEDED'
    assert session.connected


def test_unknown_until_deadline_times_out_without_motion_or_disconnect():
    clock, sink, normal, _, session, _, measured, frame = rig()
    request(frame); sink.drain()
    measured(42)
    for _ in range(75):
        clock.value += .2
        frame('ping')  # live transport/input loop while DDS has a gap
        sink.drain()
        sink.check_watchdog()
    assert not sink.posture_busy
    assert sink.posture_result['status'] == 'FAILED' and sink.posture_result['code'] == 'TIMEOUT'
    assert ('BalanceStand', ()) not in normal.calls
    assert session.connected and sink.error is None


@pytest.mark.parametrize('action', ['stand_up', 'stand_down'])
def test_stop_between_standup_and_balance_can_recover_joint_lock(action):
    _, sink, normal, emergency, session, _, measured, frame = rig()
    request(frame); sink.drain()
    measured(6, error_code=1005)
    frame('stop', stop_ref=20); sink.check_watchdog()
    assert sink.posture_result['code'] == 'STOPPED'
    assert emergency.calls == [('StopMove', ())]
    assert ('BalanceStand', ()) not in normal.calls
    measured(6, error_code=1005)
    request(frame, action, request_id='retry'); sink.drain()
    assert ('BalanceStand' if action == 'stand_up' else 'StandDown', ()) in normal.calls
    assert session.core.latch and sink.latched


def test_mode_and_error_changes_emit_numeric_diagnostics_with_cm_height(caplog):
    _, _, _, _, session, _, measured, _ = rig()
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger='foothold_agent.go2_direct.feedback'):
        measured(5, body_height=.1, error_code=1004)
        session._state(); session._state()
        measured(5, body_height=.1, error_code=1005); session._state()
        measured(5, body_height=.15, error_code=1005); session._state()
        measured(6, body_height=.3, error_code=1005); session._state()
    logs = [r.getMessage() for r in caplog.records if r.name == 'foothold_agent.go2_direct.feedback']
    assert logs == [
        'GO2_POSTURE mode=5 motion_state=1004 height_m=0.10',
        'GO2_POSTURE mode=5 motion_state=1005 height_m=0.10',
        'GO2_POSTURE mode=6 motion_state=1005 height_m=0.30']
    assert '1234' not in ''.join(logs) and 'fake-lease' not in ''.join(logs)


def test_ten_seconds_of_fifty_hz_height_noise_produces_at_most_one_journal_line(caplog):
    from foothold_agent.go2_direct.feedback import Feedback
    from test_go2_direct import Clock
    clock = Clock()
    feedback = Feedback('1234-5678', now=clock)
    with caplog.at_level(logging.WARNING, logger='foothold_agent.go2_direct.feedback'):
        for tick in range(1, 501):
            clock.value += .02
            feedback.lowstate(low(tick))
            feedback.sportmodestate(sport(tick, mode=0, error_code=100,
                body_height=.30 + .0001*(tick % 13)))
            feedback.telemetry()
    logs = [r.getMessage() for r in caplog.records if r.name == 'foothold_agent.go2_direct.feedback']
    assert logs == ['GO2_POSTURE mode=0 motion_state=100 height_m=0.30']


@pytest.mark.parametrize('mode', [1, 3])
def test_stood_but_motion_state_not_allowed_reports_distinct_failure_once(mode, caplog):
    _, sink, normal, _, session, _, measured, frame = rig()
    request(frame); sink.drain()
    measured(6, error_code=1005); sink.drain()
    assert normal.calls[-1] == ('BalanceStand', ())
    caplog.clear()
    measured(mode, error_code=1004)
    sink.drain(); sink.drain()
    assert sink.posture_result == dict(request_id='request', action='stand_up',
        status='FAILED', code='STOOD_NOT_WALKABLE', sdk_code=0)
    assert sink.latched and session.core.latch and session.connected
    assert session.core.intent == sink.pending == ZERO
    assert not any(name == 'Move' and axes != ZERO for name, axes in normal.calls)
    logs = [r.getMessage() for r in caplog.records if r.name == 'foothold_agent.go2_direct.sink']
    assert logs == [f'GO2_POSTURE_STOOD_NOT_WALKABLE mode={mode} motion_state=1004 height_m=0.30']


def test_stood_diagnostic_journal_cannot_own_stop_memory_lock(monkeypatch):
    _, sink, _, emergency, _, _, measured, frame = rig()
    request(frame); sink.drain()
    measured(6, error_code=1005); sink.drain()
    measured(1, error_code=1004)
    entered, release = threading.Event(), threading.Event()
    def blocked_journal(*_args):
        entered.set()
        assert release.wait(1)
    monkeypatch.setattr(logging.getLogger('foothold_agent.go2_direct.sink'), 'warning', blocked_journal)
    worker = threading.Thread(target=sink.drain)
    worker.start()
    try:
        assert entered.wait(1)
        before = time.monotonic()
        frame('stop', stop_ref=20)
        sink.check_watchdog()
        assert time.monotonic()-before < .1
        assert emergency.calls == [('StopMove', ())]
    finally:
        release.set(); worker.join(1)
    assert not worker.is_alive()

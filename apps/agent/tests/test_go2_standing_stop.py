"""Standing STOP holds: fake DDS/SportClient only, no robot or live workers."""
import threading

import pytest

from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.sink import Go2Sink, STOP_RETRY_S, ZERO
from foothold_agent.link.session import MotionCommand
from test_go2_direct import Clock, FakeSport
from test_go2_feedback import low, sport


def rig(mode=0):
    clock, normal, emergency = Clock(), FakeSport(), FakeSport()
    sink = Go2Sink(normal, emergency, now=clock, offline_test_mode=True)
    sink.select_source('server')
    feedback = Feedback('1234-5678', now=clock)
    feedback.sink = sink
    sink.posture_feedback = feedback.posture_snapshot
    sequence = 0

    def measured(*, low_values=None, **values):
        nonlocal sequence
        sequence += 1
        feedback.lowstate(low(sequence, **(low_values or {})))
        feedback.sportmodestate(sport(sequence, mode=mode, **values))

    sink.apply(MotionCommand('stop', stop_generation=10), source='server')
    measured()
    sink.drain()
    sink.check_watchdog()
    normal.calls.clear()
    emergency.calls.clear()
    return clock, sink, feedback, normal, emergency, measured


def hold(sink):
    sink.drain()
    sink.check_watchdog()
    assert sink._resting_lanes == {'normal', 'emergency'}


def notices(caplog, marker):
    return [r.getMessage() for r in caplog.records if marker in r.getMessage()]


@pytest.mark.parametrize('mode', [0, 1, 3, 6])
def test_stationary_standing_holds_both_outputs_and_logs_once(caplog, mode):
    clock, sink, _, normal, emergency, measured = rig(mode)
    caplog.clear()
    for _ in range(10):
        clock.value += .10
        measured()
        sink.apply(MotionCommand('stop', stop_generation=10), source='server')
        hold(sink)
        assert sink.latched and sink.pending == sink._ramp_velocity == ZERO
    assert normal.calls == emergency.calls == []
    assert notices(caplog, 'GO2_STOP_HELD') == [
        'GO2_STOP_HELD 정지 확인 — 정지 명령 반복 멈춤']
    assert not notices(caplog, 'GO2_STOP_RESUMED')


@pytest.mark.parametrize('mode', [0, 6])
@pytest.mark.parametrize('values', [
    dict(velocity=(.020001, 0., 0.)), dict(velocity=(0., .020001, 0.)),
    dict(velocity=(0., 0., .060001)), dict(yaw_speed=.030001),
    dict(low_values=dict(gyro=(.050001, 0., 0.))), dict(low_values=dict(dq=.100001)),
])
def test_motion_wakes_independent_lane_on_next_tick_and_retries(caplog, mode, values):
    clock, sink, _, normal, emergency, measured = rig(mode)
    hold(sink)
    caplog.clear()
    measured(**values)
    sink.check_watchdog()  # no new input, clock advance, or normal drain
    assert ('StopMove', ()) in emergency.calls
    assert not normal.calls
    sink.drain()
    assert ('StopMove', ()) in normal.calls
    assert notices(caplog, 'GO2_STOP_RESUMED') == [
        'GO2_STOP_RESUMED 움직임 — 정지 명령 다시 보냄']
    counts = [len(c.calls) for c in (normal, emergency)]
    clock.value += STOP_RETRY_S - .01
    measured(**values)
    sink.apply(MotionCommand(), source='server')
    sink.check_watchdog()
    sink.drain()
    assert [sum(name == 'StopMove' for name, _ in c.calls) for c in (normal, emergency)] == [1, 1]
    clock.value += .011
    measured(**values)
    sink.check_watchdog()
    sink.drain()
    assert [sum(name == 'StopMove' for name, _ in c.calls) for c in (normal, emergency)] == [2, 2]
    assert all(len(c.calls) > n for c, n in zip((normal, emergency), counts))
    assert len(notices(caplog, 'GO2_STOP_RESUMED')) == 1


@pytest.mark.parametrize('fresh_topic', [None, 'low', 'sport'])
def test_either_expired_topic_wakes_independent_lane(caplog, fresh_topic):
    clock, sink, feedback, normal, emergency, _ = rig()
    hold(sink)
    caplog.clear()
    clock.value += .201
    if fresh_topic == 'low':
        feedback.lowstate(low(2))
    elif fresh_topic == 'sport':
        feedback.sportmodestate(sport(2))
    sink.check_watchdog()
    assert ('StopMove', ()) in emergency.calls and not normal.calls
    sink.drain()
    assert ('StopMove', ()) in normal.calls
    assert notices(caplog, 'GO2_STOP_RESUMED') == [
        'GO2_STOP_RESUMED 만료 — 정지 명령 다시 보냄']


@pytest.mark.parametrize('mode', [0, 6])
@pytest.mark.parametrize('event', ['generation', 'unclassified', 'emergency', 'emergency-new', 'force', 'normal-force'])
def test_explicit_stop_always_sends_despite_fresh_stationary_hold(caplog, mode, event):
    _, sink, _, normal, emergency, measured = rig(mode)
    hold(sink)
    caplog.clear()
    generation = sink.generation
    if event in ('generation', 'unclassified'):
        sink.apply(MotionCommand('stop', stop_generation=11 if event == 'generation' else None), source='server')
        assert sink.generation > generation and sink.latched and sink.pending == ZERO
        measured()  # even fresh evidence in the NEW generation cannot skip its first RPC
        sink.check_watchdog()
        sink.drain()
        assert ('StopMove', ()) in normal.calls
    elif event == 'normal-force':
        sink._stop_output(normal, force=True)
        assert ('StopMove', ()) in normal.calls
    elif event == 'emergency-new':
        sink.emergency_stop()
        assert sink.generation > generation
    else:
        # Explicit emergency must send even when preserve=True keeps its epoch.
        sink._operator_stop = True
        sink.emergency_stop(force=event == 'force')
        assert sink.generation == generation
    if event != 'normal-force':
        assert ('StopMove', ()) in emergency.calls
    assert notices(caplog, 'GO2_STOP_RESUMED') == [
        'GO2_STOP_RESUMED 새 STOP — 정지 명령 다시 보냄']


def test_old_generation_evidence_cannot_hold_new_stop():
    _, sink, _, normal, emergency, measured = rig()
    hold(sink)
    sink.apply(MotionCommand('stop', stop_generation=11), source='server')
    sink.check_watchdog()
    sink.drain()
    normal.calls.clear()
    emergency.calls.clear()
    sink.drain()  # no new DDS after STOP: do not enter hold from the old cache
    assert normal.calls == [('Move', ZERO)]
    assert sink._held_stop_generation is None
    measured()
    hold(sink)
    assert normal.calls == [('Move', ZERO)] and not emergency.calls


def test_other_robot_invalidates_hold_and_logs_fixed_reason(caplog):
    _, sink, feedback, normal, emergency, measured = rig()
    hold(sink)
    caplog.clear()
    feedback.lowstate(low(2, sn=(9, 9)))
    measured()  # matching packets cannot undo a permanent identity conflict
    sink.check_watchdog()
    sink.drain()
    assert ('StopMove', ()) in emergency.calls and ('StopMove', ()) in normal.calls
    assert sink._held_stop_generation is None
    assert notices(caplog, 'GO2_STOP_RESUMED') == [
        'GO2_STOP_RESUMED 기체 — 정지 명령 다시 보냄']


def test_motion_rpc_inflight_and_return_require_new_sport_before_holding(caplog):
    clock, sink, feedback, normal, emergency, measured = rig()
    hold(sink)
    caplog.clear()
    entered, release = threading.Event(), threading.Event()

    def move(*args):
        normal.calls.append(('Move', args))
        entered.set()
        assert release.wait(2)
        return 0

    normal.Move = move
    worker = threading.Thread(target=sink._movement_rpc, args=(normal, 'Move', (.3, 0., 0.)))
    worker.start()
    try:
        assert entered.wait(1)
        measured()  # still, but captured DURING the RPC
        sink.check_watchdog()
        assert ('StopMove', ()) in emergency.calls
        assert sink._held_stop_generation is None
        for expected in range(2, 5):
            clock.value += .21
            measured()  # fresh but still DURING the blocked motion RPC
            sink.apply(MotionCommand(), source='server')
            sink.check_watchdog()
            assert sum(name == 'StopMove' for name, _ in emergency.calls) == expected
    finally:
        release.set()
        worker.join(2)
    assert not worker.is_alive()
    sink.drain()
    assert sink._held_stop_generation is None
    feedback.lowstate(low(100))  # a newer LowState alone is insufficient
    sink.drain()
    assert sink._held_stop_generation is None
    measured()
    hold(sink)
    assert sink._held_stop_generation == sink.generation
    assert notices(caplog, 'GO2_STOP_RESUMED') == [
        'GO2_STOP_RESUMED RPC 이후 표본 없음 — 정지 명령 다시 보냄']
    assert len(notices(caplog, 'GO2_STOP_HELD')) == 1


def test_motion_then_still_logs_one_new_entry(caplog):
    _, sink, _, _, _, measured = rig()
    hold(sink)
    measured(velocity=(.3, 0., 0.))
    sink.check_watchdog()
    sink.drain()
    measured()
    for _ in range(3):
        hold(sink)
    assert len(notices(caplog, 'GO2_STOP_HELD')) == 2
    assert len(notices(caplog, 'GO2_STOP_RESUMED')) == 1


def test_emergency_only_worker_enters_hold_then_detects_motion():
    _, sink, _, normal, emergency, measured = rig()
    sink.check_watchdog()  # normal worker does not run again
    assert 'emergency' in sink._resting_lanes
    measured(velocity=(.3, 0., 0.))
    sink.check_watchdog()
    assert emergency.calls == [('Move', ZERO), ('StopMove', ())]
    assert not normal.calls


def test_explicit_emergency_during_busy_emergency_rpc_is_not_lost():
    _, sink, _, _, emergency, _ = rig()
    hold(sink)
    sink._operator_stop = True
    entered, release = threading.Event(), threading.Event()

    def stop():
        emergency.calls.append(('StopMove', ()))
        entered.set()
        assert release.wait(2)
        return 0

    emergency.StopMove = stop
    worker = threading.Thread(target=sink.emergency_stop)
    worker.start()
    try:
        assert entered.wait(1)
        sink.emergency_stop()  # returns without waiting for the occupied lane
        assert sink._stop_requested.is_set()
    finally:
        release.set()
        worker.join(2)
    assert not worker.is_alive()
    sink.check_watchdog()
    assert sum(name == 'StopMove' for name, _ in emergency.calls) == 2


@pytest.mark.parametrize('mode,height', [(0, .07), (5, .10), (10, .24)])
def test_standing_hold_can_become_low_posture_skip_without_resuming_output(caplog, mode, height):
    _, sink, feedback, normal, emergency, _ = rig()
    hold(sink)
    caplog.clear()
    feedback.lowstate(low(2))
    feedback.sportmodestate(sport(2, mode=mode, body_height=height))
    hold(sink)
    assert not normal.calls and not emergency.calls
    assert len(notices(caplog, 'GO2_STOP_SKIPPED')) == 1
    assert not notices(caplog, 'GO2_STOP_RESUMED')

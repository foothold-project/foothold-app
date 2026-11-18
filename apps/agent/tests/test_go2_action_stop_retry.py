"""Fake SDK/clock only: accepted action's own STOP hold, never safety STOPs."""
import pytest

from foothold_agent.go2_direct.actions import EXECUTION_MAX_S
from foothold_agent.go2_direct.sink import STOP_RETRY_S
from foothold_agent.link.session import MotionCommand
from test_go2_actions import send
from test_go2_posture import rig, request


def accepted(action='Dance1', result=0, *, seed_emergency=True):
    setup = rig(0)
    _, sink, normal, emergency, _, _, _, frame = setup
    # Seed both retry lanes before acceptance, including the action's pre-stop.
    if seed_emergency:
        sink.check_watchdog()
    def rpc(*args):
        normal.calls.append((action, args))
        return result
    setattr(normal, action, rpc)
    send(frame, action)
    if seed_emergency:
        sink.check_watchdog()
    sink.drain()
    normal.calls.clear()
    emergency.calls.clear()
    return setup


def stops(client):
    return [call for call in client.calls if call[0] == 'StopMove']


def pulse(setup, dt=.1, *, moving=True):
    clock, sink, _, _, _, _, measured, frame = setup
    clock.value += dt
    measured(0, velocity=(.3 if moving else 0., 0., 0.))
    frame('ping')
    sink.drain()
    sink.check_watchdog()


@pytest.mark.parametrize('action', ['Dance1', 'Hello'])
@pytest.mark.parametrize('seed_emergency', [True, False])
def test_accepted_action_defers_both_lanes_through_repeated_core_hold(action, seed_emergency):
    setup = accepted(action, seed_emergency=seed_emergency)
    _, sink, normal, emergency, session, _, _, _ = setup
    generation = sink.generation
    for _ in range(10):
        pulse(setup)
        assert sink.generation == generation
        assert sink.actions.executing is not None
        assert not stops(normal) and not stops(emergency)
    assert sink.actions.result['code'] == 'SDK_ACCEPTED'
    assert sink.latched and session.core.latch


@pytest.mark.parametrize('event', ['stop', 'lease', 'approval', 'disconnect',
                                  'transport', 'emergency', 'cancel', 'other_source'])
def test_safety_interrupt_ends_deferral_and_stops_immediately_then_retries(event):
    setup = accepted()
    clock, sink, normal, emergency, session, client, measured, frame = setup
    # Last pre-stop was only .05 s ago: the safety event cannot wait for .20 s.
    clock.value += .05
    measured(0, velocity=(.3, 0., 0.))
    generation = sink.generation
    if event == 'stop': frame('stop', stop_ref=25)
    elif event == 'lease': frame('lease', lease_id=None, holder_type=None)
    elif event == 'approval': session.posture_gate = lambda: False
    elif event == 'disconnect': client._emit(session.disconnect())
    elif event == 'transport': client._emit(session.transport_closed(1006, retry=True))
    elif event == 'emergency': sink.emergency_stop()
    elif event == 'cancel': sink.actions.stop()
    elif event == 'other_source':
        sink.apply(MotionCommand('stop', stop_generation=session.core.stop_gen), source='phone')
    sink.check_watchdog()
    assert stops(emergency) == [('StopMove', ())]
    assert sink.generation > generation and sink.actions.executing is None
    sink.drain()
    assert stops(normal) == [('StopMove', ())]
    # Keep output/input and moving feedback live without restoring authority.
    sink.stop_feedback = lambda: dict(generation=sink.generation,
        stationary=False, received_at=clock())
    for dt, expected in [(STOP_RETRY_S-.01, 1), (.011, 2)]:
        clock.value += dt
        sink.apply(MotionCommand(), source='server')
        sink.drain()
        sink.check_watchdog()
        assert len(stops(normal)) == len(stops(emergency)) == expected
    assert not any(name == 'Damp' for name, _ in normal.calls+emergency.calls)


@pytest.mark.parametrize('first', ['watchdog', 'drain'])
def test_deadman_expiry_ends_deferral_even_while_latched(first):
    setup = accepted()
    clock, sink, normal, emergency, _, _, _, _ = setup
    clock.value += .301
    getattr(sink, 'check_watchdog' if first == 'watchdog' else 'drain')()
    assert sink.actions.executing is None
    assert stops(emergency if first == 'watchdog' else normal)


def test_late_apply_cannot_refresh_away_deadman_expiry_during_action():
    clock, sink, _, emergency, _, _, _, _ = accepted()
    clock.value += .2
    sink.drain()  # normal worker is healthy; only input expires
    clock.value += .101
    sink.apply(MotionCommand(), source='server')
    sink.check_watchdog()
    assert sink.actions.executing is None
    assert stops(emergency)


def test_acceptance_after_deadman_does_not_erase_output_outage():
    clock, sink, normal, emergency, _, _, _, frame = rig(0)
    def dance():
        clock.value += .301
        return 0
    normal.Dance1 = dance
    send(frame, 'Dance1')
    sink.drain()
    assert sink.actions.executing is None
    sink.check_watchdog()
    assert stops(emergency)


def test_execution_maximum_resumes_both_lanes_with_fresh_moving_feedback():
    setup = accepted()
    _, sink, normal, emergency, _, _, _, _ = setup
    for _ in range(int(EXECUTION_MAX_S['Dance1']*10)-1):
        pulse(setup)
    assert sink.actions.executing is not None
    assert not stops(normal) and not stops(emergency)
    pulse(setup, .11)
    assert sink.actions.executing is None
    assert stops(normal) and stops(emergency)


def test_maximum_wakes_emergency_without_prior_stop_or_core_republication():
    clock, sink, normal, emergency, _, _, _, _ = accepted(seed_emergency=False)
    sink.posture_authorized = lambda lease: True
    sink.stop_feedback = lambda: dict(generation=sink.generation,
        stationary=False, received_at=clock())
    # Exercise the sink without Core's repeated STOP event as an extra wakeup.
    sink._stop_requested.clear()
    for _ in range(int(EXECUTION_MAX_S['Dance1']*10)+1):
        clock.value += .1
        sink.apply(MotionCommand(), source='server')
        sink.drain()
        sink.check_watchdog()
    assert sink.actions.executing is None
    assert stops(normal) and stops(emergency)


def test_new_measured_stop_ends_wait_permanently_but_never_unlatches():
    setup = accepted()
    _, sink, normal, emergency, session, _, _, _ = setup
    pulse(setup)
    pulse(setup, moving=False)
    assert sink.actions.executing is None
    assert sink.latched and session.core.latch
    pulse(setup)
    assert stops(normal) and stops(emergency)


def test_preaccept_still_sample_is_not_physical_completion():
    _, sink, normal, emergency, _, _, measured, frame = rig(0)
    normal.Dance1 = lambda: 0
    send(frame, 'Dance1')
    measured(0)  # a same-generation still sample before SDK acceptance
    sink.drain()
    normal.calls.clear()
    emergency.calls.clear()
    sink.drain()
    sink.check_watchdog()
    assert sink.actions.executing is not None
    assert not stops(normal) and not stops(emergency)


@pytest.mark.parametrize('result', [73, 3104, TimeoutError(), RuntimeError('private')])
def test_unaccepted_action_never_defers_either_stop_lane(result):
    setup = rig(0)
    _, sink, normal, emergency, _, _, _, frame = setup
    def dance():
        if isinstance(result, Exception): raise result
        return result
    normal.Dance1 = dance
    send(frame, 'Dance1')
    sink.drain()
    assert sink.actions.executing is None
    assert sink.actions.result['status'] == 'FAILED'
    normal.calls.clear()
    emergency.calls.clear()
    pulse(setup, .21)
    assert stops(normal) and stops(emergency)
    assert sink.error is None


@pytest.mark.parametrize('action,mode', [('stand_up', 5), ('stand_down', 0)])
def test_posture_requests_keep_their_original_stop_retry_behavior(action, mode):
    setup = rig(mode)
    clock, sink, normal, emergency, _, _, measured, frame = setup
    request(frame, action)
    sink.drain()
    sink.check_watchdog()
    normal.calls.clear()
    emergency.calls.clear()
    clock.value += .21
    measured(mode, velocity=(.3, 0., 0.), body_height=.1 if mode == 5 else .3)
    frame('ping')
    sink.drain()
    sink.check_watchdog()
    assert sink.actions.executing is None
    assert stops(normal) and stops(emergency)


@pytest.mark.parametrize('action', ['StandUp', 'StandDown', 'StopMove', 'CheckMode', 'SpeedLevel'])
def test_posture_and_nonmotion_action_rpcs_never_defer_stop(action):
    assert action not in EXECUTION_MAX_S
    setup = accepted(action, (0, {}) if action == 'CheckMode' else 0)
    _, sink, normal, emergency, _, _, _, _ = setup
    assert sink.actions.executing is None
    pulse(setup, .21)
    assert stops(normal) and stops(emergency)

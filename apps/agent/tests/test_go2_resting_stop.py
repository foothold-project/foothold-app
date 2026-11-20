"""Replay posture and STOP at the physical output boundary using synthetic DDS."""
import pytest

from foothold_agent.go2_direct.sink import ZERO
from test_go2_actions import send
from test_go2_feedback import low, sport
from test_go2_posture import request, rig
from test_go2_remote_priority import packet
from test_setup_pairing import rig as setup_rig


@pytest.mark.parametrize('mode,height', [(0, .07), (5, .10), (10, .24)])
def test_start_reconnect_operator_stop_and_remote_retries_at_rest(mode, height):
    gate, session, client, inputs, wall, _, _, clients, activate = setup_rig()
    seq = 1

    def sample(keys=0):
        nonlocal seq
        seq += 1
        message = low(seq)
        message.wireless_remote = packet(keys=keys)
        inputs.lowstate(message)
        inputs.sportmodestate(sport(seq, mode=mode, body_height=height, error_code=1001))

    for epoch in range(2):
        sample()
        session.receive(dict(t='field_approval', expires_at=wall()+600+epoch))
        activate()
        sink = gate.active.sink
        sink.drain()
        for cause in ('lease_take', 'screen_hidden', 'user_stop', 'lease_take'):
            sample(keys=int(cause != 'lease_take'))
            client._emit(session.receive(dict(t='stop', cause=cause)))
            sink.check_watchdog()
            sink.drain()
            assert sink.latched and sink.pending == ZERO
        client._emit(session.disconnect())
        assert gate.active is None
        assert all(not sdk.calls for pair in clients for sdk in pair)
        client._emit(session.connect())
    assert len(clients) == 2


@pytest.mark.parametrize('mode,height,expected', [
    (0, .07, [('StopMove', ())]),
    (5, .10, [('StopMove', ())]),
    (10, .24, [('StopMove', ())]),
    (0, .32, [('Move', ZERO), ('StopMove', ())]),
])
def test_motion_after_quiet_stop_immediately_wakes_both_lanes(mode, height, expected):
    _, sink, normal, emergency, _, _, measured, frame = rig()
    measured(0, body_height=.07)
    frame('stop', cause='user_stop')
    sink.check_watchdog()
    sink.drain()
    assert not normal.calls and not emergency.calls
    measured(mode, body_height=height, velocity=(.3, 0., 0.))
    # No time advance or new STOP. The independent lane must notice motion
    # before the normal worker has a chance to run.
    sink.check_watchdog()
    assert emergency.calls == expected
    sink.drain()
    assert normal.calls == expected


def test_lowstate_gap_at_standup_return_requires_new_sport_before_skipping_stop():
    clock, sink, normal, emergency, session, _, _, frame = rig(5)
    feedback = session.feedback

    def stand_up():
        normal.calls.append(('StandUp', ()))
        feedback.lowstate(low(3))
        clock.value += .15
        feedback.sportmodestate(sport(3, mode=5, body_height=.10))
        clock.value += .07
        return 0

    normal.StandUp = stand_up
    request(frame)
    sink.drain()
    assert normal.calls == [('StandUp', ())]
    feedback.lowstate(low(4))
    frame('stop', cause='user_stop')
    sink.check_watchdog()
    sink.drain()
    assert emergency.calls == [('StopMove', ())]
    assert normal.calls == [('StandUp', ()), ('StopMove', ())]

    feedback.sportmodestate(sport(4, mode=5, body_height=.10))
    frame('stop', cause='user_stop')
    sink.check_watchdog()
    sink.drain()
    assert emergency.calls == [('StopMove', ())]
    assert normal.calls == [('StandUp', ()), ('StopMove', ())]


@pytest.mark.parametrize('roll,progress', [(1.4, 0.), (0., .5)])
def test_sitting_tilt_or_transition_requires_stop_on_both_lanes(roll, progress):
    _, sink, normal, emergency, session, _, _, frame = rig(10)
    message = low(3)
    message.imu_state.rpy[0] = roll
    session.feedback.lowstate(message)
    session.feedback.sportmodestate(sport(3, mode=10, body_height=.24, progress=progress))
    frame('stop', cause='user_stop')
    sink.check_watchdog()
    sink.drain()
    assert normal.calls == emergency.calls == [('StopMove', ())]


def test_zero_move_returning_after_robot_lies_down_does_not_send_stopmove():
    _, sink, normal, _, _, _, measured, frame = rig(0)
    def zero(*velocity):
        normal.calls.append(('Move', velocity))
        measured(0, body_height=.07)
        return 0
    normal.Move = zero
    frame('stop', cause='user_stop')
    sink.drain()
    assert normal.calls == [('Move', ZERO)]


@pytest.mark.parametrize('action', ['StopMove', 'Hello', 'BalanceStand', 'RecoveryStand'])
def test_trial_cannot_wake_stationary_lying_robot(action):
    _, sink, normal, _, _, _, _, frame = rig()
    send(frame, action)
    sink.drain()
    assert sink.actions.result['code'] == 'STANDING_REQUIRED'
    assert normal.calls == []


def test_held_stop_across_retry_deadlines_requires_fresh_resting_evidence():
    clock, sink, normal, emergency, session, client, _, frame = rig()
    frame('stop', cause='user_stop')
    for tick in range(100, 108):
        clock.value += .21
        message = low(tick)
        message.wireless_remote = packet(keys=tick % 2)
        session.feedback.lowstate(message)
        session.feedback.sportmodestate(sport(tick, mode=0, body_height=.07, error_code=1001))
        session.feedback.consume(client)
        sink.drain()
        sink.check_watchdog()
        assert sink.latched and normal.calls == emergency.calls == []
    clock.value += .21
    sink.check_watchdog()
    assert emergency.calls == [('Move', ZERO), ('StopMove', ())]

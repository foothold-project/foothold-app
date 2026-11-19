"""Go2 X idle/low posture: synthetic receipts only, no SDK or DDS access."""
import math

import pytest

from foothold_agent.go2_direct.sink import ZERO
from test_go2_feedback import low, sport
from test_go2_posture import rig, request


@pytest.mark.parametrize('motion_state', [0, 1001, 1002])
@pytest.mark.parametrize('height', [0., .08, .149999])
def test_idle_low_posture_confirms_stop_without_enabling_walking(motion_state, height):
    clock, sink, normal, emergency, session, client, measured, frame = rig(0)
    frame('stop', stop_ref=42)
    assert session._state()['stop_ref'] == 0
    assert not measured(0, body_height=height, error_code=motion_state)
    posture = session.feedback.posture_snapshot()
    assert posture['state'] == 'LYING' and not posture['walkable']
    assert session.core.st['stop_requested'] is True
    assert session._state()['stop_ref'] == 42
    assert sink.latched and session.core.latch
    normal.result = emergency.result = 42  # a lying Go2 may reject StopMove
    sink.drain(); sink.emergency_stop()
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    measured(0, body_height=height, error_code=motion_state)
    frame('cmd', lease_id='fake-lease', seq=1, axes=[0., 0., 0.])
    frame('cmd', lease_id='fake-lease', seq=2, axes=[1.5, 0., 0.])
    sink.drain()
    assert session.core.intent == sink.pending == ZERO
    assert all(name != 'Move' or args == ZERO for name, args in normal.calls + emergency.calls)
    assert session.connected and sink.error is None
    clock.value += .201
    assert session._state()['stop_ref'] == 0  # old evidence cannot acknowledge STOP


@pytest.mark.parametrize('motion_state', [1001, 1002])
def test_idle_low_posture_can_use_existing_authorized_stand_up(motion_state):
    _, sink, normal, _, session, _, measured, frame = rig(0)
    measured(0, body_height=.08, error_code=motion_state)
    request(frame); sink.drain()
    assert ('StandUp', ()) in normal.calls
    measured(6, error_code=motion_state); sink.drain()
    assert normal.calls[-1] == ('BalanceStand', ())
    measured(1); sink.drain()
    assert sink.posture_result['status'] == 'SUCCEEDED'
    assert session.core.latch and sink.latched


@pytest.mark.parametrize('kind', ['joint', 'gyro', 'vx', 'vy', 'vz', 'yaw', 'generation'])
def test_idle_low_posture_keeps_all_physical_stop_gates(kind):
    _, sink, _, _, session, client, _, frame = rig(0)
    frame('stop', stop_ref=42)
    message = low(100, dq=.100001 if kind == 'joint' else 0.,
                  gyro=(.050001, 0., 0.) if kind == 'gyro' else (0., 0., 0.))
    session.feedback.lowstate(message)
    if kind == 'generation':
        frame('stop', stop_ref=43)
    values = dict(vx=(.020001, 0., 0.), vy=(0., .020001, 0.), vz=(0., 0., .060001))
    session.feedback.sportmodestate(sport(100, mode=0, body_height=.08, error_code=1001,
        velocity=values.get(kind, ZERO), yaw_speed=.030001 if kind == 'yaw' else 0.))
    assert not session.feedback.consume(client)
    assert session.feedback.posture_snapshot()['state'] == 'LYING'
    assert session.core.st['stop_requested'] is False
    assert session._state()['stop_ref'] == 0
    assert sink._confirmed_generation is None and sink.latched


@pytest.mark.parametrize('mode,height,progress,tilt', [
    (0, .15, 0., 0.), (0, .17, 0., 0.), (0, .199999, 0., 0.),
    (0, -.01, 0., 0.), (0, float('nan'), 0., 0.),
    (0, .08, 0., 70.), (0, .08, 1., 0.),
    (1, .08, 0., 0.), (3, .08, 0., 0.), (7, .08, 0., 0.), (8, .08, 0., 0.),
])
def test_idle_lying_boundary_stays_closed(mode, height, progress, tilt):
    _, sink, _, _, session, client, _, frame = rig(0)
    frame('stop', stop_ref=42)
    message = low(100)
    message.imu_state.rpy[0] = math.radians(tilt)
    session.feedback.lowstate(message)
    session.feedback.sportmodestate(sport(100, mode=mode, body_height=height, progress=progress))
    assert not session.feedback.consume(client)
    assert session.feedback.posture_snapshot()['state'] in ('UNKNOWN', 'TRANSITIONING')
    assert session.core.st['stop_requested'] is False
    assert session._state()['stop_ref'] == 0 and sink.latched


@pytest.mark.parametrize('mode,height,state,walkable', [
    (5, .08, 'LYING', False), (5, .15, 'LYING', False),
    (5, .30, 'LYING', False), (5, .50, 'LYING', False),
    (0, .32, 'STANDING', True), (1, .32, 'STANDING', True), (3, .32, 'STANDING', True),
])
def test_existing_lying_and_standing_behavior(mode, height, state, walkable):
    _, sink, _, _, session, _, measured, frame = rig(0)
    frame('stop', stop_ref=42)
    assert measured(mode, body_height=height) is walkable
    posture = session.feedback.posture_snapshot()
    assert posture['state'] == state and posture['walkable'] is walkable
    assert session.core.st['stop_requested'] is True
    assert session._state()['stop_ref'] == 42 and sink.latched

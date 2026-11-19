"""Fake DDS display samples; no SDK, robot, or command client."""
from types import SimpleNamespace as NS

import pytest

from foothold_agent.go2_readonly.state import State, SDK_JOINTS
from foothold_agent.go2_direct.readonly import Measurements, Observer
from foothold_agent.go2_direct.reporting import project


def samples():
    low = NS(tick=1, motor_state=[NS(q=i / 10) for i in range(20)],
             imu_state=NS(rpy=[0., 0., 0.], quaternion=[1., 0., 0., 0.]))
    sport = NS(position=[1., 2., .3], mode=0, error_code=0)
    return low, sport


def test_named_sdk_order_independent_sources_omission_and_safety():
    clock = [0.]
    state = State(now=lambda: clock[0], wall=lambda: 1800000000. + clock[0])
    low, sport = samples()
    state.lowstate(low)
    state.sportmodestate(sport)
    snapshot = state.snapshot()
    assert snapshot['joints']['names'] == list(SDK_JOINTS)
    assert snapshot['joints']['positions'] == [i / 10 for i in range(12)]
    assert snapshot['quaternion']['wxyz'] == [1., 0., 0., 0.]
    assert snapshot['position']['xyz'] == [1., 2., .3]
    assert snapshot['position']['origin'] == 'BOOT_ORIGIN_UNVERIFIED'
    assert snapshot['joints']['received_at'] == snapshot['sources']['lowstate']['received_at']
    clock[0] = 1.
    state.lowstate(low)  # duplicate tick cannot make a frozen pose fresh
    assert state.snapshot()['joints']['received_at'] == snapshot['joints']['received_at']
    clock[0] = 2.01
    assert not {'joints', 'quaternion', 'position'} & state.snapshot().keys()
    assert snapshot['motion_enabled'] is False and snapshot['gate'] == 'READ_ONLY'


@pytest.mark.parametrize('bad', [None, [], [float('nan')] * 12, [float('inf')] * 12, [True] * 12])
def test_invalid_samples_omitted(bad):
    state = State()
    low, sport = samples()
    low.motor_state = None if bad is None else [NS(q=q) for q in bad]
    low.imu_state.quaternion = [0., 0., 0., 0.]
    sport.position = [float('nan'), 0., 0.]
    state.lowstate(low)
    state.sportmodestate(sport)
    snapshot = state.snapshot()
    assert not {'joints', 'quaternion', 'position'} & snapshot.keys()
    assert snapshot['fallen'] is False  # replay fields do not affect tilt readout


def test_readonly_observer_uses_shared_projection_and_existing_state_tick():
    measurements = Measurements(now=lambda: 0.)
    low, sport = samples()
    measurements.lowstate(low)
    measurements.sportmodestate(sport)
    observer = Observer(measurements)
    frame = observer._state()
    assert frame['robot_info']['joints']['names'] == list(SDK_JOINTS)
    assert frame['stop_ref'] == 0
    assert frame['robot_info'] == project(measurements.telemetry(), measurements.now())['robot_info']
    # No new publishing timer; the existing Session._state remains the sender.
    assert observer.measurements is measurements


def test_lowstate_temperatures_follow_sdk_slots_and_joint_sample_age():
    clock = [0.]
    measurements = Measurements(now=lambda: clock[0])
    observer = Observer(measurements)
    low, sport = samples()
    for i, motor in enumerate(low.motor_state):
        motor.temperature = 20 + i
    low.bms_state = NS(bq_ntc=[1, 36], mcu_ntc=bytes([37, 150]))
    low.imu_state.temperature = 45
    low.temperature_ntc1, low.temperature_ntc2 = 41, 42
    measurements.lowstate(low)

    clock[0] = 1.25
    info = observer._state()['robot_info']
    assert info['temperature'] == dict(joints=list(range(20, 32)), battery=[1, 36, 37, 150],
                                       imu=45, body=[41, 42], age_s=1.25)
    assert info['temperature']['age_s'] == info['joints']['age_s']
    clock[0] = 2.01
    measurements.lowstate(low)  # duplicate tick
    measurements.sportmodestate(sport)
    assert 'temperature' not in observer._state()['robot_info']


def test_partial_temperature_keeps_positions_and_missing_data_clears_sample():
    measurements = Measurements(now=lambda: 0.)
    observer = Observer(measurements)
    assert 'temperature' not in observer._state()['robot_info']
    low = NS(tick=1, motor_state=[NS(temperature=v) for v in (0, 150, 151, True, -1, 20.5)],
             bms_state=NS(mcu_ntc=[42]), temperature_ntc2=1)
    measurements.lowstate(low)
    assert observer._state()['robot_info']['temperature'] == dict(
        joints=[None, 150] + [None] * 10, battery=[None, None, 42, None],
        imu=None, body=[None, 1], age_s=0.)
    measurements.lowstate(NS(tick=2, motor_state=[NS(temperature=0)] * 12 + [NS(temperature=30)]))
    assert 'temperature' not in observer._state()['robot_info']
    measurements.lowstate(NS(tick=3))
    assert 'temperature' not in observer._state()['robot_info']

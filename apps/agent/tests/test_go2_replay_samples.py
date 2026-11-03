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


def test_only_server_readonly_observer_adds_replay_and_uses_existing_state_tick():
    measurements = Measurements()
    low, sport = samples()
    measurements.lowstate(low)
    measurements.sportmodestate(sport)
    observer = Observer(measurements)
    frame = observer._state()
    assert frame['robot_info']['joints']['names'] == list(SDK_JOINTS)
    assert frame['stop_ref'] == 0
    assert not {'joints', 'quaternion', 'position'} & project(measurements.telemetry(), measurements.now())['robot_info'].keys()
    # No new publishing timer; the existing Session._state remains the sender.
    assert observer.measurements is measurements

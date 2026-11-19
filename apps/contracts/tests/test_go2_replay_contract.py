from copy import deepcopy

import pytest

from apps.contracts.models import Go2RobotInfo


def temperature_sample():
    return dict(joints=list(range(20, 32)), battery=[1, 36, 37, 150], imu=45,
                body=[None, 42], age_s=0.)


def replay_info():
    stamp = '2026-01-01T00:00:00Z'
    return dict(source='GO2_DDS', attitude=dict(roll=0., pitch=0.), error_code=0,
                fallen=False, fallen_source='imu_tilt_estimate',
                joints=dict(received_at=stamp, age_s=0., names=[f'{leg}_{part}_joint' for leg in ('FR', 'FL', 'RR', 'RL') for part in ('hip', 'thigh', 'calf')], positions=[0.] * 12),
                quaternion=dict(received_at=stamp, age_s=0., wxyz=[1., 0., 0., 0.]),
                position=dict(received_at=stamp, age_s=0., xyz=[0., 0., .3], origin='BOOT_ORIGIN_UNVERIFIED'))


def test_legacy_and_new_readouts():
    data = replay_info()
    assert Go2RobotInfo(**data).model_dump(mode='json') == data
    legacy = {k: v for k, v in data.items() if k not in ('joints', 'quaternion', 'position')}
    assert Go2RobotInfo(**legacy).model_dump(mode='json') == legacy


@pytest.mark.parametrize('field,change', [
    ('joints', {'positions': [0.] * 11}), ('joints', {'positions': [True] * 12}),
    ('joints', {'positions': [float('nan')] * 12}), ('joints', {'names': ['FR_hip_joint'] * 12}),
    ('quaternion', {'wxyz': [0.] * 4}), ('quaternion', {'received_at': 'bad'}),
    ('position', {'xyz': [float('inf')] * 3}), ('position', {'origin': 'MAP'}),
])
def test_bad_optional_sample_omitted_without_losing_state(field, change):
    data = deepcopy(replay_info())
    data[field].update(change)
    result = Go2RobotInfo(**data).model_dump(mode='json')
    assert field not in result
    assert result['error_code'] == 0 and result['fallen'] is False


def test_temperature_invalid_readings_preserve_other_channels():
    sample = temperature_sample()
    sample.update(battery=[False, 0, 151, 150], imu='20', body=[1, 1.5])
    info = Go2RobotInfo(**replay_info(), temperature=sample)
    assert info.model_dump(mode='json')['temperature'] == {
        **sample, 'battery': [None, None, None, 150], 'imu': None, 'body': [1, None]}


@pytest.mark.parametrize('change', [
    {'joints': [30] * 11}, {'battery': [30] * 3}, {'body': [30] * 3},
    {'age_s': -1}, {'age_s': float('inf')},
    dict(joints=[0] * 12, battery=[0] * 4, imu=None, body=[0, 0]),
])
def test_invalid_or_empty_temperature_preserves_legacy_state(change):
    data = replay_info()
    info = Go2RobotInfo(**data, temperature={**temperature_sample(), **change})
    assert info.model_dump(mode='json') == data

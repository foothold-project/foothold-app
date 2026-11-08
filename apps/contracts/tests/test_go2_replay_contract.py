from copy import deepcopy

import pytest

from apps.contracts.models import Go2RobotInfo


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

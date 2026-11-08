"""Optional display data stays bounded without rejecting the legacy state."""
import json
import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.contracts.models import AgentState, Go2RobotInfo


def info():
    return dict(source='GO2_DDS', attitude=dict(roll=.1, pitch=-.2), error_code=100,
                fallen=False, fallen_source='imu_tilt_estimate')


def test_generated_contract_additions_are_optional_and_radians_are_bounded():
    schemas = Path(__file__).resolve().parents[1] / 'schema'
    for name in ('AgentState', 'PhoneState', 'ScreenState', 'RobotSummary', 'PhoneRelayState'):
        schema = json.loads((schemas / f'{name}.json').read_text())
        assert 'robot_info' not in schema['required']
        axis = schema['$defs']['Go2Attitude']['properties']['roll']['anyOf'][0]
        assert axis['minimum'] == -math.pi and axis['maximum'] == math.pi
    assert Go2RobotInfo(**info()).model_dump(mode='json') == info()


@pytest.mark.parametrize('value', [float('nan'), float('inf'), -float('inf'), math.pi+.01,
                                       -math.pi-.01, True, '0.1', [], {}])
def test_bad_axis_is_null_and_good_axis_survives(value):
    data = info()
    data['attitude']['roll'] = value
    result = Go2RobotInfo(**data).model_dump(mode='json')
    assert result['attitude'] == dict(roll=None, pitch=-.2)
    assert result['error_code'] == 100
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize('value', [-1, 0x100000000, 1.5, 100., True, '100', float('nan')])
def test_bad_raw_uint32_is_null(value):
    assert Go2RobotInfo(**{**info(), 'error_code': value}).error_code is None


@pytest.mark.parametrize('value', [0, 0xFFFFFFFF])
def test_uint32_edges_are_preserved(value):
    assert Go2RobotInfo(**{**info(), 'error_code': value}).error_code == value


def test_fallen_does_not_coerce_and_source_cannot_expand():
    assert Go2RobotInfo(**{**info(), 'fallen': 1}).fallen is None
    with pytest.raises(ValidationError):
        Go2RobotInfo(**{**info(), 'source': 'invented'})
    legacy = dict(t='state', pose=dict(floor_id=None, x=None, y=None, yaw=None, confidence=None),
                  speed=None, battery=dict(soc=None), latched=True, stop_gen=0, stop_ref=0,
                  applied=[0, 0, 0], mode='FREE')
    assert 'robot_info' not in AgentState(**legacy).model_dump(mode='json')

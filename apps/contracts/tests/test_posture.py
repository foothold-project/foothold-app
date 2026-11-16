from uuid import uuid4

import pytest
from jsonschema import Draft202012Validator
from pydantic import TypeAdapter

from apps.contracts import models as C


@pytest.mark.parametrize('action', ['stand_up', 'stand_down'])
def test_posture_wire_round_trip(action):
    frame = dict(t='posture', id='request', robot=str(uuid4()), lease_id=str(uuid4()), action=action)
    screen = TypeAdapter(C.ScreenMessage).validate_python(frame)
    agent = C.AgentPosture(request_id=screen.id, lease_id=screen.lease_id, action=screen.action)
    wire = agent.model_dump(mode='json')
    assert TypeAdapter(C.ServerAgentMessage).validate_python(wire).action == action
    Draft202012Validator(C.AgentPosture.model_json_schema()).validate(wire)


@pytest.mark.parametrize('action', ['damp', 'recovery_stand', 'jump', 'dance', '', None])
def test_no_unreviewed_posture_actions(action):
    with pytest.raises(ValueError):
        C.AgentPosture(request_id='request', lease_id=uuid4(), action=action)


@pytest.mark.parametrize('status', ['RUNNING', 'SUCCEEDED', 'REJECTED', 'FAILED'])
def test_posture_result_preserves_raw_sdk_code(status):
    result = C.PostureResult(request_id='request', action='stand_up', status=status,
        code='SDK_REJECTED', sdk_code=3102)
    assert result.model_dump()['sdk_code'] == 3102
    with pytest.raises(ValueError):
        C.PostureResult.model_validate({**result.model_dump(), 'sdk_code': True})


def test_posture_mode_is_bounded_strict_sdk_value():
    assert C.PostureState(state='LYING', mode=5).mode == 5
    for mode in (True, -1, 256, '5'):
        with pytest.raises(ValueError): C.PostureState(state='UNKNOWN', mode=mode)

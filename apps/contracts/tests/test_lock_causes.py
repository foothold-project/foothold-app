from typing import get_args
from uuid import uuid4
import pytest
from jsonschema import Draft202012Validator
from pydantic import TypeAdapter, ValidationError
from apps.contracts import models as C


@pytest.mark.parametrize('model,frame', [
    (C.AgentStop, dict(t='stop', by_user_id=None, stop_ref=1)),
    (C.AgentLease, dict(t='lease', lease_id=None, holder_type=None)),
])
def test_cause_is_optional_and_legacy_serialization_unchanged(model, frame):
    parsed = model.model_validate(frame)
    assert parsed.model_dump(mode='json') == frame
    schema = model.model_json_schema(mode='serialization')
    assert 'cause' not in schema['required']
    Draft202012Validator(schema).validate(frame)
    for cause in get_args(C.AgentLockCause):
        wire = {**frame, 'cause': cause}
        assert TypeAdapter(C.ServerAgentMessage).validate_python(wire).model_dump(mode='json') == wire
        Draft202012Validator(schema).validate(wire)


@pytest.mark.parametrize('bad', ['private-token', 'user_stop\nsecret', '', 4, [], {}])
def test_cause_accepts_fixed_codes_only(bad):
    with pytest.raises(ValidationError):
        C.AgentStop(t='stop', by_user_id=None, stop_ref=1, cause=bad)


def test_cause_never_relaxes_existing_validation():
    with pytest.raises(ValidationError):
        C.AgentStop(t='stop', by_user_id=None, stop_ref=True, cause='user_stop')
    with pytest.raises(ValidationError):
        C.AgentLease(t='lease', lease_id=uuid4(), holder_type='OTHER', cause='lease_expired')

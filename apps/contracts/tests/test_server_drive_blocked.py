"""Additive display reasons accept legacy summaries and only known codes."""
import json
from uuid import uuid4

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from apps.contracts import generate, models as C


def test_reason_contract_is_optional_nullable_and_restricted():
    files = generate.build()
    for name in ('RobotSummary', 'RobotList', 'RobotCreated'):
        schema = json.loads(files[f'schema/{name}.json'])
        summary = schema if name == 'RobotSummary' else schema['$defs']['RobotSummary']
        assert 'server_drive_blocked' not in summary['required']
    schema = json.loads(files['schema/RobotSummary.json'])
    legacy = dict(id=str(uuid4()), name='fake', model='unitree_go2', simulation=False,
        server_drive_allowed=False, owner=None, connection='OFFLINE', status=None,
        battery=None, location=None, lease=None, current_run=None, devices=[], attention=[])
    validator = Draft202012Validator(schema)
    validator.validate(legacy)
    assert C.RobotSummary(**legacy).server_drive_blocked is None
    for value in (None, [], ['SWITCH_OFF', 'NO_OWNER', 'NO_SERIAL', 'AGENT_OFFLINE']):
        payload = dict(legacy, server_drive_blocked=value)
        validator.validate(payload)
        assert C.RobotSummary(**payload).model_dump(mode='json')['server_drive_blocked'] == value
    with pytest.raises(ValidationError):
        C.RobotSummary(**legacy, server_drive_blocked=['UNKNOWN'])

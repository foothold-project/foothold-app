"""Optional editing metadata stays outside the agent execution contract."""
import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from apps.contracts import models as C

U = '00000000-0000-0000-0000-000000000001'
POINT = dict(floor_id=U, map_version_id=U, x=1., y=2., mission_id=U, mission_version=1)


@pytest.mark.parametrize('fields', [{}, {'name': None, 'wait_s': None},
    {'name': '입구', 'wait_s': 5}, {'name': '가' * 60, 'wait_s': 3600}, {'wait_s': 1}])
def test_optional_waypoint_fields_and_old_snapshots(fields):
    point = C.ScenarioWaypoint(**POINT, **fields)
    wire = point.model_dump(mode='json')
    assert point.name == fields.get('name') and point.wait_s == fields.get('wait_s')
    Draft202012Validator(C.ScenarioWaypoint.model_json_schema()).validate(wire)
    if point.name is None:
        assert 'name' not in wire
    if point.wait_s is None:
        assert 'wait_s' not in wire


@pytest.mark.parametrize('fields', [
    {'name': ''}, {'name': '   '}, {'name': '가' * 61}, {'name': '입구\n'},
    {'name': '입\u200b구'}, {'name': 123}, {'wait_s': 0}, {'wait_s': 3601},
    {'wait_s': True}, {'wait_s': 5.0}, {'wait_s': 1.5}, {'wait_s': '5'}])
def test_invalid_waypoint_fields(fields):
    with pytest.raises(ValidationError):
        C.ScenarioWaypoint(**POINT, **fields)


@pytest.mark.parametrize('model', [C.AgentScenarioWaypoint, C.ExecutableAgentScenarioWaypoint])
def test_agent_contract_has_no_editing_metadata(model):
    fields = dict(POINT, mission_name='대기', mission_steps=[{'action': 'WAIT', 'params': {'seconds': 5}}],
                  required_capabilities=['wait'])
    assert not {'name', 'wait_s'} & model.model_fields.keys()
    assert not {'name', 'wait_s'} & model(**fields).model_dump(mode='json').keys()
    for extra in ({'name': '입구'}, {'wait_s': 5}):
        with pytest.raises(ValidationError):
            model(**fields, **extra)

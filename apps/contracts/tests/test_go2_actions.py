from typing import get_args
from uuid import uuid4
import pytest
from pydantic import TypeAdapter
from apps.contracts import models as C
from apps.agent.foothold_agent.go2_direct.actions import ACTIONS, FLAGS, arguments


def params(action):
    return dict(roll=.1, pitch=-.1, yaw=0.) if action == 'Euler' else dict(level=0) if action == 'SpeedLevel' else dict(enabled=True) if action in FLAGS else dict(mode='normal') if action == 'SelectMode' else {}


@pytest.mark.parametrize('action', sorted(ACTIONS))
def test_all_actions_roundtrip_and_agent_validation_match(action):
    assert set(get_args(C.Go2ActionName)) == ACTIONS
    frame = dict(t='action', id='trial', robot=str(uuid4()), lease_id=str(uuid4()), action=action, params=params(action), confirmed=True)
    request = TypeAdapter(C.ScreenMessage).validate_python(frame)
    agent = C.AgentAction(request_id=request.id, lease_id=request.lease_id, action=request.action, params=request.params, confirmed=request.confirmed)
    wire = agent.model_dump(mode='json')
    assert TypeAdapter(C.ServerAgentMessage).validate_python(wire).action == action
    assert arguments(action, wire['params']) == arguments(action, params(action))


@pytest.mark.parametrize('action,p', [('Euler', dict(roll=.51, pitch=0, yaw=0)), ('Euler', dict(roll=float('nan'), pitch=0, yaw=0)), ('Euler', dict(roll=True, pitch=0, yaw=0)), ('Euler', dict(roll='0', pitch=0, yaw=0)), ('SpeedLevel', dict(level=2)), ('SpeedLevel', dict(level=True)), ('Pose', dict(enabled=1)), ('SelectMode', dict(mode='../lowcmd')), ('SelectMode', dict(mode='x'*33)), ('Sit', dict(enabled=True)), ('Euler', {}), ('Sit', dict(extra=0))])
def test_invalid_arguments_rejected_at_both_boundaries(action, p):
    with pytest.raises(ValueError): C.Go2ActionRequest(action=action, params=p)
    with pytest.raises(ValueError): arguments(action, p)


@pytest.mark.parametrize('name', ['Move', 'ReleaseMode', 'lowcmd', '_Call', 'unknown'])
def test_no_movement_lowlevel_or_release(name):
    with pytest.raises(ValueError): C.Go2ActionRequest(action=name)
    with pytest.raises(ValueError): arguments(name, {})

"""The agent's local field gate reaches the screen and robot summary as display only."""
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from apps.contracts import models as C
from apps.server.fh_server.realtime import AGENT, Realtime
from apps.server.fh_server.robots import robot_objects
from .test_automatic_field_gate import relay  # noqa: F401
from .test_realtime import state
from .test_screen_safety_reason import runtime  # noqa: F401


@pytest.mark.parametrize('value', ['OPEN', 'CLOSED', None])
def test_agent_contract_accepts_field_gate(value):
    assert AGENT.validate_python(state(field_gate=value)).field_gate == value
    assert AGENT.validate_python(state()).field_gate is None


@pytest.mark.parametrize('value', ['open', 'UNKNOWN', '', 1, True])
def test_invalid_field_gate_rejected(value):
    with pytest.raises(ValidationError):
        AGENT.validate_python(state(field_gate=value))


def test_screen_state_passes_field_gate_and_old_agent_is_null(runtime):
    realtime, rid, other = runtime
    peer = realtime.agents[rid]
    accept = lambda **kw: Realtime.accept_state(realtime, rid, peer, C.AgentState.model_validate(state(**kw)))
    assert accept(field_gate='CLOSED')
    assert Realtime.screen_state(realtime, rid)['field_gate'] == 'CLOSED'
    assert Realtime.screen_state(realtime, other)['field_gate'] is None
    assert accept(field_gate='OPEN')
    assert Realtime.screen_state(realtime, rid)['field_gate'] == 'OPEN'
    assert accept()  # old agent: field absent
    assert Realtime.screen_state(realtime, rid)['field_gate'] is None
    assert accept(field_gate='CLOSED')
    realtime.clock.step(3.001)
    assert Realtime.screen_state(realtime, rid)['field_gate'] is None


def summary(realtime, rid, owner, *, simulation=False):
    robot = SimpleNamespace(id=UUID(rid), name='fake', model='unitree_go2', simulation=simulation,
        owner_user_id=owner, serial='1234-test')
    user = SimpleNamespace(id=owner, org_id=uuid4(), role='OPERATOR')
    db = MagicMock()
    db.scalars.return_value = []
    db.execute.return_value = []
    db.get.return_value = SimpleNamespace(settings={})
    return robot_objects(db, [robot], user, realtime)[0]


@pytest.mark.parametrize('gate, expected', [('CLOSED', ['FIELD_GATE_CLOSED']), ('OPEN', []), (None, [])])
def test_closed_field_gate_is_its_own_blocked_reason(relay, gate, expected):
    realtime, rid, owner, peer, sent = relay
    peer.state_received_at = realtime.clock()
    peer.state['field_gate'] = gate
    body = summary(realtime, rid, owner)
    assert body.server_drive_allowed is True  # display only, decision unchanged
    assert body.server_drive_blocked == expected
    assert summary(realtime, rid, owner, simulation=True).server_drive_blocked is None


def test_server_side_reason_is_not_doubled_by_closed_field_gate(relay):
    # Keeps the web's single-AGENT_OFFLINE reconnect rule (keepDrive) unchanged.
    realtime, rid, owner, peer, sent = relay
    realtime.field_approvals[rid] = None
    peer.state_received_at = realtime.clock()
    peer.state['field_gate'] = 'CLOSED'
    assert summary(realtime, rid, owner).server_drive_blocked == ['AGENT_OFFLINE']

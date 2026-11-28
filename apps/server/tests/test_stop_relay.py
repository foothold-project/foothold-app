"""Display field: does the server pass STOP to this robot's connected agent now.

The value must come from the same gate that drops agent STOP effects, so it
follows the connection-time switch snapshot (peer.server_drive), not the
current switch, owner, serial or field approval.
"""
import asyncio
import dataclasses
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest

from apps.server.fh_server.robots import robot_objects
from .test_automatic_field_gate import relay  # noqa: F401 — connected fake peer
from .test_server_drive import trial  # noqa: F401 — isolated fixture


def summary(realtime, rid, viewer, role='OPERATOR', owner=None, simulation=False):
    robot = SimpleNamespace(id=UUID(rid), name='fake', model='unitree_go2', simulation=simulation,
        owner_user_id=owner if owner is not None else viewer, serial='1234-test')
    db = MagicMock()
    db.scalars.return_value = []
    db.execute.return_value = []
    db.get.return_value = SimpleNamespace(settings={})
    user = SimpleNamespace(id=viewer, org_id=uuid4(), role=role)
    return robot_objects(db, [robot], user, realtime)[0]


def test_switch_on_connection_delivers(relay):
    rt, rid, owner, peer, sent = relay
    assert rt.stop_relay(rid) == 'DELIVERS'
    assert summary(rt, rid, owner).stop_relay == 'DELIVERS'


def test_switch_off_after_connection_keeps_peer_snapshot(relay):
    rt, rid, owner, peer, sent = relay
    rt.settings.drive_enabled = lambda robot_id: False
    assert peer.server_drive is True
    result = summary(rt, rid, owner)
    # Current switch reads off, but STOP still reaches the agent.
    assert result.server_drive_blocked == ['SWITCH_OFF']
    assert result.stop_relay == 'DELIVERS'
    assert asyncio.run(rt.send_body(peer, {'t': 'stop'})) is True


def test_switch_off_connection_blocks(relay):
    rt, rid, owner, peer, sent = relay
    peer.server_drive = False
    assert summary(rt, rid, owner).stop_relay == 'BLOCKED_SWITCH_OFF'
    assert asyncio.run(rt.send_body(peer, {'t': 'stop'})) is False


@pytest.mark.parametrize('case', ['none', 'closing'])
def test_no_agent(relay, case):
    rt, rid, owner, peer, sent = relay
    if case == 'none':
        rt.agents = {}
    else:
        peer.closing = True
    assert summary(rt, rid, owner).stop_relay == 'NO_AGENT'


def test_no_field_approval_still_delivers(relay):
    rt, rid, owner, peer, sent = relay
    rt.field_approvals[rid] = None
    assert not rt.field_approved(rid)
    result = summary(rt, rid, owner)
    assert result.server_drive_allowed is False
    assert result.stop_relay == 'DELIVERS'


def test_viewer_without_full_view_gets_null(relay):
    rt, rid, owner, peer, sent = relay
    assert summary(rt, rid, uuid4(), owner=owner).stop_relay is None
    assert summary(rt, rid, uuid4(), role='ORG_ADMIN', owner=owner).stop_relay == 'DELIVERS'


def test_simulation_follows_same_gate(relay):
    rt, rid, owner, peer, sent = relay
    peer.simulation, peer.server_drive = True, False
    assert summary(rt, rid, owner, simulation=True).stop_relay == 'DELIVERS'
    rt.agents = {}
    assert summary(rt, rid, owner, simulation=True).stop_relay == 'NO_AGENT'


@pytest.mark.parametrize('actor', [None, 'screen'])
@pytest.mark.parametrize('simulation', [False, True])
@pytest.mark.parametrize('server_drive', [False, True])
@pytest.mark.parametrize('switch', [False, True])
@pytest.mark.parametrize('approved', [False, True])
def test_stop_relay_always_matches_stop_gate(relay, actor, simulation, server_drive, switch, approved):
    rt, rid, owner, peer, sent = relay
    peer.actor = SimpleNamespace() if actor else None
    peer.simulation, peer.server_drive = simulation, server_drive
    rt.settings.drive_enabled = lambda robot_id: switch
    if not approved:
        rt.field_approvals[rid] = None
    blocked = rt.blocked_agent_control(peer, {'t': 'stop'})
    assert rt.stop_relay(rid) == ('BLOCKED_SWITCH_OFF' if blocked else 'DELIVERS')
    # Final send path agrees too.
    assert asyncio.run(rt.send_body(peer, {'t': 'stop'})) is (not blocked)


def test_real_connections_report_connection_snapshot(trial, seeded):
    # Existing isolated TestClient/WS fixture only; no real robot or service.
    from .test_realtime import app_token, hello, receive

    mine, theirs = (str(seeded['robots'][k]) for k in ('mine', 'theirs'))
    one, two, admin = (app_token(trial, name) for name in ('one', 'two', 'admin'))
    get = lambda rid, who: trial.get('/api/v1/robots/' + rid, headers=who).json()
    assert get(mine, one)['stop_relay'] == 'NO_AGENT'
    assert get(mine, two)['stop_relay'] is None
    realtime = trial.app.state.realtime
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + mine}) as ag, trial.websocket_connect(
            '/api/v1/agent/ws', headers={'authorization': 'Bearer fake-test-' + theirs}) as off:
        ag.send_json(hello())
        receive(ag, 'lease'); receive(ag, 'stop')
        off.send_json(hello())
        receive(off, 'field_approval')
        assert get(mine, admin)['stop_relay'] == 'DELIVERS'
        assert get(theirs, two)['stop_relay'] == 'BLOCKED_SWITCH_OFF'
        assert get(theirs, two)['server_drive_blocked'] == ['SWITCH_OFF']
        # Switch off after connection: peer keeps its connection-time value.
        realtime.settings = dataclasses.replace(realtime.settings, server_drive_robots=frozenset())
        after = get(mine, one)
        assert after['server_drive_blocked'] == ['SWITCH_OFF']
        assert after['stop_relay'] == 'DELIVERS'

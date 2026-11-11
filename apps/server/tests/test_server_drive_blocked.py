"""Display reasons never replace the existing boolean control decision."""
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest

from apps.server.fh_server.robots import robot_objects
from .test_automatic_field_gate import relay  # noqa: F401 — connected fake peer
from .test_server_drive import trial  # noqa: F401 — isolated fixture


@pytest.mark.parametrize('simulation', [False, True])
@pytest.mark.parametrize('switch', [False, True])
@pytest.mark.parametrize('owned', [False, True])
@pytest.mark.parametrize('serial', [None, '', '1234-test'])
@pytest.mark.parametrize('approved', [False, True])
def test_reasons_and_allowed_match_existing_conditions(simulation, switch, owned, serial, approved):
    owner, org_id = uuid4(), uuid4()
    robot = SimpleNamespace(id=uuid4(), name='fake', model='unitree_go2', simulation=simulation,
        owner_user_id=owner if owned else None, serial=serial)
    realtime = SimpleNamespace(agents={}, settings=SimpleNamespace(drive_enabled=lambda rid: switch),
        field_approved=lambda rid: approved, arbiter=SimpleNamespace(robots={}))
    db = MagicMock()
    db.scalars.return_value = []
    db.execute.return_value = []
    db.get.return_value = SimpleNamespace(settings={})
    expected_allowed = not simulation and switch and owned and bool(serial) and approved
    expected_reasons = [code for code, valid in (
        ('SWITCH_OFF', switch), ('NO_OWNER', owned), ('NO_SERIAL', bool(serial))) if not valid]
    if not expected_reasons and not approved:
        expected_reasons.append('AGENT_OFFLINE')
    # Admin always has full view; an owner does too. Other operators see null,
    # including when the existing global boolean happens to be true.
    for role, viewer in [('ORG_ADMIN', uuid4()), ('OPERATOR', owner), ('OPERATOR', uuid4())]:
        user = SimpleNamespace(id=viewer, org_id=org_id, role=role)
        summary = robot_objects(db, [robot], user, realtime)[0].model_dump(mode='json')
        assert summary['server_drive_allowed'] is expected_allowed
        full = role == 'ORG_ADMIN' or robot.owner_user_id == viewer
        assert summary['server_drive_blocked'] == (expected_reasons if not simulation and full else None)


def test_switch_off_with_connected_laptop_only_reports_switch(relay):
    realtime, rid, owner, peer, sent = relay
    assert realtime.field_approved(rid)
    realtime.settings.drive_enabled = lambda robot_id: False
    # The real composite gate is now false despite the connected fake peer.
    assert not realtime.field_approved(rid)
    robot = SimpleNamespace(id=UUID(rid), name='fake', model='unitree_go2', simulation=False,
        owner_user_id=owner, serial='1234-test')
    user = SimpleNamespace(id=owner, org_id=uuid4(), role='OPERATOR')
    db = MagicMock()
    db.scalars.return_value = []
    db.execute.return_value = []
    db.get.return_value = SimpleNamespace(settings={})
    summary = robot_objects(db, [robot], user, realtime)[0]
    assert summary.connection == 'ONLINE'
    assert summary.server_drive_allowed is False
    assert summary.server_drive_blocked == ['SWITCH_OFF']


def test_reason_snapshot_with_real_gate_does_not_change_admin_control(trial, seeded):
    # Existing isolated TestClient/WS fixture only; no real robot or service.
    from .test_realtime import app_token, hello, receive

    rid = str(seeded['robots']['mine'])
    owner, admin, other = (app_token(trial, name) for name in ('one', 'admin', 'two'))
    path = '/api/v1/robots/' + rid
    for viewer in (owner, admin):
        summary = trial.get(path, headers=viewer).json()
        assert summary['server_drive_allowed'] is False
        assert summary['server_drive_blocked'] == ['AGENT_OFFLINE']
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease'); receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        for viewer in (owner, admin):
            summary = trial.get(path, headers=viewer).json()
            assert summary['server_drive_allowed'] is True
            assert summary['server_drive_blocked'] == []
        assert trial.get(path, headers=other).json()['server_drive_blocked'] is None
        denied = trial.post(path + '/stop', headers=admin)
        assert denied.status_code == 403
        assert denied.json()['error']['code'] == 'ADMIN_NO_REAL_CONTROL'

"""Admin management stays global; motion and STOP use trusted DB provenance."""
import time
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.api import (
    ADMIN_NO_REAL_CONTROL, APIError, Settings, authorize, create_app,
)
from apps.server.fh_server.models import PhonePass, PhoneRevocation, Robot
from apps.server.fh_server.realtime import policy_rights
from .test_api import csrf
from .test_phone_pass import pc, issue
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take
from .test_maps import maps
from .test_assignments import scenario, assignment


@pytest.mark.parametrize('simulation', [False, True, None, 'true', 1])
def test_admin_control_requires_true_db_flag(simulation):
    user = SimpleNamespace(id=uuid4(), org_id=uuid4(), role='ORG_ADMIN')
    robot = SimpleNamespace(org_id=user.org_id, owner_user_id=uuid4(), simulation=simulation)
    for permission in ('ROBOT_READ', 'ROBOT_SUMMARY', 'A'):
        authorize(user, permission, robot)
    for permission in ('O_OWN', 'ROBOT_STOP'):
        if simulation is True:
            authorize(user, permission, robot)
        else:
            with pytest.raises(APIError) as error:
                authorize(user, permission, robot)
            assert (error.value.status, error.value.code, error.value.message) == (
                403, 'ADMIN_NO_REAL_CONTROL', ADMIN_NO_REAL_CONTROL)


def test_cached_acl_key_includes_simulation_and_preserves_management():
    uid, org, rid, owner = uuid4(), uuid4(), uuid4(), uuid4()
    user = (uid, org, 'ORG_ADMIN', False, None)
    def rights(sim):
        return policy_rights(authorize, APIError, user, ((rid, org, None, owner, 'hash', sim),))[str(rid)]
    real, sim = rights(False), rights(True)
    assert {'ROBOT_READ', 'ROBOT_SUMMARY', 'ADMIN_NO_REAL_CONTROL'} <= real
    assert not {'O_OWN', 'ROBOT_STOP'} & real
    assert {'ROBOT_READ', 'ROBOT_SUMMARY', 'O_OWN', 'ROBOT_STOP'} <= sim


@pytest.mark.parametrize('purpose', ['control', 'view'])
def test_admin_pass_real_denied_sim_allowed(pc, seeded, purpose):
    pc.pass_headers = csrf(pc, 'admin')
    denied = issue(pc, seeded, purpose=purpose)
    assert denied.status_code == 403
    assert denied.json()['error'] == dict(code='ADMIN_NO_REAL_CONTROL', message=ADMIN_NO_REAL_CONTROL, detail={})
    with DBSession(pc.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = True
        db.commit()
    assert issue(pc, seeded, purpose=purpose).status_code == 200
    pc.pass_headers = csrf(pc, 'one')
    assert issue(pc, seeded).status_code == 200


def test_admin_real_ws_denials_and_live_read(client, seeded, rt):
    rid = seeded['robots']['mine']
    headers = app_token(client, 'admin')
    operator = app_token(client)
    with agent(client, seeded) as ag, screen(client, operator) as owner, screen(client, headers) as ws:
        lease = take(owner, ag, rid)
        holder = rt.arbiter.robot(str(rid)).holder
        assert reply(ws, send(ws, 'sub', robots=[str(rid)], streams=['state']))['ok']
        ag.send_json(state())
        assert receive(ws, 'state')['robot'] == str(rid)
        before = rt.arbiter.robot(str(rid)).stop_ref
        operations = [('lease.take', {}), ('lease.request', {}),
            ('lease.respond', dict(request_id=str(uuid4()), accept=True)),
            ('cmd', dict(lease_id=str(uuid4()), seq=0, axes=[1, 0, 0])),
            ('unlock', dict(lease_id=str(uuid4()), stop_gen=1)), ('stop', {})]
        for kind, fields in operations:
            result = reply(ws, send(ws, kind, rid, **fields))
            assert result['error']['code'] == 'ADMIN_NO_REAL_CONTROL', result
            assert result['error']['message'] == ADMIN_NO_REAL_CONTROL
        assert rt.arbiter.robot(str(rid)).holder == holder
        assert rt.arbiter.robot(str(rid)).stop_ref == before
        assert reply(owner, send(owner, 'cmd', rid, lease_id=lease, seq=0, axes=[0, 0, 0]))['ok']
        receive(ag, 'cmd')
        denied = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
        assert denied.status_code == 403
        assert denied.json()['error']['code'] == 'ADMIN_NO_REAL_CONTROL'
        assert reply(ws, send(ws, 'ping'))['ok']
        assert client.get(f'/api/v1/robots/{rid}', headers=headers).status_code == 200
        assert client.get('/api/v1/dashboard', headers=headers).status_code == 200


def test_admin_sim_motion_unlock_and_stops_allowed(client, seeded, rt):
    rid = seeded['robots']['mine']
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).simulation = True
        db.commit()
    headers = app_token(client, 'admin')
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        lease = take(ws, ag, rid)
        assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[0, 0, 0]))['ok']
        receive(ag, 'cmd')
        assert reply(ws, send(ws, 'unlock', rid, lease_id=lease, stop_gen=3))['ok']
        receive(ag, 'unlock')
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop')
        assert client.post(f'/api/v1/robots/{rid}/stop', headers=headers).status_code == 202
        receive(ag, 'stop')


def test_real_admin_assignments_and_robot_settings_unchanged(maps, seeded):
    http, headers, _ = maps
    value, _, _, _ = scenario(http, headers)
    result = assignment(http, headers, value, seeded['robots']['mine'])
    assert result.status_code == 201 and result.json()['status'] == 'ACTIVE'
    assert http.delete('/api/v1/assignments/' + result.json()['id'], headers=headers).status_code == 204
    rid = seeded['robots']['mine']
    result = http.patch(f'/api/v1/robots/{rid}', headers=headers,
        json={'name': '관리 유지'})
    assert result.status_code == 200, result.text


def test_restart_retains_legacy_pass_metadata_and_denies_new_admin_control(seeded):
    engine = create_engine(seeded['urls']['migrate'])
    current = int(time.time())
    tickets = []
    with DBSession(engine) as db:
        db.get(Robot, seeded['robots']['theirs']).simulation = True
        for user, robot, purpose in [('admin', 'mine', 'control'), ('admin', 'mine', 'view'),
                ('admin', 'theirs', 'control'), ('one', 'mine', 'control')]:
            row = PhonePass(org_id=seeded['org'], user_id=seeded['users'][user],
                robot_id=seeded['robots'][robot], device=uuid4(), purpose=purpose,
                jti=uuid4(), iat=current, exp=current + 600)
            db.add(row)
            tickets.append(row.jti)
        db.commit()
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    try:
        with TestClient(app, base_url='https://testserver') as http:
            assert not app.state.realtime.arbiter.robots
            with DBSession(app.state.engine) as db:
                assert not list(db.scalars(select(PhoneRevocation.jti)))
                assert set(db.scalars(select(PhonePass.jti))) == set(tickets)
            headers = app_token(http, 'admin')
            result = http.post(f"/api/v1/robots/{seeded['robots']['mine']}/phone-pass",
                headers=headers, json={'device': str(uuid4()), 'purpose': 'control'})
            assert result.status_code == 403 and result.json()['error']['code'] == 'ADMIN_NO_REAL_CONTROL'
    finally:
        app.state.engine.dispose()
        engine.dispose()

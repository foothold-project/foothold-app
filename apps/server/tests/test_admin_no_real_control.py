"""팀장 11/28: 총괄(ORG_ADMIN)은 실기도 조종·정지한다. 담당 아닌 운영자는 여전히 거절,
안전 관문(현장 폰 직접 · 정지 잠김 · 조종권 하나)은 총괄에게도 그대로다."""
import asyncio
import time
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.api import (
    APIError, Settings, authorize, create_app,
)
from apps.server.fh_server.models import PhonePass, PhoneRevocation, Robot
from apps.server.fh_server.realtime import policy_rights
from .test_api import csrf
from .test_phone_pass import pc, issue
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take
from .test_maps import maps
from .test_assignments import scenario, assignment
from .test_realtime_review import run


@pytest.mark.parametrize('simulation', [False, True, None, 'true', 1])
def test_admin_control_any_db_flag_but_nonowner_operator_denied(simulation):
    user = SimpleNamespace(id=uuid4(), org_id=uuid4(), role='ORG_ADMIN')
    robot = SimpleNamespace(org_id=user.org_id, owner_user_id=uuid4(), simulation=simulation)
    for permission in ('ROBOT_READ', 'ROBOT_SUMMARY', 'A', 'O_OWN', 'ROBOT_STOP'):
        authorize(user, permission, robot)
    operator = SimpleNamespace(id=uuid4(), org_id=user.org_id, role='OPERATOR')
    with pytest.raises(APIError) as error:
        authorize(operator, 'O_OWN', robot)
    assert (error.value.status, error.value.code) == (403, 'NOT_ROBOT_OWNER')


def test_cached_acl_key_includes_simulation_and_preserves_management():
    uid, org, rid, owner = uuid4(), uuid4(), uuid4(), uuid4()
    user = (uid, org, 'ORG_ADMIN', False, None)
    def rights(sim):
        return policy_rights(authorize, APIError, user, ((rid, org, None, owner, 'hash', sim),))[str(rid)]
    real, sim = rights(False), rights(True)
    assert {'ROBOT_READ', 'ROBOT_SUMMARY', 'O_OWN', 'ROBOT_STOP'} <= real
    assert 'ADMIN_NO_REAL_CONTROL' not in real
    assert {'ROBOT_READ', 'ROBOT_SUMMARY', 'O_OWN', 'ROBOT_STOP'} <= sim


@pytest.mark.parametrize('purpose', ['control', 'view'])
def test_admin_pass_real_and_sim_allowed_nonowner_operator_denied(pc, seeded, purpose):
    pc.pass_headers = csrf(pc, 'two')
    if purpose == 'control':
        assert issue(pc, seeded, purpose=purpose).status_code == 404
    pc.pass_headers = csrf(pc, 'admin')
    assert issue(pc, seeded, purpose=purpose).status_code == 200
    with DBSession(pc.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = True
        db.commit()
    assert issue(pc, seeded, purpose=purpose).status_code == 200
    pc.pass_headers = csrf(pc, 'one')
    assert issue(pc, seeded).status_code == 200


def test_admin_real_ws_keeps_phone_direct_gate_and_live_read(client, seeded, rt):
    rid = seeded['robots']['mine']
    headers = app_token(client, 'admin')
    operator = app_token(client)
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).simulation = False
        db.commit()
    with agent(client, seeded, direct=True) as ag, screen(client, operator) as owner, screen(client, headers) as ws:
        holder = rt.arbiter.robot(str(rid)).holder
        assert reply(ws, send(ws, 'sub', robots=[str(rid)], streams=['state']))['ok']
        ag.send_json(state())
        assert receive(ws, 'state')['robot'] == str(rid)
        before = rt.arbiter.robot(str(rid)).stop_ref
        operations = [('lease.take', {}), ('lease.request', {}),
            ('lease.respond', dict(request_id=str(uuid4()), accept=True)),
            ('cmd', dict(lease_id=str(uuid4()), seq=0, axes=[1, 0, 0])),
            ('unlock', dict(lease_id=str(uuid4()), stop_gen=1)), ('stop', {})]
        # 총괄도 실기 서버 조종이 꺼진 로봇에는 같은 안전 관문(PHONE_DIRECT_REQUIRED)에 걸린다.
        for kind, fields in operations:
            result = reply(ws, send(ws, kind, rid, **fields))
            assert result['error']['code'] == 'PHONE_DIRECT_REQUIRED', result
        assert rt.arbiter.robot(str(rid)).holder == holder
        assert rt.arbiter.robot(str(rid)).stop_ref == before
        assert reply(owner, send(owner, 'cmd', rid, lease_id=str(uuid4()), seq=0, axes=[0, 0, 0]))['error']['code'] == 'PHONE_DIRECT_REQUIRED'
        denied = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
        assert denied.status_code == 403
        assert denied.json()['error']['code'] == 'PHONE_DIRECT_REQUIRED'
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


@pytest.mark.parametrize('change', ['simulation', 'promotion', 'read'])
def test_live_control_revocation_preserves_only_authorized_subscriptions(client, seeded, rt, change):
    rid = str(seeded['robots']['mine'])
    if change == 'simulation':
        with DBSession(client.app.state.engine) as db:
            db.get(Robot, seeded['robots']['mine']).simulation = True
            db.commit()
    if change == 'read':
        with DBSession(client.app.state.engine) as db:
            db.get(Robot, seeded['robots']['mine']).simulation = False
            db.commit()
    headers = app_token(client, 'admin' if change == 'simulation' else 'one')
    admin_headers = csrf(client, 'admin')
    with agent(client, seeded, direct=(change == 'read')) as ag, screen(client, headers) as ws:
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        lease = take(ws, ag, rid) if change != 'read' else str(uuid4())
        before = rt.arbiter.robot(rid).stop_ref
        if change == 'simulation':
            with DBSession(client.app.state.engine) as db:
                db.get(Robot, seeded['robots']['mine']).simulation = False
                db.commit()
        elif change == 'promotion':
            with DBSession(client.app.state.engine) as db:
                db.get(Robot, seeded['robots']['mine']).simulation = False
                db.commit()
            result = client.patch(f"/api/v1/users/{seeded['users']['one']}",
                headers=admin_headers, json={'role': 'ORG_ADMIN'})
            assert result.status_code == 200, result.text
        else:
            result = client.patch(f'/api/v1/robots/{rid}', headers=headers,
                json={'owner_user_id': str(seeded['users']['two'])})
            assert result.status_code == 200, result.text


        async def revoked():
            async with asyncio.timeout(2):
                while any('O_OWN' in peer.policy.rights.get(rid, ()) for peer in rt.screens.values()):
                    await asyncio.sleep(.01)
            robot = rt.arbiter.robot(rid)
            assert robot.holder is None and robot.request is None and robot.transfer is None
            return next(iter(rt.screens.values()))
        peer = run(client, revoked)
        if change == 'read':
            assert receive(ws, 'subscription.revoked')['reason'] == 'ACCESS_REVOKED'
            assert rid not in peer.subscriptions
            assert rid in peer.revoked_robots
            assert client.get(f'/api/v1/robots/{rid}', headers=headers).status_code == 200
        else:
            assert 'ROBOT_READ' in peer.policy.rights[rid]
            assert peer.subscriptions == {rid: {'state'}}
            assert rid not in peer.revoked_robots
            assert client.get(f'/api/v1/robots/{rid}', headers=headers).status_code == 200
            ag.send_json({**state(4, stop_ref=rt.arbiter.robot(rid).stop_ref), 'battery': {'soc': 42}})
            # A new state reaches the original subscription without another sub.
            deadline = time.monotonic() + 2
            while True:
                remaining = deadline - time.monotonic()
                assert remaining > 0, 'No new state on the retained subscription'
                body = receive(ws, timeout=remaining)
                assert body['t'] != 'subscription.revoked'
                if body['t'] == 'state' and (body.get('battery') or {}).get('soc') == 42:
                    assert body['latched'] is True
                    break
        denied = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[1, 0, 0]))
        assert not denied['ok']


def test_real_admin_assignments_retained_robot_settings_readonly(maps, seeded):
    http, headers, _ = maps
    value, _, _, _ = scenario(http, headers)
    result = assignment(http, headers, value, seeded['robots']['mine'])
    assert result.status_code == 201 and result.json()['status'] == 'ACTIVE'
    assert http.delete('/api/v1/assignments/' + result.json()['id'], headers=headers).status_code == 204
    rid = seeded['robots']['mine']
    result = http.patch(f'/api/v1/robots/{rid}', headers=headers,
        json={'name': '관리 유지'})
    assert result.status_code == 403, result.text


def test_restart_retains_legacy_pass_metadata_and_allows_new_admin_control(seeded):
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
            # 권한 관문을 지나 발급 단계까지 간다 (이 앱에는 발급 키가 없다).
            assert result.json()['error']['code'] == 'PASS_KEY_MISSING', result.text
    finally:
        app.state.engine.dispose()
        engine.dispose()

"""S1 behavior boundaries: real telemetry, tenant scope, CRUD and live revocation."""
import asyncio
import json
import time
from dataclasses import replace
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession
from starlette.websockets import WebSocketDisconnect

from apps.contracts import models as C
from apps.server.fh_server.models import Event, PhonePass, PhoneRevocation, Robot, RobotDevice
from apps.server.fh_server.security import digest
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take

P = '/api/v1'
DEVICE = dict(key='rgb', kind='CAMERA_RGB', label='시험 카메라', state='OK')


def test_robot_crud_roles_owner_validation_one_time_token_and_audit(client, seeded):
    operator, admin = app_token(client), app_token(client, 'admin')
    rid = str(seeded['robots']['mine'])
    for method, path, body in [('post', '/robots', {'name': 'denied'}),
            ('patch', '/robots/' + rid, {'name': 'denied'}), ('delete', '/robots/' + rid, None)]:
        result = client.request(method, P + path, headers=operator, **({'json': body} if body else {}))
        assert result.status_code == 403
    for owner in ['admin', 'foreign', 'locked']:
        assert client.post(P + '/robots', headers=admin, json={'name': 'bad',
            'owner_user_id': str(seeded['users'][owner])}).status_code == 400
    result = client.post(P + '/robots', headers=admin,
        json={'name': '새 로봇', 'owner_user_id': str(seeded['users']['one'])})
    assert result.status_code == 201, result.text
    assert result.headers['cache-control'] == 'no-store'
    created = C.RobotCreated.model_validate(result.json())
    path = P + '/robots/' + str(created.robot.id)
    raw = created.agent_token
    for response in [client.get(path, headers=admin), client.get(P + '/robots?scope=all', headers=admin),
                     client.patch(path, headers=admin, json={'name': '바꾼 이름', 'owner_user_id': None})]:
        assert response.status_code == 200
        assert raw not in response.text and 'agent_token' not in response.text
    assert client.get(path, headers=admin).json()['owner'] is None
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, created.robot.id).agent_token_hash == digest(raw)
        changes = list(db.scalars(select(Event).where(Event.robot_id == created.robot.id)))
        assert {e.code for e in changes} == {'ROBOT_CREATED', 'ROBOT_UPDATED'}
        assert raw not in repr([e.data for e in changes])
    assert client.patch(path, headers=admin, json={'name': None}).status_code == 400
    assert client.patch(path, headers=admin,
        json={'owner_user_id': str(seeded['users']['foreign'])}).status_code == 400
    assert client.delete(path, headers=admin).status_code == 204
    assert client.get(path, headers=admin).status_code == 404
    with DBSession(client.app.state.engine) as db:
        row = db.get(Robot, created.robot.id)
        assert row.archived_at and row.agent_token_hash != digest(raw)
        assert db.scalar(select(Event).where(Event.robot_id == row.id, Event.code == 'ROBOT_ARCHIVED'))
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect('wss://testserver/api/v1/agent/ws',
                headers={'authorization': 'Bearer ' + raw}):
            pass
    assert error.value.status_code == 403


@pytest.mark.parametrize('map_id', [None, str(uuid4())])
def test_rest_summaries_reflect_state_and_mask_other_owner(client, seeded, rt, map_id):
    admin, own, other = app_token(client, 'admin'), app_token(client), app_token(client, 'two')
    rid = seeded['robots']['mine']
    with agent(client, seeded, devices=[DEVICE]) as ag:
        pose = dict(floor_id=str(uuid4()), x=3.2, y=-1.1, yaw=1.57, confidence=.91)
        if map_id:
            pose['map_version_id'] = map_id
        payload = state()
        payload.update(pose=pose, battery={'soc': 12}, latched=False, mode='USER')
        ag.send_json(payload)
        deadline = time.monotonic() + 2
        while True:
            detail = client.get(P + '/robots/' + str(rid), headers=own).json()
            if detail['battery']:
                break
            assert time.monotonic() < deadline
            time.sleep(.01)
        assert detail['connection'] == 'ONLINE' and detail['status'] == 'TELEOP'
        assert detail['battery']['soc'] == 12
        assert detail['location'] is not None
        assert detail['location'] == {**pose, 'map_version_id': map_id, 'floor_context': None,
                                      'updated_at': detail['location']['updated_at']}
        assert detail['devices'] == [DEVICE] and detail['current_run'] is None
        assert 'BATTERY_LOW' in detail['attention']
        listing = client.get(P + '/robots', headers=own).json()['items'][0]
        assert listing == detail
        masked = client.get(P + '/robots/' + str(rid), headers=other).json()
        assert masked['connection'] == 'UNKNOWN'
        assert all(masked[k] is None for k in ('status', 'battery', 'location', 'lease', 'current_run'))
        assert masked['devices'] == masked['attention'] == []
        dash = client.get(P + '/dashboard', headers=admin).json()
        assert dash['robots_total'] == 2 and dash['robots_online'] == 1
        assert dash['robots_attention'] == 2 and dash['robots_running'] == dash['approvals_pending'] == 0
        assert {r['user_id']: r['robot_count'] for r in dash['operators']}[str(seeded['users']['one'])] == 1
        scoped = client.get(P + '/dashboard', headers=other).json()
        assert scoped['robots_total'] == 1 and scoped['robots_online'] == 0 and scoped['operators'] == []
        deadline = time.monotonic() + 3
        while True:
            with DBSession(client.app.state.engine) as db:
                row = db.get(RobotDevice, (rid, 'rgb'))
                if row is not None:
                    assert row.state == 'OK' and row.updated_at
                    break
            assert time.monotonic() < deadline
            time.sleep(.01)
    with agent(client, seeded, devices=[]) as ag:
        detail = client.get(P + '/robots/' + str(rid), headers=own).json()
        assert detail['devices'][0]['state'] == 'MISSING'


@pytest.mark.parametrize('owner', ['two', None])
def test_assignment_recalls_phone_access_and_keeps_other_subscription(client, seeded, rt, owner):
    admin, own = app_token(client, 'admin'), app_token(client)
    rid = seeded['robots']['mine']
    second = str(seeded['robots']['theirs'])
    jti = uuid4()
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).simulation = False
        db.get(Robot, seeded['robots']['theirs']).owner_user_id = seeded['users']['one']
        db.add(PhonePass(org_id=seeded['org'], user_id=seeded['users']['one'], robot_id=rid,
            device=uuid4(), purpose='control', jti=jti, iat=int(time.time()), exp=int(time.time())+600))
        db.commit()
    with agent(client, seeded, direct=True) as ag, screen(client, own) as ws:
        assert reply(ws, send(ws, 'sub', robots=[str(rid), second], streams=['state']))['ok']
        result = client.patch(P + '/robots/' + str(rid), headers=admin,
            json={'owner_user_id': str(seeded['users'][owner]) if owner else None})
        assert result.status_code == 200, result.text
        packet = receive(ag, 'phone.revoke')
        assert str(jti) in [j for item in packet['items'] for j in item['jtis']]
        assert receive(ws, 'lease', predicate=lambda m: m['holder'] is None)['lease_id'] is None
        assert receive(ws, 'subscription.revoked') == {
            't':'subscription.revoked', 'robot':str(rid), 'reason':'ACCESS_REVOKED'}
        assert rt.arbiter.robot(str(rid)).holder is None
        assert receive(ws, 'state', predicate=lambda m: m['robot'] == second)
        assert reply(ws, send(ws, 'ping'))['ok']
        assert all(str(rid) not in p.subscriptions and second in p.subscriptions for p in rt.screens.values())
        send(ws, 'sub', robots=[str(rid)], streams=['state'])
        with pytest.raises(WebSocketDisconnect) as denied:
            receive(ws, 'reply')
        assert denied.value.code == 4403
    with DBSession(client.app.state.engine) as db:
        assert db.scalar(select(PhoneRevocation).where(PhoneRevocation.jti == jti)) is not None


def test_delete_running_conflict_then_closes_agent_and_preserves_history(client, seeded, rt):
    admin = app_token(client, 'admin')
    rid = str(seeded['robots']['mine'])
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = False
        db.commit()
    with agent(client, seeded, direct=True) as ag, screen(client, admin) as ws:
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        rt.runs[rid] = {'status': 'PAUSED'}
        assert client.delete(P + '/robots/' + rid, headers=admin).status_code == 409
        rt.runs[rid] = {'status': 'COMPLETED'}
        assert client.delete(P + '/robots/' + rid, headers=admin).status_code == 204
        assert receive(ws, 'subscription.revoked')['reason'] == 'ROBOT_DELETED'
        assert reply(ws, send(ws, 'ping'))['ok']
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(ag, 'never-after-deletion')
        assert closed.value.code == 4403
        assert client.get(P + '/dashboard', headers=admin).json()['robots_total'] == 1


def test_assignment_recalls_disconnected_phone_without_server_lease(client, seeded, rt):
    admin = app_token(client, 'admin')
    rid, jti = seeded['robots']['mine'], uuid4()
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).simulation = False
        db.add(PhonePass(org_id=seeded['org'], user_id=seeded['users']['one'], robot_id=rid,
            device=uuid4(), purpose='control', jti=jti, iat=int(time.time()), exp=int(time.time())+600))
        db.commit()
    with agent(client, seeded, direct=True) as ag:
        result = client.patch(P + '/robots/' + str(rid), headers=admin, json={'owner_user_id': None})
        assert result.status_code == 200
        assert rt.arbiter.robot(str(rid)).holder is None
        packet = receive(ag, 'phone.revoke')
        assert str(jti) in [j for item in packet['items'] for j in item['jtis']]


def test_assignment_change_preserves_admin_subscription_but_denies_real_control(client, seeded, rt):
    admin = app_token(client, 'admin')
    rid = seeded['robots']['mine']
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).simulation = False
        db.commit()
    with agent(client, seeded, direct=True) as ag, screen(client, admin) as ws:
        assert reply(ws, send(ws, 'sub', robots=[str(rid)], streams=['state']))['ok']
        denied = reply(ws, send(ws, 'lease.take', rid))
        assert denied['error']['code'] == 'ADMIN_NO_REAL_CONTROL'
        assert client.patch(P + '/robots/' + str(rid), headers=admin,
            json={'owner_user_id': str(seeded['users']['two'])}).status_code == 200
        # Let both policy and delivery watchers pass the changed row boundary.
        assert receive(ws, 'state')['robot'] == str(rid)
        denied = reply(ws, send(ws, 'cmd', rid, lease_id=str(uuid4()), seq=0, axes=[0, 0, 0]))
        assert denied['error']['code'] == 'ADMIN_NO_REAL_CONTROL'
        assert rt.arbiter.robot(str(rid)).holder is None
        assert all(str(rid) in peer.subscriptions for peer in rt.screens.values())

"""Offline PostgreSQL and fake WS only; no real robot or production service."""
import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from starlette.websockets import WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from apps.contracts import models as C
from apps.server.fh_server.api import Settings
from apps.server.fh_server.models import Event, Pairing, Robot, now
from apps.server.fh_server.security import digest
from .test_realtime import app_token, hello, receive, reply, screen, send, take
from .test_server_drive import trial as approved_trial

P = '/api/v1'
CHECKS = sorted(C.FIELD_APPROVAL_CHECKS)


@pytest.fixture
def trial(approved_trial, seeded):
    with DBSession(approved_trial.app.state.engine) as db:
        for rid in seeded['robots'].values():
            db.get(Robot, rid).field_approval_expires_at = None
        db.commit()
    return approved_trial


def start(client, serial='1234-5678'):
    response = client.post(P + '/pairing/start', json={'model': 'unitree_go2', 'robot_serial': serial})
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    return response.json()


def paired(client, auth, name='새 기체', serial='1234-5678'):
    pending = start(client, serial)
    assert client.post(P + '/pairing/claim', headers=auth, json={'code': pending['code']}).status_code == 200
    result = client.post(P + f'/pairing/{pending["pairing_id"]}/confirm', headers=auth, json={'name': name})
    assert result.status_code == 200, result.text
    credential = client.post(P + f'/pairing/{pending["pairing_id"]}/poll',
        json={'poll_secret': pending['poll_secret']}).json()
    return result.json(), credential, pending


def test_pairing_one_use_claimant_only_and_no_secret_in_summary_or_db(client, seeded):
    own, other, admin = app_token(client), app_token(client, 'two'), app_token(client, 'admin')
    pending = start(client)
    path = P + '/pairing/' + pending['pairing_id']
    poll = {'poll_secret': pending['poll_secret']}
    assert client.post(path + '/poll', json=poll).json() == {'state': 'waiting'}
    assert client.post(path + '/poll', json={'poll_secret': 'wrong'}).status_code == 404
    assert client.post(P + '/pairing/claim', headers=admin, json={'code': pending['code']}).status_code == 403
    claimed = client.post(P + '/pairing/claim', headers=own, json={'code': pending['code']})
    assert claimed.json()['robot_serial'] == '1234-5678'
    assert client.post(P + '/pairing/claim', headers=other, json={'code': pending['code']}).status_code == 404
    assert client.post(path + '/confirm', headers=other, json={'name': 'wrong operator'}).status_code == 404
    result = client.post(path + '/confirm', headers=own, json={'name': 'Go2-5678'})
    assert result.status_code == 200, result.text
    robot = result.json()
    assert robot['simulation'] is False and robot['owner']['id'] == str(seeded['users']['one'])
    assert robot['field_approval_expires_at'] is None
    assert client.post(path + '/confirm', headers=own, json={'name': 'again'}).status_code == 404
    assert client.post(P + '/pairing/claim', headers=own, json={'code': pending['code']}).status_code == 404
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda _: client.post(path + '/poll', json=poll), range(2)))
    assert sorted(r.json()['state'] for r in responses) == ['consumed', 'paired']
    token_reply = next(r for r in responses if r.json()['state'] == 'paired')
    assert token_reply.headers['cache-control'] == 'no-store'
    raw = token_reply.json()['agent_token']
    assert token_reply.json()['agent_ws_url'] == 'wss://testserver/api/v1/agent/ws'
    assert raw not in result.text and pending['poll_secret'] not in result.text
    assert raw not in client.get(P + '/robots?scope=all', headers=admin).text
    with DBSession(client.app.state.engine) as db:
        row = db.get(Pairing, UUID(pending['pairing_id']))
        assert row.consumed and row.token_ciphertext is None
        assert row.poll_hash == digest(pending['poll_secret'])
        assert db.get(Robot, UUID(robot['id'])).agent_token_hash == digest(raw)
        assert raw not in repr(list(db.scalars(select(Event.data))))


def test_pairing_expiry_missing_reuse_and_rate_limits(client):
    own = app_token(client)
    pending = start(client)
    with DBSession(client.app.state.engine) as db:
        db.get(Pairing, UUID(pending['pairing_id'])).expires_at = now() - timedelta(seconds=1)
        db.commit()
    unknown = client.post(P + '/pairing/claim', headers=own, json={'code': '999999'})
    expired = client.post(P + '/pairing/claim', headers=own, json={'code': pending['code']})
    assert unknown.status_code == expired.status_code == 404 and unknown.json() == expired.json()
    assert client.post(P + f'/pairing/{pending["pairing_id"]}/poll',
        json={'poll_secret': pending['poll_secret']}).status_code == 404
    for _ in range(8):
        assert client.post(P + '/pairing/claim', headers=own, json={'code': '999999'}).status_code == 404
    assert client.post(P + '/pairing/claim', headers=own, json={'code': '999999'}).status_code == 429


def test_start_ip_rate_and_pending_cap(client, monkeypatch):
    from apps.server.fh_server import pairing
    monkeypatch.setattr(pairing, 'MAX_PENDING', 1)
    start(client)
    body = {'model': 'unitree_go2', 'robot_serial': '1234-5678'}
    assert client.post(P + '/pairing/start', json=body).json()['error']['code'] == 'PAIRING_CAPACITY'
    monkeypatch.setattr(pairing, 'MAX_PENDING', 100)
    for _ in range(8):
        assert client.post(P + '/pairing/start', json=body).status_code == 200
    assert client.post(P + '/pairing/start', json=body).json()['error']['code'] == 'PAIRING_RATE_LIMIT'


def test_real_owner_management_admin_denial_transfer_clears_approval(client, seeded):
    own, other, admin = app_token(client), app_token(client, 'two'), app_token(client, 'admin')
    robot, credential, _ = paired(client, own)
    path = P + '/robots/' + robot['id']
    for method, suffix, data in [('patch', '', {'name': 'no'}), ('delete', '', None),
            ('post', '/agent-token', None), ('delete', '/connection', None),
            ('post', '/field-approval', {'checks': CHECKS}), ('delete', '/field-approval', None)]:
        assert client.request(method, path + suffix, headers=admin,
            **({'json': data} if data else {})).status_code == 403
    assert client.post(P + '/robots', headers=admin, json={'name': 'no'}).status_code == 403
    assert client.post(path + '/agent-token', headers=own).status_code == 403
    assert client.patch(path, headers=other, json={'name': 'no'}).status_code == 403
    for owner in ['admin', 'foreign', 'locked']:
        assert client.patch(path, headers=own, json={'owner_user_id': str(seeded['users'][owner])}).status_code == 400
    assert client.patch(path, headers=own, json={'owner_user_id': None}).status_code == 400
    assert client.post(path + '/field-approval', headers=own, json={'checks': CHECKS[:-1]}).status_code == 410
    assert client.post(path + '/field-approval', headers=own, json={'checks': CHECKS + ['unknown']}).status_code == 410
    approved = client.post(path + '/field-approval', headers=own, json={'checks': CHECKS})
    assert approved.status_code == 410
    assert client.get(path, headers=admin).json()['field_approval_expires_at'] is None
    assert client.patch(path, headers=own, json={'owner_user_id': str(seeded['users']['two'])}).status_code == 200
    assert client.get(path, headers=admin).json()['field_approval_expires_at'] is None
    assert client.patch(path, headers=own, json={'name': 'old owner'}).status_code == 403
    assert client.delete(path + '/connection', headers=other).status_code == 204
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, UUID(robot['id'])).agent_token_hash != digest(credential['agent_token'])
    assert client.delete(path, headers=other).status_code == 204


def test_switch_precedence_and_wildcard_rejection(monkeypatch):
    monkeypatch.setenv('FH_DATABASE_URL', 'unused')
    monkeypatch.setenv('FH_ORG_ID', str(uuid4()))
    rid = uuid4()
    monkeypatch.setenv('FH_SERVER_DRIVE_ROBOTS', str(rid))
    monkeypatch.delenv('FH_SERVER_DRIVE_ENABLED', raising=False)
    assert Settings.from_env().drive_enabled(rid)
    assert not Settings.from_env().drive_enabled(uuid4())
    monkeypatch.setenv('FH_SERVER_DRIVE_ENABLED', '0')
    assert not Settings.from_env().drive_enabled(rid)
    monkeypatch.setenv('FH_SERVER_DRIVE_ENABLED', '1')
    assert Settings.from_env().drive_enabled(uuid4())
    monkeypatch.setenv('FH_SERVER_DRIVE_ROBOTS', '*')
    with pytest.raises(ValueError):
        Settings.from_env()


@pytest.mark.parametrize('enabled,approved,expected', [
    (False, True, 'PHONE_DIRECT_REQUIRED'),
    (False, False, 'PHONE_DIRECT_REQUIRED'),
    (True, False, 'FIELD_APPROVAL_REQUIRED'),
    (True, True, None)])
def test_both_motion_gates_required(seeded, enabled, approved, expected):
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from apps.server.fh_server.api import create_app
    rid = seeded['robots']['mine']
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        row = db.get(Robot, rid)
        row.agent_token_hash = digest('fake-gates')
        row.serial = '1234-5678' if approved else None
        row.field_approval_expires_at = now() + timedelta(minutes=30)  # Never authorizes motion.
        db.commit()
    engine.dispose()
    app = create_app(Settings(seeded['urls']['app'], seeded['org'], server_drive_enabled=enabled))
    with TestClient(app, base_url='https://testserver') as client:
        own = app_token(client)
        assert client.get(P + '/robots/' + str(rid), headers=own).json()['server_drive_allowed'] is False
        with client.websocket_connect(P + '/agent/ws', headers={'authorization': 'Bearer fake-gates'}) as ag:
            ag.send_json(hello())
            receive(ag, 'field_approval')
            if enabled and approved:
                receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
            with screen(client, own) as ws:
                result = reply(ws, send(ws, 'lease.take', rid))
                if expected:
                    assert (result.get('error') or {}).get('code') == expected
                else:
                    assert result['ok']


def test_automatic_marker_survives_over_thirty_minutes(trial, seeded, monkeypatch):
    rid = str(seeded['robots']['mine'])
    own = app_token(trial)
    rt = trial.app.state.realtime
    with trial.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello()); receive(ag, 'stop')
        first = receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        from datetime import datetime
        first_expiry = datetime.fromisoformat(first['expires_at'].replace('Z', '+00:00'))
        with screen(trial, own) as ws:
            lease = take(ws, ag, rid)
            future = now() + timedelta(minutes=61)
            # Change only marker wall time, leaving auth/session monotonic clocks live.
            monkeypatch.setattr(rt, 'field_clock', lambda: future)
            # Let the real 25 ms ticker schedule its next periodic renewal.
            trial.portal.call(lambda: setattr(rt.agents[rid], 'field_refresh_at', float('-inf')))
            renewed = receive(ag, 'field_approval', predicate=lambda m:
                m['expires_at'] is not None and datetime.fromisoformat(
                    m['expires_at'].replace('Z', '+00:00')) > first_expiry + timedelta(minutes=60))
            expiry = datetime.fromisoformat(renewed['expires_at'].replace('Z', '+00:00'))
            assert timedelta(0) < expiry - future <= timedelta(minutes=30)
            assert rt.arbiter.robot(rid).holder.lease_id == lease
            with DBSession(trial.app.state.engine) as db:
                assert db.get(Robot, UUID(rid)).field_approval_expires_at is None
                assert not list(db.scalars(select(Event).where(Event.robot_id == UUID(rid),
                    Event.code == 'FIELD_APPROVAL_EXPIRED')))


def test_final_send_gate_cannot_leak_queued_command(trial, seeded):
    rid = str(seeded['robots']['mine'])
    rt = trial.app.state.realtime
    with trial.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello()); receive(ag, 'stop')
        async def verify():
            peer = rt.agents[rid]
            rt.set_field_approval(rid, None)
            assert await rt.send_body(peer, {'t': 'cmd', 'lease_id': str(uuid4()), 'seq': 1,
                'axes': [0,0,0], 't_server': now().isoformat()}) is False
            rt.field_approvals[rid] = None
            assert not rt.field_approved(rid)
            assert await rt.send_body(peer, {'t': 'unlock', 'lease_id': str(uuid4()), 'stop_gen': 3}) is False
            assert await rt.send_body(peer, {'t': 'lease', 'lease_id': None, 'holder_type': None}) is True
            assert await rt.send_body(peer, {'t': 'stop', 'by_user_id': None, 'stop_ref': 1}) is True
        trial.portal.call(verify)


@pytest.mark.parametrize('operation', ['transfer', 'disconnect'])
def test_owner_actions_stop_active_control(trial, seeded, operation):
    own = app_token(trial)
    rid = str(seeded['robots']['mine'])
    path = P + '/robots/' + rid
    rt = trial.app.state.realtime
    with trial.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello()); receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        with screen(trial, own) as ws:
            take(ws, ag, rid)
            before = rt.arbiter.robot(rid).stop_ref
            if operation == 'transfer':
                assert trial.patch(path, headers=own, json={
                    'owner_user_id': str(seeded['users']['two'])}).status_code == 200
            else:
                assert trial.delete(path + '/connection', headers=own).status_code == 204
            receive(ag, 'lease', predicate=lambda m: m['lease_id'] is None)
            receive(ag, 'stop')
            record = rt.arbiter.robot(rid)
            assert record.holder is None and record.transfer is None and record.latched
            assert record.stop_ref > before
            if operation == 'disconnect':
                assert not rt.field_approved(rid)
            with DBSession(trial.app.state.engine) as db:
                assert db.get(Robot, UUID(rid)).field_approval_expires_at is None


def test_retired_endpoints_cannot_change_automatic_gate(trial, seeded):
    own = app_token(trial)
    rid = str(seeded['robots']['mine'])
    path = P + '/robots/' + rid + '/field-approval'
    with trial.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello()); receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        assert trial.post(path, headers=own, json={'checks': CHECKS}).status_code == 410
        assert trial.delete(path, headers=own).status_code == 410
        assert trial.app.state.realtime.field_approved(rid)


def test_owner_repair_preserves_id_stops_control_and_rejects_old_token(trial, seeded):
    own = app_token(trial)
    rid = str(seeded['robots']['mine'])
    old_token = 'fake-test-' + rid
    rt = trial.app.state.realtime
    with DBSession(trial.app.state.engine) as db:
        db.get(Robot, UUID(rid)).serial = '1234-5678'
        db.commit()
    with trial.websocket_connect(P + '/agent/ws', headers={'authorization': 'Bearer ' + old_token}) as ag:
        ag.send_json(hello()); receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        with screen(trial, own) as ws:
            take(ws, ag, rid)
            before = rt.arbiter.robot(rid).stop_ref
            robot, credential, _ = paired(trial, own, name='다시 연결한 기체')
            assert robot['id'] == credential['robot_id'] == rid
            assert robot['name'] == '다시 연결한 기체' and robot['field_approval_expires_at'] is None
            assert credential['agent_token'] != old_token
            receive(ag, 'lease', predicate=lambda m: m['lease_id'] is None)
            receive(ag, 'stop')
            record = rt.arbiter.robot(rid)
            assert record.holder is None and record.latched and record.stop_ref > before
            assert not rt.field_approved(rid)
    with pytest.raises(WebSocketDisconnect) as denied:
        with trial.websocket_connect(P + '/agent/ws', headers={'authorization': 'Bearer ' + old_token}):
            pass
    assert denied.value.status_code == 403
    with DBSession(trial.app.state.engine) as db:
        assert db.get(Robot, UUID(rid)).agent_token_hash == digest(credential['agent_token'])
        assert db.scalar(select(Event).where(Event.robot_id == UUID(rid), Event.code == 'ROBOT_REPAIRED'))
    # The new key belongs to the same robot, but reconnect grants no old lease.
    with trial.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer ' + credential['agent_token']}) as ag:
        ag.send_json(hello()); receive(ag, 'stop')
        assert rt.arbiter.robot(rid).holder is None


def test_another_operator_cannot_repair_existing_serial(client):
    own, other = app_token(client), app_token(client, 'two')
    robot, credential, _ = paired(client, own)
    pending = start(client)
    assert client.post(P + '/pairing/claim', headers=other, json={'code': pending['code']}).status_code == 200
    result = client.post(P + '/pairing/' + pending['pairing_id'] + '/confirm',
        headers=other, json={'name': '가로채기'})
    assert result.status_code == 409
    assert '넘겨받기 또는 삭제' in result.json()['error']['message']
    with DBSession(client.app.state.engine) as db:
        row = db.get(Robot, UUID(robot['id']))
        assert row.name == robot['name'] and row.agent_token_hash == digest(credential['agent_token'])


def test_owner_can_repair_after_connection_is_revoked(client):
    own = app_token(client)
    before, old, _ = paired(client, own)
    assert client.delete(P + '/robots/' + before['id'] + '/connection', headers=own).status_code == 204
    after, new, _ = paired(client, own, name='다시 설치')
    assert after['id'] == before['id'] == new['robot_id']
    assert after['field_approval_expires_at'] is None and new['agent_token'] != old['agent_token']
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, UUID(after['id'])).agent_token_hash == digest(new['agent_token'])

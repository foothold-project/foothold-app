"""Offline PostgreSQL and fake WS only; no real robot or production service."""
import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
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
    assert client.post(path + '/field-approval', headers=own, json={'checks': CHECKS[:-1]}).status_code == 400
    assert client.post(path + '/field-approval', headers=own, json={'checks': CHECKS + ['unknown']}).status_code == 400
    approved = client.post(path + '/field-approval', headers=own, json={'checks': CHECKS})
    assert approved.status_code == 200
    assert client.get(path, headers=admin).json()['field_approval_expires_at'] == approved.json()['expires_at']
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
        row.field_approval_expires_at = now() + timedelta(minutes=30) if approved else None
        db.commit()
    engine.dispose()
    app = create_app(Settings(seeded['urls']['app'], seeded['org'], server_drive_enabled=enabled))
    with TestClient(app, base_url='https://testserver') as client:
        own = app_token(client)
        assert client.get(P + '/robots/' + str(rid), headers=own).json()['server_drive_allowed'] == (enabled and approved)
        with client.websocket_connect(P + '/agent/ws', headers={'authorization': 'Bearer fake-gates'}) as ag:
            ag.send_json(hello())
            receive(ag, 'field_approval')
            if approved:
                receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
            with screen(client, own) as ws:
                result = reply(ws, send(ws, 'lease.take', rid))
                if expected:
                    assert result.get('error', {}).get('code') == expected
                else:
                    assert result['ok']


def test_field_approval_denies_motion_expires_stops_and_cannot_resume(trial, seeded):
    rid = str(seeded['robots']['mine'])
    own = app_token(trial)
    path = P + '/robots/' + rid + '/field-approval'
    rt = trial.app.state.realtime
    with trial.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello())
        receive(ag, 'field_approval')
        receive(ag, 'lease'); receive(ag, 'stop')
        with screen(trial, own) as ws:
            assert reply(ws, send(ws, 'lease.take', rid))['error']['code'] == 'FIELD_APPROVAL_REQUIRED'
            assert trial.post(path, headers=own, json={'checks': CHECKS}).status_code == 200
            assert receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
            lease = take(ws, ag, rid)
            before = rt.arbiter.robot(rid).stop_ref
            expiry = now() + timedelta(seconds=.2)
            with DBSession(trial.app.state.engine) as db:
                db.get(Robot, UUID(rid)).field_approval_expires_at = expiry
                db.commit()
            trial.portal.call(rt.set_field_approval, rid, expiry)
            receive(ag, 'lease', predicate=lambda m: m['lease_id'] is None)
            receive(ag, 'stop')
            receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is None)
            record = rt.arbiter.robot(rid)
            assert record.holder is None and record.latched and record.stop_ref > before
            assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=[0,0,0]))['error']['code'] == 'FIELD_APPROVAL_REQUIRED'
            assert trial.post(path, headers=own, json={'checks': CHECKS}).status_code == 200
            receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
            assert record.holder is None and record.latched
            assert not reply(ws, send(ws, 'unlock', rid, lease_id=lease, stop_gen=3))['ok']
            assert trial.delete(path, headers=own).status_code == 204
            receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is None)
            assert not rt.field_approved(rid)


def test_final_send_gate_cannot_leak_queued_command(trial, seeded):
    rid = str(seeded['robots']['mine'])
    rt = trial.app.state.realtime
    with trial.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello()); receive(ag, 'stop')
        async def verify():
            peer = rt.agents[rid]
            assert await rt.send_body(peer, {'t': 'cmd', 'lease_id': str(uuid4()), 'seq': 1,
                'axes': [0,0,0], 't_server': now().isoformat()}) is False
            rt.field_approvals[rid] = now() - timedelta(seconds=1)
            assert not rt.field_approved(rid)
            assert await rt.send_body(peer, {'t': 'unlock', 'lease_id': str(uuid4()), 'stop_gen': 3}) is False
            assert await rt.send_body(peer, {'t': 'lease', 'lease_id': None, 'holder_type': None}) is True
            assert await rt.send_body(peer, {'t': 'stop', 'by_user_id': None, 'stop_ref': 1}) is True
        trial.portal.call(verify)


@pytest.mark.parametrize('operation', ['revoke', 'transfer', 'disconnect'])
def test_owner_actions_stop_active_control(trial, seeded, operation):
    own = app_token(trial)
    rid = str(seeded['robots']['mine'])
    path = P + '/robots/' + rid
    rt = trial.app.state.realtime
    with trial.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello()); receive(ag, 'stop')
        assert trial.post(path + '/field-approval', headers=own, json={'checks': CHECKS}).status_code == 200
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        with screen(trial, own) as ws:
            take(ws, ag, rid)
            before = rt.arbiter.robot(rid).stop_ref
            if operation == 'revoke':
                assert trial.delete(path + '/field-approval', headers=own).status_code == 204
            elif operation == 'transfer':
                assert trial.patch(path, headers=own, json={
                    'owner_user_id': str(seeded['users']['two'])}).status_code == 200
            else:
                assert trial.delete(path + '/connection', headers=own).status_code == 204
            receive(ag, 'lease', predicate=lambda m: m['lease_id'] is None)
            receive(ag, 'stop')
            record = rt.arbiter.robot(rid)
            assert record.holder is None and record.transfer is None and record.latched
            assert record.stop_ref > before and not rt.field_approved(rid)
            with DBSession(trial.app.state.engine) as db:
                assert db.get(Robot, UUID(rid)).field_approval_expires_at is None


def test_offline_expiry_is_durable_and_recorded_once(client, seeded):
    from sqlalchemy.orm import sessionmaker
    from apps.server.fh_server.pairing import expire
    rid = seeded['robots']['mine']
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).field_approval_expires_at = now() - timedelta(seconds=1)
        db.commit()
    for _ in range(2):
        expire(sessionmaker(client.app.state.engine), seeded['org'])
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, rid).field_approval_expires_at is None
        assert len(list(db.scalars(select(Event).where(Event.robot_id == rid,
            Event.code == 'FIELD_APPROVAL_EXPIRED')))) == 1

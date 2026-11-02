"""Review r1: fresh field confirmation on WS reconnect; narrow orphan assignment."""
from contextlib import ExitStack
from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.api import APIError, authorize
from apps.server.fh_server.models import Event, Robot, User, now
from .test_pairing import CHECKS, P, trial
from .test_server_drive import trial as approved_trial
from .test_realtime import agent, app_token, hello, receive, reply, rt, screen, send, take


def test_agent_connect_clears_persisted_field_approval(approved_trial, seeded):
    client = approved_trial
    rid = str(seeded['robots']['mine'])
    owner, admin = app_token(client), app_token(client, 'admin')
    path = P + '/robots/' + rid
    assert client.get(path, headers=admin).json()['field_approval_expires_at'] is not None
    realtime = client.app.state.realtime
    stale_started = realtime.clock()
    with client.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello())
        assert receive(ag, 'field_approval')['expires_at'] is None
        receive(ag, 'lease'); receive(ag, 'stop')
        for auth in (owner, admin):
            summary = client.get(path, headers=auth).json()
            assert summary['field_approval_expires_at'] is None
            assert summary['server_drive_allowed'] is False
        client.portal.call(lambda: realtime.set_field_approval(
            rid, now() + timedelta(minutes=30), observed=stale_started))
        assert not realtime.field_approved(rid)
        with DBSession(client.app.state.engine) as db:
            assert db.get(Robot, UUID(rid)).field_approval_expires_at is None
            event = db.scalar(select(Event).where(Event.robot_id == UUID(rid),
                Event.code == 'FIELD_APPROVAL_REVOKED'))
            assert event is not None and event.data == {'reason': 'AGENT_RECONNECTED'}


@pytest.mark.parametrize('replace_active', [False, True])
def test_agent_reconnect_requires_fresh_field_confirmation(trial, seeded, replace_active):
    rid = str(seeded['robots']['mine'])
    owner = app_token(trial)
    path = P + '/robots/' + rid
    realtime = trial.app.state.realtime
    headers = {'authorization': 'Bearer fake-test-' + rid}
    with ExitStack() as old_connection, screen(trial, owner) as ws:
        old = old_connection.enter_context(trial.websocket_connect(P + '/agent/ws', headers=headers))
        old.send_json(hello()); receive(old, 'stop')
        assert trial.post(path + '/field-approval', headers=owner, json={'checks': CHECKS}).status_code == 200
        receive(old, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        lease = take(ws, old, rid)
        previous_stop = realtime.arbiter.robot(rid).stop_ref
        if not replace_active:
            old_connection.close()
        with trial.websocket_connect(P + '/agent/ws', headers=headers) as new:
            new.send_json(hello())
            assert receive(new, 'field_approval')['expires_at'] is None
            assert receive(new, 'lease')['lease_id'] is None
            receive(new, 'stop')
            record = realtime.arbiter.robot(rid)
            assert record.holder is None and record.transfer is None and record.latched
            assert record.stop_ref > previous_stop
            assert trial.get(path, headers=owner).json()['field_approval_expires_at'] is None
            denied = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=[0,0,0]))
            assert (denied.get('error') or {}).get('code') == 'FIELD_APPROVAL_REQUIRED'
            assert trial.post(path + '/field-approval', headers=owner, json={'checks': CHECKS}).status_code == 200
            receive(new, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
            assert record.holder is None and record.latched
            assert not reply(ws, send(ws, 'unlock', rid, lease_id=lease, stop_gen=3))['ok']


def test_sim_agent_connection_keeps_existing_path(client, seeded, rt, monkeypatch):
    async def forbidden(*args):
        raise AssertionError('simulation must not reset real field approval')
    monkeypatch.setattr(rt, 'reset_agent_field_approval', forbidden)
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        assert take(ws, ag, seeded['robots']['mine'])


def test_admin_can_only_assign_unowned_real_robot(client, seeded):
    admin, owner = app_token(client, 'admin'), app_token(client)
    rid = seeded['robots']['mine']
    path = P + '/robots/' + str(rid)
    with DBSession(client.app.state.engine) as db:
        row = db.get(Robot, rid)
        row.owner_user_id = None
        row.field_approval_expires_at = now() + timedelta(minutes=30)
        original_name, original_token = row.name, row.agent_token_hash
        db.commit()
    assigned = {'owner_user_id': str(seeded['users']['one'])}
    for body in ({}, {'name': 'no'}, {'owner_user_id': None}, {**assigned, 'name': 'no'}):
        assert client.patch(path, headers=admin, json=body).status_code == 403
    assert client.patch(path, headers=owner, json=assigned).status_code == 403
    for target in ('admin', 'foreign', 'locked'):
        assert client.patch(path, headers=admin, json={
            'owner_user_id': str(seeded['users'][target])}).status_code == 400
    for method, suffix, body in [('delete', '', None), ('delete', '/connection', None),
            ('post', '/agent-token', None), ('post', '/field-approval', {'checks': CHECKS}),
            ('delete', '/field-approval', None)]:
        assert client.request(method, path + suffix, headers=admin,
            **({'json': body} if body else {})).status_code == 403
    with screen(client, admin) as ws:
        for kind in ('lease.take', 'stop'):
            result = reply(ws, send(ws, kind, rid))
            assert (result.get('error') or {}).get('code') == 'ADMIN_NO_REAL_CONTROL'
    response = client.patch(path, headers=admin, json=assigned)
    assert response.status_code == 200, response.text
    assert response.json()['owner']['id'] == assigned['owner_user_id']
    assert response.json()['name'] == original_name
    assert response.json()['field_approval_expires_at'] is None
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, rid).agent_token_hash == original_token
        assert db.scalar(select(Event).where(Event.robot_id == rid,
            Event.code == 'ROBOT_UPDATED', Event.user_id == seeded['users']['admin'])) is not None
        with pytest.raises(APIError):
            authorize(db.get(User, seeded['users']['admin']), 'ROBOT_ASSIGN_UNOWNED', db.get(Robot, rid))
    assert client.patch(path, headers=admin, json={
        'owner_user_id': str(seeded['users']['two'])}).status_code == 403
    assert client.patch(path, headers=owner, json={'name': '담당 복구'}).status_code == 200

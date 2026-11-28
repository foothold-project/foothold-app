"""Review r1: automatic bounded markers on WS reconnect; narrow orphan assignment."""
from contextlib import ExitStack
from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.models import Event, Robot, now
from .test_pairing import CHECKS, P, trial
from .test_server_drive import trial as approved_trial
from .test_realtime import agent, app_token, hello, receive, reply, rt, screen, send, take


def test_agent_connect_clears_persisted_field_approval(approved_trial, seeded):
    client = approved_trial
    rid = str(seeded['robots']['mine'])
    owner, admin = app_token(client), app_token(client, 'admin')
    path = P + '/robots/' + rid
    assert client.get(path, headers=admin).json()['field_approval_expires_at'] is None
    realtime = client.app.state.realtime
    stale_started = realtime.clock()
    with client.websocket_connect(P + '/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease'); receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        for auth in (owner, admin):
            summary = client.get(path, headers=auth).json()
            assert summary['field_approval_expires_at'] is None
            assert summary['server_drive_allowed'] is True
        def stale_snapshot():
            realtime.set_field_approval(rid, now() + timedelta(minutes=30), observed=stale_started)
            return realtime.field_approvals[rid]
        assert client.portal.call(stale_snapshot) == seeded['users']['one']
        assert realtime.field_approved(rid)
        with DBSession(client.app.state.engine) as db:
            assert db.get(Robot, UUID(rid)).field_approval_expires_at is None
            event = db.scalar(select(Event).where(Event.robot_id == UUID(rid),
                Event.code == 'FIELD_APPROVAL_REVOKED'))
            assert event is not None and event.data == {'reason': 'AGENT_RECONNECTED'}


@pytest.mark.parametrize('replace_active', [False, True])
def test_agent_reconnect_automatically_gates_but_never_restores_lease(trial, seeded, replace_active):
    rid = str(seeded['robots']['mine'])
    owner = app_token(trial)
    path = P + '/robots/' + rid
    realtime = trial.app.state.realtime
    headers = {'authorization': 'Bearer fake-test-' + rid}
    with ExitStack() as old_connection, screen(trial, owner) as ws:
        old = old_connection.enter_context(trial.websocket_connect(P + '/agent/ws', headers=headers))
        old.send_json(hello()); receive(old, 'stop')
        receive(old, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        lease = take(ws, old, rid)
        previous_stop = realtime.arbiter.robot(rid).stop_ref
        if not replace_active:
            old_connection.close()
        with trial.websocket_connect(P + '/agent/ws', headers=headers) as new:
            new.send_json(hello())
            assert receive(new, 'lease')['lease_id'] is None
            receive(new, 'stop')
            receive(new, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
            record = realtime.arbiter.robot(rid)
            assert record.holder is None and record.transfer is None and record.latched
            assert record.stop_ref > previous_stop
            assert trial.get(path, headers=owner).json()['field_approval_expires_at'] is None
            denied = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=[0,0,0]))
            assert not denied['ok']
            assert record.holder is None and record.latched
            assert not reply(ws, send(ws, 'unlock', rid, lease_id=lease, stop_gen=3))['ok']


def test_sim_agent_connection_keeps_existing_path(client, seeded, rt, monkeypatch):
    async def forbidden(*args):
        raise AssertionError('simulation must not reset real field approval')
    monkeypatch.setattr(rt, 'reset_agent_field_approval', forbidden)
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        assert take(ws, ag, seeded['robots']['mine'])


def test_admin_manages_unowned_real_robot(client, seeded):
    # 운영 결정 2026-11-28: 담당 없는 실기도 총괄이 관리한다. 담당이 비는 값은 여전히 거절.
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
    renamed = client.patch(path, headers=admin, json={'name': '총괄 이름'})
    assert renamed.status_code == 200 and renamed.json()['owner'] is None
    assert client.patch(path, headers=admin, json={'owner_user_id': None}).status_code == 400
    assert client.patch(path, headers=owner, json=assigned).status_code == 403
    for target in ('admin', 'foreign', 'locked'):
        assert client.patch(path, headers=admin, json={
            'owner_user_id': str(seeded['users'][target])}).status_code == 400
    for method, suffix, body, code in [('post', '/agent-token', None, 403),
            ('post', '/field-approval', {'checks': CHECKS}, 410), ('delete', '/field-approval', None, 410)]:
        assert client.request(method, path + suffix, headers=admin,
            **({'json': body} if body else {})).status_code == code
    with screen(client, admin) as ws:
        for kind in ('lease.take', 'stop'):
            result = reply(ws, send(ws, kind, rid))
            # 운영 결정 2026-11-28: 총괄도 소유 관문은 지나고, 서버 조종 꺼진 실기는 현장 폰 관문에 걸린다.
            assert (result.get('error') or {}).get('code') == 'PHONE_DIRECT_REQUIRED'
    response = client.patch(path, headers=admin, json=assigned)
    assert response.status_code == 200, response.text
    assert response.json()['owner']['id'] == assigned['owner_user_id']
    assert response.json()['name'] == '총괄 이름' != original_name
    assert response.json()['field_approval_expires_at'] is None
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, rid).agent_token_hash == original_token
        assert db.scalar(select(Event).where(Event.robot_id == rid,
            Event.code == 'ROBOT_UPDATED', Event.user_id == seeded['users']['admin'])) is not None
    assert client.patch(path, headers=owner, json={'name': '담당 복구'}).status_code == 200
    assert client.patch(path, headers=admin, json={
        'owner_user_id': str(seeded['users']['two'])}).status_code == 200
    assert client.patch(path, headers=owner, json={'name': '옛 담당'}).status_code == 403
    assert client.delete(path + '/connection', headers=admin).status_code == 204
    assert client.delete(path, headers=admin).status_code == 204
    with DBSession(client.app.state.engine) as db:
        archived = db.scalar(select(Event).where(Event.robot_id == rid, Event.code == 'ROBOT_ARCHIVED'))
        assert archived.user_id == seeded['users']['admin']
        assert archived.data['owner_user_id'] == str(seeded['users']['two'])

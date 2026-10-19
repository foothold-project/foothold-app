import asyncio
from contextlib import contextmanager
import json
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session as DBSession
from starlette.websockets import WebSocketDisconnect

from apps.contracts import models as C
from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import Event, LeaseLog, Robot, Session, User
from apps.server.fh_server.security import digest
from .conftest import login
from .test_leases import Clock


def receive(ws, kind=None, *, predicate=lambda x: True, timeout=2):
    async def wait():
        async with asyncio.timeout(timeout):
            while True:
                packet = await ws._send_rx.receive()
                ws._raise_on_close(packet)
                body = json.loads(packet['text'])
                if body.get('t') == 'stop':
                    ws.stop_ref = body['stop_ref']
                if (kind is None or body.get('t') == kind) and predicate(body):
                    return body
    try:
        return ws.portal.call(wait)
    except TimeoutError:
        pytest.fail(f'Expected {kind or "WS frame"} within {timeout}s')


def receive_open(ws, kind, **kwargs):
    try:
        return receive(ws, kind, **kwargs)
    except WebSocketDisconnect as error:
        pytest.fail(f'Expected {kind} on a live connection, received close {error.code}')


def send(ws, kind, robot=None, **fields):
    ident = str(uuid4())
    ws.send_json({'t': kind, 'id': ident, **({'robot': str(robot)} if robot else {}), **fields})
    return ident


def reply(ws, ident):
    try:
        return receive(ws, 'reply', predicate=lambda x: x['id'] == ident)
    except WebSocketDisconnect as error:
        pytest.fail(f'Expected reply {ident}, received close {error.code}')


def app_token(client, username='one'):
    data = client.post('/api/v1/auth/login', json={'username': username,
        'password': 'fake-test-password', 'client': 'app'}).json()
    return {'authorization': 'Bearer ' + data['access_token']}


def hello(**kw):
    return dict(t='hello', proto='fh-agent/2', agent_version='fake-test', robot_model=None,
        firmware=None, devices=[], map_versions=[], last_floor_id=None, latched=True,
        stop_gen=1, lease_id=None, run=None, **kw)


def state(gen=2, **kw):
    return dict(t='state', pose={'floor_id': None, 'x': None, 'y': None, 'yaw': None, 'confidence': None},
                speed=None, battery={'soc': None}, latched=True, stop_gen=gen, stop_ref=kw.pop('stop_ref', gen - 1),
                applied=[0, 0, 0], mode='FREE', **kw)


@pytest.fixture
def rt(client, seeded):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        for rid in seeded['robots'].values():
            db.get(Robot, rid).agent_token_hash = digest('fake-test-' + str(rid))
        db.commit()
    yield client.app.state.realtime
    engine.dispose()


@contextmanager
def agent(client, seeded, **extra):
    rid = seeded['robots']['mine']
    with client.websocket_connect('wss://testserver/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ws:
        frame = hello()
        frame.update(extra)
        ws.send_json(frame)
        assert receive(ws, 'lease')['lease_id'] is None
        receive(ws, 'stop')
        yield ws


@contextmanager
def screen(client, headers, **initial):
    with client.websocket_connect('wss://testserver/api/v1/ws', headers=headers) as ws:
        assert ws.accepted_subprotocol is None
        ident = send(ws, 'ping', proto='fh-rt/1', **initial)
        assert reply(ws, ident)['ok']
        yield ws


def take(ws, ag, rid, gen=3):
    ident = send(ws, 'lease.take', rid)
    assert reply(ws, ident)['ok']
    assert receive(ag, 'lease')['lease_id'] is None
    stop = receive(ag, 'stop')
    ag.send_json(state(gen, stop_ref=stop['stop_ref']))
    lease = receive(ag, 'lease')['lease_id']
    assert lease is not None
    assert receive(ws, 'lease', predicate=lambda x: x.get('lease_id') == lease)['lease_id'] == lease
    return lease


def drain_audit(client, rt):
    async def drain():
        await asyncio.wait_for(rt.audit.join(), 4)
    client.portal.call(drain)


def test_cookie_origin_and_first_protocol(client, seeded, rt):
    login(client)
    for origin in (None, 'https://evil.example', 'https://testserver.evil.example'):
        headers = {'origin': origin} if origin else {}
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect('wss://testserver/api/v1/ws', headers=headers):
                pass
        assert error.value.code == 4403
    with screen(client, {'origin': 'https://testserver'}):
        pass
    with client.websocket_connect('wss://testserver/api/v1/ws', headers={'origin': 'https://testserver'}) as ws:
        send(ws, 'ping', proto='wrong/1')
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ws, 'reply')
        assert error.value.code == 4403
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect('wss://testserver/api/v1/ws', headers={'authorization': 'Bearer bad'}):
            pass
    assert error.value.code == 4401


@pytest.mark.parametrize('robot', ['theirs', 'foreign'])
def test_out_of_scope_sub_and_cmd_denied(client, seeded, rt, robot):
    headers = app_token(client)
    rid = seeded['robots'][robot]
    for kind in ('sub', 'cmd'):
        with screen(client, headers) as ws:
            if kind == 'sub':
                send(ws, kind, robots=[str(rid)], streams=['state'])
            else:
                ident = send(ws, kind, rid, lease_id=str(uuid4()), seq=0, axes=[1, 0, 0])
                assert not reply(ws, ident)['ok']
                assert reply(ws, send(ws, 'ping'))['ok']
                continue
            with pytest.raises(WebSocketDisconnect) as error:
                receive(ws, 'reply')
            assert error.value.code == 4403


def test_command_relay_sequence_rate_and_unlock_cas(client, seeded, rt):
    headers = app_token(client)
    rid = seeded['robots']['mine']
    clock = Clock()
    rt.clock = rt.arbiter.clock = clock
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        lease = take(ws, ag, rid)
        ident = send(ws, 'cmd', rid, lease_id=str(uuid4()), seq=0, axes=[1, 0, 0])
        assert reply(ws, ident)['error']['code'] == 'LEASE_MISMATCH'
        ident = send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[0, 0, 0])
        assert reply(ws, ident)['ok']
        command = receive(ag, 'cmd')
        assert command['axes'] == [0, 0, 0] and command['seq'] == 0
        assert command['t_server'].endswith('Z')
        ident = send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[1, 0, 0])
        assert reply(ws, ident)['error']['code'] == 'CMD_SEQ'
        ident = send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=[1, 0, 0])
        assert reply(ws, ident)['ok']
        receive(ag, 'cmd')
        clock.step(.05)
        ident = send(ws, 'cmd', rid, lease_id=lease, seq=2, axes=[1, 0, 0])
        assert reply(ws, ident)['ok']
        assert receive(ag, 'cmd')['axes'] == [1, 0, 0]
        ident = send(ws, 'unlock', rid, lease_id=lease, stop_gen=2)
        assert reply(ws, ident)['error']['code'] == 'STOP_GEN_MISMATCH'
        ident = send(ws, 'unlock', rid, lease_id=lease, stop_gen=3)
        assert reply(ws, ident)['ok']
        assert receive(ag, 'unlock')['stop_gen'] == 3
        ident = send(ws, 'hidden', rid)
        assert reply(ws, ident)['ok']
        assert receive(ag, 'lease')['lease_id'] is None
        assert receive(ag, 'stop')['t'] == 'stop'
    drain_audit(client, rt)
    with DBSession(client.app.state.engine) as db:
        assert db.scalar(select(LeaseLog).where(LeaseLog.op == 'TAKE'))
        assert db.scalar(select(LeaseLog).where(LeaseLog.op == 'RELEASE'))
        assert db.scalar(select(Event).where(Event.code == 'TAKE')).category == 'LEASE'


def test_stop_and_cmd_while_organization_session_robot_and_audit_writes_locked(client, seeded, rt):
    headers = app_token(client)
    rid = seeded['robots']['mine']
    engine = create_engine(seeded['urls']['migrate'])
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        lease = take(ws, ag, rid)
        drain_audit(client, rt)
        with engine.connect() as locked:
            tx = locked.begin()
            try:
                # These are the exact rows REST identity writes/locks. Plain MVCC
                # reads stay available. Audit INSERT is deliberately blocked too.
                locked.execute(text('SELECT id FROM organizations WHERE id=:id FOR UPDATE'), {'id': seeded['org']})
                locked.execute(text('SELECT id FROM sessions FOR UPDATE'))
                locked.execute(text('SELECT id FROM robots WHERE id=:id FOR UPDATE'), {'id': rid})
                locked.execute(text('LOCK TABLE events IN SHARE MODE'))
                begin = time.monotonic()
                ident = send(ws, 'stop', rid)
                assert receive(ag, 'stop', timeout=.75)['t'] == 'stop'
                assert time.monotonic() - begin < .75
                assert reply(ws, ident)['ok']
                # No lock of the organization/session/robot is taken by cmd.
                ident = send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[0, 0, 0])
                assert receive(ag, 'cmd', timeout=.75)['seq'] == 0
                assert reply(ws, ident)['ok']
                assert rt.audit._unfinished_tasks >= 1
            finally:
                tx.rollback()
    engine.dispose()
    drain_audit(client, rt)
    with DBSession(client.app.state.engine) as db:
        assert db.scalar(select(Event).where(Event.code == 'STOP'))


def test_stop_allowed_other_owner_but_foreign_denied_http_and_ws(client, seeded, rt):
    headers = app_token(client, 'two')
    rid = seeded['robots']['mine']
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        ident = send(ws, 'stop', rid)
        assert reply(ws, ident)['ok']
        assert receive(ag, 'stop')['by_user_id'] == str(seeded['users']['two'])
        response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
        assert response.status_code == 202
        receive(ag, 'stop')
        assert client.post(f"/api/v1/robots/{seeded['robots']['foreign']}/stop", headers=headers).status_code == 404


def test_sub_state_ten_hz_streams_and_lease_id_private(client, seeded, rt):
    owner, admin = app_token(client), app_token(client, 'admin')
    rid = seeded['robots']['mine']
    with agent(client, seeded) as ag, screen(client, owner) as ws, screen(client, admin) as watch:
        ident = send(watch, 'sub', robots=[str(rid)], streams=['state', 'rgb'])
        assert reply(watch, ident)['ok']
        assert not receive(ag, 'streams')['rgb']
        lease = take(ws, ag, rid)
        other = receive(watch, 'lease', predicate=lambda x: x['holder'] is not None)
        assert 'lease_id' not in other
        ag.send_json(state(3))
        samples = [receive(watch, 'state') for _ in range(3)]
        assert all(s['robot'] == str(rid) for s in samples)
        assert samples[-1]['latched'] is True
        assert lease not in json.dumps(samples)
        ident = send(watch, 'sub', robots=[], streams=[])
        assert reply(watch, ident)['ok']
        assert receive(ag, 'streams', predicate=lambda x: not x['rgb'])['rgb'] is False


def test_agent_three_second_timeout_ping_and_reconnect_paused(client, seeded, rt):
    clock = Clock()
    rt.clock = rt.arbiter.clock = clock
    run_id = str(uuid4())
    with agent(client, seeded) as ag:
        clock.at = 1
        assert receive(ag, 'ping')['t_server'].endswith('Z')
        clock.at = 2.999
        # One more server ping never refreshes last_rx.
        receive(ag, 'ping')
        clock.at = 3
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ag)
        assert error.value.code == 1013
    with agent(client, seeded, lease_id=str(uuid4()), run={'run_id': run_id, 'status': 'MOVING', 'step': 1}) as ag:
        assert rt.runs[str(seeded['robots']['mine'])]['status'] == 'PAUSED'
        assert receive(ag, 'run.control')['op'] == 'pause'
        ag.send_json(state(2, stop_ref=ag.stop_ref))
        grant = receive(ag, 'lease')
        assert grant['holder_type'] == 'RUN:' + run_id
        assert rt.arbiter.robot(str(seeded['robots']['mine'])).holder.holder_type == 'RUN'


def test_restart_free_ignores_hello_human_lease_copy(client, seeded, rt):
    headers = app_token(client)
    rid = seeded['robots']['mine']
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        old = take(ws, ag, rid)
    drain_audit(client, rt)
    client.portal.call(rt.close)  # stop old runtime, release singleton ownership
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    with TestClient(app, base_url='https://testserver') as restarted:
        assert app.state.realtime.arbiter.robot(str(rid)).holder is None
        with agent(restarted, seeded, lease_id=old) as ag:
            assert app.state.realtime.arbiter.robot(str(rid)).holder is None


def test_token_rotation_hash_only_old_agent_invalid_and_event_no_secret(client, seeded, rt):
    rid = seeded['robots']['mine']
    headers = app_token(client, 'admin')
    response = client.post(f'/api/v1/robots/{rid}/agent-token', headers=headers)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    raw = response.json()['agent_token']
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, rid).agent_token_hash == digest(raw)
        assert raw not in repr(db.scalars(select(Event)).all())
        assert raw not in json.dumps([e.data for e in db.scalars(select(Event))])
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect('wss://testserver/api/v1/agent/ws',
            headers={'authorization': 'Bearer fake-test-' + str(rid)}):
            pass
    assert error.value.code == 4403
    with client.websocket_connect('wss://testserver/api/v1/agent/ws', headers={'authorization': 'Bearer ' + raw}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease')
    operator = app_token(client)
    assert client.post(f'/api/v1/robots/{rid}/agent-token', headers=operator).status_code == 403


def test_logout_closes_socket_4401_and_revokes_lease(client, seeded, rt):
    headers = app_token(client)
    rid = seeded['robots']['mine']
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        take(ws, ag, rid)
        assert client.post('/api/v1/auth/logout', headers=headers).status_code == 204
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ws, 'reply')
        assert error.value.code == 4401
        assert receive(ag, 'lease')['lease_id'] is None
        receive(ag, 'stop')


@pytest.mark.parametrize('payload,code', [({'t': 'ping', 'id': 'a', 'proto': 'fh-rt/1', 'pad': 'x' * 4096}, 1009),
                                         ('invalid-json', 1007)])
def test_screen_frame_limits(client, seeded, rt, payload, code):
    headers = app_token(client)
    with client.websocket_connect('wss://testserver/api/v1/ws', headers=headers) as ws:
        if isinstance(payload, str):
            ws.send_text(payload)
        else:
            ws.send_json(payload)
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ws, 'reply')
        assert error.value.code == code


def test_request_timeout_cooldown_and_transfer_verified_on_wire(client, seeded, rt):
    headers, admin = app_token(client), app_token(client, 'admin')
    rid = seeded['robots']['mine']
    clock = Clock()
    rt.arbiter.clock = clock
    with agent(client, seeded) as ag, screen(client, headers) as ws, screen(client, admin) as requester:
        lease = take(ws, ag, rid)
        ident = send(requester, 'lease.request', rid)
        assert reply(requester, ident)['ok']
        req = receive(ws, 'lease.requested')
        assert req['expires_at'].endswith('Z')
        clock.at = 10
        result = receive(requester, 'lease.result')
        assert result['result'] == 'TIMEOUT'
        ident = send(requester, 'lease.request', rid)
        limited = reply(requester, ident)
        assert limited['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
        assert limited['error']['detail']['status'] == 429
        for at, seq in ((10, 0), (20, 1), (30, 2), (40, 3)):
            clock.at = at
            ident = send(ws, 'cmd', rid, lease_id=lease, seq=seq, axes=[0, 0, 0])
            assert reply(ws, ident)['ok']
            receive(ag, 'cmd')
        ident = send(requester, 'lease.request', rid)
        assert reply(requester, ident)['ok']
        req = receive(ws, 'lease.requested')
        ident = send(ws, 'lease.respond', rid, request_id=req['request_id'], accept=True)
        assert reply(ws, ident)['ok']
        assert receive(ag, 'lease')['lease_id'] is None
        receive(ag, 'stop')
        ag.send_json(state(3, stop_ref=ag.stop_ref - 1))  # earlier STOP cannot confirm this transfer
        assert rt.arbiter.robot(str(rid)).holder is None
        ag.send_json(state(4, stop_ref=ag.stop_ref))
        new = receive(ag, 'lease')['lease_id']
        assert new != lease
        assert receive(requester, 'lease.result', predicate=lambda x: x['request_id'] == req['request_id'])['result'] == 'ACCEPTED'
    drain_audit(client, rt)
    with DBSession(client.app.state.engine) as db:
        ops = list(db.scalars(select(LeaseLog.op)))
        assert {'REQUEST', 'TIMEOUT', 'ACCEPT', 'TAKE'} <= set(ops)


def test_permission_reassignment_and_token_rotation_revoke_live_connections(client, seeded, rt):
    headers = app_token(client)
    rid = seeded['robots']['mine']
    engine = create_engine(seeded['urls']['migrate'])
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        take(ws, ag, rid)
        with DBSession(engine) as db:
            db.get(Robot, rid).owner_user_id = seeded['users']['two']
            db.commit()
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ws, 'reply')
        assert error.value.code == 4403
        assert receive(ag, 'lease')['lease_id'] is None
        receive(ag, 'stop')
        with DBSession(engine) as db:
            db.get(Robot, rid).agent_token_hash = digest('fake-new-test-token')
            db.commit()
        ag.send_json(state(4))
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ag)
        assert error.value.code == 4403
    engine.dispose()


def test_agent_protocol_credentials_and_hello_deadline(client, seeded, rt):
    headers = app_token(client)
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect('wss://testserver/api/v1/agent/ws', headers=headers):
            pass
    assert error.value.code == 4403
    rid = seeded['robots']['mine']
    auth = {'authorization': 'Bearer fake-test-' + str(rid)}
    with client.websocket_connect('wss://testserver/api/v1/agent/ws', headers=auth) as ag:
        ag.send_json({**hello(), 'proto': 'wrong/1'})
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ag)
        assert error.value.code == 4406


def test_lease_audit_append_only_and_tenant_constraints(client, seeded, rt):
    rid = seeded['robots']['mine']
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
    drain_audit(client, rt)
    from sqlalchemy.exc import DBAPIError
    for statement in ('UPDATE lease_log SET op=\'TAKE\'', 'DELETE FROM lease_log', 'TRUNCATE lease_log'):
        with client.app.state.engine.connect() as conn:
            with pytest.raises(DBAPIError):
                conn.execute(text(statement))
            conn.rollback()
    with client.app.state.engine.begin() as conn:
        with pytest.raises(DBAPIError):
            conn.execute(text('INSERT INTO lease_log(org_id, robot_id, user_id, op) VALUES (:org,:robot,:user,\'TAKE\')'),
                {'org': seeded['org'], 'robot': rid, 'user': seeded['users']['foreign']})


def test_http_cookie_stop_csrf_and_no_identity_write_lock(client, seeded, rt):
    response = login(client)
    rid = seeded['robots']['mine']
    with agent(client, seeded) as ag:
        assert client.post(f'/api/v1/robots/{rid}/stop').status_code == 403
        assert client.post(f'/api/v1/robots/{rid}/stop', headers={'x-fh-csrf': response.json()['csrf_token']}).status_code == 202
        receive(ag, 'stop')


def test_second_server_authority_for_same_org_cannot_open_ws(client, seeded, rt):
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    with TestClient(app, base_url='https://testserver') as other:
        assert app.state.realtime.failed
        assert app_token(other)  # REST authentication replicas remain supported
        for path in ('/api/v1/ws', '/api/v1/agent/ws'):
            with other.websocket_connect('wss://testserver' + path) as busy:
                with pytest.raises(WebSocketDisconnect) as error:
                    receive(busy)
                assert error.value.code == 1013
        assert other.post(f"/api/v1/robots/{seeded['robots']['mine']}/stop").status_code == 503


def test_authority_lock_loss_fails_free(client, seeded, rt):
    headers = app_token(client)
    rid = seeded['robots']['mine']
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        take(ws, ag, rid)
        async def lose_lock():
            rt.owner_connection.execute(text('SELECT pg_advisory_unlock_all()'))
            rt.owner_connection.commit()
        client.portal.call(lose_lock)
        assert receive(ws, 'lease', predicate=lambda x: x['holder'] is None)['holder'] is None
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ws, 'reply')
        assert error.value.code == 1013
        assert rt.failed
        assert rt.arbiter.robot(str(rid)).holder is None


def test_replaced_agent_late_state_cannot_confirm_new_connection_stop(client, seeded, rt, monkeypatch):
    import threading
    entered, release = threading.Event(), threading.Event()
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as old:
        original = rt.load_agent_batch
        gate = [True]
        def blocked():
            if gate[0]:
                gate[0] = False
                entered.set()
                assert release.wait(2)
            return original()
        monkeypatch.setattr(rt, 'load_agent_batch', blocked)
        old.send_json(state(99))
        assert entered.wait(1)
        try:
            with agent(client, seeded, run={'run_id': str(uuid4()), 'status': 'PAUSED', 'step': 0}) as new:
                receive(new, 'run.control')
                release.set()
                async def flush_old():
                    await asyncio.sleep(.05)
                client.portal.call(flush_old)
                assert rt.arbiter.robot(rid).holder is None
                assert rt.arbiter.robot(rid).stop_gen == 1
                new.send_json(state(2, stop_ref=new.stop_ref))
                assert receive(new, 'lease')['holder_type'].startswith('RUN:')
        finally:
            release.set()

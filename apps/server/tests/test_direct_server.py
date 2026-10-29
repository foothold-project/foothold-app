"""ADR-002: real control stays on the phone; tower requests are observations."""
import time
import pytest
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.models import Event, Notification, Robot, User
from apps.server.fh_server.leases import Effect
from .test_realtime import app_token, hello, receive, reply, rt, screen, send, state

CONTROL = {'lease', 'cmd', 'unlock', 'stop', 'run.start', 'run.control', 'run.confirm', 'floor.set', 'slam'}


def real_ping(ag):
    while True:
        packet = receive(ag)
        assert packet.get('t') not in CONTROL, packet
        if packet.get('t') == 'ping':
            return


def real_robot(client, seeded):
    rid = seeded['robots']['mine']
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).simulation = False
        db.commit()
    return rid


def wait_detail(client, rid, headers, predicate):
    deadline = time.monotonic() + 2
    while True:
        result = client.get(f'/api/v1/robots/{rid}', headers=headers)
        assert result.status_code == 200, result.text
        value = result.json()
        if predicate(value):
            return value
        assert time.monotonic() < deadline, value
        time.sleep(.01)


def test_real_legacy_ws_rest_and_generated_effects_never_relay(client, seeded, rt):
    rid = real_robot(client, seeded)
    operator, admin = app_token(client), app_token(client, 'admin')
    with client.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        real_ping(ag)
        with screen(client, operator) as ws:
            for kind, fields in [('lease.take', {}), ('lease.request', {}),
                    ('lease.release', {}), ('stop', {}),
                    ('cmd', dict(lease_id=str(uuid4()), seq=1, axes=[1,0,0])),
                    ('unlock', dict(lease_id=str(uuid4()), stop_gen=1))]:
                denied = reply(ws, send(ws, kind, rid, **fields))
                assert not denied['ok'] and denied['error']['code'] == 'PHONE_DIRECT_REQUIRED'
        assert client.post(f'/api/v1/robots/{rid}/stop', headers=operator).json()['error']['code'] == 'PHONE_DIRECT_REQUIRED'
        assert client.post(f'/api/v1/robots/{rid}/stop', headers=admin).json()['error']['code'] == 'ADMIN_NO_REAL_CONTROL'
        async def assert_blocked():
            peer = rt.agents[str(rid)]
            # Covers bootstrap, disconnect and policy-generated effects too.
            rt.apply([Effect('agent', str(rid), {'t': kind}) for kind in CONTROL])
            queued = []
            while not peer.queue.empty():
                queued.append(peer.queue.get_nowait())
            assert not any(m.get('t') in CONTROL for m in queued)
            for kind in CONTROL:
                assert await rt.send_body(peer, {'t':kind}) is False
        client.portal.call(assert_blocked)
        assert rt.arbiter.robot(str(rid)).holder is None


def test_tower_request_is_durable_idempotent_phone_notification_until_agent_report(client, seeded, rt):
    rid = real_robot(client, seeded)
    admin, operator = app_token(client, 'admin'), app_token(client)
    request_id = str(uuid4())
    path = f'/api/v1/robots/{rid}/stop-requests'
    with DBSession(client.app.state.engine) as db:
        db.get(User, seeded['users']['one']).notify_prefs = {'STOP_REQUESTED': False}
        db.commit()
    assert client.post(path, headers=operator, json={'request_id': request_id}).status_code == 403
    for _ in range(2):
        result = client.post(path, headers=admin, json={'request_id': request_id})
        assert result.status_code == 202, result.text
        assert result.json()['status'] == 'REQUESTED'
        assert result.json()['message'] == '요청 전달됨 — 실제 정지 확인 아님'
    with DBSession(client.app.state.engine) as db:
        assert len(list(db.scalars(select(Event).where(Event.code == 'STOP_REQUESTED')))) == 1
        alerts = list(db.scalars(select(Notification).where(Notification.kind == 'STOP_REQUESTED')))
        assert len(alerts) == 1 and alerts[0].user_id == seeded['users']['one']
        assert request_id in alerts[0].link
    endpoint = path + '/' + request_id
    assert client.get(endpoint, headers=operator).json()['status'] == 'REQUESTED'
    assert client.post(endpoint + '/ack', headers=admin, json={'stage':'PHONE_RECEIVED'}).status_code == 404
    received = client.post(endpoint + '/ack', headers=operator, json={'stage':'PHONE_RECEIVED'}).json()
    assert received['status'] == 'PHONE_RECEIVED' and '실제 정지 확인 아님' in received['message']
    acknowledged = client.post(endpoint + '/ack', headers=operator, json={'stage':'HUMAN_CONFIRMED'}).json()
    assert acknowledged['status'] == 'HUMAN_CONFIRMED' and '실제 정지 확인 아님' in acknowledged['message']
    with client.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        real_ping(ag)
        report = dict(request_id=request_id, stop_gen=5, latched=True,
                      applied=[0,0,0], bridge_confirmed=True)
        # Generic agent events cannot forge either server request or confirmation.
        ag.send_json(dict(t='event', code='STOP_REQUEST_CONFIRMED', severity='info', robot_at=None, data=report))
        ag.send_json(dict(t='event', code='STOP_REQUEST_APPLIED', severity='info', robot_at=None,
                         data={**report, 'bridge_confirmed': False}))
        ag.send_json(dict(t='ping'))
        real_ping(ag)
        assert client.get(endpoint, headers=admin).json()['status'] == 'HUMAN_CONFIRMED'
        for _ in range(2):
            ag.send_json(dict(t='event', code='STOP_REQUEST_APPLIED', severity='info', robot_at=None, data=report))
        deadline = time.monotonic() + 2
        while client.get(endpoint, headers=admin).json()['status'] != 'STOP_CONFIRMED':
            assert time.monotonic() < deadline
            time.sleep(.01)
        assert client.get(endpoint, headers=admin).json()['message'] == '정지 확인'
    with DBSession(client.app.state.engine) as db:
        confirmed = list(db.scalars(select(Event).where(Event.code == 'STOP_REQUEST_CONFIRMED', Event.category == 'SAFETY')))
        assert len(confirmed) == 1
    assert client.post(f"/api/v1/robots/{seeded['robots']['theirs']}/stop-requests", headers=admin,
                       json={'request_id': request_id}).status_code == 409


def test_real_summary_uses_phone_reports_and_marks_stale_transport_online(client, seeded, rt):
    rid = real_robot(client, seeded)
    admin, other = app_token(client, 'admin'), app_token(client, 'two')
    device, run_id = str(uuid4()), str(uuid4())
    with client.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        real_ping(ag)
        payload = state()
        payload.update(latched=False, mode='RUN', controller=str(seeded['users']['one']),
            controller_device=device, controller_connected=True, controller_since='2026-01-01T00:00:00Z',
            reported_run=dict(run_id=run_id, status='MOVING', step=1, progress={'done':1,'total':3},
                              wait_reason=None, fail_code=None))
        ag.send_json(payload)
        detail = wait_detail(client, rid, admin, lambda v: v['current_run'] is not None)
        assert detail['controller']['id'] == str(seeded['users']['one'])
        assert detail['controller_device'] == device and detail['controller_connected'] is True
        assert detail['lease']['holder_type'] == 'RUN'
        assert detail['current_run']['id'] == run_id and detail['current_run']['progress'] == {'done':1,'total':3}
        assert detail['last_state_received_at'] is not None and detail['state_stale'] is False
        assert client.get('/api/v1/dashboard', headers=admin).json()['robots_running'] == 1
        masked = client.get(f'/api/v1/robots/{rid}', headers=other).json()
        assert masked['controller'] is masked['last_state_received_at'] is masked['state_stale'] is None
        payload['reported_run'].update(status='PAUSED', wait_reason='LINK_LOST')
        ag.send_json(payload)
        paused = wait_detail(client, rid, admin, lambda v: v['current_run']['status'] == 'PAUSED')
        assert client.get('/api/v1/dashboard', headers=admin).json()['robots_running'] == 0
        payload.update(controller_connected=False, mode='FREE', latched=True)
        ag.send_json(payload)
        reserved = wait_detail(client, rid, admin, lambda v: v['controller_connected'] is False)
        assert reserved['controller']['id'] == str(seeded['users']['one'])
        assert reserved['lease'] is None
        stamp = reserved['last_state_received_at']
        async def age():
            rt.agents[str(rid)].state_received_at = rt.clock() - 4
        client.portal.call(age)
        stale = client.get(f'/api/v1/robots/{rid}', headers=admin).json()
        assert stale['connection'] == 'ONLINE' and stale['state_stale'] is True
        assert stale['last_state_received_at'] == stamp and 'STATE_STALE' in stale['attention']
        assert stale['controller'] is None
        assert client.get('/api/v1/dashboard', headers=admin).json()['robots_running'] == 0
    offline = client.get(f'/api/v1/robots/{rid}', headers=admin).json()
    assert offline['last_state_received_at'] == stamp and offline['state_stale'] is True


@pytest.mark.parametrize('owner_state', ['missing', 'locked'])
def test_stop_request_with_no_eligible_phone_user_is_not_accepted(client, seeded, rt, owner_state):
    rid = real_robot(client, seeded)
    admin = app_token(client, 'admin')
    with DBSession(client.app.state.engine) as db:
        if owner_state == 'missing':
            db.get(Robot, rid).owner_user_id = None
        else:
            db.get(User, seeded['users']['one']).locked = True
        db.commit()
    result = client.post(f'/api/v1/robots/{rid}/stop-requests', headers=admin,
                        json={'request_id':str(uuid4())})
    assert result.status_code == 409, result.text
    assert result.json()['error']['code'] == 'STOP_REQUEST_NO_RECIPIENTS'
    assert result.json()['error']['message'] == '받을 폰 사용자가 없음 — 현장에 직접 연락'
    with DBSession(client.app.state.engine) as db:
        assert not list(db.scalars(select(Event).where(Event.code == 'STOP_REQUESTED')))
        assert not list(db.scalars(select(Notification).where(Notification.kind == 'STOP_REQUESTED')))

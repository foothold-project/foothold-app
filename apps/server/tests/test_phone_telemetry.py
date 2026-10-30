"""App login + issued pass possession -> display only, no agent/lease side effect."""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.models import Robot, Event
from apps.server.fh_server.phone_pass import revoke
from .test_phone_pass import pc, issue
from .test_realtime import app_token, screen, send, reply, receive, state


def upload(pc, seeded, *, purpose='control'):
    issued = issue(pc, seeded, purpose=purpose)
    assert issued.status_code == 200
    rid = str(seeded['robots']['mine'])
    frame = state()
    frame.update(battery={'soc': 75., 'voltage': 28.}, speed=.5,
                 devices_changed=[dict(key='go2-battery', kind='BATTERY', label='기체 배터리', state='OK')])
    return dict(t='phone.state', robot=rid, pass_token=issued.json()['token'], sequence=1,
                observed_at=datetime.now(timezone.utc).isoformat(), robot_serial='1234-5678',
                sensor_age_ms=20, state=frame)


def post(pc, body, *, robot=None, headers=None):
    return pc.post(f'/api/v1/robots/{robot or body["robot"]}/phone-state', json=body,
                   headers=headers or pc.upload_headers)


@pytest.mark.parametrize('purpose', ['control', 'view'])
def test_valid_phone_pass_relay_reaches_rest_and_web_without_agent_or_arbiter(pc, seeded, purpose):
    body = upload(pc, seeded, purpose=purpose)
    pc.upload_headers = app_token(pc)
    rid = body['robot']
    body['state']['devices_changed'].append(dict(key='lidar', kind='LIDAR', label='relay lidar', state='OK'))
    before_actions = pc.get('/api/v1/actions', params={'robot_id': rid}, headers=pc.upload_headers).json()
    before_dashboard = pc.get('/api/v1/dashboard', headers=pc.upload_headers).json()
    result = post(pc, body)
    assert result.status_code == 204 and result.headers['cache-control'] == 'no-store'
    rt = pc.app.state.realtime
    assert rid not in rt.agents and rid not in rt.arbiter.robots
    detail = pc.get(f'/api/v1/robots/{rid}', headers=pc.upload_headers).json()
    assert detail['battery'] is None and detail['devices'] == []
    assert detail['phone_relay']['battery']['soc'] == 75. and detail['phone_relay']['source'] == 'PHONE'
    assert detail['phone_relay']['devices'][-1]['kind'] == 'LIDAR'
    assert detail['connection'] == 'OFFLINE' and detail['location'] is None
    assert detail['lease'] is None
    assert detail['last_state_received_at'] is None
    assert pc.get('/api/v1/actions', params={'robot_id': rid}, headers=pc.upload_headers).json() == before_actions
    assert pc.get('/api/v1/dashboard', headers=pc.upload_headers).json()['robots_online'] == before_dashboard['robots_online']
    with screen(pc, pc.upload_headers) as ws:
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        frame = receive(ws, 'state')
        assert frame['connection'] == 'OFFLINE' and frame['speed'] is None and frame['devices'] == []
        assert frame['phone_relay']['source'] == 'PHONE' and frame['phone_relay']['speed'] == .5
        assert 0 <= frame['phone_relay']['age_s'] < 3
    assert rid not in rt.agents


def test_pass_signature_login_user_robot_scope_simulation_and_revocation(pc, seeded, caplog):
    body = upload(pc, seeded)
    pc.upload_headers = app_token(pc)
    token = body['pass_token']
    changed = deepcopy(body)
    changed['pass_token'] = token[:-1]+('A' if token[-1] != 'A' else 'B')
    response = post(pc, changed)
    assert response.status_code == 403 and token not in response.text
    wrong = deepcopy(body)
    wrong['robot'] = str(seeded['robots']['theirs'])
    assert post(pc, wrong).status_code == 403  # valid issued token for a different robot
    assert post(pc, body, robot=seeded['robots']['theirs']).status_code == 409
    admin = app_token(pc, 'admin')
    assert post(pc, body, headers=admin).status_code == 403
    assert post(pc, body, headers=pc.pass_headers).json()['error']['code'] == 'PHONE_STATE_APP'
    with DBSession(pc.app.state.engine) as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        robot.simulation = True
        db.commit()
    assert post(pc, body).status_code == 409
    with DBSession(pc.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = False
        revoke(db, seeded['org'], robot_id=seeded['robots']['mine'])
        db.commit()
    assert post(pc, body).status_code == 403
    assert token not in caplog.text


def test_expired_pass_and_missing_login_rejected(pc, seeded):
    body = upload(pc, seeded)
    pc.upload_headers = app_token(pc)
    pc.app.state.phone_pass_issuer.clock = lambda: datetime.now(timezone.utc).timestamp()+601
    assert post(pc, body).status_code == 403
    pc.cookies.clear()
    response = pc.post(f'/api/v1/robots/{body["robot"]}/phone-state', json=body)
    assert response.status_code == 401


def test_relay_controller_does_not_become_stop_recipient_after_assignment_changes(pc, seeded):
    body = upload(pc, seeded)
    pc.upload_headers = app_token(pc)
    body['state'].update(controller=str(seeded['users']['one']), controller_connected=True)
    assert post(pc, body).status_code == 204
    with DBSession(pc.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).owner_user_id = seeded['users']['two']
        db.commit()
    request_id = str(uuid4())
    response = pc.post(f'/api/v1/robots/{body["robot"]}/stop-requests',
        headers=app_token(pc, 'admin'), json={'request_id': request_id})
    assert response.status_code == 202 and response.json()['status'] == 'REQUESTED'
    with DBSession(pc.app.state.engine) as db:
        event = db.scalar(select(Event).where(Event.code == 'STOP_REQUESTED',
            Event.data['request_id'].astext == request_id))
        assert event.data['recipients'] == [str(seeded['users']['two'])]


def test_replay_rate_stale_identity_expiry_and_no_store_forward(pc, seeded):
    body = upload(pc, seeded)
    pc.upload_headers = app_token(pc)
    cache = pc.app.state.realtime.phone_telemetry
    at = [100.]
    cache.clock = lambda: at[0]
    assert post(pc, body).status_code == 204
    assert post(pc, body).json()['error']['code'] == 'PHONE_STATE_SEQUENCE'
    newer = {**body, 'sequence': 2}
    assert post(pc, newer).json()['error']['code'] == 'PHONE_STATE_RATE'
    at[0] += 1.
    assert post(pc, {**newer, 'robot_serial': '9999-9999'}).json()['error']['code'] == 'PHONE_STATE_IDENTITY'
    stale = {**newer, 'observed_at': (datetime.now(timezone.utc)-timedelta(seconds=5)).isoformat()}
    assert post(pc, stale).json()['error']['code'] == 'PHONE_STATE_STALE'
    assert post(pc, newer).status_code == 204
    at[0] += 3.01
    detail = pc.get(f'/api/v1/robots/{body["robot"]}', headers=pc.upload_headers).json()
    assert detail['connection'] == 'OFFLINE' and detail['battery'] is None
    assert detail['phone_relay'] is None
    assert post(pc, newer).json()['error']['code'] == 'PHONE_STATE_SEQUENCE'
    assert not pc.app.state.realtime.agents


@pytest.mark.parametrize('damage', ['command', 'sensor-age', 'mission', 'map', 'serial', 'devices'])
def test_upload_contract_rejects_expansion_and_does_not_echo_pass(pc, seeded, damage):
    body = upload(pc, seeded)
    pc.upload_headers = app_token(pc)
    if damage == 'command':
        body['cmd'] = [.6, 0, 0]
    elif damage == 'sensor-age':
        body['sensor_age_ms'] = 1001
    elif damage == 'mission':
        body['state']['mode'] = 'RUN'
    elif damage == 'map':
        body['state']['pose']['x'] = 2.
    elif damage == 'serial':
        body['robot_serial'] = '4294967296-0'
    else:
        body['state']['devices_changed'] = [dict(key=str(i), kind='OTHER', label='fixture', state='OK') for i in range(17)]
    response = post(pc, body)
    assert response.status_code == 400 and body['pass_token'] not in response.text

from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session as DBSession

from apps.contracts import models as C
from apps.server.fh_server.api import APIError, Settings, authorize, create_app
from apps.server.fh_server.models import Event, Organization, Session, User, now
from apps.server.fh_server.security import digest, hash_password, verify_password
from .conftest import login

P = '/api/v1'


def csrf(client, user='admin'):
    result = login(client, user)
    assert result.status_code == 200, result.text
    return {'X-FH-CSRF': result.json()['csrf_token']}


def test_login_cookie_and_logout_audit(client, seeded):
    result = login(client)
    assert result.status_code == 200, result.text
    C.LoginResponse.model_validate(result.json())
    cookie = result.headers['set-cookie']
    for attribute in ('HttpOnly', 'Secure', 'SameSite=strict', 'Path=/api/v1'):
        assert attribute in cookie
    assert result.json()['access_token'] is None
    assert client.get(P + '/me').json()['robot_ids'] == [str(seeded['robots']['mine'])]
    assert client.post(P + '/auth/logout').status_code == 403
    assert client.post(P + '/auth/logout', headers={'X-FH-CSRF': result.json()['csrf_token']}).status_code == 204
    assert client.get(P + '/me').status_code == 401
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        assert list(db.scalars(select(Event.code).order_by(Event.id))) == ['LOGIN', 'LOGOUT']
        session = db.scalar(select(Session))
        assert len(session.token_hash) == 32 and session.revoked_at
    engine.dispose()


@pytest.mark.parametrize('username,password', [('one', 'wrong'), ('missing', 'wrong'), ('locked', 'fake-test-password')])
def test_login_failure_and_locked(client, seeded, username, password):
    result = login(client, username, password=password)
    assert result.status_code == 401
    assert result.json()['error']['code'] == 'AUTH_REQUIRED'
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        row = db.scalar(select(Event))
        assert row.code == 'LOGIN_FAILED'
        assert 'password' not in str(row.data)
        assert not db.scalar(select(Session))
    engine.dispose()


def test_rate_limit_five_failures_persistent_across_app_instances(client, seeded):
    for _ in range(5):
        assert login(client, password='wrong').status_code == 401
    assert login(client).status_code == 429
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    with TestClient(app, base_url='https://testserver') as other:
        assert login(other).status_code == 429
        assert login(other, 'two').status_code == 429  # same IP, different account


def test_rate_limit_per_account_across_ips(client, seeded):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        for index in range(5):
            db.add(Event(org_id=seeded['org'], code='LOGIN_FAILED', category='ACCOUNT',
                         message='가짜 실패', data={'username': 'one', 'ip': f'fake-{index}'}))
        db.commit()
    engine.dispose()
    assert login(client).status_code == 429
    assert login(client, 'two').status_code == 200


def test_rate_limit_window_expiration(client, seeded):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        for _ in range(5):
            db.add(Event(org_id=seeded['org'], at=now() - timedelta(minutes=6), code='LOGIN_FAILED',
                         category='ACCOUNT', message='지난 시험', data={'username': 'one', 'ip': 'testclient'}))
        db.commit()
    engine.dispose()
    assert login(client).status_code == 200


def test_csrf_bound_to_session_and_updates(client):
    first = csrf(client)
    second = csrf(client)
    for headers in ({}, {'X-FH-CSRF': 'wrong'}, first):
        result = client.patch(P + '/me', json={'display_name': '새 이름'}, headers=headers)
        assert result.status_code == 403
    assert client.patch(P + '/me', json={'display_name': '새 이름'}, headers=second).status_code == 200
    assert client.get(P + '/me').json()['display_name'] == '새 이름'


def test_operator_summary_scope_and_cross_org_404(client, seeded):
    login(client)
    mine = client.get(P + '/robots?scope=mine').json()
    assert [r['id'] for r in mine['items']] == [str(seeded['robots']['mine'])]
    all_rows = client.get(P + '/robots?scope=all').json()
    assert {r['id'] for r in all_rows['items']} == {str(seeded['robots'][x]) for x in ('mine', 'theirs')}
    C.RobotList.model_validate(all_rows)
    theirs = client.get(P + '/robots/' + str(seeded['robots']['theirs']))
    assert theirs.status_code == 200  # Coordinator clarified: summary access is allowed.
    assert theirs.json() == next(r for r in all_rows['items'] if r['id'] == str(seeded['robots']['theirs']))
    assert theirs.json()['status'] is None and theirs.json()['battery'] is None
    for rid in (seeded['robots']['foreign'], uuid4()):
        result = client.get(P + '/robots/' + str(rid))
        assert result.status_code == 404
        assert result.json()['error']['code'] == 'NOT_FOUND'
    assert client.get(P + '/robots?scope=invalid').status_code == 400
    assert client.get(P + '/robots?cursor=bad').status_code == 400
    first = client.get(P + '/robots?scope=all&limit=1').json()
    second = client.get(P + '/robots', params={'scope': 'all', 'limit': 1, 'cursor': first['next_cursor']}).json()
    assert first['items'][0]['id'] != second['items'][0]['id']
    assert second['next_cursor'] is None


@pytest.mark.parametrize('permission,role,owns,allowed', [
    ('A', 'ORG_ADMIN', False, True), ('A', 'OPERATOR', True, False),
    ('O', 'OPERATOR', False, True), ('O_OWN', 'OPERATOR', True, True),
    ('O_OWN', 'OPERATOR', False, False), ('unknown', 'ORG_ADMIN', True, False)])
def test_central_permission_policy(permission, role, owns, allowed):
    from types import SimpleNamespace
    user = SimpleNamespace(id=uuid4(), org_id=uuid4(), role=role)
    robot = SimpleNamespace(owner_user_id=user.id if owns else uuid4(), org_id=user.org_id)
    if allowed:
        authorize(user, permission, robot)
    else:
        with pytest.raises(APIError) as error:
            authorize(user, permission, robot)
        assert error.value.status == 403


def test_settings_permissions_and_change_audit(client, seeded):
    headers = csrf(client, 'one')
    assert client.get(P + '/org/settings').json() == C.OrgSettings().model_dump()
    assert client.patch(P + '/org/settings', json={'link_loss_wait_s': 5}, headers=headers).status_code == 403
    headers = csrf(client)
    assert client.patch(P + '/org/settings', json={'link_loss_wait_s': 0}, headers=headers).status_code == 200
    assert client.get(P + '/org/settings').json()['link_loss_wait_s'] == 0
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        change = db.scalar(select(Event).where(Event.code == 'ORG_SETTINGS_UPDATED'))
        assert change.data == {'link_loss_wait_s': 0}
    engine.dispose()


@pytest.mark.parametrize('field,bad', [
    ('battery_low_pct', 4), ('battery_low_pct', 51), ('battery_low_pct', 5.5),
    ('run_min_battery_pct', 9), ('run_min_battery_pct', 91),
    ('deviation_m', 0.49), ('deviation_m', 5.01),
    ('lease_request_timeout_s', 4), ('lease_request_timeout_s', 31),
    ('link_loss_wait_s', -1), ('link_loss_wait_s', 31), ('link_loss_wait_s', True),
    ('link_loss_wait_s', None), ('unknown', 1)])
def test_setting_ranges(client, field, bad):
    headers = csrf(client)
    result = client.patch(P + '/org/settings', json={field: bad}, headers=headers)
    assert result.status_code == 400
    C.ApiError.model_validate(result.json())
    assert client.get(P + '/org/settings').json() == C.OrgSettings().model_dump()


@pytest.mark.parametrize('values', [
    {'battery_low_pct': 5, 'run_min_battery_pct': 10, 'deviation_m': .5, 'lease_request_timeout_s': 5, 'link_loss_wait_s': 0},
    {'battery_low_pct': 50, 'run_min_battery_pct': 90, 'deviation_m': 5, 'lease_request_timeout_s': 30, 'link_loss_wait_s': 30}])
def test_settings_boundary_values(client, values):
    assert client.patch(P + '/org/settings', json=values, headers=csrf(client)).json() == values


def test_app_refresh_rotation_and_expiry(client, seeded):
    response = login(client, client='app')
    data = response.json()
    assert 'set-cookie' not in response.headers
    assert data['csrf_token'] is None
    headers = {'Authorization': 'Bearer ' + data['access_token']}
    assert client.get(P + '/me', headers=headers).status_code == 200
    assert client.patch(P + '/me', headers=headers, json={'display_name': '앱'}).status_code == 200
    rotated = client.post(P + '/auth/refresh', json={'refresh_token': data['refresh_token']})
    assert rotated.status_code == 200
    assert client.get(P + '/me', headers=headers).status_code == 401
    assert client.post(P + '/auth/refresh', json={'refresh_token': data['refresh_token']}).status_code == 401
    headers = {'Authorization': 'Bearer ' + rotated.json()['access_token']}
    assert client.get(P + '/me', headers=headers).status_code == 200
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        row = db.scalar(select(Session))
        assert row.refresh_expires_at - row.created_at > timedelta(days=29)
        assert timedelta(minutes=14) < row.expires_at - row.last_seen_at <= timedelta(minutes=15)
        row.expires_at = now() - timedelta(seconds=1)
        db.commit()
    engine.dispose()
    assert client.get(P + '/me', headers=headers).status_code == 401
    assert client.post(P + '/auth/logout', headers=headers).status_code == 401


def test_admin_accounts_and_revocation(client, seeded):
    operator = csrf(client, 'one')
    assert client.get(P + '/users').status_code == 403
    assert client.post(P + '/users', json={'username': 'new', 'display_name': '새', 'role': 'OPERATOR',
        'temp_password': 'fake'}, headers=operator).status_code == 403
    headers = csrf(client)
    created = client.post(P + '/users', json={'username': 'new', 'display_name': '새', 'role': 'OPERATOR',
        'temp_password': 'fake'}, headers=headers)
    assert created.status_code == 201
    uid = created.json()['id']
    duplicate = client.post(P + '/users', json={'username': 'NEW', 'display_name': '중복', 'role': 'OPERATOR',
        'temp_password': 'fake'}, headers=headers)
    assert duplicate.status_code == 409
    assert client.patch(P + '/users/' + uid, json={'locked': True}, headers=headers).status_code == 200
    one = str(seeded['users']['one'])
    assert client.delete(P + '/users/' + one, headers=headers).status_code == 409
    assert client.delete(P + '/users/' + uid, headers=headers).status_code == 204
    assert client.patch(P + '/users/' + str(seeded['users']['foreign']), json={'locked': True}, headers=headers).status_code == 404
    admin = str(seeded['users']['admin'])
    sessions = client.get(P + '/users/' + admin + '/sessions').json()
    C.SessionList.model_validate(sessions)
    assert 'token_hash' not in str(sessions)
    sid = sessions['items'][0]['id']
    assert client.delete(P + f'/users/{one}/sessions/{sid}', headers=headers).status_code == 404
    assert client.delete(P + f'/users/{admin}/sessions/{sid}', headers=headers).status_code == 204
    assert client.get(P + '/me').status_code == 401


def test_password_change_invalidates_sessions(client):
    headers = csrf(client, 'one')
    assert client.post(P + '/me/password', headers=headers,
        json={'current_password': 'wrong', 'new_password': 'fake-new'}).status_code == 403
    assert client.post(P + '/me/password', headers=headers,
        json={'current_password': 'fake-test-password', 'new_password': 'fake-new'}).status_code == 204
    assert client.get(P + '/me').status_code == 401
    assert login(client, password='fake-new').status_code == 200


def test_role_lock_rechecked_from_database(client, seeded):
    headers = csrf(client)
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        user = db.get(User, seeded['users']['admin'])
        user.role = 'OPERATOR'
        db.commit()
    assert client.patch(P + '/org/settings', headers=headers, json={'link_loss_wait_s': 5}).status_code == 403
    with DBSession(engine) as db:
        user = db.get(User, seeded['users']['admin'])
        user.locked = True
        db.commit()
    engine.dispose()
    assert client.get(P + '/me').status_code == 401


def test_events_database_permissions(client, seeded):
    login(client)
    engine = create_engine(seeded['urls']['app'])
    for statement in ('UPDATE events SET message=message', 'DELETE FROM events', 'TRUNCATE events',
                      'ALTER TABLE events ADD COLUMN hacked text'):
        with engine.connect() as connection:
            with pytest.raises(DBAPIError) as failure:
                connection.execute(text(statement))
            assert failure.value.orig.sqlstate == '42501'
    engine.dispose()
    readonly = create_engine(seeded['urls']['readonly'])
    with readonly.connect() as conn:
        assert conn.scalar(text('SELECT count(*) FROM events')) == 1
        assert conn.scalar(text('SELECT last_value FROM events_id_seq')) == 1
        with pytest.raises(DBAPIError):
            conn.execute(text("UPDATE users SET locked=true"))
    readonly.dispose()


def test_server_rejects_migration_credentials(seeded):
    app = create_app(Settings(seeded['urls']['migrate'], seeded['org']))
    with pytest.raises(RuntimeError, match='restricted'):
        with TestClient(app):
            pass
    app.state.engine.dispose()


def test_error_input_does_not_leak_password(client):
    result = client.post(P + '/auth/login', json={'password': {'secret': 'do-not-echo'}})
    assert result.status_code == 400
    assert 'do-not-echo' not in result.text
    assert client.get(P + '/me').status_code == 401


def test_scrypt_parameters():
    value = hash_password('fake')
    assert value.startswith('scrypt$16384$8$1$')
    assert verify_password('fake', value)
    assert not verify_password('other', value)


def test_rate_limit_concurrent_failures(client, seeded):
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(lambda _: login(client, password='wrong').status_code, range(8)))
    assert codes.count(401) == 5
    assert codes.count(429) == 3


def test_central_policy_never_allows_cross_org_robot():
    from types import SimpleNamespace
    user = SimpleNamespace(id=uuid4(), org_id=uuid4(), role='ORG_ADMIN')
    robot = SimpleNamespace(owner_user_id=user.id, org_id=uuid4())
    with pytest.raises(APIError) as failure:
        authorize(user, 'O_OWN', robot)
    assert failure.value.status == 404

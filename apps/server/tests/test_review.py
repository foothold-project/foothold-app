"""Regression cases for the PR #6 security/contract review."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, func, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session as DBSession

from apps.contracts import models as C
from apps.server.fh_server import api
from apps.server.fh_server.api import APIError, Settings, authorize, create_app
from apps.server.fh_server.models import AuthRateWindow, Event, Robot, Session, User, now
from apps.server.fh_server.security import digest, hash_password
from .conftest import login
from .test_api import P, csrf


def write_db(seeded):
    return create_engine(seeded['urls']['migrate'])


def test_b1_cookie_only_reload_recovers_stable_csrf(client, seeded):
    first = login(client).json()['csrf_token']
    with TestClient(client.app, base_url='https://testserver', cookies=client.cookies) as reloaded:
        info = reloaded.get(P + '/auth/session')
        assert info.status_code == 200
        assert info.headers['cache-control'] == 'no-store'
        assert info.json() == {'client': 'web', 'csrf_token': first}
        assert reloaded.get(P + '/auth/session').json()['csrf_token'] == first
        headers = {'X-FH-CSRF': first}
        assert reloaded.patch(P + '/me', json={'display_name': '새 탭'}, headers=headers).status_code == 200
        # Reading in another tab does not invalidate the first tab's CSRF token.
        assert client.patch(P + '/me', json={'display_name': '첫 탭'}, headers=headers).status_code == 200
        assert reloaded.post(P + '/auth/logout', headers=headers).status_code == 204
    assert client.get(P + '/auth/session').status_code == 401
    engine = write_db(seeded)
    with DBSession(engine) as db:
        session = db.scalar(select(Session))
        assert session.csrf_hash == digest(first)
    engine.dispose()


def test_b1_session_info_has_no_web_csrf_for_app(client):
    assert client.get(P + '/auth/session').status_code == 401
    data = login(client, client='app').json()
    response = client.get(P + '/auth/session', headers={'Authorization': 'Bearer ' + data['access_token']})
    assert response.json() == {'client': 'app', 'csrf_token': None}
    assert 'access_token' not in response.json()


@pytest.mark.parametrize('action', ['demote', 'lock', 'delete'])
def test_b2_last_active_admin_cannot_be_removed(client, seeded, action):
    headers = csrf(client)
    # A locked administrator and another organization's administrator cannot help.
    engine = write_db(seeded)
    with DBSession(engine) as db:
        locked = db.get(User, seeded['users']['locked'])
        locked.role = 'ORG_ADMIN'
        db.commit()
    engine.dispose()
    target = P + '/users/' + str(seeded['users']['admin'])
    if action == 'delete':
        response = client.delete(target, headers=headers)
    else:
        response = client.patch(target, headers=headers,
            json={'role': 'OPERATOR'} if action == 'demote' else {'locked': True})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'LAST_ORG_ADMIN'
    assert client.get(P + '/me').json()['role'] == 'ORG_ADMIN'
    assert client.patch(P + '/org/settings', json={'link_loss_wait_s': 1}, headers=headers).status_code == 200


def extra_admin(client, headers):
    response = client.post(P + '/users', headers=headers, json={
        'username': 'second-admin', 'display_name': '두 번째 총괄',
        'role': 'ORG_ADMIN', 'temp_password': 'fake-test-password'})
    assert response.status_code == 201
    return UUID(response.json()['id'])


@pytest.mark.parametrize('action', ['demote', 'lock', 'delete'])
def test_b2_concurrent_admin_removal_preserves_one(client, seeded, action):
    first_headers = csrf(client)
    second_id = extra_admin(client, first_headers)
    with TestClient(client.app, base_url='https://testserver') as second:
        second_headers = csrf(second, 'second-admin')
        barrier = Barrier(2)
        def remove(args):
            http, identifier, headers = args
            barrier.wait(timeout=10)
            path = P + '/users/' + str(identifier)
            if action == 'delete':
                return http.delete(path, headers=headers).status_code
            return http.patch(path, headers=headers,
                json={'role': 'OPERATOR'} if action == 'demote' else {'locked': True}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            codes = list(pool.map(remove, [(client, seeded['users']['admin'], first_headers),
                                          (second, second_id, second_headers)]))
    assert sorted(codes) == ([204, 409] if action == 'delete' else [200, 409])
    engine = write_db(seeded)
    with DBSession(engine) as db:
        active = db.scalar(select(func.count()).select_from(User).where(User.org_id == seeded['org'],
            User.role == 'ORG_ADMIN', User.locked.is_(False), User.archived_at.is_(None)))
        assert active == 1
    engine.dispose()


@pytest.mark.parametrize('zone', ['Asia/Seoul', 'Pacific/Honolulu'])
def test_b3_http_times_are_utc_z_even_with_non_utc_database(seeded, zone):
    url = make_url(seeded['urls']['app']).update_query_dict({'options': '-c timezone=' + zone})
    app = create_app(Settings(url, seeded['org']))
    with TestClient(app, base_url='https://testserver') as http:
        with app.state.engine.connect() as conn:
            assert conn.scalar(text('SHOW TIME ZONE')) == zone
        result = login(http, 'admin')
        assert result.json()['created_at'].endswith('Z')
        assert http.get(P + '/me').json()['created_at'].endswith('Z')
        path = P + '/users/' + str(seeded['users']['admin']) + '/sessions'
        rows = http.get(path).json()['items']
        assert rows
        for row in rows:
            for key in ('created_at', 'last_seen_at', 'expires_at'):
                assert row[key].endswith('Z')
        # Force a non-null revoked_at to exercise that serializer as well.
        headers = {'X-FH-CSRF': result.json()['csrf_token']}
        other_login = login(http, 'admin').json()
        headers = {'X-FH-CSRF': other_login['csrf_token']}
        assert http.delete(path + '/' + rows[0]['id'], headers=headers).status_code == 204
        rows = http.get(path).json()['items']
        assert next(row for row in rows if row['revoked_at'])['revoked_at'].endswith('Z')


def test_r1_any_retired_refresh_replay_revokes_current_credentials(client, seeded):
    original = login(client, client='app').json()
    rotated = client.post(P + '/auth/refresh', json={'refresh_token': original['refresh_token']}).json()
    current = client.post(P + '/auth/refresh', json={'refresh_token': rotated['refresh_token']}).json()
    headers = {'Authorization': 'Bearer ' + current['access_token']}
    assert client.get(P + '/me', headers=headers).status_code == 200
    assert client.post(P + '/auth/refresh', json={'refresh_token': original['refresh_token']}).status_code == 401
    assert client.get(P + '/me', headers=headers).status_code == 401
    assert client.post(P + '/auth/refresh', json={'refresh_token': current['refresh_token']}).status_code == 401
    engine = write_db(seeded)
    with DBSession(engine) as db:
        row = db.scalar(select(Session))
        assert row.revoked_at and len(row.retired_refresh_hashes) == 2
        records = list(db.scalars(select(Event).where(Event.code == 'SESSION_REVOKED')))
        assert len(records) == 1 and records[0].data['reason'] == 'REFRESH_REUSED'
        assert db.scalar(select(func.count()).select_from(Event).where(Event.code == 'TOKEN_REFRESHED')) == 2
        for raw in (original['refresh_token'], rotated['refresh_token'], current['access_token']):
            assert raw not in str(row.retired_refresh_hashes) + str(records[0].data)
    engine.dispose()


def test_r1_simultaneous_refresh_replay_revokes_the_session(client):
    data = login(client, client='app').json()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: client.post(P + '/auth/refresh',
            json={'refresh_token': data['refresh_token']}), range(2)))
    assert sorted(r.status_code for r in results) == [200, 401]
    access = next(r.json()['access_token'] for r in results if r.status_code == 200)
    assert client.get(P + '/me', headers={'Authorization': 'Bearer ' + access}).status_code == 401


def test_r2_password_guess_limit_is_account_wide_and_audited(client, seeded):
    headers = csrf(client, 'one')
    body = {'current_password': 'fake-wrong-private', 'new_password': 'x'}
    for _ in range(5):
        assert client.post(P + '/me/password', json=body, headers=headers).status_code == 403
    # A different device with the same account shares the failure budget.
    data = login(client, client='app').json()
    assert client.post(P + '/me/password', json={**body, 'current_password': 'fake-test-password'},
        headers={'Authorization': 'Bearer ' + data['access_token']}).status_code == 429
    two = login(client, 'two', client='app').json()
    assert client.post(P + '/me/password', json={**body, 'current_password': 'fake-test-password'},
        headers={'Authorization': 'Bearer ' + two['access_token']}).status_code == 204
    engine = write_db(seeded)
    with DBSession(engine) as db:
        rows = list(db.scalars(select(Event).where(Event.user_id == seeded['users']['one'],
            Event.code.in_(['PASSWORD_CHANGE_FAILED', 'PASSWORD_CHANGE_RATE_LIMITED']))))
        assert [r.code for r in rows].count('PASSWORD_CHANGE_FAILED') == 5
        assert [r.code for r in rows].count('PASSWORD_CHANGE_RATE_LIMITED') == 0
        pending = db.scalar(select(AuthRateWindow).where(AuthRateWindow.user_id == seeded['users']['one']))
        assert pending.key_type == 'PASSWORD_ACCOUNT' and pending.denied_count == 1
        assert 'fake-wrong-private' not in str([r.data for r in rows])
        db.execute(update(Event).where(Event.code == 'PASSWORD_CHANGE_FAILED').values(at=now() - timedelta(minutes=6)))
        db.commit()
    engine.dispose()
    # The minimum length policy remains unchanged in this revision.
    assert client.post(P + '/me/password', json={'current_password': 'fake-test-password', 'new_password': 'x'},
        headers={'Authorization': 'Bearer ' + data['access_token']}).status_code == 204


def test_r2_concurrent_password_failures_are_serialized(client):
    headers = csrf(client, 'one')
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(lambda _: client.post(P + '/me/password', headers=headers,
            json={'current_password': 'wrong', 'new_password': 'x'}).status_code, range(8)))
    assert codes.count(403) == 5 and codes.count(429) == 3


@pytest.mark.parametrize('field', ['username', 'password', 'device_label'])
def test_r3_nul_login_input_is_400_api_error(client, field):
    body = {'username': 'one', 'password': 'fake-test-password', 'device_label': 'fake'}
    body[field] = 'private\x00input'
    response = client.post(P + '/auth/login', json=body)
    assert response.status_code == 400
    C.ApiError.model_validate(response.json())
    assert 'private' not in response.text


def test_r3_nested_nul_input_is_rejected_before_database(client):
    headers = csrf(client, 'one')
    response = client.patch(P + '/me', headers=headers, json={'notify_prefs': {'private\x00input': True}})
    assert response.status_code == 400 and response.json()['error']['code'] == 'VALIDATION'


@pytest.mark.parametrize('failure,status,code', [
    ('data', 400, 'VALIDATION'), ('database', 500, 'INTERNAL_ERROR'), ('runtime', 500, 'INTERNAL_ERROR')])
def test_r3_database_and_unexpected_errors_use_api_error(client, monkeypatch, failure, status, code):
    login(client)
    def broken(*args):
        if failure == 'runtime':
            raise RuntimeError('private-server-detail')
        with client.app.state.engine.connect() as conn:
            conn.execute(text("SELECT 'private-server-detail'::integer" if failure == 'data'
                              else 'SELECT * FROM private_missing_table'))
    monkeypatch.setattr(api, 'user_object', broken)
    with TestClient(client.app, base_url='https://testserver', cookies=client.cookies,
                    raise_server_exceptions=False) as http:
        response = http.get(P + '/me')
    assert response.status_code == status
    C.ApiError.model_validate(response.json())
    assert response.json()['error']['code'] == code
    assert 'private' not in response.text and 'SELECT' not in response.text


@pytest.mark.parametrize('action', ['lock', 'delete', 'password'])
def test_r7_bulk_revocation_preserves_prior_time_and_other_users(client, seeded, action):
    engine = write_db(seeded)
    old_time = now() - timedelta(days=1)
    with DBSession(engine) as db:
        # Remove the assignment so deleting this account is a valid operation.
        db.execute(update(Robot).where(Robot.owner_user_id == seeded['users']['one']).values(owner_user_id=None))
        rows = []
        for name, user_key, revoked in [('old', 'one', old_time), ('active', 'one', None),
                                         ('other', 'two', None), ('foreign', 'foreign', None)]:
            user = db.get(User, seeded['users'][user_key])
            row = Session(org_id=user.org_id, user_id=user.id, client='web', token_hash=digest('fake-' + name),
                          expires_at=now() + timedelta(days=1), revoked_at=revoked)
            db.add(row)
            rows.append((name, row))
        db.flush()
        ids = {name: row.id for name, row in rows}
        db.commit()
    if action == 'password':
        headers = csrf(client, 'one')
        response = client.post(P + '/me/password', headers=headers,
            json={'current_password': 'fake-test-password', 'new_password': 'x'})
        assert response.status_code == 204
    else:
        headers = csrf(client)
        path = P + '/users/' + str(seeded['users']['one'])
        response = client.delete(path, headers=headers) if action == 'delete' else client.patch(
            path, headers=headers, json={'locked': True})
        assert response.status_code == (204 if action == 'delete' else 200)
    with DBSession(engine) as db:
        assert db.get(Session, ids['old']).revoked_at == old_time
        assert db.get(Session, ids['active']).revoked_at is not None
        assert db.get(Session, ids['other']).revoked_at is None
        assert db.get(Session, ids['foreign']).revoked_at is None
    engine.dispose()


def test_r7_explicit_revoke_is_idempotent(client, seeded):
    headers = csrf(client)
    one = str(seeded['users']['one'])
    login(client, 'one')
    headers = csrf(client)
    path = P + '/users/' + one + '/sessions'
    sid = client.get(path).json()['items'][0]['id']
    assert client.delete(path + '/' + sid, headers=headers).status_code == 204
    first = client.get(path).json()['items'][0]['revoked_at']
    assert client.delete(path + '/' + sid, headers=headers).status_code == 204
    assert client.get(path).json()['items'][0]['revoked_at'] == first


def test_r8_summary_read_and_command_permissions_are_distinct(client, seeded, monkeypatch):
    from types import SimpleNamespace
    user = SimpleNamespace(id=seeded['users']['one'], org_id=seeded['org'], role='OPERATOR')
    robot = SimpleNamespace(owner_user_id=seeded['users']['two'], org_id=seeded['org'])
    authorize(user, 'ROBOT_SUMMARY', robot)
    for permission, status, code in [('ROBOT_READ', 404, 'NOT_FOUND'), ('O_OWN', 403, 'NOT_ROBOT_OWNER')]:
        with pytest.raises(APIError) as error:
            authorize(user, permission, robot)
        assert (error.value.status, error.value.code) == (status, code)
    called = []
    original = api.authorize
    def spy(actor, permission, robot=None):
        called.append(permission)
        return original(actor, permission, robot)
    monkeypatch.setattr(api, 'authorize', spy)
    login(client)
    assert client.get(P + '/robots/' + str(seeded['robots']['theirs'])).status_code == 200
    assert 'ROBOT_SUMMARY' in called


def test_r10_limited_attempts_are_audited_without_unknown_username(client, seeded):
    raw = 'fake-secret-entered-in-username'
    for _ in range(5):
        assert login(client, raw, password='wrong').status_code == 401
    for _ in range(2):
        assert login(client, raw, password='wrong').status_code == 429
    engine = write_db(seeded)
    with DBSession(engine) as db:
        records = list(db.scalars(select(Event).order_by(Event.id)))
        assert [r.code for r in records].count('LOGIN_FAILED') == 5
        assert [r.code for r in records].count('LOGIN_RATE_LIMITED') == 0
        assert db.scalar(select(AuthRateWindow)).denied_count == 2
        assert raw not in str([r.data for r in records])
        assert all('username' not in r.data for r in records)
        assert records[0].data['account_key'] == digest(raw).hex()
        db.execute(update(Event).where(Event.code == 'LOGIN_FAILED').values(at=now() - timedelta(minutes=6)))
        db.add(Event(org_id=seeded['org'], category='ACCOUNT', code='LOGIN_RATE_LIMITED',
                     severity='WARN', message='시험 요약', data={'count': 2}))
        db.commit()
    engine.dispose()
    # The recent LOGIN_RATE_LIMITED events do not prolong the failure window.
    assert login(client).status_code == 200


@pytest.mark.parametrize('kind', ['users', 'sessions', 'robots'])
def test_r11_cursor_order_is_created_at_then_uuid(client, seeded, kind):
    headers = csrf(client)
    engine = write_db(seeded)
    model = {'users': User, 'sessions': Session, 'robots': Robot}[kind]
    with DBSession(engine) as db:
        if kind == 'sessions':
            for index in range(2):
                db.add(Session(org_id=seeded['org'], user_id=seeded['users']['admin'], client='app',
                    token_hash=digest('fake-pagination-' + str(index)), expires_at=now() + timedelta(days=1)))
            db.flush()
        query = select(model).where(model.org_id == seeded['org'])
        if kind == 'sessions':
            query = query.where(Session.user_id == seeded['users']['admin'])
        rows = list(db.scalars(query.order_by(model.id.desc())))
        base = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for index, row in enumerate(rows):
            # Reverse UUID order, and include equal timestamps requiring the tie-breaker.
            row.created_at = base + timedelta(seconds=index // 2)
        db.commit()
        expected = [str(row.id) for row in sorted(rows, key=lambda r: (r.created_at, r.id))]
    engine.dispose()
    path = P + ('/users/' + str(seeded['users']['admin']) + '/sessions' if kind == 'sessions' else '/' + kind)
    params = {'limit': 1}
    if kind == 'robots':
        params['scope'] = 'all'
    seen = []
    for _ in range(len(expected) + 1):
        response = client.get(path, params=params)
        assert response.status_code == 200
        payload = response.json()
        seen.extend(row['id'] for row in payload['items'])
        if payload['next_cursor'] is None:
            break
        params['cursor'] = payload['next_cursor']
    assert seen == expected


def test_b2_admins_locking_each_other_do_not_deadlock(client, seeded):
    first_headers = csrf(client)
    second_id = extra_admin(client, first_headers)
    with TestClient(client.app, base_url='https://testserver') as second:
        second_headers = csrf(second, 'second-admin')
        barrier = Barrier(2)
        def lock_other(args):
            http, target, headers = args
            barrier.wait(timeout=10)
            return http.patch(P + '/users/' + str(target), headers=headers, json={'locked': True}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lock_other, [(client, second_id, first_headers),
                (second, seeded['users']['admin'], second_headers)]))
    assert sorted(results) == [200, 401]


def test_r2_password_change_from_two_devices_rechecks_revocation(client):
    first = login(client, client='app').json()['access_token']
    second = login(client, client='app').json()['access_token']
    barrier = Barrier(2)
    def change(access):
        barrier.wait(timeout=10)
        return client.post(P + '/me/password', headers={'Authorization': 'Bearer ' + access},
            json={'current_password': 'fake-test-password', 'new_password': 'fake-next'}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(change, [first, second]))
    assert sorted(results) == [204, 401]
    assert login(client, password='fake-next').status_code == 200

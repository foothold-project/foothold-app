"""Reproduce the PR #6 second-review deadlock and audit amplification."""
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from datetime import timedelta
from threading import Event as ThreadEvent

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, event, select, text, update
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server import api
from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import Event, Robot, User, now
from .conftest import login
from .test_api import P, csrf


@pytest.mark.parametrize('method', ['patch', 'delete'])
def test_r2_1_same_session_org_and_user_lock_inversion(seeded, method):
    engine = create_engine(seeded['urls']['migrate'])
    with engine.begin() as conn:
        conn.execute(update(Robot).where(Robot.owner_user_id == seeded['users']['one']).values(owner_user_id=None))
    engine.dispose()
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    route = ContextVar('request_route', default='')
    settings_has_session = ThreadEvent()
    account_has_org = ThreadEvent()

    @app.middleware('http')
    async def identify_route(request, call_next):
        mark = route.set(request.url.path)
        try:
            return await call_next(request)
        finally:
            route.reset(mark)

    def observe_locks(conn, cursor, statement, parameters, context, executemany):
        path = route.get()
        if path == P + '/org/settings' and statement.startswith('UPDATE sessions '):
            settings_has_session.set()
            # Before the fix, settings holds the session while the other
            # request acquires the organization. After the fix it already
            # holds both, so the other request safely waits for this timeout.
            account_has_org.wait(timeout=0.5)
        if path.startswith(P + '/users/') and statement.startswith('SELECT organizations.') and 'FOR ' in statement:
            account_has_org.set()

    with TestClient(app, base_url='https://testserver') as first:
        headers = csrf(first)
        with TestClient(app, base_url='https://testserver', cookies=first.cookies) as other:
            event.listen(app.state.engine, 'after_cursor_execute', observe_locks)
            try:
                with ThreadPoolExecutor(max_workers=2) as pool:
                    settings = pool.submit(first.patch, P + '/org/settings', headers=headers,
                                           json={'link_loss_wait_s': 3})
                    assert settings_has_session.wait(timeout=5)
                    path = P + '/users/' + str(seeded['users']['one'])
                    account = pool.submit(other.patch, path, headers=headers, json={'display_name': '시험 변경'}) if method == 'patch' else pool.submit(other.delete, path, headers=headers)
                    responses = [settings.result(timeout=15), account.result(timeout=15)]
                assert [r.status_code for r in responses] == [200, 200 if method == 'patch' else 204], [r.text for r in responses]
            finally:
                event.remove(app.state.engine, 'after_cursor_execute', observe_locks)


@pytest.mark.parametrize('method', ['patch', 'delete'])
def test_r2_1_forty_shared_cookie_mutations_have_no_500(client, seeded, method):
    headers = csrf(client)
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        password = db.get(User, seeded['users']['one']).password_hash
        targets = [User(org_id=seeded['org'], username=f'fake-target-{idx}', display_name='시험 대상',
                        role='OPERATOR', password_hash=password) for idx in range(20)]
        db.add_all(targets)
        db.commit()
        identifiers = [str(row.id) for row in targets]
    engine.dispose()
    with TestClient(client.app, base_url='https://testserver', cookies=client.cookies) as other:
        def mutate(index):
            if index % 2 == 0:
                return client.patch(P + '/org/settings', headers=headers, json={'link_loss_wait_s': index % 30}).status_code
            path = P + '/users/' + identifiers[index // 2]
            if method == 'delete':
                return other.delete(path, headers=headers).status_code
            return other.patch(path, headers=headers, json={'display_name': '시험 변경'}).status_code
        with ThreadPoolExecutor(max_workers=8) as pool:
            codes = list(pool.map(mutate, range(40)))
    assert 500 not in codes
    assert set(codes) == ({200, 204} if method == 'delete' else {200})


@pytest.mark.parametrize('axis,concurrent', [('ip', False), ('account', False), ('ip', True)])
def test_r2_2_forty_logins_keep_one_window_counter_and_one_summary(client, seeded, monkeypatch, axis, concurrent):
    stamp = now()
    monkeypatch.setattr(api, 'now', lambda: stamp)
    for _ in range(5):
        assert login(client, password='wrong').status_code == 401
    # A fresh IP shares the account budget; rotating usernames shares the IP budget.
    with TestClient(client.app, base_url='https://testserver', client=('other-fake-ip', 123)) as other:
        def denied(index):
            http = other if axis == 'account' else client
            name = 'one' if axis == 'account' else f'fake-unknown-{index}'
            return login(http, name, password='wrong').status_code
        if concurrent:
            with ThreadPoolExecutor(max_workers=8) as pool:
                codes = list(pool.map(denied, range(35)))
        else:
            codes = [denied(index) for index in range(35)]
    assert codes == [429] * 35
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        audit = list(db.scalars(select(Event).where(Event.code == 'LOGIN_RATE_LIMITED')))
        # This fails on eb061e8: 35 permanent rows for 35 blocked requests.
        assert len(audit) <= 1
        rows = db.execute(text('SELECT key_type, denied_count FROM auth_rate_windows')).all()
        assert rows == [('LOGIN_ACCOUNT' if axis == 'account' else 'LOGIN_IP', 35)]
    stamp += timedelta(minutes=6)
    assert login(client).status_code == 200  # Close and summarize the prior window.
    with DBSession(engine) as db:
        audit = list(db.scalars(select(Event).where(Event.code == 'LOGIN_RATE_LIMITED')))
        assert len(audit) == 1 and audit[0].data['count'] == 35
        assert audit[0].data['key_type'] == ('LOGIN_ACCOUNT' if axis == 'account' else 'LOGIN_IP')
        assert db.scalar(text('SELECT count(*) FROM auth_rate_windows')) == 0
    engine.dispose()


def test_r2_2_forty_password_checks_keep_one_counter_and_summary(client, seeded, monkeypatch):
    stamp = now()
    monkeypatch.setattr(api, 'now', lambda: stamp)
    headers = csrf(client, 'one')
    codes = [client.post(P + '/me/password', headers=headers,
             json={'current_password': 'wrong', 'new_password': 'x'}).status_code for _ in range(40)]
    assert codes == [403] * 5 + [429] * 35
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        audit = list(db.scalars(select(Event).where(Event.code == 'PASSWORD_CHANGE_RATE_LIMITED')))
        assert len(audit) <= 1
        assert db.execute(text('SELECT key_type, denied_count FROM auth_rate_windows')).all() == [('PASSWORD_ACCOUNT', 35)]
    stamp += timedelta(minutes=6)
    assert login(client).status_code == 200
    with DBSession(engine) as db:
        audit = list(db.scalars(select(Event).where(Event.code == 'PASSWORD_CHANGE_RATE_LIMITED')))
        assert len(audit) == 1 and audit[0].data['count'] == 35
    engine.dispose()


def test_r2_1_shared_cookie_password_and_settings_have_no_500(client):
    headers = csrf(client)
    with TestClient(client.app, base_url='https://testserver', cookies=client.cookies) as other:
        def mutate(index):
            if index % 2 == 0:
                return client.patch(P + '/org/settings', headers=headers, json={'link_loss_wait_s': 2}).status_code
            return other.post(P + '/me/password', headers=headers,
                json={'current_password': 'wrong', 'new_password': 'x'}).status_code
        with ThreadPoolExecutor(max_workers=8) as pool:
            codes = list(pool.map(mutate, range(40)))
    assert codes.count(200) == 20 and codes.count(403) == 5 and codes.count(429) == 15


def test_r2_2_summary_and_counter_delete_are_one_transaction(seeded):
    from apps.server.fh_server.rate_limits import close_rate_windows, record_rate_limit
    engine = create_engine(seeded['urls']['app'])
    start = now() - timedelta(minutes=6)
    with DBSession(engine) as db:
        for _ in range(7):
            record_rate_limit(db, seeded['org'], 'LOGIN_IP', 'fake-ip', start)
        db.commit()
    with DBSession(engine) as db:
        close_rate_windows(db, seeded['org'], now())
        db.flush()
        db.rollback()  # Simulate failure before the request commits its summary.
    with DBSession(engine) as db:
        assert db.scalar(text('SELECT denied_count FROM auth_rate_windows')) == 7
        assert db.scalar(select(Event).where(Event.code == 'LOGIN_RATE_LIMITED')) is None
    engine.dispose()
    # A new app instance drains durable counters; no process memory is needed.
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    with TestClient(app, base_url='https://testserver') as restarted:
        assert login(restarted).status_code == 200
        assert login(restarted).status_code == 200
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        rows = list(db.scalars(select(Event).where(Event.code == 'LOGIN_RATE_LIMITED')))
        assert len(rows) == 1 and rows[0].data['count'] == 7
        assert db.scalar(text('SELECT count(*) FROM auth_rate_windows')) == 0
    engine.dispose()


def test_r2_2_concurrent_drainers_and_organizations_are_isolated(seeded):
    from threading import Barrier
    from apps.server.fh_server.rate_limits import close_rate_windows, record_rate_limit
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        other_org = db.get(User, seeded['users']['foreign']).org_id
        for org in (seeded['org'], other_org):
            record_rate_limit(db, org, 'LOGIN_IP', 'fake-ip', now() - timedelta(minutes=6))
        db.commit()
    barrier = Barrier(2)
    def drain(_):
        with DBSession(engine) as db:
            barrier.wait(timeout=5)
            close_rate_windows(db, seeded['org'], now())
            db.commit()
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(drain, range(2)))
    with DBSession(engine) as db:
        rows = list(db.scalars(select(Event).where(Event.code == 'LOGIN_RATE_LIMITED')))
        assert len(rows) == 1 and rows[0].org_id == seeded['org'] and rows[0].data['count'] == 1
        assert db.execute(text('SELECT org_id, denied_count FROM auth_rate_windows')).all() == [(other_org, 1)]
    engine.dispose()


def test_r2_2_distinct_windows_each_emit_one_complete_summary(client, seeded, monkeypatch):
    stamp = now()
    monkeypatch.setattr(api, 'now', lambda: stamp)
    engine = create_engine(seeded['urls']['app'])
    def event_clock(mapper, connection, row):
        # Advance persisted failure timestamps with the API's virtual clock.
        row.at = stamp
    event.listen(Event, 'before_insert', event_clock)
    try:
        for _ in range(2):
            for _ in range(5):
                assert login(client, password='wrong').status_code == 401
            for _ in range(35):
                assert login(client, password='wrong').status_code == 429
            stamp += timedelta(minutes=6)
            assert login(client).status_code == 200
        with DBSession(engine) as db:
            rows = list(db.scalars(select(Event).where(Event.code == 'LOGIN_RATE_LIMITED')))
            assert len(rows) == 2 and [row.data['count'] for row in rows] == [35, 35]
            assert len({row.data['window_start'] for row in rows}) == 2
    finally:
        event.remove(Event, 'before_insert', event_clock)
        engine.dispose()


def test_r2_2_window_stays_five_utc_minutes_across_database_dst(seeded):
    from datetime import datetime, timezone
    from sqlalchemy.engine import make_url
    from apps.server.fh_server.rate_limits import close_rate_windows, record_rate_limit
    url = make_url(seeded['urls']['app']).update_query_dict({'options': '-c timezone=America/New_York'})
    engine = create_engine(url)
    with DBSession(engine) as db:
        record_rate_limit(db, seeded['org'], 'LOGIN_IP', 'fake-ip',
                          datetime(2025, 11, 2, 5, 57, tzinfo=timezone.utc))
        db.commit()
        close_rate_windows(db, seeded['org'], datetime(2025, 11, 2, 6, 1, tzinfo=timezone.utc))
        db.commit()
        summary = db.scalar(select(Event).where(Event.code == 'LOGIN_RATE_LIMITED'))
        assert summary.data['window_start'] == '2025-11-02T05:55:00Z'
        assert summary.data['window_end'] == '2025-11-02T06:00:00Z'
    engine.dispose()

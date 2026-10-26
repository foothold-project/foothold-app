"""S5b acceptance: assignment decisions, tenant boundaries and durable history."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event as Signal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, select, text, event as sql_event
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from apps.server.fh_server import api
from apps.server.fh_server.models import Approval, Assignment, Event, Notification, Robot, Scenario, ScenarioVersion
from .test_maps import P, auth, maps, tree, upload, save


def scenario(http, admin):
    _, _, floor = tree(http, admin)
    image = upload(http, admin)
    version = save(http, admin, floor, image).json()
    mission = http.post(P + '/missions', headers=admin, json={
        'name': '대기', 'steps': [{'action': 'WAIT', 'params': {'seconds': 1}}]}).json()
    body = {'name': '시험 순찰', 'waypoints': [{'floor_id': floor, 'map_version_id': version['id'],
        'x': .1, 'y': .1, 'yaw': 0, 'mission_id': mission['id'], 'mission_version': 1}], 'notes': ''}
    response = http.post(P + '/scenarios', headers=admin, json=body)
    assert response.status_code == 201, response.text
    return response.json(), floor, image, version


def assignment(http, headers, value, robot, **kwargs):
    return http.post(P + '/assignments', headers=headers, json={
        'scenario_id': value['id'], 'scenario_version': value['number'], 'robot_id': str(robot), 'memo': '배정 시험', **kwargs})


def listing(http, headers, **params):
    response = http.get(P + '/assignments', headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()['items']


def test_direct_pending_preview_decisions_notifications_and_history(maps, seeded):
    http, admin, _ = maps
    value, _, _, _ = scenario(http, admin)
    one, two = auth(http, 'one'), auth(http, 'two')
    second = http.post(P + '/users', headers=admin, json={'username': 'second', 'display_name': '둘째 총괄',
        'role': 'ORG_ADMIN', 'temp_password': 'fake-test-password'}).json()
    direct = assignment(http, admin, value, seeded['robots']['theirs'])
    assert direct.status_code == 201, direct.text
    direct = direct.json()
    assert direct['status'] == 'ACTIVE' and direct['approval_id'] is None and direct['removed_at'] is None
    pending = assignment(http, one, value, seeded['robots']['mine'])
    assert pending.status_code == 201, pending.text
    pending = pending.json()
    assert pending['status'] == 'PENDING' and pending['approval_id']
    assert len(listing(http, two)) == 2  # organization-wide read for operators
    assert listing(http, one, robot_id=str(seeded['robots']['mine']), status='PENDING') == [pending]
    first = http.get(P + '/assignments?limit=1', headers=one).json()
    assert len(first['items']) == 1 and first['next_cursor']
    assert http.get(P + '/assignments', params={'cursor': first['next_cursor']}, headers=one).json()['items'] == [pending]
    path = P + '/approvals/' + pending['approval_id']
    detail = http.get(path, headers=admin).json()
    assert detail['kind'] == 'SCENARIO_ASSIGNMENT' and detail['target'] == {'type': 'assignment', 'id': pending['id']}
    assert detail['reason'] == '배정 시험' and detail['base_ref'] is None
    assert detail['preview'] == {'scenario_id': value['id'], 'scenario_name': value['name'],
        'scenario_version': 1, 'robot_id': str(seeded['robots']['mine']), 'robot_name': 'mine'}
    assert http.get(P + '/dashboard', headers=admin).json()['approvals_pending'] == 1
    assert http.get(P + '/dashboard', headers=one).json()['approvals_pending'] == 1
    assert http.get(P + '/dashboard', headers=two).json()['approvals_pending'] == 0
    assert http.get(path, headers=two).status_code == 404
    assert http.post(path + '/approve', headers=one).status_code == 403
    assert http.post(path + '/cancel', headers=admin).status_code == 403
    approved = http.post(path + '/approve', headers=admin, json={'comment': '확인'})
    assert approved.status_code == 200 and approved.json()['status'] == 'APPROVED'
    assert listing(http, one, robot_id=str(seeded['robots']['mine']))[0]['status'] == 'ACTIVE'
    assert http.get(P + '/dashboard', headers=admin).json()['approvals_pending'] == 0
    assert http.post(path + '/approve', headers=admin).status_code == 409
    assert http.delete(P + '/assignments/' + pending['id'], headers=one).status_code == 204
    removed = listing(http, admin, status='REMOVED')[0]
    assert removed['removed_at'].endswith('Z')
    assert http.delete(P + '/assignments/' + pending['id'], headers=one).status_code == 204
    notices = http.get(P + '/notifications', headers=one).json()['items']
    assert len(notices) == 1 and notices[0]['kind'] == 'APPROVAL_DECIDED'
    assert '시나리오 배정' in notices[0]['body'] and '승인' in notices[0]['body']
    engine = create_engine(seeded['urls']['app'])
    with Session(engine) as db:
        events = list(db.scalars(select(Event).where(Event.approval_id == UUID(pending['approval_id'])).order_by(Event.id)))
        assert [e.code for e in events] == ['APPROVAL_REQUESTED', 'APPROVAL_DECIDED']
        assert set(db.scalars(select(Notification.user_id).where(Notification.event_id == events[0].id))) == {
            seeded['users']['admin'], UUID(second['id'])}
        assert set(db.scalars(select(Notification.user_id).where(Notification.event_id == events[1].id))) == {seeded['users']['one']}
        assert all(e.robot_id == seeded['robots']['mine'] and '시나리오 배정' in e.message for e in events)
    engine.dispose()
    events = http.get(P + '/events', headers=admin).json()['items']
    assert any(e['code'] == 'ASSIGNMENT_REMOVED' and 'mine' in e['message'] and value['name'] in e['message'] for e in events)
    assert any(e['code'] == 'ASSIGNMENT_CREATED' and 'theirs' in e['message'] for e in events)


def test_boundaries_duplicate_multiple_scenarios_archive_and_memo(maps, seeded):
    http, admin, _ = maps
    value, _, _, _ = scenario(http, admin)
    one = auth(http, 'one')
    assert http.get(P + '/assignments').status_code == 401
    assert assignment(http, one, value, seeded['robots']['theirs']).status_code == 403
    for robot in (seeded['robots']['foreign'], uuid4()):
        assert assignment(http, one, value, robot).status_code == 404
    for change in ({'scenario_id': str(uuid4())}, {'scenario_version': 999}):
        assert assignment(http, one, value, seeded['robots']['mine'], **change).status_code == 404
    for memo in ('a\nb', 'a\u202eb', 'x' * 2001):
        assert assignment(http, one, value, seeded['robots']['mine'], memo=memo).status_code == 422
    row = assignment(http, one, value, seeded['robots']['mine']).json()
    assert assignment(http, admin, value, seeded['robots']['mine']).status_code == 409
    assert assignment(http, one, value, seeded['robots']['mine']).status_code == 409
    assert http.delete(P + '/assignments/' + row['id'], headers=auth(http, 'two')).status_code == 403
    assert http.delete(P + '/assignments/' + str(uuid4()), headers=admin).status_code == 404
    another, _, _, _ = scenario(http, admin)
    assert assignment(http, admin, another, seeded['robots']['mine']).status_code == 201
    assert http.delete(P + '/scenarios/' + value['id'], headers=admin).status_code == 204
    assert assignment(http, admin, value, seeded['robots']['theirs']).status_code == 422
    assert http.delete(P + '/assignments/' + row['id'], headers=admin).status_code == 204
    assert listing(http, admin, status='REMOVED')[0]['id'] == row['id']
    approval = http.get(P + '/approvals/' + row['approval_id'], headers=admin).json()
    assert approval['status'] == 'CANCELED' and approval['decider']['id'] == str(seeded['users']['admin'])
    assert http.post(P + '/approvals/' + row['approval_id'] + '/approve', headers=admin).status_code == 409
    assert http.get(P + '/notifications', headers=one).json()['items'][0]['kind'] == 'APPROVAL_DECIDED'


@pytest.mark.parametrize('action,expected', [('reject', 'REJECTED'), ('cancel', 'REMOVED')])
def test_reject_cancel_reassign(maps, seeded, action, expected):
    http, admin, _ = maps
    one = auth(http, 'one')
    value, _, _, _ = scenario(http, admin)
    row = assignment(http, one, value, seeded['robots']['mine']).json()
    response = http.post(P + '/approvals/' + row['approval_id'] + '/' + action,
        headers=one if action == 'cancel' else admin, json={'reason': '내용 수정'} if action == 'reject' else {})
    assert response.status_code == 200, response.text
    assert response.json()['status'] == ('REJECTED' if action == 'reject' else 'CANCELED')
    result = listing(http, one)[0]
    assert result['status'] == expected and bool(result['removed_at']) == (expected == 'REMOVED')
    assert assignment(http, one, value, seeded['robots']['mine']).status_code == 201


@pytest.mark.parametrize('change', ['archive', 'remove', 'owner', 'map'])
def test_stale_four_causes_commits_terminal_decision(maps, seeded, change):
    http, admin, _ = maps
    one = auth(http, 'one')
    value, floor, image, old = scenario(http, admin)
    row = assignment(http, one, value, seeded['robots']['mine']).json()
    if change == 'archive':
        http.delete(P + '/scenarios/' + value['id'], headers=admin)
    elif change == 'owner':
        http.patch(P + '/robots/' + str(seeded['robots']['mine']), headers=admin,
            json={'owner_user_id': str(seeded['users']['two'])})
    elif change == 'map':
        assert save(http, admin, floor, image, base=old['id']).status_code == 201
    else:
        # Exercise defensive STALE when a removed target still has a pending
        # request (legacy/imported rows); normal DELETE cancels both atomically.
        engine = create_engine(seeded['urls']['migrate'])
        with engine.begin() as conn:
            conn.execute(text("UPDATE assignments SET status='REMOVED', removed_at=now() WHERE id=:id"), {'id': row['id']})
        engine.dispose()
    path = P + '/approvals/' + row['approval_id']
    response = http.post(path + '/approve', headers=admin)
    assert response.status_code == 409 and response.json()['error']['code'] == 'APPROVAL_STALE', response.text
    assert http.get(path, headers=one).json()['status'] == 'STALE'
    assert listing(http, one)[0]['status'] == ('REMOVED' if change == 'remove' else 'REJECTED')
    assert http.get(P + '/dashboard', headers=admin).json()['approvals_pending'] == 0
    assert http.post(path + '/approve', headers=admin).json()['error']['code'] == 'ALREADY_DECIDED'
    notice = http.get(P + '/notifications', headers=one).json()['items'][0]
    assert notice['kind'] == 'APPROVAL_DECIDED' and '대상이 바뀌어' in notice['body']


def test_remove_approve_race_holds_approval_then_assignment(maps, seeded, monkeypatch):
    http, admin, _ = maps
    one = auth(http, 'one')
    value, _, _, _ = scenario(http, admin)
    row = assignment(http, one, value, seeded['robots']['mine']).json()
    monkeypatch.setattr(api, 'lock_organization', lambda *args: None)
    reached, robot_seen = Signal(), Signal()
    def queried(conn, cursor, statement, *args):
        if statement.startswith('SELECT robots') and 'FOR SHARE' in statement:
            robot_seen.set()
        if statement.startswith('SELECT assignments') and 'FOR UPDATE' in statement and 'FOR SHARE' not in statement:
            reached.set()
    sql_event.listen(http.app.state.engine, 'before_cursor_execute', queried)
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with Session(engine) as blocker, ThreadPoolExecutor(max_workers=2) as pool:
            blocker.scalar(select(Assignment).where(Assignment.id == UUID(row['id'])).with_for_update())
            remove = pool.submit(http.delete, P + '/assignments/' + row['id'], headers=one)
            try:
                assert reached.wait(4), 'removal must acquire assignment lock after approval lock'
                assert not remove.done(), 'assignment lock must block removal'
                assert not robot_seen.is_set(), 'assignment lock must precede robot lock and target checks'
                approve = pool.submit(http.post, P + '/approvals/' + row['approval_id'] + '/approve', headers=admin)
                assert not Signal().wait(.25) and not approve.done(), 'approval must wait behind removal approval lock'
            finally:
                # Also release on a broken-lock assertion: mutation failures
                # must never deadlock ThreadPoolExecutor shutdown.
                blocker.commit()
            assert remove.result(5).status_code == 204
            assert approve.result(5).status_code == 409
        assert listing(http, admin)[0]['status'] == 'REMOVED'
        assert http.get(P + '/approvals/' + row['approval_id'], headers=admin).json()['status'] == 'CANCELED'
    finally:
        sql_event.remove(http.app.state.engine, 'before_cursor_execute', queried)
        engine.dispose()


def test_database_immutable_assignment_columns_delete_and_tenant_fks(maps, seeded):
    http, admin, _ = maps
    value, _, _, _ = scenario(http, admin)
    row = assignment(http, admin, value, seeded['robots']['mine']).json()
    engine = create_engine(seeded['urls']['app'])
    try:
        for column, expression in [('memo', "'changed'"), ('robot_id', 'robot_id'),
                ('scenario_version_id', 'scenario_version_id'), ('created_by', 'created_by'), ('org_id', 'org_id')]:
            with engine.begin() as conn, pytest.raises(DBAPIError):
                conn.execute(text(f'UPDATE assignments SET {column}={expression} WHERE id=:id'), {'id': row['id']})
        with engine.begin() as conn, pytest.raises(DBAPIError):
            conn.execute(text('DELETE FROM assignments WHERE id=:id'), {'id': row['id']})
        with engine.connect() as conn:
            for column in ('status', 'approval_id', 'removed_at'):
                assert conn.scalar(text("SELECT has_column_privilege(current_user,'assignments',:column,'UPDATE')"), {'column': column})
            for operation in ('UPDATE', 'DELETE', 'TRUNCATE'):
                assert not conn.scalar(text("SELECT has_table_privilege(current_user,'idempotency_receipts',:op)"), {'op': operation})
        with engine.begin() as conn, pytest.raises(DBAPIError):
            conn.execute(text('''INSERT INTO assignments(org_id, scenario_version_id, robot_id, status, memo, created_by)
                SELECT org_id, scenario_version_id, :robot, 'PENDING', '', created_by FROM assignments WHERE id=:id'''),
                {'robot': seeded['robots']['foreign'], 'id': row['id']})
    finally:
        engine.dispose()


@pytest.mark.parametrize('resource', ['assignments', 'scenarios', 'robots', 'floors'])
def test_approval_checks_hold_shared_locks(maps, seeded, monkeypatch, resource):
    from apps.server.fh_server.models import Floor
    http, admin, _ = maps
    one = auth(http, 'one')
    value, floor, _, _ = scenario(http, admin)
    row = assignment(http, one, value, seeded['robots']['mine']).json()
    monkeypatch.setattr(api, 'lock_organization', lambda *args: None)
    reached = Signal()
    def queried(conn, cursor, statement, *args):
        if statement.startswith('SELECT ' + resource) and ('FOR UPDATE' if resource == 'assignments' else 'FOR SHARE') in statement:
            reached.set()
    sql_event.listen(http.app.state.engine, 'before_cursor_execute', queried)
    model, identifier = {'assignments': (Assignment, row['id']), 'scenarios': (Scenario, value['id']),
        'robots': (Robot, str(seeded['robots']['mine'])), 'floors': (Floor, floor)}[resource]
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with Session(engine) as blocker, ThreadPoolExecutor(max_workers=1) as pool:
            blocker.scalar(select(model).where(model.id == UUID(identifier)).with_for_update())
            future = pool.submit(http.post, P + '/approvals/' + row['approval_id'] + '/approve', headers=admin)
            try:
                assert reached.wait(3), 'decision must hold shared lock on ' + resource
                assert not future.done(), 'decision must wait for protected resource'
            finally:
                blocker.commit()
            assert future.result(5).status_code == 200
    finally:
        sql_event.remove(http.app.state.engine, 'before_cursor_execute', queried)
        engine.dispose()


def test_foreign_assignments_and_scenarios_are_404_and_list_empty(maps, seeded, tmp_path):
    from fastapi.testclient import TestClient
    http, admin, _ = maps
    value, _, _, _ = scenario(http, admin)
    row = assignment(http, admin, value, seeded['robots']['mine']).json()
    engine = create_engine(seeded['urls']['migrate'])
    with Session(engine) as db:
        org_id = db.get(api.User, seeded['users']['foreign']).org_id
    engine.dispose()
    app = api.create_app(api.Settings(seeded['urls']['app'], org_id, files_root=str(tmp_path / 'foreign-files')))
    try:
        with TestClient(app) as foreign:
            headers = auth(foreign, 'foreign')
            assert listing(foreign, headers) == []
            assert foreign.delete(P + '/assignments/' + row['id'], headers=headers).status_code == 404
            assert assignment(foreign, headers, value, seeded['robots']['foreign']).status_code == 404
            other, _, _, _ = scenario(foreign, headers)
            assert assignment(http, admin, other, seeded['robots']['mine']).status_code == 404
            assert foreign.delete(P + '/scenarios/' + other['id'], headers=headers).status_code == 204
            assert assignment(http, admin, other, seeded['robots']['mine']).status_code == 404
    finally:
        app.state.engine.dispose()


def test_assignment_permission_grants_rejected_at_startup(seeded):
    from fastapi.testclient import TestClient
    engine = create_engine(seeded['urls']['migrate'])
    for grant, revoke in [
            ('UPDATE (memo) ON assignments', 'UPDATE (memo) ON assignments'),
            ('DELETE ON assignments', 'DELETE ON assignments'),
            ('UPDATE (key) ON idempotency_receipts', 'UPDATE (key) ON idempotency_receipts'),
            ('DELETE ON idempotency_receipts', 'DELETE ON idempotency_receipts')]:
        with engine.begin() as conn:
            conn.execute(text('GRANT ' + grant + ' TO fh_app'))
        app = api.create_app(api.Settings(seeded['urls']['app'], seeded['org']))
        try:
            with pytest.raises(RuntimeError, match='restricted fh_app'):
                with TestClient(app):
                    pass
        finally:
            app.state.engine.dispose()
            with engine.begin() as conn:
                conn.execute(text('REVOKE ' + revoke + ' FROM fh_app'))
    engine.dispose()


def test_catalog_reports_all_unavailable_choices(client, seeded):
    from types import SimpleNamespace
    headers = auth(client, 'one')
    rid = str(seeded['robots']['mine'])
    client.app.state.realtime.agents[rid] = SimpleNamespace(closing=False, state={'devices': []})
    try:
        photo = next(a for a in client.get(P + '/actions', headers=headers, params={'robot_id': rid}).json() if a['key'] == 'PHOTO')
        assert not photo['available']
        assert 'rgb:' in photo['why_unavailable'] and 'depth:' in photo['why_unavailable']
        assert '아직 광고하지' in photo['why_unavailable'] and '아직 지원하지' in photo['why_unavailable']
    finally:
        client.app.state.realtime.agents.pop(rid)


def test_concurrent_duplicate_without_key_uses_partial_unique(maps, seeded, monkeypatch):
    from threading import Barrier
    http, admin, _ = maps
    one, another_session = auth(http, 'one'), auth(http, 'one')
    value, _, _, _ = scenario(http, admin)
    monkeypatch.setattr(api, 'lock_organization', lambda *args: None)
    checked = Barrier(2)
    def queried(conn, cursor, statement, *args):
        if statement.startswith('SELECT assignments.id'):
            checked.wait(timeout=5)  # both observe absence before either INSERT
    sql_event.listen(http.app.state.engine, 'after_cursor_execute', queried)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda headers: assignment(http, headers, value, seeded['robots']['mine']), [one, another_session]))
        assert sorted(r.status_code for r in responses) == [201, 409], [r.text for r in responses]
    finally:
        sql_event.remove(http.app.state.engine, 'after_cursor_execute', queried)
    assert len(listing(http, one)) == 1
    assert http.get(P + '/dashboard', headers=admin).json()['approvals_pending'] == 1


def test_populated_assignment_approval_downgrade_refuses_without_losing_history(maps, seeded, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from .conftest import CONFIG
    http, admin, _ = maps
    value, _, _, _ = scenario(http, admin)
    row = assignment(http, auth(http, 'one'), value, seeded['robots']['mine']).json()
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
    with pytest.raises(DBAPIError, match='assignment approval history requires backup'):
        command.downgrade(Config(str(CONFIG)), '0014')
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.connect() as conn:
            assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0020'
            assert conn.scalar(text('SELECT status FROM assignments WHERE id=:id'), {'id': row['id']}) == 'PENDING'
            assert conn.scalar(text('SELECT status FROM approvals WHERE id=:id'), {'id': row['approval_id']}) == 'PENDING'
    finally:
        engine.dispose()


@pytest.mark.parametrize('creator', ['admin', 'one'], ids=['ACTIVE', 'PENDING'])
@pytest.mark.parametrize('remover', ['admin', 'one'], ids=['admin', 'owner'])
def test_remove_assignment_after_robot_archived(maps, seeded, creator, remover):
    http, admin, _ = maps
    one, other = auth(http, 'one'), auth(http, 'two')
    headers = {'admin': admin, 'one': one}
    value, _, _, _ = scenario(http, admin)
    robot = str(seeded['robots']['mine'])
    created = assignment(http, headers[creator], value, robot)
    assert created.status_code == 201, created.text
    row = created.json()
    assert row['status'] == ('ACTIVE' if creator == 'admin' else 'PENDING')
    assert http.delete(P + '/robots/' + robot, headers=admin).status_code == 204
    path = P + '/assignments/' + row['id']
    assert http.delete(path, headers=other).status_code == 403
    for _ in range(2):
        response = http.delete(path, headers=headers[remover])
        assert response.status_code == 204, response.text
        removed = listing(http, admin, robot_id=robot)[0]
        assert removed['status'] == 'REMOVED' and removed['removed_at']
        if row['approval_id']:
            approval = http.get(P + '/approvals/' + row['approval_id'], headers=admin).json()
            assert approval['status'] == 'CANCELED'
    # The archived robot is still unavailable for new assignments.
    assert assignment(http, admin, value, robot).status_code == 404


def test_direct_active_assignment_downgrade_refuses_without_losing_history(maps, seeded, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from .conftest import CONFIG
    http, admin, _ = maps
    value, _, _, _ = scenario(http, admin)
    response = assignment(http, admin, value, seeded['robots']['mine'])
    assert response.status_code == 201, response.text
    row = response.json()
    assert row['status'] == 'ACTIVE' and row['approval_id'] is None
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.connect() as conn:
            assert conn.scalar(text("SELECT count(*) FROM approvals WHERE kind='SCENARIO_ASSIGNMENT'")) == 0
        monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
        with pytest.raises(DBAPIError, match='assignment approval history requires backup'):
            command.downgrade(Config(str(CONFIG)), '0014')
        with engine.connect() as conn:
            assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0020'
            assert conn.execute(text('SELECT status, approval_id, removed_at FROM assignments WHERE id=:id'),
                {'id': row['id']}).one() == ('ACTIVE', None, None)
            assert conn.scalar(text("SELECT count(*) FROM approvals WHERE kind='SCENARIO_ASSIGNMENT'")) == 0
            assert conn.scalar(text("SELECT count(*) FROM events WHERE code='ASSIGNMENT_CREATED'")) == 1
    finally:
        engine.dispose()

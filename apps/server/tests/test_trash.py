"""Trash contract on a private PG and synthetic local files only."""
from pathlib import Path
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, event as sql_event, select, text
from sqlalchemy.orm import Session

from apps.server.fh_server.models import (Approval, Assignment, Event, FileDeletion,
    Floor, MapVersion, Robot, Run, Scenario, ScenarioVersion, Upload)
from apps.server.fh_server.trash import delete_files
from .test_maps import P, auth, maps, tree, upload, save as save_map
from .test_missions import setup_scenario
from .test_runs import scenario, save, event, update


def trash(http, headers, kind, identifier, action='purge'):
    path = P + f'/trash/{kind}/{identifier}'
    return http.post(path + '/restore', headers=headers) if action == 'restore' else http.delete(path, headers=headers)


def test_trash_list_restore_hierarchy_and_child_purge(maps, seeded):
    http, headers, _ = maps
    site, building, floor = tree(http, headers)
    assert trash(http, headers, 'floor', floor).status_code == 409
    for kind, identifier in [('floor', floor), ('building', building), ('site', site)]:
        assert http.delete(P + f'/{kind}s/{identifier}', headers=headers).status_code == 204
    items = http.get(P + '/trash', headers=headers).json()['items']
    assert {i['kind'] for i in items} == {'site', 'building', 'floor'}
    assert next(i for i in items if i['kind'] == 'floor')['parent_name'] == '시험 건물'
    assert all(i['deleted_by']['id'] == str(seeded['users']['admin']) and i['archived_at'] for i in items)
    for kind, identifier in [('floor', floor), ('building', building)]:
        response = trash(http, headers, kind, identifier, 'restore')
        assert response.status_code == 409 and response.json()['error']['code'] == 'PARENT_ARCHIVED'
    for kind, identifier in [('site', site), ('building', building), ('floor', floor)]:
        assert trash(http, headers, kind, identifier, 'restore').status_code == 204
    assert http.get(P + '/trash', headers=headers).json() == {'items': []}
    for kind, identifier in [('floor', floor), ('building', building), ('site', site)]:
        assert http.delete(P + f'/{kind}s/{identifier}', headers=headers).status_code == 204
    assert trash(http, headers, 'site', site).json()['error']['code'] == 'HAS_CHILDREN'
    assert trash(http, headers, 'building', building).json()['error']['code'] == 'HAS_CHILDREN'
    for kind, identifier in [('floor', floor), ('building', building), ('site', site)]:
        response = trash(http, headers, kind, identifier)
        assert response.status_code == 204, response.text
    with Session(http.app.state.engine) as db:
        for kind in ('SITE', 'BUILDING', 'FLOOR'):
            ev = db.scalar(select(Event).where(Event.code == kind + '_PURGED'))
            assert set(ev.data) == {'id', 'name'}


def test_scenario_restore_purge_and_permissions(maps, seeded):
    http, headers, _ = maps
    body, floors, _, _ = setup_scenario(http, headers)
    value = http.post(P + '/scenarios', headers=headers, json=body).json()
    sid = value['id']
    assert http.delete(P + '/scenarios/' + sid, headers=headers).status_code == 204
    assert http.get(P + '/trash').status_code == 401
    # This app's auth is tenant-bound: prove the resource API also scopes every
    # lookup when an authenticated identity is associated with another tenant.
    engine = create_engine(seeded['urls']['migrate'])
    from apps.server.fh_server.models import User
    from fastapi.testclient import TestClient
    from apps.server.fh_server.api import Settings, create_app
    with Session(engine) as db:
        other_org = db.get(User, seeded['users']['foreign']).org_id
    app = create_app(Settings(seeded['urls']['app'], other_org))
    with TestClient(app, base_url='https://testserver') as other:
        other_auth = auth(other, 'foreign')
        assert other.get(P + '/trash', headers=other_auth).json()['items'] == []
        assert trash(other, other_auth, 'scenario', sid).status_code == 404
        assert trash(other, other_auth, 'scenario', sid, 'restore').status_code == 404
    app.state.engine.dispose(); engine.dispose()
    # Current archive permission O includes administrators and operators.
    operator = auth(http, 'one')
    assert trash(http, operator, 'scenario', sid, 'restore').status_code == 204
    restored = http.get(P + '/scenarios/' + sid, headers=headers).json()
    assert restored['archived_at'] is None and restored['version'] == value['version'] + 2
    assert trash(http, headers, 'scenario', sid).json()['error']['code'] == 'NOT_IN_TRASH'
    assert http.delete(P + '/scenarios/' + sid, headers=headers).status_code == 204
    response = trash(http, operator, 'scenario', sid)
    assert response.status_code == 204, response.text
    assert http.get(P + '/scenarios/' + sid, headers=headers).status_code == 404


def test_listing_reads_only_latest_archive_actor_for_current_trash(maps, seeded):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    assert http.delete(P + '/floors/' + floor, headers=headers).status_code == 204
    from apps.server.fh_server.models import now
    at = now()
    with Session(http.app.state.engine) as db:
        # Old cycles and absent resources must not cross the DB boundary as
        # history grows; ties still select the highest event id, as before.
        for n in range(100):
            db.add(Event(org_id=seeded['org'], code='FLOOR_DELETED', category='ACCOUNT',
                severity='INFO', message='synthetic archive', user_id=seeded['users']['admin'],
                data={'id': floor if n % 2 else str(uuid4())}, at=at - timedelta(days=1)))
        for user in ('admin', 'two'):
            db.add(Event(org_id=seeded['org'], code='FLOOR_DELETED', category='ACCOUNT',
                severity='INFO', message='synthetic archive', user_id=seeded['users'][user], data={'id': floor}, at=at))
            db.flush()
        db.commit()
    event_rows = []
    def counted(conn, cursor, statement, parameters, context, many):
        if 'FROM events' in statement:
            event_rows.append(cursor.rowcount)
    sql_event.listen(http.app.state.engine, 'after_cursor_execute', counted)
    try:
        items = http.get(P + '/trash', headers=headers).json()['items']
        assert len(items) == 1 and items[0]['id'] == floor
        assert items[0]['deleted_by'] == {'id': str(seeded['users']['two']), 'display_name': 'two'}
        assert event_rows == [1]
        event_rows.clear()
        assert trash(http, headers, 'floor', floor, 'restore').status_code == 204
        assert http.get(P + '/trash', headers=headers).json() == {'items': []}
        assert event_rows == []
    finally:
        sql_event.remove(http.app.state.engine, 'after_cursor_execute', counted)


@pytest.mark.parametrize('kind,usage', [('scenario', u) for u in ('run', 'ACTIVE', 'PENDING')] +
    [('floor', u) for u in ('run', 'ACTIVE', 'PENDING', 'robot', 'sim')])
def test_purge_rechecks_usage(scenario, kind, usage):
    s = scenario; http = s['client']; headers = auth(http)
    sid, fid = s['started']['scenario_id'], s['started']['floor_id']
    identifier = sid if kind == 'scenario' else fid
    assert http.delete(P + f'/{kind}s/{identifier}', headers=headers).status_code == 204
    engine = create_engine(s['seeded']['urls']['migrate'])
    with Session(engine) as db:
        version = db.scalar(select(ScenarioVersion).where(ScenarioVersion.scenario_id == UUID(sid)))
        if usage in ('ACTIVE', 'PENDING'):
            db.add(Assignment(org_id=s['seeded']['org'], scenario_version_id=version.id,
                robot_id=s['seeded']['robots']['mine'], status=usage, memo='', created_by=s['seeded']['users']['admin']))
        elif usage in ('robot', 'sim'):
            robot = db.get(Robot, s['seeded']['robots']['mine'])
            if usage == 'robot': robot.last_floor_id = UUID(fid)
            else: robot.sim_state, robot.sim_world_id = 'ACTIVE', 'synthetic-world'
        db.commit()
    if usage == 'run':
        # A legacy/live row can be present even after archiving; purge rechecks.
        with Session(engine) as db:
            db.get(Scenario, UUID(sid)).archived_at = None
            db.get(Floor, UUID(fid)).archived_at = None
            db.commit()
        assert save(s, event(s))['t'] == 'run.recorded'
        with Session(engine) as db:
            from apps.server.fh_server.models import now
            db.get(Scenario if kind == 'scenario' else Floor, UUID(identifier)).archived_at = now()
            db.commit()
    response = trash(http, headers, kind, identifier)
    assert response.status_code == 409 and response.json()['error']['code'] == 'RESOURCE_IN_USE', response.text
    engine.dispose()


def test_terminal_history_assignment_approval_photos_and_file_retry(scenario, maps, monkeypatch):
    s = scenario; http = s['client']; headers = auth(http)
    sid, fid = s['started']['scenario_id'], s['started']['floor_id']
    # An ended assignment and its approval remain readable after purge.
    response = http.post(P + '/assignments', headers=headers, json={
        'robot_id': str(s['seeded']['robots']['mine']), 'scenario_id': sid, 'scenario_version': 1})
    assert response.status_code == 201, response.text
    aid = response.json()['id']
    assert http.delete(P + '/assignments/' + aid, headers=headers).status_code == 204
    from .test_photos import start, upload as photo_upload, JPEG
    start(s)
    photo = photo_upload(s).json()
    assert save(s, update(s, seq=3, status='CANCELED'))['t'] == 'run.recorded'
    with Session(http.app.state.engine) as db:
        scenario_name = db.get(Scenario, UUID(sid)).name
        floor_name = db.get(Floor, UUID(fid)).name
        paths = [v.image_path for v in db.scalars(select(MapVersion).where(MapVersion.floor_id == UUID(fid)))]
    for kind, identifier in [('floor', fid), ('scenario', sid)]:
        assert http.delete(P + f'/{kind}s/{identifier}', headers=headers).status_code == 204
    assert trash(http, headers, 'floor', fid).json()['error']['code'] == 'HAS_REFERENCES'
    assert trash(http, headers, 'scenario', sid).status_code == 204
    assignments = http.get(P + '/assignments?archived=true', headers=headers).json()['items']
    item = next(a for a in assignments if a['id'] == aid)
    assert item['scenario_id'] is None and item['scenario_name'] == '삭제된 시나리오: ' + scenario_name
    # Fail one map unlink; the committed history must remain and retries recover.
    original = Path.unlink
    def fail_unlink(path, *args, **kwargs):
        if path.name.endswith('.png'): raise PermissionError('synthetic failure')
        return original(path, *args, **kwargs)
    with monkeypatch.context() as m:
        m.setattr(Path, 'unlink', fail_unlink)
        response = trash(http, headers, 'floor', fid)
        assert response.status_code == 204, response.text
        with Session(http.app.state.engine) as db:
            run = db.get(Run, UUID(s['started']['run_id']))
            assert (run.scenario_version_id, run.floor_id, run.map_version_id) == (None, None, None)
            assert run.scenario_name_snapshot == scenario_name and run.floor_name_snapshot == floor_name
            assert db.get(Assignment, UUID(aid)) is not None
            assert list(db.scalars(select(FileDeletion)))
            assert db.get(Floor, UUID(fid)) is None
            assert db.get(MapVersion, UUID(s['started']['map_version_id'])) is None
    delete_files(s['factory'], maps[2], s['seeded']['org'])
    with Session(http.app.state.engine) as db:
        assert list(db.scalars(select(FileDeletion))) == []
    assert all(not (maps[2] / p).exists() for p in paths)
    history = http.get(P + '/runs/' + s['started']['run_id'] + '/history', headers=headers)
    assert history.status_code == 200, history.text
    assert history.json()['scenario_name'] == '삭제된 시나리오: ' + scenario_name
    assert history.json()['floor_name'] == '삭제된 층: ' + floor_name
    assert http.get(P + '/events', params={'run_id': s['started']['run_id']}, headers=headers).json()['items']
    assert http.get(P + '/photos/' + photo['photo_id'], headers=headers).content == JPEG
    from alembic import command
    from alembic.config import Config
    from sqlalchemy.exc import DBAPIError
    from .conftest import CONFIG
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', s['seeded']['urls']['migrate'])
    with pytest.raises(DBAPIError, match='Reconcile purged history'):
        command.downgrade(Config(str(CONFIG)), '0022')


def test_map_files_are_deleted_after_commit_with_shared_upload_protected(maps):
    http, headers, root = maps
    _, _, floor = tree(http, headers)
    _, _, other_floor = tree(http, headers)
    image = upload(http, headers)
    first = save_map(http, headers, floor, image).json()
    other = save_map(http, headers, other_floor, image).json()
    with Session(http.app.state.engine) as db:
        path = root / db.get(MapVersion, UUID(first['id'])).image_path
        upload_path = root / db.get(Upload, UUID(image)).image_path
    assert path.exists() and path.with_suffix('.yaml').exists()
    assert http.delete(P + '/floors/' + floor, headers=headers).status_code == 204
    assert trash(http, headers, 'floor', floor).status_code == 204
    assert not path.exists() and not path.with_suffix('.yaml').exists()
    assert upload_path.exists()
    assert http.get(P + '/map-versions/' + other['id'] + '/image', headers=headers).status_code == 200
    assert http.delete(P + '/floors/' + other_floor, headers=headers).status_code == 204
    assert trash(http, headers, 'floor', other_floor).status_code == 204
    assert not upload_path.exists()
    with Session(http.app.state.engine) as db:
        assert list(db.scalars(select(FileDeletion))) == []


def test_map_approval_history_survives_purge(maps):
    http, admin, _ = maps
    _, _, floor = tree(http, admin)
    image = upload(http, admin)
    operator = auth(http, 'one')
    from .legacy_approvals import pending_map
    version, pending = pending_map(http, operator, floor, image)
    assert http.delete(P + '/floors/' + floor, headers=admin).status_code == 204
    assert trash(http, admin, 'floor', floor).json()['error']['code'] == 'RESOURCE_IN_USE'
    response = http.post(P + '/approvals/' + pending['id'] + '/cancel', headers=operator)
    assert response.status_code == 200, response.text
    assert trash(http, admin, 'floor', floor).status_code == 204
    response = http.get(P + '/approvals/' + pending['id'], headers=admin)
    assert response.status_code == 200, response.text
    assert response.json()['target']['id'] is None
    assert response.json()['preview']['floor_name'] == '삭제된 층: 1층'
    assert response.json()['preview']['floor_id'] is None


def test_purge_rollback_keeps_db_files_and_outbox_atomic(maps, monkeypatch):
    http, headers, root = maps
    _, _, floor = tree(http, headers)
    version = save_map(http, headers, floor, upload(http, headers)).json()
    with Session(http.app.state.engine) as db:
        path = root / db.get(MapVersion, UUID(version['id'])).image_path
    assert http.delete(P + '/floors/' + floor, headers=headers).status_code == 204
    from sqlalchemy import event as sql_event
    def fail_commit(conn, cursor, statement, parameters, context, executemany):
        if 'SELECT fh_purge_resource' in statement:
            raise RuntimeError('synthetic transaction failure')
    sql_event.listen(http.app.state.engine, 'after_cursor_execute', fail_commit)
    try:
        with pytest.raises(RuntimeError, match='synthetic transaction failure'):
            trash(http, headers, 'floor', floor)
    finally:
        sql_event.remove(http.app.state.engine, 'after_cursor_execute', fail_commit)
    assert path.exists() and path.with_suffix('.yaml').exists()
    with Session(http.app.state.engine) as db:
        assert db.get(Floor, UUID(floor)) is not None
        assert db.get(MapVersion, UUID(version['id'])) is not None
        assert list(db.scalars(select(FileDeletion))) == []
        assert db.scalar(select(Event).where(Event.code == 'FLOOR_PURGED')) is None


def test_scenario_approval_history_and_later_removal_after_purge(maps, seeded):
    http, headers, _ = maps
    body, _, _, _ = setup_scenario(http, headers)
    value = http.post(P + '/scenarios', headers=headers, json=body).json()
    from .legacy_approvals import pending_assignment
    operator = auth(http, 'one')
    assignment = pending_assignment(http, operator, value, seeded['robots']['mine'])
    approval_id = assignment['approval_id']
    result = http.post(P + '/approvals/' + approval_id + '/reject', headers=headers,
        json={'reason': '합성 기록 보존 시험'})
    assert result.status_code == 200, result.text
    assert http.delete(P + '/scenarios/' + value['id'], headers=headers).status_code == 204
    assert trash(http, headers, 'scenario', value['id']).status_code == 204
    result = http.get(P + '/approvals/' + approval_id, headers=headers)
    assert result.status_code == 200, result.text
    assert result.json()['preview']['scenario_id'] is None
    assert result.json()['preview']['scenario_name'] == '삭제된 시나리오: ' + body['name']
    assert http.delete(P + '/assignments/' + assignment['id'], headers=operator).status_code == 204
    history = http.get(P + '/assignments?archived=true', headers=headers).json()['items'][0]
    assert history['status'] == 'REMOVED' and history['scenario_name_snapshot'] == body['name']


def test_removed_legacy_assignment_with_pending_approval_still_blocks_purge(maps, seeded):
    http, headers, _ = maps
    body, _, _, _ = setup_scenario(http, headers)
    value = http.post(P + '/scenarios', headers=headers, json=body).json()
    from .legacy_approvals import pending_assignment
    item = pending_assignment(http, auth(http, 'one'), value, seeded['robots']['mine'])
    engine = create_engine(seeded['urls']['migrate'])
    with engine.begin() as conn:
        conn.execute(text("UPDATE assignments SET status='REMOVED', removed_at=now() WHERE id=:id"), {'id': item['id']})
    engine.dispose()
    assert http.delete(P + '/scenarios/' + value['id'], headers=headers).status_code == 204
    result = trash(http, headers, 'scenario', value['id'])
    assert result.status_code == 409 and result.json()['error']['code'] == 'RESOURCE_IN_USE'


def test_purge_capability_is_narrow_and_not_public(maps, seeded):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    from sqlalchemy.exc import DBAPIError
    with http.app.state.engine.begin() as conn, pytest.raises(DBAPIError, match='Resource must be in trash'):
        conn.execute(text("SELECT fh_purge_resource(:org,'floor',:id)"), {'org': seeded['org'], 'id': floor})
    readonly = create_engine(seeded['urls']['readonly'])
    try:
        with readonly.begin() as conn, pytest.raises(DBAPIError, match='permission denied'):
            conn.execute(text("SELECT fh_purge_resource(:org,'floor',:id)"), {'org': seeded['org'], 'id': floor})
    finally:
        readonly.dispose()

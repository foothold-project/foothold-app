"""Live recovery uses persisted latest states; no robots or listening HTTP ports."""
from alembic import command
from alembic.config import Config
from threading import Event
from time import perf_counter, sleep
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server import mapping_voxels
from apps.server.fh_server.models import MappingSession, MappingVoxel, MappingVoxelState, Robot, User
from .conftest import CONFIG
from .test_maps import P, auth, maps  # noqa: F401
from .test_mapping import action, setup  # noqa: F401
from .test_slam_mapping import start, report, current


def delta(seq=1, *, revision=1, reset=False, added=(), removed=()):
    return dict(revision=revision, seq=seq, reset=reset, frame_id='world_map',
        added=list(added), removed=list(removed))


def get(s, initial, **params):
    http, headers, _, rid, *_ = s
    return http.get(P + f'/robots/{rid}/slam/{initial["session_id"]}/voxels',
        headers=headers, params={'revision': 1, **params})


def cells(page, kind='added'):
    return {tuple(change['cell']): change['seq'] for change in page[kind]}


def test_many_deltas_one_poll_removal_and_restart(setup, seeded):
    s = setup
    initial = start(s)
    first = get(s, initial)
    assert first.status_code == 200 and first.json()['seq'] == 0
    assert first.json()['frame_id'] is None and first.json()['next_cursor'] is None
    for seq in range(1, 8):
        assert report(s, initial, update_seq=seq + 10,
            voxels=delta(seq, reset=seq == 1, added=[(seq, 0, 0)])).status_code == 202
    page = get(s, initial).json()
    assert cells(page) == {(seq, 0, 0): seq for seq in range(1, 8)}
    assert page['seq'] == 7 and page['reset'] and page['reset_seq'] == 1
    assert get(s, initial).headers['cache-control'] == 'private, no-store'
    assert report(s, initial, update_seq=18, voxels=delta(8, removed=[(1, 0, 0)],
        added=[(2, 0, 0), (8, 0, 0)])).status_code == 202
    change = get(s, initial, since=7).json()
    assert not change['reset'] and cells(change) == {(8, 0, 0): 8}
    assert cells(change, 'removed') == {(1, 0, 0): 8}
    # Repeated adds preserve last actual change; removed cells are absent in a full read.
    assert cells(get(s, initial).json()) == {(seq, 0, 0): seq for seq in range(2, 9)}
    assert get(s, initial, since=8).json()['added'] == []
    # A fresh app has no in-memory mapping cache or agent peer.
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    try:
        with TestClient(app, base_url='https://testserver') as fresh:
            response = fresh.get(P + f'/robots/{s[3]}/slam/{initial["session_id"]}/voxels',
                headers=auth(fresh, 'one'), params={'revision': 1, 'since': 7})
            assert response.status_code == 200
            assert response.json() == change
    finally:
        app.state.engine.dispose()


def test_pages_catchup_bound_cursor_and_reset(setup):
    s = setup
    initial = start(s)
    source = [(x, -200000, 200000) for x in range(-700, 700)]
    assert report(s, initial, voxels=delta(reset=True, added=source)).status_code == 202
    first_response = get(s, initial)
    first = first_response.json()
    assert len(first_response.content) <= C.MAPPING_VOXEL_PAGE_BYTES
    assert len(first['added']) == C.MAPPING_VOXEL_PAGE_CELLS and first['next_cursor']
    assert isinstance(first['next_cursor'], str)
    merged = cells(first)
    cursor = first['next_cursor']
    # A write behind the keyset cursor is recovered by the next pass's baseline.
    report(s, initial, update_seq=2, voxels=delta(2, added=[(-1000, 0, 0)], removed=[source[0]]))
    while cursor:
        response = get(s, initial, cursor=cursor)
        assert response.status_code == 200 and len(response.content) <= C.MAPPING_VOXEL_PAGE_BYTES
        page = response.json()
        merged.update(cells(page))
        cursor = page['next_cursor']
    assert set(merged) == set(source)
    catchup = get(s, initial, since=first['seq']).json()
    assert cells(catchup) == {(-1000, 0, 0): 2}
    assert cells(catchup, 'removed') == {source[0]: 2}
    assert get(s, initial, cursor=first['next_cursor'], since=1).status_code == 422
    assert get(s, initial, cursor='bad!').status_code == 422
    assert get(s, initial, since=100).status_code == 409
    report(s, initial, update_seq=3, voxels=delta(3, reset=True, added=[(4, 5, 6)]))
    conflict = get(s, initial, cursor=first['next_cursor'])
    assert conflict.status_code == 409 and conflict.json()['error']['code'] == 'MAPPING_VOXEL_RESET_CONFLICT'
    reset = get(s, initial, since=2).json()
    assert reset['reset'] and reset['reset_seq'] == 3 and cells(reset) == {(4, 5, 6): 3}
    report(s, initial, update_seq=4, voxels=delta(4, reset=True))
    empty = get(s, initial, since=3).json()
    assert empty['reset'] and not empty['added'] and not empty['removed'] and empty['seq'] == 4


def test_new_revision_permissions_and_isolation(setup, seeded):
    s = setup
    initial = start(s)
    report(s, initial, voxels=delta(reset=True, added=[(1, 2, 3)]))
    report(s, initial, update_seq=2, revision=2)
    assert get(s, initial).status_code == 409
    empty = get(s, initial, revision=2).json()
    assert empty['seq'] == 0 and empty['added'] == []
    report(s, initial, update_seq=3, revision=2, voxels=delta(1, revision=2, reset=True, added=[(9, 8, 7)]))
    assert cells(get(s, initial, revision=2).json()) == {(9, 8, 7): 1}
    http, headers, _, rid, _, _, engine = s
    url = P + f'/robots/{rid}/slam/{initial["session_id"]}/voxels?revision=2'
    assert http.get(url, headers=auth(http, 'two')).status_code == 403
    assert http.get(url, headers=auth(http, 'admin')).status_code == 403
    with Session(engine) as db:
        foreign_org = db.get(User, seeded['users']['foreign']).org_id
    foreign_app = create_app(Settings(seeded['urls']['app'], foreign_org))
    try:
        with TestClient(foreign_app, base_url='https://testserver') as foreign:
            foreign_headers = auth(foreign, 'foreign')
            assert http.get(url, headers=foreign_headers).status_code == 401
            assert foreign.get(url, headers=foreign_headers).status_code == 409
    finally:
        foreign_app.state.engine.dispose()
    foreign_robot = str(seeded['robots']['foreign'])
    assert http.get(url.replace(rid, foreign_robot), headers=headers).status_code == 409
    with Session(engine) as db:
        db.get(Robot, rid).owner_user_id = seeded['users']['two']
        db.commit()
    assert http.get(url, headers=headers).status_code == 403
    # Match tiles: a reassigned current robot owner can recover existing sessions.
    assert http.get(url, headers=auth(http, 'two')).status_code == 200


def test_sessions_and_their_cursors_stay_separate(setup):
    s = setup
    first = start(s)
    report(s, first, voxels=delta(reset=True, added=[(x, 0, 0) for x in range(600)]))
    cursor = get(s, first).json()['next_cursor']
    assert cursor
    assert action(s, 'cancel', first['session_id']).status_code == 200
    second = start(s)
    report(s, second, voxels=delta(reset=True, added=[(-1, 0, 0)]))
    assert cells(get(s, second).json()) == {(-1, 0, 0): 1}
    assert get(s, second, cursor=cursor).status_code == 422
    tail = get(s, first, cursor=cursor).json()
    assert len(tail['added']) == 88 and tail['next_cursor'] is None


def test_durable_sequence_and_frame_survive_null_compatibility_delta(setup):
    s = setup
    initial = start(s)
    report(s, initial, voxels=delta(4, reset=True, added=[(1, 2, 3)]))
    assert report(s, initial, update_seq=2, voxels=None).status_code == 202
    assert current(s)['voxels'] is None
    report(s, initial, update_seq=3, voxels=delta(1, reset=True, added=[(9, 9, 9)]))
    assert current(s)['update_seq'] == 2
    report(s, initial, update_seq=3, voxels={**delta(5, reset=True), 'frame_id': 'wrong'})
    assert current(s)['update_seq'] == 2
    assert get(s, initial).json()['seq'] == 4
    assert cells(get(s, initial).json()) == {(1, 2, 3): 4}


def test_occupied_limit_real_500000_cells_is_atomic_and_records_reason(setup):
    s = setup
    initial = start(s)
    report(s, initial, voxels=delta(reset=True, added=[(0, 0, 0)]))
    engine = s[-1]
    with engine.begin() as conn:
        conn.execute(text('''INSERT INTO mapping_voxels(org_id,session_id,x,y,z,seq,present)
            SELECT org_id,id,i/1000,i%1000,0,1,true FROM mapping_sessions,
            generate_series(1,499999) i WHERE id=:id'''), {'id': initial['session_id']})
        conn.execute(text('UPDATE mapping_voxel_states SET cell_count=500000 WHERE session_id=:id'),
            {'id': initial['session_id']})
    rejected = report(s, initial, update_seq=2, voxels=delta(2, added=[(1000, 0, 0)]))
    assert rejected.status_code == 409 and rejected.json()['error']['code'] == 'MAPPING_VOXEL_LIMIT'
    observed = current(s)
    assert observed['update_seq'] == 1 and observed['voxels']['seq'] == 1
    assert observed['last_report_rejection']['code'] == 'MAPPING_VOXEL_LIMIT'
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MappingVoxel).where(MappingVoxel.present)) == 500000
        assert db.get(MappingVoxelState, initial['session_id']).seq == 1
    # Remove and add at capacity, duplicate coordinates and overlap count once.
    accepted = report(s, initial, update_seq=2, voxels=delta(2,
        removed=[(0, 0, 0), (0, 0, 0), (1000, 0, 0)], added=[(1000, 0, 0), (1000, 0, 0)]))
    assert accepted.status_code == 202
    page = get(s, initial, since=1).json()
    assert cells(page) == {(1000, 0, 0): 2} and cells(page, 'removed') == {(0, 0, 0): 2}
    # Reset frees old occupied cells and tombstones, including across revisions.
    report(s, initial, update_seq=3, revision=2,
        voxels=delta(1, revision=2, reset=True, added=[(7, 7, 7)]))
    assert cells(get(s, initial, revision=2).json()) == {(7, 7, 7): 1}
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MappingVoxel)) == 1
        assert db.get(MappingVoxelState, initial['session_id']).cell_count == 1


def test_full_session_2000_cell_reports_stay_below_one_second(setup):
    s = setup
    initial = start(s)
    assert report(s, initial, voxels=delta(reset=True)).status_code == 202
    with s[-1].begin() as conn:
        conn.execute(text('''INSERT INTO mapping_voxels(org_id,session_id,x,y,z,seq,present)
            SELECT org_id,id,i/1000,i%1000,0,1,true FROM mapping_sessions,
            generate_series(0,499999) i WHERE id=:id'''), {'id': initial['session_id']})
        conn.execute(text('UPDATE mapping_voxel_states SET cell_count=500000 WHERE session_id=:id'),
            {'id': initial['session_id']})
    existing = [(i // 1000, i % 1000, 0) for i in range(2000)]
    fresh = [(1000 + i // 1000, i % 1000, 0) for i in range(2000)]
    cases = [
        ('existing', delta(2, added=existing), 202, 500000),
        ('overflow', delta(3, added=fresh), 409, 500000),
        ('removed', delta(4, removed=existing), 202, 498000),
        ('new', delta(5, added=fresh), 202, 500000),
    ]
    for label, change, status, count in cases:
        began = perf_counter()
        response = report(s, initial, update_seq=change['seq'], voxels=change)
        elapsed = perf_counter() - began
        print(f'500000-cell session / 2000 {label}: {elapsed:.3f}s')
        assert response.status_code == status, response.text
        assert elapsed < 1.0, (label, elapsed)
        with Session(s[-1]) as db:
            state = db.get(MappingVoxelState, initial['session_id'])
            assert state.cell_count == count
            assert state.seq == (2 if label == 'overflow' else change['seq'])
            rows = db.scalars(select(MappingVoxel).where(MappingVoxel.x < 2)).all()
            assert len(rows) == 2000
            assert all(row.seq == (4 if label in ('removed', 'new') else 1) for row in rows)
            assert all(row.present == (label not in ('removed', 'new')) for row in rows)


def test_http_timeout_cannot_commit_in_background_and_retry_succeeds(setup, monkeypatch):
    s = setup
    initial = start(s)
    assert report(s, initial, voxels=delta(reset=True, added=[(1, 2, 3)])).status_code == 202
    before = current(s)
    changed, release, finished = Event(), Event(), Event()
    accumulate, receive = mapping_voxels.accumulate, s[4].mapping.report

    def paused_accumulate(*args):
        result = accumulate(*args)
        changed.set()  # geometry SQL has executed while the organization lock is held
        assert release.wait(5)
        return result

    def receive_until_finished(*args, **kwargs):
        try:
            return receive(*args, **kwargs)
        finally:
            finished.set()

    change = delta(2, removed=[(1, 2, 3)], added=[(4, 5, 6)])
    with monkeypatch.context() as patch:
        patch.setattr('apps.server.fh_server.realtime.DB_READ_TIMEOUT', .4)
        patch.setattr(mapping_voxels, 'accumulate', paused_accumulate)
        patch.setattr(s[4].mapping, 'report', receive_until_finished)
        try:
            with pytest.raises(TimeoutError):
                report(s, initial, update_seq=2, voxels=change)
            assert changed.is_set()
        finally:
            release.set()
            assert finished.wait(3)
    assert current(s) == before
    assert cells(get(s, initial).json()) == {(1, 2, 3): 1}
    with s[-1].begin() as conn:
        conn.execute(text("SET LOCAL lock_timeout = '200ms'"))
        conn.execute(text('SELECT id FROM organizations FOR NO KEY UPDATE'))
    assert report(s, initial, update_seq=2, voxels=change).status_code == 202
    assert cells(get(s, initial, since=1).json()) == {(4, 5, 6): 2}
    assert cells(get(s, initial, since=1).json(), 'removed') == {(1, 2, 3): 2}


def test_slow_sql_is_cancelled_and_rolls_back_geometry_and_progress(setup, monkeypatch):
    s = setup
    initial = start(s)
    assert report(s, initial, voxels=delta(reset=True, added=[(1, 2, 3)])).status_code == 202
    before = current(s)
    accumulate = mapping_voxels.accumulate

    def slow_accumulate(db, *args):
        result = accumulate(db, *args)
        db.execute(text('SELECT pg_sleep(2)'))
        return result

    with monkeypatch.context() as patch:
        patch.setattr('apps.server.fh_server.realtime.DB_READ_TIMEOUT', .4)
        patch.setattr(mapping_voxels, 'accumulate', slow_accumulate)
        began = perf_counter()
        response = report(s, initial, update_seq=2, voxels=delta(2, added=[(4, 5, 6)]))
        assert response.status_code == 500
        assert perf_counter() - began < .4
    assert current(s) == before
    assert cells(get(s, initial).json()) == {(1, 2, 3): 1}
    with s[4].run_factory() as db:
        assert db.scalar(text('SHOW statement_timeout')) == '2s'


def test_worker_deadline_rechecks_after_flush_before_commit(setup, monkeypatch):
    s = setup
    initial = start(s)
    assert report(s, initial, voxels=delta(reset=True, added=[(1, 2, 3)])).status_code == 202
    before = current(s)
    rt = s[4]
    msg = C.AgentMappingUpdate.model_validate(dict(t='slam.update',
        session_id=initial['session_id'], floor_id=s[2], command_id=initial['command_id'],
        status='RUNNING', phase='STARTED', revision=1, update_seq=2,
        voxels=delta(2, removed=[(1, 2, 3)], added=[(4, 5, 6)])))

    def slow_flush(db, context):
        if db.bind is rt.run_engine and any(isinstance(row, MappingSession) for row in db.dirty):
            sleep(.4)  # all geometry and progress SQL succeeded, but COMMIT has not run

    event.listen(Session, 'after_flush', slow_flush)
    try:
        with monkeypatch.context() as patch:
            patch.setattr('apps.server.fh_server.realtime.DB_READ_TIMEOUT', .4)
            with pytest.raises(TimeoutError):
                rt.mapping.report(s[3], msg)
    finally:
        event.remove(Session, 'after_flush', slow_flush)
    assert current(s) == before
    assert cells(get(s, initial).json()) == {(1, 2, 3): 1}


def test_migration_preserves_history_and_refuses_lossy_downgrade(setup, seeded, monkeypatch):
    s = setup
    initial = start(s)
    engine = s[-1]
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
    config = Config(str(CONFIG))
    command.downgrade(config, '0033')
    with Session(engine) as db:
        row = db.get(MappingSession, initial['session_id'])
        row.progress = {**row.progress, 'update_seq': 1,
            'voxels': delta(1, reset=True, added=[(1, 2, 3)])}
        db.commit()
        before = (row.status, row.progress, row.result)
    command.upgrade(config, 'head')
    with Session(engine) as db:
        row = db.get(MappingSession, initial['session_id'])
        assert (row.status, row.progress, row.result) == before
    assert get(s, initial).status_code == 409  # never fabricate a full historical map
    rejected = report(s, initial, update_seq=2, voxels=delta(2, added=[(4, 5, 6)]))
    assert rejected.status_code == 409 and rejected.json()['error']['code'] == 'MAPPING_VOXELS_RESET_REQUIRED'
    assert report(s, initial, update_seq=2, voxels=delta(2, reset=True, added=[(4, 5, 6)])).status_code == 202
    with pytest.raises(DBAPIError, match='Retire live SLAM voxels'):
        command.downgrade(config, '0033')
    assert cells(get(s, initial).json()) == {(4, 5, 6): 2}
    with engine.begin() as conn:
        assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0034'
        conn.execute(text('DELETE FROM mapping_sessions WHERE id=:id'), {'id': initial['session_id']})
    command.downgrade(config, '0033')
    command.upgrade(config, 'head')

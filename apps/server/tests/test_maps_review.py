"""PR26 B1/B2/R1-R8: bounded work, current auth, disk reserve and precise audit."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, Lock, get_ident
from types import SimpleNamespace
import math
import time

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server import api, maps as M
from apps.server.fh_server.models import Floor, Upload, now
from .test_maps import maps, auth, tree, upload, save, P, PGM, YAML, FEATURES


def test_upload_rechecks_revoked_session_after_conversion(maps, seeded, monkeypatch):
    http, headers, root = maps
    entered, release = Event(), Event()
    original = M.image_bytes
    def blocked(*args):
        entered.set()
        assert release.wait(4)
        return original(*args)
    monkeypatch.setattr(M, 'image_bytes', blocked)
    engine = create_engine(seeded['urls']['migrate'])
    with ThreadPoolExecutor(max_workers=1) as pool:
        response = pool.submit(http.post, P + '/uploads', headers={**headers, 'content-type': 'image/x-portable-graymap'}, content=PGM)
        try:
            assert entered.wait(3)
            with engine.begin() as conn:
                conn.execute(text('UPDATE sessions SET revoked_at=now() WHERE user_id=:user'), {'user': seeded['users']['admin']})
        finally:
            release.set()
        result = response.result(timeout=5)
    try:
        assert result.status_code == 401
        assert not list(root.rglob('image.png'))
        with engine.connect() as conn:
            assert conn.scalar(text('SELECT count(*) FROM uploads')) == 0
    finally:
        engine.dispose()


def test_all_upload_sync_work_runs_off_event_loop(maps, monkeypatch):
    http, headers, _ = maps
    @http.app.get('/loop-thread')
    async def loop():
        return get_ident()
    loop_id = http.get('/loop-thread').json()
    observed = []
    original_image, original_sha, original_write = M.image_bytes, M.sha256, M.Path.write_bytes
    def image(*args):
        observed.append(('image', get_ident()))
        return original_image(*args)
    def sha(*args):
        observed.append(('sha', get_ident()))
        return original_sha(*args)
    def write(path, *args):
        observed.append(('file', get_ident()))
        return original_write(path, *args)
    def sql(conn, cursor, statement, *args):
        if 'uploads' in statement.lower():
            observed.append(('db', get_ident()))
    monkeypatch.setattr(M, 'image_bytes', image)
    monkeypatch.setattr(M, 'sha256', sha)
    monkeypatch.setattr(M.Path, 'write_bytes', write)
    event.listen(http.app.state.engine, 'before_cursor_execute', sql)
    try:
        upload(http, headers)
    finally:
        event.remove(http.app.state.engine, 'before_cursor_execute', sql)
    assert {kind for kind, _ in observed} == {'image', 'sha', 'file', 'db'}
    assert all(thread != loop_id for _, thread in observed)


def test_conversion_slot_survives_caller_cancellation():
    async def run():
        slot = asyncio.Semaphore(1)
        entered, release = Event(), Event()
        second_started = Event()
        def first():
            entered.set()
            assert release.wait(3)
        task = asyncio.create_task(M.upload_work(slot, first, api.fail))
        while not entered.is_set():
            await asyncio.sleep(.001)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        try:
            with pytest.raises(api.APIError) as rejected:
                await M.upload_work(slot, second_started.set, api.fail)
            assert rejected.value.status == 503 and rejected.value.code == 'SERVER_BUSY'
            assert not second_started.is_set()
        finally:
            release.set()
        async def released():
            while slot.locked():
                await asyncio.sleep(.001)
        await asyncio.wait_for(released(), 3)
        await M.upload_work(slot, second_started.set, api.fail)
        assert second_started.is_set()
    asyncio.run(run())


def test_busy_upload_returns_server_busy_without_waiting(maps, monkeypatch):
    http, headers, _ = maps
    entered, release = Event(), Event()
    guard = Lock()
    active, maximum, calls = 0, 0, 0
    original = M.image_bytes
    def convert(*args):
        nonlocal active, maximum, calls
        with guard:
            active += 1
            maximum = max(maximum, active)
            calls += 1
            number = calls
        try:
            if number == 1:
                entered.set()
                assert release.wait(3)
            return original(*args)
        finally:
            with guard:
                active -= 1
    monkeypatch.setattr(M, 'image_bytes', convert)
    def request():
        return http.post(P + '/uploads', headers={**headers, 'content-type': 'image/x-portable-graymap'}, content=PGM)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(request)
        assert entered.wait(3)
        second = pool.submit(request)
        try:
            try:
                rejected = second.result(timeout=1)
            except TimeoutError:
                pytest.fail('busy upload retained a received body waiting for conversion')
            assert rejected.status_code == 503 and rejected.json()['error']['code'] == 'SERVER_BUSY'
            assert calls == 1
        finally:
            release.set()
        assert first.result(timeout=4).status_code == 201
    assert request().status_code == 201  # permit is reusable after the first worker exits
    assert maximum == 1 and calls == 2


@pytest.mark.parametrize('where', ['upload', 'version'])
def test_low_disk_rejected_before_new_files_or_rows(maps, seeded, monkeypatch, where):
    http, headers, root = maps
    if where == 'version':
        _, _, floor = tree(http, headers)
        image = upload(http, headers)
    before_files = set(root.rglob('*')) if root.exists() else set()
    monkeypatch.setattr(M.shutil, 'disk_usage', lambda _: SimpleNamespace(free=M.MIN_FREE_SPACE - 1))
    if where == 'upload':
        response = http.post(P + '/uploads', headers={**headers, 'content-type': 'image/x-portable-graymap'}, content=PGM)
    else:
        response = save(http, headers, floor, image)
    assert response.status_code == 503 and response.json()['error']['code'] == 'FILE_STORAGE_FULL'
    assert (set(root.rglob('*')) if root.exists() else set()) == before_files
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.connect() as conn:
            assert conn.scalar(text('SELECT count(*) FROM map_versions')) == 0
            assert conn.scalar(text('SELECT count(*) FROM uploads')) == (2 if where == 'version' else 0)
    finally:
        engine.dispose()


def test_features_total_vertices_rejected_before_geometry(maps):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers)
    circle = [[1 + .8 * math.cos(n * math.tau / 256), 1 + .8 * math.sin(n * math.tau / 256)] for n in range(256)]
    features = {**FEATURES, 'zones': [{'id': str(n), 'type': 'NO_GO', 'name': '구역', 'polygon': circle} for n in range(17)]}
    response = save(http, headers, floor, image, features=features)
    assert response.status_code == 422 and response.json()['error']['detail']['element'] == 'features'


@pytest.mark.parametrize('name', ['줄\n바꿈', 'a\tb', 'a\x1fb', 'a\u202eb', 'a\u200db'])
def test_map_names_reject_control_and_format_characters(maps, name):
    http, headers, _ = maps
    site, building, floor = tree(http, headers)
    assert http.post(P + '/sites', headers=headers, json={'name': name}).status_code == 400
    assert http.post(P + f'/sites/{site}/buildings', headers=headers, json={'name': name}).status_code == 400
    assert http.post(P + f'/buildings/{building}/floors', headers=headers, json={'name': name, 'level': 2}).status_code == 400
    for path in (f'/sites/{site}', f'/buildings/{building}', f'/floors/{floor}'):
        assert http.patch(P + path, headers=headers, json={'name': name}).status_code == 400


def test_event_scope_labels_match_resource(maps, seeded):
    http, headers, _ = maps
    site, building, floor = tree(http, headers)
    image = upload(http, headers)
    assert save(http, headers, floor, image).status_code == 201
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.connect() as conn:
            rows = dict(conn.execute(text("SELECT code,data FROM events WHERE code LIKE '%CREATED' OR code='MAP_VERSION_APPROVED'")).all())
        assert rows['SITE_CREATED'].get('site_id') == site and 'floor_id' not in rows['SITE_CREATED']
        assert rows['BUILDING_CREATED'].get('building_id') == building and 'floor_id' not in rows['BUILDING_CREATED']
        assert rows['FLOOR_CREATED']['floor_id'] == rows['MAP_VERSION_APPROVED']['floor_id'] == floor
    finally:
        engine.dispose()


@pytest.mark.parametrize('privilege', ['UPDATE', 'DELETE', 'TRUNCATE'])
def test_startup_rejects_mutable_upload_role(seeded, tmp_path, privilege):
    engine = create_engine(seeded['urls']['migrate'])
    app = api.create_app(api.Settings(seeded['urls']['app'], seeded['org'], files_root=str(tmp_path)))
    try:
        with engine.begin() as conn:
            conn.execute(text(f'GRANT {privilege} ON uploads TO fh_app'))
        with pytest.raises(RuntimeError, match='restricted fh_app'):
            with TestClient(app):
                pass
    finally:
        with engine.begin() as conn:
            conn.execute(text(f'REVOKE {privilege} ON uploads FROM fh_app'))
        engine.dispose()
        app.state.engine.dispose()


def test_floor_lock_preserves_stale_without_organization_lock(maps, seeded, monkeypatch):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers)
    other = auth(http)
    monkeypatch.setattr(api, 'lock_organization', lambda *args: None)
    engine = create_engine(seeded['urls']['migrate'])
    waiting = Event()
    count, mutex = 0, Lock()
    def queried(conn, cursor, statement, *args):
        nonlocal count
        if 'FROM floors' in statement and 'floors.id =' in statement:
            with mutex:
                count += 1
                if count == 2:
                    waiting.set()
    event.listen(http.app.state.engine, 'before_cursor_execute', queried)
    try:
        with Session(engine) as blocker, ThreadPoolExecutor(max_workers=2) as pool:
            blocker.scalar(select(Floor).where(Floor.id == floor).with_for_update())
            first = pool.submit(save, http, headers, floor, image)
            second = pool.submit(save, http, other, floor, image)
            try:
                assert waiting.wait(3)
            finally:
                blocker.commit()
            try:
                responses = [first.result(timeout=5), second.result(timeout=5)]
            except Exception as exc:
                pytest.fail(f'concurrent map save raised {type(exc).__name__} instead of 201/STALE409')
        assert sorted(response.status_code for response in responses) == [201, 409]
        assert next(response for response in responses if response.status_code == 409).json()['error']['code'] == 'STALE'
    finally:
        event.remove(http.app.state.engine, 'before_cursor_execute', queried)
        engine.dispose()


def test_over_cap_ihdr_returns_422(maps):
    from .test_map_files import oversized_png
    http, headers, _ = maps
    result = http.post(P + '/uploads', headers={**headers, 'content-type': 'image/png'}, content=oversized_png())
    assert result.status_code == 422 and result.json()['error']['code'] == 'INVALID_UPLOAD'


def test_upload_cookie_csrf_and_fresh_session_are_preserved(maps):
    http, _, _ = maps
    response = http.post(P + '/auth/login', json={'username': 'one', 'password': 'fake-test-password', 'client': 'web'})
    csrf = response.json()['csrf_token']
    missing = http.post(P + '/uploads', headers={'content-type': 'image/x-portable-graymap'}, content=PGM)
    assert missing.status_code == 403
    accepted = http.post(P + '/uploads', headers={'content-type': 'image/x-portable-graymap', 'x-fh-csrf': csrf}, content=PGM)
    assert accepted.status_code == 201


@pytest.mark.parametrize('missing_at', ['stat', 'read'])
def test_missing_upload_file_returns_storage_503(maps, seeded, monkeypatch, missing_at):
    http, headers, root = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers)
    source = next(root.glob('uploads/tmp/*/image.png'))
    if missing_at == 'stat':
        source.unlink()
    else:
        original = M.ensure_space
        def remove_after_stat(*args):
            original(*args)
            source.unlink()
        monkeypatch.setattr(M, 'ensure_space', remove_after_stat)
    try:
        response = save(http, headers, floor, image)
    except OSError as exc:
        pytest.fail(f'missing upload escaped as {type(exc).__name__} instead of FILE_STORAGE_ERROR')
    assert response.status_code == 503 and response.json()['error']['code'] == 'FILE_STORAGE_ERROR'
    assert not list(root.glob('maps/*/*.png'))
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.connect() as conn:
            assert conn.scalar(text('SELECT count(*) FROM map_versions')) == 0
            assert conn.scalar(text('SELECT approved_version_id FROM floors WHERE id=:id'), {'id': floor}) is None
    finally:
        engine.dispose()

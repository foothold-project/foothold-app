"""S3b acceptance: bounded tenant-scoped diff and immutable rollback."""
import copy
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server import api, maps as M
from apps.server.fh_server.models import Building, Floor, MapVersion, Site, Upload, User
from .test_maps import maps, auth, tree, upload, save, P, PGM, YAML, FEATURES


def rollback(http, headers, target, base, reason='옛 판으로 복사 시험'):
    return http.post(P + f'/map-versions/{target}/rollback', headers=headers,
        json={'base_version_id': base, 'reason': reason})


def pair(maps):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers)
    first = save(http, headers, floor, image).json()
    second = save(http, headers, floor, image, base=first['id']).json()
    return floor, first, second


def test_diff_all_feature_kinds_image_and_default_base(maps):
    http, headers, _ = maps
    _, building, floor = tree(http, headers)
    other = http.post(P + f'/buildings/{building}/floors', headers=headers, json={'name': '2층', 'level': 2}).json()['id']
    examples = {
        'zones': {'id': 'keep', 'type': 'NO_GO', 'name': '구역', 'polygon': [[0, 0], [1, 0], [1, 1]]},
        'waypoints': {'id': 'keep', 'name': '지점', 'x': .2, 'y': .2, 'yaw': 0},
        'connectors': {'id': 'keep', 'kind': 'STAIRS', 'pair_floor_id': other, 'x': .2, 'y': .2, 'yaw': 0},
        'edits': {'id': 'keep', 'op': 'WALL', 'polyline': [[0, 0], [1, 1]], 'width': .1},
    }
    before = {kind: [copy.deepcopy(item), {**copy.deepcopy(item), 'id': 'removed'}] for kind, item in examples.items()}
    after = {kind: [copy.deepcopy(item), {**copy.deepcopy(item), 'id': 'added'}] for kind, item in examples.items()}
    after['zones'][0]['type'] = 'SLOW'
    after['waypoints'][0]['name'] = '바뀐 지점'
    after['connectors'][0]['yaw'] = 1
    after['edits'][0]['width'] = .2
    image = upload(http, headers)
    first = save(http, headers, floor, image, features=before).json()
    changed_image = upload(http, headers, image=PGM[:-1] + b'\xff')
    response = save(http, headers, floor, changed_image, base=first['id'], features=after)
    assert response.status_code == 201, response.text
    second = response.json()
    response = http.get(P + f'/map-versions/{second["id"]}/diff', headers=headers)
    assert response.status_code == 200, response.text
    diff = C.MapDiff.model_validate(response.json())
    assert diff.against is not None
    assert str(diff.version.id) == second['id'] and str(diff.against.id) == first['id']
    assert diff.image_changed is True
    for kind in examples:
        changes = {c.key: c for c in diff.changes if c.kind == kind}
        assert set(changes) == {'id:keep', 'id:removed', 'id:added'}
        assert changes['id:keep'].change == 'changed'
        assert changes['id:keep'].before.model_dump(mode='json', exclude_none=True) == before[kind][0]
        assert changes['id:keep'].after.model_dump(mode='json', exclude_none=True) == after[kind][0]
        assert changes['id:removed'].change == 'removed' and changes['id:removed'].after is None
        assert changes['id:added'].change == 'added' and changes['id:added'].before is None
    explicit = http.get(P + f'/map-versions/{second["id"]}/diff?against={first["id"]}', headers=headers)
    assert explicit.json() == response.json()
    equal = http.get(P + f'/map-versions/{second["id"]}/diff?against={second["id"]}', headers=headers).json()
    assert equal['changes'] == [] and equal['image_changed'] is False
    initial = http.get(P + f'/map-versions/{first["id"]}/diff', headers=headers).json()
    assert initial['against'] is None and initial['image_changed'] is True
    assert len(initial['changes']) == 8 and all(c['change'] == 'added' for c in initial['changes'])


def test_legacy_edits_keys_stable_under_reorder_and_duplicates(maps):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers)
    a = {'op': 'WALL', 'polyline': [[0, 0], [1, 1]], 'width': .1}
    b = {**a, 'op': 'ERASE'}
    first = save(http, headers, floor, image, features={**FEATURES, 'edits': [a, a, b]}).json()
    second = save(http, headers, floor, image, base=first['id'], features={**FEATURES, 'edits': [b, a, a]}).json()
    result = http.get(P + f'/map-versions/{second["id"]}/diff', headers=headers).json()
    assert result['image_changed'] is False
    changes = result['changes']
    assert len(changes) == 3 and all(c['change'] == 'changed' for c in changes)
    assert {(c['before_index'], c['after_index']) for c in changes} == {(0, 1), (1, 2), (2, 0)}
    assert all(c['before'] == c['after'] for c in changes)
    initial = http.get(P + f'/map-versions/{first["id"]}/diff', headers=headers).json()['changes']
    assert len(initial) == len({c['key'] for c in initial}) == 3
    assert all(c['key'].startswith('sha256:') for c in initial)
    duplicate = save(http, headers, floor, image, base=second['id'], features={**FEATURES, 'edits': [{**a, 'id': 'same'}, {**b, 'id': 'same'}]})
    assert duplicate.status_code == 422


def test_diff_rollback_other_floor_foreign_absent_same_404(maps, seeded):
    http, headers, _ = maps
    floor, first, second = pair(maps)
    _, _, other = tree(http, headers)
    third = save(http, headers, other, upload(http, headers)).json()
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with Session(engine) as db:
            foreign_user = db.get(User, seeded['users']['foreign'])
            site = Site(org_id=foreign_user.org_id, name='외부 장소'); db.add(site); db.flush()
            building = Building(org_id=site.org_id, site_id=site.id, name='외부 건물'); db.add(building); db.flush()
            foreign_floor = Floor(org_id=site.org_id, building_id=building.id, name='외부 층', level=1); db.add(foreign_floor); db.flush()
            source = db.get(MapVersion, first['id'])
            up = db.get(Upload, source.upload_id)
            foreign_up = Upload(org_id=site.org_id, image_path=up.image_path, image_sha256=up.image_sha256,
                png_sha256=up.png_sha256, size_bytes=up.size_bytes, width=up.width, height=up.height,
                metadata_json=up.metadata_json, created_by=foreign_user.id)
            db.add(foreign_up); db.flush()
            version = MapVersion(org_id=site.org_id, floor_id=foreign_floor.id, number=1, upload_id=foreign_up.id,
                status='APPROVED', image_path=source.image_path, image_sha256=source.image_sha256, width=4, height=4,
                resolution=.5, origin_x=0, origin_y=0, origin_yaw=0, features=FEATURES, reason='외부', source='IMPORT', created_by=foreign_user.id)
            db.add(version); db.flush(); foreign = str(version.id); db.commit()
        errors = []
        for target in (str(uuid4()), foreign, third['id']):
            response = http.get(P + f'/map-versions/{second["id"]}/diff?against={target}', headers=headers)
            assert response.status_code == 404
            errors.append(response.json())
        assert errors[0] == errors[1] == errors[2]
        for method in ('diff', 'rollback'):
            missing = str(uuid4())
            calls = [http.get(P + f'/map-versions/{v}/diff', headers=headers) if method == 'diff'
                     else rollback(http, headers, v, second['id']) for v in (missing, foreign)]
            assert [r.status_code for r in calls] == [404, 404]
            assert calls[0].json() == calls[1].json() == errors[0]
        assert http.get(P + f'/map-versions/{first["id"]}/diff').status_code == 401
    finally:
        engine.dispose()


def test_rollback_new_immutable_snapshot_stale_current_role_reason_event(maps, seeded):
    http, headers, root = maps
    _, _, floor = tree(http, headers)
    first = save(http, headers, floor, upload(http, headers), features={**FEATURES, 'waypoints': [
        {'id': 'old-point', 'name': '옛 지점', 'x': 1, 'y': 1, 'yaw': 0}]}).json()
    second = save(http, headers, floor, upload(http, headers, image=PGM[:-1] + b'\xff'), base=first['id']).json()
    # Rollback reads the approved snapshot, not the temporary upload file.
    for path in (root / 'uploads').rglob('image.png'):
        path.unlink()
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with Session(engine) as db:
            before = {str(r.id): {c.name: copy.deepcopy(getattr(r, c.name)) for c in MapVersion.__table__.columns}
                      for r in db.scalars(select(MapVersion))}
        stale = rollback(http, headers, first['id'], first['id'])
        assert stale.status_code == 409 and stale.json()['error']['code'] == 'STALE'
        assert stale.json()['error']['detail']['approved_version_id'] == second['id']
        current = rollback(http, headers, second['id'], second['id'])
        assert current.status_code == 409 and current.json()['error']['code'] == 'ALREADY_APPROVED'
        for reason in ('', '   '):
            assert rollback(http, headers, first['id'], second['id'], reason).status_code == 400
        response = rollback(http, headers, first['id'], second['id'])
        assert response.status_code == 201, response.text
        new = response.json()
        assert new['id'] not in before and new['number'] == 3 and new['status'] == 'APPROVED'
        assert new['source'] == 'ROLLBACK' and new['base_version_id'] == second['id'] and new['copied_from_id'] == first['id']
        for key in ('features', 'image_sha256', 'width', 'height', 'resolution', 'origin', 'upload_id'):
            assert new[key] == first[key]
        assert http.get(P + '/sites', headers=headers).json()['items'][0]['buildings'][0]['floors'][0]['approved_version_id'] == new['id']
        assert http.get(P + f'/map-versions/{new["id"]}/image', headers=headers).status_code == 200
        with Session(engine) as db:
            for identifier, original in before.items():
                row = db.get(MapVersion, identifier)
                assert {c.name: getattr(row, c.name) for c in MapVersion.__table__.columns} == original
            events = db.execute(text("SELECT category,data,message FROM events WHERE code='MAP_VERSION_ROLLED_BACK'")).all()
            assert len(events) == 1
            category, data, message = events[0]
            assert category == 'APPROVAL' and data['floor_id'] == floor and data['map_version_id'] == new['id']
            assert data['copied_from_id'] == first['id'] and data['base_version_id'] == second['id']
            assert data['copied_from_number'] == 1
            assert data['reason'] == '옛 판으로 복사 시험' and '1판을 복사한 3판' in message and data['reason'] in message
    finally:
        engine.dispose()


def test_diff_vertex_and_response_budgets(maps, seeded, monkeypatch):
    http, headers, _ = maps
    _, first, second = pair(maps)
    monkeypatch.setattr(M, 'MAX_DIFF_BYTES', 100)
    response = http.get(P + f'/map-versions/{second["id"]}/diff', headers=headers)
    assert response.status_code == 422 and response.json()['error']['code'] == 'DIFF_TOO_LARGE'
    engine = create_engine(seeded['urls']['migrate'])
    try:
        oversized = {**FEATURES, 'edits': [{'op': 'WALL', 'width': .1, 'polyline': [[0, 0], [1, 1]] * 120 + [[0, 0]]} for _ in range(17)]}
        with engine.begin() as conn:
            conn.execute(text('UPDATE map_versions SET features=CAST(:features AS jsonb) WHERE id=:id'),
                {'features': __import__('json').dumps(oversized), 'id': first['id']})
        response = http.get(P + f'/map-versions/{second["id"]}/diff', headers=headers)
        assert response.status_code == 422 and response.json()['error']['code'] == 'INVALID_FEATURES'
        assert rollback(http, headers, first['id'], second['id']).status_code == 422
    finally:
        engine.dispose()


def test_rollback_floor_lock_without_organization_lock(maps, seeded, monkeypatch):
    http, headers, _ = maps
    floor, first, second = pair(maps)
    other = auth(http)
    monkeypatch.setattr(api, 'lock_organization', lambda *args: None)
    waiting, mutex = Event(), Lock()
    count = 0
    def queried(conn, cursor, statement, *args):
        nonlocal count
        if 'FROM floors' in statement and 'floors.id =' in statement:
            with mutex:
                count += 1
                if count == 2:
                    waiting.set()
    engine = create_engine(seeded['urls']['migrate'])
    event.listen(http.app.state.engine, 'before_cursor_execute', queried)
    try:
        with Session(engine) as blocker, ThreadPoolExecutor(max_workers=2) as pool:
            blocker.scalar(select(Floor).where(Floor.id == floor).with_for_update())
            requests = [pool.submit(rollback, http, h, first['id'], second['id']) for h in (headers, other)]
            try:
                assert waiting.wait(3)
            finally:
                blocker.commit()
            try:
                results = [r.result(timeout=5) for r in requests]
            except Exception as exc:
                pytest.fail(f'rollback concurrency raised {type(exc).__name__} instead of 201/STALE409')
        assert sorted(r.status_code for r in results) == [201, 409]
        assert next(r for r in results if r.status_code == 409).json()['error']['code'] == 'STALE'
    finally:
        event.remove(http.app.state.engine, 'before_cursor_execute', queried)
        engine.dispose()


def test_version_upload_id_reuse_preserves_image_and_yaml_settings(maps):
    http, headers, root = maps
    _, _, floor = tree(http, headers)
    yaml = YAML.replace(b'resolution: 0.5', b'resolution: 0.25').replace(b'[0, 0, 0]', b'[5, 8, 0.4]').replace(b'negate: 0', b'negate: 1').replace(b'0.65', b'0.7').replace(b'free_thresh: 0.2', b'free_thresh: 0.3')
    image = upload(http, headers, yaml=yaml)
    first = save(http, headers, floor, image).json()
    detail = http.get(P + f'/map-versions/{first["id"]}', headers=headers).json()
    listing = http.get(P + f'/floors/{floor}/map-versions', headers=headers).json()['items'][0]
    assert detail['upload_id'] == listing['upload_id'] == image
    second = save(http, headers, floor, detail['upload_id'], base=first['id']).json()
    assert second['id'] != first['id'] and second['upload_id'] == image
    assert second['resolution'] == first['resolution'] == .25 and second['origin'] == first['origin'] == [5, 8, .4]
    images = [http.get(P + f'/map-versions/{v["id"]}/image', headers=headers).content for v in (first, second)]
    assert images[0] == images[1] and first['image_sha256'] == second['image_sha256']
    configs = [p.read_text().splitlines()[1:] for p in (root / 'maps' / floor).glob('*.yaml')]
    assert len(configs) == 2 and configs[0] == configs[1]
    assert {'negate: 1', 'occupied_thresh: 0.7', 'free_thresh: 0.3'} <= set(configs[0])


def test_rollback_missing_snapshot_and_event_failure_are_atomic(maps, seeded, monkeypatch):
    from apps.server.fh_server.event_messages import TEMPLATES
    http, headers, root = maps
    floor, first, second = pair(maps)
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with Session(engine) as db:
            path = root / db.get(MapVersion, first['id']).image_path
        png = path.read_bytes()
        path.unlink()
        result = rollback(http, headers, first['id'], second['id'])
        assert result.status_code == 503 and result.json()['error']['code'] == 'FILE_STORAGE_ERROR'
        path.write_bytes(png[:-1] + bytes([png[-1] ^ 1]))
        result = rollback(http, headers, first['id'], second['id'])
        assert result.status_code == 503 and result.json()['error']['code'] == 'FILE_STORAGE_ERROR'
        path.write_bytes(png)
        monkeypatch.delitem(TEMPLATES, 'MAP_VERSION_ROLLED_BACK')
        with pytest.raises(KeyError, match='MAP_VERSION_ROLLED_BACK'):
            rollback(http, headers, first['id'], second['id'])
        with engine.connect() as conn:
            assert conn.scalar(text('SELECT count(*) FROM map_versions')) == 2
            assert str(conn.scalar(text('SELECT approved_version_id FROM floors WHERE id=:id'), {'id': floor})) == second['id']
    finally:
        engine.dispose()


@pytest.mark.parametrize('with_id', [False, True])
def test_diff_edit_paint_order_changes_have_positions(maps, with_id):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers)
    wall = {'op': 'WALL', 'polyline': [[0, 0], [1, 1]], 'width': .1}
    erase = {**wall, 'op': 'ERASE'}
    if with_id:
        wall['id'], erase['id'] = 'wall', 'erase'
    first = save(http, headers, floor, image, features={**FEATURES, 'edits': [wall, erase]}).json()
    second = save(http, headers, floor, image, base=first['id'], features={**FEATURES, 'edits': [erase, wall]}).json()
    response = http.get(P + f'/map-versions/{second["id"]}/diff', headers=headers)
    assert response.status_code == 200
    result = response.json()
    assert result['image_changed'] is False
    changes = result['changes']
    assert len(changes) == 2 and all(c['kind'] == 'edits' and c['change'] == 'changed' for c in changes)
    moved = {c['before']['op']: c for c in changes}
    assert (moved['WALL']['before_index'], moved['WALL']['after_index']) == (0, 1)
    assert (moved['ERASE']['before_index'], moved['ERASE']['after_index']) == (1, 0)
    assert all(c['before'] == c['after'] for c in changes)


def test_rollback_deleted_connector_pair_rejected_with_element(maps, seeded):
    http, headers, _ = maps
    _, building, floor = tree(http, headers)
    pair_floor = http.post(P + f'/buildings/{building}/floors', headers=headers,
        json={'name': '임시 2층', 'level': 2}).json()['id']
    image = upload(http, headers)
    first = save(http, headers, floor, image, features={**FEATURES, 'connectors': [
        {'id': 'stairs', 'kind': 'STAIRS', 'pair_floor_id': pair_floor, 'x': 1, 'y': 1, 'yaw': 0}]}).json()
    second = save(http, headers, floor, image, base=first['id']).json()
    assert http.delete(P + f'/floors/{pair_floor}', headers=headers).status_code == 204
    response = rollback(http, headers, first['id'], second['id'])
    assert response.status_code == 422
    assert response.json()['error']['code'] == 'INVALID_FEATURES'
    assert response.json()['error']['detail']['element'] == 'features.connectors.0.pair_floor_id'
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.connect() as conn:
            assert conn.scalar(text('SELECT count(*) FROM map_versions')) == 2
            assert str(conn.scalar(text('SELECT approved_version_id FROM floors WHERE id=:id'), {'id': floor})) == second['id']
            assert conn.scalar(text("SELECT count(*) FROM events WHERE code='MAP_VERSION_ROLLED_BACK'")) == 0
    finally:
        engine.dispose()


@pytest.mark.parametrize('status', ['PENDING', 'REJECTED', 'SUPERSEDED'])
def test_rollback_requires_previously_approved_snapshot(maps, seeded, status):
    http, headers, _ = maps
    floor, first, second = pair(maps)
    engine = create_engine(seeded['urls']['migrate'])
    try:
        # Only the migration account can synthesize a future S4 non-approved row.
        with engine.begin() as conn:
            conn.execute(text('UPDATE map_versions SET status=:status WHERE id=:id'), {'id': first['id'], 'status': status})
        response = rollback(http, headers, first['id'], second['id'])
        assert response.status_code == 409 and response.json()['error']['code'] == 'ROLLBACK_NOT_APPROVED'
        with engine.connect() as conn:
            assert conn.scalar(text('SELECT count(*) FROM map_versions')) == 2
            assert str(conn.scalar(text('SELECT approved_version_id FROM floors WHERE id=:id'), {'id': floor})) == second['id']
            assert conn.scalar(text("SELECT count(*) FROM events WHERE code='MAP_VERSION_ROLLED_BACK'")) == 0
    finally:
        engine.dispose()


def test_diff_accepts_two_maximum_stored_feature_snapshots(maps):
    http, headers, _ = maps
    _, building, floor = tree(http, headers)
    pair_floor = http.post(P + f'/buildings/{building}/floors', headers=headers,
        json={'name': '상한 시험 층', 'level': 2}).json()['id']
    identifier = lambda kind, n: f'{kind}{n:04d}'.ljust(128, '\x01')
    name = '\x01' * 127 + '가'
    features = {
        'zones': [{'id': identifier('z', n), 'name': name, 'type': 'NO_GO',
                   'polygon': [[0, 0], [1, 0], [1, 1]]} for n in range(256)],
        'waypoints': [{'id': identifier('w', n), 'name': name, 'x': 1, 'y': 1, 'yaw': 0} for n in range(1000)],
        'connectors': [{'id': identifier('c', n), 'kind': 'STAIRS', 'pair_floor_id': pair_floor,
                        'x': 1, 'y': 1, 'yaw': 0} for n in range(256)],
        'edits': [{'id': identifier('e', n), 'op': 'WALL', 'polyline': [[0, 0], [1, 1]], 'width': .1} for n in range(256)],
    }
    for edit in features['edits'][:6]:
        edit['polyline'] = [[0, 0], [1, 1]] * 128
    features['edits'][6]['polyline'] = [[0, 0], [1, 1]] * 19
    vertices = sum(len(z['polygon']) for z in features['zones']) + sum(len(e['polyline']) for e in features['edits']) + len(features['waypoints']) + len(features['connectors'])
    assert vertices == 4096
    image = upload(http, headers)
    response = save(http, headers, floor, image, features=features)
    assert response.status_code == 201, response.text[:200]
    first = response.json()
    changed = copy.deepcopy(features)
    for group in ('zones', 'waypoints'):
        for item in changed[group]:
            item['name'] = '\x01' * 127 + '나'
    for item in changed['connectors']:
        item['yaw'] = 1
    for item in changed['edits']:
        item['width'] = .2
    response = save(http, headers, floor, image, base=first['id'], features=changed)
    assert response.status_code == 201, response.text[:200]
    second = response.json()
    response = http.get(P + f'/map-versions/{second["id"]}/diff', headers=headers)
    assert response.status_code == 200, response.text[:200]
    result = response.json()
    assert len(result['changes']) == 1768 and all(c['change'] == 'changed' for c in result['changes'])
    assert 2 * 1024 * 1024 < len(response.content) < M.MAX_DIFF_BYTES
    # Conservative bound includes four payload copies, escaped keys and indices.
    worst_case_bound = 4 * (1768 * (2 * 128 * 6 + 1536) + 4096 * 3 * 32) + 128 * 1024
    assert M.MAX_DIFF_BYTES > worst_case_bound

"""S3a acceptance: synthetic maps only, temporary file storage and restricted DB."""
import copy
import hashlib
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.map_files import MAX_IMAGE, MAX_YAML, PNG_MAGIC, gray_png
from apps.server.fh_server.models import Building, Floor, MapVersion, Site, Upload, User

P = '/api/v1'
PGM = b'P5\n# synthetic test only\n4 4\n255\n' + bytes(range(16))
YAML = b'image: synthetic.pgm\nresolution: 0.5\norigin: [0, 0, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.2\n'
FEATURES = {'zones': [], 'waypoints': [], 'connectors': [], 'edits': []}


def auth(http, name='admin'):
    response = http.post(P + '/auth/login', json={'username': name, 'password': 'fake-test-password', 'client': 'app'})
    assert response.status_code == 200, response.text
    return {'authorization': 'Bearer ' + response.json()['access_token']}


@pytest.fixture
def maps(seeded, tmp_path):
    app = create_app(Settings(seeded['urls']['app'], seeded['org'], files_root=str(tmp_path / 'files')))
    with TestClient(app, base_url='https://testserver') as http:
        headers = auth(http)
        yield http, headers, tmp_path / 'files'
    app.state.engine.dispose()


def tree(http, headers):
    site = http.post(P + '/sites', headers=headers, json={'name': '시험 장소'})
    assert site.status_code == 201, site.text
    building = http.post(P + f'/sites/{site.json()["id"]}/buildings', headers=headers, json={'name': '시험 건물'})
    assert building.status_code == 201, building.text
    floor = http.post(P + f'/buildings/{building.json()["id"]}/floors', headers=headers, json={'name': '1층', 'level': 1})
    assert floor.status_code == 201, floor.text
    return site.json()['id'], building.json()['id'], floor.json()['id']


def upload(http, headers, *, image=PGM, kind='image/x-portable-graymap', yaml=YAML):
    response = http.post(P + '/uploads', headers={**headers, 'content-type': kind}, content=image)
    assert response.status_code == 201, response.text
    assert response.json()['sha256'] == hashlib.sha256(image).hexdigest()
    response = http.post(P + '/uploads', params={'image': response.json()['upload_id']},
        headers={**headers, 'content-type': 'text/yaml'}, content=yaml)
    assert response.status_code == 201, response.text
    return response.json()['upload_id']


def save(http, headers, floor, upload_id, *, base=None, features=None):
    return http.post(P + f'/floors/{floor}/map-versions', headers=headers,
        json={'base_version_id': base, 'image': upload_id, 'features': features or copy.deepcopy(FEATURES), 'reason': '합성 지도 시험'})


def test_admin_approval_stale_immutable_png_and_delete_guards(maps, seeded):
    http, headers, root = maps
    site, building, floor = tree(http, headers)
    image = upload(http, headers)
    first = save(http, headers, floor, image)
    assert first.status_code == 201, first.text
    first = first.json()
    assert first['status'] == 'APPROVED' and first['number'] == 1 and first['created_by'] == str(seeded['users']['admin'])
    assert first['features'] == FEATURES
    listed = http.get(P + '/sites', headers=headers).json()['items'][0]['buildings'][0]['floors'][0]
    assert listed['approved_version_id'] == first['id'] and listed['pending_count'] == 0
    response = http.get(P + f'/map-versions/{first["id"]}/image', headers=headers)
    assert response.status_code == 200 and response.headers['content-type'] == 'image/png'
    assert response.content.startswith(PNG_MAGIC)
    assert hashlib.sha256(response.content).hexdigest() == first['image_sha256']
    stale = save(http, headers, floor, image)
    assert stale.status_code == 409 and stale.json()['error']['code'] == 'STALE'
    assert stale.json()['error']['detail']['approved_version_id'] == first['id']
    second = save(http, headers, floor, image, base=first['id'])
    assert second.status_code == 201 and second.json()['number'] == 2
    listing = http.get(P + f'/floors/{floor}/map-versions?limit=1', headers=headers).json()
    assert listing['items'][0]['id'] == second.json()['id'] and listing['next_cursor'] == '2'
    assert http.get(P + f'/floors/{floor}/map-versions?cursor=2', headers=headers).json()['items'][0]['status'] == 'SUPERSEDED'
    old = http.get(P + f'/map-versions/{first["id"]}', headers=headers).json()
    assert old['status'] == 'SUPERSEDED' and old['image_sha256'] == first['image_sha256']
    for method in ('patch', 'put', 'delete'):
        assert getattr(http, method)(P + f'/map-versions/{first["id"]}', headers=headers).status_code == 405
    for path in (f'/sites/{site}', f'/buildings/{building}', f'/floors/{floor}'):
        response = http.delete(P + path, headers=headers)
        assert response.status_code == 409 and response.json()['error']['code'] == 'RESOURCE_IN_USE'
    engine = create_engine(seeded['urls']['app'])
    try:
        with Session(engine) as db:
            assert db.get(MapVersion, first['id']).status == 'APPROVED'  # stored snapshot never changes
            assert str(db.get(Floor, floor).approved_version_id) == second.json()['id']
        for verb in ('UPDATE map_versions SET reason=reason', 'DELETE FROM map_versions', 'TRUNCATE map_versions'):
            with engine.connect() as connection, pytest.raises(DBAPIError):
                connection.execute(text(verb))
        with engine.connect() as connection:
            events = connection.execute(text("SELECT code, message, category FROM events WHERE code LIKE '%CREATED' OR code='MAP_VERSION_APPROVED'")).all()
            assert {row.code for row in events} >= {'SITE_CREATED', 'BUILDING_CREATED', 'FLOOR_CREATED', 'MAP_VERSION_APPROVED'}
            assert all('admin' in row.message for row in events)
            assert {row.category for row in events if row.code == 'MAP_VERSION_APPROVED'} == {'APPROVAL'}
    finally:
        engine.dispose()
    assert len(list(root.glob('maps/*/*.png'))) == len(list(root.glob('maps/*/*.yaml'))) == 2


def test_operator_upload_pending_save_and_crud_denied(maps):
    http, admin, _ = maps
    _, building, floor = tree(http, admin)
    operator = auth(http, 'one')
    image = upload(http, operator)
    result = save(http, operator, floor, image)
    assert result.status_code == 201 and result.json()['status'] == 'PENDING'
    for path, payload in [('/sites', {'name': '금지'}), (f'/buildings/{building}/floors', {'name': '층', 'level': 2})]:
        assert http.post(P + path, headers=operator, json=payload).status_code == 403
    assert http.patch(P + f'/floors/{floor}', headers=operator, json={'name': '금지'}).status_code == 403
    assert http.delete(P + f'/floors/{floor}', headers=operator).status_code == 403
    version = save(http, admin, floor, image)
    assert version.status_code == 201
    assert http.get(P + '/sites', headers=operator).status_code == 200
    assert http.get(P + f'/map-versions/{version.json()["id"]}/image', headers=operator).status_code == 200
    assert http.get(P + '/sites').status_code == 401


def test_foreign_and_absent_ids_same_404(maps, seeded):
    http, headers, _ = maps
    _, _, local = tree(http, headers)
    local_upload = upload(http, headers)
    engine = create_engine(seeded['urls']['migrate'])
    with Session(engine) as db:
        foreign_user = db.get(User, seeded['users']['foreign'])
        site = Site(org_id=foreign_user.org_id, name='다른 조직 비밀')
        db.add(site); db.flush()
        building = Building(org_id=site.org_id, site_id=site.id, name='비밀 건물')
        db.add(building); db.flush()
        floor = Floor(org_id=site.org_id, building_id=building.id, name='비밀 층', level=9)
        db.add(floor); db.flush()
        original = db.get(Upload, local_upload)
        up = Upload(org_id=site.org_id, created_by=foreign_user.id, image_path=original.image_path,
            image_sha256=original.image_sha256, png_sha256=original.png_sha256, size_bytes=original.size_bytes,
            width=original.width, height=original.height, metadata_json=original.metadata_json)
        db.add(up); db.flush()
        version = MapVersion(org_id=site.org_id, floor_id=floor.id, number=1, base_version_id=None,
            upload_id=up.id, status='APPROVED', image_path=original.image_path, image_sha256=original.png_sha256,
            width=4, height=4, resolution=.5, origin_x=0, origin_y=0, origin_yaw=0, features=FEATURES,
            reason='비밀', source='IMPORT', created_by=foreign_user.id)
        db.add(version); db.flush()
        foreign = dict(site=str(site.id), building=str(building.id), floor=str(floor.id), version=str(version.id), upload=str(up.id))
        db.commit()
    engine.dispose()
    missing = str(uuid4())
    calls = [
        ('get', '/floors/{}/map-versions', 'floor', {}),
        ('get', '/map-versions/{}', 'version', {}),
        ('get', '/map-versions/{}/image', 'version', {}),
        ('get', '/floor-connectors?building_id={}', 'building', {}),
        ('patch', '/sites/{}', 'site', {'json': {'name': '금지'}}),
        ('delete', '/buildings/{}', 'building', {}),
        ('delete', '/floors/{}', 'floor', {}),
        ('post', '/sites/{}/buildings', 'site', {'json': {'name': '금지'}}),
        ('post', '/buildings/{}/floors', 'building', {'json': {'name': '금지', 'level': 1}}),
    ]
    for method, path, key, kwargs in calls:
        absent = getattr(http, method)(P + path.format(missing), headers=headers, **kwargs)
        outside = getattr(http, method)(P + path.format(foreign[key]), headers=headers, **kwargs)
        assert absent.status_code == outside.status_code == 404, (path, outside.text)
        assert absent.json() == outside.json()
    assert save(http, headers, foreign['floor'], local_upload).status_code == 404
    assert save(http, headers, local, foreign['upload']).status_code == 404
    assert http.post(P + '/uploads?image=' + foreign['upload'], headers={**headers, 'content-type': 'text/yaml'}, content=YAML).status_code == 404
    assert len(http.get(P + '/sites', headers=headers).json()['items']) == 1


def test_rename_delete_events_and_floor_reference_guard(maps, seeded):
    http, headers, _ = maps
    site, building, floor = tree(http, headers)
    for path, body in [(f'/sites/{site}', {'name': '바뀐 장소'}), (f'/buildings/{building}', {'name': '바뀐 건물'}),
                       (f'/floors/{floor}', {'name': '지하층', 'level': -1})]:
        result = http.patch(P + path, headers=headers, json=body)
        assert result.status_code == 200
        assert all(result.json()[key] == value for key, value in body.items())
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.begin() as conn:
            conn.execute(text('UPDATE robots SET last_floor_id=:floor WHERE id=:robot'), {'floor': floor, 'robot': seeded['robots']['mine']})
        assert http.delete(P + f'/floors/{floor}', headers=headers).status_code == 409
        with engine.begin() as conn:
            conn.execute(text('UPDATE robots SET last_floor_id=NULL WHERE id=:robot'), {'robot': seeded['robots']['mine']})
        for path in (f'/floors/{floor}', f'/buildings/{building}', f'/sites/{site}'):
            assert http.delete(P + path, headers=headers).status_code == 204
        with engine.connect() as conn:
            codes = set(conn.scalars(text('SELECT code FROM events')))
            assert {f'{kind}_{verb}' for kind in ('SITE', 'BUILDING', 'FLOOR') for verb in ('CREATED', 'UPDATED', 'DELETED')} <= codes
    finally:
        engine.dispose()


@pytest.mark.parametrize('body,kind', [
    (b'not png', 'image/png'), (b'P5\n99999 2\n255\n', 'image/x-portable-graymap'),
    (b'P5\n2 2\n255\n\x00', 'image/x-portable-graymap'), (b'P2\n1 1\n255\n999', 'image/x-portable-graymap'),
    (b'GIF89a', 'image/png'), (b'abc', 'image/jpeg'),
])
def test_upload_magic_dimensions_and_pixel_rejection(maps, body, kind):
    http, headers, _ = maps
    response = http.post(P + '/uploads', headers={**headers, 'content-type': kind}, content=body)
    assert response.status_code == 422 and response.json()['error']['code'] == 'INVALID_UPLOAD'


def test_upload_content_length_and_chunked_limits(maps):
    http, headers, _ = maps
    for kind, limit in [('image/png', MAX_IMAGE), ('text/yaml', MAX_YAML)]:
        response = http.post(P + '/uploads', headers={**headers, 'content-type': kind, 'content-length': str(limit + 1)}, content=b'x')
        assert response.status_code == 413 and response.json()['error']['code'] == 'UPLOAD_TOO_LARGE'
        # No Content-Length: Starlette receives the stream, not a multipart buffer.
        response = http.post(P + '/uploads', headers={**headers, 'content-type': kind}, content=iter([b'x' * (limit + 1)]))
        assert response.status_code == 413
    assert http.post(P + '/uploads', headers={**headers, 'content-type': 'image/png', 'content-length': 'x'}, content=b'x').status_code == 422


@pytest.mark.parametrize('bad_yaml', [
    b'resolution: 1\n', YAML + b'unknown: 1\n', YAML + b'resolution: 1\n', YAML.replace(b'[0, 0, 0]', b'[0, 0]'),
    YAML.replace(b'0.5', b'.nan'), YAML.replace(b'0.5', b'0'), YAML.replace(b'negate: 0', b'negate: 2'),
    YAML.replace(b'0.2', b'0.9'), YAML + b'---\n', YAML + b'---\nfoo: bar\n', YAML.replace(b'0.5', b'&x 1'),
    YAML.replace(b'0.5', b'*x'), YAML.replace(b'0.5', b'!!float 1'), YAML + b'  nested: 1\n',
    YAML.replace(b'synthetic.pgm', b'../../secret.pgm'), YAML + b'mode: anything\n',
])
def test_strict_yaml_rejects_unsupported_or_invalid_forms(maps, bad_yaml):
    http, headers, _ = maps
    original = http.post(P + '/uploads', headers={**headers, 'content-type': 'image/x-portable-graymap'}, content=PGM).json()['upload_id']
    response = http.post(P + '/uploads?image=' + original, headers={**headers, 'content-type': 'application/x-yaml'}, content=bad_yaml)
    assert response.status_code == 422 and response.json()['error']['code'] == 'INVALID_UPLOAD'


@pytest.mark.parametrize('feature', [
    {'zones': [{'id': 'z', 'type': 'NO_GO', 'name': '구역', 'polygon': [[0, 0], [1, 1]]}]},
    {'zones': [{'id': 'z', 'type': 'WRONG', 'name': '구역', 'polygon': [[0, 0], [1, 0], [1, 1]]}]},
    {'zones': [{'id': 'z', 'type': 'NO_GO', 'name': '구역', 'polygon': [[0, 0], [1, 1], [0, 1], [1, 0]]}]},
    {'zones': [{'id': 'z', 'type': 'NO_GO', 'name': '구역', 'polygon': [[0, 0], [1, 0], [9, 1]]}]},
    {'zones': [{'id': 'z', 'type': 'NO_GO', 'name': '구역', 'polygon': [[0, 0], [2, 1], [0, 2], [1.5, .2]]}]},
    {'zones': [{'id': 'z', 'type': 'NO_GO', 'name': '구역', 'polygon': [[0, 0], [.5, .5], [1, 1]]}]},
    {'waypoints': [{'id': 'w', 'name': '지점', 'x': 3, 'y': 0, 'yaw': 0}]},
    {'waypoints': [{'id': 'w', 'name': '', 'x': 0, 'y': 0, 'yaw': 0}]},
    {'waypoints': [{'id': 'w', 'name': '   ', 'x': 0, 'y': 0, 'yaw': 0}]},
    {'waypoints': [{'id': 'w', 'name': '지점', 'x': 0, 'y': 0, 'yaw': 'Infinity'}]},
    {'connectors': [{'id': 'c', 'kind': 'STAIRS', 'pair_floor_id': str(uuid4()), 'x': 0, 'y': 0, 'yaw': 0}]},
    {'edits': [{'op': 'WRONG', 'polyline': [[0, 0], [1, 1]], 'width': .1}]},
    {'edits': [{'op': 'WALL', 'polyline': [[0, 0], [9, 1]], 'width': .1}]},
    {'edits': [{'op': 'ERASE', 'polyline': [[0, 0], [1, 1]], 'width': 0}]},
])
def test_invalid_feature_reports_element_422(maps, feature):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers)
    response = save(http, headers, floor, image, features={**copy.deepcopy(FEATURES), **feature})
    assert response.status_code == 422, response.text
    error = response.json()['error']
    assert error['code'] == 'INVALID_FEATURES'
    assert next(iter(feature)) in str(error['detail'])
    assert http.get(P + f'/floors/{floor}/map-versions', headers=headers).json()['items'] == []


def test_features_rotated_bounds_and_connector_projection(maps):
    http, headers, _ = maps
    _, building, a = tree(http, headers)
    b = http.post(P + f'/buildings/{building}/floors', headers=headers, json={'name': '2층', 'level': 2}).json()['id']
    _, _, outside = tree(http, headers)
    image = upload(http, headers)
    features = copy.deepcopy(FEATURES)
    features['zones'] = [{'id': 'z', 'type': 'SLOW', 'name': '감속', 'polygon': [[0, 0], [1, 0], [1, 1]]}]
    features['waypoints'] = [{'id': 'w', 'name': '지점', 'x': 1, 'y': 1, 'yaw': 3.14}]
    features['edits'] = [{'op': 'WALL', 'polyline': [[0, 0], [1, 1]], 'width': .1}]
    features['connectors'] = [{'id': 'stairs', 'kind': 'STAIRS', 'pair_floor_id': outside, 'x': 1, 'y': 1, 'yaw': 0}]
    assert save(http, headers, a, image, features=features).status_code == 422
    features['connectors'][0]['pair_floor_id'] = a
    assert save(http, headers, a, image, features=features).status_code == 422
    features['connectors'][0]['pair_floor_id'] = b
    va = save(http, headers, a, image, features=features)
    assert va.status_code == 201 and va.json()['features'] == features
    connectors = http.get(P + '/floor-connectors?building_id=' + building, headers=headers).json()['items']
    assert len(connectors) == 1 and connectors[0]['active'] is False and connectors[0]['b_pose'] is None
    connector_id = connectors[0]['id']
    other = copy.deepcopy(features)
    other['connectors'][0]['pair_floor_id'] = a
    vb = save(http, headers, b, image, features=other)
    assert vb.status_code == 201
    connectors = http.get(P + '/floor-connectors?building_id=' + building, headers=headers).json()['items']
    assert len(connectors) == 1 and connectors[0]['active'] is True
    assert connectors[0]['id'] == connector_id
    assert {connectors[0]['map_version_a_id'], connectors[0]['map_version_b_id']} == {va.json()['id'], vb.json()['id']}
    assert save(http, headers, b, image, base=vb.json()['id']).status_code == 201
    assert not http.get(P + '/floor-connectors?building_id=' + building, headers=headers).json()['items'][0]['active']
    rotated = upload(http, headers, yaml=YAML.replace(b'[0, 0, 0]', b'[10, 20, 1.5707963267948966]'))
    f = {'waypoints': [{'id': 'rotated', 'name': '회전', 'x': 9, 'y': 21, 'yaw': 0}]}
    assert save(http, headers, a, rotated, base=va.json()['id'], features={**FEATURES, **f}).status_code == 201


def test_incomplete_upload_and_png_corruption_rejected(maps):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    png = gray_png(2, 2, b'\x00\x80\xff\x7f')
    image = upload(http, headers, image=png, kind='image/png')
    result = save(http, headers, floor, image)
    assert result.status_code == 201
    assert http.get(P + f'/map-versions/{result.json()["id"]}/image', headers=headers).content == png
    raw = http.post(P + '/uploads', headers={**headers, 'content-type': 'image/png'}, content=png).json()['upload_id']
    assert save(http, headers, floor, raw, base=result.json()['id']).status_code == 422
    corrupt = png[:-1] + bytes([png[-1] ^ 1])
    assert http.post(P + '/uploads', headers={**headers, 'content-type': 'image/png'}, content=corrupt).status_code == 422


def test_map_template_registry_remains_closed():
    import ast
    from apps.server.fh_server.event_messages import TEMPLATES
    source = Path(__file__).resolve().parents[1] / 'fh_server/maps.py'
    codes = set()
    for node in ast.walk(ast.parse(source.read_text())):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'record':
            if isinstance(node.args[2], ast.Constant):
                codes.add(node.args[2].value)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'mutable_routes':
            prefix = node.args[-1].value
            codes |= {prefix + '_UPDATED', prefix + '_DELETED'}
    assert codes <= TEMPLATES.keys()


def test_map_db_immutable_grants(seeded):
    engine = create_engine(seeded['urls']['app'])
    try:
        with engine.connect() as conn:
            assert conn.scalar(text("SELECT has_table_privilege(current_user, 'map_versions', 'SELECT')"))
            assert conn.scalar(text("SELECT has_table_privilege(current_user, 'map_versions', 'INSERT')"))
            for privilege in ('UPDATE', 'DELETE', 'TRUNCATE'):
                assert not conn.scalar(text("SELECT has_table_privilege(current_user, 'map_versions', :privilege)"), {'privilege': privilege})
    finally:
        engine.dispose()


def test_concurrent_saves_one_approval_one_stale(maps):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers)
    barrier = Barrier(2)
    def request():
        barrier.wait(timeout=5)
        return save(http, headers, floor, image)
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: request(), range(2)))
    assert sorted(response.status_code for response in responses) == [201, 409]
    versions = http.get(P + f'/floors/{floor}/map-versions', headers=headers).json()['items']
    assert len(versions) == 1 and versions[0]['status'] == 'APPROVED'


def test_feature_error_does_not_echo_unknown_input_key(maps):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers)
    features = {**FEATURES, 'private-input-key': 'secret value'}
    response = save(http, headers, floor, image, features=features)
    assert response.status_code == 422
    assert 'private-input-key' not in response.text and 'secret value' not in response.text
    assert response.json()['error']['detail']['elements'] == ['features.?']

"""Terrain library, immutable generated maps, and browser-raster parity."""
import base64
import copy
import json
from pathlib import Path
import subprocess

import pytest
from sqlalchemy import create_engine, event, text

from apps.contracts.models import TerrainSpec
from apps.contracts.tests.test_terrain import SPEC
from apps.server.fh_server.map_files import gray_pixels
from apps.server.fh_server.terrains import terrain_grid
from .test_maps import maps, auth, P, save, tree  # noqa: F401


def put(http, headers, spec=SPEC, version=0):
    return http.put(P + '/terrains/' + spec['id'], headers=headers,
                    json={'spec': spec, 'base_version': version})


@pytest.mark.parametrize('size', [[8, 6], [7.13, 5.27], [30, 30]])
def test_grid_exactly_matches_browser_build_terrain(size):
    spec = {**SPEC, 'size': size, 'items': [SPEC['items'][0],
        {'kind': 'stairs', 'x': 0, 'y': 1.5, 'yaw': -.7, 'width': .5, 'steps': 3, 'rise': .1, 'run': .15},
        {'kind': 'gap', 'x': 1, 'y': -1, 'yaw': .32, 'length': .01, 'width': 1},
        {'kind': 'ramp', 'x': -1, 'y': -1, 'yaw': .8, 'length': 1.5, 'width': .5, 'h': .3}]}
    browser = subprocess.run(['node', '--input-type=module', '-e',
        "import {buildTerrain} from './mobile/sim/terrain/index.js'; let s=''; for await (const p of process.stdin) s+=p; console.log(JSON.stringify(buildTerrain(JSON.parse(s)).map));"],
        input=json.dumps(spec), text=True, capture_output=True, check=True, cwd=Path(__file__).resolve().parents[3])
    built = json.loads(browser.stdout)
    w, h, origin, pixels = terrain_grid(TerrainSpec.model_validate(spec))
    assert (w, h, origin, .05) == (built['w'], built['h'], built['origin'], built['res'])
    assert pixels == base64.b64decode(built['px'])


def test_save_generates_map_revisions_and_scenario_floor(maps):
    http, headers, root = maps
    first = put(http, headers)
    assert first.status_code == 200, first.text
    first = first.json()
    assert first['version'] == 1 and first['spec'] == SPEC
    tree = http.get(P + '/sites', headers=headers).json()['items']
    assert len(tree) == 1 and tree[0]['name'] == '시뮬 지형'
    assert tree[0]['purpose'] == 'SIM'
    building = tree[0]['buildings'][0]
    assert building['name'] == SPEC['name']
    floor = building['floors'][0]
    assert floor['name'] == '1층' and floor['level'] == 1
    assert floor['terrain_id'] == SPEC['id'] and floor['provenance'] == 'SIMULATION'
    assert floor['id'] == first['floor_id'] and floor['approved_version_id'] == first['map_version_id']
    version = http.get(P + '/map-versions/' + first['map_version_id'], headers=headers).json()
    assert version['terrain_spec'] == SPEC
    assert (version['width'], version['height'], version['resolution'], version['origin']) == (160, 120, .05, [-4, -3, 0])
    image = http.get(P + '/map-versions/' + first['map_version_id'] + '/image', headers=headers).content
    assert gray_pixels(image) == (160, 120, terrain_grid(TerrainSpec.model_validate(SPEC))[3])
    # Ordinary scenario authoring can use the generated approved floor/map.
    body = {'name': '합성 시나리오', 'waypoints': [
        {'floor_id': floor['id'], 'map_version_id': version['id'], 'x': -3, 'y': 0, 'yaw': 0,
         'mission_id': None, 'mission_version': None},
        {'floor_id': floor['id'], 'map_version_id': version['id'], 'x': -2, 'y': 0, 'yaw': 0,
         'mission_id': None, 'mission_version': None}], 'finish': {'mode': 'RETURN_TO_START'}, 'notes': ''}
    mission = http.post(P + '/missions', headers=headers, json={'name': '기다리기', 'steps': [{'action': 'WAIT', 'params': {'seconds': 1}}]}).json()
    for point in body['waypoints']:
        point.update(mission_id=mission['id'], mission_version=1)
    scenario = http.post(P + '/scenarios', headers=headers, json=body)
    assert scenario.status_code == 201, scenario.text
    second = put(http, headers, {**SPEC, 'name': '이름 변경'}, 1)
    assert second.status_code == 200, second.text
    second = second.json()
    assert second['floor_id'] == floor['id'] and second['map_version_id'] != version['id']
    assert second['version'] == 2
    old = http.get(P + '/map-versions/' + version['id'], headers=headers).json()
    assert old['status'] == 'SUPERSEDED' and old['image_sha256'] == version['image_sha256']
    assert old['terrain_spec'] == SPEC
    listing = http.get(P + '/floors/' + floor['id'] + '/map-versions', headers=headers).json()['items']
    assert [v['number'] for v in listing] == [2, 1]
    assert listing[1] == old
    assert listing[0] == http.get(P + '/map-versions/' + second['map_version_id'], headers=headers).json()
    assert listing[0]['terrain_spec'] == second['spec']
    diff = http.get(P + '/map-versions/' + second['map_version_id'] + '/diff', headers=headers).json()
    assert diff['version'] == listing[0] and diff['against'] == old
    assert len(list(root.glob('maps/*/*.png'))) == len(list(root.glob('maps/*/*.yaml'))) == 2
    # Lost or stale responses cannot silently create another map revision.
    assert put(http, headers, version=1).status_code == 409


def test_terrain_listing_batches_uploads_and_preserves_all_shapes(maps):
    http, headers, _ = maps
    spec = {**SPEC, 'items': [SPEC['items'][0],
        {'kind': 'stairs', 'x': 0, 'y': 1.5, 'yaw': -.7, 'width': .5, 'steps': 3, 'rise': .1, 'run': .15},
        {'kind': 'gap', 'x': 1, 'y': -1, 'yaw': .32, 'length': .01, 'width': 1},
        {'kind': 'ramp', 'x': -1, 'y': -1, 'yaw': .8, 'length': 1.5, 'width': .5, 'h': .3}]}
    for revision in range(4):
        result = put(http, headers, {**spec, 'name': f'지형 {revision}'}, revision)
        assert result.status_code == 200, result.text
    floor_id = result.json()['floor_id']
    queries = []
    def capture(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT') and 'uploads' in statement:
            queries.append(statement)
    event.listen(http.app.state.engine, 'before_cursor_execute', capture)
    try:
        listing = http.get(P + '/floors/' + floor_id + '/map-versions', headers=headers)
        assert listing.status_code == 200, listing.text
    finally:
        event.remove(http.app.state.engine, 'before_cursor_execute', capture)
    assert len(queries) == 1  # Four distinct uploads still require one read.
    for revision, version in zip(range(3, -1, -1), listing.json()['items'], strict=True):
        assert version['terrain_spec'] == {**spec, 'name': f'지형 {revision}'}
        assert version == http.get(P + '/map-versions/' + version['id'], headers=headers).json()
    first_page = http.get(P + f'/floors/{floor_id}/map-versions?limit=2', headers=headers).json()
    second_page = http.get(P + f'/floors/{floor_id}/map-versions?limit=2&cursor=' + first_page['next_cursor'], headers=headers).json()
    assert first_page['items'] + second_page['items'] == listing.json()['items']
    assert second_page['next_cursor'] is None


def test_terrain_upload_is_preserved_by_edit_rollback_and_idempotent_replay(maps):
    http, headers, _ = maps
    generated = put(http, headers).json()
    original = http.get(P + '/map-versions/' + generated['map_version_id'], headers=headers).json()
    # SIM places still reject direct map edits. Exercise the existing upload
    # reuse path on an editable REAL floor without changing those write rules.
    assert save(http, headers, generated['floor_id'], original['upload_id'], base=original['id']).status_code == 409
    _, _, floor_id = tree(http, headers)
    first = save(http, headers, floor_id, original['upload_id']).json()
    edit_headers = {**headers, 'Idempotency-Key': 'terrain-map-edit'}
    edited_response = save(http, edit_headers, floor_id, original['upload_id'], base=first['id'])
    assert edited_response.status_code == 201, edited_response.text
    edited = edited_response.json()
    assert edited['source'] == 'EDIT' and edited['terrain_spec'] == SPEC
    assert save(http, edit_headers, floor_id, original['upload_id'], base=first['id']).json() == edited
    changed = {**SPEC, 'items': [{**SPEC['items'][0], 'sx': 2}]}
    newer = put(http, headers, changed, 1).json()
    newer_map = http.get(P + '/map-versions/' + newer['map_version_id'], headers=headers).json()
    replaced = save(http, headers, floor_id, newer_map['upload_id'], base=edited['id']).json()
    assert replaced['terrain_spec'] == changed
    rollback_headers = {**headers, 'Idempotency-Key': 'terrain-map-rollback'}
    body = {'base_version_id': replaced['id'], 'reason': '옛 지형 판으로 되돌림'}
    path = P + '/map-versions/' + edited['id'] + '/rollback'
    rolled_response = http.post(path, headers=rollback_headers, json=body)
    assert rolled_response.status_code == 201, rolled_response.text
    rolled = rolled_response.json()
    assert rolled['source'] == 'ROLLBACK' and rolled['copied_from_id'] == edited['id']
    assert rolled['upload_id'] == edited['upload_id'] and rolled['terrain_spec'] == SPEC
    assert http.post(path, headers=rollback_headers, json=body).json() == rolled
    assert http.get(P + '/map-versions/' + rolled['id'], headers=headers).json() == rolled
    listing = http.get(P + '/floors/' + floor_id + '/map-versions', headers=headers).json()['items']
    assert [item['terrain_spec'] for item in listing] == [SPEC, changed, SPEC, SPEC]
    diff = http.get(P + '/map-versions/' + rolled['id'] + '/diff', headers=headers).json()
    assert diff['version'] == rolled and diff['against']['terrain_spec'] == changed


def test_role_tenant_archive_and_restore(maps, seeded):
    http, headers, root = maps
    operator = auth(http, 'one')
    assert put(http, operator).status_code == 403
    first = put(http, headers).json()
    assert http.get(P + '/terrains', headers=operator).json()['items'][0]['spec'] == SPEC
    assert http.get(P + '/terrains/t-test', headers=operator).status_code == 200
    assert http.delete(P + '/terrains/t-test', headers=operator).status_code == 403
    from fastapi.testclient import TestClient
    from apps.server.fh_server.api import create_app, Settings
    engine = create_engine(seeded['urls']['migrate'])
    with engine.connect() as conn:
        org = conn.scalar(text('SELECT org_id FROM users WHERE id=:id'), {'id': seeded['users']['foreign']})
    engine.dispose()
    other_app = create_app(Settings(seeded['urls']['app'], org, files_root=str(root)))
    with TestClient(other_app, base_url='https://testserver') as other_http:
        foreign = auth(other_http, 'foreign')
        assert other_http.get(P + '/terrains/t-test', headers=foreign).status_code == 404
        assert http.get(P + '/terrains/no-such', headers=headers).json() == other_http.get(P + '/terrains/t-test', headers=foreign).json()
        assert other_http.get(P + '/terrains', headers=foreign).json()['items'] == []
        # Same browser id is a different organization's resource, never an overwrite.
        other = put(other_http, foreign)
        assert other.status_code == 200 and other.json()['floor_id'] != first['floor_id']
    other_app.state.engine.dispose()
    assert http.delete(P + '/terrains/t-test', headers=headers).status_code == 204
    assert http.delete(P + '/terrains/t-test', headers=headers).status_code == 204
    assert http.get(P + '/terrains', headers=headers).json()['items'] == []
    assert http.get(P + '/terrains?archived=true', headers=headers).json()['items'][0]['archived_at']
    assert put(http, headers, version=1).status_code == 409
    assert http.post(P + '/terrains/t-test/restore', headers=operator).status_code == 403
    restored = http.post(P + '/terrains/t-test/restore', headers=headers)
    assert restored.status_code == 200 and restored.json()['archived_at'] is None
    assert put(http, headers, version=1).status_code == 200
    assert http.get(P + '/terrains').status_code == 401


def test_invalid_and_failed_saves_leave_no_map(maps, monkeypatch):
    http, headers, root = maps
    data = copy.deepcopy(SPEC)
    data['items'] *= 61
    assert put(http, headers, data).status_code == 422
    assert http.put(P + '/terrains/wrong', headers=headers, json={'spec': SPEC, 'base_version': 0}).status_code == 422
    original_open = Path.open
    def fail_yaml(path, *args, **kwargs):
        if path.suffix == '.yaml' and args and args[0] == 'xb':
            raise OSError('synthetic disk failure')
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', fail_yaml)
    assert put(http, headers).status_code == 503
    assert http.get(P + '/sites', headers=headers).json()['items'] == []
    assert http.get(P + '/terrains', headers=headers).json()['items'] == []
    assert not list(root.glob('maps/*/*.png'))


def test_archived_generated_floor_blocks_save_without_restoring_it(maps):
    http, headers, _ = maps
    saved = put(http, headers).json()
    assert http.delete(P + '/floors/' + saved['floor_id'], headers=headers).status_code == 204
    result = put(http, headers, version=1)
    assert result.status_code == 409 and result.json()['error']['code'] == 'RESOURCE_ARCHIVED'
    assert http.get(P + '/terrains/t-test', headers=headers).json()['version'] == 1


def test_terrain_grants_and_map_snapshot_source(maps, seeded):
    http, headers, _ = maps
    saved = put(http, headers).json()
    engine = create_engine(seeded['urls']['app'])
    try:
        with engine.connect() as conn:
            for op in ('SELECT', 'INSERT', 'UPDATE'):
                assert conn.scalar(text("SELECT has_table_privilege(current_user,'terrains',:op)"), {'op': op})
            assert not conn.scalar(text("SELECT has_table_privilege(current_user,'terrains','DELETE')"))
            metadata = conn.scalar(text('SELECT metadata_json FROM uploads JOIN map_versions ON uploads.id=map_versions.upload_id WHERE map_versions.id=:id'), {'id': saved['map_version_id']})
            assert metadata['terrain_spec'] == SPEC and metadata['terrain_version'] == 1
    finally:
        engine.dispose()

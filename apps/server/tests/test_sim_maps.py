"""Reviewed static worlds, imported only into private temporary DB/files."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import os
import subprocess
import sys
from pathlib import Path
import shutil
from uuid import UUID

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from apps.server.fh_server.models import (Approval, Building, Floor, MapVersion,
    Mission, MissionVersion, Robot, Scenario, ScenarioVersion, Site, Upload)
from apps.server.fh_server.sim_maps import check_clearance, gray_pixels, load_worlds, sync_worlds
from apps.server.fh_server.map_files import gray_png, sha256
from apps.server.fh_server.scenario_targets import require_target
from fastapi.testclient import TestClient
from apps.server.fh_server.api import APIError, Settings, create_app
from apps.server.fh_server.models import User
from .conftest import CONFIG
from .test_maps import P, auth, maps, tree, FEATURES, upload, save

SOURCE = Path(__file__).resolve().parents[2] / 'simmgr/worlds'


@pytest.fixture
def world_folder(tmp_path):
    root = tmp_path / 'worlds'
    (root / 'warehouse/maps').mkdir(parents=True)
    for relative in ('worlds.json', 'warehouse/scenarios.json', 'warehouse/maps/f1.png',
                     'warehouse/maps/f1.yaml', 'warehouse/maps/metadata.json'):
        shutil.copyfile(SOURCE / relative, root / relative)
    catalog = json.loads((root / 'worlds.json').read_text())
    catalog['worlds'] = {'warehouse/f1': catalog['worlds']['warehouse/f1']}
    (root / 'worlds.json').write_text(json.dumps(catalog))
    return root


def sync(http, seeded, folder, files):
    with Session(http.app.state.engine) as db, db.begin():
        return sync_worlds(db, seeded['org'], seeded['users']['admin'], folder, files)


def counts(http):
    with Session(http.app.state.engine) as db:
        return [db.scalar(select(func.count()).select_from(model)) for model in (
            Site, Building, Floor, MapVersion, Upload, Approval, Mission, MissionVersion, Scenario, ScenarioVersion)]


def test_import_approved_idempotent_image_replacement_and_snapshots(maps, seeded, world_folder):
    http, admin, files = maps
    http.headers.update(admin)
    assert http.get(P + '/sites').json()['items'] == []  # Opt-in, no startup import.
    changed = sync(http, seeded, world_folder, files)
    assert len(changed) == 1
    assert counts(http) == [1, 1, 1, 1, 1, 0, 12, 12, 3, 3]
    before = counts(http)
    assert sync(http, seeded, world_folder, files) == []
    assert counts(http) == before
    building = http.get(P + '/sites').json()['items'][0]['buildings'][0]
    assert building['sim_world_id'] == 'warehouse'
    floor = building['floors'][0]
    assert floor['provenance'] == 'SIMULATION' and floor['floor_z'] == .034226
    old_id = floor['approved_version_id']
    version = http.get(P + '/map-versions/' + old_id).json()
    assert version['status'] == 'APPROVED' and version['provenance'] == 'SIMULATION'
    assert http.get(P + '/map-versions/' + old_id + '/image').content == (world_folder / 'warehouse/maps/f1.png').read_bytes()
    scenarios = http.get(P + '/scenarios').json()['items']
    assert len(scenarios) == 3 and all(s['map_version_ids'] == [old_id] for s in scenarios)
    assert all(m['steps'] == [] for m in http.get(P + '/missions').json()['items'])
    # A pixel far from every preset changes, with matching generated digest.
    image = world_folder / 'warehouse/maps/f1.png'
    width, height, pixels = gray_pixels(image.read_bytes())
    pixels[0] = 0 if pixels[0] else 205
    image.write_bytes(gray_png(width, height, pixels))
    meta_path = world_folder / 'warehouse/maps/metadata.json'
    meta = json.loads(meta_path.read_text())
    meta['floors']['f1']['image_sha256'] = sha256(image.read_bytes()).hex()
    meta_path.write_text(json.dumps(meta))
    assert len(sync(http, seeded, world_folder, files)) == 1
    assert counts(http) == [1, 1, 1, 2, 2, 0, 12, 12, 3, 6]
    assert http.get(P + '/map-versions/' + old_id).json()['status'] == 'SUPERSEDED'
    new = http.get(P + f'/floors/{floor["id"]}/map-versions').json()['items'][0]
    assert new['number'] == 2 and new['base_version_id'] == old_id and new['status'] == 'APPROVED'
    for scenario in scenarios:
        old = http.get(P + '/scenarios/' + scenario['id'] + '?version=1').json()
        current = http.get(P + '/scenarios/' + scenario['id']).json()
        assert old['map_version_ids'] == [old_id]
        assert current['number'] == 2 and current['map_version_ids'] == [new['id']]
    assert sync(http, seeded, world_folder, files) == []
    assert counts(http)[-1] == 6


def test_group_world_floors_and_catalog_links_are_tenant_scoped(maps, seeded, world_folder):
    http, admin, files = maps
    http.headers.update(admin)
    path = world_folder / 'worlds.json'
    catalog = json.loads(path.read_text())
    second = copy.deepcopy(catalog['worlds']['warehouse/f1'])
    second.update(floor_id='f2', floor_name='윗층', floor_z=3., scenarios=None)
    catalog['worlds']['warehouse/f2'] = second
    other = copy.deepcopy(second)
    other.update(world_id='other', floor_id='f1', floor_z=.034226)
    catalog['worlds']['other/f1'] = other
    path.write_text(json.dumps(catalog))
    meta_path = world_folder / 'warehouse/maps/metadata.json'
    meta = json.loads(meta_path.read_text())
    meta['floors']['f2'] = {**meta['floors']['f1'], 'floor_z': 3.}
    meta_path.write_text(json.dumps(meta))
    assert len(sync(http, seeded, world_folder, files)) == 3
    assert counts(http)[:4] == [1, 2, 3, 3]
    class Relay:
        def request(self, *_):
            return {'worlds': [{'id': 'warehouse/f1', 'name': '창고'}, {'id': 'unregistered', 'name': '기타'}], 'slots': [], 'max_robots': 2, 'launcher': 'fake'}
    http.app.state.simmgr = Relay()
    worlds = http.get(P + '/simulation/worlds').json()['worlds']
    assert worlds[0]['map_id'] and len(worlds[0]['floors']) == 2
    assert {f['floor_z'] for f in worlds[0]['floors']} == {.034226, 3.}
    assert all(f['map_version_id'] for f in worlds[0]['floors'])
    assert worlds[1]['map_id'] is None and worlds[1]['floors'] == []
    with Session(http.app.state.engine) as db:
        other_org = db.get(User, seeded['users']['foreign']).org_id
    app = create_app(Settings(seeded['urls']['app'], other_org, files_root=str(files)))
    with TestClient(app, base_url='https://testserver') as other:
        app.state.simmgr = Relay()
        worlds = other.get(P + '/simulation/worlds', headers=auth(other, 'foreign')).json()['worlds']
        assert worlds[0]['map_id'] is None
    app.state.engine.dispose()


def test_simulation_target_enforced_for_admin_operator_and_approval(maps, seeded, world_folder):
    http, admin, files = maps
    http.headers.update(admin)
    sync(http, seeded, world_folder, files)
    scenario = http.get(P + '/scenarios').json()['items'][0]
    body = dict(scenario_id=scenario['id'], scenario_version=1, robot_id=str(seeded['robots']['mine']), memo='시험')
    for headers in (admin, auth(http, 'one')):
        denied = http.post(P + '/assignments', headers=headers, json=body)
        assert denied.status_code == 422
        assert denied.json()['error']['code'] == 'SIM_MAP_REQUIRES_SIM_ROBOT'
    with Session(http.app.state.engine) as db, db.begin():
        robot = db.get(Robot, seeded['robots']['mine'])
        version = db.scalar(select(ScenarioVersion).where(ScenarioVersion.scenario_id == UUID(scenario['id'])))
        with pytest.raises(APIError) as exc:
            require_target(db, version, robot, lambda *a: (_ for _ in ()).throw(APIError(*a)))
        assert exc.value.code == 'SIM_MAP_REQUIRES_SIM_ROBOT'
    # Simulate only the already-existing provenance, never start a manager/slot.
    engine = create_engine(seeded['urls']['migrate'])
    with engine.begin() as conn:
        conn.execute(text('UPDATE robots SET simulation=true WHERE id=:id'), {'id': seeded['robots']['mine']})
    from .legacy_approvals import pending_assignment
    one = auth(http, 'one')
    direct = http.post(P + '/assignments', headers=one, json=body)
    assert direct.status_code == 201, direct.text
    assert direct.json()['status'] == 'ACTIVE' and direct.json()['approval_id'] is None
    assert http.get(P + '/approvals', headers=admin).json()['items'] == []
    assert http.delete(P + '/assignments/' + direct.json()['id'], headers=admin).status_code == 204
    # Existing requests must still revalidate provenance during a decision.
    pending = pending_assignment(http, one, scenario, seeded['robots']['mine'])
    with engine.begin() as conn:
        conn.execute(text('UPDATE robots SET simulation=false WHERE id=:id'), {'id': seeded['robots']['mine']})
    stale = http.post(P + '/approvals/' + pending['approval_id'] + '/approve', headers=admin, json={})
    assert stale.status_code == 409 and stale.json()['error']['code'] == 'APPROVAL_STALE'
    engine.dispose()


def test_all_preset_points_clear_occupied_and_unknown_by_half_meter(world_folder):
    entry, metadata, png, _, _, presets = load_worlds(world_folder)[0]
    assert len(presets) == 3
    check_clearance(png, metadata, presets)
    # Deliberately put one waypoint at an occupied cell centre: must fail.
    width, height, pixels = gray_pixels(png)
    index = pixels.index(0)
    row, column = divmod(index, width)
    mutated = copy.deepcopy(presets)
    mutated[0]['waypoints'][0].update(x=-7.5 + (column + .5) * .05, y=-11 + (height - row - .5) * .05)
    with pytest.raises(ValueError, match='waypoint'):
        check_clearance(png, metadata, mutated)
    # Independent tiny grid tests the occupied/unknown cell *edge* distance.
    grid = bytearray([254] * 400)
    for value in (0, 205):
        grid[10 * 20 + 10] = value
        small = gray_png(20, 20, grid)
        meta = {'resolution': .1, 'origin': [0, 0, 0]}
        for x, allowed in ((.5, True), (.51, False)):
            test = [{'waypoints': [{'x': x, 'y': .95}]}]
            if allowed:
                check_clearance(small, meta, test)
            else:
                with pytest.raises(ValueError):
                    check_clearance(small, meta, test)


def test_concurrent_import_and_invalid_checksum_are_atomic(maps, seeded, world_folder):
    http, admin, files = maps
    http.headers.update(admin)
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: sync(http, seeded, world_folder, files), range(2)))
    assert sorted(map(len, results)) == [0, 1]
    before = counts(http)
    meta = world_folder / 'warehouse/maps/metadata.json'
    body = json.loads(meta.read_text())
    body['floors']['f1']['image_sha256'] = '0' * 64
    meta.write_text(json.dumps(body))
    with pytest.raises(ValueError, match='metadata'):
        sync(http, seeded, world_folder, files)
    assert counts(http) == before


def test_downgrade_refuses_to_erase_simulation_provenance(maps, seeded, world_folder, monkeypatch):
    http, _, files = maps
    sync(http, seeded, world_folder, files)
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
    with pytest.raises(DBAPIError, match='Retire simulation map data'):
        command.downgrade(Config(str(CONFIG)), '0016')
    with Session(http.app.state.engine) as db:
        assert db.scalar(select(Floor.provenance)) == 'SIMULATION'
    engine = create_engine(seeded['urls']['migrate'])
    with engine.connect() as conn:
        assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0020'
    engine.dispose()


def test_sim_upload_yaml_copy_and_rollback_keep_snapshot_provenance(maps, seeded, world_folder):
    http, admin, files = maps
    http.headers.update(admin)
    sync(http, seeded, world_folder, files)
    scenario = http.get(P + '/scenarios').json()['items'][0]
    original = http.get(P + '/map-versions/' + scenario['map_version_ids'][0]).json()
    _, _, floor_id = tree(http, admin)
    # Reusing a server-side upload or making a new YAML-linked upload must not
    # relabel the simulated content as HUMAN on an otherwise human floor.
    yaml = (world_folder / 'warehouse/maps/f1.yaml').read_bytes()
    duplicate = http.post(P + '/uploads?image=' + original['upload_id'],
        headers={**admin, 'content-type': 'text/yaml'}, content=yaml)
    assert duplicate.status_code == 201, duplicate.text
    ids = []
    for image in (original['upload_id'], duplicate.json()['upload_id']):
        saved = http.post(P + f'/floors/{floor_id}/map-versions', headers=admin, json={
            'base_version_id': ids[-1] if ids else None, 'image': image, 'features': FEATURES, 'reason': '복사 회귀 시험'})
        assert saved.status_code == 201 and saved.json()['provenance'] == 'SIMULATION'
        ids.append(saved.json()['id'])
    rolled = http.post(P + '/map-versions/' + ids[0] + '/rollback', headers=admin,
        json={'base_version_id': ids[1], 'reason': '되돌리기 출처 보존 시험'})
    assert rolled.status_code == 201 and rolled.json()['provenance'] == 'SIMULATION'
    body = {k: scenario[k] for k in ('name', 'waypoints', 'finish', 'notes')}
    for point in body['waypoints']:
        point.update(floor_id=floor_id, map_version_id=rolled.json()['id'])
    copied = http.post(P + '/scenarios', headers=admin, json=body)
    assert copied.status_code == 201, copied.text
    denied = http.post(P + '/assignments', headers=admin, json={'scenario_id': copied.json()['id'],
        'scenario_version': 1, 'robot_id': str(seeded['robots']['mine']), 'memo': '출처 우회 거부 시험'})
    assert denied.status_code == 422 and denied.json()['error']['code'] == 'SIM_MAP_REQUIRES_SIM_ROBOT'
    # A fresh human upload used to edit that copied snapshot still inherits its
    # simulated base provenance; neither the floor label nor upload can erase it.
    human_upload = upload(http, admin)
    edited = save(http, admin, floor_id, human_upload, base=rolled.json()['id'])
    assert edited.status_code == 201 and edited.json()['provenance'] == 'SIMULATION'


def test_explicit_management_command_is_the_only_trigger(maps, seeded, world_folder):
    http, _, files = maps
    args = [sys.executable, '-m', 'apps.server.fh_server.sim_maps', '--worlds-dir', str(world_folder),
        '--org-id', str(seeded['org']), '--actor-id', str(seeded['users']['admin']), '--files-root', str(files)]
    env = {**os.environ, 'FH_DATABASE_URL': seeded['urls']['app']}
    first = subprocess.run(args, env=env, text=True, capture_output=True, check=True, timeout=30)
    second = subprocess.run(args, env=env, text=True, capture_output=True, check=True, timeout=30)
    assert len(json.loads(first.stdout)['registered_versions']) == 1
    assert json.loads(second.stdout)['registered_versions'] == []
    assert counts(http) == [1, 1, 1, 1, 1, 0, 12, 12, 3, 3]


def test_factory_catalogue_imports_all_floors_and_presets(seeded, tmp_path):
    """Full real catalogue, temporary PostgreSQL only; repeat import is a no-op."""
    engine = create_engine(seeded['urls']['migrate'])
    try:
        prepared = load_worlds(SOURCE)
        keys = {e['world_id']+'/'+e['floor_id'] for e, *_ in prepared}
        factory_keys = {'factory_inspection/f1', 'factory_inspection_alt1/f1',
                        'factory_zone/f1', 'factory_zone/f2', 'element_course/f1'}
        assert factory_keys <= keys
        for entry, metadata, png, _, _, _ in prepared:
            if entry['world_id'].startswith(('factory_', 'element_')):
                x, y, _ = entry['spawn_xyyaw']
                check_clearance(png, metadata, [{'waypoints': [{'x': x, 'y': y}]}])
        with Session(engine) as db, db.begin():
            changed = sync_worlds(db, seeded['org'], seeded['users']['admin'], SOURCE, tmp_path)
            assert len(changed) == len(prepared)
        with Session(engine) as db, db.begin():
            assert sync_worlds(db, seeded['org'], seeded['users']['admin'], SOURCE, tmp_path) == []
            floors = list(db.scalars(select(Floor).where(Floor.sim_floor_id.in_(['f1', 'f2']))))
            assert len(floors) == len(prepared)
            assert any(f.sim_floor_id == 'f2' and f.floor_z == 2 for f in floors)
    finally:
        engine.dispose()

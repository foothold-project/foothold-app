"""Simulation pairs: public mutation guards, reversible trash, data repair."""
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from apps.contracts.tests.test_terrain import SPEC
from apps.server.fh_server.models import (Assignment, Building, Event, Floor, MapVersion,
    Robot, Run, Scenario, ScenarioVersion, Site, Terrain, now)
from apps.server.fh_server.terrains import identifier
from .conftest import CONFIG
from .legacy_approvals import pending_assignment
from .test_assignments import assignment, scenario
from .test_maps import P, auth, maps, save, tree, upload  # noqa: F401
from .test_terrains import put


def test_sim_creation_and_map_mutations_rejected_real_paths_remain(maps, seeded):
    http, headers, _ = maps
    sim = put(http, headers).json()
    sites = http.get(P + '/sites', headers=headers).json()['items']
    site, building = sites[0], sites[0]['buildings'][0]
    # SIM site, building, floor and map can still be produced internally.
    assert site['purpose'] == 'SIM'
    image = upload(http, headers)
    for response in (
        http.post(P + '/sites', headers=headers, json={'name': '직접 시뮬', 'purpose': 'SIM'}),
        http.post(P + '/sites/' + site['id'] + '/buildings', headers=headers, json={'name': '직접 건물'}),
        http.post(P + '/buildings/' + building['id'] + '/floors', headers=headers, json={'name': '직접 층', 'level': 2}),
        save(http, headers, sim['floor_id'], image, base=sim['map_version_id']),
        http.post(P + '/map-versions/' + sim['map_version_id'] + '/rollback', headers=headers,
            json={'base_version_id': sim['map_version_id'], 'reason': '직접 되돌림'}),
    ):
        assert response.status_code == 409, response.text
        assert response.json()['error']['code'] == 'SIM_PLACE_BY_TERRAIN'
    _, _, real_floor = tree(http, headers)
    first = save(http, headers, real_floor, image).json()
    second = save(http, headers, real_floor, image, base=first['id']).json()
    rollback = http.post(P + '/map-versions/' + first['id'] + '/rollback', headers=headers,
        json={'base_version_id': second['id'], 'reason': '실기 되돌림'})
    assert rollback.status_code == 201, rollback.text
    assert put(http, headers, version=1).status_code == 200


@pytest.mark.parametrize('archive_by', ['terrain', 'floor'])
@pytest.mark.parametrize('restore_by', ['terrain', 'floor'])
def test_trash_pair_both_directions_and_parent_guard(maps, archive_by, restore_by):
    http, headers, _ = maps
    pair = put(http, headers).json()
    floor_path = P + '/floors/' + pair['floor_id']
    terrain_path = P + '/terrains/' + SPEC['id']
    archived = http.delete(terrain_path if archive_by == 'terrain' else floor_path, headers=headers)
    assert archived.status_code == 204, archived.text
    assert http.get(terrain_path, headers=headers).json()['archived_at']
    trash = http.get(P + '/trash', headers=headers).json()['items']
    assert any(item['id'] == pair['floor_id'] for item in trash)
    hierarchy = http.get(P + '/sites?archived=true', headers=headers).json()['items'][0]
    building_id = hierarchy['buildings'][0]['id']
    assert http.delete(P + '/buildings/' + building_id, headers=headers).status_code == 204
    restore_path = terrain_path + '/restore' if restore_by == 'terrain' else P + '/trash/floor/' + pair['floor_id'] + '/restore'
    denied = http.post(restore_path, headers=headers)
    assert denied.status_code == 409 and denied.json()['error']['code'] == 'PARENT_ARCHIVED'
    assert http.get(terrain_path, headers=headers).json()['archived_at']
    assert http.post(P + '/trash/building/' + building_id + '/restore', headers=headers).status_code == 204
    assert http.post(restore_path, headers=headers).status_code in (200, 204)
    assert http.get(terrain_path, headers=headers).json()['archived_at'] is None
    assert http.get(P + '/trash', headers=headers).json()['items'] == []


@pytest.mark.parametrize('archive_by', ['terrain', 'floor'])
def test_used_terrain_pair_cannot_archive(maps, seeded, archive_by):
    http, headers, _ = maps
    pair = put(http, headers).json()
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.begin() as conn:
            conn.execute(text("UPDATE robots SET last_floor_id=:floor, last_floor_source='HUMAN' WHERE id=:robot"),
                dict(floor=pair['floor_id'], robot=seeded['robots']['mine']))
        path = '/terrains/' + SPEC['id'] if archive_by == 'terrain' else '/floors/' + pair['floor_id']
        denied = http.delete(P + path, headers=headers)
        assert denied.status_code == 409 and denied.json()['error']['code'] == 'RESOURCE_IN_USE'
        assert http.get(P + '/terrains/' + SPEC['id'], headers=headers).json()['archived_at'] is None
        assert http.get(P + '/trash', headers=headers).json()['items'] == []
        with engine.begin() as conn:
            conn.execute(text('UPDATE robots SET last_floor_id=NULL, last_floor_source=NULL WHERE id=:robot'),
                {'robot': seeded['robots']['mine']})
        assert http.delete(P + path, headers=headers).status_code == 204
        with engine.begin() as conn:
            conn.execute(text("UPDATE robots SET last_floor_id=:floor, last_floor_source='HUMAN' WHERE id=:robot"),
                dict(floor=pair['floor_id'], robot=seeded['robots']['mine']))
        for restore_path in ('/terrains/' + SPEC['id'] + '/restore', '/trash/floor/' + pair['floor_id'] + '/restore'):
            denied = http.post(P + restore_path, headers=headers)
            assert denied.status_code == 409 and denied.json()['error']['code'] == 'RESOURCE_IN_USE'
        assert http.get(P + '/terrains/' + SPEC['id'], headers=headers).json()['archived_at']
    finally:
        engine.dispose()


def test_0027_pairs_repair_archive_preserve_and_audit(maps, seeded, monkeypatch, capsys):
    http, headers, root = maps
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
    monkeypatch.setenv('FH_FILES_ROOT', str(root))
    config = Config(str(CONFIG))
    command.downgrade(config, '0026')
    engine = create_engine(seeded['urls']['migrate'])
    # C: an uploaded/replaced map with no terrain or world.
    c_site, c_building, c_floor = tree(http, headers)
    c_image = upload(http, headers)
    c_first = save(http, headers, c_floor, c_image).json()
    assert save(http, headers, c_floor, c_image, base=c_first['id']).status_code == 201
    # Scenario rows are preserved even when their unpaired floor is archived.
    plain_scenario, scenario_floor, _, _ = scenario(http, headers)
    active_scenario, active_floor, _, _ = scenario(http, headers)
    assert assignment(http, headers, active_scenario, seeded['robots']['mine']).status_code == 201
    pending_scenario, pending_floor, _, _ = scenario(http, headers)
    pending_assignment(http, auth(http, 'two'), pending_scenario, seeded['robots']['theirs'])
    d1 = put(http, headers, {**SPEC, 'id': 't-d'}).json()
    d2 = put(http, headers, {**SPEC, 'id': 't-d'}, 1).json()
    e = put(http, headers, {**SPEC, 'id': 't-e'}).json()
    f = put(http, headers, {**SPEC, 'id': 't-f'}).json()
    paired = put(http, headers, {**SPEC, 'id': 't-paired'}).json()
    try:
        with Session(engine) as db, db.begin():
            org = seeded['org']
            fixtures = {'C': tuple(UUID(k) for k in (c_site, c_building, c_floor))}
            db.get(Site, UUID(c_site)).purpose = 'SIM'
            for label in ('A', 'B', 'H', 'I', 'robot', 'run', 'session', 'REAL'):
                site = Site(org_id=org, name=label, purpose='REAL' if label == 'REAL' else 'SIM')
                db.add(site); db.flush()
                building = Building(org_id=org, site_id=site.id, name=label,
                    sim_world_id='v5_building' if label == 'H' else 'unpaired-world' if label == 'I' else 'active-world' if label == 'session' else None)
                db.add(building); db.flush()
                floor = Floor(org_id=org, building_id=building.id, name=label, level=1,
                    provenance='SIMULATION' if label == 'H' else 'HUMAN')
                db.add(floor); db.flush()
                fixtures[label] = (site.id, building.id, floor.id)
            for fid in (scenario_floor, active_floor, pending_floor):
                floor = db.get(Floor, UUID(fid))
                site = db.get(Site, db.get(Building, floor.building_id).site_id)
                site.purpose = 'SIM'
            db.get(Floor, UUID(d1['floor_id'])).approved_version_id = UUID(d1['map_version_id'])
            db.get(Terrain, ('t-e', org)).archived_at = now()
            floor = db.get(Floor, UUID(f['floor_id']))
            floor.archived_at = now()
            db.get(Building, floor.building_id).archived_at = now()
            db.add(Terrain(org_id=org, id='t-missing', spec={**SPEC, 'id': 't-missing'}, version=1))
            db.add(Terrain(org_id=org, id='t-invalid', spec={}, version=1))
            robot = db.get(Robot, seeded['robots']['mine'])
            robot.last_floor_id, robot.last_floor_source = fixtures['robot'][2], 'HUMAN'
            sim_robot = Robot(org_id=org, name='synthetic session', model='unitree_go2',
                agent_token_hash=b'fake', simulation=True, sim_state='RUNNING', sim_world_id='active-world')
            db.add(sim_robot); db.flush()
            db.add(Run(id=uuid4(), org_id=org, robot_id=seeded['robots']['theirs'], simulation=True,
                floor_id=fixtures['run'][2], started_by=seeded['users']['one'], device_id=uuid4(),
                surface='pc', screen_id=uuid4(), agent_instance_id=uuid4(), status='PAUSED', plan={}))
            scenario_ids = list(db.scalars(select(Scenario.id)))
            map_ids = list(db.scalars(select(MapVersion.id)))
        command.upgrade(config, 'head')
        with Session(engine) as db:
            for label in ('A', 'B', 'C', 'I'):
                assert all(db.get(model, key).archived_at for model, key in zip((Site, Building, Floor), fixtures[label]))
            for label in ('H', 'robot', 'run', 'session', 'REAL'):
                assert all(db.get(model, key).archived_at is None for model, key in zip((Site, Building, Floor), fixtures[label]))
            assert db.get(Floor, UUID(scenario_floor)).archived_at
            assert db.get(Floor, UUID(active_floor)).archived_at is None
            assert db.get(Floor, UUID(pending_floor)).archived_at is None
            assert str(db.get(Floor, UUID(d1['floor_id'])).approved_version_id) == d2['map_version_id']
            assert db.get(Floor, UUID(e['floor_id'])).archived_at
            assert db.get(Floor, UUID(f['floor_id'])).archived_at is None
            assert db.get(Floor, UUID(f['floor_id'])).approved_version_id != UUID(f['map_version_id'])
            assert db.get(Floor, UUID(paired['floor_id'])).approved_version_id == UUID(paired['map_version_id'])
            recovered = db.scalar(select(Floor).where(Floor.org_id == seeded['org'], Floor.terrain_id == 't-missing'))
            assert recovered.archived_at is None and recovered.approved_version_id
            assert (root / db.get(MapVersion, recovered.approved_version_id).image_path).is_file()
            assert db.get(Terrain, ('t-invalid', seeded['org'])).archived_at
            assert set(db.scalars(select(Scenario.id))) == set(scenario_ids)
            assert set(db.scalars(select(MapVersion.id))) >= set(map_ids)
            journal = list(db.scalars(select(Event).where(Event.code == 'SIM_PAIR_REPAIRED')))
            assert {e.data['kind'] for e in journal} == {'sites', 'buildings', 'floors', 'terrains'}
            assert all(e.data['migration'] == '0027' and 'before' in e.data and 'after' in e.data for e in journal)
            assert not any(e.data['id'] in {str(k) for k in fixtures['REAL']} for e in journal)
            count = len(journal)
        output = capsys.readouterr().out
        assert 'in_use_floors_preserved=5' in output
        assert 'terrain_map_revision_repair' in output and 'terrain_only_unrecoverable' in output
        # Data-only downgrade keeps the durable recovery journal and is repeatable.
        command.downgrade(config, '0026')
        command.upgrade(config, 'head')
        with Session(engine) as db:
            assert len(list(db.scalars(select(Event).where(Event.code == 'SIM_PAIR_REPAIRED')))) == count
        # Recovery through the existing trash flow, parent first, retains scenarios.
        with Session(engine) as db:
            archived = db.get(Floor, UUID(scenario_floor))
            building = db.get(Building, archived.building_id)
            restore_ids = [('site', building.site_id), ('building', building.id), ('floor', archived.id)]
        for kind, key in restore_ids:
            assert http.post(P + f'/trash/{kind}/{key}/restore', headers=headers).status_code == 204
        assert http.get(P + '/scenarios/' + plain_scenario['id'], headers=headers).status_code == 200
    finally:
        engine.dispose()


def test_0027_failed_rebuild_archives_terrain_without_partial_hierarchy(maps, seeded, monkeypatch):
    from apps.server.fh_server import terrains
    _, _, root = maps
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
    monkeypatch.setenv('FH_FILES_ROOT', str(root))
    config = Config(str(CONFIG))
    command.downgrade(config, '0026')
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with Session(engine) as db, db.begin():
            db.add(Terrain(org_id=seeded['org'], id=SPEC['id'], spec=SPEC, version=1))
        def storage_failure(*args, **kwargs):
            raise OSError('synthetic storage failure')
        monkeypatch.setattr(terrains, 'publish_terrain_map', storage_failure)
        command.upgrade(config, 'head')
        with Session(engine) as db:
            assert db.get(Terrain, (SPEC['id'], seeded['org'])).archived_at
            assert list(db.scalars(select(Site.id))) == []
            assert list(db.scalars(select(Building.id))) == []
            assert list(db.scalars(select(Floor.id))) == []
            journal = list(db.scalars(select(Event).where(Event.code == 'SIM_PAIR_REPAIRED')))
            assert len(journal) == 1 and journal[0].data['kind'] == 'terrains'
    finally:
        engine.dispose()


def test_0027_empty_terrain_hierarchy_survives_and_new_save_restores_parents(maps, seeded, monkeypatch):
    http, headers, root = maps
    old = put(http, headers).json()
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
    monkeypatch.setenv('FH_FILES_ROOT', str(root))
    config = Config(str(CONFIG))
    command.downgrade(config, '0026')
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with Session(engine) as db, db.begin():
            # E: migration must archive the last live floor, but keep its
            # shared terrain site and building available for the next save.
            db.get(Terrain, (SPEC['id'], seeded['org'])).archived_at = now()
        command.upgrade(config, 'head')
        with Session(engine) as db:
            floor = db.get(Floor, UUID(old['floor_id']))
            building = db.get(Building, floor.building_id)
            site = db.get(Site, building.site_id)
            assert floor.archived_at
            assert site.id == identifier(seeded['org'], 'site')
            assert site.archived_at is None and building.archived_at is None
            site_id, building_id = site.id, building.id
        assert http.delete(P + f'/buildings/{building_id}', headers=headers).status_code == 204
        assert http.delete(P + f'/sites/{site_id}', headers=headers).status_code == 204
        new_spec = {**SPEC, 'id': 't-new'}
        # Reuse an empty archived terrain building as well as the shared site.
        with Session(engine) as db, db.begin():
            db.add(Building(id=identifier(seeded['org'], 't-new/building'), org_id=seeded['org'],
                site_id=site_id, name='old name', archived_at=now()))
        saved = put(http, headers, new_spec)
        assert saved.status_code == 200, saved.text
        with Session(engine) as db:
            floor = db.get(Floor, UUID(saved.json()['floor_id']))
            building = db.get(Building, floor.building_id)
            assert db.get(Site, site_id).archived_at is None
            assert building.archived_at is None and building.name == SPEC['name']
            assert floor.archived_at is None and floor.approved_version_id
            assert db.get(Floor, UUID(old['floor_id'])).archived_at
            assert db.get(Terrain, (SPEC['id'], seeded['org'])).archived_at
    finally:
        engine.dispose()


@pytest.mark.parametrize('uid_delta,gid_delta', [(0, 0), (1, 0), (0, 1)])
def test_0027_generated_files_and_directories_match_root_owner(tmp_path, monkeypatch, uid_delta, gid_delta):
    migration = import_module('apps.server.migrations.versions.0027_sim_pairs')
    root = tmp_path / 'files'
    folder = root / 'maps' / 'floor'
    folder.mkdir(parents=True)
    created = [folder / 'map.png', folder / 'map.yaml']
    for path in created:
        path.touch()
    owner = root.stat()
    original_stat = Path.stat
    def fake_stat(path, *args, **kwargs):
        if path != root and root in path.parents:
            return SimpleNamespace(st_uid=owner.st_uid + uid_delta, st_gid=owner.st_gid + gid_delta)
        return original_stat(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'stat', fake_stat)
    changed = []
    monkeypatch.setattr(migration.os, 'chown', lambda *args: changed.append(args))
    migration.match_files_owner(root, created)
    expected = {root / 'maps', folder, *created} if uid_delta or gid_delta else set()
    assert set(changed) == {(path, owner.st_uid, owner.st_gid) for path in expected}


def test_0027_ownership_errors_print_and_continue(tmp_path, monkeypatch, capsys):
    migration = import_module('apps.server.migrations.versions.0027_sim_pairs')
    root = tmp_path / 'files'
    folder = root / 'maps' / 'floor'
    folder.mkdir(parents=True)
    png, yaml = folder / 'map.png', folder / 'map.yaml'
    owner = root.stat()
    original_stat = Path.stat
    def fake_stat(path, *args, **kwargs):
        if path == png:
            raise OSError('synthetic stat failure')
        if path != root and root in path.parents:
            return SimpleNamespace(st_uid=owner.st_uid + 1, st_gid=owner.st_gid + 1)
        return original_stat(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'stat', fake_stat)
    changed = []
    def chown(path, uid, gid):
        changed.append(path)
        if path == folder:
            raise PermissionError('synthetic chown failure')
    monkeypatch.setattr(migration.os, 'chown', chown)
    migration.match_files_owner(root, [png, yaml])
    assert changed == [root / 'maps', folder, yaml]
    output = capsys.readouterr().out
    assert 'synthetic stat failure' in output and 'synthetic chown failure' in output
    def root_failure(*args, **kwargs):
        raise OSError('synthetic root failure')
    monkeypatch.setattr(Path, 'stat', root_failure)
    migration.match_files_owner(root, [png])
    assert 'synthetic root failure' in capsys.readouterr().out

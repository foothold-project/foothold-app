"""Orphan-world repair against private PostgreSQL and synthetic registrations."""
from uuid import UUID, uuid4

from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from apps.contracts.tests.test_terrain import SPEC
from apps.server.fh_server.models import (Building, Event, Floor, MapVersion,
    Robot, Run, Scenario, ScenarioVersion, Site, Terrain)
from apps.server.fh_server.sim_maps import supported_world_ids
from apps.server.fh_server.terrains import identifier
from .conftest import CONFIG
from .legacy_approvals import pending_assignment
from .test_assignments import assignment, scenario
from .test_floor_auto import connected_folder  # noqa: F401
from .test_maps import P, auth, maps  # noqa: F401
from .test_sim_maps import sync, world_folder  # noqa: F401
from .test_terrains import put


@pytest.mark.parametrize('repair', ['migration', 'sync'])
def test_removed_world_archive_preserves_pairs_usage_history_and_is_repeatable(
        maps, seeded, world_folder, monkeypatch, repair):
    http, headers, files = maps
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
    config = Config(str(CONFIG))
    command.downgrade(config, '0027')
    ordinary, ordinary_floor, _, _ = scenario(http, headers)
    active, active_floor, _, _ = scenario(http, headers)
    assert assignment(http, headers, active, seeded['robots']['mine']).status_code == 201
    pending, pending_floor, _, _ = scenario(http, headers)
    pending_assignment(http, auth(http, 'two'), pending, seeded['robots']['theirs'])
    terrain_pair = put(http, headers).json()
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with Session(engine) as db, db.begin():
            org = seeded['org']
            shared = db.get(Site, identifier(org, 'site'))
            # Leave the shared site with only an orphan floor: its retention
            # must not accidentally depend on another live terrain floor.
            terrain_site = Site(org_id=org, name='paired terrain', purpose='SIM')
            db.add(terrain_site); db.flush()
            terrain_floor = db.get(Floor, UUID(terrain_pair['floor_id']))
            db.get(Building, terrain_floor.building_id).site_id = terrain_site.id
            fixtures = {}
            for label in ('removed', 'factory', 'v5', 'human', 'REAL', 'robot', 'run', 'session', 'shared'):
                site = shared if label == 'shared' else Site(org_id=org, name=label,
                    purpose='REAL' if label == 'REAL' else 'SIM')
                if label != 'shared':
                    db.add(site); db.flush()
                building = Building(org_id=org, site_id=site.id, name=label,
                    sim_world_id='factory_zone' if label == 'factory' else 'v5_building' if label == 'v5' else
                    'removed-session' if label == 'session' else 'rubble-' + label)
                db.add(building); db.flush()
                floor = Floor(org_id=org, building_id=building.id, name=label, level=1,
                    provenance='HUMAN' if label == 'human' else 'SIMULATION')
                db.add(floor); db.flush()
                fixtures[label] = (site.id, building.id, floor.id)
            for fid in (ordinary_floor, active_floor, pending_floor, terrain_pair['floor_id']):
                floor = db.get(Floor, UUID(fid))
                floor.provenance = 'SIMULATION'
                building = db.get(Building, floor.building_id)
                building.sim_world_id = 'rubble-' + str(floor.id)
                db.get(Site, building.site_id).purpose = 'SIM'
            db.get(Robot, seeded['robots']['mine']).last_floor_id = fixtures['robot'][2]
            db.add(Robot(org_id=org, name='synthetic active slot', model='unitree_go2',
                agent_token_hash=b'fake', simulation=True, sim_state='RUNNING', sim_world_id='removed-session'))
            db.add(Run(id=uuid4(), org_id=org, robot_id=seeded['robots']['theirs'], simulation=True,
                floor_id=fixtures['run'][2], started_by=seeded['users']['one'], device_id=uuid4(),
                surface='pc', screen_id=uuid4(), agent_instance_id=uuid4(), status='PAUSED', plan={}))
            # These empty containers belong to another feature; repair is scoped
            # to removed-world buildings and their parents.
            unrelated = Site(org_id=org, name='unrelated empty SIM', purpose='SIM')
            db.add(unrelated); db.flush()
            unrelated_id = unrelated.id
            history = {model: set(db.scalars(select(model.id))) for model in
                (Site, Building, Floor, Scenario, ScenarioVersion, MapVersion)}
            original_pair = db.get(Floor, UUID(terrain_pair['floor_id'])).approved_version_id

        def run_repair():
            if repair == 'migration':
                command.upgrade(config, 'head')
            else:
                sync(http, seeded, world_folder, files)

        run_repair()
        with Session(engine) as db:
            for label in ('removed', 'shared'):
                site_id, building_id, floor_id = fixtures[label]
                assert db.get(Floor, floor_id).archived_at
                assert db.get(Building, building_id).archived_at
                assert bool(db.get(Site, site_id).archived_at) == (label != 'shared')
            for label in ('factory', 'v5', 'human', 'REAL', 'robot', 'run', 'session'):
                assert all(db.get(model, key).archived_at is None for model, key in
                    zip((Site, Building, Floor), fixtures[label]))
            assert db.get(Floor, UUID(ordinary_floor)).archived_at
            for fid in (active_floor, pending_floor, terrain_pair['floor_id']):
                assert db.get(Floor, UUID(fid)).archived_at is None
            assert db.get(Floor, UUID(terrain_pair['floor_id'])).approved_version_id == original_pair
            assert db.get(Terrain, (SPEC['id'], org)).archived_at is None
            assert db.get(Site, unrelated_id).archived_at is None
            for model, ids in history.items():
                assert set(db.scalars(select(model.id))) >= ids  # Hard deletes: zero.
            journal = list(db.scalars(select(Event).where(Event.code == 'SIM_PAIR_REPAIRED')))
            assert journal and all('before' in e.data and 'after' in e.data for e in journal)
            assert all(e.data.get('migration') == '0028' if repair == 'migration' else
                e.data.get('origin') == 'sync_worlds' for e in journal)
            before = {model: list(db.execute(select(model.id, model.archived_at).order_by(model.id)))
                for model in (Site, Building, Floor)}
            event_ids = {e.id for e in journal}
        if repair == 'migration':
            command.downgrade(config, '0027')  # Keeps repaired data and journal.
        run_repair()
        with Session(engine) as db:
            for model, rows in before.items():
                assert list(db.execute(select(model.id, model.archived_at).order_by(model.id))) == rows
            assert set(db.scalars(select(Event.id).where(Event.code == 'SIM_PAIR_REPAIRED'))) == event_ids
        # Parent-first trash recovery still exposes the immutable scenario.
        with Session(engine) as db:
            floor = db.get(Floor, UUID(ordinary_floor))
            building = db.get(Building, floor.building_id)
            restore = [('site', building.site_id), ('building', building.id), ('floor', floor.id)]
        for kind, key in restore:
            assert http.post(P + f'/trash/{kind}/{key}/restore', headers=headers).status_code == 204
        assert http.get(P + '/scenarios/' + ordinary['id'], headers=headers).status_code == 200
    finally:
        command.upgrade(config, 'head')
        engine.dispose()


def test_world_identity_includes_packaged_and_connected_gazebo_only_worlds():
    worlds = supported_world_ids()
    assert {'warehouse', 'factory_zone', 'collapsed_house_v2', 'v5_building'} <= worlds
    assert 'rubble' not in worlds


def test_connected_catalogue_supplements_static_and_sync_is_tenant_scoped(
        maps, seeded, world_folder, connected_folder):
    http, _, files = maps
    sync(http, seeded, world_folder, files)
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with Session(engine) as db, db.begin():
            from apps.server.fh_server.models import User
            foreign_org = db.get(User, seeded['users']['foreign']).org_id
            site = Site(org_id=foreign_org, name='foreign orphan', purpose='SIM')
            db.add(site); db.flush()
            building = Building(org_id=foreign_org, site_id=site.id, name='foreign', sim_world_id='rubble')
            db.add(building); db.flush()
            floor = Floor(org_id=foreign_org, building_id=building.id, name='foreign', level=1,
                provenance='SIMULATION')
            db.add(floor); db.flush()
            foreign_floor = floor.id
        assert len(sync(http, seeded, connected_folder, files)) == 2
        with Session(engine) as db:
            floors = list(db.scalars(select(Floor).where(Floor.org_id == seeded['org'])))
            assert len(floors) == 3 and all(f.archived_at is None for f in floors)
            assert db.get(Floor, foreign_floor).archived_at is None
    finally:
        engine.dispose()

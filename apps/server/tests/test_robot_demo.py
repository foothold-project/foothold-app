"""Robot demo flag: simulation-only, carried by list and detail, migration round trip."""
from alembic import command
from alembic.config import Config
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.models import Base, Robot
from apps.server.tests.test_simulation import simulation_context, clean_ros_environment, isolated_manager_startup  # noqa: F401
from .conftest import CONFIG
from .postgres import temporary_postgres
from .test_api import csrf


def demo_of(client, headers, rid):
    listed = client.get('/api/v1/robots?scope=all', headers=headers)
    assert listed.status_code == 200
    item = next(r for r in listed.json()['items'] if r['id'] == str(rid))
    detail = client.get(f'/api/v1/robots/{rid}', headers=headers)
    assert detail.status_code == 200
    return item['demo'], detail.json()['demo']


def start(client, headers, rid, **extra):
    return client.post('/api/v1/simulation/robots', headers=headers,
                       json=dict(world_id='test', robot_id=rid, **extra))


def test_real_robot_defaults_false_and_rejects_demo(client, seeded):
    headers = csrf(client, 'one')
    rid = seeded['robots']['mine']
    assert demo_of(client, headers, rid) == (False, False)
    refused = client.patch(f'/api/v1/robots/{rid}', headers=headers, json={'demo': True})
    assert refused.status_code == 409
    assert refused.json()['error']['code'] == 'DEMO_REQUIRES_SIMULATION'
    assert demo_of(client, headers, rid) == (False, False)
    # The database keeps the same rule for any writer that skips the API.
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, rid).demo = True
        with pytest.raises(IntegrityError):
            db.commit()


def test_sim_start_default_false(simulation_context):
    client, sim, cfg, rid, launcher = simulation_context
    headers = csrf(client, 'one')
    assert start(client, headers, rid).status_code == 201
    assert demo_of(client, headers, rid) == (False, False)


def test_sim_start_demo_true_is_listed_and_released(simulation_context):
    client, sim, cfg, rid, launcher = simulation_context
    headers = csrf(client, 'one')
    assert start(client, headers, rid, demo=True).status_code == 201
    assert demo_of(client, headers, rid) == (True, True)
    assert demo_of(client, csrf(client, 'admin'), rid) == (True, True)
    assert client.delete(f'/api/v1/simulation/robots/{rid}', headers=csrf(client, 'one')).status_code == 204
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, rid).demo is False


def test_sim_robot_patch_switches_demo(simulation_context):
    client, sim, cfg, rid, launcher = simulation_context
    assert start(client, csrf(client, 'one'), rid).status_code == 201
    # Existing ROBOT_WRITE rule: simulation robots are edited by the org admin.
    headers = csrf(client, 'admin')
    patched = client.patch(f'/api/v1/robots/{rid}', headers=headers, json={'demo': True})
    assert patched.status_code == 200 and patched.json()['demo'] is True
    assert demo_of(client, headers, rid) == (True, True)
    assert client.patch(f'/api/v1/robots/{rid}', headers=headers, json={'demo': False}).json()['demo'] is False


def test_demo_migration_round_trip(monkeypatch):
    with temporary_postgres() as urls:
        monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', urls['migrate'])
        config = Config(str(CONFIG))
        engine = create_engine(urls['migrate'])
        try:
            command.upgrade(config, '0035')
            with engine.begin() as conn:
                org = conn.scalar(text("INSERT INTO organizations(name) VALUES ('synthetic demo migration') RETURNING id"))
                rid = conn.scalar(text("""INSERT INTO robots(org_id,name,model,agent_token_hash,simulation)
                    VALUES (:org,'sim','unitree_go2',decode('00','hex'),true) RETURNING id"""), {'org': org})
            command.upgrade(config, '0039')
            with engine.begin() as conn:
                assert conn.scalar(text('SELECT demo FROM robots WHERE id=:id'), {'id': rid}) is False
                conn.execute(text('UPDATE robots SET demo=true WHERE id=:id'), {'id': rid})
                assert conn.scalar(text("SELECT has_column_privilege('fh_app', 'robots', 'demo', 'UPDATE')"))
            with pytest.raises(IntegrityError), engine.begin() as conn:
                conn.execute(text("""INSERT INTO robots(org_id,name,model,agent_token_hash,demo)
                    VALUES (:org,'real','unitree_go2',decode('00','hex'),true)"""), {'org': org})
            command.downgrade(config, '0035')
            assert 'demo' not in {c['name'] for c in inspect(engine).get_columns('robots')}
            command.upgrade(config, 'head')
            with engine.connect() as conn:
                assert conn.scalar(text('SELECT demo FROM robots WHERE id=:id'), {'id': rid}) is False
                assert compare_metadata(MigrationContext.configure(conn), Base.metadata) == []
        finally:
            engine.dispose()

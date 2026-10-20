from alembic import command
from alembic.config import Config
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from apps.server.fh_server.models import Base
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
import pytest

from .conftest import CONFIG
from .postgres import temporary_postgres


def test_alembic_upgrade_downgrade_upgrade(monkeypatch):
    with temporary_postgres() as urls:
        monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', urls['migrate'])
        config = Config(str(CONFIG))
        engine = create_engine(urls['migrate'])
        try:
            command.upgrade(config, '0001')
            with engine.begin() as conn:
                org = conn.scalar(text("INSERT INTO organizations(name) VALUES ('시험 조직') RETURNING id"))
                user = conn.scalar(text("""INSERT INTO users(org_id, username, display_name, role, password_hash)
                    VALUES (:org, 'fake', '시험', 'OPERATOR', 'fake-test-hash') RETURNING id"""), {'org': org})
                conn.execute(text("""INSERT INTO sessions(org_id, user_id, token_hash, client, device_label, expires_at)
                    VALUES (:org, :user, decode('00', 'hex'), 'web', '', now() + interval '1 day')"""),
                    {'org': org, 'user': user})
            command.upgrade(config, 'head')
            with engine.connect() as conn:
                assert conn.scalar(text('SELECT retired_refresh_hashes FROM sessions')) == []
            command.downgrade(config, '0002')
            assert 'auth_rate_windows' not in inspect(engine).get_table_names()
            with engine.connect() as conn:
                assert conn.scalar(text('SELECT count(*) FROM sessions')) == 1
                assert conn.scalar(text('SELECT retired_refresh_hashes FROM sessions')) == []
            command.upgrade(config, 'head')
            command.downgrade(config, '0001')
            assert 'retired_refresh_hashes' not in {c['name'] for c in inspect(engine).get_columns('sessions')}
            with engine.connect() as conn:
                assert conn.scalar(text('SELECT count(*) FROM sessions')) == 1
            command.upgrade(config, 'head')
            expected = {'organizations', 'users', 'sessions', 'robots', 'events', 'auth_rate_windows', 'lease_log', 'robot_devices', 'notifications', 'alembic_version'}
            assert set(inspect(engine).get_table_names()) == expected
            command.downgrade(config, 'base')
            assert set(inspect(engine).get_table_names()) == {'alembic_version'}
            command.upgrade(config, 'head')
            assert set(inspect(engine).get_table_names()) == expected
            with engine.connect() as conn:
                assert compare_metadata(MigrationContext.configure(conn), Base.metadata) == []
                assert conn.scalar(text("SELECT has_table_privilege('fh_app', 'events', 'INSERT')"))
                assert not conn.scalar(text("SELECT has_table_privilege('fh_app', 'events', 'UPDATE')"))
                assert not conn.scalar(text("SELECT has_table_privilege('fh_app', 'events', 'DELETE')"))
            print('alembic upgrade head -> downgrade base -> upgrade head: PASS')
        finally:
            engine.dispose()


def test_reused_archived_name_rejects_downgrade_atomically(monkeypatch):
    with temporary_postgres() as urls:
        monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', urls['migrate'])
        config = Config(str(CONFIG))
        engine = create_engine(urls['migrate'])
        try:
            command.upgrade(config, 'head')
            with engine.begin() as conn:
                org = conn.scalar(text("INSERT INTO organizations(name) VALUES ('reuse regression') RETURNING id"))
                conn.execute(text("""INSERT INTO robots(org_id, name, model, agent_token_hash, archived_at)
                    VALUES (:org, 'reused', 'unitree_go2', decode('00', 'hex'), now()),
                           (:org, 'reused', 'unitree_go2', decode('01', 'hex'), NULL)"""), {'org': org})
                before = conn.execute(text('SELECT id, name, archived_at FROM robots ORDER BY id')).all()
            with pytest.raises(IntegrityError):
                command.downgrade(config, '0006')
            with engine.connect() as conn:
                assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0008'
                assert conn.execute(text('SELECT id, name, archived_at FROM robots ORDER BY id')).all() == before
                assert conn.scalar(text("SELECT to_regclass('robots_active_org_name')")) == 'robots_active_org_name'
                assert conn.scalar(text("SELECT count(*) FROM pg_constraint WHERE conname='robots_org_id_name_key'")) == 0
            with engine.begin() as conn:
                conn.execute(text("UPDATE robots SET name='reconciled archive' WHERE archived_at IS NOT NULL"))
            command.downgrade(config, '0006')
            with engine.connect() as conn:
                assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0006'
                assert conn.scalar(text("SELECT to_regclass('robots_active_org_name')")) is None
                assert conn.scalar(text("SELECT count(*) FROM pg_constraint WHERE conname='robots_org_id_name_key'")) == 1
                assert conn.scalar(text('SELECT count(*) FROM robots')) == 2
            command.upgrade(config, 'head')
            with engine.connect() as conn:
                assert compare_metadata(MigrationContext.configure(conn), Base.metadata) == []
                assert conn.scalar(text('SELECT count(*) FROM robots')) == 2
        finally:
            engine.dispose()

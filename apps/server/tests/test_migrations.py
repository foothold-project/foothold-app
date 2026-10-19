from alembic import command
from alembic.config import Config
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from apps.server.fh_server.models import Base
from sqlalchemy import create_engine, inspect, text

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
            expected = {'organizations', 'users', 'sessions', 'robots', 'events', 'auth_rate_windows', 'lease_log', 'alembic_version'}
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

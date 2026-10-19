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
            command.upgrade(config, 'head')
            expected = {'organizations', 'users', 'sessions', 'robots', 'events', 'alembic_version'}
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

"""Same placeholder boundary in SQL predicates, database migration and confirm."""
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.schema import CreateIndex
from sqlalchemy.exc import IntegrityError
import pytest

from apps.server.fh_server.models import Robot
from .conftest import CONFIG
from .postgres import temporary_postgres


@pytest.mark.parametrize('serial,placeholder', [
    ('1-2', False), ('429490175-2', False), ('4294901759-2', False),
    ('4294901760-0', True), ('4294901761-123', True), ('4294967295-4294967295', True),
    ('429496729-5', False), ('429496730-1', False), ('999999999-1', False)])
def test_index_predicate_has_same_meaning_sqlite_and_postgres(migrated, serial, placeholder):
    index = next(i for i in Robot.__table__.indexes if i.name == 'robots_active_serial')
    predicate = str(index.dialect_options['postgresql']['where'])
    assert predicate == str(index.dialect_options['sqlite']['where'])
    prefix = serial.split('-')[0]
    assert (len(prefix) == 10 and 0xFFFF0000 <= int(prefix) <= 0xFFFFFFFF) is placeholder
    # Canonical uint32 prefixes in the reserved range are fixed-width decimal.
    expected = not placeholder
    for engine in [create_engine('sqlite://'), create_engine(migrated['migrate'])]:
        try:
            with engine.connect() as conn:
                value = conn.scalar(text('SELECT '+predicate+' FROM (SELECT :serial AS serial, NULL AS archived_at) AS sample'),
                                    {'serial':serial})
                assert bool(value) is expected
        finally: engine.dispose()
    for dialect in (postgresql.dialect(), sqlite.dialect()):
        assert 'WHERE '+predicate in str(CreateIndex(index).compile(dialect=dialect))


def test_mac_index_upgrade_downgrade_and_duplicate_downgrade_failure(monkeypatch):
    with temporary_postgres() as urls:
        monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', urls['migrate'])
        config = Config(str(CONFIG)); engine = create_engine(urls['migrate'])
        try:
            command.upgrade(config, '0030')
            with engine.begin() as conn:
                org = conn.scalar(text("INSERT INTO organizations(name) VALUES ('fake index migration') RETURNING id"))
                conn.execute(text("INSERT INTO robots(org_id,name,model,agent_token_hash,serial) VALUES (:org,'before','unitree_go2',decode('00','hex'),'4294901760-17')"), {'org':org})
            command.upgrade(config, 'head')
            command.downgrade(config, '0030')  # no duplicates: reversible
            command.upgrade(config, 'head')
            with engine.begin() as conn:
                conn.execute(text("INSERT INTO robots(org_id,name,model,agent_token_hash,serial) VALUES (:org,'after','unitree_go2',decode('01','hex'),'4294901760-17')"), {'org':org})
                conn.execute(text("INSERT INTO robots(org_id,name,model,agent_token_hash,serial) VALUES (:org,'real','unitree_go2',decode('02','hex'),'4294901759-17')"), {'org':org})
            with pytest.raises(IntegrityError):
                with engine.begin() as conn:
                    conn.execute(text("INSERT INTO robots(org_id,name,model,agent_token_hash,serial) VALUES (:org,'other real','unitree_go2',decode('03','hex'),'4294901759-17')"), {'org':org})
            with pytest.raises(IntegrityError): command.downgrade(config, '0030')
            with engine.connect() as conn:
                assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0031'
                assert conn.scalar(text("SELECT count(*) FROM robots WHERE serial='4294901760-17'")) == 2
            # Failed transactional downgrade leaves the new index usable.
            command.upgrade(config, 'head')
        finally: engine.dispose()

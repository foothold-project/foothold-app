"""Keep receipt evidence intact across schema changes and refused rollback."""
from alembic import command
from alembic.config import Config
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError

from .conftest import CONFIG
from .postgres import temporary_postgres


def test_received_only_upgrade_preserves_rows_and_downgrade_refuses_live_receipts(monkeypatch):
    with temporary_postgres() as urls:
        monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', urls['migrate'])
        config = Config(str(CONFIG))
        engine = create_engine(urls['migrate'])
        try:
            command.upgrade(config, '0032')
            with engine.begin() as conn:
                org = conn.scalar(text("INSERT INTO organizations(name) VALUES ('synthetic receipt migration') RETURNING id"))
                user = conn.scalar(text("""INSERT INTO users(org_id,username,display_name,role,password_hash)
                    VALUES (:org,'receipt-owner','synthetic','OPERATOR','synthetic') RETURNING id"""), {'org': org})
                robot = conn.scalar(text("""INSERT INTO robots(org_id,name,model,agent_token_hash)
                    VALUES (:org,'synthetic','unitree_go2',decode('00','hex')) RETURNING id"""), {'org': org})
                site = conn.scalar(text("INSERT INTO sites(org_id,name) VALUES (:org,'synthetic') RETURNING id"), {'org': org})
                building = conn.scalar(text("""INSERT INTO buildings(org_id,site_id,name)
                    VALUES (:org,:site,'synthetic') RETURNING id"""), {'org': org, 'site': site})
                floor = conn.scalar(text("""INSERT INTO floors(org_id,building_id,name,level)
                    VALUES (:org,:building,'synthetic',1) RETURNING id"""), {'org': org, 'building': building})
                sid = conn.scalar(text("""INSERT INTO mapping_sessions(id,org_id,robot_id,floor_id,owner_id,status,progress,result,created_at)
                    VALUES (gen_random_uuid(),:org,:robot,:floor,:owner,'SAVED','{"source":"legacy"}','{"synthetic": true}',now()) RETURNING id"""),
                    {'org': org, 'robot': robot, 'floor': floor, 'owner': user})
                before = conn.execute(text('SELECT * FROM mapping_sessions WHERE id=:id'), {'id': sid}).one()
            command.upgrade(config, '0033')
            with engine.begin() as conn:
                assert conn.execute(text('SELECT * FROM mapping_sessions WHERE id=:id'), {'id': sid}).one() == before
                conn.execute(text("UPDATE mapping_sessions SET status='RECEIVED_ONLY' WHERE id=:id"), {'id': sid})
            with pytest.raises(IntegrityError):
                command.downgrade(config, '0032')
            with engine.connect() as conn:
                assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0033'
                row = conn.execute(text('SELECT status,progress,result FROM mapping_sessions WHERE id=:id'), {'id': sid}).one()
                assert tuple(row) == ('RECEIVED_ONLY', {'source': 'legacy'}, {'synthetic': True})
            # With no receipts to lose, the constraint can round-trip normally.
            with engine.begin() as conn:
                conn.execute(text('DELETE FROM mapping_sessions WHERE id=:id'), {'id': sid})
            command.downgrade(config, '0032')
            command.upgrade(config, '0033')
        finally:
            engine.dispose()

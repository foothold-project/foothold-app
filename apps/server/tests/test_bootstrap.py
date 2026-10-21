from uuid import uuid4

import psycopg
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from apps.server.fh_server import bootstrap
from apps.server.fh_server.models import Organization, User
from apps.server.fh_server.security import verify_password
from .postgres import temporary_postgres


def test_role_bootstrap_and_existing_role_refusal(monkeypatch):
    with temporary_postgres() as urls:
        dsn = urls['admin'].replace('postgresql+psycopg://', 'postgresql://')
        with psycopg.connect(dsn) as conn:
            conn.execute('DROP OWNED BY fh_migrate, fh_app, fh_readonly')
            conn.execute('DROP ROLE fh_migrate, fh_app, fh_readonly')
        monkeypatch.setenv('FH_BOOTSTRAP_DATABASE_DSN', dsn)
        for name in ('FH_APP_PASSWORD', 'FH_MIGRATE_PASSWORD', 'FH_READONLY_PASSWORD'):
            monkeypatch.setenv(name, 'fake-test-password')
        bootstrap.roles()
        with psycopg.connect(dsn) as conn:
            rows = conn.execute("SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit "
                                "FROM pg_roles WHERE rolname IN ('fh_app','fh_migrate','fh_readonly')").fetchall()
            assert len(rows) == 3
            assert all(row[1:] == (False, False, False, False) for row in rows)
        with pytest.raises(ValueError, match='already exists'):
            bootstrap.roles()


def test_organization_bootstrap_does_not_overwrite(migrated, monkeypatch):
    org_id = uuid4()
    for name, value in {
        'FH_MIGRATE_DATABASE_URL': migrated['migrate'], 'FH_ORG_ID': str(org_id),
        'FH_ORG_NAME': '가짜 새 조직', 'FH_BOOTSTRAP_USERNAME': 'fake-initial-admin',
        'FH_BOOTSTRAP_DISPLAY_NAME': '시험 총괄', 'FH_BOOTSTRAP_PASSWORD': 'fake-initial-password',
    }.items():
        monkeypatch.setenv(name, value)
    bootstrap.organization()
    engine = create_engine(migrated['migrate'])
    with Session(engine) as db:
        assert db.get(Organization, org_id).name == '가짜 새 조직'
        user = db.scalar(select(User).where(User.org_id == org_id))
        assert user.role == 'ORG_ADMIN'
        assert verify_password('fake-initial-password', user.password_hash)
    engine.dispose()
    with pytest.raises(ValueError, match='already exists'):
        bootstrap.organization()

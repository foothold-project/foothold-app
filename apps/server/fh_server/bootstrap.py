"""Explicit one-time setup, with credentials supplied only by environment."""
import argparse
import os
from uuid import UUID

import psycopg
from psycopg import sql
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from .models import Organization, User
from .security import hash_password


def roles():
    # This administrative connection is never used by the API process.
    with psycopg.connect(os.environ['FH_BOOTSTRAP_DATABASE_DSN']) as conn:
        for name, variable in [('fh_migrate', 'FH_MIGRATE_PASSWORD'),
                               ('fh_app', 'FH_APP_PASSWORD'),
                               ('fh_readonly', 'FH_READONLY_PASSWORD')]:
            password = os.environ[variable]
            if not password:
                raise ValueError(f'{variable} must not be empty')
            if conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (name,)).fetchone():
                raise ValueError(f'{name} already exists; audit existing grants before reusing it')
            conn.execute(sql.SQL('CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD {}')
                         .format(sql.Identifier(name), sql.Literal(password)))
        conn.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
        conn.execute('GRANT USAGE, CREATE ON SCHEMA public TO fh_migrate')
    print('Database roles created; run Alembic with fh_migrate.')


def organization():
    engine = create_engine(os.environ['FH_MIGRATE_DATABASE_URL'])
    if engine.dialect.name != 'postgresql':
        raise ValueError('PostgreSQL is required')
    try:
        with Session(engine) as db:
            org_id = UUID(os.environ['FH_ORG_ID'])
            if db.get(Organization, org_id):
                raise ValueError('Organization already exists; bootstrap will not overwrite it')
            org = Organization(id=org_id, name=os.environ['FH_ORG_NAME'], settings={})
            db.add(org)
            db.flush()
            db.add(User(org_id=org_id, username=os.environ['FH_BOOTSTRAP_USERNAME'],
                display_name=os.environ['FH_BOOTSTRAP_DISPLAY_NAME'], role='ORG_ADMIN',
                password_hash=hash_password(os.environ['FH_BOOTSTRAP_PASSWORD'])))
            db.commit()
    finally:
        engine.dispose()
    print('Organization and initial administrator created.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['roles', 'organization'])
    args = parser.parse_args()
    roles() if args.action == 'roles' else organization()

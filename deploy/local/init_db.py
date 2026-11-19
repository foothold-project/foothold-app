"""Local compose only: run the documented one-time server setup, skipping what exists.

Same three steps as apps/server/README.md (bootstrap roles, alembic upgrade head,
bootstrap organization). The bootstrap functions refuse to reuse an existing role
or organization; a local restart should not fail on that, so this script checks
first and only calls them for what is missing. Never used against a shared or
production database (the admin DSN comes from deploy/local/.env).
"""
import os
from pathlib import Path
import subprocess
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import psycopg  # noqa: E402
from apps.server.fh_server import bootstrap  # noqa: E402

ROLES = ('fh_migrate', 'fh_app', 'fh_readonly')


def main():
    with psycopg.connect(os.environ['FH_BOOTSTRAP_DATABASE_DSN']) as conn:
        present = {name for (name,) in conn.execute(
            'SELECT rolname FROM pg_roles WHERE rolname = ANY(%s)', (list(ROLES),))}
    if not present:
        bootstrap.roles()
    elif present != set(ROLES):
        raise SystemExit(f'partial local roles {sorted(present)}; reset the db volume')
    else:
        print('roles: already present')
    subprocess.run(['alembic', '-c', str(ROOT/'apps/server/alembic.ini'), 'upgrade', 'head'],
                   cwd=ROOT, check=True)
    with psycopg.connect(os.environ['FH_BOOTSTRAP_DATABASE_DSN']) as conn:
        exists = conn.execute('SELECT 1 FROM organizations WHERE id = %s',
                              (UUID(os.environ['FH_ORG_ID']),)).fetchone()
    if exists:
        print('organization: already present')
    else:
        bootstrap.organization()


if __name__ == '__main__':
    main()

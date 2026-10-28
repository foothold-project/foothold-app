"""Inject migration/seed credentials into this short-lived process only."""
import os
from pathlib import Path
import shlex
import subprocess
import sys


def read_env(path):
    return dict(line.split('=', 1) for line in shlex.split(Path(path).read_text(), comments=True))


def main():
    config = read_env('/etc/foothold/server.env')
    password = read_env('/etc/foothold/database.env')['FH_MIGRATE_PASSWORD']
    url = f'postgresql+psycopg://fh_migrate:{password}@127.0.0.1/foothold'
    os.environ['FH_MIGRATE_DATABASE_URL'] = url
    # No DSN is passed on argv or saved as an administrator connection string.
    subprocess.run([sys.executable, '-m', 'alembic', '-c', 'apps/server/alembic.ini', 'upgrade', 'head'], check=True, capture_output=True)
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from uuid import UUID
    from apps.server.fh_server.models import Organization
    engine = create_engine(url)
    try:
        with Session(engine) as db:
            exists = db.get(Organization, UUID(config['FH_ORG_ID'])) is not None
    finally:
        engine.dispose()
    if not exists:
        os.environ.update(config)
        os.environ.update(read_env('/root/foothold-initial-admin.txt'))
        from apps.server.fh_server.bootstrap import organization
        organization()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # SQLAlchemy errors can include connection strings or SQL parameters.
        raise SystemExit('Migration/seed failed; credentials and SQL details suppressed') from None

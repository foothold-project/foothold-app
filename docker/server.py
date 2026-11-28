"""Local Compose only: initialize a private database, then exec the API."""
import os
from pathlib import Path
import subprocess
import sys
from uuid import UUID

import psycopg
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from apps.server.fh_server import bootstrap
from apps.server.fh_server.models import Organization


ROLES = ('fh_app', 'fh_migrate', 'fh_readonly')
# Compose service name, or this machine on a non-default port (5432 is a system DB).
LOCAL_HOSTS = ('db', '127.0.0.1', 'localhost', '::1')


def configuration():
    for key in ('FH_DB_USER', 'FH_DB_NAME', 'FH_DB_PASSWORD', 'FH_DATABASE_URL',
                'FH_ORG_ID', 'FH_ORG_NAME', 'FH_BOOTSTRAP_USERNAME',
                'FH_BOOTSTRAP_DISPLAY_NAME', 'FH_BOOTSTRAP_PASSWORD'):
        if not os.environ.get(key, '').strip():
            raise ValueError(f'.env의 {key} 값을 채우세요')
    UUID(os.environ['FH_ORG_ID'])
    url = make_url(os.environ['FH_DATABASE_URL'])
    # This entrypoint must never initialize a remote or pre-existing service DB.
    if (url.drivername != 'postgresql+psycopg' or url.host not in LOCAL_HOSTS
            or url.port is None or (url.host == 'db') != (url.port == 5432)
            or url.username != 'fh_app' or url.query
            or url.database != os.environ['FH_DB_NAME']
            or os.environ['FH_DB_USER'] in ROLES):
        raise ValueError('로컬 db:5432 또는 127.0.0.1:<포트>의 fh_app 주소와 별도 초기 관리자 이름을 사용하세요')
    password = os.environ['FH_DB_PASSWORD']
    return (url.set(password=password), url.set(username='fh_migrate', password=password),
            url.set(drivername='postgresql', username=os.environ['FH_DB_USER'], password=password))


def initialize(app_url, migrate_url, admin_url):
    """Reuses data on restart; never rotates passwords or overwrites accounts."""
    with psycopg.connect(admin_url.render_as_string(hide_password=False)) as conn:
        existing = {row[0] for row in conn.execute(
            'SELECT rolname FROM pg_roles WHERE rolname = ANY(%s)', (list(ROLES),))}
    if not existing:
        os.environ['FH_BOOTSTRAP_DATABASE_DSN'] = admin_url.render_as_string(hide_password=False)
        for key in ('FH_APP_PASSWORD', 'FH_MIGRATE_PASSWORD', 'FH_READONLY_PASSWORD'):
            os.environ[key] = os.environ['FH_DB_PASSWORD']
        bootstrap.roles()
    elif existing != set(ROLES):
        raise ValueError('로컬 DB 역할이 일부만 있습니다; 전용 volume 상태를 확인하세요')

    os.environ['FH_MIGRATE_DATABASE_URL'] = migrate_url.render_as_string(hide_password=False)
    # Capture SQLAlchemy/Alembic failures: they can contain credentials or SQL data.
    subprocess.run([sys.executable, '-m', 'alembic', '-c', 'apps/server/alembic.ini',
                    'upgrade', 'head'], check=True, capture_output=True)
    engine = create_engine(migrate_url)
    try:
        with Session(engine) as db:
            exists = db.get(Organization, UUID(os.environ['FH_ORG_ID'])) is not None
    finally:
        engine.dispose()
    if not exists:
        bootstrap.organization()
    os.environ['FH_DATABASE_URL'] = app_url.render_as_string(hide_password=False)


def api_port():
    value = os.environ.get('FH_PORT', '8810')
    if not value.isdigit() or not 1 <= int(value) <= 65535:
        raise ValueError('.env의 FH_PORT 값을 1..65535 숫자로 채우세요')
    return value


def run_seed():
    from docker import seed
    passwords = {key: os.environ.get(key, '') for key in
                 (seed.password_key(name) for name, *_ in seed.ACCOUNTS)}
    seed.seed(os.environ['FH_DATABASE_URL'], UUID(os.environ['FH_ORG_ID']), os.environ['FH_FILES_ROOT'],
              os.environ['FH_BOOTSTRAP_USERNAME'], passwords)


def main():
    try:
        port = api_port()
        initialize(*configuration())
        Path(os.environ['FH_FILES_ROOT']).mkdir(parents=True, exist_ok=True)
        if os.environ.get('FH_SEED') == '1':
            run_seed()
    except ValueError as error:
        # Only our own validation messages are safe; DB/library errors are not.
        if str(error).startswith(('.env의 ', '로컬 ')):
            raise SystemExit(str(error)) from None
        raise SystemExit('로컬 DB 초기화 실패; .env와 전용 volume 설정을 확인하세요') from None
    except Exception:
        raise SystemExit('로컬 DB 초기화 실패; .env와 전용 volume 설정을 확인하세요') from None

    for key in list(os.environ):
        if (key.startswith(('FH_BOOTSTRAP_', 'FH_SEED_PASSWORD_')) or key in {
                'FH_DB_PASSWORD', 'FH_MIGRATE_DATABASE_URL', 'FH_APP_PASSWORD',
                'FH_MIGRATE_PASSWORD', 'FH_READONLY_PASSWORD'}):
            del os.environ[key]
    os.execvp(sys.executable, [sys.executable, '-m', 'uvicorn',
        'apps.server.fh_server.main:app', '--host', os.environ.get('FH_API_HOST', '127.0.0.1'),
        '--port', port, '--ws-max-size', '4096', '--workers', '1', '--no-proxy-headers'])


if __name__ == '__main__':
    main()

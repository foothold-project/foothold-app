"""Entrypoint regression checks using a disposable PostgreSQL, without Docker."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
from textwrap import dedent
from uuid import UUID

from fastapi.testclient import TestClient
import psycopg
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from docker import server
from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import User
from apps.server.fh_server.security import verify_password
from apps.server.tests.postgres import temporary_postgres


@pytest.fixture
def server_image_tree(tmp_path):
    """Stage only the Dockerfile's COPY inputs, never the host import tree.

    This checks packaged source paths without building an image. It does not
    implement Docker's build-context filtering or execute RUN instructions.
    Reject COPY syntax we cannot stage rather than silently weakening the test.
    """
    repository = Path(__file__).resolve().parents[1]
    tree = tmp_path / 'workspace'
    tree.mkdir()
    for line in (repository / 'docker/server.Dockerfile').read_text().splitlines():
        parts = shlex.split(line, comments=True)
        if not parts or parts[0].upper() != 'COPY':
            continue
        sources, destination = parts[1:-1], parts[-1]
        assert sources and not destination.startswith('/')
        assert all(not source.startswith(('/', '-', '[')) and
                   not any(char in source for char in '*?') for source in sources)
        for source in sources:
            original = repository / source
            target = tree / destination
            assert original.resolve().is_relative_to(repository)
            assert target.resolve().is_relative_to(tree)
            if original.is_dir():
                shutil.copytree(original, target, dirs_exist_ok=True,
                                ignore=shutil.ignore_patterns('__pycache__', '*.pyc',
                                                             '.venv*', 'node_modules', 'dist'))
            else:
                if destination.endswith('/'):
                    target /= original.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(original, target)
    return tree


def test_image_tree_upgrade_head_and_repository_registration(server_image_tree, tmp_path):
    # A fresh interpreter and -I prevent pytest's sys.path/PYTHONPATH from
    # supplying missing repository files. Alembic adds only its staged root.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('FH_') and key not in ('PYTHONPATH', 'PYTHONHOME')}
    env['FH_FILES_ROOT'] = str(tmp_path / 'files')
    with temporary_postgres() as urls:
        env['FH_MIGRATE_DATABASE_URL'] = urls['migrate']
        result = subprocess.run(
            [sys.executable, '-I', '-m', 'alembic', '-c', 'apps/server/alembic.ini',
             'upgrade', 'head'], cwd=server_image_tree, env=env,
            capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stdout + result.stderr
        # Check the runtime's second reader too; this never starts a simulator.
        result = subprocess.run([sys.executable, '-I', '-c', dedent('''
            import os
            from pathlib import Path
            import sys
            sys.path.insert(0, str(Path.cwd()))

            from alembic.config import Config
            from alembic.script import ScriptDirectory
            from sqlalchemy import create_engine, text
            from apps.server.fh_server import floor_maps

            assert Path(floor_maps.__file__).is_relative_to(Path.cwd())
            meta, width, height = floor_maps.repository_registration('warehouse')
            assert meta['connected_gt']['world_id'] == 'warehouse'
            assert width > 0 and height > 0
            heads = ScriptDirectory.from_config(Config('apps/server/alembic.ini')).get_heads()
            engine = create_engine(os.environ['FH_MIGRATE_DATABASE_URL'])
            try:
                with engine.connect() as connection:
                    assert set(connection.scalars(text('SELECT version_num FROM alembic_version'))) == set(heads)
            finally:
                engine.dispose()
            ''')],
            cwd=server_image_tree, env=env, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stdout + result.stderr


@pytest.fixture
def local_env(monkeypatch, tmp_path):
    values = {
        'FH_DATABASE_URL': 'postgresql+psycopg://fh_app@db:5432/foothold_local',
        'FH_DB_USER': 'local_admin', 'FH_DB_NAME': 'foothold_local',
        'FH_DB_PASSWORD': 'synthetic-$:@/ db password',
        'FH_ORG_ID': '00000000-0000-4000-8000-000000000001',
        'FH_ORG_NAME': '로컬 시험 조직', 'FH_BOOTSTRAP_USERNAME': 'local-admin',
        'FH_BOOTSTRAP_DISPLAY_NAME': '로컬 총괄',
        'FH_BOOTSTRAP_PASSWORD': 'synthetic-initial-password',
        'FH_FILES_ROOT': str(tmp_path / 'files'), 'FH_ROBOT_INSTALLER_ENABLED': '0',
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    # initialize() temporarily populates these; restore them after every case.
    for key in ('FH_BOOTSTRAP_DATABASE_DSN', 'FH_APP_PASSWORD', 'FH_MIGRATE_PASSWORD',
                'FH_READONLY_PASSWORD', 'FH_MIGRATE_DATABASE_URL'):
        monkeypatch.delenv(key, raising=False)
    return values


def test_password_encoding_and_local_target_guard(local_env, monkeypatch):
    app, migrate, admin = server.configuration()
    for url in (app, migrate, admin):
        assert make_url(url.render_as_string(hide_password=False)).password == local_env['FH_DB_PASSWORD']
    assert (app.username, migrate.username, admin.username) == ('fh_app', 'fh_migrate', 'local_admin')
    monkeypatch.setenv('FH_DATABASE_URL', 'postgresql+psycopg://fh_app@external.invalid:5432/foothold_local')
    with pytest.raises(ValueError, match='로컬 db:5432'):
        server.configuration()


@pytest.mark.parametrize('key', ['FH_DB_PASSWORD', 'FH_BOOTSTRAP_PASSWORD'])
def test_blank_password_refused(local_env, monkeypatch, key):
    monkeypatch.setenv(key, '')
    with pytest.raises(ValueError, match=key):
        server.configuration()


@pytest.mark.parametrize('host', [None, '0.0.0.0'])
def test_exec_bind_defaults_and_credentials_removed(local_env, monkeypatch, host):
    if host is None:
        monkeypatch.delenv('FH_API_HOST', raising=False)
    else:
        monkeypatch.setenv('FH_API_HOST', host)
    monkeypatch.setattr(server, 'initialize', lambda *args: None)
    seen = []
    monkeypatch.setattr(os, 'execvp', lambda executable, args: seen.append((args, dict(os.environ))))
    server.main()
    args, env = seen[0]
    assert args[args.index('--host') + 1] == (host or '127.0.0.1')
    assert args[args.index('--port') + 1] == '8810'
    assert not any(key.startswith('FH_BOOTSTRAP_') for key in env)
    assert 'FH_DB_PASSWORD' not in env
    assert 'FH_DATABASE_URL' in env


def test_initialize_login_and_restart_preserves_account(local_env, monkeypatch):
    with temporary_postgres() as urls:
        admin_url = make_url(urls['admin']).set(drivername='postgresql')
        with psycopg.connect(admin_url.render_as_string(hide_password=False)) as conn:
            conn.execute('DROP OWNED BY fh_migrate, fh_app, fh_readonly')
            conn.execute('DROP ROLE fh_migrate, fh_app, fh_readonly')
        app_url, migrate_url = make_url(urls['app']), make_url(urls['migrate'])
        server.initialize(app_url, migrate_url, admin_url)
        settings = Settings(urls['app'], UUID(local_env['FH_ORG_ID']),
                            files_root=local_env['FH_FILES_ROOT'], robot_installer_enabled=False)
        with TestClient(create_app(settings), base_url='https://localhost') as client:
            assert client.get('/openapi.json').status_code == 200
            login = client.post('/api/v1/auth/login', json={
                'username': local_env['FH_BOOTSTRAP_USERNAME'],
                'password': local_env['FH_BOOTSTRAP_PASSWORD'], 'client': 'web'})
            assert login.status_code == 200, login.text
            assert 'Secure' in login.headers['set-cookie']
            assert client.get('/api/v1/me').status_code == 200
        monkeypatch.setenv('FH_BOOTSTRAP_PASSWORD', 'synthetic-replacement-password')
        server.initialize(app_url, migrate_url, admin_url)
        engine = create_engine(migrate_url)
        try:
            with Session(engine) as db:
                users = db.scalars(select(User)).all()
                assert len(users) == 1
                assert verify_password(local_env['FH_BOOTSTRAP_PASSWORD'], users[0].password_hash)
        finally:
            engine.dispose()


def test_partial_roles_refused_without_migration(local_env, monkeypatch):
    with temporary_postgres() as urls:
        admin_url = make_url(urls['admin']).set(drivername='postgresql')
        with psycopg.connect(admin_url.render_as_string(hide_password=False)) as conn:
            conn.execute('DROP ROLE fh_readonly')
        with pytest.raises(ValueError, match='일부만'):
            server.initialize(make_url(urls['app']), make_url(urls['migrate']), admin_url)
        with psycopg.connect(admin_url.render_as_string(hide_password=False)) as conn:
            assert conn.execute("SELECT to_regclass('public.alembic_version')").fetchone()[0] is None


def test_initialization_error_hides_credentials(local_env, monkeypatch):
    def fail(*args):
        raise RuntimeError('synthetic-secret-db-password-and-sql')
    monkeypatch.setattr(server, 'initialize', fail)
    with pytest.raises(SystemExit) as error:
        server.main()
    assert 'synthetic-secret' not in str(error.value)
    assert '로컬 DB 초기화 실패' in str(error.value)


@pytest.mark.parametrize('address', ['127.0.0.1:55491', 'localhost:55491', 'db:5432'])
def test_loopback_database_address_allowed(local_env, monkeypatch, address):
    monkeypatch.setenv('FH_DATABASE_URL', f'postgresql+psycopg://fh_app@{address}/foothold_local')
    app, migrate, admin = server.configuration()
    assert f'{app.host}:{app.port}' == address == f'{admin.host}:{admin.port}'


@pytest.mark.parametrize('address', ['external.invalid:5432', '10.0.0.5:5432', '127.0.0.1', '127.0.0.1:5432', 'db:55491'])
def test_remote_or_portless_database_refused(local_env, monkeypatch, address):
    monkeypatch.setenv('FH_DATABASE_URL', f'postgresql+psycopg://fh_app@{address}/foothold_local')
    with pytest.raises(ValueError, match='로컬 db:5432'):
        server.configuration()


@pytest.mark.parametrize('port, expected', [(None, '8810'), ('18895', '18895')])
def test_api_port_from_environment(local_env, monkeypatch, port, expected):
    if port is None:
        monkeypatch.delenv('FH_PORT', raising=False)
    else:
        monkeypatch.setenv('FH_PORT', port)
    monkeypatch.setattr(server, 'initialize', lambda *args: None)
    seen = []
    monkeypatch.setattr(os, 'execvp', lambda executable, args: seen.append(args))
    server.main()
    assert seen[0][seen[0].index('--port') + 1] == expected


@pytest.mark.parametrize('port', ['0', '70000', 'http', '88 10'])
def test_invalid_api_port_refused(local_env, monkeypatch, port):
    monkeypatch.setenv('FH_PORT', port)
    monkeypatch.setattr(server, 'initialize', lambda *args: None)
    monkeypatch.setattr(os, 'execvp', lambda *args: pytest.fail('must not exec'))
    with pytest.raises(SystemExit, match='FH_PORT'):
        server.main()


def test_seed_runs_only_when_requested_and_passwords_removed(local_env, monkeypatch):
    from docker import seed
    monkeypatch.setattr(server, 'initialize', lambda *args: None)
    calls, seen = [], []
    monkeypatch.setattr(seed, 'seed', lambda *args: calls.append(args))
    monkeypatch.setattr(os, 'execvp', lambda executable, args: seen.append(dict(os.environ)))
    server.main()
    assert calls == []
    for key, value in local_env.items():  # main() strips credentials before exec
        monkeypatch.setenv(key, value)
    monkeypatch.setenv('FH_SEED', '1')
    for name, *_ in seed.ACCOUNTS:
        monkeypatch.setenv(seed.password_key(name), 'synthetic-seed-password')
    server.main()
    url, org, files, admin, passwords = calls[0]
    assert (str(org), admin) == (local_env['FH_ORG_ID'], 'local-admin')
    assert set(passwords) == {seed.password_key(name) for name, *_ in seed.ACCOUNTS}
    assert not any(key.startswith('FH_SEED_PASSWORD_') for key in seen[-1])

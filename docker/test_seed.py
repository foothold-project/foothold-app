"""Local seed: role accounts, a sim robot slot and repository worlds, run twice."""
from pathlib import Path
import stat
from uuid import UUID

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from docker import seed, server
from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import Event, Robot, Scenario, User
from apps.server.tests.postgres import temporary_postgres


ORG = '00000000-0000-4000-8000-000000000001'
REPOSITORY = Path(__file__).resolve().parents[1]


@pytest.fixture
def bootstrap_env(monkeypatch, tmp_path):
    values = {'FH_ORG_ID': ORG, 'FH_ORG_NAME': '로컬 시험 조직', 'FH_BOOTSTRAP_USERNAME': 'local-admin',
              'FH_BOOTSTRAP_DISPLAY_NAME': '로컬 총괄', 'FH_BOOTSTRAP_PASSWORD': 'synthetic-admin-password',
              'FH_DB_PASSWORD': 'synthetic-db-password', 'FH_FILES_ROOT': str(tmp_path / 'files')}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    for key in ('FH_BOOTSTRAP_DATABASE_DSN', 'FH_APP_PASSWORD', 'FH_MIGRATE_PASSWORD',
                'FH_READONLY_PASSWORD', 'FH_MIGRATE_DATABASE_URL'):
        monkeypatch.delenv(key, raising=False)
    return values


def counts(url):
    engine = create_engine(url)
    try:
        with Session(engine) as db:
            return {model.__name__: db.scalar(select(func.count()).select_from(model))
                    for model in (User, Robot, Scenario, Event)}
    finally:
        engine.dispose()


def test_seed_twice_is_idempotent_and_accounts_log_in(bootstrap_env, tmp_path, capsys):
    passwords = {seed.password_key(name): f'synthetic-{name}-password' for name, *_ in seed.ACCOUNTS}
    with temporary_postgres() as urls:
        server.initialize(make_url(urls['app']), make_url(urls['migrate']),
                          make_url(urls['admin']).set(drivername='postgresql'))
        seed.seed(urls['app'], UUID(ORG), bootstrap_env['FH_FILES_ROOT'], 'local-admin', passwords)
        first = counts(urls['migrate'])
        seed.seed(urls['app'], UUID(ORG), bootstrap_env['FH_FILES_ROOT'], 'local-admin', passwords)
        assert counts(urls['migrate']) == first
        assert first['User'] == 1 + len(seed.ACCOUNTS)
        assert first['Robot'] == 1 and first['Scenario'] >= 1

        settings = Settings(urls['app'], UUID(ORG), files_root=bootstrap_env['FH_FILES_ROOT'],
                            robot_installer_enabled=False)
        with TestClient(create_app(settings), base_url='https://localhost') as client:
            for name, _display, role in seed.ACCOUNTS:
                login = client.post('/api/v1/auth/login', json={
                    'username': name, 'password': passwords[seed.password_key(name)], 'client': 'web'})
                assert login.status_code == 200, login.text
                assert login.json()['role'] == role
            login = client.post('/api/v1/auth/login', json={
                'username': 'local-admin', 'password': 'synthetic-admin-password', 'client': 'web'})
            assert login.status_code == 200, login.text
            robots = client.get('/api/v1/robots', params={'scope': 'all'})
            assert robots.status_code == 200, robots.text
            assert [r['name'] for r in robots.json()['items']] == [seed.SIM_ROBOT_NAME]
            sites = client.get('/api/v1/sites').json()
            assert any(site['purpose'] == 'SIM' for site in sites['items']), sites
            assert client.get('/api/v1/scenarios').json()['items']
            events = client.get('/api/v1/events').json()['items']
            assert {'USER_CREATED', 'SIM_MAP_REGISTERED'} <= {e['code'] for e in events}
    out = capsys.readouterr()
    assert not any(value in out.out + out.err for value in passwords.values())


def test_seed_refuses_missing_password(bootstrap_env):
    with pytest.raises(ValueError, match='FH_SEED_PASSWORD_'):
        seed.seed('postgresql+psycopg://unused@127.0.0.1/unused', UUID(ORG), '/unused', 'local-admin', {})


def test_secrets_file_private_stable_and_outside_repository(tmp_path, monkeypatch, capsys):
    for key in seed.secret_keys():
        monkeypatch.delenv(key, raising=False)
    path = tmp_path / 'private' / 'accounts.env'
    first = seed.ensure_secrets(path, REPOSITORY)
    assert set(first) == set(seed.secret_keys())
    assert all(len(value) >= 20 for value in first.values())
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert seed.ensure_secrets(path, REPOSITORY) == first
    out = capsys.readouterr()
    assert not any(value in out.out + out.err for value in first.values())

    monkeypatch.setenv('FH_BOOTSTRAP_PASSWORD', 'synthetic-from-environment')
    assert seed.ensure_secrets(path, REPOSITORY)['FH_BOOTSTRAP_PASSWORD'] == 'synthetic-from-environment'

    path.chmod(0o644)
    with pytest.raises(ValueError, match='600'):
        seed.ensure_secrets(path, REPOSITORY)
    with pytest.raises(ValueError, match='저장소 밖'):
        seed.ensure_secrets(REPOSITORY / 'docker' / 'accounts.env', REPOSITORY)

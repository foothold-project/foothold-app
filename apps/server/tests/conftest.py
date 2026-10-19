from pathlib import Path

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import Organization, Robot, User
from apps.server.fh_server.security import digest, hash_password
from .postgres import temporary_postgres

CONFIG = Path(__file__).resolve().parents[1] / 'alembic.ini'


@pytest.fixture(scope='session')
def postgres():
    with temporary_postgres() as urls:
        yield urls


@pytest.fixture(scope='session')
def migrated(postgres):
    import os
    prior = os.environ.get('FH_MIGRATE_DATABASE_URL')
    os.environ['FH_MIGRATE_DATABASE_URL'] = postgres['migrate']
    try:
        command.upgrade(Config(str(CONFIG)), 'head')
        yield postgres
    finally:
        if prior is None:
            os.environ.pop('FH_MIGRATE_DATABASE_URL', None)
        else:
            os.environ['FH_MIGRATE_DATABASE_URL'] = prior


@pytest.fixture
def seeded(migrated):
    engine = create_engine(migrated['migrate'])
    with engine.begin() as conn:
        conn.execute(text('TRUNCATE events, sessions, robots, users, organizations RESTART IDENTITY CASCADE'))
    with DBSession(engine) as db:
        org = Organization(name='가짜 시험 조직', settings={})
        other = Organization(name='다른 시험 조직', settings={})
        db.add_all([org, other])
        db.flush()
        users = {}
        for key, role, org_id in [('admin', 'ORG_ADMIN', org.id), ('one', 'OPERATOR', org.id),
                                  ('two', 'OPERATOR', org.id), ('locked', 'OPERATOR', org.id),
                                  ('foreign', 'ORG_ADMIN', other.id)]:
            users[key] = User(org_id=org_id, username=key, display_name=key, role=role,
                              password_hash=hash_password('fake-test-password'), locked=key == 'locked')
        db.add_all(users.values())
        db.flush()
        robots = {}
        for key, owner in [('mine', 'one'), ('theirs', 'two'), ('foreign', 'foreign')]:
            robots[key] = Robot(org_id=users[owner].org_id, name=key, model='unitree_go2',
                                owner_user_id=users[owner].id, agent_token_hash=digest('fake-agent-token'))
        db.add_all(robots.values())
        db.commit()
        result = {'org': org.id, 'users': {k: v.id for k, v in users.items()},
                  'robots': {k: v.id for k, v in robots.items()}, 'urls': migrated}
    engine.dispose()
    return result


@pytest.fixture
def client(seeded):
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    with TestClient(app, base_url='https://testserver') as client:
        yield client
    app.state.engine.dispose()


def login(http, username='one', **kwargs):
    return http.post('/api/v1/auth/login', json={'username': username,
        'password': 'fake-test-password', 'client': 'web', **kwargs})

"""Records tab server gaps (#613): q · simulation · has_clip filters, counts, retention."""
from contextlib import contextmanager
import csv
from datetime import datetime, timedelta, timezone
import io

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, delete
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import Event, Robot, User
from apps.server.fh_server.security import digest
from .conftest import login as conftest_login

STAMP = datetime(2026, 11, 28, 5, 2, tzinfo=timezone.utc)


@pytest.fixture
def events(seeded):
    URLS['migrate'] = seeded['urls']['migrate']
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        org, one = seeded['org'], seeded['users']['one']
        sim = Robot(org_id=org, name='Sim-Alpha', model='unitree_go2', simulation=True,
                    owner_user_id=one, agent_token_hash=digest('fake-sim-token'))
        db.add(sim)
        db.flush()
        foreign_org = db.get(User, seeded['users']['foreign']).org_id
        robots = {**seeded['robots'], 'sim': sim.id}
        ids = {}
        def add(key, robot, *, org_id=org, category='SAFETY', severity='INFO', code='STOP', message=None,
                data=None, actor=None, seconds=0):
            row = Event(org_id=org_id, at=STAMP - timedelta(seconds=seconds), robot_id=robots.get(robot),
                        user_id=seeded['users'].get(actor), category=category, severity=severity, code=code,
                        message=message or ('저장된 ' + key), data={'key': key, **(data or {})})
            db.add(row)
            db.flush()
            ids[key] = row.id
        add('real_clip', 'mine', category='RUN', severity='ERROR', code='RECORD_MARKED', data={'clip': True})
        add('real_plain', 'mine', severity='WARN', message='계단 100% 앞에서 멈춤', seconds=1)
        add('sim_clip', 'sim', category='RUN', severity='WARN', code='RECORD_MARKED', data={'clip': True}, seconds=2)
        add('sim_noclip', 'sim', category='RUN', code='RECORD_MARKED', data={'clip': False}, seconds=3)
        add('sim_strclip', 'sim', category='LINK', code='LINK_LOST', data={'clip': 'true'}, seconds=4)
        add('account', None, category='ACCOUNT', code='PASSWORD_CHANGED', actor='one', seconds=5)
        add('hidden', 'theirs', category='LINK', severity='ERROR', message='Sim-Alpha 숨은 사건', seconds=6,
            data={'clip': True})
        add('foreign', 'foreign', org_id=foreign_org, category='RUN', severity='ERROR', code='RECORD_MARKED',
            message='Sim-Alpha 다른 조직 계단', data={'clip': True}, seconds=7)
        db.commit()
    engine.dispose()
    return {'ids': ids, 'robots': robots, 'foreign_org': foreign_org}


URLS = {}


def login(http, username='one'):
    # Logging in writes its own ACCOUNT/LOGIN event; drop it so counts stay exact.
    assert conftest_login(http, username).status_code == 200
    engine = create_engine(URLS['migrate'])
    with engine.begin() as conn:
        conn.execute(delete(Event).where(Event.code == 'LOGIN'))
    engine.dispose()


@contextmanager
def app_for(seeded, org_id, **settings):
    app = create_app(Settings(seeded['urls']['app'], org_id, **settings))
    try:
        with TestClient(app, base_url='https://testserver') as http:
            yield http
    finally:
        app.state.engine.dispose()


def page(http, **params):
    response = http.get('/api/v1/events', params=params)
    assert response.status_code == 200, response.text
    return response.json()


def keys(result, ids):
    names = {str(value): key for key, value in ids.items()}
    return {names.get(item['id'], item['id']) for item in result['items']}


def test_q_matches_message_code_and_robot_name_inside_visible_scope(client, events):
    login(client)
    ids = events['ids']
    assert keys(page(client, q='계단'), ids) == {'real_plain'}
    assert keys(page(client, q='record_marked'), ids) == {'real_clip', 'sim_clip', 'sim_noclip'}
    # Robot name; the operator cannot see the other owner's event, nor another org's.
    assert keys(page(client, q='sim-alpha'), ids) == {'sim_clip', 'sim_noclip', 'sim_strclip'}
    # LIKE wildcards are literal text.
    assert keys(page(client, q='%'), ids) == {'real_plain'}
    assert keys(page(client, q='_'), ids) == {'real_clip', 'sim_clip', 'sim_noclip', 'sim_strclip', 'account'}
    assert keys(page(client, q='   '), ids) == keys(page(client), ids)
    assert client.get('/api/v1/events', params={'q': 'x' * 101}).status_code == 400


def test_simulation_filter_uses_robot_flag_and_skips_robotless(client, events):
    login(client)
    ids = events['ids']
    assert keys(page(client, simulation='true'), ids) == {'sim_clip', 'sim_noclip', 'sim_strclip'}
    assert keys(page(client, simulation='false'), ids) == {'real_clip', 'real_plain'}
    assert client.get('/api/v1/events', params={'simulation': 'maybe'}).status_code == 400


def test_has_clip_only_json_true(client, events):
    login(client)
    ids = events['ids']
    assert keys(page(client, has_clip='true'), ids) == {'real_clip', 'sim_clip'}
    assert keys(page(client, has_clip='false'), ids) == {'real_plain', 'sim_noclip', 'sim_strclip', 'account'}
    assert keys(page(client, has_clip='true', simulation='true', q='alpha'), ids) == {'sim_clip'}


def test_counts_first_page_facets_ignore_own_dimension(client, events):
    login(client)
    first = page(client, limit=2, severity='WARN')
    counts = first['counts']
    # Everything visible to the operator except the severity facet's own filter.
    assert counts['severity'] == {'INFO': 3, 'WARN': 2, 'ERROR': 1}
    assert counts['total'] == 2
    assert counts['category'] == {'RUN': 1, 'ROUTE': 0, 'LINK': 0, 'LEASE': 0, 'APPROVAL': 0,
                                  'SAFETY': 1, 'ACCOUNT': 0}
    assert counts['simulation'] == {'real': 1, 'sim': 1, 'none': 0}
    assert counts['clip'] == {'with_clip': 1, 'without_clip': 1}
    assert len(first['items']) == 2 and first['next_cursor'] is None
    everything = page(client)['counts']
    assert everything['total'] == 6
    assert everything['simulation'] == {'real': 2, 'sim': 3, 'none': 1}
    assert everything['clip'] == {'with_clip': 2, 'without_clip': 4}
    assert sum(everything['category'].values()) == sum(everything['severity'].values()) == 6
    second = page(client, limit=1)
    assert second['counts'] is not None
    assert page(client, limit=1, cursor=second['next_cursor'])['counts'] is None


def test_admin_counts_and_search_never_include_other_org(client, seeded, events):
    login(client, 'admin')
    ids = events['ids']
    assert keys(page(client, q='Sim-Alpha'), ids) == {'sim_clip', 'sim_noclip', 'sim_strclip', 'hidden'}
    counts = page(client, has_clip='true')['counts']
    assert counts['total'] == 3
    assert counts['severity'] == {'INFO': 0, 'WARN': 1, 'ERROR': 2}
    assert str(ids['foreign']) not in {item['id'] for item in page(client, q='계단', limit=100)['items']}
    with app_for(seeded, events['foreign_org']) as http:
        login(http, 'foreign')
        foreign = page(http, q='Sim-Alpha')
    assert keys(foreign, ids) == {'foreign'}
    assert foreign['counts']['total'] == 1


def test_export_csv_uses_same_new_filters(client, events):
    login(client)
    response = client.get('/api/v1/events/export.csv', params={'has_clip': 'true', 'simulation': 'true'})
    assert response.status_code == 200
    rows = list(csv.DictReader(io.StringIO(response.text.lstrip('﻿'))))
    assert [row['id'] for row in rows] == [str(events['ids']['sim_clip'])]


def test_clip_retention_days_from_server_setting(seeded, events):
    seen = []
    for value in (None, 14):
        with app_for(seeded, seeded['org'], clip_retention_days=value) as http:
            login(http)
            seen.append(page(http)['clip_retention_days'])
            # Present on later pages too: it is a setting, not a count.
            seen.append(page(http, limit=1, cursor=page(http, limit=1)['next_cursor'])['clip_retention_days'])
    assert seen == [None, None, 14, 14]

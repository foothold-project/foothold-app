"""S2 boundaries: persisted text, visibility, keyset pages, safe CSV and inbox."""
import ast
import csv
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session as DBSession

from apps.contracts import models as C
from apps.server.fh_server import event_messages as messages
from apps.server.fh_server.events_api import csv_cell
from apps.server.fh_server.leases import Effect
from apps.server.fh_server.models import (Event, Notification, Robot, User, now,
    Site, Building, Floor, Upload, MapVersion, Scenario, ScenarioVersion, Run)
from apps.server.fh_server.notifications import append_for_event
from .conftest import login


@pytest.fixture
def records(seeded):
    engine = create_engine(seeded['urls']['migrate'])
    stamp = datetime(2026, 10, 19, 5, 2, tzinfo=timezone.utc)
    run = uuid4()
    with DBSession(engine) as db:
        # Event.run_id now has a tenant FK; create a real synthetic history row.
        org, owner = seeded['org'], seeded['users']['one']
        site = Site(org_id=org, name='synthetic'); db.add(site); db.flush()
        building = Building(org_id=org, site_id=site.id, name='synthetic'); db.add(building); db.flush()
        floor = Floor(org_id=org, building_id=building.id, name='synthetic', level=1)
        image = Upload(org_id=org, image_path='synthetic.png', image_sha256=b'x'*32,
            png_sha256=b'x'*32, size_bytes=1, width=1, height=1, metadata_json={}, created_by=owner)
        db.add_all([floor, image]); db.flush()
        version = MapVersion(org_id=org, floor_id=floor.id, number=1, upload_id=image.id,
            status='APPROVED', image_path='synthetic.png', image_sha256=b'x'*32, width=1, height=1,
            resolution=1, origin_x=0, origin_y=0, origin_yaw=0, features={}, reason='synthetic',
            source='IMPORT', created_by=owner)
        scenario = Scenario(org_id=org, name='synthetic', latest_version=1, version=1, created_by=owner)
        db.add_all([version, scenario]); db.flush()
        fixed = ScenarioVersion(org_id=org, scenario_id=scenario.id, name='synthetic', number=1,
            required_devices=[], waypoints=[], finish={'mode': 'STAY'}, notes='', floor_ids=[floor.id],
            map_version_ids=[version.id], est_distance_m=0, created_by=owner)
        db.add(fixed); db.flush()
        db.add(Run(id=run, org_id=org, robot_id=seeded['robots']['mine'], simulation=True,
            scenario_version_id=fixed.id, floor_id=floor.id, map_version_id=version.id,
            started_by=owner, device_id=uuid4(), surface='phone', screen_id=uuid4(),
            agent_instance_id=uuid4(), status='COMPLETED', plan={}, started_at=stamp, ended_at=stamp))
        db.flush()
        def add(key, *, robot=None, actor=None, category='SAFETY', severity='INFO', at=stamp, run_id=None):
            ev = Event(org_id=seeded['org'], at=at, robot_id=seeded['robots'].get(robot),
                user_id=seeded['users'].get(actor), category=category, severity=severity,
                code='STOP', message='저장된 ' + key, data={'key': key}, run_id=run_id)
            db.add(ev)
            db.flush()
            return ev.id
        ids = {
            'owned': add('owned', robot='mine', actor='two', run_id=run),
            'hidden': add('hidden', robot='theirs', actor='two', category='LINK'),
            'action': add('action', robot='theirs', actor='one', severity='WARN'),
            'account': add('account', actor='one', category='ACCOUNT'),
            'older': add('older', robot='mine', at=stamp - timedelta(seconds=1)),
        }
        foreign = Event(org_id=db.get(User, seeded['users']['foreign']).org_id,
                        category='ACCOUNT', code='LOGIN', message='foreign')
        db.add(foreign)
        db.flush()
        ids['foreign'] = foreign.id
        db.commit()
    engine.dispose()
    return {'ids': ids, 'stamp': stamp, 'run': run}


def rows(http, **params):
    response = http.get('/api/v1/events', params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_operator_scope_own_action_same_404_and_current_owner(client, seeded, records):
    login(client)
    ids = records['ids']
    visible = {item['id'] for item in rows(client)['items']}
    assert {str(ids[key]) for key in ('owned', 'action', 'account', 'older')} <= visible
    assert not {str(ids['hidden']), str(ids['foreign'])} & visible
    responses = [client.get('/api/v1/events/' + str(value)) for value in (ids['hidden'], ids['foreign'], 999999999)]
    assert [r.status_code for r in responses] == [404, 404, 404]
    assert responses[0].json() == responses[1].json() == responses[2].json()
    assert client.get('/api/v1/events/' + str(ids['action'])).status_code == 200
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.get(Robot, seeded['robots']['mine']).owner_user_id = seeded['users']['two']
        db.commit()
    engine.dispose()
    assert client.get('/api/v1/events/' + str(ids['owned'])).status_code == 404
    assert client.get('/api/v1/events/' + str(ids['action'])).status_code == 200


def test_admin_full_tenant_and_id_filters(client, seeded, records):
    login(client, 'admin')
    visible = {item['id'] for item in rows(client)['items']}
    assert {str(v) for k, v in records['ids'].items() if k != 'foreign'} <= visible
    assert str(records['ids']['foreign']) not in visible
    assert [item['id'] for item in rows(client, run_id=str(records['run']))['items']] == [str(records['ids']['owned'])]
    assert all(item['user_id'] == str(seeded['users']['two']) for item in rows(client, user_id=str(seeded['users']['two']))['items'])
    for key, value in [('robot_id', uuid4()), ('robot_id', seeded['robots']['foreign']),
                       ('user_id', uuid4()), ('user_id', seeded['users']['foreign']), ('run_id', uuid4())]:
        assert client.get('/api/v1/events', params={key: str(value)}).status_code == 404


def test_filters_inclusive_utc_seven_categories_and_cursor_ties(client, seeded, records):
    login(client)
    result = rows(client, robot_id=str(seeded['robots']['theirs']))
    assert [row['id'] for row in result['items']] == [str(records['ids']['action'])]
    period = rows(client, category='SAFETY', **{'from': '2026-10-19T05:02:00Z', 'to': '2026-10-19T05:02:00Z'})
    assert {row['id'] for row in period['items']} == {str(records['ids'][key]) for key in ('owned', 'action')}
    assert rows(client, category='SAFETY', **{'to': '2026-10-19T05:01:59Z'})['items'][0]['id'] == str(records['ids']['older'])
    assert len(rows(client, category='SAFETY', **{'to': '2026-10-19T05:01:59Z'})['items']) == 1
    result = rows(client, category='SAFETY', severity='WARN', user_id=str(seeded['users']['one']),
                  **{'from': '2026-10-19T14:02:00+09:00', 'to': '2026-10-19T05:02:00Z'})
    assert [row['id'] for row in result['items']] == [str(records['ids']['action'])]
    for category in ('RUN', 'ROUTE', 'LINK', 'LEASE', 'APPROVAL', 'SAFETY', 'ACCOUNT'):
        assert all(row['category'] == category for row in rows(client, category=category)['items'])
    expected = rows(client)['items']
    actual, cursor = [], None
    while True:
        page = rows(client, limit=2, **({'cursor': cursor} if cursor else {}))
        actual.extend(page['items'])
        cursor = page['next_cursor']
        if cursor is None:
            break
    assert actual == expected
    assert len({row['id'] for row in actual}) == len(actual)
    assert actual == sorted(actual, key=lambda row: (row['at'], int(row['id'])), reverse=True)
    assert all(row['at'].endswith('Z') for row in actual)
    for params in ({'category': 'OTHER'}, {'severity': 'warn'}, {'limit': 0}, {'cursor': 'broken'},
                   {'from': '2026-10-19T05:02:00'}, {'from': '2026-10-20T00:00:00Z', 'to': '2026-10-19T00:00:00Z'}):
        assert client.get('/api/v1/events', params=params).status_code == 400


def test_foreign_robot_filter_404_matches_missing_without_own_actions(client, seeded, records):
    login(client, 'two')
    # Operator two owns neither a foreign-tenant robot nor any actions on it.
    responses = [client.get('/api/v1/events', params={'robot_id': str(rid)})
                 for rid in (seeded['robots']['foreign'], uuid4())]
    assert all(r.status_code == 404 for r in responses)
    assert responses[0].json() == responses[1].json()
    # Same-tenant unowned robot with no own action also hides existence.
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        robot = Robot(org_id=seeded['org'], name='unowned', model='fake', agent_token_hash=b'x')
        db.add(robot)
        db.flush()
        rid = robot.id
        db.commit()
    engine.dispose()
    response = client.get('/api/v1/events', params={'robot_id': str(rid)})
    assert response.status_code == 404
    assert response.json() == responses[0].json()


def test_csv_same_scope_filters_persisted_sentence_and_formula_cells(client, seeded, records):
    login(client)
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.add(Event(org_id=seeded['org'], user_id=seeded['users']['one'], category='ACCOUNT',
                     code='=HYPERLINK("https://invalid")', message=' \t=1+1', data={'csv': 'comma, newline\nquote"'}))
        db.commit()
    engine.dispose()
    response = client.get('/api/v1/events/export.csv')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert 'attachment' in response.headers['content-disposition']
    exported = list(csv.DictReader(io.StringIO(response.content.decode('utf-8-sig'))))
    assert {row['id'] for row in exported} == {row['id'] for row in rows(client)['items']}
    formulas = [row for row in exported if row['code'].startswith("'=")]
    assert len(formulas) == 1, 'Formula-leading code must be escaped in the actual CSV'
    formula = formulas[0]
    assert formula['message'] == "' \t=1+1"
    assert next(row for row in exported if row['id'] == str(records['ids']['action']))['message'] == '저장된 action'
    params = {'category': 'SAFETY', 'severity': 'WARN', 'robot_id': str(seeded['robots']['theirs'])}
    response = client.get('/api/v1/events/export.csv', params=params)
    assert [row['id'] for row in csv.DictReader(io.StringIO(response.content.decode('utf-8-sig')))] == [row['id'] for row in rows(client, **params)['items']]
    for rid in (seeded['robots']['foreign'], uuid4()):
        assert client.get('/api/v1/events/export.csv', params={'robot_id': str(rid)}).status_code == 404


@pytest.mark.parametrize('value', ['=1', '+1', '-1', '@SUM(A1)', '  =1', '\t1', '\r=1', '\n1'])
def test_csv_formula_guard(value):
    assert csv_cell(value).startswith("'")
    assert csv_cell('한글, "값"\n다음') == '한글, "값"\n다음'


def test_csv_limit_rejects_instead_of_silently_truncating(client, seeded, monkeypatch):
    from apps.server.fh_server import events_api
    login(client)
    monkeypatch.setattr(events_api, 'EXPORT_LIMIT', 1)
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.add(Event(org_id=seeded['org'], user_id=seeded['users']['one'], category='ACCOUNT', code='LOGIN', message='과거'))
        db.commit()
    engine.dispose()
    response = client.get('/api/v1/events/export.csv')
    assert response.status_code == 400
    assert response.json()['error']['code'] == 'EXPORT_LIMIT'


def test_no_update_delete_api_and_database_append_only(client, seeded, records):
    login(client, 'admin')
    for path in ('/api/v1/events', '/api/v1/events/' + str(records['ids']['owned'])):
        for method in ('put', 'patch', 'delete', 'post'):
            assert client.request(method.upper(), path, json={'message': '덮기'}).status_code == 405
    routes = client.app.openapi()['paths']
    assert all(set(methods) <= {'get'} for path, methods in routes.items() if path.startswith('/api/v1/events'))


def test_event_database_append_only_without_app_start(seeded):
    engine = create_engine(seeded['urls']['app'])
    for statement in ("UPDATE events SET message='덮기'", 'DELETE FROM events', 'TRUNCATE events'):
        with pytest.raises(DBAPIError):
            with engine.begin() as conn:
                conn.execute(text(statement))
    engine.dispose()


def test_template_registry_covers_all_server_writers_and_missing_code_fails(client, seeded):
    # Catch new server codes at source, including the cmd/unlock error forwarding.
    root = Path(__file__).resolve().parents[1] / 'fh_server'
    codes = set()
    for file in ('api.py', 'realtime.py', 'leases.py'):
        tree = ast.parse((root / file).read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, 'attr', '')
                index = {'event': 2, 'robot_event': 3, 'audit': 1, 'LeaseError': 0}.get(name)
                if index is not None and len(node.args) > index and isinstance(node.args[index], ast.Constant):
                    codes.add(node.args[index].value)
            if isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values):
                    if isinstance(key, ast.Constant) and key.value == 'op' and isinstance(value, ast.Constant):
                        if isinstance(value.value, str) and value.value.isupper():
                            codes.add(value.value)
    codes |= {'RUN_TAKE', 'LOGIN_RATE_LIMITED', 'PASSWORD_CHANGE_RATE_LIMITED'}
    assert codes <= messages.TEMPLATES.keys(), codes - messages.TEMPLATES.keys()
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        event = Event(org_id=seeded['org'], code='MISSING_SERVER_TEMPLATE')
        with pytest.raises(KeyError):
            messages.render(db, event)
        messages.render(db, event, agent=True)
        assert 'MISSING_SERVER_TEMPLATE' in event.message
    engine.dispose()


def test_template_rendering_particles_all_templates_and_old_rows_unchanged(client, seeded, records):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        before = [(ev.id, ev.message) for ev in db.scalars(select(Event))]
        for code in messages.TEMPLATES:
            event = Event(org_id=seeded['org'], robot_id=seeded['robots']['mine'], user_id=seeded['users']['one'],
                          code=code, at=records['stamp'], data={'distance_m': 1.8})
            messages.render(db, event, other_user_id=seeded['users']['two'])
            assert event.message.startswith('14:02 ') and '{' not in event.message
        for name, subject, with_particle in [('로봇', '이', '과'), ('나비', '가', '와'),
                                             ('Go2-3', '이', '과'), ('Go2-2', '가', '와')]:
            db.get(Robot, seeded['robots']['mine']).name = name
            ev = Event(org_id=seeded['org'], robot_id=seeded['robots']['mine'], code='ROUTE_DEVIATION', data={'distance_m': 1.8})
            messages.render(db, ev)
            assert f'{name}{subject} 계획 경로에서 1.8 m' in ev.message
            assert messages.particle(name, '과', '와') == with_particle
        db.commit()
        assert [(ev.id, ev.message) for ev in db.scalars(select(Event))] == before
    engine.dispose()


def record(client, seeded, op='AGENT_DISCONNECTED', **body):
    return client.app.state.realtime.record(Effect('audit', str(seeded['robots']['mine']),
        {'op': op, 'at': now(), **body}))


def test_notifications_recipient_only_unread_count_paging_and_atomic_read(client, seeded):
    login(client)
    record(client, seeded)
    record(client, seeded)
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        other = db.scalar(select(Notification.id).where(Notification.user_id == seeded['users']['admin']))
    engine.dispose()
    result = client.get('/api/v1/notifications?unread=1&limit=1')
    assert result.status_code == 200
    result = result.json()
    assert len(result['items']) == 1 and result['unread_count'] == 2
    own_id = result['items'][0]['id']
    assert isinstance(own_id, str) and result['items'][0]['event_id'].isdecimal()
    assert result['items'][0]['kind'] == 'LINK_LOST'
    assert result['items'][0]['link'].startswith('#/history?event_id=')
    page2 = client.get('/api/v1/notifications', params={'limit': 1, 'cursor': result['next_cursor']}).json()
    assert len(page2['items']) == 1 and page2['items'][0]['id'] != own_id
    assert page2['next_cursor'] is None and page2['unread_count'] == 2
    assert result['items'][0]['created_at'].endswith('Z')
    csrf = client.get('/api/v1/auth/session').json()['csrf_token']
    headers = {'x-fh-csrf': csrf}
    for identifier in (str(other), '9999999999'):
        response = client.post('/api/v1/notifications/read', json={'ids': [own_id, identifier]}, headers=headers)
        assert response.status_code == 404
        assert client.get('/api/v1/notifications').json()['unread_count'] == 2
    assert client.post('/api/v1/notifications/read', json={'ids': [own_id]}).status_code == 403
    assert client.post('/api/v1/notifications/read', json={'ids': [own_id]}, headers=headers).status_code == 204
    after = client.get('/api/v1/notifications').json()
    read_at = next(item['read_at'] for item in after['items'] if item['id'] == own_id)
    assert isinstance(read_at, str), 'A successful read must persist its timestamp'
    assert read_at.endswith('Z') and after['unread_count'] == 1
    assert client.post('/api/v1/notifications/read', json={'ids': [own_id]}, headers=headers).status_code == 204
    assert next(item['read_at'] for item in client.get('/api/v1/notifications').json()['items'] if item['id'] == own_id) == read_at
    assert len(client.get('/api/v1/notifications?unread=1').json()['items']) == 1
    assert client.post('/api/v1/notifications/read', json={'all': True}, headers=headers).status_code == 204
    assert client.get('/api/v1/notifications?unread=1').json() == {'items': [], 'next_cursor': None, 'unread_count': 0}
    login(client, 'admin')
    assert client.get('/api/v1/notifications').json()['unread_count'] == 2
    login(client, 'two')
    assert client.get('/api/v1/notifications').json()['items'] == []


def test_notification_input_and_auth_boundaries(client):
    for path in ('/api/v1/events', '/api/v1/events/export.csv', '/api/v1/notifications'):
        assert client.get(path).status_code == 401
    login(client)
    csrf = client.get('/api/v1/auth/session').json()['csrf_token']
    for body in ({}, {'all': False}, {'ids': []}, {'ids': ['1'], 'all': True}, {'ids': [1]},
                 {'ids': ['0']}, {'ids': ['9223372036854775808']}, {'ids': None}, {'all': None}):
        response = client.post('/api/v1/notifications/read', json=body, headers={'x-fh-csrf': csrf})
        assert response.status_code == 400, (body, response.text)
    assert client.get('/api/v1/notifications?unread=2').status_code == 400
    assert client.get('/api/v1/notifications?cursor=bad').status_code == 400


def test_only_targeted_events_notify_holder_admin_owner_and_preferences(client, seeded):
    login(client, 'admin')
    for code in ('STOP', 'TAKE', 'AGENT_CONNECTED', 'AGENT_INVALID_FRAME', 'PASSWORD_CHANGED'):
        if code != 'PASSWORD_CHANGED':
            record(client, seeded, code, user_id=str(seeded['users']['one']))
    assert client.get('/api/v1/notifications').json()['items'] == []
    record(client, seeded, 'REQUEST', user_id=str(seeded['users']['two']), other_user_id=str(seeded['users']['one']))
    assert client.get('/api/v1/notifications').json()['items'] == []
    login(client)
    notice = client.get('/api/v1/notifications').json()['items']
    assert [item['kind'] for item in notice] == ['LEASE_REQUESTED']
    assert 'two님' in notice[0]['body']
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.get(User, seeded['users']['one']).notify_prefs = {'LINK_LOST': False}
        db.commit()
    record(client, seeded)
    assert client.get('/api/v1/notifications').json()['unread_count'] == 1
    login(client, 'admin')
    assert client.get('/api/v1/notifications').json()['unread_count'] == 1
    for code, category, kind in [('ROUTE_DEVIATION', 'ROUTE', 'ROUTE_DEVIATION'), ('BATTERY_LOW', 'SAFETY', 'BATTERY_LOW'),
                                 ('RUN_FAILED', 'RUN', 'RUN_FAILED'), ('RUN_COMPLETED', 'RUN', 'RUN_COMPLETED')]:
        ev = record(client, seeded, 'AGENT_EVENT', code=code, data={'distance_m': 1.8, 'soc': 12})
        assert ev['category'] == category
        assert client.get('/api/v1/notifications').json()['items'][0]['kind'] == kind
    # Alert creation never escapes a rolled-back event transaction.
    with DBSession(engine) as db:
        ev = messages.render(db, Event(org_id=seeded['org'], robot_id=seeded['robots']['mine'],
            code='LINK_LOST', category='LINK', severity='WARN', data={}))
        db.add(ev)
        append_for_event(db, ev)
        event_id = ev.id
        db.rollback()
        assert db.get(Event, event_id) is None
        assert not db.scalar(select(Notification.id).where(Notification.event_id == event_id))
    engine.dispose()


def test_notification_tenant_fk_and_restricted_roles(seeded):
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        with pytest.raises(IntegrityError):
            db.add(Notification(org_id=seeded['org'], user_id=seeded['users']['foreign'],
                event_id=None, kind='TEST', title='시험', body='시험', link='#/history'))
            db.commit()
        db.rollback()
    for privilege, expected in [('SELECT', True), ('INSERT', True), ('UPDATE', False), ('DELETE', False), ('TRUNCATE', False)]:
        with engine.connect() as conn:
            assert conn.scalar(text("SELECT has_table_privilege('fh_app', 'notifications', :privilege)"), {'privilege': privilege}) is expected
    engine.dispose()

"""PR24: local-time immutable sentences, trusted agent semantics and bounded CSV."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import io
import threading
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event as sa_event, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server import events_api as exports, event_messages as messages
from apps.server.fh_server.models import Event, Robot, Notification
from .conftest import login
from .test_events import record


def test_robot_with_only_other_actors_events_is_same_404_for_list_and_csv(client, seeded):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        robot = Robot(org_id=seeded['org'], name='private-history', model='fake',
                      owner_user_id=seeded['users']['two'], agent_token_hash=b'x')
        db.add(robot)
        db.flush()
        rid = robot.id
        db.add(Event(org_id=seeded['org'], robot_id=rid, user_id=seeded['users']['two'],
                     category='SAFETY', code='STOP', message='남의 행동'))
        db.commit()
    engine.dispose()
    login(client)
    for path in ('/api/v1/events', '/api/v1/events/export.csv'):
        hidden = client.get(path, params={'robot_id': str(rid)})
        missing = client.get(path, params={'robot_id': str(uuid4())})
        assert hidden.status_code == missing.status_code == 404
        assert hidden.json() == missing.json()
    login(client, 'two')
    assert client.get('/api/v1/events', params={'robot_id': str(rid)}).status_code == 200


@pytest.mark.parametrize('code', ['APPROVAL_DECIDED', 'STOP_PRESSED', 'EMERGENCY_RUN', 'LEASE_HANDOVER',
                                  'LOGIN', 'USER_CREATED', 'REQUEST', 'AGENT_DISCONNECTED', 'FUTURE_CODE'])
def test_agent_cannot_claim_server_actions_templates_categories_or_alerts(client, seeded, code):
    login(client, 'admin')
    ev = record(client, seeded, 'AGENT_EVENT', code=code,
                data={'approved': True, 'kind': '지도', 'scenario_name': '가짜 긴급 실행'})
    assert ev['code'] == code and ev['data']['approved'] is True
    assert ev['category'] == 'LINK'
    assert f'사건 {code}' in ev['message']
    assert '승인했습니다' not in ev['message'] and '긴급 실행했습니다' not in ev['message']
    assert client.get('/api/v1/notifications').json()['items'] == []


def test_local_sentence_time_and_robot_time_do_not_change_wire_timestamps(client, seeded):
    received = datetime(2026, 10, 19, 5, 2, tzinfo=timezone.utc)
    occurred = datetime(2026, 10, 19, 4, 1, tzinfo=timezone.utc)
    ev = record(client, seeded, 'AGENT_EVENT', code='LINK_LOST', at=received, robot_at=occurred)
    assert ev['message'].startswith('13:01 ')
    assert ev['at'] == '2026-10-19T05:02:00Z' and ev['robot_at'] == '2026-10-19T04:01:00Z'
    server = record(client, seeded, 'STOP', at=received, user_id=str(seeded['users']['one']))
    assert server['message'].startswith('14:02 ')


def test_sentence_values_have_no_controls_are_bounded_and_numbers_are_numeric(seeded):
    engine = create_engine(seeded['urls']['app'])
    stamp = datetime(2026, 10, 19, 5, 2, tzinfo=timezone.utc)
    raw = {'scenario_name': '가\n\r\t\x1b\u202e' + '나' * 300,
           'reason': '없음.\n05:03 관리자님이 STOP 을 눌렀습니다.' + '다' * 300,
           'step': {'x': 1}, 'points': '3', 'minutes': True, 'count': ['fake'],
           'distance_m': '1.8', 'soc': False}
    with DBSession(engine) as db:
        for code in ('RUN_FAILED', 'RUN_COMPLETED', 'ROUTE_DEVIATION', 'BATTERY_LOW', 'AUDIT_DROPPED'):
            ev = Event(org_id=seeded['org'], at=stamp, code=code, data=raw)
            messages.render(db, ev)
            assert not any(char in ev.message for char in '\n\r\t\x1b\u202e')
            assert '확인되지 않음' in ev.message
            assert "{'x': 1}" not in ev.message and 'True' not in ev.message and 'False' not in ev.message
            assert '나' * 129 not in ev.message and '다' * 129 not in ev.message
            assert ev.data == raw
        for field in ('scenario_name', 'reason', 'last_status', 'kind'):
            assert messages.text_value({field: 'fake'}) == '확인되지 않음'
        for value in (None, '3', {}, [], True, float('nan'), float('inf')):
            assert messages.number_value(value) == '확인되지 않음'
        assert messages.number_value(1.8) == '1.8'
        assert messages.number_value(0) == '0'
    engine.dispose()


@pytest.mark.parametrize('name,particle', [('Go2-2', '를'), ('Go2-3', '을')])
def test_object_particle_matches_robot_name(seeded, name, particle):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.get(Robot, seeded['robots']['mine']).name = name
        for code in ('ROBOT_CREATED', 'ROBOT_ARCHIVED', 'LEASE_HELD', 'LEASE_FREE', 'NOT_FOUND', 'SUBSCRIPTION_REQUIRED'):
            ev = Event(org_id=seeded['org'], robot_id=seeded['robots']['mine'], code=code, data={})
            messages.render(db, ev)
            assert name + particle in ev.message
        db.rollback()
    engine.dispose()


@pytest.mark.parametrize('space', ['\u3000', '\u00a0', '\x0b', '\x0c'])
def test_csv_unicode_whitespace_formula_prefix(space):
    for prefix in ('=', '+', '-', '@'):
        value = space + prefix + '1'
        assert exports.csv_cell(value) == "'" + value


def test_csv_second_export_gets_429_process_slot_then_releases(client, monkeypatch):
    first = login(client, 'one', client='app').json()
    second = login(client, 'admin', client='app').json()
    entered, release = threading.Event(), threading.Event()
    original = exports.write_csv
    calls = []
    def blocked(*args):
        calls.append(True)
        if len(calls) == 1:
            entered.set()
            assert release.wait(5), 'CSV first writer was not released'
        return original(*args)
    monkeypatch.setattr(exports, 'write_csv', blocked)
    def export(token):
        return client.get('/api/v1/events/export.csv', headers={'authorization': 'Bearer ' + token})
    with ThreadPoolExecutor(max_workers=2) as pool:
        future = pool.submit(export, first['access_token'])
        try:
            assert entered.wait(2)
            response = pool.submit(export, second['access_token']).result(timeout=2)
            assert response.status_code == 429 and response.json()['error']['code'] == 'RATE_LIMITED'
        finally:
            release.set()
        assert future.result(timeout=5).status_code == 200
    assert export(second['access_token']).status_code == 200
    assert not exports.EXPORT_SLOT.locked()


def test_csv_cap_rejects_before_orm_rows_or_writer_and_releases_slot(client, monkeypatch):
    login(client)
    # The LOGIN event already exceeds this cap. The probe records actual ORM loads.
    monkeypatch.setattr(exports, 'EXPORT_LIMIT', 0)
    loaded, writes = [], []
    def observed(target, context):
        loaded.append(target.id)
    original = exports.write_csv
    def writer(*args):
        writes.append(True)
        return original(*args)
    monkeypatch.setattr(exports, 'write_csv', writer)
    sa_event.listen(Event, 'load', observed)
    try:
        response = client.get('/api/v1/events/export.csv')
        assert response.status_code == 400 and response.json()['error']['code'] == 'EXPORT_LIMIT'
        assert loaded == [] and writes == []
        assert not exports.EXPORT_SLOT.locked()
    finally:
        sa_event.remove(Event, 'load', observed)


def test_csv_writer_batches_orm_rows(seeded, monkeypatch):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.add_all([Event(org_id=seeded['org'], code='LOGIN', category='ACCOUNT', message='배치',
                          data={'payload': '가' * 1000}) for _ in range(250)])
        db.commit()
    engine.dispose()
    engine = create_engine(seeded['urls']['app'])
    peak, options = [], []
    original = exports.event_object
    with DBSession(engine) as db:
        scalar = db.scalars
        def observed(query):
            options.append(query.get_execution_options().get('yield_per'))
            return scalar(query)
        monkeypatch.setattr(db, 'scalars', observed)
        def convert(row):
            peak.append(len(db.identity_map))
            return original(row)
        monkeypatch.setattr(exports, 'event_object', convert)
        exports.write_csv(db, select(Event).where(Event.org_id == seeded['org']), io.StringIO())
    engine.dispose()
    assert options == [exports.EXPORT_BATCH]
    assert max(peak) <= exports.EXPORT_BATCH + 1


def test_csv_response_releases_slot_file_on_transport_failure():
    resource = exports.CSVResource(('fake-org', 'fake-user'))
    resource.reserve(lambda *args: pytest.fail('unexpected capacity limit'))
    output = io.StringIO('CSV')
    resource.attach(output)
    response = exports.CSVDownload(resource)
    async def send(message):
        raise RuntimeError('fake disconnected transport')
    async def receive():
        return {'type': 'http.disconnect'}
    with pytest.raises(RuntimeError):
        asyncio.run(response({'type': 'http', 'asgi': {'spec_version': '2.4'}}, receive, send))
    assert output.closed and resource.key not in exports.DOWNLOADS
    assert not exports.EXPORT_SLOT.locked()


def test_notification_db_can_update_only_read_at(seeded):
    engine = create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        notice = Notification(org_id=seeded['org'], user_id=seeded['users']['one'],
            event_id=None, kind='TEST', title='원래 제목', body='원래 본문', link='#/history')
        db.add(notice)
        db.commit()
        identifier = notice.id
    from sqlalchemy import text
    with engine.begin() as connection:
        connection.execute(text('UPDATE notifications SET read_at=now() WHERE id=:id'), {'id': identifier})
    for column in ('title', 'body', 'kind', 'link', 'user_id', 'org_id', 'event_id', 'created_at', 'id'):
        with pytest.raises(DBAPIError):
            with engine.begin() as connection:
                connection.execute(text(f'UPDATE notifications SET {column}={column} WHERE id=:id'), {'id': identifier})
    engine.dispose()

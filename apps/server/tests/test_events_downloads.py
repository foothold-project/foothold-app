"""Separate CSV generation capacity from per-user download file ownership."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import io
import threading
from uuid import uuid4

import pytest

from apps.server.fh_server import events_api as exports
from .conftest import login
from .test_events import record


def test_unread_body_does_not_block_other_user_but_same_user_gets_429(client, monkeypatch):
    one = login(client, 'one', client='app').json()['access_token']
    two = login(client, 'admin', client='app').json()['access_token']
    started, release = threading.Event(), threading.Event()
    original = exports.CSVDownload.__call__
    held = []
    async def unread(self, scope, receive, send):
        if not held:
            held.append(self.resource)
            started.set()
            while not release.is_set():
                await asyncio.sleep(.005)
        await original(self, scope, receive, send)
    monkeypatch.setattr(exports.CSVDownload, '__call__', unread)
    def request(token):
        return client.get('/api/v1/events/export.csv', headers={'authorization': 'Bearer ' + token})
    with ThreadPoolExecutor(max_workers=2) as pool:
        future = pool.submit(request, one)
        try:
            assert started.wait(3)
            # Hold the first response before its body is consumed.
            assert not exports.EXPORT_SLOT.locked()
            rejected = request(one)
            assert rejected.status_code == 429 and rejected.json()['error']['code'] == 'RATE_LIMITED'
            other = pool.submit(request, two).result(timeout=3)
            assert other.status_code == 200
            assert not held[0].output.closed
        finally:
            release.set()
        assert future.result(timeout=5).status_code == 200
    assert held[0].output.closed and exports.DOWNLOADS == {}
    assert request(one).status_code == 200


def test_response_failure_before_call_reclaims_user_file_and_builder(client, monkeypatch):
    access = login(client, 'one', client='app').json()['access_token']
    responses = []
    async def fail_before_call(self, scope, receive, send):
        responses.append(self.resource)
        raise RuntimeError('fake failure before response starts')
    original = exports.CSVDownload.__call__
    monkeypatch.setattr(exports.CSVDownload, '__call__', fail_before_call)
    with pytest.raises(RuntimeError, match='fake failure before response starts'):
        client.get('/api/v1/events/export.csv', headers={'authorization': 'Bearer ' + access})
    assert len(responses) == 1 and responses[0].output.closed
    assert not exports.EXPORT_SLOT.locked() and exports.DOWNLOADS == {}
    monkeypatch.setattr(exports.CSVDownload, '__call__', original)
    assert client.get('/api/v1/events/export.csv', headers={'authorization': 'Bearer ' + access}).status_code == 200


def test_late_cleanup_does_not_remove_another_users_new_lease():
    key = ('fake-org', str(uuid4()))
    fail = lambda *args: pytest.fail('unexpected capacity limit')
    old = exports.CSVResource(key)
    old.reserve(fail)
    old.close()
    new = exports.CSVResource(key)
    new.reserve(fail)
    try:
        old.close()
        assert exports.DOWNLOADS[key] is new
        output = io.StringIO('late file')
        with pytest.raises(RuntimeError):
            old.attach(output)
        assert output.closed
    finally:
        new.close()
    assert key not in exports.DOWNLOADS


@pytest.mark.parametrize('offset,human_time', [
    (timedelta(minutes=1), '14:02'),
    (timedelta(microseconds=1), '14:02'),
    (-timedelta(hours=24, microseconds=1), '14:02'),
    (-timedelta(hours=24), '14:02'),
    (-timedelta(hours=23, minutes=59), '14:03'),
    (-timedelta(hours=1), '13:02'),
])
def test_untrusted_robot_clock_falls_back_to_receive_time(client, seeded, offset, human_time):
    received = datetime(2026, 10, 20, 5, 2, tzinfo=timezone.utc)
    robot_time = received + offset
    ev = record(client, seeded, 'AGENT_EVENT', code='LINK_LOST', at=received, robot_at=robot_time)
    assert ev['message'].startswith(human_time + ' ')
    assert ev['at'] == '2026-10-20T05:02:00Z'
    assert datetime.fromisoformat(ev['robot_at']) == robot_time


def test_robot_storage_fault_has_a_local_meaning_distinct_from_server(client, seeded):
    # The production agent actually emits this diagnostic on its own archive fault.
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent'))
    from foothold_agent.link.session import Session
    session = Session()
    session.storage_blocked('fake local disk fault')
    assert any(message.get('code') == 'HISTORY_STORAGE_BLOCKED' for message in session.pop_history())
    robot = record(client, seeded, 'AGENT_EVENT', code='HISTORY_STORAGE_BLOCKED')
    server = record(client, seeded, 'HISTORY_STORAGE_BLOCKED')
    assert '자체 사건 저장' in robot['message'] and '서버에서' not in robot['message']
    assert '서버에서' in server['message'] and robot['message'] != server['message']
    assert robot['category'] == server['category'] == 'SAFETY'

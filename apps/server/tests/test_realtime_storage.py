"""PR13 r2: gated storage, source isolation and HTTP STOP authorization."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import json
import sqlite3
import threading
import time

import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import Session as DBSession
from starlette.websockets import WebSocketDisconnect

from apps.server.fh_server.audit import FairAuditQueue
from apps.server.fh_server.leases import Effect
from apps.server.fh_server.models import Event, User, Session as UserSession, now
from apps.server.fh_server.realtime import AuditQueue
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take
from .test_realtime_review import run


def test_dequeue_failure_latches_gate_and_keeps_auditor_alive(client, seeded, rt, monkeypatch):
    seen = []
    monkeypatch.setattr(rt, 'record', lambda e: seen.append(e.body['data']['number']) or {'t': 'event'})
    async def check():
        rt.tasks[1].cancel()
        await asyncio.gather(rt.tasks[1], return_exceptions=True)
        saved, rt.audit = rt.audit, AuditQueue(8)
        h = rt.audit._queue
        for n in range(9):
            rt.audit.put_nowait(Effect('audit', str(seeded['robots']['mine']),
                {'op': 'AGENT_EVENT', 'code': 'LINK_LOSS_TIMEOUT', 'data': {'number': n}}))
        disk, broken = h.spill, [True]
        class ReadFault:
            def execute(self, sql, *args):
                if sql.startswith('SELECT') and not h.memory and broken[0]:
                    raise sqlite3.OperationalError('gated read failure')
                return disk.execute(sql, *args)
            def close(self):
                disk.close()
        h.spill = ReadFault()
        task = asyncio.create_task(rt.auditor())
        try:
            for _ in range(100):
                if rt.audit_storage_failed:
                    break
                await asyncio.sleep(.005)
            assert rt.audit_storage_failed and rt.audit_overloaded
            assert not task.done() and rt.audit.qsize() == 1 and seen == list(range(8))
            broken[0] = False
            await asyncio.wait_for(rt.audit.join(), 2)
            assert seen == list(range(9))
            assert rt.audit_storage_failed and rt.audit_overloaded
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            h.close()
            rt.audit = saved
    run(client, check)


def test_failed_auditor_is_restarted_with_gate_closed(client, rt):
    async def check():
        rt.tasks[1].cancel()
        await asyncio.gather(rt.tasks[1], return_exceptions=True)
        async def failed():
            raise RuntimeError('unexpected consumer failure')
        failed_task = asyncio.create_task(failed())
        await asyncio.gather(failed_task, return_exceptions=True)
        rt.tasks[1] = failed_task
        for _ in range(100):
            if rt.tasks[1] is not failed_task:
                break
            await asyncio.sleep(.005)
        assert rt.tasks[1] is not failed_task and not rt.tasks[1].done()
        assert rt.audit_storage_failed and rt.audit_overloaded
    run(client, check)


@pytest.mark.parametrize('code,severity', [('NOTE', 'info'), ('LINK_LOSS_TIMEOUT', 'warn'), ('CUSTOM', 'error')])
def test_one_robot_event_flood_cannot_revoke_or_starve_another(client, seeded, rt, code, severity):
    a, b = str(seeded['robots']['mine']), str(seeded['robots']['theirs'])
    other = {**seeded, 'robots': {**seeded['robots'], 'mine': seeded['robots']['theirs']}}
    with agent(client, seeded) as ag_a, agent(client, other) as ag_b, screen(client, app_token(client, 'two')) as ws:
        lease = take(ws, ag_b, b)
        # Send a burst on the owning event loop so processing cannot be paced by
        # hundreds of TestClient thread round trips (the prior reproduction race).
        async def flood():
            for n in range(1500):
                try:
                    await ag_a._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps({
                        't': 'event', 'code': code, 'severity': severity, 'robot_at': None,
                        'data': {'number': n, 'pad': 'x' * 3500}})})
                except Exception:
                    break
            for _ in range(600):
                if rt.audit.channel(a).blocked:
                    break
                await asyncio.sleep(.005)
            assert rt.audit.channel(a).blocked, 'A single source must be rate/quota bounded'
        run(client, flood)
        assert not rt.audit_overloaded and not rt.audit_storage_failed
        assert rt.arbiter.robot(b).holder is not None
        assert rt.arbiter.robot(b).holder.lease_id == lease
        assert reply(ws, send(ws, 'cmd', b, lease_id=lease, seq=1, axes=[0, 0, 0]))['ok']
        assert reply(ws, send(ws, 'stop', b))['ok']
        receive(ag_b, 'stop')
        async def recorded():
            async with asyncio.timeout(3):
                while rt.audit.channel(b).count:
                    await asyncio.sleep(.01)
        run(client, recorded)
        with DBSession(client.app.state.engine) as db:
            assert db.scalar(select(Event.id).where(Event.robot_id == seeded['robots']['theirs'], Event.code == 'STOP'))
        c = rt.audit.channel(a)
        assert c.count <= 512 and c.size <= 2 * 1024 * 1024
        assert len(c.queue._queue.memory) <= 64 and c.queue._queue.io.pending <= 256
        if c.queue._queue.file:
            from pathlib import Path
            assert (Path(c.queue._queue.file.name) / 'history.sqlite').stat().st_size <= 8 * 1024 * 1024
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(ag_a, 'never', timeout=2)
        assert closed.value.code == 1013


@pytest.mark.parametrize('operation', ['INSERT', 'SELECT', 'DELETE'])
def test_robot_file_error_does_not_block_other_robot_storage(client, seeded, rt, operation):
    a, b = str(seeded['robots']['mine']), str(seeded['robots']['theirs'])
    async def check():
        channel = rt.audit.channel(a)
        h, actual = channel.queue._queue, channel.queue._queue._disk()
        failed = threading.Event()
        recover = threading.Event()
        class Disk:
            def execute(self, sql, *args):
                if sql.startswith(operation) and not recover.is_set():
                    failed.set()
                    raise sqlite3.OperationalError('isolated source file failure')
                return actual.execute(sql, *args)
            def close(self):
                actual.close()
        h.spill = Disk()
        try:
            for n in range(66):
                rt.queue_audit(Effect('audit', a, {'op': 'AGENT_EVENT', 'code': 'LINK_LOSS_TIMEOUT',
                    'at': now(), 'data': {'number': n}}))
            assert await asyncio.to_thread(failed.wait, 1)
            for _ in range(100):
                if channel.blocked:
                    break
                await asyncio.sleep(.005)
            assert channel.blocked and not rt.audit_overloaded
            rt.queue_audit(Effect('audit', b, {'op': 'STOP', 'at': now()}))
            async with asyncio.timeout(2):
                while rt.audit.channel(b).count:
                    await asyncio.sleep(.005)
            assert h.disk_count > 0 and not rt.tasks[1].done()
        finally:
            recover.set()
            await asyncio.wait_for(rt.audit.join(), 3)
    run(client, check)
    with DBSession(client.app.state.engine) as db:
        rows = db.scalars(select(Event).where(Event.robot_id == seeded['robots']['mine'],
            Event.code == 'LINK_LOSS_TIMEOUT').order_by(Event.id)).all()
    assert [row.data['number'] for row in rows] == list(range(66))
    assert all('server_received_at' in row.data and 'robot_sequence' in row.data for row in rows)
    assert [r.data['robot_sequence'] for r in rows] == sorted(r.data['robot_sequence'] for r in rows)


def test_six_cold_http_stops_use_one_read_each_and_all_are_accepted(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    headers = [app_token(client, user) for user in ('one', 'two', 'admin') * 2]
    calls, lock = [], threading.Lock()
    def delayed(conn, cursor, sql, parameters, context, many):
        with lock:
            calls.append(sql)
        time.sleep(.45)
    event.listen(rt.stop_engine, 'before_cursor_execute', delayed)
    try:
        with agent(client, seeded), ThreadPoolExecutor(6) as pool:
            results = list(pool.map(lambda h: client.post(f'/api/v1/robots/{rid}/stop', headers=h).status_code, headers))
        assert results == [202] * 6
        assert len(calls) == 6
    finally:
        event.remove(rt.stop_engine, 'before_cursor_execute', delayed)


@pytest.mark.parametrize('change', ['lock', 'archive', 'role', 'organization', 'revoke', 'logout'])
def test_cached_http_stop_is_invalidated_immediately_by_account_or_session_change(client, seeded, rt, monkeypatch, change):
    rid = str(seeded['robots']['mine'])
    headers = app_token(client)
    # Freeze cache age: this must be invalidation, not accidentally waiting TTL.
    monkeypatch.setattr(rt, 'clock', lambda: 0)
    assert client.post(f'/api/v1/robots/{rid}/stop', headers=headers).status_code == 202
    assert rt.stop_cache
    epoch = rt.stop_cache_epoch
    if change == 'logout':
        assert client.post('/api/v1/auth/logout', headers=headers).status_code == 204
    else:
        with DBSession(client.app.state.engine) as db:
            user = db.get(User, seeded['users']['one'])
            if change == 'lock':
                user.locked = True
            elif change == 'archive':
                user.archived_at = now()
            elif change == 'role':
                user.role = 'ORG_ADMIN'  # valid role change still invalidates
            elif change == 'organization':
                # Do not violate same-org FKs; mutate a session's org claim.
                session = db.scalar(select(UserSession).where(UserSession.user_id == user.id))
                foreign = db.get(User, seeded['users']['foreign'])
                session.org_id, session.user_id = foreign.org_id, foreign.id
            else:
                db.scalar(select(UserSession).where(UserSession.user_id == user.id)).revoked_at = now()
            db.commit()
    assert rt.stop_cache_epoch > epoch and not rt.stop_cache
    response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
    assert response.status_code == (202 if change == 'role' else 401)


def test_warm_http_stop_never_waits_for_db_and_saturation_is_explicit(client, seeded, rt, monkeypatch):
    from apps.server.fh_server import realtime as module
    rid, headers = str(seeded['robots']['mine']), app_token(client)
    monkeypatch.setattr(rt, 'clock', lambda: 0)
    assert client.post(f'/api/v1/robots/{rid}/stop', headers=headers).status_code == 202
    def forbidden(*_):
        raise AssertionError('warm STOP touched the DB')
    monkeypatch.setattr(rt, 'load_stop_scope', forbidden)
    assert client.post(f'/api/v1/robots/{rid}/stop', headers=headers).status_code == 202
    other = app_token(client, 'two')
    monkeypatch.setattr(module, 'DB_READ_TIMEOUT', .05)
    async def saturate():
        for _ in range(12):
            await rt.stop_slots.acquire()
    run(client, saturate)
    try:
        assert client.post(f'/api/v1/robots/{rid}/stop', headers=other).status_code == 503
        assert client.post(f'/api/v1/robots/{rid}/stop', headers=headers).status_code == 202
    finally:
        for _ in range(12):
            rt.stop_slots.release()


def test_payload_quota_and_response_reservations_are_bounded_and_keep_robot_fifo(client, seeded, rt):
    from apps.server.fh_server.audit import SourceArchiveFull
    a, b = str(seeded['robots']['mine']), str(seeded['robots']['theirs'])
    expected = []
    async def check():
        reservations = []
        for n in range(512):
            try:
                reservations.append(rt.audit.reserve(Effect('audit', a, {'op': 'STOP', 'at': now(),
                    'data': {'number': n, 'pad': 'x' * 16384}})))
            except SourceArchiveFull:
                break
        expected.append(len(reservations))
        channel = rt.audit.channel(a)
        assert 1 < len(reservations) < 480
        assert channel.size <= 2 * 1024 * 1024 and channel.count <= 512
        assert len(channel.staged) == channel.count and not channel.queue.qsize()
        # Later response completion cannot pass the first response's record.
        rt.audit.commit(reservations[-1])
        assert not channel.queue.qsize()
        rt.queue_audit(Effect('audit', b, {'op': 'STOP', 'at': now()}))
        async with asyncio.timeout(2):
            while rt.audit.channel(b).count:
                await asyncio.sleep(.005)
        # Committing the earliest response releases records in reserved order.
        for reservation in reservations:
            rt.audit.commit(reservation)
        await asyncio.wait_for(rt.audit.join(), 4)
        assert channel.count == 0 and channel.size == 0 and not channel.sizes
        assert channel.queue._queue.io.pending <= 256
    run(client, check)
    with DBSession(client.app.state.engine) as db:
        rows = db.scalars(select(Event).where(Event.robot_id == seeded['robots']['mine'],
            Event.code == 'STOP').order_by(Event.id)).all()
    assert len(rows) == expected[0]
    assert [r.data['number'] for r in rows] == list(range(len(rows)))
    assert [r.data['robot_sequence'] for r in rows] == list(range(1, len(rows) + 1))


def test_cancelled_http_response_still_owns_stop_record_and_does_not_block_other_robot(client, seeded, rt):
    a, b, headers = str(seeded['robots']['mine']), str(seeded['robots']['theirs']), app_token(client)
    async def check():
        await rt.stop_actor(headers, {}, a)
        body_entered = asyncio.Event()
        async def receive_request():
            return {'type': 'http.request', 'body': b'', 'more_body': False}
        async def held_send(message):
            if message['type'] == 'http.response.body':
                body_entered.set()
                await asyncio.Event().wait()
        scope = {'type': 'http', 'http_version': '1.1', 'method': 'POST',
                 'scheme': 'https', 'path': f'/api/v1/robots/{a}/stop',
                 'root_path': '', 'query_string': b'', 'headers': [(b'authorization', headers['authorization'].encode())],
                 'server': ('testserver', 443), 'client': ('127.0.0.1', 1)}
        request = asyncio.create_task(client.app(scope, receive_request, held_send))
        try:
            await asyncio.wait_for(body_entered.wait(), 1)
            c = rt.audit.channel(a)
            assert c.count == 1 and len(c.staged) == 1 and not c.queue.qsize()
            rt.queue_audit(Effect('audit', b, {'op': 'STOP', 'at': now()}))
            async with asyncio.timeout(2):
                while rt.audit.channel(b).count:
                    await asyncio.sleep(.005)
        finally:
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
        await asyncio.wait_for(rt.audit.join(), 2)
    run(client, check)
    with DBSession(client.app.state.engine) as db:
        assert db.scalar(select(Event.id).where(Event.robot_id == seeded['robots']['mine'], Event.code == 'STOP'))


def test_cold_authorization_crossing_revocation_cannot_publish_a_cached_stop(client, seeded, rt, monkeypatch):
    rid, headers = str(seeded['robots']['mine']), app_token(client)
    entered, release = threading.Event(), threading.Event()
    original = rt.load_stop_scope
    def held(key):
        result = original(key)
        entered.set()
        release.wait(3)
        return result
    monkeypatch.setattr(rt, 'load_stop_scope', held)
    with ThreadPoolExecutor(1) as pool:
        result = pool.submit(client.post, f'/api/v1/robots/{rid}/stop', headers=headers)
        try:
            assert entered.wait(1)
            with DBSession(client.app.state.engine) as db:
                db.get(User, seeded['users']['one']).locked = True
                db.commit()
        finally:
            release.set()
        assert result.result().status_code == 503
    assert not rt.stop_cache


def test_record_reservations_have_480_admission_slots_and_32_safety_slots(client, seeded, rt):
    from apps.server.fh_server.audit import SourceArchiveFull
    rid = str(seeded['robots']['mine'])
    async def check():
        held = [rt.audit.reserve(Effect('audit', rid, {'op': 'STOP', 'at': now()})) for _ in range(480)]
        refused = False
        try:
            rt.audit.reserve(Effect('audit', rid, {'op': 'STOP', 'at': now()}))
        except SourceArchiveFull:
            refused = True
        assert refused
        held += [rt.audit.reserve(Effect('audit', rid, {'op': 'EXPIRE', 'at': now()})) for _ in range(32)]
        refused = False
        try:
            rt.audit.reserve(Effect('audit', rid, {'op': 'EXPIRE', 'at': now()}))
        except SourceArchiveFull:
            refused = True
        assert refused and rt.audit.channel(rid).count == 512
        for reservation in held:
            rt.audit.commit(reservation)
        await asyncio.wait_for(rt.audit.join(), 5)
        assert rt.audit.channel(rid).count == 0
    run(client, check)


def test_fair_consumer_cannot_drain_one_robot_before_another_ready_robot(client, seeded, rt, monkeypatch):
    a, b = str(seeded['robots']['mine']), str(seeded['robots']['theirs'])
    seen = []
    monkeypatch.setattr(rt, 'record', lambda e: seen.append(e.robot) or {'t': 'event'})
    async def check():
        rt.tasks[1].cancel()
        await asyncio.gather(rt.tasks[1], return_exceptions=True)
        for n in range(10):
            rt.queue_audit(Effect('audit', a, {'op': 'STOP', 'at': now(), 'data': {'number': n}}))
        rt.queue_audit(Effect('audit', b, {'op': 'STOP', 'at': now()}))
        rt.tasks[1] = asyncio.create_task(rt.auditor())
        await asyncio.wait_for(rt.audit.join(), 2)
        assert seen.index(b) <= 1 and seen.count(a) == 10
    run(client, check)


def test_spill_file_has_enforced_eight_mib_limit():
    from pathlib import Path
    from apps.server.fh_server.history import History
    h = History(0, lambda _: True)
    try:
        full = False
        try:
            h.append(b'x' * (9 * 1024 * 1024))
        except sqlite3.OperationalError as error:
            full = 'full' in str(error).lower()
        assert full, 'SQLite must enforce the physical file ceiling'
        assert (Path(h.file.name) / 'history.sqlite').stat().st_size <= 8 * 1024 * 1024
    finally:
        h.close()


def test_gated_robot_file_write_does_not_occupy_other_robots_event_loop(client, seeded, rt):
    a, b = str(seeded['robots']['mine']), str(seeded['robots']['theirs'])
    entered, release, progressed, missed = (threading.Event() for _ in range(4))
    async def check():
        h = rt.audit.channel(a).queue._queue
        actual = h._disk()
        class Disk:
            def execute(self, sql, *args):
                if sql.startswith('INSERT'):
                    entered.set()
                    release.wait(4)
                return actual.execute(sql, *args)
            def close(self):
                actual.close()
        h.spill = Disk()
        def unblock():
            if entered.wait(1) and not progressed.wait(3):
                missed.set()
            release.set()
        helper = threading.Thread(target=unblock)
        helper.start()
        try:
            for n in range(66):
                rt.queue_audit(Effect('audit', a, {'op': 'STOP', 'at': now(), 'data': {'number': n}}))
            assert await asyncio.to_thread(entered.wait, 1)
            assert not release.is_set()
            rt.queue_audit(Effect('audit', b, {'op': 'STOP', 'at': now()}))
            async with asyncio.timeout(2):
                while rt.audit.channel(b).count:
                    await asyncio.sleep(.005)
            progressed.set()
            assert not missed.is_set() and not rt.audit_overloaded
        finally:
            release.set()
            await asyncio.to_thread(helper.join, 1)
            await asyncio.wait_for(rt.audit.join(), 3)
        assert not missed.is_set(), 'The file wait blocked the shared event loop'
    run(client, check)


def test_source_shutdown_preserves_reserved_expiry_and_disconnect_records(client, seeded, rt):
    from apps.server.fh_server.leases import Actor, Holder
    rid = str(seeded['robots']['mine'])
    app_token(client)
    with DBSession(client.app.state.engine) as db:
        session_id = str(db.scalar(select(UserSession.id).where(UserSession.user_id == seeded['users']['one'])))
    async def check():
        rt.tasks[1].cancel()
        await asyncio.gather(rt.tasks[1], return_exceptions=True)
        actor = Actor(str(seeded['users']['one']), session_id, 'connection', 'one', 'OPERATOR')
        robot = rt.arbiter.robot(rid)
        robot.holder = Holder(actor, 'lease', rt.clock(), rt.clock())
        rt.block_archive_source(rid, 'BACKPRESSURE')
        rt.apply([Effect('audit', rid, {'op': 'AGENT_DISCONNECTED'})])
        records = await rt.audit._queue.snapshot()
        assert [e.body['op'] for e in records] == ['EXPIRE', 'HISTORY_STORAGE_BLOCKED', 'AGENT_DISCONNECTED']
        assert robot.holder is None and not rt.audit_overloaded
        rt.tasks[1] = asyncio.create_task(rt.auditor())
        await asyncio.wait_for(rt.audit.join(), 2)
    run(client, check)


def test_failed_start_does_not_register_global_stop_cache_listeners(client, rt, monkeypatch):
    fresh = type(rt)(rt.settings, rt.factory, rt.authorize, rt.api_error)
    def unavailable():
        raise OSError('startup database unavailable')
    monkeypatch.setattr(fresh.read_engine, 'connect', unavailable)
    async def check():
        try:
            with pytest.raises(OSError):
                await fresh.start()
            assert not fresh.stop_listeners
        finally:
            await fresh.close()
    run(client, check)


def test_cold_stop_rechecks_session_expiry_after_the_read(client, seeded, rt, monkeypatch):
    from datetime import timedelta
    from apps.server.fh_server import realtime as module
    rid, headers = str(seeded['robots']['mine']), app_token(client)
    clock = [now()]
    with DBSession(client.app.state.engine) as db:
        session = db.scalar(select(UserSession).where(UserSession.user_id == seeded['users']['one']))
        session.expires_at = expires = clock[0] + timedelta(seconds=1)
        db.commit()
    monkeypatch.setattr(module, 'now', lambda: clock[0])
    def during_read(*_):
        clock[0] = expires + timedelta(seconds=1)
    event.listen(rt.stop_engine, 'before_cursor_execute', during_read)
    reference = rt.arbiter.robot(rid).stop_ref
    try:
        response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
        assert response.status_code == 401
        assert rt.arbiter.robot(rid).stop_ref == reference and not rt.stop_cache
    finally:
        event.remove(rt.stop_engine, 'before_cursor_execute', during_read)

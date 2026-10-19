"""PR13 r3: bounded STOP admission waiting and stable backlog drain."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading
import time

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.leases import Effect
from apps.server.fh_server.models import User, now
from .test_realtime import agent, app_token, rt
from .test_realtime_review import run


@pytest.mark.parametrize('delay', [0, .45])
def test_twenty_distinct_logins_all_reach_stop_after_slot_wait(client, seeded, rt, monkeypatch, delay):
    rid = str(seeded['robots']['mine'])
    usernames = ['one', *[f'stop-user-{n}' for n in range(19)]]
    with DBSession(client.app.state.engine) as db:
        password = db.get(User, seeded['users']['one']).password_hash
        for username in usernames[1:]:
            db.add(User(org_id=seeded['org'], username=username, display_name=username,
                        role='OPERATOR', password_hash=password))
        db.commit()
    headers = [app_token(client, username) for username in usernames]
    entered, calls, applied = [0], [], []
    everyone, barrier = threading.Event(), threading.Barrier(20)
    original_actor, original_scope, original_stop = rt.stop_actor, rt.load_stop_scope, rt.arbiter.stop
    async def admitted(*args):
        entered[0] += 1
        if entered[0] == 20:
            everyone.set()
        return await original_actor(*args)
    def scope(key):
        assert everyone.wait(3), 'All HTTP requests must enter before reads complete'
        return original_scope(key)
    def stop(robot, actor):
        applied.append(actor.user)
        return original_stop(robot, actor)
    def delayed(*args):
        calls.append(1)
        time.sleep(delay)
    def hit(h):
        barrier.wait(3)
        return client.post(f'/api/v1/robots/{rid}/stop', headers=h).status_code
    monkeypatch.setattr(rt, 'stop_actor', admitted)
    monkeypatch.setattr(rt, 'load_stop_scope', scope)
    monkeypatch.setattr(rt.arbiter, 'stop', stop)
    event.listen(rt.stop_engine, 'before_cursor_execute', delayed)
    try:
        with agent(client, seeded), ThreadPoolExecutor(20) as pool:
            results = list(pool.map(hit, headers))
        assert results == [202] * 20
        assert len(calls) == len(applied) == len(set(applied)) == 20
    finally:
        everyone.set()
        event.remove(rt.stop_engine, 'before_cursor_execute', delayed)


def test_cold_slot_deadline_rejects_without_unverified_stop_or_slot_leak(client, seeded, rt, monkeypatch):
    from apps.server.fh_server import realtime as module
    rid, headers = str(seeded['robots']['mine']), app_token(client)
    monkeypatch.setattr(module, 'DB_READ_TIMEOUT', .05)
    reference = rt.arbiter.robot(rid).stop_ref
    async def check():
        for _ in range(12):
            await rt.stop_slots.acquire()
        result = None
        try:
            try:
                await asyncio.wait_for(rt.stop_actor(headers, {}, rid), .5)
            except rt.api_error as error:
                result = error.status
            except asyncio.TimeoutError:
                result = 'outer timeout'
            assert result == 503
            assert rt.stop_slots._value == 0
            assert rt.arbiter.robot(rid).stop_ref == reference and not rt.stop_cache
        finally:
            for _ in range(12):
                rt.stop_slots.release()
        assert rt.stop_slots._value == 12
    run(client, check)


def test_cancelled_stop_read_keeps_its_slot_until_worker_finishes(client, seeded, rt, monkeypatch):
    rid, headers = str(seeded['robots']['mine']), app_token(client)
    entered, release = threading.Event(), threading.Event()
    original = rt.load_stop_scope
    def held(key):
        entered.set()
        assert release.wait(3)
        return original(key)
    monkeypatch.setattr(rt, 'load_stop_scope', held)
    async def check():
        task = asyncio.create_task(rt.stop_actor(headers, {}, rid))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert rt.stop_slots._value == 11
        finally:
            release.set()
        for _ in range(200):
            if rt.stop_slots._value == 12:
                break
            await asyncio.sleep(.005)
        assert rt.stop_slots._value == 12 and not rt.stop_cache
    run(client, check)


@pytest.mark.parametrize('backlog', [64, 128, 255])
def test_join_preserves_latest_ordinary_records_instead_of_summary_cascade(client, seeded, rt, monkeypatch, backlog):
    rid, stored, omitted = str(seeded['robots']['mine']), [], []
    def record(effect):
        if effect.body.get('code') == 'BACKLOG':
            stored.append(effect.body['data']['number'])
        elif effect.body.get('op') == 'AUDIT_DROPPED':
            omitted.append(effect.body['data']['count'])
        return {'t': 'event'}
    monkeypatch.setattr(rt, 'record', record)
    async def check():
        rt.tasks[1].cancel()
        await asyncio.gather(rt.tasks[1], return_exceptions=True)
        def enqueue(n):
            rt.queue_audit(Effect('audit', rid, {'op': 'AGENT_EVENT', 'code': 'BACKLOG',
                'at': now(), 'data': {'number': n}}))
        for n in range(min(64, backlog)):
            enqueue(n)
        joining = asyncio.create_task(rt.audit.join())
        await asyncio.sleep(0)
        # Keep ingress waking join while the consumer is held. A summary must
        # not turn each producer wake-up into another ordinary-record eviction.
        for n in range(64, backlog):
            enqueue(n)
            await asyncio.sleep(0)
        rt.tasks[1] = asyncio.create_task(rt.auditor())
        await asyncio.wait_for(joining, 3)
        kept = min(backlog, 61)
        assert stored[-kept:] == list(range(backlog - kept, backlog))
        assert stored == sorted(set(stored)) and len(stored) + sum(omitted) == backlog
        assert not rt.audit.channel(rid).blocked
    run(client, check)

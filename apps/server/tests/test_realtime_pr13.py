"""PR13 review regressions: ownership, FIFO, safety capacity and resource isolation."""
import asyncio
from contextlib import ExitStack, contextmanager
import json
import threading
import time

import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import Session as DBSession
from starlette.websockets import WebSocketDisconnect

from apps.server.fh_server.realtime import AuditQueue
from apps.server.fh_server.leases import Effect
from apps.server.fh_server.models import Event, Robot, User
from apps.server.fh_server.security import digest
from uuid import uuid4
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state
from .test_realtime_review import run


@contextmanager
def slow_screen(client, headers):
    with client.websocket_connect('wss://testserver/api/v1/ws', headers=headers) as ws:
        first = reply(ws, send(ws, 'ping', proto='fh-rt/1'))
        # At 450ms, handshaking/scheduling can consume the remaining 50ms.
        # Such input must be refused; the warmed motion sample is measured below.
        assert first['ok'] or first['error']['code'] == 'POLICY_STALE', first
        yield ws


@pytest.mark.parametrize('failure', ['denied', 'transient', 'cancel'])
def test_preaccept_failure_releases_policy_producer(client, rt, monkeypatch, failure):
    from sqlalchemy.exc import OperationalError
    def broken(actor):
        if failure == 'denied':
            raise rt.api_error(401, 'AUTH_REQUIRED', 'review')
        raise OperationalError('review', {}, OSError('offline'))
    monkeypatch.setattr(rt, 'load_policy_batch', broken)
    if failure == 'cancel':
        async def refresh(peer):
            rt.policy_peers[peer.actor.session] = peer
            raise asyncio.CancelledError()
        monkeypatch.setattr(rt, 'refresh_policy', refresh)
        # Inspect cancellation directly; TestClient owns a separate cancel scope.
        class Socket:
            headers = app_token(client)
            cookies = {}
        async def check():
            with pytest.raises(asyncio.CancelledError):
                await rt.screen_ws(Socket())
        run(client, check)
    else:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('wss://testserver/api/v1/ws', headers=app_token(client)) as ws:
                ws.receive_json()
    assert not rt.policy_loads and not rt.policy_peers and not rt.policy_pipelines


def test_reconnects_have_one_runtime_backlog_and_safety_survives(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    async def pause():
        rt.tasks[1].cancel()
        await asyncio.gather(rt.tasks[1], return_exceptions=True)
        rt.audit = AuditQueue(1)
    run(client, pause)
    for n in range(12):
        with agent(client, seeded) as ag:
            ag.send_json({'t': 'event', 'code': 'LINK_LOSS_TIMEOUT', 'severity': 'WARN',
                          'robot_at': None, 'data': {'connection': n}})
            # A subsequent ping has passed the same serialized receiver.
            ag.send_json({'t': 'ping'})
            async def admitted():
                async with asyncio.timeout(1):
                    while not any(e.body.get('data', {}).get('connection') == n for e in rt.audit._queue):
                        await asyncio.sleep(.005)
            run(client, admitted)
        assert not rt.archive_tasks
        assert len(rt.audit._queue.memory) <= 1
    async def inspect():
        assert [e.body['data']['connection'] for e in rt.audit._queue if e.body.get('code') == 'LINK_LOSS_TIMEOUT'] == list(range(12))
    run(client, inspect)
    async def drain():
        rt.tasks[1] = asyncio.create_task(rt.auditor())
        await asyncio.wait_for(rt.audit.join(), 3)
    run(client, drain)
    with DBSession(client.app.state.engine) as db:
        rows = db.scalars(select(Event).where(Event.code == 'LINK_LOSS_TIMEOUT').order_by(Event.id)).all()
    assert [r.data['connection'] for r in rows] == list(range(12))


def test_disconnect_does_not_cancel_last_inflight_safety(client, seeded, rt, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = rt.record
    def record(effect):
        if effect.body.get('code') == 'LINK_LOSS_TIMEOUT':
            entered.set()
            assert release.wait(3)
        return original(effect)
    monkeypatch.setattr(rt, 'record', record)
    try:
        with agent(client, seeded) as ag:
            ag.send_json({'t': 'event', 'code': 'LINK_LOSS_TIMEOUT', 'severity': 'WARN', 'robot_at': None, 'data': {'inflight': True}})
            assert entered.wait(1)
        release.set()
        async def drained():
            await asyncio.wait_for(rt.audit.join(), 2)
        run(client, drained)
    finally:
        release.set()
    with DBSession(client.app.state.engine) as db:
        assert db.scalar(select(Event).where(Event.code == 'LINK_LOSS_TIMEOUT')).data['inflight'] is True


def test_audit_capacity_evicts_only_ordinary_and_retains_fifo_and_safety():
    async def check():
        q = AuditQueue(3)
        def put(code, number):
            try:
                q.put_nowait(Effect('audit', 'r', {'op': 'AGENT_EVENT', 'code': code, 'number': number}))
            except asyncio.QueueFull:
                if code != 'ORDINARY':
                    pytest.fail('Safety record was dropped at capacity')
                raise
        put('LINK_LOSS_TIMEOUT', 0)
        put('ORDINARY', 1)
        put('SERVER_LINK_LOST', 2)
        put('ORDINARY', 3)
        assert q.take_dropped() == 1
        for n in range(4, 1004):
            put('LINK_LOSS_TIMEOUT', n)
        # Number 3 was the only other ordinary record. Safety-only overflow
        # spills rather than evicting another safety record or growing RAM.
        assert q.take_dropped() == 1 and len(q._queue.memory) <= 3
        with pytest.raises(asyncio.QueueFull):
            put('ORDINARY', 1004)
        assert q.take_dropped() == 1
        seen = []
        while not q.empty():
            seen.append(q.get_nowait().body['number'])
            q.task_done()
        try:
            await asyncio.wait_for(q.join(), .1)
        except asyncio.TimeoutError:
            pytest.fail('Evicted ordinary records must not leave unfinished queue work')
        assert seen == [0, 2, *range(4, 1004)]
    asyncio.run(check())


@pytest.mark.parametrize('viewers,delay', [(6, .3), (6, .45), (20, .45)])
def test_batched_reads_reserve_control_and_agent_capacity_under_viewer_load(client, seeded, rt, viewers, delay):
    rid = str(seeded['robots']['mine'])
    counts = {'view': 0, 'control': 0, 'agent': 0}
    def slow(conn, cursor, statement, parameters, context, many):
        if conn.engine is rt.agent_engine:
            counts['agent'] += 1
            time.sleep(delay)
        elif 'JOIN sessions' in statement or 'FROM robots' in statement:
            counts['control' if conn.engine is rt.control_engine else 'view'] += 1
            time.sleep(delay / 2)
    for engine in (rt.view_engine, rt.control_engine, rt.agent_engine):
        event.listen(engine, 'before_cursor_execute', slow)
    with ExitStack() as stack:
        agents = []
        async def heartbeat():
            while True:
                for robot_id, socket in list(agents):
                    await socket._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps(
                        state(3, stop_ref=rt.arbiter.robot(robot_id).stop_ref))})
                await asyncio.sleep(.1)
        async def start():
            return asyncio.create_task(heartbeat())
        async def stop_heartbeat():
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
        heartbeat_task = run(client, start)
        stack.callback(lambda: run(client, stop_heartbeat))
        ag = stack.enter_context(agent(client, seeded))
        agents.append((rid, ag))
        if viewers == 20:
            with DBSession(client.app.state.engine) as db:
                password_hash = db.get(User, seeded['users']['one']).password_hash
                for n in range(19):
                    db.add(User(org_id=seeded['org'], username=f'review-user-{n}', display_name='review',
                                role='OPERATOR', password_hash=password_hash))
                robot_ids = [uuid4() for _ in range(9)]
                for robot_id in robot_ids:
                    db.add(Robot(id=robot_id, org_id=seeded['org'], name='review-' + str(robot_id), model='unitree_go2', simulation=True,
                        owner_user_id=seeded['users']['one'], agent_token_hash=digest('fake-test-' + str(robot_id))))
                db.commit()
            for robot_id in robot_ids:
                other_seed = {**seeded, 'robots': {**seeded['robots'], 'mine': robot_id}}
                other = stack.enter_context(agent(client, other_seed))
                agents.append((str(robot_id), other))
        usernames = ['one', *[f'review-user-{n}' for n in range(19)]] if viewers == 20 else ['one'] * viewers
        sockets = [stack.enter_context(slow_screen(client, app_token(client, name))) for name in usernames]
        stack.callback(lambda: run(client, stop_heartbeat))
        ws = sockets[0]
        time.sleep(.7)
        errors, retakes = [], []
        def acquire():
            for attempt in range(25):
                answer = reply(ws, send(ws, 'lease.take', rid))
                if not answer['ok']:
                    errors.append(answer['error']['code'])
                    assert answer['error']['code'] in ('POLICY_STALE', 'ROBOT_AUTH_PENDING'), answer
                    time.sleep(.02)
                    continue
                receive(ag, 'lease')
                receive(ag, 'stop')
                async def confirmed():
                    async with asyncio.timeout(1.5):
                        while rt.arbiter.robot(rid).holder is None and rt.arbiter.robot(rid).transfer:
                            await asyncio.sleep(.01)  # heartbeat feeds actual causal reference
                    return rt.arbiter.robot(rid).holder is not None
                if run(client, confirmed):
                    return receive(ws, 'lease', predicate=lambda m: bool(m.get('lease_id')))['lease_id']
                errors.append('CONFIRM_CANCELED')
            pytest.fail(f'No fresh take window: {errors}')
        lease = acquire()
        answers, fresh = [], {r: 0 for r, _ in agents}
        for seq in range(20):
            if rt.arbiter.robot(rid).holder is None:
                # This is an explicit new take, never automatic command replay.
                # Report each lost lease instead of calling this continuous motion.
                retakes.append(seq)
                lease = acquire()
            answers.append(reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=seq, axes=[0, 0, 0])))
            for robot_id, _ in agents:
                fresh[robot_id] += rt.clock() - rt.agents[robot_id].auth_checked <= .5
            time.sleep(.05)
        # This is a measured availability regression, not a hard realtime SLA.
        # Keep the 500ms refusal and explicit re-take visible under scheduling jitter.
        assert sum(a['ok'] for a in answers) >= 15, answers
        assert all(a['ok'] or a['error']['code'] in ('POLICY_STALE', 'ROBOT_AUTH_PENDING', 'LEASE_MISMATCH') for a in answers)
        assert all(n >= 15 for n in fresh.values()), fresh
        print('SNAPSHOT_MAX_READ_SECONDS=', {lane: round(p.max_latency, 3) for lane, p in rt.policy_pipelines.items()},
              'AGENT_MAX_READ_SECONDS=', round(rt.agent_pipeline.max_latency, 3), 'EXPLICIT_RETAKES=', retakes,
              'FRESH_AGENT_SAMPLES=', fresh)
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop')
        released = reply(ws, send(ws, 'lease.release', rid))
        assert released['ok'] or (released['error']['code'] == 'LEASE_MISMATCH' and rt.arbiter.robot(rid).holder is None), released
        assert rt.arbiter.robot(rid).holder is None
        assert len(rt.policy_pipelines) == 2
        assert len(rt.agents) == (10 if viewers == 20 else 1)
        assert rt.auth_executor is not rt.control_executor is not rt.agent_executor
        assert all(len(p.pending) <= p.limit for p in rt.policy_pipelines.values())
        print(f'VIEWERS={viewers} USERS={len(set(usernames))} DELAY={delay}: cmd={sum(a["ok"] for a in answers)}/20 take_errors={errors} cmd_errors={[a['error']['code'] for a in answers if not a['ok']]} SQL={counts}')


def test_take_stop_and_release_survive_exhausted_admission_pool(client, seeded, rt):
    from .test_realtime import take
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        with ExitStack() as held:
            # The owner lock already occupies one admission connection.
            for _ in range(rt.read_engine.pool.size() - 1):
                held.enter_context(rt.read_engine.connect())
            for _ in range(rt.view_engine.pool.size()):
                held.enter_context(rt.view_engine.connect())
            time.sleep(.7)
            lease = take(ws, ag, rid)
            assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=[1, 0, 0]))['ok']
            assert receive(ag, 'cmd')['axes'] == [1, 0, 0]
            assert reply(ws, send(ws, 'stop', rid))['ok']
            receive(ag, 'stop')
            assert reply(ws, send(ws, 'lease.release', rid))['ok']
            assert rt.arbiter.robot(rid).holder is None


def test_multiple_spills_have_independent_storage_and_reuse_after_drain():
    from apps.server.fh_server.history import History
    for _ in range(3):
        a, b = History(1, lambda _: True), History(1, lambda _: True)
        for n in range(20):
            a.append(('a', n))
            b.append(('b', n))
        assert a.file.name != b.file.name
        assert a.drain(20) == [('a', n) for n in range(20)]
        assert b.drain(20) == [('b', n) for n in range(20)]
        assert a.spill is b.spill is None


def test_shared_read_capacity_never_builds_executor_queue():
    from concurrent.futures import ThreadPoolExecutor
    from apps.server.fh_server.realtime import ReadAhead
    gate, all_started = threading.Event(), threading.Event()
    lock = threading.Lock()
    started = 0
    clock = [0.0]
    def blocked():
        nonlocal started
        with lock:
            started += 1
            if started == 8:
                all_started.set()
        gate.wait(3)
    async def check():
        executor = ThreadPoolExecutor(max_workers=8)
        pipelines = [ReadAhead(blocked, lambda: clock[0], executor) for _ in range(10)]
        try:
            assert await asyncio.to_thread(all_started.wait, 2)
            # Every reserved job has actually started and none can complete.
            # Advancing eligibility cannot admit a ninth job behind these eight.
            clock[0] += 10
            for _ in range(10):
                await asyncio.sleep(.003)
            assert sum(p.submitted for p in pipelines) == started == 8
            assert sum(len(p.pending) for p in pipelines) == 8
            assert all(p.capacity.locked() for p in pipelines)
        finally:
            gate.set()
            await asyncio.gather(*(p.close() for p in pipelines))
            await asyncio.to_thread(executor.shutdown, wait=True, cancel_futures=True)
    asyncio.run(check())


def test_reserved_resources_are_distinct(rt):
    assert len({id(e) for e in (rt.auth_executor, rt.control_executor, rt.agent_executor, rt.stop_executor)}) == 4
    assert len({id(e) for e in (rt.read_engine, rt.view_engine, rt.control_engine, rt.agent_engine, rt.stop_engine)}) == 5
    assert rt.control_factory.kw['bind'] is rt.control_engine
    assert rt.agent_factory.kw['bind'] is rt.agent_engine


def test_many_idle_screens_share_one_low_rate_policy_query(client, rt):
    count = []
    def query(conn, cursor, statement, parameters, context, many):
        count.append(statement)
    with ExitStack() as stack:
        for _ in range(20):
            stack.enter_context(screen(client, app_token(client)))
        for engine in (rt.view_engine, rt.control_engine):
            event.listen(engine, 'before_cursor_execute', query)
        try:
            time.sleep(.3)
            assert len(count) <= 12, len(count)
            assert len(rt.policy_pipelines) == 2
            print('IDLE_20_SCREENS_SQL_300MS=', len(count))
        finally:
            for engine in (rt.view_engine, rt.control_engine):
                event.remove(engine, 'before_cursor_execute', query)


def test_dead_snapshot_producers_restart_and_keep_start_based_freshness(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        async def check():
            original = [*rt.policy_pipelines.values(), rt.agent_pipeline]
            for p in original:
                p.task.cancel()
            await asyncio.gather(*(p.task for p in original), return_exceptions=True)
            async with asyncio.timeout(1):
                while (any(p in original for p in rt.policy_pipelines.values())
                       or rt.agent_pipeline in original):
                    await asyncio.sleep(.01)
            assert all(not p.task.done() for p in [*rt.policy_pipelines.values(), rt.agent_pipeline])
            assert rt.clock() - rt.agents[rid].auth_checked <= .5
        run(client, check)
        assert reply(ws, send(ws, 'stop', rid))['ok']


def test_internal_validation_error_is_not_protocol_mismatch(client, seeded, rt, monkeypatch):
    from apps.contracts import models as C
    def broken(*args):
        C.Battery.model_validate({'soc': 2})
    with agent(client, seeded) as ag:
        monkeypatch.setattr(rt, 'accept_state', broken)
        ag.send_json(state())
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(ag, 'never')
        assert closed.value.code == 1011 and closed.value.reason == 'INTERNAL_VALIDATION'


def test_pending_same_session_consumer_keeps_shared_producers_alive(client, seeded, rt):
    from dataclasses import replace
    from apps.server.fh_server.realtime import Peer
    from .test_realtime_review import Sink
    actor = rt.identity(app_token(client), {}, 'first')
    async def check():
        first = Peer(Sink(), actor=actor)
        pending = Peer(Sink(), actor=replace(actor, connection='pending'))
        await rt.refresh_policy(first)
        await rt.refresh_policy(pending)
        assert len(rt.policy_members[actor.session]) == 2
        producers = list(rt.policy_pipelines.values())
        await rt.release_policy(first)
        assert actor.session in rt.policy_loads
        assert all(not p.task.done() for p in producers)
        await rt.refresh_policy(pending)
        assert pending.policy.rights
        await rt.release_policy(pending)
        assert not rt.policy_members and not rt.policy_pipelines and not rt.policy_loads
    run(client, check)


def test_live_rows_still_control_memoized_rights_and_session_validity(client, seeded, rt):
    from apps.server.fh_server.models import Session as DBUserSession, now
    from apps.server.fh_server.realtime import Peer, policy_rights
    from .test_realtime_review import Sink
    actor = rt.identity(app_token(client), {}, 'memo')
    rid = str(seeded['robots']['mine'])
    async def snapshot():
        rt.policy_peers[actor.session] = Peer(Sink(), actor=actor)
        return (await asyncio.to_thread(rt.load_policy_batch, 'view'))[actor.session]
    first = run(client, snapshot)
    assert 'O_OWN' in first.rights[rid]
    second = run(client, snapshot)
    assert second.rights is first.rights and policy_rights.cache_info().currsize <= 256
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).owner_user_id = seeded['users']['two']
        db.commit()
    assert 'O_OWN' not in run(client, snapshot).rights[rid]
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = False
        db.get(User, seeded['users']['one']).role = 'ORG_ADMIN'
        db.commit()
    promoted = run(client, snapshot).rights[rid]
    assert 'O_OWN' not in promoted and 'ADMIN_NO_REAL_CONTROL' in promoted
    assert 'ROBOT_READ' in promoted
    with DBSession(client.app.state.engine) as db:
        db.get(DBUserSession, actor.session).revoked_at = now()
        db.commit()
    assert isinstance(run(client, snapshot), rt.api_error)


def test_known_screen_denial_blocks_input_before_close_finishes(client, seeded, rt, monkeypatch):
    from apps.server.fh_server.realtime import Peer
    monkeypatch.setattr(rt, 'clock', lambda: 0)
    actor = rt.identity(app_token(client), {}, 'deny-screen')
    policy = rt.load_policy(actor)
    async def check():
        entered, release = asyncio.Event(), asyncio.Event()
        class Socket:
            async def close(self, **kwargs):
                entered.set()
                await release.wait()
        peer = Peer(Socket(), actor=actor, policy=policy)
        task = asyncio.create_task(rt.deny_screen(peer, 4401))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            blocked = False
            try:
                rt.cached_access(peer, [str(seeded['robots']['mine'])], 'O_OWN')
            except rt.api_error:
                blocked = True
            # pytest.raises.fail is BaseException and stops AnyIO's portal;
            # an assertion keeps failed-mutation teardown observable as well.
            assert blocked, 'A known denial must block input before socket close completes'
        finally:
            release.set()
            await task
    run(client, check)


def test_known_agent_denial_cannot_confirm_a_new_take_during_close(client, seeded, rt, monkeypatch):
    from types import SimpleNamespace
    from apps.server.fh_server.realtime import Peer
    from apps.contracts import models as C
    from .test_realtime_review import Sink
    monkeypatch.setattr(rt, 'clock', lambda: 0)
    actor = rt.identity(app_token(client), {}, 'deny-agent')
    policy = rt.load_policy(actor)
    rid = str(seeded['robots']['mine'])
    async def check():
        entered, release = asyncio.Event(), asyncio.Event()
        class Socket:
            async def close(self, **kwargs):
                entered.set()
                await release.wait()
        peer = Peer(Socket(), auth_checked=rt.clock(), simulation=True)
        rt.agents[rid] = peer
        rt.screens[actor.connection] = Peer(Sink(), actor=actor, policy=policy)
        alive = asyncio.create_task(asyncio.Event().wait())
        pending = SimpleNamespace(task=alive, latest={rid: (rt.api_error(403, 'FORBIDDEN', 'review'), peer)}, stamp=rt.clock())
        saved, rt.agent_pipeline = rt.agent_pipeline, pending
        task = asyncio.create_task(rt._agent_watch(rid, peer, pending))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            rt.arbiter.take(rid, actor)
            reference = rt.arbiter.robot(rid).stop_ref
            accepted = rt.accept_state(rid, peer, C.AgentState.model_validate(state(3, stop_ref=reference)))
            assert not accepted and rt.arbiter.robot(rid).holder is None
        finally:
            release.set()
            await task
            alive.cancel()
            await asyncio.gather(alive, return_exceptions=True)
            rt.agent_pipeline = saved
            rt.agents.pop(rid, None)
            rt.screens.pop(actor.connection, None)
            rt.arbiter.revoke(rid, op=None)
    run(client, check)


def test_repeated_ordinary_audits_preserve_full_aggregate_count(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    clock = [rt.clock()]
    monkeypatch.setattr(rt, 'clock', lambda: clock[0])
    async def check():
        rt.tasks[1].cancel()
        await asyncio.gather(rt.tasks[1], return_exceptions=True)
        for _ in range(500):
            rt.note_audit(rid, {'op': 'CMD_SEQ', 'user_id': str(seeded['users']['one'])})
        clock[0] += 1.1
        rt.flush_audits()
        records = [e for e in rt.audit._queue if e.body['op'] == 'CMD_SEQ']
        assert len(records) == 2
        assert sum(e.body.get('_count', 1) for e in records) == 500
    run(client, check)


def test_brief_agent_verifier_error_retries_before_revoking_fresh_authority(client, seeded, rt, monkeypatch):
    from types import SimpleNamespace
    from apps.server.fh_server.realtime import Peer
    from apps.server.fh_server.leases import Actor
    from .test_realtime_review import Sink
    from .test_realtime_r2 import temporary_db_error
    monkeypatch.setattr(rt, 'clock', lambda: 0)
    rid = str(seeded['robots']['mine'])
    async def check():
        peer = Peer(Sink(), auth_checked=0, simulation=True)
        rt.agents[rid] = peer
        actor = Actor(str(seeded['users']['one']), str(uuid4()), 'verifier')
        rt.arbiter.take(rid, actor)
        rt.arbiter.state(rid, True, [0, 0, 0], 1, rt.arbiter.robot(rid).stop_ref)
        lease = rt.arbiter.robot(rid).holder.lease_id
        retried = asyncio.Event()
        calls = 0
        async def next_result():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise temporary_db_error()
            retried.set()
            await asyncio.Event().wait()
        alive = asyncio.create_task(asyncio.Event().wait())
        pending = SimpleNamespace(task=alive, latest=None, stamp=0, next=next_result)
        saved, rt.agent_pipeline = rt.agent_pipeline, pending
        task = asyncio.create_task(rt._agent_watch(rid, peer, pending))
        ready = asyncio.create_task(retried.wait())
        try:
            await asyncio.wait((task, ready), timeout=1, return_when=asyncio.FIRST_COMPLETED)
            assert retried.is_set() and not task.done(), 'A fresh identity must survive a brief verifier failure'
            assert not peer.socket.closed
            assert rt.arbiter.robot(rid).holder.lease_id == lease
        finally:
            task.cancel()
            alive.cancel()
            ready.cancel()
            await asyncio.gather(task, alive, ready, return_exceptions=True)
            rt.agent_pipeline = saved
            rt.agents.pop(rid, None)
            rt.arbiter.revoke(rid, op=None)
    run(client, check)

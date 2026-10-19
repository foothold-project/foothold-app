"""Read latency, archival head-of-line blocking and protocol-version regressions."""
import asyncio
import json
import time
from pathlib import Path
from dataclasses import replace

import pytest
from anyio import WouldBlock
from sqlalchemy import event, select
from sqlalchemy.orm import Session as DBSession
from starlette.websockets import WebSocketDisconnect

from apps.server.fh_server.realtime import BoundAgentHeaders, ReadAhead, AuditQueue
from apps.server.fh_server.models import Event
from apps.server.fh_server.leases import Effect
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take
from .test_realtime_review import run
from .test_realtime_pr13 import slow_screen


@pytest.mark.parametrize('delay', [.3, .45])
@pytest.mark.parametrize('mode', ['call', 'connection'])
def test_slow_reads_keep_20hz_commands_and_take_available(client, seeded, rt, monkeypatch, delay, mode):
    original_policy, original_agent = rt.load_policy_batch, rt.load_agent_batch
    def policy(actor):
        time.sleep(delay)
        return original_policy(actor)
    def identity():
        time.sleep(delay)
        return original_agent()
    if mode == 'call':
        monkeypatch.setattr(rt, 'load_policy_batch', policy)
        monkeypatch.setattr(rt, 'load_agent_batch', identity)
    else:
        def delay_connection(conn, cursor, statement, parameters, context, many):
            # Sleep after checkout: model latency while the DB connection is
            # occupied, rather than sleeping outside the pool in a wrapper.
            if conn.engine is rt.agent_engine or 'robots.id =' in statement:
                time.sleep(delay)  # bound agent check: one SELECT
            elif 'FROM robots' in statement or 'JOIN sessions' in statement:
                time.sleep(delay / 2)  # policy: two SELECTs total
        for engine in (rt.read_engine, rt.view_engine, rt.control_engine, rt.agent_engine):
            event.listen(engine, 'before_cursor_execute', delay_connection)
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, slow_screen(client, app_token(client)) as ws:
        time.sleep(.7)  # fill the overlapping read pipeline, no policy age relaxation
        # 450ms leaves only a 50ms freshness window. Sample explicit take
        # attempts across it; a stale attempt must remain rejected, never gain
        # a post-read TTL. Even after warming, scheduling can consume that window.
        take_errors, retakes = [], []
        def acquire():
            for attempt in range(25):
                result = reply(ws, send(ws, 'lease.take', rid))
                if not result['ok']:
                    take_errors.append(result['error']['code'])
                    assert result['error']['code'] in ('POLICY_STALE', 'ROBOT_AUTH_PENDING'), result
                    time.sleep(.02)
                    continue
                receive(ag, 'lease')
                stop = receive(ag, 'stop')
                async def feedback():
                    reference = stop['stop_ref']
                    async with asyncio.timeout(1.8):
                        while rt.arbiter.robot(rid).holder is None and rt.arbiter.robot(rid).transfer:
                            while True:
                                try:
                                    packet = ag._send_rx.receive_nowait()
                                except WouldBlock:
                                    break
                                frame = json.loads(packet.get('text', '{}'))
                                if frame.get('t') == 'stop':
                                    reference = frame['stop_ref']
                            await ag._receive_tx.send({'type': 'websocket.receive', 'text':
                                json.dumps(state(3, stop_ref=reference))})
                            await asyncio.sleep(.05)
                    return rt.arbiter.robot(rid).holder
                holder = run(client, feedback)
                if holder:
                    return receive(ws, 'lease', predicate=lambda m: m.get('lease_id') == holder.lease_id)['lease_id']
                take_errors.append('CONFIRM_CANCELED')
            pytest.fail(f'No fresh take window: {take_errors}')
        lease = acquire()
        accepted, errors = 0, []
        for seq in range(40):
            if rt.arbiter.robot(rid).holder is None:
                retakes.append(seq)
                lease = acquire()  # explicit test input; no product auto-retry
            started = time.monotonic()
            result = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=seq, axes=[0, 0, 0]))
            accepted += result['ok']
            if not result['ok']:
                errors.append(result['error']['code'])
            time.sleep(max(0, .05 - (time.monotonic() - started)))
        print(f'DB_DELAY={delay} ({mode}): CMD {accepted}/40, errors={errors}, '
              f'take_rejections={take_errors}, explicit_retakes={retakes}')
        minimum = 30 if mode == 'connection' else 36
        assert accepted >= minimum, (accepted, errors)
        async def discard_observed_frames():
            while True:
                try:
                    ag._send_rx.receive_nowait()
                except WouldBlock:
                    return
        run(client, discard_observed_frames)
        before = time.monotonic()
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop', timeout=.15)
        assert time.monotonic() - before < .15


def test_400_event_backlog_does_not_delay_take_confirmation_or_safety(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        assert reply(ws, send(ws, 'lease.take', rid))['ok']
        receive(ag, 'lease')
        stop = receive(ag, 'stop')
        started = time.monotonic()
        async def burst():
            # One producer callback models an already-buffered backlog, rather
            # than measuring 402 synchronous thread/portal round trips.
            for n in range(400):
                frame = {'t': 'event', 'code': 'FAKE_HISTORY', 'severity': 'WARN', 'robot_at': None, 'data': {'number': n}}
                await ag._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps(frame)})
            for frame in ({'t': 'event', 'code': 'LINK_LOSS_TIMEOUT', 'severity': 'WARN', 'robot_at': None, 'data': {}},
                          state(100, stop_ref=stop['stop_ref'])):
                await ag._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps(frame)})
        run(client, burst)
        lease = receive(ws, 'lease', predicate=lambda m: bool(m.get('lease_id')), timeout=.6)
        assert lease['lease_id'] and time.monotonic() - started < .6
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop', timeout=.15)
        async def drain():
            await asyncio.wait_for(rt.agents[rid].archive.join(), 6)
            await asyncio.wait_for(rt.audit.join(), 3)
        run(client, drain)
    with DBSession(client.app.state.engine) as db:
        rows = list(db.scalars(select(Event).where(Event.code.in_(['FAKE_HISTORY', 'LINK_LOSS_TIMEOUT'])).order_by(Event.id)))
        summaries = list(db.scalars(select(Event).where(Event.robot_id == seeded['robots']['mine'],
            Event.code == 'AUDIT_DROPPED')))
    ordinary = [r.data['number'] for r in rows if r.code == 'FAKE_HISTORY']
    assert ordinary == sorted(set(ordinary)) and all(0 <= n < 400 for n in ordinary)
    omitted = sum(r.data['count'] for r in summaries if r.data.get('source') == 'ROBOT_HISTORY')
    assert len(ordinary) + omitted == 400
    assert ordinary  # protected transitions also occupy this integration FIFO
    assert next(i for i, r in enumerate(rows) if r.code == 'LINK_LOSS_TIMEOUT') == len(ordinary)


@pytest.mark.parametrize('phase', ['hello', 'followup'])
def test_old_agent_proto_is_explicit_protocol_close_with_reason_audit(client, seeded, rt, phase):
    rid = str(seeded['robots']['mine'])
    if phase == 'hello':
        from .test_realtime import hello
        with client.websocket_connect('wss://testserver/api/v1/agent/ws', headers={'authorization': 'Bearer fake-test-' + rid}) as ag:
            raw = hello()
            raw['proto'] = 'fh-agent/1'
            ag.send_json(raw)
            with pytest.raises(WebSocketDisconnect) as error:
                receive(ag)
    else:
        with agent(client, seeded) as ag:
            ag.send_json({'t': 'ping', 'proto': 'fh-agent/1'})
            with pytest.raises(WebSocketDisconnect) as error:
                receive(ag, 'never')
    assert error.value.code == 4406
    assert error.value.reason == 'PROTOCOL_MISMATCH'
    run(client, rt.audit.join)
    with DBSession(client.app.state.engine) as db:
        assert db.scalar(select(Event).where(Event.code == 'AGENT_PROTOCOL_MISMATCH'))


def test_bound_agent_recheck_reads_one_robot_and_compares_digest(client, seeded, rt, monkeypatch):
    statements, comparisons = [], []
    from apps.server.fh_server import realtime as module
    original = module.hmac.compare_digest
    def compare(a, b):
        comparisons.append((len(a), len(b)))
        return original(a, b)
    monkeypatch.setattr(module.hmac, 'compare_digest', compare)
    def query(conn, cursor, statement, parameters, context, many):
        statements.append(statement)
    event.listen(rt.read_engine, 'before_cursor_execute', query)
    try:
        rid = str(seeded['robots']['mine'])
        headers = BoundAgentHeaders({'authorization': 'Bearer fake-test-' + rid}, rid)
        assert rt.agent_identity(headers) == rid
    finally:
        event.remove(rt.read_engine, 'before_cursor_execute', query)
    assert len(statements) == 1 and 'robots.id =' in statements[0]
    assert comparisons == [(32, 32)]


def test_read_ahead_has_finite_pending_slots_and_start_based_age(rt):
    import threading
    gate = threading.Event()
    async def check():
        pipeline = ReadAhead(lambda: gate.wait(2), rt.clock, rt.control_executor)
        try:
            await asyncio.sleep(.7)
            assert len(pipeline.pending) <= 32
            assert len(pipeline.pending) >= 20  # sequential refresh would starve .45s reads
            pipeline.next_start = float('inf')
            existing_starts = set(pipeline.pending.values())
            released = rt.clock()
            gate.set()
            _, started = await pipeline.next()
            assert started in existing_starts and started < released
        finally:
            gate.set()
            await pipeline.close()
            await asyncio.gather(*pipeline.pending, return_exceptions=True)
    asyncio.run(check())


def test_tracked_uvicorn_launches_use_only_os_assigned_loopback_fds():
    import ast
    root = Path(__file__).resolve().parents[1]
    launches, bindings = 0, 0
    for folder in ('tests', 'tools'):
        for path in (root / folder).glob('*.py'):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'bind':
                    assert ast.literal_eval(node.args[0]) == ('127.0.0.1', 0), path
                    bindings += 1
                if isinstance(node, ast.List):
                    constants = [n.value for n in node.elts if isinstance(n, ast.Constant)]
                    if 'uvicorn' in constants:
                        assert '--fd' in constants and '--port' not in constants, path
                        assert 8453 not in constants and 8792 not in constants, path
                        launches += 1
    assert launches >= 2 and bindings >= 2


def test_real_old_declared_proto_enters_stopped_slow_retry(seeded, tmp_path, monkeypatch):
    from foothold_agent.link.client import Client, Settings
    from foothold_agent.link.session import Session, Effects
    from foothold_agent.link import client as module
    from .ws_process import server_process
    async def check(server):
        class LegacyDeclaration(Session):
            def connect(self):
                effects = super().connect()
                hello, *rest = effects.messages
                return Effects(effects.motion, ({**hello, 'proto': 'fh-agent/1'}, *rest))
        class Sink:
            def apply(self, command):
                pass
        session = LegacyDeclaration()
        waiting = asyncio.Event()
        delays = []
        real_sleep = asyncio.sleep
        async def sleep(delay):
            if delay >= 30:
                delays.append(delay)
                waiting.set()
                await asyncio.Event().wait()  # cancel before waiting 30 real seconds
            else:
                await real_sleep(delay)
        monkeypatch.setattr(module.asyncio, 'sleep', sleep)
        c = Client(session, Sink(), Settings(server['base'] + '/api/v1/agent/ws', server['agent_token']))
        task = asyncio.create_task(c.run())
        try:
            await asyncio.wait_for(waiting.wait(), 3)
            assert delays == [30] and not task.done()
            assert session.protocol_rejected and session.core.latch
            assert session.core.out == (0, 0, 0) and not session.lease_confirmed
            closed = next(m for m in session._messages if m.get('code') == 'SERVER_CLOSED')
            assert closed['data'] == {**closed['data'], 'close_code': 4406, 'retry': True}
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    with server_process(seeded, tmp_path) as server:
        asyncio.run(check(server))


def test_global_audit_full_preserves_safety_and_frees_control(client, rt):
    from apps.server.fh_server.leases import Actor
    async def check():
        rt.tasks[1].cancel()
        await asyncio.gather(rt.tasks[1], return_exceptions=True)
        saved = rt.audit
        rt.audit = AuditQueue(1)
        actor = Actor('u', 's', 'c')
        rt.arbiter.take('r', actor)
        rt.arbiter.state('r', True, [0, 0, 0], 1, 1)
        assert rt.arbiter.robot('r').holder
        try:
            for op in ('STOP', 'EXPIRE', 'RELEASE'):
                assert rt.queue_audit(Effect('audit', 'r', {'op': op}))
            assert rt.audit_overloaded and rt.arbiter.robot('r').holder is None
            assert len(rt.audit._queue.memory) == 1
            assert rt.audit.qsize() == 4
            assert [rt.audit.get_nowait().body['op'] for _ in range(4)] == ['STOP', 'EXPIRE', 'EXPIRE', 'RELEASE']
        finally:
            rt.audit = saved
    run(client, check)

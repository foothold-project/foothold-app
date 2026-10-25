"""PR #10 review regressions: bounded external input and independent safety I/O."""
import asyncio
from dataclasses import replace
from datetime import timedelta
import json
import time
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session as DBSession
from starlette.websockets import WebSocketDisconnect

from apps.contracts import models as C
from apps.server.fh_server.leases import Actor, Effect
from apps.server.fh_server.models import Event, LeaseLog, Robot, now
from apps.server.fh_server.realtime import AuditQueue, Peer, Policy
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take, drain_audit


class Sink:
    def __init__(self):
        self.messages = []
        self.closed = []

    async def send_json(self, body):
        self.messages.append(body)

    async def close(self, code=1000):
        self.closed.append(code)


def run(client, callback):
    try:
        return client.portal.call(callback)
    except TimeoutError:
        pytest.fail('Expected realtime state transition within its explicit deadline')


def test_b1_repeated_denied_stop_agent_events_bounded_and_new_take_survives(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    async def flood():
        rt.tasks[1].cancel()
        await asyncio.gather(rt.tasks[1], return_exceptions=True)
        accepted = 0
        for n in range(5_000):
            if not rt.audit.admission_open(rid):
                break
            rt.apply([Effect('audit', rid, {'op': 'STOP', 'data': {'number': n},
                                          'user_id': str(seeded['users']['one'])})])
            accepted += 1
            await asyncio.sleep(0)
        assert 1 <= accepted <= 480
        rt.block_archive_source(rid, 'CAPACITY')
        channel = rt.audit.channel(rid)
        await channel.queue._queue.writable()
        records = await rt.audit._queue.snapshot()
        assert [e.body['data']['number'] for e in records if e.body['op'] == 'STOP'] == list(range(accepted))
        assert not rt.failed and not rt.audit_overloaded
        while not rt.audit.empty():
            await rt.audit.get()
            rt.audit.task_done()
        await channel.queue._queue.writable()
        assert channel.blocked  # recovery does not silently resume a lease
        channel.retry_at = rt.clock() - 1  # explicitly advance the reconnect gate
        rt.tasks[1] = asyncio.create_task(rt.auditor())
    run(client, flood)
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        assert take(ws, ag, rid)
    drain_audit(client, rt)


def test_b1_full_queue_revokes_notifies_keeps_stop_and_recovers(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    headers = app_token(client)
    with agent(client, seeded) as ag, screen(client, headers) as ws:
        take(ws, ag, rid)
        drain_audit(client, rt)
        async def fill():
            rt.tasks[1].cancel()
            await asyncio.gather(rt.tasks[1], return_exceptions=True)
            original = rt.audit
            rt.audit = AuditQueue(2)
            for i in range(3):
                rt.apply([Effect('audit', rid, {'op': 'TAKE', 'user_id': str(seeded['users']['one'])})])
            assert rt.audit_overloaded
            assert rt.arbiter.robot(rid).holder is None
            assert not rt.failed
            return original
        original = run(client, fill)
        assert receive(ws, 'lease', predicate=lambda x: x['holder'] is None)['holder'] is None
        assert receive(ag, 'lease')['lease_id'] is None
        receive(ag, 'stop')
        ident = send(ws, 'lease.take', rid)
        assert reply(ws, ident)['error']['code'] == 'SERVER_BUSY'
        ident = send(ws, 'stop', rid)
        assert receive(ag, 'stop')['t'] == 'stop'
        assert reply(ws, ident)['ok']
        async def recover():
            while not rt.audit.empty():
                rt.audit.get_nowait()
                rt.audit.task_done()
            rt.flush_audits()
            assert not rt.audit_overloaded
            rt.audit = original
            rt.tasks[1] = asyncio.create_task(rt.auditor())
        run(client, recover)
        # A fresh connection is usable after the overload, no server restart.
        with screen(client, headers) as fresh:
            assert take(fresh, ag, rid, gen=20)


def test_b2_stop_bypasses_slow_db_and_twenty_queued_commands(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease = take(ws, ag, rid)
        import threading
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        original = rt.load_policy_batch
        def slow(lane):
            entered.set()
            release.wait(5)
            finished.set()
            return original(lane)
        monkeypatch.setattr(rt, 'load_policy_batch', slow)
        assert entered.wait(1)
        # Prequeue all frames together, including STOP; never wait for cmd replies.
        async def backlog():
            for seq in range(20):
                await ws._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps({
                    't': 'cmd', 'id': str(seq), 'robot': rid, 'lease_id': lease, 'seq': seq, 'axes': [1, 0, 0]})})
            begin = time.monotonic()
            await ws._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps({
                't': 'stop', 'id': 'urgent-stop', 'robot': rid})})
            return begin
        run(client, backlog)
        try:
            receive(ag, 'stop')
            assert reply(ws, 'urgent-stop')['ok']
            assert not finished.is_set(), 'STOP waited for the blocked policy read'
        finally:
            release.set()


def test_b1_connection_ingress_bound_closes_flooder_only(client, seeded, rt):
    rid = seeded['robots']['mine']
    headers = app_token(client)
    with screen(client, headers) as ws:
        async def flood():
            peer = next(iter(rt.screens.values()))
            peer.budget = 0
            peer.budget_at = rt.clock() + 1  # no refill before the next frame
        run(client, flood)
        send(ws, 'ping')
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ws, 'reply')
        assert error.value.code == 1013
    assert not rt.failed
    with agent(client, seeded) as ag, screen(client, headers) as fresh:
        assert take(fresh, ag, rid)


def test_disconnect_pending_transfer_is_revoked(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag:
        with screen(client, app_token(client)) as ws:
            ident = send(ws, 'lease.take', rid)
            assert reply(ws, ident)['ok']
            receive(ag, 'lease'); receive(ag, 'stop')
            assert rt.arbiter.robot(rid).transfer
        async def verify():
            await asyncio.sleep(.01)
            assert rt.arbiter.robot(rid).transfer is None
        run(client, verify)
        assert receive(ag, 'lease')['lease_id'] is None


def test_disconnect_pending_request_is_canceled(client, seeded, rt):
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = True
        db.commit()
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as owner:
        take(owner, ag, rid)
        with screen(client, app_token(client, 'admin')) as requester:
            assert reply(requester, send(requester, 'lease.request', rid))['ok']
            req = receive(owner, 'lease.requested')
        assert receive(owner, 'lease.result', predicate=lambda x: x['request_id'] == req['request_id'])['result'] == 'CANCELED'
        assert rt.arbiter.robot(rid).request is None


def test_disconnected_requester_cannot_be_granted_even_before_cleanup(client, seeded, rt):
    with DBSession(client.app.state.engine) as db:
        db.get(Robot, seeded['robots']['mine']).simulation = True
        db.commit()
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as owner, screen(client, app_token(client, 'admin')) as requester:
        take(owner, ag, rid)
        assert reply(requester, send(requester, 'lease.request', rid))['ok']
        req = receive(owner, 'lease.requested')
        async def remove_requester():
            connection = rt.arbiter.robot(rid).request.actor.connection
            return connection, rt.screens.pop(connection)
        key, peer = run(client, remove_requester)
        try:
            result = reply(owner, send(owner, 'lease.respond', rid, request_id=req['request_id'], accept=True))
            assert result['error']['code'] == 'LEASE_REQUEST_STALE'
            assert rt.arbiter.robot(rid).holder is not None
        finally:
            run(client, lambda: rt.screens.__setitem__(key, peer))


def test_safety_enqueue_discards_pre_stop_commands(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    async def check():
        peer = Peer(Sink())
        rt.agents[rid] = peer
        for seq in range(5):
            peer.queue.put_nowait({'t': 'cmd', 'seq': seq})
        rt.apply([Effect('agent', rid, {'t': 'lease', 'lease_id': None, 'holder_type': None}),
                  Effect('agent', rid, {'t': 'stop', 'by_user_id': None})])
        pending = [peer.queue.get_nowait() for _ in range(peer.queue.qsize())]
        assert [x['t'] for x in pending] == ['lease', 'stop']
        rt.agents.pop(rid)
    run(client, check)


def test_r3_auth_close_revokes_before_watch_can_be_cancelled(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        async def hold_snapshot(peer):
            pass
        # This test deliberately expires the cached snapshot, not the valid DB
        # session. Hold that fixture so read-ahead cannot restore the DB value.
        monkeypatch.setattr(rt, 'refresh_policy', hold_snapshot)
        async def expire_cached_session():
            peer = next(p for p in rt.screens.values() if p.actor.user == str(seeded['users']['one']))
            peer.policy = replace(peer.policy, expires_at=now() - timedelta(seconds=1))
        run(client, expire_cached_session)
        send(ws, 'ping')
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ws, 'reply')
        assert error.value.code == 4401
        assert rt.arbiter.robot(rid).holder is None
        assert receive(ag, 'lease')['lease_id'] is None


def test_r4_emergency_notifies_and_authority_recovers(client, seeded, rt):
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        rid = str(seeded['robots']['mine'])
        take(ws, ag, rid)
        async def lose():
            rt.owner_connection.execute(text('SELECT pg_advisory_unlock_all()'))
            rt.owner_connection.commit()
        run(client, lose)
        try:
            free = receive(ws, 'lease', predicate=lambda x: x['holder'] is None)
        except WebSocketDisconnect as error:
            pytest.fail(f'Expected FREE notification before close {error.code}')
        assert free['holder'] is None
        with pytest.raises(WebSocketDisconnect):
            receive(ws, 'reply')
    async def recovered():
        async with asyncio.timeout(2):
            while rt.failed:
                await asyncio.sleep(.01)
        assert rt.arbiter.robot(rid).holder is None
    run(client, recovered)
    with agent(client, seeded) as ag, screen(client, app_token(client)) as fresh:
        assert take(fresh, ag, rid)


def test_r6_run_takeover_and_i1_bound_run_lease(client, seeded, rt):
    rid, run_id = str(seeded['robots']['mine']), str(uuid4())
    with agent(client, seeded, run={'run_id': run_id, 'status': 'PAUSED', 'step': 0}) as ag, screen(client, app_token(client)) as ws:
        ag.send_json(state(2, stop_ref=ag.stop_ref))
        frame = receive(ag, 'lease')
        assert frame['holder_type'] == 'RUN:' + run_id
        assert C.AgentLease.model_validate(frame).holder_type == 'RUN:' + run_id
        take(ws, ag, rid, gen=3)
    drain_audit(client, rt)
    with DBSession(client.app.state.engine) as db:
        assert db.scalar(select(LeaseLog).where(LeaseLog.op == 'RUN_PAUSE_TAKEOVER'))


def test_r7_delivery_checks_cached_policy_without_db(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    async def check():
        sink = Sink()
        actor = Actor(str(seeded['users']['one']), str(uuid4()), 'delivery-test')
        policy = Policy({rid: frozenset({'ROBOT_READ'})}, C.OrgSettings(), now() + timedelta(hours=1), rt.clock())
        peer = Peer(sink, actor=actor, policy=policy, subscriptions={rid: {'state'}, 'other': {'state'}})
        def no_db(*args):
            raise AssertionError('Delivery must not perform SQL')
        monkeypatch.setattr(rt, 'access', no_db)
        task = asyncio.create_task(rt.writer(peer, True))
        peer.queue.put_nowait({'_delivery': {'t': 'event', 'robot': rid}})
        await asyncio.sleep(.01)
        assert sink.messages
        peer.policy = replace(policy, rights={})
        peer.queue.put_nowait({'_delivery': {'t': 'event', 'robot': rid}})
        await asyncio.sleep(.01)
        assert len(sink.messages) == 3
        assert sink.messages[-2]['t'] == 'lease' and sink.messages[-2]['holder'] is None
        assert sink.messages[-2]['lease_id'] is None
        assert sink.messages[-1] == {'t': 'subscription.revoked', 'robot': rid, 'reason': 'ACCESS_REVOKED'}
        assert sink.closed == []
        assert peer.subscriptions == {'other': {'state'}}
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    run(client, check)


def test_i2_invalid_agent_body_unknown_fields_and_binary_do_not_close(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease = take(ws, ag, rid)
        ag.send_json({'t': 'state', 'latched': 'wrong', 'stop_gen': 500})
        ag.send_text('broken json')
        ag.send_bytes(b'unimplemented video')
        ag.send_json({**state(4), 'future_field': {'ignored': True}})
        assert reply(ws, send(ws, 'ping'))['ok']
        assert rt.arbiter.robot(rid).holder is not None
        assert rt.arbiter.robot(rid).holder.lease_id == lease
        assert rt.arbiter.robot(rid).stop_gen == 4  # invalid 500 cannot change safety state
        ag.send_json({'t': 'event', 'code': 'FAKE_WARN', 'severity': 'warn', 'robot_at': None, 'data': {}})
    drain_audit(client, rt)
    with DBSession(client.app.state.engine) as db:
        assert db.scalar(select(Event).where(Event.code == 'AGENT_INVALID_FRAME'))
        event = db.scalar(select(Event).where(Event.code == 'FAKE_WARN'))
        assert event is not None and event.severity == 'WARN'


def test_i2_liveness_only_parseable_envelopes(client, seeded, rt):
    from .test_leases import Clock
    clock = Clock()
    rt.clock = rt.arbiter.clock = clock
    with agent(client, seeded) as ag:
        clock.at = 2
        ag.send_text('not json')
        ag.send_bytes(b'video')
        async def flush():
            await asyncio.sleep(.02)
            assert rt.agents[str(seeded['robots']['mine'])].last_rx == 0
        run(client, flush)
        ag.send_json({'t': 'state', 'bad_body': True})
        async def accepted_envelope():
            await asyncio.sleep(.02)
            assert rt.agents[str(seeded['robots']['mine'])].last_rx == 2
            assert rt.arbiter.robot(str(seeded['robots']['mine'])).holder is None
        run(client, accepted_envelope)


def test_i3_streams_remain_disabled(client, seeded, rt):
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        rid = str(seeded['robots']['mine'])
        ident = send(ws, 'sub', robots=[rid], streams=['state', 'rgb', 'depth', 'lidar', 'map'])
        assert reply(ws, ident)['ok']
        frame = receive(ag, 'streams')
        assert all(frame[name] is False for name in ('rgb', 'depth', 'lidar', 'map'))


def test_failed_runtime_refuses_existing_connection_control_but_allows_stop(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        async def fail():
            rt.failed = True
        run(client, fail)
        try:
            result = reply(ws, send(ws, 'lease.take', rid))
            assert not result['ok']
            assert result['error']['code'] == 'SERVER_BUSY'
            assert reply(ws, send(ws, 'stop', rid))['ok']
            receive(ag, 'stop')
        finally:
            run(client, lambda: setattr(rt, 'failed', False))


def test_replaced_agent_state_handler_has_its_own_identity_gate(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    async def check():
        old, current = Peer(Sink(), auth_checked=rt.clock()), Peer(Sink(), auth_checked=rt.clock())
        rt.agents[rid] = current
        rt.arbiter.robot(rid).stop_gen = 1
        assert rt.accept_state(rid, old, C.AgentState.model_validate(state(999))) is False
        assert rt.arbiter.robot(rid).stop_gen == 1
        assert old.state == {}
        rt.agents.pop(rid)
    run(client, check)


def test_r7_policy_load_batches_robot_checks_into_two_reads(client, seeded, rt, monkeypatch):
    from sqlalchemy import event as sql_event
    headers = app_token(client)
    with screen(client, headers):
        actor = next(iter(rt.screens.values())).actor
        reads = []
        def count(conn, cursor, statement, parameters, context, executemany):
            if 'FROM users' in statement or 'FROM robots' in statement:
                reads.append(statement)
        sql_event.listen(rt.read_engine, 'before_cursor_execute', count)
        try:
            async def snapshot():
                return await asyncio.to_thread(rt.load_policy, actor)
            policy = run(client, snapshot)
            assert len(reads) == 2
            assert len(policy.rights) == 2  # all robots in this org in a single SELECT
        finally:
            sql_event.remove(rt.read_engine, 'before_cursor_execute', count)


def test_r10_lease_history_index_exists(seeded):
    from sqlalchemy import inspect
    engine = create_engine(seeded['urls']['app'])
    try:
        indexes = {i['name']: i for i in inspect(engine).get_indexes('lease_log')}
        assert 'lease_log_org_robot_at' in indexes
        index = indexes['lease_log_org_robot_at']
        assert index['column_names'] == ['org_id', 'robot_id', 'at']
        assert index['column_sorting']['at'] == ('desc',)
    finally:
        engine.dispose()


def test_r9_invalid_hidden_replies_without_closing(client, seeded, rt):
    with screen(client, app_token(client)) as ws:
        result = reply(ws, send(ws, 'hidden', seeded['robots']['theirs']))
        assert result['error']['code'] == 'NOT_ROBOT_OWNER'
        assert reply(ws, send(ws, 'ping'))['ok']


def test_stale_authorization_blocks_motion_but_cached_stop_remains_immediate(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease = take(ws, ag, rid)
        async def age_snapshot():
            peer = next(iter(rt.screens.values()))
            peer.policy = replace(peer.policy, checked=rt.clock() - 1)
        run(client, age_snapshot)
        result = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[1, 0, 0]))
        assert not result['ok']
        assert result['error']['code'] == 'POLICY_STALE'
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop', timeout=.1)


def test_b1_real_ws_cmd_and_stop_floods_allow_fresh_take(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    headers = app_token(client)
    with agent(client, seeded) as ag:
        ag.send_json(state(2, stop_ref=ag.stop_ref))
        for kind in ('cmd', 'stop'):
            with screen(client, headers) as ws:
                async def flood():
                    for seq in range(150):
                        body = {'t': kind, 'id': str(seq), 'robot': rid}
                        if kind == 'cmd':
                            body.update(lease_id=str(uuid4()), seq=seq, axes=[1, 0, 0])
                        await ws._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps(body)})
                run(client, flood)
                with pytest.raises(WebSocketDisconnect) as error:
                    receive(ws, 'never', timeout=2)
                assert error.value.code == 1013
        assert not rt.failed and not rt.audit_overloaded
        assert len(rt.audit._queue.memory) <= rt.audit.maxsize
        assert rt.audit.qsize() <= 110  # each accepted STOP remains individual
        with screen(client, headers) as fresh:
            assert reply(fresh, send(fresh, 'lease.take', rid))['ok']
            gen = 2
            while True:
                frame = receive(ag)
                if frame['t'] == 'stop':
                    gen += 1
                if frame['t'] == 'lease':
                    assert frame['lease_id'] is None
                    break
            receive(ag, 'stop')
            ag.send_json(state(gen + 1, stop_ref=ag.stop_ref))
            assert receive(ag, 'lease')['lease_id'] is not None


def test_r3_deny_screen_revokes_before_socket_close_io(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    actor = Actor(str(seeded['users']['one']), str(uuid4()), 'auth-close-test')
    async def check():
        rt.arbiter.take(rid, actor)
        rt.arbiter.state(rid, True, [0, 0, 0], 1, stop_ref=1)
        class CheckingSink(Sink):
            async def close(self, code=1000):
                assert rt.arbiter.robot(rid).holder is None
                await super().close(code)
        peer = Peer(CheckingSink(), actor=actor)
        await rt.deny_screen(peer, 4401)
        assert peer.socket.closed == [4401]
    run(client, check)

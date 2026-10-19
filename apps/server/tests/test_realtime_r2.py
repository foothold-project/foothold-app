"""Second review: retryable wire errors and bounded, lossless safety notifications."""
import asyncio
from dataclasses import replace
from datetime import timedelta
import json
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session as DBSession
from starlette.websockets import WebSocketDisconnect

from apps.contracts import models as C
from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.leases import Actor, Effect
from apps.server.fh_server.models import LeaseLog, now
from apps.server.fh_server import realtime as module
from apps.server.fh_server.realtime import Peer, Policy
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take, drain_audit
from .test_realtime_review import Sink, run


def temporary_db_error():
    return OperationalError('SELECT fake-test', {}, Exception('fake temporary DB failure'))


def test_n2_stale_free_is_retried_after_snapshot_refresh(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        original = rt.load_policy
        def slow(actor):
            time.sleep(.7)
            return original(actor)
        monkeypatch.setattr(rt, 'load_policy', slow)
        async def age():
            peer = next(iter(rt.screens.values()))
            peer.policy = replace(peer.policy, checked=rt.clock() - 1)
            rt.policy_cache[peer.actor.session] = peer.policy
        run(client, age)
        begin = time.monotonic()
        ag.close()
        result = receive(ws, 'lease', predicate=lambda x: x['holder'] is None, timeout=2)
        assert result['holder'] is None
        assert .5 < time.monotonic() - begin < 2
        assert reply(ws, send(ws, 'ping'))['ok']


def test_n3_hello_deadline_is_retryable(client, seeded, rt, monkeypatch):
    monkeypatch.setattr(module, 'HELLO_TIMEOUT', .05)
    rid = str(seeded['robots']['mine'])
    with client.websocket_connect('wss://testserver/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + rid}) as ag:
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ag, 'never')
        assert error.value.code == 1013


@pytest.mark.parametrize('kind', ['validation', 'permission', 'stale', 'busy'])
def test_n4_screen_denials_spend_ingress_before_validation(client, seeded, rt, kind):
    with screen(client, app_token(client)) as ws:
        async def empty_budget():
            peer = next(iter(rt.screens.values()))
            peer.budget = 0
            peer.budget_at = rt.clock() + 1
            if kind == 'stale':
                peer.policy = replace(peer.policy, checked=rt.clock() - 1)
            if kind == 'busy':
                rt.audit_overloaded = True
        run(client, empty_budget)
        if kind == 'validation':
            ws.send_json({'t': 'cmd', 'id': 'malformed'})
        elif kind == 'permission':
            send(ws, 'hidden', seeded['robots']['theirs'])
        else:
            send(ws, 'ping')
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ws, 'never')
        assert error.value.code == 1013


@pytest.mark.parametrize('frame', ['bad-json', 'binary', 'bad-state', 'bad-event'])
def test_n4_agent_invalid_frames_are_budgeted(client, seeded, rt, frame):
    with agent(client, seeded) as ag:
        async def empty_budget():
            peer = rt.agents[str(seeded['robots']['mine'])]
            peer.budget = peer.archive_budget = 0
            peer.budget_at = peer.archive_budget_at = rt.clock() + 1
        run(client, empty_budget)
        if frame == 'bad-json':
            ag.send_text('not-json')
        elif frame == 'binary':
            ag.send_bytes(b'unsupported video')
        else:
            ag.send_json({'t': 'state' if frame == 'bad-state' else 'event', 'bad': True})
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ag, 'never')
        assert error.value.code == 1013


def test_n5_overflow_free_follows_entire_accepted_effect_batch(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    one = Actor(str(seeded['users']['one']), str(uuid4()), 'batch-owner')
    two = Actor(str(seeded['users']['admin']), str(uuid4()), 'batch-requester')
    async def check():
        original_queue = rt.audit
        original_screens, original_agents = rt.screens, rt.agents
        policy = Policy({rid: frozenset({'ROBOT_READ', 'O_OWN'})}, C.OrgSettings(), now() + timedelta(hours=1), rt.clock())
        a, b = Peer(Sink(), actor=one, policy=policy, subscriptions={rid: set()}), Peer(Sink(), actor=two, policy=policy, subscriptions={rid: set()})
        rt.screens = {one.connection: a, two.connection: b}
        rt.agents = {rid: Peer(Sink(), auth_checked=rt.clock())}
        rt.audit = asyncio.Queue(1)
        rt.audit.put_nowait(Effect('audit', rid, {'op': 'TAKE'}))
        try:
            arb = rt.arbiter
            arb.take(rid, one)
            arb.state(rid, True, [0, 0, 0], 1)
            arb.request(rid, two)
            arb.respond(rid, one, arb.robot(rid).request.id, True)
            rt.apply(arb.state(rid, True, [0, 0, 0], 2))
            for peer in (a, b):
                frames = [peer.queue.get_nowait()['_delivery'] for _ in range(peer.queue.qsize())]
                accepted = next(i for i, frame in enumerate(frames) if frame.get('result') == 'ACCEPTED')
                free = max(i for i, frame in enumerate(frames) if frame['t'] == 'lease' and frame['holder'] is None)
                assert accepted < free
            assert arb.robot(rid).holder is None
        finally:
            rt.screens, rt.agents = original_screens, original_agents
            rt.audit = original_queue
            rt.audit_overloaded = False
    run(client, check)


def test_n6_startup_standby_acquires_after_owner_stops(client, seeded, rt):
    standby_app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    with TestClient(standby_app, base_url='https://testserver') as standby:
        assert standby_app.state.realtime.failed
        drain_audit(client, rt)
        run(client, rt.close)
        async def wait():
            async with asyncio.timeout(2):
                while standby_app.state.realtime.failed:
                    await asyncio.sleep(.01)
        run(standby, wait)
        with agent(standby, seeded) as ag, screen(standby, app_token(standby)) as ws:
            assert take(ws, ag, seeded['robots']['mine'])


def test_n7_single_policy_db_error_retries_without_dropping_lease(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease = take(ws, ag, rid)
        original, errors = rt.load_policy, []
        def once(actor):
            if not errors:
                errors.append(True)
                raise temporary_db_error()
            return original(actor)
        monkeypatch.setattr(rt, 'load_policy', once)
        async def recover():
            async with asyncio.timeout(1):
                while not errors:
                    await asyncio.sleep(.01)
            await asyncio.sleep(.15)
            assert rt.arbiter.robot(rid).holder.lease_id == lease
        run(client, recover)
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop', timeout=.1)


def test_n7_single_agent_auth_db_error_keeps_connection(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease = take(ws, ag, rid)
        original, errors = rt.agent_identity, []
        def once(headers):
            if not errors:
                errors.append(True)
                raise temporary_db_error()
            return original(headers)
        monkeypatch.setattr(rt, 'agent_identity', once)
        async def wait():
            await asyncio.sleep(.3)
            assert errors
            assert not rt.agents[rid].closing
            assert rt.arbiter.robot(rid).holder.lease_id == lease
        run(client, wait)
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop', timeout=.1)


def test_n7_unknown_ownership_frees_but_keeps_stop_and_rechecks(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        original, errors = rt.ownership_alive, []
        def once():
            if not errors:
                errors.append(True)
                raise temporary_db_error()
            return original()
        monkeypatch.setattr(rt, 'ownership_alive', once)
        async def uncertain():
            async with asyncio.timeout(1.5):
                while not rt.owner_uncertain:
                    await asyncio.sleep(.01)
            assert rt.arbiter.robot(rid).holder is None
            assert not rt.failed
        run(client, uncertain)
        assert receive(ws, 'lease', predicate=lambda x: x['holder'] is None)['holder'] is None
        receive(ag, 'lease'); receive(ag, 'stop')
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop', timeout=.1)
        async def recovered():
            async with asyncio.timeout(1.5):
                while rt.owner_uncertain:
                    await asyncio.sleep(.01)
        run(client, recovered)


def test_n8_run_takeover_has_no_duplicate_release(client, seeded, rt):
    run_id, rid = str(uuid4()), str(seeded['robots']['mine'])
    with agent(client, seeded, run={'run_id': run_id, 'status': 'PAUSED', 'step': 0}) as ag, screen(client, app_token(client)) as ws:
        receive(ag, 'run.control')
        ag.send_json(state(2))
        receive(ag, 'lease')
        take(ws, ag, rid, gen=3)
        drain_audit(client, rt)
        with DBSession(client.app.state.engine) as db:
            ops = list(db.scalars(select(LeaseLog.op).order_by(LeaseLog.id)))
            assert ops == ['RUN_TAKE', 'RUN_PAUSE_TAKEOVER', 'TAKE']


def test_n9_backlog_events_do_not_disconnect_or_starve_state(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease = take(ws, ag, rid)
        async def burst():
            for number in range(500):
                await ag._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps({
                    't': 'event', 'code': 'BACKLOG_FAKE', 'severity': 'info', 'robot_at': None,
                    'data': {'number': number}})})
            await ag._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps(state(4))})
            async with asyncio.timeout(1):
                while rt.arbiter.robot(rid).stop_gen != 4:
                    await asyncio.sleep(.01)
            assert rt.arbiter.robot(rid).holder.lease_id == lease
            assert rt.audit.qsize() < 20
            assert any(key[2] == 'AGENT_BACKLOG_SAMPLED' for key in rt.audit_groups)
        run(client, burst)
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop', timeout=.1)


def test_n7_stale_policy_revokes_motion_but_preserves_stop_during_retry(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        original = rt.load_policy
        failures = []
        def unavailable(actor):
            failures.append(True)
            raise temporary_db_error()
        monkeypatch.setattr(rt, 'load_policy', unavailable)
        async def age():
            peer = next(iter(rt.screens.values()))
            peer.policy = replace(peer.policy, checked=rt.clock() - .7)
            rt.policy_cache[peer.actor.session] = peer.policy
            async with asyncio.timeout(1):
                while not failures or rt.arbiter.robot(rid).holder is not None:
                    await asyncio.sleep(.01)
            assert not peer.closing
        run(client, age)
        receive(ag, 'lease'); receive(ag, 'stop')
        ident = send(ws, 'stop', rid)
        receive(ag, 'stop', timeout=.1)  # writer may wait for DB; STOP never does
        monkeypatch.setattr(rt, 'load_policy', original)
        assert receive(ws, 'lease', predicate=lambda x: x['holder'] is None)['holder'] is None
        assert reply(ws, ident)['ok']


def test_n7_stale_agent_auth_blocks_authority_but_stop_is_still_forwarded(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        original = rt.agent_identity
        def unavailable(headers):
            raise temporary_db_error()
        monkeypatch.setattr(rt, 'agent_identity', unavailable)
        async def age():
            peer = rt.agents[rid]
            peer.auth_checked = rt.clock() - .7
            async with asyncio.timeout(1):
                while rt.arbiter.robot(rid).holder is not None:
                    await asyncio.sleep(.01)
            assert not peer.closing
        run(client, age)
        receive(ag, 'lease'); receive(ag, 'stop')
        result = reply(ws, send(ws, 'lease.take', rid))
        assert result['error']['code'] == 'ROBOT_AUTH_PENDING'
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop', timeout=.1)
        monkeypatch.setattr(rt, 'agent_identity', original)


def test_n7_retry_grace_is_bounded_and_closes_temporarily(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag:
        def unavailable(headers):
            raise temporary_db_error()
        monkeypatch.setattr(rt, 'agent_identity', unavailable)
        async def expired():
            rt.agents[rid].auth_checked = rt.clock() - 6
        run(client, expired)
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ag, 'never', timeout=1)
        assert error.value.code == 1013


def test_n7_stale_successful_read_is_not_a_permanent_authorization_denial(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        original = rt.refresh_policy
        async def old_snapshot(peer):
            await asyncio.sleep(.01)
            peer.policy = replace(peer.policy, checked=rt.clock() - 1)
        monkeypatch.setattr(rt, 'refresh_policy', old_snapshot)
        async def wait():
            async with asyncio.timeout(1):
                while rt.arbiter.robot(rid).holder is not None:
                    await asyncio.sleep(.01)
        run(client, wait)
        receive(ag, 'lease'); receive(ag, 'stop')
        ident = send(ws, 'stop', rid)
        receive(ag, 'stop', timeout=.1)
        # Restore a real snapshot so the queued FREE and reply can be delivered.
        monkeypatch.setattr(rt, 'refresh_policy', original)
        assert receive(ws, 'lease', predicate=lambda x: x['holder'] is None)['holder'] is None
        assert reply(ws, ident)['ok']

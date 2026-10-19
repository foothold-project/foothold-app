"""Independent review regressions: causal STOPs, poison isolation and wire consumers."""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import sys
import threading
import time
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError, DataError, OperationalError
from sqlalchemy.orm import Session as DBSession

from apps.contracts import generate, models as C
from apps.server.fh_server.leases import Actor, Arbiter, Effect, MAX_SAFE_INTEGER, LeaseError
from apps.server.fh_server.models import Event, now
from apps.server.fh_server import realtime as module
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take, drain_audit
from .test_realtime_review import run

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent'))
from foothold_agent.link.session import Session


@pytest.mark.parametrize('scenario', ['release', 'cancel-retake', 'local-stop'])
def test_b1_real_session_old_release_cannot_confirm_new_stop(scenario):
    session, arb = Session(lambda: 0), Arbiter(lambda: 0)
    one, two = Actor('one', 's1', 'c1'), Actor('two', 's2', 'c2')
    session.connect()
    def consume(effects, report=True):
        states = []
        for effect in effects:
            if effect.target != 'agent':
                continue
            for message in session.receive(effect.body).messages:
                if message['t'] == 'state':
                    states.append(message)
                    if report:
                        consume(arb.state('r', message['latched'], message['applied'],
                                          message['stop_gen'], message['stop_ref']))
        return states
    consume(arb.revoke('r'))
    consume(arb.take('r', one))
    assert arb.robot('r').holder.actor == one
    delayed = consume(arb.release('r', one), report=False)
    if scenario == 'cancel-retake':
        consume(arb.take('r', two), report=False)
        delayed += consume(arb.stop('r', two), report=False)
    if scenario == 'local-stop':
        session.core.stop('fake local STOP')
        delayed += [session._state()]
    pending = arb.take('r', two)  # new STOP intentionally not delivered
    ref = next(e.body['stop_ref'] for e in pending if e.body.get('t') == 'stop')
    assert all(m['stop_ref'] != ref for m in delayed)
    for message in delayed:
        assert not arb.state('r', message['latched'], message['applied'],
                             message['stop_gen'], message['stop_ref'])
        assert arb.robot('r').holder is None
    consume(pending)
    assert arb.robot('r').holder.actor == two


def test_b1_reference_exhaustion_never_reuses_for_a_grant():
    arb, actor = Arbiter(lambda: 0), Actor('one', 's', 'c')
    arb.robot('r').stop_ref = 2**53 - 2
    effects = arb.take('r', actor)
    assert effects[1].body['stop_ref'] == 2**53 - 1
    arb.state('r', True, [0, 0, 0], 1, 2**53 - 1)
    assert arb.robot('r').holder
    arb.release('r', actor)
    effects = arb.take('r', actor)
    assert arb.robot('r').transfer is None
    assert any(e.body.get('error') == 'STOP_REF_EXHAUSTED' for e in effects)
    arb.state('r', True, [0, 0, 0], 2, 2**53 - 1)
    assert arb.robot('r').holder is None


@pytest.mark.parametrize('data', [{'bad': '\ud800'}, {'\udfff': 'key'}, {'nested': [{'x': '\x00'}]},
                                  {'nested': [float('nan')]}, {'x': float('inf')}])
def test_b2_nested_data_must_be_postgresql_json(data):
    with pytest.raises(ValidationError):
        C.AgentEvent(t='event', code='BAD', severity='WARN', robot_at=None, data=data)


def test_b2_wire_poison_dropped_then_stop_audit_drains(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        ag.send_text('{"t":"event","code":"POISON","severity":"WARN","robot_at":null,"data":{"x":"\\ud800"}}')
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop')
        async def recorded():
            async with asyncio.timeout(3):
                while True:
                    with DBSession(client.app.state.engine) as db:
                        codes = set(db.scalars(select(Event.code).where(Event.robot_id == seeded['robots']['mine'])))
                    if {'STOP', 'AGENT_INVALID_FRAME'} <= codes:
                        assert 'POISON' not in codes
                        break
                    await asyncio.sleep(.01)
        run(client, recorded)
        drain_audit(client, rt)
        assert rt.audit._unfinished_tasks == 0
        assert not rt.audit_overloaded
        assert reply(ws, send(ws, 'lease.release', rid))['ok']
        receive(ag, 'lease'); receive(ag, 'stop')
        assert take(ws, ag, rid, gen=10)


@pytest.mark.parametrize('failure', ['data', 'unicode', 'sqlstate', 'transient'])
def test_b2_auditor_quarantines_permanent_but_retries_transient(client, seeded, rt, monkeypatch, failure):
    rid = str(seeded['robots']['mine'])
    original, calls = rt.record, []
    def record(effect):
        if effect.body['op'] == 'FAKE_POISON':
            calls.append(effect)
            if failure == 'transient' and len(calls) > 1:
                return original(Effect('audit', rid, {'op': 'FAKE_RECOVERED', 'at': now()}))
            if failure == 'data':
                raise DataError('fake-data', {}, Exception('fake permanent data'))
            if failure == 'unicode':
                raise UnicodeError('fake invalid encoding')
            if failure == 'sqlstate':
                class InvalidEncoding(Exception):
                    sqlstate = '22021'
                raise DBAPIError('fake-json', {}, InvalidEncoding('fake invalid encoding'))
            raise OperationalError('fake-read', {}, Exception('fake transient'))
        return original(effect)
    monkeypatch.setattr(rt, 'record', record)
    async def check():
        rt.audit.put_nowait(Effect('audit', rid, {'op': 'FAKE_POISON', 'at': now()}))
        rt.audit.put_nowait(Effect('audit', rid, {'op': 'STOP', 'at': now()}))
        await asyncio.wait_for(rt.audit.join(), 3)
    run(client, check)
    with DBSession(client.app.state.engine) as db:
        codes = set(db.scalars(select(Event.code)))
    assert 'STOP' in codes
    assert ('AUDIT_QUARANTINED' in codes) == (failure != 'transient')
    assert len(calls) == (2 if failure == 'transient' else 1)


def test_b3_wire_fixture_python_and_schema_match():
    # The same literal wire objects are compiled by tsc (package typecheck).
    import re
    import jsonschema
    text = Path('apps/contracts/tests/wire-consumer.ts').read_text()
    schemas = generate.build()
    for name, payload in re.findall(r'^export const \w+: (\w+) = (\{.+\});$', text, re.M):
        body = json.loads(payload)
        model = C.TOP[name]
        try:
            TypeAdapter(model).validate_python(body)
        except ValidationError:
            pytest.fail(f'Valid wire object rejected by {name}')
        errors = list(jsonschema.Draft202012Validator(json.loads(schemas[f'schema/{name}.json'])).iter_errors(body))
        assert not errors, f'{name}: {errors[0].message if errors else ""}'
    assert 'proto?: "fh-rt/1";' in schemas['ts/index.ts']
    with pytest.raises(ValidationError):
        C.ScreenPing(t='ping', id='null', proto=None)


def test_b3_generator_rejects_conflicting_nested_definitions(monkeypatch):
    monkeypatch.setattr(C, 'REQUEST_MODELS', C.REQUEST_MODELS - {C.ScreenMessage})
    with pytest.raises(ValueError, match='Conflicting schema'):
        generate.build()


@pytest.mark.parametrize('number', [2**53, -1, True])
def test_c1_sequence_bounds_are_enforced_before_heartbeat(number):
    arb, actor = Arbiter(lambda: 0), Actor('one', 's', 'c')
    arb.take('r', actor)
    arb.state('r', True, [0, 0, 0], 1, 1)
    lease = arb.robot('r').holder.lease_id
    with pytest.raises(LeaseError):
        arb.cmd('r', actor, lease, number, [0, 0, 0])
    with pytest.raises(ValidationError):
        C.ScreenCmd(t='cmd', id='bad', robot=str(uuid4()), lease_id=str(uuid4()), seq=number, axes=[0., 0., 0.])
    assert arb.robot('r').holder.seq == -1


def test_c2_token_verification_uses_constant_time_comparison(client, seeded, rt, monkeypatch):
    original, comparisons = module.hmac.compare_digest, []
    def compare(left, right):
        comparisons.append((len(left), len(right)))
        return original(left, right)
    monkeypatch.setattr(module.hmac, 'compare_digest', compare)
    rid = str(seeded['robots']['mine'])
    assert rt.agent_identity({'authorization': 'Bearer fake-test-' + rid}) == rid
    assert comparisons and all(pair == (32, 32) for pair in comparisons)


@pytest.mark.parametrize('status', ['COMPLETED', 'ABORTED', 'FAILED'])
def test_c3_late_run_terminal_does_not_revoke_human(client, seeded, rt, status):
    rid, run_id = str(seeded['robots']['mine']), str(uuid4())
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease = take(ws, ag, rid)
        async def old_run():
            rt.runs[rid] = {'run_id': run_id, 'status': 'PAUSED', 'step': 0}
        run(client, old_run)
        ag.send_json({'t': 'run.update', 'run_id': run_id, 'status': status, 'step': 1, 'progress': None})
        time.sleep(.05)
        holder = rt.arbiter.robot(rid).holder
        assert holder is not None and holder.lease_id == lease
        assert reply(ws, send(ws, 'ping'))['ok']


def test_m1_stop_reply_bypasses_notification_waiting_for_policy(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        original = rt.load_policy
        def slow(actor):
            time.sleep(.8)
            return original(actor)
        monkeypatch.setattr(rt, 'load_policy', slow)
        async def stale():
            peer = next(iter(rt.screens.values()))
            peer.policy = replace(peer.policy, checked=rt.clock() - 1)
            rt.policy_cache[peer.actor.session] = peer.policy
            rt.apply([rt.arbiter.announce(rid)])
        run(client, stale)
        begin = time.monotonic()
        assert reply(ws, send(ws, 'stop', rid))['ok']
        assert time.monotonic() - begin < .1
        receive(ag, 'stop')


@pytest.mark.parametrize('kind', ['lease.release', 'hidden'])
def test_m2_release_not_blocked_by_stale_robot_auth(client, seeded, rt, kind):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        async def stale():
            rt.agents[rid].auth_checked = rt.clock() - 1
            peer = next(iter(rt.screens.values()))
            peer.policy = replace(peer.policy, checked=rt.clock() - 1)
            rt.owner_uncertain = True
        run(client, stale)
        assert reply(ws, send(ws, kind, rid))['ok']
        assert receive(ag, 'lease')['lease_id'] is None
        receive(ag, 'stop')
        assert rt.arbiter.robot(rid).holder is None


def test_m3_policy_and_robot_auth_age_start_before_db_read(client, seeded, rt, monkeypatch):
    original_policy, original_agent = rt.load_policy, rt.agent_identity
    def slow_policy(actor):
        time.sleep(.6)
        return original_policy(actor)
    def slow_agent(headers):
        time.sleep(.6)
        return original_agent(headers)
    monkeypatch.setattr(rt, 'load_policy', slow_policy)
    monkeypatch.setattr(rt, 'agent_identity', slow_agent)
    with agent(client, seeded) as ag, client.websocket_connect('wss://testserver/api/v1/ws', headers=app_token(client)) as ws:
        assert not reply(ws, send(ws, 'ping', proto='fh-rt/1'))['ok']
        time.sleep(.25)  # let the 600ms agent recheck finish, then inspect its start timestamp
        async def checked():
            peer = next(iter(rt.screens.values()))
            assert rt.clock() - peer.policy.checked >= .6
            assert rt.clock() - rt.agents[str(seeded['robots']['mine'])].auth_checked >= .6
        run(client, checked)
        result = reply(ws, send(ws, 'lease.take', seeded['robots']['mine']))
        assert not result['ok'] and result['error']['code'] == 'POLICY_STALE'
        assert reply(ws, send(ws, 'stop', seeded['robots']['mine']))['ok']


def test_m5_stalled_db_has_client_deadline_and_stop_stays_live(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        gate = threading.Event()
        original = rt.load_policy
        def stalled(actor):
            gate.wait(2)
            return original(actor)
        monkeypatch.setattr(module, 'DB_READ_TIMEOUT', .05)
        monkeypatch.setattr(rt, 'load_policy', stalled)
        async def expire():
            peer = next(iter(rt.screens.values()))
            peer.policy = replace(peer.policy, checked=rt.clock() - 1)
            rt.policy_cache[peer.actor.session] = peer.policy
            # Use a new controlled read to test the deadline. A previously
            # completed, valid read-ahead snapshot may otherwise win this fixture.
            pending = module.ReadAhead(lambda: gate.wait(2), rt.clock, rt.auth_executor)
            started = rt.clock()
            timed_out = False
            try:
                try:
                    await pending.next()
                except asyncio.TimeoutError:
                    timed_out = True
                assert timed_out, 'A stalled read must reach its client deadline'
                assert rt.clock() - started < .2
            finally:
                await pending.close()
        try:
            run(client, expire)
            begin = time.monotonic()
            assert reply(ws, send(ws, 'stop', rid))['ok']
            assert time.monotonic() - begin < .1
            receive(ag, 'stop')
        finally:
            gate.set()


@pytest.mark.parametrize('delayed_backlog', [False, True])
def test_real_uvicorn_current_agent_causal_take_transfer_stop(seeded, tmp_path, delayed_backlog):
    import httpx
    from websockets.asyncio.client import connect
    from foothold_agent.link.client import Client, Settings
    from .ws_process import server_process

    async def check(server):
        session = Session()
        class Bridge:
            def __init__(self):
                self.stopped, self.commands = True, []
            def apply(self, command):
                self.commands.append(command)
                if command.kind == 'stop':
                    self.stopped = True
                if command.kind == 'unlock':
                    self.stopped = False
        bridge = Bridge()
        client = Client(session, bridge, Settings(server['base'] + '/api/v1/agent/ws', server['agent_token']))
        running = asyncio.create_task(client.run())
        async def feedback():
            while True:
                client.on_robot_state({'schema': 'v2_live/state/1', 'episode': 1,
                    'stop_requested': bridge.stopped, 'reset_in_progress': False, 'policy_running': True})
                await asyncio.sleep(.02)
        sensor = asyncio.create_task(feedback())
        async def until(predicate):
            async with asyncio.timeout(4):
                while not predicate():
                    if running.done():
                        running.result()
                        raise AssertionError('agent Client stopped unexpectedly')
                    await asyncio.sleep(.01)
        async def read(ws, predicate):
            async with asyncio.timeout(4):
                while True:
                    body = json.loads(await ws.recv())
                    if predicate(body):
                        return body
        async def send(ws, kind, **fields):
            ident = str(uuid4())
            await ws.send(json.dumps({'t': kind, 'id': ident, **fields}))
            return ident
        async def reply(ws, ident):
            body = await read(ws, lambda m: m.get('t') == 'reply' and m.get('id') == ident)
            assert body['ok'], body
        rid = str(seeded['robots']['mine'])
        try:
            await until(lambda: session.connected and session.stop_ref > 0)
            if delayed_backlog:
                await asyncio.sleep(.7)  # warm read-ahead while actual DB reads take 300ms
                history = [{'t': 'event', 'code': 'FAKE_HISTORY', 'severity': 'WARN',
                            'robot_at': None, 'data': {'number': n}} for n in range(400)]
                await client._replay(client._outgoing, history)
            async with httpx.AsyncClient() as http:
                response = await http.post(server['base'].replace('ws://', 'http://') + '/api/v1/auth/login',
                    json={'username': 'admin', 'password': 'fake-test-password', 'client': 'app'})
                response.raise_for_status()
                admin = response.json()['access_token']
            async with connect(server['base'] + '/api/v1/ws', additional_headers={
                    'authorization': 'Bearer ' + server['access']}) as one, connect(
                    server['base'] + '/api/v1/ws', additional_headers={'authorization': 'Bearer ' + admin}) as two:
                for ws in (one, two):
                    await reply(ws, await send(ws, 'ping', proto='fh-rt/1'))
                prior_ref = session.stop_ref
                await reply(one, await send(one, 'lease.take', robot=rid))
                lease = (await read(one, lambda m: m.get('t') == 'lease' and m.get('lease_id')))['lease_id']
                await until(lambda: session.lease_id == lease)
                assert session.stop_ref > prior_ref
                first_ref = session.stop_ref
                await reply(one, await send(one, 'unlock', robot=rid, lease_id=lease, stop_gen=session.core.stop_gen))
                await until(lambda: not session.core.latch)
                await reply(one, await send(one, 'cmd', robot=rid, lease_id=lease, seq=0, axes=[0, 0, 0]))
                await until(lambda: not session.core.need_neutral)
                await reply(one, await send(one, 'cmd', robot=rid, lease_id=lease, seq=1, axes=[1, 0, 0]))
                await until(lambda: any(c.velocity[0] > 0 for c in bridge.commands))
                await reply(two, await send(two, 'lease.request', robot=rid))
                requested = await read(one, lambda m: m.get('t') == 'lease.requested')
                await reply(one, await send(one, 'lease.respond', robot=rid, request_id=requested['request_id'], accept=True))
                newer = (await read(two, lambda m: m.get('t') == 'lease' and m.get('lease_id')))['lease_id']
                await until(lambda: session.lease_id == newer)
                assert newer != lease and session.stop_ref > first_ref
                assert session.core.latch and session.core.out == (0, 0, 0)
                transfer_ref = session.stop_ref
                await reply(two, await send(two, 'stop', robot=rid))
                await until(lambda: session.stop_ref > transfer_ref)
                assert session.core.latch and session.core.out == (0, 0, 0)
                running.cancel()
                await asyncio.gather(running, return_exceptions=True)
                print('REAL CLIENT: causal take -> unlock -> neutral -> nonzero -> transfer -> STOP (local fake sink only)')
        finally:
            sensor.cancel()
            running.cancel()
            await asyncio.gather(sensor, running, return_exceptions=True)
    target = 'apps.server.tests.delayed_app:app' if delayed_backlog else 'apps.server.fh_server.main:app'
    with server_process(seeded, tmp_path, app_target=target) as server:
        asyncio.run(check(server))


def test_b2_actual_unstorable_database_item_is_quarantined(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    async def check():
        rt.audit.put_nowait(Effect('audit', rid, {'op': 'AGENT_EVENT', 'code': 'FAKE_POISON',
            'severity': 'WARN', 'at': now(), 'data': {'bad': '\ud800'}}))
        rt.audit.put_nowait(Effect('audit', rid, {'op': 'STOP', 'at': now()}))
        await asyncio.wait_for(rt.audit.join(), 3)
    run(client, check)
    with DBSession(client.app.state.engine) as db:
        codes = set(db.scalars(select(Event.code)))
    assert {'STOP', 'AUDIT_QUARANTINED'} <= codes
    assert 'FAKE_POISON' not in codes


@pytest.mark.parametrize('kind', ['missing-first', 'null-first', 'null-followup'])
def test_b3_transport_proto_first_and_null_rules(client, rt, kind):
    from starlette.websockets import WebSocketDisconnect
    with client.websocket_connect('wss://testserver/api/v1/ws', headers=app_token(client)) as ws:
        if kind == 'null-followup':
            assert reply(ws, send(ws, 'ping', proto='fh-rt/1'))['ok']
        send(ws, 'ping', **({} if kind == 'missing-first' else {'proto': None}))
        with pytest.raises(WebSocketDisconnect) as error:
            receive(ws)
        assert error.value.code == 4403


@pytest.mark.parametrize('status', ['COMPLETED', 'FAILED', 'ABORTED'])
def test_c3_matching_current_run_terminal_releases_only_its_lease(client, seeded, rt, status):
    rid, run_id = str(seeded['robots']['mine']), str(uuid4())
    with agent(client, seeded, run={'run_id': run_id, 'status': 'RUNNING', 'step': 1}) as ag:
        receive(ag, 'run.control')
        ag.send_json(state(20, stop_ref=ag.stop_ref))
        lease = receive(ag, 'lease')['lease_id']
        assert rt.runs[rid]['lease_id'] == lease
        ag.send_json({'t': 'run.update', 'run_id': run_id, 'status': status, 'step': 2, 'progress': None})
        assert receive(ag, 'lease')['lease_id'] is None
        assert rt.arbiter.robot(rid).holder is None


def test_m5_failed_owner_read_cleanup_never_blocks_stop(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    entered, closed = threading.Event(), threading.Event()
    class SlowConnection:
        def close(self):
            entered.set()
            time.sleep(.4)
            closed.set()
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        async def setup():
            async def failed():
                raise OperationalError('fake-owner-read', {}, Exception('fake lost connection'))
            pending = asyncio.create_task(failed())
            return rt.dispose_owner(pending, SlowConnection())
        future = client.portal.start_task_soon(setup)
        assert entered.wait(1)
        begin = time.monotonic()
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop', timeout=.1)
        assert time.monotonic() - begin < .1
        async def finish():
            await future.result()
        run(client, finish)
        assert closed.is_set()

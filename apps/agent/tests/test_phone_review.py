"""PR41 r1: regressions translated from both reviewers' ROS-free reproductions."""
import asyncio
from contextlib import asynccontextmanager, AsyncExitStack
import json
import os
from types import SimpleNamespace
from uuid import uuid4

import pytest

from test_phone import h, Harness, Clock, encode, signed, phone_socket
from foothold_agent.phone.hub import Peer, PhoneError
from foothold_agent.phone.server import Server, Settings
from foothold_agent.phone.tickets import Verifier, TicketError, load_keys
from foothold_agent.phone.observer import Observer
from foothold_agent.safety.core import Z


async def rpc(h, ws, kind, **fields):
    h.ids += 1
    identity = str(h.ids)
    await ws.send(json.dumps({'t': kind, 'id': identity, 'robot': h.robot, **fields}))
    async def reply():
        while True:
            value = json.loads(await ws.recv())
            if value.get('id') == identity:
                return value
    return await asyncio.wait_for(reply(), 2)


async def hello(h, ws, **fields):
    claims = h.claims(**fields)
    await rpc(h, ws, 'hello', proto='fh-phone/1', device=claims['device'], ticket=signed(h.key, claims))
    return claims


async def closed_code(ws):
    from websockets.exceptions import ConnectionClosed
    async def receive():
        try:
            while True:
                await ws.recv()
        except ConnectionClosed as error:
            return error.rcvd.code if error.rcvd else error.sent.code
    return await asyncio.wait_for(receive(), 2)


@asynccontextmanager
async def running(h, *, origins=(), watchdog=True):
    with phone_socket() as sock:
        port = sock.getsockname()[1]
        server = Server(h.hub, Settings('127.0.0.1', port, 'unused', 'test', '1', h.org,
                                        'unused-replay.sqlite', True, True, origins), sock=sock)
        if not watchdog:
            async def idle():
                await asyncio.Event().wait()
            server._watchdog = idle
        task = asyncio.create_task(server.run())
        await asyncio.wait_for(server.ready.wait(), 2)
        try:
            yield server, f'ws://127.0.0.1:{port}/phone/ws', task
        finally:
            server.stopping.set()
            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 2)


@pytest.mark.parametrize('oversized', [True, False])
def test_transport_viewer_invalid_close_stops_but_normal_close_does_not(h, oversized):
    from websockets.asyncio.client import connect
    owner, _ = h.moving()
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws, purpose='view')
                if oversized:
                    await ws.send('x' * 4097)
                    assert await closed_code(ws) == 1009
                else:
                    await ws.close()
                for _ in range(100):
                    if not server.connections:
                        break
                    await asyncio.sleep(.005)
                assert h.hub.session.core.latch is oversized
                assert h.hub.session.core.out == (Z if oversized else (.6, 0, 0))
                assert h.hub.owner is owner and not task.done() and server.failure is None
    asyncio.run(run())


@pytest.mark.parametrize('raw', ['{', 'stop', 'oversize'])
def test_unapproved_socket_cannot_stop_authenticated_owner(h, raw):
    from websockets.asyncio.client import connect
    owner, _ = h.moving()
    before = (len(h.outputs), h.hub.session.core.stop_gen)
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                value = ('x'*4097 if raw == 'oversize' else json.dumps({'t': 'stop', 'id': 'x', 'robot': h.robot})
                         if raw == 'stop' else raw)
                await ws.send(value)
                assert await closed_code(ws) in (1007, 1009, 4401)
                assert h.hub.owner is owner and not h.hub.session.core.latch
                assert h.hub.session.core.stop_gen == before[1]
                # Watchdog may repeat the current apply; it must never emit STOP/zero.
                assert all(c.kind == 'apply' and c.velocity == (.6, 0, 0) for c in h.outputs[before[0]:])
                assert not task.done()
    asyncio.run(run())


def test_origin_default_denies_browser_but_allows_app_and_explicit_origin(h):
    from websockets.asyncio.client import connect
    from websockets.exceptions import InvalidStatus
    owner, _ = h.moving()
    async def run():
        async with running(h, origins=('http://example.invalid',)) as (server, uri, task):
            with pytest.raises(InvalidStatus) as error:
                async with connect(uri, proxy=None, origin='http://untrusted.invalid'):
                    pass
            assert error.value.response.status_code == 403
            for origin in (None, 'http://example.invalid'):
                async with connect(uri, proxy=None, origin=origin) as ws:
                    await hello(h, ws, purpose='view')
            assert h.hub.owner is owner and not h.hub.session.core.latch and not task.done()
    asyncio.run(run())


def test_pending_hello_capacity_rotates_to_allow_controller_reconnect(h):
    from websockets.asyncio.client import connect
    owner, claims = h.moving()
    h.hub.disconnect(owner)
    async def run():
        async with running(h) as (server, uri, task):
            async with AsyncExitStack() as stack:
                waiting = [await stack.enter_async_context(connect(uri, proxy=None)) for _ in range(4)]
                assert sum(p.user is None for p in h.hub.peers.values()) == 4
                ws = await stack.enter_async_context(connect(uri, proxy=None))
                assert sum(p.user is None for p in h.hub.peers.values()) <= 4
                await hello(h, ws, user=claims['sub'], device=claims['device'])
                assert (await rpc(h, ws, 'lease.take'))['ok']
                assert sum(p.user is None for p in h.hub.peers.values()) <= 4
                assert await closed_code(waiting[0]) == 1013
                assert not task.done() and server.failure is None
    asyncio.run(run())


def test_pending_hello_deadline_has_no_robot_effect(h):
    owner, _ = h.moving()
    pending = object()
    h.hub.peers[pending] = Peer(last_ping=0)
    h.clock.t = 2.9
    h.send(owner, 'ping', client_time_ms=1)
    gen = h.hub.session.core.stop_gen
    h.clock.t = 3
    h.hub.tick()
    assert pending not in h.hub.peers and h.hub.owner is owner
    assert h.hub.session.core.stop_gen == gen and not h.hub.session.core.latch


def test_disconnect_sink_error_is_service_failure_and_always_cleans_tasks(h):
    from websockets.asyncio.client import connect
    async def run():
        async with running(h, watchdog=False) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws)
                peer = next(iter(h.hub.peers))
                h.take(peer); h.unlock(peer); h.cmd(peer, 0); h.cmd(peer)
                workers = server.workers[peer]
                failure = OSError('injected disconnect output failure')
                original = h.hub.sink
                class Once:
                    failed = False
                    def apply(self, command):
                        if not self.failed:
                            self.failed = True
                            raise failure
                        original.apply(command)
                h.hub.sink = Once()
                await ws.close()
                for _ in range(100):
                    if task.done():
                        break
                    await asyncio.sleep(.005)
                assert task.done() and server.failure is failure
                assert not server.connections and not server.workers and all(t.done() for t in workers)
                assert h.hub.owner is None and h.hub.session.core.latch and h.outputs[-1].velocity == Z
                assert isinstance(task.exception(), RuntimeError) and task.exception().__cause__ is failure
    asyncio.run(run())


@pytest.mark.parametrize('cancel', [False, True])
def test_handler_cleanup_preserves_first_error_or_cancellation(h, monkeypatch, cancel):
    first = asyncio.CancelledError() if cancel else RuntimeError('first local fault')
    second = OSError('cleanup fault')
    class Socket:
        request = SimpleNamespace(path='/phone/ws')
        async def recv(self):
            raise first
        def __aiter__(self):
            return self
        async def __anext__(self):
            raise first
        async def close(self, *args):
            pass
    server = Server(h.hub, Settings('127.0.0.1', 9450, 'unused', 'test', '1', h.org,
                                    'unused-replay.sqlite', True, True))
    def fail(*args, **kwargs):
        raise second
    monkeypatch.setattr(h.hub, 'disconnect', fail)
    async def run():
        with pytest.raises(type(first)) as error:
            await server._handler(Socket())
        assert error.value is first and second in getattr(first, 'output_errors', [])
        assert not server.connections and not server.workers
        assert server.failure is (second if cancel else first)
    asyncio.run(run())


def test_request_cancel_flood_closes_only_requester_and_bounds_events(h):
    from websockets.asyncio.client import connect
    owner, _ = h.moving()
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws)
                assert (await rpc(h, ws, 'lease.request'))['ok']
                assert (await rpc(h, ws, 'lease.cancel'))['ok']
                result = await rpc(h, ws, 'lease.request')
                assert not result['ok']
                assert result['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
                for index in range(40):
                    try:
                        await ws.send(json.dumps({'t': 'lease.request', 'id': str(index), 'robot': h.robot}))
                    except Exception:
                        break
                assert await closed_code(ws) == 1013
                assert h.hub.owner is owner and not h.hub.session.core.latch and h.hub.session.core.out == (.6, 0, 0)
                assert not task.done() and server.failure is None
                events = [e for e in h.events if e.get('code') in ('PHONE_LEASE_REQUESTED', 'PHONE_LEASE_CANCELED')]
                assert len(events) == 2
                assert len(h.hub.peers[owner].notifications) <= 2
    asyncio.run(run())


def test_notifications_are_latest_per_kind_without_process_failure(h):
    owner, _ = h.moving()
    for index in range(100):
        for kind in ('lease.requested', 'lease.result'):
            h.hub._notify(owner, {'t': kind, 'number': index})
    messages = h.hub.drain(owner)
    assert len(messages) == 2 and all(m['number'] == 99 for m in messages)
    assert h.hub.owner is owner and not h.hub.session.core.latch


def test_view_credential_cannot_take_or_request_authority(h):
    viewer, _, _ = h.connect(purpose='view')
    for kind in ('lease.take', 'lease.request'):
        result = h.send(viewer, kind)
        assert not result['ok'] and result['error']['code'] == 'FORBIDDEN'
    assert h.hub.owner is None and h.hub.session.lease_id is None


@pytest.mark.parametrize('change', ['trust', 'skew'])
def test_open_clock_trust_or_five_second_drift_stops_and_clears(h, change):
    h.moving()
    if change == 'trust':
        h.verifier.trusted = False  # unit-only fault injection, no production IPC
    else:
        h.clock.offset = 5.01
    h.hub.tick()
    assert h.hub.owner is None and not h.hub.peers and h.hub.session.core.latch
    assert h.outputs[-1].velocity == Z


@pytest.mark.parametrize('delta', [0, -1])
def test_duplicate_or_reversed_sequence_is_fatal(h, delta):
    owner, _ = h.moving()
    previous = h.hub.session.last_seq
    try:
        h.send(owner, 'cmd', lease_id=h.hub.session.lease_id, seq=previous+delta, vx=.6, vy=0, wz=0)
    except PhoneError:
        pass
    assert h.hub.owner is None and h.hub.session.core.latch and h.hub.session.core.out == Z


def test_replay_capacity_retains_all_unexpired_ids(h):
    payload = h.claims()
    h.verifier.verify(signed(h.key, payload))
    with h.verifier.db:
        h.verifier.db.executemany('INSERT INTO used VALUES (?, ?)', [(str(uuid4()), payload['exp']) for _ in range(4095)])
    with pytest.raises(TicketError):
        h.verifier.verify(signed(h.key, h.claims()))
    assert h.verifier.db.execute('SELECT count(*) FROM used').fetchone()[0] == 4096
    assert h.verifier.db.execute('SELECT count(*) FROM used WHERE jti=?', (payload['jti'],)).fetchone()[0] == 1
    with h.verifier.db:
        h.verifier.db.execute('UPDATE used SET exp=?', (int(h.clock.wall()),))
    h.verifier.verify(signed(h.key, h.claims()))
    assert h.verifier.db.execute('SELECT count(*) FROM used').fetchone()[0] == 1


def test_restart_rejects_journal_utc_rollback(h, tmp_path):
    path = str(tmp_path/'private.sqlite')
    one = Verifier(h.robot, {'test': h.key}, org=h.org, replay_path=path, clock_trusted=True,
                   now=h.clock, wall=h.clock.wall)
    one.verify(signed(h.key, h.claims())); one.close()
    h.clock.offset = -1
    two = Verifier(h.robot, {'test': h.key}, org=h.org, replay_path=path, clock_trusted=True,
                   now=h.clock, wall=h.clock.wall)
    try:
        with pytest.raises(TicketError):
            two.verify(signed(h.key, h.claims()))
    finally:
        two.close()


def test_authenticated_viewer_malformed_frame_stops_owner(h):
    owner, _ = h.moving()
    viewer, _, _ = h.connect(purpose='view')
    try:
        h.hub.receive(viewer, '{')
    except PhoneError:
        pass
    assert h.hub.owner is owner and h.hub.session.core.latch and h.outputs[-1].velocity == Z


def test_expired_transfer_target_never_gets_authority(h):
    owner, _ = h.moving()
    target, _, _ = h.connect(exp=int(h.clock.wall())+1)
    request = h.send(target, 'lease.request')['request_id']
    h.clock.t = 1
    result = h.send(owner, 'lease.respond', request_id=request, accept=True)
    assert not result['ok'] and h.hub.owner is owner and target not in h.hub.peers
    assert h.hub.session.core.controller == h.hub.session.lease_id


def test_reservation_never_outlives_ticket_deadline(h):
    owner, _, _ = h.connect(exp=int(h.clock.wall())+2)
    h.take(owner)
    h.hub.disconnect(owner)
    assert h.hub.reservation['until'] == 2
    h.clock.t = 2
    h.hub.tick()
    assert h.hub.reservation is None


@pytest.mark.parametrize('header', [{'alg': 'none'}, {'alg': 'HS512'}, {'typ': 'JWS'}, {'kid': 'missing'}, {'crit': ['x']}])
def test_jose_header_manipulation_is_rejected(h, header):
    with pytest.raises(TicketError):
        h.verifier.verify(signed(h.key, h.claims(), **header))


@pytest.mark.parametrize('part', [0, 1, 2])
def test_jws_padding_is_rejected(h, part):
    pieces = signed(h.key, h.claims()).split('.')
    pieces[part] += '='
    with pytest.raises(TicketError):
        h.verifier.verify('.'.join(pieces))


def test_hub_is_only_link_timer_and_owner_matches_session_lease(h):
    owner, _ = h.moving()
    # Same timeline as reviewer P18b: Session tick gap3.02s, phone ping gap2.98s.
    for _ in range(30):
        h.clock.t += .1
        h.send(owner, 'ping', client_time_ms=1); h.state(False); h.hub.tick()
    h.clock.t += .04
    h.send(owner, 'ping', client_time_ms=2)
    h.clock.t += 2.98
    h.hub.tick()
    assert h.hub.owner is owner and h.hub.session.lease_confirmed
    assert h.hub.session.core.controller == h.hub.session.lease_id
    assert not any(e.get('code') == 'SERVER_LINK_LOST' for e in h.events)
    h.clock.t += .03
    h.hub.tick()
    assert h.hub.owner is None and not h.hub.session.lease_confirmed
    assert h.hub.session.lease_id is None


def test_intermediate_input_preserves_confirmed_neutral_but_never_creates_it(h):
    owner, _, _ = h.connect(); h.take(owner); h.unlock(owner)
    assert h.cmd(owner, .2)['applied'] == list(Z)
    assert h.cmd(owner)['applied'] == list(Z)
    h.cmd(owner, 0)
    for vx in (.2, .4):
        reply = h.cmd(owner, vx)
        assert reply['applied'] == list(Z) and reply['clipped'] and reply['reason']
    assert h.cmd(owner, .6)['applied'] == [.6, 0, 0]


def test_observer_server_stop_reference_never_uses_phone_counter(h):
    h.moving()
    observer = Observer(h.hub)
    assert observer.connect().messages[1]['stop_ref'] == 0
    assert h.hub.session.stop_ref > 0
    observer.receive({'t': 'stop', 'stop_ref': 731})
    assert observer._state()['stop_ref'] == 731
    h.hub.stop()
    assert observer._state()['stop_ref'] == 731
    observer.receive({'t': 'stop', 'stop_ref': -1})
    assert observer._state()['stop_ref'] == 731
    observer.connect()
    assert observer._state()['stop_ref'] == 0
    observer._messages.close()


def test_other_phone_frame_expires_owner_before_emitting_old_output(h):
    owner, _, _ = h.connect(exp=int(h.clock.wall())+1)
    h.take(owner); h.unlock(owner); h.cmd(owner, 0)
    other, _, _ = h.connect()
    h.clock.t = .9
    h.cmd(owner)
    before = len(h.outputs)
    h.clock.t = 1
    h.send(other, 'lease.request')
    assert h.hub.owner is other and h.hub.session.core.latch
    assert all(c.kind != 'apply' or c.velocity == Z for c in h.outputs[before:])


def config_env(h, tmp_path):
    path = tmp_path/'keys.json'
    path.write_text(json.dumps({'test': encode(h.key)})); path.chmod(0o600)
    return {'ROS_DOMAIN_ID': '93', 'ROS_AUTOMATIC_DISCOVERY_RANGE': 'LOCALHOST', 'ROS_LOCALHOST_ONLY': '1',
        'FOOTHOLD_ROBOT_ID': h.robot, 'FOOTHOLD_AGENT_WS_URL': 'ws://127.0.0.1/unused',
        'FOOTHOLD_AGENT_TOKEN': encode(os.urandom(32)), 'FOOTHOLD_PHONE_HOST': '127.0.0.1',
        'FOOTHOLD_PHONE_PORT': '9450', 'FOOTHOLD_PHONE_KEY_PATH': str(path),
        'FOOTHOLD_PHONE_POLICY_NAME': 'test', 'FOOTHOLD_PHONE_POLICY_VERSION': '1',
        'FOOTHOLD_PHONE_ORG_ID': h.org, 'FOOTHOLD_PHONE_REPLAY_DB': str(tmp_path/'replay.sqlite'),
        'FOOTHOLD_PHONE_CLOCK_TRUSTED': '1', 'FOOTHOLD_PHONE_SIMULATION': '1'}


def test_production_settings_reject_memory_and_require_explicit_simulation(h, tmp_path):
    from foothold_agent.ros_bridge.config import Config
    env = config_env(h, tmp_path)
    for bad in (':memory:', 'file::memory:?cache=shared'):
        with pytest.raises(ValueError):
            Config.from_env({**env, 'FOOTHOLD_PHONE_REPLAY_DB': bad})
    missing = dict(env); missing.pop('FOOTHOLD_PHONE_SIMULATION')
    with pytest.raises(ValueError):
        Config.from_env(missing)
    for value in ('0', '1'):
        config = Config.from_env({**env, 'FOOTHOLD_PHONE_SIMULATION': value})
        assert config.phone.simulation is (value == '1')
        config.phone_verifier.close()


@pytest.mark.parametrize('target', ['key', 'journal'])
@pytest.mark.parametrize('kind', ['readable', 'writable', 'symlink', 'directory', 'fifo'])
def test_private_files_reject_unsafe_modes_or_nonregular_files(h, tmp_path, target, kind):
    from foothold_agent.ros_bridge.config import Config
    env = config_env(h, tmp_path)
    name = 'FOOTHOLD_PHONE_KEY_PATH' if target == 'key' else 'FOOTHOLD_PHONE_REPLAY_DB'
    path = tmp_path/'unsafe'
    if kind == 'directory': path.mkdir()
    elif kind == 'fifo': os.mkfifo(path, 0o600)
    elif kind == 'symlink': path.symlink_to(env['FOOTHOLD_PHONE_KEY_PATH'])
    else:
        path.write_text(json.dumps({'test': encode(h.key)}) if target == 'key' else '')
        path.chmod(0o640 if kind == 'readable' else 0o602)
    with pytest.raises(ValueError):
        Config.from_env({**env, name: str(path)})


def test_robot_model_requires_lowercase_canonical_uuid(h):
    pytest.importorskip('pydantic')
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from apps.contracts.models import PhoneEnvelope
    robot = 'abcdef01-0000-0000-0000-000000000001'
    PhoneEnvelope.model_validate({'id': 'x', 'robot': robot})
    for value in (robot.upper(), robot.replace('-', ''), '{'+robot+'}'):
        with pytest.raises(ValueError):
            PhoneEnvelope.model_validate({'id': 'x', 'robot': value})


def test_request_flood_rate_gate_closes_only_the_flooder(h):
    owner, _ = h.moving()
    other, _, _ = h.connect()
    for _ in range(20):
        try:
            h.send(other, 'lease.cancel')
        except PhoneError:
            break
    assert other not in h.hub.peers and h.hub.owner is owner
    assert not h.hub.session.core.latch


def test_sink_fallback_errors_preserve_original_exception(h):
    owner, _ = h.moving()
    failures = [OSError('first output'), OSError('fallback stop'), OSError('fallback zero')]
    attempts = []
    def fail(command):
        attempts.append(command)
        raise failures[len(attempts)-1]
    h.hub.sink = SimpleNamespace(apply=fail)
    try:
        with pytest.raises(OSError) as error:
            h.cmd(owner)
        assert error.value is failures[0]
        assert error.value.output_errors == failures[1:]
        assert attempts[1].kind == 'stop' and attempts[2].velocity == Z
    finally:
        h.hub.sink = h.sink

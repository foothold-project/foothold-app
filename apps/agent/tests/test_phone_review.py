"""PR41 r1/r2: regressions translated from both reviewers' ROS-free reproductions."""
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
async def running(h, *, origins=(), watchdog=True, server_type=Server):
    with phone_socket() as sock:
        port = sock.getsockname()[1]
        server = server_type(h.hub, Settings('127.0.0.1', port, 'unused', 'test', '1', h.org,
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
                waiting = [await stack.enter_async_context(connect(uri, proxy=None)) for _ in range(2)]
                assert sum(p.user is None for p in h.hub.peers.values()) == 2
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
                        await ws.send(json.dumps({'t': 'lease.cancel', 'id': str(index), 'robot': h.robot}))
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


@pytest.mark.parametrize('velocity', [(-.6, 0, 0), (.2, 0, 0), (0, .2, 0), (0, 0, .3)])
def test_intermediate_input_preserves_confirmed_neutral_but_never_creates_it(h, velocity):
    owner, _, _ = h.connect(); h.take(owner); h.unlock(owner)
    assert h.cmd(owner, velocity[0], vy=velocity[1], wz=velocity[2])['applied'] == list(Z)
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


class AddressServer(Server):
    # Inject logical source hosts for loopback-only tests. Production never trusts headers.
    def _address(self, ws):
        return ws.request.headers.get('X-Test-Address', 'controller')


def test_global_pending_cap_and_hello_verification_protection(h, monkeypatch):
    async def run():
        settings = Settings('127.0.0.1', 9450, 'unused', 'test', '1', h.org, 'unused', True, True)
        server = Server(h.hub, settings)
        class Socket:
            def __init__(self, host):
                self.remote_address = (host, 1)
            async def close(self, *args):
                pass
        peers = [server._admit(Socket(str(i))) for i in range(16)]
        replacement = server._admit(Socket('new'))
        assert len(h.hub.peers) == 16 and peers[0] not in h.hub.peers
        assert replacement in h.hub.peers
        # Protect all sixteen validating hellos against another source.
        server.hello_started.update(h.hub.peers)
        with pytest.raises(PhoneError):
            server._admit(Socket('fifth'))
        assert len(h.hub.peers) == 16
        await asyncio.gather(*server.close_tasks)
    asyncio.run(run())


def test_same_source_pending_cap_cannot_evict_validating_hellos(h):
    async def run():
        server = Server(h.hub, Settings('127.0.0.1', 9450, 'unused', 'test', '1', h.org,
                                       'unused', True, True))
        class Socket:
            remote_address = ('test-host', 1)
            async def close(self, *args):
                pass
        first, second = server._admit(Socket()), server._admit(Socket())
        server.hello_started.update((first, second))
        with pytest.raises(PhoneError):
            server._admit(Socket())
        assert set(h.hub.peers) == {first, second}
    asyncio.run(run())


def test_hello_is_protected_before_ticket_verification(h, monkeypatch):
    from websockets.asyncio.client import connect
    async def run():
        async with running(h) as (server, uri, task):
            original = h.verifier.verify
            def verify(ticket):
                pending = [p for p in h.hub.peers if h.hub.peers[p].user is None]
                assert pending and all(p in server.hello_started for p in pending)
                return original(ticket)
            monkeypatch.setattr(h.verifier, 'verify', verify)
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws)
            assert server.failure is None
    asyncio.run(run())


def test_other_source_churn_allows_same_device_reconnect_ten_of_ten(h):
    from websockets.asyncio.client import connect
    owner, claims = h.moving()
    h.hub.disconnect(owner)
    async def run():
        async with running(h, server_type=AddressServer) as (server, uri, task):
            stop = asyncio.Event()
            connections = 0
            async def attacker():
                nonlocal connections
                while not stop.is_set():
                    try:
                        async with connect(uri, proxy=None, additional_headers={'X-Test-Address': 'flood'}) as ws:
                            connections += 1
                            await closed_code(ws)
                    except Exception:
                        await asyncio.sleep(0)
            attackers = [asyncio.create_task(attacker()) for _ in range(16)]
            try:
                for _ in range(100):
                    if connections >= 16:
                        break
                    await asyncio.sleep(.005)
                assert connections >= 16
                assert sum(server.addresses[p] == 'flood' for p in h.hub.peers if h.hub.peers[p].user is None) <= 2
                successes = 0
                for _ in range(10):
                    h.clock.t += .2  # D12: pace valid reconnects within the identity budget.
                    async with connect(uri, proxy=None, additional_headers={'X-Test-Address': 'controller'}) as ws:
                        await hello(h, ws, user=claims['sub'], device=claims['device'])
                        assert (await rpc(h, ws, 'lease.take'))['ok']
                        successes += 1
                        assert (await rpc(h, ws, 'lease.release'))['ok']
                    for _ in range(100):
                        if not any(p.device == claims['device'] for p in h.hub.peers.values()):
                            break
                        await asyncio.sleep(.002)
                    pending = [p for p in h.hub.peers if h.hub.peers[p].user is None]
                    assert sum(server.addresses[p] == 'flood' for p in pending) <= 2
                assert successes == 10 and connections > 16
                assert not task.done() and server.failure is None
            finally:
                stop.set()
                for attacker_task in attackers:
                    attacker_task.cancel()
                await asyncio.gather(*attackers, return_exceptions=True)
    asyncio.run(run())


@pytest.mark.parametrize('cause', ['release', 'disconnect', 'expiry', 'stop-confirmation'])
def test_nonself_cancellation_does_not_penalize_requester(h, monkeypatch, cause):
    if cause == 'expiry':
        owner, _, _ = h.connect(exp=int(h.clock.wall())+1)
        h.take(owner); h.unlock(owner); h.cmd(owner, 0); h.cmd(owner)
    else:
        owner, _ = h.moving()
    requester, _, _ = h.connect()
    identity = (h.hub.peers[requester].user, h.hub.peers[requester].device)
    request = h.send(requester, 'lease.request')['request_id']
    if cause == 'release':
        h.send(owner, 'lease.release')
    elif cause == 'disconnect':
        h.hub.disconnect(owner, reserve=False)
    elif cause == 'expiry':
        h.clock.t = 1
        h.hub.tick()
    else:
        with monkeypatch.context() as patch:
            original = h.hub.session._state
            patch.setattr(h.hub.session, '_state', lambda: {**original(), 'stop_ref': -1})
            response = h.send(owner, 'lease.respond', request_id=request, accept=True)
            assert not response['ok'] and response['error']['code'] == 'STOP_CONFIRM_FAILED'
    assert h.hub.pending is None and identity not in h.hub.cooldowns
    # Another holder makes the cooldown check observable, rather than free take's bypass.
    other, _, _ = h.connect(); assert h.take(other)['ok']
    assert h.send(requester, 'lease.request')['ok']


def test_authenticated_capacity_sixteen_denies_seventeenth_without_stop(h):
    owner, _ = h.moving()
    for _ in range(15):
        h.connect(purpose='view')
    with pytest.raises(PhoneError) as error:
        h.connect(purpose='view')
    assert error.value.code == 'SERVER_BUSY' and error.value.close_code == 1013
    assert sum(p.user is not None for p in h.hub.peers.values()) == 16
    assert h.hub.owner is owner and not h.hub.session.core.latch


@pytest.mark.parametrize('code', [1002, 1003, 1007])
def test_transport_validation_close_codes_stop_authenticated_viewer(h, code):
    from websockets.asyncio.client import connect
    from websockets.frames import Frame, OP_CONT, OP_TEXT
    owner, _ = h.moving()
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws, purpose='view')
                if code == 1003:
                    await ws.close(code=1003, reason='unsupported received data')
                else:
                    ws.protocol.send_frame(Frame(OP_CONT, b'x') if code == 1002 else Frame(OP_TEXT, b'\xff'))
                    ws.send_data()
                assert await closed_code(ws) == code
                for _ in range(100):
                    if not server.connections:
                        break
                    await asyncio.sleep(.005)
                assert h.hub.session.core.latch and h.hub.session.core.out == Z
                assert h.hub.owner is owner and server.failure is None and not task.done()
    asyncio.run(run())


@pytest.mark.parametrize('target', ['key', 'journal'])
def test_private_files_require_runtime_uid(h, tmp_path, monkeypatch, target):
    path = tmp_path/'private'
    path.write_text(json.dumps({'test': encode(h.key)}) if target == 'key' else '')
    path.chmod(0o600)
    other_uid = os.geteuid() + 1
    monkeypatch.setattr(os, 'geteuid', lambda: other_uid)
    with pytest.raises(ValueError):
        if target == 'key':
            load_keys(path)
        else:
            verifier = Verifier(h.robot, {'test': h.key}, org=h.org, replay_path=str(path), clock_trusted=True)
            verifier.close()


def test_replay_journal_inode_swap_is_refused(h, tmp_path, monkeypatch):
    from foothold_agent.phone import tickets
    path, replacement = tmp_path/'journal.sqlite', tmp_path/'replacement.sqlite'
    path.touch(mode=0o600); replacement.touch(mode=0o600)
    original = tickets.sqlite3.connect
    def connect(*args, **kwargs):
        os.replace(replacement, path)
        return original(*args, **kwargs)
    monkeypatch.setattr(tickets.sqlite3, 'connect', connect)
    with pytest.raises(ValueError, match='path changed'):
        verifier = Verifier(h.robot, {'test': h.key}, org=h.org, replay_path=str(path), clock_trusted=True)
        verifier.close()


def test_request_window_reset_keeps_normal_phone_alive_after_ninth_request(h):
    owner, _ = h.moving()
    other, _, _ = h.connect()
    for window in range(3):
        h.clock.t = window
        h.send(owner, 'ping', client_time_ms=window)
        for _ in range(8):
            try:
                response = h.send(other, 'lease.cancel')
            except PhoneError:
                response = None
            assert response is not None and response['ok']
        assert other in h.hub.peers and h.hub.owner is owner
    assert not h.hub.session.core.latch


def test_self_cancel_cooldown_lasts_thirty_seconds(h):
    owner, _ = h.moving()
    requester, _, _ = h.connect()
    assert h.send(requester, 'lease.request')['ok']
    assert h.send(requester, 'lease.cancel')['ok']
    h.advance(29.99)
    response = h.send(requester, 'lease.request')
    assert not response['ok'] and response['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
    h.advance(30)
    assert h.send(requester, 'lease.request')['ok'] and h.hub.owner is owner


@pytest.mark.parametrize('kind', ['lease.cancel', 'lease.release', 'view', 'disconnect', 'ping-timeout'])
def test_requester_withdrawal_all_aliases_keep_identity_cooldown(h, kind):
    owner, _ = h.moving()
    requester, claims, _ = h.connect()
    assert h.send(requester, 'lease.request')['ok']
    if kind == 'disconnect':
        h.hub.disconnect(requester)
    elif kind == 'ping-timeout':
        h.clock.t = 3
        # Keep the holder alive before expiring the requester's missing ping.
        h.hub.peers[owner].last_ping = 3
        h.hub.tick()
    else:
        assert h.send(requester, kind)['ok']
    withdrawn_at = h.clock.t
    if kind in ('disconnect', 'ping-timeout'):
        requester, _, _ = h.connect(user=claims['sub'], device=claims['device'])
    reply = h.send(requester, 'lease.request')
    assert not reply['ok'] and reply['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
    h.advance(withdrawn_at + 29.99)
    reply = h.send(requester, 'lease.request')
    assert not reply['ok'] and reply['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
    h.advance(withdrawn_at + 30)
    assert h.send(requester, 'lease.request')['ok'] and h.hub.owner is owner


@pytest.mark.parametrize('kind', ['lease.cancel', 'lease.release', 'view'])
@pytest.mark.parametrize('pairs_per_second', [4, 8])
def test_requester_withdrawal_probe9_bounds_five_second_audit(h, kind, pairs_per_second):
    owner, _ = h.moving()
    requester, _, _ = h.connect()
    accepted = 0
    for second in range(5):
        if requester not in h.hub.peers:
            break
        h.clock.t = second
        for peer in (owner, requester):
            h.send(peer, 'ping', client_time_ms=second*1000)
        # Request/cancel share one window; release/view use a separate soft window.
        for _ in range(pairs_per_second):
            try:
                response = h.send(requester, 'lease.request')
                accepted += response['ok']
                if not response['ok']:
                    assert response['error']['code'] in ('LEASE_REQUEST_COOLDOWN', 'LEASE_ACQUIRE_LIMIT')
                assert h.send(requester, kind)['ok']
            except PhoneError as error:
                assert error.code == 'REQUEST_FLOOD'
                break
    events = [e for e in h.events if e.get('code') in ('PHONE_LEASE_REQUESTED', 'PHONE_LEASE_CANCELED')]
    assert accepted == 1 and len(events) == 2
    assert requester in h.hub.peers
    assert h.hub.owner is owner and not h.hub.session.core.latch


@pytest.mark.parametrize('kind', ['lease.release', 'view'])
def test_release_and_view_excess_is_replied_ignored_without_disconnect(h, kind):
    owner, _ = h.moving()
    requester, _, _ = h.connect()
    for _ in range(8):
        assert h.send(requester, kind)['ok']
    # Fill the independent request window once; excess release/view must not cancel it.
    assert h.send(requester, 'lease.request')['ok']
    for _ in range(12):
        try:
            reply = h.send(requester, kind)
        except PhoneError:
            reply = None
        assert reply is not None
        assert h.hub.pending is not None and h.hub.pending['peer'] is requester
        assert not reply['ok'] and reply['error']['code'] == 'REQUEST_FLOOD'
        assert reply['error']['detail']['status'] == 429
    assert requester in h.hub.peers and h.hub.owner is owner and not h.hub.session.core.latch
    assert h.send(requester, 'stop')['ok'] and h.hub.session.core.latch
    h.clock.t = 1
    assert h.send(requester, kind)['ok']


@pytest.mark.parametrize('cleanup', ['expiry', 'clock', 'server-disconnect'])
def test_requester_cleanup_uses_cause_for_withdrawal_penalty(h, cleanup):
    owner, _ = h.moving()
    requester, _, _ = h.connect(exp=int(h.clock.wall())+1)
    identity = (h.hub.peers[requester].user, h.hub.peers[requester].device)
    h.send(requester, 'lease.request')
    if cleanup == 'expiry':
        h.clock.t = 1
        h.hub.tick()
    elif cleanup == 'clock':
        with pytest.raises(PhoneError):
            h.hub.fail(requester, 'CLOCK_UNTRUSTED', 4401)
    else:
        h.hub.disconnect(requester, requester_withdrawal=False)
    assert (identity in h.hub.cooldowns) == (cleanup == 'expiry')
    assert h.hub.pending is None


def test_global_pending_replacement_uses_busiest_source_then_oldest(h):
    async def run():
        server = Server(h.hub, Settings('127.0.0.1', 9450, 'unused', 'test', '1', h.org,
                                       'unused', True, True))
        class Socket:
            def __init__(self, address):
                self.remote_address = (address, 1)
            async def close(self, *args):
                pass
        oldest_single = server._admit(Socket('single'))
        first_busy = server._admit(Socket('busy'))
        second_busy = server._admit(Socket('busy'))
        other_busy = server._admit(Socket('other'))
        server._admit(Socket('other'))
        for i in range(11):
            server._admit(Socket(str(i)))
        server._admit(Socket('returning'))
        assert oldest_single in h.hub.peers and first_busy not in h.hub.peers
        assert second_busy in h.hub.peers and other_busy in h.hub.peers
        assert len(h.hub.peers) == 16
        await asyncio.gather(*server.close_tasks)
    asyncio.run(run())


@pytest.mark.parametrize('sources,per_source', [(2, 8), (4, 4), (8, 4)])
def test_real_multisource_churn_controller_reconnects_ten_of_ten(h, sources, per_source):
    from websockets.asyncio.client import connect
    owner, claims = h.moving()
    h.hub.disconnect(owner)
    async def run():
        async with running(h) as (server, uri, task):
            stop = asyncio.Event()
            connections = 0
            errors = []
            async def attacker(address):
                nonlocal connections
                while not stop.is_set():
                    try:
                        async with connect(uri, proxy=None, open_timeout=2, local_addr=(address, 0)) as ws:
                            connections += 1
                            await closed_code(ws)
                    except Exception:
                        await asyncio.sleep(0)
            attackers = [asyncio.create_task(attacker(f'127.0.0.{2 + i % sources}'))
                         for i in range(sources * per_source)]
            try:
                for _ in range(200):
                    if connections >= sources * per_source:
                        break
                    await asyncio.sleep(.005)
                assert connections >= sources * per_source
                successes = 0
                for _ in range(10):
                    h.clock.t += .2  # D12: address admission and identity budgets are independent.
                    try:
                        async with connect(uri, proxy=None, open_timeout=2, local_addr=('127.0.0.1', 0)) as ws:
                            await hello(h, ws, user=claims['sub'], device=claims['device'])
                            result = await rpc(h, ws, 'lease.take')
                            successes += bool(result['ok'])
                            await rpc(h, ws, 'lease.release')
                    except Exception as error:
                        errors.append(type(error).__name__)
                    for _ in range(100):
                        if not any(p.device == claims['device'] for p in h.hub.peers.values()):
                            break
                        await asyncio.sleep(.002)
                assert successes == 10, errors
                assert not task.done() and server.failure is None
            finally:
                stop.set()
                for attacker_task in attackers:
                    attacker_task.cancel()
                await asyncio.gather(*attackers, return_exceptions=True)
    asyncio.run(run())


def test_requester_socket_disconnect_reconnect_cannot_reset_cooldown(h):
    from websockets.asyncio.client import connect
    owner, _ = h.moving()
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                claims = await hello(h, ws)
                assert (await rpc(h, ws, 'lease.request'))['ok']
            for _ in range(100):
                if not server.connections:
                    break
                await asyncio.sleep(.005)
            assert not server.connections and h.hub.pending is None
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws, user=claims['sub'], device=claims['device'])
                response = await rpc(h, ws, 'lease.request')
                assert not response['ok'] and response['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
            assert h.hub.owner is owner and not h.hub.session.core.latch and not task.done()
    asyncio.run(run())


@pytest.mark.parametrize('fault', ['REQUEST_FLOOD', 'VALIDATION', 'FRAME_TOO_LARGE',
                                   'TRANSPORT_INVALID', 'NOTIFICATION_OVERFLOW'])
def test_requester_fault_cleanup_keeps_identity_cooldown(h, fault):
    owner, _ = h.moving()
    requester, claims, _ = h.connect()
    h.send(requester, 'lease.request')
    with pytest.raises(PhoneError):
        h.hub.fail(requester, fault, safety=fault != 'REQUEST_FLOOD')
    requester, _, _ = h.connect(user=claims['sub'], device=claims['device'])
    reply = h.send(requester, 'lease.request')
    assert not reply['ok'] and reply['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
    assert h.hub.owner is owner


@pytest.mark.parametrize('fault', ['flood', 'malformed', 'oversize'])
def test_requester_ws_fault_reconnect_cannot_repeat_accepted_requests(h, fault):
    from websockets.asyncio.client import connect
    owner, _ = h.moving()
    async def run():
        async with running(h) as (server, uri, task):
            claims = None
            accepted = 0
            for _ in range(3):
                async with connect(uri, proxy=None) as ws:
                    fields = {} if claims is None else {'user': claims['sub'], 'device': claims['device']}
                    claims = await hello(h, ws, **fields)
                    if fault == 'flood':
                        # Fill cancel capacity BEFORE a pending request exists. The flood
                        # must itself cause withdrawal, not an earlier successful cancel.
                        for _ in range(8):
                            assert (await rpc(h, ws, 'lease.cancel'))['ok']
                    reply = await rpc(h, ws, 'lease.request')
                    accepted += bool(reply['ok'])
                    if not reply['ok']:
                        assert reply['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
                    if fault == 'flood':
                        await ws.send(json.dumps({'t': 'lease.cancel', 'id': 'flood', 'robot': h.robot}))
                    else:
                        await ws.send('{' if fault == 'malformed' else 'x'*4097)
                    assert await closed_code(ws) == {'flood': 1013, 'malformed': 1007, 'oversize': 1009}[fault]
                for _ in range(100):
                    if not server.connections:
                        break
                    await asyncio.sleep(.005)
                assert not server.connections
            events = [e for e in h.events if e.get('code') in ('PHONE_LEASE_REQUESTED', 'PHONE_LEASE_CANCELED')]
            assert accepted == 1 and len(events) == 2
            assert h.hub.owner is owner and server.failure is None and not task.done()
            assert h.hub.session.core.latch is (fault != 'flood')
            h.advance(29.99)
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws, user=claims['sub'], device=claims['device'])
                reply = await rpc(h, ws, 'lease.request')
                assert not reply['ok'] and reply['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
            h.advance(30)
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws, user=claims['sub'], device=claims['device'])
                assert (await rpc(h, ws, 'lease.request'))['ok']
    asyncio.run(run())


@pytest.mark.parametrize('cause', ['internal', 'stopping', 'send-timeout', 'normal-close'])
def test_handler_cleanup_only_peer_causes_withdrawal_penalty(h, cause, monkeypatch):
    h.moving()
    requester, _, _ = h.connect()
    identity = (h.hub.peers[requester].user, h.hub.peers[requester].device)
    h.send(requester, 'lease.request')
    server = Server(h.hub, Settings('127.0.0.1', 9450, 'unused', 'test', '1', h.org,
                                    'unused', True, True))
    class Socket:
        request = SimpleNamespace(path='/phone/ws')
        async def close(self, *args):
            pass
    ws = Socket()
    server.connections[requester] = ws
    monkeypatch.setattr(server, '_admit', lambda ws: requester)
    failure = RuntimeError('injected internal reader failure')
    async def reader(ws, peer):
        if cause == 'internal':
            raise failure
        if cause == 'stopping':
            server.stopping.set()
        elif cause == 'send-timeout':
            raise asyncio.TimeoutError
    async def states(ws, peer):
        await asyncio.Event().wait()
    monkeypatch.setattr(server, '_read', reader)
    monkeypatch.setattr(server, '_states', states)
    async def run():
        if cause == 'internal':
            with pytest.raises(RuntimeError) as error:
                await server._handler(ws)
            assert error.value is failure and server.failure is failure
        else:
            await server._handler(ws)
        assert (identity in h.hub.cooldowns) == (cause in ('send-timeout', 'normal-close'))
        assert not server.connections and not server.workers and h.hub.pending is None
    asyncio.run(run())


@pytest.mark.parametrize('kind', ['view', 'lease.release'])
def test_viewer_many_release_taps_keeps_socket_and_stop_available(h, kind):
    from websockets.asyncio.client import connect
    owner, _ = h.moving()
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws, purpose='view')
                for index in range(20):
                    reply = await rpc(h, ws, kind)
                    assert reply['ok'] is (index < 8)
                    if index >= 8:
                        assert reply['error']['code'] == 'REQUEST_FLOOD'
                assert h.hub.owner is owner and not h.hub.session.core.latch
                assert (await rpc(h, ws, 'stop'))['ok']
                assert h.hub.session.core.latch and server.failure is None and not task.done()
    asyncio.run(run())


@pytest.mark.parametrize('change', ['device', 'user'])
def test_request_cooldown_is_scoped_to_exact_user_device_pair(h, change):
    owner, _ = h.moving()
    requester, claims, _ = h.connect()
    assert h.send(requester, 'lease.request')['ok']
    h.hub.disconnect(requester)
    fields = {'user': claims['sub']} if change == 'device' else {'device': claims['device']}
    other, _, _ = h.connect(**fields)
    assert h.send(other, 'lease.request')['ok'] and h.hub.owner is owner
    h.send(other, 'lease.cancel')
    h.hub.disconnect(other)
    requester, _, _ = h.connect(user=claims['sub'], device=claims['device'])
    reply = h.send(requester, 'lease.request')
    assert not reply['ok'] and reply['error']['code'] == 'LEASE_REQUEST_COOLDOWN'


def test_direct_hub_unapproved_capacity_sixteen(h):
    for _ in range(15):
        h.hub.peers[object()] = Peer(last_ping=h.clock())
    # Fifteen pending peers still permit a sixteenth hello; capacity is exactly16.
    try:
        admitted = h.connect()
    except PhoneError:
        admitted = None
    assert admitted is not None
    peer = admitted[0]
    assert h.hub.peers[peer].user is not None
    h.hub.peers[peer] = Peer(last_ping=h.clock())
    with pytest.raises(PhoneError) as error:
        h.send(object(), 'hello', proto='fh-phone/1', device=str(uuid4()), ticket='unused')
    assert error.value.code == 'SERVER_BUSY' and error.value.close_code == 1013
    assert len(h.hub.peers) == 16


@pytest.mark.parametrize('acquire', ['take', 'transfer'])
@pytest.mark.parametrize('kind', ['lease.release', 'view'])
def test_owner_release_ignores_limits_after_role_change_and_does_not_count(h, acquire, kind):
    old = h.moving()[0] if acquire == 'transfer' else None
    peer, _, _ = h.connect()
    for _ in range(4):
        h.send(peer, 'lease.cancel')
    for _ in range(8):
        assert h.send(peer, 'view')['ok']
    if acquire == 'take':
        assert h.take(peer)['ok']
    else:
        request = h.send(peer, 'lease.request')['request_id']
        assert h.send(old, 'lease.respond', request_id=request, accept=True)['ok']
    p = h.hub.peers[peer]
    assert p.request_count == p.release_count == 0
    assert p.request_window == p.release_window == float('-inf')
    lease = h.hub.session.lease_id
    h.unlock(peer); h.cmd(peer, 0)
    assert h.cmd(peer)['applied'] == [.6, 0, 0]
    assert h.send(peer, kind)['ok']
    assert p.release_count == 0  # Owner's safety release is never counted.
    assert h.hub.owner is None and h.hub.session.lease_id is None and h.hub.session.core.latch
    assert h.hub.session.core.out == Z and h.outputs[-1].velocity == Z
    reply = h.send(peer, 'cmd', lease_id=lease, seq=1000, vx=.6, vy=0, wz=0)
    assert not reply['ok'] and reply['error']['code'] == 'NOT_CONTROLLER'
    assert h.hub.session.core.out == Z


@pytest.mark.parametrize('kind', ['lease.release', 'view'])
def test_owner_repeated_take_release_is_never_rate_limited(h, kind):
    peer, _, _ = h.connect()
    p = h.hub.peers[peer]
    for _ in range(12):
        h.advance(h.clock.t+1)
        assert h.take(peer)['ok']
        h.unlock(peer); h.cmd(peer, 0); h.cmd(peer)
        assert h.send(peer, kind)['ok']
        assert h.hub.owner is None and h.hub.session.core.latch and h.hub.session.core.out == Z
        assert p.release_count == 0


@pytest.mark.parametrize('acquire', ['take', 'transfer'])
@pytest.mark.parametrize('kind', ['lease.release', 'view'])
def test_ws_owner_release_after_view_taps_stops_locks_and_clears(h, acquire, kind):
    from websockets.asyncio.client import connect
    async def run():
        async with running(h) as (server, uri, task):
            async with AsyncExitStack() as stack:
                if acquire == 'transfer':
                    old = await stack.enter_async_context(connect(uri, proxy=None))
                    await hello(h, old)
                    assert (await rpc(h, old, 'lease.take'))['ok']
                ws = await stack.enter_async_context(connect(uri, proxy=None))
                await hello(h, ws)
                for _ in range(8):
                    assert (await rpc(h, ws, 'view'))['ok']
                if acquire == 'take':
                    take = await rpc(h, ws, 'lease.take')
                    assert take['ok']
                    lease = take['lease_id']
                else:
                    request = await rpc(h, ws, 'lease.request')
                    assert (await rpc(h, old, 'lease.respond', request_id=request['request_id'], accept=True))['ok']
                    lease = h.hub.session.lease_id
                p = h.hub.peers[h.hub.owner]
                assert p.release_count == 0
                h.state(True)
                assert (await rpc(h, ws, 'unlock', lease_id=lease, stop_gen=h.hub.session.core.stop_gen))['ok']
                h.state(False)
                for seq, vx in ((0, 0), (1, .6)):
                    ack = await rpc(h, ws, 'cmd', lease_id=lease, seq=seq, vx=vx, vy=0, wz=0)
                assert ack['applied'] == [.6, 0, 0]
                assert (await rpc(h, ws, kind))['ok']
                assert h.hub.owner is None and h.hub.session.lease_id is None and h.hub.session.core.latch
                assert h.hub.session.core.out == Z and h.outputs[-1].velocity == Z and p.release_count == 0
                reply = await rpc(h, ws, 'cmd', lease_id=lease, seq=2, vx=.6, vy=0, wz=0)
                assert not reply['ok'] and reply['error']['code'] == 'NOT_CONTROLLER'
                assert server.failure is None and not task.done()
    asyncio.run(run())


def test_requester_short_ticket_expiry_cannot_repeat_request_with_new_tickets(h):
    owner, _ = h.moving()
    requester, claims, _ = h.connect(exp=int(h.clock.wall())+1)
    assert h.send(requester, 'lease.request')['ok']
    accepted = 1
    def advance(target):
        while h.clock.t < target:
            h.clock.t = min(target, round(h.clock.t+.1, 8))
            # Only the live holder pings. Expired requesters must not send queued pings.
            h.send(owner, 'ping', client_time_ms=int(h.clock.t*1000))
            h.state(False); h.hub.tick()
    for second in range(1, 30):
        advance(second)
        requester, _, _ = h.connect(user=claims['sub'], device=claims['device'], exp=int(h.clock.wall())+1)
        reply = h.send(requester, 'lease.request')
        accepted += bool(reply['ok'])
        assert not reply['ok'] and reply['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
    events = [e for e in h.events if e.get('code') in ('PHONE_LEASE_REQUESTED', 'PHONE_LEASE_CANCELED')]
    assert accepted == 1 and len(events) == 2
    assert h.hub.owner is owner and not h.hub.session.core.latch
    # Expiry at t=1 starts the30s cooldown, not the original request at t=0.
    advance(30.99)
    requester, _, _ = h.connect(user=claims['sub'], device=claims['device'])
    reply = h.send(requester, 'lease.request')
    assert not reply['ok'] and reply['error']['code'] == 'LEASE_ACQUIRE_LIMIT'
    advance(31)
    assert h.send(requester, 'lease.request')['error']['code'] == 'LEASE_ACQUIRE_LIMIT'


@pytest.mark.parametrize('kind', ['lease.release', 'view'])
def test_owner_release_is_safe_even_if_window_is_already_exhausted(h, kind):
    owner, _ = h.moving()
    p = h.hub.peers[owner]
    # Safety release must tolerate any counter state, including a stale role window.
    p.release_window, p.release_count = h.clock(), 8
    reply = h.send(owner, kind)
    assert reply['ok'] and h.hub.owner is None and h.hub.session.core.latch
    assert h.hub.session.lease_id is None and h.hub.session.core.out == Z
    assert h.outputs[-1].velocity == Z and p.release_count == 8


@pytest.mark.parametrize('acquire', ['lease.take', 'lease.request'])
@pytest.mark.parametrize('release', ['lease.release', 'view'])
def test_acquisition_cycles_obey_independent_identity_budget(h, acquire, release):
    peer, _, _ = h.connect()
    accepted = 0
    for _ in range(100):
        reply = h.send(peer, acquire)
        if reply['ok']:
            accepted += 1
            assert h.send(peer, release)['ok']
            assert h.hub.owner is None and h.hub.session.core.latch and h.hub.session.core.out == Z
        else:
            assert reply['error']['code'] == 'LEASE_ACQUIRE_LIMIT'
    assert accepted == 8
    h.clock.t = 1
    h.hub.tick()  # flush one aggregate, not92 individual denial events
    assert sum(e.get('code') == 'PHONE_LEASE_TAKEN' for e in h.events) == 8
    assert sum(e.get('code') == 'PHONE_LEASE_RELEASED' for e in h.events) == 8
    denied = [e for e in h.events if e.get('code') == 'PHONE_LEASE_ACQUIRE_LIMIT']
    assert len(denied) == 1 and denied[0]['data']['rejected'] == 92
    assert h.send(peer, 'stop')['ok']


@pytest.mark.parametrize('acquire', ['lease.take', 'lease.request'])
def test_ws_three_hundred_acquisitions_bound_safety_history_without_spill(h, acquire):
    from websockets.asyncio.client import connect
    observer = Observer(h.hub)
    h.hub.record = observer.retain
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws)
                accepted = 0
                for _ in range(300):
                    reply = await rpc(h, ws, acquire)
                    if reply['ok']:
                        accepted += 1
                        assert (await rpc(h, ws, 'lease.release'))['ok']
                    else:
                        assert reply['error']['code'] == 'LEASE_ACQUIRE_LIMIT'
                h.clock.t = 1
                h.hub.tick()
                retained = list(observer._messages)
                assert accepted == 8
                assert sum(e.get('code') == 'PHONE_LEASE_TAKEN' for e in retained) == 8
                assert sum(e.get('code') == 'PHONE_LEASE_RELEASED' for e in retained) == 8
                assert len(retained) <= 17 and observer._messages.disk_count == 0
                assert (await rpc(h, ws, 'stop'))['ok']
                assert server.failure is None and not task.done() and h.hub.session.core.latch
    try:
        asyncio.run(run())
    finally:
        h.hub.record = h.events.extend
        observer._messages.close()


def test_acquisition_budget_survives_new_ticket_and_socket(h):
    from websockets.asyncio.client import connect
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                claims = await hello(h, ws)
                for _ in range(8):
                    assert (await rpc(h, ws, 'lease.take'))['ok']
                    assert (await rpc(h, ws, 'lease.release'))['ok']
            for _ in range(100):
                if not server.connections:
                    break
                await asyncio.sleep(.005)
            assert not server.connections
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws, user=claims['sub'], device=claims['device'])
                reply = await rpc(h, ws, 'lease.take')
                assert not reply['ok'] and reply['error']['code'] == 'LEASE_ACQUIRE_LIMIT'
                assert (await rpc(h, ws, 'stop'))['ok'] and not task.done()
    asyncio.run(run())


def test_acquisition_rolling_second_and_minute_boundaries(h):
    peer, _, _ = h.connect(exp=int(h.clock.wall())+120)
    def cycles(n):
        accepted = 0
        for _ in range(n):
            reply = h.take(peer)
            accepted += bool(reply['ok'])
            if reply['ok']:
                assert h.send(peer, 'lease.release')['ok']
            else:
                assert reply['error']['code'] == 'LEASE_ACQUIRE_LIMIT'
        return accepted
    assert cycles(9) == 8
    h.advance(.999)
    assert cycles(1) == 0
    h.advance(1)
    assert cycles(8) == 8
    h.advance(2)
    assert cycles(8) == 8
    h.advance(3)
    assert cycles(8) == 6
    h.advance(59.999)
    assert cycles(1) == 0
    h.advance(60)
    assert cycles(8) == 8


@pytest.mark.parametrize('change', ['user', 'device'])
def test_acquisition_budget_uses_exact_identity_pair(h, change):
    peer, claims, _ = h.connect()
    for _ in range(8):
        assert h.take(peer)['ok']
        h.send(peer, 'lease.release')
    h.hub.disconnect(peer)
    fields = {'user': claims['sub']} if change == 'device' else {'device': claims['device']}
    other, _, _ = h.connect(**fields)
    assert h.take(other)['ok']
    h.send(other, 'lease.release'); h.hub.disconnect(other)
    peer, _, _ = h.connect(user=claims['sub'], device=claims['device'])
    reply = h.take(peer)
    assert not reply['ok'] and reply['error']['code'] == 'LEASE_ACQUIRE_LIMIT'


def test_acquisition_denial_audit_is_globally_batched_per_second(h):
    peers = [h.connect()[0] for _ in range(2)]
    for peer in peers:
        for _ in range(8):
            h.take(peer); h.send(peer, 'lease.release')
    for _ in range(100):
        for peer in peers:
            assert not h.take(peer)['ok']
    assert not any(e.get('code') == 'PHONE_LEASE_ACQUIRE_LIMIT' for e in h.events)
    h.advance(1)
    records = [e for e in h.events if e.get('code') == 'PHONE_LEASE_ACQUIRE_LIMIT']
    assert len(records) == 1 and records[0]['data']['rejected'] == 200
    for _ in range(40):
        h.send(peers[0], 'stop')
    assert len([e for e in h.events if e.get('code') == 'PHONE_LEASE_ACQUIRE_LIMIT']) == 1


def test_viewer_twenty_stop_taps_never_count_or_close(h):
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed
    owner, _ = h.moving()
    async def run():
        async with running(h) as (server, uri, task):
            async with connect(uri, proxy=None) as ws:
                await hello(h, ws, purpose='view')
                generation = h.hub.session.core.stop_gen
                for _ in range(20):
                    try:
                        reply = await rpc(h, ws, 'stop')
                    except ConnectionClosed:
                        reply = None
                    assert reply is not None and reply['ok']
                    generation += 1
                    assert h.hub.session.core.stop_gen == generation
                    assert h.hub.session.core.latch and h.hub.session.core.out == Z
                    assert h.outputs[-1].velocity == Z and h.hub.owner is owner
                assert (await rpc(h, ws, 'ping', client_time_ms=1))['ok']
                assert server.failure is None and not task.done()
    asyncio.run(run())


def test_requester_expiry_cooldown_boundary_below_acquisition_budget(h):
    owner, _ = h.moving()
    requester, claims, _ = h.connect(exp=int(h.clock.wall())+1)
    h.send(requester, 'lease.request')
    h.clock.t = 1
    h.send(owner, 'ping', client_time_ms=1000)
    h.advance(30.99)
    requester, _, _ = h.connect(user=claims['sub'], device=claims['device'])
    reply = h.send(requester, 'lease.request')
    assert not reply['ok'] and reply['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
    h.advance(31)
    assert h.send(requester, 'lease.request')['ok']

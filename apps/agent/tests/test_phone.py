"""ROS-free phone acceptance: ephemeral test keys, fake clock/sink and loopback WS."""
import asyncio
import base64
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import hmac
import json
import os
from pathlib import Path
import socket
import sys
import time
from uuid import uuid4

import pytest

from foothold_agent.phone.hub import Hub, PhoneError
from foothold_agent.phone.observer import Observer, DiscardSink
from foothold_agent.phone.protocol import LIMITS, project_velocity
from foothold_agent.phone.server import Server, Settings
from foothold_agent.phone.tickets import Verifier, TicketError, load_keys
from foothold_agent.safety.core import SCHEMA, Z


class Clock:
    t = 0.
    offset = 0.
    def __call__(self):
        return self.t
    def wall(self):
        return 1800000000. + self.t + self.offset


def encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


def signed(key, claims, **header):
    a = encode(json.dumps({'alg': 'HS256', 'typ': 'JWT', 'kid': 'test', **header}).encode())
    b = encode(json.dumps(claims).encode())
    return a + '.' + b + '.' + encode(hmac.digest(key, (a+'.'+b).encode(), hashlib.sha256))


class Harness:
    def __init__(self, *, replay_path=':memory:', clock=None):
        self.clock = clock or Clock()
        self.robot, self.org = str(uuid4()), str(uuid4())
        self.key = os.urandom(32)
        self.outputs, self.events = [], []
        self.verifier = Verifier(self.robot, {'test': self.key}, org=self.org, replay_path=replay_path,
                                 clock_trusted=True, now=self.clock, wall=self.clock.wall)
        self.sink = type('Sink', (), {'apply': lambda _, command: self.outputs.append(command)})()
        self.hub = Hub(self.verifier, self.sink, policy_name='test-policy', policy_version='1',
                       simulation=True, now=self.clock, wall=self.clock.wall, record=self.events.extend)
        self.ids = 0
        self.sequence = 0

    def claims(self, user=None, device=None, **overrides):
        return {'iss': 'fh-control', 'aud': 'fh-phone/1', 'org': self.org, 'robot': self.robot,
                'sub': user or str(uuid4()), 'device': device or str(uuid4()), 'purpose': 'control',
                'iat': int(self.clock.wall()), 'exp': int(self.clock.wall())+120, 'jti': str(uuid4()), **overrides}

    def send(self, peer, kind, **body):
        self.ids += 1
        return self.hub.receive(peer, json.dumps({'t': kind, 'id': str(self.ids), 'robot': self.robot, **body}))

    def connect(self, peer=None, **claims):
        peer = peer or object()
        payload = self.claims(**claims)
        welcome = self.send(peer, 'hello', proto='fh-phone/1', device=payload['device'], ticket=signed(self.key, payload))
        return peer, payload, welcome

    def take(self, peer):
        return self.send(peer, 'lease.take')

    def state(self, stop=False, **extra):
        self.hub.on_robot_state({'schema': SCHEMA, 'episode': 0, 'sim_t': self.clock.t,
            'stop_requested': stop, 'reset_in_progress': False, 'policy_running': True,
            'fallen': False, 'body_still': not self.hub.session.core.out[0], **extra})

    def cmd(self, peer, vx=.6, vy=0, wz=0, **extra):
        self.sequence += 1
        return self.send(peer, 'cmd', lease_id=self.hub.session.lease_id,
                         seq=self.sequence, vx=vx, vy=vy, wz=wz, **extra)

    def unlock(self, peer):
        self.state(True)
        result = self.send(peer, 'unlock', lease_id=self.hub.session.lease_id,
                           stop_gen=self.hub.session.core.stop_gen)
        assert result['ok']
        assert self.hub.session.core.latch  # unlock request is not feedback
        self.state(False)
        assert not self.hub.session.core.latch

    def moving(self):
        peer, payload, _ = self.connect()
        assert self.take(peer)['ok']
        self.unlock(peer)
        self.cmd(peer, 0)
        assert self.cmd(peer)['applied'] == [.6, 0, 0]
        return peer, payload

    def advance(self, target, *, ping=True):
        while self.clock.t < target:
            self.clock.t = min(target, round(self.clock.t+.1, 8))
            if ping:
                for peer, p in list(self.hub.peers.items()):
                    if p.user is not None:
                        self.send(peer, 'ping', client_time_ms=int(self.clock.t*1000))
            self.state(False)
            self.hub.tick()


@pytest.fixture
def h():
    fixture = Harness()
    yield fixture
    fixture.hub.close()
    fixture.verifier.close()


def test_phone_single_controller_and_connection_bound_lease(h):
    a, _, welcome = h.connect()
    b, _, _ = h.connect()
    assert welcome['limits'] == LIMITS and welcome['simulation']
    assert h.take(a)['ok']
    lease = h.hub.session.lease_id
    assert not h.take(b)['ok']
    h.unlock(a)
    h.cmd(a, 0)
    h.cmd(a)
    before = (h.hub.session.last_seq, h.hub.session.core.intent_t, len(h.outputs))
    reply = h.cmd(b, wz=.5)
    assert reply['t'] == 'reply' and not reply['ok']
    assert reply['error']['code'] == 'NOT_CONTROLLER'
    assert (h.hub.session.last_seq, h.hub.session.core.intent_t, len(h.outputs)) == before
    assert h.hub.session.lease_id == lease and h.hub.owner == a
    assert h.hub.state(b)['lease_id'] is None


def test_phone_concurrent_requests_only_one_holder(h):
    async def run():
        a, _, _ = h.connect()
        b, _, _ = h.connect()
        async def take(peer):
            await asyncio.sleep(0)
            return h.take(peer)
        replies = await asyncio.gather(take(a), take(b))
        assert sum(reply['ok'] for reply in replies) == 1
        assert h.hub.session.core.controller == h.hub.session.lease_id
    asyncio.run(run())


@pytest.mark.parametrize('change', ['expired', 'forged', 'robot', 'org', 'aud', 'device', 'purpose', 'long', 'future', 'bool'])
def test_phone_rejects_invalid_ticket(h, change):
    payload = h.claims()
    device = payload['device']
    if change == 'expired': payload.update(iat=int(h.clock.wall())-10, exp=int(h.clock.wall()))
    if change == 'robot': payload['robot'] = str(uuid4())
    if change == 'org': payload['org'] = str(uuid4())
    if change == 'aud': payload['aud'] = 'other'
    if change == 'device': device = str(uuid4())
    if change == 'purpose': payload['purpose'] = 'admin'
    if change == 'long': payload['exp'] = payload['iat'] + 601
    if change == 'future': payload['iat'] += 1
    if change == 'bool': payload['iat'] = True
    key = os.urandom(32) if change == 'forged' else h.key
    with pytest.raises(PhoneError) as error:
        h.send(object(), 'hello', proto='fh-phone/1', device=device, ticket=signed(key, payload))
    assert error.value.close_code == 4403
    assert h.hub.owner is None and h.hub.session.core.latch


def test_phone_ticket_replay_and_same_device_second_tab(h):
    a, payload, _ = h.connect()
    with pytest.raises(PhoneError):
        h.send(object(), 'hello', proto='fh-phone/1', device=payload['device'], ticket=signed(h.key, payload))
    with pytest.raises(PhoneError) as error:
        h.connect(user=payload['sub'], device=payload['device'])
    assert error.value.code == 'DEVICE_CONNECTED'
    assert a in h.hub.peers
    h.hub.disconnect(a)
    # A new credential is required even after the first socket has closed.
    with pytest.raises(PhoneError):
        h.send(object(), 'hello', proto='fh-phone/1', device=payload['device'], ticket=signed(h.key, payload))


def test_phone_replay_journal_survives_restart_and_fails_closed(tmp_path):
    clock = Clock()
    robot, org, key = str(uuid4()), str(uuid4()), os.urandom(32)
    claims = {'iss': 'fh-control', 'aud': 'fh-phone/1', 'org': org, 'robot': robot, 'sub': str(uuid4()),
              'device': str(uuid4()), 'purpose': 'view', 'iat': int(clock.wall()),
              'exp': int(clock.wall())+120, 'jti': str(uuid4())}
    path = str(tmp_path/'spent.sqlite')
    def verifier():
        return Verifier(robot, {'test': key}, org=org, replay_path=path, clock_trusted=True, now=clock, wall=clock.wall)
    one = verifier()
    one.verify(signed(key, claims))
    one.close()
    two = verifier()
    rejected = False
    try:
        two.verify(signed(key, claims))
    except TicketError:
        rejected = True
    assert rejected
    two.db.close()
    with pytest.raises(TicketError):
        two.verify(signed(key, {**claims, 'jti': str(uuid4())}))


def test_phone_open_ticket_expiry_stops_locks_and_clears(h):
    a, _, _ = h.connect(exp=int(h.clock.wall())+1)
    h.take(a)
    h.unlock(a)
    h.cmd(a, 0)
    h.cmd(a)
    h.clock.t = 1
    h.state(False)
    h.hub.tick()
    assert h.hub.owner is None and h.hub.reservation is None
    assert a not in h.hub.peers and h.hub.session.core.latch
    assert h.outputs[-1].velocity == Z


def test_phone_expiry_checked_before_queued_command(h):
    a, _, _ = h.connect(exp=int(h.clock.wall())+1)
    h.take(a)
    h.clock.t = 1
    try:
        h.cmd(a)
    except PhoneError:
        pass
    assert h.hub.owner is None and h.hub.session.core.latch
    assert h.hub.session.core.out == Z


def test_phone_disconnect_stops_and_reserves_then_reconnects_with_new_lease(h):
    a, claims = h.moving()
    old_lease = h.hub.session.lease_id
    h.hub.disconnect(a)
    assert h.outputs[-1].velocity == Z and h.hub.session.core.latch
    assert h.hub.owner is None and h.hub.reservation['identity'] == (claims['sub'], claims['device'])
    other, _, _ = h.connect()
    assert not h.take(other)['ok']
    same, _, _ = h.connect(user=claims['sub'], device=claims['device'])
    assert h.take(same)['ok'] and h.hub.session.lease_id != old_lease
    assert h.hub.session.core.latch
    h.unlock(same)
    assert h.cmd(same)['applied'] == list(Z)
    h.cmd(same, 0)
    assert h.cmd(same)['applied'] == [.6, 0, 0]


def test_phone_ping_loss_stops_at_three_seconds_clears_at_fifteen(h):
    a, _ = h.moving()
    h.clock.t = 2.99
    h.hub.tick()
    assert h.hub.owner == a
    h.clock.t = 3
    expired = h.hub.tick()
    assert expired and expired[0][1].code == 'PHONE_LINK_LOST'
    assert h.hub.session.core.latch and h.hub.session.core.out == Z
    assert h.hub.reservation is not None
    h.clock.t = 14.99
    h.hub.tick()
    assert h.hub.reservation is not None
    h.clock.t = 15
    h.hub.tick()
    assert h.hub.reservation is None
    b, _, _ = h.connect()
    assert h.take(b)['ok']


def test_phone_cmd_does_not_replace_ping(h):
    a, _ = h.moving()
    h.clock.t = 3
    try:
        h.cmd(a)
    except PhoneError:
        pass
    assert h.hub.owner is None and h.hub.session.core.latch


def test_phone_deadman_boundary_and_new_neutral(h):
    a, _ = h.moving()
    h.clock.t = .3
    h.hub.tick()
    assert h.hub.session.core.out == (.6, 0, 0)
    h.clock.t = .30001
    h.hub.tick()
    assert h.hub.session.core.out == Z and not h.hub.session.core.latch
    assert h.cmd(a)['applied'] == list(Z)
    h.cmd(a, 0)
    assert h.cmd(a)['applied'] == [.6, 0, 0]


def test_phone_stop_unlock_requires_feedback_and_new_neutral(h):
    a, _ = h.moving()
    b, _, _ = h.connect(purpose='view')
    assert not h.take(b)['ok']
    h.send(b, 'stop')
    assert h.cmd(a)['applied'] == list(Z) and h.hub.session.core.latch
    assert not h.send(b, 'unlock', lease_id=h.hub.session.lease_id, stop_gen=h.hub.session.core.stop_gen)['ok']
    stale_gen = h.hub.session.core.stop_gen-1
    h.state(True)
    assert not h.send(a, 'unlock', lease_id=h.hub.session.lease_id, stop_gen=stale_gen)['ok']
    h.unlock(a)
    assert h.cmd(a)['applied'] == list(Z)
    h.cmd(a, 0)
    assert h.cmd(a)['applied'] == [.6, 0, 0]


@pytest.mark.parametrize('velocity,expected,clipped', [
    ((9, 8, 7), (.6, 0, .5), True), ((-2, 0, 1), Z, True),
    ((.2, 0, .2), Z, True), ((.6, 0, -.5), (.6, 0, -.5), False),
    ((0, 0, 0), Z, False), ((.6, 0, .1), (.6, 0, 0), True)])
def test_phone_limits_never_expand_core_alphabet(h, velocity, expected, clipped):
    a, _ = h.moving()
    reply = h.cmd(a, *velocity)
    assert reply['applied'] == list(expected) and reply['clipped'] is clipped
    assert LIMITS['commands'] == [[0, 0, 0], [.6, 0, 0], [.6, 0, -.5], [.6, 0, .5]]


@pytest.mark.parametrize('raw', ['[]', '{}', '{', '{"t":"stop","t":"cmd"}', b'binary',
    'x'*4097, '{"t":"ping","id":"a","robot":null}', '{"t":"unknown","id":"a"}'])
def test_phone_malformed_frames_stop_and_lock(h, raw):
    a, _ = h.moving()
    try:
        h.hub.receive(a, raw)
    except PhoneError:
        pass
    assert h.hub.session.core.latch and h.outputs[-1].velocity == Z
    assert h.hub.owner is None


@pytest.mark.parametrize('bad', [True, None, float('nan'), float('inf'), '0', 10**200])
def test_phone_invalid_command_numbers_are_fatal(h, bad):
    a, _ = h.moving()
    with pytest.raises(PhoneError):
        h.cmd(a, bad)
    assert h.hub.session.core.latch and h.hub.owner is None


def test_phone_second_hello_stops_and_locks(h):
    a, payload = h.moving()
    try:
        h.send(a, 'hello', proto='fh-phone/1', device=payload['device'], ticket=signed(h.key, payload))
    except PhoneError as error:
        assert error.close_code == 1012
    assert h.hub.session.core.latch and h.hub.owner is None and h.outputs[-1].velocity == Z


def test_phone_handoff_blocks_old_input_and_requires_explicit_unlock(h):
    a, _ = h.moving()
    b, _, _ = h.connect()
    request = h.send(b, 'lease.request')['request_id']
    assert h.hub.drain(a)[0]['request_id'] == request
    before = len(h.outputs)
    assert h.send(a, 'lease.respond', request_id=request, accept=True)['ok']
    assert h.hub.owner == b and h.hub.session.core.latch
    assert all(m.kind != 'apply' or m.velocity == Z for m in h.outputs[before:])
    assert not h.cmd(a)['ok']
    assert h.hub.drain(b)[0]['result'] == 'ACCEPTED'
    h.unlock(b)
    assert h.cmd(b)['applied'] == list(Z)
    h.cmd(b, 0)
    assert h.cmd(b)['applied'] == [.6, 0, 0]


@pytest.mark.parametrize('accept', [False, None])
def test_phone_request_decline_timeout_cooldown(h, accept):
    a, _ = h.moving()
    b, _, _ = h.connect()
    request = h.send(b, 'lease.request')['request_id']
    assert not h.send(b, 'lease.request')['ok']
    if accept is False:
        h.send(a, 'lease.respond', request_id=request, accept=False)
    else:
        h.advance(10)
    assert h.hub.owner == a
    result = h.hub.drain(b)[0]['result']
    assert result == ('DECLINED' if accept is False else 'TIMEOUT')
    assert h.send(b, 'lease.request')['error']['code'] == 'LEASE_REQUEST_COOLDOWN'
    h.advance(h.clock.t+30)
    assert h.send(b, 'lease.request')['ok']


def test_phone_release_view_and_request_cancel(h):
    a, _ = h.moving()
    b, _, _ = h.connect()
    h.send(b, 'lease.request')
    h.send(b, 'lease.cancel')
    assert h.hub.pending is None and h.hub.owner == a
    h.send(a, 'view')
    assert h.hub.owner is None and h.hub.reservation is None and h.hub.session.core.latch
    assert h.take(b)['ok']
    h.send(b, 'lease.release')
    assert h.hub.owner is None and h.hub.reservation is None


def test_phone_stop_confirmation_failure_never_grants(h, monkeypatch):
    a, _, _ = h.connect()
    original = h.hub.session._state
    monkeypatch.setattr(h.hub.session, '_state', lambda: {**original(), 'stop_ref': -1})
    reply = h.take(a)
    assert not reply['ok'] and reply['error']['code'] == 'STOP_CONFIRM_FAILED'
    assert h.hub.owner is None


def test_phone_no_cloud_lease_cmd_unlock_run_or_reconnect_can_change_authority(h):
    a, _ = h.moving()
    observer = Observer(h.hub)
    before = (h.hub.session.lease_id, h.hub.session.core.stop_gen, h.hub.session.last_seq, len(h.outputs))
    for method in (observer.connect, observer.disconnect, observer.connect,
                   lambda: observer.transport_closed(1012, retry=True)):
        assert not method().motion
    for kind in ('lease', 'cmd', 'unlock', 'run.start', 'run.control', 'slam', 'floor.set'):
        observer.receive({'t': kind, 'lease_id': str(uuid4()), 'axes': [1, 0, 1], 'stop_gen': 0})
    assert (h.hub.session.lease_id, h.hub.session.core.stop_gen, h.hub.session.last_seq, len(h.outputs)) == before
    assert h.hub.owner == a and h.hub.session.run is None
    observer.receive({'t': 'stop'})
    assert h.hub.session.core.latch and h.outputs[-1].velocity == Z
    assert observer._state()['stop_gen'] == h.hub.session.core.stop_gen
    observer._messages.close()


def test_phone_clock_untrusted_and_rollback_stop_open_connections(h):
    a, _ = h.moving()
    h.clock.offset = -1
    h.hub.tick()
    assert h.hub.owner is None and h.hub.reservation is None and not h.hub.peers
    assert h.hub.session.core.latch and h.outputs[-1].velocity == Z
    with pytest.raises(PhoneError):
        h.connect()


def test_phone_simulation_pause_does_not_extend_ticket_deadline(h):
    a, _, _ = h.connect(exp=int(h.clock.wall())+1)
    h.take(a)
    h.state(sim_t=0)
    h.clock.t = 1
    h.hub.tick()
    assert h.hub.owner is None and h.hub.session.core.latch


def test_phone_state_echo_measurements_and_clock_difference(h):
    a, _, _ = h.connect()
    h.state(sim_t=10, vx=.6, vy=0, wz=.5, tilt_deg=2, z=.3)
    h.clock.t = .2
    h.state(sim_t=10.1, vx=.6, vy=0, wz=.5, tilt_deg=2, z=.3)
    h.send(a, 'ping', client_time_ms=123)
    result = h.hub.state(a)
    assert result['echo']['client_time_ms'] == 123
    assert result['battery']['soc'] is None and result['speed'] is None
    assert result['velocity'] == [.6, 0, .5] and result['posture']['tilt_deg'] == 2
    assert result['sim_wall_delta_s'] == pytest.approx(-.1)
    h.clock.t = 1.21
    result = h.hub.state(a)
    assert result['velocity'] == [None]*3 and result['sim_time_s'] is None


def test_phone_output_failure_attempts_both_stop_and_zero(h):
    a, _ = h.moving()
    attempts = []
    def fail(command):
        attempts.append(command)
        raise OSError('fake sink error')
    h.hub.sink = type('Sink', (), {'apply': lambda _, command: fail(command)})()
    with pytest.raises(OSError):
        h.cmd(a)
    assert any(m.kind == 'stop' for m in attempts) and attempts[-1].velocity == Z
    h.hub.sink = h.sink


@contextmanager
def phone_socket():
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        for port in range(9450, 9470):
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                continue
            sock.listen(16)
            yield sock
            return
        raise RuntimeError('no authorized phone test port')
    finally:
        sock.close()


def test_phone_ws_two_clients_disconnect_and_state_stream(h):
    from websockets.asyncio.client import connect
    async def run():
        with phone_socket() as sock:
            port = sock.getsockname()[1]
            server = Server(h.hub, Settings('127.0.0.1', port, 'unused', 'test', '1', h.org, 'unused-replay.sqlite', True, True), sock=sock)
            task = asyncio.create_task(server.run())
            await asyncio.wait_for(server.ready.wait(), 2)
            uri = f'ws://127.0.0.1:{port}/phone/ws'
            async def response(ws, kind, **fields):
                h.ids += 1
                identity = str(h.ids)
                await ws.send(json.dumps({'t': kind, 'id': identity, 'robot': h.robot, **fields}))
                while True:
                    reply = json.loads(await asyncio.wait_for(ws.recv(), 2))
                    if reply.get('id') == identity:
                        return reply
            try:
                async with connect(uri, proxy=None) as a, connect(uri, proxy=None) as b:
                    for ws in (a, b):
                        payload = h.claims()
                        welcome = await response(ws, 'hello', proto='fh-phone/1', device=payload['device'], ticket=signed(h.key, payload))
                        assert welcome['limits'] == LIMITS
                    replies = await asyncio.gather(response(a, 'lease.take'), response(b, 'lease.take'))
                    assert sum(r['ok'] for r in replies) == 1
                    owner_ws = a if replies[0]['ok'] else b
                    lease = h.hub.session.lease_id
                    h.state(True)
                    assert (await response(owner_ws, 'unlock', lease_id=lease, stop_gen=h.hub.session.core.stop_gen))['ok']
                    h.state(False)
                    for seq, vx in ((0, 0), (1, .6)):
                        ack = await response(owner_ws, 'cmd', lease_id=lease, seq=seq, vx=vx, vy=0, wz=0)
                    assert ack['applied'] == [.6, 0, 0]
                    await owner_ws.close()
                    for _ in range(40):
                        if h.hub.owner is None:
                            break
                        await asyncio.sleep(.01)
                    assert h.hub.owner is None and h.hub.session.core.latch and h.outputs[-1].velocity == Z
            finally:
                server.stopping.set()
                await asyncio.wait_for(task, 2)
    asyncio.run(run())


def test_phone_contract_models_match_runtime_frames(h):
    pytest.importorskip('pydantic')
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from apps.contracts.models import PhoneWelcome, PhoneState, PhoneReply, PhoneCmdAck, PhoneLeaseRequested, PhoneLeaseResult
    a, _, welcome = h.connect()
    PhoneWelcome.model_validate(welcome)
    PhoneState.model_validate(h.hub.state(a))
    PhoneReply.model_validate(h.take(a))
    h.unlock(a)
    PhoneCmdAck.model_validate(h.cmd(a, 0))
    b, _, _ = h.connect()
    request = h.send(b, 'lease.request')['request_id']
    PhoneLeaseRequested.model_validate(h.hub.drain(a)[0])
    h.send(a, 'lease.respond', request_id=request, accept=False)
    PhoneLeaseResult.model_validate(h.hub.drain(b)[0])


@pytest.mark.parametrize('velocity', [(-.6, 0, 0), (.2, 0, 0), (0, .2, 0), (0, 0, .3)])
def test_phone_clipped_zero_cannot_replace_explicit_neutral(h, velocity):
    a, _, _ = h.connect()
    h.take(a)
    h.unlock(a)
    assert h.cmd(a, velocity[0], vy=velocity[1], wz=velocity[2])['applied'] == list(Z)
    assert h.cmd(a)['applied'] == list(Z)
    h.cmd(a, 0)
    assert h.cmd(a)['applied'] == [.6, 0, 0]


def test_phone_bridge_feedback_cannot_apply_expired_intent(h):
    a, _, _ = h.connect(exp=int(h.clock.wall())+1)
    h.take(a)
    h.unlock(a)
    h.cmd(a, 0)
    h.clock.t = .9
    h.cmd(a)
    before = len(h.outputs)
    h.clock.t = 1
    h.state(False)
    assert h.hub.owner is None and h.hub.session.core.latch
    assert all(m.kind != 'apply' or m.velocity == Z for m in h.outputs[before:])


def test_phone_configuration_is_opt_in_and_secrets_are_external(h, tmp_path):
    assert Settings.from_env({}) is None
    with pytest.raises(ValueError):
        Settings.from_env({'FOOTHOLD_PHONE_PORT': '9450'})
    secret_path = tmp_path/'keys.json'
    secret_path.write_text(json.dumps({'test': encode(h.key)}))
    secret_path.chmod(0o600)
    assert load_keys(secret_path) == {'test': h.key}
    secret_path.write_text(json.dumps({'test': encode(os.urandom(8))}))
    with pytest.raises(ValueError):
        load_keys(secret_path)
    verifier = Verifier(h.robot, {'test': h.key}, org=h.org, replay_path=':memory:', clock_trusted=False)
    try:
        with pytest.raises(TicketError):
            verifier.verify(signed(h.key, h.claims()))
    finally:
        verifier.close()


@pytest.mark.parametrize('simulation', [False, True])
def test_phone_ros_entrypoint_uses_one_session_and_one_sink_without_starting_ros(h, monkeypatch, simulation):
    from types import SimpleNamespace
    from foothold_agent.ros_bridge import __main__ as runner
    from foothold_agent.link.client import Client as ActualClient
    observed = {}
    class Bridge:
        def __init__(self, config):
            self.inputs = SimpleNamespace(telemetry=SimpleNamespace(snapshot=lambda: None), device_observations=lambda: [])
        async def start(self, on_state, *, on_telemetry, on_devices):
            observed.update(state=on_state, telemetry=on_telemetry, devices=on_devices)
            return h.sink
        async def wait_failure(self):
            await asyncio.Event().wait()
        def close(self):
            observed['closed'] = True
    class NoListener(Server):
        async def run(self):
            observed['phone'] = self.hub
            await asyncio.Event().wait()
    class Client(ActualClient):
        async def run(self):
            assert isinstance(self.session, Observer) and isinstance(self.sink, DiscardSink)
            phone = self.session.phone
            assert observed['phone'] is phone
            assert phone.simulation is simulation
            observed['telemetry'](None)
            observed['devices']([])
            observed['state']({'schema': SCHEMA, 'episode': 0, 'stop_requested': True,
                              'reset_in_progress': False, 'policy_running': True})
            assert phone.session.core.st is not None
            self.session.receive({'t': 'lease', 'lease_id': str(uuid4()), 'holder_type': 'USER'})
            assert phone.session.lease_id is None
            # Actual network transport isn't started by this regression test.
            self.session._messages.close()
    monkeypatch.setattr(runner, 'RosNode', Bridge)
    monkeypatch.setattr(runner, 'Server', NoListener)
    monkeypatch.setattr(runner, 'Client', Client)
    config = SimpleNamespace(phone=Settings('127.0.0.1', 9450, 'unused', 'test', '1', h.org, 'unused-replay.sqlite', True, simulation),
                             phone_verifier=h.verifier, settings=None)
    # Schedule the phone task first inside the injected Client to observe it.
    original = Client.run
    async def delayed(self):
        await asyncio.sleep(0)
        return await original(self)
    monkeypatch.setattr(Client, 'run', delayed)
    # runner owns/ closes this verifier; keep fixture cleanup independent.
    config.phone_verifier = Verifier(h.robot, {'test': h.key}, org=h.org, replay_path=':memory:', clock_trusted=True)
    asyncio.run(runner.run(config))
    assert observed['closed'] and observed['phone'].session.core.latch
    assert h.outputs[-1].velocity == Z


def test_phone_config_validates_keys_and_journal_before_ros(h, tmp_path):
    from foothold_agent.ros_bridge.config import Config
    key_path = tmp_path/'keys.json'
    key_path.write_text(json.dumps({'test': encode(h.key)}))
    key_path.chmod(0o600)
    env = {'ROS_DOMAIN_ID': '93', 'ROS_AUTOMATIC_DISCOVERY_RANGE': 'LOCALHOST', 'ROS_LOCALHOST_ONLY': '1',
           'FOOTHOLD_ROBOT_ID': h.robot, 'FOOTHOLD_AGENT_WS_URL': 'ws://127.0.0.1/unused',
           'FOOTHOLD_AGENT_TOKEN': encode(os.urandom(32)), 'FOOTHOLD_PHONE_HOST': '127.0.0.1',
           'FOOTHOLD_PHONE_PORT': '9450', 'FOOTHOLD_PHONE_KEY_PATH': str(key_path),
           'FOOTHOLD_PHONE_POLICY_NAME': 'test', 'FOOTHOLD_PHONE_POLICY_VERSION': '1',
           'FOOTHOLD_PHONE_ORG_ID': h.org, 'FOOTHOLD_PHONE_REPLAY_DB': str(tmp_path/'replay.sqlite'),
           'FOOTHOLD_PHONE_CLOCK_TRUSTED': '1', 'FOOTHOLD_PHONE_SIMULATION': '1'}
    config = Config.from_env(env)
    assert config.phone_verifier.robot == h.robot
    assert config.phone.port == 9450
    assert str(key_path) not in repr(config)
    config.phone_verifier.close()
    with pytest.raises(ValueError):
        Config.from_env({**env, 'FOOTHOLD_PHONE_CLOCK_TRUSTED': '0'})


def test_phone_stdlib_import_does_not_load_websockets_or_pydantic():
    import subprocess
    root = Path(__file__).resolve().parents[1]
    source = ('import sys; sys.path.insert(0, '+repr(str(root))+'); '
              'from foothold_agent.phone import hub, tickets, server, observer; '
              'assert "websockets" not in sys.modules and "pydantic" not in sys.modules')
    subprocess.run([sys.executable, '-I', '-S', '-c', source], check=True, capture_output=True)


def test_phone_cloud_client_reconnect_is_only_metadata(h):
    from websockets.asyncio.server import serve
    from foothold_agent.link.client import Client, Settings as CloudSettings
    a, _ = h.moving()
    lease, generation, seq = h.hub.session.lease_id, h.hub.session.core.stop_gen, h.hub.session.last_seq
    async def run():
        finished = asyncio.Event()
        async def cloud(ws):
            first = json.loads(await ws.recv())
            assert first['t'] == 'hello' and first['lease_id'] is None
            for kind in ('lease', 'cmd', 'unlock', 'run.start'):
                await ws.send(json.dumps({'t': kind, 'lease_id': str(uuid4()), 'holder_type': 'USER',
                                          'seq': 999, 'axes': [1, 0, 1], 'stop_gen': generation}))
            await ws.send(json.dumps({'t': 'ping'}))
            await asyncio.sleep(.1)
            await ws.close(1012, 'test restart')
            finished.set()
        observer = Observer(h.hub)
        with phone_socket() as sock:
            async with serve(cloud, sock=sock):
                client = Client(observer, DiscardSink(), CloudSettings(
                    f'ws://127.0.0.1:{sock.getsockname()[1]}/agent', encode(os.urandom(32))))
                task = asyncio.create_task(client.run())
                try:
                    await asyncio.wait_for(finished.wait(), 2)
                    await asyncio.sleep(.02)
                    assert not task.done()
                    assert (h.hub.session.lease_id, h.hub.session.core.stop_gen, h.hub.session.last_seq) == (lease, generation, seq)
                    assert h.cmd(a)['applied'] == [.6, 0, 0]
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        assert h.hub.owner == a and not h.hub.session.core.latch
    asyncio.run(run())


def test_phone_journal_latency_cannot_extend_ticket_lifetime(h):
    original = h.verifier.db
    class SlowCommit:
        delay = .75
        def __enter__(self):
            original.__enter__()
            return self
        def __exit__(self, *args):
            h.clock.t += self.delay
            return original.__exit__(*args)
        def execute(self, *args):
            return original.execute(*args)
    h.verifier.db = SlowCommit()
    try:
        payload = h.claims(exp=int(h.clock.wall())+1)
        checked = h.verifier.verify(signed(h.key, payload))
        assert checked['deadline'] == 1
        h.clock.t = 1
        h.verifier.db.delay = 2
        with pytest.raises(TicketError):
            h.verifier.verify(signed(h.key, h.claims(exp=int(h.clock.wall())+1)))
    finally:
        h.verifier.db = original


def test_phone_expiry_from_bridge_callback_keeps_4401_on_socket(h):
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed
    async def run():
        with phone_socket() as sock:
            server = Server(h.hub, Settings('127.0.0.1', sock.getsockname()[1], 'unused', 'test', '1',
                                           h.org, 'unused-replay.sqlite', True, True), sock=sock)
            task = asyncio.create_task(server.run())
            await asyncio.wait_for(server.ready.wait(), 2)
            try:
                async with connect(f'ws://127.0.0.1:{sock.getsockname()[1]}/phone/ws', proxy=None) as ws:
                    payload = h.claims(exp=int(h.clock.wall())+1)
                    await ws.send(json.dumps({'t': 'hello', 'id': 'hello', 'robot': h.robot, 'proto': 'fh-phone/1',
                                              'device': payload['device'], 'ticket': signed(h.key, payload)}))
                    assert json.loads(await ws.recv())['t'] == 'hello'
                    h.clock.t = 1
                    h.state(False)  # expiration can be detected outside the WS watchdog
                    closed = None
                    async def read_until_closed():
                        while True:
                            await ws.recv()
                    try:
                        await asyncio.wait_for(read_until_closed(), 2)
                    except ConnectionClosed as exc:
                        closed = exc.rcvd.code
                    assert closed == 4401
            finally:
                server.stopping.set()
                await asyncio.wait_for(task, 2)
    asyncio.run(run())

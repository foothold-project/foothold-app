"""End-to-end loopback phone WS -> real Core/lease -> fake DDS/SportClient.

The fake sensors report independent measurements, never echo RPC return codes.
"""
import asyncio
import builtins
import json
import socket
import time
from types import SimpleNamespace as NS
from uuid import uuid4

import pytest
from apps.contracts.models import PhoneState

from foothold_agent.go2_direct.config import Config
from foothold_agent.go2_direct.runtime import run
from foothold_agent.phone.server import Server
from test_go2_runtime_config import env
from test_go2_feedback import low, sport
from test_phone import signed


class FakeDDS:
    def __init__(self, monkeypatch):
        self.callbacks, self.clients, self.initializations = {}, [], []
        self.velocity = (0., 0., 0.)
        self.enabled = True
        self.serial = (1234, 5678)
        self.tick = 0
        fixture = self
        class Subscriber:
            def __init__(self, topic, _type):
                self.topic = topic
            def Init(self, callback, queue):
                assert queue == 0
                fixture.callbacks[self.topic] = callback
            def Close(self):
                fixture.callbacks.pop(self.topic, None)
        class SportClient:
            def __init__(self):
                self.calls = []
                fixture.clients.append(self)
            def SetTimeout(self, value):
                assert value == .10
            def Init(self):
                pass
            def Move(self, *velocity):
                self.calls.append(('Move', velocity))
                return 0
            def StopMove(self):
                self.calls.append(('StopMove', ()))
                return 0
        modules = {
            'unitree_sdk2py.core.channel': NS(ChannelSubscriber=Subscriber,
                ChannelFactoryInitialize=lambda *args: self.initializations.append(args)),
            'unitree_sdk2py.idl.unitree_go.msg.dds_': NS(LowState_=object, SportModeState_=object),
            'unitree_sdk2py.go2.sport.sport_client': NS(SportClient=SportClient),
        }
        original = builtins.__import__
        def fake_import(name, *args, **kwargs):
            if name.startswith(('unitree', 'cyclonedds', 'rclpy')):
                assert name in modules, 'real SDK/DDS import forbidden'
                return modules[name]
            return original(name, *args, **kwargs)
        monkeypatch.setattr(builtins, '__import__', fake_import)
        monkeypatch.setattr(socket, 'if_nameindex', lambda: [(1, 'fake0')])

    async def emit(self):
        while True:
            if self.enabled:
                self.tick += 1
                if 'rt/lowstate' in self.callbacks:
                    self.callbacks['rt/lowstate'](low(self.tick, sn=self.serial))
                if 'rt/sportmodestate' in self.callbacks:
                    self.callbacks['rt/sportmodestate'](sport(self.tick, velocity=self.velocity))
            await asyncio.sleep(.01)

    def moved(self):
        return any(kind == 'Move' and velocity == (.6, 0., 0.)
                   for client in self.clients for kind, velocity in client.calls)


async def until(predicate, task, timeout=2.):
    deadline = time.monotonic()+timeout
    while not predicate():
        if task.done():
            task.result()
            raise AssertionError('runtime stopped early')
        if time.monotonic() > deadline:
            raise AssertionError('condition did not become true')
        await asyncio.sleep(.01)


def free_port():
    for port in range(9530, 9550):
        with socket.socket() as sock:
            try:
                sock.bind(('127.0.0.1', port))
                return port
            except OSError:
                pass
    raise AssertionError('authorized test port range busy')


@pytest.mark.parametrize('outage', ['disconnect', 'input', 'sensor'])
def test_authenticated_ws_move_stop_feedback_resume_and_outages(env, monkeypatch, outage):
    from websockets.asyncio.client import connect
    env['FOOTHOLD_PHONE_PORT'] = str(free_port())
    env['FOOTHOLD_PHONE_ORIGINS'] = '["https://app.invalid"]'
    config = Config.from_env(env)
    dds = FakeDDS(monkeypatch)
    servers = []
    def server_factory(*args, **kwargs):
        server = Server(*args, **kwargs)
        servers.append(server)
        return server

    async def scenario():
        stop = asyncio.Event()
        emitter = asyncio.create_task(dds.emit())
        task = asyncio.create_task(run(config, env, stop=stop, server_factory=server_factory))
        try:
            await until(lambda: bool(servers) and servers[0].ready.is_set(), task)
            hub = servers[0].hub
            sink = hub.sink.sink
            seq = 0
            async with connect(f'ws://127.0.0.1:{config.phone.port}/phone/ws',
                               origin='https://app.invalid', proxy=None) as ws:
                async def request(kind, **body):
                    ident = str(uuid4())
                    await ws.send(json.dumps(dict(t=kind, id=ident, robot=config.robot, **body)))
                    while True:
                        result = json.loads(await asyncio.wait_for(ws.recv(), 2))
                        if result.get('id') == ident:
                            return result
                claims = dict(iss='fh-control', aud='fh-phone/1', org=config.phone.org,
                    robot=config.robot, sub=str(uuid4()), device=str(uuid4()), purpose='control',
                    iat=int(time.time()), exp=int(time.time())+120, jti=str(uuid4()))
                welcome = await request('hello', proto='fh-phone/1', device=claims['device'],
                                        ticket=signed(b'x'*32, claims))
                assert welcome['simulation'] is False
                assert (await request('lease.take'))['ok']
                display = hub.state(hub.owner)
                PhoneState.model_validate(display)
                assert display['battery']['soc'] == 75 and display['robot_serial'] == '1234-5678'
                assert display['sensor_age_ms'] <= 200
                lease = hub.session.lease_id
                async def unlock():
                    await until(lambda: hub.session.core.st is not None and
                        hub.session.core.st['stop_requested'] and not sink.output_safety()[1], task)
                    result = await request('unlock', lease_id=lease, stop_gen=hub.session.core.stop_gen)
                    assert result['ok']
                    await until(lambda: not hub.session.core.latch and not sink.latched, task)
                async def cmd(vx):
                    nonlocal seq
                    seq += 1
                    return await request('cmd', lease_id=lease, seq=seq, vx=vx, vy=0, wz=0)
                await unlock()
                assert (await cmd(.6))['applied'] == [0., 0., 0.]  # new neutral required
                await cmd(0)
                assert (await cmd(.6))['applied'] == [.6, 0., 0.]
                await until(dds.moved, task)
                # SDK STOP success cannot confirm physically still sensor feedback.
                dds.velocity = (.6, 0., 0.)
                await asyncio.sleep(.04)
                assert (await request('stop'))['ok']
                await until(lambda: any(k == 'StopMove' for k, _ in dds.clients[1].calls), task)
                assert sink.latched and hub.session.core.latch
                assert not (await request('unlock', lease_id=lease,
                            stop_gen=hub.session.core.stop_gen))['ok']
                dds.velocity = (0., 0., 0.)
                await unlock()
                await cmd(0)
                await cmd(.6)
                await until(lambda: sink.pending == (.6, 0., 0.), task)
                if outage == 'disconnect':
                    await ws.close()
                elif outage == 'sensor':
                    dds.enabled = False
                # No more phone commands. Ticks and feedback must NOT feed the
                # original input's independent 0.30 s watchdog.
                await until(lambda: sink.latched and hub.session.core.latch, task, timeout=1.)
                assert sink.pending == (0., 0., 0.)
                assert dds.initializations == [(0, 'fake0')]
                assert len(dds.clients) == 2
                assert any(k == 'StopMove' for k, _ in dds.clients[1].calls)
        finally:
            stop.set()
            await asyncio.wait_for(task, 3)
            emitter.cancel()
            await asyncio.gather(emitter, return_exceptions=True)
            assert not dds.callbacks
    try:
        asyncio.run(scenario())
    finally:
        config.verifier.close()


def test_origin_rejection_has_fixed_reason_without_echoing_address(caplog):
    from websockets.asyncio.client import connect
    from websockets.exceptions import InvalidStatus
    from foothold_agent.phone.server import Settings
    from test_phone import Harness
    h = Harness(simulation=False)
    async def scenario():
        port = free_port()
        settings = Settings('127.0.0.1', port, 'unused', 'go2-flat', '1', h.org,
                            'unused.sqlite', True, False, ('https://app.invalid',))
        server = Server(h.hub, settings)
        task = asyncio.create_task(server.run())
        await asyncio.wait_for(server.ready.wait(), 2)
        try:
            with pytest.raises(InvalidStatus) as rejected:
                async with connect(f'ws://127.0.0.1:{port}/phone/ws',
                                   origin='https://untrusted.invalid', proxy=None):
                    pass
            assert rejected.value.response.status_code == 403
            assert b'PHONE_ORIGIN_NOT_ALLOWED' in rejected.value.response.body
            assert 'PHONE_ORIGIN_NOT_ALLOWED' in caplog.text and 'untrusted.invalid' not in caplog.text
            async with connect(f'ws://127.0.0.1:{port}/phone/ws', origin='https://app.invalid', proxy=None):
                pass
        finally:
            server.stopping.set()
            await asyncio.wait_for(task, 2)
    try:
        asyncio.run(scenario())
    finally:
        h.hub.close()
        h.verifier.close()


def test_occupied_listener_and_disabled_cli_import_no_sdk(env, monkeypatch):
    from foothold_agent.go2_direct.__main__ import main
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        assert not name.startswith(('unitree', 'cyclonedds', 'rclpy'))
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)
    monkeypatch.delenv('FH_GO2_DIRECT_ENABLED', raising=False)
    assert main([]) == 2
    env['FOOTHOLD_PHONE_PORT'] = str(free_port())
    config = Config.from_env(env)
    try:
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', config.phone.port))
            with pytest.raises(OSError):
                asyncio.run(run(config, env))
    finally:
        config.verifier.close()

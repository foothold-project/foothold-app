"""Server trial uses fake SDK only; no DDS import or robot network."""
import asyncio
import json
import builtins

import pytest

from foothold_agent.go2_direct.server import DriveSession, ServerSink
from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.sink import Go2Sink
from foothold_agent.go2_direct.config import Config
from foothold_agent.link.client import Client, Settings
from test_go2_direct import Clock, FakeSport, command
from test_go2_feedback import low, sport
from test_go2_runtime_config import env


def rig():
    now, normal, emergency = Clock(), FakeSport(), FakeSport()
    sink = Go2Sink(normal, emergency, now=now, offline_test_mode=True, phone_watchdog=True)
    feedback = Feedback('1234-5678', now=now)
    feedback.sink = sink
    session = DriveSession(feedback, now=now)
    client = Client(session, ServerSink(sink, session), Settings('ws://127.0.0.1/ws', 'fake-token'))
    client._emit(session.connect())
    sink.drain()
    count = 0
    def measured():
        nonlocal count
        count += 1
        feedback.lowstate(low(count))
        feedback.sportmodestate(sport(count))
        assert feedback.consume(client)
    def frame(t, **kw):
        client._emit(session.receive({'t': t, **kw}))
    measured()
    frame('lease', lease_id='fake-lease', holder_type='USER')
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    measured()  # fresh physical resume feedback; SDK success is not evidence
    frame('cmd', lease_id='fake-lease', seq=0, axes=[0, 0, 0])
    sink.drain()
    return now, sink, normal, emergency, session, client, measured, frame


@pytest.mark.parametrize('axes,expected', [([1,0,0],(.6,0,0)), ([1,0,1],(.6,0,.5)),
                                          ([1,0,-1],(.6,0,-.5)), ([0,0,0],(0,0,0))])
def test_existing_server_command_to_sdk_alphabet(axes, expected):
    now, sink, normal, _, session, client, measured, frame = rig()
    frame('cmd', lease_id='fake-lease', seq=1, axes=axes)
    sink.drain()
    assert not sink.latched and normal.calls[-1] == ('Move', expected)
    state = session._state()
    assert state['battery']['soc'] == 75 and state['speed'] == 0


def test_ticks_cannot_refresh_point_three_second_input_deadline():
    now, sink, normal, emergency, session, client, measured, frame = rig()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[1,0,0])
    for _ in range(6):
        now.value += .05
        client._emit(session.tick())
        sink.drain()
    now.value += .001
    assert sink.check_watchdog()
    assert sink.latched and sink.pending == (0,0,0)
    assert emergency.calls[-2:] == [('Move',(0,0,0)), ('StopMove',())]
    frame('cmd', lease_id='fake-lease', seq=2, axes=[1,0,0])
    sink.drain()
    assert sink.latched and normal.calls[-2:] == [('Move',(0,0,0)), ('StopMove',())]


@pytest.mark.parametrize('reason', ['disconnect', 'transport_closed', 'stop', 'lease'])
def test_socket_stop_and_lease_loss_lock_before_next_input(reason):
    now, sink, normal, emergency, session, client, measured, frame = rig()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[1,0,0])
    sink.drain()
    if reason == 'disconnect':
        client._emit(session.disconnect())
    elif reason == 'transport_closed':
        client._emit(session.transport_closed(1006, retry=True))
    elif reason == 'stop':
        frame('stop', stop_ref=42)
        assert session._state()['stop_ref'] == 0  # no recycled STOP measurement
    else:
        frame('lease', lease_id=None, holder_type=None)
    assert sink.latched and sink.pending == (0,0,0)
    assert sink.check_watchdog()
    assert emergency.calls[-1] == ('StopMove',())
    frame('cmd', lease_id='fake-lease', seq=2, axes=[1,0,0])
    assert sink.pending == (0,0,0)


def test_stop_confirmation_requires_new_measurement_then_explicit_unlock_and_new_neutral():
    now, sink, normal, emergency, session, client, measured, frame = rig()
    frame('stop', stop_ref=42)
    assert session._state()['stop_ref'] == 0
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    assert sink.latched
    measured()
    assert session._state()['stop_ref'] == 42
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    measured()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[1,0,0])
    assert sink.pending == (0,0,0)
    frame('cmd', lease_id='fake-lease', seq=2, axes=[0,0,0])
    frame('cmd', lease_id='fake-lease', seq=3, axes=[1,0,0])
    sink.drain()
    sink.drain()  # the first drain services the queued STOP before any motion
    assert normal.calls[-1] == ('Move',(.6,0,0))


def test_two_sources_and_run_cannot_drive_server_mode():
    _, sink, _, _, session, client, measured, frame = rig()
    with pytest.raises(ValueError):
        sink.apply(command(velocity=(.6,0,0)), source='phone')
    assert sink.latched
    frame('lease', lease_id='run', holder_type='RUN:fake')
    assert not session.connected and not session.lease_confirmed


def test_explicit_server_configuration_has_no_phone_listener(env, monkeypatch):
    for key in list(env):
        if key.startswith('FOOTHOLD_PHONE_'):
            del env[key]
    env.update(FOOTHOLD_AGENT_WS_URL='wss://server.invalid/api/v1/agent/ws', FOOTHOLD_AGENT_TOKEN='fake-token')
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        assert not name.startswith(('unitree', 'cyclonedds'))
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)
    config = Config.from_env(env, server=True)
    assert config.server and config.phone is None and config.verifier is None and config.link
    with pytest.raises(ValueError):
        Config.from_env({**env, 'FH_GO2_DEDICATED_NIC':'0'}, server=True)
    with pytest.raises(ValueError):
        Config.from_env({**env, 'FOOTHOLD_AGENT_TOKEN':''}, server=True)


def test_real_loopback_ws_fake_sdk_disconnect_stops_and_locks(monkeypatch):
    from types import SimpleNamespace as NS
    import time
    from websockets.asyncio.server import serve
    from foothold_agent.go2_direct.server import run
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        assert not name.startswith(('unitree_sdk2py', 'cyclonedds'))
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)

    async def scenario():
        normal, emergency = FakeSport(), FakeSport()
        stop = asyncio.Event()
        captured = {}
        class Channel:
            closed = False
            handle = None
            counter = 0
            def subscribe(self, feedback):
                def sample():
                    self.counter += 1
                    feedback.lowstate(low(self.counter))
                    feedback.sportmodestate(sport(self.counter))
                    self.handle = asyncio.get_running_loop().call_later(.02, sample)
                sample()
            def close(self):
                self.closed = True
                self.handle.cancel()
        channel = Channel()
        def client_factory(session, sink, settings):
            client = Client(session, sink, settings)
            captured['client'] = client
            return client
        async def read(ws, predicate):
            async with asyncio.timeout(2):
                while True:
                    msg = json.loads(await ws.recv())
                    if predicate(msg):
                        return msg
        async def server(ws):
            assert (await read(ws, lambda x:x['t']=='hello'))['proto'] == 'fh-agent/2'
            await ws.send(json.dumps(dict(t='stop', stop_ref=42)))
            measured_state = await read(ws, lambda x:x['t']=='state' and x['stop_ref']==42)
            await ws.send(json.dumps(dict(t='lease', lease_id='fake-lease', holder_type='USER')))
            await ws.send(json.dumps(dict(t='unlock', lease_id='fake-lease', stop_gen=measured_state['stop_gen'])))
            await read(ws, lambda x:x['t']=='state' and x['latched'] is False)
            await ws.send(json.dumps(dict(t='cmd', lease_id='fake-lease', seq=0, axes=[0,0,0])))
            for seq in range(1, 8):
                await ws.send(json.dumps(dict(t='cmd', lease_id='fake-lease', seq=seq, axes=[1,0,1])))
                await asyncio.sleep(.06)
                if ('Move',(.6,0,.5)) in normal.calls:
                    break
            assert ('Move',(.6,0,.5)) in normal.calls
            stop_count = len(emergency.calls)
            await ws.close()
            async with asyncio.timeout(.25):
                while not captured['client'].sink.sink.latched:
                    await asyncio.sleep(.001)
            assert captured['client'].session.core.latch
            async with asyncio.timeout(.25):
                while len(emergency.calls) < stop_count+2 or emergency.calls[-1] != ('StopMove',()):
                    await asyncio.sleep(.001)
            stop.set()
        async with serve(server, '127.0.0.1', 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            config = NS(approval=NS(robot_serial='1234-5678', expires_at=time.time()+60),
                        link=Settings(f'ws://127.0.0.1:{port}/agent', 'fake-token'))
            await asyncio.wait_for(run(config, {}, stop=stop, channel_factory=lambda env:channel,
                connect_factory=lambda *a,**kw:(normal, emergency), client_factory=client_factory), 5)
        assert channel.closed
        assert normal.calls[-2:] == [('Move',(0,0,0)), ('StopMove',())]
    asyncio.run(scenario())


def test_feedback_loss_reports_lock_and_requires_explicit_recovery():
    now, sink, normal, emergency, session, client, measured, frame = rig()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[1,0,0])
    client._emit(session.feedback_lost())
    assert session.connected and sink.latched and session._state()['latched']
    measured()
    frame('cmd', lease_id='fake-lease', seq=2, axes=[1,0,0])
    assert sink.latched and sink.pending == (0,0,0)
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    measured()
    frame('cmd', lease_id='fake-lease', seq=3, axes=[1,0,0])
    assert sink.pending == (0,0,0)
    frame('cmd', lease_id='fake-lease', seq=4, axes=[0,0,0])
    frame('cmd', lease_id='fake-lease', seq=5, axes=[1,0,0])
    sink.drain()
    sink.drain()
    assert normal.calls[-1] == ('Move',(.6,0,0))

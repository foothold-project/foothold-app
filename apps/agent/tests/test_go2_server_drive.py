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
    sink.check_watchdog()  # live emergency worker services startup STOP before unlock
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


@pytest.mark.parametrize('axes,expected', [(list(value), value) for value in (
    (0.,0.,0.), (.4,0.,0.), (-.2,0.,0.), (0.,.2,0.), (0.,-.2,0.),
    (0.,0.,.5), (0.,0.,-.5), (.4,0.,.5), (.4,0.,-.5))])
def test_existing_server_command_to_sdk_alphabet(axes, expected):
    now, sink, normal, _, session, client, measured, frame = rig()
    frame('cmd', lease_id='fake-lease', seq=1, axes=axes)
    sink.drain()
    assert not sink.latched and normal.calls[-1] == ('Move', expected)
    state = session._state()
    assert state['battery']['soc'] == 75 and state['speed'] == 0


def test_ticks_cannot_refresh_point_three_second_input_deadline():
    now, sink, normal, emergency, session, client, measured, frame = rig()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[.4,0,0])
    for _ in range(6):
        now.value += .05
        client._emit(session.tick())
        sink.drain()
    now.value += .001
    assert sink.check_watchdog()
    assert sink.latched and sink.pending == (0,0,0)
    assert emergency.calls[-2:] == [('Move',(0,0,0)), ('StopMove',())]
    frame('cmd', lease_id='fake-lease', seq=2, axes=[.4,0,0])
    sink.drain()
    assert sink.latched and normal.calls[-2:] == [('Move',(0,0,0)), ('StopMove',())]


@pytest.mark.parametrize('reason', ['disconnect', 'transport_closed', 'stop', 'lease'])
def test_socket_stop_and_lease_loss_lock_before_next_input(reason):
    now, sink, normal, emergency, session, client, measured, frame = rig()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[.4,0,0])
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
    frame('cmd', lease_id='fake-lease', seq=2, axes=[.4,0,0])
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
    frame('cmd', lease_id='fake-lease', seq=1, axes=[.4,0,0])
    assert sink.pending == (0,0,0)
    frame('cmd', lease_id='fake-lease', seq=2, axes=[0,0,0])
    frame('cmd', lease_id='fake-lease', seq=3, axes=[.4,0,0])
    sink.drain()
    sink.drain()  # the first drain services the queued STOP before any motion
    assert normal.calls[-1] == ('Move',(.4,0,0))


def test_two_sources_and_run_cannot_drive_server_mode():
    _, sink, _, _, session, client, measured, frame = rig()
    with pytest.raises(ValueError):
        sink.apply(command(velocity=(.4,0,0)), source='phone')
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


@pytest.mark.parametrize('fallback,sport_state', [(False,0),(True,0),(True,100)])
def test_real_loopback_ws_fake_sdk_disconnect_stops_and_locks(monkeypatch, fallback, sport_state, caplog):
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
        identity_checks = []
        def identity_check(approval, serial):
            assert serial == '0-0'
            identity_checks.append(serial)
            return True
        class Channel:
            closed = False
            handle = None
            counter = 0
            def subscribe(self, feedback):
                def sample():
                    self.counter += 1
                    feedback.lowstate(low(self.counter, sn=(0,0) if fallback else (1234,5678)))
                    feedback.sportmodestate(sport(self.counter, error_code=sport_state))
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
                await ws.send(json.dumps(dict(t='cmd', lease_id='fake-lease', seq=seq, axes=[.4,0,.5])))
                await asyncio.sleep(.06)
                if ('Move',(.4,0,.5)) in normal.calls:
                    break
            assert ('Move',(.4,0,.5)) in normal.calls
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
            config = NS(approval=NS(robot_serial=None if fallback else '1234-5678',
                        serial_unavailable=fallback, robot_mac='02:00:00:00:00:01',
                        accept_error_codes=frozenset({100}) if sport_state else frozenset(), expires_at=time.time()+60),
                        link=Settings(f'ws://127.0.0.1:{port}/agent', 'fake-token'))
            await asyncio.wait_for(run(config, {}, stop=stop, channel_factory=lambda env:channel,
                connect_factory=lambda *a,**kw:(normal, emergency), client_factory=client_factory,
                identity_check=identity_check), 5)
        assert channel.closed
        if sport_state:
            assert '100(Agile)' in caplog.text
        if fallback:
            assert len(identity_checks) >= 2  # startup plus explicit resume, never a cached grant
        assert normal.calls[-2:] == [('Move',(0,0,0)), ('StopMove',())]
    asyncio.run(scenario())


def test_feedback_loss_reports_lock_and_requires_explicit_recovery():
    now, sink, normal, emergency, session, client, measured, frame = rig()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[.4,0,0])
    client._emit(session.feedback_lost())
    assert session.connected and sink.latched and session._state()['latched']
    measured()
    frame('cmd', lease_id='fake-lease', seq=2, axes=[.4,0,0])
    assert sink.latched and sink.pending == (0,0,0)
    frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
    measured()
    frame('cmd', lease_id='fake-lease', seq=3, axes=[.4,0,0])
    assert sink.pending == (0,0,0)
    frame('cmd', lease_id='fake-lease', seq=4, axes=[0,0,0])
    frame('cmd', lease_id='fake-lease', seq=5, axes=[.4,0,0])
    sink.drain()
    sink.drain()
    assert normal.calls[-1] == ('Move',(.4,0,0))


def test_new_si_table_is_exact_and_does_not_change_phone_table():
    from foothold_agent.go2_direct.sink import ALLOWED, SERVER_ALLOWED
    from apps.contracts.server_drive import ALLOWED as CONTRACT
    assert SERVER_ALLOWED == CONTRACT and len(SERVER_ALLOWED) == 9
    assert ALLOWED == frozenset(((0.,0.,0.),(.6,0.,0.),(.6,0.,.5),(.6,0.,-.5)))


@pytest.mark.parametrize('bad', [[1,0,0],[.6,0,0],[.4000000001,0,0],[-.2,0,.5],
    [.4,.2,0],[0,0,1],[True,0,0],[float('nan'),0,0]])
def test_outside_exact_server_table_stops_without_quantization(bad):
    _, sink, normal, emergency, session, client, measured, frame = rig()
    frame('cmd', lease_id='fake-lease', seq=1, axes=[.4,0,0])
    frame('cmd', lease_id='fake-lease', seq=2, axes=bad)
    assert sink.latched and session.core.latch and sink.pending == (0,0,0)
    assert sink.check_watchdog() and emergency.calls[-1] == ('StopMove',())


def test_twenty_hz_new_neutral_is_real_input_and_does_not_trip_deadline():
    now, sink, normal, emergency, session, client, measured, frame = rig()
    for seq in range(1,31):
        now.value += .05
        measured()
        frame('cmd', lease_id='fake-lease', seq=seq, axes=[0,0,0])
        sink.drain()
        assert not sink.check_watchdog()
        assert not sink.latched
    assert normal.calls[-1] == ('Move',(0,0,0))


def test_readonly_server_mode_never_constructs_motion_adapter(monkeypatch):
    from foothold_agent.go2_direct.readonly import Config as ReadConfig, run as read_run
    import foothold_agent.go2_direct.server as motion
    def forbidden(*args,**kwargs):
        raise AssertionError('motion output construction forbidden')
    monkeypatch.setattr(motion, 'Go2Sink', forbidden)
    async def scenario():
        from types import SimpleNamespace as NS
        stop=asyncio.Event()
        observed={}
        class Subscribers:
            def __init__(self,state,nic): self.state=state
            def start(self):
                self.state.lowstate(low())
                self.state.sportmodestate(sport(velocity=(.01,0,0)))
            def close(self): observed['closed']=True
        class ObserverClient:
            def __init__(self,session,sink,settings): self.session=session
            async def run(self):
                self.session.connect()
                for frame in ({'t':'lease','lease_id':'bad','holder_type':'USER'},
                    {'t':'cmd','lease_id':'bad','seq':1,'axes':[.4,0,0]},
                    {'t':'unlock','lease_id':'bad','stop_gen':2},{'t':'stop','stop_ref':42}):
                    self.session.receive(frame)
                value=self.session._state()
                assert value['stop_ref']==0 and value['latched'] and value['applied']==[0,0,0]
                assert value['battery']['soc']==75 and value['speed']==.01
                assert self.session.lease_id is None
                stop.set()
        config=ReadConfig('fake-robot','fake0',Settings('ws://127.0.0.1/ws','fake-token'))
        await read_run(config,stop=stop,subscriptions_factory=Subscribers,client_factory=ObserverClient)
        assert observed['closed']
    asyncio.run(scenario())

"""Approval initialization with fake SDK, DDS callbacks and server frames only."""
import asyncio
import builtins
from dataclasses import replace
import socket
import threading
import time
from types import SimpleNamespace as NS

import pytest

from foothold_agent.go2_direct.sdk import connect_approved
from foothold_agent.go2_readonly.sdk import Subscriptions
from foothold_agent.link.client import Client
from foothold_agent.setup.identity import MacIdentity
from foothold_agent.setup.runtime import Inputs, run
from foothold_agent.setup.view import Status
from test_setup_pairing import credentials, NIC_VALUE, OfflineSink, FakeSport, low, sport

MAC = '02:00:00:00:00:11'


async def until(predicate, task):
    async with asyncio.timeout(3):
        while not predicate():
            if task.done():
                task.result()
                pytest.fail('runtime ended before expected state')
            await asyncio.sleep(.005)


@pytest.mark.parametrize('zero', [False, True])
def test_slow_sdk_initialization_keeps_connection_identity_and_approval(zero, monkeypatch):
    exercise_initialization(monkeypatch, zero=zero)


def test_slow_initialization_does_not_prematurely_close_new_output(monkeypatch):
    # On the old loop, MAC expiry immediately closed the freshly created sink;
    # a failing SDK STOP during that close escaped run() as OutputError.
    exercise_initialization(monkeypatch, zero=True, stop_result=-1)


@pytest.mark.parametrize('change', ['mac', 'serial', 'nic', 'disconnect', 'revoke', 'expiry'])
def test_invalidated_initialization_never_installs_output(change, monkeypatch):
    exercise_initialization(monkeypatch, zero=True, change=change)


def exercise_initialization(monkeypatch, *, zero, change=None, stop_result=0):
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    if not zero:
        release.set()  # normal serial keeps its established synchronous factory
    made, outputs, queries, media = [], [], [], []
    current, nic_ok = [MAC], [True]
    sequence, sn = [0], [(0, 0) if zero else (1234, 5678)]
    inputs = Inputs()

    class Sport(FakeSport):
        def __init__(self):
            super().__init__()
            self.result = stop_result
            made.append(self)
        def SetTimeout(self, timeout):
            assert timeout == .1
        def Init(self):
            entered.set()
            release.wait(2)  # bounded fake Init; no SDK worker can hang the suite

    original_import = builtins.__import__
    def fake_import(name, *args, **kwargs):
        if name == 'unitree_sdk2py.go2.sport.sport_client':
            return NS(SportClient=Sport)
        assert not name.startswith(('unitree_sdk2py', 'cyclonedds')), 'real DDS/SDK forbidden'
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', fake_import)
    monkeypatch.setattr(socket, 'if_nameindex', lambda: [(7, NIC_VALUE.name)])

    async def scenario():
        status, stop, seen = Status(), asyncio.Event(), {}
        def pulse():
            sequence[0] += 1
            inputs.lowstate(low(sequence[0], sn=sn[0]))
            inputs.sportmodestate(sport(sequence[0]))
            seen['pulse'] = asyncio.get_running_loop().call_later(.01, pulse)
        pulse()
        creds = credentials()
        if zero:
            def query(_nic):
                queries.append(True)
                return current[0], ['192.168.123.161']
            inputs.mac_identity = MacIdentity(NIC_VALUE.name, MAC, inputs, query=query)
            creds = replace(creds, robot_serial=inputs.mac_identity.serial,
                            identity_source='mac', robot_mac=MAC)
        class FakeClient(Client):
            # Use the real Client.run + watchdog; replace only socket transport.
            async def _network(self):
                seen['client'] = self
                self._emit(self.session.connect())
                seen['pings'] = 0
                while not stop.is_set():
                    seen['pings'] += 1
                    self._emit(self.session.receive(dict(t='ping', seq=seen['pings'])))
                    await asyncio.sleep(.02)
        def sdk(*args):
            pair = connect_approved(*args)
            finished.set()
            return pair
        def sink_factory(*args, **kwargs):
            sink = OfflineSink(*args, **kwargs)
            outputs.append(sink)
            return sink
        def media_factory(_credentials, approval, subscriptions, recorder, enabled):
            assert enabled() and approval.robot_serial == creds.robot_serial
            item = NS(closed=False, enabled=enabled)
            media.append(item)
            class Publisher:
                source = NS(close=lambda: setattr(item, 'closed', True))
                async def run(self):
                    await stop.wait()
            return Publisher()
        subscriptions = Subscriptions(inputs, NIC_VALUE.name)
        subscriptions._started = True  # already-running fake DDS; never .start()
        recorder = NS(notice='', stopped=threading.Event(), start=lambda: None, close=lambda: None)
        task = asyncio.create_task(run(creds, NIC_VALUE, inputs, subscriptions, ready=True,
            check_nic=lambda: nic_ok[0], status=status, stop=stop, client_factory=FakeClient,
            connect=sdk, sink_factory=sink_factory, media_factory=media_factory,
            recorder_factory=lambda *args, **kwargs: recorder))
        try:
            await until(lambda: 'client' in seen and inputs.feedback.sample() is not None, task)
            client = seen['client']
            client._emit(client.session.receive(dict(t='field_approval', expires_at=time.time()+60)))
            await until(entered.is_set, task)
            before_pings, before_queries = seen['pings'], len(queries)
            # Longer than the unchanged MAC/feedback freshness limit.
            await asyncio.sleep(.25)
            assert client.session.connected and not task.done()
            assert seen['pings'] > before_pings
            if zero:
                assert not outputs
                assert inputs.mac_identity.valid() and len(queries) > before_queries
            if change == 'mac': current[0] = '02:00:00:00:00:12'
            elif change == 'serial': sn[0] = (9, 9)
            elif change == 'nic': nic_ok[0] = False
            elif change == 'disconnect': client._emit(client.session.disconnect())
            elif change == 'revoke': client.sink.revoke()
            elif change == 'expiry': client.sink.deadline = float('-inf')
            if change:
                await asyncio.sleep(.15)
            release.set()
            await until(finished.is_set, task)
            if change:
                await asyncio.sleep(.1)
                assert not outputs and not media and client.sink.active is None
                assert client.session.core.latch and client.session.lease_id is None
                if change in ('mac', 'serial'): assert inputs.mac_identity.fault
                assert all(not sport_client.calls for sport_client in made)
            else:
                await until(lambda: bool(media), task)
                await asyncio.sleep(.25)
                assert client.sink.active is not None and client.session.connected and not task.done()
                assert status.snapshot()['connected'] and status.snapshot()['field_approval_expires_at']
                assert outputs[0].latched and client.session.core.latch
                assert client.session.lease_id is None
                assert inputs.feedback.serial == ('0-0' if zero else creds.robot_serial)
        finally:
            # Explicit shutdown still exercises the unchanged successful STOP.
            for sport_client in made:
                sport_client.result = 0
            release.set()
            stop.set()
            seen['pulse'].cancel()
            await asyncio.wait_for(task, 3)
        assert all(item.closed and not item.enabled() for item in media)
        assert all(args == (0, 0, 0) for obj in made for method, args in obj.calls if method == 'Move')
    asyncio.run(scenario())


@pytest.mark.parametrize('error_type,message,reason', [
    (PermissionError, None, 'connection_failed'),
    (RuntimeError, None, 'connection_failed'),
    (AttributeError, None, 'connection_failed'),
    (ImportError, None, 'connection_failed'),
    (type('untrusted_private_type', (Exception,), {}), None, 'connection_failed'),
    (RuntimeError, 'motion output failed', 'motion_output_failed'),
    (RuntimeError, 'emergency SDK output failed', 'emergency_sdk_output_failed'),
])
def test_serve_diagnostic_is_one_fixed_line_without_exception_values(error_type, message, reason, monkeypatch, capsys):
    from foothold_agent.setup import __main__ as setup
    private = '192.0.2.123 02:00:00:00:00:99 fake-private-token 7654-3210'
    async def fail(*_args):
        try:
            raise ValueError(private)
        except ValueError as cause:
            raise error_type(message or private) from cause
    monkeypatch.setattr(setup, 'connect', fail)
    monkeypatch.setattr(setup, 'install_stop_handlers', lambda _: lambda: None)
    async def scenario():
        stop = asyncio.Event()
        stop.set()
        status = Status()
        assert not await setup.serve(NS(), status, stop=stop)
        assert not status.snapshot()['connected']
        assert private not in str(status.snapshot())
    asyncio.run(scenario())
    output = capsys.readouterr().err
    name = 'Exception' if error_type.__name__ == 'untrusted_private_type' else error_type.__name__
    assert output.splitlines()[0] == f'SETUP_FAILURE type={name} reason={reason}'
    assert len(output.splitlines()) == 2
    for value in private.split() + ['Traceback', 'untrusted_private_type']:
        assert value not in output

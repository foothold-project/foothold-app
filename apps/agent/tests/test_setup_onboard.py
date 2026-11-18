"""Mounted-computer identity and failure lifetime using fake inputs only."""
import asyncio
from dataclasses import replace
import threading
from types import SimpleNamespace as NS
from urllib.request import urlopen

import pytest

from foothold_agent.setup import __main__ as setup
from foothold_agent.setup.identity import confirm_zero_identity, mounted_binding, computer_identity, IdentityUnavailable
from foothold_agent.setup.storage import load, save, mac_serial
from foothold_agent.setup.runtime import Inputs
from foothold_agent.setup.view import Status, make_server
from foothold_agent.link.client import ReconnectForbidden
from test_setup_pairing import NIC_VALUE, credentials
from test_setup_zero_identity import MAC, until
from test_go2_feedback import low

COMPUTER = 'a'*64


def saved():
    binding = mounted_binding(NIC_VALUE, MAC, computer=lambda:COMPUTER)
    return replace(credentials(), robot_serial=mac_serial(MAC), robot_mac=MAC,
                   identity_source='mac', mounted_binding=binding)


@pytest.mark.parametrize('change', ['none', 'nic-name', 'nic-mac', 'robot-mac', 'computer', 'missing', 'laptop', 'computer-unavailable'])
def test_only_matching_mounted_binding_skips_human_confirmation(change):
    async def scenario():
        inputs = Inputs(); inputs.lowstate(low(1, sn=(0, 0)))
        nic, mac, creds, computer = NIC_VALUE, MAC, saved(), lambda:COMPUTER
        if change == 'nic-name': nic = replace(nic, name='other0')
        if change == 'nic-mac': nic = replace(nic, mac='02:00:00:00:00:22')
        if change == 'robot-mac': mac = '02:00:00:00:00:33'
        if change == 'computer': computer = lambda:'b'*64
        if change == 'missing': creds = replace(creds, mounted_binding=None)
        if change == 'computer-unavailable':
            def computer(): raise OSError('synthetic missing identity')
        status, stop = Status(), asyncio.Event()
        # Keep DDS evidence fresh while waiting for the operator.
        def pulse():
            inputs.lowstate(low(1, sn=(0, 0)))
            handles.append(asyncio.get_running_loop().call_later(.01, pulse))
        handles = []; pulse()
        task = asyncio.create_task(confirm_zero_identity(inputs, nic, status, stop, creds,
            query=lambda _:(mac, []), onboard=change != 'laptop', computer=computer))
        try:
            if change == 'none':
                identity = await asyncio.wait_for(task, 1)
                assert not status.snapshot().get('identity_confirmation')
            else:
                await until(lambda:status.snapshot().get('identity_confirmation'))
                assert inputs.mac_identity is None and not task.done()
                shown = status.snapshot()['identity_confirmation']
                status.confirm_identity(shown['request'], True)
                identity = await asyncio.wait_for(task, 1)
            assert identity is inputs.mac_identity
            if change in ('laptop', 'computer-unavailable'): assert identity.binding is None
        finally:
            stop.set()
            for handle in handles: handle.cancel()
            if not task.done(): task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())


def test_binding_is_private_backward_compatible_and_never_projected(tmp_path):
    path = tmp_path/'private/agent.json'
    value = saved(); save(value, path)
    assert load(path) == value and path.stat().st_mode & 0o777 == 0o600
    save(credentials(), path)
    assert load(path).mounted_binding is None
    assert 'mounted_binding' not in path.read_text()
    with pytest.raises(ValueError): replace(value, mounted_binding={**value.mounted_binding, 'computer':'raw-machine-id'})
    status = Status(onboard=True)
    assert COMPUTER not in str(status.snapshot())
    source = tmp_path/'machine-id'; source.write_text('1'*32+'\n')
    assert len(computer_identity(source)) == 64
    source.write_text('0'*32)
    with pytest.raises(PermissionError): computer_identity(source)


@pytest.mark.parametrize('error,code', [(RuntimeError('private-fake-token'), 'connection_failed'),
    (IdentityUnavailable('synthetic identity error'), 'identity_unavailable'),
    (ReconnectForbidden(4403), 'reconnect_forbidden')])
def test_headless_failure_returns_after_cleanup_without_waiting(monkeypatch, capsys, error, code):
    closed = []
    async def fail(*_):
        try: raise error
        finally: closed.append('stop-lock-sockets')
    monkeypatch.setattr(setup, 'connect', fail)
    monkeypatch.setattr(setup, 'install_stop_handlers', lambda _:lambda:closed.append('restore'))
    async def scenario():
        assert await asyncio.wait_for(setup.serve(NS(no_browser=True, headless=True, onboard=True), Status(onboard=True)), .5) is False
    asyncio.run(scenario())
    assert closed == ['stop-lock-sockets', 'restore']
    output = capsys.readouterr().err
    assert code in output and 'private-fake-token' not in output and 'Ctrl+C' not in output and '노트북' not in output


@pytest.mark.parametrize('no_browser', [False, True])
def test_gui_failure_keeps_status_alive_until_stop(monkeypatch, no_browser):
    async def fail(*_): raise RuntimeError('fake')
    monkeypatch.setattr(setup, 'connect', fail)
    monkeypatch.setattr(setup, 'install_stop_handlers', lambda _:lambda:None)
    async def scenario():
        stop = asyncio.Event()
        task = asyncio.create_task(setup.serve(NS(no_browser=no_browser), Status(), stop=stop))
        await asyncio.sleep(.03)
        assert not task.done()
        stop.set(); assert await task is False
    asyncio.run(scenario())


def test_headless_main_exit_code_closes_status_listener(monkeypatch):
    closed = []
    async def fail(*_): raise RuntimeError('fake')
    monkeypatch.setattr(setup, 'connect', fail)
    monkeypatch.setattr(setup, 'install_stop_handlers', lambda _:lambda:None)
    monkeypatch.setattr(setup, 'make_server', lambda *_:NS(server_port=9570, serve_forever=lambda:None,
        shutdown=lambda:closed.append('shutdown'), server_close=lambda:closed.append('close')))
    assert setup.main(['--headless', '--onboard', '--config', '/fake/private/agent.json']) == 2
    assert closed == ['shutdown', 'close']


def test_onboard_page_has_robot_computer_wording_and_hidden_controls():
    status = Status(onboard=True); server = make_server(status, 0)
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    try:
        page = urlopen(f'http://127.0.0.1:{server.server_port}', timeout=2).read().decode()
        assert '로봇 컴퓨터 화면의 코드' in page and '노트북' not in page
        assert '<p hidden><label><input id="autostart"' in page
        assert '<details hidden><summary>직접 설정하는 법' in page
    finally:
        server.shutdown(); server.server_close(); worker.join()


def test_first_registration_remembers_binding_next_boot_skips_confirmation_and_failure_closes(tmp_path, monkeypatch):
    from foothold_agent.setup import identity as identity_module
    monkeypatch.setattr('foothold_agent.go2_direct.identity.neighbors', lambda _: [
        dict(dst='192.168.123.161', dev=NIC_VALUE.name, lladdr=MAC, state=['STALE'])])
    monkeypatch.setattr(identity_module, 'computer_identity', lambda:COMPUTER)
    calls = []
    class Subscriptions:
        def __init__(self, inputs, nic): self.inputs = inputs
        def start(self):
            def pulse():
                self.inputs.lowstate(low(1, sn=(0, 0)))
                self.handle = asyncio.get_running_loop().call_later(.01, pulse)
            pulse()
        def close(self): self.handle.cancel(); calls.append('subscriptions-closed')
    class Pairing:
        code = '123456'
        import time
        expires_at = time.time()+590
        def __init__(self, server): calls.append('pairing')
        def start(self, serial): pass
        def poll(self, serial): return replace(credentials(), robot_serial=serial)
        def clear(self): calls.append('pairing-cleared')
    async def runtime(*args, **kwargs): calls.append('runtime')
    args = NS(config=tmp_path/'private/agent.json', server='http://127.0.0.1', nic=None,
              wheel_dir='fake', repair=False, onboard=True, no_browser=True, headless=True)
    async def scenario():
        async def connect(status, run=runtime):
            return await setup.connect(args, status, asyncio.Event(), discover=lambda:[NIC_VALUE],
                subscriptions_factory=Subscriptions, preflight=lambda _:dict(installation_ready=True, issues=[]),
                pairing_factory=Pairing, runtime=run,
                depth_factory=lambda **_:NS(start=lambda:None, close=lambda:calls.append('depth-closed'), bind=lambda _:None))
        status = Status(onboard=True)
        task = asyncio.create_task(connect(status))
        await until(lambda:status.snapshot().get('identity_confirmation'))
        shown = status.snapshot()['identity_confirmation']
        assert not args.config.exists() and 'pairing' not in calls
        status.confirm_identity(shown['request'], True)
        await asyncio.wait_for(task, 2)
        assert load(args.config).mounted_binding == saved().mounted_binding
        assert calls.count('pairing') == 1
        # New process inputs and status, same saved evidence: no operator click.
        status = Status(onboard=True)
        await asyncio.wait_for(connect(status), 2)
        assert not status.snapshot().get('identity_confirmation')
        assert calls.count('pairing') == 1 and calls.count('runtime') == 2
        # The existing connect finally closes read-only and media resources even
        # when activation/runtime fails; serve then returns in headless mode.
        async def fail(*args, **kwargs): raise RuntimeError('fake activation failure')
        real_connect = setup.connect
        async def delegated(*_):
            monkeypatch.setattr(setup, 'connect', real_connect)
            return await connect(Status(onboard=True), fail)
        monkeypatch.setattr(setup, 'connect', delegated)
        monkeypatch.setattr(setup, 'install_stop_handlers', lambda _:lambda:None)
        assert await asyncio.wait_for(setup.serve(args, Status(onboard=True)), 2) is False
        assert calls.count('subscriptions-closed') == calls.count('depth-closed') == 3
    asyncio.run(scenario())

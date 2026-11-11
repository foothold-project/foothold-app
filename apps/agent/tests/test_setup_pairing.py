"""Pairing is exercised with fake SDK and loopback-only HTTP/WS, never real DDS."""
import asyncio
import builtins
from dataclasses import replace
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import stat
import sys
import threading
import time
from types import SimpleNamespace as NS
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from foothold_agent.setup.discovery import NIC, candidates, select
from foothold_agent.setup.storage import Credentials, load, save
from foothold_agent.setup.pairing import Pairing, timestamp, origin
from foothold_agent.setup.runtime import Gate, GatedSession, Inputs, run
from foothold_agent.setup.view import Status, make_server, qr_svg
from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.sink import Go2Sink
from foothold_agent.link.client import Client, Settings
from foothold_agent.link.session import MotionCommand
from test_go2_feedback import low, sport
from test_go2_direct import FakeSport, Clock

RID = '00000000-0000-4000-8000-000000000001'
PID = '00000000-0000-4000-8000-000000000002'
SERIAL = '1234-5678'
SECRET = 'fake-poll-secret-'+'x'*32
TOKEN = 'fake-private-agent-token'
NIC_VALUE = NIC('robot0', 7, '02:00:00:00:00:01', (('192.168.123.50', 24),))


@pytest.fixture(autouse=True)
def no_real_sdk(monkeypatch):
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        assert not name.startswith(('unitree_sdk2py', 'cyclonedds')), 'real SDK import forbidden in tests'
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)


def credentials(url='ws://127.0.0.1/api/v1/agent/ws'):
    return Credentials(RID, SERIAL, TOKEN, url)


def test_detects_only_dedicated_physical_wired_nic_and_never_changes_network(tmp_path):
    names = ('robot0', 'wifi0', 'internet0', 'virtual0', 'other0')
    rows = []
    for i, name in enumerate(names):
        folder = tmp_path/name
        folder.mkdir()
        if name != 'virtual0':
            (folder/'device').mkdir()
        if name == 'wifi0':
            (folder/'wireless').mkdir()
        rows.append(dict(ifname=name, ifindex=i, address='02:00:00:00:00:01',
                         operstate='UP', link_type='ether', addr_info=[dict(family='inet',
                         local='10.0.0.1' if name == 'other0' else '192.168.123.50', prefixlen=24)]))
    calls = []
    def query(*args):
        calls.append(args)
        return rows if args[0] == 'address' else [dict(dst='default', dev='internet0')]
    found = candidates(query_fn=query, sysfs=tmp_path)
    assert [nic.name for nic in found] == ['robot0']
    assert select(found).name == 'robot0'
    assert calls == [('address', 'show'), ('route', 'show', 'table', 'all')]
    with pytest.raises(PermissionError):
        select(found+found)
    with pytest.raises(PermissionError):
        select(found, 'wifi0')
    rows[0]['addr_info'].append(dict(family='inet', local='10.0.0.2', prefixlen=24))
    assert candidates(query_fn=query, sysfs=tmp_path) == []


def test_private_atomic_storage_and_legacy_file_untouched(tmp_path):
    directory = tmp_path/'private'
    path = directory/'agent.json'
    legacy = tmp_path/'go2-agent.env'
    legacy.write_text('never-read-never-modify')
    legacy.chmod(0)
    assert load(path) is None
    save(credentials(), path)
    assert load(path) == credentials()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert path.stat().st_nlink == 1
    save(replace(credentials(), agent_token='rotated-fake-token'), path)
    assert load(path).agent_token == 'rotated-fake-token'
    assert len(list(directory.iterdir())) == 1
    assert stat.S_IMODE(legacy.stat().st_mode) == 0
    with pytest.raises(PermissionError): load(legacy)
    with pytest.raises(PermissionError): save(credentials(), legacy)
    assert TOKEN not in repr(credentials())


@pytest.mark.parametrize('attack', ['mode', 'hardlink', 'symlink', 'owner', 'fifo', 'directory-mode', 'parent-symlink'])
def test_storage_refuses_unsafe_target_for_read_and_write(tmp_path, monkeypatch, attack):
    directory = tmp_path/'private'
    path = directory/'agent.json'
    save(credentials(), path)
    if attack == 'mode':
        path.chmod(0o644)
    elif attack == 'hardlink':
        os.link(path, directory/'alias')
    elif attack == 'symlink':
        path.rename(directory/'target')
        path.symlink_to(directory/'target')
    elif attack == 'owner':
        monkeypatch.setattr(os, 'getuid', lambda: path.stat().st_uid+1)
    elif attack == 'fifo':
        path.unlink()
        os.mkfifo(path, 0o600)
    elif attack == 'directory-mode':
        directory.chmod(0o755)
    else:
        directory.rename(tmp_path/'real')
        directory.symlink_to(tmp_path/'real', target_is_directory=True)
    for operation in (lambda: load(path), lambda: save(credentials(), path)):
        with pytest.raises((PermissionError, OSError)):
            operation()


def test_contract_pairing_one_time_delivery_and_origin_guard():
    calls = []
    def post(path, body):
        calls.append((path, body))
        if path.endswith('/start'):
            return dict(pairing_id=PID, code='012345', poll_secret=SECRET, expires_at=1500)
        if len(calls) == 2:
            return dict(state='waiting')
        return dict(state='paired', robot_id=RID, agent_token=TOKEN, agent_ws_url='wss://pairing.invalid/api/v1/agent/ws')
    pairing = Pairing('https://pairing.invalid', post=post, wall=lambda: 1000)
    pairing.start(SERIAL)
    assert pairing.code == '012345' and pairing.poll(SERIAL) is None
    result = pairing.poll(SERIAL)
    assert result.agent_token == TOKEN and pairing._secret is None and pairing.code is None
    assert calls == [('/api/v1/pairing/start', {'model':'unitree_go2', 'robot_serial':SERIAL}),
                     (f'/api/v1/pairing/{PID}/poll', {'poll_secret':SECRET}),
                     (f'/api/v1/pairing/{PID}/poll', {'poll_secret':SECRET})]
    with pytest.raises(PermissionError):
        pairing.poll(SERIAL)
    assert SECRET not in repr(pairing)
    for url in ('http://external.invalid', 'https://user:secret@pairing.invalid', 'https://pairing.invalid/path'):
        with pytest.raises(ValueError):
            origin(url)
    assert timestamp('2030-01-01T00:00:00Z') == 1893456000
    with pytest.raises(ValueError):
        timestamp('2030-01-01T00:00:00')


@pytest.mark.parametrize('state', ['consumed', 'expired', 'invalid'])
def test_nonpaired_terminal_response_clears_secret(state):
    replies = iter([dict(pairing_id=PID, code='123456', poll_secret=SECRET, expires_at=1500), dict(state=state)])
    pairing = Pairing('https://pairing.invalid', post=lambda *a: next(replies), wall=lambda:1000)
    pairing.start(SERIAL)
    with pytest.raises(PermissionError):
        pairing.poll(SERIAL)
    assert pairing._secret is None


def test_http_pairing_no_redirect_secret_disclosure_and_response_bound():
    captured = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            captured.append((self.path, json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
            if self.path.endswith('/start'):
                response = dict(pairing_id=PID, code='123456', poll_secret=SECRET, expires_at=time.time()+590)
            else:
                self.send_response(307)
                self.send_header('Location', '/stolen')
                self.end_headers()
                return
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        pairing = Pairing(f'http://127.0.0.1:{server.server_port}')
        pairing.start(SERIAL)
        with pytest.raises(HTTPError):
            pairing.poll(SERIAL)
        assert [p for p, _ in captured] == ['/api/v1/pairing/start', f'/api/v1/pairing/{PID}/poll']
    finally:
        server.shutdown(); server.server_close(); worker.join()


class OfflineSink(Go2Sink):
    def __init__(self, *args, **kw):
        super().__init__(*args, offline_test_mode=True, **kw)
    def start_threads(self):
        pass


def rig(*, ready=True):
    inputs = Inputs()
    inputs.feedback = Feedback(SERIAL)
    inputs.lowstate(low(1)); inputs.sportmodestate(sport(1))
    nic_ok = [True]
    wall, now = Clock(), Clock()
    wall.value = 1000
    gate = Gate(NIC_VALUE, SERIAL, inputs, ready=ready, nic_matches=lambda:nic_ok[0], wall=wall, now=now)
    session = GatedSession(inputs.feedback, gate)
    client = Client(session, gate, credentials().link)
    client._emit(session.connect())
    made = []
    def connect(*args):
        pair = FakeSport(), FakeSport()
        made.append(pair)
        return pair
    def activate():
        gate.activate(object(), connect=connect, sink_factory=OfflineSink)
    return gate, session, client, inputs, wall, now, nic_ok, made, activate


def test_no_motion_objects_before_approval_and_existing_locked_start_after():
    gate, session, client, inputs, wall, now, nic_ok, made, activate = rig()
    for frame in ({'t':'lease', 'lease_id':'lease', 'holder_type':'USER'},
                  {'t':'unlock', 'lease_id':'lease', 'stop_gen':0},
                  {'t':'cmd', 'lease_id':'lease', 'seq':1, 'axes':[1.5,0,0]},
                  {'t':'stop', 'stop_ref':42}):
        client._emit(session.receive(frame)); activate()
    assert made == [] and session._state()['stop_ref'] == 0 and session.core.latch
    assert session.lease_id is None
    session.receive({'t':'field_approval', 'expires_at':1100})
    activate()
    assert len(made) == 1 and gate.active.sink.latched and not session.lease_confirmed
    assert made[0][0].calls == made[0][1].calls == []
    gate.revoke()


def test_automatic_renewal_past_thirty_minutes_keeps_sink_lease_and_latch():
    gate, session, client, inputs, wall, clock, nic_ok, made, activate = rig()
    saved = []
    gate.remember = saved.append
    session.receive({'t':'field_approval', 'expires_at':wall.value+1800})
    activate()
    active = gate.active
    session.receive({'t':'lease', 'lease_id':'renewed-lease', 'holder_type':'USER'})
    lease, latch, epoch = session.lease_id, session.core.latch, gate.epoch
    for _ in range(62):
        wall.value += 60; clock.value += 60
        inputs.lowstate(low(1)); inputs.sportmodestate(sport(1))
        session.receive({'t':'field_approval', 'expires_at':wall.value+1800})
        activate()
        assert gate.allowed() and gate.active is active
        assert session.lease_id == lease and session.core.latch == latch
        assert gate.epoch == epoch and len(made) == 1
    assert len(saved) == 63  # Every fresh expiry is durable, including renewals.
    session.transport_closed(1006, retry=True)
    assert gate.active is None and session.lease_id is None and session.core.latch
    assert made[0][1].calls[-2:] == [('Move',(0,0,0)), ('StopMove',())]


@pytest.mark.parametrize('failure', ['nic', 'serial', 'too_far', 'expired', 'feedback', 'disconnect'])
def test_renewal_retains_all_local_safety_checks(failure):
    gate, session, client, inputs, wall, clock, nic_ok, made, activate = rig()
    session.receive({'t':'field_approval', 'expires_at':1100}); activate()
    expiry = 1200
    if failure == 'nic': nic_ok[0] = False
    elif failure == 'serial': inputs.lowstate(low(2, sn=(9876,5432)))
    elif failure == 'too_far': expiry = wall.value+1831
    elif failure == 'expired': expiry = wall.value
    elif failure == 'feedback': inputs.feedback._fault = True
    else: session.disconnect()
    session.receive({'t':'field_approval', 'expires_at':expiry}); activate()
    assert not gate.allowed() and session.core.latch and session.lease_id is None
    assert len(made) == 1


@pytest.mark.parametrize('reason', ['expiry', 'monotonic-expiry', 'revoke', 'nic', 'serial', 'disconnect', 'transport', 'link-lost'])
def test_revocation_stops_locks_and_cannot_rearm_same_approval(reason):
    gate, session, client, inputs, wall, now, nic_ok, made, activate = rig()
    session.receive({'t':'field_approval', 'expires_at':1100})
    activate()
    old_sink = gate.active.sink
    if reason == 'expiry': wall.value = 1100
    elif reason == 'monotonic-expiry': now.value += 101
    elif reason == 'revoke': session.receive({'t':'field_approval', 'expires_at':None})
    elif reason == 'nic': nic_ok[0] = False
    elif reason == 'serial': inputs.lowstate(low(2, sn=(9876, 5432)))
    elif reason == 'disconnect': client._emit(session.disconnect())
    elif reason == 'transport': client._emit(session.transport_closed(1006, retry=True))
    else: session.link_lost = True
    gate.apply(MotionCommand(velocity=(1.5,0,0)))
    assert gate.active is None and old_sink.latched and session.core.latch
    assert made[0][1].calls[-2:] == [('Move',(0,0,0)), ('StopMove',())]
    assert not session.lease_confirmed and session.lease_id is None
    wall.value = 1000; now.value = 0; nic_ok[0] = True
    client._emit(session.connect())
    session.receive({'t':'field_approval', 'expires_at':1100})
    activate()
    assert len(made) == 1 and gate.active is None


@pytest.mark.parametrize('expiry', [None, True, 'garbage', float('nan'), float('inf'), 1000, 2831])
def test_invalid_approval_never_constructs_motion(expiry):
    gate, session, client, inputs, wall, now, nic_ok, made, activate = rig()
    session.receive({'t':'field_approval', 'expires_at':expiry})
    activate()
    assert made == [] and gate.active is None


def test_failed_preflight_remains_readonly_even_with_valid_approval():
    gate, session, _, _, _, _, _, made, activate = rig(ready=False)
    session.receive({'t':'field_approval', 'expires_at':1100})
    activate()
    assert made == [] and gate.active is None


def test_local_view_allowlist_no_secrets_and_dns_rebinding_denied():
    status = Status()
    status.update(serial=SERIAL, code='123456', expires_at=time.time()+590, qr=qr_svg('123456'))
    with pytest.raises(ValueError):
        status.update(agent_token=TOKEN)
    server = make_server(status, 0)
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    try:
        assert server.server_address[0] == '127.0.0.1'
        base = f'http://127.0.0.1:{server.server_port}'
        for path in ('/', '/status'):
            response = urlopen(base+path)
            body = response.read().decode()
            assert TOKEN not in body and SECRET not in body
            assert response.headers['Cache-Control'] == 'no-store'
        for headers in ({'Host':'attacker.invalid'}, {'Origin':'https://attacker.invalid'}, {'Sec-Fetch-Site':'cross-site'}):
            with pytest.raises(HTTPError) as error:
                urlopen(Request(base+'/status', headers=headers))
            assert error.value.code == 403
        for port in (8453,8792,5190,5191,8870,9430):
            with pytest.raises(ValueError): make_server(status, port)
    finally:
        server.shutdown(); server.server_close(); worker.join()


def test_fake_http_dds_and_real_loopback_ws_pair_save_approve_move_expire(tmp_path, capsys):
    """One command's connect path, with no actual SDK import and live safety workers."""
    from foothold_agent.setup.__main__ import connect as setup_connect
    from websockets.asyncio.server import serve

    async def scenario():
        stop = asyncio.Event()
        motion = []
        observed = {}
        requests = []
        status = Status()
        class Subscriptions:
            def __init__(self, inputs, nic):
                self.inputs, self.nic, self.sequence = inputs, nic, 0
                observed['subscriptions'] = self
            def start(self):
                def pulse():
                    self.sequence += 1
                    self.inputs.lowstate(low(self.sequence))
                    self.inputs.sportmodestate(sport(self.sequence))
                    self.handle = asyncio.get_running_loop().call_later(.02, pulse)
                pulse()
            def close(self):
                self.handle.cancel()
                observed['closed'] = True
        def sdk_factory(approval, serial, subscriptions):
            assert approval.nic == NIC_VALUE.name and serial == SERIAL
            assert subscriptions is observed['subscriptions']
            motion.append((FakeSport(), FakeSport()))
            return motion[-1]
        def client_factory(session, sink, settings):
            observed['session'], observed['gate'] = session, sink
            return Client(session, sink, settings)
        async def runtime(*args, **kwargs):
            await run(*args, **kwargs, connect=sdk_factory, client_factory=client_factory)
        async def read(ws, predicate):
            async with asyncio.timeout(4):
                while True:
                    message = json.loads(await ws.recv())
                    if predicate(message): return message
        handler_error = []
        async def ws_handler(ws):
            try:
                assert ws.request.headers['Authorization'] == 'Bearer '+TOKEN
                hello = await read(ws, lambda m:m['t']=='hello')
                assert hello['proto'] == 'fh-agent/2'
                await ws.send(json.dumps(dict(t='lease', lease_id='fake-lease', holder_type='USER')))
                await ws.send(json.dumps(dict(t='cmd', lease_id='fake-lease', seq=1, axes=[1.5,0,0])))
                await ws.send(json.dumps(dict(t='stop', stop_ref=42)))
                await asyncio.sleep(.1)
                assert motion == []
                state = await read(ws, lambda m:m['t']=='state')
                assert state['latched'] and state['stop_ref'] == 0
                approval = time.time()+1.1
                await ws.send(json.dumps(dict(t='field_approval', expires_at=datetime.fromtimestamp(approval, timezone.utc).isoformat())))
                async with asyncio.timeout(1):
                    while not motion: await asyncio.sleep(.01)
                await ws.send(json.dumps(dict(t='stop', stop_ref=43)))
                stopped = await read(ws, lambda m:m['t']=='state' and m['stop_ref']==43)
                await ws.send(json.dumps(dict(t='lease', lease_id='fake-lease', holder_type='USER')))
                await ws.send(json.dumps(dict(t='unlock', lease_id='fake-lease', stop_gen=stopped['stop_gen'])))
                await read(ws, lambda m:m['t']=='state' and not m['latched'])
                await ws.send(json.dumps(dict(t='cmd', lease_id='fake-lease', seq=2, axes=[0,0,0])))
                for seq in range(3, 12):
                    await ws.send(json.dumps(dict(t='cmd', lease_id='fake-lease', seq=seq, axes=[1.5,0,.5])))
                    await asyncio.sleep(.04)
                    if ('Move',(1.5,0,.5)) in motion[0][0].calls: break
                assert ('Move',(1.5,0,.5)) in motion[0][0].calls
                async with asyncio.timeout(2):
                    while observed['gate'].active is not None: await asyncio.sleep(.01)
                assert motion[0][1].calls[-1] == ('StopMove',())
                assert observed['session'].core.latch
                await ws.send(json.dumps(dict(t='field_approval', expires_at=approval)))
                await asyncio.sleep(.05)
                assert len(motion) == 1 and observed['gate'].active is None
                assert any(d['key']=='go2-preflight' and d['state']=='OK' for d in hello['devices'])
            except BaseException as error:
                handler_error.append(error)
            finally:
                stop.set()
        async with serve(ws_handler, '127.0.0.1', 0) as ws:
            ws_port = ws.sockets[0].getsockname()[1]
            # Shared HTTP/WS origin is required by production transport. For this
            # integration the fake HTTP server supplies a test-local Pairing with
            # a matching paired URL check and a separately bound WS listener.
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_): pass
                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    requests.append((self.path, body))
                    if self.path.endswith('/start'):
                        value = dict(pairing_id=PID, code='123456', expires_at=time.time()+590, poll_secret=SECRET)
                    else:
                        value = dict(state='paired', robot_id=RID, agent_token=TOKEN,
                                     agent_ws_url=f'ws://127.0.0.1:{ws_port}/api/v1/agent/ws')
                    self.send_response(200); self.send_header('Cache-Control','no-store'); self.end_headers()
                    self.wfile.write(json.dumps(value).encode())
            http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            worker = threading.Thread(target=http.serve_forever, daemon=True); worker.start()
            # Keep origin validation in Pairing; only route its injected POST to
            # the fake HTTP port. Both production transport methods are exercised.
            transport = Pairing(f'http://127.0.0.1:{http.server_port}')
            args = NS(config=tmp_path/'private'/'agent.json', server=f'http://127.0.0.1:{ws_port}',
                      nic=None, wheel_dir='fake-wheels')
            try:
                await asyncio.wait_for(setup_connect(args, status, stop, discover=lambda:[NIC_VALUE],
                    subscriptions_factory=Subscriptions, preflight=lambda _:dict(installation_ready=True, issues=[]),
                    pairing_factory=lambda server:Pairing(server, post=transport._http), runtime=runtime), 8)
            finally:
                http.shutdown(); http.server_close(); worker.join()
        if handler_error: raise handler_error[0]
        assert observed['closed'] and load(args.config).agent_token == TOKEN
        assert stat.S_IMODE(args.config.stat().st_mode) == 0o600
        assert requests[0][1] == dict(model='unitree_go2', robot_serial=SERIAL)
        assert requests[1][1] == dict(poll_secret=SECRET)
        assert TOKEN not in json.dumps(status.snapshot()) and SECRET not in json.dumps(status.snapshot())
    asyncio.run(scenario())
    captured = capsys.readouterr()
    assert TOKEN not in captured.out+captured.err and SECRET not in captured.out+captured.err


def test_used_approval_is_saved_before_motion_and_rejected_after_restart(tmp_path):
    gate, session, client, inputs, wall, now, nic_ok, made, activate = rig()
    path = tmp_path/'private'/'agent.json'
    save(credentials(), path)
    gate.remember = lambda expiry: save(replace(credentials(), last_field_approval_expires_at=expiry), path)
    session.receive({'t':'field_approval', 'expires_at':1100})
    def connect(*_):
        assert load(path).last_field_approval_expires_at == 1100
        made.append((FakeSport(), FakeSport()))
        return made[-1]
    gate.activate(object(), connect=connect, sink_factory=OfflineSink)
    gate.revoke()
    restarted, session, _, _, _, _, _, restarted_objects, activate = rig()
    restarted.last_expiry = load(path).last_field_approval_expires_at
    session.receive({'t':'field_approval', 'expires_at':1100})
    activate()
    assert restarted_objects == [] and restarted.active is None
    session.receive({'t':'field_approval', 'expires_at':1200})
    activate()
    assert len(restarted_objects) == 1 and restarted.active.sink.latched
    restarted.revoke()


def test_failed_approval_history_save_never_constructs_motion():
    gate, session, _, _, _, _, _, made, activate = rig()
    def fail(_): raise OSError('fake disk failure')
    gate.remember = fail
    session.receive({'t':'field_approval', 'expires_at':1100})
    with pytest.raises(OSError): activate()
    assert made == [] and gate.active is None


def test_serial_zero_and_conflict_are_refused_without_motion():
    from foothold_agent.setup.runtime import SerialUnavailable
    inputs = Inputs()
    inputs.lowstate(low(1, sn=(0,0)))
    with pytest.raises(SerialUnavailable): inputs.identity()
    inputs = Inputs()
    inputs.lowstate(low(1))
    assert inputs.identity() == SERIAL
    inputs.lowstate(low(2, sn=(9999, 9999)))
    with pytest.raises(PermissionError): inputs.identity()


@pytest.mark.parametrize('remaining', [60, 1801])
def test_production_sdk_factory_validates_before_import_and_only_initializes_two_clients(monkeypatch, remaining):
    from foothold_agent.go2_direct.sdk import connect_approved
    from foothold_agent.go2_direct.approval import Approval
    from foothold_agent.go2_readonly.sdk import Subscriptions
    import socket
    approvals = Approval(NIC_VALUE.name, SERIAL, time.time()+remaining)
    subscriptions = Subscriptions(Inputs(), NIC_VALUE.name)
    subscriptions._started = True
    monkeypatch.setattr(socket, 'if_nameindex', lambda:[(7, NIC_VALUE.name)])
    created = []
    class Sport:
        def __init__(self): created.append(self); self.calls=[]
        def SetTimeout(self, value): self.calls.append(('timeout', value))
        def Init(self): self.calls.append(('init',))
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        if name == 'unitree_sdk2py.go2.sport.sport_client':
            return NS(SportClient=Sport)
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)
    for approval, observed, sub in ((replace(approvals, expires_at=time.time()-1),SERIAL,subscriptions),
                                   (approvals,'wrong-serial',subscriptions), (approvals,SERIAL,object())):
        with pytest.raises(PermissionError): connect_approved(approval, observed, sub)
        assert created == []
    clients = connect_approved(approvals, SERIAL, subscriptions)
    assert len(clients) == len(created) == 2
    assert all(c.calls == [('timeout', .1), ('init',)] for c in created)


def test_help_and_import_do_not_import_sdk_or_open_socket():
    import subprocess
    code = '''
import socket, sys
class Block:
 def find_spec(self,name,*args):
  if name.startswith(('unitree_sdk2py','cyclonedds')): raise AssertionError('SDK import')
sys.meta_path.insert(0,Block())
class DenySocket(socket.socket):
 def __init__(self,*a,**k): raise AssertionError('socket open')
socket.socket=DenySocket
from foothold_agent.setup import __main__
__main__.main(['--help'])
'''
    result = subprocess.run([sys.executable,'-c',code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('skew,accepted', [(-1,True),(-.05,True),(0,True),(-30,True),(-30.001,False),(600,False),(601,False)])
def test_server_pairing_expiry_clock_skew_only_relaxes_upper_bound(skew, accepted):
    pairing = Pairing('https://pairing.invalid', wall=lambda:1000+skew,
                      post=lambda *_:dict(pairing_id=PID, code='123456', poll_secret=SECRET, expires_at=1600))
    if accepted:
        try:
            pairing.start(SERIAL)
        except ValueError:
            pytest.fail('valid server expiry was refused within the allowed clock offset')
        assert pairing.expires_at == 1600  # expiry itself is never extended
    else:
        with pytest.raises(ValueError): pairing.start(SERIAL)
        assert pairing._secret is None


@pytest.mark.parametrize('skew,accepted', [(-1,True),(-.05,True),(0,True),(-30,True),(-30.001,False),(1800,False),(1801,False)])
def test_server_field_approval_clock_skew_and_expired_boundary(skew, accepted):
    gate, session, _, _, wall, _, _, made, activate = rig()
    wall.value = 1000+skew
    session.receive({'t':'field_approval', 'expires_at':2800})
    activate()
    try:
        assert bool(made) is accepted
        if accepted:
            assert gate.last_expiry == 2800
            wall.value = 2800
            gate.apply(MotionCommand(velocity=(1.5,0,0)))
            assert gate.active is None and made[0][1].calls[-1] == ('StopMove',())
    finally:
        gate.revoke()


def test_local_manual_approval_stays_strict_and_server_expiry_cannot_use_past_grace():
    from foothold_agent.go2_direct.approval import SERVER_CLOCK_SKEW_S, validate_value
    value = dict(v=1, purpose='go2-field-motion', nic=NIC_VALUE.name, robot_serial=SERIAL, expires_at=2801)
    with pytest.raises(PermissionError): validate_value(value, NIC_VALUE.name, now=1000)
    approval = validate_value(value, NIC_VALUE.name, now=1000, clock_skew_s=SERVER_CLOCK_SKEW_S)
    assert approval.expires_at == 2801
    for expiry in (999, 1000):
        with pytest.raises(PermissionError):
            validate_value({**value, 'expires_at':expiry}, NIC_VALUE.name, now=1000, clock_skew_s=SERVER_CLOCK_SKEW_S)


class RepairSubscriptions:
    """Callback timer supplies fresh identity without initializing DDS."""
    def __init__(self, inputs, nic):
        self.inputs, self.sequence = inputs, 0
    def start(self):
        def pulse():
            self.sequence += 1
            self.inputs.lowstate(low(self.sequence))
            self.inputs.sportmodestate(sport(self.sequence))
            self.handle = asyncio.get_running_loop().call_later(.02, pulse)
        pulse()
    def close(self):
        self.handle.cancel()


def repair_args(path, *, repair=False):
    return NS(config=path, server=None, nic=None, wheel_dir='fake-wheels', repair=repair)


def setup_dependencies():
    return dict(discover=lambda:[NIC_VALUE], subscriptions_factory=RepairSubscriptions,
                preflight=lambda _:dict(installation_ready=True, issues=[]))


@pytest.mark.parametrize('kind,code', [('ws',4403),('ws',4401),('http',401),('http',403)])
def test_saved_connection_auth_rejection_shows_explicit_repair_without_pairing(tmp_path, monkeypatch, capsys, kind, code):
    from foothold_agent.setup import __main__ as setup
    from websockets.asyncio.server import serve
    from websockets.http11 import Response
    from websockets.datastructures import Headers

    async def scenario():
        status = Status()
        stop = None
        attempts = []
        original_connect = setup.connect
        def no_pairing(*_): raise AssertionError('must not automatically pair after auth rejection')
        async def injected(args, status, event):
            nonlocal stop
            stop = event
            await original_connect(args, status, event, **setup_dependencies(), pairing_factory=no_pairing)
        monkeypatch.setattr(setup, 'connect', injected)
        async def ws_handler(ws):
            attempts.append(ws.request.headers['Authorization'])
            await ws.recv()
            await ws.close(code=code)
        def reject(connection, request):
            if kind == 'http':
                attempts.append(request.headers['Authorization'])
                return Response(code, 'Unauthorized', Headers(), b'')
        async with serve(ws_handler, '127.0.0.1', 0, process_request=reject) as listener:
            port = listener.sockets[0].getsockname()[1]
            path = tmp_path/'private'/'agent.json'
            old = credentials(f'ws://127.0.0.1:{port}/api/v1/agent/ws')
            save(old, path)
            task = asyncio.create_task(setup.serve(repair_args(path), status))
            try:
                async with asyncio.timeout(3):
                    while not any(message in status.snapshot()['mode'] for message in ('이 노트북의 연결이 해제됨', '연결 거부')):
                        await asyncio.sleep(.01)
                assert '이 노트북의 연결이 해제됨' in status.snapshot()['mode']
                assert '--repair' in status.snapshot()['mode'] and not status.snapshot()['connected']
                assert status.snapshot().get('code') is None
                assert load(path) == old and attempts == ['Bearer '+TOKEN]
                assert TOKEN not in json.dumps(status.snapshot())
                stop.set()
                assert await task is False
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())
    captured = capsys.readouterr()
    assert TOKEN not in captured.out+captured.err


def test_explicit_repair_pairs_again_and_atomically_replaces_saved_token(tmp_path):
    from foothold_agent.setup.__main__ import connect

    async def scenario():
        path = tmp_path/'private'/'agent.json'
        old = replace(credentials('wss://pairing.invalid/api/v1/agent/ws'), last_field_approval_expires_at=1100)
        save(old, path)
        calls, used_tokens = [], []
        valid_tokens = {TOKEN}
        new_token = 'replacement-private-agent-token'
        def post(endpoint, body):
            calls.append((endpoint, body))
            assert load(path) == old  # no destructive reset before success
            if endpoint.endswith('/start'):
                return dict(pairing_id=PID, code='123456', poll_secret=SECRET, expires_at=time.time()+600)
            # Fake server models confirm's existing token rotation contract.
            valid_tokens.discard(TOKEN)
            valid_tokens.add(new_token)
            return dict(state='paired', robot_id=RID, agent_token=new_token,
                        agent_ws_url='wss://pairing.invalid/api/v1/agent/ws')
        async def runtime(value, *args, **kwargs):
            used_tokens.append(value.agent_token)
            assert value.agent_token == new_token and TOKEN not in valid_tokens
            assert load(path) == value
        status = Status()
        await connect(repair_args(path, repair=True), status, asyncio.Event(), **setup_dependencies(),
                      pairing_factory=lambda server:Pairing(server, post=post), runtime=runtime)
        assert calls[0] == ('/api/v1/pairing/start', dict(model='unitree_go2', robot_serial=SERIAL))
        assert calls[1] == (f'/api/v1/pairing/{PID}/poll', dict(poll_secret=SECRET))
        assert used_tokens == [new_token] and load(path).agent_token == new_token
        assert load(path).last_field_approval_expires_at == 1100
        assert stat.S_IMODE(path.stat().st_mode) == 0o600 and path.stat().st_nlink == 1
        assert TOKEN not in path.read_text() and SECRET not in path.read_text()
        assert new_token not in json.dumps(status.snapshot())
    asyncio.run(scenario())


@pytest.mark.parametrize('failure', ['pairing', 'storage'])
def test_failed_explicit_repair_preserves_file_and_never_falls_back_to_old_token(tmp_path, monkeypatch, failure):
    from foothold_agent.setup import __main__ as setup

    async def scenario():
        path = tmp_path/'private'/'agent.json'
        old = credentials('wss://pairing.invalid/api/v1/agent/ws')
        save(old, path)
        def post(endpoint, body):
            if endpoint.endswith('/start'):
                return dict(pairing_id=PID, code='123456', poll_secret=SECRET, expires_at=time.time()+600)
            if failure == 'pairing': return dict(state='consumed')
            return dict(state='paired', robot_id=RID, agent_token='replacement-token',
                        agent_ws_url='wss://pairing.invalid/api/v1/agent/ws')
        def fail_save(*_): raise OSError('fake disk failure')
        if failure == 'storage': monkeypatch.setattr(setup, 'save', fail_save)
        async def no_runtime(*args, **kwargs): raise AssertionError('no fallback to old token on repair failure')
        with pytest.raises((PermissionError, OSError)):
            await setup.connect(repair_args(path, repair=True), Status(), asyncio.Event(), **setup_dependencies(),
                                pairing_factory=lambda server:Pairing(server, post=post), runtime=no_runtime)
        assert load(path) == old and stat.S_IMODE(path.stat().st_mode) == 0o600
    asyncio.run(scenario())

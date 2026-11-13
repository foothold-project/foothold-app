"""0-0 laptop identity boundaries using fake DDS and kernel rows only."""
import asyncio
from dataclasses import replace
import json
import time
from types import SimpleNamespace as NS
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import threading

import pytest

from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.identity import neighbor_identity, ResumeGate
from foothold_agent.setup.identity import MacIdentity, IdentityUnavailable, confirm_zero_identity
from foothold_agent.setup.runtime import Inputs, Gate, GatedSession, run
from foothold_agent.setup.storage import load, save, mac_serial
from foothold_agent.setup.view import Status, make_server
from foothold_agent.setup.__main__ import connect
from foothold_agent.link.client import Client
from test_go2_feedback import low, sport
from test_setup_pairing import NIC_VALUE, credentials, OfflineSink, FakeSport, Clock

MAC = '02:00:00:00:00:11'


def rows():
    # No .18 required; unknown peers are evidence for the human, not a veto.
    return [dict(dst='192.168.123.161', dev=NIC_VALUE.name, lladdr=MAC, state=['STALE']),
            dict(dst='192.168.123.99', dev=NIC_VALUE.name, state=['INCOMPLETE'])]


def query(_nic):
    return neighbor_identity(_nic, entries=rows())


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.005)


@pytest.mark.parametrize('bad', ['missing', 'no-mac', 'zero-mac', 'multicast', 'failed', 'duplicate', 'wrong-nic'])
def test_body_mac_is_mandatory(bad):
    values = rows()
    if bad == 'missing': values.pop(0)
    elif bad == 'no-mac': values[0].pop('lladdr')
    elif bad == 'zero-mac': values[0]['lladdr'] = '00:00:00:00:00:00'
    elif bad == 'multicast': values[0]['lladdr'] = '01:00:00:00:00:11'
    elif bad == 'failed': values[0]['state'] = ['FAILED']
    elif bad == 'duplicate': values.append(dict(values[0]))
    else: values[0]['dev'] = 'other0'
    with pytest.raises(PermissionError):
        neighbor_identity(NIC_VALUE.name, entries=values)


@pytest.mark.parametrize('confirm', [True, False])
def test_no_server_call_before_confirmation_and_cancel_does_nothing(tmp_path, monkeypatch, confirm):
    monkeypatch.setattr('foothold_agent.go2_direct.identity.neighbors', lambda nic: rows())
    async def scenario():
        status, stop, calls, closed = Status(), asyncio.Event(), [], []
        class Subscriptions:
            def __init__(self, inputs, nic): self.inputs, self.tick = inputs, 0
            def start(self):
                def pulse():
                    self.tick += 1
                    self.inputs.lowstate(low(self.tick, sn=(0, 0)))
                    self.handle = asyncio.get_running_loop().call_later(.01, pulse)
                pulse()
            def close(self): self.handle.cancel(); closed.append(True)
        class Pairing:
            code, expires_at = '123456', time.time()+590
            def __init__(self, server): calls.append('pairing-created')
            def start(self, serial): calls.append(('start', serial))
            def poll(self, serial): calls.append(('poll', serial)); return replace(credentials(), robot_serial=serial)
            def clear(self): pass
        async def runtime(creds, nic, inputs, subscriptions, **kw):
            calls.append('runtime')
            assert creds.identity_source == 'mac' and creds.robot_mac == MAC
            assert inputs.identity() == mac_serial(MAC)
        args = NS(config=tmp_path/'private'/'agent.json', server='http://127.0.0.1', nic=None,
                  wheel_dir='fake', repair=False)
        task = asyncio.create_task(connect(args, status, stop, discover=lambda:[NIC_VALUE],
            subscriptions_factory=Subscriptions, preflight=lambda _:dict(installation_ready=True, issues=[]),
            pairing_factory=Pairing, runtime=runtime,
            depth_factory=lambda **_:NS(start=lambda:None, close=lambda:None, bind=lambda _:None)))
        await until(lambda:status.snapshot().get('identity_confirmation'))
        shown = status.snapshot()['identity_confirmation']
        assert shown['mac'] == MAC and shown['addresses'] == ['192.168.123.99', '192.168.123.161']
        await asyncio.sleep(.06)
        assert calls == [] and not args.config.exists()
        status.confirm_identity(shown['request'], confirm)
        await asyncio.wait_for(task, 2)
        assert closed and status.snapshot()['identity_confirmation'] is None
        if confirm:
            assert calls == ['pairing-created', ('start', mac_serial(MAC)), ('poll', mac_serial(MAC)), 'runtime']
            saved = load(args.config)
            assert saved.robot_serial == mac_serial(MAC) and saved.robot_mac == MAC and saved.identity_source == 'mac'
            assert args.config.stat().st_mode & 0o777 == 0o600
        else:
            assert calls == [] and not args.config.exists()
    asyncio.run(scenario())


def test_unavailable_neighbor_and_windows_refuse_without_confirmation():
    async def scenario():
        inputs = Inputs(); inputs.lowstate(low(1, sn=(0, 0)))
        for windows in (False, True):
            status = Status()
            def missing(_): raise PermissionError('no body')
            with pytest.raises(IdentityUnavailable) as error:
                await confirm_zero_identity(inputs, NIC_VALUE, status, asyncio.Event(), None,
                                            query=missing, windows=windows)
            if windows: assert 'Windows' in str(error.value)
            assert not status.snapshot().get('identity_confirmation')
    asyncio.run(scenario())


@pytest.mark.parametrize('change', ['mac', 'serial', 'conflict', 'stale'])
def test_identity_change_revokes_motion_stops_and_locks(change):
    async def scenario():
        inputs = Inputs(); inputs.lowstate(low(1, sn=(0, 0)))
        current = [MAC]
        identity = MacIdentity(NIC_VALUE.name, MAC, inputs, query=lambda _:(current[0], []))
        inputs.mac_identity = identity
        await identity.refresh()
        inputs.feedback = Feedback('0-0')
        inputs.lowstate(low(2, sn=(0, 0))); inputs.sportmodestate(sport(2))
        wall, now = Clock(), Clock(); wall.value = 1000
        gate = Gate(NIC_VALUE, identity.serial, inputs, ready=True, nic_matches=lambda:True, wall=wall, now=now)
        session = GatedSession(inputs.feedback, gate); session.connect()
        made = []
        def sdk(*_): made.append((FakeSport(), FakeSport())); return made[-1]
        session.receive(dict(t='field_approval', expires_at=1100))
        gate.activate(object(), connect=sdk, sink_factory=OfflineSink)
        assert gate.active is not None
        if change == 'mac':
            current[0] = '02:00:00:00:00:12'
            with pytest.raises(PermissionError): await identity.refresh()
        elif change in ('serial', 'conflict'):
            inputs.lowstate(low(3, sn=(1234, 5678)))
            if change == 'conflict': inputs.lowstate(low(4, sn=(0, 0)))
        else: identity.checked -= .21
        assert not gate.allowed() and gate.active is None and session.core.latch
        assert session.lease_id is None
        assert made[0][1].calls[-2:] == [('Move', (0, 0, 0)), ('StopMove', ())]
    asyncio.run(scenario())


@pytest.mark.parametrize('changed', [False, True])
def test_every_unlock_reads_body_again_and_failed_check_cannot_unlock(changed):
    from test_go2_server_drive import rig
    async def scenario():
        now, sink, normal, emergency, session, client, measured, frame = rig()
        inputs = Inputs(); inputs.lowstate(low(1, sn=(0, 0)))
        checks = []
        current = [MAC]
        def read(_): checks.append(True); return current[0], []
        identity = MacIdentity(NIC_VALUE.name, MAC, inputs, query=read)
        await identity.refresh()
        frame('stop', stop_ref=42); measured()
        feedback = NS(serial='0-0', sink=sink, fault=False, sample=lambda:object())
        session.identity_gate = ResumeGate(None, feedback, check=identity.verify_resume, now=now)
        if changed: current[0] = '02:00:00:00:00:12'
        frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
        assert sink.latched
        await until(lambda:session.identity_gate.task.done())
        session.identity_gate.poll(client)
        assert len(checks) == 2
        assert sink.latched is changed
        session.identity_gate.close()
    asyncio.run(scenario())


def test_saved_mac_mapping_is_explicit_and_cannot_be_relabelled(tmp_path):
    value = replace(credentials(), robot_serial=mac_serial(MAC), identity_source='mac', robot_mac=MAC)
    path = tmp_path/'private'/'agent.json'; save(value, path)
    assert load(path) == value
    for changes in (dict(robot_serial='1234-5678'), dict(identity_source='serial'), dict(robot_mac=None)):
        with pytest.raises(ValueError): replace(value, **changes)
    assert mac_serial(MAC) != mac_serial('02:00:00:00:00:12')


def test_runtime_continuously_checks_body_mac_and_stops_on_change():
    async def scenario():
        inputs, current, seen, made, stop = Inputs(), [MAC], {}, [], asyncio.Event()
        identity = MacIdentity(NIC_VALUE.name, MAC, inputs, query=lambda _:(current[0], []))
        inputs.mac_identity = identity
        sequence = [0]
        def pulse():
            sequence[0] += 1
            inputs.lowstate(low(sequence[0], sn=(0, 0)))
            inputs.sportmodestate(sport(sequence[0]))
            seen['pulse'] = asyncio.get_running_loop().call_later(.01, pulse)
        pulse()
        def client_factory(session, gate, settings):
            seen['gate'], seen['session'] = gate, session
            class OfflineClient(Client):
                async def run(self):
                    self._emit(self.session.connect())
                    await stop.wait()
            return OfflineClient(session, gate, settings)
        def sdk(*_): made.append((FakeSport(), FakeSport())); return made[-1]
        recorder = NS(notice='', stopped=threading.Event(), close=lambda:None)
        creds = replace(credentials(), robot_serial=identity.serial, identity_source='mac', robot_mac=MAC)
        task = asyncio.create_task(run(creds, NIC_VALUE, inputs, object(), ready=True,
            check_nic=lambda:True, status=Status(), stop=stop, connect=sdk, sink_factory=OfflineSink,
            client_factory=client_factory, recorder_factory=lambda *a, **k:recorder))
        try:
            await until(lambda:'session' in seen and seen['session'].connected)
            seen['session'].receive(dict(t='field_approval', expires_at=time.time()+60))
            await until(lambda:made and seen['gate'].active is not None)
            assert inputs.feedback.serial == '0-0'
            current[0] = '02:00:00:00:00:12'
            await until(lambda:seen['gate'].active is None)
            assert identity.fault and seen['session'].core.latch
            assert made[0][1].calls[-1] == ('StopMove', ())
        finally:
            stop.set(); seen['pulse'].cancel()
            await asyncio.wait_for(task, 2)
    asyncio.run(scenario())


def test_confirmation_http_requires_same_origin_current_request_and_one_decision():
    status = Status(); request = status.request_identity(MAC, ['192.168.123.161'])
    server = make_server(status, 0); worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    base = f'http://127.0.0.1:{server.server_port}'
    def post(body, origin):
        return urlopen(Request(base+'/identity-confirm', data=json.dumps(body).encode(), method='POST',
                              headers={'Content-Type':'application/json', 'Origin':origin}), timeout=2)
    try:
        for body, origin, code in ((dict(request=request, confirmed=True), 'https://other.invalid', 403),
                (dict(request='stale', confirmed=True), base, 400),
                (dict(request=request, confirmed='true'), base, 400)):
            with pytest.raises(HTTPError) as error: post(body, origin)
            assert error.value.code == code
            assert status.identity_decision(request) is None
        assert post(dict(request=request, confirmed=False), base).status == 204
        assert status.identity_decision(request) is False
        with pytest.raises(HTTPError): post(dict(request=request, confirmed=True), base)
        status.clear_identity(request)
        with pytest.raises(HTTPError): post(dict(request=request, confirmed=True), base)
    finally:
        server.shutdown(); server.server_close(); worker.join()

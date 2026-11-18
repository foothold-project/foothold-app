"""Transient body checks use fake neighbours, clocks and motion outputs only."""
import asyncio
from dataclasses import replace
import subprocess
import threading
import time
from types import SimpleNamespace as NS

import pytest

from foothold_agent.link.client import Client
from foothold_agent.setup.identity import MacIdentity
from foothold_agent.setup.runtime import Inputs, run
from foothold_agent.setup.view import Status
from test_go2_feedback import low, sport
from test_setup_pairing import NIC_VALUE, credentials, OfflineSink, FakeSport, Clock
from test_setup_zero_identity import MAC, until


@pytest.mark.parametrize('failure', ['timeout', 'missing', 'stale', 'slow'])
def test_transient_invalidates_cached_identity_and_only_fresh_check_recovers(monkeypatch, caplog, failure):
    now = Clock()
    monkeypatch.setattr('foothold_agent.setup.runtime.time', NS(monotonic=now))
    inputs = Inputs()
    inputs.lowstate(low(1, sn=(0, 0)))
    bad = [False]
    def query(_):
        if bad[0]:
            if failure == 'timeout':
                raise subprocess.TimeoutExpired('fake-neighbor-query', .15)
            if failure == 'missing':
                raise PermissionError('no body neighbor')
            if failure == 'slow':
                now.value += .20
                inputs.lowstate(low(2, sn=(0, 0)))
        return MAC, []
    identity = inputs.mac_identity = MacIdentity(NIC_VALUE.name, MAC, inputs, query=query, now=now)
    identity.check()
    assert inputs.identity() == identity.serial
    bad[0] = True
    if failure == 'stale':
        now.value += .201
    for _ in range(3):
        with pytest.raises((PermissionError, subprocess.TimeoutExpired)):
            identity.check()
        assert not identity.fault and not identity.valid()
        with pytest.raises(PermissionError):
            inputs.identity()
        now.value += 1
    assert identity.failure_epoch == 3
    assert [r.message for r in caplog.records] == ['기체 확인 잠시 안 됨']
    bad[0] = False
    inputs.lowstate(low(3, sn=(0, 0)))
    # Time and a new LowState alone cannot authorize the old cached MAC.
    assert not identity.valid()
    identity.check()
    assert identity.valid() and inputs.identity() == identity.serial
    identity.check()
    assert [r.message for r in caplog.records] == ['기체 확인 잠시 안 됨', '기체 확인 다시 확인됨']
    assert MAC not in caplog.text and '192.168.' not in caplog.text


@pytest.mark.parametrize('conflict', ['mac', 'serial', 'serial-returned-zero', 'stale-serial'])
def test_positive_conflict_stays_permanent_after_original_robot_returns(monkeypatch, conflict):
    now = Clock()
    monkeypatch.setattr('foothold_agent.setup.runtime.time', NS(monotonic=now))
    inputs = Inputs()
    inputs.lowstate(low(1, sn=(0, 0)))
    mac = [MAC]
    identity = inputs.mac_identity = MacIdentity(NIC_VALUE.name, MAC, inputs,
                                                 query=lambda _: (mac[0], []), now=now)
    identity.check()
    if conflict == 'mac':
        mac[0] = '02:00:00:00:00:12'
    else:
        inputs.lowstate(low(2, sn=(9, 9)))
        if conflict == 'serial-returned-zero':
            inputs.lowstate(low(3, sn=(0, 0)))
        elif conflict == 'stale-serial':
            now.value += .201
    with pytest.raises(PermissionError):
        identity.check()
    mac[0] = MAC
    inputs.lowstate(low(4, sn=(0, 0)))
    for _ in range(3):
        with pytest.raises(PermissionError):
            identity.check()
        assert identity.fault and not identity.valid()


def test_runtime_timeout_keeps_transport_and_requires_approval_unlock_and_neutral():
    async def scenario():
        inputs, seen, stop = Inputs(), {}, asyncio.Event()
        fail = [False]
        queries = []
        def query(_):
            queries.append(True)
            if fail[0]:
                raise subprocess.TimeoutExpired('fake-neighbor-query', .15)
            return MAC, []
        identity = inputs.mac_identity = MacIdentity(NIC_VALUE.name, MAC, inputs, query=query)
        tick = [0]
        def pulse():
            tick[0] += 1
            inputs.lowstate(low(tick[0], sn=(0, 0)))
            inputs.sportmodestate(sport(tick[0], error_code=100))
            seen['pulse'] = asyncio.get_running_loop().call_later(.01, pulse)
        pulse()
        def client_factory(session, gate, settings):
            class OfflineClient(Client):
                async def run(self):
                    self._emit(self.session.connect())
                    await stop.wait()
            seen['client'] = client = OfflineClient(session, gate, settings)
            return client
        recorder = NS(notice='', stopped=threading.Event(), start=lambda: None, close=lambda: None)
        status = Status()
        creds = replace(credentials(), robot_serial=identity.serial, identity_source='mac', robot_mac=MAC)
        task = asyncio.create_task(run(creds, NIC_VALUE, inputs, object(), ready=True,
            check_nic=lambda: True, status=status, stop=stop, client_factory=client_factory,
            connect=lambda *_: (FakeSport(), FakeSport()), sink_factory=OfflineSink,
            recorder_factory=lambda *a, **k: recorder, mapping_factory=lambda *a, **k: None,
            media_factory=lambda *a, **k: (_ for _ in ()).throw(RuntimeError('no camera'))))
        try:
            await until(lambda: 'client' in seen and seen['client'].session.connected)
            client = seen['client']
            session, gate = client.session, client.sink
            def frame(t, **kw):
                client._emit(session.receive(dict(t=t, **kw)))
            expiry = time.time()+60
            frame('field_approval', expires_at=expiry)
            await until(lambda: gate.active is not None)
            old_sink = gate.active.sink
            frame('stop', stop_ref=41)
            old_sink.check_watchdog()
            await until(lambda: session._state()['stop_ref'] == 41)
            frame('lease', lease_id='fake-lease', holder_type='USER')
            frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
            await until(lambda: not session.core.latch)
            frame('cmd', lease_id='fake-lease', seq=0, axes=[0, 0, 0])
            frame('cmd', lease_id='fake-lease', seq=1, axes=[1.5, 0, 0])
            assert old_sink.pending == (1.5, 0, 0) and not old_sink.latched
            fail[0] = True
            await until(lambda: gate.active is None)
            assert not identity.valid() and not identity.fault
            with pytest.raises(PermissionError):
                inputs.identity()
            assert session.connected and not task.done() and status.snapshot()['connected']
            assert status.snapshot()['mode'] == '로봇 확인 잠시 안 됨 · 이동 잠김'
            assert any(d['label'] == '로봇 확인 잠시 안 됨 · 이동 잠김'
                       for d in session.identity['devices'])
            assert old_sink.latched and old_sink.emergency_client.calls[-1] == ('StopMove', ())
            before = len(queries)
            fail[0] = False
            await until(identity.valid)
            assert len(queries) > before and session.core.latch and gate.active is None
            frame('cmd', lease_id='fake-lease', seq=0, axes=[1.5, 0, 0])
            assert session.core.latch and gate.active is None
            frame('field_approval', expires_at=expiry+1)
            await until(lambda: gate.active is not None)
            sink = gate.active.sink
            frame('stop', stop_ref=42)
            sink.check_watchdog()
            await until(lambda: session._state()['stop_ref'] == 42)
            frame('lease', lease_id='fake-lease', holder_type='USER')
            before = len(queries)
            frame('unlock', lease_id='fake-lease', stop_gen=session.core.stop_gen)
            await until(lambda: not session.core.latch)
            assert len(queries) > before  # ResumeGate queried the body again
            frame('cmd', lease_id='fake-lease', seq=1, axes=[1.5, 0, 0])
            assert sink.pending == (0, 0, 0)
            frame('cmd', lease_id='fake-lease', seq=2, axes=[0, 0, 0])
            frame('cmd', lease_id='fake-lease', seq=3, axes=[1.5, 0, 0])
            assert sink.pending == (1.5, 0, 0)
            assert session.connected and not task.done()
        finally:
            stop.set()
            seen['pulse'].cancel()
            await asyncio.wait_for(task, 2)
    asyncio.run(scenario())


def test_recovery_between_gate_ticks_cannot_keep_old_approval():
    from foothold_agent.go2_direct.feedback import Feedback
    from foothold_agent.setup.runtime import Gate, GatedSession
    inputs = Inputs()
    inputs.lowstate(low(1, sn=(0, 0)))
    fail = [False]
    def query(_):
        if fail[0]:
            raise TimeoutError('fake query')
        return MAC, []
    identity = inputs.mac_identity = MacIdentity(NIC_VALUE.name, MAC, inputs, query=query)
    identity.check()
    inputs.feedback = Feedback('0-0')
    inputs.lowstate(low(2, sn=(0, 0)))
    inputs.sportmodestate(sport(2))
    gate = Gate(NIC_VALUE, identity.serial, inputs, ready=True, nic_matches=lambda: True)
    session = GatedSession(inputs.feedback, gate)
    session.connect()
    session.receive(dict(t='field_approval', expires_at=time.time()+60))
    gate.activate(object(), connect=lambda *_: (FakeSport(), FakeSport()), sink_factory=OfflineSink)
    sink = gate.active.sink
    fail[0] = True
    with pytest.raises(TimeoutError):
        identity.verify_resume(None, '0-0')
    fail[0] = False
    identity.check()
    assert identity.valid()  # failure and recovery both occurred before gate.allowed()
    assert not gate.allowed() and gate.active is None
    assert session.connected and session.core.latch and session.lease_id is None
    assert sink.latched and sink.emergency_client.calls[-1] == ('StopMove', ())


def test_refresh_counts_executor_queue_time_as_transient(monkeypatch):
    async def scenario():
        now = Clock()
        monkeypatch.setattr('foothold_agent.setup.runtime.time', NS(monotonic=now))
        inputs = Inputs()
        inputs.lowstate(low(1, sn=(0, 0)))
        identity = MacIdentity(NIC_VALUE.name, MAC, inputs, query=lambda _: (MAC, []), now=now)
        async def queued(function, *args, **kwargs):
            now.value += .201
            inputs.lowstate(low(2, sn=(0, 0)))
            return function(*args, **kwargs)
        monkeypatch.setattr('foothold_agent.setup.identity.asyncio.to_thread', queued)
        with pytest.raises(PermissionError):
            await identity.refresh()
        assert not identity.fault and not identity.valid()
    asyncio.run(scenario())

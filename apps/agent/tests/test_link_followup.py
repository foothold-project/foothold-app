"""Follow-up boundaries; no changes to original Core expectations."""
import asyncio
import json
import time

import pytest

from foothold_agent.link.session import Session, Effects, MAX_BUFFER
from foothold_agent.link.client import Client, Outbox, Settings
from foothold_agent.safety.core import SCHEMA, Z


def test_offline_buffer_is_bounded_and_loss_is_counted():
    s = Session()
    s._event('SERVER_LINK_LOST')
    for n in range(1000):
        s._event('FAKE_HISTORY', number=n)
    assert len(s._messages) <= MAX_BUFFER
    result = s.connect()
    assert any(m.get('code') == 'SERVER_LINK_LOST' for m in result.messages)
    summary = next(m for m in result.messages if m.get('code') == 'LINK_BUFFER_DROPPED')
    history = [m for m in result.messages if m.get('code') == 'FAKE_HISTORY']
    assert summary['data']['count'] + len(history) == 1000
    assert len(result.messages) <= MAX_BUFFER + 2


@pytest.mark.parametrize('transition', ['transport_overflow', 'protocol_mismatch'])
def test_transport_failures_preserve_existing_wait_reason(transition):
    s = Session()
    s.run = {'run_id': 'r', 'status': 'PAUSED', 'step': 0, 'wait_reason': 'LINK_LOSS_TIMEOUT'}
    getattr(s, transition)()
    assert s.run['wait_reason'] == 'LINK_LOSS_TIMEOUT'
    assert s.core.latch and s.core.out == Z and not s.lease_confirmed


@pytest.mark.parametrize('field', ['x', 'sim_t', 'cmd_applied', 'episode'])
@pytest.mark.parametrize('value', [10**400, -(10**400)], ids=['huge-positive', 'huge-negative'])
def test_bridge_large_integers_never_enter_core_or_refresh_health(field, value):
    s = Session(lambda: 1)
    valid = {'schema': SCHEMA, 'episode': 1, 'stop_requested': True,
             'reset_in_progress': False, 'policy_running': True}
    s.on_robot_state(valid)
    before = s.core.state_seq
    bad = {**valid, field: [value, 0, 0] if field == 'cmd_applied' else value}
    try:
        s.on_robot_state(bad)
    except OverflowError:
        pytest.fail('link passed an overflowing bridge integer into Core')
    assert s.core.state_seq == before
    assert s.core.latch and s.core.out == Z
    assert any(m.get('code') == 'BRIDGE_STATE_INVALID' for m in s._messages)


def test_outbox_coalesces_telemetry_and_prioritizes_state_and_safety():
    async def check():
        q = Outbox()
        q.put_nowait({'t': 'hello'})
        for n in range(120):
            q.put_nowait({'t': 'event', 'code': 'FAKE_HISTORY', 'number': n})
        q.put_nowait({'t': 'event', 'code': 'LINK_LOSS_TIMEOUT'})
        for n in range(1000):
            q.put_nowait({'t': 'state', 'stop_ref': n})
            q.put_nowait({'t': 'cmd.ack', 'seq': n})
        assert len(q.frames) == 122 and len(q.telemetry) == 2
        assert (await q.get())['t'] == 'hello'
        assert (await q.get()).get('stop_ref') == 999
        assert (await q.get()).get('seq') == 999
        assert (await q.get())['code'] == 'LINK_LOSS_TIMEOUT'
        assert [(await q.get())['number'] for _ in range(120)] == list(range(120))
    asyncio.run(check())


def test_full_offline_buffer_recovers_on_first_connection_with_backpressure():
    from websockets.asyncio.server import serve
    async def check():
        s = Session()
        for n in range(255):
            s._event('FAKE_HISTORY', number=n)
        received, connections = [], []
        complete = asyncio.Event()
        async def server(ws):
            connections.append(ws)
            async for raw in ws:
                msg = json.loads(raw)
                received.append(msg)
                if sum(m.get('code') == 'FAKE_HISTORY' for m in received) == 255:
                    complete.set()
        class Sink:
            def apply(self, command):
                pass
        async with serve(server, '127.0.0.1', 0) as srv:
            c = Client(s, Sink(), Settings(f'ws://127.0.0.1:{srv.sockets[0].getsockname()[1]}', 'fake-token'))
            task = asyncio.create_task(c.run())
            try:
                try:
                    await asyncio.wait_for(complete.wait(), 2)
                except asyncio.TimeoutError:
                    pytest.fail('bounded offline history must drain on the first connection')
                assert len(connections) == 1 and not task.done()
                assert received[0]['t'] == 'hello' and received[1]['t'] == 'state'
                assert [m['data']['number'] for m in received if m.get('code') == 'FAKE_HISTORY'] == list(range(255))
                assert not any(m.get('code') == 'TRANSPORT_BACKPRESSURE' for m in received)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    asyncio.run(check())


def test_protocol_4406_stops_and_waits_at_least_30s_before_retry(monkeypatch):
    from websockets.asyncio.server import serve
    from foothold_agent.link import client as module
    async def check():
        waits, connections = [], []
        s = Session()
        real_sleep = asyncio.sleep
        async def sleep(delay):
            if delay >= 30:
                waits.append(delay)
                assert s.core.latch and s.core.out == Z and not s.lease_confirmed
                await real_sleep(.01)  # virtualize only the long protocol wait
            else:
                await real_sleep(delay)
        monkeypatch.setattr(module.asyncio, 'sleep', sleep)
        complete = asyncio.Event()
        async def server(ws):
            hello = json.loads(await ws.recv())
            connections.append(hello)
            if len(connections) == 1:
                await ws.close(4406, 'PROTOCOL_MISMATCH: expected fh-agent/2')
            else:
                complete.set()
                await ws.wait_closed()
        class Sink:
            def apply(self, command):
                pass
        async with serve(server, '127.0.0.1', 0) as srv:
            c = Client(s, Sink(), Settings(f'ws://127.0.0.1:{srv.sockets[0].getsockname()[1]}', 'fake-token'))
            task = asyncio.create_task(c.run())
            try:
                await asyncio.wait_for(complete.wait(), 2)
                assert waits == [30] and len(connections) == 2 and not task.done()
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    asyncio.run(check())


def test_failed_write_keeps_unsent_history_and_discards_old_telemetry():
    async def check():
        s = Session()
        q = Outbox()
        q.put_nowait({'t': 'event', 'code': 'FIRST'})
        q.put_nowait({'t': 'event', 'code': 'SECOND'})
        class Sink:
            def apply(self, command):
                pass
        class FailedSocket:
            async def send(self, raw):
                raise OSError('fake unavailable socket')
        c = Client(s, Sink(), Settings('ws://127.0.0.1:1', 'fake-token'))
        with pytest.raises(OSError):
            await c._writer(FailedSocket(), q)
        q.put_nowait({'t': 'state', 'stop_ref': 999})
        q.put_nowait({'t': 'cmd.ack', 'seq': 999})
        s._event('NEW_DISCONNECT_EVENT')
        s.restore(q.unsent())
        restored = s.connect().messages
        assert [m['code'] for m in restored if m['t'] == 'event'] == ['FIRST', 'SECOND', 'NEW_DISCONNECT_EVENT']
        assert not any(m.get('seq') == 999 or m.get('stop_ref') == 999 for m in restored)
    asyncio.run(check())

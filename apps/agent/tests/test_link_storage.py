"""Gated storage regressions: sink output, watchdog and bounded admission."""
import asyncio
import threading

import pytest

from foothold_agent.link.client import Client, Settings
from foothold_agent.link.session import Session, MAX_BUFFER
from foothold_agent.safety.core import SCHEMA, Z


def running(clock):
    s = Session(lambda: clock[0])
    s.connect()
    s.emit_history = False
    s.receive({'t': 'lease', 'lease_id': 'old', 'holder_type': 'RUN:r'})
    s.receive({'t': 'run.start', 'run_id': 'r', 'plan': {'segments': []}, 'missions': {}})
    bridge = {'schema': SCHEMA, 'episode': 0, 'stop_requested': True,
              'reset_in_progress': False, 'policy_running': True}
    s.on_robot_state(bridge)
    s.receive({'t': 'unlock', 'lease_id': 'old', 'stop_gen': s.core.stop_gen})
    s.on_robot_state({**bridge, 'stop_requested': False})
    s.executor_command('r', [0, 0, 0])
    s.executor_command('r', [1, 0, 0])
    assert s.core.out != Z
    s.pop_history(MAX_BUFFER)
    for n in range(MAX_BUFFER - 1):
        s._event('SERVER_LINK_LOST', number=n)
    return s, bridge


def blocked_disk(history, order):
    entered, release = threading.Event(), threading.Event()
    actual = history._disk()
    class Gate:
        def execute(self, sql, *args):
            if sql.startswith('INSERT'):
                order.append('insert')
                entered.set()
                release.wait(5)
            return actual.execute(sql, *args)
        def close(self):
            actual.close()
    history.spill = Gate()
    return entered, release


async def close_history(history, release):
    release.set()
    history.close()
    assert await asyncio.to_thread(history.io.closed.wait, 3)
    await asyncio.to_thread(history._close_disk)


@pytest.mark.parametrize('stop_at', [0.0, 3.1])
def test_stop_and_watchdog_precede_gated_file_io(monkeypatch, stop_at):
    async def check():
        clock, order = [0.0], []
        s, _ = running(clock)
        entered, release = blocked_disk(s._messages, order)
        class Sink:
            def apply(self, command):
                order.append(command.kind)
        c = Client(s, Sink(), Settings('ws://127.0.0.1:1', 'fake-token'))
        submit = s._messages.io.submit
        def scheduled(operation, *args, **kwargs):
            submit(operation, *args, **kwargs)
            if operation == 'insert':
                assert entered.wait(1)  # force worker start before the caller resumes
        monkeypatch.setattr(s._messages.io, 'submit', scheduled)
        task = None
        try:
            clock[0] = stop_at  # include already-due link/executor transitions
            c._emit(s.receive({'t': 'stop', 'stop_ref': 1, 'by_user_id': None}))
            assert await asyncio.to_thread(entered.wait, 1)
            assert order.index('stop') < order.index('insert')
            assert order.index('apply') < order.index('insert')
            assert not release.is_set()
            # A held INSERT must not stop the executor/link clocks or 20Hz loop.
            ticks, progressed = [0], asyncio.Event()
            original = s.tick
            def tick():
                ticks[0] += 1
                if ticks[0] >= 3:
                    progressed.set()
                return original()
            s.tick = tick
            clock[0] = stop_at + 3.1
            task = asyncio.create_task(c._watchdog())
            await asyncio.wait_for(progressed.wait(), 1)
            assert s.run['status'] == 'FAILED' and s.link_lost
            assert s.core.latch and s.core.applied() == Z
            assert not release.is_set()
            release.set()
            await asyncio.wait_for(s._messages.writable(), 2)
            records = await s._messages.snapshot()
            assert [m['data']['number'] for m in records if 'number' in m.get('data', {})] == list(range(MAX_BUFFER - 1))
        finally:
            if task:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            await close_history(s._messages, release)
    asyncio.run(check())


def test_storage_pressure_reserves_unsent_history_and_never_auto_unlocks(monkeypatch):
    async def check():
        import websockets.asyncio.client as ws_client
        clock, order = [0.0], []
        s, bridge = running(clock)
        entered, release = blocked_disk(s._messages, order)
        commands = []
        class Sink:
            def apply(self, command):
                commands.append(command)
        c = Client(s, Sink(), Settings('ws://127.0.0.1:1', 'fake-token'))
        connected = asyncio.Event()
        class Connection:
            async def __aenter__(self):
                connected.set()
                await asyncio.Event().wait()
            async def __aexit__(self, *_):
                pass
        monkeypatch.setattr(ws_client, 'connect', lambda *a, **k: Connection())
        network = None
        try:
            for n in range(63):
                s._event('SERVER_LINK_LOST', number=255 + n)
            assert await asyncio.to_thread(entered.wait, 1)
            assert s._messages.io.pending == 63 and not c.storage_blocked
            s._event('SERVER_LINK_LOST', number=318)
            assert c.storage_blocked and s.core.latch and s.core.applied() == Z
            assert not s.lease_confirmed and s.lease_id is None
            assert any(x.kind == 'stop' for x in commands)
            # Reserve covers a failed in-flight write and all 128 outbox frames.
            s.restore([{'t': 'event', 'code': 'SERVER_LINK_LOST', 'data': {'restored': n}} for n in range(129)])
            pending = s._messages.io.pending
            for _ in range(1000):
                c.on_robot_state({'episode': 10**400})  # declined while admission is closed
            assert s._messages.io.pending == pending <= 256
            assert len(s._messages.memory) <= 255
            network = asyncio.create_task(c._network())
            await asyncio.sleep(0)
            assert not connected.is_set()
            release.set()
            await asyncio.wait_for(connected.wait(), 3)
            assert s.core.latch and s.core.applied() == Z and not s.lease_confirmed
            assert not any(x.kind == 'unlock' or x.velocity != Z for x in commands)
            # Recovery permits a new transport, never a motion/lease replay.
            c._emit(s.connect())
            c._emit(s.receive({'t': 'lease', 'lease_id': 'new', 'holder_type': 'USER'}))
            c.on_robot_state(bridge)
            c._emit(s.receive({'t': 'unlock', 'lease_id': 'new', 'stop_gen': s.core.stop_gen}))
            c.on_robot_state({**bridge, 'stop_requested': False})
            c._emit(s.receive({'t': 'cmd', 'lease_id': 'new', 'seq': 0, 'axes': [0, 0, 0]}))
            c._emit(s.receive({'t': 'cmd', 'lease_id': 'new', 'seq': 1, 'axes': [1, 0, 0]}))
            assert s.core.out != Z
        finally:
            if network:
                network.cancel()
                await asyncio.gather(network, return_exceptions=True)
            await close_history(s._messages, release)
    asyncio.run(check())


def test_file_wait_does_not_occupy_the_watchdog_event_loop():
    async def check():
        clock, order = [0.0], []
        s, _ = running(clock)
        entered, release = blocked_disk(s._messages, order)
        progressed, missed = threading.Event(), threading.Event()
        class Sink:
            def apply(self, command):
                pass
        c = Client(s, Sink(), Settings('ws://127.0.0.1:1', 'fake-token'))
        original, ticks = s.tick, [0]
        def tick():
            ticks[0] += 1
            if ticks[0] >= 3:
                progressed.set()
            return original()
        s.tick = tick
        def unblock():
            if entered.wait(1):
                clock[0] = .4
                if not progressed.wait(3):
                    missed.set()
            release.set()
        helper = threading.Thread(target=unblock)
        helper.start()
        watchdog = asyncio.create_task(c._watchdog())
        try:
            c._emit(s.receive({'t': 'stop', 'stop_ref': 1}))
            assert await asyncio.to_thread(progressed.wait, 4)
            await asyncio.to_thread(helper.join, 1)
            assert not missed.is_set(), 'The file wait prevented the watchdog from executing'
            assert s.core.latch and s.core.applied() == Z
        finally:
            release.set()
            watchdog.cancel()
            await asyncio.gather(watchdog, return_exceptions=True)
            await asyncio.to_thread(helper.join, 1)
            await close_history(s._messages, release)
    asyncio.run(check())


def test_server_archive_limit_stops_before_waiting_for_writer_cancellation(monkeypatch):
    from websockets.exceptions import ConnectionClosed
    from websockets.frames import Close
    from websockets.asyncio import client as ws_client
    async def check():
        canceled, release = asyncio.Event(), asyncio.Event()
        s, _ = running([0.0])
        # No spill is needed to reproduce a transport that stalls during teardown.
        s.pop_history(MAX_BUFFER)
        commands = []
        class Sink:
            def apply(self, command):
                commands.append(command)
        class Socket:
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
        c = Client(s, Sink(), Settings('ws://127.0.0.1:1', 'fake-token'))
        async def reader(ws):
            # connect() clears old authority; emulate a fresh running lease.
            active, _ = running([0.0])
            active.pop_history(MAX_BUFFER)
            c.session = active
            active.before_history = c._before_history
            c._ensure_history()
            assert active.core.out != Z
            await asyncio.sleep(0)
            raise ConnectionClosed(Close(1013, 'ROBOT_ARCHIVE_LIMIT'), Close(1013, 'ROBOT_ARCHIVE_LIMIT'), True)
        async def writer(ws, queue):
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                canceled.set()
                await release.wait()
        monkeypatch.setattr(ws_client, 'connect', lambda *a, **kw: Socket())
        monkeypatch.setattr(c, '_reader', reader)
        monkeypatch.setattr(c, '_writer', writer)
        task = asyncio.create_task(c._network())
        try:
            await asyncio.wait_for(canceled.wait(), 1)
            assert c.storage_blocked and c.session.core.latch and c.session.core.applied() == Z
            assert not c.session.lease_confirmed and c.session.lease_id is None
            assert any(x.kind == 'stop' for x in commands) and commands[-1].velocity == Z
        finally:
            release.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            for history in (s._messages, c.session._messages):
                history.close()
    asyncio.run(check())


def test_spill_file_has_enforced_eight_mib_limit():
    import sqlite3
    from pathlib import Path
    from foothold_agent.link.history import History
    h = History(0, lambda _: True)
    try:
        full = False
        try:
            h.append(b'x' * (9 * 1024 * 1024))
        except sqlite3.OperationalError as error:
            full = 'full' in str(error).lower()
        assert full, 'SQLite must enforce the physical file ceiling'
        assert (Path(h.file.name) / 'history.sqlite').stat().st_size <= 8 * 1024 * 1024
    finally:
        h.close()

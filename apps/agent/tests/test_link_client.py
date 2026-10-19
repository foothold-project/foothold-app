"""Only fake same-process WS servers on 127.0.0.1, OS-selected ports."""

import asyncio
from contextlib import suppress
import json
import time

import pytest

from foothold_agent.link.client import Client, LocalPortError, Settings
from foothold_agent.link.session import Session
from foothold_agent.safety.core import SCHEMA, Z

websockets = pytest.importorskip("websockets", reason="install the agent [link] extra for WS tests")
from websockets.asyncio.server import serve


class FakeMotionSink:
    def __init__(self):
        self.commands = []

    def apply(self, command):
        self.commands.append((time.monotonic(), command))


class FakeExecutor:
    def __init__(self, axes=Z):
        self.axes = axes
        self.calls = 0

    def poll(self, run):
        self.calls += 1
        return self.axes


def state(session, stop=False):
    session.on_robot_state({"schema": SCHEMA, "episode": 0, "stop_requested": stop,
                           "reset_in_progress": False, "policy_running": True})


async def until_message(ws, kind):
    async def read():
        while True:
            msg = json.loads(await ws.recv())
            if msg["t"] == kind:
                return msg
    return await asyncio.wait_for(read(), 2)


async def cancel(task):
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


def test_fake_server_header_handoff_ack_stop_before_hello_reconnect():
    async def scenario():
        sink = FakeMotionSink()
        session = Session(time.monotonic)
        completed = asyncio.get_running_loop().create_future()
        connections = []

        async def server(ws):
            try:
                connections.append(ws)
                assert ws.request.headers["Authorization"] == "Bearer fake-test-token"
                assert ws.subprotocol is None
                assert "Sec-WebSocket-Protocol" not in ws.request.headers
                hello = await until_message(ws, "hello")
                assert sink.commands[-1][1].velocity == Z
                assert any(c.kind == "stop" for _, c in sink.commands)
                assert hello["latched"] and hello["proto"] == "fh-agent/1"
                if len(connections) == 1:
                    await until_message(ws, "state")  # consume startup snapshot
                    await ws.send(json.dumps({"t": "lease", "lease_id": "lease-a", "holder_type": "USER"}))
                    await until_message(ws, "state")
                    state(session, True)
                    await ws.send(json.dumps({"t": "unlock", "lease_id": "lease-a", "stop_gen": session.core.stop_gen}))
                    await until_message(ws, "state")
                    state(session, False)
                    for seq, axes in ((1, [0, 0, 0]), (2, [1, 0, 0])):
                        await ws.send(json.dumps({"t": "cmd", "lease_id": "lease-a", "seq": seq, "axes": axes}))
                    ack = await until_message(ws, "cmd.ack")
                    assert ack["seq"] == 2 and ack["applied"] == [0.6, 0, 0]
                    await ws.send(json.dumps({"t": "lease", "lease_id": None, "holder_type": None}))
                    revoked = await until_message(ws, "state")
                    assert revoked["applied"] == [0, 0, 0]
                    gen = revoked["stop_gen"]
                    started = time.monotonic()
                    await ws.send(json.dumps({"t": "stop", "by_user_id": "viewer"}))
                    stopped = await until_message(ws, "state")
                    assert time.monotonic() - started < 2
                    assert stopped["latched"] and stopped["stop_gen"] > gen
                    assert stopped["applied"] == [0, 0, 0]
                    assert sink.commands[-1][1].velocity == Z
                    await ws.send(json.dumps({"t": "lease", "lease_id": "lease-b", "holder_type": "USER"}))
                    await until_message(ws, "state")
                    await ws.close()
                else:
                    assert hello["lease_id"] == "lease-b"
                    assert session.core.need_neutral and session.core.latch
                    completed.set_result(True)
                    await ws.wait_closed()
            except Exception as exc:
                if not completed.done():
                    completed.set_exception(exc)

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            task = asyncio.create_task(Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/agent/ws", "fake-test-token", 0.01, 0.04)).run())
            try:
                await asyncio.wait_for(completed, 5)
            finally:
                await cancel(task)
        assert sink.commands[-1][1].velocity == Z and session.core.latch

    asyncio.run(scenario())


def test_watchdog_continues_during_failed_handshake_and_retry_backoff():
    async def scenario():
        sink = FakeMotionSink()
        session = Session(time.monotonic)
        got_handshake = asyncio.Event()
        release = asyncio.Event()

        async def blackhole(reader, writer):
            got_handshake.set()
            try:
                await release.wait()  # no WS handshake response
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(blackhole, "127.0.0.1", 0)
        async with server:
            port = server.sockets[0].getsockname()[1]
            task = asyncio.create_task(Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/agent/ws", "fake-test-token")).run())
            try:
                await asyncio.wait_for(got_handshake.wait(), 1)
                before = len(sink.commands)
                await asyncio.sleep(0.36)
                assert len(sink.commands) - before >= 5
                assert all(c.velocity == Z for _, c in sink.commands)
            finally:
                await cancel(task)
                release.set()
    asyncio.run(scenario())


def test_deadman_runs_while_reader_waits_and_ping_cannot_keep_cmd_alive():
    async def scenario():
        sink = FakeMotionSink()
        session = Session(time.monotonic)
        completed = asyncio.get_running_loop().create_future()

        async def server(ws):
            try:
                await until_message(ws, "hello")
                await until_message(ws, "state")
                await ws.send(json.dumps({"t": "lease", "lease_id": "a", "holder_type": "USER"}))
                await until_message(ws, "state")
                state(session, True)
                await ws.send(json.dumps({"t": "unlock", "lease_id": "a", "stop_gen": session.core.stop_gen}))
                await until_message(ws, "state")
                state(session)
                for seq, axes in ((1, [0, 0, 0]), (2, [1, 0, 0])):
                    await ws.send(json.dumps({"t": "cmd", "lease_id": "a", "seq": seq, "axes": axes}))
                ack = await until_message(ws, "cmd.ack")
                assert ack["applied"] == [0.6, 0, 0]
                for _ in range(9):
                    await ws.send(json.dumps({"t": "ping"}))
                    state(session)
                    await asyncio.sleep(0.05)
                assert sink.commands[-1][1].velocity == Z
                assert not session.core.latch and session.core.need_neutral
                completed.set_result(True)
                await ws.wait_closed()
            except Exception as exc:
                if not completed.done():
                    completed.set_exception(exc)

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            task = asyncio.create_task(Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/agent/ws", "fake-test-token")).run())
            try:
                await asyncio.wait_for(completed, 4)
            finally:
                await cancel(task)
    asyncio.run(scenario())


def test_writer_backpressure_cannot_suspend_watchdog_or_restart_motion():
    async def scenario():
        from foothold_agent.link.client import Client

        class BlockedWriter:
            async def send(self, message):
                await asyncio.Event().wait()

        session = Session(time.monotonic)
        sink = FakeMotionSink()
        client = Client(session, sink, Settings("ws://127.0.0.1:1", "fake-test-token"))
        queue = asyncio.Queue()
        queue.put_nowait({"t": "state"})
        watchdog = asyncio.create_task(client._watchdog())
        writer = asyncio.create_task(client._writer(BlockedWriter(), queue))
        try:
            with pytest.raises(asyncio.TimeoutError):
                await writer
            assert len(sink.commands) >= 3
        finally:
            await cancel(watchdog)
    asyncio.run(scenario())


def test_executor_fake_is_local_zero_heartbeat_and_disconnect_doesnt_retry_unlock():
    async def scenario():
        session = Session(time.monotonic)
        sink = FakeMotionSink()
        fake = FakeExecutor()
        session.connect()
        session.receive({"t": "lease", "lease_id": "a", "holder_type": "RUN"})
        session.receive({"t": "run.start", "run_id": "r", "plan": {"segments": []}, "missions": {}})
        client = Client(session, sink, Settings("ws://127.0.0.1:1", "fake-test-token"), fake)
        task = asyncio.create_task(client._watchdog())
        try:
            await asyncio.sleep(0.4)
            assert fake.calls >= 6 and session.run["status"] == "RUNNING"
            assert all(c.velocity == Z for _, c in sink.commands)
            assert not any(c.kind == "unlock" for _, c in sink.commands)
        finally:
            await cancel(task)
    asyncio.run(scenario())


def test_local_sink_oserror_is_fatal_and_zero_is_attempted():
    async def scenario():
        class FailedSink(FakeMotionSink):
            def apply(self, command):
                super().apply(command)
                raise OSError("fake local output failure")
        session = Session(time.monotonic)
        sink = FailedSink()
        async with serve(lambda ws: ws.wait_closed(), "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            client = Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/agent/ws", "fake-test-token"))
            with pytest.raises(LocalPortError):
                await asyncio.wait_for(client.run(), 1)
        assert session.core.latch and sink.commands[-1][1].velocity == Z
    asyncio.run(scenario())


def test_env_only_settings_secret_repr_and_validation(monkeypatch):
    monkeypatch.delenv("FOOTHOLD_AGENT_WS_URL", raising=False)
    monkeypatch.delenv("FOOTHOLD_AGENT_TOKEN", raising=False)
    with pytest.raises(ValueError, match="set FOOTHOLD"):
        Settings.from_env()
    monkeypatch.setenv("FOOTHOLD_AGENT_WS_URL", "wss://example.invalid/agent/ws")
    monkeypatch.setenv("FOOTHOLD_AGENT_TOKEN", "fake-test-token")
    config = Settings.from_env()
    assert "fake-test-token" not in repr(config) and "example.invalid" not in repr(config)
    for url in ("http://example.invalid", "ws://example.invalid/agent/ws",
                "wss://a:b@example.invalid/agent/ws", "wss://example.invalid?token=secret"):
        with pytest.raises(ValueError):
            Settings(url, "fake-test-token")
    for token in ("", "fake\r\nheader", "has space"):
        with pytest.raises(ValueError):
            Settings("wss://example.invalid/agent/ws", token)


@pytest.mark.parametrize("via_close", [False, True])
def test_protocol_mismatch_response_or_close_latches_before_reconnect(via_close):
    async def scenario():
        session = Session(time.monotonic)
        sink = FakeMotionSink()
        completed = asyncio.get_running_loop().create_future()
        attempts = 0
        first_gen = 0

        async def server(ws):
            nonlocal attempts, first_gen
            try:
                attempts += 1
                hello = await until_message(ws, "hello")
                assert hello["proto"] == "fh-agent/1"
                if attempts == 1:
                    first_gen = session.core.stop_gen
                    if via_close:
                        await ws.close(4000, json.dumps({"proto": "fh-agent/2"}))
                    else:
                        await ws.send(json.dumps({"t": "error", "proto": "fh-agent/2"}))
                        await ws.wait_closed()
                else:
                    assert hello["stop_gen"] >= first_gen + 2  # mismatch STOP, then reconnect STOP
                    assert hello["latched"] and session.core.need_neutral
                    assert sink.commands[-1][1].velocity == Z
                    completed.set_result(True)
                    await ws.wait_closed()
            except Exception as exc:
                if not completed.done():
                    completed.set_exception(exc)

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            client = Client(session, sink, Settings(f"ws://127.0.0.1:{port}/agent/ws",
                                                  "fake-test-token", 0.02, 0.08))
            task = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(completed, 3)
            finally:
                await cancel(task)
        assert attempts >= 2
    asyncio.run(scenario())


def test_exponential_backoff_against_same_process_rejecting_server():
    async def scenario():
        from websockets.http11 import Response
        from websockets.datastructures import Headers

        session = Session(time.monotonic)
        sink = FakeMotionSink()
        completed = asyncio.Event()
        times = []

        async def reject(connection, request):
            times.append(time.monotonic())
            if len(times) >= 5:
                completed.set()
            return Response(503, "Unavailable", Headers(), b"")

        async with serve(lambda ws: ws.wait_closed(), "127.0.0.1", 0,
                         process_request=reject) as srv:
            port = srv.sockets[0].getsockname()[1]
            task = asyncio.create_task(Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/agent/ws", "fake-test-token", 0.02, 0.08)).run())
            try:
                await asyncio.wait_for(completed.wait(), 3)
            finally:
                await cancel(task)
        gaps = [b - a for a, b in zip(times, times[1:])]
        # Broad lower bounds tolerate host scheduling while distinguishing each step.
        assert all(gap >= expected for gap, expected in zip(gaps, (0.018, 0.038, 0.078, 0.078)))
        assert len(sink.commands) >= 3 and all(c.velocity == Z for _, c in sink.commands)
    asyncio.run(scenario())

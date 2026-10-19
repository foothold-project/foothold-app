"""Only fake same-process WS servers on 127.0.0.1, OS-selected ports."""

import asyncio
from contextlib import suppress
import json
import time

import pytest

from foothold_agent.link.client import Client, LocalPortError, Settings
from foothold_agent.link.session import Effects, Session
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
        session.receive({"t": "lease", "lease_id": "a", "holder_type": "RUN:r"})
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


def test_cancel_while_moving_requests_stop_zero_and_latch():
    async def scenario():
        session = Session(time.monotonic)
        sink = FakeMotionSink()
        moving = asyncio.Event()
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
                moving.set()
                await ws.wait_closed()
                completed.set_result(True)
            except Exception as exc:
                if not completed.done():
                    completed.set_exception(exc)

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            task = asyncio.create_task(Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/api/v1/agent/ws", "fake-test-token")).run())
            try:
                await asyncio.wait_for(moving.wait(), 3)
                count = len(sink.commands)
                await cancel(task)
                after = [c for _, c in sink.commands[count:]]
                assert any(c.kind == "stop" for c in after)
                assert after[-1].velocity == Z and session.core.latch
                assert not session.connected
                await asyncio.wait_for(completed, 1)
            finally:
                if not task.done():
                    await cancel(task)
    asyncio.run(scenario())


def test_queue_overflow_reconnects_instead_of_terminating_client():
    async def scenario():
        session = Session(time.monotonic)
        sink = FakeMotionSink()
        completed = asyncio.get_running_loop().create_future()
        attempts = 0
        initial_gen = 0

        async def server(ws):
            nonlocal attempts, initial_gen
            try:
                attempts += 1
                hello = await until_message(ws, "hello")
                assert hello["latched"]
                if attempts == 1:
                    await until_message(ws, "state")
                    # Enter real Session motion through its normal local/remote
                    # ports, synchronously so no writer can drain during saturation.
                    client._emit(session.receive({"t": "lease", "lease_id": "a", "holder_type": "USER"}))
                    client.on_robot_state({"schema": SCHEMA, "episode": 0,
                        "stop_requested": True, "reset_in_progress": False, "policy_running": True})
                    client._emit(session.receive({"t": "unlock", "lease_id": "a", "stop_gen": session.core.stop_gen}))
                    client.on_robot_state({"schema": SCHEMA, "episode": 0,
                        "stop_requested": False, "reset_in_progress": False, "policy_running": True})
                    for seq, axes in ((1, [0, 0, 0]), (2, [1, 0, 0])):
                        client._emit(session.receive({"t": "cmd", "lease_id": "a", "seq": seq, "axes": axes}))
                    assert sink.commands[-1][1].velocity == (0.6, 0, 0)
                    initial_gen = session.core.stop_gen
                    # Deterministically saturate this connection's bounded queue
                    # in one event-loop callback, without waiting for OS buffers.
                    while not client._outgoing.full():
                        client._outgoing.put_nowait({"t": "state"})
                    count = len(sink.commands)
                    client._emit(Effects((), ({"t": "state"},)))
                    after = [c for _, c in sink.commands[count:]]
                    assert any(c.kind == "stop" for c in after)
                    assert after[-1].velocity == Z and session.core.latch
                    assert not task.done()
                    # Drain the old socket so its bounded inbound queue cannot
                    # delay processing the close handshake.
                    async for _ in ws:
                        pass
                else:
                    assert hello["stop_gen"] >= initial_gen + 2
                    assert sink.commands[-1][1].velocity == Z
                    assert not task.done()
                    completed.set_result(True)
                    await ws.wait_closed()
            except Exception as exc:
                if not completed.done():
                    completed.set_exception(exc)

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            client = Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/api/v1/agent/ws", "fake-test-token", 0.01, 0.04))
            task = asyncio.create_task(client.run())
            try:
                await asyncio.wait_for(completed, 3)
                assert attempts >= 2 and not task.done()
            finally:
                await cancel(task)
    asyncio.run(scenario())


@pytest.mark.parametrize("zero_also_fails", [False, True])
def test_stop_failure_still_attempts_apply_zero_and_preserves_first_error(zero_also_fails):
    from foothold_agent.link.session import MotionCommand

    class SelectiveSink(FakeMotionSink):
        velocity = (0.6, 0, 0)

        def __init__(self):
            super().__init__()
            self.original_error = OSError("first stop failed")

        def apply(self, command):
            super().apply(command)
            if command.kind == "stop":
                raise self.original_error
            if zero_also_fails:
                raise RuntimeError("later apply failed")
            self.velocity = command.velocity

    session = Session()
    sink = SelectiveSink()
    client = Client(session, sink, Settings("ws://127.0.0.1:1", "fake-test-token"))
    with pytest.raises(LocalPortError) as caught:
        client._emit(session.shutdown())
    assert [c.kind for _, c in sink.commands] == ["stop", "apply"]
    assert sink.commands[-1][1] == MotionCommand(velocity=Z)
    assert caught.value.__cause__ is sink.original_error
    if not zero_also_fails:
        assert sink.velocity == Z


def test_run_shutdown_preserves_initial_output_error_and_still_applies_zero(monkeypatch):
    async def scenario():
        from foothold_agent.link.session import MotionCommand

        class StopFails(FakeMotionSink):
            def apply(self, command):
                super().apply(command)
                if command.kind == "stop":
                    raise OSError("subsequent shutdown stop failed")

        original = OSError("original output error")
        sink = StopFails()
        session = Session()
        client = Client(session, sink, Settings("ws://127.0.0.1:1", "fake-test-token"))

        async def failing_watchdog():
            sink.apply(MotionCommand(velocity=(0.6, 0, 0)))
            raise LocalPortError("initial failure") from original

        async def idle_network():
            await asyncio.Event().wait()

        monkeypatch.setattr(client, "_watchdog", failing_watchdog)
        monkeypatch.setattr(client, "_network", idle_network)
        with pytest.raises(LocalPortError) as caught:
            await client.run()
        assert caught.value.__cause__ is original
        assert any(c.kind == "apply" and c.velocity == Z for _, c in sink.commands)
    asyncio.run(scenario())


@pytest.mark.parametrize("durations,expected", [
    ([1.2, 1.2, 1.2], [0.25, 0.5, 1.0]),
    ([1.2, 3.1, 1.2], [0.25, 0.25, 0.5]),
])
def test_backoff_reset_measures_connected_time_not_handshake(monkeypatch, durations, expected):
    async def scenario():
        import websockets.asyncio.client as ws_client

        now = [0.0]
        waits = []
        attempt = [0]
        session = Session(lambda: now[0])
        client = Client(session, FakeMotionSink(), Settings("ws://127.0.0.1:1", "fake-test-token", 0.25, 8))

        class Done(Exception):
            pass

        class FakeSocket:
            async def send(self, message):
                pass

        class SlowHandshake:
            async def __aenter__(self):
                now[0] += 2  # handshake time must never count as connected time
                return FakeSocket()

            async def __aexit__(self, *args):
                pass

        async def reader(ws):
            now[0] += durations[attempt[0]]
            attempt[0] += 1

        async def sleep(delay):
            waits.append(delay)
            now[0] += delay
            if len(waits) == 3:
                raise Done

        monkeypatch.setattr(ws_client, "connect", lambda *args, **kw: SlowHandshake())
        monkeypatch.setattr(client, "_reader", reader)
        monkeypatch.setattr(asyncio, "sleep", sleep)
        with pytest.raises(Done):
            await client._network()
        assert waits == expected
    asyncio.run(scenario())


def test_huge_integer_frame_is_discarded_and_websocket_client_keeps_running():
    async def scenario():
        session = Session()
        sink = FakeMotionSink()
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
                assert (await until_message(ws, "cmd.ack"))["applied"] == [0.6, 0, 0]
                await ws.send(json.dumps({"t": "cmd", "lease_id": "a", "seq": 3,
                                          "axes": [10**400, 0, 0]}))
                ack = await until_message(ws, "cmd.ack")
                assert ack["seq"] == 3 and ack["applied"] == [0, 0, 0]
                assert not task.done() and not session.core.latch
                for seq, axes in ((4, [0, 0, 0]), (5, [1, 0, 0])):
                    await ws.send(json.dumps({"t": "cmd", "lease_id": "a", "seq": seq, "axes": axes}))
                assert (await until_message(ws, "cmd.ack"))["applied"] == [0.6, 0, 0]
                completed.set_result(True)
                await ws.wait_closed()
            except Exception as exc:
                if not completed.done():
                    completed.set_exception(exc)

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            task = asyncio.create_task(Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/api/v1/agent/ws", "fake-test-token")).run())
            try:
                await asyncio.wait_for(completed, 3)
            finally:
                await cancel(task)
    asyncio.run(scenario())


def test_disconnect_output_failure_is_not_hidden_by_transport_error(monkeypatch):
    async def scenario():
        import websockets.asyncio.client as ws_client

        class Sink(FakeMotionSink):
            armed = False

            def __init__(self):
                super().__init__()
                self.errors = []

            def apply(self, command):
                super().apply(command)
                if self.armed and command.kind == "stop":
                    exc = OSError("stop failure during disconnect")
                    self.errors.append(exc)
                    raise exc

        class FakeConnection:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def send(self, message):
                pass

        sink = Sink()
        client = Client(Session(), sink, Settings("ws://127.0.0.1:1", "fake-test-token"))

        async def broken_reader(ws):
            sink.armed = True
            raise ConnectionResetError("transport disconnected")

        monkeypatch.setattr(ws_client, "connect", lambda *args, **kw: FakeConnection())
        monkeypatch.setattr(client, "_reader", broken_reader)
        with pytest.raises(LocalPortError) as caught:
            await asyncio.wait_for(client.run(), 1)
        assert caught.value.__cause__ is sink.errors[0]
        assert any(c.kind == "apply" and c.velocity == Z for _, c in sink.commands)
    asyncio.run(scenario())


def test_nonzero_apply_failure_alone_attempts_zero_without_shutdown():
    from foothold_agent.link.session import MotionCommand

    class Sink(FakeMotionSink):
        def apply(self, command):
            super().apply(command)
            if command.velocity != Z:
                raise OSError("nonzero apply failed")

    sink = Sink()
    client = Client(Session(), sink, Settings("ws://127.0.0.1:1", "fake-test-token"))
    with pytest.raises(LocalPortError):
        client._emit(Effects((MotionCommand(velocity=(0.6, 0, 0)),)))
    assert [c.velocity for _, c in sink.commands] == [(0.6, 0, 0), Z]
    assert all(c.kind == "apply" for _, c in sink.commands)


def test_cancelled_error_retains_shutdown_sink_failure_trace(monkeypatch):
    async def scenario():
        from foothold_agent.link.session import MotionCommand

        class Sink(FakeMotionSink):
            error = OSError("stop failed during cancellation")

            def apply(self, command):
                super().apply(command)
                if command.kind == "stop":
                    raise self.error

        ready = asyncio.Event()
        sink = Sink()
        client = Client(Session(), sink, Settings("ws://127.0.0.1:1", "fake-test-token"))

        async def moving_watchdog():
            sink.apply(MotionCommand(velocity=(0.6, 0, 0)))
            ready.set()
            await asyncio.Event().wait()

        async def idle_network():
            await asyncio.Event().wait()

        monkeypatch.setattr(client, "_watchdog", moving_watchdog)
        monkeypatch.setattr(client, "_network", idle_network)
        task = asyncio.create_task(client.run())
        await ready.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError) as caught:
            await task
        errors = getattr(caught.value, "output_errors", ())
        assert errors and errors[0].__cause__ is sink.error
        if hasattr(caught.value, "add_note"):
            assert caught.value.__notes__
        assert any(c.kind == "apply" and c.velocity == Z for _, c in sink.commands)
    asyncio.run(scenario())


@pytest.mark.parametrize("close_code", [4401, 4403])
def test_authorization_close_is_terminal_and_stops_without_reconnect(close_code):
    async def scenario():
        session = Session()
        sink = FakeMotionSink()
        attempts = []

        async def server(ws):
            attempts.append(ws)
            await until_message(ws, "hello")
            await ws.close(close_code, "access refused")

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            client = Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/api/v1/agent/ws", "fake-test-token", 0.01, 0.04))
            # A terminal authorization close must finish, rather than loop until
            # this timeout or require us to cancel the client.
            try:
                await asyncio.wait_for(client.run(), 0.5)
            except asyncio.TimeoutError:
                pytest.fail("authorization close retried instead of ending")
            except RuntimeError as exc:
                assert getattr(exc, "close_code", None) == close_code
            else:
                pytest.fail("terminal close must report its reason to the caller")
        assert len(attempts) == 1
        assert session.core.latch and sink.commands[-1][1].velocity == Z
    asyncio.run(scenario())


def test_second_hello_1012_reconnects_and_records_close_and_backoff():
    async def scenario():
        clock = [0.0]
        session = Session(lambda: clock[0])
        sink = FakeMotionSink()
        completed = asyncio.get_running_loop().create_future()
        attempts = 0

        async def server(ws):
            nonlocal attempts
            try:
                attempts += 1
                await until_message(ws, "hello")
                if attempts == 1:
                    clock[0] = 3.01
                    await ws.send(json.dumps({"t": "ping"}))
                    hello = await until_message(ws, "hello")
                    assert hello["latched"]
                    await ws.close(1012, "second hello requires a fresh socket")
                else:
                    events = []
                    while len(events) < 2:
                        m = json.loads(await ws.recv())
                        if m.get("code") in ("SERVER_CLOSED", "SERVER_RETRY"):
                            events.append(m)
                    closed = next(m for m in events if m["code"] == "SERVER_CLOSED")
                    assert closed["data"]["close_code"] == 1012 and closed["data"]["retry"]
                    assert sink.commands[-1][1].velocity == Z and not task.done()
                    completed.set_result(True)
                    await ws.wait_closed()
            except Exception as exc:
                if not completed.done():
                    completed.set_exception(exc)

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            task = asyncio.create_task(Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/api/v1/agent/ws", "fake-test-token", 0.01, 0.04)).run())
            try:
                await asyncio.wait_for(completed, 1)
            except asyncio.TimeoutError:
                pytest.fail("1012 close must reconnect and retain close/backoff events")
            finally:
                if not task.done():
                    await cancel(task)
                elif task.exception() is not None:
                    pytest.fail("1012 must remain reconnectable, not terminate Client.run")
        assert attempts == 2
    asyncio.run(scenario())


def test_default_close_backoff_matches_api_spec():
    settings = Settings("wss://example.invalid/api/v1/agent/ws", "fake-test-token")
    assert settings.retry_initial_s == 1 and settings.retry_max_s == 10


@pytest.mark.parametrize("status,close_code", [(401, 4401), (403, 4403)])
def test_handshake_authorization_rejection_does_not_retry(status, close_code):
    async def scenario():
        from websockets.http11 import Response
        from websockets.datastructures import Headers

        attempts = []

        async def reject(connection, request):
            attempts.append(request)
            return Response(status, "Rejected", Headers(), b"")

        session = Session()
        sink = FakeMotionSink()
        async with serve(lambda ws: ws.wait_closed(), "127.0.0.1", 0, process_request=reject) as srv:
            port = srv.sockets[0].getsockname()[1]
            client = Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/api/v1/agent/ws", "fake-test-token", 0.01, 0.04))
            try:
                await asyncio.wait_for(client.run(), 0.5)
            except asyncio.TimeoutError:
                pytest.fail("HTTP authorization rejection must not retry")
            except RuntimeError as exc:
                assert getattr(exc, "close_code", None) == close_code
            else:
                pytest.fail("HTTP rejection must be reported to the caller")
        assert len(attempts) == 1 and session.core.latch
        assert sink.commands[-1][1].velocity == Z
    asyncio.run(scenario())


def test_repeated_1013_close_uses_fixed_interval_and_records_each_attempt():
    async def scenario():
        session = Session()
        sink = FakeMotionSink()
        observed = []
        original = session._event

        def event(code, **data):
            observed.append((code, data))
            original(code, **data)

        session._event = event
        attempts = 0
        completed = asyncio.get_running_loop().create_future()

        async def server(ws):
            nonlocal attempts
            try:
                attempts += 1
                await until_message(ws, "hello")
                if attempts <= 3:
                    await ws.close(1013, "busy")
                else:
                    completed.set_result(True)
                    await ws.wait_closed()
            except Exception as exc:
                if not completed.done():
                    completed.set_exception(exc)

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            task = asyncio.create_task(Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/api/v1/agent/ws", "fake-test-token", 0.01, 0.04)).run())
            try:
                await asyncio.wait_for(completed, 1)
            except asyncio.TimeoutError:
                pytest.fail("retryable close must back off and keep reconnecting")
            finally:
                await cancel(task)
        retries = [data["delay_s"] for code, data in observed if code == "SERVER_RETRY"]
        closed = [data for code, data in observed if code == "SERVER_CLOSED"]
        assert retries == [0.01, 0.01, 0.01]
        assert len(closed) == 3 and all(d == {"close_code": 1013, "retry": True} for d in closed)
        assert attempts == 4 and sink.commands[-1][1].velocity == Z
    asyncio.run(scenario())


def test_long_outage_recovers_on_first_socket_with_original_safety_events_in_order():
    async def scenario():
        # Reuse the clock/bridge fixture; all 200 retry intervals are simulated,
        # while real networking is only one same-process loopback connection.
        from test_link_session import Harness

        h = Harness("RUN", wait=0)
        h.s.disconnect()
        h.advance_run(3)
        assert h.s.run["wait_reason"] == "LINK_LOSS_TIMEOUT"
        for _ in range(200):
            # Advance the offline clock in samples below the 0.3 s deadline;
            # no wall-clock waiting or robot output is involved in preparation.
            for _ in range(40):
                h.t += 0.25
                h.state()
                h.s.executor_command("run-a", [0, 0, 0])
            h.s.transport_retry(10)
        session = h.s
        sink = FakeMotionSink()
        attempts = 0
        completed = asyncio.get_running_loop().create_future()

        async def server(ws):
            nonlocal attempts
            try:
                attempts += 1
                hello = await until_message(ws, "hello")
                assert hello["latched"] and hello["run"]["wait_reason"] == "LINK_LOSS_TIMEOUT"
                received = []
                while True:
                    msg = json.loads(await ws.recv())
                    received.append(msg)
                    if msg["t"] == "state":
                        break
                order = [(m["t"], m.get("code"), m.get("status")) for m in received]
                assert order[:4] == [
                    ("event", "SERVER_LINK_LOST", None),
                    ("run.update", None, "PAUSED"),
                    ("event", "LINK_LOSS_TIMEOUT", None),
                    ("event", "SERVER_RETRY", None),
                ]
                retry = next(m for m in received if m.get("code") == "SERVER_RETRY")
                assert retry["data"]["attempts"] == 200
                assert not any(m.get("code") == "TRANSPORT_BACKPRESSURE" for m in received)
                assert attempts == 1 and not task.done()
                completed.set_result(True)
                await ws.wait_closed()
            except Exception as exc:
                if not completed.done():
                    completed.set_exception(exc)

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            task = asyncio.create_task(Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/api/v1/agent/ws", "fake-test-token", 0.01, 0.04),
                FakeExecutor()).run())
            try:
                await asyncio.wait_for(completed, 2)
            except asyncio.TimeoutError:
                pytest.fail("200 offline retries must fit the first recovery socket")
            finally:
                await cancel(task)
        assert attempts == 1 and sink.commands[-1][1].velocity == Z
    asyncio.run(scenario())


@pytest.mark.parametrize("close_code", [4401, 4403])
def test_client_auth_close_preserves_paused_reason_and_nonretry_event(close_code):
    async def scenario():
        session = Session()
        sink = FakeMotionSink()
        observed = []
        original = session._event

        def event(code, **data):
            observed.append((code, data))
            original(code, **data)

        session._event = event

        async def server(ws):
            await until_message(ws, "hello")
            await ws.send(json.dumps({"t": "lease", "lease_id": "r", "holder_type": "RUN:run-a"}))
            await ws.send(json.dumps({"t": "run.start", "run_id": "run-a",
                                      "plan": {"segments": []}, "missions": {}}))
            await until_message(ws, "run.update")
            await ws.close(close_code, "authorization rejected")

        async with serve(server, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            client = Client(session, sink, Settings(
                f"ws://127.0.0.1:{port}/api/v1/agent/ws", "fake-test-token", 0.01, 0.04), FakeExecutor())
            with pytest.raises(RuntimeError) as caught:
                await asyncio.wait_for(client.run(), 1)
            assert getattr(caught.value, "close_code", None) == close_code
        assert ("SERVER_CLOSED", {"close_code": close_code, "retry": False}) in observed
        assert session.run["status"] == "PAUSED"
        assert session.run["wait_reason"] == "SERVER_AUTH_REJECTED"
        assert session.core.latch and sink.commands[-1][1].velocity == Z
    asyncio.run(scenario())

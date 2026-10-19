"""Thin asyncio transport. No connection is made on import or construction."""

import asyncio
from copy import deepcopy
from dataclasses import dataclass, field
import json
import os
from collections import deque
from urllib.parse import urlsplit

from .interfaces import Executor, MotionSink
from .session import Effects, MotionCommand, Session
from foothold_agent.safety.core import Z

TICK_S = 0.05
FATAL_CLOSE_CODES = (4401, 4403)
PROTOCOL_CLOSE_CODE = 4406
PROTOCOL_RETRY_S = 30.0


class Outbox:
    """128 FIFO discrete frames plus coalesced state/ACK ahead of history."""
    def __init__(self):
        self.frames = deque()
        self.telemetry = {}
        self.ready = asyncio.Event()
        self.inflight = None

    def put_nowait(self, message):
        if message['t'] in ('state', 'cmd.ack'):
            self.telemetry[message['t']] = message
        else:
            if len(self.frames) >= 128:
                raise asyncio.QueueFull
            self.frames.append(message)
        self.ready.set()

    async def put(self, message):
        while True:
            try:
                self.put_nowait(message)
                return
            except asyncio.QueueFull:
                await asyncio.sleep(.005)

    async def get(self):
        while True:
            await self.ready.wait()
            index = next((i for i, m in enumerate(self.frames) if m['t'] == 'hello'), None)
            if index is not None:
                message = self.frames[index]
                del self.frames[index]
            elif self.telemetry:
                key = 'state' if 'state' in self.telemetry else 'cmd.ack'
                message = self.telemetry.pop(key)
            elif self.frames:
                message = self.frames.popleft()
            else:
                self.ready.clear()
                continue
            if not self.frames and not self.telemetry:
                self.ready.clear()
            self.inflight = message
            return message

    def unsent(self):
        return ([self.inflight] if self.inflight else []) + list(self.frames)


@dataclass(frozen=True)
class Settings:
    url: str = field(repr=False)
    token: str = field(repr=False)
    retry_initial_s: float = 1.0
    retry_max_s: float = 10.0

    def __post_init__(self):
        url = urlsplit(self.url)
        if (url.scheme not in {"wss", "ws"} or not url.hostname or url.username
                or url.password or url.query or url.fragment
                or (url.scheme == "ws" and url.hostname not in {"127.0.0.1", "::1"})):
            raise ValueError("agent URL requires WSS (WS allowed only on loopback)")
        if not self.token or any(c.isspace() or ord(c) < 32 for c in self.token):
            raise ValueError("agent token must be a nonempty header value")
        if not 0 < self.retry_initial_s <= self.retry_max_s <= 10:
            raise ValueError("invalid reconnect backoff")

    @classmethod
    def from_env(cls):
        try:
            return cls(url=os.environ["FOOTHOLD_AGENT_WS_URL"],
                       token=os.environ["FOOTHOLD_AGENT_TOKEN"])
        except KeyError:
            raise ValueError("set FOOTHOLD_AGENT_WS_URL and FOOTHOLD_AGENT_TOKEN") from None


class LocalPortError(RuntimeError):
    """A local output port failed; never classify it as a reconnectable socket error."""


class ReconnectForbidden(RuntimeError):
    """Authorization/configuration must be fixed before explicitly starting again."""

    def __init__(self, close_code):
        self.close_code = close_code
        super().__init__(f"agent connection rejected ({close_code}); automatic reconnect disabled")


def _note_output_error(pending_error, error, phase):
    # Keep cancellation/first-error semantics, with inspectable diagnostics even
    # on Python 3.10 (BaseException.add_note was added in 3.11).
    pending_error.output_errors = (*getattr(pending_error, "output_errors", ()), error)
    if hasattr(pending_error, "add_note"):
        pending_error.add_note(f"Local motion output failed during {phase}; see output_errors")


class Client:
    """Single asyncio event loop owns the session and local ports.

    The watchdog runs during handshakes, writes, closes and retry delays. Ports
    MUST be nonblocking; real-time scheduling / hardware watchdogs are not claimed.
    Cancel run() to stop. No motion, unlock, or execution command is retried.
    """

    def __init__(self, session: Session, sink: MotionSink, settings: Settings,
                 executor: Executor | None = None):
        self.session = session
        self.sink = sink
        self.settings = settings
        self.executor = executor
        self._outgoing = None
        self._overflow = None
        self.storage_blocked = False
        self.session.emit_history = False
        self.session.before_history = self._before_history
        self._ensure_history()

    def _ensure_history(self):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return  # run()/the first async entry installs the worker
        self.session._messages.background(
            lambda error: self._storage_problem(type(error).__name__),
            lambda: self._storage_problem('BACKPRESSURE'))

    def _before_history(self):
        # Session is synchronous: publish its already-decided safe motion before
        # even submitting file work. The callback never publishes nonzero/unlock.
        if self.session.core.latch:
            self._emit(Effects((MotionCommand('stop'), MotionCommand(velocity=Z))))
        elif self.session.core.applied() == Z:
            self._emit(Effects((MotionCommand(velocity=Z),)))
        self._ensure_history()

    def _storage_problem(self, reason):
        if self.storage_blocked:
            return
        self.storage_blocked = True
        self._outgoing = None
        # Physical STOP/zero precede metadata, error events and worker waits.
        self._emit(Effects((MotionCommand('stop'), MotionCommand(velocity=Z))))
        if self._overflow is not None:
            self._overflow.set()
        self._emit(self.session.storage_blocked(reason))

    def _emit(self, effects: Effects):
        # This ordering is mandatory: stop/apply locally before hello or state ACK.
        first_error = None
        zero_attempted = False
        for command in effects.motion:
            if first_error is not None and not (command.kind == "stop" or (
                    command.kind == "apply" and command.velocity == Z)):
                continue  # never try an unlock/nonzero command after output failure
            zero_attempted |= command.kind == "apply" and command.velocity == Z
            try:
                self.sink.apply(command)
            except Exception as exc:
                if first_error is None:
                    first_error = exc
        if first_error is not None:
            if not zero_attempted:
                try:
                    self.sink.apply(MotionCommand(velocity=Z))
                except Exception:
                    pass  # retain the first failure, even if zero also failed
            raise LocalPortError("motion sink failed") from first_error
        if self._outgoing is not None:
            for index, message in enumerate(effects.messages):
                try:
                    self._outgoing.put_nowait(message)
                except asyncio.QueueFull:
                    # A slow connection must not terminate the local watchdog.
                    # Detach before emitting STOP so no safety response re-enters
                    # the saturated queue; the network task closes and reconnects.
                    self.session.retain(effects.messages[index:])
                    self._outgoing = None
                    if self._overflow is not None:
                        self._overflow.set()
                    self._emit(self.session.transport_overflow())
                    break

    def on_robot_state(self, raw):
        """Local bridge feedback, called on the owning event loop."""
        self._ensure_history()
        self._emit(self.session.on_robot_state(raw, record_errors=not self.storage_blocked))

    def waypoint_reached(self, run_id):
        """Local executor observation; never inferred from a server message."""
        self._emit(self.session.waypoint_reached(run_id))

    async def _watchdog(self):
        while True:
            self._emit(self.session.tick())
            run = self.session.run
            if self.executor is not None and run is not None and not self.storage_blocked:
                axes = self.executor.poll(deepcopy(run))
                if axes is not None:
                    self._emit(self.session.executor_command(run["run_id"], axes))
            await asyncio.sleep(TICK_S)

    async def _writer(self, websocket, queue):
        while True:
            message = await queue.get()
            # Bounded writes cannot suspend the local watchdog.
            await asyncio.wait_for(websocket.send(json.dumps(message, allow_nan=False)), 0.2)
            queue.inflight = None

    async def _replay(self, queue, messages, *, live=False):
        # Only replaceable telemetry may pass event history. Events and run
        # transitions use one serialized FIFO pump, including newly generated
        # history while a reconnect backlog is still draining.
        messages = sorted(messages, key=lambda m: 0 if m['t'] == 'hello' else
                          1 if m['t'] in ('state', 'cmd.ack') else 2)
        index = 0
        try:
            for message in messages:
                await queue.put(message)
                index += 1
            while live:
                await self.session.history_ready.wait()
                try:
                    messages = self.session.pop_history(1)
                except Exception:
                    if self.session._messages.io is None or self.session._messages.io.error is None:
                        raise
                    await self.session._messages.writable()
                    continue
                if not messages:
                    await self.session._messages.readable()
                    continue
                index = 0
                for message in messages:
                    await queue.put(message)
                    index += 1
        finally:
            self.session.restore(messages[index:])

    async def _reader(self, websocket):
        while True:
            if self.storage_blocked:
                return
            try:
                frame = await asyncio.wait_for(websocket.recv(), TICK_S)
            except asyncio.TimeoutError:
                if self.session.link_lost or self.session.reconnect_required:
                    return
                continue
            if self.storage_blocked:
                return
            self._emit(self.session.receive(frame))
            if self.session.reconnect_required:
                return

    async def _network(self):
        # Optional dependency is deliberately lazy; sans-I/O import needs stdlib only.
        from websockets.asyncio.client import connect
        from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

        delay = self.settings.retry_initial_s
        while True:
            await self.session._messages.writable()
            self.storage_blocked = False  # Core stays latched, old lease cleared
            connected_for = 0.0
            retry_code = None
            protocol_wait = False
            try:
                async with connect(
                    self.settings.url,
                    additional_headers={"Authorization": "Bearer " + self.settings.token},
                    proxy=None, ping_interval=None,
                    open_timeout=2, close_timeout=0.2, max_size=4096,
                    compression=None,
                ) as websocket:
                    connected_at = self.session.now()
                    queue = Outbox()
                    self._outgoing = queue
                    self._overflow = asyncio.Event()
                    self.session.emit_history = False
                    effects = self.session.connect()
                    self._emit(Effects(effects.motion))
                    replay = asyncio.create_task(self._replay(queue, effects.messages, live=True))
                    reader = asyncio.create_task(self._reader(websocket))
                    writer = asyncio.create_task(self._writer(websocket, queue))
                    overflow = asyncio.create_task(self._overflow.wait())
                    pending_error = None
                    try:
                        done, _ = await asyncio.wait((reader, writer, overflow, replay),
                                                     return_when=asyncio.FIRST_COMPLETED)
                        for task in done:
                            task.result()
                    except BaseException as exc:
                        pending_error = exc
                        raise
                    finally:
                        connected_for = self.session.now() - connected_at
                        # Discard this connection's buffered ACKs/state; never replay them.
                        self._outgoing = None
                        self._overflow = None
                        try:
                            if isinstance(pending_error, ConnectionClosed):
                                code = pending_error.rcvd.code if pending_error.rcvd else 1006
                                legacy_protocol = code == 4403 and pending_error.rcvd.reason.startswith('PROTOCOL_MISMATCH')
                                if code == PROTOCOL_CLOSE_CODE or legacy_protocol:
                                    self._emit(self.session.protocol_mismatch())
                                if code == 1013 and pending_error.rcvd.reason == 'ROBOT_ARCHIVE_LIMIT':
                                    self._storage_problem('SERVER_ARCHIVE_LIMIT')
                                effects = self.session.transport_closed(code, retry=code not in FATAL_CLOSE_CODES or legacy_protocol)
                            else:
                                effects = (self.session.shutdown() if isinstance(pending_error, LocalPortError)
                                           else self.session.disconnect())
                            self._emit(effects)
                        except LocalPortError as exc:
                            # Preserve the first *output* failure, but never hide
                            # one behind a reconnectable socket/timeout error.
                            if isinstance(pending_error, (LocalPortError, asyncio.CancelledError)):
                                _note_output_error(pending_error, exc, "disconnect")
                            else:
                                raise
                        finally:
                            reader.cancel()
                            writer.cancel()
                            overflow.cancel()
                            replay.cancel()
                            await asyncio.gather(reader, writer, overflow, replay, return_exceptions=True)
                            self.session.restore(queue.unsent())
                            self.session.emit_history = False
            except ConnectionClosed as exc:
                retry_code = exc.rcvd.code if exc.rcvd else 1006
                reason = exc.rcvd.reason if exc.rcvd is not None else ""
                legacy_protocol = retry_code == 4403 and reason.startswith('PROTOCOL_MISMATCH')
                if retry_code in FATAL_CLOSE_CODES and not legacy_protocol:
                    raise ReconnectForbidden(retry_code) from exc
                try:
                    declaration = json.loads(reason)
                except (ValueError, RecursionError):
                    declaration = {"proto": reason} if reason.startswith("fh-agent/") else {}
                if (retry_code == PROTOCOL_CLOSE_CODE or legacy_protocol or
                        isinstance(declaration, dict) and "proto" in declaration
                        and declaration["proto"] != "fh-agent/2"):
                    if not self.session.protocol_rejected:
                        self._emit(self.session.protocol_mismatch())
                    protocol_wait = True
            except InvalidStatus as exc:
                # ASGI authorization rejection before accept is HTTP 401/403,
                # rather than a negotiated WebSocket close frame.
                if exc.response.status_code in (401, 403):
                    code = 4401 if exc.response.status_code == 401 else 4403
                    self._emit(self.session.transport_closed(code, retry=False))
                    raise ReconnectForbidden(code) from exc
            except (OSError, InvalidHandshake, asyncio.TimeoutError):
                pass  # transport only; never catch a local sink/executor failure
            if connected_for >= 3 or retry_code == 1013:
                delay = self.settings.retry_initial_s
            protocol_wait |= self.session.protocol_rejected
            wait = max(PROTOCOL_RETRY_S, delay) if protocol_wait else delay
            self._emit(self.session.transport_retry(wait, retry_code))
            await asyncio.sleep(wait)
            delay = min(delay * 2, self.settings.retry_max_s)

    async def run(self):
        self._ensure_history()
        watchdog = asyncio.create_task(self._watchdog())
        network = asyncio.create_task(self._network())
        pending_error = None
        try:
            done, _ = await asyncio.wait((watchdog, network), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except BaseException as exc:
            pending_error = exc
            raise
        finally:
            self._outgoing = None
            # Stop BEFORE awaiting cancellation of socket tasks, even on cancellation
            # or a local port failure. A failing hardware sink cannot be hidden.
            try:
                try:
                    effects = self.session.shutdown()
                except Exception:
                    # History I/O failure cannot prevent physical STOP/zero.
                    self._emit(Effects((MotionCommand('stop'), MotionCommand(velocity=Z))))
                    raise
                self._emit(effects)
            except Exception as exc:
                if pending_error is None:
                    raise
                _note_output_error(pending_error, exc, "shutdown")
            finally:
                watchdog.cancel()
                network.cancel()
                await asyncio.gather(watchdog, network, return_exceptions=True)
                self.session._messages.close()

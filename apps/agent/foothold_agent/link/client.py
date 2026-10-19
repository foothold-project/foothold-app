"""Thin asyncio transport. No connection is made on import or construction."""

import asyncio
from copy import deepcopy
from dataclasses import dataclass, field
import json
import os
from urllib.parse import urlsplit

from .interfaces import Executor, MotionSink
from .session import Effects, MotionCommand, Session
from foothold_agent.safety.core import Z

TICK_S = 0.05


@dataclass(frozen=True)
class Settings:
    url: str = field(repr=False)
    token: str = field(repr=False)
    retry_initial_s: float = 0.25
    retry_max_s: float = 8.0

    def __post_init__(self):
        url = urlsplit(self.url)
        if (url.scheme not in {"wss", "ws"} or not url.hostname or url.username
                or url.password or url.query or url.fragment
                or (url.scheme == "ws" and url.hostname not in {"127.0.0.1", "::1"})):
            raise ValueError("agent URL requires WSS (WS allowed only on loopback)")
        if not self.token or any(c.isspace() or ord(c) < 32 for c in self.token):
            raise ValueError("agent token must be a nonempty header value")
        if not 0 < self.retry_initial_s <= self.retry_max_s <= 30:
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
            for message in effects.messages:
                try:
                    self._outgoing.put_nowait(message)
                except asyncio.QueueFull:
                    # A slow connection must not terminate the local watchdog.
                    # Detach before emitting STOP so no safety response re-enters
                    # the saturated queue; the network task closes and reconnects.
                    self._outgoing = None
                    if self._overflow is not None:
                        self._overflow.set()
                    self._emit(self.session.transport_overflow())
                    break

    def on_robot_state(self, raw):
        """Local bridge feedback, called on the owning event loop."""
        self._emit(self.session.on_robot_state(raw))

    def waypoint_reached(self, run_id):
        """Local executor observation; never inferred from a server message."""
        self._emit(self.session.waypoint_reached(run_id))

    async def _watchdog(self):
        while True:
            self._emit(self.session.tick())
            run = self.session.run
            if self.executor is not None and run is not None:
                axes = self.executor.poll(deepcopy(run))
                if axes is not None:
                    self._emit(self.session.executor_command(run["run_id"], axes))
            await asyncio.sleep(TICK_S)

    async def _writer(self, websocket, queue):
        while True:
            message = await queue.get()
            # Bounded writes cannot suspend the local watchdog.
            await asyncio.wait_for(websocket.send(json.dumps(message, allow_nan=False)), 0.2)

    async def _reader(self, websocket):
        while True:
            try:
                frame = await asyncio.wait_for(websocket.recv(), TICK_S)
            except asyncio.TimeoutError:
                if self.session.link_lost or self.session.reconnect_required:
                    return
                continue
            self._emit(self.session.receive(frame))
            if self.session.reconnect_required:
                return

    async def _network(self):
        # Optional dependency is deliberately lazy; sans-I/O import needs stdlib only.
        from websockets.asyncio.client import connect
        from websockets.exceptions import ConnectionClosed, InvalidHandshake

        delay = self.settings.retry_initial_s
        while True:
            connected_for = 0.0
            try:
                async with connect(
                    self.settings.url,
                    additional_headers={"Authorization": "Bearer " + self.settings.token},
                    proxy=None, ping_interval=None,
                    open_timeout=2, close_timeout=0.2, max_size=4096,
                    compression=None,
                ) as websocket:
                    connected_at = self.session.now()
                    queue = asyncio.Queue(maxsize=128)
                    self._outgoing = queue
                    self._overflow = asyncio.Event()
                    self._emit(self.session.connect())
                    reader = asyncio.create_task(self._reader(websocket))
                    writer = asyncio.create_task(self._writer(websocket, queue))
                    overflow = asyncio.create_task(self._overflow.wait())
                    pending_error = None
                    try:
                        done, _ = await asyncio.wait((reader, writer, overflow),
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
                            effects = (self.session.shutdown() if isinstance(pending_error, LocalPortError)
                                       else self.session.disconnect())
                            self._emit(effects)
                        except LocalPortError:
                            # Preserve the first *output* failure, but never hide
                            # one behind a reconnectable socket/timeout error.
                            if not isinstance(pending_error, LocalPortError):
                                raise
                        finally:
                            reader.cancel()
                            writer.cancel()
                            overflow.cancel()
                            await asyncio.gather(reader, writer, overflow, return_exceptions=True)
            except ConnectionClosed as exc:
                reason = exc.rcvd.reason if exc.rcvd is not None else ""
                try:
                    declaration = json.loads(reason)
                except (ValueError, RecursionError):
                    declaration = {"proto": reason} if reason.startswith("fh-agent/") else {}
                if (isinstance(declaration, dict) and "proto" in declaration
                        and declaration["proto"] != "fh-agent/1"):
                    self._emit(self.session.protocol_mismatch())
            except (OSError, InvalidHandshake, asyncio.TimeoutError):
                pass  # transport only; never catch a local sink/executor failure
            if connected_for >= 3:
                delay = self.settings.retry_initial_s
            await asyncio.sleep(delay)
            delay = min(delay * 2, self.settings.retry_max_s)

    async def run(self):
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
                self._emit(self.session.shutdown())
            except Exception:
                if pending_error is None:
                    raise
            finally:
                watchdog.cancel()
                network.cancel()
                await asyncio.gather(watchdog, network, return_exceptions=True)

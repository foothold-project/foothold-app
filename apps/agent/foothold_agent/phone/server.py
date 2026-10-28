"""Bounded WS transport; local safety tick never waits for a phone write."""

import asyncio
from collections import Counter
from dataclasses import dataclass
import json
import os
import socket
from urllib.parse import urlsplit

from .hub import PhoneError, Peer
from .origins import with_tunnel_origin
from foothold_agent.discovery import Advertiser


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    key_path: str
    policy_name: str
    policy_version: str
    org: str
    replay_path: str
    clock_trusted: bool
    simulation: bool
    origins: tuple[str, ...] = ()

    def __post_init__(self):
        if (not self.host or type(self.port) is not int or not 1 <= self.port <= 65535
                or not self.key_path or not 1 <= len(self.policy_name) <= 128
                or not 1 <= len(self.policy_version) <= 128 or not self.replay_path
                or self.replay_path == ':memory:' or self.replay_path.startswith('file:')
                or self.clock_trusted is not True or type(self.simulation) is not bool):
            raise ValueError('invalid phone configuration')
        from .tickets import uuid
        uuid(self.org)
        if len(self.origins) > 16:
            raise ValueError('too many phone origins')
        for origin in self.origins:
            parsed = urlsplit(origin)
            if (parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.path
                    or parsed.query or parsed.fragment or parsed.username or parsed.password):
                raise ValueError('invalid phone origin')

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        names = ('FOOTHOLD_PHONE_HOST', 'FOOTHOLD_PHONE_PORT', 'FOOTHOLD_PHONE_KEY_PATH',
                 'FOOTHOLD_PHONE_POLICY_NAME', 'FOOTHOLD_PHONE_POLICY_VERSION',
                 'FOOTHOLD_PHONE_ORG_ID', 'FOOTHOLD_PHONE_REPLAY_DB', 'FOOTHOLD_PHONE_CLOCK_TRUSTED',
                 'FOOTHOLD_PHONE_SIMULATION')
        if not any(name in env for name in names):
            return None  # explicit opt in, no listener by default
        try:
            simulation = env[names[8]]
            if simulation not in ('0', '1'):
                raise ValueError('explicit simulation flag required')
            origins = json.loads(env.get('FOOTHOLD_PHONE_ORIGINS', '[]'))
            if not isinstance(origins, list) or not all(isinstance(v, str) for v in origins):
                raise ValueError('invalid origins')
            return cls(env[names[0]], int(env[names[1]]), env[names[2]], env[names[3]], env[names[4]],
                       env[names[5]], env[names[6]], env[names[7]] == '1', simulation == '1',
                       with_tunnel_origin(tuple(origins), env) if simulation == '1' else tuple(origins))
        except (KeyError, ValueError, TypeError):
            raise ValueError('set all phone host/port/key/policy environment variables') from None


class Server:
    def __init__(self, hub, settings, *, sock=None, camera=None, media=None):
        self.hub, self.settings, self.sock = hub, settings, sock
        self.camera = camera
        self.media = media
        self.media_generations = {}
        self.connections = {}
        self.addresses = {}
        self.hello_started = set()
        self.close_tasks = set()
        self.closing = set()
        self.ready = asyncio.Event()
        self.stopping = asyncio.Event()
        self.failure = None
        self.workers = {}

    def _failed(self, error):
        if self.failure is None:
            self.failure = error
        elif self.failure is not error:
            self._note(self.failure, error)
        self.stopping.set()

    @staticmethod
    def _note(first, extra):
        errors = getattr(first, 'output_errors', [])
        first.output_errors = [*errors, extra]
        if hasattr(first, 'add_note'):
            first.add_note('additional phone cleanup error: ' + type(extra).__name__)

    def _close_later(self, ws, peer, error):
        if peer not in self.closing:
            self.closing.add(peer)
            task = asyncio.create_task(ws.close(error.close_code, error.code))
            self.close_tasks.add(task)
            task.add_done_callback(self.close_tasks.discard)

    async def _send(self, ws, value):
        await asyncio.wait_for(ws.send(json.dumps(value, allow_nan=False, separators=(',', ':'))), .2)

    async def _states(self, ws, peer):
        while peer in self.hub.peers:
            if self.hub.peers[peer].user is not None:
                for notification in self.hub.drain(peer):
                    await self._send(ws, notification)
                if peer in self.hub.peers:
                    await self._send(ws, self.hub.state(peer))
                if (self.media is not None and peer in self.media_generations
                        and self.media_generations[peer] != self.media.media.generation):
                    generation = self.media.media.generation
                    info = self.media.issue(peer)
                    await self._send(ws, dict(t='media.update', robot=self.hub.robot, media=info))
                    self.media_generations[peer] = generation
            await asyncio.sleep(.1)

    async def _read(self, ws, peer):
        async for raw in ws:
            if peer not in self.hub.peers:
                raise self.hub.closing.get(peer, PhoneError('CONNECTION_EXPIRED', 4401))
            try:
                if json.loads(raw).get('t') == 'hello':
                    self.hello_started.add(peer)
            except (ValueError, TypeError, AttributeError, RecursionError):
                pass  # Hub owns frame validation and authenticated STOP policy.
            result = self.hub.receive(peer, raw)
            generation = None
            if result.get('t') == 'hello':
                result['camera_token'] = self.camera.issue(peer) if self.camera is not None else None
                if self.media is not None:
                    generation = self.media.media.generation
                    info = self.media.issue(peer)
                    if info is not None:
                        result['media'] = info
            await self._send(ws, result)
            if generation is not None:
                # Updates start only after hello. Capture before the send so a
                # binding change during that await is advertised next tick.
                self.media_generations[peer] = generation

    def _address(self, ws):
        # Source host only: ephemeral ports must not bypass the per-address cap.
        remote = getattr(ws, 'remote_address', None)
        return remote[0] if remote else None

    def _admit(self, ws):
        pending = [p for p in self.connections if p in self.hub.peers and self.hub.peers[p].user is None]
        address = self._address(ws)
        same = [p for p in pending if self.addresses[p] == address]
        # Apply the source limit FIRST. A noisy host only rotates its own slots.
        candidates = same if len(same) >= 2 else pending if len(pending) >= 16 else []
        if candidates:
            replaceable = [p for p in candidates if p not in self.hello_started]
            if not replaceable:
                raise PhoneError('HELLO_CAPACITY', 1013)
            counts = Counter(self.addresses[p] for p in pending)
            # min is stable: equal source loads use the oldest pending socket.
            oldest = min(replaceable, key=lambda p: -counts[self.addresses[p]])
            self.hub.disconnect(oldest, reserve=False, requester_withdrawal=False)
            error = PhoneError('HELLO_CAPACITY', 1013)
            self.hub.closing[oldest] = error
            self._close_later(self.connections[oldest], oldest, error)
        peer = object()
        self.connections[peer] = ws
        self.addresses[peer] = address
        self.hub.peers[peer] = Peer(last_ping=self.hub.now())
        return peer

    async def _handler(self, ws):
        from websockets.exceptions import ConnectionClosed
        native_socket = getattr(ws, 'transport', None)
        native_socket = native_socket.get_extra_info('socket') if native_socket is not None else None
        if native_socket is not None:
            native_socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        if ws.request.path == '/phone/media/ws' and self.media is not None:
            await self.media.handler(ws)
            return
        if ws.request.path == '/phone/camera/ws' and self.camera is not None:
            await self.camera.handler(ws)
            return
        if ws.request.path != '/phone/ws':
            await ws.close(4403, 'PATH_INVALID')
            return
        try:
            peer = self._admit(ws)
        except PhoneError as error:
            await ws.close(error.close_code, error.code)
            return
        reader = asyncio.create_task(self._read(ws, peer))
        states = asyncio.create_task(self._states(ws, peer))
        self.workers[peer] = (reader, states)
        primary = None
        close_error = None
        try:
            done, _ = await asyncio.wait((reader, states), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except PhoneError as exc:
            close_error = exc
        except ConnectionClosed as exc:
            codes = [part.code for part in (exc.sent, exc.rcvd) if part is not None]
            invalid = next((code for code in codes if code in (1002, 1003, 1007, 1009)), None)
            if invalid is not None and peer in self.hub.peers and self.hub.peers[peer].user is not None:
                try:
                    self.hub.fail(peer, 'TRANSPORT_INVALID', invalid)
                except PhoneError as error:
                    close_error = error
                except BaseException as error:
                    primary = error
                    self._failed(error)
        except asyncio.TimeoutError:
            pass
        except BaseException as exc:
            primary = exc
            if not isinstance(exc, asyncio.CancelledError):
                self._failed(exc)
        finally:
            try:
                self.hub.disconnect(peer, requester_withdrawal=primary is None and not self.stopping.is_set())
                # STOP above precedes any asynchronous cleanup.
            except BaseException as error:
                if primary is None:
                    primary = error
                elif primary is not error:
                    self._note(primary, error)
                self._failed(primary if not isinstance(primary, asyncio.CancelledError) else error)
            finally:
                if self.camera is not None:
                    self.camera.forget(peer)
                if self.media is not None:
                    self.media.forget(peer)
                self.connections.pop(peer, None)
                self.addresses.pop(peer, None)
                self.hello_started.discard(peer)
                self.media_generations.pop(peer, None)
                self.closing.discard(peer)
                self.workers.pop(peer, None)
                reader.cancel()
                states.cancel()
                try:
                    await asyncio.gather(reader, states, return_exceptions=True)
                finally:
                    close_error = close_error or self.hub.closing.pop(peer, None)
                    self.hub.closing.pop(peer, None)
                    try:
                        await asyncio.wait_for(ws.close(close_error.close_code if close_error else 1000,
                                                       close_error.code if close_error else ''), .3)
                    except (ConnectionClosed, OSError, asyncio.TimeoutError):
                        pass  # a network close failure isn't a local service fault
        if primary is not None:
            raise primary

    async def _watchdog(self):
        while True:
            expired = self.hub.tick()  # every 50 ms, independent of network tasks
            for peer, error in expired:
                ws = self.connections.get(peer)
                if ws is not None:
                    self._close_later(ws, peer, error)
            await asyncio.sleep(.05)

    async def run(self):
        from websockets.asyncio.server import serve
        advertisement = Advertiser.for_listener(self.settings.host, self.settings.port, rid=self.hub.robot)
        watchdog = waiter = None
        primary = None
        stopped = False
        def stop_hub():
            nonlocal stopped
            stopped = True
            self.hub.close()
        try:
            kwargs = {'sock': self.sock} if self.sock is not None else {
                'host': self.settings.host, 'port': self.settings.port}
            async with serve(self._handler, **kwargs, max_size=4096, max_queue=4,
                             origins=[None, *self.settings.origins],
                             write_limit=4096, compression=None, ping_interval=None,
                             open_timeout=3, close_timeout=.2) as listener:
                try:
                    advertisement.start()
                    self.ready.set()
                    watchdog = asyncio.create_task(self._watchdog())
                    waiter = asyncio.create_task(self.stopping.wait())
                    done, _ = await asyncio.wait((watchdog, waiter), return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                    if self.failure is not None:
                        raise RuntimeError('phone service failed') from self.failure
                except BaseException as error:
                    primary = error
                    if self.failure is None and not isinstance(error, asyncio.CancelledError):
                        self._failed(error)
                    raise
                finally:
                    advertisement.close()
                    # Includes cancellation: stop BEFORE listener shutdown waits.
                    try:
                        stop_hub()
                    except BaseException as error:
                        self._failed(error)
                        if primary is None:
                            raise
                        self._note(primary, error)
        except BaseException as error:
            primary = error
            raise
        finally:
            try:
                if not stopped:
                    try:
                        stop_hub()
                    except BaseException as error:
                        if primary is None:
                            raise
                        self._note(primary, error)
            finally:
                for task in (watchdog, waiter):
                    if task is not None:
                        task.cancel()
                await asyncio.gather(*(t for t in (watchdog, waiter) if t is not None),
                                     *self.close_tasks, return_exceptions=True)

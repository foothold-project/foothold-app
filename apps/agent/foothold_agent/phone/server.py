"""Bounded WS transport; local safety tick never waits for a phone write."""

import asyncio
from dataclasses import dataclass
import json
import os

from .hub import PhoneError, Peer


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

    def __post_init__(self):
        if (not self.host or type(self.port) is not int or not 1 <= self.port <= 65535
                or not self.key_path or not 1 <= len(self.policy_name) <= 128
                or not 1 <= len(self.policy_version) <= 128 or not self.replay_path
                or self.clock_trusted is not True):
            raise ValueError('invalid phone configuration')
        from .tickets import uuid
        uuid(self.org)

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        names = ('FOOTHOLD_PHONE_HOST', 'FOOTHOLD_PHONE_PORT', 'FOOTHOLD_PHONE_KEY_PATH',
                 'FOOTHOLD_PHONE_POLICY_NAME', 'FOOTHOLD_PHONE_POLICY_VERSION',
                 'FOOTHOLD_PHONE_ORG_ID', 'FOOTHOLD_PHONE_REPLAY_DB', 'FOOTHOLD_PHONE_CLOCK_TRUSTED')
        if not any(name in env for name in names):
            return None  # explicit opt in, no listener by default
        try:
            return cls(env[names[0]], int(env[names[1]]), env[names[2]], env[names[3]], env[names[4]],
                       env[names[5]], env[names[6]], env[names[7]] == '1')
        except (KeyError, ValueError, TypeError):
            raise ValueError('set all phone host/port/key/policy environment variables') from None


class Server:
    def __init__(self, hub, settings, *, sock=None):
        self.hub, self.settings, self.sock = hub, settings, sock
        self.connections = {}
        self.close_tasks = set()
        self.closing = set()
        self.ready = asyncio.Event()
        self.stopping = asyncio.Event()
        self.failure = None

    async def _send(self, ws, value):
        await asyncio.wait_for(ws.send(json.dumps(value, allow_nan=False, separators=(',', ':'))), .2)

    async def _states(self, ws, peer):
        while peer in self.hub.peers:
            if self.hub.peers[peer].user is not None:
                for notification in self.hub.drain(peer):
                    await self._send(ws, notification)
                if peer in self.hub.peers:
                    await self._send(ws, self.hub.state(peer))
            await asyncio.sleep(.1)

    async def _read(self, ws, peer):
        async for raw in ws:
            if peer not in self.hub.peers:
                raise self.hub.closing.get(peer, PhoneError('CONNECTION_EXPIRED', 4401))
            result = self.hub.receive(peer, raw)
            await self._send(ws, result)

    async def _handler(self, ws):
        from websockets.exceptions import ConnectionClosed
        if ws.request.path != '/phone/ws':
            await ws.close(4403, 'PATH_INVALID')
            return
        if len(self.connections) >= 16:
            await ws.close(1013, 'SERVER_BUSY')
            return
        peer = object()
        self.connections[peer] = ws
        self.hub.peers[peer] = Peer(last_ping=self.hub.now())
        reader = asyncio.create_task(self._read(ws, peer))
        states = asyncio.create_task(self._states(ws, peer))
        try:
            done, _ = await asyncio.wait((reader, states), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except PhoneError as exc:
            await ws.close(exc.close_code, exc.code)
        except (ConnectionClosed, asyncio.TimeoutError):
            pass
        except BaseException as exc:
            # Do not let websockets swallow an output/serialization failure while
            # other clients continue running. The owning run() closes the sink.
            if not isinstance(exc, asyncio.CancelledError):
                self.failure = exc
                self.stopping.set()
            raise
        finally:
            # Local STOP before waiting for sender cancellation or socket close.
            self.hub.disconnect(peer)
            self.connections.pop(peer, None)
            self.closing.discard(peer)
            reader.cancel()
            states.cancel()
            await asyncio.gather(reader, states, return_exceptions=True)
            error = self.hub.closing.pop(peer, None)
            await ws.close(error.close_code if error else 1000, error.code if error else '')

    async def _watchdog(self):
        while True:
            expired = self.hub.tick()  # every 50 ms, independent of network tasks
            for peer, error in expired:
                ws = self.connections.get(peer)
                if ws is not None and peer not in self.closing:
                    # Close frames may wait for transport; safety has already run.
                    self.closing.add(peer)
                    task = asyncio.create_task(ws.close(error.close_code, error.code))
                    self.close_tasks.add(task)
                    task.add_done_callback(self.close_tasks.discard)
            await asyncio.sleep(.05)

    async def run(self):
        from websockets.asyncio.server import serve
        watchdog = waiter = None
        try:
            kwargs = {'sock': self.sock} if self.sock is not None else {
                'host': self.settings.host, 'port': self.settings.port}
            async with serve(self._handler, **kwargs, max_size=4096, max_queue=4,
                             write_limit=4096, compression=None, ping_interval=None,
                             open_timeout=3, close_timeout=.2) as listener:
                try:
                    self.ready.set()
                    watchdog = asyncio.create_task(self._watchdog())
                    waiter = asyncio.create_task(self.stopping.wait())
                    done, _ = await asyncio.wait((watchdog, waiter), return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                    if self.failure is not None:
                        raise RuntimeError('phone service failed') from self.failure
                finally:
                    # Includes cancellation: stop BEFORE listener shutdown waits.
                    self.hub.close()
        finally:
            self.hub.close()
            for task in (watchdog, waiter):
                if task is not None:
                    task.cancel()
            await asyncio.gather(*(t for t in (watchdog, waiter) if t is not None), return_exceptions=True)

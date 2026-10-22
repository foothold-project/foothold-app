"""Separate camera websocket; a blocked camera write never holds control writes."""
import asyncio
import hmac
import json
import secrets
import time

from foothold_agent.phone.tickets import json_object


class CameraTransport:
    def __init__(self, camera, hub, *, now=time.monotonic):
        self.camera, self.hub, self.now = camera, hub, now
        self.tokens = {}
        self.active = {}
        self.pending = 0
        self.waiting_addresses = {}

    def issue(self, peer):
        token = secrets.token_urlsafe(32)
        self.tokens[peer] = (token, self.now() + 10)
        return token

    def forget(self, peer):
        self.tokens.pop(peer, None)
        # Parent presence is rechecked by monitor within 50 ms; no await in STOP.

    def parent_alive(self, peer):
        parent = self.hub.peers.get(peer)
        return parent is not None and parent.user is not None and self.hub.now() < parent.deadline

    async def handler(self, ws):
        from websockets.exceptions import ConnectionClosed
        address = getattr(ws, 'remote_address', None)
        address = address[0] if address else 'local-test'
        if self.waiting_addresses.get(address, 0) >= 2:
            await ws.close(1013, 'CAMERA_ADDRESS_CAPACITY')
            return
        if self.pending >= 16:
            await ws.close(1013, 'CAMERA_CAPACITY')
            return
        self.pending += 1
        self.waiting_addresses[address] = self.waiting_addresses.get(address, 0) + 1
        waiting = True
        peer = queue = None
        tasks = []
        try:
            raw = await asyncio.wait_for(ws.recv(), 1)
            if not isinstance(raw, str) or len(raw.encode()) > 4096:
                raise ValueError('CAMERA_HELLO_INVALID')
            hello = json_object(raw)
            if set(hello) != {'t', 'robot', 'token'} or hello['t'] != 'camera.hello' or hello['robot'] != self.camera.robot or not isinstance(hello['token'], str) or len(hello['token']) > 128:
                raise ValueError('CAMERA_HELLO_INVALID')
            # No URL credential and no reusable pass ticket on this socket.
            peer = next((p for p, (token, deadline) in self.tokens.items()
                         if self.now() < deadline and hmac.compare_digest(token, hello['token'])), None)
            if peer is None or not self.parent_alive(peer) or peer in self.active:
                raise ValueError('CAMERA_UNAUTHORIZED')
            self.tokens.pop(peer)
            self.waiting_addresses[address] -= 1
            if not self.waiting_addresses[address]:
                del self.waiting_addresses[address]
            waiting = False
            self.active[peer] = ws
            queue = self.camera.subscribe()
            tasks = [asyncio.create_task(self._frames(ws, queue)),
                     asyncio.create_task(self._monitor(ws, peer)),
                     asyncio.create_task(self._reject_input(ws))]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except asyncio.TimeoutError:
            await ws.close(1013, 'CAMERA_SEND_TIMEOUT' if queue is not None else 'CAMERA_HELLO_TIMEOUT')
        except ValueError:
            await ws.close(4403, 'CAMERA_UNAUTHORIZED')
        except (ConnectionClosed, OSError):
            pass
        finally:
            self.pending -= 1
            if waiting:
                self.waiting_addresses[address] -= 1
                if not self.waiting_addresses[address]:
                    del self.waiting_addresses[address]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if queue is not None:
                self.camera.unsubscribe(queue)
            if peer is not None and self.active.get(peer) is ws:
                self.active.pop(peer, None)
            await ws.close()

    async def _frames(self, ws, queue):
        while True:
            frame = await queue.get()
            # Timeout only ends camera transport. Never disconnect parent/control.
            await asyncio.wait_for(ws.send(json.dumps(frame, separators=(',', ':'))), .2)

    async def _monitor(self, ws, peer):
        while self.parent_alive(peer):
            await asyncio.sleep(.05)
        await ws.close(4403, 'CAMERA_PARENT_CLOSED')

    async def _reject_input(self, ws):
        await ws.recv()  # receive-only after hello: even a ping/application frame closes
        await ws.close(4403, 'CAMERA_RECEIVE_ONLY')

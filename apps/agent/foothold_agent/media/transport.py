"""Per-channel one-use admission and bounded observation-only writes."""
import asyncio
import hmac
import json
import secrets
import time

from foothold_agent.phone.tickets import json_object
from .stream import CHANNELS

PATH = '/phone/media/ws'


class MediaTransport:
    def __init__(self, media, hub, *, now=time.monotonic):
        self.media, self.hub, self.now = media, hub, now
        self.tokens, self.active = {}, {}
        self.pending, self.addresses = 0, {}

    def issue(self, peer):
        self.forget(peer)
        if self.media.binding is None:
            return None
        channels = {}
        for channel in CHANNELS:
            available = self.media.available(channel)
            token = secrets.token_urlsafe(32) if available else None
            if token is not None:
                self.tokens[peer, channel] = token, self.now() + 10, dict(self.media.binding)
            channels[channel] = dict(available=available,
                reason='Ready' if available else self.media.reason(channel), token=token)
        return dict(version='media/1', path=PATH, **self.media.binding, **channels)

    def forget(self, peer):
        for channel in CHANNELS:
            self.tokens.pop((peer, channel), None)
        # Parent monitor closes within 50 ms without awaiting any control operation.

    def parent_alive(self, peer):
        parent = self.hub.peers.get(peer)
        return parent is not None and parent.user is not None and self.hub.now() < parent.deadline

    def authorize(self, hello):
        keys = {'t', 'version', 'robot', 'epoch', 'episode_id', 'channel', 'token'}
        if (set(hello) != keys or hello['t'] != 'media.hello' or hello['version'] != 'media/1'
                or type(hello['epoch']) is not int or hello['epoch'] < 0
                or hello['channel'] not in CHANNELS or not isinstance(hello['token'], str)
                or len(hello['token']) != 43 or self.media.binding is None):
            raise ValueError('MEDIA_UNAUTHORIZED')
        binding = {key: hello[key] for key in ('robot', 'epoch', 'episode_id')}
        if binding != self.media.binding:
            raise ValueError('MEDIA_UNAUTHORIZED')
        channel = hello['channel']
        for (peer, registered), (token, deadline, issued_binding) in tuple(self.tokens.items()):
            if (registered == channel and hmac.compare_digest(token, hello['token'])
                    and self.now() < deadline and issued_binding == binding
                    and self.parent_alive(peer) and (peer, channel) not in self.active):
                self.tokens.pop((peer, channel))
                return peer, channel, binding
        raise ValueError('MEDIA_UNAUTHORIZED')

    async def handler(self, ws):
        from websockets.exceptions import ConnectionClosed
        address = getattr(ws, 'remote_address', None)
        address = address[0] if address else 'local-test'
        if self.pending >= 32 or self.addresses.get(address, 0) >= 4:
            await ws.close(1013, 'MEDIA_CAPACITY')
            return
        self.pending += 1
        self.addresses[address] = self.addresses.get(address, 0) + 1
        waiting = True
        peer = queue = channel = None
        tasks = []
        try:
            raw = await asyncio.wait_for(ws.recv(), 1)
            if not isinstance(raw, str) or len(raw.encode()) > 4096:
                raise ValueError('MEDIA_HELLO_INVALID')
            peer, channel, binding = self.authorize(json_object(raw))
            self.addresses[address] -= 1
            waiting = False
            self.active[peer, channel] = ws
            queue = self.media.subscribe(channel)
            tasks = [asyncio.create_task(self._frames(ws, channel, queue, binding)),
                     asyncio.create_task(self._monitor(ws, peer, binding)),
                     asyncio.create_task(self._reject_input(ws))]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except asyncio.TimeoutError:
            await ws.close(1013, 'MEDIA_TIMEOUT')
        except (ValueError, TypeError, KeyError):
            await ws.close(4403, 'MEDIA_UNAUTHORIZED')
        except (ConnectionClosed, OSError):
            pass
        finally:
            self.pending -= 1
            if waiting:
                self.addresses[address] -= 1
            if not self.addresses.get(address):
                self.addresses.pop(address, None)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if queue is not None:
                self.media.unsubscribe(channel, queue)
            if peer is not None and self.active.get((peer, channel)) is ws:
                self.active.pop((peer, channel), None)
            await ws.close()

    async def _frames(self, ws, channel, queue, binding):
        next_send = float('-inf')
        while True:
            await asyncio.sleep(max(0, next_send - self.now()))
            received, header, payload = await queue.get()
            if self.media.binding != binding:
                return
            if not 0 <= self.now() - received <= 1:
                header, payload = self.media.status(channel), None
            # Serialization is bounded; conversion/base64 were done in the process.
            text = json.dumps(header, separators=(',', ':'), allow_nan=False)
            async def send():
                await ws.send(text)
                if payload is not None:
                    await ws.send(payload)  # no other writer can interleave a header
            await asyncio.wait_for(send(), .2)
            next_send = self.now() + (.5 if channel == 'lidar' else .2)

    async def _monitor(self, ws, peer, binding):
        while self.parent_alive(peer) and self.media.binding == binding and not self.media.closed:
            await asyncio.sleep(.05)
        await ws.close(4403, 'MEDIA_PARENT_OR_BINDING_CLOSED')

    async def _reject_input(self, ws):
        await ws.recv()
        await ws.close(4403, 'MEDIA_RECEIVE_ONLY')

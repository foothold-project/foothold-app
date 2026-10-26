"""Late media readiness never delays authenticated hello, STOP or deadman."""
import asyncio
import json
import time
from types import SimpleNamespace
from uuid import uuid4

from test_phone import h, phone_socket, signed
from foothold_agent.media import Media, MediaTransport
from foothold_agent.phone.server import Server, Settings
from foothold_agent.safety.core import Z


async def receive(ws, kind):
    for _ in range(40):
        value = json.loads(await asyncio.wait_for(ws.recv(), 1))
        if value['t'] == kind:
            return value
    raise AssertionError('missing ' + kind)


def test_initially_unbound_media_updates_without_reconnect_and_stop_is_immediate(h):
    from websockets.asyncio.client import connect
    async def run():
        owner, _ = h.moving()
        media = Media(h.robot)
        media.processes = {channel: (SimpleNamespace(is_alive=lambda: True),)
                           for channel in ('rgb', 'lidar')}
        transport = MediaTransport(media, h.hub, now=h.clock)
        with phone_socket() as sock:
            port = sock.getsockname()[1]
            server = Server(h.hub, Settings('127.0.0.1', port, 'unused', 'test', '1', h.org,
                'unused-replay.sqlite', True, True), sock=sock, media=transport)
            task = asyncio.create_task(server.run())
            await asyncio.wait_for(server.ready.wait(), 1)
            try:
                async with connect(f'ws://127.0.0.1:{port}/phone/ws') as ws:
                    claims = h.claims(purpose='view')
                    began = time.monotonic()
                    await ws.send(json.dumps(dict(t='hello', id='1', robot=h.robot, proto='fh-phone/1',
                        device=claims['device'], ticket=signed(h.key, claims))))
                    hello = await receive(ws, 'hello')
                    assert 'media' not in hello and time.monotonic()-began < .2
                    # Still no binding: STOP must use the normal reader immediately.
                    began = time.monotonic()
                    await ws.send(json.dumps(dict(t='stop', id='2', robot=h.robot)))
                    assert (await receive(ws, 'reply'))['ok']
                    assert time.monotonic()-began < .2
                    assert h.outputs[-1].velocity == Z and h.hub.session.core.latch
                    h.unlock(owner)
                    h.cmd(owner, 0)
                    h.cmd(owner)
                    assert h.outputs[-1].velocity != Z
                    entered, release = asyncio.Event(), asyncio.Event()
                    original_send = server._send
                    async def stalled_offer(socket, value):
                        if value['t'] == 'media.update':
                            entered.set()
                            await release.wait()
                        await original_send(socket, value)
                    server._send = stalled_offer
                    binding = dict(robot=h.robot, epoch=1, episode_id=str(uuid4()))
                    media.bind(binding)
                    await asyncio.wait_for(entered.wait(), 1)
                    # A stalled observation writer cannot delay the safety tick.
                    h.clock.t = .30001
                    h.hub.tick()
                    assert h.outputs[-1].velocity == Z and h.hub.session.core.need_neutral
                    began = time.monotonic()
                    await ws.send(json.dumps(dict(t='stop', id='3', robot=h.robot)))
                    assert (await receive(ws, 'reply'))['ok']
                    assert time.monotonic()-began < .2 and h.hub.session.core.latch
                    release.set()
                    update = await receive(ws, 'media.update')
                    from apps.contracts.models import PhoneMediaUpdate
                    PhoneMediaUpdate.model_validate(update)
                    assert update['robot'] == h.robot
                    assert all(update['media'][k] == v for k, v in binding.items())
                    peer = next(p for p in server.connections)
                    info = update['media']
                    assert transport.authorize(dict(t='media.hello', version='media/1', channel='lidar',
                        token=info['lidar']['token'], **binding))[:2] == (peer, 'lidar')
                    media.bind(None)
                    assert (await receive(ws, 'media.update'))['media'] is None
                    media.bind({**binding, 'epoch': 2})
                    assert (await receive(ws, 'media.update'))['media']['epoch'] == 2
                    # No repeat offers/tokens on ordinary periodic state messages.
                    for _ in range(3):
                        assert json.loads(await ws.recv())['t'] != 'media.update'
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())

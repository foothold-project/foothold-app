"""No ROS/robot: real conversion children, one-use admission and bounded sockets."""
import asyncio
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import struct
import time
from types import SimpleNamespace
from uuid import uuid4

import pytest
from PIL import Image

from apps.contracts.models import MediaPointCloudHeader, MediaVideoFrame, PhoneMediaWelcome
from foothold_agent.media import Media, MediaTransport
from foothold_agent.media.processing import convert, points, video
from foothold_agent.ros_bridge.media import MediaRosSource
from test_phone import h, Harness, signed


def jpeg(size=(40, 30)):
    output = BytesIO()
    Image.new('RGB', size, 'red').save(output, 'JPEG')
    return output.getvalue()


def cloud(xyz=((1., 2., 3.),), *, big=False, pad=0):
    data = b''.join(struct.pack('>fff' if big else '<fff', *p) for p in xyz) + b'\0' * pad
    return (data, len(xyz), 1, 12, len(data), big,
            (('x', 0, 7, 1), ('y', 4, 7, 1), ('z', 8, 7, 1)), 'lidar_link')


@pytest.fixture
def media(h):
    stream = Media(h.robot)
    stream.bind(dict(robot=h.robot, epoch=1, episode_id=str(uuid4())))
    stream.start()
    yield stream
    stream.close()


def test_complete_jpeg_decode_and_bounds():
    assert video(jpeg())['width'] == 40
    for data in (jpeg((641, 30)), jpeg()[:30] + b'\xff\xd9', b'\xff\xd8\xff\xd9', jpeg()+b'x', b'x'*65537):
        with pytest.raises((ValueError, OSError)):
            video(data)


def test_voxel_cap_little_endian_and_layout():
    header, payload = points(cloud(((1., 2., 3.), (1.01, 2.01, 3.01)), big=True, pad=8))
    assert header['count'] == 1 and payload == struct.pack('<fff', 1, 2, 3)
    assert header['frame'] == 'lidar_link' and header['map_version_id'] is None and header['pose'] is None
    header, payload = points(cloud(tuple((float(i), 0., 0.) for i in range(4001))))
    assert header['count'] == 4000 and header['truncated'] and len(payload) == 48000


@pytest.mark.parametrize('value', [float('nan'), float('inf'), -10001., 10001.])
def test_reject_nonfinite_and_range(value):
    with pytest.raises(ValueError):
        points(cloud(((value, 0, 0),)))


def test_reject_bad_cloud_fields_and_length():
    good = cloud()
    for bad in (good[:-1]+('map',), (b'x',)+good[1:], good[:6]+((('x', 0, 7, 1),),)+good[7:],
                good[:3]+(4,)+good[4:], good[:1]+(100001,)+good[2:]):
        with pytest.raises(ValueError):
            points(bad)


def test_capture_time_and_receipt_freshness():
    binding = dict(robot=str(uuid4()), epoch=1, episode_id=None)
    for age in (1.1, -1.1):
        captured = (datetime.now(timezone.utc)-timedelta(seconds=age)).isoformat()
        assert convert('rgb', (binding, 1, time.monotonic(), captured, jpeg())) is None
    assert convert('rgb', (binding, 1, time.monotonic()-1.1, datetime.now(timezone.utc).isoformat(), jpeg())) is None


def test_tokens_channel_parent_tenant_epoch_and_replay(h, media):
    peer, _, _ = h.connect()
    transport = MediaTransport(media, h.hub, now=h.clock)
    welcome = transport.issue(peer)
    PhoneMediaWelcome.model_validate(welcome)
    assert welcome['external'] == dict(available=False, reason='External camera source is not connected', token=None)
    hello = dict(t='media.hello', version='media/1', channel='rgb', token=welcome['rgb']['token'], **media.binding)
    for change in ({'token': 'x'*43}, {'robot': str(uuid4())}, {'epoch': 0}, {'epoch': True},
                   {'episode_id': str(uuid4())}, {'channel': 'lidar'}, {'org': str(uuid4())}):
        with pytest.raises(ValueError):
            transport.authorize({**hello, **change})
    assert transport.authorize(hello)[:2] == (peer, 'rgb')
    with pytest.raises(ValueError):
        transport.authorize(hello)
    # Tenant isolation is inherited from phone verifier; no media ticket bypass.
    payload = h.claims(org=str(uuid4()))
    with pytest.raises(ValueError):
        h.verifier.verify(signed(h.key, payload))
    token = welcome['lidar']['token']
    h.hub.disconnect(peer)
    with pytest.raises(ValueError):
        transport.authorize({**hello, 'channel': 'lidar', 'token': token})


def test_token_expiry_and_binding_switch(h, media):
    peer, _, _ = h.connect()
    transport = MediaTransport(media, h.hub, now=h.clock)
    info = transport.issue(peer)
    hello = dict(t='media.hello', version='media/1', channel='lidar', token=info['lidar']['token'], **media.binding)
    h.clock.t = 10
    with pytest.raises(ValueError):
        transport.authorize(hello)
    h.clock.t = 0
    info = transport.issue(peer)
    media.bind({**media.binding, 'epoch': 2})
    with pytest.raises(ValueError):
        transport.authorize({**hello, 'token': info['lidar']['token']})


async def wait_frame(stream, channel):
    deadline = time.monotonic() + 4
    queue = stream.subscribe(channel)
    try:
        while time.monotonic() < deadline:
            stream.sample()
            while not queue.empty():
                item = queue.get_nowait()
                if item[1]['t'] != 'media.status':
                    return item
            await asyncio.sleep(.025)
        raise AssertionError('conversion did not produce a frame')
    finally:
        stream.unsubscribe(channel, queue)


def test_real_workers_contracts_freshness_latest_only(h, media):
    async def run():
        assert media.submit('rgb', jpeg())
        assert not media.submit('rgb', jpeg())  # 5Hz wall limit
        assert media.submit('lidar', cloud())
        rgb, lidar = await asyncio.gather(wait_frame(media, 'rgb'), wait_frame(media, 'lidar'))
        MediaVideoFrame.model_validate(rgb[1])
        header = MediaPointCloudHeader.model_validate(lidar[1])
        header.validate_payload(lidar[2])
        queue = media.subscribe('rgb')
        await asyncio.sleep(1.1)
        media.sample()
        assert queue.qsize() == 1 and queue.get_nowait()[1]['state'] == 'NO_VIDEO'
        media.unsubscribe('rgb', queue)
    asyncio.run(run())


def test_ros_source_rejects_old_future_duplicate_epoch(media):
    source = MediaRosSource(media)
    source.update_time(1, 10)
    message = SimpleNamespace(header=SimpleNamespace(stamp=SimpleNamespace(sec=10, nanosec=0)))
    assert source.fresh('lidar', message)
    assert not source.fresh('lidar', message)
    for stamp in (8, 12):
        message.header.stamp.sec = stamp
        assert not source.fresh('rgb', message)
    source.update_time(2, 10)
    assert not source.fresh('rgb', message)


class SlowSocket:
    def __init__(self):
        self.sent = []
    async def send(self, message):
        await asyncio.sleep(10)


def test_slow_viewer_rgb_lidar_stop_deadman_regression(h, media):
    async def run():
        owner, _ = h.moving()
        transport = MediaTransport(media, h.hub)
        queues = {c: media.subscribe(c) for c in ('rgb', 'lidar')}
        tasks = [asyncio.create_task(transport._frames(SlowSocket(), c, q, dict(media.binding)))
                 for c, q in queues.items()]
        try:
            assert media.submit('rgb', jpeg()) and media.submit('lidar', cloud(tuple((i*.11, 0., 0.) for i in range(8000))))
            # Both converters busy, both viewers stalled; safety needs no media operation.
            started = time.monotonic()
            h.send(owner, 'stop')
            assert time.monotonic() - started < .05
            assert h.outputs[-1].velocity == (0., 0., 0.)
            h.unlock(owner)
            h.cmd(owner, 0)
            h.cmd(owner)
            h.clock.t = .30001
            started = time.monotonic()
            h.hub.tick()
            assert time.monotonic() - started < .05
            assert h.outputs[-1].velocity == (0., 0., 0.) and h.hub.session.core.need_neutral
            results = await asyncio.gather(*tasks, return_exceptions=True)
            assert all(isinstance(result, asyncio.TimeoutError) for result in results)
            assert all(q.qsize() <= 1 for q in queues.values())
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for channel, queue in queues.items():
                media.unsubscribe(channel, queue)
    asyncio.run(run())


def test_loopback_media_binary_order_parent_close_and_legacy_camera(h, media):
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed
    from foothold_agent.phone.server import Server, Settings
    from foothold_agent.camera import Camera, CameraTransport
    from apps.contracts.models import PhoneWelcome
    from test_phone import phone_socket

    async def receive_kind(ws, kind):
        for _ in range(30):
            value = json.loads(await asyncio.wait_for(ws.recv(), 3))
            if value['t'] == kind:
                return value
        raise AssertionError('message did not arrive: ' + kind)

    async def run():
        transport = MediaTransport(media, h.hub)
        camera = Camera(h.robot)
        with phone_socket() as sock:
            port = sock.getsockname()[1]
            server = Server(h.hub, Settings('127.0.0.1', port, 'unused', 'test', '1', h.org,
                            'unused-replay.sqlite', True, True), sock=sock,
                            camera=CameraTransport(camera, h.hub), media=transport)
            tasks = [asyncio.create_task(server.run()), asyncio.create_task(media.run()),
                     asyncio.create_task(camera.run())]
            await asyncio.wait_for(server.ready.wait(), 2)
            root = f'ws://127.0.0.1:{port}'
            try:
                async with connect(root+'/phone/ws') as control:
                    claims = h.claims(purpose='view')
                    await control.send(json.dumps(dict(t='hello', id='1', robot=h.robot, proto='fh-phone/1',
                        device=claims['device'], ticket=signed(h.key, claims))))
                    welcome = await receive_kind(control, 'hello')
                    PhoneWelcome.model_validate(welcome)
                    info = welcome['media']
                    assert not info['external']['available'] and info['external']['token'] is None
                    def hello(channel):
                        return dict(t='media.hello', version='media/1', channel=channel,
                            token=info[channel]['token'], **media.binding)
                    async with connect(root+info['path']) as lidar:
                        await lidar.send(json.dumps(hello('lidar')))
                        assert media.submit('lidar', cloud())
                        header = MediaPointCloudHeader.model_validate(await receive_kind(lidar, 'media.points'))
                        binary = await asyncio.wait_for(lidar.recv(), 1)
                        assert isinstance(binary, bytes)
                        header.validate_payload(binary)
                        # This is observation-only; an application binary never reaches control.
                        await lidar.send(b'command')
                        await asyncio.wait_for(lidar.wait_closed(), 1)
                        assert lidar.close_code == 4403
                    async with connect(root+info['path']) as replay:
                        await replay.send(json.dumps(hello('lidar')))
                        await asyncio.wait_for(replay.wait_closed(), 1)
                        assert replay.close_code == 4403
                    async with connect(root+'/phone/camera/ws') as legacy:
                        await legacy.send(json.dumps(dict(t='camera.hello', robot=h.robot, token=welcome['camera_token'])))
                        assert camera.submit(jpeg())
                        assert (await receive_kind(legacy, 'camera.frame'))['width'] == 40
                    async with connect(root+info['path']) as rgb:
                        await rgb.send(json.dumps(hello('rgb')))
                        assert media.submit('rgb', jpeg())
                        MediaVideoFrame.model_validate(await receive_kind(rgb, 'media.video'))
                        await control.send(json.dumps(dict(t='ping', id='2', robot=h.robot, client_time_ms=0)))
                        assert (await receive_kind(control, 'reply'))['ok']
                        await control.close()
                        await asyncio.wait_for(rgb.wait_closed(), 1)
                        assert rgb.close_code == 4403
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.run(run())


def test_shared_mailbox_overwrites_without_a_feeder_backlog():
    import multiprocessing
    from foothold_agent.media.mailbox import LatestSlot
    slot = LatestSlot(multiprocessing.get_context('spawn'), 1024)
    for value in range(1000):
        assert slot.put(value)
    assert slot.take() == 999 and slot.take() is None
    assert not slot.put(b'x'*1024)


def test_reset_discards_same_epoch_inflight_conversion(h, media):
    binding, generation = dict(media.binding), media.generation
    header = dict(binding, t='media.video')
    media.bind(None)
    media.bind(binding)
    assert not media.submit('rgb', jpeg(), expected_generation=generation)
    assert media.processes['rgb'][2].put((generation, time.monotonic(), header, None))
    media.sample()
    assert 'rgb' not in media.latest

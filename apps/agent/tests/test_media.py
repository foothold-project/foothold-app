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
from foothold_agent.ros_bridge.media import MediaRosSource, external_source
from test_phone import h, Harness, signed


def jpeg(size=(40, 30)):
    output = BytesIO()
    Image.new('RGB', size, 'red').save(output, 'JPEG')
    return output.getvalue()


def compressed(data, stamp=10):
    return SimpleNamespace(header=SimpleNamespace(stamp=SimpleNamespace(sec=stamp, nanosec=0)),
                           format='jpeg', data=data)


def cloud(xyz=((1., 2., 3.),), *, big=False, pad=0):
    data = b''.join(struct.pack('>fff' if big else '<fff', *p) for p in xyz) + b'\0' * pad
    return (data, len(xyz), 1, 12, len(data), big,
            (('x', 0, 7, 1), ('y', 4, 7, 1), ('z', 8, 7, 1)), 'lidar_link')


def organized_l1(*, big=False, pad=0):
    """Synthetic adapter-shaped scan: 360x6, sim stamp, missing ray returns.

    The native adapter preserves nonfinite coordinates while aliasing the frame.
    No recorded points or map data are used here.
    """
    width, height, step = 360, 6, 16
    row_step = width * step + pad
    pack = struct.Struct('>ffff' if big else '<ffff').pack
    rows = []
    for row in range(height):
        cells = []
        for column in range(width):
            xyz = ((1., 2., 3.) if (row, column) in ((0, 1), (0, 2)) else
                   (4., 5., 6.) if (row, column) == (5, 359) else
                   (float('nan'), float('inf'), -float('inf')))
            cells.append(pack(*xyz, 10.))
        rows.append(b''.join(cells) + b'\0' * pad)
    return SimpleNamespace(
        header=SimpleNamespace(frame_id='lidar_link', stamp=SimpleNamespace(sec=310, nanosec=800_000_000)),
        width=width, height=height, point_step=step, row_step=row_step,
        data=b''.join(rows), is_bigendian=big, is_dense=False,
        fields=tuple(SimpleNamespace(name=name, offset=offset, datatype=7, count=1)
                     for name, offset in (('x', 0), ('y', 4), ('z', 8), ('intensity', 12))))


@pytest.mark.parametrize('big,pad', [(False, 0), (False, 8), (True, 0), (True, 8)])
def test_organized_l1_missing_returns_preserve_valid_points(big, pad):
    message = organized_l1(big=big, pad=pad)
    raw = (message.data, message.width, message.height, message.point_step,
           message.row_step, message.is_bigendian,
           tuple((f.name, f.offset, f.datatype, f.count) for f in message.fields),
           message.header.frame_id)
    binding = dict(robot=str(uuid4()), epoch=1, episode_id=str(uuid4()))
    converted = convert('lidar', (binding, 1, time.monotonic(), datetime.now(timezone.utc).isoformat(), raw))
    assert converted is not None
    header, payload = converted[2:]
    parsed = MediaPointCloudHeader.model_validate({**header, 'seq': 1})
    parsed.validate_payload(payload)
    assert header['count'] == 2 and not header['truncated']
    assert header['frame'] == 'lidar_link' and header['pose'] is None and header['map_version_id'] is None
    assert payload == struct.pack('<ffffff', 1., 2., 3., 4., 5., 6.)


@pytest.fixture
def media(h, request):
    stream = Media(h.robot, external_source='gazebo_external' if getattr(request, 'param', False) else None)
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


@pytest.mark.parametrize('value', [-10001., 10001.])
def test_reject_finite_out_of_range(value):
    with pytest.raises(ValueError):
        points(cloud(((value, 0, 0),)))


@pytest.mark.parametrize('value', [float('nan'), float('inf'), -float('inf')])
@pytest.mark.parametrize('axis', [0, 1, 2])
def test_missing_returns_never_enter_payload_or_voxels(value, axis):
    bad = [0., 0., 0.]
    bad[axis] = value
    header, payload = points(cloud(((1., 2., 3.), bad, (4., 5., 6.))))
    assert header['count'] == 2 and not header['truncated']
    assert payload == struct.pack('<ffffff', 1., 2., 3., 4., 5., 6.)
    header, payload = points(cloud((bad,)))
    assert header['count'] == 0 and not header['truncated'] and payload == b''


def test_reject_bad_cloud_fields_and_length():
    good = cloud()
    for bad in (good[:-1]+('map',), (b'x',)+good[1:], good[:6]+((('x', 0, 7, 1),),)+good[7:],
                good[:3]+(4,)+good[4:], good[:1]+(100001,)+good[2:]):
        with pytest.raises(ValueError):
            points(bad)


@pytest.mark.parametrize('channel', ['rgb', 'external'])
def test_capture_time_and_receipt_freshness(channel):
    binding = dict(robot=str(uuid4()), epoch=1, episode_id=None)
    for age in (1.1, -1.1):
        captured = (datetime.now(timezone.utc)-timedelta(seconds=age)).isoformat()
        assert convert(channel, (binding, 1, time.monotonic(), captured, jpeg())) is None
    assert convert(channel, (binding, 1, time.monotonic()-1.1, datetime.now(timezone.utc).isoformat(), jpeg())) is None


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


@pytest.mark.parametrize('media', [True], indirect=True)
@pytest.mark.parametrize('channel', ['lidar', 'external'])
def test_token_expiry_and_binding_switch(h, media, channel):
    peer, _, _ = h.connect()
    transport = MediaTransport(media, h.hub, now=h.clock)
    info = transport.issue(peer)
    hello = dict(t='media.hello', version='media/1', channel=channel, token=info[channel]['token'], **media.binding)
    if channel == 'external':
        with pytest.raises(ValueError):
            transport.authorize({**hello, 'token': info['rgb']['token']})
    h.clock.t = 10
    with pytest.raises(ValueError):
        transport.authorize(hello)
    h.clock.t = 0
    info = transport.issue(peer)
    media.bind({**media.binding, 'epoch': 2})
    with pytest.raises(ValueError):
        transport.authorize({**hello, 'token': info[channel]['token']})


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


def test_organized_l1_sim_stamp_through_source_worker_and_transport(media):
    async def run():
        source = MediaRosSource(media)
        source.update_time(1, 310.9)
        source.cloud(organized_l1())
        frame = await wait_frame(media, 'lidar')
        header = MediaPointCloudHeader.model_validate(frame[1])
        header.validate_payload(frame[2])
        assert header.count == 2 and header.frame == 'lidar_link'
        # Capture UTC comes from receipt; the ROS sim stamp is never UTC.
        assert abs((datetime.now(timezone.utc) - header.captured_at).total_seconds()) < 1
        assert frame[1]['epoch'] == 1 and frame[1]['episode_id'] == media.binding['episode_id']
        source.cloud(organized_l1())
        assert media.processes['lidar'][1].take() is None  # duplicate sim stamp

        class Socket:
            def __init__(self):
                self.sent = []
            async def send(self, value):
                self.sent.append(value)

        queue, socket = asyncio.Queue(maxsize=1), Socket()
        queue.put_nowait(frame)
        transport = MediaTransport(media, None)
        task = asyncio.create_task(transport._frames(socket, 'lidar', queue, dict(media.binding)))
        try:
            await asyncio.sleep(.01)
            assert json.loads(socket.sent[0])['count'] == 2
            assert socket.sent[1] == struct.pack('<ffffff', 1., 2., 3., 4., 5., 6.)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
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


@pytest.mark.parametrize('media', [True], indirect=True)
def test_slow_viewer_rgb_lidar_stop_deadman_regression(h, media):
    async def run():
        owner, _ = h.moving()
        transport = MediaTransport(media, h.hub)
        queues = {c: media.subscribe(c) for c in ('rgb', 'external', 'lidar')}
        tasks = [asyncio.create_task(transport._frames(SlowSocket(), c, q, dict(media.binding)))
                 for c, q in queues.items()]
        tasks.append(asyncio.create_task(media.run()))
        try:
            assert media.submit('rgb', jpeg()) and media.submit('lidar', cloud(tuple((i*.11, 0., 0.) for i in range(8000))))
            assert media.submit('external', jpeg((320, 240)))
            # Let actual conversion and stalled sends overlap before measuring safety.
            await asyncio.sleep(.05)
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
            results = await asyncio.gather(*tasks[:-1], return_exceptions=True)
            assert all(isinstance(result, asyncio.TimeoutError) for result in results)
            assert all(q.qsize() <= 1 for q in queues.values())
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for channel, queue in queues.items():
                media.unsubscribe(channel, queue)
    asyncio.run(run())


@pytest.mark.parametrize('media', [False, True], indirect=True)
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
                    assert info['external']['available'] == media.available('external')
                    if not media.available('external'):
                        assert info['external']['token'] is None
                    def hello(channel):
                        return dict(t='media.hello', version='media/1', channel=channel,
                            token=info[channel]['token'], **media.binding)
                    if media.available('external'):
                        assert len(info['external']['token']) == 43
                        async with connect(root+info['path']) as external:
                            await external.send(json.dumps(hello('external')))
                            source = MediaRosSource(media)
                            source.update_time(1, 10)
                            source.external(compressed(jpeg((320, 240))))
                            frame = MediaVideoFrame.model_validate(await receive_kind(external, 'media.video'))
                            assert frame.channel == 'external' and frame.source == 'gazebo_external'
                            assert (frame.width, frame.height) == (320, 240)
                            assert str(frame.episode_id) == media.binding['episode_id'] and frame.epoch == 1
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


@pytest.mark.parametrize('media', [True], indirect=True)
@pytest.mark.parametrize('channel', ['rgb', 'external'])
def test_reset_discards_same_epoch_inflight_conversion(h, media, channel):
    binding, generation = dict(media.binding), media.generation
    header = dict(binding, t='media.video')
    media.bind(None)
    media.bind(binding)
    assert not media.submit(channel, jpeg(), expected_generation=generation)
    assert media.processes[channel][2].put((generation, time.monotonic(), header, None))
    media.sample()
    assert channel not in media.latest


@pytest.mark.parametrize('world', ['warehouse', 'rubble', 'v5_building'])
def test_external_adapter_requires_verified_launch_and_supported_world(world, monkeypatch):
    from dataclasses import replace
    from foothold_agent.executor.nav2.simulation import SimulationBinding
    from test_warehouse_floor import launch as warehouse
    from test_rubble_floor import launch as rubble
    from test_floor_telemetry import launch as building
    floors = {'warehouse': warehouse, 'rubble': rubble, 'v5_building': building}[world]()
    floors.run_id = str(uuid4())
    config = SimpleNamespace(robot_id=floors.robot_id, phone=SimpleNamespace(simulation=True), floor_bindings=floors)
    proof = SimulationBinding(config.robot_id, floors.run_id, floors.generation, floors.epoch,
                              tuple((b['world_id'], b['floor_id'], b['sha256']) for b in floors.bindings.values()))
    monkeypatch.setenv('FOOTHOLD_EXTERNAL_CAMERA_ENABLED', '1')
    assert external_source(config, None) is None  # env plus floor bindings alone never suffices
    assert external_source(config, proof) == (None if world == 'v5_building' else 'gazebo_external')
    for bad in (replace(proof, run_id=str(uuid4())), replace(proof, robot_id=str(uuid4())),
                replace(proof, generation=99), replace(proof, epoch=99), replace(proof, maps=())):
        assert external_source(config, bad) is None
    config.phone.simulation = False
    assert external_source(config, proof) is None


@pytest.mark.parametrize('media', [True], indirect=True)
def test_external_bounds_ros_freshness_no_video_and_seq(media):
    async def run():
        source = MediaRosSource(media)
        source.update_time(1, 10)
        incoming = media.processes['external'][1]
        for message in (compressed(b'x'*65537), compressed(jpeg(), 8), compressed(jpeg(), 12)):
            source.external(message)
            assert incoming.take() is None
        # Oversize advanced only the ROS stamp. A newer bounded frame can proceed.
        source.update_time(1, 11)
        source.external(compressed(jpeg((320, 240)), 11))
        first = await wait_frame(media, 'external')
        MediaVideoFrame.model_validate(first[1])
        assert first[1]['seq'] == 1 and first[1]['source'] == 'gazebo_external'
        source.external(compressed(jpeg((320, 240)), 11))
        assert incoming.take() is None  # duplicate
        queue = media.subscribe('external')
        await asyncio.sleep(1.1)
        media.sample()
        assert queue.qsize() == 1 and queue.get_nowait()[1]['state'] == 'NO_VIDEO'
        source.external(compressed(jpeg(), 12))
        assert incoming.take() is None  # accepted state is now stale
        media.bind({**media.binding, 'epoch': 2})
        source.external(compressed(jpeg(), 0))
        assert incoming.take() is None  # epoch clock mismatch
        source.update_time(2, 0)
        source.external(compressed(jpeg((320, 240)), 0))
        second = await wait_frame(media, 'external')
        assert second[1]['seq'] == 2 and second[1]['epoch'] == 2
        media.unsubscribe('external', queue)
    asyncio.run(run())


@pytest.mark.parametrize('media', [True], indirect=True)
@pytest.mark.parametrize('blocked,live', [('rgb', 'external'), ('external', 'rgb')])
def test_video_channels_do_not_share_worker_mailbox_or_admission(media, blocked, live):
    # Occupy exactly one mailbox, as if that decoder were stalled inside a read.
    slot = media.processes[blocked][1]
    assert slot.lock.acquire(False)
    try:
        assert not media.submit(blocked, jpeg())
        assert media.submit(live, jpeg())
        frame = asyncio.run(wait_frame(media, live))
        assert frame[1]['channel'] == live and frame[1]['seq'] == 1
        assert media.processes[blocked][0] != media.processes[live][0]
    finally:
        slot.lock.release()


@pytest.mark.parametrize('enabled', [False, True])
def test_external_subscription_reuses_ros_context_executor_and_depth_one(enabled, monkeypatch):
    import sys
    from foothold_agent.ros_bridge.media import RGB_TOPIC, POINT_TOPIC, EXTERNAL_TOPIC
    calls, contexts, executors = [], [], []
    stream = Media(str(uuid4()), external_source='gazebo_external' if enabled else None)
    source = MediaRosSource(stream)
    class Context:
        def __init__(self):
            contexts.append(self)
        def ok(self):
            return True
        def shutdown(self):
            pass
    class Executor:
        def __init__(self, **kwargs):
            executors.append(self)
        def add_node(self, node):
            pass
        def spin_once(self, **kwargs):
            source.closing.set()
        def shutdown(self, **kwargs):
            pass
    node = SimpleNamespace(create_subscription=lambda typ, topic, callback, qos: calls.append((topic, qos)),
                           destroy_node=lambda: None)
    modules = {'rclpy': SimpleNamespace(init=lambda **kwargs: None, create_node=lambda *args, **kwargs: node),
               'rclpy.context': SimpleNamespace(Context=Context),
               'rclpy.executors': SimpleNamespace(SingleThreadedExecutor=Executor),
               'rclpy.qos': SimpleNamespace(qos_profile_sensor_data=SimpleNamespace(depth=5, reliability='BEST_EFFORT')),
               'sensor_msgs': SimpleNamespace(),
               'sensor_msgs.msg': SimpleNamespace(CompressedImage=object, PointCloud2=object)}
    for name, value in modules.items():
        monkeypatch.setitem(sys.modules, name, value)
    monkeypatch.setattr('foothold_agent.ros_bridge.media.validate_isolation', lambda: None)
    source._run()
    assert source.error is None and len(contexts) == len(executors) == 1
    assert {topic for topic, _ in calls} == {RGB_TOPIC, POINT_TOPIC} | ({EXTERNAL_TOPIC} if enabled else set())
    assert all(qos.depth == 1 and qos.reliability == 'BEST_EFFORT' for _, qos in calls)


def test_missing_decoder_disables_external_and_rgb(monkeypatch):
    monkeypatch.setattr('foothold_agent.media.stream.importlib.util.find_spec', lambda name: None)
    stream = Media(str(uuid4()), external_source='gazebo_external')
    assert stream.reason('external') == stream.reason('rgb') == 'JPEG decoder (Pillow) is unavailable'

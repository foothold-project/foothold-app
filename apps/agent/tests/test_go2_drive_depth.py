"""Server drive depth uses fake setup samples, SDK, identity and HTTP only."""
import asyncio
import json
import time
from types import SimpleNamespace as NS

import numpy as np
import pytest

from apps.contracts.models import MediaVideoFrame
from foothold_agent.depth.convert import colour
from foothold_agent.go2_direct.media import Publisher, Source
from test_depth import raw
from test_go2_media_identity import recorder
from test_setup_pairing import credentials


def source_with_depth(depth):
    creds = credentials()
    config = NS(robot=creds.robot_id, link=creds.link)
    return Source(config, {}, None, recorder=recorder(), include_depth=False, depth_source=depth)


def test_fresh_setup_depth_upload_reuses_metric_format_and_http_bounds():
    # RealSense's expected 640x480 Z16, with high entropy to exercise JPEG bounds.
    values = np.random.default_rng(42).integers(0, 8000, (480, 640), dtype=np.uint16)
    header, payload = colour(raw(values))
    header.update(version='media/1', robot=credentials().robot_id, epoch=999,
                  episode_id=None, channel='depth', seq=7, captured_at='2026-11-19T00:00:00Z')
    sample = time.monotonic(), header, payload
    depth = NS(sample=lambda _: sample)
    source = source_with_depth(depth)
    publisher = Publisher(source.config, {}, None, source_factory=lambda *_: source)
    requests = []
    class Response:
        status = 202
        def read(self, size): return b''
        def close(self): pass
    publisher.opener = NS(open=lambda request, **_: (requests.append(request), Response())[1])
    try:
        received, outbound, body = source.sample('depth')
        MediaVideoFrame.model_validate(outbound)
        publisher.upload('depth', outbound, body)
        request = requests[0]
        message = json.loads(request.data)
        assert request.full_url.endswith('/drive-media/depth')
        assert len(request.data) <= 100_000
        assert message['header']['source'] == 'go2_depth'
        assert (message['header']['width'], message['header']['height']) == (480, 360)
        assert message['header']['depth_min_m'] == .2 and message['header']['depth_max_m'] == 5.
        assert message['header']['epoch'] == source.epoch != 999
        assert message['header']['seq'] == 7 and message['points'] is None
        assert header['epoch'] == 999  # borrowed setup frame is never changed
        assert received == sample[0]
    finally:
        source.close()
        publisher.executor.shutdown(wait=True)


@pytest.mark.parametrize('state', ['missing', 'empty', 'stale', 'future', 'exception'])
def test_unavailable_depth_uploads_no_video(state):
    def sample(_):
        if state == 'exception': raise RuntimeError('fake disconnected camera')
        if state == 'empty': return None
        return time.monotonic()+(-2 if state == 'stale' else 2), dict(seq=1), None
    source = source_with_depth(None if state == 'missing' else NS(sample=sample))
    publisher = Publisher(source.config, {}, None, source_factory=lambda *_: source)
    uploads = []
    publisher.upload = lambda *args: uploads.append(args)
    async def scenario():
        task = asyncio.create_task(publisher.stream('depth'))
        try:
            async with asyncio.timeout(1):
                while not uploads: await asyncio.sleep(.001)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    try:
        asyncio.run(scenario())
        channel, header, payload = uploads[0]
        assert channel == 'depth' and header['state'] == 'NO_VIDEO' and payload is None
    finally:
        source.close()
        publisher.executor.shutdown(wait=True)


def test_depth_failure_keeps_rgb_and_lidar_publishing_at_bounded_intervals():
    def fail(_): raise RuntimeError('fake depth reader failure')
    source = source_with_depth(NS(sample=fail))
    publisher = Publisher(source.config, {}, None, source_factory=lambda *_: source)
    uploads = {channel: [] for channel in publisher.channels}
    for channel in ('rgb', 'lidar'):
        source.publish(channel, time.monotonic(), (dict(t='media.video', seq=0), None))
    publisher.upload = lambda channel, header, payload: uploads[channel].append((time.monotonic(), header))
    async def scenario():
        tasks = [asyncio.create_task(publisher.stream(channel)) for channel in publisher.channels]
        try:
            async with asyncio.timeout(2):
                while len(uploads['depth']) < 3: await asyncio.sleep(.005)
            assert uploads['rgb'][0][1]['channel'] == 'rgb'
            assert uploads['lidar'][0][1]['channel'] == 'lidar'
            assert all(header['state'] == 'NO_VIDEO' for _, header in uploads['depth'])
            assert all(b[0]-a[0] >= .2 for a, b in zip(uploads['depth'], uploads['depth'][1:]))
        finally:
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    try: asyncio.run(scenario())
    finally:
        source.close()
        publisher.executor.shutdown(wait=True)


def test_media_approval_epochs_do_not_start_or_close_setup_depth(monkeypatch):
    # The borrowed reader deliberately has no start/close methods. Only setup
    # owns it; source.start/close must neither open DDS nor retire that reader.
    depth = NS(sample=lambda _: None)
    source = source_with_depth(depth)
    monkeypatch.setattr(source, 'camera', lambda: None)
    monkeypatch.setattr(source, 'lidar', lambda: None)
    source.start()
    source.close()
    for thread in source.threads: thread.join(timeout=.5)
    assert source.depth_source is depth and source.sample('depth') is None


def test_depth_and_camera_http_stalls_leave_lidar_an_upload_worker():
    import threading
    source = source_with_depth(None)
    publisher = Publisher(source.config, {}, None, source_factory=lambda *_: source)
    release, depth_entered, rgb_entered, lidar_uploaded = [threading.Event() for _ in range(4)]
    def upload(channel, header, payload):
        if channel == 'depth':
            depth_entered.set()
            release.wait(1)
            raise TimeoutError('fake depth HTTP failure')
        if channel == 'rgb':
            rgb_entered.set()
            release.wait(1)
        if channel == 'lidar': lidar_uploaded.set()
    publisher.upload = upload
    async def scenario():
        tasks = []
        async def wait_for(event):
            async with asyncio.timeout(.3):
                while not event.is_set(): await asyncio.sleep(.001)
        try:
            tasks.append(asyncio.create_task(publisher.stream('depth')))
            await wait_for(depth_entered)
            tasks.append(asyncio.create_task(publisher.stream('rgb')))
            await wait_for(rgb_entered)
            tasks.append(asyncio.create_task(publisher.stream('lidar')))
            await wait_for(lidar_uploaded)
        finally:
            release.set()
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    try: asyncio.run(scenario())
    finally:
        release.set()
        source.close()
        publisher.executor.shutdown(wait=True)


@pytest.mark.parametrize('channel', ['rgb', 'lidar'])
def test_observation_retries_identity_failure_in_same_epoch(monkeypatch, caplog, channel):
    import threading
    import foothold_agent.go2_direct.media as media
    from test_go2_drive_media import cloud
    attempts = []
    published = threading.Event()
    class Camera:
        def GetImageSample(self): return 0, b'fake-jpeg'
    class Subscription:
        def Close(self): pass
    def factory(env, participant, serial, *, callback=None):
        requested = 'lidar' if callback is not None else 'rgb'
        if requested != channel: raise PermissionError('other channel unavailable')
        attempts.append(time.monotonic())
        if len(attempts) == 1: raise PermissionError('fake temporary identity gap')
        if callback is not None:
            callback(cloud())
            return Subscription()
        return Camera()
    source = Source(NS(robot=credentials().robot_id, approval=NS(robot_serial='fake')),
                    {}, None, recorder=recorder(), include_depth=False, factory=factory)
    source.last_odom_points = float('-inf')
    original_publish = source.publish
    def publish(*args):
        original_publish(*args)
        published.set()
    monkeypatch.setattr(source, 'publish', publish)
    monkeypatch.setattr(media, 'video', lambda _: (dict(t='media.video'), None))
    epoch = source.epoch
    source.start()
    try:
        assert published.wait(2.5)
        assert source.sample(channel) is not None
        assert source.epoch == epoch and attempts[1]-attempts[0] >= 1.
        assert channel not in source.start_failures
        assert caplog.text.count('GO2_MEDIA start_failed reason=identity channel='+channel) == 1
    finally:
        source.close()
        for thread in source.threads: thread.join(timeout=.5)
    assert all(not thread.is_alive() for thread in source.threads)

"""Synthetic setup/approved publishers; no SDK, DDS or robot connection."""
import asyncio
import json
import threading
import time
from types import SimpleNamespace as NS
from urllib.error import HTTPError

import pytest

from foothold_agent.depth.source import Publisher as DepthPublisher
from foothold_agent.go2_direct.media import Source, approved_publisher
from test_go2_media_identity import recorder
from test_setup_pairing import credentials


def test_setup_is_the_only_depth_uploader_with_approved_media_for_ten_seconds():
    creds = credentials()
    started, closed = [], []
    epoch = 111
    def sample(channel):
        assert channel == 'depth'
        return time.monotonic(), dict(t='media.video', version='media/1',
            robot=creds.robot_id, epoch=epoch, episode_id=None, channel='depth',
            seq=int(time.monotonic()*5), source='go2_depth'), None
    depth = NS(sample=sample, epoch=epoch, start=lambda: started.append(True),
               close=lambda: closed.append(True))
    setup = DepthPublisher(NS(robot=creds.robot_id, link=creds.link), source=depth)
    # Disabled observation factories never open SDK resources; their upload
    # loops still exercise RGB/lidar NO_VIDEO/NO_POINTS beside setup depth.
    approved = approved_publisher(creds, None, NS(state=NS(mac_identity=None)),
                                  recorder(), lambda: False)
    posts, last, lock = [], {}, threading.Lock()
    class Response:
        status = 202
        def read(self, _): return b''
        def close(self): pass
    def accept(request, *, timeout):
        header = json.loads(request.data)['header']
        channel, now = request.full_url.rsplit('/', 1)[1], time.monotonic()
        assert request.method == 'POST'
        with lock:
            previous = last.get(channel)
            status = 429 if previous is not None and now-previous < .2 else 202
            if status == 202: last[channel] = now
            posts.append((channel, now, status, header))
        if status == 429:
            raise HTTPError(request.full_url, status, 'fake rate limit', {}, None)
        return Response()
    for publisher in (setup, approved): publisher.opener = NS(open=accept)
    async def scenario():
        tasks = [asyncio.create_task(publisher.run()) for publisher in (setup, approved)]
        try:
            await asyncio.sleep(10)
            assert all(not task.done() for task in tasks)
        finally:
            for task in tasks: task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    try:
        asyncio.run(scenario())
    finally:
        for publisher in (setup, approved): publisher.executor.shutdown(wait=True)
        for thread in approved.source.threads: thread.join(timeout=.5)
    frames = [post for post in posts if post[0] == 'depth']
    assert 40 <= len(frames) <= 50
    assert all(post[2] == 202 for post in posts)
    assert all(b[1]-a[1] >= .2 for a, b in zip(frames, frames[1:]))
    assert {post[3]['epoch'] for post in frames} == {epoch}
    assert all(post[3]['t'] == 'media.video' for post in frames)
    assert {'rgb', 'lidar', 'depth'} == {post[0] for post in posts}
    assert approved.channels == ('rgb', 'lidar') and approved.source.depth_source is None
    assert started == [True] and closed == [True]


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


@pytest.mark.parametrize('stop_during_retry', [False, True])
def test_camera_read_exceptions_reuse_one_video_client(monkeypatch, caplog, stop_during_retry):
    import foothold_agent.go2_direct.media as media
    opened, reads, published = [], [], threading.Event()
    class Camera:
        def GetImageSample(self):
            reads.append(time.monotonic())
            if len(reads) <= 2:
                raise RuntimeError('fake camera read failure')
            return 0, b'fake-jpeg'
    camera = Camera()
    def factory(*args, **kwargs):
        opened.append(camera)
        return camera
    source = Source(NS(robot=credentials().robot_id, approval=NS(robot_serial='fake')),
                    {}, None, recorder=recorder(), include_depth=False, factory=factory)
    original_publish = source.publish
    def publish(*args):
        original_publish(*args)
        published.set()
    monkeypatch.setattr(source, 'publish', publish)
    monkeypatch.setattr(media, 'video', lambda _: (dict(t='media.video'), None))
    thread = threading.Thread(target=source.observe, args=('rgb', source.camera), daemon=True)
    epoch = source.epoch
    thread.start()
    try:
        if stop_during_retry:
            deadline = time.monotonic()+1
            # GetImageSample records its read before the worker catches and logs the error.
            while 'GO2_MEDIA start_failed reason=source channel=rgb' not in caplog.text and time.monotonic() < deadline:
                time.sleep(.001)
            assert reads
        else:
            assert published.wait(3)
            assert source.epoch == epoch and source.sample('rgb') is not None
            assert 'rgb' not in source.start_failures
            assert all(b-a >= 1 for a, b in zip(reads[:2], reads[1:3]))
        assert opened == [camera]
        assert caplog.text.count('GO2_MEDIA start_failed reason=source channel=rgb') == 1
    finally:
        source.close()
        thread.join(timeout=.5)
    assert not thread.is_alive()
    if stop_during_retry: assert len(reads) == 1

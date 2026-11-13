"""Synthetic recordings only, in pytest temp folders; no DDS participant/robot."""
import asyncio
import base64
import builtins
from datetime import datetime, timezone
from pathlib import Path
import re
import struct
import threading
import time
from types import SimpleNamespace as NS

import pytest

from foothold_agent.go2_direct.media import Source, approved_publisher, video
from foothold_agent.go2_direct.record import Recorder, MAX_SESSION_BYTES, MIN_FREE_BYTES
from foothold_agent.setup.view import PAGE, Status
from test_depth import raw as depth_raw, compressed, colour, cv2, np
from test_go2_drive_media import cloud, raw as cloud_raw


def until(predicate, timeout=2):
    deadline = time.monotonic()+timeout
    while not predicate() and time.monotonic() < deadline:
        time.sleep(.005)
    assert predicate()


@pytest.fixture
def recording(tmp_path):
    made = []
    def make(**kwargs):
        recorder = Recorder({}, root=tmp_path/'records',
            disk_usage=lambda _: NS(free=20_000_000_000), **kwargs)
        made.append(recorder)
        recorder.start()
        return recorder
    yield make
    for recorder in made:
        recorder.close()
        if recorder.thread:
            recorder.thread.join(timeout=2)
            assert not recorder.thread.is_alive()


def flush(recorder):
    until(lambda: recorder.queue.unfinished_tasks == 0)


def jpeg(width=1000, height=600):
    ok, result = cv2.imencode('.jpg', np.zeros((height, width, 3), np.uint8))
    assert ok
    return result.tobytes()


def test_three_original_files_metadata_and_binary_ply(recording):
    status = Status()
    recorder = recording(status=status)
    original = jpeg()
    message = depth_raw(big=True, padding=6)
    recorder.rgb(original)
    recorder.lidar(cloud_raw(cloud(10000, big=True)))
    recorder.depth(message, colour(message)[0], 'rt/d455/depth/image_rect_raw')
    flush(recorder)
    assert set(p.name for p in recorder.path.iterdir()) == {'rgb', 'lidar', 'depth', 'info.txt'}
    image = next((recorder.path/'rgb').iterdir())
    assert re.fullmatch(r'00000001-\d{8}T\d{6}\.\d{6}Z.jpg', image.name)
    assert image.read_bytes() == original
    assert image.read_bytes() != base64.b64decode(video(original)[0]['jpeg'])
    ply = next((recorder.path/'lidar').iterdir()).read_bytes()
    head, payload = ply.split(b'end_header\n', 1)
    assert b'format binary_little_endian 1.0' in head
    assert b'element vertex 10000\n' in head  # web has only <=4000 points
    assert all(f'property float {axis}'.encode() in head for axis in 'xyz')
    assert len(payload) == 10000*12 and struct.unpack('<fff', payload[:12]) == (0., 2., 3.)
    png = next((recorder.path/'depth').iterdir())
    decoded = cv2.imdecode(np.frombuffer(png.read_bytes(), np.uint8), cv2.IMREAD_UNCHANGED)
    assert png.suffix == '.png' and decoded.dtype == np.uint16
    assert np.array_equal(decoded, [[0, 200, 1000], [2000, 5000, 8000]])
    info = (recorder.path/'info.txt').read_text()
    assert 'started_at_utc:' in info and 'rt/d455/depth/image_rect_raw' in info
    assert 'lidar_frame: utlidar_lidar' in info
    assert status.snapshot()['record_notice'].startswith('기록 저장 중: '+str(recorder.path))
    assert ' GB' in status.snapshot()['record_notice']
    assert recorder.total_bytes == sum(p.stat().st_size for p in recorder.path.rglob('*') if p.is_file())


@pytest.mark.parametrize('transport', [False, True])
def test_compressed_depth_retains_original_16_bit_png(recording, transport):
    recorder = recording()
    message = compressed(transport=transport)
    recorder.depth(message, colour(message)[0], 'rt/d435i/depth/compressedDepth')
    flush(recorder)
    data = next((recorder.path/'depth').iterdir()).read_bytes()
    assert data == message.data[12 if transport else 0:]


@pytest.mark.parametrize('compressed_input', [False, True])
def test_float_depth_falls_back_to_emitted_jpeg(recording, compressed_input):
    recorder = recording()
    message = compressed(encoding='32FC1') if compressed_input else depth_raw(encoding='32FC1')
    frame = colour(message)[0]
    recorder.depth(message, frame, 'rt/d455/depth/image_raw')
    flush(recorder)
    path = next((recorder.path/'depth').iterdir())
    assert path.suffix == '.jpg' and path.read_bytes() == base64.b64decode(frame['jpeg'])


def test_disabled_has_no_worker_directory_or_home_access(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, 'home', lambda: pytest.fail('disabled recorder must not resolve home'))
    recorder = Recorder({'FH_RECORD':'0'}, root=tmp_path/'disabled')
    recorder.start()
    recorder.rgb(b'fake'); recorder.lidar(cloud_raw(cloud()))
    recorder.depth(depth_raw(), colour(depth_raw())[0], 'rt/d455/depth/image_raw')
    assert recorder.thread is None and recorder.queue.empty() and not (tmp_path/'disabled').exists()


@pytest.mark.parametrize('value,expected', [('2.5', 2_500_000_000), ('20', 20_000_000_000),
    ('nan', MAX_SESSION_BYTES), ('inf', MAX_SESSION_BYTES), ('0', MAX_SESSION_BYTES),
    ('-1', MAX_SESSION_BYTES), ('bad', MAX_SESSION_BYTES)])
def test_environment_capacity_is_positive_finite_and_invalid_values_keep_default(value, expected):
    recorder = Recorder({'FH_RECORD_MAX_GB': value})
    assert recorder.max_bytes == expected


def test_depth_is_saved_once_per_second_but_rgb_and_lidar_keep_every_sample(recording):
    clock = [0.]
    recorder = recording(now=lambda: clock[0])
    message = depth_raw(); frame = colour(message)[0]
    for stamp in (0., .2, .4, .6, .8, 1., 1.2):
        clock[0] = stamp
        recorder.depth(message, frame, 'rt/d455/depth/image_raw')
        recorder.rgb(b'fake')
        recorder.lidar(cloud_raw(cloud()))
        flush(recorder)
    assert recorder.sequences == dict(rgb=7, lidar=7, depth=2)


def test_default_home_layout_and_same_second_sessions_do_not_overwrite(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    recorders = [Recorder({}, disk_usage=lambda _: NS(free=20_000_000_000)) for _ in range(2)]
    recorders[1].started_at = recorders[0].started_at
    try:
        for recorder in recorders:
            recorder.start(); recorder.rgb(b'fake'); flush(recorder)
        assert recorders[0].path.parent == tmp_path/'FOOTHOLD-기록'
        assert re.fullmatch(r'\d{8}-\d{6}', recorders[0].path.name)
        assert recorders[0].path != recorders[1].path
        assert next((recorders[0].path/'rgb').iterdir()).read_bytes() == b'fake'
    finally:
        for recorder in recorders:
            recorder.close(); recorder.thread.join(timeout=2)


@pytest.mark.parametrize('failure', ['permission', 'disk-full'])
def test_write_failure_only_stops_recorder_and_publication_continues(recording, monkeypatch, failure):
    recorder = recording()
    original_open = Path.open
    def fail(path, *args, **kwargs):
        if args and args[0] == 'xb':
            raise PermissionError('private-data-must-not-be-logged') if failure == 'permission' else OSError('disk full')
        return original_open(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', fail)
    source = Source(NS(robot='fake', approval=NS(robot_serial='fake')), {}, None,
                    recorder=recorder, include_depth=False)
    source.publish('rgb', source.now(), video(jpeg()))
    recorder.rgb(jpeg())
    until(lambda: recorder.stopped.is_set())
    source.publish('rgb', source.now(), video(jpeg()))
    assert source.sample('rgb')[1]['seq'] == 2
    assert recorder.notice == '기록 멈춤: 파일을 저장할 수 없습니다'
    assert 'private-data' not in recorder.notice


@pytest.mark.parametrize('limit', ['total', 'free', 'free-projected'])
def test_space_limits_stop_before_exceeding_budget(recording, limit):
    recorder = recording()
    recorder.rgb(b'first'); flush(recorder)
    before = recorder.total_bytes
    if limit == 'total': recorder.max_bytes = before+4
    elif limit == 'free': recorder.disk_usage = lambda _: NS(free=MIN_FREE_BYTES-1)
    else: recorder.disk_usage = lambda _: NS(free=MIN_FREE_BYTES+4)
    recorder.rgb(b'next-frame'); flush(recorder)
    assert recorder.stopped.is_set() and recorder.notice == '기록 멈춤: 저장 공간 부족'
    assert recorder.total_bytes == before and len(list((recorder.path/'rgb').iterdir())) == 1
    assert MAX_SESSION_BYTES == 20_000_000_000 and MIN_FREE_BYTES == 5_000_000_000


def test_stalled_writer_bounded_queue_and_close_do_not_wait(recording, monkeypatch):
    recorder = recording(queue_size=2)
    entered, release = threading.Event(), threading.Event()
    original = recorder.write
    def stalled(*args):
        entered.set(); release.wait(2)
        return original(*args)
    monkeypatch.setattr(recorder, 'write', stalled)
    recorder.rgb(b'first'); assert entered.wait(1)
    before = time.monotonic()
    for _ in range(100): recorder.rgb(b'next')
    recorder.close()
    assert time.monotonic()-before < .1 and recorder.queue.qsize() == 2
    release.set()


def test_media_workers_record_but_storage_exception_cannot_drop_publication(recording, monkeypatch):
    recorder = recording()
    def fail(*_): raise OSError('fake recording failure')
    monkeypatch.setattr(recorder, 'rgb', fail)
    monkeypatch.setattr(recorder, 'lidar', fail)
    class Camera:
        def GetImageSample(self): return 0, jpeg()
    def factory(*args, callback=None):
        if callback:
            callback(cloud(10000))
            return NS(Close=lambda: None)
        return Camera()
    source = Source(NS(robot='fake', approval=NS(robot_serial='fake')), {}, None,
                    recorder=recorder, factory=factory, include_depth=False)
    source.start()
    try:
        until(lambda: source.sample('rgb') is not None and source.sample('lidar') is not None)
        assert source.sample('lidar')[1]['count'] <= 4000
    finally:
        source.close()
        for thread in source.threads: thread.join(timeout=1)


def test_depth_source_records_only_when_approved_and_keeps_topic(recording):
    from foothold_agent.depth.source import Source as DepthSource
    from foothold_agent.depth.discovery import IMAGE
    recorder = recording()
    allowed = [False]
    class Discovery:
        def __init__(self, *_): pass
        def poll(self): return [dict(name='rt/d455/depth/image_rect_raw', type=IMAGE, supported=True)]
        def close(self): pass
    class Images:
        def __init__(self, *_): self.seq = 0
        def take(self):
            self.seq += 1
            message = depth_raw(); message.header.stamp.sec = self.seq
            return [message]
        def close(self): pass
    source = DepthSource(NS(robot='fake'), participant=lambda: 'fake', discovery=Discovery, images=Images,
                         recorder=recorder, recording_allowed=lambda: allowed[0])
    source.start()
    try:
        until(lambda: source.sample('depth') is not None)
        assert recorder.path is None
        allowed[0] = True
        until(lambda: recorder.path is not None and (recorder.path/'depth').is_dir()
              and any((recorder.path/'depth').iterdir()))
        allowed[0] = False
        flush(recorder)
        count = recorder.sequences['depth']
        previous = source.seq
        until(lambda: source.seq > previous)
        assert recorder.sequences['depth'] == count
        assert 'rt/d455/depth/image_rect_raw' in (recorder.path/'info.txt').read_text()
    finally:
        source.close(); source.thread.join(timeout=1)


def test_desktop_observation_factory_reuses_existing_participant_without_motion(recording, monkeypatch):
    import socket
    from foothold_agent.go2_direct.approval import Approval
    from foothold_agent.go2_readonly.sdk import Subscriptions
    from test_setup_pairing import credentials, NIC_VALUE, SERIAL
    subscriptions = Subscriptions(NS(), NIC_VALUE.name)
    subscriptions._started = True
    monkeypatch.setattr(socket, 'if_nameindex', lambda: [(7, NIC_VALUE.name)])
    calls = []
    subscriptions.cloud = lambda topic, callback: calls.append(('cloud', topic, callback)) or 'cloud-handle'
    class Camera:
        def __init__(self): calls.append(('camera',))
        def SetTimeout(self, timeout): calls.append(('timeout', timeout))
        def Init(self): calls.append(('init',))
    original = builtins.__import__
    def guarded(name, *args, **kwargs):
        if name == 'unitree_sdk2py.go2.video.video_client': return NS(VideoClient=Camera)
        assert not name.startswith(('unitree_sdk2py', 'cyclonedds'))
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', guarded)
    enabled = [True]
    publisher = approved_publisher(credentials(), Approval(NIC_VALUE.name, SERIAL, time.time()+60),
                                   subscriptions, recording(), lambda: enabled[0])
    try:
        source = publisher.source
        assert publisher.channels == ('rgb', 'lidar') and source.depth_source is None
        callback = lambda _: None
        assert source.factory({}, subscriptions, SERIAL, callback=callback) == 'cloud-handle'
        source.factory({}, subscriptions, SERIAL)
        assert calls == [('cloud', 'rt/utlidar/cloud', callback), ('camera',), ('timeout', .1), ('init',)]
        enabled[0] = False
        with pytest.raises(PermissionError): source.factory({}, subscriptions, SERIAL)
        assert source.sample('rgb') is None
    finally:
        publisher.executor.shutdown(wait=False)


def test_record_notice_is_plain_text_in_existing_desktop_status():
    status = Status(); status.update(record_notice='기록 멈춤: 저장 공간 부족')
    assert status.snapshot()['record_notice'] == '기록 멈춤: 저장 공간 부족'
    assert 'id="record-notice" role="status"' in PAGE
    assert "record.textContent=s.record_notice||''" in PAGE


@pytest.mark.parametrize('media_failure', ['factory', 'worker'])
def test_setup_approval_starts_shared_observations_and_failure_does_not_affect_stop(recording, media_failure):
    from foothold_agent.setup.runtime import Inputs, run
    from foothold_agent.link.client import Client
    from test_setup_pairing import credentials, NIC_VALUE, OfflineSink, FakeSport, low, sport
    async def scenario():
        inputs, status, stop = Inputs(), Status(), asyncio.Event()
        captured, publishers, motion = {}, [], []
        depth = NS(recorder=None, recording_allowed=lambda: False)
        recorder = recording(status=status)
        class FakeClient(Client):
            async def run(self):
                captured['client'] = self
                self._emit(self.session.connect())
                sequence = 0
                while not stop.is_set():
                    sequence += 1
                    inputs.lowstate(low(sequence)); inputs.sportmodestate(sport(sequence))
                    self._emit(self.session.receive(dict(t='ping', seq=sequence)))
                    await asyncio.sleep(.02)
        def connect(*_):
            pair = FakeSport(), FakeSport()
            motion.append(pair)
            return pair
        def media_factory(creds, approval, subscriptions, shared, enabled):
            assert shared is recorder and enabled() and depth.recording_allowed()
            publishers.append(dict(enabled=enabled, closed=False))
            if media_failure == 'factory': raise OSError('camera absent')
            item = publishers[-1]
            class BrokenPublisher:
                source = NS(close=lambda: item.update(closed=True))
                async def run(self): raise OSError('observation loss')
            return BrokenPublisher()
        task = asyncio.create_task(run(credentials(), NIC_VALUE, inputs, object(), ready=True,
            check_nic=lambda: True, status=status, stop=stop, client_factory=FakeClient,
            connect=connect, sink_factory=OfflineSink, depth_source=depth,
            media_factory=media_factory, recorder_factory=lambda *args, **kwargs: recorder))
        async def wait_for(predicate):
            async with asyncio.timeout(2):
                while not predicate(): await asyncio.sleep(.005)
        try:
            await wait_for(lambda: 'client' in captured)
            await asyncio.sleep(.06)
            client = captured['client']
            assert not publishers and not motion and not depth.recording_allowed() and recorder.path is None
            client._emit(client.session.receive(dict(t='field_approval', expires_at=time.time()+.5)))
            await wait_for(lambda: bool(publishers))
            assert depth.recorder is recorder and client.sink.active is not None
            await asyncio.sleep(.06)
            assert not task.done() and client.sink.active is not None
            client._emit(client.session.receive(dict(t='stop', stop_ref=42)))
            client.sink.active.sink.check_watchdog()
            assert motion[0][1].calls[-1] == ('StopMove', ())
            await wait_for(lambda: client.sink.active is None)
            assert not publishers[0]['enabled']() and not depth.recording_allowed()
            assert client.session.core.latch
            if media_failure == 'worker':
                await wait_for(lambda: publishers[0]['closed'])
        finally:
            stop.set(); await asyncio.wait_for(task, 2)
        assert recorder.stopped.is_set() and motion[0][1].calls[-1] == ('StopMove', ())
    asyncio.run(scenario())

"""Fake SDK observation paths are bounded and cannot hold control's event loop."""
import asyncio
import base64
from datetime import datetime,timezone
import json
import struct
import threading
import time
from types import SimpleNamespace as NS
from urllib.error import HTTPError, URLError
from uuid import uuid4

import pytest

from foothold_agent.go2_direct.media import Source, Publisher, points, dimensions
from foothold_agent.link.client import Settings
from apps.contracts.models import MediaPointCloudHeader
from test_go2_server_drive import rig


def cloud(count=1, *, big=False, frame='utlidar_lidar'):
    data=b''.join(struct.pack('>fff' if big else '<fff',i*.001,2,3) for i in range(count))
    return NS(header=NS(frame_id=frame,stamp=NS(sec=1,nanosec=1)),width=count,height=1,
        point_step=12,row_step=count*12,is_bigendian=big,data=data,
        fields=[NS(name=name,offset=offset,datatype=7,count=1) for name,offset in (('x',0),('y',4),('z',8))])


def raw(message):
    return (message.data,message.width,message.height,message.point_step,message.row_step,
        message.is_bigendian,tuple((f.name,f.offset,f.datatype,f.count) for f in message.fields),message.header.frame_id)


@pytest.mark.parametrize('count,big',[(1,False),(1,True),(10000,False),(100000,False)])
def test_pointcloud_layout_downsampling_and_hardware_frame(count,big):
    header,payload=points(raw(cloud(count,big=big)))
    assert header['count']<=4000 and len(payload)<=48000
    assert header['truncated']==(count>4000) and header['frame']=='lidar_link'
    assert header['pose'] is None and header['map_version_id'] is None
    header.update(version='media/1',robot=str(uuid4()),epoch=1,episode_id=None,channel='lidar',
        seq=1,captured_at=datetime.now(timezone.utc).isoformat())
    MediaPointCloudHeader.model_validate(header).validate_payload(payload)


@pytest.mark.parametrize('change',['overlap','unknown-frame','oversize','wrong-length','range','bad-type'])
def test_bad_cloud_does_not_become_fake_points(change):
    message=cloud()
    if change=='overlap': message.fields[1].offset=0
    elif change=='unknown-frame': message.header.frame_id='unverified_map'
    elif change=='oversize': message.width=100001
    elif change=='wrong-length': message.data=b'bad'
    elif change=='range': message.data=struct.pack('<fff',10001,0,0)
    else: message.point_step=True
    with pytest.raises(ValueError): points(raw(message))


@pytest.mark.parametrize('frame', ['utlidar_lidar', 'odom'])
@pytest.mark.parametrize('count', [4100, 10600])
@pytest.mark.parametrize('setting,limit', [(None, 4000), ('1000', 1000), ('4000', 4000), ('20000', 20000)])
def test_drive_lidar_limit_applies_to_raw_and_odom_with_identical_default_bytes(frame, count, setting, limit):
    env = {} if setting is None else {'FH_DRIVE_LIDAR_MAX_POINTS': setting}
    source = Source(NS(robot=str(uuid4())), env, None, now=lambda: 0.,
                    include_depth=False, recorder=NS(lidar=lambda _: None))
    message = cloud(count, frame=frame)
    if frame == 'odom':
        source.poses.nearest = lambda *_: (0., 1, (0., 0., 0.), (1., 0., 0., 0.))
        source.deskewed(message)
    else:
        source.last_odom_points = float('-inf')
        source.cloud(message)
    try:
        source.publish_clouds()
        _, header, payload = source.sample('lidar')
        stride = (count + limit - 1)//limit
        expected = b''.join(message.data[i*12:(i+1)*12] for i in range(0, count, stride))
        assert payload == expected
        assert header['count'] == len(expected)//12
        assert header['truncated'] is (limit < count)
        MediaPointCloudHeader.model_validate(header).validate_payload(payload)
        if limit == 20000:
            assert header['count'] == count and payload == message.data
    finally:
        source.close()


@pytest.mark.parametrize('setting', ['', 'bad', '1000.5', 'nan', '999', '20001', '-1', '0'])
def test_invalid_drive_lidar_limit_warns_once_per_source_and_keeps_default(setting, caplog):
    source = Source(NS(robot=str(uuid4())), {'FH_DRIVE_LIDAR_MAX_POINTS': setting}, None,
                    now=lambda: 0., include_depth=False, recorder=NS(lidar=lambda _: None))
    try:
        assert source.max_points == 4000
        source.last_odom_points = float('-inf')
        source.cloud(cloud(10600))
        source.publish_clouds()
        assert source.sample('lidar')[1]['count'] == 3534
        source.publish_clouds()
        assert sum('invalid FH_DRIVE_LIDAR_MAX_POINTS' in m for m in caplog.messages) == 1
    finally:
        source.close()


def test_drive_option_does_not_raise_phone_direct_lidar_limit(monkeypatch):
    from foothold_agent.media.processing import points as phone_points
    monkeypatch.setenv('FH_DRIVE_LIDAR_MAX_POINTS', '20000')
    message = cloud(10600, frame='lidar_link')
    message.data = b''.join(struct.pack('<fff', i*.2, 2., 3.) for i in range(10600))
    header, payload = phone_points(raw(message))
    assert header['count'] == 4000 and header['truncated'] is True
    assert len(payload) == 48000
    # The low-level helper used outside server-drive also keeps its default.
    header, payload = points(raw(message))
    assert header['count'] == 3534 and len(payload) == 3534*12


def test_approved_publisher_forwards_drive_limit_and_uploads_full_frame(monkeypatch):
    from foothold_agent.go2_direct.media import approved_publisher
    from test_setup_pairing import credentials
    monkeypatch.setenv('FH_DRIVE_LIDAR_MAX_POINTS', '20000')
    pub = approved_publisher(credentials(), None, NS(state=NS(mac_identity=None)),
                             NS(), lambda: False)
    requests = []
    pub.opener = NS(open=lambda request, **_: (requests.append(request) or
        NS(status=202, read=lambda _: b'', close=lambda: None)))
    try:
        assert pub.source.max_points == 20000
        header, payload = points(raw(cloud(20000)), max_points=pub.source.max_points)
        header['edge_u8'] = base64.b64encode(bytes(20000)).decode()
        pub.upload('lidar', header, payload)
        body = json.loads(requests[0].data)
        assert body['header']['count'] == 20000 and body['header']['truncated'] is False
        assert base64.b64decode(body['points']) == payload
        assert len(requests[0].data) > 320000
    finally:
        pub.source.close()
        pub.executor.shutdown(wait=True)


def test_sdk_camera_and_cloud_workers_are_independent_latest_only(monkeypatch):
    import foothold_agent.go2_direct.media as module
    gate=threading.Event(); camera_entered=threading.Event(); closed=threading.Event()
    class Video:
        def GetImageSample(self):
            camera_entered.set(); gate.wait(1); return 1,b''
    class Subscription:
        def Close(self): closed.set()
    def sdk_factory(env,channel,serial,callback=None):
        if callback:
            callback(cloud(10000)); return Subscription()
        return Video()
    config=NS(robot=str(uuid4()),approval=NS(robot_serial='fake-serial'))
    source=Source(config,{'FH_RECORD':'0'},object(),factory=sdk_factory)
    source.start()
    try:
        assert camera_entered.wait(.3)
        deadline=time.monotonic()+.5
        while source.sample('lidar') is None and time.monotonic()<deadline: time.sleep(.005)
        sample=source.sample('lidar')
        assert sample is not None and sample[1]['count']<=4000
        assert source.sample('rgb') is None  # no fabricated image while SDK is blocked
        assert len(source.latest)<=2
    finally:
        source.close();gate.set()
        for thread in source.threads: thread.join(timeout=.5)
    assert closed.is_set()


def test_observation_upload_stall_does_not_block_twenty_hz_neutral_or_stop():
    now,sink,normal,emergency,session,client,measured,frame=rig()
    class FakeSource:
        epoch=1
        closed=False
        def __init__(self,*args):pass
        def start(self):pass
        def sample(self,channel):return None
        def close(self):self.closed=True
    config=NS(robot=str(uuid4()),link=Settings('ws://127.0.0.1/api/v1/agent/ws','fake-token'))
    publisher=Publisher(config,{},None,source_factory=FakeSource)
    gate=threading.Event();entered=threading.Event()
    def blocked(*args):entered.set();gate.wait(2)
    publisher.upload=blocked
    async def scenario():
        task=asyncio.create_task(publisher.run())
        try:
            async with asyncio.timeout(.5):
                while not entered.is_set():await asyncio.sleep(.001)
            for seq in range(1,21):
                now.value+=.05;measured()
                frame('cmd',lease_id='fake-lease',seq=seq,axes=[0,0,0])
                sink.drain()
                assert not sink.check_watchdog() and not sink.latched
                await asyncio.sleep(.002)
            frame('stop',stop_ref=42)
            assert sink.latched and sink.check_watchdog()
            assert emergency.calls[-1]==('StopMove',())
        finally:
            gate.set();task.cancel();await asyncio.gather(task,return_exceptions=True)
    asyncio.run(scenario())
    assert publisher.source.closed


def test_upload_format_has_no_url_token_and_keeps_control_ws_limit():
    config=NS(robot=str(uuid4()),link=Settings('wss://robot.invalid/api/v1/agent/ws','fake-token'))
    publisher=Publisher(config,{},None,source_factory=lambda *args:None)
    assert publisher.url('rgb')=='https://robot.invalid/api/v1/agent/drive-media/rgb'
    requests=[]
    class Response:
        status=202
        def close(self):pass
        def read(self,count):assert count==128
    class Opener:
        def open(self,request,timeout):requests.append(request);return Response()
    publisher.opener=Opener()
    try:
        publisher.upload('lidar',{'t':'media.points'},b'fake')
        body=json.loads(requests[0].data)
        assert body=={'header':{'t':'media.points'},'points':'ZmFrZQ=='}
        assert requests[0].get_header('Authorization')=='Bearer fake-token'
    finally:publisher.executor.shutdown(wait=True)


def test_lidar_upload_logs_only_changes_in_frame_or_result(monkeypatch, caplog):
    url = 'https://private.invalid'
    attempts = iter([
        (False, 202), (False, 202), (True, 202), (True, 202),
        (True, HTTPError(url, 403, 'private reason', {}, None)),
        (True, HTTPError(url, 403, 'private reason', {}, None)),
        (True, 503), (True, URLError(TimeoutError(url))), (True, asyncio.TimeoutError()),
        (True, URLError(url)), (True, ValueError(url)), (True, 202),
    ])
    seq = 0
    response = None

    def sample(channel):
        nonlocal seq, response
        step = next(attempts, None)
        if step is None:
            raise asyncio.CancelledError
        has_points, response = step
        seq += 1
        return (0, {'t': 'media.points', 'seq': seq}, b'private points') if has_points else None

    def open_response(request, timeout):
        if isinstance(response, Exception):
            raise response
        return NS(status=response, read=lambda n: b'', close=lambda: None)

    async def skip_delay(seconds):
        pass

    monkeypatch.setattr(asyncio, 'sleep', skip_delay)
    config = NS(robot='private robot', link=Settings('wss://private.invalid/api/v1/agent/ws', 'fake-token'))
    publisher = Publisher(config, {}, None, source_factory=lambda *args: NS(sample=sample, epoch=1))
    publisher.opener = NS(open=open_response)
    try:
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(publisher.stream('lidar'))
    finally:
        publisher.executor.shutdown(wait=True)
    transitions = [message for message in caplog.messages if 'lidar_upload' in message]
    assert transitions == ['GO2_MEDIA lidar_upload frame=' + value for value in (
        'no_points result=http_202', 'points result=http_202', 'points result=http_403',
        'points result=http_503', 'points result=timeout', 'points result=network_error',
        'points result=error', 'points result=http_202',
    )]

    summary, = [message for message in caplog.messages if 'upload_summary' in message]
    assert 'channel=lidar attempts=12' in summary and "'timeout': 2" in summary
    assert 'data_attempts=10' in summary and 'private' not in summary


def test_slow_ack_then_timeout_samples_next_frame_without_one_second_backoff(monkeypatch, caplog):
    intervals = []
    sent = []
    responses = iter([202, TimeoutError(), 202])
    seqs = iter([1, 2, 2, 3])

    def sample(_):
        seq = next(seqs, None)
        if seq is None:
            raise asyncio.CancelledError
        return 0, dict(t='media.points', frame='odom', seq=seq), b'x'

    def post(request, timeout):
        sent.append(json.loads(request.data)['header']['seq'])
        response = next(responses)
        if response == 202 and len(sent) == 1:
            time.sleep(.65)  # past the old 600 ms overall cutoff
        if isinstance(response, Exception):
            raise response
        return NS(status=202, read=lambda _: b'', close=lambda: None)

    async def delay(seconds):
        intervals.append(seconds)

    monkeypatch.setattr(asyncio, 'sleep', delay)
    config = NS(link=Settings('wss://example.invalid/api/v1/agent/ws','fake-token'))
    publisher = Publisher(config, {}, None, source_factory=lambda *_: NS(sample=sample))
    publisher.opener = NS(open=post)
    try:
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(publisher.stream('lidar'))
    finally:
        publisher.executor.shutdown(wait=True)
    assert "frames={'odom': 3} ack_frames={'odom': 2}" in caplog.text
    assert sent == [1, 2, 3]
    assert intervals[:3] == [.2, .2, .05]


def test_wall_timeout_waits_for_worker_before_next_lidar_request(monkeypatch, caplog):
    entered, release = threading.Event(), threading.Event()
    second = threading.Event()
    samples = iter([1, 2])
    original_sleep = asyncio.sleep

    def sample(_):
        seq = next(samples, None)
        if seq is None:
            raise asyncio.CancelledError
        return 0, dict(t='media.points', seq=seq, frame='odom'), b'x'

    def post(request, timeout):
        if entered.is_set():
            second.set()
        else:
            entered.set()
            assert release.wait(4)
        return NS(status=202, read=lambda _: b'', close=lambda: None)

    async def skip_delay(seconds):
        await original_sleep(0)

    monkeypatch.setattr(asyncio, 'sleep', skip_delay)
    config = NS(link=Settings('wss://example.invalid/api/v1/agent/ws','fake-token'))
    pub = Publisher(config, {}, None, source_factory=lambda *_: NS(sample=sample))
    pub.opener = NS(open=post)

    async def scenario():
        task = asyncio.create_task(pub.stream('lidar'))
        try:
            async with asyncio.timeout(3):
                while 'result=timeout' not in caplog.text:
                    await original_sleep(.01)
            assert entered.is_set() and not second.is_set()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 1)
            assert second.is_set()
        finally:
            release.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    try:
        asyncio.run(scenario())
    finally:
        pub.executor.shutdown(wait=True)


def test_camera_metadata_rejects_multiple_or_oversized_rasters_without_codec_import():
    def sof(width,height):
        return b'\xff\xc0\x00\x0b\x08'+height.to_bytes(2,'big')+width.to_bytes(2,'big')+b'\x01\x01\x11\x00'
    with pytest.raises(ValueError):
        dimensions(b'\xff\xd8'+sof(64,36)+sof(64,36)+b'\xff\xda\x00\x02\xff\xd9')
    with pytest.raises(ValueError):
        dimensions(b'\xff\xd8'+sof(2000,1080)+b'\xff\xda\x00\x02\xff\xd9')

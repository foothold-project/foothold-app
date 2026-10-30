"""Fake SDK observation paths are bounded and cannot hold control's event loop."""
import asyncio
from datetime import datetime,timezone
import json
import struct
import threading
import time
from types import SimpleNamespace as NS
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
    source=Source(config,{},object(),factory=sdk_factory)
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
        def __enter__(self):return self
        def __exit__(self,*args):pass
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


def test_camera_metadata_rejects_multiple_or_oversized_rasters_without_codec_import():
    def sof(width,height):
        return b'\xff\xc0\x00\x0b\x08'+height.to_bytes(2,'big')+width.to_bytes(2,'big')+b'\x01\x01\x11\x00'
    with pytest.raises(ValueError):
        dimensions(b'\xff\xd8'+sof(64,36)+sof(64,36)+b'\xff\xda\x00\x02\xff\xd9')
    with pytest.raises(ValueError):
        dimensions(b'\xff\xd8'+sof(2000,1080)+b'\xff\xda\x00\x02\xff\xd9')

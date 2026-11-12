"""Synthetic room/odometry and fake DDS only. No robot or simulator joins."""
import ast
import json
import math
from pathlib import Path
import struct
import sys
import time
from types import SimpleNamespace as NS
from uuid import uuid4

import numpy as np
import pytest

from foothold_agent.mapping.core import Accumulator
from foothold_agent.mapping.runtime import MappingRuntime
from foothold_agent.link.client import Settings
from foothold_agent.mapping.inputs import CloudBus
from apps.contracts import models as C
from apps.server.fh_server.voxel_files import convert


def command(op='start', sid=None, fid=None):
    return dict(t='slam', op=op, session_id=sid or str(uuid4()), floor_id=fid or str(uuid4()))


def synthetic_room():
    floor = [(x/10, y/10, 0.) for x in range(-30,31) for y in range(-30,31)]
    walls = [(x/10, y/10, z/10) for x in range(-30,31) for y in (-30,30) for z in range(1,11)]
    walls += [(x/10, y/10, z/10) for y in range(-29,30) for x in (-30,30) for z in range(1,11)]
    return np.asarray(floor+walls)


def test_room_with_jitter_accumulates_binary_pcd_and_preview():
    clock = NS(t=0.)
    core = Accumulator(now=lambda: clock.t)
    start = command()
    assert core.command(start)
    world = synthetic_room()
    for i in range(10):
        clock.t += .1
        pose = [i*.08, .005*math.sin(i), .3]
        yaw = .002*math.sin(i)
        q = [math.cos(yaw/2), 0, 0, math.sin(yaw/2)]
        r = np.array([[math.cos(yaw), -math.sin(yaw),0],[math.sin(yaw),math.cos(yaw),0],[0,0,1]])
        core.add((world-pose)@r, pose, q, stamp=i+1)
    assert .7 < core.distance < .8 and core.status == 'RUNNING'
    assert core.command({**start, 'op':'save'}) and core.status == 'SAVING'
    data = core.pcd()
    header, payload = data.split(b'DATA binary\n')
    assert b'FIELDS x y z' in header and len(payload) == 12*len(core.cells)
    imported = convert(data, 'pcd', 'synthetic-mapping', '합성 방')
    assert imported['point_count'] == len(core.cells)
    assert imported['spec'].items and imported['png'].startswith(b'\x89PNG')
    report = core.report()
    assert len(json.dumps(report).encode()) <= 65536
    C.AgentMappingUpdate.model_validate(report)
    assert report['preview']['cells'] and len(report['preview']['path']) >= 2
    count = len(core.cells)
    core.add(world, [0,0,0], [1,0,0,0], stamp=20)
    assert len(core.cells) == count  # SAVING freezes acquisition
    core.fail('SAVE_FAILED','저장 실패')
    assert core.pcd() == data  # failure retains accumulated points
    assert core.command({**start,'op':'save'})
    assert core.command({**start,'op':'cancel'}) and core.status == 'CANCELLED'
    assert not core.cells and not core.command({**start,'op':'save'})


def test_limits_duplicates_nonfinite_and_preview_budget():
    core = Accumulator(max_points=4)
    start = command()
    assert core.command(start)
    xyz = np.asarray([(1,1,1),(1.001,1,1),(2,2,2),(3,3,3),(4,4,4),(5,5,5),(np.nan,0,0)])
    core.add(xyz,[0,0,0],[1,0,0,0],stamp=1)
    assert len(core.cells)==4 and core.status=='FAILED' and core.error_code=='MAPPING_LIMIT'
    assert core.command(start) and len(core.cells)==4  # retry start doesn't erase points
    assert not core.command(command())
    core.cells = {(i,0,0):(float(i%1000),float(i//1000),1.+(i%3)) for i in range(50000)}
    for i in range(4096): core.path.append((float(i),float(i)))
    report=core.report()
    assert len(report['preview']['cells'])<=2000 and len(report['preview']['path'])<=256
    assert len(json.dumps(report).encode())<=65536
    C.AgentMappingUpdate.model_validate(report)
    assert core.command({**start,'op':'cancel'})


def test_frame_dispatch_has_zero_motion_and_preserves_existing_stop():
    from foothold_agent.go2_direct.readonly import Observer, Measurements
    observer = Observer(Measurements())
    mapper = NS(command=lambda frame: received.append(frame))
    observer.mapping = mapper
    received=[]
    effects = observer.receive(command())
    assert len(received)==1 and effects.motion == ()
    # Acquisition core/runtime have no reachable motion SDK, sink or Core import.
    root=Path(__file__).resolve().parents[1]/'foothold_agent/mapping'
    for file in root.glob('*.py'):
        tree=ast.parse(file.read_text())
        for node in ast.walk(tree):
            if isinstance(node,ast.ImportFrom):
                assert not any(x in (node.module or '') for x in ('sport_client','sink','safety','ros'))
            if isinstance(node,ast.Attribute):
                assert node.attr not in ('Move','StopMove','ChannelPublisher','DataWriter')


def test_cloud_bus_shares_one_subscription_and_does_not_construct_publishers(monkeypatch):
    calls=[]; callbacks={}
    class Subscriber:
        def __init__(self,topic,kind): self.topic=topic; calls.append(('subscribe',topic))
        def Init(self,callback,queue): callbacks[self.topic]=callback
        def Close(self): calls.append(('close',self.topic))
    def forbidden(*a,**k): raise AssertionError('motion/publication forbidden')
    monkeypatch.setitem(sys.modules,'unitree_sdk2py.core.channel',NS(ChannelSubscriber=Subscriber,ChannelPublisher=forbidden))
    monkeypatch.setitem(sys.modules,'unitree_sdk2py.idl.sensor_msgs.msg.dds_',NS(PointCloud2_=object))
    bus=CloudBus(); a=[]; b=[]
    one=bus.subscribe('rt/utlidar/cloud',a.append)
    two=bus.subscribe('rt/utlidar/cloud',b.append)
    callbacks['rt/utlidar/cloud']('synthetic')
    assert a==b==['synthetic'] and calls==[('subscribe','rt/utlidar/cloud')]
    one.Close(); assert len(calls)==1
    two.Close(); assert calls[-1]==('close','rt/utlidar/cloud')


def test_runtime_stale_sensors_disconnect_and_save_retention(tmp_path):
    clock=NS(t=0.)
    sent=[]
    def request(session,suffix,data):
        sent.append((session,suffix,len(data)))
        if suffix=='point-cloud': raise OSError('synthetic failed upload')
        return {'accepted':True}
    runtime=MappingRuntime(NS(),NS(),Settings('wss://example.invalid/api/v1/agent/ws','fake-token'),
        str(uuid4()),{'FH_MAPPING_CACHE_DIR':str(tmp_path)},now=lambda:clock.t,request=request)
    runtime.online=True
    start=command(); runtime.command(start); runtime.step()
    runtime.core.add(synthetic_room(),[0,0,0],[1,0,0,0],stamp=1)
    runtime.online=False; runtime.step()
    assert runtime.core.status=='FAILED' and runtime.core.error_code=='LINK_LOST'
    count=len(runtime.core.cells)
    runtime.online=True; runtime.step()
    assert runtime.core.status=='FAILED' and len(runtime.core.cells)==count  # no auto resume
    runtime.command({**start,'op':'save'}); runtime.step()
    deadline=time.monotonic()+2
    while runtime.save_future is not None and not runtime.save_future.done() and time.monotonic()<deadline:
        time.sleep(.01)
    runtime.step()
    assert runtime.core.status=='FAILED' and runtime.path.is_file()
    assert b'DATA binary\n' in runtime.path.read_bytes()
    runtime.command({**start,'op':'cancel'}); runtime.step()
    assert runtime.core.status=='CANCELLED' and not runtime.path.exists()
    runtime.io.shutdown(wait=True)


def test_runtime_uses_synchronized_cloud_pose_and_stop_is_unchanged(tmp_path):
    from foothold_agent.go2_direct.server import DriveSession
    runtime=MappingRuntime(NS(),NS(),Settings('wss://example.invalid/api/v1/agent/ws','fake-token'),
        str(uuid4()),{'FH_MAPPING_CACHE_DIR':str(tmp_path)},request=lambda *a:{'accepted':True})
    runtime.online=True
    start=command(); runtime.command(start); runtime.step()
    data=synthetic_room().astype('<f4').tobytes(); n=len(data)//12
    cloud=NS(data=data,width=n,height=1,point_step=12,row_step=len(data),is_bigendian=False,
        fields=[NS(name=k,offset=i*4,datatype=7,count=1) for i,k in enumerate(('x','y','z'))],
        header=NS(stamp=NS(sec=1,nanosec=1),frame_id='utlidar_lidar'))
    pose=NS(stamp=NS(sec=1,nanosec=1),position=[0.,0.,0.],imu_state=NS(quaternion=[1.,0.,0.,0.]))
    runtime.sport(pose); runtime.cloud(cloud); runtime.step()
    assert len(runtime.core.cells)>1000
    count=len(runtime.core.cells)
    runtime.cloud(cloud); runtime.step()
    assert len(runtime.core.cells)==count  # repeated sensor timestamp ignored
    feedback=NS(telemetry=lambda:{},sample=lambda:None)
    session=DriveSession(feedback)
    session.mapping=runtime
    session.connect()
    assert session.receive({**start,'op':'save'}).motion==()
    effects=session.receive({'t':'stop','stop_ref':1})
    assert session.core.latch and any(c.kind=='stop' for c in effects.motion)
    runtime.io.shutdown(wait=True)


def test_restarted_process_reports_missing_accumulation_instead_of_hanging():
    sent=[]
    runtime=MappingRuntime(NS(),NS(),Settings('wss://example.invalid/api/v1/agent/ws','fake-token'),
        str(uuid4()),{},request=lambda *args:sent.append(args))
    runtime.online=True
    runtime.command(command('save')); runtime.step()
    assert runtime.core.status=='FAILED' and runtime.core.error_code=='MAPPING_SESSION_LOST'
    runtime.io.shutdown(wait=True)
    assert sent and json.loads(sent[-1][2])['status']=='FAILED'


def test_new_authorized_start_recovers_a_cancel_missed_while_offline():
    runtime=MappingRuntime(NS(),NS(),Settings('wss://example.invalid/api/v1/agent/ws','fake-token'),
        str(uuid4()),{},request=lambda *args:None)
    runtime.online=True
    first=command(); runtime.command(first); runtime.step()
    runtime.core.add(synthetic_room(),[0,0,0],[1,0,0,0],stamp=1)
    runtime.online=False; runtime.step()
    assert runtime.core.status=='FAILED' and runtime.core.cells
    # Server can only issue a different start UUID after ending the prior session.
    second=command(); runtime.online=True; runtime.command(second); runtime.step()
    assert runtime.core.session_id==second['session_id'] and runtime.core.status=='RUNNING'
    assert not runtime.core.cells
    runtime.io.shutdown(wait=True)

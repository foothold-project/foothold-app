"""Synthetic odom scans only: never initialize DDS, robot clients or services."""
import asyncio
import json
import math
import struct
import threading
import time
from types import SimpleNamespace as NS
from uuid import uuid4

import numpy as np
import pytest

from foothold_agent.go2_direct.media import Source
from foothold_agent.mapping.core import Accumulator
from foothold_agent.mapping.poses import Poses
from foothold_agent.mapping.runtime import MappingRuntime
from foothold_agent.mapping.inputs import DEFAULT_TOPIC, ODOM_TOPIC, ObservationInputs
from foothold_agent.link.client import Client, Settings
from foothold_agent.setup.runtime import Inputs, run
from foothold_agent.setup.view import Status
from apps.contracts.models import MediaPointCloudHeader
from test_mapping import command
from test_go2_drive_media import cloud
from test_setup_pairing import credentials, NIC_VALUE, OfflineSink, FakeSport, low, sport
from test_setup_approval_runtime import until


def odom(x=1., y=0., z=0., yaw=math.pi/2, stamp=1):
    return NS(header=NS(frame_id='odom', stamp=NS(sec=1, nanosec=stamp)),
              pose=NS(pose=NS(position=NS(x=x, y=y, z=z),
                  orientation=NS(w=math.cos(yaw/2), x=0., y=0., z=math.sin(yaw/2)))))


def sport_pose(x=10.):
    return NS(stamp=NS(sec=999, nanosec=1), position=[x, 0., 0.],
              imu_state=NS(quaternion=[1., 0., 0., 0.]))


def scan(xyz, stamp=1):
    msg = cloud(len(xyz), frame='odom')
    msg.data = np.asarray(xyz, dtype='<f4').tobytes()
    msg.header.stamp.nanosec = stamp
    return msg


@pytest.mark.parametrize('fallback', [False, True])
def test_media_odom_pose_raw_timeout_and_recovery(fallback):
    clock = NS(t=0.)
    recorded = []
    source = Source(NS(robot=str(uuid4()), approval=NS(robot_serial='fake')),
        {}, object(), now=lambda: clock.t, include_depth=False,
        recorder=NS(lidar=recorded.append))
    source.poses.sport(sport_pose())
    if not fallback:
        source.poses.odom(odom())
    msg = scan([[3., 2., 1.]]*10000)
    source.deskewed(msg)
    source.cloud(cloud())
    source.publish_clouds()
    sample = source.sample('lidar')
    header, payload = sample[1:]
    assert header['frame'] == 'odom' and header['map_version_id'] is None
    assert header['pose']['x'] == (10. if fallback else 1.)
    assert header['pose']['yaw'] == pytest.approx(0. if fallback else math.pi/2)
    assert header['count'] <= 4000 and header['truncated'] and len(payload) <= 48000
    MediaPointCloudHeader.model_validate(header).validate_payload(payload)
    assert struct.unpack_from('<fff', payload) == (3., 2., 1.)
    assert len(recorded) == 1 and recorded[0][-1] == 'utlidar_lidar'
    # Source switches retain the common two-Hz cap.
    clock.t = .1
    msg.header.stamp.nanosec += 1
    source.deskewed(msg); source.publish_clouds()
    assert source.latest['lidar'][1]['seq'] == 1
    clock.t = 2.99
    raw = cloud(); raw.header.stamp.nanosec = 2
    source.cloud(raw); source.publish_clouds()
    assert source.sample('lidar') is None
    clock.t = 3.5
    raw.header.stamp.nanosec = 3
    source.cloud(raw); source.publish_clouds()
    header = source.sample('lidar')[1]
    assert header['frame'] == 'lidar_link' and header['pose'] is None
    clock.t = 4.
    source.poses.odom(odom(stamp=5))
    msg.header.stamp.nanosec = 5
    source.deskewed(msg); source.publish_clouds()
    assert source.sample('lidar')[1]['frame'] == 'odom'
    source.close()
    assert source.sample('lidar') is None


def test_pose_buffer_rejects_bad_stale_replayed_and_mismatched_odometry():
    clock = NS(t=0.)
    poses = Poses(lambda: clock.t)
    bad = odom(); bad.header.frame_id = 'map'; poses.odom(bad)
    bad = odom(); bad.pose.pose.orientation.w = float('nan'); poses.odom(bad)
    assert poses.nearest(0., 1_000_000_001) is None
    poses.odom(odom())
    poses.odom(odom(x=99.))  # duplicate stamp cannot overwrite
    assert poses.nearest(0., 1_000_000_001)[2][0] == 1.
    assert poses.nearest(0., 2_000_000_000) is None
    clock.t = .6
    assert poses.nearest(0., 1_000_000_001) is None


def test_odom_accumulator_never_rotates_translates_or_applies_mount():
    core = Accumulator(extrinsic=(9., 8., 7., .5, .6, .7))
    core.command(command())
    q = [math.cos(math.pi/4), 0., 0., math.sin(math.pi/4)]
    points = [[1.1, 0., 0.], [3., 2., 1.], [0., 0., 0.]]
    core.add(points, [1., 0., 0.], q, stamp=1, frame='odom')
    values = set(core.cells.values())
    assert values == {(3., 2., 1.), (0., 0., 0.)}  # body exclusion is robot-relative
    core.add(points, [1.5, 0., 0.], q, stamp=2, frame='odom')
    assert core.distance == .5 and core.robot == pytest.approx([1.5, 0., math.pi/2])
    assert len(core.path) == 2 and (3., 2., 1.) in core.cells.values()


@pytest.mark.parametrize('fallback', [False, True])
def test_mapping_runtime_accumulates_deskewed_in_odom(tmp_path, fallback):
    runtime = MappingRuntime(NS(), NS(), Settings('wss://example.invalid/api/v1/agent/ws', 'fake'),
        str(uuid4()), {'FH_MAPPING_CACHE_DIR': str(tmp_path), 'FH_MAPPING_LIDAR_TO_BODY': 'invalid'},
        request=lambda *args: {})
    try:
        runtime.online = True
        runtime.command(command()); runtime.step()
        runtime.sport(sport_pose(x=1.))
        if not fallback:
            runtime.odom(odom())
        runtime.cloud(scan([[3., 2., 1.], [1.1, 0., 0.]])); runtime.step()
        assert runtime.core.status == 'RUNNING' and runtime.core.cells
        assert set(runtime.core.cells.values()) == {(3., 2., 1.)}
        assert runtime.core.robot == pytest.approx([1., 0., 0. if fallback else math.pi/2])
    finally:
        runtime.close(); runtime.io.shutdown(wait=True)


def test_odometry_bus_uses_nav_msgs_and_releases_last_listener(monkeypatch):
    import sys
    calls, callbacks = [], {}
    class Subscriber:
        def __init__(self, topic, kind):
            calls.append((topic, kind)); self.topic = topic
        def Init(self, callback, queue): callbacks[self.topic] = callback
        def Close(self): calls.append(('closed', self.topic))
    kind = object()
    monkeypatch.setitem(sys.modules, 'unitree_sdk2py.core.channel', NS(ChannelSubscriber=Subscriber))
    monkeypatch.setitem(sys.modules, 'unitree_sdk2py.idl.nav_msgs.msg.dds_', NS(Odometry_=kind))
    inputs = ObservationInputs(); inputs.init_observations()
    received = []
    a = inputs.odometry(received.append); b = inputs.odometry(received.append)
    callbacks[ODOM_TOPIC]('fake')
    assert received == ['fake'] and calls == [(ODOM_TOPIC, kind)]
    a.Close(); b.Close()
    assert calls[-1] == ('closed', ODOM_TOPIC)


@pytest.mark.parametrize('end', ['revoke', 'reconnect', 'feedback', 'mapping-error'])
@pytest.mark.parametrize('operation', ['save', 'cancel'])
def test_installed_setup_slam_start_progress_save_and_approval_lifetime(tmp_path, end, operation):
    async def scenario():
        stop, seen, reports, uploads, maps = asyncio.Event(), {}, [], [], []
        inputs = Inputs()
        class Channel:
            def __init__(self): self.callbacks = {}; self.listeners = []; self.closed = []
            def cloud(self, topic, callback):
                self.callbacks[topic] = callback
                return NS(Close=lambda: self.closed.append(topic))
            def odometry(self, callback): return self.cloud(ODOM_TOPIC, callback)
            def add_sport_listener(self, callback): self.listeners.append(callback)
            def remove_sport_listener(self, callback): self.listeners.remove(callback)
        channel = Channel()
        class FakeClient(Client):
            async def run(self):
                seen['client'] = self
                self._emit(self.session.connect())
                sequence = 0
                while not stop.is_set():
                    sequence += 1
                    if not seen.get('feedback_lost'):
                        inputs.lowstate(low(sequence)); inputs.sportmodestate(sport(sequence))
                    self._emit(self.session.receive(dict(t='ping', seq=sequence)))
                    await asyncio.sleep(.01)
        def request(session, suffix, data):
            (reports if suffix == 'progress' else uploads).append(json.loads(data) if suffix == 'progress' else data)
            return {'accepted': True}
        def mapping_factory(observer, channel, settings, robot, env, **kwargs):
            mapper = MappingRuntime(observer, channel, settings, robot,
                {'FH_MAPPING_CACHE_DIR': str(tmp_path)}, request=request, **kwargs)
            observer.mapping = mapper; maps.append(mapper)
            if end == 'mapping-error':
                async def fail(): raise RuntimeError('fake observation failure')
                return asyncio.create_task(fail())
            return asyncio.create_task(mapper.run())
        def no_media(*args): raise ImportError('fake camera absent')
        recorder = NS(notice='', stopped=threading.Event(), start=lambda: None, close=lambda: None)
        task = asyncio.create_task(run(credentials(), NIC_VALUE, inputs, channel,
            ready=True, check_nic=lambda: True, status=Status(), stop=stop,
            client_factory=FakeClient, connect=lambda *args: (FakeSport(), FakeSport()),
            sink_factory=OfflineSink, media_factory=no_media, mapping_factory=mapping_factory,
            recorder_factory=lambda *args, **kwargs: recorder))
        try:
            await until(lambda: 'client' in seen and inputs.feedback.sample() is not None, task)
            client = seen['client']; session = client.session
            start = command()
            session.receive(start)
            assert not maps  # no mapping before field approval
            session.receive(dict(t='field_approval', expires_at=time.time()+60))
            await until(lambda: bool(maps), task)
            mapper = maps[0]
            if end == 'mapping-error':
                await asyncio.sleep(.08)
                assert not task.done() and client.sink.active is not None
            else:
                await until(lambda: DEFAULT_TOPIC in channel.callbacks and mapper.online, task)
                session.receive(start)
                await until(lambda: mapper.core.status == 'RUNNING', task)
                channel.callbacks[ODOM_TOPIC](odom())
                channel.callbacks[DEFAULT_TOPIC](scan([[3., 2., 1.], [3., 2., 0.]]))
                await until(lambda: bool(mapper.core.cells), task)
                retained = mapper.core.pcd()
                if end == 'reconnect': session.disconnect()
                elif end == 'feedback': seen['feedback_lost'] = True
                else: client.sink.revoke()
                await until(lambda: mapper.core.error_code == 'LINK_LOST', task)
                assert not mapper.stopping.is_set() and mapper.core.pcd() == retained
                assert mapper.core.session_id == start['session_id']
                assert session.core.latch and client.sink.active is None
                assert not uploads and len(maps) == 1
                channel.callbacks[ODOM_TOPIC](odom(stamp=2))
                channel.callbacks[DEFAULT_TOPIC](scan([[9., 8., 1.]], stamp=2))
                # Frames arriving without approval cannot save/cancel the map.
                session.receive({**start, 'op': operation})
                await asyncio.sleep(.08)
                assert mapper.core.status == 'FAILED' and mapper.core.pcd() == retained
                if end == 'reconnect': session.connect()
                seen['feedback_lost'] = False
                await until(lambda: inputs.feedback.sample() is not None, task)
                session.receive(dict(t='field_approval', expires_at=time.time()+120))
                await until(lambda: client.sink.active is not None and mapper.online, task)
                assert session.mapping is mapper and len(maps) == 1
                assert mapper.core.status == 'FAILED' and mapper.core.pcd() == retained
                session.receive({**start, 'op': operation})
                if operation == 'save':
                    await until(lambda: any(r['status'] == 'SAVED' for r in reports), task)
                    assert uploads == [retained]
                    assert any(r['status'] == 'RUNNING' for r in reports)
                else:
                    await until(lambda: any(r['status'] == 'CANCELLED' for r in reports), task)
                    assert not mapper.core.cells and not uploads
            effects = session.receive(dict(t='stop', stop_ref=44))
            assert session.core.latch and any(c.kind == 'stop' for c in effects.motion)
        finally:
            stop.set(); await asyncio.wait_for(task, 3)
            assert all(m.stopping.is_set() for m in maps)
            assert not channel.listeners
            for mapper in maps:
                if mapper.thread is not None:
                    await asyncio.to_thread(mapper.thread.join, .5)
            assert end == 'mapping-error' or set(channel.closed) == {DEFAULT_TOPIC, ODOM_TOPIC}
    asyncio.run(scenario())


@pytest.mark.parametrize('stall', ['init', 'close'])
def test_mapping_sdk_stall_never_holds_the_event_loop(stall):
    entered, release = threading.Event(), threading.Event()
    class Channel:
        def cloud(self, *_args):
            if stall == 'init':
                entered.set(); release.wait(2)
            return NS(Close=self.close)
        def close(self):
            if stall == 'close':
                entered.set(); release.wait(2)
        def add_sport_listener(self, _callback): pass
        def remove_sport_listener(self, _callback): pass
    async def scenario():
        mapper = MappingRuntime(NS(connected=True, link_lost=False, reconnect_required=False),
            Channel(), Settings('wss://example.invalid/api/v1/agent/ws', 'fake'), str(uuid4()), {})
        task = asyncio.create_task(mapper.run())
        try:
            if stall == 'init':
                async with asyncio.timeout(.5):
                    while not entered.is_set(): await asyncio.sleep(.005)
            else:
                async with asyncio.timeout(.5):
                    while mapper.handle is None: await asyncio.sleep(.005)
            task.cancel()
            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), .1)
            if stall == 'close':
                async with asyncio.timeout(.5):
                    while not entered.is_set(): await asyncio.sleep(.005)
            assert entered.is_set() and mapper.stopping.is_set()
        finally:
            release.set()
    asyncio.run(scenario())


@pytest.mark.parametrize('had_pose', [False, True])
def test_media_continuous_deskew_without_pose_falls_back_after_three_seconds(had_pose):
    clock = NS(t=0.)
    source = Source(NS(robot=str(uuid4()), approval=NS(robot_serial='fake')), {}, object(),
        now=lambda: clock.t, include_depth=False, recorder=NS(lidar=lambda raw: None))
    try:
        if had_pose:
            source.poses.odom(odom())
        for index in range(7):
            clock.t = index * .5
            source.deskewed(scan([[3., 2., 1.]], stamp=index+1))
            raw = cloud(); raw.header.stamp.nanosec = index+1
            source.cloud(raw); source.publish_clouds()
            sample = source.sample('lidar')
            if clock.t == 0. and had_pose:
                assert sample[1]['frame'] == 'odom'
            elif clock.t < 3.:
                assert sample is None or sample[1]['frame'] == 'odom'
            else:
                assert sample[1]['frame'] == 'lidar_link'
                assert sample[1]['pose'] is None and sample[1]['map_version_id'] is None
                MediaPointCloudHeader.model_validate(sample[1]).validate_payload(sample[2])
        clock.t = 3.5
        source.poses.odom(odom(stamp=8))
        source.deskewed(scan([[3., 2., 1.]], stamp=8)); source.publish_clouds()
        assert source.sample('lidar')[1]['frame'] == 'odom'
    finally:
        source.close()


@pytest.mark.parametrize('same_robot', [False, True])
def test_new_runtime_cannot_restore_another_runtime_map(tmp_path, same_robot):
    robot = str(uuid4())
    args = (NS(), NS(), Settings('wss://example.invalid/api/v1/agent/ws', 'fake'))
    env = {'FH_MAPPING_CACHE_DIR': str(tmp_path)}
    first = MappingRuntime(*args, robot, env, request=lambda *args: {})
    second = MappingRuntime(*args, robot if same_robot else str(uuid4()), env, request=lambda *args: {})
    try:
        start = command()
        first.online = second.online = True
        first.command(start); first.step()
        first.core.add([[3., 2., 1.]], [1., 0., 0.], [1., 0., 0., 0.], stamp=1, frame='odom')
        second.command({**start, 'op': 'save'}); second.step()
        assert second.core.error_code == 'MAPPING_SESSION_LOST' and not second.core.cells
        assert first.core.status == 'RUNNING' and first.core.cells
    finally:
        for mapper in (first, second):
            mapper.close(); mapper.io.shutdown(wait=True)

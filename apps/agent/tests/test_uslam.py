"""Bounded onboard SLAM decoding and worker lifecycle, using fake DDS only."""
import math
import struct
import threading
import time
from types import SimpleNamespace as NS

import pytest

from foothold_agent.go2_direct import uslam
from foothold_agent.go2_direct.media import Publisher, Source
from test_go2_drive_media import cloud


@pytest.mark.parametrize('big', [False, True])
@pytest.mark.parametrize('octets', [bytes, list])
def test_mixed_types_organized_padding_and_order(big, octets):
    endian = '>' if big else '<'
    data = bytearray(112)
    for i in range(4):
        at = (i//2)*56 + (i%2)*24
        struct.pack_into(endian+'h', data, at+1, -i)
        struct.pack_into(endian+'d', data, at+6, 1.5+i)
        struct.pack_into(endian+'f', data, at+17, i+.25)
    msg = cloud(frame='world')
    msg.width, msg.height, msg.point_step, msg.row_step = 2, 2, 24, 56
    msg.fields = [NS(name=n, datatype=d, offset=o, count=1) for n, d, o in (
        ('z', 3, 1), ('x', 8, 6), ('intensity', 2, 0), ('y', 7, 17))]
    msg.data, msg.is_bigendian = octets(data), big
    header, payload = uslam.cloud(msg)
    assert header['frame'] == 'world' and header['source'] == uslam.CLOUD
    assert not header['truncated'] and header['count'] == 4
    assert list(struct.iter_unpack('<fff', payload)) == [(1.5+i, i+.25, -i) for i in range(4)]


@pytest.mark.parametrize('count', [4000, 4001, 30000])
def test_output_bound(count):
    header, payload = uslam.cloud(cloud(count))
    assert header['count'] == 4000 and header['byte_length'] == len(payload) == 48000
    assert header['truncated'] == (count > 4000)


@pytest.mark.parametrize('bad', ['empty', 'oversize', 'short', 'overlap', 'missing', 'duplicate',
                                 'datatype', 'array', 'offset', 'nan', 'range', 'frame'])
def test_reject_bad_cloud(bad):
    msg = cloud(0 if bad == 'empty' else 1)
    if bad == 'oversize': msg.row_step = uslam.MAX_INPUT_BYTES+1
    if bad == 'short': msg.data = msg.data[:-1]
    if bad == 'overlap': msg.fields[0].offset = 2
    if bad == 'missing': msg.fields.pop()
    if bad == 'duplicate': msg.fields.append(msg.fields[0])
    if bad == 'datatype': msg.fields[0].datatype = 42
    if bad == 'array': msg.fields[0].count = 3
    if bad == 'offset': msg.fields[0].offset = 12
    if bad == 'nan': msg.data = struct.pack('<fff', 0, math.nan, 0)
    if bad == 'range': msg.data = struct.pack('<fff', 1e6, 0, 0)
    if bad == 'frame': msg.header.frame_id = 'bad\nframe'
    with pytest.raises(ValueError):
        uslam.cloud(msg)


def pose():
    return NS(header=NS(frame_id='world', stamp=NS(sec=1, nanosec=0)), child_frame_id='base_link',
              pose=NS(pose=NS(position=NS(x=-1., y=2., z=.3),
                              orientation=NS(w=.5**.5, x=0., y=0., z=.5**.5))))


@pytest.mark.parametrize('topic', [uslam.FRONTEND, uslam.LOCALIZATION])
def test_odom(topic):
    msg = pose()
    header, payload = uslam.odometry(msg, topic)
    assert header['pose'] == pytest.approx(dict(x=-1, y=2, z=.3, yaw=math.pi/2))
    assert header['source'] == topic and header['child_frame'] == 'base_link' and payload is None
    msg.pose.pose.orientation.w = 0
    with pytest.raises(ValueError, match='orientation'):
        uslam.odometry(msg, topic)
    msg = pose()
    msg.pose.pose.position.x = math.inf
    with pytest.raises(ValueError, match='pose'):
        uslam.odometry(msg, topic)


def wait_for(condition):
    deadline = time.monotonic()+3
    while not condition() and time.monotonic() < deadline:
        time.sleep(.005)
    assert condition()


def test_slam_workers_latest_only_independent_and_first_five_observations(caplog):
    callbacks, closed, uploads = {}, [], []
    release = threading.Event()
    class Bus:
        def subscribe(self, topic, callback, *, odometry=False):
            assert odometry == (topic in (uslam.FRONTEND, uslam.LOCALIZATION))
            callbacks[topic] = callback
            return NS(Close=lambda: closed.append(topic))

    channel = NS(cloud_bus=Bus())
    config = NS(robot='fake', approval=NS(robot_serial='fake'))
    publisher = Publisher(config, {}, channel, source_factory=lambda *args:
        Source(*args, include_depth=False, recorder=NS(start=lambda: None),
               authorize=lambda *_: None))
    source = publisher.source
    source.camera = source.lidar = lambda: None
    def upload(name, header, payload):
        uploads.append((name, header, payload))
        if name == 'slam':
            release.wait(2)
    assert source.slam_upload == publisher.upload
    source.slam_upload = upload
    source.start()
    try:
        wait_for(lambda: len(callbacks) == 4)
        assert uploads == []
        unknown = cloud(frame='192.0.2.1/private-token')
        for _ in range(8):
            callbacks[uslam.MAP](unknown)
        callbacks[uslam.CLOUD](cloud())
        wait_for(lambda: len(uploads) == 1)
        for i in range(2, 12):
            msg = cloud(i)
            msg.header.stamp.sec = i
            callbacks[uslam.CLOUD](msg)
        callbacks[uslam.LOCALIZATION](pose())
        wait_for(lambda: len(uploads) == 2)
        assert uploads[1][1]['pose']['yaw'] == pytest.approx(math.pi/2)
        release.set()
        wait_for(lambda: len(uploads) == 3)
        assert uploads[2][1]['count'] == 11 and uploads[2][1]['seq'] == 2
        assert caplog.text.count('observation topic='+uslam.MAP+' ') == uslam.OBSERVATIONS
        assert '192.0.2.1' not in caplog.text and 'private-token' not in caplog.text
        wait_for(lambda: uslam.MAP in closed)
        invalid = cloud(0)
        invalid.header.stamp.sec = 12
        callbacks[uslam.CLOUD](invalid)
        wait_for(lambda: 'reason=invalid_cloud_dimensions' in caplog.text)
        assert len(uploads) == 3
    finally:
        release.set()
        source.close()
        for thread in source.threads:
            thread.join(2)
        publisher.executor.shutdown()
    assert sorted(closed) == sorted(callbacks)


def test_setting_disables_readers_and_uploads():
    publisher = Publisher(NS(), {'FH_USLAM': '0'}, NS(cloud_bus=object()))
    try:
        assert publisher.source.slam_upload is None
    finally:
        publisher.source.close()
        publisher.executor.shutdown()


def test_oversize_buffer_rejected_before_retention(caplog):
    class Large:
        def __len__(self):
            return uslam.MAX_INPUT_BYTES + 1

    msg = cloud()
    msg.data = Large()
    reader = uslam.Reader(NS(now=lambda: 1., closing=threading.Event(), enabled=lambda: True), 'slam')
    reader.receive(uslam.CLOUD, msg)
    assert reader.pending[-1] is None
    assert reader.take_frame() is None
    assert 'reason=invalid_cloud_buffer' in caplog.text


def test_slam_authorization_precedes_all_subscriptions():
    def deny(*_):
        raise PermissionError()
    source = NS(env={}, channel=NS(), config=NS(approval=NS(robot_serial='test')), authorize=deny)
    for channel in uslam.TOPICS:
        with pytest.raises(PermissionError):
            uslam.Reader(source, channel).run()

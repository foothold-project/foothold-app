"""Synthetic geometry only; no DDS, robot, map files, or network service."""
import asyncio
import base64
import json
import struct
import time
from types import SimpleNamespace as NS

import numpy as np
import pytest

from foothold_agent.media import edges
from foothold_agent.media.processing import points as ros_points
from foothold_agent.media.transport import MediaTransport
from foothold_agent.go2_direct.media import points as sdk_points, Source, approved_publisher


def room():
    """Floor + wall + three visible box faces (also a raised tabletop)."""
    a = np.arange(-1., 1.01, .1)
    floor = [(x, y, 0) for x in a for y in a]
    wall = [(1., y, z) for y in a for z in np.arange(.1, 1.51, .1)]
    side = np.arange(-.5, .51, .1)
    height = np.arange(.1, .81, .1)
    box = ([(x, y, .8) for x in side for y in side]
           + [(-.5, y, z) for y in side for z in height]
           + [(x, -.5, z) for x in side for z in height])
    return np.array(floor + wall + box, dtype='<f4')


def raw(xyz, frame='lidar_link'):
    payload = xyz.astype('<f4').tobytes()
    return (payload, len(xyz), 1, 12, len(payload), False,
            (('x', 0, 7, 1), ('y', 4, 7, 1), ('z', 8, 7, 1)), frame)


def unlimited(monkeypatch):
    # Geometry assertions must not depend on the shared CI host's CPU load.
    monkeypatch.setattr(edges, 'EDGE_BUDGET_SECONDS', 10.)


def test_floor_wall_box_edges_stay_in_boundary_bands(monkeypatch):
    unlimited(monkeypatch)
    xyz = room()
    values = np.frombuffer(edges.edge_bytes(xyz.tobytes()), dtype='u1')
    x, y, z = xyz.T
    # A cell + its neighbors span at most 0.4 m on either side of a seam.
    wall_seam = (x >= .6) & (z <= .4)
    box_floor = ((np.abs(x + .5) <= .4) & (np.abs(y) <= .9) & (z <= .4)) | ((np.abs(y + .5) <= .4) & (np.abs(x) <= .9) & (z <= .4))
    box_rim = ((np.abs(x + .5) <= .4) | (np.abs(y + .5) <= .4)) & (np.abs(x) <= .9) & (np.abs(y) <= .9) & (z >= .4) & (z <= .81)
    vertical_corner = (np.abs(x + .5) <= .4) & (np.abs(y + .5) <= .4) & (z <= .81)
    assert not np.any(values[~(wall_seam | box_floor | box_rim | vertical_corner)])
    assert np.any(values[(x > .85) & (z < .2)])  # wall-floor
    assert np.any(values[(np.abs(x + .5) < .11) & (z > .69)])  # tabletop rim
    assert np.any(values[(np.abs(x + .5) < .11) & (np.abs(y + .5) < .11) & (z > .3) & (z < .6)])
    assert set(values) == {0, 255}


@pytest.mark.parametrize('axis', [0, 1, 2])
def test_flat_plane_centers_and_outer_boundaries_are_not_edges(monkeypatch, axis):
    unlimited(monkeypatch)
    a = np.linspace(-2, 2, 31)
    xyz = np.array([(x, y, 0) for x in a for y in a])[:, np.roll(np.arange(3), axis)]
    # Tilt and translate too: height differences alone must not mark a ramp.
    xyz[:, 2] += .3 * xyz[:, 0] + .2 * xyz[:, 1] + 123.
    assert not any(edges.edge_bytes(xyz.astype('<f4').tobytes()))


def test_bounds_empty_nonfinite_and_budget_skip(monkeypatch):
    assert edges.edge_bytes(b'') is None
    assert edges.edge_bytes(b'x') is None
    assert edges.edge_bytes(b'\0' * (12 * (edges.MAX_EDGE_POINTS+1))) is None
    assert edges.edge_bytes(struct.pack('<fff', float('nan'), 0., 0.)) is None
    ticks = iter((0., 1.))
    assert edges.edge_bytes(room().tobytes(), now=lambda: next(ticks)) is None
    ticks = iter([0.] * 28 + [1.])  # exceeded only after the final eigensolve
    assert edges.edge_bytes(room().tobytes(), now=lambda: next(ticks)) is None
    monkeypatch.setattr(edges, 'EDGE_BUDGET_SECONDS', -1.)
    header, payload = edges.annotate({'count': 1}, b'\0'*12, edge_enabled=True)
    assert header == {'count': 1} and payload == b'\0'*12


def test_exact_point_cap_and_sparse_or_repeated_returns(monkeypatch):
    unlimited(monkeypatch)
    xyz = np.random.default_rng(42).uniform(-20, 20, (edges.MAX_EDGE_POINTS, 3)).astype('<f4')
    assert len(edges.edge_bytes(xyz.tobytes())) == edges.MAX_EDGE_POINTS
    assert not any(edges.edge_bytes(np.zeros((edges.MAX_EDGE_POINTS, 3), dtype='<f4').tobytes()))


def test_missing_numpy_keeps_plain_scan(monkeypatch):
    import builtins
    original = builtins.__import__
    def missing(name, *args, **kwargs):
        if name == 'numpy':
            raise ImportError('optional numpy absent')
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', missing)
    header, _ = edges.annotate({}, b'\0'*12, edge_enabled=True)
    assert header == {}


@pytest.mark.parametrize('converter', [ros_points, sdk_points])
def test_opt_in_alignment_and_exact_old_header_and_payload(monkeypatch, converter):
    unlimited(monkeypatch)
    xyz = room()
    def converted():
        return (converter(raw(xyz), edge_enabled=edges.enabled())
                if converter is sdk_points else converter(raw(xyz)))
    monkeypatch.delenv('FH_LIDAR_EDGE_ENABLED', raising=False)
    old, payload = converted()
    assert 'edge_u8' not in old
    monkeypatch.setenv('FH_LIDAR_EDGE_ENABLED', '1')
    new, same_payload = converted()
    assert same_payload == payload
    strengths = base64.b64decode(new.pop('edge_u8'), validate=True)
    assert len(strengths) == new['count'] and new == old
    assert any(strengths)
    for switch in ('0', 'true', 'invalid'):
        monkeypatch.setenv('FH_LIDAR_EDGE_ENABLED', switch)
        assert converted() == (old, payload)


def test_mapping_and_recording_conversion_does_not_spend_edge_budget(monkeypatch):
    monkeypatch.setenv('FH_LIDAR_EDGE_ENABLED', '1')
    def forbidden(_):
        raise AssertionError('non-media conversion must not compute edges')
    monkeypatch.setattr(edges, 'edge_bytes', forbidden)
    header, _ = sdk_points(raw(room()), max_points=100000)
    assert 'edge_u8' not in header


def test_sdk_source_uses_own_environment_for_raw_and_odom(monkeypatch):
    unlimited(monkeypatch)
    monkeypatch.setenv('FH_LIDAR_EDGE_ENABLED', '0')
    source = Source(NS(robot='fake'), {'FH_LIDAR_EDGE_ENABLED': '1', 'FH_RECORD': '0'},
                    object(), include_depth=False, now=lambda: 1.)
    source.raw_cloud = (1., raw(room()))
    source.last_odom_points = -10.
    source.publish_clouds()
    assert 'edge_u8' in source.sample('lidar')[1]
    source.next_lidar_publish = -10.
    source.deskew_cloud = (1., raw(room(), 'odom'), 1)
    monkeypatch.setattr(source.poses, 'nearest', lambda *_: (1., 1, (0., 0., 0.), (1., 0., 0., 0.)))
    source.publish_clouds()
    assert source.sample('lidar')[1]['frame'] == 'odom'
    assert 'edge_u8' in source.sample('lidar')[1]
    source.close()


@pytest.mark.parametrize('switch', [None, '0', '1', 'true', 'invalid'])
@pytest.mark.parametrize('frame', ['lidar_link', 'odom'])
def test_approved_publisher_respects_edge_environment(monkeypatch, switch, frame):
    unlimited(monkeypatch)
    if switch is None:
        monkeypatch.delenv('FH_LIDAR_EDGE_ENABLED', raising=False)
    else:
        monkeypatch.setenv('FH_LIDAR_EDGE_ENABLED', switch)
    monkeypatch.setenv('FH_USLAM', '1')
    subscriptions = NS(state=NS(), cloud_bus=object())
    publisher = approved_publisher(NS(robot_id='fake', link=None), None,
                                   subscriptions, NS(lidar=lambda _: None), lambda: True)
    source = publisher.source
    source.now = lambda: 1.
    xyz = room()
    try:
        assert source.env['FH_USLAM'] == '0'
        assert source.slam_upload is None
        assert source.depth_source is None
        if frame == 'odom':
            source.deskew_cloud = (1., raw(xyz, frame), 1)
            monkeypatch.setattr(source.poses, 'nearest', lambda *_:
                                (1., 1, (0., 0., 0.), (1., 0., 0., 0.)))
        else:
            source.raw_cloud = (1., raw(xyz))
            source.last_odom_points = float('-inf')
        source.publish_clouds()
        _, header, payload = source.sample('lidar')
        assert header['frame'] == frame
        assert payload == xyz.tobytes()
        if switch == '1':
            strengths = base64.b64decode(header['edge_u8'], validate=True)
            assert len(strengths) == header['count']
            assert any(strengths)
        else:
            assert 'edge_u8' not in header
    finally:
        source.close()
        publisher.executor.shutdown(wait=True)


def test_direct_transport_sends_extension_in_same_json_xyz_pair(monkeypatch):
    unlimited(monkeypatch)
    monkeypatch.setenv('FH_LIDAR_EDGE_ENABLED', '1')
    header, payload = ros_points(raw(room()))
    binding = {'robot': 'fake', 'epoch': 1, 'episode_id': None}
    media = NS(binding=binding)
    transport = MediaTransport(media, None)
    sent = []
    class Socket:
        async def send(self, data):
            sent.append(data)
    async def run():
        queue = asyncio.Queue()
        queue.put_nowait((time.monotonic(), header, payload))
        task = asyncio.create_task(transport._frames(Socket(), 'lidar', queue, binding))
        try:
            async with asyncio.timeout(1):
                while len(sent) < 2:
                    await asyncio.sleep(.001)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())
    assert json.loads(sent[0])['edge_u8'] == header['edge_u8']
    assert sent[1] == payload and len(payload) == header['count'] * 12

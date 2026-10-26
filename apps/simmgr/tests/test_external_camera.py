"""Offline acceptance: generated assets, request policy, relay and cleanup only."""
import asyncio
from dataclasses import replace
import hashlib
import json
import math
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
import xml.etree.ElementTree as ET

from fastapi.testclient import TestClient
import pytest

from apps.simmgr.api import create_app
from apps.simmgr.external_camera import (Observer, DEFAULT_VIEW, ENTITY, GZ_TOPIC,
                                         ROS_TOPIC, SERVICE, episode_world)
from apps.simmgr import launcher, preflight, observer_unit
from apps.simmgr.launcher import CleanupUnconfirmed, NativeLauncher
from apps.simmgr.repo_runtime import robot_world
from test_manager import settings


@pytest.fixture
def policy():
    clock = [10.]
    robot, episode = str(uuid4()), str(uuid4())
    observer = Observer(robot, episode, now=lambda: clock[0])
    observer.status(dict(run_id=episode.replace('-', ''), epoch=1))
    observer.state(dict(episode=1, reset_in_progress=False, x=1., y=2., z=.4))
    body = dict(t='external.view', version='observer/1', robot=robot, episode_id=episode,
                epoch=1, seq=0, yaw=0., pitch=0., radius=2.)
    return observer, body, clock


@pytest.mark.parametrize('world_id', ['warehouse', 'rubble'])
def test_generated_world_preserves_original_geometry_and_robot(world_id, tmp_path):
    root = Path(__file__).resolve().parents[1]/'worlds'
    source = root/world_id/(world_id+'.sdf')
    entry = json.loads((root/'worlds.json').read_text())['worlds'][world_id+'/f1']
    native = SimpleNamespace(root=root, world_file=source, entry=entry)
    before = {p: hashlib.sha256(p.read_bytes()).digest() for p in root.rglob('*') if p.is_file()}
    prepared = robot_world(source.read_text(), native, tmp_path)
    generated = ET.fromstring(episode_world(prepared))
    world = generated.find('world')
    cameras = world.findall(f"model[@name='{ENTITY}']")
    assert len(cameras) == 1
    cam = cameras[0]
    assert cam.findtext('static') == 'true' and cam.findtext('link/gravity') == 'false'
    assert cam.findall('.//collision') == [] and cam.findall('.//joint') == []
    sensor = cam.find('link/sensor')
    assert sensor.findtext('update_rate') == '5' and sensor.findtext('topic') == GZ_TOPIC
    assert [sensor.findtext('camera/image/'+v) for v in ('width', 'height', 'format')] == ['320', '240', 'R8G8B8']
    assert 'follow' not in ET.tostring(cam).decode()
    world.remove(cam)
    assert ET.tostring(generated) == ET.tostring(ET.fromstring(prepared))
    assert all(hashlib.sha256(p.read_bytes()).digest() == sha for p, sha in before.items())
    assert ROS_TOPIC == '/v2_live/external_cam/compressed'
    assert SERVICE == '/world/fh_v2_live/set_pose'


def test_missing_user_commands_and_duplicate_camera_fail_closed():
    with pytest.raises(ValueError):
        episode_world('<sdf><world name="fh_v2_live"/></sdf>')
    sdf = '<sdf><world name="fh_v2_live"><plugin filename="gz-sim-user-commands-system"/></world></sdf>'
    with pytest.raises(ValueError):
        episode_world(episode_world(sdf))


def test_pose_values_rate_latest_and_cancel(policy):
    observer, body, clock = policy
    observer.submit(body)
    calls = []
    assert observer.tick(lambda pose: calls.append(pose) or True)
    assert calls == [(3., 2., .4, 0., 0., -math.pi)]
    for seq in range(1, 100):
        observer.submit(dict(body, seq=seq, radius=4.))
    assert observer.pending[1] == (0., 0., 4.)
    clock[0] += .05
    assert not observer.tick(lambda p: calls.append(p))
    observer.submit(dict(body, seq=100), 'cancel')
    assert observer.pending is None and observer.view == (0., 0., 2.)
    clock[0] += .06
    observer.tick(lambda p: calls.append(p))
    assert len(calls) == 2 and calls[-1][0] == 3.
    observer.submit(dict(body, seq=101), 'reset')
    clock[0] += .11
    observer.tick(lambda p: calls.append(p))
    assert observer.view == DEFAULT_VIEW
    x, y, z, _, pitch, yaw = calls[-1]
    assert x < 1 and y == pytest.approx(2) and z > .4
    assert pitch == .45 and yaw == pytest.approx(0, abs=1e-12)


@pytest.mark.parametrize('change', [dict(yaw=3.2), dict(pitch=1.21), dict(radius=.49),
    dict(radius=10.1), dict(yaw=float('nan')), dict(pitch=float('inf')),
    dict(entity='go2_v2'), dict(service='/anything'), dict(world='other'),
    dict(robot=str(uuid4())), dict(episode_id=str(uuid4())), dict(epoch=2)])
def test_bounds_extra_fields_and_wrong_bindings(policy, change):
    observer, body, _ = policy
    with pytest.raises(ValueError):
        observer.submit(dict(body, **change))
    assert observer.pending is None


def test_stale_pose_sequence_pending_timeout_epoch_and_reset(policy):
    observer, body, clock = policy
    observer.submit(body)
    with pytest.raises(ValueError):
        observer.submit(body)
    clock[0] += .31
    observer.tick(lambda p: True)
    assert observer.view == DEFAULT_VIEW and observer.pending is None
    clock[0] += .3
    assert not observer.tick(lambda p: pytest.fail('stale pose moved camera'))
    with pytest.raises(ValueError):
        observer.submit(dict(body, seq=1))
    observer.status(dict(run_id=observer.episode.replace('-', ''), epoch=2))
    assert observer.position is observer.pending is None and observer.seq == -1
    observer.state(dict(episode=1, x=5, y=5, z=5))
    assert observer.position is None
    observer.state(dict(episode=2, x=1, y=2, z=.4))
    observer.submit(dict(body, epoch=2))
    observer.state(dict(episode=2, reset_in_progress=True, x=1, y=2, z=.4))
    assert observer.position is observer.pending is None


def test_fixed_camera_gazebo_request_and_timeout(policy):
    from apps.simmgr.observer_entry import send_pose
    observer, body, _ = policy
    class Pose:
        def __init__(self):
            self.position, self.orientation = SimpleNamespace(), SimpleNamespace()
    calls = []
    def request(*args):
        calls.append(args)
        return True, SimpleNamespace(data=True)
    observer.submit(body)
    assert observer.tick(lambda values: send_pose(SimpleNamespace(request=request), values, Pose, bool))
    service, pose, request_type, response_type, timeout = calls[0]
    assert service == SERVICE and pose.name == ENTITY and timeout == 80
    assert request_type == Pose and response_type == bool
    assert vars(pose.position) == dict(x=3., y=2., z=.4)
    q = pose.orientation
    assert q.x == q.y == 0 and q.z == -1 and q.w == pytest.approx(0, abs=1e-12)
    assert not send_pose(SimpleNamespace(request=lambda *a: (False, SimpleNamespace(data=True))),
                         (0, 0, 0, 0, 0, 0), Pose, bool)


def test_authenticated_http_relay_rejects_forgery_and_unsupported_world(policy):
    _, body, _ = policy
    cfg = settings()
    slot = next(iter(cfg.slots.values()))
    body['robot'] = slot.robot_id
    app = create_app(cfg)
    manager = app.state.manager
    manager.robots[slot.robot_id] = SimpleNamespace(state='RUNNING', generation=1, slot=slot)
    calls = []
    async def relay(request, op):
        calls.append((request, op))
        return dict(accepted=True, shared=True)
    headers = {'Authorization': 'Bearer '+cfg.secret}
    with TestClient(app, client=('127.0.0.1', 9580)) as client:
        path = '/v1/robots/'+slot.robot_id+'/external-camera/'
        assert client.post(path+'view', json=body).status_code == 401
        assert client.post(path+'view', headers=headers, json=body).status_code == 409
        manager.launcher.external_view = relay
        for op in ('view', 'reset', 'cancel'):
            assert client.post(path+op, headers=headers, json=body).status_code == 200
        assert [c[1] for c in calls] == ['view', 'reset', 'cancel']
        assert client.post(path+'view', headers=headers, json=dict(body, entity='go2_v2')).status_code == 400
        assert client.post(path+'view', headers=headers, json=dict(body, robot=str(uuid4()))).status_code == 409
        manager.robots.clear()
        assert client.post(path+'view', headers=headers, json=body).status_code == 409


def test_cleanup_failure_latches_and_prevents_native_close():
    launch = NativeLauncher.__new__(NativeLauncher)
    launch.failed = launch.recovery_blocked = False
    launch.child = launch.nav2 = None
    launch.sim = SimpleNamespace(reason=None)
    class Blocked:
        def stop(self):
            raise RuntimeError('cgroup populated')
    launch.observer = Blocked()
    with pytest.raises(CleanupUnconfirmed) as error:
        asyncio.run(launch._close_world())
    assert error.value.code == 'SIM_CLEANUP_OBSERVER_UNPROVEN'
    assert launch.failed and launch.recovery_blocked and launch.observer is not None


def test_startup_absence_includes_observer(monkeypatch, tmp_path):
    monkeypatch.setattr(preflight, 'ROOT', tmp_path)
    monkeypatch.setattr(preflight, 'isolation_preflight', lambda *_: {})
    commands = []
    def run(args, **kwargs):
        commands.append(args)
        return SimpleNamespace(stdout='fh-simmgr-observer-old.service loaded active running')
    monkeypatch.setattr(preflight.subprocess, 'run', run)
    with pytest.raises(RuntimeError, match='units remain'):
        preflight.startup_preflight(True)
    assert 'fh-simmgr-observer-*.service' in commands[0]


@pytest.fixture
def owned_observer(monkeypatch, tmp_path):
    unit = {'LoadState': 'not-found'}
    commands = []
    def run(args, **kwargs):
        commands.append(args)
        if args[:3] == ['systemctl', '--user', 'show']:
            return SimpleNamespace(stdout='\n'.join(k+'='+v for k, v in unit.items()))
        if args[0] == 'systemd-run':
            unit.update(LoadState='loaded', ActiveState='active', MainPID='123',
                        ControlGroup='/synthetic-observer', InvocationID='owned')
        if args[:3] == ['systemctl', '--user', 'stop']:
            unit.update(ActiveState='inactive', MainPID='0')
        return SimpleNamespace(stdout='')
    monkeypatch.setattr(observer_unit.subprocess, 'run', run)
    monkeypatch.setenv('XDG_RUNTIME_DIR', '/run/user/7000')
    monkeypatch.setattr(observer_unit.os, 'getuid', lambda: 7000)
    original = Path.stat
    def stat(path, *args, **kwargs):
        if str(path) == '/run/user/7000':
            return SimpleNamespace(st_uid=7000, st_mode=0o40700)
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'stat', stat)
    child = observer_unit.ObserverUnit(tmp_path, settings(), tmp_path,
        dict(ros_domain='93', partition='fh-srv-aaaaaaaaaaaa'), str(uuid4()), str(uuid4()))
    return child, unit, commands


def test_observer_unit_bounds_and_owned_cleanup(owned_observer):
    child, unit, commands = owned_observer
    config = json.loads(child.private.read_text())
    assert child.private.stat().st_mode & 0o777 == 0o600
    assert config['env']['ROS_DOMAIN_ID'] == '93'
    assert config['env']['GZ_PARTITION'] == 'fh-srv-aaaaaaaaaaaa'
    assert len(child.socket_path.encode()) < 108
    child.start()
    args = next(a for a in commands if a[0] == 'systemd-run')
    for prop in ('MemoryMax=256M', 'MemorySwapMax=0', 'CPUQuota=50%', 'KillMode=control-group', 'RuntimeMaxSec=1890'):
        assert '--property='+prop in args
    child.stop()
    assert json.loads((child.folder/'observer-cleanup.json').read_text())['complete']
    assert not child.private.exists()


@pytest.mark.parametrize('cause', ['replacement', 'survivor'])
def test_observer_unit_refuses_replacement_or_populated_cgroup(owned_observer, monkeypatch, cause):
    child, unit, commands = owned_observer
    child.start()
    if cause == 'replacement':
        unit['InvocationID'] = 'replacement'
    else:
        original = Path.read_text
        def text(path, *args, **kwargs):
            if str(path) == '/sys/fs/cgroup/synthetic-observer/cgroup.events':
                return 'populated 1\n'
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, 'read_text', text)
    before = len(commands)
    with pytest.raises(RuntimeError):
        child.stop()
    assert not (child.folder/'observer-cleanup.json').exists()
    if cause == 'replacement':
        assert not any('stop' in a for a in commands[before:])


def test_images_latest_bounded_stale_order_and_epoch(policy, monkeypatch):
    from apps.simmgr import observer_entry as entry
    observer, _, clock = policy
    monkeypatch.setattr(entry.time, 'monotonic', lambda: clock[0])
    images = entry.Images()
    def image(stamp, **changes):
        obj = SimpleNamespace(width=320, height=240, step=960, pixel_format_type=3,
            data=b'x'*230400, HasField=lambda _: True,
            header=SimpleNamespace(HasField=lambda _: True, stamp=SimpleNamespace(sec=stamp, nsec=0)))
        obj.__dict__.update(changes)
        return obj
    images.put(image(1, width=640), 3)
    assert images.pending is None
    images.put(image(1), 3)
    latest = image(2)
    images.put(latest, 3)
    assert images.take(observer, 2) is latest
    clock[0] += .21
    images.put(image(1), 3)
    assert images.take(observer, 2) is None
    images.put(image(3), 3)
    assert images.take(observer, 2) is None
    images.clear()
    images.put(image(1), 3)
    assert images.take(observer, 1) is not None


def test_discard_lost_ack_does_not_discard_newer_view(policy):
    observer, body, _ = policy
    observer.submit(body)
    observer.submit(dict(body, seq=1))
    observer.discard(body)
    assert observer.pending is not None
    observer.discard(dict(body, seq=1))
    assert observer.pending is None


def test_relay_is_bounded_and_disconnect_discards_pending(policy, tmp_path):
    from apps.contracts.models import ExternalCameraViewRequest
    _, body, _ = policy
    async def exercise():
        path = str(tmp_path/'ipc')
        commands = []
        pending = asyncio.Event()
        release = asyncio.Event()
        async def serve(reader, writer):
            try:
                data = json.loads(await reader.readline())
                commands.append(data['op'])
                if data['op'] == 'view':
                    pending.set()
                    await release.wait()
                else:
                    writer.write(b'{"accepted":true}\n')
                    await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
        server = await asyncio.start_unix_server(serve, path=path)
        launch = NativeLauncher.__new__(NativeLauncher)
        launch.sim = None
        launch.failed = launch.observer_busy = False
        launch._watching = True
        launch.observer = SimpleNamespace(socket_path=path)
        request = ExternalCameraViewRequest.model_validate(body)
        task = asyncio.create_task(launch.external_view(request, 'view'))
        try:
            await asyncio.wait_for(pending.wait(), 1)
            with pytest.raises(ValueError, match='busy'):
                await launch.external_view(request, 'view')
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert commands == ['view', 'discard'] and not launch.observer_busy
        finally:
            release.set()
            server.close()
            await server.wait_closed()
            await asyncio.sleep(0)
    asyncio.run(exercise())

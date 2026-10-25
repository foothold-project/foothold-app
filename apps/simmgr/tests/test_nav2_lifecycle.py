"""Synthetic child/unit/resource evidence only; no ROS imports or real units."""
import asyncio
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
from types import SimpleNamespace

import pytest

from apps.simmgr import launcher, nav2_entry, nav2_unit, preflight
from apps.simmgr.launcher import CleanupUnconfirmed, NativeLauncher
from apps.simmgr.nav2_unit import Nav2Unit
from apps.simmgr.run_environment import map_assets, outbox_path, scenario_origin
from test_episode_reuse import native_episode
from test_failed_agent_cleanup import failed_episode
from test_manager import settings
from test_native_catalogue import catalogue
from test_repo_worlds import repo
from test_review_environment import isolation


@pytest.fixture
def owned_nav2(tmp_path, monkeypatch):
    state = SimpleNamespace(unit={'LoadState': 'not-found'}, commands=[])
    def run(args, **kwargs):
        state.commands.append((args, kwargs))
        if args[:3] == ['systemctl', '--user', 'show']:
            return SimpleNamespace(stdout='\n'.join(k + '=' + v for k, v in state.unit.items()))
        if args[0] == 'systemd-run':
            state.unit = dict(LoadState='loaded', ActiveState='active', Result='success',
                              MainPID='123', ControlGroup='', InvocationID='owned-invocation')
        if args[:3] == ['systemctl', '--user', 'stop']:
            state.unit.update(MainPID='0', ActiveState='inactive')
        return SimpleNamespace(stdout='')
    monkeypatch.setattr(nav2_unit.subprocess, 'run', run)
    child = Nav2Unit(tmp_path, settings(), Path('/synthetic'),
                     dict(ros_domain='93', partition='fh-srv-aaaaaaaaaaaa'))
    return child, state


def test_nav2_unit_bounds_environment_and_cleanup(owned_nav2):
    child, state = owned_nav2
    assert child.private.stat().st_mode & 0o777 == 0o600
    child.start()
    args, kwargs = next(c for c in state.commands if c[0][0] == 'systemd-run')
    for prop in ('MemoryMax=768M', 'CPUQuota=150%', 'MemorySwapMax=0',
                 'KillMode=control-group', 'RuntimeMaxSec=1890'):
        assert '--property=' + prop in args
    assert args[args.index('/usr/bin/env') + 1] == '-i'
    assert not any(k.startswith(('ROS_', 'FOOTHOLD_')) for k in kwargs['env'])
    env = json.loads(child.private.read_text())['env']
    assert env['ROS_DOMAIN_ID'] == '93' and env['ROS_LOCALHOST_ONLY'] == '1'
    assert env['GZ_PARTITION'] == 'fh-srv-aaaaaaaaaaaa' and env['GZ_IP'] == '127.0.0.1'
    record = json.loads((child.folder / 'nav2-unit.json').read_text())
    assert record['memory_mib'] is record['cpu_percent'] is None
    child.stop()
    assert json.loads((child.folder / 'nav2-cleanup.json').read_text())['complete'] is True
    assert not child.private.exists()
    assert [c[0] for c in state.commands if 'stop' in c[0]] == [
        ['systemctl', '--user', 'stop', child.unit]]


def test_nav2_replacement_invocation_never_signalled(owned_nav2):
    child, state = owned_nav2
    child.start()
    state.unit['InvocationID'] = 'replacement'
    before = len(state.commands)
    with pytest.raises(RuntimeError, match='identity changed'):
        child.stop()
    assert all('stop' not in args for args, _ in state.commands[before:])


@pytest.mark.parametrize('failure', ['rejected', 'timeout'])
def test_nav2_absent_after_failed_creation_only_rejection_allows_world_cleanup(
        native_episode, monkeypatch, failure):
    cfg, state = native_episode
    original_run = nav2_unit.subprocess.run
    commands = []
    def run(args, **kwargs):
        if (args[:3] != ['systemctl', '--user', 'list-units']
                and any('fh-simmgr-nav2-' in arg for arg in args)):
            commands.append(args)
            if args[:3] == ['systemctl', '--user', 'show']:
                return SimpleNamespace(stdout='LoadState=not-found\nInvocationID=\n')
            if args[0] == 'systemd-run':
                if failure == 'rejected':
                    raise subprocess.CalledProcessError(1, args)
                raise subprocess.TimeoutExpired(args, 10)
            pytest.fail('absent or ambiguous unit must not be signalled')
        return original_run(args, **kwargs)
    monkeypatch.setattr(nav2_unit.subprocess, 'run', run)
    monkeypatch.setattr(launcher, 'Nav2Unit', Nav2Unit)
    async def exercise():
        launch = NativeLauncher(cfg)
        await launch.start_world(cfg.worlds['v5_single/f1'])
        async def verified():
            assert launch.nav2 is launch.child is None
            launch.sim.close()
        monkeypatch.setattr(launch, '_close_verified_native', verified)
        folder = launch.folder
        expected = subprocess.CalledProcessError if failure == 'rejected' else CleanupUnconfirmed
        with pytest.raises(expected):
            await launch.add(next(iter(cfg.slots.values())), {'agent_token': 'x' * 32})
        assert launch.failed and launch.child is None
        if failure == 'rejected':
            assert launch.nav2 is launch.sim is None
            assert launch.recovery_complete and not launch.recovery_blocked
            assert not (folder / 'nav2-env.json').exists()
            assert state.events[-1] == 'world_close'
        else:
            assert launch.nav2 is not None and launch.sim is not None
            assert launch.recovery_blocked and not launch.recovery_complete
            with pytest.raises(RuntimeError, match='identity changed'):
                launch.nav2.stop()
            assert 'world_close' not in state.events
        assert sum(args[0] == 'systemd-run' for args in commands) == 1
    asyncio.run(exercise())


def test_nav2_cleanup_requires_empty_original_cgroup(owned_nav2, monkeypatch):
    child, state = owned_nav2
    child.start()
    state.unit['ControlGroup'] = '/synthetic-owned-nav2'
    read = Path.read_text
    def text(path, *args, **kwargs):
        if str(path) == '/sys/fs/cgroup/synthetic-owned-nav2/cgroup.events':
            return 'populated 1\n'
        return read(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'read_text', text)
    with pytest.raises(RuntimeError, match='remains populated'):
        child.stop()
    assert not (child.folder / 'nav2-cleanup.json').exists()


def test_nav2_name_collision_and_invalid_partition_refuse_before_create(owned_nav2):
    child, state = owned_nav2
    child.start()
    before = len(state.commands)
    with pytest.raises(RuntimeError, match='already exists'):
        Nav2Unit(child.folder, settings(), Path('/synthetic'),
                 dict(ros_domain='93', partition='fh-srv-aaaaaaaaaaaa'))
    with pytest.raises(ValueError, match='domain/partition'):
        Nav2Unit(child.folder, settings(), Path('/synthetic'),
                 dict(ros_domain='61', partition='operating'))
    assert not any(args[0] == 'systemd-run' for args, _ in state.commands[before:])


def test_nav2_bootstrap_unlinks_private_config_without_importing_ros(tmp_path, monkeypatch):
    private = tmp_path / 'private.json'
    env = dict(ROS_DOMAIN_ID='93', GZ_PARTITION='fh-srv-aaaaaaaaaaaa')
    private.write_text(json.dumps(dict(setup='/synthetic/setup', root='/synthetic', env=env)))
    monkeypatch.setattr(nav2_entry.sys, 'argv', ['entry', str(private)])
    calls = []
    monkeypatch.setattr(nav2_entry.os, 'execve', lambda *args: calls.append(args))
    nav2_entry.main()
    assert not private.exists() and calls[0][2] == env
    # Any one lifecycle process exit shuts down the rest of the launch.
    assert 'OnProcessExit' in calls[0][1][-2] and 'Shutdown' in calls[0][1][-2]


@pytest.mark.parametrize('memory,load', [(2999, 0), (3000, 7.01), (3000, 7)])
def test_sixty_second_resource_envelope(tmp_path, monkeypatch, memory, load):
    clock = [0.]
    monkeypatch.setattr(preflight.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(preflight.time, 'sleep', lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    monkeypatch.setattr(isolation, 'resources', lambda: dict(mem_available_mib=memory, load1=load))
    if memory < 3000 or load > 7:
        with pytest.raises(preflight.ResourceGateError):
            preflight.wait_resource_gate(tmp_path)
        assert clock[0] == 0
    else:
        preflight.wait_resource_gate(tmp_path)
        assert clock[0] == 60
        assert len((tmp_path / 'resource-gate.jsonl').read_text().splitlines()) == 61


def test_resource_dip_at_end_refuses_without_new_attempt(tmp_path, monkeypatch):
    clock = [0.]
    monkeypatch.setattr(preflight.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(preflight.time, 'sleep', lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    monkeypatch.setattr(isolation, 'resources', lambda: dict(
        mem_available_mib=2999 if clock[0] == 60 else 4000, load1=1))
    with pytest.raises(preflight.ResourceGateError):
        preflight.wait_resource_gate(tmp_path)
    assert clock[0] == 60


def test_outbox_survives_episode_delete_and_manager_restart(tmp_path):
    cfg = replace(settings(), run_dir=str(tmp_path))
    slot = next(iter(cfg.slots.values()))
    episode = tmp_path / 'episode'; episode.mkdir()
    path = Path(outbox_path(cfg, slot))
    assert path.stat().st_mode & 0o777 == 0o600 and not path.is_relative_to(episode)
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE pending (body TEXT)')
        db.execute("INSERT INTO pending VALUES ('durable report')")
    shutil.rmtree(episode)
    restarted = replace(cfg)
    assert Path(outbox_path(restarted, slot)) == path
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT body FROM pending').fetchall() == [('durable report',)]
    assert Path(outbox_path(cfg, list(cfg.slots.values())[1])) != path


@pytest.mark.parametrize('unsafe', ['symlink', 'public_file', 'public_dir'])
def test_outbox_refuses_unsafe_path(tmp_path, unsafe):
    cfg = replace(settings(), run_dir=str(tmp_path))
    slot = next(iter(cfg.slots.values()))
    path = Path(outbox_path(cfg, slot))
    if unsafe == 'symlink':
        path.unlink(); path.symlink_to(tmp_path / 'outside.sqlite3')
    if unsafe == 'public_file': path.chmod(0o644)
    if unsafe == 'public_dir': path.parent.chmod(0o755)
    with pytest.raises((OSError, ValueError)):
        outbox_path(cfg, slot)


@pytest.mark.parametrize('origin', ['http://127.0.0.1:9431/api/v1', 'http://u:p@localhost',
                                   'http://localhost/', 'http://localhost?query', 'ws://localhost'])
def test_origin_rejects_paths_credentials_and_non_http(origin):
    with pytest.raises(ValueError, match='path-free'):
        replace(settings(), scenario_data_origin=origin)


@pytest.mark.parametrize('origin,accepted', [
    ('http://localhost:9431', False), ('http://192.0.2.1:9431', False),
    ('http://127.0.0.2:9431', False), ('http://[::2]:9431', False),
    ('http://127.0.0.1:9431', True), ('http://[::1]:9431', True),
    ('https://example.invalid', True),
])
def test_scenario_http_origin_matches_agent_loopback_policy(origin, accepted):
    if accepted:
        assert scenario_origin(replace(settings(), scenario_data_origin=origin)) == origin
    else:
        with pytest.raises(ValueError, match='loopback'):
            replace(settings(), scenario_data_origin=origin)


def test_warehouse_map_copy_preserves_pixels_origin_and_registered_hashes(repo, catalogue, tmp_path):
    from apps.simmgr.native_catalogue import resolve_native_world
    from apps.server.fh_server.map_files import gray_pixels, map_yaml
    _, _, world = repo
    native = resolve_native_world(world, {world.id: world}, catalogue[0])
    result = json.loads(map_assets(native, world.map_bindings, tmp_path))
    item = result[0]; binding = world.map_bindings[0]
    assert item['map_version_id'] == binding['map_version_id']
    png, pgm = Path(item['image_path']).read_bytes(), Path(item['pgm_path']).read_bytes()
    width, height, pixels = gray_pixels(png)
    assert (width, height) == (300, 440)
    assert pgm == b'P5\n300 440\n255\n' + pixels
    assert {0, 205, 254} <= set(pixels)
    assert hashlib.sha256(pgm).hexdigest() == binding['source_pgm_sha256']
    metadata = map_yaml(Path(item['pgm_path']).with_suffix('.yaml').read_bytes())
    assert metadata['origin'] == [-7.5, -11., 0.] and metadata['resolution'] == .05


@pytest.mark.parametrize('field,value', [('origin', [0, 0, 0]), ('source_pgm_sha256', '0' * 64)])
def test_map_evidence_mismatch_refuses(repo, catalogue, tmp_path, field, value):
    from apps.simmgr.native_catalogue import resolve_native_world
    _, _, world = repo
    native = resolve_native_world(world, {world.id: world}, catalogue[0])
    binding = {**world.map_bindings[0], field: value}
    with pytest.raises(ValueError, match='registered raster'):
        map_assets(native, [binding], tmp_path)


def test_child_environment_and_world_then_nav2_then_agent_order(native_episode, monkeypatch):
    cfg, state = native_episode
    cfg = replace(cfg, arrival_pose_max_age_s=.75, scenario_data_origin='http://127.0.0.1:9431')
    slot = next(iter(cfg.slots.values()))
    class Nav2:
        def __init__(self, folder, settings, root, identity):
            assert state.events[-1] == 'world_start'
            assert identity['partition'] == 'fh-srv-aaaaaaaaaaaa'
        def start(self): state.events.append('nav2_start')
        def poll(self): return None
        def stop(self): state.events.append('nav2_stop')
    monkeypatch.setattr(launcher, 'Nav2Unit', Nav2)
    async def run():
        launch = NativeLauncher(cfg)
        await launch.start_world(cfg.worlds['v5_single/f1'])
        assert 'nav2_start' not in state.events
        await launch.add(slot, {'agent_token': 'x' * 32})
        env = json.loads((launch.folder / 'agent-env.json').read_text())['env']
        assert env['FOOTHOLD_SCENARIO_DATA_ORIGIN'] == scenario_origin(cfg)
        assert env['FH_RUN_ARRIVAL_POSE_MAX_AGE_S'] == '0.75'
        assert json.loads(env['FOOTHOLD_RUN_MAP_ASSETS_JSON']) == []
        assert env['GZ_PARTITION'] == 'fh-srv-aaaaaaaaaaaa'
        assert Path(env['FOOTHOLD_RUN_OUTBOX_PATH']).stat().st_mode & 0o777 == 0o600
        await launch.stop_agent(slot)
        await launch.close_world()
        assert state.events.index('agent_exit0') < state.events.index('nav2_stop') < state.events.index('world_close')
        await launch.watch_task
    asyncio.run(run())


@pytest.mark.parametrize('dead', ['agent', 'nav2', 'world'])
def test_child_exit_autonomously_cleans_peers_and_retains_failure(dead, native_episode, monkeypatch):
    cfg, state = native_episode
    async def run():
        launch = NativeLauncher(cfg)
        await launch.start_world(cfg.worlds['v5_single/f1'])
        await launch.add(next(iter(cfg.slots.values())), {'agent_token': 'x' * 32})
        if dead == 'agent': state.units[launch.child.unit] = 0
        if dead == 'nav2': launch.nav2.code = 1
        if dead == 'world': launch.sim.reason = 'unit_exited'
        # The synthetic native supervisor has no manifests; independently prove
        # this watcher requests the existing verified close path, in order.
        async def verified():
            assert launch.child is launch.nav2 is None
            state.events.append('verified_world_close')
        monkeypatch.setattr(launch, '_close_verified_native', verified)
        await asyncio.wait_for(launch.watch_task, 2)
        assert launch.child is launch.nav2 is launch.sim is None
        assert launch.failed and launch.recovery_complete and not launch.recovery_blocked
        assert 'verified_world_close' in state.events
        await launch.close_world()  # explicit owner cleanup acknowledgement permits reuse
        assert not launch.failed
    asyncio.run(run())


def test_nav2_cleanup_failure_retains_latch_and_world(native_episode):
    cfg, state = native_episode
    async def run():
        launch = NativeLauncher(cfg)
        await launch.start_world(cfg.worlds['v5_single/f1'])
        await launch.add(next(iter(cfg.slots.values())), {'agent_token': 'x' * 32})
        child = launch.nav2
        def failed(): raise RuntimeError('synthetic remaining cgroup')
        child.stop = failed
        with pytest.raises(CleanupUnconfirmed, match='NAV2_UNPROVEN'):
            await launch.stop_agent(None)
        assert launch.failed and launch.recovery_blocked and launch.nav2 is child and launch.sim
        assert 'world_close' not in state.events
        await launch.watch_task
    asyncio.run(run())


def test_failed_agent_stops_nav2_before_verified_native_cleanup(failed_episode):
    cfg, state, launch, prepare = failed_episode
    prepare()
    launch.nav2 = SimpleNamespace(stop=lambda: state.events.append('nav2_stop'))
    asyncio.run(launch.stop_agent(None))
    assert state.events == ['nav2_stop', 'native_sigint', 'agent_reaped']
    assert launch.nav2 is launch.sim is launch.child is None


@pytest.mark.parametrize('phase', ['nav2', 'agent'])
def test_startup_failure_also_cleans_peers(native_episode, monkeypatch, phase):
    cfg, state = native_episode
    class Nav2:
        def __init__(self, *args): pass
        def start(self):
            state.events.append('nav2_start')
            if phase == 'nav2': raise RuntimeError('synthetic startup failed')
        def stop(self): state.events.append('nav2_stop')
    monkeypatch.setattr(launcher, 'Nav2Unit', Nav2)
    def failed(*args): raise RuntimeError('synthetic startup failed')
    monkeypatch.setattr(launcher, 'AgentUnit', failed)
    async def run():
        launch = NativeLauncher(cfg)
        await launch.start_world(cfg.worlds['v5_single/f1'])
        async def verified():
            assert launch.nav2 is launch.child is None
            state.events.append('verified_world_close')
        monkeypatch.setattr(launch, '_close_verified_native', verified)
        with pytest.raises(RuntimeError, match='synthetic startup failed'):
            await launch.add(next(iter(cfg.slots.values())), {'agent_token': 'x' * 32})
        assert state.events[-2:] == ['nav2_stop', 'verified_world_close']
        assert launch.failed and launch.recovery_complete and launch.sim is None
    asyncio.run(run())


@pytest.mark.parametrize('phase', ['agent', 'nav2'])
def test_readiness_poll_error_also_requests_cleanup_and_retains_latch(
        native_episode, monkeypatch, phase):
    cfg, state = native_episode
    def unavailable(*args):
        raise RuntimeError('synthetic user bus unavailable')
    class Nav2:
        def __init__(self, *args): pass
        def start(self): pass
        def poll(self):
            if phase == 'nav2': unavailable()
            return None
        def stop(self): state.events.append('nav2_stop')
    monkeypatch.setattr(launcher, 'Nav2Unit', Nav2)
    if phase == 'agent':
        monkeypatch.setattr(launcher.AgentUnit, 'poll', unavailable)
    async def exercise():
        launch = NativeLauncher(cfg)
        await launch.start_world(cfg.worlds['v5_single/f1'])
        original_cleanup = launch._cleanup_failed_start
        async def cleanup(slot):
            assert launch.failed
            state.events.append('startup_cleanup')
            await original_cleanup(slot)
        async def verified():
            assert launch.nav2 is launch.child is None
            state.events.append('verified_world_close')
        monkeypatch.setattr(launch, '_cleanup_failed_start', cleanup)
        monkeypatch.setattr(launch, '_close_verified_native', verified)
        with pytest.raises(RuntimeError, match='status unavailable|user bus unavailable'):
            await launch.add(next(iter(cfg.slots.values())), {'agent_token': 'x' * 32})
        assert state.events.count('startup_cleanup') == 1
        assert state.events.index('startup_cleanup') < state.events.index('nav2_stop')
        assert launch.failed and not launch._watching and launch.watch_task is None
        if phase == 'agent':
            assert launch.recovery_blocked and launch.child and launch.sim
        else:
            assert launch.recovery_complete and launch.sim is None
            assert state.events[-1] == 'verified_world_close'
    asyncio.run(exercise())

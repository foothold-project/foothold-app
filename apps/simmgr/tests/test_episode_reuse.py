"""Repeated episodes with real lifecycle code and synthetic OS/supervisor only."""
import asyncio
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import signal
import subprocess
import sys
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.simmgr import agent_unit, launcher, preflight
from apps.simmgr.agent_unit import AgentUnit
from apps.simmgr.api import create_app
from apps.simmgr.config import World
from apps.simmgr.launcher import FakeLauncher, NativeLauncher
from apps.simmgr.service import Manager, SimError
from test_manager import settings
from test_review_environment import isolation


@pytest.fixture
def native_episode(tmp_path, monkeypatch):
    monkeypatch.setenv('FH_SIM_RUN', '1')
    monkeypatch.setattr(launcher, 'ROOT', tmp_path)
    monkeypatch.setattr(preflight, 'ROOT', tmp_path)
    monkeypatch.setattr(launcher, 'load_keys', lambda path: {})
    monkeypatch.setitem(sys.modules, 'constants', SimpleNamespace(MAP_DIRECTORY='maps'))
    source = tmp_path / 'experiment/spec/stage/source'
    source.mkdir(parents=True)
    maps = source.parent.parent.parent / 'maps'
    maps.mkdir()
    world = maps / 'world.sdf'; world.write_text('synthetic')
    mapfile = maps / 'map.pgm'; mapfile.write_text('synthetic')
    (maps / 'worlds.json').write_text(json.dumps({'worlds': {
        'v5_single/f1': {'world': 'world.sdf', 'gt_map': 'map.pgm'}}}))
    cfg = replace(settings(), real=True, source=str(source), ros_setup='unused',
                  run_dir=str(tmp_path / 'runs/reuse'),
                  worlds={'v5_single/f1': World('v5_single/f1', world, mapfile)})
    state = SimpleNamespace(events=[], units={}, sims=[], remaining='', memory=8000,
                            rows=[], ports=[], close_error=None, close_reason=None)
    monkeypatch.setattr(isolation, 'processes', lambda: (state.rows, 0))
    monkeypatch.setattr(isolation, 'dds_ports', lambda: (state.ports, ''))
    monkeypatch.setattr(isolation, 'resources', lambda: dict(mem_available_mib=state.memory, load1=0))
    monkeypatch.setattr(isolation, 'command', lambda *args: '')
    original = isolation.preflight
    def gate(folder):
        state.events.append('preflight')
        return original(folder)
    monkeypatch.setattr(isolation, 'preflight', gate)

    def run(args, **kwargs):
        if args[:3] == ['systemctl', '--user', 'list-units']:
            state.events.append('units')
            return SimpleNamespace(stdout=state.remaining)
        if args[:3] == ['systemctl', '--user', 'show']:
            code = state.units.get(args[3], 'absent')
            value = ('LoadState=not-found\n' if code == 'absent' else
                     'LoadState=loaded\nActiveState=active\nResult=success\n' +
                     ('ExecMainCode=0\n' if code is None else 'ExecMainCode=1\nExecMainStatus=0\n'))
            return SimpleNamespace(stdout=value)
        if args[0] == 'systemd-run':
            unit = next(arg.split('=', 1)[1] for arg in args if arg.startswith('--unit='))
            state.events.append(('agent', unit))
            state.units[unit] = None
        elif args[:3] == ['systemctl', '--user', 'kill']:
            state.events.append('agent_sigint')
            assert '--signal=SIGINT' in args
            state.units[args[-1]] = 0
        elif args[:3] == ['systemctl', '--user', 'stop']:
            state.events.append('agent_exit0')
            del state.units[args[-1]]
        else:
            pytest.fail(f'unexpected OS call: {args}')
        return SimpleNamespace(stdout='')
    monkeypatch.setattr(agent_unit.subprocess, 'run', run)

    class Sim:
        reason = None
        started = False
        def __init__(self, folder, source, setup, launch_env):
            self.folder, self.source = folder, source
            assert launch_env['ROS_DOMAIN_ID'] == '93'
            state.sims.append(self)
        def start(self):
            isolation.preflight(self.folder)
            self.started = True
            state.events.append('world_start')
        def live_identity(self):
            return {'partition': 'synthetic'}
        def close(self):
            state.events.append('world_close')
            if state.close_error:
                raise RuntimeError(state.close_error)
            self.reason = state.close_reason
    monkeypatch.setattr(isolation, 'Simulation', Sim)

    class Writer:
        def close(self): pass
        async def wait_closed(self): pass
    async def connection(*args): return None, Writer()
    monkeypatch.setattr(asyncio, 'open_connection', connection)
    return cfg, state


@pytest.mark.parametrize('native', [False, True])
def test_delete_then_post_same_manager_preserves_generation(native_episode, native):
    cfg, state = native_episode
    if not native:
        cfg = replace(cfg, real=False)
    launch = NativeLauncher(cfg) if native else FakeLauncher()
    app = create_app(cfg, launch)
    slot = next(iter(cfg.slots.values()))
    body = dict(world_id='v5_single/f1', robot_id=slot.robot_id, org_id=slot.org_id,
                owner_id=str(uuid4()), agent_token='x' * 32, generation=1)
    headers = {'Authorization': 'Bearer ' + cfg.secret}
    with TestClient(app, client=('127.0.0.1', 9428)) as client:
        for generation in (1, 2):
            body['generation'] = generation
            response = client.post('/v1/robots', json=body, headers=headers)
            assert response.status_code == 200, response.text
            assert response.json()['state'] == ('RUNNING' if native else 'PREPARED')
            assert client.request('DELETE', '/v1/robots/' + slot.robot_id,
                                  json={'generation': generation}, headers=headers).status_code == 200
            # Late POSTs still cannot resurrect the just-deleted generation.
            response = client.post('/v1/robots', json=body, headers=headers)
            assert response.status_code == 409
            assert response.json()['error']['code'] == 'SIM_GENERATION_STALE'
            if native:
                assert not launch.failed and launch.sim is launch.child is launch.folder is None
    if native:
        assert len(state.sims) == 2
        folders = [sim.folder for sim in state.sims]
        assert folders[0] != folders[1]
        assert all(folder.parent == Path(cfg.run_dir) and folder.stat().st_mode & 0o777 == 0o700
                   for folder in folders)
        units = [event[1] for event in state.events if isinstance(event, tuple)]
        assert units == ['fh-simmgr-agent-' + folder.name + '.service' for folder in folders]
        assert len(set(units)) == 2
        assert state.events == ['preflight', 'units', 'preflight', 'world_start',
                                ('agent', units[0]), 'agent_sigint', 'agent_exit0', 'world_close',
                                'preflight', 'units', 'preflight', 'world_start',
                                ('agent', units[1]), 'agent_sigint', 'agent_exit0', 'world_close']


@pytest.mark.parametrize('blocker', ['memory', 'domain93', 'dds', 'unit'])
def test_second_episode_rechecks_all_preflight_gates(native_episode, blocker):
    cfg, state = native_episode
    launch = NativeLauncher(cfg); mgr = Manager(cfg, launch)
    slot = next(iter(cfg.slots.values())); owner = str(uuid4())
    async def run():
        await mgr.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'x' * 32, 1)
        await mgr.remove(slot.robot_id, 1)
        if blocker == 'memory': state.memory = 2499
        if blocker == 'domain93': state.rows = [dict(pid=123, ppid=1, domain='93')]
        if blocker == 'dds': state.ports = [30650]
        if blocker == 'unit': state.remaining = 'fh-simmgr-agent-old.service'
        with pytest.raises(RuntimeError):
            await mgr.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'x' * 32, 2)
        assert state.events.count('world_start') == 1
        assert state.events.count('preflight') == 3
    asyncio.run(run())


@pytest.mark.parametrize('failure', ['cleanup', 'identity', 'forced', 'watcher', 'watcher_during_close'])
def test_failed_episode_never_reopens_even_after_cleanup(native_episode, monkeypatch, failure):
    cfg, state = native_episode
    launch = NativeLauncher(cfg); mgr = Manager(cfg, launch)
    slot = next(iter(cfg.slots.values())); owner = str(uuid4())
    async def run():
        await mgr.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'x' * 32, 1)
        sim, folder = launch.sim, launch.folder
        if failure in ('cleanup', 'identity'): state.close_error = failure + ' unconfirmed'
        if failure == 'watcher': sim.reason = 'watcher_error:RuntimeError'
        if failure == 'watcher_during_close': state.close_reason = 'watcher_error:RuntimeError'
        if failure == 'forced':
            def wait(self, timeout):
                if timeout == 15: raise subprocess.TimeoutExpired('synthetic', timeout)
                return 0  # even a later exit0 cannot confirm STOP/zero after force
            monkeypatch.setattr(AgentUnit, 'wait', wait)
            def send(self, sig):
                if sig == signal.SIGTERM: state.units[self.unit] = 0
            monkeypatch.setattr(AgentUnit, 'send_signal', send)
        with pytest.raises(RuntimeError): await mgr.remove(slot.robot_id, 1)
        assert launch.failed and launch.sim is sim and launch.folder == folder
        assert mgr.robots[slot.robot_id].state == 'ERROR'
        state.close_error = state.close_reason = None
        sim.reason = None
        with pytest.raises(RuntimeError): await launch.close_world()
        for generation in (2, 3):
            with pytest.raises(SimError) as error:
                await mgr.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'x' * 32, generation)
            assert error.value.code == 'SIM_UNAVAILABLE' and error.value.status == 503
        assert state.events.count('world_start') == 1
    asyncio.run(run())


def test_normal_cleanup_unit_exit_observation_allows_reuse(native_episode):
    cfg, state = native_episode
    state.close_reason = 'unit_exited'
    launch = NativeLauncher(cfg)
    async def run():
        for _ in range(2):
            await launch.start_world(cfg.worlds['v5_single/f1'])
            await launch.close_world()
            assert not launch.failed and launch.folder is None
    asyncio.run(run())


def test_existing_episode_directory_is_never_adopted(native_episode, monkeypatch):
    cfg, state = native_episode
    fixed = datetime(2026, 1, 1, tzinfo=timezone.utc)
    monkeypatch.setattr(launcher, 'datetime', SimpleNamespace(now=lambda tz: fixed))
    base = Path(cfg.run_dir); base.mkdir(parents=True)
    folder = base / '20260101T000000000000Z-000001'; folder.mkdir()
    sentinel = folder / 'evidence'; sentinel.write_text('keep')
    launch = NativeLauncher(cfg)
    with pytest.raises(FileExistsError):
        asyncio.run(launch.start_world(cfg.worlds['v5_single/f1']))
    assert not state.events and sentinel.read_text() == 'keep'


def test_agent_literal_name_collision_is_rejected(native_episode):
    cfg, state = native_episode
    folder = Path(cfg.run_dir) / '20260101T000000000000Z-000001'
    folder.mkdir(parents=True)
    unit = 'fh-simmgr-agent-' + folder.name + '.service'
    state.units[unit] = None
    with pytest.raises(RuntimeError, match='already exists'):
        AgentUnit(folder, cfg, {}, Path('/synthetic'))
    assert not (folder / 'agent-env.json').exists() and not state.events

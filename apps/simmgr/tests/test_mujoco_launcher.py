"""MujocoLauncher: a real child process per robot; RUNNING only after the agent says it reached the server.

The child here is a plain Python stand-in for ``python -m foothold_agent.mujoco_bridge``
(no Node, MuJoCo, server or robot). It follows the same readiness contract:
write its own pid to FH_SIM_READY_FILE after the server connection opens.
"""
import asyncio
from dataclasses import replace
import os
from pathlib import Path
import sys
import time
from uuid import uuid4

import pytest

from apps.simmgr.config import Settings, Slot, World
from apps.simmgr.launcher import FakeLauncher
from apps.simmgr.mujoco_launcher import MujocoLauncher
from apps.simmgr.service import Manager, SimError

FAKE_AGENT = r'''
import os, signal, subprocess, sys, time
mode, delay = sys.argv[1], float(sys.argv[2])
ready = os.environ['FH_SIM_READY_FILE']
assert os.environ['FOOTHOLD_AGENT_TOKEN'] and os.environ['FH_SIM_MAP']
if mode == 'stubborn':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
# Grandchild like the Node physics child; it must not outlive remove().
kid = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])
open(os.path.join(os.path.dirname(ready), 'grandchild.pid'), 'w').write(str(kid.pid))
time.sleep(delay)
if mode == 'die':
    sys.exit(3)
if mode in ('ready', 'stubborn', 'die_after'):
    tmp = ready + '.tmp'
    open(tmp, 'w').write(str(os.getpid()))
    os.replace(tmp, ready)
if mode == 'die_after':
    time.sleep(.3)
    sys.exit(4)
while True:
    time.sleep(.05)
'''


def settings(tmp_path):
    org = str(uuid4())
    slots = [Slot(str(uuid4()), org, '/private/key', '/private/replay-' + str(i), 9433 + i) for i in range(2)]
    return Settings({'collapsed-house-v2': World('collapsed-house-v2', Path('/private/a.sdf'), Path('/private/a.yaml'))},
                    {s.robot_id: s for s in slots}, 'x' * 32, run_dir=str(tmp_path / 'runs'),
                    local_backend='mujoco')


def launcher(tmp_path, mode, delay=0.0, **kw):
    script = tmp_path / 'fake_agent.py'
    script.write_text(FAKE_AGENT)
    cfg = settings(tmp_path)
    kw.setdefault('ready_timeout', 5)
    kw.setdefault('stop_timeout', 1)
    return cfg, MujocoLauncher(cfg, command=[sys.executable, str(script), mode, str(delay)],
                               env={'FH_SIM_SRC': str(tmp_path)}, **kw)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers kill(0); it is gone for our purpose once reaped or Z.
    try:
        return Path(f'/proc/{pid}/stat').read_text().split(')')[-1].split()[0] != 'Z'
    except OSError:
        return False


def wait_gone(pid, seconds=3):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if not alive(pid):
            return True
        time.sleep(.02)
    return False


def add(manager, cfg, owner=None):
    slot = next(iter(cfg.slots.values()))
    return slot, manager.add('collapsed-house-v2', slot.robot_id, owner or str(uuid4()), slot.org_id, 'x' * 32, 1)


def test_running_only_after_child_readiness(tmp_path):
    async def run():
        cfg, launch = launcher(tmp_path, 'ready', delay=.6)
        manager = Manager(cfg, launch)
        slot, pending = add(manager, cfg)
        task = asyncio.create_task(pending)
        await asyncio.sleep(.3)
        early = await manager.listing(slot.org_id)
        assert [r['state'] for r in early] == ['STARTING']
        pid = launch.children[slot.robot_id].pid
        assert alive(pid)
        started = time.monotonic()
        row = await task
        assert time.monotonic() - started >= .2
        assert row['state'] == 'RUNNING' and row['launcher'] == 'mujoco-local'
        assert [r['state'] for r in await manager.listing(slot.org_id)] == ['RUNNING']
        await manager.close()
    asyncio.run(run())


def test_child_exit_before_readiness_is_not_running(tmp_path):
    async def run():
        cfg, launch = launcher(tmp_path, 'die', delay=.2)
        manager = Manager(cfg, launch)
        slot, pending = add(manager, cfg)
        with pytest.raises(RuntimeError):
            await pending
        assert [r['state'] for r in await manager.listing(slot.org_id)] == ['ERROR']
    asyncio.run(run())


def test_child_death_after_running_leaves_running(tmp_path):
    async def run():
        cfg, launch = launcher(tmp_path, 'die_after')
        manager = Manager(cfg, launch)
        slot, pending = add(manager, cfg)
        assert (await pending)['state'] == 'RUNNING'
        await asyncio.sleep(.8)
        rows = await manager.listing(slot.org_id)
        assert [r['state'] for r in rows] == ['ERROR']
        # A dead child is cleaned and reaped; the slot is free again.
        assert await manager.remove(slot.robot_id, 1) is False
        assert await manager.listing(slot.org_id) == []
        await manager.close()
    asyncio.run(run())


def test_readiness_timeout_is_not_running_and_child_is_reaped(tmp_path):
    async def run():
        cfg, launch = launcher(tmp_path, 'never', ready_timeout=.5)
        manager = Manager(cfg, launch)
        slot, pending = add(manager, cfg)
        started = time.monotonic()
        with pytest.raises(RuntimeError):
            await pending
        assert time.monotonic() - started < 4
        assert [r['state'] for r in await manager.listing(slot.org_id)] == ['ERROR']
        grandchild = int((Path(cfg.run_dir) / slot.robot_id / 'grandchild.pid').read_text())
        assert wait_gone(grandchild)
        # Failed start: the owner's DELETE is the confirmed cleanup that frees the manager.
        assert await manager.remove(slot.robot_id, 1) is False
        with pytest.raises(SimError) as error:
            await manager.add('collapsed-house-v2', slot.robot_id, str(uuid4()), slot.org_id, 'x' * 32, 1)
        assert error.value.code == 'SIM_GENERATION_STALE'  # fenced generation, not SIM_UNAVAILABLE
    asyncio.run(run())


@pytest.mark.parametrize('mode', ['ready', 'stubborn'])
def test_remove_kills_child_and_grandchild_by_pid(tmp_path, mode):
    async def run():
        cfg, launch = launcher(tmp_path, mode, stop_timeout=.5)
        manager = Manager(cfg, launch)
        slot, pending = add(manager, cfg)
        assert (await pending)['state'] == 'RUNNING'
        pid = launch.children[slot.robot_id].pid
        grandchild = int((Path(cfg.run_dir) / slot.robot_id / 'grandchild.pid').read_text())
        assert alive(pid) and alive(grandchild)
        assert await manager.remove(slot.robot_id, 1) is False
        assert not alive(pid) and wait_gone(grandchild)
        assert slot.robot_id not in launch.children
        assert not (Path(cfg.run_dir) / slot.robot_id / 'ready').exists()
        await manager.close()
    asyncio.run(run())


def test_ready_file_from_another_pid_is_not_readiness(tmp_path):
    async def run():
        cfg, launch = launcher(tmp_path, 'never', ready_timeout=.6)
        slot = next(iter(cfg.slots.values()))
        folder = Path(cfg.run_dir) / slot.robot_id
        folder.mkdir(parents=True)
        (folder / 'ready').write_text('1')  # stale file: launcher must start fresh
        manager = Manager(cfg, launch)
        with pytest.raises(RuntimeError):
            await manager.add('collapsed-house-v2', slot.robot_id, str(uuid4()), slot.org_id, 'x' * 32, 1)
    asyncio.run(run())


def test_unknown_mujoco_map_is_rejected_before_any_process(tmp_path):
    async def run():
        cfg, launch = launcher(tmp_path, 'ready')
        # warehouse/f1 now maps to the MuJoCo 'warehouse' map; an id not in mobile/sim/maps.json is refused.
        cfg = replace(cfg, worlds={'nowhere/f1': World('nowhere/f1', Path('/p/a'), Path('/p/b'))})
        launch.settings = cfg
        manager = Manager(cfg, launch)
        slot = next(iter(cfg.slots.values()))
        with pytest.raises(SimError) as error:
            await manager.add('nowhere/f1', slot.robot_id, str(uuid4()), slot.org_id, 'x' * 32, 1)
        assert error.value.code == 'SIM_WORLD_INVALID' and launch.children == {}
    asyncio.run(run())


def test_fake_launcher_still_prepared(tmp_path):
    async def run():
        cfg = replace(settings(tmp_path), local_backend=None)
        manager = Manager(cfg)
        assert isinstance(manager.launcher, FakeLauncher)
        slot, pending = add(manager, cfg)
        row = await pending
        assert row['state'] == 'PREPARED' and row['launcher'] == 'fake'
    asyncio.run(run())


def test_settings_choose_mujoco_backend_and_reject_with_native(tmp_path, monkeypatch):
    monkeypatch.setenv('FH_SIM_SRC', str(tmp_path))
    cfg = settings(tmp_path)
    assert isinstance(Manager(cfg).launcher, MujocoLauncher)
    with pytest.raises(ValueError):
        replace(cfg, local_backend='gazebo')
    with pytest.raises(ValueError):
        replace(cfg, local_backend='mujoco', real=True, runtime_seconds=300, source='s', ros_setup='r')


def test_mujoco_map_name_drops_spawn_floor_and_uses_dashes():
    """Server catalog keys for connected worlds carry the spawn floor (plant_a/l1); mobile/sim maps.json uses plant-a."""
    from apps.simmgr.mujoco_launcher import mujoco_map
    assert mujoco_map('plant_a/l1') == 'plant-a'
    assert mujoco_map('plant_a') == 'plant-a'
    assert mujoco_map('collapsed-house-v2') == 'collapsed-house-v2'


def test_plant_a_server_map_bindings_reach_the_mujoco_agent(tmp_path):
    """plant_a: the server's approved SIMULATION bindings must reach the agent env (server run.start path)."""
    async def run():
        cfg, launch = launcher(tmp_path, 'ready')
        cfg = replace(cfg, worlds={'plant_a/l1': World('plant_a/l1', Path('/p/a'), Path('/p/b'))})
        launch.settings = cfg
        manager = Manager(cfg, launch)
        slot = next(iter(cfg.slots.values()))
        bindings = [dict(world_id='plant_a', ros_floor_id='l1', floor_id=str(uuid4()), map_version_id=str(uuid4()),
                         image_sha256='a' * 64, source_pgm_sha256='b' * 64)]
        seen = {}
        original = launch.add
        async def spy(s, credentials):
            seen.update(credentials)
            return await original(s, credentials)
        launch.add = spy
        await manager.add('plant_a', slot.robot_id, str(uuid4()), slot.org_id, 'x' * 32, 1, 'l1', bindings)
        assert list(seen['map_bindings']) == bindings
        await manager.close()
    asyncio.run(run())


@pytest.mark.parametrize('count, backend, ok', [(8, 'mujoco', True), (9, 'mujoco', False), (3, None, False), (2, None, True)])
def test_robot_cap_eight_for_mujoco_two_otherwise(tmp_path, count, backend, ok):
    org = str(uuid4())
    slots = {s.robot_id: s for s in (Slot(str(uuid4()), org, '/k', f'/r{i}', 9433 + i) for i in range(count))}
    make = lambda: Settings({'collapsed-house-v2': World('collapsed-house-v2', Path('/a'), Path('/b'))}, slots, 'x' * 32,
                            run_dir=str(tmp_path), local_backend=backend, max_robots=count)
    if ok:
        assert make().max_robots == count
    else:
        with pytest.raises(ValueError):
            make()

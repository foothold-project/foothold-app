"""Deadline tests use synthetic units only; no systemd/ROS/Gazebo calls."""
import asyncio
from dataclasses import replace
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from apps.simmgr.service import Manager, SimError
from apps.simmgr.launcher import NativeLauncher
from test_manager import settings
from test_episode_reuse import native_episode


@pytest.mark.parametrize('seconds', [0, 4, 3601, True, 1800.0])
def test_runtime_is_bounded(seconds):
    with pytest.raises(ValueError, match='runtime'):
        replace(settings(), runtime_seconds=seconds)


def test_shared_runtime_default_and_maximum():
    cfg = settings()
    assert cfg.runtime_seconds == 1800 and cfg.unit_runtime_seconds == 1890
    assert replace(cfg, runtime_seconds=3600).unit_runtime_seconds == 3690


def test_five_second_native_deadline_is_clean_and_reusable(native_episode, monkeypatch):
    cfg, state = native_episode
    cfg = replace(cfg, runtime_seconds=5)
    from apps.simmgr import agent_unit
    original = agent_unit.subprocess.run
    argv = []
    def run(args, **kwargs):
        if args[0] == 'systemd-run':
            argv.append(args)
        return original(args, **kwargs)
    monkeypatch.setattr(agent_unit.subprocess, 'run', run)

    async def exercise():
        launch = NativeLauncher(cfg)
        manager = Manager(cfg, launch)
        slot = next(iter(cfg.slots.values()))
        owner = str(uuid4())
        before = datetime.now(timezone.utc)
        row = await manager.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'x'*32, 1)
        assert 4 < (row['expires_at'] - before).total_seconds() <= 5.1
        assert state.runtime_seconds == 95
        assert '--property=RuntimeMaxSec=95' in argv[0]
        await asyncio.wait_for(asyncio.shield(manager.expiry_task), 6)
        assert manager.failed is False and launch.failed is False
        assert manager.world is None and not manager.robots and not state.units
        assert state.events.index('agent_sigint') < state.events.index('agent_exit0') < state.events.index('world_close')
        assert manager.completions(slot.org_id) == [dict(robot_id=slot.robot_id, owner_id=owner, generation=1)]
        with pytest.raises(SimError) as error:
            await manager.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'x'*32, 1)
        assert error.value.code == 'SIM_GENERATION_STALE'
        await manager.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'y'*32, 2)
        assert manager.completions(slot.org_id) == []
        await manager.close()
        assert not state.units and not manager.failed and not launch.failed
    asyncio.run(exercise())


@pytest.mark.parametrize('failure', ['agent', 'world'])
def test_deadline_failure_keeps_latch_and_ownership(native_episode, failure):
    cfg, state = native_episode
    async def exercise():
        launch = NativeLauncher(cfg)
        manager = Manager(cfg, launch)
        slot = next(iter(cfg.slots.values()))
        owner = str(uuid4())
        await manager.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'x'*32, 1)
        manager.expiry_task.cancel()
        await asyncio.gather(manager.expiry_task, return_exceptions=True)
        if failure == 'agent':
            async def broken(slot):
                raise RuntimeError('STOP/zero unconfirmed')
            launch.stop_agent = broken
        else:
            state.close_error = 'manifest unconfirmed'
        await manager._expire_at(asyncio.get_running_loop().time())
        assert manager.failed and manager.robots[slot.robot_id].state == 'ERROR'
        assert manager.robots[slot.robot_id].owner == owner
        assert manager.completions(slot.org_id) == []
        with pytest.raises(SimError) as error:
            await manager.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'y'*32, 2)
        assert error.value.code == 'SIM_UNAVAILABLE'
    asyncio.run(exercise())

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


@pytest.mark.parametrize('seconds', [5, 299])
def test_native_runtime_rejects_short_values(native_episode, seconds):
    cfg, _ = native_episode
    with pytest.raises(ValueError, match='300..3600'):
        replace(cfg, runtime_seconds=seconds)
    assert replace(settings(), runtime_seconds=seconds).runtime_seconds == seconds


def test_native_deadline_is_clean_and_reusable(native_episode, monkeypatch):
    cfg, state = native_episode
    cfg = replace(cfg, runtime_seconds=300)
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
        assert 299 < (row['expires_at'] - before).total_seconds() <= 300.1
        assert 299 <= row['remaining_s'] <= 300
        assert state.runtime_seconds == 390
        assert '--property=RuntimeMaxSec=390' in argv[0]
        manager.expiry_task.cancel()
        await asyncio.gather(manager.expiry_task, return_exceptions=True)
        await manager._expire_at(asyncio.get_running_loop().time())
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


@pytest.mark.parametrize('phase', ['start_world', 'add', 'stop_agent', 'remove'])
def test_listing_returns_immediately_during_native_transitions(native_episode, monkeypatch, phase):
    cfg, _ = native_episode

    async def exercise():
        launch = NativeLauncher(cfg)
        manager = Manager(cfg, launch)
        slot = next(iter(cfg.slots.values()))
        owner = str(uuid4())
        entered, release = asyncio.Event(), asyncio.Event()
        original = getattr(launch, phase)

        async def paused(*args):
            entered.set()
            await release.wait()
            return await original(*args)

        monkeypatch.setattr(launch, phase, paused)
        if phase in ('start_world', 'add'):
            task = asyncio.create_task(manager.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'x'*32, 1))
            expected = 'STARTING'
        else:
            await manager.add('v5_single/f1', slot.robot_id, owner, slot.org_id, 'x'*32, 1)
            manager.expiry_task.cancel()
            await asyncio.gather(manager.expiry_task, return_exceptions=True)
            task = asyncio.create_task(manager._expire_at(asyncio.get_running_loop().time()))
            expected = 'STOPPING'
        await asyncio.wait_for(entered.wait(), 1)
        assert manager.lock.locked()

        async def forbidden_health():
            pytest.fail('health must not inspect an intentional lifecycle transition')

        with monkeypatch.context() as patch:
            patch.setattr(launch, 'check_health', forbidden_health)
            if phase == 'remove':
                # The watcher may see the unit exit during normal world close.
                patch.setattr(launch.sim, 'reason', 'unit_exited')
            rows = await asyncio.wait_for(manager.listing(slot.org_id), .1)
            assert len(rows) == 1 and rows[0]['state'] == expected
            assert rows[0]['owner_id'] == owner and rows[0]['generation'] == 1
            assert await asyncio.wait_for(manager.listing(str(uuid4())), .1) == []
        release.set()
        await task
        assert not manager.failed and not launch.failed
        await manager.close()
    asyncio.run(exercise())


def test_remaining_seconds_use_monotonic_deadline_not_utc():
    async def exercise():
        cfg = replace(settings(), runtime_seconds=5)
        manager = Manager(cfg)
        slot = next(iter(cfg.slots.values()))
        row = await manager.add('a', slot.robot_id, str(uuid4()), slot.org_id, 'x'*32, 1)
        assert row['remaining_s'] == 5
        manager.expires_at = datetime(2000, 1, 1, tzinfo=timezone.utc)
        manager.deadline = asyncio.get_running_loop().time() + 1.5
        assert (await manager.listing(slot.org_id))[0]['remaining_s'] == 2
        manager.deadline = asyncio.get_running_loop().time() - 1
        assert (await manager.listing(slot.org_id))[0]['remaining_s'] == 0
        await manager.close()
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

"""One building lifecycle, start aliases, manifest closure and agent launch data."""
import asyncio
from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from apps.simmgr.config import World
from apps.simmgr.service import Manager, SimError
from apps.simmgr.native_catalogue import resolve_native_world
from apps.simmgr.native_entrypoint import verified_helper
from apps.simmgr import launcher
from foothold_agent.ros_bridge.floors import FloorBindings
from test_connected_assets import connected_catalogue
from test_manager import settings
from test_episode_reuse import native_episode


def test_single_world_start_floor_is_immutable_without_stop_or_reprovision(connected_catalogue):
    root, bindings = connected_catalogue
    worlds = {f'v5_building/{f}': World(f'v5_building/{f}', root/f/'world.sdf', root/f/'map.yaml', 'Building')
              for f in ('l1', 'l2')}
    cfg = replace(settings(), worlds=worlds)
    async def run():
        manager = Manager(cfg)
        slot = next(iter(cfg.slots.values()))
        owner = str(uuid4())
        row = await manager.add('v5_building/l2', slot.robot_id, owner, slot.org_id, 'x'*32, 1,
                                map_bindings=bindings)
        assert row['world_id'] == 'v5_building' and row['spawn_floor_id'] == 'l2'
        assert manager.world == 'v5_building' and manager.spawn_floor_id == 'l2'
        assert manager.world_bindings == tuple(bindings)
        before = list(manager.launcher.events)
        same = await manager.add('v5_building', slot.robot_id, owner, slot.org_id, 'x'*32, 1,
                                 'l2', bindings)
        assert same['generation'] == 1 and manager.launcher.events == before
        with pytest.raises(SimError) as error:
            await manager.start_world('v5_building/l1')
        assert error.value.code == 'SIM_WORLD_BUSY'
        assert manager.launcher.events == before  # map/spawn selection never sends STOP or adds an agent
        await manager.close()
    asyncio.run(run())


def clearance(root, bindings, tmp_path):
    source = tmp_path/'source'; source.mkdir()
    (source/'sensor_isolation.py').write_text('TARGET = {}\n')
    (source/'live_map.py').write_text('synthetic sensor runtime')
    world = World('v5_building/l2', root/'l2/world.sdf', root/'l2/map.yaml', 'Building')
    native = resolve_native_world(world, {world.id: world}, root)
    path = tmp_path/'clearance.json'
    path.write_text(json.dumps(dict(key=world.id, root=str(root), roots=list(map(str, native.roots)),
        world_file=str(native.world_file), map_file=str(native.map_file),
        hashes=native.hashes(source), map_bindings=bindings)))
    return native, source, path


@pytest.mark.parametrize('relative', ['l1/heights.npz', 'l2/map.yaml', 'l1/meta.json', 'l2/map.pgm',
                                     'l1/world.sdf', 'connected/cols.npz', 'connected/connected.json'])
def test_child_sha_fences_all_floors_before_import(connected_catalogue, tmp_path, monkeypatch, relative):
    root, bindings = connected_catalogue
    native, source, manifest = clearance(root, bindings, tmp_path)
    asset = root/relative; asset.write_bytes(asset.read_bytes()+b'\n')
    monkeypatch.setattr('importlib.util.spec_from_file_location', lambda *_: pytest.fail('helper imported too early'))
    with pytest.raises(ValueError):
        verified_helper(source, manifest, ['--world-id', 'v5_building', '--floor-id', 'l2'])


def test_child_verified_target_and_no_missing_map_bindings(connected_catalogue, tmp_path):
    root, bindings = connected_catalogue
    native, source, manifest = clearance(root, bindings, tmp_path)
    helper = verified_helper(source, manifest, ['--world-id', 'v5_building', '--floor-id', 'l2'])
    assert helper.TARGET == dict(world_id='v5_building', floor_id='l2', map_mode='static')
    assert 'sensor_runtime' in native.hashes(source) and 'adapter_connected.py' in native.hashes(source)
    data = json.loads(manifest.read_text()); data['map_bindings'] = bindings[:1]
    manifest.write_text(json.dumps(data))
    with pytest.raises(ValueError, match='both connected'):
        verified_helper(source, manifest, ['--world-id', 'v5_building', '--floor-id', 'l2'])


def test_native_agent_receives_registered_floors_generation_and_actual_run_nonce(native_episode):
    cfg, state = native_episode
    slot = next(iter(cfg.slots.values()))
    async def run():
        native = launcher.NativeLauncher(cfg)
        await native.start_world(cfg.worlds['v5_single/f1'])  # synthetic supervisor only
        native.sim.out.mkdir()
        (native.sim.out/'manifest.json').write_text(json.dumps(dict(run_id='native-run-nonce')))
        bindings = []
        for i, floor in enumerate(('l1', 'l2'), 1):
            bindings.append(dict(world_id='v5_building', building_id=str(uuid4()) if i == 1 else building,
                ros_building_id='v5', ros_floor_id=floor, ros_map_version='gt-20261012', floor_id=str(uuid4()),
                map_version_id=str(uuid4()), sha256='a'*64, source_pgm_sha256='b'*64,
                resolution=.05, origin=[0, 0, 0], width=2, height=2, source='SIMULATION'))
            building = bindings[0]['building_id']
        await native.add(slot, dict(agent_token='x'*32, generation=7, spawn_floor_id='l2', map_bindings=bindings))
        data = json.loads((native.folder/'agent-env.json').read_text())
        launch = FloorBindings.from_env(data['env'])
        assert launch.robot_id == slot.robot_id and launch.generation == 7
        assert launch.spawn == 'l2' and launch.run_id == 'native-run-nonce'
        assert set(launch.bindings) == {'l1', 'l2'}
        await native.stop_agent(slot)
        await native.close_world()
    asyncio.run(run())

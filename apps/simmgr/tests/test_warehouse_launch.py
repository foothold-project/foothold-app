"""Offline warehouse launch identity and approved bytes, without ROS/Gazebo."""
from copy import deepcopy
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from apps.simmgr.connected_runtime import compile_static_runtime, write_run_identity
from apps.simmgr.repo_runtime import single_floor_status, verify_bindings
from apps.simmgr.native_catalogue import resolve_native_world
from apps.simmgr.native_entrypoint import verified_helper
from foothold_agent.ros_bridge.floors import FloorBindings
from test_repo_worlds import repo
from test_native_catalogue import catalogue
from test_floor_launch import IDENTITY_RUNTIME
from test_episode_reuse import native_episode
from apps.simmgr import launcher


@pytest.mark.parametrize('field,value', [('source_pgm_sha256','a'*64), ('sha256','b'*64),
    ('origin',[0,0,0]), ('width',301), ('ros_floor_id','l1'), ('world_id','v5_building')])
def test_warehouse_native_rejects_unmatched_approved_bytes(repo, catalogue, field, value):
    _, _, world = repo
    native = resolve_native_world(world, {world.id:world}, catalogue[0])
    verify_bindings(native, world.map_bindings)
    changed = deepcopy(list(world.map_bindings)); changed[0][field] = value
    with pytest.raises(ValueError, match='differs from native GT'):
        verify_bindings(native, changed)
    with pytest.raises(ValueError):
        verify_bindings(native, [])


def test_warehouse_compiled_native_nonce_and_status_match_agent_registration(repo, tmp_path):
    _, _, world = repo
    b = world.map_bindings[0]
    base = dict(world_id='warehouse', building_id='warehouse', floor_id='f1', epoch=1,
        schema='v2_map_status/1', map_frame='map', sim_t=.2, map_version='gt-20261012',
        map_source='gt_raster', map=dict(width=300,height=440,resolution=.05,epoch=1))
    source = IDENTITY_RUNTIME.replace('st = {"run_id": RUN_ID}', 'st = {**base, "run_id": RUN_ID}')
    scope = dict(a=SimpleNamespace(out=tmp_path), CONN=False, base=base,
        static_meta=dict(sha256_pgm=b['source_pgm_sha256'],origin=b['origin']),
        _fh_single_floor_status=single_floor_status, _fh_run_identity=write_run_identity,
        pub_status=SimpleNamespace(publish=lambda _:None))
    exec(compile_static_runtime(source, 'warehouse-native-fixture', warehouse=True), scope)
    man, status = scope['main']()
    assert man == json.loads((tmp_path/'run-identity.json').read_text())
    launch = FloorBindings('00000000-0000-4000-8000-000000000010',3,man['run_id'],1,'f1',[b])
    context = launch.context(status)
    assert context['floor_state'] == 'on_floor' and context['current_floor_id'] == 'f1'
    assert context['map_version_id'] == b['map_version_id'] and context['source_pgm_sha256'] == b['source_pgm_sha256']


def test_warehouse_child_rejects_missing_registration_before_helper_import(repo, catalogue, tmp_path, monkeypatch):
    _, _, world = repo
    root, source, _ = catalogue
    native = resolve_native_world(world, {world.id:world}, root)
    manifest = tmp_path/'manifest.json'
    manifest.write_text(json.dumps(dict(key=native.key, root=str(native.root), roots=list(map(str,native.roots)),
        world_file=str(native.world_file),map_file=str(native.map_file),hashes=native.hashes(source))))
    monkeypatch.setattr('importlib.util.spec_from_file_location',lambda *_:pytest.fail('import before binding check'))
    with pytest.raises(ValueError, match='differs from native GT'):
        verified_helper(source,manifest,['--world-id','warehouse','--floor-id','f1'])


def test_warehouse_agent_env_uses_actual_native_nonce_and_fixed_f1(native_episode):
    cfg, _ = native_episode
    slot = next(iter(cfg.slots.values()))
    async def run():
        native = launcher.NativeLauncher(cfg)
        await native.start_world(cfg.worlds['v5_single/f1'])  # synthetic supervisor only
        native.sim.out.mkdir()
        write_run_identity(native.sim.out,'warehouse-run')
        b = dict(world_id='warehouse',ros_building_id='warehouse',ros_floor_id='f1',
            building_id='00000000-0000-4000-8000-000000000020',floor_id='00000000-0000-4000-8000-000000000001',
            map_version_id='00000000-0000-4000-8000-000000000002',sha256='a'*64,source_pgm_sha256='b'*64,
            ros_map_version='gt-20261012',source='SIMULATION',width=300,height=440,resolution=.05,origin=[-7.5,-11.,0.])
        await native.add(slot,dict(agent_token='x'*32,generation=7,spawn_floor_id=None,map_bindings=[b]))
        data = json.loads((native.folder/'agent-env.json').read_text())
        launch = FloorBindings.from_env(data['env'])
        assert launch.spawn == 'f1' and launch.world == 'warehouse'
        assert launch.run_id == 'warehouse-run' and launch.generation == 7
        await native.stop_agent(slot)
        (native.sim.out/'manifest.json').write_text(json.dumps(dict(run_id='warehouse-run')))
        await native.close_world()
    asyncio.run(run())

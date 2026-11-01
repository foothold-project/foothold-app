"""Catalogue target adapter, using temporary assets and no ROS/systemd/Gazebo."""
import asyncio
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from test_review_environment import isolation
from test_episode_reuse import native_episode
from test_manager import settings
from apps.simmgr import launcher, native_simulation
from apps.simmgr.config import World
from apps.simmgr.environment import child_environment
from apps.simmgr.native_catalogue import resolve_native_world
from apps.simmgr.native_entrypoint import verified_helper


@pytest.fixture
def catalogue(tmp_path):
    root = tmp_path / 'experiment/map-20261014'
    root.mkdir(parents=True)
    source = root.parent / 'sensor-spec-20261016/stage/sensor-runtime-r1'
    source.mkdir(parents=True)
    (source / 'sensor_isolation.py').write_text(
        "TARGET = dict(world_id='v5_single', floor_id='f1', map_mode='static')\n"
        "REQUIRED_ENV = {'ROS_DOMAIN_ID': '93'}\nGT_VERSION = 'gt-20261012'\n"
        "def arg_errors(target, env):\n"
        "    return [] if target == TARGET and env == REQUIRED_ENV else ['refused']\n")
    (source / 'live_map.py').write_text('synthetic runtime')
    entries, worlds = {}, {}
    for key, pose in [('v5_single/f1', [-12, -9, .4, 0, 0, 0]),
                      ('building/l1', [-12, -9, .4, 0, 0, 0]),
                      ('building/l2', [10.5, 4.5, 2.8, 0, 0, 3.14159])]:
        stem = key.replace('/', '_')
        world = root / (stem + '.sdf')
        world.write_text('<sdf><world><include><pose>' + ' '.join(map(str, pose)) +
                         '</pose></include></world></sdf>')
        mapfile = root / (stem + '.yaml'); mapfile.write_text('synthetic map')
        entries[key] = dict(world=world.name, gt_map=mapfile.name, spawn_pose=pose)
        worlds[key] = World(key, world, mapfile, name=key)
    (root / 'worlds.json').write_text(json.dumps({'worlds': entries}))
    return root, source, worlds


def manifest_for(root, source, worlds, key, path):
    native = resolve_native_world(worlds[key], worlds, root)
    path.write_text(json.dumps(dict(key=key, root=str(root), world_file=str(native.world_file),
        map_file=str(native.map_file), hashes=native.hashes(source))))
    return path


@pytest.mark.parametrize('key', ['unknown/l1', 'building/unknown', 'building/l2'])
def test_unprovisioned_target_rejected_before_evidence_hashing_or_unit(catalogue, tmp_path, monkeypatch, key):
    root, source, worlds = catalogue
    monkeypatch.setenv('FH_SIM_RUN', '1')
    monkeypatch.setattr(launcher, 'ROOT', tmp_path)
    cfg = replace(settings(), source=str(source), ros_setup='unused', run_dir=str(tmp_path/'runs/new'),
                  worlds={'v5_single/f1': worlds['v5_single/f1']})
    # Even a real native entry is forbidden unless the private catalogue provisions it.
    world = worlds.get(key, replace(worlds['building/l2'], id=key, name=key))
    monkeypatch.setattr(launcher, 'startup_preflight', lambda *_: pytest.fail('preflight too early'))
    monkeypatch.setattr(isolation, 'source_hashes', lambda *_: pytest.fail('hashing too early'))
    with pytest.raises(ValueError, match='configured catalogue'):
        asyncio.run(launcher.NativeLauncher(cfg).start_world(world))
    assert not (tmp_path/'runs/new').exists()


@pytest.mark.parametrize('key', ['unknown/l1', 'building/unknown'])
def test_native_catalogue_also_required(catalogue, key):
    root, _, worlds = catalogue
    world = replace(worlds['building/l2'], id=key, name=key)
    with pytest.raises(ValueError, match='native static catalogue'):
        resolve_native_world(world, {key: world}, root)


def test_registered_l2_launcher_passes_the_selected_native_pair(catalogue, tmp_path, monkeypatch):
    root, source, worlds = catalogue
    monkeypatch.setenv('FH_SIM_RUN', '1')
    monkeypatch.setenv('HOME', '/sealed/read-only-home')
    monkeypatch.setattr(launcher, 'ROOT', tmp_path)
    monkeypatch.setattr(launcher, 'startup_preflight', lambda *_: {})
    cfg = replace(settings(), source=str(source), ros_setup='unused', run_dir=str(tmp_path/'runs/l2'), worlds=worlds)
    captured = {}
    class Sim:
        reason = None
        started = False
        def __init__(self, folder, source, setup, *, native, configured_world, **kwargs):
            captured.update(native=native, configured_world=configured_world,
                            folder=folder, env=kwargs['launch_env'])
        def start(self):
            home = Path(captured['env']['HOME'])
            assert home == captured['folder'] / 'native-home'
            assert home.stat().st_mode & 0o777 == 0o700
            assert (home / '.gz').is_dir()
            assert (home / '.gz').stat().st_mode & 0o777 == 0o700
            # Stand in for gz-common's first write, without loading Gazebo/ROS.
            (home / '.gz' / 'auto_default.log').write_text('synthetic')
            self.started = True
        def live_identity(self):
            return {'partition': 'synthetic'}
    monkeypatch.setattr(native_simulation, 'CataloguedSimulation', Sim)
    launch = launcher.NativeLauncher(cfg)
    asyncio.run(launch.start_world(worlds['building/l2']))
    assert captured['configured_world'] is worlds['building/l2']
    assert captured['native'].target == dict(world_id='building', floor_id='l2', map_mode='static')
    assert captured['native'].world_file == worlds['building/l2'].world_file
    assert captured['native'].map_file == worlds['building/l2'].map_file
    assert launch.sim.started


@pytest.mark.parametrize('field', ['world_file', 'map_file'])
def test_realpath_mismatch_rejected(catalogue, field):
    root, _, worlds = catalogue
    world = replace(worlds['building/l2'], **{field: root / 'wrong'})
    with pytest.raises(ValueError, match='world/map pair'):
        resolve_native_world(world, worlds, root)


@pytest.mark.parametrize('changed', ['world', 'map', 'catalogue', 'helper', 'unknown_floor'])
def test_child_refuses_changed_sha_or_unknown_floor_before_loading_target(catalogue, tmp_path, monkeypatch, changed):
    root, source, worlds = catalogue
    manifest = manifest_for(root, source, worlds, 'building/l2', tmp_path/'manifest.json')
    path = {'world': worlds['building/l2'].world_file, 'map': worlds['building/l2'].map_file,
            'catalogue': root/'worlds.json', 'helper': source/'sensor_isolation.py'}.get(changed)
    if path:
        path.write_text(path.read_text() + '\n')
    monkeypatch.setattr(importlib.util, 'spec_from_file_location', lambda *_: pytest.fail('TARGET loaded before rejection'))
    floor = 'unknown' if changed == 'unknown_floor' else 'l2'
    with pytest.raises(ValueError, match='SHA mismatch|cleared target'):
        verified_helper(source, manifest, ['--world-id', 'building', '--floor-id', floor])


def test_only_target_changes_and_original_environment_gate_remains(catalogue, tmp_path):
    root, source, worlds = catalogue
    path = manifest_for(root, source, worlds, 'building/l2', tmp_path/'manifest.json')
    before = (source/'sensor_isolation.py').read_bytes()
    helper = verified_helper(source, path, ['--world-id', 'building', '--floor-id', 'l2'])
    assert helper.TARGET == dict(world_id='building', floor_id='l2', map_mode='static')
    assert helper.REQUIRED_ENV == {'ROS_DOMAIN_ID': '93'}
    assert helper.GT_VERSION == 'gt-20261012'
    assert helper.arg_errors(helper.TARGET, {'ROS_DOMAIN_ID': '93'}) == []
    assert helper.arg_errors(helper.TARGET, {'ROS_DOMAIN_ID': '61'}) == ['refused']
    assert (source/'sensor_isolation.py').read_bytes() == before


def test_entrypoint_uses_registered_l2_sdf_pose(catalogue, tmp_path):
    root, source, worlds = catalogue
    manifest = manifest_for(root, source, worlds, 'building/l2', tmp_path/'manifest.json')
    # Runtime double reads the selected SDF, as native runtime does; no simulator imports.
    (source/'live_map.py').write_text(
        "import json, sys, xml.etree.ElementTree as ET\n"
        "from pathlib import Path\nimport sensor_isolation as iso\n"
        f"root=Path({str(root)!r})\n"
        "assert iso.TARGET == dict(world_id='building', floor_id='l2', map_mode='static')\n"
        "entry=json.loads((root/'worlds.json').read_text())['worlds']['building/l2']\n"
        "print(json.dumps([float(v) for v in ET.parse(root/entry['world']).find('.//pose').text.split()]))\n")
    entrypoint = Path(native_simulation.__file__).with_name('native_entrypoint.py')
    result = subprocess.run([sys.executable, str(entrypoint), str(source), str(manifest),
        '--world-id', 'building', '--floor-id', 'l2'], capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == [10.5, 4.5, 2.8, 0, 0, 3.14159]


def test_catalogued_start_clears_environment_and_records_hashes(catalogue, tmp_path, monkeypatch):
    root, source, worlds = catalogue
    folder = tmp_path/'episode'; folder.mkdir()
    native = resolve_native_world(worlds['building/l2'], worlds, root)
    sim = native_simulation.CataloguedSimulation(folder, source, tmp_path/'setup',
        native=native, configured_world=worlds['building/l2'], launch_env=child_environment(93, {}), seconds=1890)
    monkeypatch.setattr(native_simulation, 'preflight', lambda _: dict(domain61=[]))
    monkeypatch.setattr(native_simulation, 'source_hashes', lambda _: {})
    monkeypatch.setattr(native_simulation.threading, 'Thread', Mock())
    monkeypatch.setattr(sim, 'show', lambda: dict(MainPID='123', ControlGroup='/owned'))
    monkeypatch.setattr(native_simulation, 'processes', lambda: ([dict(pid=123, start_ticks=1)], 0))
    launch = Mock(return_value='')
    monkeypatch.setattr(native_simulation.subprocess, 'check_output', launch)
    sim.start()
    argv = launch.call_args.args[0]
    assert argv[-2:] == ['building', 'l2']
    assert ['/usr/bin/env', '-i'] == argv[argv.index('/usr/bin/env'):argv.index('/usr/bin/env')+2]
    assert '--property=RuntimeMaxSec=1890' in argv
    manifest = json.loads((folder/'catalogue-target-manifest.json').read_text())
    assert manifest['hashes'] == native.hashes(source)
    assert sim.gt_world_sha == manifest['hashes']['world']
    assert sim.close.__func__ is isolation.Simulation.close
    assert sim.watch.__func__ is isolation.Simulation.watch


def test_catalogued_resource_refusal_precedes_all_hashing(catalogue, tmp_path, monkeypatch):
    root, source, worlds = catalogue
    native = resolve_native_world(worlds['building/l2'], worlds, root)
    sim = native_simulation.CataloguedSimulation(tmp_path, source, tmp_path/'setup',
        native=native, configured_world=worlds['building/l2'])
    def refused(_):
        raise RuntimeError('preflight resource gate failed; no launch')
    monkeypatch.setattr(native_simulation, 'preflight', refused)
    monkeypatch.setattr(native_simulation, 'source_hashes', lambda *_: pytest.fail('hashing too early'))
    monkeypatch.setattr(type(native), 'hashes', lambda *_: pytest.fail('asset hashing too early'))
    with pytest.raises(RuntimeError, match='preflight resource gate failed; no launch'):
        sim.start()
    assert not (tmp_path/'catalogue-target-manifest.json').exists()
    assert not sim.started


def test_legacy_f1_retains_original_supervisor(native_episode, monkeypatch):
    cfg, state = native_episode
    original = isolation.Simulation
    def forbidden(*args, **kwargs):
        pytest.fail('legacy f1 must use the original supervisor')
    monkeypatch.setattr(native_simulation, 'CataloguedSimulation', forbidden)
    launch = launcher.NativeLauncher(cfg)
    asyncio.run(launch.start_world(cfg.worlds['v5_single/f1']))
    assert type(launch.sim) is original
    assert state.events[-1] == 'world_start'

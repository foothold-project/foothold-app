"""Repository native assets and rejection recovery; no simulator/ROS/unit starts."""
import asyncio
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from test_review_environment import isolation
from apps.simmgr import launcher, native_catalogue, native_simulation
from apps.simmgr.api import create_app
from apps.simmgr.config import World
from apps.simmgr.native_catalogue import resolve_native_world, WorldValidationError
from apps.simmgr.native_entrypoint import verified_helper
from test_episode_reuse import native_episode
from test_native_catalogue import catalogue
from test_connected_assets import connected_catalogue


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / 'repository-worlds'
    shutil.copytree(native_catalogue.REPO_WORLDS, root)
    monkeypatch.setattr(native_catalogue, 'REPO_WORLDS', root)
    entry = json.loads((root / 'worlds.json').read_text())['worlds']['warehouse/f1']
    from apps.server.fh_server.map_files import gray_pixels, sha256
    png = (root/'warehouse/maps/f1.png').read_bytes()
    width, height, pixels = gray_pixels(png)
    binding = dict(world_id='warehouse', ros_building_id='warehouse', ros_floor_id='f1',
        ros_map_version='gt-20261012', building_id=str(uuid4()), floor_id=str(uuid4()),
        map_version_id=str(uuid4()), sha256=sha256(png).hex(),
        source_pgm_sha256=sha256(f'P5\n{width} {height}\n255\n'.encode()+pixels).hex(),
        width=width, height=height, resolution=.05, origin=[-7.5,-11.,0.], source='SIMULATION')
    world = World('warehouse/f1', root / entry['world'], root / entry['gt_map'], name='Warehouse',
                  map_bindings=(binding,))
    return root, entry, world


def test_repository_resolution_and_original_control_catalogue_regression(repo, catalogue):
    root, entry, world = repo
    control, _, worlds = catalogue
    native = resolve_native_world(world, {world.id: world}, control)
    assert native.repository and native.root == root
    assert native.world_file == world.world_file and native.map_file == world.map_file
    assert native.entry['spawn_xyyaw'] == [0, 0, 0]
    assert native.entry['spawn_z'] == .434226 and native.entry['floor_z'] == .034226
    for key in ('v5_single/f1', 'building/l1', 'building/l2'):
        old = resolve_native_world(worlds[key], worlds, control)
        assert not old.repository and old.root == control
        assert old.world_file == worlds[key].world_file


@pytest.mark.parametrize('asset', ['world', 'gt_map', 'map_metadata', 'image', 'collision', 'visual'])
def test_repository_path_escape_rejected_before_any_hash(repo, catalogue, tmp_path, monkeypatch, asset):
    root, entry, world = repo
    paths = dict(world=world.world_file, gt_map=world.map_file,
        map_metadata=root / entry['map_metadata'], image=world.map_file.with_suffix('.png'),
        collision=world.world_file.parent / 'meshes/ShelfF_01_collision.obj',
        visual=world.world_file.parent / 'meshes/ShelfF_01_visual.obj')
    path = paths[asset]
    outside = tmp_path / 'outside'
    outside.write_bytes(path.read_bytes()); path.unlink(); path.symlink_to(outside)
    monkeypatch.setattr(native_catalogue, 'sha256', lambda *_: pytest.fail('hashing before realpath rejection'))
    with pytest.raises(WorldValidationError, match='escapes catalogue root'):
        resolve_native_world(world, {world.id: world}, catalogue[0])


def test_dotdot_path_escape_rejected_before_any_hash(repo, catalogue, tmp_path, monkeypatch):
    root, _, world = repo
    outside = tmp_path / 'outside.sdf'; outside.write_text('outside')
    data = json.loads((root / 'worlds.json').read_text())
    data['worlds'][world.id]['world'] = '../outside.sdf'
    (root / 'worlds.json').write_text(json.dumps(data))
    monkeypatch.setattr(native_catalogue, 'sha256', lambda *_: pytest.fail('hashing before traversal rejection'))
    with pytest.raises(WorldValidationError, match='escapes catalogue root'):
        resolve_native_world(world, {world.id: world}, catalogue[0])


@pytest.mark.parametrize('asset', ['world', 'map', 'metadata', 'image', 'collision', 'visual'])
def test_repository_sha_mismatch_rejected(repo, catalogue, asset):
    root, entry, world = repo
    paths = dict(world=world.world_file, map=world.map_file, metadata=root / entry['map_metadata'],
        image=world.map_file.with_suffix('.png'),
        collision=world.world_file.parent / 'meshes/ShelfF_01_collision.obj',
        visual=world.world_file.parent / 'meshes/ShelfF_01_visual.obj')
    path = paths[asset]; path.write_bytes(path.read_bytes() + b'\n')
    with pytest.raises(WorldValidationError, match='SHA mismatch'):
        resolve_native_world(world, {world.id: world}, catalogue[0])


def test_duplicate_key_across_catalogues_rejected_before_hashing(repo, catalogue, monkeypatch):
    _, entry, world = repo
    path = catalogue[0] / 'worlds.json'; data = json.loads(path.read_text())
    data['worlds'][world.id] = entry
    path.write_text(json.dumps(data))
    monkeypatch.setattr(native_catalogue, 'sha256', lambda *_: pytest.fail('hashing ambiguous target'))
    with pytest.raises(WorldValidationError, match='ambiguous'):
        resolve_native_world(world, {world.id: world}, catalogue[0])


@pytest.mark.parametrize('refusal', ['unlisted', 'sha', 'ambiguous'])
@pytest.mark.parametrize('endpoint', ['/v1/worlds', '/v1/robots'])
def test_rejection_is_4xx_before_evidence_and_next_v5_request_succeeds(repo, native_episode, refusal, endpoint):
    root, entry, warehouse = repo
    cfg, state = native_episode
    if refusal == 'unlisted':
        rejected = replace(cfg.worlds['v5_single/f1'], id='unlisted/f1', name='Unlisted')
    else:
        rejected = warehouse
        if refusal == 'sha':
            warehouse.map_file.write_text('changed map')
        else:
            path = Path(cfg.source).parents[2] / 'maps/worlds.json'
            data = json.loads(path.read_text()); data['worlds'][warehouse.id] = entry
            path.write_text(json.dumps(data))
    cfg = replace(cfg, worlds={**cfg.worlds, rejected.id: rejected})
    launch = launcher.NativeLauncher(cfg); app = create_app(cfg, launch)
    slot = next(iter(cfg.slots.values()))
    headers = {'Authorization': 'Bearer ' + cfg.secret}
    body = dict(robot_id=slot.robot_id, org_id=slot.org_id, owner_id=str(uuid4()),
                generation=1, agent_token='x'*32)
    with TestClient(app, client=('127.0.0.1', 9650)) as client:
        response = client.post(endpoint, headers=headers,
            json=dict(world_id=rejected.id, **(body if endpoint.endswith('robots') else {})))
        assert response.status_code == 400, response.text
        assert response.json()['error']['code'] == ('SIM_WORLD_UNKNOWN' if refusal == 'unlisted' else 'SIM_WORLD_INVALID')
        assert not app.state.manager.failed and not launch.failed
        assert launch.sim is launch.child is launch.folder is None
        assert not app.state.manager.robots and not state.events
        assert not Path(cfg.run_dir).exists()
        response = client.post('/v1/robots', headers=headers, json=dict(world_id='v5_single/f1', **body))
        assert response.status_code == 200, response.text
        assert response.json()['state'] == 'RUNNING'


def test_validation_error_from_supervisor_still_latches(native_episode, monkeypatch):
    cfg, _ = native_episode
    def failed(sim):
        raise WorldValidationError('assets changed after supervisor construction')
    monkeypatch.setattr(isolation.Simulation, 'start', failed)
    launch = launcher.NativeLauncher(cfg)
    app = create_app(cfg, launch)
    with TestClient(app, client=('127.0.0.1', 9650), raise_server_exceptions=False) as client:
        headers = {'Authorization': 'Bearer ' + cfg.secret}
        response = client.post('/v1/worlds', headers=headers, json={'world_id': 'v5_single/f1'})
        assert response.status_code == 503
        assert app.state.manager.failed and launch.failed
        assert client.post('/v1/worlds', headers=headers, json={'world_id': 'v5_single/f1'}).status_code == 503
        async def preserve(): pass
        monkeypatch.setattr(launch, 'close_world', preserve)


def test_repository_launcher_passes_cleared_assets_to_native_supervisor(repo, catalogue, tmp_path, monkeypatch):
    _, _, warehouse = repo
    _, source, worlds = catalogue
    from test_manager import settings
    cfg = replace(settings(), real=True, source=str(source), ros_setup='unused',
        run_dir=str(tmp_path / 'runs/repo'), worlds={**worlds, warehouse.id: warehouse})
    monkeypatch.setenv('FH_SIM_RUN', '1'); monkeypatch.setattr(launcher, 'ROOT', tmp_path)
    monkeypatch.setattr(launcher, 'startup_preflight', lambda *_: {})
    seen = {}
    class Sim:
        reason = None
        started = False
        def __init__(self, folder, source, setup, *, native, configured_world, **kwargs):
            seen.update(native=native, world=configured_world)
        def start(self): self.started = True
        def live_identity(self): return {}
    monkeypatch.setattr(native_simulation, 'CataloguedSimulation', Sim)
    launch = launcher.NativeLauncher(cfg)
    asyncio.run(launch.start_world(warehouse))
    assert seen['native'].repository and seen['world'] == warehouse
    assert launch.sim.started


def test_repository_manifest_reverified_before_child_import(repo, catalogue, tmp_path, monkeypatch):
    _, _, warehouse = repo
    control, source, _ = catalogue
    native = resolve_native_world(warehouse, {warehouse.id: warehouse}, control)
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps(dict(key=native.key, root=str(native.root), roots=list(map(str, native.roots)),
        world_file=str(native.world_file), map_file=str(native.map_file), hashes=native.hashes(source),
        map_bindings=list(warehouse.map_bindings))))
    helper = verified_helper(source, manifest, ['--world-id', 'warehouse', '--floor-id', 'f1'])
    assert helper.TARGET == dict(world_id='warehouse', floor_id='f1', map_mode='static')
    warehouse.map_file.write_text('changed after clearance')
    monkeypatch.setattr(importlib.util, 'spec_from_file_location', lambda *_: pytest.fail('helper imported before SHA rejection'))
    with pytest.raises(WorldValidationError, match='SHA mismatch'):
        verified_helper(source, manifest, ['--world-id', 'warehouse', '--floor-id', 'f1'])


def test_repository_runtime_assets_offline_with_system_geometry(repo, catalogue, tmp_path):
    root, _, _ = repo
    control, _, _ = catalogue
    # The native child uses system Python, which already supplies geometry libs;
    # the manager/server venv intentionally does not need those dependencies.
    script = r'''
import json, sys, xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from apps.simmgr.native_catalogue import resolve_native_world
from apps.simmgr.repo_runtime import prepare, robot_world, install
root, control, folder = map(Path, sys.argv[1:])
entry = json.loads((root/'worlds.json').read_text())['worlds']['warehouse/f1']
world = SimpleNamespace(id='warehouse/f1', world_file=root/entry['world'], map_file=root/entry['gt_map'])
native = resolve_native_world(world, {world.id:world}, control, root)
prepared = prepare(native, control, folder)
data = json.loads((prepared/'worlds.json').read_text())
w = data['worlds'][world.id]
assert w['floor_z'] == .034226 and w['spawn_z'] == .434226
assert w['spawn_xyyaw'] == [0,0,0]
assert w['world'] == str(world.world_file)
meta = json.loads((Path(w['gt_map']).parent/'meta.json').read_text())
assert (meta['width'], meta['height'], meta['origin']) == (300,440,[-7.5,-11,0])
raw = (Path(w['gt_map']).parent/'map.pgm').read_bytes().split(b'\n',3)
px = np.frombuffer(raw[3],np.uint8).reshape(440,300)
assert dict(zip(*np.unique(px,return_counts=True))) == {0:22724,205:14400,254:94876}
z = np.load(w['heights']); hz = z['hz']; assert hz.shape == (440,300)
assert abs(hz[220,150]-.034226)<.005 and np.isnan(hz[0,0])
sdf = ET.fromstring(robot_world(world.world_file.read_text(),native,prepared))
robot = sdf.find('./world/include')
assert robot.findtext('uri') == 'model://go2_v2_map'
assert list(map(float,robot.findtext('pose').split())) == [0,0,.434226,0,0,0]
assert sdf.find('world').get('name') == 'fh_v2_live'
assert all(Path(u.text).is_absolute() and Path(u.text).is_relative_to(root) for u in sdf.findall('.//collision/geometry/mesh/uri'))
for uri in sdf.findall('.//visual/geometry/mesh/uri'):
    path = Path(uri.text)
    assert path.is_relative_to(prepared/'visual-meshes') and path.is_file()
    original = root/path.relative_to(prepared/'visual-meshes')
    def geometry(text):
        return [line if line.startswith('v ') else 'f '+' '.join(c.split('/')[0] for c in line.split()[1:])
                for line in text.splitlines() if line.startswith(('v ', 'f '))]
    assert geometry(path.read_text()) == geometry(original.read_text())
    assert not any(line.startswith('vn ') for line in original.read_text().splitlines())
    lines = path.read_text().splitlines()
    normals = np.array([list(map(float,line.split()[1:])) for line in lines if line.startswith('vn ')])
    assert np.isfinite(normals).all() and np.allclose(np.linalg.norm(normals,axis=1),1)
    assert all(len(c.split('/'))==3 and c.split('/')[0]==c.split('/')[2]
               for line in lines if line.startswith('f ') for c in line.split()[1:])
assert not any(p.get('filename')=='gz-sim-imu-system' for p in sdf.findall('./world/plugin'))
assert not any(m.startswith(('rclpy','gz.')) for m in sys.modules)
print('repository runtime assets verified offline')
'''
    result = subprocess.run(['/usr/bin/python3', '-c', script, str(root), str(control), str(tmp_path)],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert 'verified offline' in result.stdout


@pytest.mark.parametrize('floor', ['l1', 'l2'])
def test_v5_building_levels_keep_catalogue_target(connected_catalogue, floor):
    root, _ = connected_catalogue
    key = 'v5_building/' + floor
    world = World(key, root/floor/'world.sdf', root/floor/'map.yaml', key)
    native = resolve_native_world(world, {key: world}, root)
    assert native.target == dict(world_id='v5_building', floor_id=floor, map_mode='static')
    assert native.world_file == world.world_file and not native.repository


def test_repository_root_symlink_escape_rejected(repo, catalogue, tmp_path, monkeypatch):
    root, _, world = repo
    link = tmp_path / 'linked-worlds'; link.symlink_to(root, target_is_directory=True)
    monkeypatch.setattr(native_catalogue, 'REPO_WORLDS', link)
    with pytest.raises(WorldValidationError, match='root must not escape'):
        resolve_native_world(world, {world.id: world}, catalogue[0])


def test_repository_building_path_escape_rejected_before_hashes(repo, catalogue, monkeypatch):
    root, _, world = repo
    path = root / 'worlds.json'; data = json.loads(path.read_text())
    data['worlds'][world.id]['building_id'] = '../escaped'
    path.write_text(json.dumps(data))
    monkeypatch.setattr(native_catalogue, 'sha256', lambda *_: pytest.fail('hashing before building id rejection'))
    with pytest.raises(WorldValidationError, match='building id'):
        resolve_native_world(world, {world.id: world}, catalogue[0])


def test_repository_entrypoint_installs_assets_and_preserves_ledger_paths(repo, catalogue, tmp_path):
    _, _, warehouse = repo
    control, source, _ = catalogue
    native = resolve_native_world(warehouse, {warehouse.id: warehouse}, control)
    folder = tmp_path / 'episode'; folder.mkdir()
    manifest = folder / 'manifest.json'
    manifest.write_text(json.dumps(dict(key=native.key, root=str(native.root), roots=list(map(str, native.roots)),
        world_file=str(native.world_file), map_file=str(native.map_file), hashes=native.hashes(source),
        map_bindings=list(warehouse.map_bindings))))
    (source / 'live_map.py').write_text(
        'import json\nfrom pathlib import Path\nfrom types import SimpleNamespace\n'
        'import xml.etree.ElementTree as ET\nimport sensor_isolation as iso\n'
        f'HERE = {str(control)!r}\n'
        'SP = SimpleNamespace(world_text=lambda text, follow: text)\n'
        "def operating_ledgers(): return [HERE + '/runs/map_ledger.jsonl', '/synthetic/ux/ledger']\n"
        'def gt_identity_allowed(d, w, here=HERE): return here\n'
        'def main():\n'
        '    import uuid\n'
        f'    a = SimpleNamespace(out={str(folder / "native-out")!r})\n'
        '    Path(a.out).mkdir()\n'
        '    RUN_ID = uuid.uuid4().hex\n'
        '    gate = None\n'
        '    def static_floor(ep, f, rev): pass\n'
        '    def floor_tick(sim_t, pos, tilt, fallen): pass\n'
        '    def publish_status():\n'
        '        pub_status.publish(st)\n'
        "    w = json.loads((Path(HERE)/'worlds.json').read_text())['worlds']['warehouse/f1']\n"
        "    robot = ET.fromstring(SP.world_text(Path(w['world']).read_text(), False)).find('./world/include')\n"
        "    print(json.dumps(dict(target=iso.TARGET, floor_z=w['floor_z'], pose=robot.findtext('pose'),\n"
        "        ledgers=operating_ledgers(), identity_root=gt_identity_allowed(None,None), root=HERE)))\n"
        '    return 0\n'
        "if __name__ == '__main__': raise AssertionError('must install assets before main')\n")
    cleared = json.loads(manifest.read_text())
    cleared['hashes'] = native.hashes(source)
    manifest.write_text(json.dumps(cleared))
    result = subprocess.run(['/usr/bin/python3', str(Path(launcher.__file__).with_name('native_entrypoint.py')),
                             str(source), str(manifest), '--world-id', 'warehouse', '--floor-id', 'f1'],
                            capture_output=True, text=True, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data['target'] == dict(world_id='warehouse', floor_id='f1', map_mode='static')
    assert data['floor_z'] == .034226
    assert list(map(float, data['pose'].split())) == [0, 0, .434226, 0, 0, 0]
    assert data['ledgers'] == [str(control / 'runs/map_ledger.jsonl'), '/synthetic/ux/ledger']
    assert data['root'] == data['identity_root'] == str(folder / 'native-assets')

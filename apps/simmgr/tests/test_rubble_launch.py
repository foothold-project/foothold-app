"""Packaged rubble identity and native preparation, no real simulator."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
from uuid import uuid4

import pytest

from apps.server.fh_server.sim_maps import load_worlds
from apps.simmgr.config import World
from apps.simmgr.native_catalogue import resolve_native_world
from apps.simmgr.repo_runtime import verify_bindings, single_floor_status
from foothold_agent.ros_bridge.floors import FloorBindings

ROOT = Path(__file__).resolve().parents[1]/'worlds'


def rubble(tmp_path):
    entry, meta, _, width, height, _ = next(r for r in load_worlds(ROOT) if r[0]['world_id']=='rubble')
    binding = dict(**meta['connected_gt'],width=width,height=height,resolution=meta['resolution'],
        origin=meta['origin'],building_id=str(uuid4()),floor_id=str(uuid4()),map_version_id=str(uuid4()))
    world = World('rubble/f1',ROOT/entry['world'],ROOT/entry['gt_map'],name='잔해 험지',map_bindings=(binding,))
    control = tmp_path/'control'; control.mkdir()
    (control/'worlds.json').write_text('{"worlds":{}}')
    return resolve_native_world(world,{world.id:world},control), binding


def test_rubble_binding_uses_exact_approved_bytes_and_world(tmp_path):
    native,b = rubble(tmp_path)
    verify_bindings(native,[b])
    assert native.target == dict(world_id='rubble',floor_id='f1',map_mode='static')
    for field,value in [('world_id','warehouse'),('source_pgm_sha256','b'*64),('origin',[0,0,0]),('ros_floor_id','l1')]:
        bad = deepcopy(b); bad[field]=value
        with pytest.raises(ValueError): verify_bindings(native,[bad])
    with pytest.raises(ValueError): verify_bindings(native,[])
    st = single_floor_status(dict(world_id='rubble',floor_id='f1',run_id='rubble-run',epoch=1,sim_t=.1,
        building_id='rubble',map_version='gt-20261012',map_source='gt_raster',
        map=dict(width=400,height=400,resolution=.05,epoch=1)),
        dict(sha256_pgm=b['source_pgm_sha256'],origin=b['origin']),world_id='rubble')
    launch = FloorBindings(str(uuid4()),1,'rubble-run',1,'f1',[b])
    assert launch.context(st)['map_version_id'] == b['map_version_id']
    with pytest.raises(ValueError): single_floor_status(st,{},world_id='warehouse')


def test_rubble_native_height_map_matches_actual_collision_and_visuals_have_normals(tmp_path):
    native,b = rubble(tmp_path)
    # System geometry packages stay outside the manager's venv, as in repo tests.
    script = '''
import json, sys
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import xml.etree.ElementTree as ET
from apps.simmgr.repo_runtime import prepare,robot_world
native=SimpleNamespace(**json.loads(sys.argv[1]))
native.root=Path(native.root); native.world_file=Path(native.world_file); native.map_file=Path(native.map_file)
folder=Path(sys.argv[2]); folder.mkdir()
root=prepare(native,folder,folder)
heights=np.load(root/'ground.npz')['hz']
assert heights.shape==(400,400) and np.isfinite(heights).all()
assert heights.min()>=-1e-7 and .10<heights.max()<=.15
assert heights[80,200]==0  # spawn (0,-6)
assert np.all(heights[:,190:210]==0)
sdf=ET.fromstring(robot_world(native.world_file.read_text(),native,root))
assert sdf.findtext('./world/include/pose')=='0.0 -6.0 0.4 0 0 0.0'
for uri in sdf.findall('.//visual/geometry/mesh/uri'):
    assert 'vn ' in Path(uri.text).read_text()
print('rubble native raster, collision heights, spawn and normals verified')
'''
    data = dict(root=str(native.root),world_file=str(native.world_file),map_file=str(native.map_file),
        key=native.key,entry=native.entry)
    result = subprocess.run(['/usr/bin/python3','-c',script,json.dumps(data),str(tmp_path/'episode')],
        capture_output=True,text=True)
    assert result.returncode==0,result.stdout+result.stderr

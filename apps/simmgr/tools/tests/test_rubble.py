"""Independent geometry limits, byte determinism and existing GT generation."""
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image

from apps.simmgr.tools.generate_rubble import generate, generate_assets
from apps.simmgr.tools.collision_map import read_collisions

ROOT = Path(__file__).resolve().parents[2] / 'worlds'


def test_regeneration_is_byte_identical_and_catalogue_hashes_match(tmp_path):
    expected = json.loads((ROOT/'worlds.json').read_text())['worlds']['rubble/f1']
    assert generate(tmp_path) == expected
    for source in (ROOT/'rubble').rglob('*'):
        if source.is_file() and source.name != '.gitignore' and source.suffix != '.md':
            assert (tmp_path/source.relative_to(ROOT/'rubble')).read_bytes() == source.read_bytes()
    before = (tmp_path/'rubble.sdf').read_bytes()
    generate_assets(tmp_path)
    assert (tmp_path/'rubble.sdf').read_bytes() == before
    for key, path in [('world','rubble.sdf'), ('map','maps/f1.yaml'), ('metadata','maps/metadata.json')]:
        assert hashlib.sha256((tmp_path/path).read_bytes()).hexdigest() == expected['sha256'][key]


def test_static_geometry_clear_spawn_passages_and_band_height_envelopes():
    path = ROOT/'rubble/rubble.sdf'
    tree = ET.parse(path)
    nodes = tree.findall('./world/model')
    assert len(nodes) == 97 and all(n.findtext('static') == 'true' for n in nodes)
    assert not tree.findall('.//include') and not tree.findall('.//sensor')
    collisions, _ = read_collisions(path)
    kinds = set()
    for node, collision in zip(nodes[1:], collisions[1:]):
        name = node.get('name'); band, _, _, kind, _ = name.split('_')
        kinds.add(kind)
        vertices = collision.mesh.vertices
        lo, hi = collision.mesh.bounds
        assert collision.closed
        assert lo[2] >= -1e-7
        assert hi[2] <= {'easy':.05,'medium':.10,'hard':.15}[band] + 1e-7
        # Distance from the entire enclosing XY box to spawn, not just centre.
        closest = np.maximum(lo[:2]-[0,-6], np.maximum([0,-6]-hi[:2], 0))
        assert np.linalg.norm(closest) >= 2
        assert lo[0] >= .8 or hi[0] <= -.8  # continuous >=1.6m centre lane
        assert lo[1] >= {'easy':-9.5,'medium':-2,'hard':4}[band]
        assert hi[1] <= {'easy':-3,'medium':3,'hard':9.5}[band]
        pitch = float(node.findtext('pose').split()[4])
        assert abs(pitch) <= np.deg2rad(15)
        assert np.isfinite(vertices).all()
    assert kinds == {'box','plate','cylinder','mound'}
    for mesh in (ROOT/'rubble/meshes').glob('*.obj'):
        normals = np.array([list(map(float,l.split()[1:])) for l in mesh.read_text().splitlines() if l.startswith('vn ')])
        assert np.isfinite(normals).all() and np.allclose(np.linalg.norm(normals,axis=1),1)


def test_map_is_ground_supported_and_patrol_stays_in_easy_lane():
    pixels = np.array(Image.open(ROOT/'rubble/maps/f1.png'))
    assert pixels.shape == (400,400) and set(np.unique(pixels)) == {0,254}
    assert np.all(pixels[:, 190:210] == 254)
    points = json.loads((ROOT/'rubble/scenarios.json').read_text())
    assert len(points) == 1 and 2 <= len(points[0]['waypoints']) <= 3
    for p in points[0]['waypoints']:
        assert -9 <= p['y'] <= -3 and p['x'] == 0
        assert pixels[int((10-p['y'])/.05),int((p['x']+10)/.05)] == 254

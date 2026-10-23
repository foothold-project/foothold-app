"""Synthetic geometry with independent expected occupancy; system geometry Python."""
import json
import hashlib

import numpy as np
from PIL import Image
import pytest
import trimesh

from apps.simmgr.tools.collision_map import generate


def test_two_floors_support_holes_solid_mesh_pose_and_image_coordinates(tmp_path):
    # A tall closed mesh crosses the entire body slab: surface projection alone
    # would leave its interior free. The independent expected grid catches that.
    mesh = trimesh.creation.box(extents=[1.4, 1.4, 1.0])
    (tmp_path / 'obstacle.obj').write_text(mesh.export(file_type='obj'))
    sdf = tmp_path / 'world.sdf'
    sdf.write_text('''<sdf version="1.9"><world name="synthetic">
      <model name="building"><static>true</static><pose>1 0 0 0 0 0</pose><link name="l">
        <collision name="floor1"><pose>1 2 -0.05 0 0 0</pose>
          <geometry><box><size>4 4 0.1</size></box></geometry></collision>
        <collision name="floor2"><pose>1.5 1 2.95 0 0 0</pose>
          <geometry><box><size>5 2 0.1</size></box></geometry></collision>
        <collision name="obstacle1"><pose>0.5 1.5 0.5 0 0 0</pose>
          <geometry><mesh><uri>obstacle.obj</uri></mesh></geometry></collision>
        <collision name="obstacle2"><pose>3.5 0.5 3.5 0 0 0.7</pose>
          <geometry><box><size>0.4 0.4 1</size></box></geometry></collision>
      </link></model></world></sdf>''')
    output = tmp_path / 'maps'
    meta = generate(sdf, output, {'f1': 0.0, 'f2': 3.0}, resolution=1.0, bounds=[0, 0, 5, 4])
    np.testing.assert_array_equal(np.array(Image.open(output / 'f1.png')),
                                  [[254, 254, 254, 254, 205], [0, 0, 0, 254, 205],
                                   [0, 0, 0, 254, 205], [0, 0, 0, 254, 205]])
    np.testing.assert_array_equal(np.array(Image.open(output / 'f2.png')),
                                  [[205, 205, 205, 205, 205], [205, 205, 205, 205, 205],
                                   [254, 254, 254, 254, 254], [254, 254, 254, 254, 0]])
    assert meta['origin'] == [0, 0, 0.0]  # yaw, never the upper floor's z
    assert meta['floors']['f2']['floor_z'] == 3.0
    assert meta['size_pixels'] == [5, 4] and meta['size_m'] == [5.0, 4.0]
    assert set(meta['dependencies']) == {'world.sdf', 'obstacle.obj'}
    assert meta['world_sha256'] == hashlib.sha256(sdf.read_bytes()).hexdigest()
    assert meta['floors']['f2']['image_sha256'] == hashlib.sha256(
        (output / 'f2.png').read_bytes()).hexdigest()
    assert json.loads((output / 'metadata.json').read_text()) == meta
    assert 'origin: [0, 0, 0.0]' in (output / 'f2.yaml').read_text()
    assert 'occupied_thresh: 0.65' in (output / 'f2.yaml').read_text()
    # Unknown collision types must abort, not silently disappear from a map.
    sdf.write_text(sdf.read_text().replace('<box><size>4 4 0.1</size></box>', '<heightmap/>'))
    with pytest.raises(ValueError, match='unsupported collision geometry'):
        generate(sdf, tmp_path / 'invalid', {'f1': 0.0})

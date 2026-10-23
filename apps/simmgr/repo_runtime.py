"""Child-only static asset compatibility for the established native runtime.

All generated files live in the episode folder. The upstream source, isolation,
command handling, supervisor and cleanup are unchanged. Geometry dependencies
are system-provided; importing the manager never imports numpy, ROS or Gazebo.
"""
import functools
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from .native_catalogue import contained

VERSION = 'gt-20261012'  # Existing isolated runtime's static-map version contract.


def verify_bindings(native, bindings):
    """Bind the one approved warehouse PNG to the generated native PGM bytes."""
    from apps.server.fh_server.map_files import gray_pixels
    meta = json.loads((native.root / native.entry['map_metadata']).read_text())
    png = (native.map_file.parent / meta['floors']['f1']['image']).read_bytes()
    width, height, pixels = gray_pixels(png)
    pgm = f'P5\n{width} {height}\n255\n'.encode() + pixels
    expected = dict(world_id='warehouse', ros_building_id=native.entry['building_id'], ros_floor_id='f1',
        ros_map_version=VERSION, source_pgm_sha256=hashlib.sha256(pgm).hexdigest(),
        sha256=hashlib.sha256(png).hexdigest(), resolution=meta['resolution'], origin=meta['origin'],
        width=width, height=height, source='SIMULATION')
    if (native.key != 'warehouse/f1' or len(bindings) != 1
            or any(bindings[0].get(k) != v for k, v in expected.items())):
        raise ValueError('approved warehouse binding differs from native GT')
    # UUIDs are validated by the authenticated provisioning contract.


def single_floor_status(status, meta):
    """Warehouse is a fixed f1 observation, never a fabricated connected transit."""
    if status.get('world_id') != 'warehouse' or status.get('floor_id') != 'f1':
        raise ValueError('warehouse status identity changed')
    status.update(floor_rev=1, floor_state='on_floor', current_floor='f1', spawn_floor='f1',
        floor_reason='ok', floor_src='gt_geometry', floor_confirm_sim_t=0.0,
        source_pgm_sha256=meta['sha256_pgm'], map_origin=meta['origin'])
    if status.get('map') is not None:
        status['map'].update(floor_id='f1', floor_rev=1)
    return status


def robot_world(text, native, assets_root):
    """Use episode visual normals and the robot; preserve collision geometry."""
    tree = ET.fromstring(text)
    world = tree.find('world')
    if world is None or tree.findall('.//include'):
        raise ValueError('repository world must contain only expanded static assets')
    world.set('name', 'fh_v2_live')
    for uri in tree.findall('.//uri'):
        uri.text = str(contained(native.root, str(native.world_file.parent.relative_to(native.root) / uri.text)))
    for uri in tree.findall('.//visual/geometry/mesh/uri'):
        uri.text = str(assets_root / 'visual-meshes' / Path(uri.text).relative_to(native.root))
    for plugin in list(world.findall('plugin')):
        if plugin.get('filename') == 'gz-sim-imu-system':
            world.remove(plugin)  # Established sensor-profile adapter adds exactly one.
    include = ET.SubElement(world, 'include')
    ET.SubElement(include, 'uri').text = 'model://go2_v2_map'
    ET.SubElement(include, 'name').text = 'go2_v2'
    x, y, yaw = native.entry['spawn_xyyaw']
    ET.SubElement(include, 'pose').text = f"{x} {y} {native.entry['spawn_z']} 0 0 {yaw}"
    ET.indent(tree, space='  ')
    return ET.tostring(tree, encoding='unicode') + '\n'


def prepare(native, base_root, folder):
    import numpy as np
    from PIL import Image
    from .tools.collision_map import read_collisions, raster_floor, triangle_samples

    # Verify geometry against the registered image, rather than asserting GT identity.
    entry = native.entry
    meta = json.loads((native.root / entry['map_metadata']).read_text())
    image = native.map_file.parent / meta['floors'][entry['floor_id']]['image']
    pixels = np.array(Image.open(image).convert('L'))
    width, height = meta['size_pixels']
    resolution = meta['resolution']
    x0, y0, _ = meta['origin']
    bounds = [x0, y0, x0+width*resolution, y0+height*resolution]
    collisions, _ = read_collisions(native.world_file)
    regenerated = raster_floor(collisions, bounds, resolution, entry['floor_z'])
    if pixels.shape != (height, width) or not np.array_equal(pixels, regenerated):
        raise ValueError('repository collision raster does not match registered map')
    root = folder / 'native-assets'
    root.mkdir(exist_ok=False)
    # Ogre2 requires finite vertex normals on these texture-free OBJ visuals.
    # Keep the registered source/collision bytes intact; only the episode copy
    # gains normals. The source's two zero-area visual faces remain in place.
    from .tools.collision_normals import add_normals
    for uri in ET.parse(native.world_file).findall('.//visual/geometry/mesh/uri'):
        source = contained(native.root, str(native.world_file.parent.relative_to(native.root) / uri.text))
        target = root / 'visual-meshes' / source.relative_to(native.root)
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(add_normals(source.read_text(), allow_degenerate=True))
    # These resources are read by the upstream runtime. No writable maps/ledgers
    # or connected-world catalogue are linked into the generated asset tree.
    for name in ('gz', 'live_map.py', 'points_view.py', 'slam_params_v2map.yaml'):
        path = base_root / name
        if path.exists():
            (root / name).symlink_to(path, target_is_directory=path.is_dir())
    mapdir = root / 'maps' / entry['building_id'] / entry['floor_id'] / VERSION
    mapdir.mkdir(parents=True)
    pgm = f'P5\n{width} {height}\n255\n'.encode() + pixels.tobytes()
    (mapdir / 'map.pgm').write_bytes(pgm)
    (mapdir / 'map.yaml').write_text(
        f'image: map.pgm\nmode: trinary\nresolution: {resolution}\norigin: {meta["origin"]}\n'
        'negate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n')
    digest = hashlib.sha256(pgm).hexdigest()
    legacy = dict(schema='v2_map_meta/1', world_id=entry['world_id'], building_id=entry['building_id'],
                  floor_id=entry['floor_id'], epoch=None, map_version=VERSION, map_source='gt_raster',
                  map_frame='map', resolution=resolution, origin=meta['origin'], width=width, height=height,
                  saved_sim_t=None, saved_wall=None, reason='verified static collision raster',
                  sha256_pgm=digest, source_pgm=str(mapdir / 'map.pgm'), source_sha256=digest)
    (mapdir / 'meta.json').write_text(json.dumps(legacy))
    # Actual upward collision surfaces in this floor's body band; unsupported
    # cells remain NaN. Never infer a ground plane from occupancy/free pixels.
    xs = x0 + (np.arange(width)+.5)*resolution
    ys = y0 + (np.arange(height)+.5)*resolution
    hz = np.full((height, width), np.nan)
    for collision in collisions:
        if not collision.closed:
            continue
        for triangle, normal in zip(collision.mesh.triangles, collision.mesh.face_normals):
            if normal[2] <= 1e-10:
                continue
            iy, ix, inside, zz = triangle_samples(triangle, xs, ys)
            inside &= (zz >= entry['floor_z']-.005) & (zz <= entry['floor_z']+.60)
            old = hz[np.ix_(iy, ix)]
            hz[np.ix_(iy, ix)] = np.where(inside, np.fmax(old, zz), old)
    ground = root / 'ground.npz'
    np.savez_compressed(ground, hz=hz, x0=x0, y0=y0, res=resolution)
    runtime_entry = {**entry, 'world': str(native.world_file), 'gt_map': str(mapdir / 'map.yaml'),
                     'heights': str(ground)}
    (root / 'worlds.json').write_text(json.dumps(dict(worlds={native.key: runtime_entry},
        lidar_pose_base=[0, 0, .12], check={'repository_collision_bytes_match': True})))
    return root


def install(runtime, native, folder):
    original_root = Path(runtime['HERE'])
    root = prepare(native, original_root, folder)
    # Preserve the original operating-ledger paths and isolation verification.
    ledgers = runtime['operating_ledgers']()
    runtime['operating_ledgers'] = lambda: ledgers
    runtime['HERE'] = str(root)
    runtime['gt_identity_allowed'] = functools.partial(runtime['gt_identity_allowed'], here=str(root))
    profile = runtime['SP']
    original = profile.world_text
    profile.world_text = lambda text, follow: original(robot_world(text, native, root), follow)

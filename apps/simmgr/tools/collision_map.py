"""Offline static SDF collision rasterizer; numpy/Pillow/trimesh, no ROS or installs.

Explicit floor heights share one XY grid. Free cells need support at all four
corners AND their centre; unsupported cells remain unknown (205). Obstacles are
conservative cell/polygon intersections within the configured body-height band.
Closed, consistently wound meshes also use solid interior winding. Open or
inconsistently wound meshes use a conservative AABB and cannot supply support.
This is a finite-resolution geometric map, not a traversability certification.
"""
import argparse
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
import trimesh

VERSION = 'collision-map/1'
UNKNOWN, FREE, OCCUPIED = 205, 254, 0


def pose_matrix(element):
    if element is None:
        return np.eye(4)
    if (element.get('relative_to') or element.get('frame') or
            element.get('degrees', 'false') != 'false' or
            element.get('rotation_format', 'euler_rpy') != 'euler_rpy'):
        raise ValueError('poses must use local, radian Euler coordinates')
    values = np.fromstring(element.text or '', sep=' ')
    if values.shape != (6,) or not np.isfinite(values).all():
        raise ValueError('pose must contain six finite values')
    x, y, z, roll, pitch, yaw = values
    sr, sp, sy = np.sin([roll, pitch, yaw])
    cr, cp, cy = np.cos([roll, pitch, yaw])
    matrix = np.eye(4)
    matrix[:3, :3] = [[cy*cp, cy*sp*sr-sy*cr, cy*sp*cr+sy*sr],
                      [sy*cp, sy*sp*sr+cy*cr, sy*sp*cr-cy*sr],
                      [-sp, cp*sr, cp*cr]]
    matrix[:3, 3] = [x, y, z]
    return matrix


@dataclass
class Collision:
    mesh: trimesh.Trimesh
    closed: bool


def read_collisions(world_file):
    root = ET.parse(world_file).getroot()
    if root.findall('.//include') or root.findall('.//frame'):
        raise ValueError('expand includes and named frames before rasterizing')
    dependencies = {world_file.resolve()}
    collisions = []

    def visit(model, parent, inherited_static=False):
        static = model.findtext('static', str(inherited_static).lower()) in ('1', 'true')
        if not static:
            raise ValueError('only static models can supply a static map')
        transform = parent @ pose_matrix(model.find('pose'))
        for link in model.findall('link'):
            link_transform = transform @ pose_matrix(link.find('pose'))
            for part in link.findall('collision'):
                geometry = part.find('geometry')
                if geometry is None or len(geometry) != 1:
                    raise ValueError('exactly one collision geometry is required')
                shape = geometry[0]
                if shape.tag == 'box':
                    size = np.fromstring(shape.findtext('size', ''), sep=' ')
                    if size.shape != (3,) or not np.isfinite(size).all() or (size <= 0).any():
                        raise ValueError('box dimensions must be finite and positive')
                    mesh = trimesh.creation.box(extents=size)
                elif shape.tag == 'mesh':
                    if shape.find('submesh') is not None:
                        raise ValueError('submesh selection is not supported')
                    uri = shape.findtext('uri', '')
                    if not uri or '://' in uri or Path(uri).is_absolute():
                        raise ValueError('mesh URI must be a local relative file')
                    path = (world_file.parent / uri).resolve()
                    # Keep the offline input closure inside the world directory.
                    if not path.is_relative_to(world_file.parent.resolve()) or path.suffix != '.obj':
                        raise ValueError('mesh must be a local OBJ inside the world directory')
                    dependencies.add(path)
                    mesh = trimesh.load(path, force='mesh', process=False)
                    scale = np.fromstring(shape.findtext('scale', '1 1 1'), sep=' ')
                    if scale.shape != (3,) or not np.isfinite(scale).all() or (scale <= 0).any():
                        raise ValueError('mesh scale must be finite and positive')
                    mesh.apply_scale(scale)
                else:
                    # Fail closed rather than silently omit unknown collision types.
                    raise ValueError(f'unsupported collision geometry: {shape.tag}')
                mesh.apply_transform(link_transform @ pose_matrix(part.find('pose')))
                if not len(mesh.faces) or not np.isfinite(mesh.vertices).all():
                    raise ValueError('collision must have finite nonempty triangle geometry')
                collisions.append(Collision(mesh, mesh.is_watertight and mesh.is_winding_consistent))
        for child in model.findall('model'):
            visit(child, transform, static)

    world = root.find('world')
    if world is None:
        raise ValueError('expected an SDF world')
    for model in world.findall('model'):
        visit(model, np.eye(4))
    if not collisions:
        raise ValueError('no collisions found')
    return collisions, dependencies


def clip_z(vertices, height, above):
    result = []
    for a, b in zip(vertices, np.roll(vertices, -1, axis=0)):
        a_in = a[2] >= height if above else a[2] <= height
        b_in = b[2] >= height if above else b[2] <= height
        if a_in:
            result.append(a)
        if a_in != b_in:
            result.append(a + (b-a) * ((height-a[2]) / (b[2]-a[2])))
    return np.array(result).reshape(-1, 3)


def polygon_cells(polygon, xs, ys, half_cell):
    """Convex polygon/segment versus grid squares by separating axes."""
    low, high = polygon.min(axis=0), polygon.max(axis=0)
    ix = np.flatnonzero((xs >= low[0]-half_cell-1e-10) & (xs <= high[0]+half_cell+1e-10))
    iy = np.flatnonzero((ys >= low[1]-half_cell-1e-10) & (ys <= high[1]+half_cell+1e-10))
    if not len(ix) or not len(iy):
        return iy, ix, np.zeros((len(iy), len(ix)), dtype=bool)
    xx, yy = np.meshgrid(xs[ix], ys[iy])
    inside = np.ones(xx.shape, dtype=bool)
    for edge in np.roll(polygon, -1, axis=0) - polygon:
        normal = np.array([-edge[1], edge[0]])
        projection = polygon @ normal
        radius = half_cell * np.abs(normal).sum()
        sample = xx*normal[0] + yy*normal[1]
        inside &= (sample >= projection.min()-radius-1e-10)
        inside &= (sample <= projection.max()+radius+1e-10)
    return iy, ix, inside


def triangle_samples(triangle, xs, ys):
    """Return sample indices, XY inclusion and interpolated surface height."""
    polygon = triangle[:, :2]
    iy, ix, _ = polygon_cells(polygon, xs, ys, 0)
    xx, yy = np.meshgrid(xs[ix], ys[iy])
    a, b, c = triangle
    denominator = (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1])
    if abs(denominator) < 1e-14:
        return iy, ix, np.zeros(xx.shape, dtype=bool), np.zeros(xx.shape)
    u = ((b[1]-c[1])*(xx-c[0]) + (c[0]-b[0])*(yy-c[1])) / denominator
    v = ((c[1]-a[1])*(xx-c[0]) + (a[0]-c[0])*(yy-c[1])) / denominator
    inside = (u >= -1e-10) & (v >= -1e-10) & (u+v <= 1+1e-10)
    return iy, ix, inside, u*a[2] + v*b[2] + (1-u-v)*c[2]


def raster_floor(collisions, bounds, resolution, floor_z, body=(0.05, 0.60), support_tolerance=0.005):
    xmin, ymin, xmax, ymax = bounds
    width, height = np.ceil([(xmax-xmin)/resolution, (ymax-ymin)/resolution]).astype(int)
    # Pixel-square outer corners and centres are separate support samples.
    corner_x = xmin + np.arange(width+1)*resolution
    corner_y = ymin + np.arange(height+1)*resolution
    xs, ys = corner_x[:-1]+resolution/2, corner_y[:-1]+resolution/2
    supported_corners = np.zeros((height+1, width+1), dtype=bool)
    supported_centres = np.zeros((height, width), dtype=bool)
    occupied = np.zeros((height, width), dtype=bool)
    zlow, zhigh = floor_z+body[0], floor_z+body[1]
    for collision in collisions:
        mesh = collision.mesh
        if not collision.closed:
            if mesh.bounds[0, 2] <= zhigh and mesh.bounds[1, 2] >= zlow:
                lo, hi = mesh.bounds[:, :2]
                polygon = np.array([lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]])
                iy, ix, mask = polygon_cells(polygon, xs, ys, resolution/2)
                occupied[np.ix_(iy, ix)] |= mask
            continue
        winding = np.zeros(occupied.shape, dtype=np.int32)
        for triangle, normal in zip(mesh.triangles, mesh.face_normals):
            # Only near-horizontal upward surfaces at the explicit floor count.
            if normal[2] > 0.999 and np.max(np.abs(triangle[:, 2]-floor_z)) <= support_tolerance:
                for xx, yy, support in [(corner_x, corner_y, supported_corners),
                                        (xs, ys, supported_centres)]:
                    iy, ix, mask, _ = triangle_samples(triangle, xx, yy)
                    support[np.ix_(iy, ix)] |= mask
            # Solid interiors at the lower slab plane; a tiny deterministic XY
            # offset avoids double counting rays on triangulation seams.
            if triangle[:, 2].min() <= zlow and abs(normal[2]) > 1e-10:
                iy, ix, mask, zz = triangle_samples(triangle, xs+resolution*1.234e-7,
                                                   ys+resolution*2.345e-7)
                winding[np.ix_(iy, ix)] += (mask & (zz < zlow)) * (1 if normal[2] > 0 else -1)
            if triangle[:, 2].min() > zhigh or triangle[:, 2].max() < zlow:
                continue
            clipped = clip_z(clip_z(triangle, zlow, True), zhigh, False)
            if len(clipped):
                iy, ix, mask = polygon_cells(clipped[:, :2], xs, ys, resolution/2)
                occupied[np.ix_(iy, ix)] |= mask
        occupied |= winding != 0
    supported = (supported_centres & supported_corners[:-1, :-1] &
                 supported_corners[1:, :-1] & supported_corners[:-1, 1:] &
                 supported_corners[1:, 1:])
    pixels = np.full((height, width), UNKNOWN, dtype=np.uint8)
    pixels[supported] = FREE
    pixels[occupied] = OCCUPIED
    return np.flipud(pixels)


def generate(world_file, output, floors, resolution=0.05, bounds=None, body=(0.05, 0.60)):
    if (not math.isfinite(resolution) or resolution <= 0 or
            len(body) != 2 or not all(math.isfinite(v) for v in body) or not 0 < body[0] < body[1]):
        raise ValueError('positive finite resolution and ordered positive body band required')
    if not floors or any(not re.fullmatch(r'[A-Za-z0-9_-]+', f) or not math.isfinite(z)
                         for f, z in floors.items()):
        raise ValueError('explicit named finite floor heights required')
    world_file = Path(world_file).resolve()
    collisions, dependencies = read_collisions(world_file)
    if bounds is None:
        vertices = np.concatenate([c.mesh.bounds for c in collisions])
        lo = np.floor(vertices[:, :2].min(axis=0)/resolution)*resolution-resolution
        hi = np.ceil(vertices[:, :2].max(axis=0)/resolution)*resolution+resolution
        bounds = [*lo, *hi]
    if (len(bounds) != 4 or not all(math.isfinite(v) for v in bounds) or
            bounds[0] >= bounds[2] or bounds[1] >= bounds[3]):
        raise ValueError('bounds must be finite xmin ymin xmax ymax')
    dimensions = np.ceil([(bounds[2]-bounds[0])/resolution,
                          (bounds[3]-bounds[1])/resolution]).astype(int)
    if dimensions.prod() > 10_000_000:
        raise ValueError('map exceeds offline raster cell limit')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    hashes = {str(p.relative_to(world_file.parent)): digest(p) for p in sorted(dependencies)}
    dependency_sha = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    result = {'generator_version': VERSION, 'generator_sha256': digest(Path(__file__)),
              'world_sha256': digest(world_file), 'dependency_sha256': dependency_sha,
              'dependencies': hashes, 'resolution': resolution, 'origin': [*bounds[:2], 0.0],
              'size_pixels': dimensions.tolist(), 'size_m': (dimensions*resolution).tolist(),
              'body_band_above_floor_m': list(body), 'support_tolerance_m': 0.005,
              'support_samples': 'four corners and centre; no support remains unknown',
              'open_mesh_policy': 'occupied AABB in body band; never supplies support',
              'pixel_values': {'occupied': OCCUPIED, 'free': FREE, 'unknown': UNKNOWN},
              'pixel_to_world': 'x=xmin+(column+0.5)*resolution; y=ymin+(height-row-0.5)*resolution',
              'floors': {}}
    source_manifest = world_file.parent / 'sources.json'
    if source_manifest.exists():
        result['upstream_revision'] = json.loads(source_manifest.read_text())['revision']
    for name, floor_z in floors.items():
        pixels = raster_floor(collisions, bounds, resolution, floor_z, body)
        Image.fromarray(pixels).save(output / f'{name}.png')
        yaml = (f'image: {name}.png\nmode: trinary\nresolution: {resolution}\n'
                f'origin: [{bounds[0]}, {bounds[1]}, 0.0]\nnegate: 0\n'
                'occupied_thresh: 0.65\nfree_thresh: 0.25\n')
        (output / f'{name}.yaml').write_text(yaml)
        result['floors'][name] = {'floor_z': floor_z, 'image': f'{name}.png', 'yaml': f'{name}.yaml',
                                  'image_sha256': digest(output / f'{name}.png'),
                                  'counts': {key: int((pixels == value).sum()) for key, value in
                                             result['pixel_values'].items()}}
    (output / 'metadata.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('world', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--floor', action='append', required=True, help='id:z; repeat for each floor')
    parser.add_argument('--resolution', type=float, default=0.05)
    parser.add_argument('--bounds', nargs=4, type=float, metavar=('XMIN', 'YMIN', 'XMAX', 'YMAX'))
    args = parser.parse_args()
    floors = {}
    for item in args.floor:
        name, value = item.split(':', 1)
        if name in floors:
            parser.error('duplicate floor id')
        floors[name] = float(value)
    generate(args.world, args.output, floors, args.resolution, args.bounds)

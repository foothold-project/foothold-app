#!/usr/bin/env python3
"""Offline map validation/copy + conservative whole-path GT corridor proof.

No ROS imports. Never modifies source maps/worlds. Outputs must be outside the
source directory and newly created; map payloads are runtime artifacts only.
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import shutil
import sys

MAP_HASHES = {
    'map.pgm': 'f0b026aadbcec29a9d7c11522d62ea20c10d3a1e937cace984ef4728038d0508',
    'map.yaml': '9b0c851a5edcaaf2d93e12adcb75f5d3b45c70928eba2e260f91612a62e04409',
    'meta.json': 'bec5b93450e6b4f5a28e7a60e57120beff3b1982143ed1f82f16dc0f69236576',
}
WORLD_SHA = 'e044f07d6a83491022b3810dff2dab473df19c92153543aff0294640e3163b03'


def map_manifest(source):
    hashes = {name: hashlib.sha256((source/name).read_bytes()).hexdigest() for name in MAP_HASHES}
    if hashes != MAP_HASHES:
        raise ValueError('map source SHA differs from preregistration')
    meta = json.loads((source/'meta.json').read_text())
    if (meta['world_id'], meta['floor_id'], meta['map_version'], meta['resolution'],
            meta['origin'], meta['width'], meta['height']) != (
            'v5_single', 'f1', 'gt-20261012', .05, [-20, -14, 0.0], 800, 640):
        raise ValueError('map/frame metadata mismatch')
    raw = (source/'map.pgm').read_bytes().split(b'\n', 3)
    if raw[:3] != [b'P5', b'800 640', b'255'] or len(raw[3]) != 800*640:
        raise ValueError('unexpected fixed PGM grammar')
    rows = [raw[3][i:i+800] for i in range(0, len(raw[3]), 800)]
    table = bytes(100 if i == 0 else 0 if i == 254 else 255 for i in range(256))
    occupancy_sha = hashlib.sha256(b''.join(reversed(rows)).translate(table)).hexdigest()
    return {'occupancy_sha256': occupancy_sha, 'world': 'v5_single', 'floor': 'f1', 'frame': 'map', 'sha256': hashes}


def copy_map(source, output):
    manifest = map_manifest(source)
    if output.resolve().is_relative_to(source.resolve()):
        raise ValueError('output must be outside the source tree')
    output.mkdir(parents=True, exist_ok=False)
    for name in MAP_HASHES:
        shutil.copyfile(source/name, output/name)
    copied = map_manifest(output)
    if copied != manifest:
        raise ValueError('copied map differs from verified source')
    (output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    return manifest


def proof_function():
    # Reuse the reviewed SDF parser, including unknown-include rejection. No copy
    # of the native runtime and no amendment to existing safety-tool constants.
    folder = Path(__file__).resolve().parents[1]/'sim'
    sys.path.insert(0, str(folder))
    try:
        spec = importlib.util.spec_from_file_location('fh_nav_clearance', folder/'clearance.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.prove
    finally:
        sys.path.remove(str(folder))


class GTWorld:
    """Read/hash/parse world and meshes ONCE, then perform only geometry math.

    Reuse the reviewed parser's structure validation, rotations and support union.
    No global monkeypatch or source write. Pose/path workers share immutable bounds.
    """
    def __init__(self, world):
        data = world.read_bytes()
        if hashlib.sha256(data).hexdigest() != WORLD_SHA:
            raise ValueError('world source SHA differs from preregistration')
        source = proof_function().__globals__
        terrain = source['terrain_model'](source['ET'].fromstring(data))
        self.covered, self.floors, self.obstacles = source['covered'], [], []
        self.hashes = {str(world): WORLD_SHA}
        for link in terrain.findall('link'):
            if set(link.attrib)-{'name'} or any(c.tag not in {'collision', 'visual'} for c in link):
                raise ValueError('unverified link transform')
            for collision in link.findall('collision'):
                pose_el = collision.find('pose')
                if pose_el is not None and pose_el.attrib:
                    raise ValueError('relative collision pose unsupported')
                pose = list(map(float, collision.findtext('pose', '0 0 0 0 0 0').split()))
                geom = collision.find('geometry')
                if len(pose) != 6 or not all(math.isfinite(v) for v in pose) or geom is None or len(geom) != 1:
                    raise ValueError('unverified geometry')
                box = geom.findtext('box/size')
                if box:
                    sizes = list(map(float, box.split()))
                    if len(sizes) != 3 or not all(math.isfinite(v) and v > 0 for v in sizes):
                        raise ValueError('invalid box dimensions')
                    points = list(source['itertools'].product(*[(-v/2, v/2) for v in sizes]))
                elif geom.find('mesh') is not None:
                    mesh = geom.find('mesh')
                    if {e.tag for e in mesh} != {'uri'}:
                        raise ValueError('mesh scale or transform unsupported')
                    uri = source['urlparse'](mesh.findtext('uri'))
                    if uri.scheme != 'file' or uri.netloc:
                        raise ValueError('mesh must be a readable local OBJ')
                    path = Path(source['unquote'](uri.path))
                    if path.suffix != '.obj':
                        raise ValueError('unverified mesh format')
                    raw = path.read_bytes()
                    self.hashes[str(path)] = hashlib.sha256(raw).hexdigest()
                    points = [list(map(float, line.split()[1:4])) for line in raw.decode().splitlines() if line.startswith('v ')]
                else:
                    raise ValueError('unknown collision shape')
                if not points or any(len(v) != 3 or not all(math.isfinite(n) for n in v) for v in points):
                    raise ValueError('empty collision')
                rot = source['rotation'](pose)
                vertices = [[pose[i]+sum(rot[i][j]*v[j] for j in range(3)) for i in range(3)] for v in points]
                bounds = [(min(v[i] for v in vertices), max(v[i] for v in vertices)) for i in range(3)]
                if box and max(abs(a) for a in pose[3:]) < 1e-6 and abs(bounds[2][1]) < .001:
                    self.floors.append((*bounds[0], *bounds[1]))
                elif bounds[2][1] > .02:
                    self.obstacles.append((collision.attrib.get('name'), bounds))

    def pose(self, state, margin=0):
        x, y, z, yaw = (state[k] for k in ('x', 'y', 'z', 'yaw'))
        if not all(type(v) in (int, float) and math.isfinite(v) for v in (x,y,z,yaw)) or not .20 <= z <= .75:
            raise ValueError('invalid actual GT pose')
        cs, sn = math.cos(yaw), math.sin(yaw)
        corners = [(x+f*cs-l*sn, y+f*sn+l*cs) for f in (-.5-margin, 3.5+margin) for l in (-.6-margin, .6+margin)]
        rect = (min(v[0] for v in corners), max(v[0] for v in corners), min(v[1] for v in corners), max(v[1] for v in corners))
        return self.rectangle(rect)

    def rectangle(self, rect):
        hits = [name for name, b in self.obstacles if not
                (b[0][1] < rect[0] or b[0][0] > rect[1] or b[1][1] < rect[2] or b[1][0] > rect[3])]
        support = self.covered(rect, self.floors)
        return {'pass': not hits and support, 'flat_support_complete': support,
                'obstacle_intersections': hits, 'conservative_world_rectangle': rect}

    def path(self, actual, goal, trace, *, spacing=.05, deviation=.05, heading_tolerance=math.pi/12):
        # A cell-scale NavFn wobble is NOT interpreted as a commanded curve.
        # Prove the actual->goal straight sweep with an additional deviation
        # envelope, then require every trace vertex inside that envelope.
        dx, dy = goal['x']-actual['x'], goal['y']-actual['y']
        distance = math.hypot(dx, dy)
        if not trace or not 0 < spacing <= .05 or not 0 <= deviation <= .05 or not 0 < distance <= 3:
            return {'pass': False, 'reason': 'INVALID_OR_TOO_LONG_TRACE'}
        heading = math.atan2(dy, dx)
        delta = abs(math.atan2(math.sin(heading-actual['yaw']), math.cos(heading-actual['yaw'])))
        if delta > heading_tolerance:
            return {'pass': False, 'reason': 'CURVE_OR_REVERSE_SWEEP_UNVERIFIED'}
        maximum = 0
        for point in trace:
            px, py = point['x']-actual['x'], point['y']-actual['y']
            along, cross = (px*dx+py*dy)/distance, abs(px*dy-py*dx)/distance
            if not all(math.isfinite(v) for v in (along, cross)) or cross > deviation or not -deviation <= along <= distance+deviation:
                return {'pass': False, 'reason': 'TRACE_OUTSIDE_STRAIGHT_ENVELOPE'}
            maximum = max(maximum, cross)
        count = max(1, math.ceil(distance/spacing))
        first = self.pose(actual, margin=deviation)['conservative_world_rectangle']
        last = self.pose({**actual, 'x': goal['x'], 'y': goal['y']}, margin=deviation)['conservative_world_rectangle']
        # One bounding rectangle encloses EVERY intermediate footprint. Unlike
        # sampled rectangles, this also proves the diagonal strips between them.
        continuous = (min(first[0],last[0]),max(first[1],last[1]),min(first[2],last[2]),max(first[3],last[3]))
        proof = self.rectangle(continuous)
        return {**proof, 'endpoint_envelopes': 2, 'map_cell_intervals': count,
                'spacing_m': spacing, 'trace_max_deviation_m': maximum, 'margin_m': deviation,
                'world_sha': WORLD_SHA, 'source_sha256': self.hashes,
                'method': 'continuous straight swept bounding rectangle plus bounded trace-deviation envelope'}



def swept(world, points, *, spacing=.05):
    geometry = GTWorld(world)
    if not points:
        raise ValueError('nonempty path required')
    return geometry.path(points[0], points[-1], points, spacing=spacing)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--map-source', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    print(json.dumps(copy_map(args.map_source, args.output), indent=2))


if __name__ == '__main__':
    main()

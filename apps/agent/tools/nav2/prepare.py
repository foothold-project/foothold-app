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


def swept(world, points, *, spacing=.05):
    if hashlib.sha256(world.read_bytes()).hexdigest() != WORLD_SHA:
        raise ValueError('world source SHA differs from preregistration')
    if not points or not 0 < spacing <= .05:
        raise ValueError('nonempty path and <= map-cell spacing required')
    prove = proof_function()
    samples = [points[0]]
    for start, end in zip(points, points[1:]):
        dx, dy = end['x']-start['x'], end['y']-start['y']
        heading = math.atan2(dy, dx)
        if (abs(math.atan2(math.sin(end['yaw']-start['yaw']), math.cos(end['yaw']-start['yaw']))) > 1e-6
                or abs(math.atan2(math.sin(heading-start['yaw']), math.cos(heading-start['yaw']))) > 1e-6):
            return {'pass': False, 'reason': 'CURVE_OR_REVERSE_SWEEP_UNVERIFIED'}
        count = max(1, math.ceil(math.hypot(dx, dy)/spacing))
        samples.extend({**start, 'x': start['x']+dx*i/count, 'y': start['y']+dy*i/count}
                       for i in range(1, count+1))
    proofs = [prove(world, point) for point in samples]
    return {'pass': all(p['pass'] for p in proofs), 'samples': len(proofs),
            'spacing_m': spacing, 'proofs': proofs, 'world_sha': WORLD_SHA,
            'method': 'straight swept path, .05m sampling; each sample encloses 3m ahead + .5m front/back and .6m sides'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--map-source', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    print(json.dumps(copy_map(args.map_source, args.output), indent=2))


if __name__ == '__main__':
    main()

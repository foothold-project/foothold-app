"""Child-only compatibility entrypoint for a verified native catalogue target.

The upstream helper is unmodified on disk. Only its TARGET is replaced, after
membership, realpath and SHA checks; all its other gates execute unchanged.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace

# Also supports the absolute script path used in the isolated systemd unit.
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from apps.simmgr.native_catalogue import resolve_native_world


def verified_helper(source, manifest, argv):
    data = json.loads(manifest.read_text())
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--world-id', required=True)
    parser.add_argument('--floor-id', required=True)
    args, _ = parser.parse_known_args(argv)
    if f'{args.world_id}/{args.floor_id}' != data['key']:
        raise ValueError('world/floor does not match cleared target')
    world = SimpleNamespace(id=data['key'], world_file=Path(data['world_file']), map_file=Path(data['map_file']))
    native = resolve_native_world(world, {world.id: world}, Path(data['root']))
    if native.hashes(source) != data['hashes']:
        raise ValueError('native catalogue/world/map/helper SHA mismatch')
    # Load only the established helper after verification, before TARGET assignment.
    spec = importlib.util.spec_from_file_location('sensor_isolation', source / 'sensor_isolation.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper.TARGET = native.target
    return helper


def main(argv=None):
    source_arg, manifest_arg, *runtime_args = sys.argv[1:] if argv is None else argv
    source = Path(source_arg)
    helper = verified_helper(source, Path(manifest_arg), runtime_args)
    sys.modules['sensor_isolation'] = helper
    runtime = source / 'live_map.py'
    sys.argv = [str(runtime), *runtime_args]
    runpy.run_path(str(runtime), run_name='__main__')


if __name__ == '__main__':
    main()

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
    roots = [Path(r) for r in data.get('roots', [data['root']])]
    native = resolve_native_world(world, {world.id: world}, roots[0],
                                  roots[1] if len(roots) > 1 else None)
    if native.hashes(source) != data['hashes']:
        raise ValueError('native catalogue/world/map/helper SHA mismatch')
    if native.key.startswith('v5_building/'):
        from apps.simmgr.connected_assets import verify_bindings
        verify_bindings(native.root, data.get('map_bindings', []))
    if native.repository:
        from apps.simmgr.repo_runtime import verify_bindings
        verify_bindings(native, data.get('map_bindings', []))
    # Load only the established helper after verification, before TARGET assignment.
    spec = importlib.util.spec_from_file_location('sensor_isolation', source / 'sensor_isolation.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    helper.TARGET = native.target
    helper.FH_NATIVE_WORLD = native
    return helper


def main(argv=None):
    source_arg, manifest_arg, *runtime_args = sys.argv[1:] if argv is None else argv
    source = Path(source_arg)
    helper = verified_helper(source, Path(manifest_arg), runtime_args)
    sys.modules['sensor_isolation'] = helper
    runtime = source / 'live_map.py'
    sys.argv = [str(runtime), *runtime_args]
    if helper.FH_NATIVE_WORLD.repository:
        from apps.simmgr.repo_runtime import install, single_floor_status
        from apps.simmgr.connected_runtime import compile_static_runtime, write_run_identity
        scope = dict(__name__='fh_catalogued_runtime', __file__=str(runtime),
            _fh_single_floor_status=single_floor_status, _fh_run_identity=write_run_identity)
        exec(compile_static_runtime(runtime.read_text(), str(runtime), warehouse=True), scope)
        install(scope, helper.FH_NATIVE_WORLD, Path(manifest_arg).parent)
        raise SystemExit(scope['main']())
    if helper.FH_NATIVE_WORLD.key.startswith('v5_building/'):
        from apps.simmgr.connected_runtime import run_static_runtime
        return run_static_runtime(runtime, runtime_args)
    runpy.run_path(str(runtime), run_name='__main__')


if __name__ == '__main__':
    main()

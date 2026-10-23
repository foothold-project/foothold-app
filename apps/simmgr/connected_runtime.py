"""Thin static-only adapter around the established sensor runtime.

Two nested map selection functions are transplanted from connected_static, and
the existing native run nonce is exported immediately after its creation.
The existing sensor, isolation, STOP, TTL and process ownership code runs intact.
No ROS imports or runtime execution occur while building/verifying this adapter.
"""
import ast
from copy import deepcopy
import json
from pathlib import Path
import sys

from . import connected


def write_run_identity(out, run_id):
    """Publish the native nonce before Gazebo starts; manifest is exit evidence.

    The runtime creates a fresh output directory before generating RUN_ID. Its
    supervisor's live identity cannot become ready until after this file closes.
    Never generate a second nonce or substitute the output directory's name.
    """
    with (Path(out) / 'run-identity.json').open('x') as stream:
        json.dump(dict(run_id=run_id), stream)


def decorate_status(status, selection):
    """Use the same captured static selection as publish_status's floor snapshot."""
    meta = selection.get('meta') if isinstance(selection, dict) else None
    meta = meta or {}
    status['source_pgm_sha256'] = meta.get('sha256_pgm')
    status['map_origin'] = meta.get('origin')
    return status


def compile_static_runtime(source, filename, *, warehouse=False):
    """Fail closed when the source no longer offers the known adapter points."""
    tree = ast.parse(source, filename=filename)
    main = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main'), None)
    if main is None:
        raise ValueError('connected static runtime main missing')
    copied = ast.parse(Path(__file__).with_name('connected_static.py').read_text())
    replacements = {n.name: n for n in copied.body if isinstance(n, ast.FunctionDef)}
    found = set()
    gate_count = 0
    identity_count = 0
    body = []
    for node in main.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'RUN_ID'):
            if ast.dump(node.value) != ast.dump(ast.parse('uuid.uuid4().hex', mode='eval').body):
                raise ValueError('connected static runtime run identity hook changed')
            identity_count += 1
            body.extend([node, ast.copy_location(
                ast.parse('_fh_run_identity(a.out, RUN_ID)').body[0], node)])
            continue
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'gate'):
            # Preserve the pure Gate: static boot/reset also call gate.close().
            gate_count += 1
        if isinstance(node, ast.FunctionDef) and node.name in replacements:
            node = deepcopy(replacements[node.name])
            found.add(node.name)
        body.append(node)
    main.body = body
    if identity_count != 1:
        raise ValueError('connected static runtime run identity hook changed')
    if found != set(replacements) or gate_count != 1:
        raise ValueError('connected static runtime selection hooks changed')

    class Status(ast.NodeTransformer):
        count = 0
        def visit_Expr(self, node):
            if (isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute)
                    and isinstance(node.value.func.value, ast.Name)
                    and node.value.func.value.id == 'pub_status' and node.value.func.attr == 'publish'):
                self.count += 1
                before = ast.parse("st = _fh_single_floor_status(st, static_meta)" if warehouse else
                    "st = _fh_floor_status(st, sel) if CONN and a.map_mode == 'static' else st").body[0]
                return [ast.copy_location(before, node), node]
            return self.generic_visit(node)
    status = Status()
    tree = status.visit(tree)
    if status.count != 1:
        raise ValueError('connected static runtime status hook changed')
    ast.fix_missing_locations(tree)
    return compile(tree, filename, 'exec')


def run_static_runtime(path, argv):
    # Source/assets were rehashed by native_entrypoint before any external import.
    if '--map-mode' not in argv or argv[argv.index('--map-mode') + 1] != 'static':
        raise ValueError('connected adapter supports static GT only')
    code = compile_static_runtime(path.read_text(), str(path))
    sys.modules['connected'] = connected
    sys.argv = [str(path), *argv]
    scope = dict(__name__='__main__', __file__=str(path), _fh_floor_status=decorate_status,
                 _fh_run_identity=write_run_identity)
    exec(code, scope)

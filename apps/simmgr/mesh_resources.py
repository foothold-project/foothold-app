"""Offline closure of the pinned Go2 model; no ROS, Gazebo or process calls.

Keep sealed generator inputs intact. Only episode copies lose obsolete build
URIs; relative mesh paths are resolved beside the copied model, without Fuel.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

from .native_catalogue import WorldValidationError

MODEL = 'go2_v2_l1d435i_c2min'
PROFILE = 'l1-d435i-c2-min'
MESHES = frozenset(('trunk.dae', 'hip.dae', 'thigh.dae', 'thigh_mirror.dae', 'calf.dae'))


def file_at(root, relative):
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file() or path.stat().st_size == 0:
        raise WorldValidationError('mesh resource missing or outside declared root')
    return path


def portable_model(source):
    source = Path(source)
    model = file_at(source, f'out/{PROFILE}/model/{MODEL}/model.sdf')
    tree = ET.parse(model)
    resources = {}
    for uri in tree.findall('.//uri'):
        value = uri.text or ''
        parsed = urlsplit(value)
        path = Path(parsed.path)
        # Match the known build suffix, never guess an arbitrary basename.
        if (parsed.scheme != 'file' or parsed.netloc or parsed.query or parsed.fragment
                or not path.is_absolute() or '..' in path.parts
                or path.parts[-5:-1] != ('gz', 'model', 'out', 'meshes')
                or path.name not in MESHES):
            raise WorldValidationError('unapproved Go2 mesh URI')
        resources[path.name] = file_at(source.parents[2], 'gz/model/out/meshes/' + path.name)
        uri.text = 'meshes/' + path.name
    if set(resources) != MESHES:
        raise WorldValidationError('Go2 mesh closure incomplete')
    text = ET.tostring(tree.getroot(), encoding='unicode')
    if re.search(r'file://|/home/|/Users/|/workspaces/|/Desktop/', text):
        raise WorldValidationError('generated model contains a build path')
    return text, resources


def check_world(text, directory):
    """Check every URI, recursively expanding local includes, without search paths."""
    seen = set()

    def visit(body, parent):
        tree = ET.fromstring(body)
        includes = {id(u) for u in tree.findall('.//include/uri')}
        for uri in tree.findall('.//uri'):
            value = uri.text or ''
            parsed = urlsplit(value)
            if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or '..' in Path(value).parts:
                raise WorldValidationError('world URI requires an explicit local file')
            path = Path(value)
            if not path.is_absolute():
                path = Path(parent) / path
            if not path.is_file() or path.stat().st_size == 0:
                raise WorldValidationError('world URI does not resolve to a nonempty file')
            if id(uri) in includes:
                path = path.resolve()
                if path in seen:
                    raise WorldValidationError('cyclic world include')
                seen.add(path)
                visit(path.read_text(), path.parent)
                seen.remove(path)
    visit(text, directory)


def preflight(source, world):
    text, resources = portable_model(source)
    check_world(Path(world).read_text(), Path(world).parent)
    return dict(schema=1, mesh_files=len(resources), model_uris=len(ET.fromstring(text).findall('.//uri')),
                build_paths=0, native_started=False)


def episode_model(source, folder):
    text, resources = portable_model(source)
    model = Path(folder) / 'robot-model' / MODEL / 'model.sdf'
    (model.parent / 'meshes').mkdir(parents=True)
    for name, path in resources.items():
        shutil.copyfile(path, model.parent / 'meshes' / name)
    model.write_text(text)
    check_world(text, model.parent)
    return model


def bind_model(text, model):
    tree = ET.fromstring(text)
    includes = tree.findall(f".//include/uri[.='model://{MODEL}']")
    if len(includes) != 1:
        raise WorldValidationError('expected exactly one sensor robot include')
    includes[0].text = str(model)
    result = ET.tostring(tree, encoding='unicode')
    check_world(result, model.parent)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--world', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(preflight(args.source, args.world), sort_keys=True))


if __name__ == '__main__':
    main()

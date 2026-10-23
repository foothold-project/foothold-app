"""Resolve an explicitly provisioned world/floor before any native launch work."""
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

REPO_WORLDS = Path(__file__).resolve().parent / 'worlds'


class WorldValidationError(ValueError):
    """Only a proven pre-launch catalogue rejection may bypass the failure latch."""
    def __init__(self, message, code='SIM_WORLD_INVALID'):
        self.code = code
        super().__init__(message)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def contained(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise WorldValidationError('native asset missing or path escapes catalogue root')
    return path


@dataclass(frozen=True)
class NativeWorld:
    key: str
    root: Path
    world_file: Path
    map_file: Path
    roots: tuple[Path, Path]
    entry: dict
    repository: bool
    assets: tuple[Path, ...] = ()

    @property
    def target(self):
        world, floor = self.key.split('/')
        return dict(world_id=world, floor_id=floor, map_mode='static')

    def resolve_again(self, world):
        return resolve_native_world(world, {world.id: world}, self.roots[0], self.roots[1])

    def hashes(self, source):
        files = {'catalogue': self.root / 'worlds.json', 'world': self.world_file,
                 'map': self.map_file, 'helper': source / 'sensor_isolation.py'}
        files.update({str(p): p for p in self.assets})
        files.update({str(r / 'worlds.json'): r / 'worlds.json'
                      for r in self.roots if (r / 'worlds.json').is_file()})
        if self.key.startswith('v5_building/'):
            from .connected_assets import connected_files
            files.update(connected_files(self.root))
            files['sensor_runtime'] = source / 'live_map.py'
            for name in ('connected.py', 'connected_static.py', 'connected_runtime.py', 'connected_assets.py', 'native_entrypoint.py'):
                files['adapter_' + name] = Path(__file__).with_name(name)
        if self.repository:
            files['sensor_runtime'] = source / 'live_map.py'
            files['map_codec'] = Path(__file__).resolve().parents[1] / 'server/fh_server/map_files.py'
            for name in ('repo_runtime.py', 'connected_runtime.py', 'connected_static.py', 'native_entrypoint.py'):
                files['adapter_' + name] = Path(__file__).with_name(name)
        return {name: sha256(path) for name, path in files.items()}


def resolve_native_world(world, provisioned, root, repo_root=None):
    try:
        repository = Path(REPO_WORLDS if repo_root is None else repo_root).absolute()
        if repository.resolve() != repository:
            raise WorldValidationError('repository worlds root must not escape through symlinks')
        return _resolve(world, provisioned, Path(root).resolve(), repository)
    except WorldValidationError:
        raise
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
        raise WorldValidationError('native catalogue invalid or unreadable') from error


def _resolve(world, provisioned, root, repo_root):
    # Membership, ambiguity, identity and every realpath precede asset hashing.
    configured = provisioned.get(world.id)
    if configured is None:
        raise WorldValidationError('world/floor not in configured catalogue', 'SIM_WORLD_UNKNOWN')
    if not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_-]+', world.id):
        raise WorldValidationError('invalid native world/floor id')
    roots = (root, repo_root)
    matches = []
    for candidate in dict.fromkeys(roots):
        catalogue = candidate / 'worlds.json'
        if catalogue.exists():
            contained(candidate, 'worlds.json')
            entries = json.loads(catalogue.read_text())['worlds']
            if not isinstance(entries, dict):
                raise WorldValidationError('native catalogue worlds must be an object')
            if world.id in entries:
                matches.append((candidate, entries[world.id]))
    if len(matches) > 1:
        raise WorldValidationError('ambiguous native catalogue world/floor key')
    if not matches:
        raise WorldValidationError('world/floor not in native static catalogue', 'SIM_WORLD_UNKNOWN')
    selected, entry = matches[0]
    if not isinstance(entry, dict):
        raise WorldValidationError('native catalogue entry must be an object')
    if not entry.get('world') or not entry.get('gt_map'):
        raise WorldValidationError('world/floor not in native static catalogue', 'SIM_WORLD_UNKNOWN')
    world_id, floor_id = world.id.split('/')
    if entry.get('world_id', world_id) != world_id or entry.get('floor_id', floor_id) != floor_id:
        raise WorldValidationError('native catalogue world/floor identity mismatch')
    world_file = contained(selected, entry['world'])
    map_file = contained(selected, entry['gt_map'])
    if any(w.world_file.resolve() != world_file or w.map_file.resolve() != map_file
           for w in (configured, world)):
        raise WorldValidationError('configured world/map pair does not match native catalogue')
    assets = []
    repository = selected == repo_root
    if repository:
        if not isinstance(entry.get('building_id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]+', entry['building_id']):
            raise WorldValidationError('invalid native building id')
        metadata = contained(selected, entry['map_metadata'])
        meta = json.loads(metadata.read_text())
        floor = meta['floors'][floor_id]
        image = contained(selected, str(map_file.parent.relative_to(selected) / floor['image']))
        uris = {u.text for u in ET.parse(world_file).findall('.//uri')}
        if uris != set(entry['mesh_sha256']) or any('://' in u for u in uris):
            raise WorldValidationError('native world mesh closure mismatch')
        meshes = [(contained(selected, str(world_file.parent.relative_to(selected) / name)), digest)
                  for name, digest in entry['mesh_sha256'].items()]
        dependencies = [(contained(selected, str(world_file.parent.relative_to(selected) / name)), digest)
                        for name, digest in meta['dependencies'].items()]
        pose = [*entry['spawn_xyyaw'], entry['spawn_z'], entry['floor_z']]
        if (len(pose) != 5 or not all(type(v) in (int, float) and math.isfinite(v) for v in pose)
                or entry['floor_z'] != floor['floor_z']
                or map_file.name != floor['yaml']):
            raise WorldValidationError('native catalogue spawn/floor metadata mismatch')
        expected = entry['sha256']
        checks = [(world_file, expected['world']), (map_file, expected['map']),
                  (metadata, expected['metadata']), (world_file, meta['world_sha256']),
                  (image, floor['image_sha256']), *dependencies, *meshes]
        if any(sha256(path) != digest for path, digest in checks):
            raise WorldValidationError('native catalogue asset SHA mismatch')
        assets = list(dict.fromkeys([metadata, image, *(p for p, _ in dependencies), *(p for p, _ in meshes)]))
    if world_id == 'v5_building':
        from .connected_assets import connected_files
        assets.extend(connected_files(selected).values())
    return NativeWorld(world.id, selected, world_file, map_file, roots, entry,
                       repository, tuple(assets))

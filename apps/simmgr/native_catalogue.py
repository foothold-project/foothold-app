"""Resolve an explicitly provisioned world/floor before any native launch work."""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@dataclass(frozen=True)
class NativeWorld:
    key: str
    root: Path
    world_file: Path
    map_file: Path

    @property
    def target(self):
        world, floor = self.key.split('/')
        return dict(world_id=world, floor_id=floor, map_mode='static')

    def hashes(self, source):
        return {name: sha256(path) for name, path in {
            'catalogue': self.root / 'worlds.json', 'world': self.world_file,
            'map': self.map_file, 'helper': source / 'sensor_isolation.py'}.items()}


def resolve_native_world(world, provisioned, root):
    # Fail precisely before hashing, allocating evidence or constructing a unit.
    configured = provisioned.get(world.id)
    if configured is None:
        raise ValueError('world/floor not in configured catalogue')
    if not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_-]+', world.id):
        raise ValueError('invalid native world/floor id')
    entry = json.loads((root / 'worlds.json').read_text())['worlds'].get(world.id)
    if entry is None or not entry.get('world') or not entry.get('gt_map'):
        raise ValueError('world/floor not in native static catalogue')
    world_id, floor_id = world.id.split('/')
    if entry.get('world_id', world_id) != world_id or entry.get('floor_id', floor_id) != floor_id:
        raise ValueError('native catalogue world/floor identity mismatch')
    native = NativeWorld(world.id, root, (root / entry['world']).resolve(),
                         (root / entry['gt_map']).resolve())
    if any(w.world_file.resolve() != native.world_file or w.map_file.resolve() != native.map_file
           for w in (configured, world)):
        raise ValueError('configured world/map pair does not match native catalogue')
    return native

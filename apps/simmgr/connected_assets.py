"""Private connected assets: validate both canonical grids before native launch."""
import hashlib
import json
from pathlib import Path

from apps.server.fh_server.map_files import map_yaml


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def local(root, relative):
    path = (root / relative).resolve(strict=True)
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('connected asset escapes native catalogue')
    return path


def connected_files(root):
    root = Path(root)
    catalogue = json.loads((root/'worlds.json').read_text())
    cat = json.loads((root/'connected/connected.json').read_text())
    entry = cat.get('worlds', {}).get('v5_building', {})
    if (cat.get('schema') != 'v2_connected_catalog/1'
            or set(entry.get('floors', [])) != {'l1', 'l2'}):
        raise ValueError('both connected floors must be provisioned')
    files = {'connected_catalogue': root/'connected/connected.json'}
    for key in ('cols', 'geom'):
        path = local(root, 'connected/' + entry[key])
        if digest(path) != entry[key + '_sha256']:
            raise ValueError('connected geometry SHA mismatch')
        files['connected_' + key] = path
    geom = json.loads(files['connected_geom'].read_text())
    if (geom.get('schema') != 'v2_building_geom/1' or geom.get('world_id') != 'v5_building'
            or geom.get('building_id') != entry['building_id']):
        raise ValueError('connected geometry identity mismatch')
    for floor in ('l1', 'l2'):
        target = catalogue['worlds']['v5_building/' + floor]
        if (target.get('world_id') != 'v5_building' or target.get('floor_id') != floor
                or target.get('building_id') != entry['building_id']):
            raise ValueError('connected world identity mismatch')
        for kind, key in [('world', 'world'), ('heights', 'heights'), ('yaml', 'gt_map')]:
            files[f'{floor}_{kind}'] = local(root, target[key])
        if geom.get('sdf_sha256', {}).get(floor) != digest(files[f'{floor}_world']):
            raise ValueError('connected world/geometry SHA mismatch')
        yaml_path = files[f'{floor}_yaml']
        files[f'{floor}_meta'] = local(root, str(yaml_path.relative_to(root).parent/'meta.json'))
        yaml = map_yaml(yaml_path.read_bytes())
        files[f'{floor}_pgm'] = local(root, str(yaml_path.relative_to(root).parent/yaml['image']))
        meta = json.loads(files[f'{floor}_meta'].read_text())
        if (meta.get('world_id') != 'v5_building' or meta.get('floor_id') != floor
                or meta.get('building_id') != entry['building_id'] or meta.get('map_frame') != 'map'
                or meta.get('map_source') != 'gt_raster' or meta.get('epoch') is not None
                or meta.get('sha256_pgm') != digest(files[f'{floor}_pgm'])
                or meta.get('source_sha256') != digest(files[f'{floor}_pgm'])
                or meta.get('resolution') != yaml['resolution'] or meta.get('origin') != yaml['origin']):
            raise ValueError('connected canonical GT mismatch')
    return files


def verify_bindings(root, bindings):
    files = connected_files(root)
    if len(bindings) != 2 or {b['ros_floor_id'] for b in bindings} != {'l1', 'l2'}:
        raise ValueError('both connected map bindings required')
    if len({b['building_id'] for b in bindings}) != 1:
        raise ValueError('connected bindings span buildings')
    for binding in bindings:
        floor = binding['ros_floor_id']
        meta = json.loads(files[f'{floor}_meta'].read_text())
        checks = dict(world_id=meta['world_id'], ros_building_id=meta['building_id'],
            ros_map_version=meta['map_version'], source_pgm_sha256=meta['sha256_pgm'],
            resolution=meta['resolution'], origin=meta['origin'], width=meta['width'], height=meta['height'],
            source='SIMULATION')
        if any(binding.get(key) != value for key, value in checks.items()):
            raise ValueError('approved binding differs from native GT')
    return files

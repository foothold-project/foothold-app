"""Explicit, opt-in import of reviewed static worlds; never launches a simulator."""
import argparse
import json
import math
import os
import re
import struct
from pathlib import Path
from uuid import UUID, uuid5

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from apps.contracts import models as C
from .map_files import MAX_IMAGE, gray_pixels, map_yaml, png_image, pgm_png, sha256, yaml_bytes
from .maps import refresh_connectors
from .models import (Building, Event, Floor, MapVersion, Mission, MissionVersion,
                     Organization, Scenario, ScenarioVersion, Site, Terrain, Upload, User, now)
from .resource_archive import require_unused

NAMESPACE = UUID('7cf30f97-697d-4f02-a196-635970db0246')
WORLD_FOLDER = Path(__file__).resolve().parents[2] / 'simmgr/worlds'


def supported_world_ids(prepared=None):
    """Packaged worlds plus the separately imported connected v5 building.

    This is world identity, not launcher readiness or a map-image allowlist.
    Invalid/missing/empty catalogues raise before any archive operation.
    """
    if prepared is None:
        prepared = load_worlds(WORLD_FOLDER)
    if not prepared:
        raise ValueError('Static world catalogue must not be empty')
    return {entry['world_id'] for entry, *_ in prepared} | {'v5_building'}


def archive_removed_worlds(db, world_ids, *, org_id=None, migration=None):
    """Archive unused orphan world floors; retain maps, scenarios and terrain pairs."""
    from .terrains import identifier as terrain_identifier

    organizations = select(Organization).where(Organization.id.in_(
        select(Site.org_id).where(Site.purpose == 'SIM')))
    if org_id is not None:
        organizations = organizations.where(Organization.id == org_id)
    list(db.scalars(organizations.order_by(Organization.id).with_for_update()))
    candidates = select(Building).join(Site, Site.id == Building.site_id).where(
        Site.purpose == 'SIM', Building.sim_world_id.is_not(None),
        Building.sim_world_id.not_in(world_ids))
    if org_id is not None:
        candidates = candidates.where(Building.org_id == org_id)
    buildings = list(db.scalars(candidates.order_by(Building.id)))
    logs = []
    context = {'migration': migration} if migration else {'origin': 'sync_worlds'}

    class InUse(Exception):
        pass

    def reject(*args):
        raise InUse()

    def archive(row, reason):
        if row.archived_at is not None:
            return
        row.archived_at = now()
        data = dict(kind=row.__tablename__, id=str(row.id), org_id=str(row.org_id),
            reason=reason, before={'archived_at': None},
            after={'archived_at': row.archived_at.isoformat()})
        data.update(context)
        db.add(Event(org_id=row.org_id, category='ACCOUNT', code='SIM_PAIR_REPAIRED',
            severity='INFO', message='시뮬 지형·지도 짝 정리', data=data))
        logs.append(data)

    for building in buildings:
        floors = list(db.scalars(select(Floor).where(Floor.org_id == building.org_id,
            Floor.building_id == building.id, Floor.archived_at.is_(None))
            .order_by(Floor.id).with_for_update()))
        for floor in floors:
            if floor.provenance != 'SIMULATION':
                continue
            terrain = db.get(Terrain, (floor.terrain_id, floor.org_id)) if floor.terrain_id else None
            if terrain is not None and terrain.archived_at is None:
                maps = db.execute(select(Upload.metadata_json).join(MapVersion,
                    (MapVersion.org_id == Upload.org_id) & (MapVersion.upload_id == Upload.id)).where(
                    MapVersion.org_id == floor.org_id, MapVersion.floor_id == floor.id,
                    MapVersion.source == 'IMPORT', MapVersion.provenance == 'SIMULATION',
                    MapVersion.status == 'APPROVED'))
                if any(meta.get('terrain_id') == terrain.id and meta.get('terrain_version') == terrain.version
                        and meta.get('terrain_spec') == terrain.spec for meta in maps.scalars()):
                    continue
            try:
                require_unused(db, floor.org_id, reject, floor=floor)
            except InUse:
                logs.append(dict(context, kind='floors', id=str(floor.id), org_id=str(floor.org_id),
                    reason='in_use_preserved'))
                continue
            archive(floor, 'removed_world_no_live_pair')
            db.flush()
            refresh_connectors(db, floor)
        if db.scalar(select(Floor.id).where(Floor.building_id == building.id,
                Floor.archived_at.is_(None)).limit(1)) is None:
            archive(building, 'no_live_floors')
    db.flush()
    for site_id in {building.site_id for building in buildings}:
        site = db.get(Site, site_id)
        if site.id == terrain_identifier(site.org_id, 'site'):
            continue
        if db.scalar(select(Floor.id).join(Building, Building.id == Floor.building_id).where(
                Building.site_id == site.id, Floor.archived_at.is_(None)).limit(1)) is None:
            archive(site, 'no_live_floors')
    db.flush()
    return logs


def identifier(org_id, key):
    return uuid5(NAMESPACE, str(org_id) + '/' + key)


def local_file(root, path):
    result = (root / path).resolve(strict=True)
    if not result.is_relative_to(root.resolve()):
        raise ValueError('World asset escapes catalogue directory')
    return result


MAX_MODEL = 64 * 1024 * 1024


def load_model(root, entry, metadata, width, height):
    """Optional per-floor GLB: declared path + sha256.model, checked before DB writes.

    Returns (bytes, None) to attach, (None, None) when nothing is declared or the
    file is absent (GLBs are not committed), or (None, {reason, sha256}) when a
    present file fails a check: the floor then drops to 2D only and the sync
    records why.
    A malformed declaration or a path outside the catalogue fails the sync.
    """
    name = entry.get('model')
    if name is None:
        return None, None
    digest = entry.get('sha256', {}).get('model')
    if not isinstance(name, str) or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('World model needs a path and lowercase hex sha256.model')
    try:
        path = local_file(root, name)
    except FileNotFoundError:
        return None, None
    if not path.is_file() or path.stat().st_size > MAX_MODEL:
        return None, {'reason': 'not a file or larger than 64 MiB', 'sha256': None}
    data = path.read_bytes()
    actual = sha256(data).hex()
    if actual != digest:
        return None, {'reason': 'sha256 differs from worlds.json', 'sha256': actual}
    try:
        check_model_frame(data, entry['floor_id'], entry['floor_z'], metadata, width, height)
    except (ValueError, KeyError, IndexError, TypeError, struct.error, json.JSONDecodeError) as error:
        return None, {'reason': str(error) or type(error).__name__, 'sha256': actual}
    return data, None


def check_model_frame(data, floor_id, floor_z, metadata, width, height):
    """The `<floor>_floor` node, glTF Y-up mapped to world (x, -z, y), lies in the map
    and its top face is the catalogue floor_z (within 1 cm).

    Uses only the GLB JSON chunk (node transforms + POSITION accessor min/max),
    so a flipped y sign lands outside the asymmetric map extent and is refused.
    """
    if data[:4] != b'glTF' or struct.unpack_from('<I', data, 4)[0] != 2:
        raise ValueError('not a glTF 2 binary')
    length, kind = struct.unpack_from('<II', data, 12)
    if kind != 0x4E4F534A:
        raise ValueError('first GLB chunk is not JSON')
    gltf = json.loads(data[20:20 + length])
    nodes = gltf['nodes']
    found = [i for i, node in enumerate(nodes) if node.get('name') == floor_id + '_floor']
    if len(found) != 1 or 'mesh' not in nodes[found[0]]:
        raise ValueError(f'needs exactly one mesh node {floor_id}_floor')
    parent = {child: i for i, node in enumerate(nodes) for child in node.get('children', [])}
    matrix, index, depth = node_matrix(nodes[found[0]]), found[0], 0
    while index in parent and depth < len(nodes):
        index, depth = parent[index], depth + 1
        matrix = multiply(node_matrix(nodes[index]), matrix)
    low, high = [], []
    for primitive in gltf['meshes'][nodes[found[0]]['mesh']]['primitives']:
        accessor = gltf['accessors'][primitive['attributes']['POSITION']]
        low.append(accessor['min']); high.append(accessor['max'])
    lo = [min(v[k] for v in low) for k in range(3)]
    hi = [max(v[k] for v in high) for k in range(3)]
    corners = [(a, b, c) for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for c in (lo[2], hi[2])]
    ox, oy, yaw = metadata['origin']
    resolution = metadata['resolution']
    eps, top = 1e-6, -math.inf
    for corner in corners:
        gx, gy, gz = (sum(matrix[r][c] * v for c, v in enumerate((*corner, 1.0))) for r in range(3))
        top = max(top, gy)
        wx, wy = gx - ox, -gz - oy  # glTF (x, y, z) -> world (x, -z, y), then map frame
        mx, my = math.cos(yaw) * wx + math.sin(yaw) * wy, -math.sin(yaw) * wx + math.cos(yaw) * wy
        if not (-eps <= mx <= width * resolution + eps and -eps <= my <= height * resolution + eps):
            raise ValueError(f'{floor_id}_floor lies outside the map extent (check the y sign)')
    if not abs(top - floor_z) <= .01:
        raise ValueError(f'{floor_id}_floor top {top:.4f} m differs from floor_z {floor_z} m')


def node_matrix(node):
    if 'matrix' in node:
        m = [float(v) for v in node['matrix']]
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]  # column-major
    tx, ty, tz = node.get('translation', (0, 0, 0))
    x, y, z, w = node.get('rotation', (0, 0, 0, 1))
    sx, sy, sz = node.get('scale', (1, 1, 1))
    rotation = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[rotation[r][0] * sx, rotation[r][1] * sy, rotation[r][2] * sz, t]
            for r, t in enumerate((tx, ty, tz))] + [[0, 0, 0, 1]]


def multiply(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def check_clearance(png, metadata, scenarios, clearance=.5):
    """Distance to occupied/unknown cell *area*, including the grid boundary."""
    width, height, pixels = gray_pixels(png)
    resolution = metadata['resolution']
    ox, oy, yaw = metadata['origin']
    cosine, sine = math.cos(yaw), math.sin(yaw)
    for scenario in scenarios:
        for point in scenario['waypoints']:
            x, y = point['x'] - ox, point['y'] - oy
            x, y = cosine * x + sine * y, -sine * x + cosine * y
            if not all(math.isfinite(v) for v in (x, y)) or min(x, y, width * resolution - x, height * resolution - y) < clearance:
                raise ValueError('Preset waypoint lacks 0.5 m clearance')
            column, bottom = math.floor(x / resolution), math.floor(y / resolution)
            if pixels[(height - 1 - bottom) * width + column] != 254:
                raise ValueError('Preset waypoint is not free')
            cells = math.ceil(clearance / resolution) + 1
            for cy in range(max(0, bottom - cells), min(height, bottom + cells + 1)):
                for cx in range(max(0, column - cells), min(width, column + cells + 1)):
                    if pixels[(height - 1 - cy) * width + cx] == 254:
                        continue
                    dx = max(cx * resolution - x, 0, x - (cx + 1) * resolution)
                    dy = max(cy * resolution - y, 0, y - (cy + 1) * resolution)
                    if math.hypot(dx, dy) < clearance - 1e-10:
                        raise ValueError('Preset waypoint lacks 0.5 m clearance')


def load_worlds(folder):
    root = Path(folder).resolve(strict=True)
    catalog = json.loads((root / 'worlds.json').read_text())
    if catalog['schema'] == 'v2_map_worlds/1':
        return load_connected_worlds(root, catalog)
    if catalog['schema'] != 'simmgr_static_worlds/1':
        raise ValueError('Unsupported static catalogue')
    result, seen = [], set()
    for entry in catalog['worlds'].values():
        key = (entry['world_id'], entry['floor_id'])
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', part) for part in key):
            raise ValueError('Static world/floor IDs must be simple stable identifiers')
        if key in seen:
            raise ValueError('Duplicate world floor')
        seen.add(key)
        yaml_path = local_file(root, entry['gt_map'])
        metadata = map_yaml(yaml_path.read_bytes())
        # Keep unknown semantics of the collision-map generator fixed.
        if (metadata.get('mode'), metadata['negate'], metadata['free_thresh'], metadata['occupied_thresh']) != ('trinary', 0, .196, .65):
            raise ValueError('Static occupancy thresholds differ from collision-map')
        image = local_file(root, str(yaml_path.relative_to(root).parent / metadata['image']))
        if image.stat().st_size > MAX_IMAGE:
            raise ValueError('Static map image too large')
        png = image.read_bytes()
        _, width, height = png_image(png)
        generated = json.loads(local_file(root, entry['map_metadata']).read_text())
        floor = generated['floors'][entry['floor_id']]
        if (floor['image_sha256'] != sha256(png).hex() or floor['floor_z'] != entry['floor_z']
                or not math.isfinite(entry['floor_z']) or generated['size_pixels'] != [width, height]
                or generated['origin'] != metadata['origin'] or generated['resolution'] != metadata['resolution']):
            raise ValueError('Static map metadata does not match image/YAML/floor')
        if key in (('warehouse', 'f1'), ('plant_a', 'l1'), ('plant_a', 'l2'), ('plant_a', 'l3'), ('factory_site', 'f1')):
            _, _, pixels = gray_pixels(png)
            pgm = f'P5\n{width} {height}\n255\n'.encode() + pixels
            metadata['connected_gt'] = dict(world_id=entry['world_id'], ros_building_id=entry['building_id'],
                ros_floor_id=entry['floor_id'],
                ros_map_version='gt-20261012' if key[0] == 'warehouse' else 'gt-20261128',
                source_pgm_sha256=sha256(pgm).hex(), sha256=sha256(png).hex(), source='SIMULATION')
        scenarios = json.loads(local_file(root, entry['scenarios']).read_text()) if entry.get('scenarios') else []
        if len({s['id'] for s in scenarios}) != len(scenarios):
            raise ValueError('Duplicate preset scenario')
        check_clearance(png, metadata, scenarios)
        model, rejected = load_model(root, entry, metadata, width, height)
        # Named places (AREA etc.) from the world file are its canonical zones; checked like editor saves.
        zones = json.loads(local_file(root, entry['zones']).read_text())['zones'] if entry.get('zones') else []
        zones = C.MapFeatures(zones=zones, waypoints=[], connectors=[], edits=[]).model_dump(mode='json', exclude_none=True)['zones']
        entry = dict(entry, model_glb=model, model_rejected=rejected, zone_features=zones)
        result.append((entry, metadata, png, width, height, scenarios))
    return result


def load_connected_worlds(root, catalog):
    """Import canonical control-app GT read-only; map bytes remain private.

    The source PGM is hashed separately from the server's PNG conversion. The
    original metadata/coordinate checks precede any DB write, for both floors.
    """
    flags = [v for k, v in catalog.get('check', {}).items() if 'bytes_match' in k]
    if not flags or any(v is not True for v in flags):
        raise ValueError('Canonical GT byte checks required')
    result = []
    for floor, z in (('l1', 0.0), ('l2', 2.4)):
        entry = dict(catalog['worlds']['v5_building/' + floor])
        yaml_path = local_file(root, entry['gt_map'])
        metadata = map_yaml(yaml_path.read_bytes())
        pgm_path = local_file(root, str(yaml_path.relative_to(root).parent / metadata['image']))
        pgm = pgm_path.read_bytes()
        if len(pgm) > MAX_IMAGE:
            raise ValueError('Canonical GT too large')
        png, width, height = pgm_png(pgm)
        raw = json.loads(yaml_path.with_name('meta.json').read_text())
        if (entry['world_id'] != 'v5_building' or entry['floor_id'] != floor or entry['floor_z'] != z
                or raw['world_id'] != entry['world_id'] or raw['floor_id'] != floor
                or raw['building_id'] != entry['building_id'] or raw['map_source'] != 'gt_raster'
                or raw['map_frame'] != 'map' or raw['epoch'] is not None
                or raw['sha256_pgm'] != sha256(pgm).hex() or raw['source_sha256'] != sha256(pgm).hex()
                or raw['resolution'] != metadata['resolution'] or raw['origin'] != metadata['origin']
                or (raw['width'], raw['height']) != (width, height)
                or not re.fullmatch(r'gt-\d{8}', raw['map_version'])):
            raise ValueError('Canonical GT metadata/PGM identity mismatch')
        metadata['connected_gt'] = dict(world_id='v5_building', ros_building_id=entry['building_id'],
            ros_floor_id=floor, ros_map_version=raw['map_version'], source_pgm_sha256=sha256(pgm).hex(),
            sha256=sha256(png).hex(), source='SIMULATION')
        model, rejected = load_model(root, entry, metadata, width, height)
        entry.update(name='연결 건물', floor_name='1층' if floor == 'l1' else '2층', level=1 if floor == 'l1' else 2,
                     model_glb=model, model_rejected=rejected)
        result.append((entry, metadata, png, width, height, []))
    return result


def sync_worlds(db, org_id, actor_id, folder, files_root):
    prepared = load_worlds(folder)  # All files/waypoints checked before DB writes.
    # Imports can be partial or a separate connected-v2 catalogue. They
    # supplement packaged world identity rather than retire its other worlds.
    world_ids = supported_world_ids() | supported_world_ids(prepared)
    db.scalar(select(Organization).where(Organization.id == org_id).with_for_update())
    actor = db.scalar(select(User).where(User.id == actor_id, User.org_id == org_id,
        User.role == 'ORG_ADMIN', User.locked.is_(False), User.archived_at.is_(None)))
    if actor is None:
        raise ValueError('Active organization administrator required for import attribution')
    site_id = identifier(org_id, 'sim-site')
    if db.get(Site, site_id) is None:
        db.add(Site(id=site_id, org_id=org_id, name='시뮬 월드', purpose='SIM'))
        db.flush()
    changed = []
    for entry, metadata, png, width, height, presets in prepared:
        world_id, floor_key = entry['world_id'], entry['floor_id']
        building_id = identifier(org_id, 'world/' + world_id)
        building = db.get(Building, building_id)
        if building is None:
            building = Building(id=building_id, org_id=org_id, site_id=site_id,
                name=entry['name'], sim_world_id=world_id)
            db.add(building)
            db.flush()
        floor_id = identifier(org_id, f'world/{world_id}/{floor_key}')
        floor = db.scalar(select(Floor).where(Floor.id == floor_id).with_for_update())
        if floor is None:
            floor = Floor(id=floor_id, org_id=org_id, building_id=building_id, name=entry.get('floor_name', floor_key),
                level=entry.get('level', len(list(db.scalars(select(Floor.id).where(Floor.building_id == building_id)))) + 1),
                provenance='SIMULATION', sim_floor_id=floor_key, floor_z=entry['floor_z'])
            db.add(floor)
            db.flush()
        if floor.provenance != 'SIMULATION' or floor.floor_z != entry['floor_z']:
            raise ValueError('Static floor identity/height changed; explicit migration required')
        digest = sha256(png)
        # A previously imported image is never duplicated, even after A -> B -> A.
        version = db.scalar(select(MapVersion).where(MapVersion.floor_id == floor.id,
            MapVersion.image_sha256 == digest, MapVersion.source == 'IMPORT').order_by(MapVersion.number).limit(1))
        if version is not None and (version.resolution != metadata['resolution']
                or [version.origin_x, version.origin_y, version.origin_yaw] != metadata['origin']):
            raise ValueError('Same image SHA has different map coordinates; explicit migration required')
        if version is None:
            number = (db.scalar(select(func.max(MapVersion.number)).where(MapVersion.floor_id == floor.id)) or 0) + 1
            path = Path('maps/simulation') / str(floor.id) / (digest.hex() + '.png')
            destination = Path(files_root) / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Content-addressed orphans from a rolled-back transaction are safe to reuse.
            if destination.exists() and destination.read_bytes() != png:
                raise ValueError('Static image storage collision')
            destination.write_bytes(png)
            destination.with_suffix('.yaml').write_bytes(yaml_bytes(metadata, destination.name))
            upload = Upload(provenance='SIMULATION', org_id=org_id, image_path=str(path), image_sha256=digest, png_sha256=digest,
                size_bytes=len(png), width=width, height=height, metadata_json=metadata, created_by=actor.id)
            db.add(upload)
            db.flush()
            version = MapVersion(provenance='SIMULATION', org_id=org_id, floor_id=floor.id, number=number, base_version_id=floor.approved_version_id,
                upload_id=upload.id, status='APPROVED', image_path=str(path), image_sha256=digest, width=width, height=height,
                resolution=metadata['resolution'], origin_x=metadata['origin'][0], origin_y=metadata['origin'][1],
                origin_yaw=metadata['origin'][2], features=dict(C.MapFeatures(zones=[], waypoints=[], connectors=[], edits=[]).model_dump(),
                    zones=entry.get('zone_features', [])), source='IMPORT',
                reason='검토된 시뮬 월드 자동 등록 (2026-10-23 결정)', created_by=actor.id)
            db.add(version)
            db.flush()
            floor.approved_version_id = version.id
            db.flush()
            refresh_connectors(db, floor)
            db.add(Event(org_id=org_id, category='ACCOUNT', code='SIM_MAP_REGISTERED', user_id=actor.id,
                message='시뮬 월드 지도를 결재 없이 승인 등록했습니다.',
                data={'world_id': world_id, 'floor_id': str(floor.id), 'map_version_id': str(version.id), 'provenance': 'SIMULATION'}))
            changed.append(str(version.id))
        attach_model(version, entry.get('model_glb'), files_root)
        if entry.get('model_rejected'):
            reject_model(db, actor, world_id, floor, version, entry)
        # Existing historical images must not silently roll back a newer approval.
        if floor.approved_version_id == version.id:
            sync_presets(db, actor, world_id, floor, version, presets)
    archive_removed_worlds(db, world_ids, org_id=org_id)
    db.flush()
    return changed


def attach_model(version, data, files_root):
    """Content-addressed GLB copy; the version keeps the last declared model."""
    if data is None:
        return
    digest = sha256(data)
    if version.model_sha256 == digest:
        return
    path = Path('maps/simulation') / str(version.floor_id) / (digest.hex() + '.glb')
    destination = Path(files_root) / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.read_bytes() != data:
        raise ValueError('Static model storage collision')
    destination.write_bytes(data)
    version.model_path, version.model_sha256 = str(path), digest


def reject_model(db, actor, world_id, floor, version, entry):
    """A model that fails its check is detached: 2D only beats a mismatched 3D view.

    One event per (version, reason, rejected file sha); repeated syncs add none.
    """
    rejected = entry['model_rejected']
    detached = version.model_sha256.hex() if version.model_sha256 is not None else None
    if detached is not None:
        version.model_path = version.model_sha256 = None
    key = {'map_version_id': str(version.id), 'reason': rejected['reason'], 'sha256': rejected['sha256']}
    seen = db.scalar(select(Event.id).where(Event.org_id == actor.org_id, Event.code == 'SIM_MODEL_REJECTED',
        Event.data.contains(key)).limit(1))
    if seen is None or detached is not None:
        db.add(Event(org_id=actor.org_id, category='ACCOUNT', code='SIM_MODEL_REJECTED', user_id=actor.id,
            message='시뮬 월드 3D 모형을 검사에서 거절해 붙이지 않았습니다.' if detached is None
                else '시뮬 월드 3D 모형을 검사에서 거절해 이전 모형을 떼고 2D 로 되돌렸습니다.',
            data={**key, 'world_id': world_id, 'floor_id': str(floor.id), 'model': entry.get('model'),
                  'detached_sha256': detached}))


def sync_presets(db, actor, world_id, floor, version, presets):
    for preset in presets:
        points = []
        for point in preset['waypoints']:
            name = point['mission_name']
            mid = identifier(actor.org_id, 'sim-mission/' + name)
            if db.get(Mission, mid) is None:
                db.add(Mission(id=mid, org_id=actor.org_id, name=name, created_by=actor.id, latest_version=1, version=1))
                db.flush()
                # Display/log only; no executable action is attached to a preset.
                db.add(MissionVersion(mission_id=mid, org_id=actor.org_id, name=name, number=1,
                    steps=[], required_devices=[], created_by=actor.id))
            points.append(C.ScenarioWaypoint(floor_id=floor.id, map_version_id=version.id,
                x=point['x'], y=point['y'], yaw=point.get('yaw', 0.), mission_id=mid, mission_version=1))
        body = C.ScenarioWrite(name=preset['name'], waypoints=points,
            finish=C.ScenarioFinish(mode=preset.get('finish', 'RETURN_TO_START')),
            notes='시뮬 전용 · 지점 임무는 표시·기록만')
        sid = identifier(actor.org_id, f'sim-scenario/{world_id}/{floor.sim_floor_id}/{preset["id"]}')
        scenario = db.get(Scenario, sid)
        if scenario is None:
            scenario = Scenario(id=sid, org_id=actor.org_id, name=body.name, created_by=actor.id, latest_version=0, version=1)
            # Positive version constraint: insert the parent with its first version.
            scenario.latest_version = 1
            db.add(scenario)
            db.flush()
            number = 1
        else:
            latest = db.scalar(select(ScenarioVersion).where(ScenarioVersion.scenario_id == sid,
                ScenarioVersion.number == scenario.latest_version))
            if latest.map_version_ids == [version.id]:
                continue
            if scenario.archived_at is not None:
                continue
            scenario.latest_version += 1
            scenario.version += 1
            number = scenario.latest_version
        coordinates = [(p.x, p.y) for p in points]
        routes = list(zip(coordinates, coordinates[1:]))
        if body.finish.mode == 'RETURN_TO_START':
            routes.append((coordinates[-1], coordinates[0]))
        db.add(ScenarioVersion(org_id=actor.org_id, scenario_id=sid, name=body.name, number=number,
            waypoints=[p.model_dump(mode='json') for p in points], finish=body.finish.model_dump(mode='json'),
            notes=body.notes, floor_ids=[floor.id], map_version_ids=[version.id], required_devices=[],
            est_distance_m=sum(math.dist(a, b) for a, b in routes), created_by=actor.id))
        db.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worlds-dir', required=True)
    parser.add_argument('--org-id', required=True, type=UUID)
    parser.add_argument('--actor-id', required=True, type=UUID)
    parser.add_argument('--files-root', required=True)
    args = parser.parse_args()
    engine = create_engine(os.environ['FH_DATABASE_URL'])
    try:
        with Session(engine) as db, db.begin():
            changed = sync_worlds(db, args.org_id, args.actor_id, args.worlds_dir, args.files_root)
        print(json.dumps({'registered_versions': changed}))
    finally:
        engine.dispose()


if __name__ == '__main__':
    main()

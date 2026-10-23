"""Explicit, opt-in import of reviewed static worlds; never launches a simulator."""
import argparse
import json
import math
import os
import re
from pathlib import Path
from uuid import UUID, uuid5

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from apps.contracts import models as C
from .map_files import MAX_IMAGE, gray_pixels, map_yaml, png_image, pgm_png, sha256, yaml_bytes
from .maps import refresh_connectors
from .models import (Building, Event, Floor, MapVersion, Mission, MissionVersion,
                     Organization, Scenario, ScenarioVersion, Site, Upload, User)

NAMESPACE = UUID('7cf30f97-697d-4f02-a196-635970db0246')


def identifier(org_id, key):
    return uuid5(NAMESPACE, str(org_id) + '/' + key)


def local_file(root, path):
    result = (root / path).resolve(strict=True)
    if not result.is_relative_to(root.resolve()):
        raise ValueError('World asset escapes catalogue directory')
    return result


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
        if key == ('warehouse', 'f1'):
            _, _, pixels = gray_pixels(png)
            pgm = f'P5\n{width} {height}\n255\n'.encode() + pixels
            metadata['connected_gt'] = dict(world_id='warehouse', ros_building_id=entry['building_id'],
                ros_floor_id='f1', ros_map_version='gt-20261012', source_pgm_sha256=sha256(pgm).hex(),
                sha256=sha256(png).hex(), source='SIMULATION')
        scenarios = json.loads(local_file(root, entry['scenarios']).read_text()) if entry.get('scenarios') else []
        if len({s['id'] for s in scenarios}) != len(scenarios):
            raise ValueError('Duplicate preset scenario')
        check_clearance(png, metadata, scenarios)
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
        entry.update(name='연결 건물', floor_name='1층' if floor == 'l1' else '2층', level=1 if floor == 'l1' else 2)
        result.append((entry, metadata, png, width, height, []))
    return result


def sync_worlds(db, org_id, actor_id, folder, files_root):
    prepared = load_worlds(folder)  # All files/waypoints checked before DB writes.
    db.scalar(select(Organization).where(Organization.id == org_id).with_for_update())
    actor = db.scalar(select(User).where(User.id == actor_id, User.org_id == org_id,
        User.role == 'ORG_ADMIN', User.locked.is_(False), User.archived_at.is_(None)))
    if actor is None:
        raise ValueError('Active organization administrator required for import attribution')
    site_id = identifier(org_id, 'sim-site')
    if db.get(Site, site_id) is None:
        db.add(Site(id=site_id, org_id=org_id, name='시뮬 월드'))
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
                origin_yaw=metadata['origin'][2], features=C.MapFeatures(zones=[], waypoints=[], connectors=[], edits=[]).model_dump(), source='IMPORT',
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
        # Existing historical images must not silently roll back a newer approval.
        if floor.approved_version_id == version.id:
            sync_presets(db, actor, world_id, floor, version, presets)
    db.flush()
    return changed


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

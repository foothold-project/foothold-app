"""Validated terrain library; each save publishes an immutable simulation map."""
import copy
import math
from pathlib import Path
from typing import Annotated
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import Query
from sqlalchemy import select, func

from apps.contracts import models as C
from .map_files import gray_png, sha256, yaml_bytes
from .maps import ensure_space, refresh_connectors
from .resource_archive import require_unused
from .models import Building, Floor, MapVersion, Organization, Site, Terrain, Upload, now


def terrain_grid(spec):
    """Same cell-square raster as mobile/sim/terrain buildTerrain (not its padded SVG).

    ROS origin is the lower left; image rows run from the upper left. Every
    object footprint, including gaps and the stairs landing, is occupied.
    """
    sx, sy = spec.size
    res = .05
    width, height = math.ceil(sx / res), math.ceil(sy / res)
    origin = [-sx / 2, -sy / 2, 0]
    pad2 = (res * math.sqrt(2) / 2) ** 2
    objects = []
    for o in spec.items:
        length = o.sx if o.kind == 'box' else o.steps * o.run + 1 if o.kind == 'stairs' else o.length
        breadth = o.sy if o.kind == 'box' else o.width
        objects.append((o.x, o.y, math.cos(o.yaw), math.sin(o.yaw), length / 2, breadth / 2))
    pixels = bytearray(width * height)
    for r in range(height):
        y = origin[1] + (height - r - .5) * res
        for col in range(width):
            x = origin[0] + (col + .5) * res
            if (r == 0 or col == 0 or r == height - 1 or col == width - 1
                    or x + res / 2 > sx / 2 + 1e-9 or y + res / 2 > sy / 2 + 1e-9):
                value = 205
            else:
                value = 254
                for ox, oy, c, s, hx, hy in objects:
                    dx, dy = x - ox, y - oy
                    u, v = max(0, abs(c * dx + s * dy) - hx), max(0, abs(-s * dx + c * dy) - hy)
                    if u * u + v * v <= pad2:
                        value = 0
                        break
            pixels[r * width + col] = value
    return width, height, origin, pixels


def identifier(org_id, key):
    return uuid5(NAMESPACE_URL, f'foothold:{org_id}:custom-terrain/{key}')


def publish_terrain_map(db, user, spec, floor, terrain_version, root, fail, created=None, *, twin=None):
    """Publish from a validated spec, shared by terrain saves and pair repair.

    The caller owns the transaction and the library revision. Existing map
    snapshots remain immutable; failures remove only this attempt's new files.
    """
    width, height, origin, pixels = terrain_grid(spec)
    png = gray_png(width, height, pixels)
    digest = sha256(png)
    number = (db.scalar(select(func.max(MapVersion.number)).where(MapVersion.floor_id == floor.id)) or 0) + 1
    # Random suffix also avoids overwriting an orphan from an interrupted save.
    path = Path('maps') / str(floor.id) / f'{number}-{uuid4()}.png'
    destination = root / path
    next_version = terrain_version
    metadata = {'resolution': .05, 'origin': origin, 'negate': 0, 'occupied_thresh': .65,
        'free_thresh': .2, 'terrain_id': spec.id, 'terrain_version': next_version,
        'terrain_spec': spec.model_dump(mode='json', by_alias=True)}
    features = {'zones': [], 'waypoints': [], 'connectors': [], 'edits': []}
    if twin:
        source = db.get(MapVersion, UUID(twin['map_version_id']))
        if source is None or source.org_id != user.org_id or source.provenance != 'HUMAN':
            fail(422, 'MAP_PROOF_UNAVAILABLE', '연결된 실기 지도 판을 찾을 수 없습니다.')
        features = copy.deepcopy(source.features)
        # Canonical PGM is the exact terrain raster used by the custom world.
        # The agent must independently match these bytes and its live world.
        pgm = f'P5\n{width} {height}\n255\n'.encode() + pixels
        metadata['voxel_twin'] = twin
        metadata['connected_gt'] = dict(world_id='custom/' + spec.id, ros_floor_id='f1',
            source='SIMULATION', sha256=digest.hex(), source_pgm_sha256=sha256(pgm).hex())
    created = [] if created is None else created
    try:
        ensure_space(root, len(png) + 16384 + (len(pgm) if twin else 0), fail)
        destination.parent.mkdir(parents=True, exist_ok=True)
        for target, content in ((destination, png), (destination.with_suffix('.yaml'), yaml_bytes(metadata, destination.name))):
            with target.open('xb') as out:
                created.append(target)
                out.write(content)
        if twin:
            with destination.with_suffix('.pgm').open('xb') as out:
                created.append(destination.with_suffix('.pgm'))
                out.write(pgm)
        upload = Upload(provenance='SIMULATION', org_id=user.org_id, image_path=str(path), image_sha256=digest,
            png_sha256=digest, size_bytes=len(png), width=width, height=height, metadata_json=metadata, created_by=user.id)
        db.add(upload)
        db.flush()
        version = MapVersion(provenance='SIMULATION', org_id=user.org_id, floor_id=floor.id, number=number,
            base_version_id=floor.approved_version_id, upload_id=upload.id, status='APPROVED', image_path=str(path),
            image_sha256=digest, width=width, height=height, resolution=.05, origin_x=origin[0], origin_y=origin[1],
            origin_yaw=0, features=features,
            source='IMPORT', reason='지형 저장으로 위에서 본 지도 자동 생성', created_by=user.id)
        db.add(version)
        db.flush()
        floor.approved_version_id = version.id
        refresh_connectors(db, floor)
        return version
    except BaseException as exc:
        for target in created:
            target.unlink(missing_ok=True)
        if isinstance(exc, OSError):
            fail(503, 'FILE_STORAGE_ERROR', '지형 지도를 저장할 수 없습니다.')
        raise


def terrain_object(db, row):
    floor = db.scalar(select(Floor).where(Floor.org_id == row.org_id, Floor.terrain_id == row.id))
    # Floor may have been permanently deleted via existing map trash rules;
    # keep terrain readable and recreate that floor on the next save.
    return C.Terrain(spec=row.spec, version=row.version,
        floor_id=floor.id if floor else None,
        map_version_id=floor.approved_version_id if floor else None,
        archived_at=row.archived_at, updated_at=row.updated_at)


def save_terrain(db, user, terrain_id, body, root, fail, event, *, created=None, twin=None):
    if twin and list(body.spec.size) != twin['terrain_size']:
        fail(422, 'INVALID_TERRAIN', '실기 지도와 좌표를 맞추려면 연결된 지형의 바닥 크기를 유지해 주세요.')
    if terrain_id != body.spec.id:
        fail(422, 'INVALID_TERRAIN', '주소와 지형 id가 다릅니다.')
    # Serialize first saves/site creation, then lock the shared floor just
    # like ordinary map saves. Version checks prevent silent draft loss.
    db.scalar(select(Organization).where(Organization.id == user.org_id).with_for_update())
    row = db.scalar(select(Terrain).where(Terrain.org_id == user.org_id, Terrain.id == terrain_id).with_for_update())
    if (row.version if row else 0) != body.base_version:
        fail(409, 'VERSION_CONFLICT', '서버 지형이 바뀌었습니다. 내 지형에서 서버 저장본을 다시 열어 주세요.')
    if row and row.archived_at is not None:
        fail(409, 'RESOURCE_ARCHIVED', '휴지통의 지형을 먼저 되돌려 주세요.')
    site = db.get(Site, identifier(user.org_id, 'site'))
    if site is None:
        site = Site(id=identifier(user.org_id, 'site'), org_id=user.org_id, name='시뮬 지형', purpose='SIM')
        db.add(site)
        db.flush()
    building = db.get(Building, identifier(user.org_id, terrain_id + '/building'))
    if building is None:
        building = Building(id=identifier(user.org_id, terrain_id + '/building'), org_id=user.org_id,
            site_id=site.id, name=body.spec.name)
        db.add(building)
        db.flush()
    floor = db.scalar(select(Floor).where(Floor.org_id == user.org_id, Floor.terrain_id == terrain_id).with_for_update().execution_options(populate_existing=True))
    if floor is None:
        floor = Floor(id=identifier(user.org_id, terrain_id + '/floor'), org_id=user.org_id,
            building_id=building.id, name='1층', level=1, terrain_id=terrain_id, provenance='SIMULATION', floor_z=0)
        db.add(floor)
        db.flush()
    # A map annotation save may have completed while this terrain save waited
    # for the floor lock. Use the binding under that lock, not the route's read.
    if twin and floor.approved_version_id:
        current = db.get(MapVersion, floor.approved_version_id)
        current_upload = db.get(Upload, current.upload_id) if current else None
        twin = current_upload.metadata_json.get('voxel_twin') if current_upload else None
    if floor.archived_at is not None:
        fail(409, 'RESOURCE_ARCHIVED', '지도 휴지통의 층을 먼저 되돌려 주세요.')
    # Saving terrain is the entry point for creating simulation places,
    # including when all previous terrain floors and parents were archived.
    site.archived_at = None
    building.archived_at = None
    building.name = body.spec.name
    created = [] if created is None else created
    try:
        if twin:
            building.sim_world_id = 'custom/' + terrain_id
            floor.sim_floor_id = 'f1'
        version = publish_terrain_map(db, user, body.spec, floor,
            row.version + 1 if row else 1, root, fail, created, twin=twin)
        if row is None:
            row = Terrain(id=terrain_id, org_id=user.org_id)
            db.add(row)
            row.version = 0
        row.spec = body.spec.model_dump(mode='json', by_alias=True)
        row.version += 1
        row.updated_at = now()
        db.flush()
        event(db, user.org_id, 'MAP_VERSION_APPROVED', user.id,
            {'floor_id': str(floor.id), 'map_version_id': str(version.id), 'terrain_id': terrain_id, 'number': version.number}, category='APPROVAL')
        result = terrain_object(db, row)
        return result
    except BaseException:
        for target in created:
            target.unlink(missing_ok=True)
        raise


def install(app, DB, Identity, fail, authorize, event, settings):
    root = Path(settings.files_root).resolve()

    def own(db, user, terrain_id, lock=False):
        query = select(Terrain).where(Terrain.org_id == user.org_id, Terrain.id == terrain_id)
        row = db.scalar(query.with_for_update() if lock else query)
        if row is None:
            fail(404, 'NOT_FOUND', '지형을 찾을 수 없습니다.')
        return row

    @app.get('/api/v1/terrains', response_model=C.TerrainList)
    def listing(auth: Identity, db: DB, archived: bool = False,
                limit: Annotated[int, Query(ge=1, le=100)] = 50, cursor: str | None = None):
        query = select(Terrain).where(Terrain.org_id == auth[0].org_id)
        if not archived:
            query = query.where(Terrain.archived_at.is_(None))
        if cursor:
            query = query.where(Terrain.id > cursor)
        rows = list(db.scalars(query.order_by(Terrain.id).limit(limit + 1)))
        return C.TerrainList(items=[terrain_object(db, row) for row in rows[:limit]],
            next_cursor=rows[limit - 1].id if len(rows) > limit else None)

    @app.get('/api/v1/terrains/{terrain_id}', response_model=C.Terrain)
    def read(terrain_id: str, auth: Identity, db: DB):
        return terrain_object(db, own(db, auth[0], terrain_id))

    @app.put('/api/v1/terrains/{terrain_id}', response_model=C.Terrain)
    def save(terrain_id: str, body: C.TerrainWrite, auth: Identity, db: DB):
        authorize(auth[0], 'A')
        # Preserve a server-created source binding across terrain edits.
        floor = db.scalar(select(Floor).where(Floor.org_id == auth[0].org_id, Floor.terrain_id == terrain_id))
        version = db.get(MapVersion, floor.approved_version_id) if floor and floor.approved_version_id else None
        upload = db.get(Upload, version.upload_id) if version else None
        twin = upload.metadata_json.get('voxel_twin') if upload else None
        created = []
        try:
            result = save_terrain(db, auth[0], terrain_id, body, root, fail, event, created=created, twin=twin)
            db.commit()
            return result
        except BaseException:
            for target in created:
                target.unlink(missing_ok=True)
            raise

    @app.delete('/api/v1/terrains/{terrain_id}', status_code=204)
    def archive(terrain_id: str, auth: Identity, db: DB):
        authorize(auth[0], 'A')
        db.scalar(select(Organization).where(Organization.id == auth[0].org_id).with_for_update())
        row = own(db, auth[0], terrain_id, lock=True)
        if row.archived_at is not None:
            return
        floor = db.scalar(select(Floor).where(Floor.org_id == row.org_id,
            Floor.terrain_id == row.id).with_for_update())
        if floor is not None:
            require_unused(db, row.org_id, fail, floor=floor)
        row.archived_at = now()
        if floor is not None:
            floor.archived_at = row.archived_at
            event(db, row.org_id, 'FLOOR_DELETED', auth[0].id, {'id': str(floor.id), 'name': floor.name})
            db.flush()
            refresh_connectors(db, floor)
        event(db, auth[0].org_id, 'TERRAIN_ARCHIVED', auth[0].id, {'terrain_id': terrain_id, 'name': row.spec['name']})

    @app.post('/api/v1/terrains/{terrain_id}/restore', response_model=C.Terrain)
    def restore(terrain_id: str, auth: Identity, db: DB):
        authorize(auth[0], 'A')
        db.scalar(select(Organization).where(Organization.id == auth[0].org_id).with_for_update())
        row = own(db, auth[0], terrain_id, lock=True)
        if row.archived_at is None:
            return terrain_object(db, row)
        floor = db.scalar(select(Floor).where(Floor.org_id == row.org_id,
            Floor.terrain_id == row.id).with_for_update())
        if floor is None:
            fail(409, 'TERRAIN_PAIR_MISSING', '연결된 층이 없어 지형을 되돌릴 수 없습니다.')
        building = db.get(Building, floor.building_id)
        site = db.get(Site, building.site_id)
        if building.archived_at is not None or site.archived_at is not None:
            fail(409, 'PARENT_ARCHIVED', '상위 장소·건물을 먼저 되살리세요.')
        require_unused(db, row.org_id, fail, floor=floor)
        floor.archived_at = None
        row.archived_at = None
        event(db, row.org_id, 'FLOOR_RESTORED', auth[0].id, {'id': str(floor.id), 'name': floor.name})
        db.flush()
        refresh_connectors(db, floor)
        event(db, auth[0].org_id, 'TERRAIN_RESTORED', auth[0].id, {'terrain_id': terrain_id, 'name': row.spec['name']})
        return terrain_object(db, row)

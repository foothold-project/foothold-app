"""Validated terrain library; each save publishes an immutable simulation map."""
import math
from pathlib import Path
from typing import Annotated
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import Query
from sqlalchemy import select, func

from apps.contracts import models as C
from .map_files import gray_png, sha256, yaml_bytes
from .maps import ensure_space, refresh_connectors
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


def install(app, DB, Identity, fail, authorize, event, settings):
    root = Path(settings.files_root).resolve()

    def own(db, user, terrain_id, lock=False):
        query = select(Terrain).where(Terrain.org_id == user.org_id, Terrain.id == terrain_id)
        row = db.scalar(query.with_for_update() if lock else query)
        if row is None:
            fail(404, 'NOT_FOUND', '지형을 찾을 수 없습니다.')
        return row

    def output(db, row):
        floor = db.scalar(select(Floor).where(Floor.org_id == row.org_id, Floor.terrain_id == row.id))
        # Floor may have been permanently deleted via existing map trash rules;
        # keep terrain readable and recreate that floor on the next save.
        return C.Terrain(spec=row.spec, version=row.version,
            floor_id=floor.id if floor else None,
            map_version_id=floor.approved_version_id if floor else None,
            archived_at=row.archived_at, updated_at=row.updated_at)

    @app.get('/api/v1/terrains', response_model=C.TerrainList)
    def listing(auth: Identity, db: DB, archived: bool = False,
                limit: Annotated[int, Query(ge=1, le=100)] = 50, cursor: str | None = None):
        query = select(Terrain).where(Terrain.org_id == auth[0].org_id)
        if not archived:
            query = query.where(Terrain.archived_at.is_(None))
        if cursor:
            query = query.where(Terrain.id > cursor)
        rows = list(db.scalars(query.order_by(Terrain.id).limit(limit + 1)))
        return C.TerrainList(items=[output(db, row) for row in rows[:limit]],
            next_cursor=rows[limit - 1].id if len(rows) > limit else None)

    @app.get('/api/v1/terrains/{terrain_id}', response_model=C.Terrain)
    def read(terrain_id: str, auth: Identity, db: DB):
        return output(db, own(db, auth[0], terrain_id))

    @app.put('/api/v1/terrains/{terrain_id}', response_model=C.Terrain)
    def save(terrain_id: str, body: C.TerrainWrite, auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'A')
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
            site = Site(id=identifier(user.org_id, 'site'), org_id=user.org_id, name='시뮬 지형')
            db.add(site)
            db.flush()
        building = db.get(Building, identifier(user.org_id, terrain_id + '/building'))
        if building is None:
            building = Building(id=identifier(user.org_id, terrain_id + '/building'), org_id=user.org_id,
                site_id=site.id, name=body.spec.name)
            db.add(building)
            db.flush()
        floor = db.scalar(select(Floor).where(Floor.org_id == user.org_id, Floor.terrain_id == terrain_id).with_for_update())
        if floor is None:
            floor = Floor(id=identifier(user.org_id, terrain_id + '/floor'), org_id=user.org_id,
                building_id=building.id, name='1층', level=1, terrain_id=terrain_id, provenance='SIMULATION', floor_z=0)
            db.add(floor)
            db.flush()
        if any(item.archived_at is not None for item in (site, building, floor)):
            fail(409, 'RESOURCE_ARCHIVED', '지도 휴지통의 장소·건물·층을 먼저 되돌려 주세요.')
        building.name = body.spec.name
        width, height, origin, pixels = terrain_grid(body.spec)
        png = gray_png(width, height, pixels)
        digest = sha256(png)
        number = (db.scalar(select(func.max(MapVersion.number)).where(MapVersion.floor_id == floor.id)) or 0) + 1
        # Random suffix also avoids overwriting an orphan from an interrupted save.
        path = Path('maps') / str(floor.id) / f'{number}-{uuid4()}.png'
        destination = root / path
        next_version = row.version + 1 if row else 1
        metadata = {'resolution': .05, 'origin': origin, 'negate': 0, 'occupied_thresh': .65,
            'free_thresh': .2, 'terrain_id': terrain_id, 'terrain_version': next_version,
            'terrain_spec': body.spec.model_dump(mode='json', by_alias=True)}
        created = []
        try:
            ensure_space(root, len(png) + 16384, fail)
            destination.parent.mkdir(parents=True, exist_ok=True)
            for target, content in ((destination, png), (destination.with_suffix('.yaml'), yaml_bytes(metadata, destination.name))):
                with target.open('xb') as out:
                    created.append(target)
                    out.write(content)
            upload = Upload(provenance='SIMULATION', org_id=user.org_id, image_path=str(path), image_sha256=digest,
                png_sha256=digest, size_bytes=len(png), width=width, height=height, metadata_json=metadata, created_by=user.id)
            db.add(upload)
            db.flush()
            version = MapVersion(provenance='SIMULATION', org_id=user.org_id, floor_id=floor.id, number=number,
                base_version_id=floor.approved_version_id, upload_id=upload.id, status='APPROVED', image_path=str(path),
                image_sha256=digest, width=width, height=height, resolution=.05, origin_x=origin[0], origin_y=origin[1],
                origin_yaw=0, features={'zones': [], 'waypoints': [], 'connectors': [], 'edits': []},
                source='IMPORT', reason='지형 저장으로 위에서 본 지도 자동 생성', created_by=user.id)
            db.add(version)
            db.flush()
            floor.approved_version_id = version.id
            if row is None:
                row = Terrain(id=terrain_id, org_id=user.org_id)
                db.add(row)
            row.spec = metadata['terrain_spec']
            row.version = next_version
            row.updated_at = now()
            db.flush()
            refresh_connectors(db, floor)
            event(db, user.org_id, 'MAP_VERSION_APPROVED', user.id,
                {'floor_id': str(floor.id), 'map_version_id': str(version.id), 'terrain_id': terrain_id, 'number': number}, category='APPROVAL')
            result = output(db, row)
            db.commit()
            return result
        except BaseException as exc:
            for target in created:
                target.unlink(missing_ok=True)
            if isinstance(exc, OSError):
                fail(503, 'FILE_STORAGE_ERROR', '지형 지도를 저장할 수 없습니다.')
            raise

    @app.delete('/api/v1/terrains/{terrain_id}', status_code=204)
    def archive(terrain_id: str, auth: Identity, db: DB):
        authorize(auth[0], 'A')
        row = own(db, auth[0], terrain_id, lock=True)
        if row.archived_at is not None:
            return
        row.archived_at = now()
        event(db, auth[0].org_id, 'TERRAIN_ARCHIVED', auth[0].id, {'terrain_id': terrain_id, 'name': row.spec['name']})

    @app.post('/api/v1/terrains/{terrain_id}/restore', response_model=C.Terrain)
    def restore(terrain_id: str, auth: Identity, db: DB):
        authorize(auth[0], 'A')
        row = own(db, auth[0], terrain_id, lock=True)
        if row.archived_at is None:
            return output(db, row)
        row.archived_at = None
        event(db, auth[0].org_id, 'TERRAIN_RESTORED', auth[0].id, {'terrain_id': terrain_id, 'name': row.spec['name']})
        return output(db, row)

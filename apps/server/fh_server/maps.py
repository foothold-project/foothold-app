"""Tenant-scoped immutable map snapshots, bounded files, diff and rollback."""
import asyncio
import copy
import json
from pathlib import Path
import shutil
from typing import Annotated
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5
import math

from fastapi import Query, Request
from fastapi.responses import FileResponse
from sqlalchemy import delete, func, select

from apps.contracts import models as C
from .map_files import MAX_IMAGE, MAX_YAML, image_bytes, map_yaml, sha256, yaml_bytes
from . import idempotency
from .models import Approval, Building, Floor, FloorConnector, MapVersion, Robot, Site, Upload


UPLOAD_BODY_SECONDS = 30
MIN_FREE_SPACE = 256 * 1024 * 1024
MAX_FEATURE_VERTICES = 4096
# Four copies at most (two snapshots plus before/after), bounded by contract:
# 1768 elements, <=2 strings of 128 characters (6 bytes escaped), 4096 vertices
# of <=3 float coordinates (32 bytes), and generous syntax/key/metadata budgets.
# 4 * (1768 * (2 * 128 * 6 + 1536) + 4096 * 3 * 32) + 128 KiB
# = 23,429,120 bytes < 32 MiB, including edit indices and escaped change keys.
MAX_DIFF_BYTES = 32 * 1024 * 1024


def ensure_space(root, required, fail):
    existing = root
    while not existing.exists():
        existing = existing.parent
    if shutil.disk_usage(existing).free < MIN_FREE_SPACE + required:
        fail(503, 'FILE_STORAGE_FULL', '파일 저장 공간이 부족합니다.')


async def upload_work(slot, work, fail):
    # The task owns the permit until its thread actually ends, including after
    # client cancellation. Disconnecting cannot admit a second live conversion.
    # Check and acquire have no suspension between them on this event loop.
    # Refuse received bodies instead of retaining them in a waiting queue.
    if slot.locked():
        fail(503, 'SERVER_BUSY', '지도 파일 처리 중입니다. 잠시 후 다시 시도하세요.')
    await slot.acquire()
    task = asyncio.create_task(asyncio.to_thread(work))
    def finished(task):
        slot.release()
        if not task.cancelled():
            task.exception()
    task.add_done_callback(finished)
    return await asyncio.shield(task)


def orientation(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def intersects(a, b, c, d):
    def on(p, q, r):
        return abs(orientation(p, q, r)) <= 1e-10 and min(p[0], q[0]) <= r[0] <= max(p[0], q[0]) and min(p[1], q[1]) <= r[1] <= max(p[1], q[1])
    o1, o2, o3, o4 = orientation(a, b, c), orientation(a, b, d), orientation(c, d, a), orientation(c, d, b)
    return (o1 * o2 < 0 and o3 * o4 < 0) or on(a, b, c) or on(a, b, d) or on(c, d, a) or on(c, d, b)


def within_map(x, y, origin, width, height):
    """World coordinate bounds shared by map features and scenario points."""
    ox, oy, yaw = origin
    dx, dy = x - ox, y - oy
    cosine, sine = math.cos(yaw), math.sin(yaw)
    px, py = cosine * dx + sine * dy, -sine * dx + cosine * dy
    return (math.isfinite(px) and math.isfinite(py)
        and -1e-9 <= px <= width + 1e-9 and -1e-9 <= py <= height + 1e-9)


def validate_features(db, floor, upload, features, fail):
    vertices = sum(len(z.polygon) for z in features.zones) + sum(len(e.polyline) for e in features.edits) + len(features.waypoints) + len(features.connectors)
    if vertices > MAX_FEATURE_VERTICES:
        fail(422, 'INVALID_FEATURES', '지도 요소의 전체 꼭짓점은 4096개 이하여야 합니다.', {'element': 'features'})
    meta = upload.metadata_json
    ox, oy, yaw = meta['origin']
    width, height = upload.width * meta['resolution'], upload.height * meta['resolution']
    if not all(math.isfinite(v) for v in (width, height, ox, oy)):
        fail(422, 'INVALID_FEATURES', '지도 좌표 범위를 확인하세요.', {'element': 'image'})
    def bad(path, message):
        fail(422, 'INVALID_FEATURES', message, {'element': path})
    def point(x, y, path):
        if not within_map(x, y, (ox, oy, yaw), width, height):
            bad(path, '지도 범위 안의 좌표를 입력하세요.')
    for group in ('zones', 'waypoints', 'connectors'):
        identifiers = set()
        for index, item in enumerate(getattr(features, group)):
            path = f'features.{group}.{index}'
            if item.id in identifiers:
                bad(path + '.id', '같은 종류의 지도 요소 ID가 중복됩니다.')
            identifiers.add(item.id)
            if group == 'zones':
                polygon = item.polygon
                if len(set(polygon)) != len(polygon):
                    bad(path + '.polygon', '다각형 점이 중복됩니다.')
                for n, (x, y) in enumerate(polygon):
                    point(x, y, f'{path}.polygon.{n}')
                area = sum(orientation((0, 0), polygon[n], polygon[(n + 1) % len(polygon)]) for n in range(len(polygon)))
                if abs(area) < 1e-10:
                    bad(path + '.polygon', '다각형 넓이가 0입니다.')
                for a in range(len(polygon)):
                    for b in range(a + 1, len(polygon)):
                        if b == a + 1 or (a == 0 and b == len(polygon) - 1):
                            continue
                        if intersects(polygon[a], polygon[(a + 1) % len(polygon)], polygon[b], polygon[(b + 1) % len(polygon)]):
                            bad(path + '.polygon', '다각형 변이 서로 교차합니다.')
            else:
                point(item.x, item.y, path)
                if group == 'connectors':
                    pair = db.scalar(select(Floor).where(Floor.id == item.pair_floor_id, Floor.org_id == floor.org_id,
                        Floor.building_id == floor.building_id, Floor.id != floor.id))
                    if pair is None:
                        # No identifiers/names of foreign or absent floors are disclosed.
                        bad(path + '.pair_floor_id', '같은 건물의 다른 층을 선택하세요.')
    edit_ids = [e.id for e in features.edits if e.id is not None]
    if len(edit_ids) != len(set(edit_ids)):
        bad('features.edits.id', '같은 종류의 지도 요소 ID가 중복됩니다.')
    for index, edit in enumerate(features.edits):
        for n, (x, y) in enumerate(edit.polyline):
            point(x, y, f'features.edits.{index}.polyline.{n}')
        if len(set(edit.polyline)) < 2:
            bad(f'features.edits.{index}.polyline', '서로 다른 점이 2개 이상 필요합니다.')


def refresh_connectors(db, floor):
    """Project the current approved pair only; unmatched endpoints stay inactive."""
    floors = list(db.scalars(select(Floor).where(Floor.org_id == floor.org_id, Floor.building_id == floor.building_id)))
    versions = {f.id: db.get(MapVersion, f.approved_version_id) for f in floors if f.approved_version_id}
    db.execute(delete(FloorConnector).where(FloorConnector.org_id == floor.org_id, FloorConnector.building_id == floor.building_id))
    seen = set()
    for floor_id, version in versions.items():
        for connector in version.features['connectors']:
            pair_id = UUID(connector['pair_floor_id'])
            key = (min(str(floor_id), str(pair_id)), max(str(floor_id), str(pair_id)), connector['id'])
            if key in seen:
                continue
            seen.add(key)
            other = versions.get(pair_id)
            matching = next((item for item in other.features['connectors'] if item['id'] == connector['id'] and
                item['pair_floor_id'] == str(floor_id) and item['kind'] == connector['kind']), None) if other else None
            pose = lambda item: {key: item[key] for key in ('x', 'y', 'yaw')}
            db.add(FloorConnector(id=uuid5(NAMESPACE_URL, f'foothold:{floor.building_id}:{key}'), org_id=floor.org_id, building_id=floor.building_id, kind=connector['kind'],
                floor_a_id=floor_id, floor_b_id=pair_id, a_pose=pose(connector), b_pose=pose(matching) if matching else None,
                map_version_a_id=version.id, map_version_b_id=other.id if matching else None, active=matching is not None))


def version_object(row, floor):
    return C.MapVersion(upload_id=row.upload_id, id=row.id, floor_id=row.floor_id, number=row.number, base_version_id=row.base_version_id,
        copied_from_id=row.copied_from_id,
        status='SUPERSEDED' if row.status == 'APPROVED' and floor.approved_version_id != row.id else row.status,
        image_sha256=row.image_sha256.hex(), width=row.width, height=row.height, resolution=row.resolution,
        origin=(row.origin_x, row.origin_y, row.origin_yaw), features=row.features, reason=row.reason,
        source=row.source, provenance=row.provenance, created_by=row.created_by, created_at=row.created_at)


def bounded_features(row, fail):
    # Stored snapshots also pass the same vertex budget before any comparison.
    features = row.features
    vertices = sum(len(z['polygon']) for z in features['zones']) + sum(len(e['polyline']) for e in features['edits']) + len(features['waypoints']) + len(features['connectors'])
    if MAX_FEATURE_VERTICES < vertices:
        fail(422, 'INVALID_FEATURES', '지도 요소의 전체 꼭짓점은 4096개 이하여야 합니다.', {'element': 'features'})
    return features


def validate_rollback_connectors(db, floor, features, fail):
    for index, connector in enumerate(features['connectors']):
        pair = db.scalar(select(Floor.id).where(Floor.id == UUID(connector['pair_floor_id']),
            Floor.org_id == floor.org_id, Floor.building_id == floor.building_id, Floor.id != floor.id))
        if pair is None:
            fail(422, 'INVALID_FEATURES', '연결점이 가리키는 같은 건물의 다른 층을 찾을 수 없습니다.',
                {'element': f'features.connectors.{index}.pair_floor_id'})


def feature_index(items, kind):
    result, duplicates = {}, {}
    for item in items:
        if kind != 'edits' or item.get('id') is not None:
            key = 'id:' + item['id']
        else:
            # Legacy edits have no identity. Equal content keeps its key across
            # reordering; the diff reports changed positions separately. Changed
            # legacy content is a removal plus an addition.
            digest = sha256(json.dumps(item, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hex()
            occurrence = duplicates.get(digest, 0)
            duplicates[digest] = occurrence + 1
            key = f'sha256:{digest}:{occurrence}'
        result[key] = item
    return result


def install(app, DB, Identity, fail, authorize, event, settings, UploadIdentity, upload_write):
    root = Path(settings.files_root).resolve()
    conversion_slot = asyncio.Semaphore(1)

    def own(db, model, identifier, user, *, lock=False):
        query = select(model).where(model.id == identifier, model.org_id == user.org_id)
        if lock:
            query = query.with_for_update()
        row = db.scalar(query)
        if row is None:
            fail(404, 'NOT_FOUND', '장소·지도 자료를 찾을 수 없습니다.')
        return row

    def record(db, user, code, row, **data):
        if isinstance(row, Site):
            scope = {'site_id': str(row.id)}
        elif isinstance(row, Building):
            scope = {'site_id': str(row.site_id), 'building_id': str(row.id)}
        elif isinstance(row, Floor):
            scope = {'building_id': str(row.building_id), 'floor_id': str(row.id)}
        else:
            scope = {'floor_id': str(row.floor_id), 'map_version_id': str(row.id)}
        event(db, user.org_id, code, user.id, {'id': str(row.id), 'name': getattr(row, 'name', ''),
            'number': getattr(row, 'number', None), **scope, **data},
            category='APPROVAL' if code in ('MAP_VERSION_APPROVED', 'MAP_VERSION_ROLLED_BACK') else 'ACCOUNT')

    def floor_object(row, pending_count=0):
        return C.MapFloor(pending_count=pending_count, **{key: getattr(row, key) for key in C.MapFloor.model_fields if key != 'pending_count'})

    @app.get('/api/v1/sites', response_model=C.SiteTree)
    def sites(auth: Identity, db: DB):
        user = auth[0]
        floors = list(db.scalars(select(Floor).where(Floor.org_id == user.org_id).order_by(Floor.level, Floor.id)))
        buildings = list(db.scalars(select(Building).where(Building.org_id == user.org_id).order_by(Building.name, Building.id)))
        sites = list(db.scalars(select(Site).where(Site.org_id == user.org_id).order_by(Site.name, Site.id)))
        counts = dict(db.execute(select(MapVersion.floor_id, func.count()).join(Approval,
            (Approval.org_id == MapVersion.org_id) & (Approval.target_id == MapVersion.id)).where(
            Approval.org_id == user.org_id, Approval.status == 'PENDING').group_by(MapVersion.floor_id)).all())
        return C.SiteTree(items=[C.MapSite(id=s.id, name=s.name, buildings=[C.MapBuilding(id=b.id,
            site_id=b.site_id, name=b.name, sim_world_id=b.sim_world_id, floors=[floor_object(f, counts.get(f.id, 0)) for f in floors if f.building_id == b.id])
            for b in buildings if b.site_id == s.id]) for s in sites])

    @app.post('/api/v1/sites', response_model=C.MapSite, status_code=201)
    def site_create(body: C.MapName, auth: Identity, db: DB):
        user = auth[0]
        authorize(user, 'O')
        row = Site(org_id=user.org_id, name=body.name)
        db.add(row)
        db.flush()
        record(db, user, 'SITE_CREATED', row)
        return C.MapSite(id=row.id, name=row.name)

    @app.post('/api/v1/sites/{site_id}/buildings', response_model=C.MapBuilding, status_code=201)
    def building_create(site_id: UUID, body: C.MapName, auth: Identity, db: DB):
        user = auth[0]
        own(db, Site, site_id, user)
        authorize(user, 'O')
        row = Building(org_id=user.org_id, site_id=site_id, name=body.name)
        db.add(row)
        db.flush()
        record(db, user, 'BUILDING_CREATED', row)
        return C.MapBuilding(id=row.id, site_id=row.site_id, name=row.name)

    @app.post('/api/v1/buildings/{building_id}/floors', response_model=C.MapFloor, status_code=201)
    def floor_create(building_id: UUID, body: C.FloorCreate, auth: Identity, db: DB):
        user = auth[0]
        building = own(db, Building, building_id, user)
        authorize(user, 'O')
        row = Floor(provenance='SIMULATION' if building.sim_world_id else 'HUMAN', org_id=user.org_id, building_id=building_id, name=body.name, level=body.level)
        db.add(row)
        db.flush()
        record(db, user, 'FLOOR_CREATED', row)
        return floor_object(row)

    def mutable_routes(model, path, patch_model, response_model, serialize, prefix):
        def patch(identifier: UUID, body: patch_model, auth: Identity, db: DB):
            user = auth[0]
            row = own(db, model, identifier, user)
            authorize(user, 'O')
            for key, value in body.model_dump(exclude_unset=True).items():
                if value is None:
                    fail(400, 'VALIDATION', '빈 값으로 바꿀 수 없습니다.')
                setattr(row, key, value)
            record(db, user, prefix + '_UPDATED', row)
            return serialize(row)

        def remove(identifier: UUID, auth: Identity, db: DB):
            user = auth[0]
            row = own(db, model, identifier, user)
            authorize(user, 'O')
            if model is Site:
                used = db.scalar(select(Building.id).where(Building.site_id == row.id).limit(1))
            elif model is Building:
                used = db.scalar(select(Floor.id).where(Floor.building_id == row.id).limit(1))
            else:
                used = db.scalar(select(MapVersion.id).where(MapVersion.floor_id == row.id).limit(1))
                used = used or db.scalar(select(Robot.id).where(Robot.last_floor_id == row.id).limit(1))
                used = used or db.scalar(select(FloorConnector.id).where(FloorConnector.floor_b_id == row.id).limit(1))
                # Scenario points require an approved MapVersion. Keeping every
                # map snapshot already prevents deleting a referenced floor.
            if used:
                fail(409, 'RESOURCE_IN_USE', '하위 자료나 사용 중인 지도가 있어 지울 수 없습니다.')
            record(db, user, prefix + '_DELETED', row)
            db.delete(row)
        app.patch(path, response_model=response_model, name=prefix.lower() + '_patch')(patch)
        app.delete(path, status_code=204, name=prefix.lower() + '_delete')(remove)

    mutable_routes(Site, '/api/v1/sites/{identifier}', C.MapName, C.MapSite, lambda row: C.MapSite(id=row.id, name=row.name), 'SITE')
    mutable_routes(Building, '/api/v1/buildings/{identifier}', C.MapName, C.MapBuilding,
        lambda row: C.MapBuilding(id=row.id, site_id=row.site_id, name=row.name), 'BUILDING')
    mutable_routes(Floor, '/api/v1/floors/{identifier}', C.FloorPatch, C.MapFloor, floor_object, 'FLOOR')

    @app.post('/api/v1/uploads', response_model=C.MapUpload, status_code=201)
    async def upload(request: Request, auth: UploadIdentity, image: UUID | None = None):
        content_type = request.headers.get('content-type', '').split(';')[0].strip().lower()
        is_yaml = content_type in ('text/yaml', 'application/x-yaml')
        if content_type not in ('image/png', 'image/x-portable-graymap', 'text/yaml', 'application/x-yaml'):
            fail(422, 'INVALID_UPLOAD', 'PNG·PGM 이미지 또는 지도 YAML을 올려 주세요.')
        limit = MAX_YAML if is_yaml else MAX_IMAGE
        length = request.headers.get('content-length')
        if length is not None:
            if len(length) > 20 or not length.isdecimal():
                fail(422, 'INVALID_UPLOAD', '파일 길이가 올바르지 않습니다.')
            if int(length) > limit:
                fail(413, 'UPLOAD_TOO_LARGE', '올릴 수 있는 파일 크기를 넘었습니다.')
        data = bytearray()
        try:
            async with asyncio.timeout(UPLOAD_BODY_SECONDS):
                async for part in request.stream():
                    if len(data) + len(part) > limit:
                        fail(413, 'UPLOAD_TOO_LARGE', '올릴 수 있는 파일 크기를 넘었습니다.')
                    data.extend(part)
        except TimeoutError:
            fail(408, 'UPLOAD_TIMEOUT', '파일 수신 시간이 초과되었습니다.')
        if length is not None and int(length) != len(data):
            fail(422, 'INVALID_UPLOAD', '파일 길이가 본문과 다릅니다.')

        def process():
            # Conversion, digests, disk checks and writes run outside a database
            # transaction and off the event loop, with one admitted worker.
            try:
                if is_yaml:
                    if image is None:
                        fail(422, 'INVALID_UPLOAD', 'YAML과 연결할 이미지 업로드 ID가 필요합니다.')
                    metadata = map_yaml(bytes(data))
                    def insert_yaml(db, user):
                        original = own(db, Upload, image, user)
                        row = Upload(provenance=original.provenance, org_id=user.org_id, image_path=original.image_path,
                            image_sha256=original.image_sha256, png_sha256=original.png_sha256, size_bytes=original.size_bytes,
                            width=original.width, height=original.height, metadata_json=metadata, created_by=user.id)
                        db.add(row)
                        db.flush()
                        return C.MapUpload(upload_id=row.id, sha256=row.image_sha256.hex())
                    return upload_write(request, auth, insert_yaml)
                if image is not None:
                    fail(422, 'INVALID_UPLOAD', '이미지 본문에는 image 쿼리를 쓰지 않습니다.')
                png, width, height = image_bytes(bytes(data), content_type)
            except ValueError as exc:
                fail(422, 'INVALID_UPLOAD', str(exc))
            image_hash, png_hash = sha256(data), sha256(png)
            identifier = uuid4()
            relative = Path('uploads/tmp') / str(identifier) / 'image.png'
            destination = root / relative
            ensure_space(root, len(png), fail)
            destination.parent.mkdir(parents=True, exist_ok=False)
            try:
                destination.write_bytes(png)
                def insert_image(db, user):
                    row = Upload(id=identifier, org_id=user.org_id, image_path=str(relative), image_sha256=image_hash,
                        png_sha256=png_hash, size_bytes=len(data), width=width, height=height, metadata_json={}, created_by=user.id)
                    db.add(row)
                    db.flush()
                    return C.MapUpload(upload_id=row.id, sha256=row.image_sha256.hex())
                return upload_write(request, auth, insert_image)
            except BaseException:
                destination.unlink(missing_ok=True)
                destination.parent.rmdir()
                raise
        return await upload_work(conversion_slot, process, fail)

    @app.post('/api/v1/floors/{floor_id}/map-versions', response_model=C.MapVersion, status_code=201)
    def save(floor_id: UUID, body: C.MapVersionCreate, auth: Identity, db: DB, idempotency_key: idempotency.KeyHeader = None):
        user = auth[0]
        receipt, replay = idempotency.begin(db, user, idempotency_key, 'POST /floors/' + str(floor_id) + '/map-versions', body, fail)
        if replay is not None:
            return replay
        floor = own(db, Floor, floor_id, user, lock=True)
        if body.base_version_id != floor.approved_version_id:
            fail(409, 'STALE', '승인된 지도 판이 바뀌었습니다.', {'approved_version_id': str(floor.approved_version_id) if floor.approved_version_id else None})
        upload = own(db, Upload, body.image, user)
        if not upload.metadata_json:
            fail(422, 'INVALID_UPLOAD', '이미지에 지도 YAML을 연결한 업로드 ID가 필요합니다.')
        validate_features(db, floor, upload, body.features, fail)
        number = (db.scalar(select(func.max(MapVersion.number)).where(MapVersion.floor_id == floor.id)) or 0) + 1
        relative = Path('maps') / str(floor.id) / f'{number}-{upload.png_sha256.hex()[:12]}.png'
        destination = root / relative
        metadata = upload.metadata_json
        origin = metadata['origin']
        base_provenance = db.scalar(select(MapVersion.provenance).where(MapVersion.id == body.base_version_id)) if body.base_version_id else None
        row = MapVersion(provenance='SIMULATION' if 'SIMULATION' in (floor.provenance, upload.provenance, base_provenance) else 'HUMAN',
            org_id=user.org_id, floor_id=floor.id, number=number, base_version_id=body.base_version_id,
            status='APPROVED', upload_id=upload.id, image_path=str(relative), image_sha256=upload.png_sha256,
            width=upload.width, height=upload.height, resolution=metadata['resolution'], origin_x=origin[0],
            origin_y=origin[1], origin_yaw=origin[2], features=body.features.model_dump(mode='json', exclude_none=True), reason=body.reason,
            source='IMPORT' if body.base_version_id is None else 'EDIT', created_by=user.id)
        created = []
        try:
            ensure_space(root, (root / upload.image_path).stat().st_size + MAX_YAML, fail)
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive creation also prevents accidental overwrites after orphan files/crashes.
            png = (root / upload.image_path).read_bytes()
            if sha256(png) != upload.png_sha256:
                fail(503, 'FILE_STORAGE_ERROR', '지도 파일을 확인할 수 없습니다.')
            for target, content in ((destination, png), (destination.with_suffix('.yaml'), yaml_bytes(metadata, destination.name))):
                with target.open('xb') as output:
                    created.append(target)
                    output.write(content)
            db.add(row)
            db.flush()
            floor.approved_version_id = row.id
            db.flush()
            refresh_connectors(db, floor)
            record(db, user, 'MAP_VERSION_APPROVED', row)
            result = idempotency.finish(receipt, version_object(row, floor))
            db.commit()
            return result
        except BaseException as exc:
            for path in created:
                path.unlink(missing_ok=True)
            if isinstance(exc, OSError):
                fail(503, 'FILE_STORAGE_ERROR', '지도 파일을 읽거나 저장할 수 없습니다.')
            raise

    @app.get('/api/v1/map-versions/{version_id}/diff', response_model=C.MapDiff)
    def diff(version_id: UUID, auth: Identity, db: DB, against: UUID | None = None):
        user = auth[0]
        row = own(db, MapVersion, version_id, user)
        floor = own(db, Floor, row.floor_id, user)
        baseline_id = against if against is not None else row.base_version_id
        baseline = own(db, MapVersion, baseline_id, user) if baseline_id else None
        if baseline is not None and baseline.floor_id != row.floor_id:
            fail(404, 'NOT_FOUND', '장소·지도 자료를 찾을 수 없습니다.')
        current = bounded_features(row, fail)
        previous = bounded_features(baseline, fail) if baseline else dict.fromkeys(current, [])
        changes = []
        for kind in ('zones', 'waypoints', 'connectors', 'edits'):
            before, after = feature_index(previous[kind], kind), feature_index(current[kind], kind)
            before_positions = {key: i for i, key in enumerate(before)} if kind == 'edits' else {}
            after_positions = {key: i for i, key in enumerate(after)} if kind == 'edits' else {}
            for key in sorted(before.keys() | after.keys()):
                old, new = before.get(key), after.get(key)
                old_index, new_index = before_positions.get(key), after_positions.get(key)
                moved = old is not None and new is not None and old_index != new_index
                if old != new or moved:
                    changes.append(C.MapFeatureChange(kind=kind, key=key,
                        change='added' if old is None else 'removed' if new is None else 'changed', before=old, after=new,
                        before_index=old_index, after_index=new_index))
        result = C.MapDiff(version=version_object(row, floor), against=version_object(baseline, floor) if baseline else None,
            image_changed=baseline is None or row.image_sha256 != baseline.image_sha256, changes=changes)
        if len(result.model_dump_json().encode()) > MAX_DIFF_BYTES:
            fail(422, 'DIFF_TOO_LARGE', '비교 결과의 크기 상한을 넘었습니다.')
        return result

    @app.post('/api/v1/map-versions/{version_id}/rollback', response_model=C.MapVersion, status_code=201)
    def rollback(version_id: UUID, body: C.MapRollback, auth: Identity, db: DB, idempotency_key: idempotency.KeyHeader = None):
        user = auth[0]
        receipt, replay = idempotency.begin(db, user, idempotency_key, 'POST /map-versions/' + str(version_id) + '/rollback', body, fail)
        if replay is not None:
            return replay
        original = own(db, MapVersion, version_id, user)
        floor = own(db, Floor, original.floor_id, user, lock=True)
        if body.base_version_id != floor.approved_version_id:
            fail(409, 'STALE', '승인된 지도 판이 바뀌었습니다.', {'approved_version_id': str(floor.approved_version_id) if floor.approved_version_id else None})
        if original.id == floor.approved_version_id:
            fail(409, 'ALREADY_APPROVED', '이미 승인된 지도 판입니다.')
        if original.status != 'APPROVED':
            fail(409, 'ROLLBACK_NOT_APPROVED', '이전에 승인된 지도 판만 되돌릴 수 있습니다.')
        features = bounded_features(original, fail)
        validate_rollback_connectors(db, floor, features, fail)
        number = (db.scalar(select(func.max(MapVersion.number)).where(MapVersion.floor_id == floor.id)) or 0) + 1
        row = MapVersion(provenance='SIMULATION' if 'SIMULATION' in (floor.provenance, original.provenance) else 'HUMAN',
            org_id=user.org_id, floor_id=floor.id, number=number, base_version_id=body.base_version_id,
            copied_from_id=original.id, status='APPROVED', upload_id=original.upload_id,
            image_path=original.image_path, image_sha256=original.image_sha256, width=original.width, height=original.height,
            resolution=original.resolution, origin_x=original.origin_x, origin_y=original.origin_y, origin_yaw=original.origin_yaw,
            features=copy.deepcopy(original.features), reason=body.reason, source='ROLLBACK', created_by=user.id)
        # Immutable content-addressed snapshot file may be shared; never use a
        # possibly expired temporary upload or mutate the old snapshot/file.
        try:
            if sha256((root / original.image_path).read_bytes()) != original.image_sha256:
                fail(503, 'FILE_STORAGE_ERROR', '지도 파일을 확인할 수 없습니다.')
        except OSError:
            fail(503, 'FILE_STORAGE_ERROR', '지도 파일을 읽거나 저장할 수 없습니다.')
        db.add(row)
        db.flush()
        floor.approved_version_id = row.id
        db.flush()
        refresh_connectors(db, floor)
        record(db, user, 'MAP_VERSION_ROLLED_BACK', row, copied_from_id=str(original.id),
            base_version_id=str(body.base_version_id), copied_from_number=original.number, reason=body.reason)
        return idempotency.finish(receipt, version_object(row, floor))

    @app.get('/api/v1/floors/{floor_id}/map-versions', response_model=C.MapVersionList)
    def versions(floor_id: UUID, auth: Identity, db: DB, limit: Annotated[int, Query(ge=1, le=100)] = 50, cursor: str | None = None):
        user = auth[0]
        floor = own(db, Floor, floor_id, user)
        query = select(MapVersion).where(MapVersion.org_id == user.org_id, MapVersion.floor_id == floor.id)
        if cursor:
            if not cursor.isdecimal() or len(cursor) > 10 or not 1 <= int(cursor) <= 2147483647:
                fail(400, 'VALIDATION', '목록 위치가 올바르지 않습니다.')
            query = query.where(MapVersion.number < int(cursor))
        rows = list(db.scalars(query.order_by(MapVersion.number.desc()).limit(limit + 1)))
        more = len(rows) > limit
        rows = rows[:limit]
        return C.MapVersionList(items=[version_object(row, floor) for row in rows], next_cursor=str(rows[-1].number) if more else None)

    @app.get('/api/v1/map-versions/{version_id}', response_model=C.MapVersion)
    def version(version_id: UUID, auth: Identity, db: DB):
        row = own(db, MapVersion, version_id, auth[0])
        return version_object(row, own(db, Floor, row.floor_id, auth[0]))

    @app.get('/api/v1/map-versions/{version_id}/image', response_class=FileResponse)
    def image(version_id: UUID, auth: Identity, db: DB):
        row = own(db, MapVersion, version_id, auth[0])
        path = root / row.image_path
        if not path.is_file():
            fail(503, 'FILE_STORAGE_ERROR', '지도 파일을 찾을 수 없습니다.')
        return FileResponse(path, media_type='image/png', headers={'Cache-Control': 'private, no-store', 'ETag': '"' + row.image_sha256.hex() + '"'})

    @app.get('/api/v1/floor-connectors', response_model=C.FloorConnectorList)
    def connectors(building_id: UUID, auth: Identity, db: DB):
        user = auth[0]
        own(db, Building, building_id, user)
        rows = db.scalars(select(FloorConnector).where(FloorConnector.org_id == user.org_id, FloorConnector.building_id == building_id).order_by(FloorConnector.id))
        return C.FloorConnectorList(items=[C.FloorConnector(**{key: getattr(row, key) for key in C.FloorConnector.model_fields}) for row in rows])

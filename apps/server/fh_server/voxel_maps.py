"""Receive a completed SLAM file; never connects to a robot or starts a simulator."""
import asyncio
from pathlib import Path
import struct
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import Query, Request, Response
from sqlalchemy import select, func

from apps.contracts import models as C
from .map_files import sha256, yaml_bytes
from .maps import ensure_space, refresh_connectors, require_real_site, upload_work, version_object
from .models import Building, Floor, MapVersion, Site, Upload
from .terrains import save_terrain
from .voxel_links import twin_proof, voxel_summary
from .voxel_files import CELL, MAX_BYTES, MAX_VOXELS, PointCloudError, convert

RECORD = struct.Struct('<iii')



def publish_cloud(db, user, floor, base_version_id, result, data, format, terrain_id, root, fail, event, created):
    """Shared transaction: approved HUMAN snapshot and its exact simulation twin."""
    identifier = uuid4()
    folder = Path('maps') / str(floor.id) / str(identifier)
    png = result['png']
    cells = b''.join(RECORD.pack(*cell) for cell in result['cells'])
    summary = C.VoxelMapSummary(map_version_id=identifier, terrain_id=terrain_id,
        point_count=result['point_count'], voxel_count=result['voxel_count'], origin=result['origin'],
        source_translation=result['source_translation'], estimated_floor_z=result['floor_z'],
        source_sha256=sha256(data).hex(), cells_sha256=sha256(cells).hex(), warnings=result['warnings'])
    meta = dict(resolution=CELL, origin=result['origin'], negate=0, occupied_thresh=.65, free_thresh=.2,
        voxel_map=summary.model_dump(mode='json'), voxel_cells=str(folder / 'cells.bin'),
        voxel_original=str(folder / ('source.' + format)))
    ensure_space(root, len(data) + len(cells) + len(png) + 4_000_000, fail)
    (root / folder).mkdir(parents=True, exist_ok=False)
    for relative, content in ((folder / ('source.' + format), data), (folder / 'cells.bin', cells),
            (folder / 'image.png', png), (folder / 'image.yaml', yaml_bytes(meta, 'image.png'))):
        with (root / relative).open('xb') as out:
            created.append(root / relative)
            out.write(content)
    image = Upload(org_id=user.org_id, provenance='HUMAN', image_path=str(folder / 'image.png'),
        image_sha256=sha256(png), png_sha256=sha256(png), size_bytes=len(png),
        width=result['width'], height=result['height'], metadata_json=meta, created_by=user.id)
    db.add(image)
    db.flush()
    number = (db.scalar(select(func.max(MapVersion.number)).where(MapVersion.floor_id == floor.id)) or 0) + 1
    version = MapVersion(id=identifier, org_id=user.org_id, floor_id=floor.id, number=number,
        provenance='HUMAN', base_version_id=base_version_id, upload_id=image.id, status='APPROVED',
        image_path=image.image_path, image_sha256=image.png_sha256, width=image.width, height=image.height,
        resolution=CELL, origin_x=result['origin'][0], origin_y=result['origin'][1], origin_yaw=0.,
        features={'zones': [], 'waypoints': [], 'connectors': [], 'edits': []}, source='SLAM',
        reason='점 지도 파일에서 지도·시뮬 지형 자동 생성', created_by=user.id)
    db.add(version)
    db.flush()
    floor.approved_version_id = version.id
    refresh_connectors(db, floor)
    twin = dict(floor_id=str(floor.id), map_version_id=str(version.id),
        image_sha256=version.image_sha256.hex(), origin=result['origin'], resolution=CELL,
        width=version.width, height=version.height, terrain_id=terrain_id,
        terrain_size=list(result['spec'].size))
    terrain = save_terrain(db, user, terrain_id, C.TerrainWrite(spec=result['spec'], base_version=0),
        root, fail, event, created=created, twin=twin)
    event(db, user.org_id, 'MAP_VERSION_APPROVED', user.id,
        {'floor_id': str(floor.id), 'map_version_id': str(version.id), 'number': number}, category='APPROVAL')
    return C.VoxelMapImport(map=version_object(version, floor, image, db), terrain=terrain, voxels=summary)


def install(app, DB, Identity, UploadIdentity, upload_write, fail, authorize, event, settings):
    root = Path(settings.files_root).resolve()
    slot = asyncio.Semaphore(1)
    body_slot = asyncio.Semaphore(1)

    def own(db, model, identifier, user):
        row = db.scalar(select(model).where(model.org_id == user.org_id, model.id == identifier))
        if row is None:
            fail(404, 'NOT_FOUND', '점 지도 자료를 찾을 수 없습니다.')
        return row

    @app.post('/api/v1/floors/{floor_id}/voxel-maps', response_model=C.VoxelMapImport, status_code=201)
    async def upload(floor_id: UUID, request: Request, auth: UploadIdentity,
                     name: Annotated[C.MapNameText, Query(min_length=1, max_length=40, pattern=r'\S')],
                     format: Annotated[str, Query(pattern='^(pcd|ply)$')],
                     base_version_id: UUID | None = None):
        # Raw binary body avoids multipart spooling and filename/path interpretation.
        length = request.headers.get('content-length')
        if length is not None:
            if len(length) > 20 or not length.isdecimal():
                fail(422, 'INVALID_POINT_CLOUD', '파일 길이가 올바르지 않습니다.')
            if int(length) > MAX_BYTES:
                fail(413, 'UPLOAD_TOO_LARGE', '점 지도는 50 MB 이하로 올려 주세요.')
        # Bound complete bodies too: reserve before receiving, release only when work ends.
        if slot.locked() or body_slot.locked():
            fail(503, 'UPLOAD_BUSY', '다른 점 지도를 처리하고 있습니다. 잠시 뒤 다시 올려 주세요.')
        data = bytearray()
        def process():
            terrain_id = 'vox-' + uuid4().hex[:28]
            try:
                result = convert(bytes(data), format, terrain_id, name)
            except (ValueError, KeyError, IndexError, OverflowError, UnicodeError, struct.error) as exc:
                message = str(exc) if isinstance(exc, PointCloudError) else '점 지도 형식이 올바르지 않습니다. PCD·PLY XYZ 파일을 확인해 주세요.'
                fail(422, 'INVALID_POINT_CLOUD', message)
            created = []
            def write(db, user):
                authorize(user, 'A')
                floor = own(db, Floor, floor_id, user)
                # upload_write holds the organization's write lock.
                if floor.archived_at is not None:
                    fail(409, 'RESOURCE_ARCHIVED', '휴지통의 층을 먼저 되돌려 주세요.')
                building = own(db, Building, floor.building_id, user)
                site = own(db, Site, building.site_id, user)
                require_real_site(site, fail)
                if building.archived_at or site.archived_at:
                    fail(409, 'RESOURCE_ARCHIVED', '상위 장소·건물을 먼저 되돌려 주세요.')
                if floor.provenance != 'HUMAN':
                    fail(422, 'INVALID_POINT_CLOUD', '실기용 층에 점 지도를 올려 주세요.')
                if floor.approved_version_id != base_version_id:
                    fail(409, 'STALE', '승인된 지도 판이 바뀌었습니다. 지도를 다시 열어 주세요.')
                return publish_cloud(db, user, floor, base_version_id, result, data, format,
                    terrain_id, root, fail, event, created)
            try:
                return upload_write(request, auth, write)
            except BaseException as exc:
                for path in created:
                    path.unlink(missing_ok=True)
                if isinstance(exc, OSError):
                    fail(503, 'FILE_STORAGE_ERROR', '점 지도 파일을 읽거나 저장할 수 없습니다.')
                raise
        # upload_work owns the slot through worker completion/cancellation.
        async def receive():
            try:
                async with asyncio.timeout(60):
                    async for part in request.stream():
                        if len(data) + len(part) > MAX_BYTES:
                            fail(413, 'UPLOAD_TOO_LARGE', '점 지도는 50 MB 이하로 올려 주세요.')
                        data.extend(part)
            except TimeoutError:
                fail(408, 'UPLOAD_TIMEOUT', '파일 수신 시간이 초과되었습니다.')
            if length is not None and int(length) != len(data):
                fail(422, 'INVALID_POINT_CLOUD', '파일 길이가 본문과 다릅니다.')
        # Separate body admission ensures slow bodies cannot allocate many 50 MB buffers.
        async with body_slot:
            await receive()
            return await upload_work(slot, process, fail)


    @app.get('/api/v1/map-versions/{version_id}/voxels', response_model=C.VoxelCells)
    def read(version_id: UUID, response: Response, auth: Identity, db: DB,
             limit: Annotated[int, Query(ge=1, le=20_000)] = 10_000,
             cursor: Annotated[int, Query(ge=0, le=MAX_VOXELS)] = 0):
        row = own(db, MapVersion, version_id, auth[0])
        image = own(db, Upload, row.upload_id, auth[0])
        meta = image.metadata_json
        if 'voxel_map' not in meta:
            fail(404, 'NOT_FOUND', '이 지도 판에는 3D 칸 자료가 없습니다.')
        summary = C.VoxelMapSummary.model_validate(voxel_summary(db, row, image))
        path = (root / meta['voxel_cells']).resolve()
        try:
            if not path.is_relative_to(root) or path.stat().st_size != summary.voxel_count * RECORD.size:
                raise OSError()
            with path.open('rb') as source:
                source.seek(cursor * RECORD.size)
                cells = list(RECORD.iter_unpack(source.read(limit * RECORD.size)))
        except OSError:
            fail(503, 'FILE_STORAGE_ERROR', '3D 칸 자료를 읽을 수 없습니다.')
        following = cursor + len(cells)
        response.headers['Cache-Control'] = 'private, no-store'
        return C.VoxelCells(summary=summary, cells=cells,
            next_cursor=following if following < summary.voxel_count else None)


def simulation_twin(db, robot, floor_id, version_id, fail, target_id=None):
    """Resolve the server-created twin of this exact immutable annotation snapshot."""
    version = db.scalar(select(MapVersion).where(MapVersion.org_id == robot.org_id,
        MapVersion.id == version_id, MapVersion.floor_id == floor_id))
    if version is None or version.provenance != 'HUMAN':
        return floor_id, version_id
    image = db.scalar(select(Upload).where(Upload.org_id == robot.org_id, Upload.id == version.upload_id))
    summary = voxel_summary(db, version, image) if image else {}
    floor = db.scalar(select(Floor).where(Floor.org_id == robot.org_id, Floor.id == floor_id))
    def bad():
        fail(422, 'MAP_PROOF_UNAVAILABLE', '이 실기 지도 판과 연결된 시뮬 지형·원본·좌표 증명을 확인할 수 없습니다.')
    if (not summary or summary.get('map_version_id') != str(version.id) or floor is None
            or floor.provenance != 'HUMAN' or image.provenance != 'HUMAN'
            or image.png_sha256 != version.image_sha256):
        bad()
    terrain_id = summary.get('terrain_id')
    twin_floor = db.scalar(select(Floor).where(Floor.org_id == robot.org_id,
        Floor.terrain_id == terrain_id, Floor.archived_at.is_(None)))
    if twin_floor is None:
        bad()
    query = select(MapVersion).where(MapVersion.org_id == robot.org_id, MapVersion.floor_id == twin_floor.id)
    # Default to the original terrain raster paired with this exact source
    # snapshot. Explicit UUIDs are never replaced by a newer annotation/raster.
    if target_id:
        query = query.where(MapVersion.id == target_id)
    else:
        query = query.join(Upload, Upload.id == MapVersion.upload_id).where(
            Upload.org_id == robot.org_id,
            Upload.metadata_json['voxel_twin']['map_version_id'].astext == str(version.id),
            Upload.metadata_json['terrain_version'].as_integer() == 1).order_by(MapVersion.number).limit(1)
    twin_version = db.scalar(query)
    twin_image = db.get(Upload, twin_version.upload_id) if twin_version else None
    proof = twin_image.metadata_json.get('voxel_twin', {}) if twin_image else {}
    origin = [version.origin_x, version.origin_y, version.origin_yaw]
    expected = twin_proof(version, terrain_id)
    if (proof != expected or version.status not in ('APPROVED', 'SUPERSEDED')
            or image.metadata_json.get('origin') != origin or summary.get('origin') != origin
            or image.metadata_json.get('resolution') != version.resolution
            or (image.width, image.height) != (version.width, version.height)
            or twin_version is None or twin_image.org_id != robot.org_id
            or [twin_version.origin_x, twin_version.origin_y, twin_version.origin_yaw] != origin
            or not math_close(twin_version.width * twin_version.resolution, version.width * version.resolution)
            or not math_close(twin_version.height * twin_version.resolution, version.height * version.resolution)
            or twin_version.features != version.features
            or robot.sim_world_id != 'custom/' + terrain_id):
        bad()
    # The unchanged map_proof gate subsequently verifies SIMULATION + PGM + world + grid.
    return twin_floor.id, twin_version.id


def math_close(a, b):
    return abs(a - b) < 1e-8

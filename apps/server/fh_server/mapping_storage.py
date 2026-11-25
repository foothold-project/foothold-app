"""Preserve agent-computed 5 cm maps; optional terrain conversion is a later transaction."""
import asyncio
import json
import struct
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import Request, Response
from sqlalchemy import func, select

from apps.contracts import models as C
from apps.contracts.mapping_sources import mapping_adapter
from .map_files import gray_png, sha256, yaml_bytes
from .maps import ensure_space, refresh_connectors, upload_work
from .models import MappingSession, MapVersion, Upload, User
from .terrains import save_terrain
from .voxel_files import convert
from .voxel_links import twin_proof

RECORD = struct.Struct('<iii')


def encode(bundle):
    """Deterministic artifact hashes; preserve all cells and native coordinates."""
    voxels = sorted(set(bundle.voxels))
    cells = b''.join(RECORD.pack(*cell) for cell in voxels)
    grid = bundle.grid
    raster = bytes(grid.cells)
    pixels = bytes((205, 254, 0)[v] for y in range(grid.height - 1, -1, -1)
                   for v in grid.cells[y * grid.width:(y + 1) * grid.width])
    png = gray_png(grid.width, grid.height, pixels)
    metadata = grid.model_dump(mode='json', exclude={'cells'})
    fingerprint = dict(source=bundle.source, revision=bundle.revision, frame_id=bundle.frame_id, resolution=.05,
        grid=metadata, odom=bundle.odom.model_dump(mode='json') if bundle.odom else None,
        voxels_sha256=sha256(cells).hex(), grid_sha256=sha256(raster).hex())
    digest = sha256(json.dumps(fingerprint, sort_keys=True, separators=(',', ':')).encode()).hex()
    return cells, raster, png, fingerprint, digest


def write_artifacts(root, folder, artifacts, created):
    (root / folder).mkdir(parents=True, exist_ok=False)
    for name, data in artifacts.items():
        path = root / folder / name
        with path.open('xb') as out:
            created.append(path)
            out.write(data)


def publish(db, row, user, floor, bundle, encoded, root, fail, event, created):
    cells, raster, png, fingerprint, digest = encoded
    identifier = uuid4()
    folder = Path('maps') / str(floor.id) / str(identifier)
    grid = bundle.grid
    manifest = dict(schema='fh_slam_bundle/1', name=row.progress['name'], session_id=str(row.id),
        robot_id=str(row.robot_id), map_version_id=str(identifier),
        **fingerprint, sha256=digest, voxels_path=str(folder / 'slam-voxels.bin'),
        grid_path=str(folder / 'slam-grid.bin'), voxel_count=len(cells) // RECORD.size,
        floor_z=grid.floor_z, axis='XYZ', source_translation=[0, 0, 0], slam_save=bundle.slam_save,
        completeness='RECEIVED_ONLY' if bundle.slam_save != 'SLAM_SAVED' else 'SLAM_CONFIRMED')
    metadata = dict(resolution=.05, origin=list(grid.origin), negate=0, occupied_thresh=.65,
        free_thresh=.2, slam_bundle=manifest)
    artifacts = {'slam-voxels.bin': cells, 'slam-grid.bin': raster, 'image.png': png,
        'image.yaml': yaml_bytes(metadata, 'image.png'),
        'manifest.json': json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()}
    ensure_space(root, sum(len(data) for data in artifacts.values()), fail)
    write_artifacts(root, folder, artifacts, created)
    image = Upload(org_id=row.org_id, provenance='HUMAN', image_path=str(folder / 'image.png'),
        image_sha256=sha256(png), png_sha256=sha256(png), size_bytes=len(png),
        width=grid.width, height=grid.height, metadata_json=metadata, created_by=user.id)
    db.add(image)
    db.flush()
    number = (db.scalar(select(func.max(MapVersion.number)).where(MapVersion.floor_id == floor.id)) or 0) + 1
    version = MapVersion(id=identifier, org_id=row.org_id, floor_id=floor.id, number=number,
        provenance='HUMAN', base_version_id=row.base_version_id, upload_id=image.id, status='APPROVED',
        image_path=image.image_path, image_sha256=image.png_sha256, width=grid.width, height=grid.height,
        resolution=.05, origin_x=grid.origin[0], origin_y=grid.origin[1], origin_yaw=0,
        features={'zones': [], 'waypoints': [], 'connectors': [], 'edits': []}, source='SLAM',
        reason=('GLIM 최종 5 cm 3D·2D 지도 묶음 저장' if bundle.slam_save == 'SLAM_SAVED'
            else 'SLAM 저장 미확인 · 받은 범위의 5 cm 3D·2D 지도 묶음 보관'), created_by=user.id)
    db.add(version)
    db.flush()
    floor.approved_version_id = identifier
    refresh_connectors(db, floor)
    event(db, row.org_id, 'MAP_VERSION_APPROVED', user.id,
        {'floor_id': str(floor.id), 'map_version_id': str(identifier), 'number': number}, category='APPROVAL')
    row.status = 'SAVED'
    row.result = dict(bundle=manifest, map_version_id=str(identifier), terrain_id=None)
    times = dict(row.progress.get('times') or {})
    if bundle.times:
        times.update(bundle.times.model_dump(mode='json', exclude_none=True,
            exclude={'server_received_at', 'start_requested_at', 'save_requested_at', 'command_forwarded_at',
                'start_forwarded_at', 'save_forwarded_at', 'start_ack_at', 'save_ack_at', 'saved_at'}))
    from .models import now
    received = now().isoformat()
    times.setdefault('first_data_at', received)
    times['last_data_at'] = received
    row.progress = {**row.progress, 'slam_save': bundle.slam_save, 'phase': bundle.slam_save,
        'terrain_status': 'PENDING', 'times': times,
        'point_count': len(cells) // RECORD.size, 'error_code': None,
        'reason': None if bundle.slam_save == 'SLAM_SAVED' else 'SLAM 저장 확인 안 됨 · 받은 범위만 보관했습니다.'}
    if bundle.odom:
        row.progress = {**row.progress, 'odom': bundle.odom.model_dump(mode='json')}
    from .mapping import server_time
    server_time(row, 'saved_at')


def point_cloud(cells):
    # Convert exact cell centres through the unchanged 10 cm terrain converter.
    count = len(cells) // RECORD.size
    header = f'FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nWIDTH {count}\nHEIGHT 1\nPOINTS {count}\nDATA binary\n'.encode()
    return header + b''.join(struct.pack('<fff', *((v + .5) * .05 for v in cell))
                            for cell in RECORD.iter_unpack(cells))


def install(app, DB, Identity, factory, settings, fail, event, lock_organization, mapping):
    from .mapping import builtin, owner_scope, progress
    root = Path(settings.files_root).resolve()
    slot, body_slot = asyncio.Semaphore(1), asyncio.Semaphore(1)

    def selected(db, robot_id, session_id):
        row = db.scalar(select(MappingSession).where(MappingSession.org_id == settings.org_id,
            MappingSession.id == session_id, MappingSession.robot_id == robot_id))
        if row is None or not builtin(row):
            fail(409, 'MAPPING_SESSION_MISMATCH', '지도 만들기 작업을 확인해 주세요.')
        user = db.get(User, row.owner_id)
        _, floor = owner_scope(db, settings.org_id, robot_id, user, fail, row.floor_id)
        if row.status != 'SAVED':
            if (not (row.progress.get('times') or {}).get('save_requested_at')
                    or row.status not in ('SAVING', 'FINALIZING', 'FAILED', 'UNKNOWN')
                    or row.progress.get('phase') not in ('SAVE_REQUESTED', 'SLAM_SAVED', 'FAILED', 'UNKNOWN')):
                fail(409, 'MAPPING_STATE_CONFLICT', '지도 저장을 먼저 요청해 주세요.')
            if floor.approved_version_id != row.base_version_id:
                fail(409, 'STALE', '층의 지도 판이 바뀌었습니다.')
        return row, user, floor

    def terrain(robot_id, session_id, cells):
        created = []
        try:
            with factory() as db:
                lock_organization(db, settings.org_id)
                row, user, _ = selected(db, robot_id, session_id)
                if row.progress.get('terrain_status') == 'READY':
                    return
                terrain_id = 'slam-' + uuid4().hex[:26]
                result = convert(point_cloud(cells), 'pcd', terrain_id, row.progress['name'])
                saved = save_terrain(db, user, terrain_id, C.TerrainWrite(spec=result['spec'], base_version=0),
                    root, fail, event, created=created)
                version = db.get(MapVersion, UUID(row.result['map_version_id']))
                # Native mapping and centered terrain have different coordinates/cropping.
                # Record the transform explicitly, never advertise an exact raster twin.
                link = dict(source=twin_proof(version, terrain_id), source_translation=result['source_translation'],
                    warnings=result['warnings'], terrain_id=terrain_id,
                    map_version_id=str(saved.map_version_id), floor_id=str(saved.floor_id))
                # Uploads are immutable: keep the later terrain link on the
                # durable session, reachable from the bundle session_id.
                row.result = {**row.result, 'terrain_id': terrain_id, 'terrain': link}
                row.progress = {**row.progress, 'terrain_status': 'READY'}
                db.commit()
        except Exception:
            for path in created:
                path.unlink(missing_ok=True)
            with factory() as db:
                lock_organization(db, settings.org_id)
                row = db.get(MappingSession, session_id)
                if row and row.org_id == settings.org_id and row.status == 'SAVED':
                    row.progress = {**row.progress, 'terrain_status': 'FAILED'}
                    db.commit()

    @app.post('/api/v1/agent/robots/{robot_id}/slam/{session_id}/bundle', status_code=201,
              response_model=C.MappingProgress)
    async def upload(robot_id: UUID, session_id: UUID, request: Request):
        rid, simulation = await app.state.realtime.read(app.state.realtime.agent_auth, request.headers)
        if rid != str(robot_id) or simulation:
            fail(403, 'FORBIDDEN', '이 로봇의 연결 인증을 확인해 주세요.')
        def admission():
            with factory() as db:
                selected(db, robot_id, session_id)
        await app.state.realtime.read(admission)
        length = request.headers.get('content-length')
        if length is not None and (not length.isdecimal() or len(length) > 20):
            fail(422, 'VALIDATION', '파일 길이가 올바르지 않습니다.')
        if length is not None and int(length) > C.MAPPING_BUNDLE_BYTES:
            fail(413, 'UPLOAD_TOO_LARGE', '지도 묶음은 50 MB 이하로 올려 주세요.')
        if slot.locked() or body_slot.locked():
            fail(503, 'UPLOAD_BUSY', '다른 지도를 저장하고 있습니다.')
        data = bytearray()
        def process():
            try:
                bundle = C.MappingBundle.model_validate_json(data)
            except ValueError:
                fail(422, 'VALIDATION', '지도 묶음 형식을 확인해 주세요.')
            if bundle.session_id != session_id:
                fail(409, 'MAPPING_SESSION_MISMATCH', '지도 만들기 작업을 확인해 주세요.')
            if bundle.odom and (bundle.odom.provider != bundle.source
                    or not mapping_adapter(bundle.source).accepts_odom(bundle.odom.source)):
                fail(422, 'MAPPING_POSE_SOURCE_MISMATCH', '최종 지도와 같은 출처·좌표의 위치를 확인해 주세요.')
            encoded = encode(bundle)
            created = []
            try:
                # Pin the content before filesystem writes so a partial failure can
                # only retry the same pair. Admission/auth checked again after receive.
                with factory() as db:
                    lock_organization(db, settings.org_id)
                    app.state.realtime.agent_auth(request.headers)
                    row, _, _ = selected(db, robot_id, session_id)
                    prior = (row.result or {}).get('bundle', {})
                    if prior and (prior['sha256'] != encoded[-1] or prior['revision'] != bundle.revision):
                        fail(409, 'MAPPING_BUNDLE_CONFLICT', '같은 판의 같은 지도 묶음으로 다시 저장해 주세요.')
                    if bundle.revision != row.progress.get('revision'):
                        fail(409, 'MAPPING_REVISION_CONFLICT', '지도 판을 확인해 주세요.')
                    if bundle.source != row.progress.get('source'):
                        fail(409, 'MAPPING_SOURCE_CONFLICT', '마지막 지도 판과 같은 출처로 저장해 주세요.')
                    if row.status != 'SAVED':
                        row.result = dict(bundle=dict(sha256=encoded[-1], revision=bundle.revision), map_version_id=None)
                        db.commit()
                with factory() as db:
                    lock_organization(db, settings.org_id)
                    app.state.realtime.agent_auth(request.headers)
                    row, user, floor = selected(db, robot_id, session_id)
                    if row.status != 'SAVED':
                        publish(db, row, user, floor, bundle, encoded, root, fail, event, created)
                        db.commit()
                    elif bundle.slam_save == 'SLAM_SAVED' and row.progress.get('slam_save') != 'SLAM_SAVED':
                        row.progress = {**row.progress, 'slam_save': 'SLAM_SAVED', 'phase': 'SLAM_SAVED', 'reason': None}
                        from .mapping import server_time
                        server_time(row, 'save_ack_at')
                        db.commit()
            except BaseException as exc:
                for path in created:
                    path.unlink(missing_ok=True)
                with factory() as db:
                    lock_organization(db, settings.org_id)
                    row = db.get(MappingSession, session_id)
                    if row and row.org_id == settings.org_id and row.status in ('SAVING', 'FINALIZING', 'UNKNOWN'):
                        row.status = 'FAILED'
                        row.progress = {**row.progress, 'error_code': 'MAPPING_SAVE_FAILED',
                            'reason': '지도를 저장하지 못했습니다. 같은 판으로 다시 저장해 주세요.'}
                        db.commit()
                if isinstance(exc, OSError):
                    fail(503, 'FILE_STORAGE_ERROR', '지도를 저장하지 못했습니다.')
                raise
            terrain(robot_id, session_id, encoded[0])
            with factory() as db:
                return progress(selected(db, robot_id, session_id)[0])
        async with body_slot:
            try:
                async with asyncio.timeout(60):
                    async for part in request.stream():
                        if len(data) + len(part) > C.MAPPING_BUNDLE_BYTES:
                            fail(413, 'UPLOAD_TOO_LARGE', '지도 묶음은 50 MB 이하로 올려 주세요.')
                        data.extend(part)
            except TimeoutError:
                fail(408, 'UPLOAD_TIMEOUT', '파일 수신 시간이 초과되었습니다.')
            if length is not None and int(length) != len(data):
                fail(422, 'VALIDATION', '파일 길이가 본문과 다릅니다.')
            return await upload_work(slot, process, fail)

    @app.get('/api/v1/robots/{robot_id}/slam/{session_id}/bundle')
    def manifest(robot_id: UUID, session_id: UUID, response: Response, db: DB, auth: Identity):
        owner_scope(db, settings.org_id, robot_id, auth[0], fail)
        row, _, _ = selected(db, robot_id, session_id)
        if row.status != 'SAVED':
            fail(409, 'MAPPING_STATE_CONFLICT', '지도 저장을 기다려 주세요.')
        response.headers['Cache-Control'] = 'private, no-store'
        return row.result

    @app.get('/api/v1/robots/{robot_id}/slam/{session_id}/bundle/{kind}')
    def artifact(robot_id: UUID, session_id: UUID, kind: str, db: DB, auth: Identity):
        owner_scope(db, settings.org_id, robot_id, auth[0], fail)
        row, _, _ = selected(db, robot_id, session_id)
        if row.status != 'SAVED' or kind not in ('voxels', 'grid'):
            fail(404, 'NOT_FOUND', '저장된 지도 자료를 찾을 수 없습니다.')
        bundle = row.result['bundle']
        path = (root / bundle[kind + '_path']).resolve()
        try:
            if not path.is_relative_to(root):
                raise OSError()
            data = path.read_bytes()
            if sha256(data).hex() != bundle[kind + '_sha256']:
                raise OSError()
        except OSError:
            fail(503, 'FILE_STORAGE_ERROR', '저장된 지도 자료를 읽을 수 없습니다.')
        return Response(data, media_type='application/octet-stream', headers={'Cache-Control': 'private, no-store'})

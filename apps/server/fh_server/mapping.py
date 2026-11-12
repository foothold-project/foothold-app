"""Operator-owned read-only acquisition. No robot output, leases or simulator calls."""
import asyncio
import json
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import Request, Response
from sqlalchemy import select

from apps.contracts import models as C
from .models import Building, Floor, MappingSession, Robot, Site, User
from .maps import upload_work
from .voxel_files import MAX_BYTES, PointCloudError, convert
from .voxel_maps import publish_cloud

ACTIVE = ('RUNNING', 'SAVING', 'FAILED')


def owner_scope(db, org_id, robot_id, user, fail, floor_id=None):
    robot = db.scalar(select(Robot).where(Robot.org_id == org_id, Robot.id == robot_id))
    if robot is None:
        fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
    if user.role != 'OPERATOR' or robot.owner_user_id != user.id or user.locked or user.archived_at:
        fail(403, 'MAPPING_OWNER_ONLY', '이 로봇의 담당 운영자만 지도를 만들 수 있습니다.')
    if robot.archived_at:
        fail(409, 'RESOURCE_ARCHIVED', '휴지통의 로봇을 먼저 되돌려 주세요.')
    if robot.simulation:
        fail(422, 'MAPPING_REAL_ONLY', '실제 로봇으로 실제 장소의 지도를 만들어 주세요.')
    if floor_id is None:
        return robot, None
    floor = db.scalar(select(Floor).where(Floor.org_id == org_id, Floor.id == floor_id))
    building = db.get(Building, floor.building_id) if floor else None
    site = db.get(Site, building.site_id) if building else None
    if floor is None or site is None or site.org_id != org_id:
        fail(404, 'NOT_FOUND', '층을 찾을 수 없습니다.')
    if floor.archived_at or building.archived_at or site.archived_at:
        fail(409, 'RESOURCE_ARCHIVED', '휴지통의 장소·건물·층을 먼저 되돌려 주세요.')
    if floor.provenance != 'HUMAN' or site.purpose != 'REAL':
        fail(422, 'MAPPING_REAL_ONLY', '실제 장소의 층을 골라 주세요.')
    return robot, floor


def progress(row):
    body = {**(row.progress or {}), 'session_id': row.id, 'floor_id': row.floor_id, 'status': row.status}
    if row.result:
        body.update(map_version_id=row.result['map']['id'], terrain_id=row.result['voxels']['terrain_id'],
                    point_count=row.result['voxels']['point_count'])
    return C.MappingProgress.model_validate(body)


class Mapping:
    def __init__(self, realtime, fail):
        self.realtime, self.fail = realtime, fail

    def connected(self, robot_id):
        peer = self.realtime.agents.get(str(robot_id))
        return bool(peer is not None and not peer.closing and not peer.simulation
                    and self.realtime.clock() - peer.last_rx < 3)

    def command_allowed(self, rid, body):
        # Final send gate: only exact REST-authorized pending commands, once.
        return (rid, body.get('session_id'), body.get('floor_id'), body.get('op')) in self.pending

    def consume(self, rid, body):
        self.pending.discard((rid, body.get('session_id'), body.get('floor_id'), body.get('op')))

    def dispatch(self, row, op):
        rid = str(row.robot_id)
        peer = self.realtime.agents.get(rid)
        if not self.connected(rid):
            self.fail(409, 'ROBOT_OFFLINE', '노트북 연결 프로그램을 먼저 연결해 주세요.')
        body = C.AgentMappingCommand(op=op, session_id=row.id, floor_id=row.floor_id).model_dump(mode='json')
        # Preserve start→save ordering if both are queued before the first send.
        # A new session invalidates all older commands; cancel invalidates this session.
        if op == 'start':
            self.pending = {key for key in self.pending if key[0] != rid}
        elif op == 'cancel':
            self.pending = {key for key in self.pending if key[1] != str(row.id)}
        self.pending.add((rid, str(row.id), str(row.floor_id), op))
        self.realtime.put(peer, body)

    def report(self, rid, msg):
        if len(msg.model_dump_json().encode()) > 65536:
            return
        from .api import lock_organization
        with self.realtime.run_factory() as db:
            lock_organization(db, self.realtime.settings.org_id)
            row = db.get(MappingSession, msg.session_id)
            if (row is None or row.org_id != self.realtime.settings.org_id
                    or str(row.robot_id) != rid or row.floor_id != msg.floor_id
                    or row.status in ('SAVED', 'CANCELLED') or msg.status == 'SAVED'):
                return
            # The REST request owns SAVING; late RUNNING may never resurrect it.
            if msg.status == 'RUNNING' and row.status != 'RUNNING':
                return
            if msg.status == 'SAVING' and row.status != 'SAVING':
                return
            if msg.status == 'CANCELLED':
                return  # cancellation is owned by the requesting operator
            row.status = msg.status
            body = msg.model_dump(mode='json', exclude={'t', 'map_version_id', 'terrain_id'})
            row.progress = body
            db.commit()


def install(app, DB, Identity, factory, settings, fail, event, lock_organization):
    mapping = Mapping(app.state.realtime, fail)
    mapping.pending = set()
    app.state.mapping = mapping
    app.state.realtime.mapping = mapping
    slot, body_slot = asyncio.Semaphore(1), asyncio.Semaphore(1)

    def latest(db, robot_id):
        return db.scalar(select(MappingSession).where(MappingSession.org_id == settings.org_id,
            MappingSession.robot_id == robot_id).order_by(MappingSession.created_at.desc()).limit(1))

    def selected(db, robot_id, session_id, user, *, bind_owner=True):
        row = db.scalar(select(MappingSession).where(MappingSession.org_id == settings.org_id,
            MappingSession.robot_id == robot_id, MappingSession.id == session_id))
        if row is None:
            fail(409, 'MAPPING_SESSION_MISMATCH', '지도를 다시 열어 현재 작업을 확인해 주세요.')
        owner_scope(db, settings.org_id, robot_id, user, fail, row.floor_id)
        if bind_owner and row.owner_id != user.id:
            fail(403, 'MAPPING_OWNER_ONLY', '지도를 만들기 시작한 담당 운영자만 저장할 수 있습니다.')
        return row

    @app.get('/api/v1/robots/{robot_id}/slam', response_model=C.MappingProgress | None)
    def get(robot_id: UUID, response: Response, db: DB, auth: Identity):
        owner_scope(db, settings.org_id, robot_id, auth[0], fail)
        row = latest(db, robot_id)
        response.headers['Cache-Control'] = 'private, no-store'
        # Reflect disconnected acquisition promptly even if the agent cannot report.
        if row and row.status in ('RUNNING', 'SAVING') and not mapping.connected(robot_id):
            body = progress(row).model_dump(mode='json')
            body.update(status='FAILED', error_code='LINK_LOST', reason='연결이 끊겼습니다. 다시 연결한 뒤 저장하거나 취소해 주세요.')
            return C.MappingProgress.model_validate(body)
        return progress(row) if row else None

    @app.post('/api/v1/robots/{robot_id}/slam/start', status_code=202, response_model=C.MappingProgress)
    async def start(robot_id: UUID, body: C.MappingStart, db: DB, auth: Identity):
        _, floor = owner_scope(db, settings.org_id, robot_id, auth[0], fail, body.floor_id)
        row = latest(db, robot_id)
        if row and row.status in ACTIVE:
            fail(409, 'MAPPING_ACTIVE', '이미 지도를 만들고 있습니다. 저장하거나 취소해 주세요.')
        if not mapping.connected(robot_id):
            fail(409, 'ROBOT_OFFLINE', '노트북 연결 프로그램을 먼저 연결해 주세요.')
        row = MappingSession(id=uuid4(), org_id=settings.org_id, robot_id=robot_id,
            floor_id=floor.id, owner_id=auth[0].id, base_version_id=floor.approved_version_id, status='RUNNING')
        db.add(row)
        db.commit()  # durable identity before putting a frame on the live socket
        mapping.dispatch(row, 'start')
        return progress(row)

    @app.post('/api/v1/robots/{robot_id}/slam/save', status_code=202, response_model=C.MappingProgress)
    async def save(robot_id: UUID, body: C.MappingAction, db: DB, auth: Identity):
        row = selected(db, robot_id, body.session_id, auth[0])
        if row.status == 'SAVED':
            return progress(row)
        if row.status == 'CANCELLED':
            fail(409, 'MAPPING_STATE_CONFLICT', '취소한 지도입니다. 새로 시작해 주세요.')
        if not mapping.connected(robot_id):
            fail(409, 'ROBOT_OFFLINE', '노트북 연결 프로그램을 먼저 연결해 주세요.')
        if row.status == 'SAVING':
            return progress(row)
        row.status = 'SAVING'
        db.commit()
        mapping.dispatch(row, 'save')
        return progress(row)

    @app.post('/api/v1/robots/{robot_id}/slam/cancel', response_model=C.MappingProgress)
    async def cancel(robot_id: UUID, body: C.MappingAction, db: DB, auth: Identity):
        row = selected(db, robot_id, body.session_id, auth[0], bind_owner=False)
        if row.status == 'SAVED':
            fail(409, 'MAPPING_STATE_CONFLICT', '이미 저장한 지도입니다.')
        row.status = 'CANCELLED'
        row.progress = {**(row.progress or {}), 'error_code': None, 'reason': None}
        db.commit()
        mapping.pending = {key for key in mapping.pending if key[1] != str(row.id)}
        if mapping.connected(robot_id):
            mapping.dispatch(row, 'cancel')
        return progress(row)

    @app.post('/api/v1/agent/robots/{robot_id}/slam/{session_id}/progress', status_code=202)
    async def report(robot_id: UUID, session_id: UUID, request: Request):
        rid, simulation = await app.state.realtime.read(app.state.realtime.agent_auth, request.headers)
        if rid != str(robot_id) or simulation:
            fail(403, 'FORBIDDEN', '이 로봇의 연결 인증을 확인해 주세요.')
        data = bytearray()
        async with asyncio.timeout(5):
            async for part in request.stream():
                if len(data) + len(part) > 65536:
                    fail(413, 'MAPPING_REPORT_TOO_LARGE', '지도 미리보기 크기를 줄여 주세요.')
                data.extend(part)
        try:
            msg = C.AgentMappingUpdate.model_validate_json(data)
        except ValueError:
            fail(422, 'VALIDATION', '지도 진행 자료 형식을 확인해 주세요.')
        if msg.session_id != session_id:
            fail(409, 'MAPPING_SESSION_MISMATCH', '지도 만들기 작업을 확인해 주세요.')
        await app.state.realtime.read(mapping.report, rid, msg)
        return {'accepted': True}

    @app.post('/api/v1/agent/robots/{robot_id}/slam/{session_id}/point-cloud',
              status_code=201, response_model=C.VoxelMapImport)
    async def upload(robot_id: UUID, session_id: UUID, request: Request):
        rid, simulation = await app.state.realtime.read(app.state.realtime.agent_auth, request.headers)
        if rid != str(robot_id) or simulation:
            fail(403, 'FORBIDDEN', '이 로봇의 연결 인증을 확인해 주세요.')
        def validated(db):
            row = db.scalar(select(MappingSession).where(MappingSession.id == session_id,
                MappingSession.org_id == settings.org_id, MappingSession.robot_id == robot_id))
            if row is None:
                fail(409, 'MAPPING_SESSION_MISMATCH', '지도 만들기 작업을 확인해 주세요.')
            user = db.get(User, row.owner_id)
            _, floor = owner_scope(db, settings.org_id, robot_id, user, fail, row.floor_id)
            if row.status == 'SAVED':
                return row, user, floor
            if row.status != 'SAVING':
                fail(409, 'MAPPING_STATE_CONFLICT', '지도 저장을 먼저 요청해 주세요.')
            if not mapping.connected(robot_id):
                fail(409, 'ROBOT_OFFLINE', '노트북 연결 프로그램을 다시 연결해 주세요.')
            if floor.approved_version_id != row.base_version_id:
                fail(409, 'STALE', '층의 지도가 바뀌었습니다. 취소한 뒤 다시 시작해 주세요.')
            return row, user, floor
        def admission():
            with factory() as db:
                row, _, _ = validated(db)
                return row.result if row.status == 'SAVED' else None
        prior = await app.state.realtime.read(admission)
        if prior:
            return C.VoxelMapImport.model_validate(prior)
        length = request.headers.get('content-length')
        if length and (not length.isdecimal() or len(length) > 20):
            fail(422, 'INVALID_POINT_CLOUD', '파일 길이가 올바르지 않습니다.')
        if length and int(length) > MAX_BYTES:
            fail(413, 'UPLOAD_TOO_LARGE', '점 지도는 50 MB 이하로 올려 주세요.')
        if slot.locked() or body_slot.locked():
            fail(503, 'UPLOAD_BUSY', '다른 지도를 저장하고 있습니다. 잠시 뒤 다시 저장해 주세요.')
        data = bytearray()
        def process():
            created = []
            try:
                terrain_id = 'vox-' + uuid4().hex[:28]
                result = convert(bytes(data), 'pcd', terrain_id, '로봇이 만든 지도')
                with factory() as db:
                    lock_organization(db, settings.org_id)
                    # Token rotation/ownership/cancel/base checked again after body and conversion.
                    app.state.realtime.agent_auth(request.headers)
                    row, user, floor = validated(db)
                    if row.status == 'SAVED':
                        return C.VoxelMapImport.model_validate(row.result)
                    saved = publish_cloud(db, user, floor, row.base_version_id, result, data, 'pcd',
                        terrain_id, Path(settings.files_root).resolve(), fail, event, created)
                    row.status, row.result = 'SAVED', saved.model_dump(mode='json')
                    row.progress = {**(row.progress or {}), 'error_code': None, 'reason': None}
                    db.commit()
                    return saved
            except BaseException as exc:
                for path in created:
                    path.unlink(missing_ok=True)
                # Preserve cancelled/saved decisions and expose a retryable failure.
                with factory() as db:
                    lock_organization(db, settings.org_id)
                    row = db.get(MappingSession, session_id)
                    if row and row.org_id == settings.org_id and row.status == 'SAVING':
                        row.status = 'FAILED'
                        row.progress = {**(row.progress or {}), 'error_code': 'MAPPING_SAVE_FAILED',
                            'reason': '지도를 저장하지 못했습니다. 연결을 확인한 뒤 다시 저장해 주세요.'}
                        db.commit()
                if isinstance(exc, PointCloudError):
                    fail(422, 'INVALID_POINT_CLOUD', str(exc))
                if isinstance(exc, OSError):
                    fail(503, 'FILE_STORAGE_ERROR', '지도를 저장하지 못했습니다. 다시 저장해 주세요.')
                raise
        async with body_slot:
            try:
                async with asyncio.timeout(60):
                    async for part in request.stream():
                        if len(data) + len(part) > MAX_BYTES:
                            fail(413, 'UPLOAD_TOO_LARGE', '점 지도는 50 MB 이하로 올려 주세요.')
                        data.extend(part)
            except TimeoutError:
                fail(408, 'UPLOAD_TIMEOUT', '파일 수신 시간이 초과되었습니다.')
            if length and int(length) != len(data):
                fail(422, 'INVALID_POINT_CLOUD', '파일 길이가 본문과 다릅니다.')
            return await upload_work(slot, process, fail)

"""Owner-authorized SLAM sessions and observation uploads, independent of movement leases."""
import asyncio
import json
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import Query, Request, Response
from sqlalchemy import delete, func, select
from typing import Annotated

from apps.contracts import models as C
from apps.contracts.mapping_sources import DEFAULT_FINAL_SOURCE, mapping_adapter
from .models import Building, Floor, MappingSession, MappingTile, Robot, Site, User, now
from .maps import upload_work
from .voxel_files import MAX_BYTES, PointCloudError, convert
from .voxel_maps import publish_cloud

ACTIVE = ('STARTING', 'RUNNING', 'SAVING', 'FINALIZING', 'UNKNOWN', 'FAILED')
PERSISTED = ('SAVED', 'RECEIVED_ONLY')


def builtin(row):
    return mapping_adapter((row.progress or {}).get('source')) is not None


def server_time(row, key):
    body = dict(row.progress or {})
    body['times'] = {**(body.get('times') or {}), key: now().isoformat()}
    row.progress = body


def owner_scope(db, org_id, robot_id, user, fail, floor_id=None):
    robot = db.scalar(select(Robot).where(Robot.org_id == org_id, Robot.id == robot_id))
    if robot is None:
        fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
    if user is None or user.role != 'OPERATOR' or robot.owner_user_id != user.id or user.locked or user.archived_at:
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
    if row.result and 'bundle' in row.result:
        body.update(map_version_id=row.result['map_version_id'], terrain_id=row.result.get('terrain_id'))
    elif row.result:
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
        key = (rid, body.get('session_id'), body.get('floor_id'), body.get('op'))
        return key in self.pending and self.pending[key] == body and self.command_peers.get(key) is self.realtime.agents.get(rid)

    def consume(self, rid, body):
        key = (rid, body.get('session_id'), body.get('floor_id'), body.get('op'))
        self.pending.pop(key, None)
        self.command_peers.pop(key, None)
        self.command_actors.pop(key, None)

    def authorized(self, rid, body):
        if not self.command_allowed(rid, body):
            return False
        try:
            with self.realtime.run_factory() as db:
                row = db.get(MappingSession, UUID(body['session_id']))
                if (row is None or row.org_id != self.realtime.settings.org_id or str(row.robot_id) != rid
                        or (row.status == 'CANCELLED') != (body['op'] == 'cancel') or row.status in PERSISTED):
                    return False
                key = (rid, body['session_id'], body['floor_id'], body['op'])
                owner_scope(db, row.org_id, row.robot_id,
                    db.get(User, self.command_actors[key]), self.fail, row.floor_id)
                return True
        except Exception:
            return False

    def forwarded(self, rid, body):
        from .api import lock_organization
        with self.realtime.run_factory() as db:
            lock_organization(db, self.realtime.settings.org_id)
            row = db.get(MappingSession, UUID(body['session_id']))
            if row and row.org_id == self.realtime.settings.org_id and str(row.robot_id) == rid:
                server_time(row, 'command_forwarded_at')
                if body['op'] in ('start', 'save'):
                    server_time(row, body['op'] + '_forwarded_at')
                db.commit()

    def dispatch(self, row, op, *, actor_id=None):
        rid = str(row.robot_id)
        peer = self.realtime.agents.get(rid)
        if not self.connected(rid):
            self.fail(409, 'ROBOT_OFFLINE', '노트북 연결 프로그램을 먼저 연결해 주세요.')
        extra = dict(source=row.progress['source'], pipeline='point_lio+glim',
            final_source=row.progress['final_source'], command_id=row.progress['command_id'],
            requested_at=row.progress['times']['server_received_at'], revision=row.progress['revision']) if builtin(row) else {}
        body = C.AgentMappingCommand(op=op, session_id=row.id, floor_id=row.floor_id, **extra).model_dump(mode='json')
        # Preserve start→save ordering if both are queued before the first send.
        # A new session invalidates all older commands; cancel invalidates this session.
        if op == 'start':
            self.pending = {key: value for key, value in self.pending.items() if key[0] != rid}
        elif op == 'cancel':
            self.pending = {key: value for key, value in self.pending.items() if key[1] != str(row.id)}
        key = (rid, str(row.id), str(row.floor_id), op)
        self.pending[key] = body
        self.command_peers = {key: value for key, value in self.command_peers.items() if key in self.pending}
        self.command_peers[key] = peer
        self.command_actors = {key: value for key, value in self.command_actors.items() if key in self.pending}
        self.command_actors[key] = actor_id if actor_id is not None else row.owner_id
        self.realtime.put(peer, body)

    def reject_report(self, rid, msg, error):
        """Retain the last WS rejection, once per consecutive code/reason pair."""
        from .api import lock_organization
        with self.realtime.run_factory() as db:
            lock_organization(db, self.realtime.settings.org_id)
            row = db.get(MappingSession, msg.session_id)
            if (row is None or row.org_id != self.realtime.settings.org_id
                    or str(row.robot_id) != rid or row.floor_id != msg.floor_id):
                return
            previous = row.progress or {}
            last = previous.get('last_report_rejection') or {}
            if (last.get('code'), last.get('reason')) == (error.code, error.message):
                return
            row.progress = {**previous, 'last_report_rejection': dict(
                code=error.code, reason=error.message, received_at=now().isoformat())}
            db.commit()

    def report(self, rid, msg):
        if len(msg.model_dump_json(exclude_unset=True).encode()) > C.MAPPING_REPORT_BYTES:
            return
        from .api import lock_organization
        with self.realtime.run_factory() as db:
            lock_organization(db, self.realtime.settings.org_id)
            row = db.get(MappingSession, msg.session_id)
            if (row is None or row.org_id != self.realtime.settings.org_id
                    or str(row.robot_id) != rid or row.floor_id != msg.floor_id
                    or row.status == 'CANCELLED' or msg.status in PERSISTED):
                return
            user = db.get(User, row.owner_id)
            owner_scope(db, row.org_id, row.robot_id, user, self.fail, row.floor_id)
            if builtin(row):
                previous = row.progress or {}
                if (msg.command_id is None or str(msg.command_id) != previous.get('command_id')
                        or msg.update_seq is None or msg.update_seq <= previous.get('update_seq', 0)
                        or msg.revision is None or msg.revision < previous.get('revision', 1)):
                    return
                source = msg.source or previous['source']
                new_revision = msg.revision is not None and msg.revision > previous.get('revision', 1)
                changed_source = source != previous['source']
                adapter = mapping_adapter(source)
                if adapter is None:
                    self.fail(409, 'MAPPING_SOURCE_CONFLICT', '지도 출처를 확인해 주세요.')
                if changed_source and (not new_revision or mapping_adapter(previous['source']).role == 'final' or adapter.role != 'final'):
                    self.fail(409, 'MAPPING_SOURCE_CONFLICT', '같은 지도 판의 출처를 섞거나 이전 출처로 돌아갈 수 없습니다.')
                if changed_source and not (previous.get('times') or {}).get('save_requested_at'):
                    self.fail(409, 'MAPPING_SOURCE_CONFLICT', '저장 요청 뒤에 최종 지도로 바꿔 주세요.')
                if changed_source and (not msg.voxels or not msg.voxels.reset or not msg.odom or msg.odom.provider != source):
                    self.fail(409, 'MAPPING_SOURCE_CONFLICT', '새 지도 판의 전체 재구축·위치를 함께 확인해 주세요.')
                if msg.odom and msg.odom.provider != source:
                    self.fail(409, 'MAPPING_SOURCE_CONFLICT', '위치와 지도 판의 출처를 맞춰 주세요.')
                if msg.odom and not adapter.accepts_odom(msg.odom.source):
                    return
                if row.status in PERSISTED:
                    # A late robot acknowledgement updates only its separate
                    # outcome; immutable map artifacts and SAVED never regress.
                    outcome = 'SLAM_SAVED' if msg.phase == 'SLAM_SAVED' else msg.slam_save
                    if outcome is None or msg.revision != previous['revision']:
                        return
                    if previous.get('slam_save') == 'SLAM_SAVED' and outcome != 'SLAM_SAVED':
                        return
                    row.progress = {**previous, 'slam_save': outcome, 'phase': outcome, 'update_seq': msg.update_seq}
                    if row.status == 'SAVED' and outcome == 'SLAM_SAVED' and mapping_adapter(previous['source']).role == 'final':
                        row.progress = {**row.progress, 'reason': None}
                    if outcome == 'SLAM_SAVED' and not (row.progress.get('times') or {}).get('save_ack_at'):
                        server_time(row, 'save_ack_at')
                    db.commit()
                    return
                save_requested = (previous.get('times') or {}).get('save_requested_at') is not None
                if save_requested and msg.status in ('STARTING', 'RUNNING'):
                    return
                allowed = {'STARTING': ('START_REQUESTED',), 'RUNNING': ('STARTED',),
                    'SAVING': ('SAVE_REQUESTED',), 'FINALIZING': ('SLAM_SAVED',),
                    'UNKNOWN': ('UNKNOWN',), 'FAILED': ('FAILED',)}
                if msg.phase not in allowed.get(msg.status, ()):
                    return
                if msg.status in ('SAVING', 'FINALIZING') and not save_requested:
                    return
                if msg.voxels and (msg.voxels.revision != msg.revision
                        or (not new_revision and previous.get('voxels') and msg.voxels.seq <= previous['voxels']['seq'])
                        or ((previous.get('voxels') is None or msg.revision > previous.get('revision', 1)) and not msg.voxels.reset)):
                    return
                tiles = msg.tiles or []
                if any(tile.revision != msg.revision for tile in tiles):
                    return
                frames = [item.frame_id for item in (msg.voxels, msg.grid, msg.odom, *tiles) if item is not None]
                anchor = db.scalar(select(MappingTile).where(MappingTile.session_id == row.id,
                    MappingTile.org_id == row.org_id).limit(1))
                prior_frame = next((previous[k]['frame_id'] for k in ('voxels', 'grid', 'odom') if previous.get(k)),
                    anchor.frame_id if anchor else None)
                if len(set(frames)) > 1 or (not new_revision and prior_frame and frames and prior_frame != frames[0]) or (msg.grid and msg.grid.revision != msg.revision):
                    return
                heights = [tile.floor_z for tile in tiles]
                if msg.grid:
                    heights.append(msg.grid.floor_z)
                if (len(set(heights)) > 1 or (not new_revision and anchor and heights and anchor.floor_z != heights[0])):
                    return
                if new_revision:
                    db.execute(delete(MappingTile).where(MappingTile.session_id == row.id,
                        MappingTile.org_id == row.org_id))
                    previous = {k: v for k, v in previous.items() if k not in ('voxels', 'grid', 'tiles', 'odom')}
                tile_count = db.scalar(select(func.count()).select_from(MappingTile).where(
                    MappingTile.session_id == row.id, MappingTile.org_id == row.org_id))
                for tile in tiles:
                    current = db.get(MappingTile, (row.id, tile.x, tile.y))
                    if current and current.tile_seq >= tile.tile_seq:
                        continue
                    if current is None:
                        tile_count += 1
                        if tile_count > 4096:
                            return  # transaction rolls back all tiles/status on overflow
                        current = MappingTile(org_id=row.org_id, session_id=row.id, x=tile.x, y=tile.y)
                        db.add(current)
                    current.revision, current.tile_seq = tile.revision, tile.tile_seq
                    current.update_seq = msg.update_seq
                    current.frame_id, current.floor_z, current.cells = tile.frame_id, tile.floor_z, bytes(tile.cells)
                supplied = msg.model_dump(mode='json', exclude_unset=True,
                    exclude={'t', 'map_version_id', 'terrain_id', 'terrain_status', 'last_report_rejection', 'source', 'pipeline', 'final_source', 'name', 'times'})
                times = dict(previous.get('times') or {})
                if msg.times:
                    times.update(msg.times.model_dump(mode='json', exclude_none=True,
                        exclude={'server_received_at', 'start_requested_at', 'save_requested_at', 'command_forwarded_at',
                            'start_forwarded_at', 'save_forwarded_at', 'start_ack_at', 'save_ack_at', 'saved_at'}))
                received = now().isoformat()
                if msg.phase in ('STARTED', 'SLAM_SAVED'):
                    times.setdefault('start_ack_at' if msg.phase == 'STARTED' else 'save_ack_at', received)
                if msg.voxels or msg.grid or msg.odom or tiles:
                    times.setdefault('first_data_at', received)
                    times['last_data_at'] = received
                row.progress = {**previous, **supplied, 'source': source, 'times': times}
                row.status = msg.status
                db.commit()
                return
            if row.status in PERSISTED:
                return
            # The REST request owns SAVING; late RUNNING may never resurrect it.
            if msg.status == 'RUNNING' and row.status != 'RUNNING':
                return
            if msg.status == 'SAVING' and row.status != 'SAVING':
                return
            if msg.status == 'CANCELLED':
                return  # cancellation is owned by the requesting operator
            row.status = msg.status
            body = msg.model_dump(mode='json', exclude={'t', 'map_version_id', 'terrain_id', 'last_report_rejection'})
            if (row.progress or {}).get('last_report_rejection'):
                body['last_report_rejection'] = row.progress['last_report_rejection']
            row.progress = body
            db.commit()


def install(app, DB, Identity, factory, settings, fail, event, lock_organization):
    mapping = Mapping(app.state.realtime, fail)
    mapping.pending = {}
    mapping.command_peers = {}
    mapping.command_actors = {}
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
        if row and row.status in ('STARTING', 'RUNNING', 'SAVING', 'FINALIZING') and not mapping.connected(robot_id):
            body = progress(row).model_dump(mode='json')
            body.update(status='UNKNOWN' if builtin(row) else 'FAILED', error_code='LINK_LOST', reason='연결이 끊겼습니다. 다시 연결한 뒤 저장하거나 취소해 주세요.')
            if builtin(row):
                body['phase'] = 'UNKNOWN'
            return C.MappingProgress.model_validate(body)
        return progress(row) if row else None

    @app.post('/api/v1/robots/{robot_id}/slam/start', status_code=202, response_model=C.MappingProgress)
    async def start(robot_id: UUID, body: C.MappingStart, db: DB, auth: Identity):
        lock_organization(db, settings.org_id)
        _, floor = owner_scope(db, settings.org_id, robot_id, auth[0], fail, body.floor_id)
        row = latest(db, robot_id)
        if row and row.status in ACTIVE:
            fail(409, 'MAPPING_ACTIVE', '이미 지도를 만들고 있습니다. 저장하거나 취소해 주세요.')
        if not mapping.connected(robot_id):
            fail(409, 'ROBOT_OFFLINE', '노트북 연결 프로그램을 먼저 연결해 주세요.')
        row = MappingSession(id=uuid4(), org_id=settings.org_id, robot_id=robot_id,
            floor_id=floor.id, owner_id=auth[0].id, base_version_id=floor.approved_version_id,
            status='STARTING' if mapping_adapter(body.source) else 'RUNNING',
            progress=dict(source=body.source, name=body.name))
        if builtin(row):
            row.progress = {**row.progress, 'pipeline': 'point_lio+glim', 'final_source': DEFAULT_FINAL_SOURCE,
                'command_id': str(uuid4()), 'phase': 'START_REQUESTED', 'revision': 1}
            server_time(row, 'server_received_at')
            server_time(row, 'start_requested_at')
        db.add(row)
        db.commit()  # durable identity before putting a frame on the live socket
        mapping.dispatch(row, 'start')
        return progress(row)

    @app.get('/api/v1/robots/{robot_id}/slam/{session_id}/tiles', response_model=C.MappingTilePage)
    def tiles(robot_id: UUID, session_id: UUID, response: Response, db: DB, auth: Identity,
              revision: Annotated[int, Query(ge=1)],
              cursor: Annotated[int, Query(ge=0, le=39_062_500)] = 0,
              since: Annotated[int, Query(ge=0)] = 0):
        row = selected(db, robot_id, session_id, auth[0], bind_owner=False)
        if revision != (row.progress or {}).get('revision'):
            fail(409, 'MAPPING_REVISION_CONFLICT', '지도 판이 바뀌었습니다. 처음부터 다시 받아 주세요.')
        rows = list(db.scalars(select(MappingTile).where(MappingTile.org_id == row.org_id,
            MappingTile.session_id == row.id, MappingTile.revision == revision,
            MappingTile.update_seq > since,
            (MappingTile.x + 3125) * 6250 + MappingTile.y + 3126 > cursor)
            .order_by(MappingTile.x, MappingTile.y).limit(5)))
        response.headers['Cache-Control'] = 'private, no-store'
        return C.MappingTilePage(session_id=row.id, revision=revision, update_seq=row.progress.get('update_seq', 0),
            tiles=[C.MappingGridTile(revision=r.revision, tile_seq=r.tile_seq, x=r.x, y=r.y,
                frame_id=r.frame_id, floor_z=r.floor_z, cells=list(r.cells)) for r in rows[:4]],
            next_cursor=(rows[3].x + 3125) * 6250 + rows[3].y + 3126 if len(rows) > 4 else None)

    @app.post('/api/v1/robots/{robot_id}/slam/save', status_code=202, response_model=C.MappingProgress)
    async def save(robot_id: UUID, body: C.MappingAction, db: DB, auth: Identity):
        lock_organization(db, settings.org_id)
        row = selected(db, robot_id, body.session_id, auth[0])
        if row.status in PERSISTED:
            return progress(row)
        if row.status == 'CANCELLED':
            fail(409, 'MAPPING_STATE_CONFLICT', '취소한 지도입니다. 새로 시작해 주세요.')
        if not mapping.connected(robot_id):
            fail(409, 'ROBOT_OFFLINE', '노트북 연결 프로그램을 먼저 연결해 주세요.')
        if row.status in ('SAVING', 'FINALIZING'):
            return progress(row)
        row.status = 'SAVING'
        if builtin(row):
            row.progress = {**row.progress, 'command_id': str(uuid4()), 'phase': 'SAVE_REQUESTED',
                'error_code': None, 'reason': None}
            server_time(row, 'server_received_at')
            server_time(row, 'save_requested_at')
        db.commit()
        mapping.dispatch(row, 'save')
        return progress(row)

    @app.post('/api/v1/robots/{robot_id}/slam/cancel', response_model=C.MappingProgress)
    async def cancel(robot_id: UUID, body: C.MappingAction, db: DB, auth: Identity):
        lock_organization(db, settings.org_id)
        row = selected(db, robot_id, body.session_id, auth[0], bind_owner=False)
        if row.status in PERSISTED:
            fail(409, 'MAPPING_STATE_CONFLICT', '이미 저장한 지도입니다.')
        row.status = 'CANCELLED'
        row.progress = {**(row.progress or {}), 'error_code': None, 'reason': None}
        db.commit()
        mapping.pending = {key: value for key, value in mapping.pending.items() if key[1] != str(row.id)}
        if mapping.connected(robot_id):
            mapping.dispatch(row, 'cancel', actor_id=auth[0].id)
        return progress(row)

    @app.post('/api/v1/agent/robots/{robot_id}/slam/{session_id}/progress', status_code=202)
    async def report(robot_id: UUID, session_id: UUID, request: Request):
        rid, simulation = await app.state.realtime.read(app.state.realtime.agent_auth, request.headers)
        if rid != str(robot_id) or simulation:
            fail(403, 'FORBIDDEN', '이 로봇의 연결 인증을 확인해 주세요.')
        data = bytearray()
        try:
            async with asyncio.timeout(5):
                async for part in request.stream():
                    if len(data) + len(part) > C.MAPPING_REPORT_BYTES:
                        fail(413, 'MAPPING_REPORT_TOO_LARGE', '지도 미리보기 크기를 줄여 주세요.')
                    data.extend(part)
        except TimeoutError:
            fail(408, 'UPLOAD_TIMEOUT', '진행 자료 수신 시간이 초과되었습니다.')
        try:
            msg = C.AgentMappingUpdate.model_validate_json(data)
        except ValueError:
            fail(422, 'VALIDATION', '지도 진행 자료 형식을 확인해 주세요.')
        if msg.session_id != session_id:
            fail(409, 'MAPPING_SESSION_MISMATCH', '지도 만들기 작업을 확인해 주세요.')
        def receive_report():
            app.state.realtime.agent_auth(request.headers)
            mapping.report(rid, msg)
        await app.state.realtime.read(receive_report)
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
            if builtin(row):
                fail(409, 'MAPPING_BUNDLE_REQUIRED', '3D·2D 지도 묶음으로 저장해 주세요.')
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

    from .mapping_storage import install as install_bundles
    install_bundles(app, DB, Identity, factory, settings, fail, event, lock_organization, mapping)

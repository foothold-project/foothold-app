"""Separate bounded REST photo storage; safety sockets carry references only.

JPEG validation follows markers/segment lengths/dimensions, without a pixel
codec dependency. Pixel corruption inside a structurally valid scan is not detected.
"""
import os
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import Request
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker
from starlette.concurrency import run_in_threadpool

from apps.contracts import models as C
from .event_messages import render
from .models import Event, Organization, Photo, Robot, Run, RunStep, now
from .security import digest
from .runs import TERMINAL


@dataclass(frozen=True)
class PhotoLimits:
    """One policy location; reaching retention capacity blocks new admission.

    Existing evidence is never silently evicted. Administrators must explicitly
    retire evidence before lowering limits or reclaiming retained photos.
    """
    max_bytes: int = 65536
    max_width: int = 640
    max_height: int = 360
    max_retained: int = 10000
    max_storage_bytes: int = 256 * 1024 * 1024


LIMITS = PhotoLimits()


def jpeg_dimensions(data, limits=LIMITS):
    """Walk header and entropy markers, including progressive multi-scan JPEG."""
    if not data.startswith(b'\xff\xd8'):
        raise ValueError('JPEG SOI required')
    offset, dimensions, scans = 2, None, 0
    while offset < len(data):
        if data[offset] != 0xff:
            raise ValueError('JPEG marker required')
        while offset < len(data) and data[offset] == 0xff:
            offset += 1
        if offset >= len(data):
            raise ValueError('truncated JPEG marker')
        marker = data[offset]
        offset += 1
        if marker == 0xd9:
            if dimensions is None or not scans or offset != len(data):
                raise ValueError('incomplete JPEG or trailing data')
            return dimensions
        if marker in (0, 0xd8) or 0xd0 <= marker <= 0xd7:
            raise ValueError('unexpected JPEG marker')
        if offset + 2 > len(data):
            raise ValueError('truncated JPEG length')
        length = int.from_bytes(data[offset:offset+2], 'big')
        if length < 2 or offset + length > len(data):
            raise ValueError('invalid JPEG segment length')
        segment = data[offset+2:offset+length]
        if marker in (0xc0, 0xc1, 0xc2):
            if dimensions is not None or len(segment) < 6:
                raise ValueError('invalid JPEG SOF')
            height, width = int.from_bytes(segment[1:3], 'big'), int.from_bytes(segment[3:5], 'big')
            channels = segment[5]
            if (segment[0] != 8 or channels not in (1, 3) or len(segment) != 6 + 3 * channels
                    or not 0 < width <= limits.max_width or not 0 < height <= limits.max_height):
                raise ValueError('unsupported JPEG dimensions/components')
            dimensions = width, height
        elif marker in (0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
            raise ValueError('unsupported JPEG frame')
        offset += length
        if marker == 0xda:
            if dimensions is None or not segment or segment[0] not in (1, 3) or len(segment) != 4 + 2 * segment[0]:
                raise ValueError('invalid JPEG SOS')
            scans += 1
            # Entropy scan: FF00 is escaped data, restart markers have no length.
            while offset < len(data):
                marker_at = data.find(b'\xff', offset)
                if marker_at < 0:
                    raise ValueError('JPEG EOI required')
                cursor = marker_at + 1
                while cursor < len(data) and data[cursor] == 0xff:
                    cursor += 1
                if cursor >= len(data):
                    raise ValueError('truncated JPEG entropy')
                if data[cursor] == 0 or 0xd0 <= data[cursor] <= 0xd7:
                    offset = cursor + 1
                else:
                    offset = marker_at
                    break
    raise ValueError('JPEG EOI required')


def metadata(row):
    return C.PhotoUploadMetadata(**{key: getattr(row, key) for key in C.PhotoUploadMetadata.model_fields
                                   if key != 'mime'}, mime='image/jpeg')


def receipt(row):
    return C.PhotoUploadReceipt(**metadata(row).model_dump(), photo_id=row.id, stored_at=row.stored_at)


def photo_event(db, meta, *, row=None, failure=None):
    data = dict(run_id=str(meta.run_id), waypoint_idx=meta.waypoint_idx, step_idx=meta.step_idx,
                source=meta.source, captured_at=meta.captured_at.isoformat(), sha256=meta.sha256)
    if row is not None:
        data.update(photo_id=str(row.id), url=f'/api/v1/photos/{row.id}',
                    thumbnail_url=f'/api/v1/photos/{row.id}/thumbnail')
    if failure:
        data['reason'] = failure
    db.add(render(db, Event(org_id=meta.org_id, robot_id=meta.robot_id, run_id=meta.run_id,
        code='PHOTO_STORE_FAILED' if failure else 'PHOTO_STORED', category='RUN',
        severity='ERROR' if failure else 'INFO', data=data)))


def owned(db, settings, rid, meta, token_hash, fail):
    if meta.org_id != settings.org_id or meta.robot_id != rid:
        fail(403, 'FORBIDDEN', '인증된 로봇과 사진 소유가 다릅니다.')
    robot = db.scalar(select(Robot).where(Robot.org_id == settings.org_id, Robot.id == rid,
        Robot.archived_at.is_(None), Robot.agent_token_hash == token_hash).with_for_update())
    if robot is None:
        fail(403, 'FORBIDDEN', '로봇 인증이 만료되었습니다.')
    run = db.scalar(select(Run).where(Run.org_id == settings.org_id, Run.robot_id == rid,
        Run.id == meta.run_id).with_for_update())
    if run is None:
        fail(404, 'NOT_FOUND', '실행을 찾을 수 없습니다.')
    try:
        goal = run.plan['segments'][0]['goals'][meta.waypoint_idx]
        step = goal['mission_steps'][meta.step_idx]
    except (IndexError, KeyError, TypeError):
        fail(422, 'PHOTO_PLAN_MISMATCH', '고정 실행 단계에 사진 촬영이 없습니다.')
    if run.plan.get('run_contract') != 'scenario/2' or step['action'] != 'PHOTO' or step['params']['camera'] != meta.source:
        fail(422, 'PHOTO_PLAN_MISMATCH', '고정 실행 사진 단계와 일치하지 않습니다.')
    return run


def safe_path(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise OSError('photo storage outside root')
    return path


def clean_orphans(db, root, directory, org_id):
    """Called under organization lock; no concurrent photo writer can own a temp."""
    known = set(db.scalars(select(Photo.path).where(Photo.org_id == org_id, Photo.status == 'STORED')))
    for path in directory.iterdir():
        if path.suffix not in ('.jpg', '.tmp') or not path.is_file():
            continue
        # Only UUID filenames created by this module are eligible for recovery.
        try:
            UUID(path.stem)
        except ValueError:
            continue
        if str(path.relative_to(root)) not in known:
            path.unlink()


def save_photo(factory, settings, rid, meta, payload, token_hash, fail, limits=LIMITS):
    final = temporary = None
    # Serialization makes quota/idempotency/orphan recovery safe across processes.
    with factory() as db:
        try:
            db.scalar(select(Organization).where(Organization.id == settings.org_id).with_for_update())
            run = owned(db, settings, rid, meta, token_hash, fail)
            existing = db.scalar(select(Photo).where(Photo.org_id == meta.org_id,
                Photo.robot_id == rid, Photo.idempotency_key == meta.idempotency_key))
            if existing is not None and metadata(existing) != meta:
                fail(409, 'IDEMPOTENCY_CONFLICT', '같은 사진 키의 내용이 다릅니다.')
            other = db.scalar(select(Photo).where(Photo.org_id == meta.org_id, Photo.run_id == meta.run_id,
                Photo.waypoint_idx == meta.waypoint_idx, Photo.step_idx == meta.step_idx))
            if other is not None and other.id != getattr(existing, 'id', None):
                fail(409, 'IDEMPOTENCY_CONFLICT', '이 단계에 다른 사진 키가 이미 있습니다.')
            try:
                if len(payload) > limits.max_bytes:
                    raise ValueError('photo exceeds byte limit')
                meta.validate_payload(payload)
                jpeg_dimensions(payload, limits)
                if meta.captured_at > now() or meta.captured_at < run.started_at:
                    raise ValueError('capture timestamp outside run')
            except ValueError:
                photo_event(db, meta, failure='PHOTO_INVALID')
                db.commit()
                fail(422, 'PHOTO_INVALID', 'JPEG 형식·크기·해시·촬영시각을 확인하세요.')
            if existing is not None and existing.status == 'STORED':
                result = receipt(existing)
                db.commit()
                return result
            waypoint = db.get(RunStep, (run.id, meta.waypoint_idx))
            if (run.status in TERMINAL or run.step != meta.waypoint_idx
                    or waypoint is None or waypoint.status != 'ARRIVED'):
                fail(409, 'PHOTO_RUN_STATE', '도착한 현재 실행 지점에서만 촬영을 저장할 수 있습니다.')
            count, size = db.execute(select(func.count(), func.coalesce(func.sum(Photo.byte_length), 0)).where(
                Photo.org_id == meta.org_id, Photo.status == 'STORED')).one()
            if count >= limits.max_retained or size + len(payload) > limits.max_storage_bytes:
                photo_event(db, meta, failure='PHOTO_CAPACITY')
                db.commit()
                fail(507, 'PHOTO_CAPACITY', '사진 보관 한도에 도달했습니다.')
            identifier = existing.id if existing else uuid4()
            relative = f'photos/{meta.org_id}/{identifier}.jpg'
            root = Path(settings.files_root).resolve()
            final = safe_path(root, relative)
            final.parent.mkdir(parents=True, exist_ok=True)
            clean_orphans(db, root, final.parent, meta.org_id)
            temporary = final.with_suffix('.tmp')
            with temporary.open('xb') as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, final)
            descriptor = os.open(final.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            row = existing or Photo(id=identifier, **meta.model_dump(exclude={'mime'}), path=relative)
            row.status, row.stored_at = 'STORED', now()
            db.add(row)
            photo_event(db, meta, row=row)
            result = receipt(row)
            db.commit()  # No success response can escape before commit.
            return result
        except Exception as exc:
            db.rollback()
            if hasattr(exc, 'status'):
                raise
            # Recovery uses the same organization lock as admission. A concurrent
            # retry must not commit a file between verification and unlink.
            try:
                with factory.begin() as audit:
                    audit.scalar(select(Organization).where(Organization.id == settings.org_id).with_for_update())
                    row = audit.scalar(select(Photo).where(Photo.org_id == meta.org_id,
                        Photo.robot_id == rid, Photo.idempotency_key == meta.idempotency_key))
                    # COMMIT may have succeeded even when its response was lost.
                    if row is not None and row.status == 'STORED' and metadata(row) == meta:
                        return receipt(row)
                    for path in (temporary, final):
                        if path is not None:
                            try:
                                path.unlink(missing_ok=True)
                            except OSError:
                                pass  # A later serialized upload recovers orphans.
                    owned(audit, settings, rid, meta, token_hash, fail)
                    if row is None:
                        identifier = uuid4()
                        audit.add(Photo(id=identifier, **meta.model_dump(exclude={'mime'}),
                            path=f'photos/{meta.org_id}/{identifier}.jpg', status='FAILED', stored_at=None))
                    photo_event(audit, meta, failure='PHOTO_STORAGE_ERROR')
            except Exception as recovery:
                if hasattr(recovery, 'status'):
                    raise
                # Unknown DB outcome: keep possible committed evidence. On retry,
                # the receipt check or locked orphan recovery resolves ownership.
                fail(503, 'PHOTO_STORAGE_ERROR', '사진 저장 확정을 확인할 수 없습니다. 같은 키로 재시도하세요.')
            fail(503, 'PHOTO_STORAGE_ERROR', '사진 저장에 실패했습니다. 같은 키로 다시 시도하세요.')


def failed_request(factory, settings, rid, meta, token_hash, code, fail):
    with factory.begin() as db:
        owned(db, settings, rid, meta, token_hash, fail)
        photo_event(db, meta, failure=code)


def install(app, DB, Identity, fail, authorize):
    @app.post('/api/v1/agent/photos', response_model=C.PhotoUploadReceipt)
    async def upload(request: Request):
        rt = app.state.realtime
        rid = UUID(await run_in_threadpool(rt.agent_identity, request.headers))
        try:
            header = request.headers.get('x-photo-metadata', '')
            if len(header) > 4096:
                raise ValueError('metadata too large')
            meta = C.PhotoUploadMetadata.model_validate_json(header)
        except (ValidationError, ValueError):
            fail(422, 'PHOTO_INVALID', 'X-Photo-Metadata에 사진 메타데이터 JSON을 지정하세요.')
        factory = sessionmaker(app.state.engine, expire_on_commit=False)
        token_hash = digest(request.headers['authorization'][7:])
        if request.headers.get('content-type', '').lower() != 'image/jpeg':
            await run_in_threadpool(failed_request, factory, rt.settings, rid, meta, token_hash, 'PHOTO_MIME', fail)
            fail(415, 'PHOTO_INVALID', 'image/jpeg 본문이 필요합니다.')
        if meta.org_id != rt.settings.org_id or meta.robot_id != rid:
            fail(403, 'FORBIDDEN', '인증된 로봇과 사진 소유가 다릅니다.')
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > LIMITS.max_bytes:
                await run_in_threadpool(failed_request, factory, rt.settings, rid, meta, token_hash, 'PHOTO_TOO_LARGE', fail)
                fail(413, 'PHOTO_TOO_LARGE', '사진 크기 한도를 넘었습니다.')
            body.extend(chunk)
        return await run_in_threadpool(save_photo, factory, rt.settings, rid, meta, bytes(body),
            token_hash, fail)

    @app.get('/api/v1/photos/{identifier}', response_class=FileResponse)
    @app.get('/api/v1/photos/{identifier}/thumbnail', response_class=FileResponse)
    def download(identifier: UUID, auth: Identity, db: DB):
        row = db.scalar(select(Photo).where(Photo.org_id == auth[0].org_id,
            Photo.id == identifier, Photo.status == 'STORED'))
        if row is None:
            fail(404, 'NOT_FOUND', '사진을 찾을 수 없습니다.')
        robot = db.scalar(select(Robot).where(Robot.org_id == row.org_id, Robot.id == row.robot_id))
        if robot is None:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        authorize(auth[0], 'ROBOT_READ', robot)
        try:
            path = safe_path(Path(app.state.realtime.settings.files_root).resolve(), row.path)
            if not path.is_file():
                raise OSError('missing photo')
        except OSError:
            fail(503, 'PHOTO_STORAGE_ERROR', '사진 파일을 찾을 수 없습니다.')
        return FileResponse(path, media_type='image/jpeg', headers={
            'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
            'ETag': '"' + row.sha256 + '"'})

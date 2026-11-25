"""Revision-local voxel accumulation and bounded keyset pages, without projection."""
import base64
import binascii
import json

from sqlalchemy import delete, select, tuple_
from sqlalchemy.dialects.postgresql import insert

from apps.contracts import models as C
from .models import MappingVoxel, MappingVoxelState, now


def scope(model, row):
    return (model.org_id == row.org_id, model.session_id == row.id)


def rejection(db, row, fail, code, reason):
    # Called before any geometry/status mutation. REST and WS retain the reason.
    previous = row.progress or {}
    last = previous.get('last_report_rejection') or {}
    if (last.get('code'), last.get('reason')) != (code, reason):
        row.progress = {**previous, 'last_report_rejection': dict(
            code=code, reason=reason, received_at=now().isoformat())}
        db.commit()
    fail(409, code, reason)


def accumulate(db, row, delta, new_revision, fail):
    """Caller holds the organization lock; commit with the accepted report."""
    state = db.scalar(select(MappingVoxelState).where(*scope(MappingVoxelState, row)))
    if delta is None:
        if new_revision:
            db.execute(delete(MappingVoxel).where(*scope(MappingVoxel, row)))
            db.execute(delete(MappingVoxelState).where(*scope(MappingVoxelState, row)))
        return True
    if state is not None and not new_revision and (delta.seq <= state.seq or delta.frame_id != state.frame_id):
        return False  # progress may explicitly omit/clear its compatibility last delta
    if state is None and not delta.reset:
        rejection(db, row, fail, 'MAPPING_VOXELS_RESET_REQUIRED',
            '전체 칸을 복구하려면 reset 증분부터 다시 보내 주세요.')
    reset = new_revision or delta.reset
    desired = {cell: False for cell in delta.removed}
    desired.update({cell: True for cell in delta.added})  # same-cell add wins
    existing = {} if reset or not desired else {
        (r.x, r.y, r.z): r.present for r in db.scalars(select(MappingVoxel).where(
            *scope(MappingVoxel, row), tuple_(MappingVoxel.x, MappingVoxel.y, MappingVoxel.z).in_(desired)))}
    count = 0 if reset else state.cell_count
    changes = []
    for cell, present in desired.items():
        before = existing.get(cell, False)
        if before == present:
            continue
        count += 1 if present else -1
        changes.append(dict(org_id=row.org_id, session_id=row.id, x=cell[0], y=cell[1], z=cell[2],
            seq=delta.seq, present=present))
    if count > C.MAPPING_VOXEL_CELLS:
        rejection(db, row, fail, 'MAPPING_VOXEL_LIMIT',
            '실시간 지도는 최대 500,000칸까지 보관할 수 있습니다.')
    if reset:
        db.execute(delete(MappingVoxel).where(*scope(MappingVoxel, row)))
    if changes:
        statement = insert(MappingVoxel).values(changes)
        db.execute(statement.on_conflict_do_update(index_elements=['session_id', 'x', 'y', 'z'],
            set_={'seq': statement.excluded.seq, 'present': statement.excluded.present}))
    if state is None:
        state = MappingVoxelState(org_id=row.org_id, session_id=row.id)
        db.add(state)
    state.revision, state.seq, state.frame_id, state.cell_count = delta.revision, delta.seq, delta.frame_id, count
    if reset:
        state.reset_seq = delta.seq
    return True


def page(db, row, revision, since, cursor, fail):
    """Read under the same lock as reports so reset/header/rows are coherent."""
    state = db.scalar(select(MappingVoxelState).where(*scope(MappingVoxelState, row)))
    if state is None and (row.progress or {}).get('voxels'):
        fail(409, 'MAPPING_VOXELS_RESET_REQUIRED', '전체 칸을 복구하려면 reset 증분부터 다시 보내 주세요.')
    seq, reset_seq = (state.seq, state.reset_seq) if state else (0, 0)
    if since > seq:
        fail(409, 'MAPPING_VOXEL_SEQUENCE_CONFLICT', '칸 순서가 바뀌었습니다. 처음부터 다시 받아 주세요.')
    reset = since == 0 or since < reset_seq
    binding = [1, str(row.id), revision, since, reset_seq]
    after = None
    if cursor is not None:
        try:
            data = json.loads(base64.b64decode(cursor + '=' * (-len(cursor) % 4), altchars=b'-_', validate=True))
            if (not isinstance(data, list) or len(data) != 6 or data[:4] != binding[:4]
                    or type(data[4]) is not int or not isinstance(data[5], list) or len(data[5]) != 3
                    or any(type(v) is not int or not -200000 <= v <= 200000 for v in data[5])):
                raise ValueError('cursor binding')
            if data[4] != reset_seq:
                fail(409, 'MAPPING_VOXEL_RESET_CONFLICT', '칸이 초기화됐습니다. 처음부터 다시 받아 주세요.')
            after = tuple(data[5])
        except (ValueError, TypeError, binascii.Error, UnicodeDecodeError):
            fail(422, 'MAPPING_VOXEL_CURSOR_INVALID', '칸 조회 커서를 확인해 주세요.')
    conditions = [*scope(MappingVoxel, row)]
    if reset:
        conditions.append(MappingVoxel.present.is_(True))
    else:
        conditions.append(MappingVoxel.seq > since)
    if after is not None:
        conditions.append(tuple_(MappingVoxel.x, MappingVoxel.y, MappingVoxel.z) > after)
    rows = list(db.scalars(select(MappingVoxel).where(*conditions)
        .order_by(MappingVoxel.x, MappingVoxel.y, MappingVoxel.z).limit(C.MAPPING_VOXEL_PAGE_CELLS + 1)))
    visible = rows[:C.MAPPING_VOXEL_PAGE_CELLS]
    next_cursor = None
    if len(rows) > len(visible):
        last = visible[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps(
            [*binding, [last.x, last.y, last.z]], separators=(',', ':')).encode()).decode().rstrip('=')
    # 512 changes with bounded XYZ/seq/frame/cursor are <65,536 UTF-8 bytes;
    # the contract validator also checks the exact serialized byte length.
    return C.MappingVoxelPage(session_id=row.id, revision=revision, seq=seq,
        reset=reset, reset_seq=reset_seq, frame_id=state.frame_id if state else None,
        added=[C.MappingVoxelChange(cell=(r.x, r.y, r.z), seq=r.seq) for r in visible if r.present],
        removed=[C.MappingVoxelChange(cell=(r.x, r.y, r.z), seq=r.seq) for r in visible if not r.present],
        next_cursor=next_cursor)

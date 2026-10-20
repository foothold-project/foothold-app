"""S4a map requests and one terminal transition, atomic with map/event/inbox."""
from typing import Annotated
from uuid import UUID

from fastapi import Query
from sqlalchemy import func, select
from apps.contracts import models as C
from .event_messages import render
from .models import Approval, Event, Floor, MapVersion, User, now
from .notifications import append_for_event


KINDS = {'MAP_REVISION': '지도 수정', 'MAP_ROLLBACK': '지도 되돌리기'}


def visible(user):
    query = select(Approval).where(Approval.org_id == user.org_id)
    if user.role != 'ORG_ADMIN':
        query = query.where(Approval.requester_id == user.id)
    return query


def pending_count(db, user):
    return db.scalar(visible(user).where(Approval.status == 'PENDING')
        .with_only_columns(func.count()).order_by(None))


def record(db, approval, actor, version, code, *, approved=None):
    row = Event(org_id=approval.org_id, category='APPROVAL', code=code, severity='INFO',
        user_id=actor.id, approval_id=approval.id, data={
            'approval_id': str(approval.id), 'kind': KINDS[approval.kind], 'approval_kind': approval.kind,
            'requester_id': str(approval.requester_id), 'status': approval.status,
            'floor_id': str(version.floor_id), 'map_version_id': str(version.id),
            'base_version_id': str(approval.base_ref_id) if approval.base_ref_id else None,
            'number': version.number, 'reason': approval.reason,
            'decision_comment': approval.decision_comment, 'approved': approved})
    db.add(render(db, row, other_user_id=approval.requester_id))
    append_for_event(db, row)


def request_map(db, user, version):
    row = Approval(org_id=user.org_id, kind='MAP_ROLLBACK' if version.source == 'ROLLBACK' else 'MAP_REVISION',
        status='PENDING', target_type='map_version', target_id=version.id,
        base_ref_type='map_version' if version.base_version_id else None,
        base_ref_id=version.base_version_id, requester_id=user.id, reason=version.reason)
    db.add(row)
    db.flush()
    record(db, row, user, version, 'APPROVAL_REQUESTED')
    return row


def approval_object(db, row):
    def person(identifier):
        user = db.scalar(select(User).where(User.org_id == row.org_id, User.id == identifier))
        return C.Person(id=user.id, display_name=user.display_name) if user else None
    return C.Approval(id=row.id, kind=row.kind, status=row.status, requester=person(row.requester_id),
        decider=person(row.decider_id) if row.decider_id else None, reason=row.reason,
        decision_comment=row.decision_comment, target=C.ApprovalRef(id=row.target_id),
        base_ref=C.ApprovalRef(id=row.base_ref_id) if row.base_ref_id else None,
        emergency=row.emergency, created_at=row.created_at, decided_at=row.decided_at)


def transition(db, row, user, status, comment, fail):
    # Caller holds the approval row. All terminal transitions pass this guard.
    if row.status != 'PENDING':
        fail(409, 'ALREADY_DECIDED', '이미 끝난 요청입니다. 결재 목록을 새로 확인하세요.')
    from .maps import refresh_connectors, bounded_features, validate_rollback_connectors
    version = db.scalar(select(MapVersion).where(MapVersion.org_id == user.org_id, MapVersion.id == row.target_id))
    floor = db.scalar(select(Floor).where(Floor.org_id == user.org_id, Floor.id == version.floor_id).with_for_update())
    stale = status == 'APPROVED' and row.base_ref_id != floor.approved_version_id
    if stale:
        status = 'STALE'
    elif status == 'APPROVED':
        # A paired floor may have been removed since the request was created.
        validate_rollback_connectors(db, floor, bounded_features(version, fail), fail)
        version.status = 'APPROVED'
        floor.approved_version_id = version.id
        db.flush()
        refresh_connectors(db, floor)
    elif status in ('REJECTED', 'CANCELED'):
        version.status = status
    row.status, row.decider_id, row.decided_at, row.decision_comment = status, user.id, now(), comment
    code = 'APPROVAL_STALE' if stale else 'APPROVAL_CANCELED' if status == 'CANCELED' else 'APPROVAL_DECIDED'
    record(db, row, user, version, code, approved=status == 'APPROVED' if code == 'APPROVAL_DECIDED' else None)
    if stale:
        # Error responses roll back dependency transactions. Commit this terminal
        # decision and its event/inbox before returning the intentional conflict.
        db.commit()
        fail(409, 'APPROVAL_STALE', '요청 이후 지도가 바뀌었습니다. 새 승인 판에서 다시 요청하세요.',
            {'approved_version_id': str(floor.approved_version_id) if floor.approved_version_id else None})
    return approval_object(db, row)


def install(app, DB, Identity, fail, authorize, page):
    def own(db, user, identifier, *, lock=False):
        query = visible(user).where(Approval.id == identifier)
        if lock:
            query = query.with_for_update()
        row = db.scalar(query)
        if row is None:
            fail(404, 'NOT_FOUND', '결재 요청을 찾을 수 없습니다.')
        return row

    @app.get('/api/v1/approvals', response_model=C.ApprovalList)
    def approvals(auth: Identity, db: DB, status: C.ApprovalStatus | None = None,
                  limit: Annotated[int, Query(ge=1, le=100)] = 50, cursor: str | None = None):
        query = visible(auth[0])
        if status is not None:
            query = query.where(Approval.status == status)
        # Oldest first, matching F-AP-02; the shared opaque UUID cursor is stable.
        return C.ApprovalList(**page(db, query, Approval, limit, cursor, lambda db, row: approval_object(db, row)))

    @app.get('/api/v1/approvals/{approval_id}', response_model=C.Approval)
    def detail(approval_id: UUID, auth: Identity, db: DB):
        return approval_object(db, own(db, auth[0], approval_id))

    @app.post('/api/v1/approvals/{approval_id}/approve', response_model=C.Approval)
    def approve(approval_id: UUID, auth: Identity, db: DB, body: C.ApprovalApprove = C.ApprovalApprove()):
        user = auth[0]
        row = own(db, user, approval_id, lock=True)
        authorize(user, 'A')
        return transition(db, row, user, 'APPROVED', body.comment, fail)

    @app.post('/api/v1/approvals/{approval_id}/reject', response_model=C.Approval)
    def reject(approval_id: UUID, body: C.ApprovalReject, auth: Identity, db: DB):
        user = auth[0]
        row = own(db, user, approval_id, lock=True)
        authorize(user, 'A')
        return transition(db, row, user, 'REJECTED', body.reason, fail)

    @app.post('/api/v1/approvals/{approval_id}/cancel', response_model=C.Approval)
    def cancel(approval_id: UUID, auth: Identity, db: DB):
        user = auth[0]
        row = own(db, user, approval_id, lock=True)
        if row.requester_id != user.id:
            fail(403, 'FORBIDDEN', '요청한 사람만 취소할 수 있습니다.')
        return transition(db, row, user, 'CANCELED', None, fail)

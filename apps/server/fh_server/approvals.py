"""S4a map requests and one terminal transition, atomic with map/event/inbox."""
from typing import Annotated
from uuid import UUID

from fastapi import Query
from sqlalchemy import func, select
from apps.contracts import models as C
from .event_messages import render
from .models import Approval, Assignment, Event, Floor, MapVersion, Robot, Scenario, ScenarioVersion, User, now
from .notifications import append_for_event


KINDS = {'MAP_REVISION': '지도 수정', 'MAP_ROLLBACK': '지도 되돌리기', 'SCENARIO_ASSIGNMENT': '시나리오 배정'}


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
            **({'assignment_id': str(version.id), 'robot_id': str(version.robot_id)}
                if approval.kind == 'SCENARIO_ASSIGNMENT' else
                {'floor_id': str(version.floor_id), 'map_version_id': str(version.id)}),
            'base_version_id': str(approval.base_ref_id) if approval.base_ref_id else None,
            'number': db.get(ScenarioVersion, version.scenario_version_id).number if approval.kind == 'SCENARIO_ASSIGNMENT' else version.number, 'reason': approval.reason,
            'decision_comment': approval.decision_comment, 'approved': approved})
    if approval.kind == 'SCENARIO_ASSIGNMENT':
        row.robot_id = version.robot_id
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


def request_assignment(db, user, assignment):
    row = Approval(org_id=user.org_id, kind='SCENARIO_ASSIGNMENT', status='PENDING',
        target_type='assignment', target_id=assignment.id, requester_id=user.id, reason=assignment.memo)
    db.add(row)
    db.flush()
    record(db, row, user, assignment, 'APPROVAL_REQUESTED')
    return row


def approval_objects(db, rows):
    if not rows:
        return []
    identifiers = {identifier for row in rows for identifier in (row.requester_id, row.decider_id) if identifier}
    users = {user.id: C.Person(id=user.id, display_name=user.display_name) for user in db.execute(
        select(User.id, User.display_name).where(User.org_id == rows[0].org_id, User.id.in_(identifiers)))}
    return [C.Approval(id=row.id, kind=row.kind, status=row.status, requester=users[row.requester_id],
        decider=users[row.decider_id] if row.decider_id else None, reason=row.reason,
        decision_comment=row.decision_comment, target=C.ApprovalRef(type=row.target_type, id=row.target_id),
        base_ref=C.ApprovalRef(id=row.base_ref_id) if row.base_ref_id else None,
        emergency=row.emergency, created_at=row.created_at, decided_at=row.decided_at) for row in rows]


def approval_object(db, row):
    return approval_objects(db, [row])[0]


def approval_detail(db, row):
    if row.kind == 'SCENARIO_ASSIGNMENT':
        assignment = db.scalar(select(Assignment).where(Assignment.org_id == row.org_id, Assignment.id == row.target_id))
        version = db.scalar(select(ScenarioVersion).where(ScenarioVersion.org_id == row.org_id, ScenarioVersion.id == assignment.scenario_version_id))
        robot = db.scalar(select(Robot).where(Robot.org_id == row.org_id, Robot.id == assignment.robot_id))
        return C.ApprovalDetail(**approval_object(db, row).model_dump(), preview=C.ApprovalAssignmentPreview(
            scenario_id=version.scenario_id, scenario_name=version.name, scenario_version=version.number,
            robot_id=robot.id, robot_name=robot.name))
    target = db.execute(select(MapVersion.floor_id, MapVersion.number).where(
        MapVersion.org_id == row.org_id, MapVersion.id == row.target_id)).one()
    floor = db.scalar(select(Floor).where(Floor.org_id == row.org_id, Floor.id == target.floor_id))
    base_number = db.scalar(select(MapVersion.number).where(MapVersion.org_id == row.org_id,
        MapVersion.id == row.base_ref_id)) if row.base_ref_id else None
    return C.ApprovalDetail(**approval_object(db, row).model_dump(), preview=C.ApprovalMapPreview(
        floor_id=floor.id, floor_name=floor.name, target_version_number=target.number, base_version_number=base_number))


def transition(db, row, user, status, comment, fail):
    # Caller holds the approval row. All terminal transitions pass this guard.
    if row.status != 'PENDING':
        fail(409, 'ALREADY_DECIDED', '이미 끝난 요청입니다. 결재 목록을 새로 확인하세요.')
    if status != 'CANCELED' and row.requester_id == user.id:
        fail(403, 'FORBIDDEN', '본인이 요청한 결재는 취소만 할 수 있습니다. 다른 총괄에게 처리를 요청하세요.')
    if row.kind == 'SCENARIO_ASSIGNMENT':
        version, stale = transition_assignment(db, row, user, status)
        detail = {'assignment_id': str(version.id)}
    else:
        version, stale, detail = transition_map(db, row, user, status, fail)
    if stale:
        status = 'STALE'
    row.status, row.decider_id, row.decided_at, row.decision_comment = status, user.id, now(), comment
    code = 'APPROVAL_STALE' if stale else 'APPROVAL_CANCELED' if status == 'CANCELED' else 'APPROVAL_DECIDED'
    record(db, row, user, version, code, approved=status == 'APPROVED' if code == 'APPROVAL_DECIDED' else None)
    if stale:
        # Error responses roll back dependency transactions. Commit this terminal
        # decision and its event/inbox before returning the intentional conflict.
        db.commit()
        fail(409, 'APPROVAL_STALE', '요청 이후 배정 대상이 바뀌었습니다. 다시 요청하세요.' if row.kind == 'SCENARIO_ASSIGNMENT' else '요청 이후 지도가 바뀌었습니다. 새 승인 판에서 다시 요청하세요.', detail)
    return approval_object(db, row)


def transition_map(db, row, user, status, fail):
    from .maps import refresh_connectors, bounded_features, validate_rollback_connectors
    version = db.scalar(select(MapVersion).where(MapVersion.org_id == user.org_id, MapVersion.id == row.target_id))
    floor = db.scalar(select(Floor).where(Floor.org_id == user.org_id, Floor.id == version.floor_id).with_for_update())
    stale = status == 'APPROVED' and row.base_ref_id != floor.approved_version_id
    if not stale and status == 'APPROVED':
        validate_rollback_connectors(db, floor, bounded_features(version, fail), fail)
        version.status = 'APPROVED'
        floor.approved_version_id = version.id
        db.flush()
        refresh_connectors(db, floor)
    elif status in ('REJECTED', 'CANCELED'):
        version.status = status
    return version, stale, {'approved_version_id': str(floor.approved_version_id) if floor.approved_version_id else None}


def transition_assignment(db, approval, user, status):
    # Global order: approval -> assignment -> scenario -> robot -> sorted floors.
    # Shared locks hold archive/owner/map checks stable through the decision commit.
    row = db.scalar(select(Assignment).where(Assignment.org_id == user.org_id,
        Assignment.id == approval.target_id).with_for_update())
    if status == 'CANCELED':
        row.status, row.removed_at = 'REMOVED', now()
        return row, False
    elif status == 'REJECTED':
        row.status = 'REJECTED'
        return row, False
    version = db.scalar(select(ScenarioVersion).where(ScenarioVersion.org_id == user.org_id,
        ScenarioVersion.id == row.scenario_version_id))
    scenario = db.scalar(select(Scenario).where(Scenario.org_id == user.org_id,
        Scenario.id == version.scenario_id).with_for_update(read=True))
    robot = db.scalar(select(Robot).where(Robot.org_id == user.org_id,
        Robot.id == row.robot_id).with_for_update(read=True))
    floors = list(db.scalars(select(Floor).where(Floor.org_id == user.org_id,
        Floor.id.in_(version.floor_ids)).order_by(Floor.id).with_for_update(read=True)))
    maps_current = {f.approved_version_id for f in floors}
    stale = status == 'APPROVED' and (scenario.archived_at is not None or row.status != 'PENDING'
        or robot.owner_user_id != approval.requester_id or robot.archived_at is not None
        or len(floors) != len(version.floor_ids) or maps_current != set(version.map_version_ids))
    if stale:
        # No assignment STALE state in 06: retire an invalid request as REJECTED,
        # preserving REMOVED when an already removed assignment is encountered.
        if row.status == 'PENDING':
            row.status = 'REJECTED'
    elif status == 'APPROVED':
        row.status = 'ACTIVE'
    return row, stale


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
        return C.ApprovalList(**page(db, query, Approval, limit, cursor, None, serialize_many=approval_objects))

    @app.get('/api/v1/approvals/{approval_id}', response_model=C.ApprovalDetail)
    def detail(approval_id: UUID, auth: Identity, db: DB):
        return approval_detail(db, own(db, auth[0], approval_id))

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

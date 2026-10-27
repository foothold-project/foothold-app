"""S5b scenario snapshots assigned to robots; removal preserves audit history."""
from typing import Annotated
from uuid import UUID

from fastapi import Query
from sqlalchemy import select
from apps.contracts import models as C
from . import approvals, idempotency
from .event_messages import render
from .scenario_targets import require_target
from .models import Approval, Assignment, Event, Robot, Scenario, ScenarioVersion, now


def assignment_objects(db, rows):
    if not rows:
        return []
    org_id = rows[0].org_id
    versions = {v.id: v for v in db.scalars(select(ScenarioVersion).where(
        ScenarioVersion.org_id == org_id, ScenarioVersion.id.in_({r.scenario_version_id for r in rows})))}
    robots = dict(db.execute(select(Robot.id, Robot.name).where(Robot.org_id == org_id,
        Robot.id.in_({r.robot_id for r in rows}))).all())
    return [C.Assignment(scenario_id=versions[r.scenario_version_id].scenario_id,
        scenario_version=versions[r.scenario_version_id].number, scenario_name=versions[r.scenario_version_id].name,
        robot_name=robots[r.robot_id], **{k: getattr(r, k) for k in (
            'id', 'robot_id', 'status', 'approval_id', 'memo', 'created_by', 'created_at', 'removed_at')}) for r in rows]


def record(db, user, row, code):
    version = db.get(ScenarioVersion, row.scenario_version_id)
    db.add(render(db, Event(org_id=user.org_id, category='ACCOUNT', code=code,
        user_id=user.id, robot_id=row.robot_id, data={'assignment_id': str(row.id),
            'scenario_id': str(version.scenario_id), 'scenario_version': version.number,
            'scenario_name': version.name, 'number': version.number, 'status': row.status})))


def robot_for_write(db, user, robot_id, fail, *, creating):
    query = select(Robot).where(Robot.org_id == user.org_id, Robot.id == robot_id)
    if creating:
        query = query.where(Robot.archived_at.is_(None))
    robot = db.scalar(query.with_for_update(read=True))
    if robot is None:
        fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
    if user.role != 'ORG_ADMIN' and robot.owner_user_id != user.id:
        fail(403, 'FORBIDDEN', '담당 로봇만 배정하거나 해제할 수 있습니다.')
    return robot


def install(app, DB, Identity, fail, page):
    @app.get('/api/v1/assignments', response_model=C.AssignmentList)
    def listing(auth: Identity, db: DB, robot_id: UUID | None = None, status: C.AssignmentStatus | None = None,
                limit: Annotated[int, Query(ge=1, le=100)] = 50, cursor: str | None = None):
        query = select(Assignment).where(Assignment.org_id == auth[0].org_id)
        if robot_id is not None:
            query = query.where(Assignment.robot_id == robot_id)
        if status is not None:
            query = query.where(Assignment.status == status)
        return C.AssignmentList(**page(db, query, Assignment, limit, cursor, None, serialize_many=assignment_objects))

    @app.post('/api/v1/assignments', response_model=C.Assignment, status_code=201)
    def create(body: C.AssignmentCreate, auth: Identity, db: DB, idempotency_key: idempotency.KeyHeader = None):
        user = auth[0]
        receipt, replay = idempotency.begin(db, user, idempotency_key, 'POST /assignments', body, fail)
        if replay is not None:
            return replay
        scenario = db.scalar(select(Scenario).where(Scenario.org_id == user.org_id,
            Scenario.id == body.scenario_id).with_for_update(read=True))
        if scenario is None:
            fail(404, 'NOT_FOUND', '시나리오를 찾을 수 없습니다.')
        if scenario.archived_at is not None:
            fail(422, 'SCENARIO_ARCHIVED', '보관된 시나리오는 배정할 수 없습니다.')
        version = db.scalar(select(ScenarioVersion).where(ScenarioVersion.org_id == user.org_id,
            ScenarioVersion.scenario_id == scenario.id, ScenarioVersion.number == body.scenario_version))
        if version is None:
            fail(404, 'NOT_FOUND', '시나리오 판을 찾을 수 없습니다.')
        robot = robot_for_write(db, user, body.robot_id, fail, creating=True)
        require_target(db, version, robot, fail)
        if db.scalar(select(Assignment.id).where(Assignment.org_id == user.org_id,
                Assignment.robot_id == body.robot_id, Assignment.scenario_version_id == version.id,
                Assignment.status.in_(['ACTIVE', 'PENDING']))) is not None:
            fail(409, 'ASSIGNMENT_EXISTS', '이미 배정되었거나 결재를 기다리는 시나리오 판입니다.')
        row = Assignment(org_id=user.org_id, scenario_version_id=version.id, robot_id=body.robot_id,
            status='ACTIVE', memo=body.memo, created_by=user.id)
        db.add(row)
        db.flush()
        record(db, user, row, 'ASSIGNMENT_CREATED')
        db.flush()
        return idempotency.finish(receipt, assignment_objects(db, [row])[0])

    @app.delete('/api/v1/assignments/{assignment_id}', status_code=204)
    def remove(assignment_id: UUID, auth: Identity, db: DB):
        user = auth[0]
        # Read immutable pointer only, then lock in the terminal transition order:
        # approval -> assignment -> scenario/robot/floors. Never lock in reverse.
        original = db.scalar(select(Assignment).where(Assignment.org_id == user.org_id, Assignment.id == assignment_id))
        if original is None:
            fail(404, 'NOT_FOUND', '배정을 찾을 수 없습니다.')
        approval = db.scalar(select(Approval).where(Approval.org_id == user.org_id,
            Approval.id == original.approval_id).with_for_update()) if original.approval_id else None
        row = db.scalar(select(Assignment).where(Assignment.org_id == user.org_id,
            Assignment.id == assignment_id).with_for_update().execution_options(populate_existing=True))
        robot_for_write(db, user, row.robot_id, fail, creating=False)
        if row.status == 'REMOVED':
            return
        if row.status == 'PENDING' and approval is not None and approval.status == 'PENDING':
            approvals.transition(db, approval, user, 'CANCELED', None, fail)
        row.status, row.removed_at = 'REMOVED', now()
        record(db, user, row, 'ASSIGNMENT_REMOVED')

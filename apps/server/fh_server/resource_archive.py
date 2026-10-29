"""Archive guards and selection filters; historical snapshots remain readable."""
from sqlalchemy import any_, exists, or_, select

from .models import Assignment, Building, Floor, Robot, Run, ScenarioVersion

TERMINAL_RUNS = ('COMPLETED', 'FAILED', 'CANCELED', 'ABORTED')


def visible_version():
    """A fixed scenario version is selectable only while all its floors are live."""
    return ~exists(select(Floor.id).where(Floor.org_id == ScenarioVersion.org_id,
        Floor.id == any_(ScenarioVersion.floor_ids), Floor.archived_at.is_not(None)))


def require_live_floors(db, version, fail):
    floors = list(db.scalars(select(Floor).where(Floor.org_id == version.org_id,
        Floor.id.in_(version.floor_ids)).order_by(Floor.id).with_for_update(read=True)))
    if len(floors) != len(set(version.floor_ids)) or any(f.archived_at is not None for f in floors):
        fail(409, 'RESOURCE_ARCHIVED', '삭제된 층을 사용하는 시나리오는 배정하거나 실행할 수 없습니다.')


def require_unused(db, org_id, fail, *, floor=None, scenario=None):
    versions = select(ScenarioVersion.id).where(ScenarioVersion.org_id == org_id)
    if floor is not None:
        versions = versions.where(floor.id == any_(ScenarioVersion.floor_ids))
        if db.scalar(select(Robot.id).where(Robot.org_id == org_id, Robot.archived_at.is_(None),
                Robot.last_floor_id == floor.id).limit(1)):
            fail(409, 'RESOURCE_IN_USE', '현재 이 층에 있는 로봇이 있어 삭제할 수 없습니다.')
        building = db.get(Building, floor.building_id)
        if building.sim_world_id and db.scalar(select(Robot.id).where(Robot.org_id == org_id,
                Robot.archived_at.is_(None), Robot.simulation.is_(True), Robot.sim_state != 'IDLE',
                or_(Robot.sim_world_id.is_(None), Robot.sim_world_id == building.sim_world_id)).limit(1)):
            # Legacy non-idle slots have no durable world; keep them fail-closed
            # until their existing cleanup flow confirms IDLE. No manager RPC.
            fail(409, 'RESOURCE_IN_USE', '이 층을 사용하는 시뮬 세션이 있어 삭제할 수 없습니다. 세션을 먼저 종료하세요.')
    else:
        versions = versions.where(ScenarioVersion.scenario_id == scenario.id)
    run_scope = Run.scenario_version_id.in_(versions)
    if floor is not None:
        run_scope = or_(run_scope, Run.floor_id == floor.id)
    if db.scalar(select(Run.id).where(Run.org_id == org_id,
            Run.status.not_in(TERMINAL_RUNS), run_scope).limit(1)):
        fail(409, 'RESOURCE_IN_USE', '실행 중이거나 대기·일시정지 중인 임무가 있어 삭제할 수 없습니다.')
    if db.scalar(select(Assignment.id).where(Assignment.org_id == org_id,
            Assignment.status.in_(('ACTIVE', 'PENDING')), Assignment.scenario_version_id.in_(versions)).limit(1)):
        fail(409, 'RESOURCE_IN_USE', '사용 중이거나 결재 대기 중인 로봇 배정이 있어 삭제할 수 없습니다. 배정을 먼저 해제하세요.')

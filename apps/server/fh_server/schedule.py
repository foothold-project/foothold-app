"""로봇 일정 칸 · 기간 가용 · 시나리오 예상 시간 (app-design-lx 11/28 합의).

권한은 배정과 같다: 조직 사용자는 모두 읽고, 바꾸기는 총괄 또는 그 로봇 담당만 한다.
겹침 검사는 로봇 행을 배타 잠금한 뒤에 하므로 같은 로봇에 동시에 넣어도 하나만 들어간다.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Annotated
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Query
from sqlalchemy import select
from apps.contracts import models as C
from . import idempotency
from .event_messages import render
from .robots import robot_objects
from .models import (Assignment, Building, Event, Floor, MissionVersion, Robot, Scenario, ScenarioVersion,
                     ScheduleSlot, now)

# 미실측 추정 표. 실기 · 시뮬에서 잰 값이 아니다. 잰 값이 생기기 전까지 estimate_source 는
# 항상 TABLE_UNMEASURED 다. 값을 바꿀 때는 이 표 한 곳만 고친다.
#   speed_mps: 직선 경로 평균 걷기 속도 (m/s)
#   battery_pct_per_min: 걷기 · 할 일 시간 전체에 같은 비율로 빼는 배터리 소모 (%/분)
GAIT_TABLE_UNMEASURED = {
    'classic': {'speed_mps': 0.4, 'battery_pct_per_min': 0.8},
    'sport': {'speed_mps': 0.8, 'battery_pct_per_min': 1.0},
    'start': {'speed_mps': 0.5, 'battery_pct_per_min': 0.9},
    'ame2': {'speed_mps': 0.5, 'battery_pct_per_min': 0.9},
}
# 시간 값이 없는 할 일의 미실측 고정 시간 (초). WAIT · SENSOR_LOG 는 임무에 적힌 초를 쓴다.
TASK_TABLE_UNMEASURED = {'PHOTO': 5.0, 'OPERATOR_CONFIRM': 30.0}

LABELS = {'BATTERY_SWAP': '배터리 교체'}


def slot_object(row):
    return C.ScheduleSlot(id=row.id, robot_id=row.robot_id, scenario_id=row.scenario_id,
        scenario_version=row.scenario_version, gait=row.gait, start=row.start_at, end=row.end_at,
        kind=row.kind, assignment_id=row.assignment_id, memo=row.memo,
        created_by=row.created_by, created_at=row.created_at)


def record(db, user, row, code):
    db.add(render(db, Event(org_id=user.org_id, category='ACCOUNT', code=code, user_id=user.id,
        robot_id=row.robot_id, data={'slot_id': str(row.id), 'kind': row.kind,
            'start': row.start_at.astimezone(timezone.utc).isoformat(),
            'end': row.end_at.astimezone(timezone.utc).isoformat(),
            'scenario_id': str(row.scenario_id) if row.scenario_id else None,
            'scenario_version': row.scenario_version})))


def lock_robots(db, user, ids, fail, *, creating):
    # 여러 로봇은 id 순서로 잠가 교착을 막는다. 권한 판단은 배정의 robot_for_write 와 같다.
    robots = {}
    for robot_id in sorted(set(ids), key=str):
        query = select(Robot).where(Robot.org_id == user.org_id, Robot.id == robot_id)
        if creating:
            query = query.where(Robot.archived_at.is_(None))
        robot = db.scalar(query.with_for_update())
        if robot is None:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        if user.role != 'ORG_ADMIN' and robot.owner_user_id != user.id:
            fail(403, 'FORBIDDEN', '담당 로봇의 일정만 바꿀 수 있습니다.')
        robots[robot_id] = robot
    return robots


def overlapping(db, org_id, robot_id, start, end, exclude=None):
    query = select(ScheduleSlot).where(ScheduleSlot.org_id == org_id, ScheduleSlot.robot_id == robot_id,
        ScheduleSlot.start_at < end, ScheduleSlot.end_at > start)
    if exclude is not None:
        query = query.where(ScheduleSlot.id != exclude)
    return list(db.scalars(query.order_by(ScheduleSlot.start_at, ScheduleSlot.id)))


def require_free(db, org_id, robot_id, start, end, fail, exclude=None):
    rows = overlapping(db, org_id, robot_id, start, end, exclude)
    if rows:
        fail(409, 'SCHEDULE_CONFLICT', '같은 로봇의 다른 일정과 겹칩니다.',
             {'slot_ids': [str(row.id) for row in rows]})


def scenario_version(db, user, scenario_id, number, fail):
    scenario = db.scalar(select(Scenario).where(Scenario.org_id == user.org_id, Scenario.id == scenario_id))
    if scenario is None:
        fail(404, 'NOT_FOUND', '시나리오를 찾을 수 없습니다.')
    version = db.scalar(select(ScenarioVersion).where(ScenarioVersion.org_id == user.org_id,
        ScenarioVersion.scenario_id == scenario.id,
        ScenarioVersion.number == (number if number is not None else scenario.latest_version)))
    if version is None:
        fail(404, 'NOT_FOUND', '시나리오 판을 찾을 수 없습니다.')
    return scenario, version


def task_seconds(db, org_id, version, fail):
    total = 0.0
    for point in version.waypoints:
        mission = db.scalar(select(MissionVersion).where(MissionVersion.org_id == org_id,
            MissionVersion.mission_id == UUID(str(point['mission_id'])),
            MissionVersion.number == point['mission_version']))
        if mission is None:
            fail(422, 'PLAN_UNAVAILABLE', '고정 임무 판을 찾을 수 없습니다.')
        for step in mission.steps:
            params = step.get('params') or {}
            if step['action'] == 'WAIT':
                # 지점의 wait_s 가 임무의 대기 초를 덮는다 (runs.py 와 같은 규칙).
                total += point.get('wait_s') or params.get('seconds', C.WaitParams().seconds)
            elif step['action'] == 'SENSOR_LOG':
                total += params.get('seconds', C.SensorLogParams().seconds)
            else:
                total += TASK_TABLE_UNMEASURED[step['action']]
    return total


def day_range(day, tz, fail):
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        fail(400, 'VALIDATION', '시간대 이름을 확인하세요.')
    start = datetime(day.year, day.month, day.day, tzinfo=zone)
    end = datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=zone)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def install(app, DB, Identity, fail):
    @app.get('/api/v1/schedule', response_model=C.ScheduleDay)
    def day_view(auth: Identity, db: DB, day: date,
                 tz: Annotated[str, Query(min_length=1, max_length=64)] = 'Asia/Seoul'):
        start, end = day_range(day, tz, fail)
        rows = db.scalars(select(ScheduleSlot).where(ScheduleSlot.org_id == auth[0].org_id,
            ScheduleSlot.start_at < end, ScheduleSlot.end_at > start).order_by(
                ScheduleSlot.start_at, ScheduleSlot.robot_id, ScheduleSlot.id))
        return C.ScheduleDay(day=day, tz=tz, slots=[slot_object(row) for row in rows])

    @app.post('/api/v1/schedule/slots', response_model=C.ScheduleSlot, status_code=201)
    def create(body: C.ScheduleSlotCreate, auth: Identity, db: DB, idempotency_key: idempotency.KeyHeader = None):
        user = auth[0]
        receipt, replay = idempotency.begin(db, user, idempotency_key, 'POST /schedule/slots', body, fail)
        if replay is not None:
            return replay
        if body.scenario_id is not None:
            scenario, _ = scenario_version(db, user, body.scenario_id, body.scenario_version, fail)
            if scenario.archived_at is not None:
                fail(422, 'SCENARIO_ARCHIVED', '보관된 시나리오는 일정에 넣을 수 없습니다.')
        if body.assignment_id is not None and db.scalar(select(Assignment.id).where(
                Assignment.org_id == user.org_id, Assignment.id == body.assignment_id)) is None:
            fail(404, 'NOT_FOUND', '배정을 찾을 수 없습니다.')
        lock_robots(db, user, [body.robot_id], fail, creating=True)
        require_free(db, user.org_id, body.robot_id, body.start, body.end, fail)
        row = ScheduleSlot(org_id=user.org_id, robot_id=body.robot_id, scenario_id=body.scenario_id,
            scenario_version=body.scenario_version, gait=body.gait, start_at=body.start, end_at=body.end,
            kind=body.kind, assignment_id=body.assignment_id, memo=body.memo, created_by=user.id)
        db.add(row)
        db.flush()
        record(db, user, row, 'SCHEDULE_SLOT_CREATED')
        db.flush()
        return idempotency.finish(receipt, slot_object(row))

    def find(db, user, slot_id):
        row = db.scalar(select(ScheduleSlot).where(ScheduleSlot.org_id == user.org_id, ScheduleSlot.id == slot_id))
        if row is None:
            fail(404, 'NOT_FOUND', '일정을 찾을 수 없습니다.')
        return row

    @app.patch('/api/v1/schedule/slots/{slot_id}', response_model=C.ScheduleSlot)
    def patch(slot_id: UUID, body: C.ScheduleSlotPatch, auth: Identity, db: DB):
        user = auth[0]
        values = body.model_dump(exclude_unset=True)
        original = find(db, user, slot_id)
        target = values.get('robot_id', original.robot_id)
        # 옮기기는 원래 로봇과 새 로봇 둘 다 바꿀 권한이 있어야 한다. 두 로봇은 한 번에 id 순서로 잠근다.
        robots = lock_robots(db, user, [original.robot_id, target], fail, creating=False)
        if robots[target].archived_at is not None:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        row = db.scalar(select(ScheduleSlot).where(ScheduleSlot.org_id == user.org_id,
            ScheduleSlot.id == slot_id).with_for_update().execution_options(populate_existing=True))
        if row is None:
            fail(404, 'NOT_FOUND', '일정을 찾을 수 없습니다.')
        if row.robot_id != original.robot_id:
            fail(409, 'VERSION_CONFLICT', '일정이 다른 로봇으로 옮겨졌습니다. 다시 불러오세요.')
        start, end = values.get('start', row.start_at), values.get('end', row.end_at)
        kind = values.get('kind', row.kind)
        if end <= start:
            fail(400, 'VALIDATION', '끝 시각은 시작 시각보다 뒤여야 합니다.')
        if row.scenario_id is None and kind != 'BATTERY_SWAP':
            fail(400, 'VALIDATION', '시나리오 없는 일정은 배터리 교체만 됩니다.')
        require_free(db, user.org_id, target, start, end, fail, exclude=row.id)
        row.robot_id, row.start_at, row.end_at, row.kind = target, start, end, kind
        if 'gait' in values:
            row.gait = values['gait']
        db.flush()
        record(db, user, row, 'SCHEDULE_SLOT_UPDATED')
        return slot_object(row)

    @app.delete('/api/v1/schedule/slots/{slot_id}', status_code=204)
    def remove(slot_id: UUID, auth: Identity, db: DB):
        user = auth[0]
        original = find(db, user, slot_id)
        lock_robots(db, user, [original.robot_id], fail, creating=False)
        row = db.scalar(select(ScheduleSlot).where(ScheduleSlot.org_id == user.org_id,
            ScheduleSlot.id == slot_id).with_for_update().execution_options(populate_existing=True))
        if row is None:
            return
        if row.robot_id != original.robot_id:
            fail(409, 'VERSION_CONFLICT', '일정이 다른 로봇으로 옮겨졌습니다. 다시 불러오세요.')
        record(db, user, row, 'SCHEDULE_SLOT_DELETED')
        db.delete(row)

    def labels(db, org_id, rows):
        keys = {(r.scenario_id, r.scenario_version) for r in rows if r.scenario_id}
        names = {}
        if keys:
            for version in db.scalars(select(ScenarioVersion).where(ScenarioVersion.org_id == org_id,
                    ScenarioVersion.scenario_id.in_({k[0] for k in keys}))):
                names[(version.scenario_id, version.number)] = version.name
        return {r.id: LABELS.get(r.kind) or names.get((r.scenario_id, r.scenario_version)) for r in rows}

    def floor_labels(db, org_id, floor_ids):
        if not floor_ids:
            return {}
        return {floor_id: building + ' · ' + floor for floor_id, floor, building in db.execute(
            select(Floor.id, Floor.name, Building.name).join(Building, (Building.id == Floor.building_id)
                & (Building.org_id == Floor.org_id)).where(Floor.org_id == org_id, Floor.id.in_(floor_ids)))}

    @app.get('/api/v1/robots/availability', response_model=C.RobotAvailabilityList)
    def availability(auth: Identity, db: DB, start: Annotated[C.UTCDateTime, Query()],
                     end: Annotated[C.UTCDateTime, Query()]):
        user = auth[0]
        if end <= start:
            fail(400, 'VALIDATION', '끝 시각은 시작 시각보다 뒤여야 합니다.')
        robots = list(db.scalars(select(Robot).where(Robot.org_id == user.org_id,
            Robot.archived_at.is_(None)).order_by(Robot.name, Robot.id)))
        # 연결 · 배터리 · 위치는 로봇 요약과 같은 가림 규칙을 따른다 (담당 아닌 운영자는 모름).
        summaries = {s.id: s for s in robot_objects(db, robots, user, app.state.realtime)}
        busy = {}
        if robots:
            rows = list(db.scalars(select(ScheduleSlot).where(ScheduleSlot.org_id == user.org_id,
                ScheduleSlot.robot_id.in_([r.id for r in robots]), ScheduleSlot.start_at < end,
                ScheduleSlot.end_at > start).order_by(ScheduleSlot.end_at, ScheduleSlot.id)))
            names = labels(db, user.org_id, rows)
            for row in rows:  # 끝이 가장 늦은 칸이 남는다
                busy[row.robot_id] = (row, names[row.id])
        places = floor_labels(db, user.org_id, {s.location.floor_id for s in summaries.values()
                                                if s.location and s.location.floor_id})
        items = []
        for robot in robots:
            summary = summaries[robot.id]
            slot, label = busy.get(robot.id, (None, None))
            # 겹치는 일정이 먼저다. CHARGING 신호는 서버에 아직 없어 내지 않는다.
            state = 'BUSY' if slot else 'OFFLINE' if summary.connection == 'OFFLINE' else 'FREE'
            items.append(C.RobotAvailability(robot_id=robot.id, robot_name=robot.name, state=state,
                busy_until=slot.end_at if slot else None, busy_slot_id=slot.id if slot else None,
                busy_label=label, battery_pct=summary.battery.soc if summary.battery else None,
                demo=False, sim=robot.simulation is True,
                location_label=places.get(summary.location.floor_id) if summary.location else None))
        return C.RobotAvailabilityList(items=items)

    @app.post('/api/v1/estimates', response_model=C.Estimate)
    def estimate(body: C.EstimateRequest, auth: Identity, db: DB):
        user = auth[0]
        robot = db.scalar(select(Robot).where(Robot.org_id == user.org_id, Robot.id == body.robot_id,
            Robot.archived_at.is_(None)))
        if robot is None:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        _, version = scenario_version(db, user, body.scenario_id, body.scenario_version, fail)
        table = GAIT_TABLE_UNMEASURED[body.gait]
        # 길이는 시나리오 저장 때 지점 순서로 잰 직선 · 연결점 경유 거리다 (Nav2 경로 아님).
        length = float(version.est_distance_m)
        walk_s = length / table['speed_mps']
        task_s = task_seconds(db, user.org_id, version, fail)
        start = body.start or now()
        eta = start + timedelta(seconds=walk_s + task_s)
        following = db.scalar(select(ScheduleSlot.start_at).where(ScheduleSlot.org_id == user.org_id,
            ScheduleSlot.robot_id == robot.id, ScheduleSlot.start_at >= start).order_by(ScheduleSlot.start_at).limit(1))
        summary = robot_objects(db, [robot], user, app.state.realtime)[0]
        end_battery = None
        if summary.battery is not None:
            end_battery = max(0.0, summary.battery.soc - table['battery_pct_per_min'] * (walk_s + task_s) / 60)
        return C.Estimate(length_m=length, walk_s=walk_s, task_s=task_s, eta=eta,
            margin_s=(following - eta).total_seconds() if following else None,
            end_battery_pct=end_battery, estimate_source='TABLE_UNMEASURED')

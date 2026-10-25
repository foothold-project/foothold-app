"""Data-only scenario access and transactional agent report recording."""
import hashlib
import json
from uuid import UUID

from fastapi import Query, Request, Response
from sqlalchemy import select

from apps.contracts import models as C
from .event_messages import render, CATEGORIES, AGENT_CODES
from .notifications import append_for_event
from .models import (Event, MissionVersion, Robot, Run, RunReport, RunStep,
                     ScenarioVersion, User, now)

TERMINAL = {'COMPLETED', 'FAILED', 'CANCELED', 'ABORTED'}
SECRET_KEYS = {'resume_token', 'token', 'signature', 'authorization'}


def public_data(value):
    if isinstance(value, dict):
        return {k: public_data(v) for k, v in value.items() if k.lower() not in SECRET_KEYS}
    if isinstance(value, list):
        return [public_data(v) for v in value]
    return value


class ReportRejected(Exception):
    """No receipt: agent must replay its durable outbox after reconnect."""


def fixed_scenario(db, robot, identifier, version, fail):
    row = db.scalar(select(ScenarioVersion).where(ScenarioVersion.org_id == robot.org_id,
        ScenarioVersion.scenario_id == identifier, ScenarioVersion.number == version))
    if row is None:
        fail(404, 'NOT_FOUND', '시나리오 판을 찾을 수 없습니다.')
    # No SF-12 proof/assignment/user binding exists in the current data contract.
    # Do not let the simulation exception silently enable real execution.
    if robot.simulation is not True:
        fail(422, 'PRECHECK_FAILED', '실기 배정·시작 사용자·실행 전 점검 증명이 필요합니다.')
    points = []
    for waypoint in row.waypoints:
        mission = db.scalar(select(MissionVersion).where(MissionVersion.org_id == robot.org_id,
            MissionVersion.mission_id == UUID(waypoint['mission_id']),
            MissionVersion.number == waypoint['mission_version']))
        if mission is None:
            fail(422, 'PLAN_UNAVAILABLE', '고정 임무 판을 찾을 수 없습니다.')
        points.append(C.AgentScenarioWaypoint(**waypoint, mission_name=mission.name))
    return row, C.AgentScenario(id=identifier, number=version, waypoints=points, finish=row.finish)


def install(app, DB, fail):
    @app.get('/api/v1/agent/scenarios/{identifier}', response_model=C.AgentScenario)
    def scenario(identifier: UUID, request: Request, response: Response, db: DB,
                 version: int = Query(ge=1)):
        rid = app.state.realtime.agent_identity(request.headers)
        robot = db.scalar(select(Robot).where(Robot.org_id == app.state.realtime.settings.org_id,
            Robot.id == UUID(rid), Robot.archived_at.is_(None)))
        if robot is None:
            fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
        response.headers['Cache-Control'] = 'no-store'
        return fixed_scenario(db, robot, identifier, version, fail)[1]


def reject(*args):
    raise ReportRejected('RUN_REPORT_INVALID')


def start_run(db, robot, msg, at):
    body = C.RunStarted.model_validate(msg.data)
    if body.simulation != robot.simulation or (body.surface == 'pc' and not robot.simulation):
        raise ReportRejected('RUN_REPORT_PROVENANCE')
    user = db.scalar(select(User).where(User.org_id == robot.org_id, User.id == body.user_id,
        User.archived_at.is_(None), User.locked.is_(False)))
    if user is None or not (user.role == 'ORG_ADMIN' or robot.owner_user_id == user.id):
        raise ReportRejected('RUN_REPORT_OWNER')
    row, scenario = fixed_scenario(db, robot, body.scenario_id, body.scenario_version, reject)
    all_points = list(scenario.waypoints)
    if scenario.finish.target is not None:
        all_points.append(scenario.finish.target)
    if any(p.floor_id != body.floor_id or p.map_version_id != body.map_version_id for p in all_points):
        raise ReportRejected('RUN_REPORT_MAP')
    if db.get(Run, body.run_id) is not None:
        raise ReportRejected('RUN_REPORT_CONFLICT')
    goals = [C.RunGoal(idx=i, **p.model_dump(exclude={'floor_id', 'map_version_id'}))
             for i, p in enumerate(scenario.waypoints)]
    plan = C.RunPlan(segments=[C.RunSegment(floor_id=body.floor_id,
        map_version_id=body.map_version_id, goals=goals)]).model_dump(mode='json')
    # Preserve the fixed finish reference too; it is not another mission step.
    plan['finish'] = scenario.finish.model_dump(mode='json')
    run = Run(id=body.run_id, org_id=robot.org_id, robot_id=robot.id, simulation=robot.simulation,
        assignment_id=None, scenario_version_id=row.id, floor_id=body.floor_id,
        map_version_id=body.map_version_id, started_by=body.user_id, device_id=body.device_id,
        surface=body.surface, screen_id=body.screen_id, agent_instance_id=msg.agent_instance_id,
        status='QUEUED', plan=plan, started_at=at)
    db.add(run)
    db.flush()
    db.add_all([RunStep(org_id=robot.org_id, run_id=run.id, idx=i, status='PENDING')
                for i in range(len(goals))])
    db.flush()
    return run


def record(factory, org_id, rid, msg):
    """Returns only after commit. Robot row serializes reconnect/concurrent replay."""
    received = now()
    with factory.begin() as db:
        robot = db.scalar(select(Robot).where(Robot.org_id == org_id, Robot.id == UUID(rid),
            Robot.archived_at.is_(None)).with_for_update())
        if robot is None:
            raise ReportRejected('RUN_REPORT_ROBOT')
        identified = 'agent_instance_id' in msg.model_fields_set
        clean = public_data(msg.model_dump(mode='json', exclude_unset=True))
        fingerprint = hashlib.sha256(json.dumps(clean, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if identified:
            key = (robot.id, msg.agent_instance_id, msg.report_seq)
            prior = db.get(RunReport, key)
            if prior is not None:
                if prior.request_hash != fingerprint:
                    raise ReportRejected('RUN_REPORT_CONFLICT')
                return C.RunRecorded(agent_instance_id=msg.agent_instance_id, report_seq=msg.report_seq).model_dump(mode='json')
            previous = db.scalar(select(RunReport).where(RunReport.robot_id == robot.id,
                RunReport.agent_instance_id == msg.agent_instance_id).order_by(RunReport.report_seq.desc()).limit(1))
            if ((previous is None and msg.report_seq not in (0, 1)) or
                    (previous is not None and (msg.report_seq != previous.report_seq + 1
                                             or msg.monotonic_s < previous.monotonic_s))):
                raise ReportRejected('RUN_REPORT_SEQUENCE')
        run = None
        if msg.t == 'event' and msg.code == 'RUN_STARTED':
            run = start_run(db, robot, msg, received)
        else:
            identifier = str(msg.run_id) if msg.t == 'run.update' else msg.data.get('run_id')
            if identifier is not None:
                try:
                    run = db.scalar(select(Run).where(Run.org_id == org_id, Run.robot_id == robot.id,
                        Run.id == UUID(identifier)))
                except (ValueError, TypeError):
                    raise ReportRejected('RUN_REPORT_INVALID') from None
                if run is None:
                    if identified:
                        raise ReportRejected('RUN_REPORT_NOT_FOUND')
                    return None  # old producer remains accepted, without inventing a run
        if run is not None and identified and run.agent_instance_id != msg.agent_instance_id:
            # A restarted process may close the recovered run, never resume it.
            if msg.t != 'run.update' or msg.status != 'FAILED':
                raise ReportRejected('RUN_REPORT_INSTANCE')
        if msg.t == 'run.update' and run is not None and run.status not in TERMINAL:
            total = len(run.plan['segments'][0]['goals'])
            if msg.step > total or (msg.step == total and msg.status not in TERMINAL):
                raise ReportRejected('RUN_REPORT_STEP')
            run.status, run.step = msg.status, msg.step
            run.progress = msg.progress.model_dump() if msg.progress else None
            run.wait_reason, run.fail_code = msg.wait_reason, msg.fail_code
            if msg.status in TERMINAL:
                run.ended_at = received
                run.wait_reason = None
        elif msg.t == 'event':
            if msg.code in ('RUN_WAYPOINT_ARRIVED', 'RUN_WAYPOINT_RECORDED'):
                body = (C.RunWaypointArrived if msg.code == 'RUN_WAYPOINT_ARRIVED'
                        else C.RunWaypointRecorded).model_validate(msg.data)
                if run is None or run.status in TERMINAL:
                    raise ReportRejected('RUN_REPORT_STATE')
                step = db.get(RunStep, (run.id, body.idx))
                if step is None:
                    raise ReportRejected('RUN_REPORT_STEP')
                goal = run.plan['segments'][0]['goals'][body.idx]
                if (body.floor_id != run.floor_id or body.map_version_id != run.map_version_id
                        or any(str(getattr(body, k)) != str(goal[k]) for k in
                               ('mission_id', 'mission_version', 'mission_name', 'waypoint_ref'))):
                    raise ReportRejected('RUN_REPORT_PLAN')
                if msg.code == 'RUN_WAYPOINT_ARRIVED':
                    if step.status == 'PENDING':
                        step.status, step.arrived_at = 'ARRIVED', received
                else:
                    if step.status not in ('ARRIVED', 'DONE'):
                        raise ReportRejected('RUN_REPORT_STATE')
                    step.status, step.done_at = 'DONE', step.done_at or received
                    step.results = {'mode': 'DISPLAY_ONLY', **goal}
            ev = render(db, Event(org_id=org_id, robot_id=robot.id,
                run_id=run.id if run else None, at=received, robot_at=msg.robot_at,
                code=msg.code, severity=msg.severity.upper(), category='RUN' if run else CATEGORIES.get(msg.code, 'LINK'),
                data=public_data({**msg.data, **{k: clean[k] for k in
                    ('agent_instance_id', 'report_seq', 'monotonic_s') if k in clean}})), agent=True)
            db.add(ev)
            if msg.code in AGENT_CODES:
                append_for_event(db, ev)
        if identified:
            db.add(RunReport(org_id=org_id, robot_id=robot.id, agent_instance_id=msg.agent_instance_id,
                report_seq=msg.report_seq, monotonic_s=msg.monotonic_s, request_hash=fingerprint, at=received))
    return (C.RunRecorded(agent_instance_id=msg.agent_instance_id, report_seq=msg.report_seq).model_dump(mode='json')
            if identified else None)


def sample_path(factory, org_id, rid, pose, at):
    if any(pose.get(k) is None for k in ('x', 'y', 'yaw', 'floor_id', 'map_version_id')):
        return
    with factory.begin() as db:
        run = db.scalar(select(Run).where(Run.org_id == org_id, Run.robot_id == UUID(rid),
            Run.status.not_in(TERMINAL)).with_for_update())
        if run is None or str(run.floor_id) != pose['floor_id'] or str(run.map_version_id) != pose['map_version_id']:
            return
        previous = run.path_actual[-1] if run.path_actual else None
        if previous is None or at.timestamp() - previous['received_s'] >= 1:
            run.path_actual = [*run.path_actual, dict(pose, at=at.isoformat(), received_s=at.timestamp())]


def snapshot(factory, org_id, rid, identifier):
    with factory() as db:
        query = select(Run).where(Run.org_id == org_id, Run.robot_id == UUID(rid))
        query = query.where(Run.id == UUID(str(identifier))) if identifier is not None else query.where(Run.status.not_in(TERMINAL))
        run = db.scalar(query)
        if run is not None:
            return dict(run_id=str(run.id), status=run.status, step=run.step,
                        progress=run.progress, wait_reason=run.wait_reason, fail_code=run.fail_code)

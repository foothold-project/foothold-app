"""Data-only scenario access and transactional agent report recording."""
import hashlib
import json
import math
from pathlib import Path
from uuid import UUID

from fastapi import Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError

from apps.contracts import models as C
from .event_messages import render, CATEGORIES, AGENT_CODES
from .notifications import append_for_event
from .models import (AgentPlanMap, Building, Event, Floor, MapVersion, MissionVersion,
                     Robot, Run, RunReport, RunReportRejection, RunStep, ScenarioVersion, Upload, User, now)

TERMINAL = {'COMPLETED', 'FAILED', 'CANCELED', 'ABORTED'}
SECRET_KEYS = {'resume_token', 'token', 'signature', 'authorization'}


def public_data(value):
    if isinstance(value, dict):
        return {k: public_data(v) for k, v in value.items() if k.lower() not in SECRET_KEYS}
    if isinstance(value, list):
        return [public_data(v) for v in value]
    return value


class ReportRejected(Exception):
    """A business rejection, rolled back before a durable quarantine decision."""


def map_proof(db, robot, floor_id, version_id, fail):
    floor = db.scalar(select(Floor).where(Floor.org_id == robot.org_id, Floor.id == floor_id))
    version = db.scalar(select(MapVersion).where(MapVersion.org_id == robot.org_id,
        MapVersion.id == version_id, MapVersion.floor_id == floor_id))
    if floor is None or version is None:
        fail(422, 'MAP_PROOF_UNAVAILABLE', '고정 지도 판을 찾을 수 없습니다.')
    if floor.provenance != 'SIMULATION' or version.provenance != 'SIMULATION':
        fail(422, 'MAP_PROOF_UNAVAILABLE', 'HUMAN 지도는 원본 PGM 증명이 없어 실행할 수 없습니다.')
    upload = db.scalar(select(Upload).where(Upload.org_id == robot.org_id, Upload.id == version.upload_id))
    building = db.scalar(select(Building).where(Building.org_id == robot.org_id, Building.id == floor.building_id))
    meta = upload.metadata_json if upload is not None else {}
    source = meta.get('connected_gt', {})
    if (upload is None or upload.provenance != 'SIMULATION' or building is None
            or version.source != 'IMPORT' or version.status not in ('APPROVED', 'SUPERSEDED')
            or source.get('source') != 'SIMULATION' or not building.sim_world_id
            or source.get('world_id') != building.sim_world_id or not floor.sim_floor_id
            or source.get('ros_floor_id') != floor.sim_floor_id
            or source.get('sha256') != version.image_sha256.hex()
            or upload.png_sha256 != version.image_sha256
            or (upload.width, upload.height) != (version.width, version.height)
            or meta.get('resolution') != version.resolution
            or meta.get('origin') != [version.origin_x, version.origin_y, version.origin_yaw]):
        fail(422, 'MAP_PROOF_UNAVAILABLE', '시뮬 지도 원본·좌표 증명을 확인할 수 없습니다.')
    try:
        return C.RunMapProof(floor_id=floor_id, map_version_id=version_id,
            image_sha256=version.image_sha256.hex(), source_pgm_sha256=source.get('source_pgm_sha256'),
            origin=(version.origin_x, version.origin_y, version.origin_yaw), resolution=version.resolution,
            width=version.width, height=version.height, source='SIMULATION',
            world_id=source['world_id'], ros_floor_id=source['ros_floor_id'])
    except ValidationError:
        fail(422, 'MAP_PROOF_UNAVAILABLE', '시뮬 지도 PGM 증명이 올바르지 않습니다.')


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
    finish = C.ScenarioFinish.model_validate(row.finish)
    all_points = [*points, *([finish.target] if finish.target is not None else [])]
    proofs = [map_proof(db, robot, floor, version_id, fail) for floor, version_id in
              dict.fromkeys((p.floor_id, p.map_version_id) for p in all_points)]
    return row, C.ProvenAgentScenario(id=identifier, number=version, waypoints=points,
                                      finish=finish, map_proofs=proofs)


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
        row, plan = fixed_scenario(db, robot, identifier, version, fail)
        for proof in plan.map_proofs:
            db.execute(insert(AgentPlanMap).values(org_id=robot.org_id, robot_id=robot.id,
                scenario_version_id=row.id, map_version_id=proof.map_version_id).on_conflict_do_nothing())
        return plan

    @app.get('/api/v1/agent/map-versions/{identifier}/image', response_class=FileResponse)
    def image(identifier: UUID, request: Request, db: DB):
        rid = UUID(app.state.realtime.agent_identity(request.headers))
        org_id = app.state.realtime.settings.org_id
        allowed = db.scalar(select(AgentPlanMap).where(AgentPlanMap.org_id == org_id,
            AgentPlanMap.robot_id == rid, AgentPlanMap.map_version_id == identifier).limit(1))
        if allowed is None:
            fail(403, 'FORBIDDEN', '인증된 고정 계획에서 허용하지 않은 지도 판입니다.')
        row = db.scalar(select(MapVersion).where(MapVersion.org_id == org_id, MapVersion.id == identifier))
        if row is None:
            fail(404, 'NOT_FOUND', '지도 판을 찾을 수 없습니다.')
        root = Path(app.state.realtime.settings.files_root).resolve()
        path = (root / row.image_path).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            fail(503, 'FILE_STORAGE_ERROR', '지도 파일을 찾을 수 없습니다.')
        return FileResponse(path, media_type='image/png', headers={
            'Cache-Control': 'private, no-store', 'ETag': '"' + row.image_sha256.hex() + '"'})


def reject(status, code, message):
    raise ReportRejected({'NOT_FOUND': 'RUN_REPORT_NOT_FOUND',
                          'MAP_PROOF_UNAVAILABLE': 'RUN_REPORT_MAP',
                          'PLAN_UNAVAILABLE': 'RUN_REPORT_PLAN',
                          'PRECHECK_FAILED': 'RUN_REPORT_PROVENANCE'}.get(code, 'RUN_REPORT_INVALID'))


def start_run(db, robot, msg, at):
    body = C.ProvenRunStarted.model_validate(msg.data)
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
    if len(scenario.map_proofs) != 1 or body.map_proof != scenario.map_proofs[0]:
        raise ReportRejected('RUN_REPORT_MAP')
    if db.get(Run, body.run_id) is not None or db.scalar(select(Run.id).where(
            Run.robot_id == robot.id, Run.status.not_in(TERMINAL))) is not None:
        raise ReportRejected('RUN_REPORT_CONFLICT')
    goals = [C.RunGoal(idx=i, **p.model_dump(exclude={'floor_id', 'map_version_id'}))
             for i, p in enumerate(scenario.waypoints)]
    plan = C.RunPlan(segments=[C.RunSegment(floor_id=body.floor_id,
        map_version_id=body.map_version_id, goals=goals)]).model_dump(mode='json')
    # Preserve the fixed finish reference too; it is not another mission step.
    plan['finish'] = scenario.finish.model_dump(mode='json')
    plan['map_proofs'] = [proof.model_dump(mode='json') for proof in scenario.map_proofs]
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


def report_identity(raw):
    """Only the instance/sequence pair is required to address a rejection."""
    try:
        identity = C.RunRecorded(agent_instance_id=raw['agent_instance_id'], report_seq=raw['report_seq'])
        return identity
    except (KeyError, TypeError, ValueError):
        return None


def report_run_id(raw):
    try:
        value = raw.get('run_id') if raw.get('t') == 'run.update' else raw.get('data', {}).get('run_id')
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def rejection(raw, code, expected=None):
    identity = report_identity(raw)
    if identity is None:
        return None
    fields = dict(agent_instance_id=identity.agent_instance_id, report_seq=identity.report_seq,
        run_id=report_run_id(raw), code=code,
        disposition='RETRY' if code in ('RUN_REPORT_SEQUENCE', 'RUN_REPORT_STORAGE') else 'QUARANTINE')
    if expected is not None:
        fields['expected_report_seq'] = expected
    return C.RunReportRejected(t='run.report_rejected', **fields).model_dump(mode='json', exclude_unset=True)


def record(factory, org_id, rid, msg):
    """ACK/quarantine only after commit; robot lock serializes all replay decisions."""
    raw = msg if isinstance(msg, dict) else msg.model_dump(mode='json', exclude_unset=True)
    identity = report_identity(raw)
    received = now()
    fingerprint = hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(',', ':'),
                                           allow_nan=True).encode()).hexdigest()
    with factory.begin() as db:
        robot = db.scalar(select(Robot).where(Robot.org_id == org_id, Robot.id == UUID(rid)).with_for_update())
        if robot is None:
            raise ReportRejected('RUN_REPORT_ROBOT')
        if identity is None:
            # Legacy display reports never cross the persistent run boundary.
            return None
        key = (robot.id, identity.agent_instance_id, identity.report_seq)
        accepted = db.get(RunReport, key)
        denied = db.get(RunReportRejection, (*key, fingerprint))
        if accepted is not None and accepted.request_hash == fingerprint:
            return identity.model_dump(mode='json')
        if denied is not None:
            return rejection(raw, denied.code)
        prior_denial = db.scalar(select(RunReportRejection).where(
            RunReportRejection.robot_id == robot.id,
            RunReportRejection.agent_instance_id == identity.agent_instance_id,
            RunReportRejection.report_seq == identity.report_seq).limit(1))
        if accepted is not None or prior_denial is not None:
            db.add(RunReportRejection(org_id=org_id, robot_id=robot.id,
                agent_instance_id=identity.agent_instance_id, report_seq=identity.report_seq,
                request_hash=fingerprint, monotonic_s=(accepted or prior_denial).monotonic_s,
                run_id=report_run_id(raw), code='RUN_REPORT_CONFLICT', at=received))
            return rejection(raw, 'RUN_REPORT_CONFLICT')
        previous = []
        for model in (RunReport, RunReportRejection):
            row = db.scalar(select(model).where(model.robot_id == robot.id,
                model.agent_instance_id == identity.agent_instance_id).order_by(model.report_seq.desc(), model.monotonic_s.desc()).limit(1))
            if row is not None:
                previous.append(row)
        last = max(previous, key=lambda row: row.report_seq) if previous else None
        expected = last.report_seq + 1 if last is not None else 1
        if (last is None and identity.report_seq not in (0, 1)) or (last is not None and identity.report_seq != expected):
            return rejection(raw, 'RUN_REPORT_SEQUENCE', expected)
        mono = raw.get('monotonic_s')
        try:
            valid_mono = (not isinstance(mono, bool) and isinstance(mono, (int, float))
                          and math.isfinite(mono) and mono >= 0)
        except OverflowError:
            valid_mono = False
        watermark = last.monotonic_s if last is not None else 0.
        code = None
        try:
            # Failed business validation must not leak run/step/event mutations.
            with db.begin_nested():
                if robot.archived_at is not None:
                    raise ReportRejected('RUN_REPORT_ROBOT')
                if not valid_mono or mono < watermark:
                    raise ReportRejected('RUN_REPORT_INVALID')
                if raw.get('t') == 'event':
                    parsed = C.AgentEvent.model_validate(raw)
                    if 'run_id' in parsed.data or parsed.code.startswith('RUN_'):
                        parsed = C.DurableAgentEvent.model_validate(raw)
                else:
                    parsed = C.DurableAgentRunUpdate.model_validate(raw)
                apply_report(db, robot, parsed, received)
                db.flush()
        except ReportRejected as exc:
            code = str(exc)
        except ValidationError:
            code = 'RUN_REPORT_INVALID'
        except IntegrityError as exc:
            # Only known business constraints are permanent; operational failures retry.
            name = getattr(getattr(exc.orig, 'diag', None), 'constraint_name', None)
            if name not in ('one_active_run', 'runs_pkey'):
                raise
            code = 'RUN_REPORT_CONFLICT'
        fields = dict(org_id=org_id, robot_id=robot.id, agent_instance_id=identity.agent_instance_id,
            report_seq=identity.report_seq, monotonic_s=max(mono, watermark) if valid_mono else watermark,
            request_hash=fingerprint, at=received)
        if code:
            db.add(RunReportRejection(**fields, run_id=report_run_id(raw), code=code))
        else:
            db.add(RunReport(**fields))
    return rejection(raw, code) if code else identity.model_dump(mode='json')


def apply_report(db, robot, msg, received):
    org_id = robot.org_id
    clean = public_data(msg.model_dump(mode='json', exclude_unset=True))
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
                raise ReportRejected('RUN_REPORT_NOT_FOUND')
    if run is not None and run.agent_instance_id != msg.agent_instance_id:
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

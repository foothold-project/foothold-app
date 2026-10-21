"""S5a reusable immutable missions and direct-pair scenario previews."""
import math
from typing import Annotated, get_args
from uuid import UUID

from fastapi import Header, Query, Response
from sqlalchemy import any_, select, tuple_

from apps.contracts import models as C
from .maps import bounded_features, orientation, within_map
from .models import Floor, FloorConnector, MapVersion, Mission, MissionVersion, Robot, RobotDevice, Scenario, ScenarioVersion, now
from .robots import reported_devices

DEVICE_KINDS = {'rgb': 'CAMERA_RGB', 'depth': 'CAMERA_DEPTH', 'lidar': 'LIDAR', 'battery': 'BATTERY'}
LABELS = {'PHOTO': '사진 찍기', 'WAIT': '대기', 'OPERATOR_CONFIRM': '운영자 확인', 'SENSOR_LOG': '센서 값 기록'}


def requirements(step):
    if step.action == 'PHOTO':
        return [DEVICE_KINDS[step.params['camera']]]
    if step.action == 'SENSOR_LOG':
        return [DEVICE_KINDS[step.params['device']]]
    return []


def inside_polygon(x, y, polygon):
    # Boundary belongs to NO_GO too. Ray crossing supports concave polygons.
    inside = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if abs(orientation(a, b, (x, y))) <= 1e-10 and min(a[0], b[0]) <= x <= max(a[0], b[0]) and min(a[1], b[1]) <= y <= max(a[1], b[1]):
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def preview(db, user, body, fail):
    points = [(f'waypoints.{i}', point) for i, point in enumerate(body.waypoints)]
    if body.finish.mode == 'GO_TO':
        points.append(('finish.target', body.finish.target))
    # Stable shared-lock ordering: approval/map save needs an exclusive floor
    # lock, so every referenced pointer stays current until this save commits.
    floors = {row.id: row for row in db.scalars(select(Floor).where(Floor.org_id == user.org_id,
        Floor.id.in_({p.floor_id for _, p in points})).order_by(Floor.id).with_for_update(read=True))}
    if len(floors) != len({p.floor_id for _, p in points}):
        fail(404, 'NOT_FOUND', '층을 찾을 수 없습니다.')
    for element, point in points:
        if floors[point.floor_id].approved_version_id != point.map_version_id:
            fail(409, 'STALE', '지도가 바뀌었습니다. 지금 승인 판에서 다시 저장하세요.', {'elements': [element],
                'approved_version_id': str(floors[point.floor_id].approved_version_id) if floors[point.floor_id].approved_version_id else None})
    versions = {row.id: row for row in db.scalars(select(MapVersion).where(MapVersion.org_id == user.org_id,
        MapVersion.id.in_({p.map_version_id for _, p in points})))}
    features = {identifier: bounded_features(row, fail) for identifier, row in versions.items()}
    # Share-lock mission parents in a stable order; archiving cannot race a new
    # reference. Historical scenario reads never revalidate archived missions.
    missions = {row.id: row for row in db.scalars(select(Mission).where(Mission.org_id == user.org_id,
        Mission.id.in_({p.mission_id for p in body.waypoints})).order_by(Mission.id).with_for_update(read=True))}
    mission_versions = {(row.mission_id, row.number): row for row in db.scalars(select(MissionVersion).where(
        MissionVersion.org_id == user.org_id, tuple_(MissionVersion.mission_id, MissionVersion.number).in_(
            {(p.mission_id, p.mission_version) for p in body.waypoints})))}
    required = set()
    for i, point in enumerate(body.waypoints):
        mission = missions.get(point.mission_id)
        version = mission_versions.get((point.mission_id, point.mission_version))
        if mission is None or mission.archived_at is not None or version is None:
            fail(422, 'PRECHECK_FAILED', '사용할 수 있는 임무 판을 선택하세요.', {'elements': [f'waypoints.{i}.mission_version']})
        required.update(version.required_devices)
    results = []
    for element, point in points:
        version = versions[point.map_version_id]
        reasons = []
        if not within_map(point.x, point.y, (version.origin_x, version.origin_y, version.origin_yaw),
                          version.width * version.resolution, version.height * version.resolution):
            reasons.append('지도 범위 밖입니다.')
        if any(zone['type'] == 'NO_GO' and inside_polygon(point.x, point.y, zone['polygon']) for zone in features[version.id]['zones']):
            reasons.append('진입 금지 구역 안입니다.')
        if point.waypoint_ref is not None:
            waypoint = next((w for w in features[version.id]['waypoints'] if w['id'] == point.waypoint_ref), None)
            if waypoint is None:
                reasons.append('지도 판의 지점 ID와 일치하지 않습니다.')
            elif math.hypot(point.x - waypoint['x'], point.y - waypoint['y']) > 0.05 + 1e-12:
                reasons.append('참조 지점 좌표에서 0.05 m 넘게 벗어났습니다.')
        results.append(C.PreviewPoint(element=element, reachable=not reasons, reasons=reasons))
    routes = list(zip(points, points[1:]))
    if body.finish.mode == 'RETURN_TO_START':
        routes.append((points[-1], points[0]))
    connectors = list(db.scalars(select(FloorConnector).where(FloorConnector.org_id == user.org_id,
        FloorConnector.active.is_(True), FloorConnector.floor_a_id.in_(floors), FloorConnector.floor_b_id.in_(floors))))
    # Each endpoint's geometry is checked once, regardless of repeated routes.
    connections = {}
    for connector in connectors:
        if (connector.map_version_a_id != floors[connector.floor_a_id].approved_version_id
                or connector.map_version_b_id != floors[connector.floor_b_id].approved_version_id):
            continue
        pair = [C.ScenarioPoint(floor_id=floor_id, map_version_id=version_id, **pose)
            for floor_id, version_id, pose in (
                (connector.floor_a_id, connector.map_version_a_id, connector.a_pose),
                (connector.floor_b_id, connector.map_version_b_id, connector.b_pose))]
        if any(any(z['type'] == 'NO_GO' and inside_polygon(p.x, p.y, z['polygon'])
                   for z in features[p.map_version_id]['zones']) for p in pair):
            continue
        for endpoints in (pair, pair[::-1]):
            a, b = endpoints
            key = (a.floor_id, b.floor_id, a.map_version_id, b.map_version_id)
            connections.setdefault(key, []).append((connector.id, endpoints))
    segments, distance = [], 0.0
    result_by_element = {r.element: r for r in results}
    def straight(a, b):
        return math.hypot(a.x - b.x, a.y - b.y)
    for (start, a), (end, b) in routes:
        via, connector_id, reason, length = [], None, None, None
        if not result_by_element[start].reachable or not result_by_element[end].reachable:
            reason = '갈 수 없는 지점이 포함되어 있습니다.'
        elif a.floor_id == b.floor_id:
            length = straight(a, b)
        else:
            candidates = []
            for identifier, pair in connections.get((a.floor_id, b.floor_id, a.map_version_id, b.map_version_id), []):
                candidates.append((straight(a, pair[0]) + straight(pair[1], b), str(identifier), identifier, pair))
            if candidates:
                length, _, connector_id, via = min(candidates)
            else:
                reason = '두 층을 직접 잇는 연결점 짝이 없습니다.'
                result_by_element[end].reachable = False
                result_by_element[end].reasons.append(reason)
        # ponytail: straight segments plus direct connector approach/departure
        # only, not Nav2; floor transition distance is unknown (zero estimate).
        if length is not None:
            distance += length
        segments.append(C.PreviewSegment(start=start, end=end, reachable=reason is None, reason=reason,
            connector_id=connector_id, distance_m=length, via=via))
    return C.ScenarioPreview(reachable=all(p.reachable for p in results) and all(s.reachable for s in segments),
        points=results, segments=segments, est_distance_m=distance,
        floor_ids=sorted(floors, key=str), map_version_ids=sorted(versions, key=str), required_devices=sorted(required))


def install(app, DB, Identity, fail, authorize, event, page):
    def own(db, user, model, identifier, *, lock=False):
        query = select(model).where(model.org_id == user.org_id, model.id == identifier)
        row = db.scalar(query.with_for_update() if lock else query)
        if row is None:
            fail(404, 'NOT_FOUND', '임무 또는 시나리오를 찾을 수 없습니다.')
        return row

    def editable(row, user):
        if user.role != 'ORG_ADMIN' and row.created_by != user.id:
            fail(403, 'FORBIDDEN', '만든 사람 또는 총괄만 변경할 수 있습니다.')
        if row.archived_at is not None:
            fail(409, 'VERSION_CONFLICT', '보관된 항목은 변경할 수 없습니다.', {'version': row.version})

    def check_match(row, match):
        if match is None:
            fail(428, 'PRECONDITION_REQUIRED', 'If-Match에 현재 판을 지정하세요.')
        if match != f'"{row.version}"':
            fail(409, 'VERSION_CONFLICT', '다른 사람이 새 판을 저장했습니다. 최신 판을 확인하세요.', {'version': row.version})

    def result(db, row, number=None):
        is_mission = isinstance(row, Mission)
        model = MissionVersion if is_mission else ScenarioVersion
        parent = model.mission_id if is_mission else model.scenario_id
        snapshot = db.scalar(select(model).where(model.org_id == row.org_id, parent == row.id,
            model.number == (number if number is not None else row.latest_version)))
        if snapshot is None:
            fail(404, 'NOT_FOUND', '판을 찾을 수 없습니다.')
        return serialize(row, snapshot)

    def serialize(row, snapshot):
        common = dict(id=row.id, name=snapshot.name, number=snapshot.number, latest_version=row.latest_version,
            version=row.version, required_devices=snapshot.required_devices, created_by=row.created_by,
            created_at=row.created_at, version_created_by=snapshot.created_by,
            version_created_at=snapshot.created_at, archived_at=row.archived_at)
        if isinstance(row, Mission):
            return C.Mission(**common, steps=snapshot.steps)
        return C.Scenario(**common, waypoints=snapshot.waypoints, finish=snapshot.finish, notes=snapshot.notes,
            floor_ids=snapshot.floor_ids, map_version_ids=snapshot.map_version_ids, est_distance_m=snapshot.est_distance_m)

    def batch(db, rows):
        if not rows:
            return []
        model = MissionVersion if isinstance(rows[0], Mission) else ScenarioVersion
        parent = model.mission_id if model is MissionVersion else model.scenario_id
        parents = {row.id: row for row in rows}
        # Join the latest pointer instead of loading every historical version.
        owner = Mission if model is MissionVersion else Scenario
        snapshots = {getattr(s, 'mission_id' if model is MissionVersion else 'scenario_id'): s
            for s in db.scalars(select(model).join(owner, (parent == owner.id) & (model.org_id == owner.org_id) &
                (model.number == owner.latest_version)).where(owner.org_id == rows[0].org_id, owner.id.in_(parents)))}
        return [serialize(row, snapshots[row.id]) for row in rows]

    def save(db, user, body, model, row=None):
        is_mission = model is Mission
        if is_mission:
            values = dict(steps=[s.model_dump() for s in body.steps],
                required_devices=sorted({d for step in body.steps for d in requirements(step)}))
        else:
            checked = preview(db, user, body, fail)
            if not checked.reachable:
                fail(422, 'PRECHECK_FAILED', '갈 수 없는 지점이 있습니다.', {
                    'elements': [p.element for p in checked.points if not p.reachable],
                    'preview': checked.model_dump(mode='json')})
            values = dict(waypoints=[p.model_dump(mode='json') for p in body.waypoints], finish=body.finish.model_dump(mode='json'),
                notes=body.notes, floor_ids=checked.floor_ids, map_version_ids=checked.map_version_ids,
                required_devices=checked.required_devices, est_distance_m=checked.est_distance_m)
        created = row is None
        if created:
            row = model(org_id=user.org_id, name=body.name, created_by=user.id, version=1, latest_version=1)
            db.add(row)
            db.flush()
        else:
            row.name, row.version, row.latest_version = body.name, row.version + 1, row.latest_version + 1
        snapshot_model = MissionVersion if is_mission else ScenarioVersion
        snapshot = snapshot_model(org_id=user.org_id, name=body.name, number=row.latest_version, created_by=user.id,
            **{'mission_id' if is_mission else 'scenario_id': row.id}, **values)
        db.add(snapshot)
        code = ('MISSION_CREATED' if created else 'MISSION_VERSION_CREATED') if is_mission else ('SCENARIO_CREATED' if created else 'SCENARIO_VERSION_CREATED')
        event(db, user.org_id, code, user.id, {'id': str(row.id), 'name': body.name, 'number': row.latest_version})
        db.flush()
        return serialize(row, snapshot)

    def archive(db, user, model, identifier):
        row = own(db, user, model, identifier, lock=True)
        if user.role != 'ORG_ADMIN' and row.created_by != user.id:
            fail(403, 'FORBIDDEN', '만든 사람 또는 총괄만 보관할 수 있습니다.')
        if row.archived_at is None:
            row.archived_at, row.version = now(), row.version + 1
            event(db, user.org_id, 'MISSION_ARCHIVED' if model is Mission else 'SCENARIO_ARCHIVED', user.id,
                {'id': str(row.id), 'name': row.name, 'number': row.latest_version})

    def tagged(response, value):
        response.headers['ETag'] = f'"{value.version}"'
        return value

    @app.get('/api/v1/actions', response_model=list[C.Action])
    def actions(auth: Identity, db: DB, robot_id: UUID | None = None):
        devices = None
        if robot_id is not None:
            robot = db.scalar(select(Robot).where(Robot.id == robot_id, Robot.org_id == auth[0].org_id, Robot.archived_at.is_(None)))
            if robot is None:
                fail(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.')
            authorize(auth[0], 'ROBOT_READ', robot)
            devices = reported_devices(app.state.realtime, str(robot.id))
            if devices is None:
                devices = [dict(kind=d.kind, state=d.state) for d in db.scalars(select(RobotDevice).where(
                    RobotDevice.org_id == auth[0].org_id, RobotDevice.robot_id == robot.id))]
                if not devices and robot.last_seen_at is None:
                    devices = None
        def unavailable(required):
            reason = None
            if robot_id is not None:
                if devices is None:
                    reason = '장치 정보를 아직 받지 못했습니다'
                elif any(not any(d['kind'] == kind and d['state'] == 'OK' for d in devices) for kind in required):
                    reason = '필요한 장치가 없거나 정상 상태가 아닙니다: ' + ', '.join(required)
            return reason
        items = []
        for key, label in LABELS.items():
            step = C.MissionStep(action=key)
            options = []
            parameter = {'PHOTO': 'camera', 'SENSOR_LOG': 'device'}.get(key)
            if parameter is not None:
                for value in get_args(C.ACTION_PARAMS[key].model_fields[parameter].annotation):
                    required = requirements(C.MissionStep(action=key, params={parameter: value}))
                    reason = unavailable(required)
                    options.append(C.ActionOption(param=parameter, value=value, requires=required,
                        available=reason is None, why_unavailable=reason))
                # Only unconditional requirements belong on the action itself.
                required = sorted(set.intersection(*(set(o.requires) for o in options)))
                reason = None if any(o.available for o in options) else options[0].why_unavailable
            else:
                required = requirements(step)
                reason = unavailable(required)
            items.append(C.Action(key=key, label=label, params=step.params, requires=required,
                available=reason is None, why_unavailable=reason, options=options))
        return items

    @app.get('/api/v1/missions', response_model=C.MissionList)
    def missions(auth: Identity, db: DB, archived: bool = False,
                 limit: Annotated[int, Query(ge=1, le=100)] = 50, cursor: str | None = None):
        query = select(Mission).where(Mission.org_id == auth[0].org_id)
        if not archived:
            query = query.where(Mission.archived_at.is_(None))
        return page(db, query, Mission, limit, cursor, None, serialize_many=batch)

    @app.post('/api/v1/missions', response_model=C.Mission, status_code=201)
    def create_mission(body: C.MissionWrite, auth: Identity, db: DB, response: Response):
        authorize(auth[0], 'O')
        return tagged(response, save(db, auth[0], body, Mission))

    @app.get('/api/v1/missions/{identifier}', response_model=C.Mission)
    def mission(identifier: UUID, auth: Identity, db: DB, response: Response, version: Annotated[int | None, Query(ge=1)] = None):
        value = result(db, own(db, auth[0], Mission, identifier), version)
        return tagged(response, value) if version is None else value

    @app.put('/api/v1/missions/{identifier}', response_model=C.Mission)
    def update_mission(identifier: UUID, body: C.MissionWrite, auth: Identity, db: DB, response: Response,
                       if_match: Annotated[str | None, Header()] = None):
        row = own(db, auth[0], Mission, identifier, lock=True)
        editable(row, auth[0])
        check_match(row, if_match)
        return tagged(response, save(db, auth[0], body, Mission, row))

    @app.delete('/api/v1/missions/{identifier}', status_code=204)
    def delete_mission(identifier: UUID, auth: Identity, db: DB):
        archive(db, auth[0], Mission, identifier)

    @app.post('/api/v1/scenarios/preview', response_model=C.ScenarioPreview)
    def scenario_preview(body: C.ScenarioWrite, auth: Identity, db: DB):
        return preview(db, auth[0], body, fail)

    @app.get('/api/v1/scenarios', response_model=C.ScenarioList)
    def scenarios(auth: Identity, db: DB, mine: bool = False, floor_id: UUID | None = None, archived: bool = False,
                  limit: Annotated[int, Query(ge=1, le=100)] = 50, cursor: str | None = None):
        query = select(Scenario).where(Scenario.org_id == auth[0].org_id)
        if not archived:
            query = query.where(Scenario.archived_at.is_(None))
        if mine:
            query = query.where(Scenario.created_by == auth[0].id)
        if floor_id is not None:
            if db.scalar(select(Floor.id).where(Floor.org_id == auth[0].org_id, Floor.id == floor_id)) is None:
                fail(404, 'NOT_FOUND', '층을 찾을 수 없습니다.')
            query = query.join(ScenarioVersion, (ScenarioVersion.scenario_id == Scenario.id) & (ScenarioVersion.number == Scenario.latest_version)).where(floor_id == any_(ScenarioVersion.floor_ids))
        return page(db, query, Scenario, limit, cursor, None, serialize_many=batch)

    @app.post('/api/v1/scenarios', response_model=C.Scenario, status_code=201)
    def create_scenario(body: C.ScenarioWrite, auth: Identity, db: DB, response: Response):
        authorize(auth[0], 'O')
        return tagged(response, save(db, auth[0], body, Scenario))

    @app.get('/api/v1/scenarios/{identifier}', response_model=C.Scenario)
    def scenario(identifier: UUID, auth: Identity, db: DB, response: Response, version: Annotated[int | None, Query(ge=1)] = None):
        value = result(db, own(db, auth[0], Scenario, identifier), version)
        return tagged(response, value) if version is None else value

    @app.put('/api/v1/scenarios/{identifier}', response_model=C.Scenario)
    def update_scenario(identifier: UUID, body: C.ScenarioWrite, auth: Identity, db: DB, response: Response,
                        if_match: Annotated[str | None, Header()] = None):
        row = own(db, auth[0], Scenario, identifier, lock=True)
        editable(row, auth[0])
        check_match(row, if_match)
        return tagged(response, save(db, auth[0], body, Scenario, row))

    @app.delete('/api/v1/scenarios/{identifier}', status_code=204)
    def delete_scenario(identifier: UUID, auth: Identity, db: DB):
        archive(db, auth[0], Scenario, identifier)

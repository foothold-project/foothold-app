"""Explicit immutable annotation updates; no writes from reads or previews."""
import copy
from types import SimpleNamespace
from uuid import UUID

from sqlalchemy import select

from apps.contracts import models as C
from .models import Floor, MapVersion, Scenario, ScenarioVersion, Upload
from .voxel_links import same_annotation_raster
from .zones import inside_polygon, scenario_geometry


def same_raster(db, before, after):
    if before is None or after is None:
        return False
    image = db.get(Upload, after.upload_id)
    if image is None:
        return False
    if same_annotation_raster(after, before, image):
        return True
    # #333 creates a new immutable SIMULATION Upload for each annotation clone.
    # Accept only that recorded clone of the identical terrain revision, after
    # checking the HUMAN source with the very same shared raster predicate.
    if (before.provenance != 'SIMULATION' or after.provenance != 'SIMULATION'
            or after.copied_from_id is None
            or after.copied_from_id not in (before.id, before.copied_from_id)):
        return False
    prior_image = db.get(Upload, before.upload_id)
    if prior_image is None or prior_image.org_id != image.org_id:
        return False
    a, b = copy.deepcopy(prior_image.metadata_json), copy.deepcopy(image.metadata_json)
    pa, pb = a.get('voxel_twin'), b.get('voxel_twin')
    if not pa or not pb:
        return False
    source_a, source_b = db.get(MapVersion, UUID(pa['map_version_id'])), db.get(MapVersion, UUID(pb['map_version_id']))
    if source_a is None or source_b is None or source_b.org_id != after.org_id:
        return False
    if not same_annotation_raster(source_b, source_a, db.get(Upload, source_b.upload_id)):
        return False
    pa.pop('map_version_id')
    pb.pop('map_version_id')
    # Reuse every geometry/provenance/edit check, allowing only the server clone's
    # Upload id after the immutable metadata/file identity has been checked.
    proxy = SimpleNamespace(**{k: v for k, v in vars(before).items() if not k.startswith('_')})
    proxy.upload_id = after.upload_id
    return (a == b and prior_image.image_path == image.image_path
        and prior_image.image_sha256 == image.image_sha256
        and prior_image.png_sha256 == image.png_sha256
        and same_annotation_raster(after, proxy, image))


def map_update(db, snapshot, *, lock=False):
    query = select(Floor).where(Floor.org_id == snapshot.org_id,
        Floor.id.in_(snapshot.floor_ids)).order_by(Floor.id)
    floors = list(db.scalars(query.with_for_update(read=True) if lock else query))
    by_floor = {str(f.id): f for f in floors}
    versions = {v.id: v for v in db.scalars(select(MapVersion).where(MapVersion.org_id == snapshot.org_id,
        MapVersion.id.in_(set(snapshot.map_version_ids) | {f.approved_version_id for f in floors if f.approved_version_id})))}
    targets = {str(f.id): versions.get(f.approved_version_id) for f in floors}
    reasons = []
    def reason(element, message):
        value = C.MapUpdateReason(element=element, reason=message)
        if value not in reasons:
            reasons.append(value)
    if len(floors) != len(set(snapshot.floor_ids)) or any(f.archived_at is not None for f in floors):
        reason('floor_ids', '휴지통의 층 또는 없는 층을 사용합니다.')
    for source_id in snapshot.map_version_ids:
        source = versions.get(source_id)
        floor = by_floor.get(str(source.floor_id)) if source else None
        target = targets.get(str(source.floor_id)) if source else None
        if source is None or floor is None or target is None:
            reason('map_version_ids', '최신 승인 지도를 찾을 수 없습니다.')
        elif source.id != target.id and not same_raster(db, source, target):
            reason('map_version_ids', '지도 그림·출처·격자 또는 벽 편집이 바뀌어 시나리오 수정이 필요합니다.')
    replacement_features = {key: v.features for key, v in targets.items() if v is not None}
    # Identify the route's fixed connector endpoints using the old snapshots;
    # moving/removing a connector requires a human to inspect that route.
    points, _ = scenario_geometry(db, snapshot)
    for element, point in points:
        target = targets.get(str(point['floor_id']))
        if target is None:
            continue
        for zone in target.features['zones']:
            if zone['type'] == 'NO_GO' and inside_polygon(point['x'], point['y'], zone['polygon']):
                reason(element, '접근 금지 구역 안입니다. (구역: ' + zone['name'] + ')')
        if point.get('waypoint_ref') is not None:
            ref = next((p for p in target.features['waypoints'] if p['id'] == point['waypoint_ref']), None)
            if ref is None or ((point['x'] - ref['x']) ** 2 + (point['y'] - ref['y']) ** 2) ** .5 > .05 + 1e-12:
                reason(element, '참조 지점이 없어졌거나 좌표가 바뀌었습니다.')
        if '.via.' in element:
            connector = next((p for p in target.features['connectors'] if p['id'] == point['id']), None)
            if connector is None or any(connector[k] != point[k] for k in ('x', 'y', 'yaw', 'kind', 'pair_floor_id')):
                reason(element, '연결점이 없어졌거나 바뀌었습니다.')
    # A newly selected direct connector must also obey NO_GO. Segment crossings
    # intentionally do not require editing: the browser planner takes a detour.
    new_points, _ = scenario_geometry(db, snapshot, replacement_features)
    for element, point in new_points:
        target = targets.get(str(point['floor_id']))
        if '.via.' in element and target and any(z['type'] == 'NO_GO' and inside_polygon(point['x'], point['y'], z['polygon']) for z in target.features['zones']):
            reason(element, '연결점이 접근 금지 구역 안입니다.')
    ids = sorted({v.id for v in targets.values() if v is not None}, key=str)
    changed = set(ids) != set(snapshot.map_version_ids)
    return C.ScenarioMapUpdate(status='NEEDS_EDIT' if reasons else 'AUTO_APPLICABLE' if changed else 'CURRENT',
        reasons=reasons, map_version_ids=ids), targets


def effective_version(db, snapshot, parent=None):
    """Only an unbroken automatic ancestry can carry an old assignment forward.

    Original assignment, approval preview and run snapshot references never move.
    A manual scenario save breaks this chain and retains the prior rules.
    """
    if snapshot is None:
        return None
    parent = parent or db.get(Scenario, snapshot.scenario_id)
    if parent is None or parent.org_id != snapshot.org_id or parent.archived_at is not None:
        return snapshot
    current = db.scalar(select(ScenarioVersion).where(ScenarioVersion.org_id == snapshot.org_id,
        ScenarioVersion.scenario_id == snapshot.scenario_id, ScenarioVersion.number == parent.latest_version))
    candidate = current
    while candidate is not None and candidate.number > snapshot.number and candidate.auto_map_from_number is not None:
        if candidate.auto_map_from_number == snapshot.number:
            return current
        candidate = db.scalar(select(ScenarioVersion).where(ScenarioVersion.org_id == snapshot.org_id,
            ScenarioVersion.scenario_id == snapshot.scenario_id, ScenarioVersion.number == candidate.auto_map_from_number))
    return snapshot


def apply_latest(db, user, parent, fail, event):
    # Caller holds Scenario exclusively, then shared sorted Floor locks. Never
    # acquire Assignment or Approval locks here (their order precedes Scenario).
    snapshot = db.scalar(select(ScenarioVersion).where(ScenarioVersion.org_id == parent.org_id,
        ScenarioVersion.scenario_id == parent.id, ScenarioVersion.number == parent.latest_version))
    update, targets = map_update(db, snapshot, lock=True)
    if update.status == 'NEEDS_EDIT':
        fail(409, 'MAP_UPDATE_REQUIRED', '시나리오 수정이 필요합니다.', {'map_update': update.model_dump(mode='json')})
    if update.status == 'CURRENT':
        return snapshot
    def translate(point):
        return {**point, 'map_version_id': str(targets[str(point['floor_id'])].id)}
    finish = copy.deepcopy(snapshot.finish)
    if finish.get('target') is not None:
        finish['target'] = translate(finish['target'])
    parent.version += 1
    parent.latest_version += 1
    clone = ScenarioVersion(org_id=parent.org_id, scenario_id=parent.id, number=parent.latest_version,
        name=snapshot.name, waypoints=[translate(p) for p in snapshot.waypoints], finish=finish,
        notes=snapshot.notes, floor_ids=list(snapshot.floor_ids), map_version_ids=list(update.map_version_ids),
        required_devices=list(snapshot.required_devices), est_distance_m=snapshot.est_distance_m,
        created_by=user.id, auto_map_from_number=snapshot.number)
    db.add(clone)
    db.flush()
    event(db, user.org_id, 'SCENARIO_VERSION_CREATED', user.id, {'id': str(parent.id), 'name': parent.name,
        'number': clone.number, 'reason': '지도 구역 변경으로 자동 갱신', 'auto_map_from_number': snapshot.number,
        'assignment_policy': 'preserve_original_reference_follow_auto_lineage',
        'map_version_ids': [str(identifier) for identifier in clone.map_version_ids]})
    return clone


def require_current_start(db, snapshot, fail):
    update, _ = map_update(db, snapshot, lock=True)
    if update.status != 'CURRENT':
        fail(409, 'MAP_UPDATE_REQUIRED', '시나리오 수정이 필요합니다.' if update.status == 'NEEDS_EDIT'
            else '최신 지도 적용을 먼저 확정한 뒤 새 시나리오 판으로 시작하세요.',
            {'map_update': update.model_dump(mode='json')})

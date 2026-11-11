"""Synthetic-only zone contract, read APIs, immutable updates and start gates."""
import copy
import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from fastapi.testclient import TestClient
from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import User
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server import runs
from apps.server.fh_server.models import Approval, Assignment, Event, Floor, MapVersion, Robot, ScenarioVersion
from apps.server.fh_server.zones import rasterize
from .legacy_approvals import pending_assignment
from .test_assignments import assignment, scenario
from .test_maps import FEATURES, P, auth, maps, save, tree, upload
from .test_missions import setup_scenario
from .test_voxel_maps import post as import_voxels


@contextmanager
def foreign_api(seeded):
    engine = create_engine(seeded['urls']['app'])
    with Session(engine) as db:
        org_id = db.get(User, seeded['users']['foreign']).org_id
    engine.dispose()
    app = create_app(Settings(seeded['urls']['app'], org_id))
    with TestClient(app, base_url='https://testserver') as http:
        yield http, auth(http, 'foreign')
    app.state.engine.dispose()


def zone(kind='NO_GO', polygon=None, speed=None, identifier='zone'):
    result = dict(id=identifier, type=kind, name=identifier,
        polygon=polygon or [[.7, .0], [.9, .0], [.9, .4], [.7, .4]])
    if speed is not None:
        result['max_speed_mps'] = speed
    return result


def changed_map(http, headers, floor, image, previous, zones=None, **extra):
    features = copy.deepcopy(previous['features'])
    features['zones'] = zones or [zone()]
    response = save(http, headers, floor, image, base=previous['id'], features=features, **extra)
    assert response.status_code == 201, response.text
    return response.json()


def apply(http, headers, value):
    return http.post(P + '/scenarios/' + value['id'] + '/apply-latest-map', headers=headers)


@pytest.mark.parametrize('value', [.3, .7, 1.5, None])
def test_slow_speed_contract_and_legacy(value):
    raw = zone('SLOW')
    raw['max_speed_mps'] = value
    parsed = C.MapZone.model_validate(raw)
    assert parsed.max_speed_mps == value
    assert C.MapZone.model_validate(zone('SLOW')).model_dump(mode='json', exclude_none=True) == zone('SLOW')
    assert 'max_speed_mps' not in C.MapZone.model_validate(zone()).model_dump()


@pytest.mark.parametrize('value', [.29, 1.51, float('nan'), float('inf'), '0.3', True])
def test_speed_outside_existing_range_rejected(value):
    with pytest.raises(ValidationError):
        C.MapZone.model_validate({**zone('SLOW'), 'max_speed_mps': value})


@pytest.mark.parametrize('value', [.3, None])
def test_no_go_cannot_have_speed_key_even_null(value):
    with pytest.raises(ValidationError):
        C.MapZone.model_validate({**zone(), 'max_speed_mps': value})


def test_shared_grid_golden_fixtures():
    fixture = json.loads(Path(__file__).with_name('fixtures').joinpath('zone-grid-v1.json').read_text())
    assert fixture['format_version'] == 1 and fixture['row_order'] == 'TOP_TO_BOTTOM'
    for case in fixture['cases']:
        assert rasterize(case['origin'], case['resolution'], case['width'], case['height'], case['zones']) == case['cells'], case['name']


def test_grid_pagination_permissions_and_missing_speed(maps, seeded):
    http, admin, _ = maps
    _, _, floor = tree(http, admin)
    image = upload(http, admin)
    features = copy.deepcopy(FEATURES)
    features['zones'] = [zone('SLOW', [[.1, .1], [.9, .1], [.9, .9], [.1, .9]])]
    first = save(http, admin, floor, image, features=features).json()
    path = P + f'/map-versions/{first["id"]}/zone-grid'
    assert http.get(path).status_code == 401
    operator = auth(http, 'one')
    response = http.get(path, headers=operator, params={'limit': 2})
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['format_version'] == 1 and value['origin'] == [0, 0, 0] and value['resolution'] == .5
    assert value['row_order'] == 'TOP_TO_BOTTOM' and value['width'] == value['height'] == 4
    assert value['cursor'] == 0 and value['next_cursor'] == 2
    assert value['cells'] == [dict(index=i, no_go=False, slow=True, max_speed_mps=None) for i in [8, 9]]
    assert http.get(path, headers=operator, params={'cursor': 2}).json()['cells'] == [dict(index=i, no_go=False, slow=True, max_speed_mps=None) for i in [12, 13]]
    assert http.get(path, headers=operator, params={'cursor': 10}).json()['next_cursor'] is None
    for params in ({'cursor': -1}, {'limit': 0}, {'limit': 20001}):
        assert http.get(path, headers=operator, params=params).status_code == 400
    with foreign_api(seeded) as (foreign, headers):
        assert foreign.get(path, headers=headers).status_code == 404
    assert http.get(P + f'/map-versions/{uuid4()}/zone-grid', headers=operator).status_code == 404


def test_draft_overlap_points_segments_finish_and_no_save(maps, seeded):
    http, admin, _ = maps
    value, floor, image, previous = scenario(http, admin)
    body = {k: value[k] for k in ('name', 'waypoints', 'finish', 'notes')}
    body['waypoints'].append({**body['waypoints'][0], 'x': 1.5})
    body['finish'] = {'mode': 'RETURN_TO_START'}
    value = http.put(P + '/scenarios/' + value['id'], headers={**admin, 'If-Match': '"1"'}, json=body).json()
    features = {**copy.deepcopy(FEATURES), 'zones': [zone()]}
    path = P + f'/floors/{floor}/zone-overlaps'
    response = http.post(path, headers=auth(http, 'one'), json={'features': features})
    assert response.status_code == 200, response.text
    hits = response.json()['scenarios'][0]['hits']
    assert {h['kind'] for h in hits} == {'SEGMENT'}
    assert {h['element'] for h in hits} == {'waypoints.0->waypoints.1', 'waypoints.1->waypoints.0'}
    features['zones'] = [zone(polygon=[[.1, .1], [.3, .1], [.3, .3], [.1, .3]])]
    result = http.post(path, headers=admin, json={'features': features}).json()['scenarios'][0]
    assert result['scenario_id'] == value['id'] and result['scenario_name'] == value['name']
    assert any(h['kind'] == 'POINT' and h['element'] == 'waypoints.0' for h in result['hits'])
    assert http.get(P + '/map-versions/' + previous['id'], headers=admin).json()['features'] == previous['features']
    assert http.get(P + '/scenarios/' + value['id'], headers=admin).json()['number'] == 2
    # The same overlapping map is saved successfully: UI owns the decision.
    saved = save(http, admin, floor, image, base=previous['id'], features=features)
    assert saved.status_code == 201, saved.text
    with foreign_api(seeded) as (foreign, headers):
        assert foreign.post(path, headers=headers, json={'features': features}).status_code == 404


def test_connector_point_and_approach_overlap(maps):
    http, admin, _ = maps
    body, floors, versions, _ = setup_scenario(http, admin)
    value = http.post(P + '/scenarios', headers=admin, json=body).json()
    features = copy.deepcopy(versions[0]['features'])
    features['zones'] = [zone(polygon=[[.5, .5], [.6, .5], [.6, .6], [.5, .6]])]
    response = http.post(P + f'/floors/{floors[0]}/zone-overlaps', headers=admin, json={'features': features})
    assert response.status_code == 200, response.text
    hits = response.json()['scenarios'][0]['hits']
    assert any(h['kind'] == 'POINT' and '.via.0:stairs' in h['element'] for h in hits)
    assert any(h['kind'] == 'SEGMENT' and '.via.0:stairs' in h['element'] for h in hits)
    assert value['number'] == 1


def test_explicit_map_update_idempotency_manual_break_and_preserved_assignments(maps, seeded):
    http, admin, _ = maps
    value, floor, image, original = scenario(http, admin)
    active = assignment(http, admin, value, seeded['robots']['theirs']).json()
    pending = pending_assignment(http, auth(http, 'one'), value, seeded['robots']['mine'])
    newer = changed_map(http, admin, floor, image, original)
    early_decision = http.post(P + '/approvals/' + pending['approval_id'] + '/approve', headers=admin)
    assert early_decision.status_code == 409 and early_decision.json()['error']['code'] == 'MAP_UPDATE_REQUIRED'
    assert http.get(P + '/approvals/' + pending['approval_id'], headers=admin).json()['status'] == 'PENDING'
    before = http.get(P + '/scenarios/' + value['id'], headers=admin).json()
    assert before['number'] == 1 and before['map_update']['status'] == 'AUTO_APPLICABLE'
    assert before['map_update']['map_version_ids'] == [newer['id']]
    assert http.get(P + '/scenarios', headers=admin).json()['items'][0]['map_update']['status'] == 'AUTO_APPLICABLE'
    responses = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: apply(http, admin, value), range(2)))
    assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
    updated = responses[0].json()
    assert [r.json()['number'] for r in responses] == [2, 2]
    assert updated['map_update']['status'] == 'CURRENT' and updated['waypoints'][0]['map_version_id'] == newer['id']
    old = http.get(P + '/scenarios/' + value['id'] + '?version=1', headers=admin).json()
    assert old['waypoints'] == value['waypoints'] and old['map_version_ids'] == value['map_version_ids']
    listed = http.get(P + '/assignments', headers=admin).json()['items']
    assert {a['id'] for a in listed} == {active['id'], pending['id']}
    assert all(a['scenario_version'] == 1 and a['effective_scenario_version'] == 2 for a in listed)
    preview = http.get(P + '/approvals/' + pending['approval_id'], headers=admin).json()['preview']
    assert preview['scenario_version'] == 1 and preview['effective_scenario_version'] == 2
    duplicate = assignment(http, admin, updated, seeded['robots']['theirs'])
    assert duplicate.status_code == 409 and duplicate.json()['error']['code'] == 'ASSIGNMENT_EXISTS'
    decision = http.post(P + '/approvals/' + pending['approval_id'] + '/approve', headers=admin)
    assert decision.status_code == 200 and decision.json()['status'] == 'APPROVED', decision.text
    engine = create_engine(seeded['urls']['app'])
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(ScenarioVersion)) == 2
        assert db.get(Assignment, UUID(active['id'])).scenario_version_id == db.scalar(select(ScenarioVersion.id).where(ScenarioVersion.number == 1))
        event = db.scalar(select(Event).where(Event.code == 'SCENARIO_VERSION_CREATED'))
        assert event.data['reason'] == '지도 구역 변경으로 자동 갱신'
        assert '지도 구역 변경으로 자동 갱신' in event.message
        assert event.data['assignment_policy'] == 'preserve_original_reference_follow_auto_lineage'
        decision_event = db.scalar(select(Event).where(Event.code == 'APPROVAL_DECIDED'))
        assert decision_event.data['number'] == 1 and decision_event.data['effective_scenario_version'] == 2
    engine.dispose()
    manual_body = {k: updated[k] for k in ('name', 'waypoints', 'finish', 'notes')}
    manual_body['notes'] = '사람의 수정'
    manual = http.put(P + '/scenarios/' + value['id'], headers={**admin, 'If-Match': responses[0].headers['etag']}, json=manual_body)
    assert manual.status_code == 200, manual.text
    assert all('effective_scenario_version' not in a for a in http.get(P + '/assignments', headers=admin).json()['items'])


def test_blocked_points_stale_starts_and_no_side_effect_from_reads(maps, seeded):
    http, admin, _ = maps
    value, floor, image, original = scenario(http, admin)
    newer = changed_map(http, admin, floor, image, original,
        zones=[zone(polygon=[[.1, .1], [.3, .1], [.3, .3], [.1, .3]])])
    current = http.get(P + '/scenarios/' + value['id'], headers=admin).json()
    assert current['map_update']['status'] == 'NEEDS_EDIT'
    assert current['map_update']['reasons'][0]['element'] == 'waypoints.0'
    failed = apply(http, admin, value)
    assert failed.status_code == 409 and failed.json()['error']['code'] == 'MAP_UPDATE_REQUIRED'
    assert failed.json()['error']['detail']['map_update']['status'] == 'NEEDS_EDIT'
    class Rejected(Exception): pass
    def reject(status, code, message, detail=None): raise Rejected(code, detail)
    engine = create_engine(seeded['urls']['app'])
    with Session(engine) as db:
        robot = SimpleNamespace(org_id=seeded['org'], simulation=True, sim_world_id='synthetic')
        with pytest.raises(Rejected) as error:
            runs.fixed_scenario(db, robot, UUID(value['id']), 1, reject)
        assert error.value.args[0] == 'MAP_UPDATE_REQUIRED'
        assert db.scalar(select(func.count()).select_from(ScenarioVersion)) == 1
        # The real execution gate still fails closed ahead of any new check.
        robot.simulation = False
        with pytest.raises(Rejected) as real:
            runs.fixed_scenario(db, robot, UUID(value['id']), 1, reject)
        assert real.value.args[0] == 'PRECHECK_FAILED'
    engine.dispose()
    assert http.get(P + '/map-versions/' + newer['id'], headers=admin).json()['features']['zones']


def test_only_segment_crossing_can_follow_and_changed_upload_cannot(maps):
    http, admin, _ = maps
    value, floor, image, original = scenario(http, admin)
    body = {k: value[k] for k in ('name', 'waypoints', 'finish', 'notes')}
    body['waypoints'].append({**body['waypoints'][0], 'x': 1.5})
    value = http.put(P + '/scenarios/' + value['id'], headers={**admin, 'If-Match': '"1"'}, json=body).json()
    newer = changed_map(http, admin, floor, image, original)
    response = apply(http, admin, value)
    assert response.status_code == 200 and response.json()['number'] == 3, response.text
    # Identical bytes under a different Upload do not satisfy #333 identity.
    different_upload = upload(http, admin)
    changed_map(http, admin, floor, different_upload, newer)
    failed = apply(http, admin, value)
    assert failed.status_code == 409 and '그림' in failed.json()['error']['detail']['map_update']['reasons'][0]['reason']


def test_voxel_twin_grid_and_exact_resolution_link(maps, seeded):
    http, admin, _ = maps
    imported = import_voxels(http, admin)
    assert imported.status_code == 201, imported.text
    original = imported.json()['map']
    floor = original['floor_id']
    newer = changed_map(http, admin, floor, original['upload_id'], original,
        zones=[zone('SLOW', [[.11, .11], [.19, .11], [.19, .19], [.11, .19]], .4)])
    operator = auth(http, 'one')
    path = P + '/map-versions/' + newer['id']
    link = http.get(path + '/simulation-twin', headers=operator)
    assert link.status_code == 200, link.text
    twin_id = link.json()['simulation_map_version_id']
    human = http.get(path + '/zone-grid', headers=operator).json()
    twin = http.get(P + '/map-versions/' + twin_id + '/zone-grid', headers=operator).json()
    assert human['resolution'] == .1 and twin['resolution'] == .05
    assert human['origin'] == twin['origin'] and twin['width'] == human['width'] * 2
    assert len(human['cells']) == 1 and len(twin['cells']) == 4
    assert all(c['slow'] and c['max_speed_mps'] == .4 for c in twin['cells'])
    old_link = http.get(P + '/map-versions/' + original['id'] + '/simulation-twin', headers=operator).json()
    assert old_link['simulation_map_version_id'] != twin_id
    assert http.get(P + '/map-versions/' + old_link['simulation_map_version_id'] + '/zone-grid', headers=operator).json()['cells'] == []
    with foreign_api(seeded) as (foreign, headers):
        assert foreign.get(path + '/simulation-twin', headers=headers).status_code == 404


def test_chained_auto_updates_preserve_pending_but_manual_save_breaks_it(maps, seeded):
    http, admin, _ = maps
    value, floor, image, original = scenario(http, admin)
    pending = pending_assignment(http, auth(http, 'one'), value, seeded['robots']['mine'])
    first = changed_map(http, admin, floor, image, original)
    assert apply(http, admin, value).json()['number'] == 2
    second = changed_map(http, admin, floor, image, first, zones=[zone('SLOW', speed=.5)])
    updated = apply(http, admin, value).json()
    assert updated['number'] == 3
    listed = http.get(P + '/assignments', headers=admin).json()['items'][0]
    assert listed['scenario_version'] == 1 and listed['effective_scenario_version'] == 3
    manual_body = {k: updated[k] for k in ('name', 'waypoints', 'finish', 'notes')}
    manual_body['notes'] = '수동 수정 뒤 기존 승인 규칙 적용'
    assert http.put(P + '/scenarios/' + value['id'], headers={**admin, 'If-Match': '"3"'}, json=manual_body).status_code == 200
    decision = http.post(P + '/approvals/' + pending['approval_id'] + '/approve', headers=admin)
    assert decision.status_code == 409 and decision.json()['error']['code'] == 'APPROVAL_STALE'
    assert second['id'] != original['id']


def test_connector_in_latest_no_go_requires_edit_and_wall_edit_rejected(maps):
    http, admin, _ = maps
    body, floors, versions, image = setup_scenario(http, admin)
    value = http.post(P + '/scenarios', headers=admin, json=body).json()
    current = changed_map(http, admin, floors[0], image, versions[0],
        zones=[zone(polygon=[[.5, .5], [.6, .5], [.6, .6], [.5, .6]])])
    result = apply(http, admin, value)
    assert result.status_code == 409, result.text
    assert any('.via.' in r['element'] and '접근 금지' in r['reason'] for r in result.json()['error']['detail']['map_update']['reasons'])
    features = copy.deepcopy(current['features'])
    features['zones'] = []
    features['edits'] = [dict(op='WALL', polyline=[[.2, .2], [.4, .2]], width=.1)]
    assert save(http, admin, floors[0], image, base=current['id'], features=features).status_code == 201
    result = apply(http, admin, value)
    assert result.status_code == 409 and any('벽 편집' in r['reason'] for r in result.json()['error']['detail']['map_update']['reasons'])


def test_voxel_auto_update_stale_start_rejection_and_ongoing_run_stays_fixed(maps, seeded):
    from sqlalchemy.orm import sessionmaker
    from apps.server.fh_server.models import Run
    from .test_voxel_maps import scenario_for, fail, Rejected
    http, admin, _ = maps
    imported = import_voxels(http, admin).json()
    original = imported['map']
    value = scenario_for(http, admin, original['floor_id'], original['id'])
    factory = sessionmaker(http.app.state.engine, expire_on_commit=False)
    with factory.begin() as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        robot.simulation, robot.sim_world_id = True, 'custom/' + imported['terrain']['spec']['id']
    with factory() as db:
        _, old = runs.fixed_scenario(db, db.get(Robot, seeded['robots']['mine']), UUID(value['id']), 1, fail)
    instance, run_id = str(uuid4()), str(uuid4())
    data = dict(run_id=run_id, scenario_id=value['id'], scenario_version=1,
        floor_id=str(old.waypoints[0].floor_id), map_version_id=str(old.waypoints[0].map_version_id),
        user_id=str(seeded['users']['one']), device_id=str(uuid4()), surface='pc', screen_id=str(uuid4()),
        simulation=True, map_proof=old.map_proofs[0].model_dump(mode='json'))
    started = C.AgentEvent(t='event', code='RUN_STARTED', severity='INFO', robot_at=None, data=data,
        agent_instance_id=instance, report_seq=1, monotonic_s=1.)
    assert runs.record(factory, seeded['org'], str(seeded['robots']['mine']), started)['t'] == 'run.recorded'
    with factory() as db:
        old_plan = copy.deepcopy(db.get(Run, UUID(run_id)).plan)
    changed_map(http, admin, original['floor_id'], original['upload_id'], original,
        zones=[zone('SLOW', [[.11, .11], [.19, .11], [.19, .19], [.11, .19]], .4)])
    updated = apply(http, admin, value)
    assert updated.status_code == 200 and updated.json()['number'] == 2, updated.text
    with factory() as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        with pytest.raises(Rejected) as error:
            runs.fixed_scenario(db, robot, UUID(value['id']), 1, fail)
        assert error.value.args[1] == 'MAP_UPDATE_REQUIRED'
        _, new = runs.fixed_scenario(db, robot, UUID(value['id']), 2, fail)
        assert new.map_proofs[0].map_version_id != old.map_proofs[0].map_version_id
        assert new.map_proofs[0].source_pgm_sha256 == old.map_proofs[0].source_pgm_sha256
    for seq, status in [(2, 'PAUSED'), (3, 'MOVING')]:
        update = C.AgentRunUpdate(t='run.update', run_id=run_id, status=status, step=0, progress={'done': 0, 'total': 2},
            agent_instance_id=instance, report_seq=seq, monotonic_s=float(seq))
        assert runs.record(factory, seeded['org'], str(seeded['robots']['mine']), update)['t'] == 'run.recorded'
    with factory() as db:
        run = db.get(Run, UUID(run_id))
        assert run.status == 'MOVING' and run.plan == old_plan
        assert run.map_version_id == old.map_proofs[0].map_version_id
        assert db.get(ScenarioVersion, run.scenario_version_id).number == 1


def test_simulation_annotation_clone_can_follow_latest_and_keep_own_grid(maps):
    from .test_voxel_maps import scenario_for
    http, admin, _ = maps
    imported = import_voxels(http, admin).json()
    original, terrain = imported['map'], imported['terrain']
    value = scenario_for(http, admin, terrain['floor_id'], terrain['map_version_id'])
    first = changed_map(http, admin, original['floor_id'], original['upload_id'], original,
        zones=[zone('SLOW', speed=.4)])
    updated = apply(http, admin, value)
    assert updated.status_code == 200 and updated.json()['number'] == 2, updated.text
    changed_map(http, admin, original['floor_id'], original['upload_id'], first,
        zones=[zone('SLOW', speed=.6)])
    updated = apply(http, admin, value)
    assert updated.status_code == 200 and updated.json()['number'] == 3, updated.text
    target = http.get(P + '/map-versions/' + updated.json()['map_version_ids'][0], headers=admin).json()
    assert target['provenance'] == 'SIMULATION' and target['resolution'] == .05
    assert target['features']['zones'][0]['max_speed_mps'] == .6


def test_lineage_migration_downgrade_refuses_to_erase_auto_history(maps, seeded, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy.exc import DBAPIError
    from .conftest import CONFIG
    http, admin, _ = maps
    value, floor, image, original = scenario(http, admin)
    changed_map(http, admin, floor, image, original)
    assert apply(http, admin, value).status_code == 200
    monkeypatch.setenv('FH_MIGRATE_DATABASE_URL', seeded['urls']['migrate'])
    with pytest.raises(DBAPIError, match='Automatic map lineage requires backup'):
        command.downgrade(Config(str(CONFIG)), '0028')
    engine = create_engine(seeded['urls']['app'])
    with Session(engine) as db:
        versions = list(db.scalars(select(ScenarioVersion).order_by(ScenarioVersion.number)))
        assert [v.auto_map_from_number for v in versions] == [None, 1]
        with pytest.raises(DBAPIError):
            db.execute(text('UPDATE scenario_versions SET auto_map_from_number=NULL'))
    engine.dispose()


def test_scanline_raster_matches_independent_closed_square_oracle():
    import math
    import random
    from apps.server.fh_server.maps import intersects
    from apps.server.fh_server.zones import inside_polygon
    rng = random.Random(32)
    for _ in range(40):
        angles = sorted(rng.random() * math.tau for _ in range(12))
        polygon = []
        for angle in angles:
            radius = .2 + rng.random() * 2
            polygon.append([2.5 + radius * math.cos(angle), 2.5 + radius * math.sin(angle)])
        edges = list(zip(polygon, polygon[1:] + polygon[:1]))
        expected = []
        for y in range(5):
            for x in range(5):
                corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]
                touched = (any(x <= a <= x + 1 and y <= b <= y + 1 for a, b in polygon)
                    or any(inside_polygon(*p, polygon) for p in corners)
                    or any(intersects(a, b, c, d) for a, b in zip(corners, corners[1:] + corners[:1]) for c, d in edges))
                if touched:
                    expected.append((4 - y) * 5 + x)
        actual = rasterize([0, 0, 0], 1, 5, 5, [dict(type='NO_GO', polygon=polygon)])
        assert [c['index'] for c in actual] == sorted(expected)


def test_go_to_finish_overlap_and_archived_scenarios_are_excluded(maps):
    http, admin, _ = maps
    value, floor, image, original = scenario(http, admin)
    body = {k: value[k] for k in ('name', 'waypoints', 'finish', 'notes')}
    target = {k: value['waypoints'][0][k] for k in ('floor_id', 'map_version_id', 'x', 'y', 'yaw', 'waypoint_ref')}
    target['x'] = 1.5
    body['finish'] = {'mode': 'GO_TO', 'target': target}
    response = http.put(P + '/scenarios/' + value['id'], headers={**admin, 'If-Match': '"1"'}, json=body)
    assert response.status_code == 200, response.text
    features = copy.deepcopy(FEATURES)
    polygon = [[1.5, .1], [1.8, .1], [1.8, .3], [1.5, .3]]
    features['zones'] = [zone('SLOW', polygon, .3)]
    path = P + f'/floors/{floor}/zone-overlaps'
    assert http.post(path, headers=admin, json={'features': features}).json()['scenarios'] == []
    features['zones'] = [zone(polygon=polygon)]
    hits = http.post(path, headers=admin, json={'features': features}).json()['scenarios'][0]['hits']
    assert any(h['kind'] == 'POINT' and h['element'] == 'finish.target' for h in hits)
    assert any(h['kind'] == 'SEGMENT' and h['element'] == 'waypoints.0->finish.target' for h in hits)
    changed_map(http, admin, floor, image, original, zones=features['zones'])
    blocked = apply(http, admin, value)
    assert blocked.status_code == 409
    assert any(r['element'] == 'finish.target' for r in blocked.json()['error']['detail']['map_update']['reasons'])
    assert http.delete(P + '/scenarios/' + value['id'], headers=admin).status_code == 204
    assert http.post(path, headers=admin, json={'features': features}).json()['scenarios'] == []

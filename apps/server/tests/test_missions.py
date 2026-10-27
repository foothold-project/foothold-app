"""S5a behavioral acceptance; synthetic maps, tenant separation, real DB roles."""
import copy
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import MissionVersion, RobotDevice, ScenarioVersion
from .test_maps import P, FEATURES, auth, maps, tree, upload, save

MISSION = {'name': '합성 임무', 'steps': [{'action': 'PHOTO', 'params': {}}, {'action': 'WAIT', 'params': {'seconds': 5}}]}


def make_mission(http, headers, body=None):
    response = http.post(P + '/missions', headers=headers, json=body or MISSION)
    assert response.status_code == 201, response.text
    return response.json()


def setup_scenario(http, headers, paired=True):
    _, building, a = tree(http, headers)
    b = http.post(P + f'/buildings/{building}/floors', headers=headers, json={'name': '2층', 'level': 2}).json()['id']
    image = upload(http, headers)
    features = copy.deepcopy(FEATURES)
    features['zones'] = [{'id': 'blocked', 'type': 'NO_GO', 'name': '금지', 'polygon': [[1.4, 1.4], [1.8, 1.4], [1.8, 1.8], [1.4, 1.8]]}]
    features['waypoints'] = [{'id': 'gate-id', 'name': '입구', 'x': .1, 'y': .1, 'yaw': 0}]
    connector = {'id': 'stairs', 'kind': 'STAIRS', 'x': .5, 'y': .5, 'yaw': 0}
    fa, fb = copy.deepcopy(features), copy.deepcopy(features)
    if paired:
        fa['connectors'] = [{**connector, 'pair_floor_id': b}]
        fb['connectors'] = [{**connector, 'pair_floor_id': a}]
    va, vb = save(http, headers, a, image, features=fa).json(), save(http, headers, b, image, features=fb).json()
    m1, m2 = make_mission(http, headers), make_mission(http, headers, {'name': '센서', 'steps': [{'action': 'SENSOR_LOG', 'params': {'device': 'lidar'}}]})
    def point(floor, version, x, y, mission):
        return dict(floor_id=floor, map_version_id=version, x=x, y=y, yaw=0, waypoint_ref=None,
                    mission_id=mission['id'], mission_version=1)
    body = dict(name='두 층 순찰', waypoints=[point(a, va['id'], .1, .1, m1), point(a, va['id'], .5, .1, m1),
        point(b, vb['id'], 1, .5, m2)], finish={'mode': 'STAY', 'target': None}, notes='합성 시험')
    return body, (a, b), (va, vb), image


def test_actions_inventory_scope_and_live_hello(client, seeded):
    headers = auth(client, 'one')
    assert client.get(P + '/actions').status_code == 401
    catalog = client.get(P + '/actions', headers=headers).json()
    assert [a['key'] for a in catalog] == ['PHOTO', 'WAIT', 'OPERATOR_CONFIRM', 'SENSOR_LOG']
    assert catalog[0]['params'] == {'camera': 'rgb'} and catalog[0]['requires'] == [] and catalog[0]['options'][0]['requires'] == ['CAMERA_RGB']
    assert not catalog[0]['available'] and not catalog[1]['available']
    assert all(a['available'] for a in catalog[2:])
    rid = str(seeded['robots']['mine'])
    missing = client.get(P + '/actions', params={'robot_id': rid}, headers=headers).json()
    assert all(not a['available'] for a in missing)
    assert all('아직 광고하지' in a['why_unavailable'] for a in missing[:2])
    engine = create_engine(seeded['urls']['migrate'])
    with Session(engine) as db:
        db.add_all([RobotDevice(org_id=seeded['org'], robot_id=seeded['robots']['mine'], key='rgb', kind='CAMERA_RGB', label='카메라', state='OK'),
                    RobotDevice(org_id=seeded['org'], robot_id=seeded['robots']['mine'], key='lidar', kind='LIDAR', label='라이다', state='ERROR')])
        db.commit()
    engine.dispose()
    stored = client.get(P + '/actions', params={'robot_id': rid}, headers=headers).json()
    assert not stored[0]['available'] and not stored[1]['available'] and stored[3]['available']
    lidar = next(o for o in stored[3]['options'] if o['value'] == 'lidar')
    assert not lidar['available'] and 'LIDAR' in lidar['why_unavailable']
    client.app.state.realtime.agents[rid] = SimpleNamespace(closing=False, state={'devices': [],
        'execution_capabilities': {'contract': 'scenario/2', 'revision': 1, 'actions': [
            {'key': 'wait', 'state': 'SUPPORTED', 'reason': None},
            {'key': 'photo.rgb', 'state': 'SUPPORTED', 'reason': None}]}})
    try:
        live = client.get(P + '/actions', params={'robot_id': rid}, headers=headers).json()
        assert not live[0]['available'] and live[1]['available'] and '장치' in live[0]['why_unavailable']
    finally:
        client.app.state.realtime.agents.pop(rid)
    for identifier in (seeded['robots']['theirs'], seeded['robots']['foreign'], uuid4()):
        response = client.get(P + '/actions', params={'robot_id': str(identifier)}, headers=headers)
        assert response.status_code == 404 and response.json()['error']['code'] == 'NOT_FOUND'


def test_mission_versions_conflicts_archive_permissions_events(client, seeded):
    one, two, admin = auth(client, 'one'), auth(client, 'two'), auth(client)
    first = make_mission(client, one)
    path = P + '/missions/' + first['id']
    assert first['number'] == first['version'] == first['latest_version'] == 1
    assert first['required_devices'] == ['CAMERA_RGB']
    assert client.get(path, headers=two).headers['etag'] == '"1"'
    changed = {'name': '변경 이름', 'steps': [{'action': 'WAIT', 'params': {'seconds': 9}}]}
    assert client.put(path, headers=one, json=changed).status_code == 428
    stale = client.put(path, headers={**one, 'If-Match': '"0"'}, json=changed)
    assert stale.status_code == 409 and stale.json()['error']['detail'] == {'version': 1}
    response = client.put(path, headers={**admin, 'If-Match': '"1"'}, json=changed)
    assert response.status_code == 200 and response.headers['etag'] == '"2"', response.text
    assert response.json()['number'] == response.json()['version'] == 2 and response.json()['required_devices'] == []
    assert client.get(path + '?version=1', headers=two).json()['name'] == first['name']
    assert client.get(path + '?version=1', headers=two).json()['steps'] == first['steps']
    assert client.delete(path, headers=one).status_code == 204
    assert client.get(P + '/missions', headers=one).json()['items'] == []
    assert client.get(P + '/missions?archived=1', headers=one).json()['items'][0]['archived_at']
    old = client.get(path + '?version=1', headers=two)
    assert old.status_code == 200 and 'etag' not in old.headers
    assert old.json()['number'] == 1 and old.json()['archived_at']
    events = client.get(P + '/events', headers=one).json()['items']
    bycode = {row['code']: row for row in events}
    # Version saved by admin is visible to admin; own create/archive to operator.
    all_events = client.get(P + '/events', headers=admin).json()['items']
    bycode.update({row['code']: row for row in all_events})
    for code, word in [('MISSION_CREATED', '만들었습니다'), ('MISSION_VERSION_CREATED', '저장했습니다'), ('MISSION_ARCHIVED', '보관했습니다')]:
        assert code in bycode and word in bycode[code]['message'] and '임무' in bycode[code]['message']
    assert client.get(P + '/notifications', headers=admin).json()['items'] == []


def test_mission_two_concurrent_puts_only_one(client, seeded):
    headers = auth(client)
    first = make_mission(client, headers)
    path = P + '/missions/' + first['id']
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.put(path, headers={**headers, 'If-Match': '"1"'}, json=MISSION), range(2)))
    assert sorted(r.status_code for r in responses) == [200, 409]
    assert client.get(path, headers=headers).json()['number'] == 2
    engine = create_engine(seeded['urls']['app'])
    with Session(engine) as db:
        rows = list(db.scalars(select(MissionVersion).where(MissionVersion.mission_id == first['id'])))
        assert sorted(row.number for row in rows) == [1, 2]
    engine.dispose()


@pytest.mark.parametrize('body', [
    {'name': 'x', 'steps': []}, {'name': 'x', 'steps': [{'action': 'WAIT'}] * 101},
    {'name': 'x\u200b', 'steps': [{'action': 'WAIT'}]}, {'name': 'x\n', 'steps': [{'action': 'WAIT'}]},
    {'name': 'x', 'steps': [{'action': 'UNKNOWN'}]},
    *[{'name': 'x', 'steps': [{'action': action, 'params': params}]} for action, params in [
        ('WAIT', {'seconds': 0}), ('WAIT', {'seconds': 3601}), ('WAIT', {'seconds': True}), ('WAIT', {'seconds': 1.5}),
        ('WAIT', {'seconds': '30'}), ('WAIT', {'extra': 1}), ('PHOTO', {'camera': 'thermal'}),
        ('SENSOR_LOG', {'device': 'unknown'}), ('SENSOR_LOG', {'seconds': -1}),
        ('OPERATOR_CONFIRM', {'prompt': ''}), ('OPERATOR_CONFIRM', {'prompt': 'x\u200b'})]]])
def test_invalid_mission_steps_422(client, body):
    response = client.post(P + '/missions', headers=auth(client), json=body)
    assert response.status_code == 422 and response.json()['error']['code'] == 'PRECHECK_FAILED'


def test_scenario_calculation_versions_finish_archive_and_event(maps, seeded):
    http, headers, _ = maps
    body, floors, versions, _ = setup_scenario(http, headers)
    before = http.get(P + '/scenarios', headers=headers).json()
    response = http.post(P + '/scenarios/preview', headers=headers, json=body)
    assert response.status_code == 200, response.text
    checked = response.json()
    assert checked['reachable'] and all(p['reachable'] for p in checked['points'])
    assert len(checked['segments'][1]['via']) == 2 and checked['segments'][1]['connector_id']
    assert checked['est_distance_m'] == pytest.approx(1.3)
    assert sorted(checked['floor_ids']) == sorted(floors)
    assert sorted(checked['map_version_ids']) == sorted(v['id'] for v in versions)
    assert checked['required_devices'] == ['CAMERA_RGB', 'LIDAR'] and 'Nav2' in checked['distance_note']
    assert http.get(P + '/scenarios', headers=headers).json() == before
    created = http.post(P + '/scenarios', headers=headers, json=body)
    assert created.status_code == 201 and created.headers['etag'] == '"1"', created.text
    first, path = created.json(), P + '/scenarios/' + created.json()['id']
    assert first['est_distance_m'] == checked['est_distance_m'] and first['floor_ids'] == checked['floor_ids']
    for key in ('map_version_ids', 'required_devices'):
        assert first[key] == checked[key]
    assert http.get(P + '/scenarios?mine=1&floor_id=' + floors[1], headers=headers).json()['items'][0]['id'] == first['id']
    one = auth(http, 'one')
    assert http.get(path, headers=one).status_code == 200
    assert http.get(P + '/scenarios?mine=1', headers=one).json()['items'] == []
    assert http.put(path, headers=headers, json=body).status_code == 428
    body['name'], body['notes'] = '새 이름', '둘째 판 메모'
    body['finish'] = {'mode': 'RETURN_TO_START'}
    second = http.put(path, headers={**headers, 'If-Match': '"1"'}, json=body)
    assert second.status_code == 200 and second.json()['number'] == second.json()['version'] == 2, second.text
    assert second.json()['est_distance_m'] == pytest.approx(1.3 + .5 + math_distance(.5, .5, .1, .1))
    assert http.put(path, headers={**headers, 'If-Match': '"1"'}, json=body).status_code == 409
    assert http.get(path + '?version=1', headers=one).json()['name'] == first['name']
    body['finish'] = {'mode': 'GO_TO', 'target': {k: v for k, v in body['waypoints'][0].items() if not k.startswith('mission_')}}
    go = http.post(P + '/scenarios/preview', headers=one, json=body)
    assert go.status_code == 200 and go.json()['segments'][-1]['end'] == 'finish.target'
    for point in first['waypoints']:
        assert http.delete(P + '/missions/' + point['mission_id'], headers=headers).status_code == 204
    assert http.get(path + '?version=1', headers=one).json()['waypoints'] == first['waypoints']
    assert http.delete(path, headers=headers).status_code == 204
    assert http.get(P + '/scenarios', headers=headers).json()['items'] == []
    assert http.get(P + '/scenarios?archived=1', headers=headers).json()['items'][0]['archived_at']
    assert http.get(path + '?version=1', headers=one).status_code == 200
    events = {e['code']: e for e in http.get(P + '/events', headers=headers).json()['items']}
    for code, word in [('SCENARIO_CREATED', '만들었습니다'), ('SCENARIO_VERSION_CREATED', '저장했습니다'), ('SCENARIO_ARCHIVED', '보관했습니다')]:
        assert code in events and word in events[code]['message'] and '시나리오' in events[code]['message']
    engine = create_engine(seeded['urls']['app'])
    with Session(engine) as db:
        persisted = db.scalar(select(ScenarioVersion).where(ScenarioVersion.scenario_id == first['id'], ScenarioVersion.number == 1))
        assert persisted.est_distance_m == pytest.approx(1.3) and persisted.required_devices == ['CAMERA_RGB', 'LIDAR']
    engine.dispose()


def math_distance(x1, y1, x2, y2):
    return ((x1 - x2)**2 + (y1 - y2)**2)**.5


def test_scenario_rejections_and_preview_reasons(maps):
    http, headers, _ = maps
    good, floors, versions, image = setup_scenario(http, headers, paired=False)
    missing = http.post(P + '/scenarios/preview', headers=headers, json=good)
    assert missing.status_code == 200 and not missing.json()['reachable']
    assert not missing.json()['points'][2]['reachable']
    assert '연결점 짝이 없습니다' in missing.json()['points'][2]['reasons'][0]
    assert http.post(P + '/scenarios', headers=headers, json=good).status_code == 422
    good['waypoints'] = good['waypoints'][:2]
    for patch, reason in [({'x': 3}, '지도 범위'), ({'x': 1.6, 'y': 1.6}, '진입 금지'),
                          ({'x': 1.4, 'y': 1.4}, '진입 금지'), ({'waypoint_ref': 'wrong'}, '일치하지')]:
        body = copy.deepcopy(good)
        body['waypoints'][0].update(patch)
        checked = http.post(P + '/scenarios/preview', headers=headers, json=body)
        assert checked.status_code == 200 and not checked.json()['points'][0]['reachable'], checked.text
        assert reason in checked.json()['points'][0]['reasons'][0]
        failed = http.post(P + '/scenarios', headers=headers, json=body)
        assert failed.status_code == 422 and failed.json()['error']['detail']['preview']['points'][0]['element'] == 'waypoints.0'
    for reference in ('gate-id',):
        body = copy.deepcopy(good)
        body['waypoints'][0]['waypoint_ref'] = reference
        assert http.post(P + '/scenarios', headers=headers, json=body).status_code == 201
    for patch in ({'mission_id': str(uuid4())}, {'mission_version': 999}):
        body = copy.deepcopy(good)
        body['waypoints'][0].update(patch)
        response = http.post(P + '/scenarios', headers=headers, json=body)
        assert response.status_code == 422 and response.json()['error']['detail']['elements'] == ['waypoints.0.mission_version']
    body = copy.deepcopy(good)
    body['waypoints'][0]['map_version_id'] = versions[1]['id']
    assert http.post(P + '/scenarios', headers=headers, json=body).status_code == 409
    changed = save(http, headers, floors[0], image, base=versions[0]['id']).json()
    stale = http.post(P + '/scenarios', headers=headers, json=good)
    assert stale.status_code == 409 and stale.json()['error']['code'] == 'STALE'
    assert stale.json()['error']['detail']['approved_version_id'] == changed['id']
    for point in good['waypoints']:
        point['map_version_id'] = changed['id']
    assert http.delete(P + '/missions/' + good['waypoints'][0]['mission_id'], headers=headers).status_code == 204
    assert http.post(P + '/scenarios', headers=headers, json=good).status_code == 422


def test_scenario_input_limits_finish_finite_and_pending_map(maps):
    http, headers, _ = maps
    good, floors, versions, image = setup_scenario(http, headers)
    for patch in ({'waypoints': []}, {'waypoints': good['waypoints'] * 67}, {'name': 'bad\u200b'},
                  {'finish': {'mode': 'GO_TO'}}, {'finish': {'mode': 'WRONG'}},
                  {'finish': {'mode': 'STAY', 'target': {k: v for k, v in good['waypoints'][0].items() if not k.startswith('mission_')}}}):
        response = http.post(P + '/scenarios', headers=headers, json={**good, **patch})
        assert response.status_code == 422, response.text
    for coordinate in ('NaN', 'Infinity', '1e999', 'true', '"1.2"'):
        body = copy.deepcopy(good)
        body['waypoints'][0]['x'] = 'TOKEN'
        import json
        response = http.post(P + '/scenarios', headers={**headers, 'content-type': 'application/json'}, content=json.dumps(body).replace('"TOKEN"', coordinate))
        assert response.status_code == 422
    operator = auth(http, 'one')
    from .legacy_approvals import pending_map
    pending, _ = pending_map(http, operator, floors[0], image, versions[0]['id'])
    assert pending['status'] == 'PENDING'
    body = copy.deepcopy(good)
    body['waypoints'][0]['map_version_id'] = pending['id']
    assert http.post(P + '/scenarios', headers=operator, json=body).status_code == 409
    target = {k: v for k, v in good['waypoints'][0].items() if not k.startswith('mission_')}
    target['x'] = 10
    response = http.post(P + '/scenarios', headers=headers, json={**good, 'finish': {'mode': 'GO_TO', 'target': target}})
    assert response.status_code == 422 and response.json()['error']['detail']['preview']['points'][-1]['element'] == 'finish.target'


def test_tenant_ids_lists_and_pagination(client, seeded):
    headers = auth(client)
    first = make_mission(client, headers)
    second = make_mission(client, headers)
    page = client.get(P + '/missions?limit=1', headers=headers).json()
    assert len(page['items']) == 1 and page['next_cursor']
    after = client.get(P + '/missions', params={'cursor': page['next_cursor'], 'limit': 1}, headers=headers).json()
    assert after['items'][0]['id'] == second['id'] and after['next_cursor'] is None
    # Tenant-scoped auth comes from the server's organization setting.
    engine = create_engine(seeded['urls']['migrate'])
    from apps.server.fh_server.models import User
    with Session(engine) as db:
        org = db.get(User, seeded['users']['foreign']).org_id
    engine.dispose()
    app = create_app(Settings(seeded['urls']['app'], org))
    with TestClient(app, base_url='https://testserver') as other:
        foreign_headers = auth(other, 'foreign')
        foreign = make_mission(other, foreign_headers)
        for identifier in (foreign['id'], str(uuid4())):
            assert client.get(P + '/missions/' + identifier, headers=headers).status_code == 404
            assert client.delete(P + '/missions/' + identifier, headers=headers).status_code == 404
            assert client.put(P + '/missions/' + identifier, headers={**headers, 'If-Match': '"1"'}, json=MISSION).status_code == 404
        assert other.get(P + '/missions/' + first['id'], headers=foreign_headers).status_code == 404
    assert len(client.get(P + '/missions', headers=headers).json()['items']) == 2


def test_snapshot_and_parent_db_permissions_and_missing_template(maps, seeded, monkeypatch):
    http, headers, _ = maps
    body, _, _, _ = setup_scenario(http, headers)
    scenario = http.post(P + '/scenarios', headers=headers, json=body).json()
    engine = create_engine(seeded['urls']['app'])
    with engine.connect() as conn:
        for table in ('mission_versions', 'scenario_versions'):
            for statement in (f'UPDATE {table} SET name=name', f'DELETE FROM {table}', f'TRUNCATE {table}'):
                with pytest.raises(DBAPIError):
                    conn.execute(text(statement))
                conn.rollback()
        for table in ('missions', 'scenarios'):
            for statement in (f'UPDATE {table} SET created_by=created_by', f'DELETE FROM {table}', f'TRUNCATE {table}'):
                with pytest.raises(DBAPIError):
                    conn.execute(text(statement))
                conn.rollback()
    engine.dispose()
    from apps.server.fh_server import event_messages
    for code in ('MISSION_CREATED', 'MISSION_VERSION_CREATED', 'MISSION_ARCHIVED', 'SCENARIO_CREATED', 'SCENARIO_VERSION_CREATED', 'SCENARIO_ARCHIVED'):
        assert code in event_messages.TEMPLATES
    monkeypatch.delitem(event_messages.TEMPLATES, 'MISSION_CREATED')
    with pytest.raises(KeyError):
        http.post(P + '/missions', headers=headers, json={'name': '실패 원자성', 'steps': [{'action': 'WAIT'}]})
    assert all(m['name'] != '실패 원자성' for m in http.get(P + '/missions', headers=headers).json()['items'])
    assert http.get(P + '/scenarios/' + scenario['id'], headers=headers).status_code == 200


@pytest.mark.parametrize('table,grant', [('mission_versions', 'UPDATE'), ('scenario_versions', 'DELETE'),
    ('scenario_versions', 'UPDATE (notes)'), ('missions', 'UPDATE (created_by)'), ('scenarios', 'TRUNCATE')])
def test_startup_rejects_unsafe_mission_grants(seeded, table, grant):
    engine = create_engine(seeded['urls']['migrate'])
    with engine.begin() as conn:
        conn.execute(text(f'GRANT {grant} ON {table} TO fh_app'))
    app = create_app(Settings(seeded['urls']['app'], seeded['org']))
    try:
        with pytest.raises(RuntimeError, match='restricted'):
            with TestClient(app):
                pass
    finally:
        with engine.begin() as conn:
            conn.execute(text(f'REVOKE {grant} ON {table} FROM fh_app'))
        engine.dispose()
        app.state.engine.dispose()


def test_scenario_foreign_floor_mission_and_id_scope(maps, seeded):
    http, headers, _ = maps
    good, floors, _, _ = setup_scenario(http, headers)
    engine = create_engine(seeded['urls']['migrate'])
    from apps.server.fh_server.models import Building, Floor, Mission, Site, User
    with Session(engine) as db:
        org = db.get(User, seeded['users']['foreign']).org_id
        site = Site(org_id=org, name='다른 장소')
        db.add(site)
        db.flush()
        building = Building(org_id=org, site_id=site.id, name='다른 건물')
        db.add(building)
        db.flush()
        floor = Floor(org_id=org, building_id=building.id, name='다른 층', level=1)
        mission = Mission(org_id=org, name='다른 임무', created_by=seeded['users']['foreign'], version=1, latest_version=1)
        db.add_all([floor, mission])
        db.flush()
        db.add(MissionVersion(org_id=org, mission_id=mission.id, name=mission.name, number=1, steps=[{'action': 'WAIT', 'params': {'seconds': 1}}],
            required_devices=[], created_by=seeded['users']['foreign']))
        db.commit()
        foreign_floor, foreign_mission = str(floor.id), str(mission.id)
    engine.dispose()
    created = http.post(P + '/scenarios', headers=headers, json=good).json()
    app = create_app(Settings(seeded['urls']['app'], org))
    with TestClient(app, base_url='https://testserver') as foreign:
        foreign_headers = auth(foreign, 'foreign')
        for identifier in (created['id'], str(uuid4())):
            path = P + '/scenarios/' + identifier
            assert foreign.get(path, headers=foreign_headers).status_code == 404
            assert foreign.put(path, headers={**foreign_headers, 'If-Match': '"1"'}, json=good).status_code == 404
            assert foreign.delete(path, headers=foreign_headers).status_code == 404
    for identifier in (foreign_floor, str(uuid4())):
        body = copy.deepcopy(good)
        body['waypoints'][0]['floor_id'] = identifier
        assert http.post(P + '/scenarios', headers=headers, json=body).status_code == 404
        assert http.get(P + '/scenarios?floor_id=' + identifier, headers=headers).status_code == 404
    for identifier in (foreign_mission, str(uuid4())):
        body = copy.deepcopy(good)
        body['waypoints'][0]['mission_id'] = identifier
        response = http.post(P + '/scenarios', headers=headers, json=body)
        assert response.status_code == 422 and response.json()['error']['detail']['elements'] == ['waypoints.0.mission_version']


def test_rotated_map_coordinates_and_photo_depth_requirements(maps):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers, yaml=b'image: synthetic.pgm\nresolution: 0.5\norigin: [5, 7, 1.5707963267948966]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.2\n')
    version = save(http, headers, floor, image).json()
    mission = make_mission(http, headers, {'name': '깊이 사진', 'steps': [{'action': 'PHOTO', 'params': {'camera': 'depth'}},
        {'action': 'SENSOR_LOG', 'params': {'device': 'battery', 'seconds': 20}}]})
    assert mission['required_devices'] == ['BATTERY', 'CAMERA_DEPTH']
    point = dict(floor_id=floor, map_version_id=version['id'], x=4, y=8, mission_id=mission['id'], mission_version=1)
    body = dict(name='회전 지도', waypoints=[point], finish={'mode': 'STAY'})
    assert http.post(P + '/scenarios', headers=headers, json=body).status_code == 201
    point['x'], point['y'] = 6, 8
    assert http.post(P + '/scenarios', headers=headers, json=body).status_code == 422

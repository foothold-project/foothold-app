"""PR35 review: actual row-lock races and tightened public contracts."""
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event
from uuid import UUID

import pytest
from sqlalchemy import create_engine, event as sql_event, select, text
from sqlalchemy.orm import Session

from apps.server.fh_server import api, missions
from apps.server.fh_server.models import MissionVersion, ScenarioVersion
from .test_maps import P, FEATURES, auth, maps, save, tree, upload
from .test_missions import MISSION, make_mission, setup_scenario


@contextmanager
def observe_reads(engine, table):
    reached, fetched = Event(), Event()
    def before(conn, cursor, statement, *args):
        if statement.startswith('SELECT ' + table + '.'):
            reached.set()
    def after(conn, cursor, statement, *args):
        if statement.startswith('SELECT ' + table + '.'):
            fetched.set()
    sql_event.listen(engine, 'before_cursor_execute', before)
    sql_event.listen(engine, 'after_cursor_execute', after)
    try:
        yield reached, fetched
    finally:
        sql_event.remove(engine, 'before_cursor_execute', before)
        sql_event.remove(engine, 'after_cursor_execute', after)


def test_floor_share_lock_blocks_stale_save(maps, seeded):
    http, headers, _ = maps
    body, (floor, _), (first, _), image = setup_scenario(http, headers)
    second = save(http, headers, floor, image, base=first['id']).json()
    body['waypoints'] = [p for p in body['waypoints'] if p['floor_id'] == floor]
    for point in body['waypoints']:
        point['map_version_id'] = second['id']
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.connect() as blocker, ThreadPoolExecutor(max_workers=1) as pool:
            blocker.execute(text('UPDATE floors SET approved_version_id=:version WHERE id=:floor'),
                {'version': first['id'], 'floor': floor})
            with observe_reads(http.app.state.engine, 'floors') as (reached, fetched):
                future = pool.submit(http.post, P + '/scenarios', headers=headers, json=body)
                try:
                    assert reached.wait(5), 'save did not reach the floor read'
                    blocked = not fetched.wait(.25)
                finally:
                    blocker.commit()
                response = future.result(timeout=10)
        assert blocked, 'scenario must wait for the concurrent approved-pointer update'
        assert response.status_code == 409 and response.json()['error']['code'] == 'STALE', response.text
        assert response.json()['error']['detail']['approved_version_id'] == first['id']
        assert http.get(P + '/scenarios', headers=headers).json()['items'] == []
    finally:
        engine.dispose()


def test_mission_share_lock_blocks_concurrent_archive_reference(maps, seeded):
    http, headers, _ = maps
    body, _, _, _ = setup_scenario(http, headers)
    identifier = body['waypoints'][0]['mission_id']
    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.connect() as blocker, ThreadPoolExecutor(max_workers=1) as pool:
            blocker.execute(text('UPDATE missions SET archived_at=now(), version=version+1 WHERE id=:id'), {'id': identifier})
            with observe_reads(http.app.state.engine, 'missions') as (reached, fetched):
                future = pool.submit(http.post, P + '/scenarios', headers=headers, json=body)
                try:
                    assert reached.wait(5), 'save did not reach the mission read'
                    blocked = not fetched.wait(.25)
                finally:
                    blocker.commit()
                response = future.result(timeout=10)
        assert blocked, 'new reference must wait for the mission archive transaction'
        assert response.status_code == 422, response.text
        assert response.json()['error']['detail'] == {'elements': ['waypoints.0.mission_version']}
        assert http.get(P + '/scenarios', headers=headers).json()['items'] == []
    finally:
        engine.dispose()


@pytest.mark.parametrize('resource', ['missions', 'scenarios'])
def test_parent_update_lock_serializes_archive_and_put(maps, seeded, monkeypatch, resource):
    http, admin, _ = maps
    second_session = auth(http)
    if resource == 'missions':
        body, first = MISSION, make_mission(http, admin)
    else:
        body, _, _, _ = setup_scenario(http, admin)
        response = http.post(P + '/scenarios', headers=admin, json=body)
        assert response.status_code == 201, response.text
        first = response.json()
    path = P + '/' + resource + '/' + first['id']
    # Different login sessions and no organization lock isolate the parent lock.
    monkeypatch.setattr(api, 'lock_organization', lambda *args: None)
    archive_holds_row, finish_archive = Event(), Event()
    original_now = missions.now
    def hold_archive():
        archive_holds_row.set()
        if not finish_archive.wait(10):
            raise RuntimeError('test archive release timed out')
        return original_now()
    monkeypatch.setattr(missions, 'now', hold_archive)
    with ThreadPoolExecutor(max_workers=2) as pool:
        archived = pool.submit(http.delete, path, headers=admin)
        try:
            assert archive_holds_row.wait(5), 'archive did not acquire the parent'
            with observe_reads(http.app.state.engine, resource) as (reached, fetched):
                saved = pool.submit(http.put, path, headers={**second_session, 'If-Match': '"1"'}, json=body)
                try:
                    assert reached.wait(5), 'PUT did not reach the parent read'
                    blocked = not fetched.wait(.25)
                finally:
                    finish_archive.set()
                updated = saved.result(timeout=10)
        finally:
            finish_archive.set()
        deleted = archived.result(timeout=10)
    assert blocked, 'PUT must wait while archive holds the parent row'
    assert deleted.status_code == 204 and updated.status_code == 409, updated.text
    current = http.get(path, headers=admin).json()
    assert current['archived_at'] and current['version'] == 2 and current['latest_version'] == 1
    engine = create_engine(seeded['urls']['app'])
    try:
        with Session(engine) as db:
            model = MissionVersion if resource == 'missions' else ScenarioVersion
            parent_id = model.mission_id if resource == 'missions' else model.scenario_id
            assert list(db.scalars(select(model.number).where(parent_id == UUID(first['id'])))) == [1]
    finally:
        engine.dispose()


def test_waypoint_id_coordinates_details_and_historical_etag(maps):
    http, headers, _ = maps
    good, _, _, _ = setup_scenario(http, headers)
    good['waypoints'] = good['waypoints'][:1]
    good['waypoints'][0]['waypoint_ref'] = 'gate-id'
    for coordinate, status in [(.1, 201), (.15, 201), (.151, 422)]:
        good['waypoints'][0]['x'] = coordinate
        response = http.post(P + '/scenarios', headers=headers, json=good)
        assert response.status_code == status, response.text
        if status == 422:
            detail = response.json()['error']['detail']
            assert set(detail) == {'elements', 'preview'} and detail['elements'] == ['waypoints.0']
            assert '0.05 m' in detail['preview']['points'][0]['reasons'][0]
        else:
            path = P + '/scenarios/' + response.json()['id']
            assert http.get(path, headers=headers).headers['etag'] == '"1"'
            assert 'etag' not in http.get(path + '?version=1', headers=headers).headers
    good['waypoints'][0].update(x=.1, waypoint_ref='입구')
    response = http.post(P + '/scenarios', headers=headers, json=good)
    assert response.status_code == 422
    assert response.json()['error']['detail']['elements'] == ['waypoints.0']
    assert '지점 ID' in response.json()['error']['detail']['preview']['points'][0]['reasons'][0]
    for name in ('missing', 'invalid'):
        payload = {'steps': []} if name == 'missing' else {**MISSION, 'steps': [{'action': 'WAIT', 'params': {'seconds': 0}}]}
        response = http.post(P + '/missions', headers=headers, json=payload)
        assert response.status_code == 422 and set(response.json()['error']['detail']) == {'elements'}


def test_query_and_path_validation_remain_common_400(client):
    headers = auth(client)
    for path in ('/missions?limit=0', '/missions/not-a-uuid', '/scenarios?floor_id=bad',
                 '/missions/00000000-0000-0000-0000-000000000000?version=0',
                 '/scenarios?archived=bad', '/scenarios/not-a-uuid'):
        response = client.get(P + path, headers=headers)
        assert response.status_code == 400, response.text
        assert response.json()['error'] == {'code': 'VALIDATION', 'message': '입력 형식을 확인하세요.', 'detail': {}}


def test_rotated_boundary_uses_same_tolerance_as_map_features(maps):
    http, headers, _ = maps
    _, _, floor = tree(http, headers)
    image = upload(http, headers, yaml=b'image: synthetic.pgm\nresolution: 0.5\norigin: [5, 7, 1.5707963267948966]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.2\n')
    features = {**copy.deepcopy(FEATURES), 'waypoints': [{'id': 'edge', 'name': '가장자리', 'x': 4, 'y': 7, 'yaw': 0}]}
    version = save(http, headers, floor, image, features=features)
    assert version.status_code == 201, version.text
    mission = make_mission(http, headers)
    point = dict(floor_id=floor, map_version_id=version.json()['id'], x=4, y=7, waypoint_ref='edge', mission_id=mission['id'], mission_version=1)
    response = http.post(P + '/scenarios', headers=headers, json={'name': '경계', 'waypoints': [point]})
    assert response.status_code == 201, response.text
    point['y'] = 7 - 2e-9
    assert http.post(P + '/scenarios', headers=headers, json={'name': '범위 밖', 'waypoints': [point]}).status_code == 422


def test_catalog_options_and_any_supported_choice(client, seeded):
    headers, rid = auth(client, 'one'), str(seeded['robots']['mine'])
    from types import SimpleNamespace
    state = {'devices': [], 'execution_capabilities': {
        'contract': 'scenario/2', 'revision': 1, 'actions': [
            {'key': key, 'state': 'SUPPORTED', 'reason': None}
            for key in ('wait', 'photo.rgb', 'photo.depth')]}}
    client.app.state.realtime.agents[rid] = SimpleNamespace(closing=False, state=state)
    try:
        for devices in ([{'kind': 'CAMERA_DEPTH', 'state': 'OK'}],
                        [{'kind': 'CAMERA_RGB', 'state': 'OK'}],
                        [{'kind': 'LIDAR', 'state': 'ERROR'}, {'kind': 'BATTERY', 'state': 'OK'}], []):
            state['devices'] = devices
            response = client.get(P + '/actions', params={'robot_id': rid}, headers=headers)
            assert response.status_code == 200
            actions = {a['key']: a for a in response.json()}
            for key, param, values in [('PHOTO', 'camera', ['rgb', 'depth']), ('SENSOR_LOG', 'device', ['rgb', 'depth', 'lidar', 'battery'])]:
                action = actions[key]
                assert action['requires'] == [] and [o['value'] for o in action['options']] == values
                for option in action['options']:
                    expected = any(d['kind'] == missions.DEVICE_KINDS[option['value']] and d['state'] == 'OK' for d in devices)
                    if key == 'PHOTO' and option['value'] == 'depth':
                        expected = False  # Device presence cannot enable unsupported depth storage.
                    assert option['param'] == param and option['requires'] == [missions.DEVICE_KINDS[option['value']]]
                    assert option['available'] == expected and (option['why_unavailable'] is None) == expected
                assert action['available'] == any(o['available'] for o in action['options'])
                assert (action['why_unavailable'] is None) == action['available']
            assert actions['WAIT']['available'] and actions['WAIT']['options'] == []
        state['devices'] = [{'kind': 'CAMERA_DEPTH', 'state': 'MISSING'}]
        assert not client.get(P + '/actions', params={'robot_id': rid}, headers=headers).json()[0]['available']
    finally:
        client.app.state.realtime.agents.pop(rid)


def test_connector_geometry_checked_once_per_pair(maps, monkeypatch):
    http, headers, _ = maps
    good, _, _, _ = setup_scenario(http, headers)
    good['waypoints'] = [copy.deepcopy(good['waypoints'][0 if i % 2 == 0 else 2]) for i in range(200)]
    original, endpoint_checks = missions.inside_polygon, []
    def observed(x, y, polygon):
        if (x, y) == (.5, .5):
            endpoint_checks.append((x, y))
        return original(x, y, polygon)
    monkeypatch.setattr(missions, 'inside_polygon', observed)
    response = http.post(P + '/scenarios/preview', headers=headers, json=good)
    assert response.status_code == 200 and response.json()['reachable'], response.text
    assert len(response.json()['segments']) == 199
    assert len(endpoint_checks) == 2, 'each connector endpoint is checked once, not once per segment'


def test_scenario_referenced_floor_cannot_be_deleted(maps):
    http, headers, _ = maps
    body, (floor, _), _, _ = setup_scenario(http, headers)
    response = http.post(P + '/scenarios', headers=headers, json=body)
    assert response.status_code == 201, response.text
    removed = http.delete(P + '/floors/' + floor, headers=headers)
    assert removed.status_code == 409 and removed.json()['error']['code'] == 'RESOURCE_IN_USE'
    assert http.get(P + '/scenarios/' + response.json()['id'], headers=headers).json()['waypoints'] == body['waypoints']

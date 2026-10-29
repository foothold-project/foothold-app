"""Hidden selections, in-use guards and historical reads using a private DB."""
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from apps.server.fh_server.models import Assignment, Building, Event, Floor, Robot, Run, Site
from .test_maps import P, auth, maps, tree, upload, save as save_map
from .test_missions import setup_scenario
from .test_runs import scenario, save, event, update
from .test_photos import start, upload as upload_photo, JPEG
from .test_simulation import simulation_context


def delete(http, headers, path):
    return http.delete(P + path, headers=headers)


def test_archive_hierarchy_snapshots_selections_events_and_permissions(maps, seeded):
    http, headers, _ = maps
    site, building, floor = tree(http, headers)
    image = upload(http, headers)
    version = save_map(http, headers, floor, image).json()
    assert delete(http, headers, f'/buildings/{building}').status_code == 409
    assert delete(http, headers, f'/sites/{site}').status_code == 409
    assert http.delete(P + f'/floors/{floor}').status_code == 401
    assert delete(http, headers, '/floors/' + str(seeded['robots']['foreign'])).status_code == 404
    # Preserve the existing O policy for operators as well as administrators.
    assert delete(http, auth(http, 'one'), f'/floors/{floor}').status_code == 204
    assert delete(http, headers, f'/floors/{floor}').status_code == 204
    assert http.get(P + '/sites', headers=headers).json()['items'][0]['buildings'][0]['floors'] == []
    archived = http.get(P + '/sites?archived=true', headers=headers).json()['items'][0]['buildings'][0]['floors'][0]
    assert archived['id'] == floor and archived['archived_at'] is not None
    assert http.get(P + f'/floors/{floor}/map-versions', headers=headers).json()['items'] == []
    assert http.get(P + f'/floors/{floor}/map-versions?archived=true', headers=headers).json()['items'][0]['id'] == version['id']
    assert http.get(P + f'/map-versions/{version["id"]}', headers=headers).status_code == 200
    assert http.get(P + f'/map-versions/{version["id"]}/image', headers=headers).status_code == 200
    assert save_map(http, headers, floor, image, base=version['id']).status_code == 409
    assert http.patch(P + f'/floors/{floor}', headers=headers, json={'name': '다시 사용'}).status_code == 409
    assert delete(http, headers, f'/buildings/{building}').status_code == 204
    assert http.post(P + f'/buildings/{building}/floors', headers=headers, json={'name': '새 층', 'level': 2}).status_code == 409
    assert delete(http, headers, f'/sites/{site}').status_code == 204
    assert http.post(P + f'/sites/{site}/buildings', headers=headers, json={'name': '새 건물'}).status_code == 409
    assert http.get(P + '/sites', headers=headers).json()['items'] == []
    with Session(http.app.state.engine) as db:
        for model, identifier in ((Site, site), (Building, building), (Floor, floor)):
            assert db.get(model, UUID(identifier)).archived_at is not None
        codes = list(db.scalars(select(Event.code).where(Event.code.in_(['SITE_DELETED', 'BUILDING_DELETED', 'FLOOR_DELETED']))))
        assert sorted(codes) == ['BUILDING_DELETED', 'FLOOR_DELETED', 'SITE_DELETED']
    paths = http.app.openapi()['paths']
    for path in ('/api/v1/sites', '/api/v1/floors/{floor_id}/map-versions', '/api/v1/assignments'):
        assert any(p['name'] == 'archived' for p in paths[path]['get']['parameters'])


def test_hidden_floor_scenario_and_assignment_selection(maps, seeded):
    http, headers, _ = maps
    body, floors, versions, _ = setup_scenario(http, headers)
    result = http.post(P + '/scenarios', headers=headers, json=body).json()
    path = '/scenarios/' + result['id']
    # A scenario on a hidden floor stays historically readable but cannot be selected.
    assert delete(http, headers, '/floors/' + floors[0]).status_code == 204
    assert http.get(P + '/scenarios', headers=headers).json()['items'] == []
    assert http.get(P + '/scenarios?archived=true', headers=headers).json()['items'][0]['id'] == result['id']
    for suffix in ('', '?version=1'):
        assert http.get(P + path + suffix, headers=headers).status_code == 200
    assert http.post(P + '/scenarios/preview', headers=headers, json=body).status_code == 404
    assert http.post(P + '/scenarios', headers=headers, json=body).status_code == 404
    response = http.post(P + '/assignments', headers=headers, json={'robot_id': str(seeded['robots']['mine']),
        'scenario_id': result['id'], 'scenario_version': 1})
    assert response.status_code == 409 and response.json()['error']['code'] == 'RESOURCE_ARCHIVED'
    assert delete(http, headers, path).status_code == 204
    assert http.get(P + path + '?version=1', headers=headers).status_code == 200
    connectors = http.get(P + '/floor-connectors', headers=headers,
        params={'building_id': http.get(P + '/sites', headers=headers).json()['items'][0]['buildings'][0]['id']})
    assert connectors.json()['items'] == []


@pytest.mark.parametrize('status', ['ACTIVE', 'PENDING'])
def test_assignment_blocks_floor_and_scenario(maps, seeded, status):
    http, headers, _ = maps
    body, floors, _, _ = setup_scenario(http, headers)
    result = http.post(P + '/scenarios', headers=headers, json=body).json()
    response = http.post(P + '/assignments', headers=headers, json={'robot_id': str(seeded['robots']['mine']),
        'scenario_id': result['id'], 'scenario_version': 1})
    assert response.status_code == 201, response.text
    assignment = response.json()
    with Session(http.app.state.engine) as db:
        db.get(Assignment, UUID(assignment['id'])).status = status
        db.commit()
    for path in ('/floors/' + floors[1], '/scenarios/' + result['id']):
        response = delete(http, headers, path)
        assert response.status_code == 409 and '배정' in response.json()['error']['message']
    assert delete(http, headers, '/assignments/' + assignment['id']).status_code == 204
    assert delete(http, headers, '/scenarios/' + result['id']).status_code == 204
    assert http.get(P + '/assignments', headers=headers).json()['items'] == []
    assert http.get(P + '/assignments?archived=true', headers=headers).json()['items'][0]['status'] == 'REMOVED'
    assert delete(http, headers, '/floors/' + floors[1]).status_code == 204


@pytest.mark.parametrize('kind', ['location', 'STARTING', 'ACTIVE', 'STOPPING', 'unknown_world'])
def test_robot_location_and_sim_session_block_floor(scenario, kind):
    s = scenario; http = s['client']; headers = auth(http)
    with Session(http.app.state.engine) as db:
        robot = db.get(Robot, s['seeded']['robots']['mine'])
        if kind == 'location':
            robot.last_floor_id = UUID(s['started']['floor_id'])
        else:
            robot.sim_state = 'ACTIVE' if kind == 'unknown_world' else kind
            robot.sim_world_id = None if kind == 'unknown_world' else 'synthetic-world'
        db.commit()
    response = delete(http, headers, '/floors/' + s['started']['floor_id'])
    assert response.status_code == 409 and response.json()['error']['code'] == 'RESOURCE_IN_USE'
    with Session(http.app.state.engine) as db:
        robot = db.get(Robot, s['seeded']['robots']['mine'])
        robot.last_floor_id, robot.sim_state = None, 'IDLE'
        db.commit()
    assert delete(http, headers, '/floors/' + s['started']['floor_id']).status_code == 204


@pytest.mark.parametrize('status', ['QUEUED', 'PREPARING', 'MOVING', 'RUNNING', 'AT_WAYPOINT', 'PERFORMING', 'WAIT_CONFIRM', 'PAUSED'])
def test_nonterminal_run_blocks_floor_and_scenario(scenario, status):
    s = scenario; http = s['client']; headers = auth(http)
    assert save(s, event(s))['t'] == 'run.recorded'
    with Session(http.app.state.engine) as db:
        db.get(Run, UUID(s['started']['run_id'])).status = status
        db.commit()
    for path in ('/floors/' + s['started']['floor_id'], '/scenarios/' + s['started']['scenario_id']):
        response = delete(http, headers, path)
        assert response.status_code == 409 and '임무' in response.json()['error']['message']


def test_terminal_run_and_photo_survive_archived_floor_and_scenario(scenario):
    s = start(scenario); http = s['client']; headers = auth(http)
    photo = upload_photo(s).json()
    assert save(s, update(s, seq=3, status='CANCELED'))['t'] == 'run.recorded'
    for path in ('/floors/' + s['started']['floor_id'], '/scenarios/' + s['started']['scenario_id']):
        assert delete(http, headers, path).status_code == 204
    history = http.get(P + '/events', params={'run_id': s['started']['run_id']}, headers=headers)
    assert history.status_code == 200 and history.json()['items']
    started = next(e for e in history.json()['items'] if e['code'] == 'RUN_STARTED')
    assert started['data']['floor_id'] == s['started']['floor_id']
    assert started['data']['scenario_id'] == s['started']['scenario_id']
    assert http.get(P + '/scenarios/' + s['started']['scenario_id'] + '?version=1', headers=headers).status_code == 200
    assert http.get(P + '/map-versions/' + s['started']['map_version_id'], headers=headers).status_code == 200
    assert http.get(P + '/map-versions/' + s['started']['map_version_id'] + '/image', headers=headers).status_code == 200
    assert http.get(P + '/photos/' + photo['photo_id'], headers=headers).content == JPEG
    response = http.get(P + '/agent/scenarios/' + s['started']['scenario_id'] + '?version=1', headers={
        'authorization': 'Bearer fake-test-' + str(s['seeded']['robots']['mine'])})
    assert response.status_code == 409


def test_sim_world_hides_archived_floor_and_refuses_restart(simulation_context):
    http, _, _, rid, launcher = simulation_context
    headers = auth(http)
    _, building, floor = tree(http, headers)
    with Session(http.app.state.engine) as db:
        db.get(Building, UUID(building)).sim_world_id = 'test'
        db.commit()
    assert http.get(P + '/simulation/worlds', headers=headers).json()['worlds'][0]['id'] == 'test'
    response = http.post(P + '/simulation/robots', headers=headers, json={'world_id': 'test', 'robot_id': rid})
    assert response.status_code == 201, response.text
    with Session(http.app.state.engine) as db:
        assert db.get(Robot, UUID(rid)).sim_world_id == 'test'
    assert delete(http, headers, '/floors/' + floor).status_code == 409
    assert delete(http, headers, '/simulation/robots/' + rid).status_code == 204
    assert delete(http, headers, '/floors/' + floor).status_code == 204
    assert http.get(P + '/simulation/worlds', headers=headers).json()['worlds'] == []
    response = http.post(P + '/simulation/robots', headers=headers, json={'world_id': 'test', 'robot_id': rid})
    assert response.status_code == 409 and response.json()['error']['code'] == 'RESOURCE_ARCHIVED'

"""Waypoint editing, immutable JSONB snapshots and the actual WAIT execution input."""
import copy
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

from sqlalchemy import select

from apps.contracts import models as C
from apps.server.fh_server.models import MissionVersion, ScenarioVersion
from .test_maps import P, auth, maps
from .test_missions import setup_scenario
from .test_runs import scenario, event, save, stored
from .test_photos import CAPS, photos_record


def test_waypoint_fields_roundtrip_and_immutable_history(maps):
    client, headers, _ = maps
    body, _, _, _ = setup_scenario(client, headers)
    created = client.post(P + '/scenarios', headers=headers, json=body)
    assert created.status_code == 201, created.text
    path = P + '/scenarios/' + created.json()['id']
    body['waypoints'][0].update(name='입구 확인', wait_s=17)
    body['waypoints'][1].update(name='가' * 60, wait_s=3600)
    assert client.post(P + '/scenarios/preview', headers=headers, json=body).status_code == 200
    saved = client.put(path, headers={**headers, 'If-Match': '"1"'}, json=body)
    assert saved.status_code == 200, saved.text
    assert client.get(path, headers=headers).json()['waypoints'] == body['waypoints']
    assert client.get(path + '?version=2', headers=headers).json()['waypoints'] == body['waypoints']
    assert client.get(path + '?version=1', headers=headers).json() == created.json() | {'version': 2, 'latest_version': 2}
    assert client.get(P + '/scenarios', headers=headers).json()['items'][0]['waypoints'] == body['waypoints']
    with client.app.state.engine.connect() as conn:
        snapshots = conn.execute(select(ScenarioVersion.number, ScenarioVersion.waypoints).where(
            ScenarioVersion.scenario_id == UUID(created.json()['id'])).order_by(ScenarioVersion.number)).all()
    assert 'name' not in snapshots[0].waypoints[0] and 'wait_s' not in snapshots[0].waypoints[0]
    assert snapshots[1].waypoints == body['waypoints']
    # A fresh create and explicit clearing also use the same JSONB path.
    fresh = client.post(P + '/scenarios', headers=headers, json=body)
    assert fresh.status_code == 201 and fresh.json()['waypoints'] == body['waypoints']
    body['waypoints'][0].update(name=None, wait_s=None)
    cleared = client.put(path, headers={**headers, 'If-Match': '"2"'}, json=body)
    assert cleared.status_code == 200, cleared.text
    assert not {'name', 'wait_s'} & cleared.json()['waypoints'][0].keys()
    assert client.get(path + '?version=2', headers=headers).json()['waypoints'][0]['wait_s'] == 17


def test_invalid_point_fields_and_waitless_missions_fail_preview_create_update(maps):
    client, headers, _ = maps
    body, _, _, _ = setup_scenario(client, headers)
    created = client.post(P + '/scenarios', headers=headers, json=body).json()
    path = P + '/scenarios/' + created['id']
    invalid = [{'name': ''}, {'name': '   '}, {'name': '가' * 61}, {'name': '이름\n'},
               {'name': '이\u200b름'}, {'wait_s': 0}, {'wait_s': 3601}, {'wait_s': True},
               {'wait_s': 5.0}, {'wait_s': '5'}]
    for fields in invalid:
        changed = copy.deepcopy(body)
        changed['waypoints'][0].update(fields)
        for method, url in [('post', P + '/scenarios/preview'), ('post', P + '/scenarios'), ('put', path)]:
            response = getattr(client, method)(url, headers={**headers, 'If-Match': '"1"'}, json=changed)
            assert response.status_code == 422 and response.json()['error']['code'] == 'PRECHECK_FAILED', response.text
    # The selected historical mission version, rather than the latest, determines WAIT availability.
    mission = body['waypoints'][0]['mission_id']
    updated = client.put(P + '/missions/' + mission, headers={**headers, 'If-Match': '"1"'},
                         json={'name': '이동만', 'steps': []})
    assert updated.status_code == 200, updated.text
    body['waypoints'][0]['wait_s'] = 5
    assert client.post(P + '/scenarios/preview', headers=headers, json=body).status_code == 200
    body['waypoints'][0]['mission_version'] = 2
    for method, url in [('post', P + '/scenarios/preview'), ('post', P + '/scenarios'), ('put', path)]:
        response = getattr(client, method)(url, headers={**headers, 'If-Match': '"1"'}, json=body)
        assert response.status_code == 422, response.text
        assert response.json()['error'] == dict(code='PRECHECK_FAILED', message='이 할 일에는 대기 단계가 없습니다.',
                                              detail={'elements': ['waypoints.0.wait_s']})
    assert client.get(path, headers=headers).json()['number'] == 1


def test_wait_override_agent_payload_run_plan_and_real_step_runner(scenario, monkeypatch):
    s = scenario
    client, headers = s['client'], auth(s['client'])
    original = [{'action': 'WAIT', 'params': {'seconds': 30}}, {'action': 'WAIT', 'params': {'seconds': 9}}]
    mission = client.post(P + '/missions', headers=headers, json={'name': '두 번 대기', 'steps': original}).json()
    for point in s['body']['waypoints']:
        point.update(mission_id=mission['id'], mission_version=1)
    s['body']['waypoints'][0].update(name='입구', wait_s=5)
    s['body']['waypoints'][1].update(name='다음 지점')
    created = client.post(P + '/scenarios', headers=headers, json=s['body'])
    assert created.status_code == 201, created.text
    s['started']['scenario_id'] = created.json()['id']
    path = P + '/agent/scenarios/' + created.json()['id']
    rid = str(s['seeded']['robots']['mine'])
    bearer = {'authorization': 'Bearer fake-test-' + rid}
    legacy = client.get(path, params={'version': 1}, headers=bearer)
    assert legacy.status_code == 422 and legacy.json()['error']['code'] == 'EXECUTION_UNAVAILABLE'
    # A legacy RUN_STARTED must also fail closed, with no run history inserted.
    assert save(s, event(s))['disposition'] == 'QUARANTINE'
    assert not stored(s)
    client.app.state.realtime.agents[rid] = SimpleNamespace(closing=False,
        state={'devices': [], 'execution_capabilities': CAPS.model_dump(mode='json')})
    try:
        response = client.get(path, headers=bearer, params=dict(version=1, run_contract='scenario/2',
                                                              execution_capability_revision=7))
    finally:
        client.app.state.realtime.agents.pop(rid)
    assert response.status_code == 200, response.text
    plan = response.json()
    C.ExecutableAgentScenario.model_validate(plan)
    assert plan['waypoints'][0]['mission_steps'] == [{'action': 'WAIT', 'params': {'seconds': 5}}] * 2
    assert plan['waypoints'][1]['mission_steps'] == original
    assert all(not {'name', 'wait_s'} & point.keys() for point in plan['waypoints'])
    s['started'].update(run_contract='scenario/2', execution_capability_revision=7)
    # The prior quarantined report consumed seq=1; use a new instance for this start.
    s['instance'] = str(uuid4())
    assert photos_record(s, event(s))['t'] == 'run.recorded'
    goals = stored(s)[0].plan['segments'][0]['goals']
    assert goals[0]['mission_steps'] == plan['waypoints'][0]['mission_steps']
    assert all(not {'name', 'wait_s'} & goal.keys() for goal in goals)
    with s['factory']() as db:
        fixed_mission = db.scalar(select(MissionVersion).where(MissionVersion.mission_id == UUID(mission['id'])))
        assert fixed_mission.steps == original
    assert client.get(P + '/missions/' + mission['id'], headers=headers).json()['steps'] == original
    # Execute the server response through the unchanged agent validator and timer using a fake clock.
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / 'agent'))
    from foothold_agent.executor.scenario import plan_from_data
    from foothold_agent.executor.steps import ExecutionSupport, StepRunner
    clock = [100.]
    support = ExecutionSupport(now=lambda: clock[0])
    support.advertised = CAPS.model_dump(mode='json')
    agent_plan, _ = plan_from_data(plan, s['started'], support)
    runner = StepRunner(support, org=str(s['seeded']['org']), robot=rid, run=s['started']['run_id'],
                        waypoint=0, steps=agent_plan['segments'][0]['goals'][0]['mission_steps'], now=lambda: clock[0])
    runner.tick()
    assert runner.deadline == 105. and runner.state == 'WAITING'
    clock[0] = 104.99
    runner.tick()
    assert not runner.results
    clock[0] = 105.
    runner.tick()
    assert len(runner.results) == 1
    runner.tick()
    assert runner.deadline == 110.
    clock[0] = 110.
    runner.tick()
    assert runner.state == 'DONE'


def test_name_only_legacy_and_override_preserves_other_actions(scenario):
    s = scenario
    client, headers = s['client'], auth(s['client'])
    s['body']['waypoints'][0]['name'] = '사진 지점'
    created = client.post(P + '/scenarios', headers=headers, json=s['body'])
    assert created.status_code == 201, created.text
    path = P + '/agent/scenarios/' + created.json()['id']
    rid = str(s['seeded']['robots']['mine'])
    bearer = {'authorization': 'Bearer fake-test-' + rid}
    legacy = client.get(path, headers=bearer, params={'version': 1})
    assert legacy.status_code == 200, legacy.text
    C.ProvenAgentScenario.model_validate(legacy.json())
    assert all(not {'name', 'wait_s'} & point.keys() for point in legacy.json()['waypoints'])
    s['body']['waypoints'][0]['wait_s'] = 17
    changed = client.put(P + '/scenarios/' + created.json()['id'], json=s['body'],
                         headers={**headers, 'If-Match': '"1"'})
    assert changed.status_code == 200, changed.text
    client.app.state.realtime.agents[rid] = SimpleNamespace(closing=False, state={
        'devices': [{'kind': 'CAMERA_RGB', 'state': 'OK'}],
        'execution_capabilities': CAPS.model_dump(mode='json')})
    try:
        response = client.get(path, headers=bearer, params=dict(version=2, run_contract='scenario/2',
                                                              execution_capability_revision=7))
    finally:
        client.app.state.realtime.agents.pop(rid)
    assert response.status_code == 200, response.text
    points = response.json()['waypoints']
    assert points[0]['mission_steps'] == [{'action': 'PHOTO', 'params': {'camera': 'rgb'}},
                                        {'action': 'WAIT', 'params': {'seconds': 17}}]
    assert points[1]['mission_steps'] == [{'action': 'PHOTO', 'params': {'camera': 'rgb'}},
                                        {'action': 'WAIT', 'params': {'seconds': 5}}]
    assert all(not {'name', 'wait_s'} & point.keys() for point in points)

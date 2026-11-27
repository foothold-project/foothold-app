"""일정 칸 · 기간 가용 · 예상 시간 (app-design-lx 11/28 합의 계약)."""
from types import SimpleNamespace

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from apps.server.fh_server.models import Event
from .test_maps import P, auth, maps, tree, upload, save  # noqa: F401  (maps 는 fixture)

SEOUL_LATE = ('2026-11-28T14:30:00Z', '2026-11-28T15:30:00Z')  # 서울 28일 23:30 ~ 29일 00:30


def scenario(http, admin, points=((.1, .1),), steps=(({'action': 'WAIT', 'params': {'seconds': 1}},),), **extra):
    _, _, floor = tree(http, admin)
    version = save(http, admin, floor, upload(http, admin)).json()
    waypoints = []
    for (x, y), mission_steps, more in zip(points, steps, extra.get('waypoint_extra', [{}] * len(points))):
        mission = http.post(P + '/missions', headers=admin, json={'name': '할 일', 'steps': list(mission_steps)})
        assert mission.status_code == 201, mission.text
        waypoints.append({'floor_id': floor, 'map_version_id': version['id'], 'x': x, 'y': y, 'yaw': 0,
                          'mission_id': mission.json()['id'], 'mission_version': 1, **more})
    response = http.post(P + '/scenarios', headers=admin, json={'name': '시험 순찰', 'waypoints': waypoints, 'notes': ''})
    assert response.status_code == 201, response.text
    return response.json()


def slot(http, headers, robot, start, end, value=None, kind='CONFIRMED', **kwargs):
    body = {'robot_id': str(robot), 'start': start, 'end': end, 'kind': kind, **kwargs}
    if value is not None:
        body.update(scenario_id=value['id'], scenario_version=value['number'])
    return http.post(P + '/schedule/slots', headers=headers, json=body)


def day(http, headers, value, tz):
    response = http.get(P + '/schedule', headers=headers, params={'day': value, 'tz': tz})
    assert response.status_code == 200, response.text
    return response.json()


def online(http, robot, soc):
    rt = http.app.state.realtime
    rt.agents[str(robot)] = SimpleNamespace(closing=False, state_received_at=rt.clock(), socket=None,
        state={'battery': {'soc': soc, 'updated_at': '2026-11-28T00:00:00Z'}, 'devices': [], 'status': 'IDLE'})


def test_create_day_boundary_conflict_and_permissions(maps, seeded):
    http, admin, _ = maps
    value = scenario(http, admin)
    one, two = auth(http, 'one'), auth(http, 'two')
    mine, theirs = seeded['robots']['mine'], seeded['robots']['theirs']
    first = slot(http, one, mine, *SEOUL_LATE, value, gait='sport', memo='밤 순찰')
    assert first.status_code == 201, first.text
    first = first.json()
    assert first['start'] == '2026-11-28T14:30:00Z' and first['gait'] == 'sport' and first['assignment_id'] is None
    assert first['scenario_version'] == 1 and first['created_by'] == str(seeded['users']['one'])
    # 서울 29일 00:00 에 시작하는 칸은 서울 28일에 들지 않는다 (반열린 구간).
    midnight = slot(http, admin, theirs, '2026-11-28T15:00:00Z', '2026-11-28T16:00:00Z', kind='BATTERY_SWAP')
    assert midnight.status_code == 201, midnight.text
    assert midnight.json()['scenario_id'] is None
    ids = lambda body: [s['id'] for s in body['slots']]
    seoul28 = day(http, two, '2026-11-28', 'Asia/Seoul')
    assert seoul28['day'] == '2026-11-28' and seoul28['tz'] == 'Asia/Seoul' and ids(seoul28) == [first['id']]
    assert ids(day(http, two, '2026-11-29', 'Asia/Seoul')) == [first['id'], midnight.json()['id']]
    assert ids(day(http, two, '2026-11-28', 'UTC')) == [first['id'], midnight.json()['id']]
    assert ids(day(http, two, '2026-11-29', 'UTC')) == []
    assert http.get(P + '/schedule', headers=two, params={'day': '2026-11-28', 'tz': 'Mars/Base'}).status_code == 400
    assert http.get(P + '/schedule', headers=two, params={'tz': 'UTC'}).status_code == 400
    # 같은 로봇 겹침은 409 와 겹친 칸 id. 끝과 시작이 맞닿는 칸은 겹침이 아니다.
    clash = slot(http, admin, mine, '2026-11-28T15:00:00Z', '2026-11-28T17:00:00Z', value, kind='DRAFT')
    assert clash.status_code == 409
    assert clash.json()['error']['code'] == 'SCHEDULE_CONFLICT'
    assert clash.json()['error']['detail'] == {'slot_ids': [first['id']]}
    touching = slot(http, admin, mine, '2026-11-28T15:30:00Z', '2026-11-28T16:00:00Z', value, kind='DRAFT')
    assert touching.status_code == 201, touching.text
    # 권한: 담당 아닌 운영자 403, 다른 조직 로봇 404, 형식 오류 400.
    assert slot(http, two, mine, '2026-11-30T00:00:00Z', '2026-11-30T01:00:00Z', value).status_code == 403
    assert slot(http, admin, seeded['robots']['foreign'], '2026-11-30T00:00:00Z', '2026-11-30T01:00:00Z', value).status_code == 404
    assert slot(http, admin, mine, '2026-11-30T01:00:00Z', '2026-11-30T00:00:00Z', value).status_code == 400
    assert slot(http, admin, mine, '2026-11-30T00:00:00Z', '2026-11-30T01:00:00Z').status_code == 400  # 시나리오 없는 CONFIRMED
    assert slot(http, admin, mine, '2026-11-30T00:00', '2026-11-30T01:00:00Z', value).status_code == 400  # 시간대 없음
    assert slot(http, admin, mine, '2026-11-30T00:00:00Z', '2026-11-30T01:00:00Z', {'id': value['id'], 'number': 9}).status_code == 404
    engine = create_engine(seeded['urls']['migrate'])
    with Session(engine) as db:
        codes = db.scalars(select(Event.code).where(Event.code.like('SCHEDULE_%'))).all()
    engine.dispose()
    assert codes.count('SCHEDULE_SLOT_CREATED') == 3


def test_patch_move_reassign_and_delete(maps, seeded):
    http, admin, _ = maps
    value = scenario(http, admin)
    one = auth(http, 'one')
    mine, theirs = seeded['robots']['mine'], seeded['robots']['theirs']
    a = slot(http, one, mine, '2026-12-01T01:00:00Z', '2026-12-01T02:00:00Z', value).json()
    b = slot(http, admin, theirs, '2026-12-01T03:00:00Z', '2026-12-01T04:00:00Z', value).json()
    path = P + '/schedule/slots/' + a['id']
    moved = http.patch(path, headers=one, json={'start': '2026-12-01T05:00:00Z', 'end': '2026-12-01T06:00:00Z', 'gait': 'classic'})
    assert moved.status_code == 200, moved.text
    assert moved.json()['start'] == '2026-12-01T05:00:00Z' and moved.json()['gait'] == 'classic'
    assert moved.json()['robot_id'] == str(mine) and moved.json()['kind'] == 'CONFIRMED'
    # 담당 운영자는 남의 로봇으로 옮길 수 없다. 총괄은 옮긴다. 옮긴 뒤 겹치면 409.
    assert http.patch(path, headers=one, json={'robot_id': str(theirs)}).status_code == 403
    clash = http.patch(path, headers=admin, json={'robot_id': str(theirs), 'start': '2026-12-01T03:30:00Z'})
    assert clash.status_code == 409 and clash.json()['error']['detail'] == {'slot_ids': [b['id']]}
    reassigned = http.patch(path, headers=admin, json={'robot_id': str(theirs)})
    assert reassigned.status_code == 200 and reassigned.json()['robot_id'] == str(theirs)
    assert http.patch(path, headers=one, json={'start': '2026-12-01T05:10:00Z'}).status_code == 403
    assert http.patch(path, headers=admin, json={'gait': None}).status_code == 400
    assert http.patch(path, headers=admin, json={'start': '2026-12-01T07:00:00Z'}).status_code == 400  # 끝보다 뒤
    swap = slot(http, admin, mine, '2026-12-02T00:00:00Z', '2026-12-02T00:30:00Z', kind='BATTERY_SWAP').json()
    assert http.patch(P + '/schedule/slots/' + swap['id'], headers=admin, json={'kind': 'CONFIRMED'}).status_code == 400
    assert http.delete(path, headers=one).status_code == 403
    assert http.delete(path, headers=admin).status_code == 204
    assert http.delete(path, headers=admin).status_code == 404
    assert http.patch(path, headers=admin, json={'kind': 'DRAFT'}).status_code == 404
    assert [s['id'] for s in day(http, admin, '2026-12-01', 'UTC')['slots']] == [b['id']]


def test_availability_states(maps, seeded):
    http, admin, _ = maps
    value = scenario(http, admin)
    mine, theirs = seeded['robots']['mine'], seeded['robots']['theirs']
    busy = slot(http, admin, mine, '2026-12-01T01:00:00Z', '2026-12-01T02:00:00Z', value).json()
    later = slot(http, admin, mine, '2026-12-01T02:00:00Z', '2026-12-01T02:30:00Z', kind='BATTERY_SWAP').json()
    online(http, theirs, 80)
    query = {'start': '2026-12-01T01:30:00Z', 'end': '2026-12-01T02:15:00Z'}
    response = http.get(P + '/robots/availability', headers=admin, params=query)
    assert response.status_code == 200, response.text
    items = {i['robot_name']: i for i in response.json()['items']}
    assert set(items) == {'mine', 'theirs'}  # 다른 조직 로봇은 없다
    assert items['mine']['state'] == 'BUSY' and items['mine']['busy_slot_id'] == later['id']
    assert items['mine']['busy_until'] == '2026-12-01T02:30:00Z' and items['mine']['busy_label'] == '배터리 교체'
    assert items['theirs'] == {'robot_id': str(theirs), 'robot_name': 'theirs', 'state': 'FREE', 'busy_until': None,
        'busy_slot_id': None, 'busy_label': None, 'battery_pct': 80.0, 'demo': False, 'sim': False, 'location_label': None}
    early = http.get(P + '/robots/availability', headers=admin,
        params={'start': '2026-12-01T00:00:00Z', 'end': '2026-12-01T01:30:00Z'}).json()['items']
    early = {i['robot_name']: i for i in early}
    assert early['mine']['busy_slot_id'] == busy['id'] and early['mine']['busy_label'] == '시험 순찰'
    free = {i['robot_name']: i['state'] for i in http.get(P + '/robots/availability', headers=admin,
        params={'start': '2026-12-02T00:00:00Z', 'end': '2026-12-02T01:00:00Z'}).json()['items']}
    assert free == {'mine': 'OFFLINE', 'theirs': 'FREE'}
    # 담당 아닌 운영자에게는 연결 · 배터리를 가린다 (로봇 요약과 같은 규칙).
    one = {i['robot_name']: i for i in http.get(P + '/robots/availability', headers=auth(http, 'one'),
        params={'start': '2026-12-02T00:00:00Z', 'end': '2026-12-02T01:00:00Z'}).json()['items']}
    assert one['theirs']['battery_pct'] is None and one['theirs']['state'] == 'FREE' and one['mine']['state'] == 'OFFLINE'
    assert http.get(P + '/robots/availability', headers=admin,
        params={'start': '2026-12-02T01:00:00Z', 'end': '2026-12-02T01:00:00Z'}).status_code == 400
    assert http.get(P + '/robots/availability', headers=admin,
        params={'start': '2026-12-02T01:00:00', 'end': '2026-12-02T02:00:00Z'}).status_code == 400


def test_estimate_math_on_known_path(maps, seeded):
    http, admin, _ = maps
    # (0.1, 0.1) -> (1.3, 1.7): 직선 2.0 m. 할 일: 대기 (지점 wait_s 3 초가 임무 1 초를 덮음) + 사진 고정 5 초.
    value = scenario(http, admin, points=((.1, .1), (1.3, 1.7)),
        steps=(({'action': 'WAIT', 'params': {'seconds': 1}},), ({'action': 'PHOTO', 'params': {'camera': 'rgb'}},)),
        waypoint_extra=[{'wait_s': 3}, {}])
    assert abs(value['est_distance_m'] - 2.0) < 1e-9
    mine = seeded['robots']['mine']
    online(http, mine, 50)
    slot(http, admin, mine, '2026-12-01T00:01:00Z', '2026-12-01T00:02:00Z', value)
    body = {'scenario_id': value['id'], 'robot_id': str(mine), 'gait': 'classic', 'start': '2026-12-01T00:00:00Z'}
    response = http.post(P + '/estimates', headers=admin, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    # classic 미실측 표: 0.4 m/s, 0.8 %/분. 걷기 5 초 + 할 일 8 초 = 13 초.
    assert abs(result['length_m'] - 2.0) < 1e-9 and abs(result['walk_s'] - 5.0) < 1e-9 and result['task_s'] == 8.0
    assert result['eta'] == '2026-12-01T00:00:13Z' and abs(result['margin_s'] - 47.0) < 1e-6
    assert abs(result['end_battery_pct'] - (50 - 0.8 * 13 / 60)) < 1e-9
    assert result['estimate_source'] == 'TABLE_UNMEASURED'
    sport = http.post(P + '/estimates', headers=admin, json={**body, 'gait': 'sport', 'scenario_version': 1,
        'start': '2026-12-01T00:03:00Z'}).json()
    assert abs(sport['walk_s'] - 2.5) < 1e-9 and sport['margin_s'] is None
    assert http.post(P + '/estimates', headers=admin, json={**body, 'scenario_version': 7}).status_code == 404
    assert http.post(P + '/estimates', headers=admin, json={**body, 'gait': 'run'}).status_code == 400
    two = http.post(P + '/estimates', headers=auth(http, 'two'), json=body).json()
    assert two['end_battery_pct'] is None and two['task_s'] == 8.0

"""팀장 11/22: 넘어짐 · 일어서기는 긴급 기록으로 남기고 사용자에게 알린다 (시뮬 페이지 → SAFETY 사건 + 알림)."""
from .conftest import login

P = '/api/v1'
BODY = {'phase': 'FALL', 'cause': '시험 단추', 'map': 'warehouse', 'policy': 'start-demo', 'start_map': 'gt',
        'pos': [1.0, 2.0, 0.1], 'yaw': 0.5, 'grav_z': 0.99, 'height': 0.1, 'attempts': 0,
        'cmd_last': [0.0, 0.0, 0.0], 'cmd_peak': [1.5, 0.0, 0.0], 'sim_t': 5.6}


def headers(client, user):
    result = login(client, user)
    assert result.status_code == 200, result.text
    return {'X-FH-CSRF': result.json()['csrf_token']}


def test_sim_fall_records_safety_event_and_notifies(client):
    h = headers(client, 'one')
    assert client.post(P + '/simulation/falls', headers=h, json=BODY).status_code == 204
    assert client.post(P + '/simulation/falls', headers=h, json={**BODY, 'phase': 'RECOVERED', 'attempts': 1}).status_code == 204
    assert client.post(P + '/simulation/falls', headers=h, json={**BODY, 'phase': 'BOOM'}).status_code == 400
    events = client.get(P + '/events', params={'category': 'SAFETY'}).json()['items']
    codes = [e['code'] for e in events]
    assert 'ROBOT_FALL' in codes and 'ROBOT_FALL_RECOVERED' in codes
    fall = next(e for e in events if e['code'] == 'ROBOT_FALL')
    assert fall['severity'] == 'ERROR' and '넘어졌습니다 (시험 단추)' in fall['message'] and fall['data']['simulation'] is True
    mine = client.get(P + '/notifications').json()['items']
    assert [n['title'] for n in mine if n['kind'] == 'ROBOT_FALL'] == ['다시 섬', '넘어짐']
    client.post(P + '/auth/logout', headers=h)
    headers(client, 'admin')
    assert any(n['kind'] == 'ROBOT_FALL' for n in client.get(P + '/notifications').json()['items'])

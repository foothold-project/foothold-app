"""S5a actual uvicorn HTTP, synthetic map -> two missions -> 3 points/2 floors."""
from concurrent.futures import ThreadPoolExecutor

import httpx
from .test_maps import P, auth
from .test_missions import setup_scenario
from .ws_process import server_process


def test_uvicorn_two_floor_scenario_new_version_archive(seeded, tmp_path, monkeypatch):
    monkeypatch.setenv('FH_FILES_ROOT', str(tmp_path / 'files'))
    with server_process(seeded, tmp_path) as server:
        with httpx.Client(base_url=server['base'].replace('ws://', 'http://'), timeout=15) as http:
            admin = auth(http)
            operator = auth(http, 'one')
            body, floors, versions, _ = setup_scenario(http, admin)
            # The creator is O; A supplied approved synthetic maps/missions.
            checked = http.post(P + '/scenarios/preview', headers=operator, json=body)
            assert checked.status_code == 200 and checked.json()['reachable'], checked.text
            assert checked.json()['est_distance_m'] == 1.3
            created = http.post(P + '/scenarios', headers=operator, json=body)
            assert created.status_code == 201 and created.headers['etag'] == '"1"', created.text
            identifier = created.json()['id']
            path = P + '/scenarios/' + identifier
            body['notes'] = 'HTTP 새 판'
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda _: http.put(path, headers={**operator, 'If-Match': '"1"'}, json=body), range(2)))
            assert sorted(r.status_code for r in responses) == [200, 409]
            current = http.get(path, headers=operator)
            assert current.headers['etag'] == '"2"' and current.json()['number'] == 2
            assert current.json()['notes'] == 'HTTP 새 판' and len(current.json()['waypoints']) == 3
            assert http.get(path + '?version=1', headers=admin).json()['notes'] == '합성 시험'
            for point in body['waypoints']:
                mission_path = P + '/missions/' + point['mission_id']
                assert http.delete(mission_path, headers=admin).status_code == 204
            assert http.get(path + '?version=1', headers=operator).status_code == 200
            assert http.delete(path, headers=operator).status_code == 204
            assert http.get(P + '/scenarios?mine=1', headers=operator).json()['items'] == []
            assert http.get(path + '?version=1', headers=operator).json()['archived_at']
            rows = http.get(P + '/events', headers=operator).json()['items']
            assert {'SCENARIO_CREATED', 'SCENARIO_VERSION_CREATED', 'SCENARIO_ARCHIVED'} <= {r['code'] for r in rows}
            assert http.get(P + '/notifications', headers=operator).json()['items'] == []
            print('S5a uvicorn: map upload -> two missions -> two floors / 3 points -> concurrent new version -> archive -> old version: PASS')

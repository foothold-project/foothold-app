"""Legacy requests over actual uvicorn/HTTP: admin decisions, durable inbox."""
import httpx
from .test_maps import P, PGM, YAML
from .ws_process import server_process
from .legacy_approvals import pending_map


def test_legacy_pending_admin_list_approve_tree_reject_operator_notification(seeded, tmp_path, monkeypatch):
    monkeypatch.setenv('FH_FILES_ROOT', str(tmp_path / 'files'))
    with server_process(seeded, tmp_path) as server:
        base = server['base'].replace('ws://', 'http://') + P
        with httpx.Client(base_url=base, timeout=10) as http:
            def login(name):
                response = http.post('/auth/login', json={'username': name, 'password': 'fake-test-password', 'client': 'app'})
                assert response.status_code == 200
                return {'authorization': 'Bearer ' + response.json()['access_token']}
            admin, operator = login('admin'), login('one')
            site = http.post('/sites', headers=admin, json={'name': '합성 결재 장소'}).json()['id']
            building = http.post(f'/sites/{site}/buildings', headers=admin, json={'name': '합성 건물'}).json()['id']
            floor = http.post(f'/buildings/{building}/floors', headers=admin, json={'name': '1층', 'level': 1}).json()['id']
            image = http.post('/uploads', headers={**operator, 'content-type': 'image/x-portable-graymap'}, content=PGM).json()['upload_id']
            image = http.post('/uploads', params={'image': image}, headers={**operator, 'content-type': 'text/yaml'}, content=YAML).json()['upload_id']
            def request(base):
                with httpx.Client(base_url=server['base'].replace('ws://', 'http://'), timeout=10) as legacy:
                    return pending_map(legacy, operator, floor, image, base, database_url=seeded['urls']['migrate'])
            version, row = request(None)
            response = http.post(f'/approvals/{row["id"]}/approve', headers=admin, json={})
            assert response.status_code == 200 and response.json()['status'] == 'APPROVED', response.text
            tree = http.get('/sites', headers=operator).json()['items'][0]['buildings'][0]['floors'][0]
            assert tree['approved_version_id'] == version['id'] and tree['pending_count'] == 0
            rejected, row = request(version['id'])
            response = http.post(f'/approvals/{row["id"]}/reject', headers=admin, json={'reason': '현장 경계 재확인'})
            assert response.status_code == 200 and response.json()['status'] == 'REJECTED'
            notices = http.get('/notifications', headers=operator).json()
            assert notices['unread_count'] == 2 and len(notices['items']) == 2
            assert row['id'] in notices['items'][0]['link'] and '반려' in notices['items'][0]['body']
            assert http.get(f'/approvals/{row["id"]}', headers=operator).json()['decision_comment'] == '현장 경계 재확인'
            assert http.get(f'/map-versions/{rejected["id"]}', headers=operator).json()['status'] == 'REJECTED'
            assert http.get('/dashboard', headers=admin).json()['approvals_pending'] == 0
            print('S4a uvicorn: O save -> A list -> approve -> tree pointer / O save -> A reject -> O inbox: PASS')

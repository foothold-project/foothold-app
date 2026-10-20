"""One actual uvicorn flow: synthetic map only, private DB and loopback port."""
import hashlib
import httpx
from .test_maps import PGM, YAML, FEATURES, P
from .ws_process import server_process


def test_maps_create_upload_approve_tree_image_over_uvicorn(seeded, tmp_path, monkeypatch):
    monkeypatch.setenv('FH_FILES_ROOT', str(tmp_path / 'files'))
    with server_process(seeded, tmp_path) as server:
        base = server['base'].replace('ws://', 'http://') + P
        with httpx.Client(base_url=base, timeout=10) as http:
            response = http.post('/auth/login', json={'username': 'admin', 'password': 'fake-test-password', 'client': 'app'})
            assert response.status_code == 200
            http.headers['authorization'] = 'Bearer ' + response.json()['access_token']
            response = http.post('/sites', json={'name': '합성 통합 장소'})
            assert response.status_code == 201, response.text
            response = http.post(f'/sites/{response.json()["id"]}/buildings', json={'name': '합성 건물'})
            assert response.status_code == 201, response.text
            response = http.post(f'/buildings/{response.json()["id"]}/floors', json={'name': '1층', 'level': 1})
            assert response.status_code == 201, response.text
            floor = response.json()['id']
            response = http.post('/uploads', content=PGM, headers={'content-type': 'image/x-portable-graymap'})
            assert response.status_code == 201, response.text
            response = http.post('/uploads', params={'image': response.json()['upload_id']}, content=YAML, headers={'content-type': 'text/yaml'})
            assert response.status_code == 201, response.text
            response = http.post(f'/floors/{floor}/map-versions', json={'base_version_id': None,
                'image': response.json()['upload_id'], 'features': FEATURES, 'reason': '가짜 지도 실서버 검증'})
            assert response.status_code == 201, response.text
            version = response.json()
            tree = http.get('/sites').json()['items']
            assert tree[0]['buildings'][0]['floors'][0]['approved_version_id'] == version['id']
            response = http.get(f'/map-versions/{version["id"]}/image')
            assert response.status_code == 200 and response.headers['content-type'] == 'image/png'
            assert hashlib.sha256(response.content).hexdigest() == version['image_sha256']
            print('S3a uvicorn: site -> building -> floor -> raw PGM -> raw YAML -> approved version -> tree pointer -> PNG: PASS')

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
            second = http.post(f'/floors/{floor}/map-versions', json={'base_version_id': version['id'],
                'image': version['upload_id'], 'features': {**FEATURES, 'waypoints': [
                    {'id': 'wire-point', 'name': '합성 지점', 'x': 1, 'y': 1, 'yaw': 0}]}, 'reason': '두 번째 판'})
            assert second.status_code == 201, second.text
            diff = http.get(f'/map-versions/{second.json()["id"]}/diff')
            assert diff.status_code == 200 and diff.json()['image_changed'] is False
            assert diff.json()['changes'][0]['change'] == 'added'
            restored = http.post(f'/map-versions/{version["id"]}/rollback', json={
                'base_version_id': second.json()['id'], 'reason': '실서버 복원 시험'})
            assert restored.status_code == 201, restored.text
            new = restored.json()
            assert new['id'] not in (version['id'], second.json()['id']) and new['number'] == 3
            assert new['features'] == FEATURES and new['copied_from_id'] == version['id']
            tree = http.get('/sites').json()['items']
            assert tree[0]['buildings'][0]['floors'][0]['approved_version_id'] == new['id']
            print('S3b uvicorn: two versions -> diff -> rollback version 1 to new version 3 -> tree pointer: PASS')
            print('S3a uvicorn: site -> building -> floor -> raw PGM -> raw YAML -> approved version -> tree pointer -> PNG: PASS')


def test_slow_upload_does_not_block_writes_and_has_total_deadline(seeded, tmp_path, monkeypatch):
    import asyncio
    from urllib.parse import urlparse
    monkeypatch.setenv('FH_FILES_ROOT', str(tmp_path / 'files'))
    async def check(server):
        parsed = urlparse(server['base'])
        base = server['base'].replace('ws://', 'http://') + P
        async with httpx.AsyncClient(base_url=base, timeout=1) as http:
            admin = await http.post('/auth/login', json={'username': 'admin', 'password': 'fake-test-password', 'client': 'app'})
            admin_headers = {'authorization': 'Bearer ' + admin.json()['access_token']}
            reader, writer = await asyncio.open_connection('127.0.0.1', parsed.port)
            try:
                writer.write((f'POST /api/v1/uploads HTTP/1.1\r\nHost: 127.0.0.1:{parsed.port}\r\n'
                    f'Authorization: Bearer {server["access"]}\r\nContent-Type: image/png\r\n'
                    'Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n8\r\n').encode() + b'\x89PNG\r\n\x1a\n\r\n')
                await writer.drain()
                # Give the server time to authenticate and begin waiting for the body.
                await asyncio.sleep(.1)
                try:
                    response = await http.post('/sites', headers=admin_headers, json={'name': '느린 업로드 중 생성'})
                except httpx.TimeoutException:
                    __import__('pytest').fail('organization write blocked by slow upload')
                assert response.status_code == 201
                # Never send another chunk: timeout is for the entire receive, not
                # merely a check between chunks. It must respond before EOF.
                try:
                    header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 3)
                except TimeoutError:
                    __import__('pytest').fail('upload has no total receive deadline')
                body = await reader.read()
                assert header.startswith(b'HTTP/1.1 408 ') and b'UPLOAD_TIMEOUT' in body
            finally:
                writer.close()
                await writer.wait_closed()
    with server_process(seeded, tmp_path, app_target='apps.server.tests.maps_review_app:app') as server:
        asyncio.run(check(server))

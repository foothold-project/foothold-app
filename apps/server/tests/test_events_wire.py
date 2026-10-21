"""S2 one real uvicorn round trip, fake agent only, constrained loopback port."""
import asyncio
import csv
import io
import json

import httpx
from websockets.asyncio.client import connect
from .ws_process import server_process


def test_events_filter_csv_and_notification_read_over_uvicorn(seeded, tmp_path):
    async def check(server):
        base = server['base'].replace('ws://', 'http://') + '/api/v1'
        rid = str(seeded['robots']['mine'])
        headers = {'authorization': 'Bearer ' + server['access']}
        async with httpx.AsyncClient(base_url=base) as http:
            async with connect(server['base'] + '/api/v1/agent/ws', proxy=None,
                additional_headers={'authorization': 'Bearer ' + server['agent_token']}) as agent:
                await agent.send(json.dumps(dict(t='hello', proto='fh-agent/2', agent_version='fake-S2',
                    robot_model='fake', firmware=None, devices=[], map_versions=[], last_floor_id=None,
                    latched=True, stop_gen=1, lease_id=None, run=None)))
                await agent.send(json.dumps(dict(t='event', code='ROUTE_DEVIATION', severity='warn',
                    robot_at='2026-10-19T05:02:00Z', data={'distance_m': 1.8})))
                async with asyncio.timeout(5):
                    while True:
                        response = await http.get('/events', headers=headers, params={'robot_id': rid, 'category': 'ROUTE', 'severity': 'WARN'})
                        assert response.status_code == 200
                        events = response.json()['items']
                        if events:
                            break
                        await asyncio.sleep(.02)
                assert len(events) == 1 and events[0]['code'] == 'ROUTE_DEVIATION'
                assert '1.8 m 벗어났습니다.' in events[0]['message']
                assert events[0]['robot_at'] == '2026-10-19T05:02:00Z'
                exported = await http.get('/events/export.csv', headers=headers,
                    params={'robot_id': rid, 'category': 'ROUTE', 'severity': 'WARN'})
                assert exported.status_code == 200
                csv_rows = list(csv.DictReader(io.StringIO(exported.content.decode('utf-8-sig'))))
                assert [row['id'] for row in csv_rows] == [events[0]['id']]
                assert csv_rows[0]['message'] == events[0]['message']
                response = await http.get('/notifications?unread=1', headers=headers)
                assert response.status_code == 200
                notices = response.json()
                assert notices['unread_count'] == 1 and notices['items'][0]['event_id'] == events[0]['id']
                response = await http.post('/notifications/read', headers=headers,
                    json={'ids': [notices['items'][0]['id']]})
                assert response.status_code == 204
                assert (await http.get('/notifications?unread=1', headers=headers)).json()['unread_count'] == 0
                print('S2 uvicorn: fake agent event -> filtered persisted sentence -> same CSV -> own inbox/read: PASS')
    with server_process(seeded, tmp_path) as server:
        asyncio.run(check(server))


def test_stalled_csv_body_only_blocks_same_user_over_real_uvicorn(seeded, tmp_path):
    import os
    import socket
    import struct
    import time
    from urllib.parse import urlparse
    from sqlalchemy import create_engine, insert
    from apps.server.fh_server.models import Event

    engine = create_engine(seeded['urls']['migrate'])
    try:
        with engine.begin() as connection:
            # >28 MB: exceeds the kernel send buffer without reading the CSV body.
            for offset in range(0, 9000, 500):
                connection.execute(insert(Event), [dict(org_id=seeded['org'],
                    robot_id=seeded['robots']['mine'], user_id=seeded['users']['one'],
                    code='LOGIN', category='ACCOUNT', severity='INFO', message='가짜 대용량 기록',
                    data={'padding': 'x' * 3072, 'row': row}) for row in range(offset, offset + 500)])
    finally:
        engine.dispose()
    with server_process(seeded, tmp_path) as server:
        parsed = urlparse(server['base'])
        if os.environ.get('FH_TEST_PORT_RANGE'):
            first_port, last_port = map(int, os.environ['FH_TEST_PORT_RANGE'].split(':'))
            assert first_port <= parsed.port <= last_port
        base = server['base'].replace('ws://', 'http://') + '/api/v1'
        one = {'authorization': 'Bearer ' + server['access']}
        with httpx.Client(base_url=base, timeout=12) as http:
            response = http.post('/auth/login', json={'username': 'admin',
                'password': 'fake-test-password', 'client': 'app'})
            assert response.status_code == 200
            admin = {'authorization': 'Bearer ' + response.json()['access_token']}
            with socket.socket() as stalled:
                stalled.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
                stalled.settimeout(12)
                stalled.connect(('127.0.0.1', parsed.port))
                stalled.sendall((f'GET /api/v1/events/export.csv HTTP/1.1\r\nHost: 127.0.0.1:{parsed.port}\r\n'
                    f'Authorization: Bearer {server["access"]}\r\nConnection: close\r\n\r\n').encode())
                headers = b''
                while not headers.endswith(b'\r\n\r\n'):
                    chunk = stalled.recv(1)
                    assert chunk, 'server closed before CSV headers'
                    headers += chunk
                    assert len(headers) < 8192
                assert headers.startswith(b'HTTP/1.1 200 ')
                # Read headers only, keeping the first body entirely unread.
                duplicate = http.get('/events/export.csv', headers=one)
                assert duplicate.status_code == 429 and duplicate.json()['error']['code'] == 'RATE_LIMITED'
                with http.stream('GET', '/events/export.csv', headers=admin) as other:
                    assert other.status_code == 200
                    count = sum(len(chunk) for chunk in other.iter_bytes())
                assert count > 28_000_000
                assert http.get('/events/export.csv', headers=one).status_code == 429
                # Reset the stalled connection and verify its per-user file is reclaimed.
                stalled.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
            deadline = time.monotonic() + 5
            while True:
                resumed = http.get('/events/export.csv?category=RUN', headers=one)
                if resumed.status_code == 200:
                    break
                assert resumed.status_code == 429
                assert time.monotonic() < deadline, 'download file lease was not reclaimed after RST'
                time.sleep(.01)
            print(f'S2 real uvicorn:{parsed.port}: 9000 rows, unread first body -> same user429, other user200/{count} bytes, RST -> same user200: PASS')

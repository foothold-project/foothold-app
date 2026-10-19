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

"""배터리 남은 분 (11/28): 에이전트 AgentBattery.minutes_left -> RobotSummary.battery · ScreenState.battery. 실제 uvicorn + Client."""
import asyncio
import json
import sys
from pathlib import Path
from uuid import uuid4

import httpx
from websockets.asyncio.client import connect

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent'))

from .ws_process import server_process


def test_minutes_left_reaches_summary_and_screen_and_old_agent_reads_null(seeded, tmp_path):
    from foothold_agent.link.client import Client, Settings
    from foothold_agent.link.session import Session

    async def check(server):
        class Agent(Session):
            battery = {'soc': 73, 'minutes_left': 41}

            def _state(self):
                return {**super()._state(), 'battery': dict(self.battery)}

        class Sink:
            def apply(self, command):
                pass

        base = server['base'].replace('ws://', 'http://') + '/api/v1'
        async with httpx.AsyncClient(base_url=base) as http:
            response = await http.post('/auth/login', json=dict(username='one', password='fake-test-password', client='app'))
            operator = {'authorization': 'Bearer ' + response.json()['access_token']}
            from .pairing_helpers import paired_async
            created = await paired_async(http, operator, prefix='', name='minutes-robot')
            rid = created['robot']['id']
            session = Agent(identity={'devices': []})
            task = asyncio.create_task(Client(session, Sink(), Settings(server['base'] + '/api/v1/agent/ws', created['agent_token'])).run())

            async def summary(predicate):
                async with asyncio.timeout(5):
                    while True:
                        assert not task.done(), repr(task.exception())
                        detail = (await http.get('/robots/' + rid, headers=operator)).json()
                        if detail['battery'] and predicate(detail['battery']):
                            return detail['battery']
                        await asyncio.sleep(.01)
            try:
                assert (await summary(lambda b: True))['minutes_left'] == 41
                async with connect(server['base'] + '/api/v1/ws', additional_headers=operator, proxy=None) as ws:
                    await ws.send(json.dumps(dict(t='sub', id=str(uuid4()), proto='fh-rt/1', robots=[rid], streams=['state'])))
                    async with asyncio.timeout(5):
                        while True:
                            body = json.loads(await ws.recv())
                            body = body.get('_delivery', body)
                            if body.get('t') == 'state' and body.get('battery'):
                                break
                    assert body['battery']['minutes_left'] == 41 and body['battery']['soc'] == 73
                session.battery = {'soc': 70}  # 옛 에이전트: 칸 없음 -> null
                old = await summary(lambda b: b['soc'] == 70)
                assert old['minutes_left'] is None
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    with server_process(seeded, tmp_path) as server:
        asyncio.run(check(server))

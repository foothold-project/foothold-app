"""S1 real uvicorn + production Client with a synthetic, ROS-free local sink."""
import asyncio
import json
import sys
from pathlib import Path
from uuid import uuid4

import httpx
from websockets.asyncio.client import connect

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent'))

from .ws_process import server_process
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as DBSession
from uuid import UUID
from apps.server.fh_server.models import Robot


def test_registration_real_client_dashboard_reassignment_stop_and_delete(seeded, tmp_path):
    from foothold_agent.link.client import Client, ReconnectForbidden, Settings
    from foothold_agent.link.session import Session

    async def check(server):
        class FakeTelemetrySession(Session):
            def __init__(self):
                super().__init__(identity={'devices': [dict(key='rgb', kind='CAMERA_RGB',
                    label='가짜 카메라', state='OK')]})
                self.frames = []

            def _state(self):
                state = super()._state()
                state.update(battery={'soc': 73}, pose=dict(floor_id=None, x=2.5, y=1.2,
                    yaw=.4, confidence=.9))
                return state

            def receive(self, frame):
                body = json.loads(frame) if isinstance(frame, (str, bytes)) else frame
                self.frames.append(body)
                return super().receive(frame)

        class Sink:
            def __init__(self):
                self.outputs = []
            def apply(self, command):
                self.outputs.append(command)

        base = server['base'].replace('ws://', 'http://') + '/api/v1'
        async with httpx.AsyncClient(base_url=base) as http:
            async def login(name):
                response = await http.post('/auth/login', json=dict(username=name,
                    password='fake-test-password', client='app'))
                assert response.status_code == 200
                return {'authorization': 'Bearer ' + response.json()['access_token']}
            admin, operator = await login('admin'), await login('one')
            response = await http.post('/robots', headers=admin, json=dict(name='wire-robot',
                owner_user_id=str(seeded['users']['one'])))
            assert response.status_code == 201
            created = response.json()
            rid = created['robot']['id']
            # This synthetic Session exercises the supported legacy sim relay.
            engine = create_engine(seeded['urls']['migrate'])
            with DBSession(engine) as db:
                db.get(Robot, UUID(rid)).simulation = True
                db.commit()
            engine.dispose()
            session, sink = FakeTelemetrySession(), Sink()
            client = Client(session, sink, Settings(server['base'] + '/api/v1/agent/ws', created['agent_token']))
            task = asyncio.create_task(client.run())
            async def until(predicate):
                async with asyncio.timeout(5):
                    while not predicate():
                        assert not task.done(), repr(task.exception())
                        await asyncio.sleep(.01)
            try:
                await until(lambda: session.stop_ref > 0)
                async with asyncio.timeout(5):
                    while True:
                        detail = (await http.get('/robots/' + rid, headers=admin)).json()
                        if detail['battery']:
                            break
                        await asyncio.sleep(.01)
                assert detail['connection'] == 'ONLINE' and detail['battery']['soc'] == 73
                assert detail['location']['x'] == 2.5 and detail['location']['map_version_id'] is None
                assert detail['devices'][0]['key'] == 'rgb'
                listing = (await http.get('/robots?scope=all', headers=admin)).json()['items']
                assert next(r for r in listing if r['id'] == rid)['battery']['soc'] == 73
                dash = (await http.get('/dashboard', headers=admin)).json()
                assert dash['robots_total'] == 3 and dash['robots_online'] == 1
                async with connect(server['base'] + '/api/v1/ws', additional_headers=operator, proxy=None) as ws:
                    async def receive(kind, predicate=lambda m: True):
                        async with asyncio.timeout(5):
                            while True:
                                body = json.loads(await ws.recv())
                                if body.get('t') == kind and predicate(body):
                                    return body
                    async def send(kind, **fields):
                        ident = str(uuid4())
                        await ws.send(json.dumps(dict(t=kind, id=ident, **fields)))
                        return ident
                    await send('sub', proto='fh-rt/1', robots=[rid], streams=['state'])
                    await receive('reply')
                    await send('lease.take', robot=rid)
                    lease = await receive('lease', lambda m: m.get('lease_id'))
                    assert session.lease_id == lease['lease_id']
                    assert (await http.delete('/robots/' + rid, headers=admin)).status_code == 409
                    mark = len(session.frames)
                    # Finish the legacy simulation phase before testing real
                    # management. The real path must never relay lease/STOP.
                    release_id = await send('lease.release', robot=rid)
                    assert (await receive('reply', lambda m: m['id'] == release_id))['ok']
                    await until(lambda: session.lease_id is None and session.core.latch)
                    engine = create_engine(seeded['urls']['migrate'])
                    with DBSession(engine) as db:
                        db.get(Robot, UUID(rid)).simulation = False
                        db.commit()
                    engine.dispose()
                    response = await http.patch('/robots/' + rid, headers=admin,
                        json={'owner_user_id': str(seeded['users']['two'])})
                    assert response.status_code == 200
                    assert (await receive('subscription.revoked'))['reason'] == 'ACCESS_REVOKED'
                    await until(lambda: any(f.get('t') == 'stop' for f in session.frames[mark:]))
                    transitions = [f['t'] for f in session.frames[mark:] if f['t'] in ('lease', 'stop')]
                    assert transitions[:2] == ['lease', 'stop']
                    assert session.lease_id is None and session.core.latch and session.core.out == (0, 0, 0)
                    assert sink.outputs[-1].velocity == (0, 0, 0)
                    ident = await send('lease.take', robot=rid)
                    assert not (await receive('reply', lambda m: m['id'] == ident))['ok']
                    assert (await http.delete('/robots/' + rid, headers=admin)).status_code == 204
                    async with asyncio.timeout(5):
                        result = (await asyncio.gather(task, return_exceptions=True))[0]
                    assert isinstance(result, ReconnectForbidden) and result.close_code == 4403
                    assert (await http.get('/robots/' + rid, headers=admin)).status_code == 404
                    print('S1 uvicorn + real Client: registration token -> ONLINE/73/pose/device/dashboard -> take -> delete 409 -> sim release lease-null/STOP/0 -> real reassignment robot-only revoke -> delete/4403: PASS')
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    with server_process(seeded, tmp_path) as server:
        asyncio.run(check(server))

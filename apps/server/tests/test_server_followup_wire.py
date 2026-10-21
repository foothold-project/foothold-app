"""Real loopback uvicorn, production agent Client with synthetic sink, fake screens."""
import asyncio
import json
import sys
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as DBSession
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from apps.server.fh_server.models import User
from .ws_process import server_process

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent'))


def test_s0_real_client_ping_cancel_first_unlock_and_twenty_cold_stops(seeded, tmp_path):
    from foothold_agent.link.client import Client, Settings
    from foothold_agent.link.session import Session
    names = ['one', *[f's0-wire-{n}' for n in range(19)]]
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        password = db.get(User, seeded['users']['one']).password_hash
        db.add_all([User(org_id=seeded['org'], username=name, display_name=name,
                        role='OPERATOR', password_hash=password) for name in names[1:]])
        db.commit()
    engine.dispose()

    async def check(server):
        base = server['base'].replace('ws://', 'http://')
        rid = str(seeded['robots']['mine'])
        class Sink:
            def apply(self, command):
                pass  # All outputs are local; no ROS or robot transport.
        session = Session()
        agent = Client(session, Sink(), Settings(server['base'] + '/api/v1/agent/ws', server['agent_token']))
        agent_task = asyncio.create_task(agent.run())
        async with httpx.AsyncClient(base_url=base, timeout=8) as http:
            async def login(name):
                response = await http.post('/api/v1/auth/login', json=dict(username=name, password='fake-test-password', client='app'))
                assert response.status_code == 200
                return response.json()
            tokens = [await login(name) for name in names]
            admin, unrelated = await login('admin'), await login('two')
            def auth(token):
                return {'authorization': 'Bearer ' + token['access_token']}
            async def receive(ws, kind, predicate=lambda m: True):
                async with asyncio.timeout(5):
                    while True:
                        body = json.loads(await ws.recv())
                        if body.get('t') == kind and predicate(body):
                            return body
            async def send(ws, kind, **fields):
                ident = str(uuid4())
                await ws.send(json.dumps(dict(t=kind, id=ident, **fields)))
                return ident
            try:
                async with asyncio.timeout(5):
                    while session.stop_ref == 0:
                        assert not agent_task.done()
                        await asyncio.sleep(.01)
                async with connect(server['base'] + '/api/v1/ws', additional_headers=auth(tokens[0]), proxy=None) as holder, connect(server['base'] + '/api/v1/ws', additional_headers=auth(admin), proxy=None) as requester:
                    # Unsubscribed screens must receive unsolicited UTC pings.
                    ping = await receive(requester, 'ping')
                    assert ping['t_server'].endswith('Z')
                    created = await http.post('/api/v1/robots', headers=auth(admin), json={'name': 's0-immediate-sub'})
                    assert created.status_code == 201
                    ident = await send(requester, 'sub', proto='fh-rt/1', robots=[created.json()['robot']['id']], streams=['state'])
                    assert (await receive(requester, 'reply', lambda m: m['id'] == ident))['ok']
                    ident = await send(holder, 'sub', proto='fh-rt/1', robots=[rid], streams=['state'])
                    assert (await receive(holder, 'reply', lambda m: m['id'] == ident))['ok']
                    await receive(holder, 'state')
                    await send(holder, 'lease.take', robot=rid)
                    latest, grant = None, None
                    async with asyncio.timeout(5):
                        while grant is None:
                            body = json.loads(await holder.recv())
                            if body['t'] == 'state':
                                latest = body
                            if body['t'] == 'lease' and body.get('lease_id'):
                                grant = body
                    assert latest and latest['stop_gen'] is not None
                    ident = await send(holder, 'unlock', robot=rid, lease_id=grant['lease_id'], stop_gen=latest['stop_gen'])
                    assert (await receive(holder, 'reply', lambda m: m['id'] == ident))['ok']
                    await send(requester, 'lease.request', proto='fh-rt/1', robot=rid)
                    request = await receive(holder, 'lease.requested')
                    await send(requester, 'lease.cancel', robot=rid)
                    for ws in (holder, requester):
                        result = await receive(ws, 'lease.result')
                        assert result['result'] == 'CANCELED' and result['request_id'] == request['request_id']
                    # Release the holder before STOP storm, preserving all safety paths.
                    await send(holder, 'lease.release', robot=rid)
                tasks = [asyncio.create_task(http.post(f'/api/v1/robots/{rid}/stop', headers=auth(token))) for token in tokens]
                try:
                    async with asyncio.timeout(5):
                        while (await http.get('/_s0/loaded')).json()['loaded'] < 12:
                            await asyncio.sleep(.01)
                    assert (await http.post('/api/v1/auth/refresh', json={'refresh_token': unrelated['refresh_token']})).status_code == 200
                finally:
                    await http.post('/_s0/release')
                responses = await asyncio.gather(*tasks)
                statuses = [response.status_code for response in responses]
                assert statuses == [202] * 20, statuses
                print('S0 uvicorn + real agent Client/fake sink + fake screens: UTC ping; POST201/immediate sub; cancel both dialogs; immediate first unlock; 20 cold STOP + unrelated refresh: 202=20, 503=0')
            finally:
                agent_task.cancel()
                await asyncio.gather(agent_task, return_exceptions=True)
    with server_process(seeded, tmp_path, app_target='apps.server.tests.s0_wire_app:app') as server:
        asyncio.run(check(server))


def test_upgrade_denials_have_distinct_http_status_over_uvicorn(seeded, tmp_path):
    async def check(server):
        for path, headers, expected in [
            ('/api/v1/ws', {}, 401),
            ('/api/v1/ws', {'authorization': 'Bearer invalid'}, 401),
            ('/api/v1/agent/ws', {}, 401),
            ('/api/v1/agent/ws', {'authorization': 'Bearer invalid'}, 403),
        ]:
            try:
                async with connect(server['base'] + path, additional_headers=headers, proxy=None):
                    pytest.fail('Rejected credentials upgraded')
            except InvalidStatus as error:
                assert error.response.status_code == expected
                body = json.loads(error.response.body)
                assert body['error']['code'] == ('AUTH_REQUIRED' if expected == 401 else 'FORBIDDEN')
        async with httpx.AsyncClient(base_url=server['base'].replace('ws://', 'http://')) as http:
            result = await http.post('/api/v1/auth/login', json=dict(username='one', password='fake-test-password', client='web'))
            cookie = result.cookies.get('fh_s')
        try:
            async with connect(server['base'] + '/api/v1/ws', additional_headers={'cookie': 'fh_s=' + cookie}, origin='https://wrong.example', proxy=None):
                pytest.fail('Wrong Origin upgraded')
        except InvalidStatus as error:
            assert error.response.status_code == 403
    with server_process(seeded, tmp_path) as server:
        asyncio.run(check(server))

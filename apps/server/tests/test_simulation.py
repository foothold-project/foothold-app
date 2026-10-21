"""Private PostgreSQL + fake manager: permission, provenance and PR43 pass path."""
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from apps.simmgr.api import create_app as manager_app
from apps.simmgr.config import Settings as ManagerSettings, Slot, World
from apps.server.fh_server.models import Event, Robot
from apps.server.fh_server.simulation import RelayError
from .test_api import csrf


class LocalRelay:
    def __init__(self, client, secret):
        self.client, self.secret = client, secret
    def request(self, method, path, body=None):
        response = self.client.request(method, path, json=body, headers={'Authorization':'Bearer '+self.secret})
        if response.status_code >= 400:
            raise RelayError(response.json()['error']['code'], response.status_code)
        return response.json()


def test_simulation_relay_auth_provenance_pass_and_removal(client,seeded):
    rid = str(uuid4()); org = str(seeded['org'])
    slot = Slot(rid,org,'unused','unused.sqlite',9433)
    settings = ManagerSettings({'test':World('test',Path('unused.sdf'),Path('unused.yaml'))},{rid:slot},'x'*32)
    with TestClient(manager_app(settings), client=('127.0.0.1', 9438)) as sim:
        client.app.state.simmgr = LocalRelay(sim,settings.secret)
        client.app.state.phone_pass_issuer.keys[rid] = ('test',{'test':b'x'*32})
        assert client.get('/api/v1/simulation/worlds').status_code == 401
        headers = csrf(client,'one')
        assert client.get('/api/v1/simulation/worlds').json()['slots'] == [rid]
        assert client.post('/api/v1/simulation/robots',json=dict(world_id='test',robot_id=rid)).status_code == 403
        start = client.post('/api/v1/simulation/robots',json=dict(world_id='test',robot_id=rid),headers=headers)
        assert start.status_code == 201, start.text
        body = start.json()
        assert body['robot_id'] == rid and body['simulation'] and body['state'] == 'PREPARED'
        assert 'token' not in start.text and start.headers['cache-control'] == 'no-store'
        assert client.get('/api/v1/robots/'+rid).json()['simulation'] is True
        # Existing pass issuer signs the provisioned robot, no simulation-only pass.
        issued = client.post('/api/v1/robots/'+rid+'/phone-pass',headers=headers,json=dict(device=str(uuid4()),purpose='control'))
        assert issued.status_code == 200 and len(issued.json()['token']) > 100
        with DBSession(client.app.state.engine) as db:
            row = db.get(Robot,body['robot_id'])
            assert row.simulation and str(row.owner_user_id) == str(seeded['users']['one'])
            events = list(db.scalars(select(Event).where(Event.code.like('SIM_%'))))
            assert {e.code for e in events} == {'SIM_ROBOT_REQUESTED','SIM_ROBOT_REGISTERED'}
            assert all('token' not in str(e.data) for e in events)
        assert client.post('/api/v1/simulation/robots',json=dict(world_id='test',robot_id=rid),headers=headers).status_code == 201
        other = csrf(client,'two')
        assert client.get('/api/v1/simulation/robots').json()['items'] == []
        assert client.delete('/api/v1/simulation/robots/'+rid,headers=other).status_code == 403
        headers = csrf(client,'one')
        assert client.delete('/api/v1/simulation/robots/'+rid,headers=headers).status_code == 204
        assert client.get('/api/v1/robots/'+rid).json()['simulation'] is True
        assert client.get('/api/v1/simulation/robots').json()['items'] == []


def test_provenance_cannot_be_set_by_normal_robot_api(client):
    headers = csrf(client)
    result = client.post('/api/v1/robots',headers=headers,json=dict(name='fake',owner_user_id=None,simulation=True))
    assert result.status_code == 400
    assert client.get('/api/v1/simulation/worlds').status_code == 503


def test_relay_rejects_external_destination_and_redirects(tmp_path):
    import pytest
    from apps.server.fh_server.simulation import Relay, NoRedirect
    private = tmp_path/'service-secret'
    private.write_text('x'*32);private.chmod(0o600)
    for url in ('http://example.test:9430','http://127.0.0.1:8453','http://127.0.0.1:9430/path'):
        with pytest.raises(ValueError):
            Relay(url,private)
    assert NoRedirect().redirect_request(None,None,302,'',{},'http://example.test') is None


import pytest
from apps.server.fh_server.models import PhoneRevocation
from apps.simmgr.launcher import FakeLauncher


@pytest.fixture
def simulation_context(client,seeded):
    rid=str(uuid4());slot=Slot(rid,str(seeded['org']),'unused','unused.sqlite',9433)
    settings=ManagerSettings({'test':World('test',Path('unused.sdf'),Path('unused.yaml'))},{rid:slot},'x'*32)
    class Capture(FakeLauncher):
        async def add(self,slot,credentials):
            self.token=credentials['agent_token']
            await super().add(slot,credentials)
    launcher=Capture()
    with TestClient(manager_app(settings,launcher),client=('127.0.0.1',9438)) as sim:
        client.app.state.simmgr=LocalRelay(sim,settings.secret)
        client.app.state.phone_pass_issuer.keys[rid]=('test',{'test':b'x'*32})
        yield client,sim,settings,rid,launcher


def start_slot(context,username='one'):
    client,sim,cfg,rid,launcher=context
    headers=csrf(client,username)
    result=client.post('/api/v1/simulation/robots',headers=headers,json=dict(world_id='test',robot_id=rid))
    return result,headers


def test_released_slot_can_change_owner_and_revokes_live_passes(simulation_context,seeded):
    client,sim,cfg,rid,launcher=simulation_context
    result,headers=start_slot(simulation_context)
    assert result.status_code==201
    issued=client.post(f'/api/v1/robots/{rid}/phone-pass',headers=headers,json=dict(device=str(uuid4()),purpose='view'))
    assert issued.status_code==200
    assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
    with DBSession(client.app.state.engine) as db:
        row=db.get(Robot,rid)
        assert row.owner_user_id is None and row.simulation
        assert db.scalar(select(PhoneRevocation).where(PhoneRevocation.robot_id==row.id)) is not None
        assert db.scalar(select(Event).where(Event.code=='SIM_ROBOT_REMOVED')) is not None
    result,_=start_slot(simulation_context,'two')
    assert result.status_code==201 and result.json()['owner_id']==str(seeded['users']['two'])


def test_failed_delete_is_durable_audit_and_keeps_owner(simulation_context,seeded):
    client,sim,cfg,rid,launcher=simulation_context
    result,headers=start_slot(simulation_context);assert result.status_code==201
    async def broken(*args):raise RuntimeError('synthetic failure')
    launcher.stop_agent=broken
    client.app.state.simmgr=LocalRelay(TestClient(sim.app,raise_server_exceptions=False,client=('127.0.0.1',9438)),cfg.secret)
    response=client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers)
    assert response.status_code==503
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot,rid).owner_user_id==seeded['users']['one']
        assert db.scalar(select(Event).where(Event.code=='SIM_ROBOT_REMOVE_FAILED')) is not None
        assert db.scalar(select(Event).where(Event.code=='SIM_ROBOT_REMOVED')) is None
    async def stopped(slot):return None
    launcher.stop_agent=stopped


def test_missing_key_fails_before_manager_start(simulation_context):
    client,sim,cfg,rid,launcher=simulation_context
    client.app.state.phone_pass_issuer.keys.pop(rid)
    result,_=start_slot(simulation_context)
    assert result.status_code==503 and result.json()['error']['code']=='PASS_KEY_MISSING'
    assert not sim.app.state.manager.robots


def test_existing_real_robot_cannot_be_adopted(simulation_context,seeded):
    client,sim,cfg,rid,launcher=simulation_context
    with DBSession(client.app.state.engine) as db:
        from apps.server.fh_server.security import digest
        db.add(Robot(id=rid,org_id=seeded['org'],name='synthetic real',model='go2',simulation=False,
                     owner_user_id=seeded['users']['one'],agent_token_hash=digest('old')))
        db.commit()
    result,_=start_slot(simulation_context)
    assert result.status_code==404 and not sim.app.state.manager.robots


def test_admin_cannot_steal_owned_slot_even_when_manager_is_empty(simulation_context,seeded):
    client,sim,cfg,rid,launcher=simulation_context
    result,_=start_slot(simulation_context);assert result.status_code==201
    sim.portal.call(sim.app.state.manager.remove,rid,1)
    original=client.app.state.simmgr.request; calls=[]
    def recorded(method,path,body=None):
        calls.append((method,path))
        return original(method,path,body)
    client.app.state.simmgr.request=recorded
    result,_=start_slot(simulation_context,'admin')
    assert result.status_code==409 and not sim.app.state.manager.robots
    assert not any(path.startswith('/v1/robots') for method,path in calls)


def test_simulation_agent_token_rotation_is_blocked(simulation_context):
    client,sim,cfg,rid,launcher=simulation_context
    result,_=start_slot(simulation_context);assert result.status_code==201
    headers=csrf(client,'admin')
    result=client.post(f'/api/v1/robots/{rid}/agent-token',headers=headers)
    assert result.status_code==409 and result.json()['error']['code']=='SIM_TOKEN_MANAGED'


def test_configured_agent_path_connects_to_real_server_route(simulation_context):
    from urllib.parse import urlsplit
    from .test_realtime import hello,receive
    client,sim,cfg,rid,launcher=simulation_context
    result,_=start_slot(simulation_context);assert result.status_code==201
    path=urlsplit(cfg.agent_ws_url).path
    assert path=='/api/v1/agent/ws'
    with client.websocket_connect(path,headers={'authorization':'Bearer '+launcher.token}) as ws:
        ws.send_json(hello())
        assert receive(ws,'lease')['lease_id'] is None
        assert receive(ws,'stop')['t']=='stop'


def test_pass_issued_during_removal_is_revoked_before_release(simulation_context):
    from apps.server.fh_server.models import PhonePass
    client,sim,cfg,rid,launcher=simulation_context
    result,headers=start_slot(simulation_context);assert result.status_code==201
    request=client.app.state.simmgr.request
    issued=[]
    def during_stop(method,path,body=None):
        if method=='DELETE':
            response=client.post(f'/api/v1/robots/{rid}/phone-pass',headers=headers,
                json=dict(device=str(uuid4()),purpose='view'))
            issued.append(response.status_code)
        return request(method,path,body)
    client.app.state.simmgr.request=during_stop
    assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
    assert issued==[200]
    with DBSession(client.app.state.engine) as db:
        passes=list(db.scalars(select(PhonePass).where(PhonePass.robot_id==rid)))
        revoked={r.jti for r in db.scalars(select(PhoneRevocation).where(PhoneRevocation.robot_id==rid))}
        assert passes and {p.jti for p in passes}<=revoked
        assert db.get(Robot,rid).owner_user_id is None

import os
import pytest


@pytest.fixture(autouse=True)
def clean_ros_environment(monkeypatch):
    for name in tuple(os.environ):
        if name.startswith(('ROS_', 'RMW_', 'CYCLONEDDS_', 'FASTRTPS_', 'FASTDDS_')):
            monkeypatch.delenv(name)

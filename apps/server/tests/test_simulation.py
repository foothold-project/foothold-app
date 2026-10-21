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
    with TestClient(manager_app(settings)) as sim:
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

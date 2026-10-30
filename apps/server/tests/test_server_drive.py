"""Robot-scoped opt-in reuses the existing arbiter and authenticated WS."""
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import Robot
from apps.server.fh_server.security import digest
from .test_realtime import app_token, hello, receive, reply, screen, send, state, take, agent, rt


@pytest.fixture
def trial(seeded):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        for rid in seeded['robots'].values():
            row = db.get(Robot, rid)
            row.simulation = False
            row.agent_token_hash = digest('fake-test-' + str(rid))
        db.commit()
    engine.dispose()
    app = create_app(Settings(seeded['urls']['app'], seeded['org'],
                              server_drive_robots=frozenset({seeded['robots']['mine']})))
    with TestClient(app, base_url='https://testserver') as client:
        yield client
    app.state.engine.dispose()


def test_server_drive_switch_env_is_empty_default_and_strict_uuid(monkeypatch):
    monkeypatch.setenv('FH_DATABASE_URL', 'fake-unused')
    monkeypatch.setenv('FH_ORG_ID', str(uuid4()))
    monkeypatch.delenv('FH_SERVER_DRIVE_ROBOTS', raising=False)
    assert Settings.from_env().server_drive_robots == frozenset()
    rid = uuid4()
    monkeypatch.setenv('FH_SERVER_DRIVE_ROBOTS', f' {rid}, ')
    assert Settings.from_env().server_drive_robots == frozenset({rid})
    monkeypatch.setenv('FH_SERVER_DRIVE_ROBOTS', '*')
    with pytest.raises(ValueError):
        Settings.from_env()


def test_trial_relay_lease_cmd_stop_admin_and_two_connections(trial, seeded):
    client = trial
    rid = seeded['robots']['mine']
    owner, admin, other = app_token(client), app_token(client, 'admin'), app_token(client, 'two')
    detail = client.get(f'/api/v1/robots/{rid}', headers=owner).json()
    assert detail['server_drive_allowed'] is True and detail['simulation'] is False
    with client.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease')
        receive(ag, 'stop')
        with screen(client, owner) as ws, screen(client, owner) as second, screen(client, admin) as tower:
            lease = take(ws, ag, rid)
            assert client.get(f'/api/v1/robots/{rid}', headers=owner).json()['lease']['holder_type'] == 'USER'
            assert reply(ws, send(ws, 'unlock', rid, lease_id=lease, stop_gen=3))['ok']
            assert receive(ag, 'unlock')['stop_gen'] == 3
            assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[0,0,0]))['ok']
            assert receive(ag, 'cmd')['axes'] == [0,0,0]
            assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=[1.5,0,.5]))['ok']
            assert receive(ag, 'cmd')['axes'] == [1.5,0,.5]
            denied = reply(second, send(second, 'cmd', rid, lease_id=lease, seq=2, axes=[1,0,0]))
            assert denied['error']['code'] == 'LEASE_MISMATCH'
            assert reply(second, send(second, 'lease.take', rid))['error']['code'] == 'LEASE_HELD'
            for kind, fields in [('lease.take', {}), ('stop', {}),
                    ('cmd', dict(lease_id=lease, seq=2, axes=[1,0,0])),
                    ('unlock', dict(lease_id=lease, stop_gen=3))]:
                assert reply(tower, send(tower, kind, rid, **fields))['error']['code'] == 'ADMIN_NO_REAL_CONTROL'
            assert client.post(f'/api/v1/robots/{rid}/stop', headers=admin).json()['error']['code'] == 'ADMIN_NO_REAL_CONTROL'
            # Any operator in this organization retains STOP, including non-owner.
            assert client.post(f'/api/v1/robots/{rid}/stop', headers=other).status_code == 202
            receive(ag, 'stop')
            # Physical trial never opens RUN/map/SLAM output paths.
            rt = client.app.state.realtime
            async def blocked():
                peer = rt.agents[str(rid)]
                for body in ({'t':'run.start'}, {'t':'slam'}, {'t':'floor.set'},
                             {'t':'lease','lease_id':'fake-run','holder_type':'RUN'}):
                    assert await rt.send_body(peer, body) is False
            client.portal.call(blocked)


def test_outside_list_is_unchanged(trial, seeded):
    rid = seeded['robots']['theirs']
    owner = app_token(trial, 'two')
    assert trial.get(f'/api/v1/robots/{rid}', headers=owner).json()['server_drive_allowed'] is False
    with screen(trial, owner) as ws:
        assert reply(ws, send(ws, 'lease.take', rid))['error']['code'] == 'PHONE_DIRECT_REQUIRED'
        assert reply(ws, send(ws, 'stop', rid))['error']['code'] == 'PHONE_DIRECT_REQUIRED'
    assert trial.post(f'/api/v1/robots/{rid}/stop', headers=owner).json()['error']['code'] == 'PHONE_DIRECT_REQUIRED'


def test_empty_list_retains_real_rejection(client, seeded):
    rid = seeded['robots']['mine']
    owner = app_token(client)
    assert client.get(f'/api/v1/robots/{rid}', headers=owner).json()['server_drive_allowed'] is False
    with screen(client, owner) as ws:
        for kind in ('lease.take', 'stop'):
            assert reply(ws, send(ws, kind, rid))['error']['code'] == 'PHONE_DIRECT_REQUIRED'
    assert client.post(f'/api/v1/robots/{rid}/stop', headers=owner).json()['error']['code'] == 'PHONE_DIRECT_REQUIRED'


@pytest.mark.parametrize('bad', [[1.5000000001,0,0],[-1.5,0,.5],[1.5,1.5,0],[1,0,0],[True,0,0]])
def test_outside_exact_table_is_stopped_and_rejected(trial,seeded,bad):
    rid=seeded['robots']['mine']
    with trial.websocket_connect('/api/v1/agent/ws',headers={
            'authorization':'Bearer fake-test-'+str(rid)}) as ag:
        ag.send_json(hello()); receive(ag,'lease'); receive(ag,'stop')
        with screen(trial,app_token(trial)) as ws:
            lease=take(ws,ag,rid)
            result=reply(ws,send(ws,'cmd',rid,lease_id=lease,seq=1,axes=bad))
            assert not result['ok'] and result['error']['code'] in ('SERVER_DRIVE_COMMAND','VALIDATION')
            receive(ag,'stop')


def test_simulation_keeps_normalized_axis_bounds(client, seeded, rt):
    rid=seeded['robots']['mine']
    with agent(client,seeded) as ag, screen(client,app_token(client)) as ws:
        lease=take(ws,ag,rid)
        rejected=reply(ws,send(ws,'cmd',rid,lease_id=lease,seq=1,axes=[1.5,0,0]))
        assert rejected['error']['code']=='VALIDATION'
        assert reply(ws,send(ws,'cmd',rid,lease_id=lease,seq=2,axes=[1,0,0]))['ok']
        assert receive(ag,'cmd')['axes']==[1,0,0]

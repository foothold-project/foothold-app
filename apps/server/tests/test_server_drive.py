"""Robot-scoped opt-in reuses the existing arbiter and authenticated WS."""
import asyncio
import time
from uuid import UUID, uuid4
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, event
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import Event, Organization, Robot, now
from apps.server.fh_server.security import digest
from apps.contracts import models as C
from apps.contracts.server_drive import ALLOWED
from .test_realtime import app_token, drain_audit, hello, receive, reply, screen, send, state, take, agent, rt


@pytest.fixture
def trial(seeded):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        for index, rid in enumerate(seeded['robots'].values()):
            row = db.get(Robot, rid)
            row.simulation = False
            row.serial = f'1234-{index}'
            row.field_approval_expires_at = now() + timedelta(minutes=30)
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
    assert detail['server_drive_allowed'] is False and detail['simulation'] is False
    with client.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease')
        receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
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
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
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


@pytest.mark.parametrize('no_fast', [False, True])
def test_org_fast_drive_restriction_only_narrows_existing_table(trial, seeded, no_fast):
    rid = seeded['robots']['mine']
    admin = app_token(trial, 'admin')
    if no_fast:
        assert trial.patch('/api/v1/org/settings', headers=admin,
            json={'real_no_fast_server_drive': True}).status_code == 200
    else:
        assert trial.get('/api/v1/org/settings', headers=admin).json()['real_no_fast_server_drive'] is False
    owner = app_token(trial)
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello()); receive(ag, 'lease'); receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        with screen(trial, owner) as ws, screen(trial, owner) as second:
            lease = take(ws, ag, rid)
            for seq, axes in enumerate(sorted(ALLOWED)):
                trial.portal.call(asyncio.sleep, 0.05)  # Respect the existing intent rate limit.
                result = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=seq, axes=axes))
                if (no_fast and any(axes[:2])) or axes[1]:
                    assert result['ok'] is False
                    assert result['error']['code'] == 'SERVER_DRIVE_COMMAND'
                    receive(ag, 'stop')
                else:
                    assert result['ok'] is True, (axes, result)
                    assert receive(ag, 'cmd')['axes'] == list(axes)
            # A second connection cannot use this policy to stop the holder.
            denied = reply(second, send(second, 'cmd', rid,
                lease_id=lease, seq=100, axes=[1.5, 0, 0]))
            assert denied['error']['code'] == 'LEASE_MISMATCH'
            # An already-open control connection picks up the organization policy.
            assert trial.patch('/api/v1/org/settings', headers=admin,
                json={'real_no_fast_server_drive': not no_fast}).status_code == 200
            async def refreshed():
                async with asyncio.timeout(2):
                    while any(p.policy.settings.real_no_fast_server_drive == no_fast
                              for p in trial.app.state.realtime.screens.values()):
                        await asyncio.sleep(0.01)
            trial.portal.call(refreshed)
            result = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=101, axes=[1.5, 0, 0]))
            assert result['ok'] == no_fast
            receive(ag, 'cmd' if no_fast else 'stop')
            assert reply(ws, send(ws, 'stop', rid))['ok']
            receive(ag, 'stop')


def test_real_fast_drive_setting_does_not_restrict_simulation(client, seeded, rt):
    assert client.patch('/api/v1/org/settings', headers=app_token(client, 'admin'),
        json={'real_no_fast_server_drive': True}).status_code == 200
    rid = seeded['robots']['mine']
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease = take(ws, ag, rid)
        assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=[1, 0, 0]))['ok']
        assert receive(ag, 'cmd')['axes'] == [1, 0, 0]


@pytest.mark.parametrize('axes', ([1.5, 0, 0], [-1.5, 0, 0], [0, 0, .5], [0, 0, 0]))
def test_enable_stops_last_translation_once_after_commit(trial, seeded, monkeypatch, axes):
    rid = seeded['robots']['mine']
    owner, admin = app_token(trial), app_token(trial, 'admin')
    realtime = trial.app.state.realtime
    stops, original = [], realtime.arbiter.stop
    def stop(robot, actor):
        # This is the existing arbiter path on the ASGI loop, after durability.
        asyncio.get_running_loop()
        with DBSession(trial.app.state.engine) as db:
            assert db.get(Organization, seeded['org']).settings['real_no_fast_server_drive'] is True
        stops.append(robot)
        return original(robot, actor)
    monkeypatch.setattr(realtime.arbiter, 'stop', stop)
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello()); receive(ag, 'lease'); receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        with screen(trial, owner) as ws:
            lease = take(ws, ag, rid)
            assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=axes))['ok']
            receive(ag, 'cmd')  # No new cmd or moving-state report is needed.
            for patch in ({'sim_runner_vx': .5}, {'real_no_fast_server_drive': False}):
                assert trial.patch('/api/v1/org/settings', headers=admin, json=patch).status_code == 200
            assert stops == []
            # Invalid combined PATCH rolls back without sending STOP.
            assert trial.patch('/api/v1/org/settings', headers=admin, json={
                'real_no_fast_server_drive': True, 'sim_max_vx': .3}).status_code == 422
            assert stops == []
            result = trial.patch('/api/v1/org/settings', headers=admin,
                json={'real_no_fast_server_drive': True})
            assert result.status_code == 200
            assert result.json()['sim_runner_vx'] == .5
            assert result.json() == trial.get('/api/v1/org/settings', headers=admin).json()
            expected = [str(rid)] if any(axes[:2]) else []
            assert stops == expected
            if expected:
                assert receive(ag, 'stop')['by_user_id'] == str(seeded['users']['admin'])
            for patch in ({'real_no_fast_server_drive': True}, {'sim_runner_wz': .7},
                          {'real_no_fast_server_drive': False}, {'real_no_fast_server_drive': True}):
                assert trial.patch('/api/v1/org/settings', headers=admin, json=patch).status_code == 200
            assert stops == expected  # STOP cleared the retained translation.
            drain_audit(trial, realtime)
            with DBSession(trial.app.state.engine) as db:
                records = list(db.scalars(select(Event).where(Event.robot_id == rid,
                    Event.code == 'SERVER_DRIVE_COMMAND')))
                assert len(records) == len(expected)
                if records:
                    assert records[0].category == 'SAFETY'
                    assert records[0].data['reason'] == 'SERVER_DRIVE_COMMAND'


def test_enable_commit_failure_never_stops_or_saves(trial, seeded, monkeypatch):
    admin = app_token(trial, 'admin')
    stops = []
    monkeypatch.setattr(trial.app.state.realtime, 'stop_fast_server_drives',
        lambda *args: stops.append(args))
    def reject(db):
        if any(isinstance(row, Event) and row.code == 'ORG_SETTINGS_UPDATED'
               for row in db.new):
            raise RuntimeError('fake settings commit failure')
    event.listen(DBSession, 'before_commit', reject)
    try:
        with pytest.raises(RuntimeError, match='fake settings commit failure'):
            trial.patch('/api/v1/org/settings', headers=admin,
                json={'real_no_fast_server_drive': True})
    finally:
        event.remove(DBSession, 'before_commit', reject)
    assert stops == []
    assert trial.get('/api/v1/org/settings', headers=admin).json()['real_no_fast_server_drive'] is False


@pytest.mark.parametrize('caps', [dict(sim_max_vx=1.5, sim_key_vx=1.5, sim_max_vy=.5, sim_max_wz=1.2),
    dict(sim_max_vx=.2, sim_min_vx=0, sim_key_vx=.1, sim_max_vy=0, sim_max_wz=0)])
def test_browser_org_caps_do_not_change_physical_server_drive_alphabet(trial, seeded, caps):
    assert ALLOWED == frozenset(((0., 0., 0.), (1.5, 0., 0.), (-1.5, 0., 0.),
        (0., 1.5, 0.), (0., -1.5, 0.), (0., 0., .5), (0., 0., -.5),
        (1.5, 0., .5), (1.5, 0., -.5)))
    admin = app_token(trial, 'admin')
    assert trial.patch('/api/v1/org/settings', headers=admin, json=caps).status_code == 200
    rid = seeded['robots']['mine']
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello()); receive(ag, 'lease'); receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        with screen(trial, app_token(trial)) as ws:
            lease = take(ws, ag, rid)
            assert reply(ws, send(ws, 'unlock', rid, lease_id=lease, stop_gen=3))['ok']
            receive(ag, 'unlock')
            assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[0, 0, 0]))['ok']
            receive(ag, 'cmd')
            for seq, axes in enumerate(sorted(ALLOWED), start=1):
                time.sleep(.06)  # Keep the real 20 Hz command-rate guard enabled.
                ack = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=seq, axes=list(axes)))
                if axes[1]:  # Fixed 1.5 side commands exceed the SDK organization maximum 1.0.
                    assert ack['error']['code'] == 'SERVER_DRIVE_COMMAND'
                    receive(ag, 'stop')
                else:
                    assert ack['ok'], (axes, ack)
                    assert receive(ag, 'cmd')['axes'] == list(axes)
            result = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=len(ALLOWED)+1, axes=[0, 0, 1.2]))
            assert result['error']['code'] == 'VALIDATION'  # Rejected at the unchanged wire schema.
            receive(ag, 'stop')


@pytest.mark.parametrize('patch,axes', [({'real_max_vx': 1.49}, [1.5, 0, 0]),
    ({'real_max_vx_back': 0}, [-1.5, 0, 0]), ({'real_max_vy': 1}, [0, 1.5, 0]),
    ({'real_max_wz': .49}, [0, 0, .5]), ({'real_max_wz': 0}, [1.5, 0, -.5])])
def test_real_caps_reject_over_limit_table_commands_with_stop(trial, seeded, patch, axes):
    assert trial.patch('/api/v1/org/settings', headers=app_token(trial, 'admin'), json=patch).status_code == 200
    test_outside_exact_table_is_stopped_and_rejected(trial, seeded, axes)


@pytest.mark.parametrize('axes,patch', [([1.5, 0, 0], {'real_max_vx': .5}),
                                      ([0, 0, .5], {'real_max_wz': 0})])
def test_lowering_caps_stops_retained_translation_or_rotation_after_commit(trial, seeded, axes, patch):
    rid = seeded['robots']['mine']
    owner, admin = app_token(trial), app_token(trial, 'admin')
    with trial.websocket_connect('/api/v1/agent/ws', headers={'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello()); receive(ag, 'lease'); receive(ag, 'stop')
        receive(ag, 'field_approval', predicate=lambda m: m['expires_at'] is not None)
        with screen(trial, owner) as ws:
            lease = take(ws, ag, rid)
            assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=axes))['ok']
            receive(ag, 'cmd')
            assert trial.patch('/api/v1/org/settings', headers=admin, json=patch).status_code == 200
            assert receive(ag, 'stop')['by_user_id'] == str(seeded['users']['admin'])
            time.sleep(.1)
            rejected = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=2, axes=axes))
            assert not rejected['ok'] and rejected['error']['code'] in ('POLICY_STALE', 'SERVER_DRIVE_COMMAND')

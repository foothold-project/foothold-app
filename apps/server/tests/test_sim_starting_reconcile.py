"""Recover abandoned STARTING only with a restarted, clean manager's bound receipt."""
from concurrent.futures import ThreadPoolExecutor
import threading
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from apps.server.fh_server.models import Event, PhonePass, PhoneRevocation, Robot
from apps.server.fh_server.simulation import RelayError
from .test_api import csrf
from .test_sim_recovery import snapshot
from .test_simulation import (simulation_context, start_slot, LocalRelay, manager_app,
                             clean_ros_environment, isolated_manager_startup)


@pytest.fixture
def abandoned_start(simulation_context):
    client, old, cfg, rid, launcher = simulation_context
    reconcile = client.app.state.simulation_reconcile
    client.app.state.simulation_reconcile = lambda: None  # deterministic checkpoints
    original = client.app.state.simmgr.request

    def uncertain(method, path, body=None):
        if method == 'POST':
            raise RelayError()
        return original(method, path, body)

    client.app.state.simmgr.request = uncertain
    result, headers = start_slot(simulation_context)
    assert result.status_code == 503 and snapshot(client, rid)[0] == 'STARTING'
    client.app.state.simmgr.request = original
    with TestClient(manager_app(cfg), client=('127.0.0.1', 9588)) as new:
        client.app.state.simmgr = LocalRelay(new, cfg.secret)
        yield client, old, new, rid, headers, reconcile


@pytest.mark.parametrize('trigger', ['periodic', 'listing', 'background'])
def test_restart_abandoned_start_releases_for_another_account(abandoned_start, trigger):
    client, old, new, rid, headers, reconcile = abandoned_start
    before = snapshot(client, rid)
    issued = client.post(f'/api/v1/robots/{rid}/phone-pass', headers=headers,
                         json={'device': str(uuid4()), 'purpose': 'view'})
    assert issued.status_code == 200
    if trigger == 'periodic':
        reconcile()
    elif trigger == 'listing':
        assert client.get('/api/v1/simulation/robots').json()['cleanup'] == []
    else:
        client.app.state.simulation_reconcile = reconcile
        deadline = time.monotonic() + 5
        while snapshot(client, rid)[0] != 'IDLE' and time.monotonic() < deadline:
            time.sleep(.05)
    after = snapshot(client, rid)
    assert after[:3] == ('IDLE', None, 1) and after[3] != before[3]
    assert new.app.state.manager.removed_generation[rid] == 1
    assert old.app.state.manager.robots == new.app.state.manager.robots == {}
    with Session(client.app.state.engine) as db:
        records = list(db.scalars(select(Event).where(Event.code == 'SIM_ROBOT_REMOVED')))
        assert len(records) == 1
        assert records[0].data['reason'] == 'startup_recovery'
        assert records[0].data['recovered_absent'] is True
        passes = set(db.scalars(select(PhonePass.jti).where(PhonePass.robot_id == rid)))
        revoked = set(db.scalars(select(PhoneRevocation.jti).where(PhoneRevocation.robot_id == rid)))
        assert passes and passes <= revoked
    other = csrf(client, 'two')
    result = client.post('/api/v1/simulation/robots', headers=other,
                         json={'robot_id': rid, 'world_id': 'test'})
    assert result.status_code == 201, result.text
    assert result.json()['generation'] == 2


@pytest.mark.parametrize('broken', [
    'same_manager', 'legacy', 'catalogue', 'list_unavailable', 'list_malformed',
    'present', 'startup_clean', 'request_nonce', 'generation', 'robot_id',
    'manager_instance_id', 'absent', 'unreachable', 'malformed',
])
def test_unproven_start_preserves_owner_generation_and_credentials(abandoned_start, broken):
    client, old, new, rid, headers, reconcile = abandoned_start
    if broken == 'legacy':
        with Session(client.app.state.engine) as db:
            db.get(Robot, rid).sim_manager_instance_id = None
            db.commit()
    before = snapshot(client, rid)
    original = client.app.state.simmgr.request
    deletes = []

    def damaged(method, path, body=None):
        if method == 'GET' and path.startswith('/v1/robots'):
            if broken == 'list_unavailable':
                raise RelayError()
            if broken == 'list_malformed':
                return {'invalid': True}
            if broken == 'present':
                return {'items': [dict(robot_id=rid, owner_id=str(before[1]), generation=1,
                    world_id='test', simulation=True, state='STARTING', launcher='fake',
                    agent_address='ws://127.0.0.1:9588/phone/ws', namespace='/test',
                    tf_prefix='test/', command_topic='/test/v2_live/cmd_vel')]}
        if method == 'DELETE':
            deletes.append(body)
            if broken == 'unreachable':
                raise RelayError()
            if broken == 'malformed':
                return {'invalid': True}
        result = original(method, path, body)
        if path.startswith('/v1/worlds'):
            if broken == 'same_manager':
                result['manager_instance_id'] = str(old.app.state.instance_id)
            if broken == 'catalogue':
                result.pop('manager_instance_id')
        if method == 'DELETE':
            if broken in ('startup_clean', 'absent'):
                result[broken] = False
            elif broken in ('request_nonce', 'generation', 'robot_id', 'manager_instance_id'):
                result[broken] = 99 if broken == 'generation' else str(uuid4())
        return result

    client.app.state.simmgr.request = damaged
    reconcile()
    assert snapshot(client, rid) == before
    with Session(client.app.state.engine) as db:
        assert db.scalar(select(Event).where(Event.code == 'SIM_ROBOT_REMOVED')) is None
    if broken in ('same_manager', 'legacy', 'catalogue', 'list_unavailable', 'list_malformed', 'present'):
        assert deletes == []
    else:
        assert len(deletes) == 1
    other = csrf(client, 'two')
    blocked = client.post('/api/v1/simulation/robots', headers=other,
                          json={'robot_id': rid, 'world_id': 'test'})
    assert blocked.status_code == 409
    assert blocked.json()['error']['code'] == 'SIM_SLOT_BUSY'
    assert '관리자 확인' in blocked.json()['error']['message']


def test_recovery_receipt_cannot_release_a_successor(abandoned_start):
    client, old, new, rid, headers, reconcile = abandoned_start
    original = client.app.state.simmgr.request
    expected = []

    def superseded(method, path, body=None):
        result = original(method, path, body)
        if method == 'DELETE' and not expected:
            expected.append(None)
            assert client.delete(f'/api/v1/simulation/robots/{rid}', headers=headers).status_code == 204
            started = client.post('/api/v1/simulation/robots', headers=headers,
                                  json={'robot_id': rid, 'world_id': 'test'})
            assert started.status_code == 201
            expected[0] = snapshot(client, rid)
        return result

    client.app.state.simmgr.request = superseded
    reconcile()
    assert snapshot(client, rid) == expected[0]
    assert new.app.state.manager.robots[rid].generation == 2


def test_concurrent_recovery_and_start_claims_release_once(abandoned_start):
    client, old, new, rid, headers, reconcile = abandoned_start
    original = client.app.state.simmgr.request
    barrier = threading.Barrier(2)

    def simultaneous(method, path, body=None):
        if method == 'DELETE':
            barrier.wait(timeout=5)
        return original(method, path, body)

    client.app.state.simmgr.request = simultaneous
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(reconcile) for _ in range(2)]
        for future in futures:
            future.result(timeout=10)
    assert snapshot(client, rid)[:3] == ('IDLE', None, 1)
    with Session(client.app.state.engine) as db:
        assert len(list(db.scalars(select(Event).where(Event.code == 'SIM_ROBOT_REMOVED')))) == 1
    client.app.state.simmgr.request = original
    # Share the app without running its lifespan twice.
    other = TestClient(client.app, base_url='https://testserver')
    try:
        other_headers = csrf(other, 'two')
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(http.post, '/api/v1/simulation/robots', headers=auth,
                                   json={'robot_id': rid, 'world_id': 'test'})
                       for http, auth in [(client, headers), (other, other_headers)]]
            results = [future.result(timeout=10) for future in futures]
        assert sum(result.status_code == 201 for result in results) == 1
        assert all(result.status_code in (201, 403, 409) for result in results)
        assert snapshot(client, rid)[2] == new.app.state.manager.robots[rid].generation == 2
    finally:
        other.close()


def test_recovery_cancels_first_delivery_held_across_restart(simulation_context):
    client, old, cfg, rid, launcher = simulation_context
    reconcile = client.app.state.simulation_reconcile
    client.app.state.simulation_reconcile = lambda: None
    relay = client.app.state.simmgr
    original = relay.request
    held, resume = threading.Event(), threading.Event()
    headers = csrf(client)

    def delayed(method, path, body=None):
        if method == 'POST':
            held.set()
            assert resume.wait(10)
        return original(method, path, body)

    relay.request = delayed
    with ThreadPoolExecutor(max_workers=1) as pool:
        starting = pool.submit(client.post, '/api/v1/simulation/robots', headers=headers,
                               json={'robot_id': rid, 'world_id': 'test'})
        try:
            assert held.wait(5)
            with TestClient(manager_app(cfg), client=('127.0.0.1', 9588)) as new:
                relay.client = new
                reconcile()
                expected = snapshot(client, rid)
                assert expected[:3] == ('IDLE', None, 1)
                resume.set()
                assert starting.result(timeout=5).status_code == 409
                assert new.app.state.manager.robots == {}
                assert snapshot(client, rid) == expected
        finally:
            resume.set()

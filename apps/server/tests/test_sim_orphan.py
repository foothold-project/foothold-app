"""Durable cleanup targets survive manager restart; absence alone never releases."""
from fastapi.testclient import TestClient
from uuid import uuid4
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from apps.server.fh_server.models import Event, Robot
from apps.server.fh_server.simulation import RelayError
from .test_api import csrf
from .test_simulation import (simulation_context, start_slot, LocalRelay, manager_app,
                             clean_ros_environment, isolated_manager_startup)
from .test_sim_recovery import snapshot


@pytest.mark.parametrize('proof', [True, False])
def test_restart_lists_orphan_and_requires_startup_proof(simulation_context, proof):
    client, old, cfg, rid, launcher = simulation_context
    started, headers = start_slot(simulation_context)
    assert started.status_code == 201
    # The original manager completed runtime cleanup, but its reply was lost.
    old.portal.call(old.app.state.manager.remove, rid, 1)
    with TestClient(manager_app(cfg), client=('127.0.0.1', 9418)) as new:
        new.app.state.preflight = {'resources_ok': proof}
        client.app.state.simmgr = LocalRelay(new, cfg.secret)
        listing = client.get('/api/v1/simulation/robots')
        assert listing.status_code == 200
        assert listing.json()['items'] == []
        cleanup = listing.json()['cleanup']
        assert len(cleanup) == 1 and cleanup[0]['robot_id'] == rid
        assert cleanup[0]['can_recover'] is True
        assert new.app.state.instance_id != old.app.state.instance_id
        before = snapshot(client, rid)
        result = client.delete('/api/v1/simulation/robots/' + rid, headers=headers)
        assert result.status_code == (204 if proof else 503), result.text
        with Session(client.app.state.engine) as db:
            audits = list(db.scalars(select(Event).where(Event.code == 'SIM_ROBOT_REMOVED')))
        if proof:
            assert snapshot(client, rid)[:3] == ('IDLE', None, 1)
            assert len(audits) == 1 and audits[0].data['recovered_absent'] is True
            assert client.get('/api/v1/simulation/robots').json()['cleanup'] == []
        else:
            assert snapshot(client, rid)[:3] == ('STOPPING', before[1], 1)
            assert snapshot(client, rid)[3] == before[3] and not audits


def test_unreachable_manager_keeps_cleanup_visible_and_authorized(simulation_context):
    client, old, cfg, rid, launcher = simulation_context
    result, headers = start_slot(simulation_context)
    assert result.status_code == 201
    original = client.app.state.simmgr
    class Down:
        def request(self, *args, **kwargs):
            raise RelayError(detail={'reason': 'manager_unreachable'})
    client.app.state.simmgr = Down()
    assert client.delete('/api/v1/simulation/robots/' + rid, headers=headers).status_code == 503
    assert client.get('/api/v1/simulation/robots').json()['cleanup'][0]['robot_id'] == rid
    other = csrf(client, 'two')
    assert client.get('/api/v1/simulation/robots').json()['cleanup'] == []
    assert client.delete('/api/v1/simulation/robots/' + rid, headers=other).status_code == 403
    client.app.state.simmgr = original


def test_same_failed_manager_cannot_use_stale_startup_proof(simulation_context):
    client, old, cfg, rid, launcher = simulation_context
    result, headers = start_slot(simulation_context)
    assert result.status_code == 201
    old.portal.call(old.app.state.manager.remove, rid, 1)
    old.app.state.manager.failed = True
    before = snapshot(client, rid)
    response = client.delete('/api/v1/simulation/robots/' + rid, headers=headers)
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'SIM_RECOVERY_UNPROVEN'
    assert snapshot(client, rid) == ('STOPPING', before[1], before[2], before[3])


@pytest.mark.parametrize('missing', ['legacy', 'malformed', 'failed_manager'])
def test_insufficient_absence_proof_preserves_generation_and_credentials(simulation_context, missing):
    client, old, cfg, rid, launcher = simulation_context
    result, headers = start_slot(simulation_context)
    assert result.status_code == 201
    old.portal.call(old.app.state.manager.remove, rid, 1)
    if missing == 'legacy':
        with Session(client.app.state.engine) as db:
            db.get(Robot, rid).sim_manager_instance_id = None
            db.commit()
    before = snapshot(client, rid)
    with TestClient(manager_app(cfg), client=('127.0.0.1', 9418)) as new:
        relay = LocalRelay(new, cfg.secret)
        if missing == 'failed_manager':
            new.app.state.manager.failed = True
        if missing == 'malformed':
            original = relay.request
            relay.request = lambda method, path, body=None: {} if method == 'DELETE' else original(method, path, body)
        client.app.state.simmgr = relay
        cleanup = client.get('/api/v1/simulation/robots').json()['cleanup'][0]
        assert cleanup['can_recover'] is (missing != 'legacy')
        response = client.delete('/api/v1/simulation/robots/' + rid, headers=headers)
        assert response.status_code == 503
        assert response.json()['error']['code'] == 'SIM_RECOVERY_UNPROVEN'
        assert snapshot(client, rid) == ('STOPPING', before[1], before[2], before[3])


def test_old_absence_receipt_cannot_release_a_live_new_generation(simulation_context):
    client, manager, cfg, rid, launcher = simulation_context
    started, headers = start_slot(simulation_context)
    assert started.status_code == 201
    assert client.delete('/api/v1/simulation/robots/' + rid, headers=headers).status_code == 204
    relay = client.app.state.simmgr
    old = relay.request('DELETE', '/v1/robots/' + rid,
                        {'generation': 1, 'request_nonce': str(uuid4())})
    assert old['absent'] is True and old['startup_clean'] is True
    started, headers = start_slot(simulation_context)
    assert started.status_code == 201 and started.json()['generation'] == 2
    before = snapshot(client, rid)
    events_before = list(launcher.events)
    nonces = []
    class Replay:
        def request(self, method, path, body=None):
            if method == 'DELETE':
                nonces.append(body['request_nonce'])
                return old
            return relay.request(method, path, body)
    client.app.state.simmgr = Replay()
    for _ in range(2):
        removed = client.delete('/api/v1/simulation/robots/' + rid, headers=headers)
        assert removed.status_code == 503
        assert removed.json()['error']['code'] == 'SIM_RECOVERY_UNPROVEN'
        assert snapshot(client, rid) == ('STOPPING', before[1], 2, before[3])
        alive = manager.app.state.manager.robots[rid]
        assert (alive.generation, alive.state) == (2, 'PREPARED')
        assert launcher.events == events_before
    assert len(set([old['request_nonce'], *nonces])) == 3
    with Session(client.app.state.engine) as db:
        removed = list(db.scalars(select(Event).where(Event.code == 'SIM_ROBOT_REMOVED')))
        assert len(removed) == 1 and removed[0].data['generation'] == 1


@pytest.mark.parametrize('absent', [True, False])
@pytest.mark.parametrize('field', ['robot_id', 'generation', 'request_nonce', 'manager_instance_id'])
@pytest.mark.parametrize('missing', [False, True])
def test_removal_receipt_binding_required(simulation_context, absent, field, missing):
    client, manager, cfg, rid, launcher = simulation_context
    started, headers = start_slot(simulation_context)
    assert started.status_code == 201
    before = snapshot(client, rid)
    events_before = list(launcher.events)
    original = client.app.state.simmgr.request
    def faulty(method, path, body=None):
        if method != 'DELETE':
            return original(method, path, body)
        result = dict(robot_id=rid, generation=body['generation'], request_nonce=body['request_nonce'],
                      manager_instance_id=str(manager.app.state.instance_id), absent=absent, startup_clean=True)
        if missing:
            result.pop(field)
        elif field == 'manager_instance_id':
            result[field] = 'invalid-uuid'
        else:
            result[field] = 99 if field == 'generation' else str(uuid4())
        return result
    client.app.state.simmgr.request = faulty
    result = client.delete('/api/v1/simulation/robots/' + rid, headers=headers)
    assert result.status_code == 503 and result.json()['error']['code'] == 'SIM_RECOVERY_UNPROVEN'
    assert snapshot(client, rid) == ('STOPPING', before[1], before[2], before[3])
    assert manager.app.state.manager.robots[rid].generation == 1
    assert launcher.events == events_before


def test_same_instance_absence_is_normal_cancellation_receipt(simulation_context):
    client, manager, cfg, rid, launcher = simulation_context
    started, headers = start_slot(simulation_context)
    assert started.status_code == 201
    manager.portal.call(manager.app.state.manager.remove, rid, 1)
    events_before = list(launcher.events)
    assert client.delete('/api/v1/simulation/robots/' + rid, headers=headers).status_code == 204
    assert snapshot(client, rid)[:3] == ('IDLE', None, 1)
    assert manager.app.state.manager.removed_generation[rid] == 1
    assert launcher.events == events_before
    with Session(client.app.state.engine) as db:
        removed = list(db.scalars(select(Event).where(Event.code == 'SIM_ROBOT_REMOVED')))
        assert len(removed) == 1 and removed[0].data['recovered_absent'] is False


@pytest.mark.parametrize('failure', ['disabled', 'unreachable', 'malformed'])
def test_list_reports_manager_failure_without_releasing_slot(simulation_context, failure):
    client, manager, cfg, rid, launcher = simulation_context
    started, headers = start_slot(simulation_context)
    assert started.status_code == 201
    assert client.get('/api/v1/simulation/robots').json()['manager_error'] is None
    before = snapshot(client, rid)
    class Down:
        def request(self, *args, **kwargs):
            if failure == 'malformed':
                return {'invalid': True}
            raise RelayError()
    client.app.state.simmgr = None if failure == 'disabled' else Down()
    listed = client.get('/api/v1/simulation/robots')
    assert listed.status_code == 200
    assert listed.json()['manager_error'] == ('SIM_DISABLED' if failure == 'disabled' else 'SIM_UNAVAILABLE')
    assert listed.json()['cleanup'][0]['robot_id'] == rid
    assert snapshot(client, rid) == before

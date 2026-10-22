"""Private DB + authenticated synthetic manager; no runtime or real units."""
import asyncio
import time
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from apps.server.fh_server.models import Event, PhonePass, PhoneRevocation, Robot
from .test_simulation import (simulation_context, start_slot, clean_ros_environment,
                              isolated_manager_startup)
from .test_sim_recovery import snapshot


async def expire_now(manager):
    manager.expiry_task.cancel()
    await asyncio.gather(manager.expiry_task, return_exceptions=True)
    manager.expiry_task = asyncio.create_task(manager._expire_at(asyncio.get_running_loop().time()))
    await manager.expiry_task


def test_background_deadline_release_revokes_pass_and_allows_next_generation(simulation_context):
    client, sim, cfg, rid, launcher = simulation_context
    result, headers = start_slot(simulation_context)
    assert result.status_code == 201 and result.json()['expires_at']
    before = snapshot(client, rid)
    issued = client.post(f'/api/v1/robots/{rid}/phone-pass', headers=headers,
                         json={'device': str(uuid4()), 'purpose': 'view'})
    assert issued.status_code == 200
    manager = sim.app.state.manager
    sim.portal.call(expire_now, manager)
    # No phone/list request: the lifespan worker must release independently.
    end = time.monotonic() + 5
    while snapshot(client, rid)[0] != 'IDLE' and time.monotonic() < end:
        time.sleep(.05)
    after = snapshot(client, rid)
    assert after[:3] == ('IDLE', None, 1) and after[3] != before[3]
    assert manager.failed is False and not manager.robots
    with Session(client.app.state.engine) as db:
        passes = set(db.scalars(select(PhonePass.jti).where(PhonePass.robot_id == rid)))
        revoked = set(db.scalars(select(PhoneRevocation.jti).where(PhoneRevocation.robot_id == rid)))
        assert passes and passes <= revoked
        events = list(db.scalars(select(Event).where(Event.code == 'SIM_ROBOT_REMOVED')))
        assert len(events) == 1 and events[0].data['reason'] == 'time_limit'
    body = client.get('/api/v1/simulation/robots').json()
    assert body['items'] == body['cleanup'] == []
    assert body['expired'] == [dict(robot_id=rid, owner_id=str(before[1]), generation=1, reason='time_limit')]
    again = client.post('/api/v1/simulation/robots', headers=headers,
                        json={'robot_id': rid, 'world_id': 'test'})
    assert again.status_code == 201 and again.json()['generation'] == 2
    assert client.get('/api/v1/simulation/robots').json()['expired'] == []


@pytest.mark.parametrize('broken', ['request_nonce', 'robot_id', 'generation', 'startup_clean'])
def test_expiration_release_requires_existing_bound_removal_proof(simulation_context, broken):
    client, sim, cfg, rid, launcher = simulation_context
    result, headers = start_slot(simulation_context)
    assert result.status_code == 201
    before = snapshot(client, rid)
    original = client.app.state.simmgr.request
    def corrupt(method, path, body=None):
        result = original(method, path, body)
        if method == 'DELETE':
            result[broken] = (False if broken == 'startup_clean' else
                              99 if broken == 'generation' else str(uuid4()))
        return result
    client.app.state.simmgr.request = corrupt
    sim.portal.call(expire_now, sim.app.state.manager)
    client.app.state.simulation_reconcile()
    assert snapshot(client, rid) == ('STOPPING', *before[1:])
    listed = client.get('/api/v1/simulation/robots').json()
    assert listed['expired'] == [] and listed['cleanup'][0]['robot_id'] == rid
    client.app.state.simmgr.request = original
    assert client.delete(f'/api/v1/simulation/robots/{rid}', headers=headers).status_code == 204


@pytest.mark.parametrize('broken', ['owner_id', 'robot_id', 'generation'])
def test_stale_completion_does_not_touch_live_generation(simulation_context, broken):
    client, sim, cfg, rid, launcher = simulation_context
    result, headers = start_slot(simulation_context)
    assert result.status_code == 201
    before = snapshot(client, rid)
    original = client.app.state.simmgr.request
    deletes = []
    def stale(method, path, body=None):
        result = original(method, path, body)
        if method == 'GET' and path.startswith('/v1/robots'):
            completed = dict(robot_id=rid, owner_id=str(before[1]), generation=1, reason='time_limit')
            completed[broken] = 99 if broken == 'generation' else str(uuid4())
            result['expired'] = [completed]
        if method == 'DELETE':
            deletes.append(body)
        return result
    client.app.state.simmgr.request = stale
    client.app.state.simulation_reconcile()
    assert snapshot(client, rid) == before and deletes == []
    assert sim.app.state.manager.robots[rid].generation == 1


def test_failed_deadline_cleanup_retains_active_slot_and_no_completion(simulation_context):
    client, sim, cfg, rid, launcher = simulation_context
    result, headers = start_slot(simulation_context)
    assert result.status_code == 201
    before = snapshot(client, rid)
    original = launcher.stop_agent
    async def broken(slot):
        raise RuntimeError('unconfirmed STOP/zero')
    launcher.stop_agent = broken
    sim.portal.call(expire_now, sim.app.state.manager)
    client.app.state.simulation_reconcile()
    assert snapshot(client, rid) == before
    body = client.get('/api/v1/simulation/robots').json()
    assert body['items'][0]['state'] == 'ERROR' and body['expired'] == []
    assert sim.app.state.manager.failed
    launcher.stop_agent = original

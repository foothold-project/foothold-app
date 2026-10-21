"""Delayed DELETE must never cross a slot generation, including same-owner reuse."""
from concurrent.futures import ThreadPoolExecutor
import threading
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from apps.server.tests.test_simulation import simulation_context, start_slot, clean_ros_environment
from apps.server.fh_server.models import Robot, PhonePass, PhoneRevocation, Event


@pytest.mark.parametrize('phase', ['before_manager', 'after_manager'])
@pytest.mark.parametrize('replacement_owner', ['two', 'one'])
def test_old_delete_preserves_reacquired_generation(simulation_context, seeded, phase, replacement_owner):
    client, sim, cfg, rid, launcher = simulation_context
    started, headers = start_slot(simulation_context)
    assert started.status_code == 201
    original = client.app.state.simmgr.request
    held, resume = threading.Event(), threading.Event()
    gate = threading.Lock()
    deletes = [0]
    def delayed(method, path, body=None):
        if method == 'DELETE':
            with gate:
                deletes[0] += 1
                first = deletes[0] == 1
            if first:
                response = original(method, path, body) if phase == 'after_manager' else None
                held.set()
                assert resume.wait(10), 'review gate timed out'
                if phase == 'after_manager':
                    return response
        return original(method, path, body)
    client.app.state.simmgr.request = delayed
    with ThreadPoolExecutor(max_workers=1) as executor:
        old = executor.submit(client.delete, f'/api/v1/simulation/robots/{rid}', headers=headers)
        try:
            assert held.wait(5)
            # STOPPING is reserved even for the same user.
            blocked = client.post('/api/v1/simulation/robots', headers=headers,
                                  json={'robot_id':rid,'world_id':'test'})
            assert blocked.status_code == 409
            assert client.delete(f'/api/v1/simulation/robots/{rid}', headers=headers).status_code == 204
            replacement, second_headers = start_slot(simulation_context, replacement_owner)
            assert replacement.status_code == 201, replacement.text
            assert replacement.json()['generation'] == 2
            new_pass = client.post(f'/api/v1/robots/{rid}/phone-pass', headers=second_headers,
                json={'device': str(uuid4()), 'purpose': 'control'})
            assert new_pass.status_code == 200
            with Session(client.app.state.engine) as db:
                expected_hash = db.get(Robot, rid).agent_token_hash
                jti = db.scalar(select(PhonePass.jti).where(PhonePass.robot_id == rid).order_by(PhonePass.iat.desc()))
            resume.set()
            assert old.result(timeout=10).status_code == 409
            manager_row = sim.app.state.manager.robots[rid]
            assert manager_row.generation == 2 and manager_row.owner == str(seeded['users'][replacement_owner])
            with Session(client.app.state.engine) as db:
                row = db.get(Robot, rid)
                assert row.owner_user_id == seeded['users'][replacement_owner]
                assert row.sim_generation == 2 and row.sim_state == 'ACTIVE'
                assert row.agent_token_hash == expected_hash
                assert db.scalar(select(PhoneRevocation).where(PhoneRevocation.jti == jti)) is None
                code = 'SIM_ROBOT_REMOVE_STALE' if phase == 'after_manager' else 'SIM_ROBOT_REMOVE_FAILED'
                assert len(list(db.scalars(select(Event).where(Event.code == code)))) == 1
        finally:
            resume.set()


@pytest.mark.parametrize('retry',[False,True])
def test_stalled_catalogue_releases_organization_write_lock(simulation_context,retry):
    from .test_api import csrf
    client, sim, cfg, rid, launcher = simulation_context
    if retry:
        first,headers=start_slot(simulation_context,'admin')
        assert first.status_code==201
    else:
        headers = csrf(client, 'admin')
    original = client.app.state.simmgr.request
    held, resume = threading.Event(), threading.Event()
    def delayed(method, path, body=None):
        target='/v1/robots?' if retry else '/v1/worlds?'
        if method == 'GET' and path.startswith(target):
            held.set()
            assert resume.wait(10)
        return original(method, path, body)
    client.app.state.simmgr.request = delayed
    with ThreadPoolExecutor(max_workers=2) as executor:
        add = executor.submit(client.post, '/api/v1/simulation/robots', headers=headers,
                              json={'robot_id': rid, 'world_id': 'test'})
        try:
            assert held.wait(5)
            write = executor.submit(client.patch, '/api/v1/org/settings', headers=headers, json={})
            assert write.result(timeout=2).status_code == 200
        finally:
            resume.set()
        assert add.result(timeout=10).status_code == 201


def test_normal_delete_and_owner_patch_cannot_change_simulation(simulation_context):
    from .test_api import csrf
    client, sim, cfg, rid, launcher = simulation_context
    result, _ = start_slot(simulation_context)
    assert result.status_code == 201
    headers = csrf(client, 'admin')
    for response in (client.patch(f'/api/v1/robots/{rid}', headers=headers, json={'owner_user_id': None}),
                     client.delete(f'/api/v1/robots/{rid}', headers=headers)):
        assert response.status_code == 409 and response.json()['error']['code'] == 'SIM_ROBOT_MANAGED'
    with Session(client.app.state.engine) as db:
        assert db.get(Robot, rid).archived_at is None

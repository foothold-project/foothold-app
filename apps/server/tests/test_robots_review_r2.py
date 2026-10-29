"""PR18 r2: latest inventory, bounded recovery and regrant delivery policy."""
import asyncio
from dataclasses import replace
from datetime import timedelta
import threading
import time
from pathlib import Path
import runpy
import socket
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server import inventory as module
from apps.server.fh_server.leases import Actor
from apps.server.fh_server.models import Robot, RobotDevice, now
from apps.server.fh_server.realtime import Peer, Policy
from apps.server.fh_server.security import digest
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take
from .test_realtime_review import Sink

P = '/api/v1'
D = dict(key='rgb', kind='CAMERA_RGB', label='fake', state='OK')


def test_dashboard_device_error_matches_latest_inventory_before_storage(client, seeded, rt):
    admin, rid = app_token(client, 'admin'), str(seeded['robots']['mine'])
    async def hold():
        await rt.inventory.slots.acquire()
        await rt.inventory.slots.acquire()
    client.portal.call(hold)
    try:
        with agent(client, seeded) as ag:
            def check(devices, expected):
                frame = state(devices_changed=devices)
                frame['latched'] = False
                ag.send_json(frame)
                deadline = time.monotonic() + 2
                while client.portal.call(lambda: rt.agents[rid].state.get('devices')) != devices:
                    assert time.monotonic() < deadline
                    time.sleep(.001)
                detail = client.get(P+'/robots/'+rid, headers=admin).json()
                listed = client.get(P+'/robots?scope=all', headers=admin).json()['items']
                assert ('DEVICE_ERROR' in detail['attention']) == expected
                assert next(r for r in listed if r['id'] == rid)['attention'] == detail['attention']
                assert client.get(P+'/dashboard', headers=admin).json()['robots_attention'] == 1 + expected
            # DB has no error, but the latest in-memory inventory does.
            check([{**D, 'state': 'ERROR'}], True)
            # Keep DB ERROR while live inventory recovers or omits the device.
            with Session(rt.inventory.engine) as db:
                db.add(RobotDevice(org_id=seeded['org'], robot_id=seeded['robots']['mine'],
                    **{**D, 'state': 'ERROR'}))
                db.commit()
            check([D], False)
            check([], False)
    finally:
        client.portal.call(rt.inventory.slots.release)
        client.portal.call(rt.inventory.slots.release)


def test_failed_latest_inventory_retries_without_another_submit(client, seeded, rt, monkeypatch):
    original, calls, failures = module.save_inventory, [], []
    def flaky(*args):
        calls.append(args[3])
        if len(calls) == 1:
            raise OSError('synthetic temporary metadata failure')
        return original(*args)
    monkeypatch.setattr(module, 'save_inventory', flaky)
    monkeypatch.setattr(rt.inventory, 'RETRY_DELAY', .01)
    monkeypatch.setattr(rt.inventory, 'failed', lambda *args: failures.append(args))
    rid = str(seeded['robots']['mine'])
    async def check():
        rt.inventory.submit(rid, [D], None, None)
        await asyncio.wait_for(rt.inventory.jobs[rid].task, 2)
        assert len(calls) == 2 and len(failures) == 1
        assert rt.inventory.jobs[rid].saved is not None
    client.portal.call(check)
    with Session(rt.inventory.engine) as db:
        assert db.scalar(select(RobotDevice).where(RobotDevice.robot_id == seeded['robots']['mine'])).state == 'OK'


def test_inventory_retry_budget_is_finite_and_new_value_rearms(client, seeded, rt, monkeypatch):
    calls, failures = [], []
    def broken(*args):
        calls.append(args[3])
        # Let an unbounded mutant finish so the failure is a count assertion,
        # rather than a timeout or a background task error.
        if len(calls) > 6:
            return
        raise OSError('synthetic persistent metadata failure')
    monkeypatch.setattr(module, 'save_inventory', broken)
    monkeypatch.setattr(rt.inventory, 'RETRY_DELAY', .01)
    monkeypatch.setattr(rt.inventory, 'failed', lambda *args: failures.append(args))
    rid = str(seeded['robots']['mine'])
    async def check():
        rt.inventory.submit(rid, [D], None, None)
        job = rt.inventory.jobs[rid]
        await asyncio.wait_for(job.task, 2)
        assert len(calls) == len(failures) == 3
        assert job.pending is None and job.task is None and job.exhausted is not None
        for _ in range(100):
            rt.inventory.submit(rid, [D], None, None)
        await asyncio.sleep(.02)
        assert len(calls) == 3
        rt.inventory.submit(rid, [{**D, 'state': 'ERROR'}], None, None)
        await asyncio.wait_for(job.task, 2)
        assert len(calls) == len(failures) == 6
    client.portal.call(check)


def test_telemetry_tool_reserves_only_configured_port(monkeypatch):
    tool = runpy.run_path(str(Path(__file__).resolve().parents[3] /
        'apps/agent/tools/check_telemetry_integration.py'))
    with socket.socket() as occupied:
        occupied.bind(('127.0.0.1', 0))
        occupied.listen(1)
        port = occupied.getsockname()[1]
        monkeypatch.setenv('FH_TEST_PORT_RANGE', f'{port}:{port}')
        with pytest.raises(RuntimeError, match='no available loopback test port'):
            with tool['server_socket']():
                pass
    with tool['server_socket']() as reserved:
        assert reserved.getsockname() == ('127.0.0.1', port)


@pytest.mark.parametrize('change', ['newer', 'forget', 'token', 'reconnect'])
def test_failed_write_cannot_restore_old_snapshot_over_new_generation(client, seeded, rt, monkeypatch, change):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def write(factory, org, rid, devices, model, token_hash):
        calls.append((devices, model, token_hash))
        if len(calls) == 1:
            entered.set()
            assert release.wait(2)
            raise OSError('synthetic in-flight failure')
    monkeypatch.setattr(module, 'save_inventory', write)
    monkeypatch.setattr(rt.inventory, 'RETRY_DELAY', .01)
    rid = str(seeded['robots']['mine'])
    async def check():
        rt.inventory.submit(rid, [D], 'old-model', b'old-token')
        job = rt.inventory.jobs[rid]
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            if change in ('forget', 'reconnect'):
                rt.inventory.forget(rid)
            if change == 'reconnect':
                rt.inventory.submit(rid, [D], 'old-model', b'old-token')
            elif change != 'forget':
                rt.inventory.submit(rid, [{**D, 'label': 'latest'}], None,
                    b'new-token' if change == 'token' else b'old-token')
            release.set()
            await asyncio.wait_for(job.task, 2)
            if change == 'forget':
                assert len(calls) == 1 and rid not in rt.inventory.jobs
            else:
                assert len(calls) == 2
                assert calls[-1][0][0]['label'] == ('fake' if change == 'reconnect' else 'latest')
                assert calls[-1][1] == (None if change == 'token' else 'old-model')
                assert calls[-1][2] == (b'new-token' if change == 'token' else b'old-token')
        finally:
            release.set()
    client.portal.call(check)


def test_hello_model_survives_coalescing_and_reaches_database(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    async def check():
        await rt.inventory.slots.acquire()
        await rt.inventory.slots.acquire()
        try:
            rt.inventory.submit(rid, [D], 'actual-robot-model', None)
            await asyncio.sleep(0)
            rt.inventory.submit(rid, [{**D, 'state': 'ERROR'}], None, None)
            job = rt.inventory.jobs[rid]
            assert job.pending[1] == 'actual-robot-model'
        finally:
            rt.inventory.slots.release()
            rt.inventory.slots.release()
        await asyncio.wait_for(job.task, 2)
    client.portal.call(check)
    with Session(rt.inventory.engine) as db:
        assert db.get(Robot, seeded['robots']['mine']).model == 'actual-robot-model'
        assert db.scalar(select(RobotDevice).where(RobotDevice.robot_id == seeded['robots']['mine'])).state == 'ERROR'


def test_new_hello_rearms_exhausted_inventory_generation(client, seeded, rt, monkeypatch):
    original, calls = module.save_inventory, []
    def flaky(*args):
        calls.append(args[3])
        if len(calls) == 1:
            raise OSError('synthetic exhausted old connection')
        return original(*args)
    monkeypatch.setattr(module, 'save_inventory', flaky)
    monkeypatch.setattr(rt.inventory, 'MAX_ATTEMPTS', 1)
    rid = str(seeded['robots']['mine'])
    async def old_generation():
        rt.inventory.submit(rid, [D], 'actual-robot-model', digest('fake-test-'+rid))
        await rt.inventory.jobs[rid].task
        assert rt.inventory.jobs[rid].exhausted is not None
    client.portal.call(old_generation)
    with agent(client, seeded, devices=[D], robot_model='actual-robot-model'):
        async def saved():
            job = rt.inventory.jobs[rid]
            if job.task:
                await asyncio.wait_for(job.task, 2)
            assert len(calls) == 2 and job.saved is not None and job.exhausted is None
        client.portal.call(saved)
    with Session(rt.inventory.engine) as db:
        assert db.get(Robot, seeded['robots']['mine']).model == 'actual-robot-model'


def test_regrant_requires_resubscription_before_take_or_request(client, seeded, rt):
    admin, own = app_token(client, 'admin'), app_token(client)
    rid, other = str(seeded['robots']['mine']), str(seeded['users']['two'])
    with agent(client, seeded) as ag, screen(client, own) as ws:
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        assert client.patch(P+'/robots/'+rid, headers=admin, json={'owner_user_id': other}).status_code == 200
        receive(ws, 'subscription.revoked')
        assert client.patch(P+'/robots/'+rid, headers=admin,
            json={'owner_user_id': str(seeded['users']['one'])}).status_code == 200
        async def verified():
            peer = next(iter(rt.screens.values()))
            async with asyncio.timeout(2):
                while True:
                    await rt.refresh_policy(peer)
                    marker = rt.robot_changed_at[(rid, peer.actor.user)]
                    if peer.policy.checked > marker and 'O_OWN' in peer.policy.rights.get(rid, ()):
                        return
                    await asyncio.sleep(.005)
        client.portal.call(verified)
        before = rt.arbiter.robot(rid).stop_ref
        for kind in ('lease.take', 'lease.request'):
            result = reply(ws, send(ws, kind, rid))
            assert not result['ok'] and result['error']['code'] == 'SUBSCRIPTION_REQUIRED'
            record = rt.arbiter.robot(rid)
            assert record.holder is record.transfer is record.request is None
            assert record.stop_ref == before
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        assert take(ws, ag, rid)


@pytest.mark.parametrize('policy_age', [0, .501])
def test_take_confirmation_at_policy_boundary_is_deterministic(client, seeded, rt, monkeypatch, policy_age):
    rid, fixed = str(seeded['robots']['mine']), rt.clock()
    monkeypatch.setattr(rt, 'clock', lambda: fixed)
    monkeypatch.setattr(rt.arbiter, 'clock', rt.clock)
    async def check():
        actor = Actor(str(seeded['users']['one']), str(uuid4()), 'fixed-policy-boundary')
        policy = Policy({rid: frozenset({'O_OWN', 'ROBOT_READ'})}, C.OrgSettings(),
            now()+timedelta(hours=1), fixed)
        peer = Peer(Sink(), actor=actor, policy=policy)
        ag = Peer(Sink(), auth_checked=fixed, simulation=True)
        rt.screens[actor.connection], rt.agents[rid] = peer, ag
        try:
            rt.apply(rt.arbiter.take(rid, actor))
            while not ag.queue.empty():
                ag.queue.get_nowait()
            peer.policy = replace(policy, checked=fixed-policy_age)
            assert rt.accept_state(rid, ag, C.AgentState.model_validate(
                state(3, stop_ref=rt.arbiter.robot(rid).stop_ref)))
            messages = []
            while not ag.queue.empty():
                messages.append(ag.queue.get_nowait())
            record = rt.arbiter.robot(rid)
            if policy_age:
                assert [(m['t'], m.get('lease_id')) for m in messages] == [('lease', None), ('stop', None)]
                assert record.holder is record.transfer is None
                assert not any(m['t'] in ('cmd', 'unlock') for m in messages)
            else:
                assert record.holder is not None and record.transfer is None
                assert messages[0]['lease_id'] == record.holder.lease_id
        finally:
            rt.screens.pop(actor.connection)
            rt.agents.pop(rid)
    client.portal.call(check)


def test_policy_release_retires_all_producers_before_waiting(client, seeded, rt):
    async def check():
        entered, released = asyncio.Event(), asyncio.Event()
        class Pipeline:
            def __init__(self):
                self.task = asyncio.create_task(asyncio.Event().wait())
            async def close(self):
                self.task.cancel()
                entered.set()
                await released.wait()
                await asyncio.gather(self.task, return_exceptions=True)
        pipelines = [Pipeline(), Pipeline()]
        actor = Actor(str(seeded['users']['one']), str(uuid4()), 'cancel-cleanup')
        peer = Peer(Sink(), actor=actor)
        rt.policy_members[actor.session] = {actor.connection: peer}
        rt.policy_peers[actor.session] = peer
        rt.policy_pipelines.update(dict(zip(('view', 'control'), pipelines)))
        task = asyncio.create_task(rt.release_policy(peer))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            assert not rt.policy_pipelines and not rt.policy_peers
            assert all(p.task.cancelling() for p in pipelines)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert not rt.policy_pipelines
        finally:
            released.set()
            task.cancel()
            for p in pipelines:
                p.task.cancel()
            await asyncio.gather(task, *(p.task for p in pipelines), return_exceptions=True)
    client.portal.call(check)


@pytest.mark.parametrize('failure', ['denied', 'transient'])
def test_preaccept_rejection_is_published_after_policy_cleanup(client, seeded, rt, monkeypatch, failure):
    from sqlalchemy.exc import OperationalError
    def broken(lane):
        if failure == 'denied':
            raise rt.api_error(401, 'AUTH_REQUIRED', 'synthetic rejection')
        raise OperationalError('synthetic transient', {}, OSError('offline'))
    monkeypatch.setattr(rt, 'load_policy_batch', broken)
    headers, closed = app_token(client), []
    class Socket:
        cookies = {}
        async def accept(self):
            pass
        async def close(self, *, code):
            assert not rt.policy_peers and not rt.policy_pipelines and not rt.policy_loads
            closed.append(code)
    socket = Socket()
    socket.headers = headers
    client.portal.call(rt.screen_ws, socket)
    assert closed == [4401 if failure == 'denied' else 1013]

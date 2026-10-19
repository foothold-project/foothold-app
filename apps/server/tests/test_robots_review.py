"""PR18 review regressions: delivery, metadata isolation, scope and bounded reads."""
import asyncio
from dataclasses import replace
from datetime import timedelta
import threading
import time
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect

from apps.contracts import models as C
from apps.server.fh_server.api import APIError
from apps.server.fh_server.leases import Actor
from apps.server.fh_server.models import Robot, now
from apps.server.fh_server.realtime import Peer, Policy
from .test_realtime import agent, app_token, hello, receive, reply, rt, screen, send, state, take
from .test_realtime_review import Sink

P = '/api/v1'
D = dict(key='rgb', kind='CAMERA_RGB', label='fake', state='OK')


@pytest.mark.parametrize('inflight', [False, True])
def test_revoke_discards_private_frames_and_rechecks_after_send_lock(client, seeded, rt, inflight):
    rid, other = str(seeded['robots']['mine']), str(uuid4())
    async def check():
        sink, entered = Sink(), asyncio.Event()
        actor = Actor(str(seeded['users']['one']), str(uuid4()), 'review-delivery')
        policy = Policy({r: frozenset({'ROBOT_READ'}) for r in (rid, other)},
            C.OrgSettings(), now()+timedelta(hours=1), rt.clock())
        peer = Peer(sink, actor=actor, policy=policy, subscriptions={rid: {'state'}, other: {'state'}})
        rt.screens[actor.connection] = peer
        old_send = rt.send_body
        async def tracked(*args, **kwargs):
            entered.set()
            return await old_send(*args, **kwargs)
        rt.send_body = tracked
        if inflight:
            await peer.send_lock.acquire()
        rt.put(peer, dict(t='state', robot=rid, battery={'soc': 73}))
        rt.put(peer, dict(t='event', robot=rid, message='private'))
        rt.put(peer, dict(t='state', robot=other, battery={'soc': 15}))
        task = asyncio.create_task(rt.writer(peer, True)) if inflight else None
        try:
            if inflight:
                await asyncio.wait_for(entered.wait(), 1)
            rt.robot_changed(rid, old_owner=actor.user)
            assert not any(item.get('_delivery', {}).get('robot') == rid
                           for item in peer.queue._queue)
            # Granting read again cannot resurrect a frame from the previous
            # subscription generation that is already waiting on send_lock.
            if inflight:
                peer.revoked_robots.discard(rid)
                peer.subscriptions[rid] = {'state'}
                peer.policy = replace(policy, checked=rt.clock())
                peer.send_lock.release()
            if task is None:
                task = asyncio.create_task(rt.writer(peer, True))
            async with asyncio.timeout(1):
                while not any(m.get('t') == 'subscription.revoked' for m in sink.messages):
                    await asyncio.sleep(.001)
            assert not any(m.get('robot') == rid and m['t'] in ('state', 'event') for m in sink.messages)
            assert any(m.get('robot') == other and m['t'] == 'state' for m in sink.messages)
            target = [m for m in sink.messages if m.get('robot') == rid]
            assert [m['t'] for m in target] == ['lease', 'subscription.revoked']
            assert target[0]['holder'] is target[0]['lease_id'] is None
        finally:
            if peer.send_lock.locked():
                peer.send_lock.release()
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            rt.send_body = old_send
            rt.screens.pop(actor.connection, None)
    client.portal.call(check)


def test_inventory_row_lock_does_not_block_state_ping_or_stop_confirmation(client, seeded, rt, monkeypatch):
    rid = seeded['robots']['mine']
    entered, failed = threading.Event(), threading.Event()
    original_note = rt.note_audit
    def note(rid, body):
        if body.get('op') == 'AGENT_INVENTORY_FAILED':
            failed.set()
        return original_note(rid, body)
    monkeypatch.setattr(rt, 'note_audit', note)
    engine = create_engine(seeded['urls']['migrate'])
    def blocked(conn, cursor, sql, params, context, many):
        if 'FROM robots' in sql and 'FOR UPDATE' in sql:
            entered.set()
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        event.listen(rt.inventory.engine, 'before_cursor_execute', blocked)
        try:
            with Session(engine) as lock:
                lock.scalar(select(Robot).where(Robot.id == rid).with_for_update())
                ag.send_json(state(devices_changed=[D]))
                assert entered.wait(1)
                assert reply(ws, send(ws, 'lease.take', rid))['ok']
                assert receive(ag, 'lease')['lease_id'] is None
                stop = receive(ag, 'stop')
                confirmation = state(3, stop_ref=stop['stop_ref'], devices_changed=[D])
                confirmation['battery'] = {'soc': 99}
                ag.send_json(confirmation)
                lease = receive(ag, 'lease', predicate=lambda m: m['lease_id'] is not None, timeout=.75)
                assert lease['lease_id']
                assert rt.agents[str(rid)].state['battery']['soc'] == 99
                # Keep the row lock beyond metadata lock_timeout; metadata
                # failure must become an event and leave the live lease intact.
                deadline = time.monotonic()+2
                while time.monotonic() < deadline:
                    ag.send_json({'t': 'ping'})
                    if failed.is_set():
                        break
                    time.sleep(.05)
                assert failed.is_set()
                assert reply(ws, send(ws, 'cmd', rid, lease_id=lease['lease_id'], seq=0, axes=[0,0,0]))['ok']
                assert rt.arbiter.robot(str(rid)).holder.lease_id == lease['lease_id']
                lock.rollback()
        finally:
            event.remove(rt.inventory.engine, 'before_cursor_execute', blocked)
            engine.dispose()


def test_duplicate_device_frame_cannot_close_agent_or_discard_lease(client, seeded, rt, monkeypatch):
    rid = seeded['robots']['mine']
    from collections import deque
    import sys
    effects = deque(maxlen=40)
    original = rt.apply
    def trace(batch):
        batch = list(batch)
        if batch:
            agent_peer = rt.agents.get(str(rid))
            effects.append((sys._getframe(1).f_code.co_name,
                [e.body for e in batch],
                rt.clock()-agent_peer.auth_checked if agent_peer else None,
                [(rt.clock()-p.policy.checked, dict(p.policy.rights))
                    for p in rt.screens.values() if p.policy]))
        return original(batch)
    monkeypatch.setattr(rt, 'apply', trace)
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        try:
            lease = take(ws, ag, rid)
        except AssertionError as error:
            raise AssertionError(list(effects)) from error
        ag.send_json(state(devices_changed=[D, D]))
        ag.send_json(state())
        ag.send_json({'t':'ping'})
        assert reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=0, axes=[0,0,0]))['ok']
        assert receive(ag, 'cmd')['lease_id'] == lease
        assert rt.arbiter.robot(str(rid)).holder.lease_id == lease


def test_summary_null_when_disconnected_or_state_is_stale(client, seeded, rt):
    own, other = app_token(client), app_token(client, 'two')
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag:
        message = state()
        message.update(battery={'soc': 10}, pose=dict(floor_id=None, x=1,y=2,yaw=0,confidence=1))
        ag.send_json(message)
        deadline = time.monotonic()+2
        while client.get(P+'/robots/'+rid, headers=own).json()['battery'] is None:
            assert time.monotonic()<deadline
            time.sleep(.01)
        assert client.get(P+'/robots/'+rid, headers=other).json()['connection'] == 'UNKNOWN'
        def age():
            rt.agents[rid].state_received_at = rt.clock()-4
        client.portal.call(age)
        ag.send_json({'t':'ping'})
        detail = client.get(P+'/robots/'+rid, headers=own).json()
        assert detail['connection']=='ONLINE'
        assert all(detail[k] is None for k in ('status','battery','location'))
    detail = client.get(P+'/robots/'+rid, headers=own).json()
    assert detail['connection']=='OFFLINE' and detail['attention']==['OFFLINE']
    assert all(detail[k] is None for k in ('status','battery','location'))


def test_robot_list_and_dashboard_queries_do_not_grow_with_fleet(client, seeded, rt):
    admin = app_token(client, 'admin')
    statements=[]
    def collect(conn, cursor, sql, params, context, many):
        if sql.lstrip().upper().startswith('SELECT'):
            statements.append(sql)
    event.listen(client.app.state.engine, 'before_cursor_execute', collect)
    def count(path):
        statements.clear()
        assert client.get(P+path, headers=admin).status_code==200
        return len(statements), sum('FROM robot_devices' in s for s in statements)
    try:
        before = {p:count(p) for p in ('/robots?scope=all','/dashboard')}
        for n in range(10):
            assert client.post(P+'/robots', headers=admin, json=dict(name=f'batch-{n}',
                owner_user_id=str(seeded['users']['one']))).status_code==201
        after = {p:count(p) for p in before}
        assert before==after
        assert all(devices==1 for _, devices in after.values())
        print('constant SELECT counts:', after)
    finally:
        event.remove(client.app.state.engine, 'before_cursor_execute', collect)


def test_change_gate_blocks_control_and_deleted_cache_blocks_even_stop(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease=take(ws, ag, rid)
        client.portal.call(rt.begin_robot_change, rid)
        try:
            for kind, fields in [('cmd',dict(lease_id=lease,seq=0,axes=[0,0,0])),('lease.take',{})]:
                result=reply(ws,send(ws,kind,rid,**fields))
                assert not result['ok'] and result['error']['code']=='POLICY_STALE'
        finally:
            client.portal.call(rt.end_robot_change,rid)
        def deleted():
            peer=next(iter(rt.screens.values()))
            rt.deleted_robots.add(rid)
            try:
                try:
                    rt.cached_access(peer,[rid],'ROBOT_SUMMARY',safety=True)
                except APIError as denied:
                    return denied.status
                return None
            finally:
                rt.deleted_robots.discard(rid)
        assert client.portal.call(deleted)==404



@pytest.mark.parametrize('change',['token','deleting','changing'])
def test_hello_revalidates_token_and_pending_robot_change(client, seeded, rt, monkeypatch, change):
    rid=str(seeded['robots']['mine'])
    original, gate = rt.receive, threading.Event()
    async def gated(ws, **kw):
        frame=await original(ws,**kw)
        if kw.get('agent') and frame.get('t')=='hello':
            gate.set()
            while not released.is_set():
                await asyncio.sleep(.001)
        return frame
    released=threading.Event()
    monkeypatch.setattr(rt,'receive',gated)
    installed=[]
    original_submit=rt.inventory.submit
    def submitted(*args):
        installed.append(args[0])
        return original_submit(*args)
    monkeypatch.setattr(rt.inventory,'submit',submitted)
    with client.websocket_connect('wss://testserver/api/v1/agent/ws',headers={
            'authorization':'Bearer fake-test-'+rid}) as ag:
        ag.send_json(hello())
        assert gate.wait(1)
        if change=='token':
            admin=app_token(client,'admin')
            assert client.post(P+'/robots/'+rid+'/agent-token',headers=admin).status_code==200
        elif change=='deleting':
            client.portal.call(rt.deleted_robots.add,rid)
        else:
            client.portal.call(rt.begin_robot_change,rid)
        released.set()
        try:
            with pytest.raises(WebSocketDisconnect) as denied:
                receive(ag,'must-not-be-installed')
            assert denied.value.code==(1013 if change=='changing' else 4403)
            assert installed==[]
        finally:
            client.portal.call(rt.deleted_robots.discard,rid)
            client.portal.call(rt.end_robot_change,rid)


def test_inventory_coalesces_to_one_latest_snapshot_and_skips_unchanged(client, seeded, rt, monkeypatch):
    from apps.server.fh_server import inventory as module
    entered, release = threading.Event(), threading.Event()
    calls=[]
    def slow(factory, org, rid, devices, model, token_hash):
        calls.append(devices)
        entered.set()
        assert release.wait(3)
    monkeypatch.setattr(module,'save_inventory',slow)
    rid=str(seeded['robots']['mine'])
    async def check():
        rt.inventory.submit(rid,[D],None,b'fake-hash')
        assert await asyncio.to_thread(entered.wait,1)
        try:
            for i in range(100):
                rt.inventory.submit(rid,[{**D,'label':str(i)}],None,b'fake-hash')
            job=rt.inventory.jobs[rid]
            assert job.running is not None and job.pending is not None
            assert len(calls)==1
            release.set()
            await asyncio.wait_for(job.task,2)
            assert len(calls)==2 and calls[-1][0]['label']=='99'
            for i in range(100):
                rt.inventory.submit(rid,[{**D,'label':'99'}],None,b'fake-hash')
            await asyncio.sleep(.01)
            assert len(calls)==2 and job.pending is None
        finally:
            release.set()
    client.portal.call(check)


def test_name_only_patch_does_not_gate_existing_control(client, seeded, rt, monkeypatch):
    admin=app_token(client,'admin')
    rid=seeded['robots']['mine']
    with agent(client,seeded) as ag, screen(client,app_token(client)) as ws:
        lease=take(ws,ag,rid)
        def forbidden(*args):
            raise AssertionError('name-only update must not block robot control')
        monkeypatch.setattr(rt,'begin_robot_change',forbidden)
        response=client.patch(P+'/robots/'+str(rid),headers=admin,json={'name':'renamed',
            'owner_user_id':str(seeded['users']['one'])})
        assert response.status_code==200
        assert reply(ws,send(ws,'cmd',rid,lease_id=lease,seq=0,axes=[0,0,0]))['ok']
        assert rt.arbiter.robot(str(rid)).holder.lease_id==lease


def test_revocation_cache_metadata_is_reaped_after_policy_grace(client, seeded, rt):
    rid=str(seeded['robots']['mine'])
    async def check():
        rt.arbiter.robot(rid)
        rt.deleted_robots.add(rid)
        rt.deleted_at[rid]=rt.clock()-7
        rt.robot_changed_at[(rid,'retired-user')]=rt.clock()-7
        async with asyncio.timeout(1):
            while rid in rt.deleted_robots:
                await asyncio.sleep(.01)
        assert rid not in rt.deleted_at and rid not in rt.arbiter.robots
        assert (rid,'retired-user') not in rt.robot_changed_at
    client.portal.call(check)


def test_invalid_hello_inventory_is_audited_without_protocol_mislabel(client, seeded, rt, monkeypatch):
    from apps.server.fh_server import realtime as module
    from apps.server.fh_server.models import Event
    from .test_realtime import drain_audit
    monkeypatch.setattr(module,'HELLO_TIMEOUT',.1)
    rid=str(seeded['robots']['mine'])
    with client.websocket_connect('wss://testserver/api/v1/agent/ws',headers={
            'authorization':'Bearer fake-test-'+rid}) as ag:
        payload=hello()
        payload['devices']=[D,D]
        ag.send_json(payload)
        with pytest.raises(WebSocketDisconnect) as closed:
            receive(ag,'invalid-hello')
        assert closed.value.code==1013
    drain_audit(client,rt)
    with Session(client.app.state.engine) as db:
        assert db.scalar(select(Event.id).where(Event.code=='AGENT_INVALID_HELLO'))
        assert db.scalar(select(Event.id).where(Event.code=='AGENT_PROTOCOL_MISMATCH')) is None


def test_all_null_pose_has_no_fresh_location_timestamp(client, seeded, rt):
    rid=str(seeded['robots']['mine'])
    own=app_token(client)
    with agent(client,seeded) as ag, screen(client,own) as ws:
        assert reply(ws,send(ws,'sub',robots=[rid],streams=['state']))['ok']
        ag.send_json(state())
        message=receive(ws,'state',predicate=lambda m: m.get('stop_gen')==2)
        assert message['location'] is None
        detail=client.get(P+'/robots/'+rid,headers=own).json()
        assert detail['location'] is None

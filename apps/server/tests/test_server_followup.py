"""S0 connection, cancellation, bounded authorization and first-unlock regressions."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
import threading
import time
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, update
from sqlalchemy.orm import Session as DBSession

from apps.contracts import models as C
from apps.server.fh_server.models import Robot, Session, User, Event, now
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state, take
from .test_realtime_review import run


def test_screen_server_ping_without_subscription_does_not_extend_lease(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        take(ws, ag, rid)
        holder = rt.arbiter.robot(rid).holder
        heartbeat = holder.heartbeat
        frame = receive(ws, 'ping')
        assert C.ScreenServerPing.model_validate(frame).t_server.utcoffset().total_seconds() == 0
        assert frame['t_server'].endswith('Z')
        assert holder.heartbeat == heartbeat and not next(iter(rt.screens.values())).subscriptions


@pytest.mark.parametrize('accepted', [False, True])
def test_requester_cancel_closes_both_dialogs_and_blocks_late_grant(client, seeded, rt, accepted):
    rid = str(seeded['robots']['mine'])
    own, admin = app_token(client), app_token(client, 'admin')
    with agent(client, seeded) as ag, screen(client, own) as holder, screen(client, admin) as requester, screen(client, admin) as other_tab:
        lease = take(holder, ag, rid)
        assert reply(requester, send(requester, 'lease.request', rid))['ok']
        req = receive(holder, 'lease.requested')
        bad = reply(other_tab, send(other_tab, 'lease.cancel', rid))
        assert not bad['ok'] and rt.arbiter.robot(rid).request
        if accepted:
            assert reply(holder, send(holder, 'lease.respond', rid, request_id=req['request_id'], accept=True))['ok']
            receive(ag, 'lease')
            stop = receive(ag, 'stop')
        ident = send(requester, 'lease.cancel', rid)
        result, response = None, None
        while result is None or response is None:
            frame = receive(requester)
            if frame['t'] == 'lease.result':
                result = frame
            if frame['t'] == 'reply' and frame['id'] == ident:
                response = frame
        assert response['ok']
        assert result['result'] == 'CANCELED' and result['request_id'] == req['request_id']
        result = receive(holder, 'lease.result')
        assert result['result'] == 'CANCELED' and result['request_id'] == req['request_id']
        record = rt.arbiter.robot(rid)
        assert record.request is None and record.transfer is None
        if accepted:
            ag.send_json(state(4, stop_ref=stop['stop_ref']))
            assert reply(requester, send(requester, 'ping'))['ok']
            assert record.holder is None
        else:
            assert record.holder.lease_id == lease
            assert not reply(holder, send(holder, 'lease.respond', rid, request_id=req['request_id'], accept=True))['ok']
        assert not reply(requester, send(requester, 'lease.cancel', rid))['ok']


@pytest.mark.parametrize('accepted', [False, True])
def test_request_cancel_survives_archive_admission_closed(client, seeded, rt, monkeypatch, accepted):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client, 'one')) as holder, \
            screen(client, app_token(client, 'admin')) as requester:
        lease = take(holder, ag, rid)
        assert reply(requester, send(requester, 'lease.request', rid))['ok']
        req = receive(holder, 'lease.requested')
        if accepted:
            assert reply(holder, send(holder, 'lease.respond', rid, request_id=req['request_id'], accept=True))['ok']
            receive(ag, 'lease')
            stop = receive(ag, 'stop')
        monkeypatch.setattr(rt.audit, 'admission_open', lambda _: False)
        assert reply(requester, send(requester, 'lease.cancel', rid))['ok']
        result = receive(holder, 'lease.result')
        assert result['result'] == 'CANCELED' and result['request_id'] == req['request_id']
        record = rt.arbiter.robot(rid)
        assert record.request is None and record.transfer is None
        if accepted:
            ag.send_json(state(4, stop_ref=stop['stop_ref']))
            assert reply(requester, send(requester, 'ping'))['ok']
            assert record.holder is None
        else:
            assert record.holder.lease_id == lease
        refused = reply(requester, send(requester, 'lease.request', rid))
        assert not refused['ok'] and refused['error']['code'] == 'ROBOT_ARCHIVE_BUSY'


def test_policy_refresh_waits_for_either_lane_without_crossing_watermarks(client, rt):
    from apps.server.fh_server.leases import Actor
    from apps.server.fh_server.realtime import Peer, Policy
    from .test_realtime_review import Sink
    async def check():
        peer = Peer(Sink(), actor=Actor('user', 'session', 'connection'))
        policy = Policy(rights={}, settings=C.OrgSettings(), expires_at=now(), checked=10.5)
        class Lane:
            def __init__(self, stamp):
                self.stamp, self.latest = stamp, {}
                self.task = asyncio.current_task()
                self.changed, self.calls = asyncio.Event(), []
            async def next(self, after=None):
                self.calls.append(after)
                while self.stamp <= after:
                    self.changed.clear()
                    await self.changed.wait()
                return self.latest, self.stamp
        view, control = Lane(11), Lane(9)
        rt.policy_pipelines = {'view': view, 'control': control}
        async def publish():
            # The empty view lane is newer than the valid control result.
            for _ in range(3):
                await asyncio.sleep(0)
            control.latest, control.stamp = {'session': policy}, 10.5
            control.changed.set()
        producer = asyncio.create_task(publish())
        try:
            await rt.refresh_policy(peer, after=10)
            assert peer.policy == policy
            assert view.calls == [11] and control.calls == [10]
        finally:
            producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)
            rt.policy_pipelines.clear()
            await rt.release_policy(peer)
    run(client, check)


def test_twenty_cold_stops_ignore_unrelated_token_refresh(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    names = ['one', *[f's0-stop-{n}' for n in range(19)]]
    with DBSession(client.app.state.engine) as db:
        password = db.get(User, seeded['users']['one']).password_hash
        db.add_all([User(org_id=seeded['org'], username=name, display_name=name,
                         role='OPERATOR', password_hash=password) for name in names[1:]])
        db.commit()
    headers = [app_token(client, name) for name in names]
    unrelated = client.post('/api/v1/auth/login', json=dict(username='two', password='fake-test-password', client='app')).json()
    entered, release = threading.Event(), threading.Event()
    original = rt.load_stop_scope
    def hold(key):
        result = original(key)
        entered.set()
        assert release.wait(3)
        time.sleep(.45)
        return result
    monkeypatch.setattr(rt, 'load_stop_scope', hold)
    with ThreadPoolExecutor(20) as pool:
        results = [pool.submit(client.post, f'/api/v1/robots/{rid}/stop', headers=h) for h in headers]
        try:
            assert entered.wait(2)
            assert client.post('/api/v1/auth/refresh', json={'refresh_token': unrelated['refresh_token']}).status_code == 200
        finally:
            release.set()
        statuses = [r.result().status_code for r in results]
    assert statuses == [202] * 20, statuses
    assert rt.stop_slots._value == 12


@pytest.mark.parametrize('age,expected', [(.25, 202), (.251, 503)])
def test_warm_stop_bypasses_slots_only_inside_250ms(client, seeded, rt, monkeypatch, age, expected):
    from apps.server.fh_server import realtime as module
    at = [0.]
    monkeypatch.setattr(rt, 'clock', lambda: at[0])
    monkeypatch.setattr(module, 'DB_READ_TIMEOUT', .02)
    rid, headers = str(seeded['robots']['mine']), app_token(client)
    assert client.post(f'/api/v1/robots/{rid}/stop', headers=headers).status_code == 202
    at[0] = age
    async def occupy():
        for _ in range(12):
            await rt.stop_slots.acquire()
    run(client, occupy)
    before = rt.arbiter.robot(rid).stop_ref
    try:
        response = client.post(f'/api/v1/robots/{rid}/stop', headers=headers)
        assert response.status_code == expected
        assert rt.arbiter.robot(rid).stop_ref == before + (expected == 202)
    finally:
        for _ in range(12):
            client.portal.call(rt.stop_slots.release)


def test_bulk_session_revocation_is_scoped_and_rollback_does_not_invalidate(client, seeded, rt, monkeypatch):
    monkeypatch.setattr(rt, 'clock', lambda: 0.)
    rid = str(seeded['robots']['mine'])
    headers = {name: app_token(client, name) for name in ('one', 'two')}
    for h in headers.values():
        assert client.post(f'/api/v1/robots/{rid}/stop', headers=h).status_code == 202
    from apps.server.fh_server.models import now
    with DBSession(client.app.state.engine) as db:
        db.execute(update(Session).where(Session.user_id == seeded['users']['one']).values(revoked_at=now()))
        db.rollback()
    assert len(rt.stop_cache) == 2
    with DBSession(client.app.state.engine) as db:
        db.execute(update(Session).where(Session.user_id == seeded['users']['one']).values(revoked_at=now()))
        db.commit()
    assert len(rt.stop_cache) == 1
    assert client.post(f'/api/v1/robots/{rid}/stop', headers=headers['one']).status_code == 401
    assert client.post(f'/api/v1/robots/{rid}/stop', headers=headers['two']).status_code == 202


def test_stop_invalidation_journal_overflow_fails_closed(client, seeded, rt):
    from apps.server.fh_server.leases import Actor
    actor = Actor('one', 's', 'c')
    epoch = rt.stop_cache_epoch
    for _ in range(1025):
        rt.invalidate_stop_cache(users=['unrelated'])
    assert len(rt.stop_changes) == 1024
    assert rt.stop_scope_changed(epoch, actor, seeded['robots']['mine'])
    assert not rt.stop_scope_changed(rt.stop_cache_epoch, actor, seeded['robots']['mine'])


def test_archived_robot_name_reuse_preserves_ids_history_and_active_uniqueness(client, seeded, rt):
    headers = app_token(client, 'admin')
    path = '/api/v1/robots'
    old = client.post(path, headers=headers, json={'name': 'reusable'}).json()['robot']['id']
    assert client.delete(f'{path}/{old}', headers=headers).status_code == 204
    new = client.post(path, headers=headers, json={'name': 'reusable'})
    assert new.status_code == 201
    new_id = new.json()['robot']['id']
    assert new_id != old
    assert client.post(path, headers=headers, json={'name': 'reusable'}).status_code == 409
    assert client.patch(f"{path}/{seeded['robots']['mine']}", headers=headers, json={'name': 'reusable'}).status_code == 409
    with DBSession(client.app.state.engine) as db:
        assert db.get(Robot, UUID(old)).archived_at
        assert db.scalar(select(Event).where(Event.robot_id == UUID(old), Event.code == 'ROBOT_ARCHIVED'))
    assert client.get(f'{path}/{old}', headers=headers).status_code == 404


def test_first_unlock_uses_state_delivered_before_new_lease(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        receive(ws, 'state')
        # Disable periodic state emission: the new lease must carry its causal
        # state ordering on its own, with no lucky 100ms timer tick.
        async def hold_periodic():
            peer = next(iter(rt.screens.values()))
            peer.state_sent = float('inf')
        run(client, hold_periodic)
        assert reply(ws, send(ws, 'lease.take', rid))['ok']
        receive(ag, 'lease')
        stop = receive(ag, 'stop')
        ag.send_json(state(17, stop_ref=stop['stop_ref']))
        lease = receive(ag, 'lease')['lease_id']
        latest = None
        while True:
            body = receive(ws)
            if body['t'] == 'state':
                latest = body
            if body['t'] == 'lease' and body.get('lease_id') == lease:
                break
        assert latest is not None and latest['stop_gen'] == 17
        result = reply(ws, send(ws, 'unlock', rid, lease_id=lease, stop_gen=latest['stop_gen']))
        assert result['ok'], result
        assert receive(ag, 'unlock')['stop_gen'] == 17


@pytest.mark.parametrize('age,revoked', [(0., False), (.5, False), (.501, True)])
def test_flood_policy_boundary_revokes_at_501ms_but_preserves_stop(client, seeded, rt, monkeypatch, age, revoked):
    from apps.server.fh_server.leases import Effect
    rid = str(seeded['robots']['mine'])
    other = str(seeded['robots']['theirs'])
    at = [10.]
    monkeypatch.setattr(rt, 'clock', lambda: at[0])
    rt.arbiter.clock = rt.clock
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        lease = take(ws, ag, rid)
        async def hold(peer):
            pass
        monkeypatch.setattr(rt, 'refresh_policy', hold)
        async def expire():
            peer = next(iter(rt.screens.values()))
            peer.policy = replace(peer.policy, checked=10. - age)
            for n in range(1500):
                rt.queue_audit(Effect('audit', other, {'op': 'AGENT_EVENT', 'code': 'CUSTOM', 'severity': 'ERROR', 'data': {'n': n}}))
            await asyncio.sleep(.04)
            return peer
        peer = run(client, expire)
        record = rt.arbiter.robot(rid)
        assert (record.holder is None) == revoked
        assert not rt.audit_overloaded and not rt.audit_storage_failed
        response = reply(ws, send(ws, 'cmd', rid, lease_id=lease, seq=1, axes=[0, 0, 0]))
        assert response['ok'] == (not revoked), response
        if revoked:
            assert response['error']['code'] == 'POLICY_STALE'
            assert receive(ag, 'lease')['lease_id'] is None
            receive(ag, 'stop')
            assert record.transfer is None
        assert reply(ws, send(ws, 'stop', rid))['ok']
        receive(ag, 'stop')


def test_rejected_upgrade_fallback_sends_ws_codes_and_policy_cleanup_first(client, rt):
    async def check():
        for code in (4401, 4403):
            calls = []
            class Socket:
                scope = {'extensions': {}}
                async def accept(self):
                    calls.append('accept')
                async def close(self, *, code):
                    calls.append(code)
            await rt.reject_upgrade(Socket(), code)
            assert calls == ['accept', code]
    run(client, check)


def test_policy_freshness_and_loop_delay_under_real_clock_flood(client, seeded, rt):
    a, b = str(seeded['robots']['mine']), str(seeded['robots']['theirs'])
    other = {**seeded, 'robots': {**seeded['robots'], 'mine': seeded['robots']['theirs']}}
    with agent(client, seeded) as ag_a, agent(client, other) as ag_b, screen(client, app_token(client, 'two')) as ws:
        lease = take(ws, ag_b, b)
        async def measure():
            samples, errors, attempts = [], [], [0]
            peer = next(iter(rt.screens.values()))
            async def heartbeat():
                seq = 0
                while True:
                    await ag_b._receive_tx.send({'type': 'websocket.receive', 'text': '{"t":"ping"}'})
                    seq += 1
                    ident = str(uuid4())
                    await ws._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps(dict(
                        t='cmd', id=ident, robot=b, lease_id=lease, seq=seq, axes=[0, 0, 0]))})
                    attempts[0] += 1
                    await asyncio.sleep(.05)
            async def observer():
                while True:
                    started = time.monotonic()
                    await asyncio.sleep(.01)
                    samples.append((rt.clock() - peer.policy.checked, time.monotonic() - started - .01))
            async def responses():
                while True:
                    packet = await ws._send_rx.receive()
                    assert packet['type'] == 'websocket.send', packet
                    body = json.loads(packet['text'])
                    if body.get('t') == 'reply' and not body['ok']:
                        errors.append(body['error']['code'])
            tasks = [asyncio.create_task(f()) for f in (heartbeat, observer, responses)]
            started = time.monotonic()
            try:
                for n in range(1500):
                    try:
                        await ag_a._receive_tx.send({'type': 'websocket.receive', 'text': json.dumps(dict(
                            t='event', code='CUSTOM', severity='ERROR', robot_at=None, data={'n': n, 'pad': 'x' * 3500}))})
                    except Exception:
                        break
                while time.monotonic() - started < 3.6:
                    assert rt.arbiter.robot(b).holder and rt.arbiter.robot(b).holder.lease_id == lease, (samples[-20:], errors)
                    await asyncio.sleep(.01)
                assert rt.audit.channel(a).blocked and not rt.audit_overloaded and not rt.audit_storage_failed
            finally:
                for task in tasks:
                    task.cancel()
                outcomes = await asyncio.gather(*tasks, return_exceptions=True)
                assert all(isinstance(result, asyncio.CancelledError) for result in outcomes), outcomes
            assert attempts[0] >= 50 and not errors, (attempts, errors)
            return dict(seconds=round(time.monotonic() - started, 3), commands=attempts[0],
                policy_age_max_ms=round(max(p for p, _ in samples) * 1000, 2),
                loop_delay_max_ms=round(max(d for _, d in samples) * 1000, 2), policy_stale=errors.count('POLICY_STALE'))
        result = run(client, measure)
        assert reply(ws, send(ws, 'stop', b))['ok']
        receive(ag_b, 'stop')
        print('S0 flood availability ' + json.dumps(result, sort_keys=True))


def test_screen_ping_bypasses_private_delivery_waiting_for_policy(client, seeded, rt, monkeypatch):
    from apps.server.fh_server.leases import Actor
    from apps.server.fh_server.realtime import Peer, Policy
    from apps.server.fh_server.models import now
    from datetime import timedelta
    async def check():
        frames = []
        class Socket:
            async def send_json(self, body):
                frames.append(body)
            async def close(self, **kwargs):
                pass
        rid = str(seeded['robots']['mine'])
        actor = Actor('one', 's', 'c')
        peer = Peer(Socket(), actor=actor)
        peer.policy = Policy(rights={}, settings=C.OrgSettings(), checked=rt.clock() - 1,
            expires_at=now() + timedelta(days=1))
        entered = asyncio.Event()
        async def blocked(peer):
            entered.set()
            await asyncio.Event().wait()
        monkeypatch.setattr(rt, 'refresh_policy', blocked)
        sender = asyncio.create_task(rt.writer(peer, True))
        urgent = asyncio.create_task(rt.replies(peer))
        try:
            rt.put(peer, {'t': 'lease', 'robot': rid})
            await asyncio.wait_for(entered.wait(), 1)
            rt.put(peer, C.ScreenServerPing(t_server=now()).model_dump(mode='json'))
            await asyncio.sleep(.02)
            assert [frame['t'] for frame in frames] == ['ping']
        finally:
            sender.cancel()
            urgent.cancel()
            await asyncio.gather(sender, urgent, return_exceptions=True)
    run(client, check)


def test_disconnected_devices_are_missing_in_list_and_detail_without_rewriting_history(client, seeded, rt):
    from apps.server.fh_server.models import RobotDevice
    rid = str(seeded['robots']['mine'])
    devices = [dict(key=key, kind=kind, label=key, state='OK') for key, kind in
               [('rgb', 'CAMERA_RGB'), ('depth', 'CAMERA_DEPTH'), ('l1', 'LIDAR')]]
    viewers = [app_token(client, name) for name in ('admin', 'one')]
    with agent(client, seeded, devices=devices) as ag:
        receive(ag, 'ping')
        async def saved():
            async with asyncio.timeout(2):
                while rt.inventory.jobs[rid].saved is None:
                    await asyncio.sleep(.01)
        run(client, saved)
        for headers in viewers:
            detail = client.get(f'/api/v1/robots/{rid}', headers=headers).json()
            assert [d['state'] for d in detail['devices']] == ['OK'] * 3
    for headers in viewers:
        detail = client.get(f'/api/v1/robots/{rid}', headers=headers).json()
        listing = client.get('/api/v1/robots?scope=all', headers=headers).json()['items']
        listed = next(row for row in listing if row['id'] == rid)
        for row in (detail, listed):
            assert row['connection'] == 'OFFLINE'
            assert row['status'] is row['battery'] is row['location'] is None
            assert len(row['devices']) == 3 and all(d['state'] == 'MISSING' for d in row['devices'])
            assert row['attention'] == ['OFFLINE']
        assert client.get('/api/v1/dashboard', headers=headers).json()['robots_online'] == 0
    with DBSession(client.app.state.engine) as db:
        assert list(db.scalars(select(RobotDevice.state).where(RobotDevice.robot_id == UUID(rid)))) == ['OK'] * 3
    with agent(client, seeded, devices=devices):
        detail = client.get(f'/api/v1/robots/{rid}', headers=viewers[0]).json()
        assert detail['connection'] == 'ONLINE' and all(d['state'] == 'OK' for d in detail['devices'])


@pytest.mark.parametrize('change', ['register', 'assign', 'delete'])
def test_sub_refreshes_snapshot_after_robot_write_and_missing_keeps_connection(client, seeded, rt, monkeypatch, change):
    admin = app_token(client, 'admin')
    headers = app_token(client, 'one') if change == 'assign' else admin
    mine = str(seeded['robots']['mine'])
    other = str(seeded['robots']['theirs'])
    forced = []
    with screen(client, headers) as ws:
        assert reply(ws, send(ws, 'sub', robots=[mine], streams=['state']))['ok']
        original = rt.refresh_policy
        async def hold_old_until_requested(peer, *, after=None):
            if after is not None:
                forced.append(after)
                await original(peer, after=after)
        monkeypatch.setattr(rt, 'refresh_policy', hold_old_until_requested)
        if change == 'register':
            response = client.post('/api/v1/robots', headers=admin, json={'name': 'immediate-sub'})
            assert response.status_code == 201
            rid = response.json()['robot']['id']
            assert rid not in next(iter(rt.screens.values())).policy.rights
        elif change == 'assign':
            rid = other
            assert 'ROBOT_READ' not in next(iter(rt.screens.values())).policy.rights[rid]
            assert client.patch('/api/v1/robots/' + rid, headers=admin,
                json={'owner_user_id': str(seeded['users']['one'])}).status_code == 200
        else:
            rid = other
            assert rid in next(iter(rt.screens.values())).policy.rights
            assert client.delete('/api/v1/robots/' + rid, headers=admin).status_code == 204
        result = reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))
        assert len(forced) == 1
        peer = next(iter(rt.screens.values()))
        if change == 'delete':
            assert not result['ok'] and result['error']['code'] == 'NOT_FOUND'
            assert result['error']['detail']['status'] == 404
            assert set(peer.subscriptions) == {mine}
        else:
            assert result['ok'], result
            assert set(peer.subscriptions) == {rid}
        assert reply(ws, send(ws, 'ping'))['ok']


def test_unknown_sub_refresh_is_bounded_and_does_not_block_existing_stop(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        entered, release = asyncio.Event(), asyncio.Event()
        original = rt.refresh_policy
        async def held(peer, *, after=None):
            if after is not None:
                entered.set()
                await release.wait()
            await original(peer, **({'after': after} if after is not None else {}))
        monkeypatch.setattr(rt, 'refresh_policy', held)
        unknown = str(uuid4())
        request = send(ws, 'sub', robots=[unknown], streams=['state'])
        async def waiting():
            await asyncio.wait_for(entered.wait(), 1)
            return next(iter(rt.screens.values())).subscription_task
        task = run(client, waiting)
        try:
            started = time.monotonic()
            assert reply(ws, send(ws, 'stop', rid))['ok']
            receive(ag, 'stop')
            assert time.monotonic() - started < .1
            busy = reply(ws, send(ws, 'sub', robots=[unknown], streams=['state']))
            assert not busy['ok'] and busy['error']['code'] == 'SERVER_BUSY'
            assert next(iter(rt.screens.values())).subscription_task is task
        finally:
            client.portal.call(release.set)
        result = reply(ws, request)
        assert not result['ok'] and result['error']['code'] == 'NOT_FOUND'
        assert set(next(iter(rt.screens.values())).subscriptions) == {rid}
        assert reply(ws, send(ws, 'ping'))['ok']


def test_pending_sub_refresh_is_canceled_before_policy_producer_cleanup(client, rt, monkeypatch):
    entered = asyncio.Event()
    original = rt.refresh_policy
    task = None
    with screen(client, app_token(client)) as ws:
        async def held(peer, *, after=None):
            if after is not None:
                entered.set()
                await asyncio.Event().wait()
            await original(peer)
        monkeypatch.setattr(rt, 'refresh_policy', held)
        send(ws, 'sub', robots=[str(uuid4())], streams=['state'])
        async def waiting():
            await asyncio.wait_for(entered.wait(), 1)
            return next(iter(rt.screens.values())).subscription_task
        task = run(client, waiting)
    assert task.done() and task.cancelled()
    assert not rt.policy_peers and not rt.policy_loads and not rt.policy_pipelines

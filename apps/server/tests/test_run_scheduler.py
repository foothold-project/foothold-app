"""Scheduled run start (11/28): a CONFIRMED slot's start time makes the server send the #537 run.start.

The requester is the server on behalf of the slot's creator; gates are the human ones. Demo robot only:
a real robot keeps FORBIDDEN (SKIPPED). A fake agent socket answers; no robot, no Jetson.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DBSession, sessionmaker

from apps.server.fh_server import scheduler as S
from apps.server.fh_server.models import Event, Robot, ScheduleSlot
from apps.server.fh_server.security import digest
from .test_realtime import app_token, hello, receive, reply, screen, send
from .test_run_relay import synthetic_assignment

T0 = datetime(2026, 11, 28, 6, 0, tzinfo=timezone.utc)


def frames(ws, timeout=.05):
    async def wait():
        out = []
        try:
            async with asyncio.timeout(timeout):
                while True:
                    packet = await ws._send_rx.receive()
                    ws._raise_on_close(packet)
                    out.append(json.loads(packet['text']))
        except TimeoutError:
            return out
    return ws.portal.call(wait)


class FakeAgent:
    """Answers like the demo Observer: STOP confirm, unlock, run.start result, run progress."""
    def __init__(self, ws, *, result='OK', answer=True):
        self.ws, self.result, self.answer = ws, result, answer
        self.latched, self.gen, self.stop_ref = True, 1, 0
        self.seen, self.run, self.run_result = [], None, None

    def state(self):
        body = dict(t='state', pose={'floor_id': None, 'x': None, 'y': None, 'yaw': None, 'confidence': None},
                    speed=None, battery={'soc': None}, latched=self.latched, stop_gen=self.gen,
                    stop_ref=self.stop_ref if self.latched else 0, applied=[0, 0, 0], mode='FREE',
                    reported_run=self.run)
        if self.run_result is not None:
            body['run_result'] = self.run_result
        self.ws.send_json(body)

    def pump(self):
        for f in frames(self.ws):
            self.seen.append(f)
            t = f.get('t')
            if t == 'stop':
                self.latched, self.stop_ref = True, f['stop_ref']
                self.gen += 1
            elif t == 'unlock' and self.answer:
                self.latched = False
            elif t == 'lease' and f.get('lease_id') is None and self.run and self.run['status'] == 'MOVING':
                self.run = {**self.run, 'status': 'PAUSED', 'wait_reason': 'LINK_LOST'}  # relay lets go of the Hub
                self.latched = True
            elif t == 'run.control' and f['op'] == 'resume' and self.run:
                self.run_result = dict(request_id=f['request_id'], op='resume', run_id=f['run_id'],
                                       status='SUCCEEDED', code='OK')
                self.run = {**self.run, 'status': 'MOVING', 'wait_reason': None}
            elif t == 'run.start' and self.answer:
                self.run_result = dict(request_id=f['request_id'], op='start', run_id=f['run_id'],
                                       status='SUCCEEDED' if self.result == 'OK' else 'REJECTED', code=self.result)
                if self.result == 'OK':
                    self.run = dict(run_id=f['run_id'], status='MOVING', step=0,
                                    progress={'done': 0, 'total': 1}, wait_reason=None, fail_code=None)
        self.state()

    def kinds(self):
        return [f.get('t') for f in self.seen]


@pytest.fixture
def demo(client, seeded):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        for key in ('mine', 'theirs'):
            row = db.get(Robot, seeded['robots'][key])
            row.agent_token_hash = digest('fake-test-' + str(row.id))
            row.simulation = key == 'mine'
        db.commit()
    engine.dispose()
    clock = [T0]
    app = client.app
    sched = S.Scheduler(app.state.realtime, sessionmaker(app.state.engine, expire_on_commit=False),
                        seeded['org'], clock=lambda: clock[0])
    return client, sched, clock


def add_slot(seeded, good=None, *, robot='mine', kind='CONFIRMED', start=T0 + timedelta(minutes=2),
             minutes=30, assignment=True):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        row = ScheduleSlot(org_id=seeded['org'], robot_id=seeded['robots'][robot], kind=kind,
            scenario_id=UUID(good['scenario_id']) if good and kind != 'BATTERY_SWAP' else None,
            scenario_version=good['scenario_version'] if good and kind != 'BATTERY_SWAP' else None,
            assignment_id=UUID(good['assignment_id']) if good and assignment and kind != 'BATTERY_SWAP' else None,
            start_at=start, end_at=start + timedelta(minutes=minutes), memo='', created_by=seeded['users']['one'])
        db.add(row); db.commit()
        slot_id = row.id
    engine.dispose()
    return slot_id


def slot_row(seeded, slot_id):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        row = db.get(ScheduleSlot, slot_id)
        result = dict(state=row.run_state, run_id=row.run_id, code=row.run_code)
    engine.dispose()
    return result


def codes(seeded):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        result = [e.code for e in db.scalars(select(Event).where(Event.code.like('SCHEDULE_RUN%')
                                                                 | Event.code.like('SCHEDULE_BATTERY%')))]
    engine.dispose()
    return result


def agent_ws(client, seeded, robot='mine'):
    rid = seeded['robots'][robot]
    return client.websocket_connect('wss://testserver/api/v1/agent/ws',
                                    headers={'authorization': 'Bearer fake-test-' + str(rid)})


def run_ticks(client, sched, agent, n=20, until=None):
    for _ in range(n):
        client.portal.call(sched.tick)
        if agent is not None:
            agent.pump()
        if until is not None and until():
            return True
    return until() if until else None


def test_due_slot_starts_run_then_done_and_notes_battery_swap(demo, seeded):
    client, sched, clock = demo
    good = synthetic_assignment(seeded)
    slot_id = add_slot(seeded, good)
    swap = add_slot(seeded, kind='BATTERY_SWAP', start=T0 + timedelta(minutes=40), minutes=10)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        agent.pump()
        run_ticks(client, sched, agent, 3)
        assert slot_row(seeded, slot_id)['state'] is None and 'run.start' not in agent.kinds()  # not yet
        clock[0] = T0 + timedelta(minutes=2, seconds=1)
        assert run_ticks(client, sched, agent, 40, until=lambda: slot_row(seeded, slot_id)['state'] == 'STARTED')
        row = slot_row(seeded, slot_id)
        assert row['run_id'] == S.run_id_for(slot_id)
        start = next(f for f in agent.seen if f.get('t') == 'run.start')
        assert start['request_id'] == S.request_id_for(slot_id)
        assert start['user_id'] == str(seeded['users']['one'])
        assert (start['assignment_id'], start['scenario_id'], start['scenario_version'], start['floor_id'],
                start['map_version_id']) == (good['assignment_id'], good['scenario_id'], 1, good['floor_id'],
                                             good['map_version_id'])
        lease = next(f for f in agent.seen if f.get('t') == 'lease' and f.get('lease_id'))
        assert lease['holder_type'] == 'RUN:' + str(row['run_id']) and start['lease_id'] == lease['lease_id']
        unlock = next(f for f in agent.seen if f.get('t') == 'unlock')
        assert unlock['lease_id'] == lease['lease_id'] and unlock['user_id'] == str(seeded['users']['one'])
        assert agent.kinds().count('run.start') == 1
        agent.run = {**agent.run, 'status': 'COMPLETED', 'progress': {'done': 1, 'total': 1}}
        assert run_ticks(client, sched, agent, 20, until=lambda: slot_row(seeded, slot_id)['state'] == 'DONE')
        assert run_ticks(client, sched, agent, 5, until=lambda: any(
            f.get('t') == 'lease' and f.get('lease_id') is None for f in agent.seen[agent.seen.index(lease):]))
        assert agent.kinds().count('run.start') == 1
    assert slot_row(seeded, swap)['state'] is None  # recorded only, never started
    assert {'SCHEDULE_RUN_STARTED', 'SCHEDULE_RUN_DONE', 'SCHEDULE_BATTERY_SWAP_NEXT'} <= set(codes(seeded))


@pytest.mark.parametrize('end,code', [('FAILED', 'NAV_TIMEOUT'), ('CANCELED', 'OPERATOR_ABORT')])
def test_run_that_ends_badly_marks_failed(demo, seeded, end, code):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        assert run_ticks(client, sched, agent, 40, until=lambda: slot_row(seeded, slot_id)['state'] == 'STARTED')
        agent.run = {**agent.run, 'status': end, 'fail_code': code}
        assert run_ticks(client, sched, agent, 20, until=lambda: slot_row(seeded, slot_id)['state'] == 'FAILED')
    assert slot_row(seeded, slot_id)['code'] == code


def test_agent_rejection_marks_failed_and_releases_run_lease(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws, result='NAV_UNAVAILABLE')
        assert run_ticks(client, sched, agent, 40, until=lambda: slot_row(seeded, slot_id)['state'] == 'FAILED')
        assert slot_row(seeded, slot_id)['code'] == 'NAV_UNAVAILABLE'
        holder = client.app.state.realtime.arbiter.robot(str(seeded['robots']['mine'])).holder
        assert holder is None


def test_human_lease_skips_without_waiting(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        agent.pump()
        with screen(client, app_token(client)) as sc:
            assert reply(sc, send(sc, 'lease.take', seeded['robots']['mine']))['ok']
            for _ in range(10):
                agent.pump()
                if client.app.state.realtime.arbiter.robot(str(seeded['robots']['mine'])).holder:
                    break
            clock[0] = T0 + timedelta(minutes=3)
            run_ticks(client, sched, agent, 5)
            assert slot_row(seeded, slot_id) == dict(state='SKIPPED', run_id=S.run_id_for(slot_id), code='LEASE_HELD')
            assert 'run.start' not in agent.kinds()
    assert 'SCHEDULE_RUN_SKIPPED' in codes(seeded)


def test_offline_robot_is_missed(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    run_ticks(client, sched, None, 3)
    assert slot_row(seeded, slot_id)['state'] == 'MISSED' and slot_row(seeded, slot_id)['code'] == 'ROBOT_OFFLINE'
    assert 'SCHEDULE_RUN_MISSED' in codes(seeded)


def test_real_robot_stays_forbidden(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded, robot='theirs'), robot='theirs')
    clock[0] = T0 + timedelta(minutes=3)
    with agent_ws(client, seeded, 'theirs') as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        run_ticks(client, sched, agent, 5)
        assert slot_row(seeded, slot_id)['state'] == 'SKIPPED'
        assert slot_row(seeded, slot_id)['code'] == 'REAL_RUN_FORBIDDEN'
        assert 'run.start' not in agent.kinds()


@pytest.mark.parametrize('case,state,code', [('passed', 'MISSED', 'WINDOW_PASSED'),
    ('no_assignment', 'SKIPPED', 'NO_ASSIGNMENT'), ('pending_assignment', 'SKIPPED', 'ASSIGNMENT_INVALID')])
def test_slot_preconditions(demo, seeded, case, state, code):
    client, sched, clock = demo
    good = synthetic_assignment(seeded, status='PENDING' if case == 'pending_assignment' else 'ACTIVE')
    slot_id = add_slot(seeded, good, assignment=case != 'no_assignment')
    clock[0] = T0 + timedelta(hours=1) if case == 'passed' else T0 + timedelta(minutes=3)
    run_ticks(client, sched, None, 2)
    assert (slot_row(seeded, slot_id)['state'], slot_row(seeded, slot_id)['code']) == (state, code)


def test_draft_and_battery_slots_never_start(demo, seeded):
    client, sched, clock = demo
    good = synthetic_assignment(seeded)
    draft = add_slot(seeded, good, kind='DRAFT')
    swap = add_slot(seeded, kind='BATTERY_SWAP', start=T0 + timedelta(minutes=40), minutes=5)
    clock[0] = T0 + timedelta(minutes=45)
    run_ticks(client, sched, None, 2)
    assert slot_row(seeded, draft)['state'] is None and slot_row(seeded, swap)['state'] is None


def test_safety_latched_robot_is_skipped(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        agent.pump()
        ws.send_json({**json.loads(json.dumps(dict(t='state', pose={'floor_id': None, 'x': None, 'y': None,
            'yaw': None, 'confidence': None}, speed=None, battery={'soc': None}, latched=True, stop_gen=1,
            stop_ref=0, applied=[0, 0, 0], mode='FREE'))), 'safety_reason': 'OUTPUT_STALLED'})
        for _ in range(5):
            frames(ws)
        client.portal.call(sched.tick)
        assert (slot_row(seeded, slot_id)['state'], slot_row(seeded, slot_id)['code']) == ('SKIPPED', 'SAFETY_STOP')


def test_start_timeout_fails_and_releases(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws, answer=False)  # never unlocks, never answers run.start
        run_ticks(client, sched, agent, 15)
        clock[0] += timedelta(seconds=S.START_TIMEOUT_S + 1)
        assert run_ticks(client, sched, agent, 10, until=lambda: slot_row(seeded, slot_id)['state'] == 'FAILED')
        assert slot_row(seeded, slot_id)['code'] == 'START_TIMEOUT'
        assert client.app.state.realtime.arbiter.robot(str(seeded['robots']['mine'])).holder is None
        assert 'run.start' not in agent.kinds()


def test_same_slot_never_starts_twice_across_workers_and_restart(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    factory = sessionmaker(client.app.state.engine, expire_on_commit=False)
    at = T0 + timedelta(minutes=3)
    # Two workers claim at once: exactly one gets the slot.
    first = S.claim_due(factory, seeded['org'], at)
    second = S.claim_due(factory, seeded['org'], at)
    assert [c['slot_id'] for c in first] == [slot_id] and second == []
    # Restart: a new scheduler never re-sends a STARTING slot; past the start window it is MISSED.
    clock[0] = at
    fresh0 = S.Scheduler(client.app.state.realtime, factory, seeded['org'], clock=lambda: clock[0])
    client.portal.call(fresh0.tick)
    assert slot_row(seeded, slot_id)['state'] == 'STARTING'  # a live start may still own it
    clock[0] = at + S.STALE_STARTING + timedelta(seconds=1)
    fresh = S.Scheduler(client.app.state.realtime, factory, seeded['org'], clock=lambda: clock[0])
    client.portal.call(fresh.tick)
    assert slot_row(seeded, slot_id) == dict(state='MISSED', run_id=S.run_id_for(slot_id), code='SCHEDULER_RESTARTED')
    client.portal.call(fresh.tick)
    assert slot_row(seeded, slot_id)['state'] == 'MISSED'
    # The run id is unique across slots.
    other = add_slot(seeded, synthetic_assignment(seeded), start=T0 + timedelta(hours=2))
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.get(ScheduleSlot, other).run_id = S.run_id_for(slot_id)
        with pytest.raises(IntegrityError):
            db.commit()
    engine.dispose()


def test_started_slot_cannot_be_patched_or_deleted(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    factory = sessionmaker(client.app.state.engine, expire_on_commit=False)
    S.claim_due(factory, seeded['org'], T0 + timedelta(minutes=3))
    one = {'authorization': app_token(client)['authorization']}
    patched = client.patch(f'/api/v1/schedule/slots/{slot_id}', headers=one, json={'kind': 'DRAFT'})
    assert patched.status_code == 409 and patched.json()['error']['code'] == 'SCHEDULE_SLOT_RUN'
    deleted = client.delete(f'/api/v1/schedule/slots/{slot_id}', headers=one)
    assert deleted.status_code == 409


def test_slot_view_shows_run_state(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    run_ticks(client, sched, None, 2)
    one = {'authorization': app_token(client)['authorization']}
    body = client.get('/api/v1/schedule', headers=one, params={'day': '2026-11-28', 'tz': 'UTC'}).json()
    slot = next(s for s in body['slots'] if s['id'] == str(slot_id))
    assert (slot['run_state'], slot['run_code'], slot['run_id']) == ('MISSED', 'ROBOT_OFFLINE', str(S.run_id_for(slot_id)))


def test_pause_releases_run_lease_then_person_resumes_with_own_lease(demo, seeded):
    """11/28 lease rule (web #542): pause -> PAUSED, RUN lease released (relay lets go, zero, latched);
    a person then takes a USER lease and resumes with it (#537). The RUN lease is never taken again."""
    client, sched, clock = demo
    rid = str(seeded['robots']['mine'])
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    rt = client.app.state.realtime
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        assert run_ticks(client, sched, agent, 40, until=lambda: slot_row(seeded, slot_id)['state'] == 'STARTED')
        run_id = str(S.run_id_for(slot_id))
        assert rt.arbiter.robot(rid).holder.holder_type == 'RUN'
        with screen(client, app_token(client)) as sc:
            send(sc, 'sub', robots=[rid], streams=['state'])
            seen = next(f for f in frames(sc, .5) if f.get('t') == 'lease')
            assert seen['holder']['holder_type'] == 'RUN' and 'lease_id' not in seen  # the screen can tell RUN apart
            before = len(agent.seen)
            pause = send(sc, 'run.control', rid, lease_id=str(uuid4()), run_id=run_id,
                         screen_id=str(uuid4()), op='pause')
            assert reply(sc, pause)['ok']
            agent.pump()
            after = [f for f in agent.seen[before:] if f['t'] in ('lease', 'stop', 'unlock', 'run.control')]
            assert [f['t'] for f in after][:2] == ['lease', 'stop'] and after[0]['lease_id'] is None
            assert 'run.control' not in [f['t'] for f in after]
            assert rt.arbiter.robot(rid).holder is None and rid not in rt.scheduled_runs
            run_ticks(client, sched, agent, 3)
            assert slot_row(seeded, slot_id)['state'] == 'STARTED' and agent.run['status'] == 'PAUSED'
            # A person takes control and resumes with the USER lease.
            assert reply(sc, send(sc, 'lease.take', rid))['ok']
            for _ in range(10):
                agent.pump()
                holder = rt.arbiter.robot(rid).holder
                if holder:
                    break
            assert holder.holder_type == 'USER'
            lease = receive(sc, 'lease', predicate=lambda m: m.get('lease_id'))['lease_id']
            assert reply(sc, send(sc, 'unlock', rid, lease_id=lease, stop_gen=agent.gen))['ok']
            agent.pump(); agent.pump()
            resume = send(sc, 'run.control', rid, lease_id=lease, run_id=run_id, screen_id=str(uuid4()), op='resume')
            assert reply(sc, resume)['ok'], 'resume'
            agent.pump()
            sent = next(f for f in reversed(agent.seen) if f.get('t') == 'run.control')
            assert sent['op'] == 'resume' and sent['lease_id'] == lease
            assert rt.arbiter.robot(rid).holder.holder_type == 'USER'
            agent.run = {**agent.run, 'status': 'COMPLETED'}
            assert run_ticks(client, sched, agent, 20, until=lambda: slot_row(seeded, slot_id)['state'] == 'DONE')
            assert rt.arbiter.robot(rid).holder.holder_type == 'USER'  # the person keeps control
            assert not any(f.get('t') == 'lease' and str(f.get('holder_type', '')).startswith('RUN')
                           for f in agent.seen[before:])

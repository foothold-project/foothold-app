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
from .test_maps import maps  # noqa: F401  (fixture)

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
    def __init__(self, ws, *, result='OK', answer=True, latched=False, stop_ref=0, extra=None):
        # latched=False: the robot is unlatched at slot time. NOTE: the real server STOPs (latches) every
        # agent on connect and on every lease release, so today nothing reaches this state; the fake skips
        # the connect STOP to stand for «a person cleared the latch» (S1 open question in the PR).
        self.ws, self.result, self.answer = ws, result, answer
        self.cleared = not latched
        self.latched, self.gen, self.stop_ref = latched, 1, stop_ref
        self.extra = extra or {}
        self.seen, self.run, self.run_result = [], None, None

    def state(self):
        body = dict(t='state', pose={'floor_id': None, 'x': None, 'y': None, 'yaw': None, 'confidence': None},
                    speed=None, battery={'soc': None}, latched=self.latched, stop_gen=self.gen,
                    stop_ref=self.stop_ref if self.latched else 0, applied=[0, 0, 0], mode='FREE',
                    reported_run=self.run, **self.extra)
        if self.run_result is not None:
            body['run_result'] = self.run_result
        self.ws.send_json(body)

    def pump(self):
        for f in frames(self.ws):
            self.seen.append(f)
            t = f.get('t')
            if t == 'stop' and self.cleared and f.get('cause') == 'agent_connected':
                self.stop_ref = f['stop_ref']  # stands for a person's later unlock (see __init__)
            elif t == 'stop':
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
             minutes=30, assignment=True, confirmer='one'):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        row = ScheduleSlot(org_id=seeded['org'], robot_id=seeded['robots'][robot], kind=kind,
            scenario_id=UUID(good['scenario_id']) if good and kind != 'BATTERY_SWAP' else None,
            scenario_version=good['scenario_version'] if good and kind != 'BATTERY_SWAP' else None,
            assignment_id=UUID(good['assignment_id']) if good and assignment and kind != 'BATTERY_SWAP' else None,
            start_at=start, end_at=start + timedelta(minutes=minutes), memo='', created_by=seeded['users']['one'],
            confirmed_by=seeded['users'][confirmer] if kind == 'CONFIRMED' and confirmer else None)
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
        if agent is not None:
            agent.pump()  # the server holds a fresh state before each tick (the real agent streams it)
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
    add_slot(seeded, kind='BATTERY_SWAP', start=T0 + timedelta(minutes=32), minutes=10)
    clock[0] = T0 + timedelta(minutes=3)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws, result='NAV_UNAVAILABLE')
        assert run_ticks(client, sched, agent, 40, until=lambda: slot_row(seeded, slot_id)['state'] == 'FAILED')
        assert slot_row(seeded, slot_id)['code'] == 'NAV_UNAVAILABLE'
        holder = client.app.state.realtime.arbiter.robot(str(seeded['robots']['mine'])).holder
        assert holder is None
    # N1: a slot that never STARTED (STARTING -> FAILED) does not announce the next battery swap.
    assert 'SCHEDULE_BATTERY_SWAP_NEXT' not in codes(seeded)


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
        assert slot_row(seeded, slot_id)['code'] == 'REAL_ROBOT_SCHEDULE_DISABLED'  # off by default (10:58)
        assert 'run.start' not in agent.kinds() and sent(agent, 'unlock', 'lease') == sent(agent, 'lease')[:1]
    skipped = [d for _, d in events(seeded, 'SCHEDULE_RUN_SKIPPED')]
    assert [(d['slot_id'], d['reason']) for d in skipped] == [(str(slot_id), 'REAL_ROBOT_SCHEDULE_DISABLED')]


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


def started_slot(seeded, good, minutes=30):
    """A slot this or an earlier server process already STARTED (run_id set)."""
    slot_id = add_slot(seeded, good, minutes=minutes)
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        row = db.get(ScheduleSlot, slot_id)
        row.run_state, row.run_id, row.run_at = 'STARTED', S.run_id_for(slot_id), T0 + timedelta(minutes=2)
        db.commit()
    engine.dispose()
    return slot_id


def late_events(seeded, slot_id):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        rows = [(e.code, e.data.get('status')) for e in db.scalars(select(Event).where(
            Event.code == 'SCHEDULE_RUN_LATE_REPORT')) if e.data.get('slot_id') == str(slot_id)]
    engine.dispose()
    return rows


def test_started_slot_without_report_past_end_fails_report_lost_then_late_report_is_only_noted(demo, seeded):
    """11/28: a STARTED slot is not kept forever. Past end_at with no agent report -> FAILED RUN_REPORT_LOST
    (with an event). A report that arrives later is recorded only; the slot state never changes again."""
    client, sched, clock = demo
    slot_id = started_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=31)  # before end_at + nothing: still STARTED
    run_ticks(client, sched, None, 2)
    assert slot_row(seeded, slot_id)['state'] == 'STARTED'
    clock[0] = T0 + timedelta(minutes=33, seconds=1)  # past end_at (T0+32m) + grace, no agent, no report
    run_ticks(client, sched, None, 2)
    assert (slot_row(seeded, slot_id)['state'], slot_row(seeded, slot_id)['code']) == ('FAILED', 'RUN_REPORT_LOST')
    assert 'SCHEDULE_RUN_FAILED' in codes(seeded)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        agent.run = dict(run_id=str(S.run_id_for(slot_id)), status='COMPLETED', step=0,
                         progress={'done': 1, 'total': 1}, wait_reason=None, fail_code=None)
        run_ticks(client, sched, agent, 4)
    assert (slot_row(seeded, slot_id)['state'], slot_row(seeded, slot_id)['code']) == ('FAILED', 'RUN_REPORT_LOST')
    assert late_events(seeded, slot_id) == [('SCHEDULE_RUN_LATE_REPORT', 'COMPLETED')]  # once


def test_started_slot_still_reported_running_past_end_stays_started(demo, seeded):
    client, sched, clock = demo
    slot_id = started_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=40)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        agent.run = dict(run_id=str(S.run_id_for(slot_id)), status='MOVING', step=0,
                         progress={'done': 0, 'total': 1}, wait_reason=None, fail_code=None)
        run_ticks(client, sched, agent, 4)
        assert slot_row(seeded, slot_id)['state'] == 'STARTED'  # the agent still reports it


def sent(agent, *kinds):
    return [f for f in agent.seen if f.get('t') in kinds]


def events(seeded, code):
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        rows = list(db.scalars(select(Event).where(Event.code == code).order_by(Event.at)))
        out = [(e.user_id, e.data) for e in rows]
    engine.dispose()
    return out


@pytest.mark.parametrize('case', ['person_stop', 'reconnect', 'safety'])
def test_latched_robot_is_skipped_and_never_unlocked(demo, seeded, case):
    """S1 (PRD SF-02 · ADR-003): only a person unlocks. A latched robot -> SKIPPED STOP_LATCHED whatever
    stop_ref / safety_reason; no unlock, no run.start; pause/resume cannot get around it. The next slot
    skips too while the latch stays; once a person clears it the following slot runs."""
    client, sched, clock = demo
    rid = str(seeded['robots']['mine'])
    good = synthetic_assignment(seeded)
    first = add_slot(seeded, good)
    second = add_slot(seeded, good, start=T0 + timedelta(minutes=40), minutes=10)
    third = add_slot(seeded, good, start=T0 + timedelta(minutes=60), minutes=10)
    kw = dict(person_stop=dict(stop_ref=7), reconnect=dict(stop_ref=0),
              safety=dict(stop_ref=0, extra={'safety_reason': 'OUTPUT_STALLED'}))[case]
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws, latched=True, **kw)
        clock[0] = T0 + timedelta(minutes=3)
        run_ticks(client, sched, agent, 4)
        assert (slot_row(seeded, first)['state'], slot_row(seeded, first)['code']) == ('SKIPPED', 'STOP_LATCHED')
        assert sent(agent, 'unlock', 'run.start') == [] and agent.latched
        with screen(client, app_token(client)) as sc:
            for op in ('pause', 'resume'):
                send(sc, 'run.control', rid, lease_id=str(uuid4()), run_id=str(S.run_id_for(first)),
                     screen_id=str(uuid4()), op=op)
            run_ticks(client, sched, agent, 3)
        assert sent(agent, 'unlock', 'run.start') == [] and agent.latched
        clock[0] = T0 + timedelta(minutes=41)
        run_ticks(client, sched, agent, 4)
        assert (slot_row(seeded, second)['state'], slot_row(seeded, second)['code']) == ('SKIPPED', 'STOP_LATCHED')
        assert sent(agent, 'unlock', 'run.start') == [] and agent.latched
        agent.latched, agent.extra = False, {}  # a person clears the latch (stand-in: see FakeAgent)
        clock[0] = T0 + timedelta(minutes=61)
        assert run_ticks(client, sched, agent, 40, until=lambda: slot_row(seeded, third)['state'] == 'STARTED')
    skipped = [d for _, d in events(seeded, 'SCHEDULE_RUN_SKIPPED')]
    assert [d['slot_id'] for d in skipped] == [str(first), str(second)]  # one event line per slot
    assert all(d['reason'] == 'STOP_LATCHED' for d in skipped)


def test_person_stop_during_start_is_never_unlocked(demo, seeded):
    """A person's STOP after the scheduler's own STOP/unlock but before run.start: no second unlock,
    no run.start, SKIPPED STOP_LATCHED."""
    client, sched, clock = demo
    rid = str(seeded['robots']['mine'])
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        assert run_ticks(client, sched, agent, 20, until=lambda: sent(agent, 'unlock'))
        assert sent(agent, 'run.start') == []
        with screen(client, app_token(client)) as sc:
            assert reply(sc, send(sc, 'stop', rid))['ok']
            agent.pump()
            run_ticks(client, sched, agent, 5)
        assert (slot_row(seeded, slot_id)['state'], slot_row(seeded, slot_id)['code']) == ('SKIPPED', 'STOP_LATCHED')
        assert len(sent(agent, 'unlock')) == 1 and sent(agent, 'run.start') == [] and agent.latched


def start_until_unlock(client, sched, seeded, agent, slot_id):
    assert run_ticks(client, sched, agent, 20, until=lambda: sent(agent, 'unlock'))
    assert sent(agent, 'run.start') == [] and not agent.latched
    rt = client.app.state.realtime
    rid = str(seeded['robots']['mine'])
    holder = rt.arbiter.robot(rid).holder
    assert holder.holder_type == 'RUN' and rt.scheduled_runs[rid]['run_id'] == str(S.run_id_for(slot_id))
    return rt, rid, holder


@pytest.mark.parametrize('gate', ['robot_changes', 'owner_uncertain', 'blocked_agent_control'])
def test_gate_block_just_before_start_is_run_not_allowed(demo, seeded, gate):
    """M9 · M12: the scheduler respects blocked_agent_control at the last moment."""
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        rt, rid, _ = start_until_unlock(client, sched, seeded, agent, slot_id)
        if gate == 'robot_changes':
            rt.robot_changes.add(rid)
        elif gate == 'owner_uncertain':
            rt.owner_uncertain = True
        else:
            original = rt.blocked_agent_control
            rt.blocked_agent_control = lambda peer, body: body.get('t') == 'run.start' or original(peer, body)
        client.portal.call(sched.tick)
        if gate == 'robot_changes':
            rt.robot_changes.discard(rid)
        elif gate == 'owner_uncertain':
            rt.owner_uncertain = False
        agent.pump()
        assert (slot_row(seeded, slot_id)['state'], slot_row(seeded, slot_id)['code']) == ('SKIPPED', 'RUN_NOT_ALLOWED')
        assert sent(agent, 'run.start') == []


def test_run_lease_gate_takes_only_its_own_run_start(demo, seeded):
    """M9 · M10: with the slot's RUN lease, the server gate passes only run.start for that run id."""
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        rt, rid, holder = start_until_unlock(client, sched, seeded, agent, slot_id)
        peer = rt.agents[rid]
        base = dict(request_id='x', user_id=str(seeded['users']['one']), lease_id=holder.lease_id,
                    screen_id=str(uuid4()))
        own = dict(base, t='run.start', run_id=str(S.run_id_for(slot_id)))
        assert not rt.blocked_agent_control(peer, own)
        assert rt.blocked_agent_control(peer, dict(own, run_id=str(uuid4())))  # another run id
        for op in ('pause', 'resume', 'abort'):
            assert rt.blocked_agent_control(peer, dict(base, t='run.control', run_id=own['run_id'], op=op))
        assert rt.blocked_agent_control(peer, dict(own, lease_id=str(uuid4())))  # another lease


# -- owner pause contract (#542 R5 · 05:09 every device) --

def test_contract_pause_needs_no_lease_but_resume_and_abort_do():
    from apps.contracts import models as C
    from pydantic import ValidationError
    common = dict(t='run.control', id='a', robot=str(uuid4()), run_id=str(uuid4()), screen_id=str(uuid4()))
    assert C.ScreenRunControl.model_validate(dict(common, op='pause')).lease_id is None
    C.ScreenRunControl.model_validate(dict(common, op='pause', lease_id=str(uuid4())))
    for op in ('resume', 'abort'):
        with pytest.raises(ValidationError):
            C.ScreenRunControl.model_validate(dict(common, op=op))


def scheduled_moving(client, sched, seeded, agent, slot_id):
    assert run_ticks(client, sched, agent, 40, until=lambda: slot_row(seeded, slot_id)['state'] == 'STARTED')
    assert agent.run['status'] == 'MOVING'


def test_owner_pauses_run_lease_without_lease_id_and_audit_names_them(demo, seeded):
    client, sched, clock = demo
    rid = str(seeded['robots']['mine'])
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    clock[0] = T0 + timedelta(minutes=3)
    rt = client.app.state.realtime
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        scheduled_moving(client, sched, seeded, agent, slot_id)
        run_id = str(S.run_id_for(slot_id))
        with screen(client, app_token(client, 'two')) as other:  # not this robot's owner
            denied = reply(other, send(other, 'run.control', rid, run_id=run_id, screen_id=str(uuid4()), op='pause'))
            assert not denied['ok'] and rt.arbiter.robot(rid).holder.holder_type == 'RUN'
        with screen(client, app_token(client)) as sc:
            wrong = reply(sc, send(sc, 'run.control', rid, run_id=str(uuid4()), screen_id=str(uuid4()), op='pause'))
            assert not wrong['ok']  # another run id: nothing happens
            assert rt.arbiter.robot(rid).holder.holder_type == 'RUN'
            ok = reply(sc, send(sc, 'run.control', rid, run_id=run_id, screen_id=str(uuid4()), op='pause'))
            assert ok['ok'], ok
            agent.pump()
            assert rt.arbiter.robot(rid).holder is None and agent.latched and agent.run['status'] == 'PAUSED'
            run_ticks(client, sched, agent, 3)
            assert sent(agent, 'unlock')[-1:] == sent(agent, 'unlock')[:1]  # only the scheduler's own, once
        assert agent.latched  # the latch stays: pause never clears it
    rows = events(seeded, 'RUN_PAUSE_REQUESTED')
    assert [(str(u), d['run_id'], d['holder_type']) for u, d in rows] == [(str(seeded['users']['one']), run_id, 'RUN')]


def test_user_lease_pause_only_by_holder_and_audited(demo, seeded):
    """USER holder: only that screen's lease pauses (lease_id required). Others use STOP or lease.request."""
    client, sched, clock = demo
    rid = str(seeded['robots']['mine'])
    rt = client.app.state.realtime
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws)
        agent.pump()
        with screen(client, app_token(client)) as sc, screen(client, app_token(client)) as second:
            assert reply(sc, send(sc, 'lease.take', rid))['ok']
            for _ in range(10):
                agent.pump()
                if rt.arbiter.robot(rid).holder:
                    break
            lease = rt.arbiter.robot(rid).holder.lease_id
            run_id = str(uuid4())
            body = dict(run_id=run_id, screen_id=str(uuid4()), op='pause')
            no_lease = reply(sc, send(sc, 'run.control', rid, **body))
            assert no_lease['error']['code'] == 'LEASE_MISMATCH'  # a USER lease is named
            other = reply(second, send(second, 'run.control', rid, lease_id=lease, **body))
            assert other['error']['code'] == 'LEASE_MISMATCH'  # same person, another screen
            ok = reply(sc, send(sc, 'run.control', rid, lease_id=lease, **body))
            assert ok['ok'], ok
            agent.pump()
            assert sent(agent, 'run.control')[-1]['op'] == 'pause'
            assert rt.arbiter.robot(rid).holder.holder_type == 'USER'  # the lease logic is unchanged
    rows = events(seeded, 'RUN_PAUSE_REQUESTED')
    assert [(str(u), d['run_id'], d['holder_type']) for u, d in rows] == [(str(seeded['users']['one']), run_id, 'USER')]


# -- (1) confirming a slot counts as pressing unlock in advance: simulation only (10:58) --

def person_unlocks_then_releases(client, seeded, agent):
    """A person takes control, unlocks, then lets go: the server's release STOP latches the robot again."""
    rt = client.app.state.realtime
    rid = str(seeded['robots']['mine'])
    with screen(client, app_token(client)) as sc:
        assert reply(sc, send(sc, 'lease.take', rid))['ok']
        for _ in range(10):
            agent.pump()
            if rt.arbiter.robot(rid).holder:
                break
        lease = rt.arbiter.robot(rid).holder.lease_id
        assert reply(sc, send(sc, 'unlock', rid, lease_id=lease, stop_gen=agent.gen))['ok']
        agent.pump(); agent.pump()
        assert not agent.latched
        assert reply(sc, send(sc, 'lease.release', rid))['ok']
        agent.pump(); agent.pump()
    assert agent.latched and rt.arbiter.robot(rid).holder is None


def test_confirmed_slot_pre_unlocks_a_release_latch_on_the_demo_robot(demo, seeded):
    client, sched, clock = demo
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws, latched=True)  # the real connect STOP latches it
        agent.pump()
        person_unlocks_then_releases(client, seeded, agent)
        clock[0] = T0 + timedelta(minutes=3)
        assert run_ticks(client, sched, agent, 40, until=lambda: slot_row(seeded, slot_id)['state'] == 'STARTED')
        start = sent(agent, 'run.start')[-1]
        assert start['user_id'] == str(seeded['users']['one'])  # the confirmer
    rows = events(seeded, 'SCHEDULE_PRE_UNLOCK')
    assert [(str(u), d['slot_id']) for u, d in rows] == [(str(seeded['users']['one']), str(slot_id))]


@pytest.mark.parametrize('case', ['connect_only', 'person_stop', 'agent_stop', 'safety'])
def test_pre_unlock_never_clears_a_persons_or_restart_latch(demo, seeded, case):
    """Only a latch made by the server releasing control (after a person had unlocked) is pre-unlocked.
    Connect/restart latch (SF-02), a person's STOP, a STOP the agent took itself (phone · sim stop) or a
    safety latch stay: SKIPPED STOP_LATCHED, no unlock, no run.start."""
    client, sched, clock = demo
    rid = str(seeded['robots']['mine'])
    slot_id = add_slot(seeded, synthetic_assignment(seeded))
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws, latched=True)
        agent.pump()
        if case != 'connect_only':
            person_unlocks_then_releases(client, seeded, agent)
        if case == 'person_stop':
            with screen(client, app_token(client)) as sc:
                assert reply(sc, send(sc, 'stop', rid))['ok']
                agent.pump()
        elif case == 'agent_stop':
            agent.gen += 1  # the Hub latched again by itself (phone STOP / sim stop); the server sent nothing
        elif case == 'safety':
            agent.extra = {'safety_reason': 'OUTPUT_STALLED'}
        before = len(sent(agent, 'unlock'))
        clock[0] = T0 + timedelta(minutes=3)
        run_ticks(client, sched, agent, 5)
        assert (slot_row(seeded, slot_id)['state'], slot_row(seeded, slot_id)['code']) == ('SKIPPED', 'STOP_LATCHED')
        assert len(sent(agent, 'unlock')) == before and sent(agent, 'run.start') == [] and agent.latched
    assert events(seeded, 'SCHEDULE_PRE_UNLOCK') == []


@pytest.mark.parametrize('case', ['no_confirmer', 'not_owner', 'locked'])
def test_pre_unlock_needs_the_confirmers_authority_now(demo, seeded, case):
    client, sched, clock = demo
    confirmer = dict(no_confirmer=None, not_owner='two', locked='locked')[case]
    slot_id = add_slot(seeded, synthetic_assignment(seeded), confirmer=confirmer)
    with agent_ws(client, seeded) as ws:
        ws.send_json(hello())
        agent = FakeAgent(ws, latched=True)
        agent.pump()
        person_unlocks_then_releases(client, seeded, agent)
        before = len(sent(agent, 'unlock'))
        clock[0] = T0 + timedelta(minutes=3)
        run_ticks(client, sched, agent, 5)
        assert (slot_row(seeded, slot_id)['state'], slot_row(seeded, slot_id)['code']) == ('SKIPPED', 'CONFIRMER_NOT_ALLOWED')
        assert len(sent(agent, 'unlock')) == before and sent(agent, 'run.start') == []


def test_confirmed_by_follows_who_made_the_slot_confirmed(maps, seeded):
    client, _, _ = maps
    from .test_schedule import scenario
    from .test_maps import auth
    admin, one = auth(client, 'admin'), auth(client, 'one')
    value = scenario(client, admin)
    body = dict(robot_id=str(seeded['robots']['mine']), start='2030-01-01T00:00:00Z', end='2030-01-01T01:00:00Z',
                scenario_id=value['id'], scenario_version=value['number'])
    made = client.post('/api/v1/schedule/slots', headers=one, json={**body, 'kind': 'DRAFT'}).json()
    assert made['confirmed_by'] is None
    confirmed = client.patch(f"/api/v1/schedule/slots/{made['id']}", headers=admin, json={'kind': 'CONFIRMED'}).json()
    assert confirmed['confirmed_by'] == str(seeded['users']['admin'])
    direct = client.post('/api/v1/schedule/slots', headers=one, json={**body, 'kind': 'CONFIRMED',
        'start': '2030-01-02T00:00:00Z', 'end': '2030-01-02T01:00:00Z'}).json()
    assert direct['confirmed_by'] == str(seeded['users']['one'])
    back = client.patch(f"/api/v1/schedule/slots/{made['id']}", headers=one, json={'kind': 'DRAFT'}).json()
    assert back['confirmed_by'] is None


def test_real_robot_flag_is_the_one_switch(demo, seeded):
    """Real robots are off by default; one setting opens them later (after the real STOP check)."""
    client, sched, clock = demo
    from apps.server.fh_server.api import Settings
    assert Settings('x', uuid4()).schedule_real_robots is False
    slot_id = add_slot(seeded, synthetic_assignment(seeded, robot='theirs'), robot='theirs', confirmer='two')
    factory = sessionmaker(client.app.state.engine, expire_on_commit=False)
    claimed = S.claim_due(factory, seeded['org'], T0 + timedelta(minutes=3), real_enabled=True)
    assert [c['slot_id'] for c in claimed] == [slot_id]


def test_maintenance_slot_on_a_real_robot_sends_nothing(demo, seeded):
    """11/28 15:04: 정비 칸은 일정 표시뿐이다. 실기에 걸려 있어도 서버는 로봇에 아무 명령도 보내지 않는다."""
    client, sched, clock = demo
    with agent_ws(client, seeded, 'theirs') as ws:  # theirs = 실기 (demo fixture)
        ws.send_json(hello())
        agent = FakeAgent(ws)
        run_ticks(client, sched, agent, 3)
        baseline = list(agent.kinds())
        slot_id = add_slot(seeded, robot='theirs', kind='MAINTENANCE', start=T0 + timedelta(minutes=2), minutes=30)
        for minutes in (1, 3, 20, 40):  # 칸 전 · 걸린 동안 · 끝난 뒤
            clock[0] = T0 + timedelta(minutes=minutes)
            run_ticks(client, sched, agent, 3)
        after = agent.kinds()[len(baseline):]
        assert [k for k in after if k not in ('ping',)] == [], after
        assert slot_row(seeded, slot_id) == dict(state=None, run_id=None, code=None)
    assert [c for c in codes(seeded)] == []

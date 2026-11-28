"""일정 칸 예약 실행 (11/28): CONFIRMED 칸의 시작 시각에 서버가 #537 과 같은 run.start 를 에이전트에 보낸다.

- 요청자는 서버 (칸을 만든 사람 이름으로). 관문은 사람 요청과 같다 (blocked_agent_control · 배정 확인).
- 예약 실행의 조종권은 기존 RUN holder lease 다 (Arbiter.begin(actor=None) -> STOP 확인 뒤 'RUN:<run_id>').
  사람 USER lease · 요청 · 넘김이 있으면 기다리지 않고 SKIPPED LEASE_HELD.
- 실기 칸은 시작하지 않는다 (SKIPPED REAL_ROBOT_SCHEDULE_DISABLED, 11/28 10:58). 켜는 곳은 설정 하나
  (Settings.schedule_real_robots · FH_SCHEDULE_REAL_ROBOTS, 기본 꺼짐) 이고 실기 STOP 확인 뒤에 연다.
  로봇이 끊겨 있으면 MISSED ROBOT_OFFLINE.
- 한 칸은 한 번만: run_state IS NULL 인 줄만 FOR UPDATE SKIP LOCKED 로 잡고 같은 트랜잭션에서 STARTING 으로
  바꾼다. run_id 는 칸에서 정해지는 uuid5 이고 유일 키다. 다시 켜져 STARTING 으로 남은 칸은 시작 시한
  (START_TIMEOUT_S + 10 초) 이 지나면 보내지 않고 MISSED SCHEDULER_RESTARTED.
- 에이전트 소켓은 한 프로세스 메모리에 있다 (realtime). 서버는 한 프로세스로 돈다는 전제.
- 시계는 clock 으로 바꿔 끼운다 (시험).
- STARTED 칸은 끝없이 두지 않는다: end_at + 60 초가 지나고 이 프로세스가 60 초 넘게 보고를 못 보면 FAILED
  RUN_REPORT_LOST (사건). 그 뒤 늦게 온 끝 보고는 SCHEDULE_RUN_LATE_REPORT 사건만 남기고 칸은 그대로.
- 잠금은 사람만 푼다 (PRD SF-02 · ADR-003, 11/28 S1). 칸 시각에 로봇이 잠겨 있으면 (latched=True, 새 state
  가 없음도 잠김으로 본다) stop_ref · safety_reason 과 상관없이 SKIPPED STOP_LATCHED, unlock 을 보내지 않는다.
  잠금이 남아 있는 동안 다음 칸도 건너뛰고, 사람이 풀면 그다음 칸부터 돈다.
  서버가 보내는 unlock 은 RUN lease 를 넘겨받을 때 서버가 스스로 낸 STOP (이미 풀려 있던 로봇) 만 푼다.
  그 사이 사람 STOP 이 오면 (stop_ref 가 바뀜) unlock · run.start 없이 SKIPPED STOP_LATCHED.
  예외 하나 (①, 시뮬만 · 실기는 위 설정 뒤): 칸을 CONFIRMED 로 만든 사람 (confirmed_by) 이 잠금 해제를 미리
  누른 것으로 본다. 단 그 잠금이 «사람이 풀어 둔 로봇을 서버가 조종권을 놓으며 잠근 것» 일 때만
  (Realtime.release_latched_only). run 끝은 에이전트가 먼저 스스로 잠그므로, 에이전트가 그 잠금을 그 run 의
  COMPLETED 끝으로 밝힌 것 (state.run_end_latch, 같은 run id · 그 뒤 stop_gen 그대로) 만 run 끝 잠금으로 친다 (#630).
  다시 붙음 · 재시작 · 사람 STOP · 그 밖의 에이전트 스스로 잠금 · FAILED · safety 잠금은 그대로
  STOP_LATCHED. 해제는 그 사람 권한으로 (지금도 담당 또는 총괄, 잠기지 않은 계정) 하고 사건
  SCHEDULE_PRE_UNLOCK 를 남긴다. 권한이 없으면 SKIPPED CONFIRMER_NOT_ALLOWED.
  PR #549 본문 «정한 것» 에 같은 규칙.
"""
import asyncio
import logging
from datetime import timedelta, timezone
from uuid import UUID, uuid5

from sqlalchemy import select

from apps.contracts import models as C
from .event_messages import render
from .leases import Effect
from .models import Assignment, Event, Robot, ScenarioVersion, ScheduleSlot, User, now

log = logging.getLogger(__name__)
NAMESPACE = UUID('5d7c4c8e-62a5-4f0e-9a51-1f0d2e8b7c11')
START_TIMEOUT_S = 20
STALE_STARTING = timedelta(seconds=START_TIMEOUT_S + 10)
REPORT_GRACE = timedelta(seconds=60)  # no report for this long (after end_at) means lost
LATE_WINDOW = timedelta(days=1)  # how long a RUN_REPORT_LOST slot still notes a late report
TERMINAL = {'COMPLETED': 'DONE', 'FAILED': 'FAILED', 'CANCELED': 'FAILED', 'ABORTED': 'FAILED'}


def run_id_for(slot_id):
    return uuid5(NAMESPACE, 'run:' + str(slot_id))


def screen_id_for(slot_id):
    return uuid5(NAMESPACE, 'screen:' + str(slot_id))


def request_id_for(slot_id):
    return 'schedule:' + str(slot_id)


def note(db, org_id, row, code, *, user=None, **data):
    db.add(render(db, Event(org_id=org_id, category='RUN', code=code, user_id=user or row.created_by,
        robot_id=row.robot_id, data={'slot_id': str(row.id), 'run_id': str(row.run_id) if row.run_id else None,
                                     'action': data.get('reason'), **data})))


def settle(db, org_id, row, state, code=None):
    row.run_state, row.run_code = state, code
    note(db, org_id, row, {'STARTED': 'SCHEDULE_RUN_STARTED', 'DONE': 'SCHEDULE_RUN_DONE',
                           'FAILED': 'SCHEDULE_RUN_FAILED', 'SKIPPED': 'SCHEDULE_RUN_SKIPPED',
                           'MISSED': 'SCHEDULE_RUN_MISSED'}[state], reason=code)


def claim_due(factory, org_id, at, *, real_enabled=False):
    """Claim due CONFIRMED slots exactly once. Returns start requests for slots left STARTING."""
    claimed = []
    with factory() as db, db.begin():
        # A STARTING slot older than any live start (START_TIMEOUT_S) lost its process: never re-sent.
        for row in db.scalars(select(ScheduleSlot).where(ScheduleSlot.org_id == org_id,
                ScheduleSlot.run_state == 'STARTING', ScheduleSlot.run_at < at - STALE_STARTING)
                .with_for_update(skip_locked=True)):
            settle(db, org_id, row, 'MISSED', 'SCHEDULER_RESTARTED')
        rows = db.scalars(select(ScheduleSlot).where(ScheduleSlot.org_id == org_id,
            ScheduleSlot.kind == 'CONFIRMED', ScheduleSlot.run_state.is_(None), ScheduleSlot.start_at <= at)
            .order_by(ScheduleSlot.start_at, ScheduleSlot.id).with_for_update(skip_locked=True)).all()
        for row in rows:
            row.run_at, row.run_id, row.run_state = at, run_id_for(row.id), 'STARTING'
            if row.end_at <= at:
                settle(db, org_id, row, 'MISSED', 'WINDOW_PASSED')
                continue
            robot = db.scalar(select(Robot).where(Robot.org_id == org_id, Robot.id == row.robot_id))
            if robot is None or robot.archived_at is not None:
                settle(db, org_id, row, 'MISSED', 'ROBOT_OFFLINE')
                continue
            if robot.simulation is not True and not real_enabled:
                settle(db, org_id, row, 'SKIPPED', 'REAL_ROBOT_SCHEDULE_DISABLED')
                continue
            confirmer = row.confirmed_by and db.scalar(select(User).where(
                User.org_id == org_id, User.id == row.confirmed_by))
            if (not confirmer or confirmer.locked or confirmer.archived_at is not None
                    or (confirmer.role != 'ORG_ADMIN' and robot.owner_user_id != confirmer.id)):
                settle(db, org_id, row, 'SKIPPED', 'CONFIRMER_NOT_ALLOWED')  # the run goes in their name, now
                continue
            if row.assignment_id is None:
                settle(db, org_id, row, 'SKIPPED', 'NO_ASSIGNMENT')
                continue
            assignment = db.scalar(select(Assignment).where(Assignment.org_id == org_id,
                                                            Assignment.id == row.assignment_id))
            version = assignment and db.scalar(select(ScenarioVersion).where(
                ScenarioVersion.org_id == org_id, ScenarioVersion.id == assignment.scenario_version_id))
            if (assignment is None or assignment.status != 'ACTIVE' or assignment.robot_id != row.robot_id
                    or version is None or version.scenario_id != row.scenario_id
                    or version.number != row.scenario_version):
                settle(db, org_id, row, 'SKIPPED', 'ASSIGNMENT_INVALID')
                continue
            if len(version.floor_ids) != 1 or len(version.map_version_ids) != 1:
                settle(db, org_id, row, 'SKIPPED', 'MULTI_FLOOR')
                continue
            row.run_state = 'STARTING'
            claimed.append(dict(slot_id=row.id, robot_id=str(row.robot_id), run_id=row.run_id,
                user_id=row.confirmed_by, assignment_id=row.assignment_id, scenario_id=row.scenario_id,
                scenario_version=row.scenario_version, floor_id=version.floor_ids[0],
                map_version_id=version.map_version_ids[0]))
    return claimed


def write(factory, org_id, outcomes):
    """outcomes: [(slot_id, state, code)] for slots this process owns (STARTING/STARTED)."""
    with factory() as db, db.begin():
        for slot_id, state, code in outcomes:
            row = db.scalar(select(ScheduleSlot).where(ScheduleSlot.org_id == org_id, ScheduleSlot.id == slot_id)
                            .with_for_update())
            if state == 'PRE_UNLOCK':
                if row is not None:  # who pre-pressed unlock: the confirmer (event user_id)
                    note(db, org_id, row, 'SCHEDULE_PRE_UNLOCK', user=UUID(code), confirmer=code)
                continue
            if state == 'LATE':
                # A report after RUN_REPORT_LOST: record it once, never change the slot state again.
                if row is not None and row.run_code == 'RUN_REPORT_LOST' and not any(
                        e.data.get('slot_id') == str(row.id) for e in db.scalars(select(Event).where(
                            Event.org_id == org_id, Event.code == 'SCHEDULE_RUN_LATE_REPORT',
                            Event.robot_id == row.robot_id))):
                    note(db, org_id, row, 'SCHEDULE_RUN_LATE_REPORT', status=code, reason=code)
                continue
            if row is None or row.run_state not in ('STARTING', 'STARTED') or row.run_state == state:
                continue
            was = row.run_state
            settle(db, org_id, row, state, code)
            if state in ('DONE', 'FAILED') and was == 'STARTED':  # N1: read before settle
                following = db.scalar(select(ScheduleSlot).where(ScheduleSlot.org_id == org_id,
                    ScheduleSlot.robot_id == row.robot_id, ScheduleSlot.start_at >= row.end_at)
                    .order_by(ScheduleSlot.start_at).limit(1))
                if following is not None and following.kind == 'BATTERY_SWAP':
                    # This unit records only; nothing is started for a battery swap slot.
                    note(db, org_id, following, 'SCHEDULE_BATTERY_SWAP_NEXT', after_slot_id=str(row.id))


def started(factory, org_id, at):
    """STARTED slots, plus RUN_REPORT_LOST slots of the last day whose late report may still arrive."""
    with factory() as db:
        return [dict(slot_id=r.id, robot_id=str(r.robot_id), run_id=str(r.run_id), end_at=r.end_at,
                     lost=r.run_state == 'FAILED') for r in db.scalars(
            select(ScheduleSlot).where(ScheduleSlot.org_id == org_id, (ScheduleSlot.run_state == 'STARTED') | (
                (ScheduleSlot.run_state == 'FAILED') & (ScheduleSlot.run_code == 'RUN_REPORT_LOST')
                & (ScheduleSlot.end_at > at - LATE_WINDOW))))]


class Scheduler:
    def __init__(self, realtime, factory, org_id, *, clock=None, real_enabled=False):
        self.rt, self.factory, self.org_id = realtime, factory, org_id
        self.real_enabled = real_enabled  # the one switch for real robots (default off)
        self.clock = clock or (lambda: now().astimezone(timezone.utc))
        self.pending = {}   # slot_id -> start state machine (memory only; restart = MISSED)
        self.reported = {}  # slot_id -> last time a report (or, after a restart, the first look) was seen

    async def tick(self):
        at = self.clock()
        claimed = await asyncio.to_thread(claim_due, self.factory, self.org_id, at, real_enabled=self.real_enabled)
        outcomes = []
        for item in claimed:
            outcomes += self.begin(item, at)
        for slot_id, p in list(self.pending.items()):
            outcomes += self.step(slot_id, p, at)
        for item in await asyncio.to_thread(started, self.factory, self.org_id, at):
            outcomes += self.watch(item, at)
        if outcomes:
            await asyncio.to_thread(write, self.factory, self.org_id, outcomes)

    # -- start state machine (GRANT -> UNLOCK -> RESULT) --

    def begin(self, item, at):
        rt, rid, slot_id = self.rt, item['robot_id'], item['slot_id']
        peer = rt.agents.get(rid)
        if peer is None or peer.closing or rt.clock() - peer.auth_checked > .5:
            return [(slot_id, 'MISSED', 'ROBOT_OFFLINE')]
        if not peer.simulation and not self.real_enabled:
            return [(slot_id, 'SKIPPED', 'REAL_ROBOT_SCHEDULE_DISABLED')]
        if rt.owner_uncertain or getattr(rt, 'failed', False):
            return [(slot_id, 'MISSED', 'SERVER_BUSY')]
        r = rt.arbiter.robot(rid)
        if (r.holder and r.holder.holder_type == 'USER') or r.request or r.transfer:
            return [(slot_id, 'SKIPPED', 'LEASE_HELD')]  # a person holds or is getting control: never wait
        reported = peer.state.get('reported_run')
        if r.holder or (reported and reported.get('status') not in TERMINAL) or rid in rt.scheduled_runs:
            return [(slot_id, 'SKIPPED', 'RUN_ACTIVE')]
        fresh = 0 <= rt.clock() - peer.state_received_at <= .5
        pre_unlock = False
        if not fresh or peer.state.get('latched') is not False:
            if not (fresh and rt.release_latched_only(rid)):
                closed = fresh and rt.latest_latch_cause(rid) == 'screen_disconnected'
                # only a person unlocks (SF-02); never auto-resume. A closed control tab gets its own reason.
                return [(slot_id, 'SKIPPED', 'STOP_LATCHED_SCREEN_CLOSED' if closed else 'STOP_LATCHED')]
            pre_unlock = True  # the confirmer pre-pressed unlock (1); audited below
        if peer.state.get('safety_reason') is not None:
            return [(slot_id, 'SKIPPED', 'SAFETY_STOP')]
        rt.apply(rt.arbiter.begin(rid, None, op=None, cause='scheduled_run'))  # lease null first, then STOP
        # stop_ref: this run's own start STOP. Only if run_finished is the next server STOP may its end latch be
        # pre-unlocked (#630 H1: any person · screen STOP in between moves stop_ref past it).
        rt.scheduled_runs[rid] = {'run_id': str(item['run_id']), 'slot_id': str(slot_id), 'stop_ref': r.stop_ref}
        self.pending[slot_id] = dict(item, phase='GRANT', lease=None, ref=r.stop_ref,  # our own STOP's ref
                                     deadline=at + timedelta(seconds=START_TIMEOUT_S))
        return [(slot_id, 'STARTING', None)] + ([(slot_id, 'PRE_UNLOCK', str(item['user_id']))] if pre_unlock else [])

    def _end(self, slot_id, p, state, code):
        self.pending.pop(slot_id, None)
        rt, rid = self.rt, p['robot_id']
        if state != 'STARTED':
            self._release(rid, p.get('lease'))
        return [(slot_id, state, code)]

    def _release(self, rid, lease, run_id=None):
        rt = self.rt
        if run_id is not None and (rt.scheduled_runs.get(rid) or {}).get('run_id') != run_id:
            return  # the RUN lease now belongs to someone else
        holder = rt.arbiter.robot(rid).holder
        transfer = rt.arbiter.robot(rid).transfer
        if (holder and holder.holder_type == 'RUN' and (lease is None or holder.lease_id == lease)) or (
                transfer and transfer.actor is None and lease is None):
            rt.apply(rt.arbiter.revoke(rid, op=None, cause='run_finished'))
        rt.scheduled_runs.pop(rid, None)

    def step(self, slot_id, p, at):
        rt, rid = self.rt, p['robot_id']
        peer = rt.agents.get(rid)
        if peer is None or peer.closing:
            return self._end(slot_id, p, 'FAILED', 'ROBOT_OFFLINE')
        if at >= p['deadline']:
            return self._end(slot_id, p, 'FAILED', 'START_TIMEOUT')
        r = rt.arbiter.robot(rid)
        holder = r.holder
        if r.stop_ref != p['ref']:
            return self._end(slot_id, p, 'SKIPPED', 'STOP_LATCHED')  # a person's STOP since ours: no unlock
        if p['phase'] == 'GRANT':
            if holder and holder.holder_type == 'RUN' and holder.actor is None:
                p['lease'], p['phase'] = holder.lease_id, 'UNLOCK'
                # Server-side unlock for the RUN holder; same frame shape as a person's unlock.
                rt.apply([Effect('agent', rid, {'t': 'unlock', 'lease_id': holder.lease_id,
                    'stop_gen': r.stop_gen, 'user_id': str(p['user_id'])})])
                return []
            if holder is not None:
                return self._end(slot_id, p, 'SKIPPED', 'LEASE_HELD')
            if r.transfer is None:
                return self._end(slot_id, p, 'FAILED', 'STOP_CONFIRM_FAILED')
            return []
        if holder is None or holder.lease_id != p['lease']:
            return self._end(slot_id, p, 'FAILED', 'LEASE_LOST')
        if p['phase'] == 'UNLOCK':
            fresh = 0 <= rt.clock() - peer.state_received_at <= .5
            if fresh and peer.state.get('latched') is False and peer.state.get('applied') == [0, 0, 0]:
                body = C.AgentRunStart(request_id=request_id_for(slot_id), user_id=p['user_id'],
                    lease_id=p['lease'], run_id=p['run_id'], screen_id=screen_id_for(slot_id),
                    scenario_id=p['scenario_id'], scenario_version=p['scenario_version'], floor_id=p['floor_id'],
                    map_version_id=p['map_version_id'], assignment_id=p['assignment_id']).model_dump(mode='json')
                if rt.blocked_agent_control(peer, body):
                    return self._end(slot_id, p, 'SKIPPED', 'RUN_NOT_ALLOWED')
                rt.put(peer, body)
                p['phase'] = 'RESULT'
            return []
        result = peer.state.get('run_result') or {}
        if result.get('request_id') != request_id_for(slot_id):
            return []
        if result.get('status') == 'SUCCEEDED':
            return self._end(slot_id, p, 'STARTED', None)
        return self._end(slot_id, p, 'FAILED', str(result.get('code') or 'REJECTED')[:64])

    # -- STARTED: finish when the agent reports the run terminal --

    def watch(self, item, at):
        rt, rid = self.rt, item['robot_id']
        if item['slot_id'] in self.pending:
            return []
        peer = rt.agents.get(rid)
        run = None
        if peer is not None:
            reported = peer.state.get('reported_run')
            if reported and reported.get('run_id') == item['run_id']:
                run = reported
        projected = rt.runs.get(rid)
        if run is None and projected and str(projected.get('run_id')) == item['run_id']:
            run = projected
        if item['lost']:
            return [(item['slot_id'], 'LATE', run['status'])] if run and run.get('status') in TERMINAL else []
        seen = self.reported.setdefault(item['slot_id'], at)
        if run:
            self.reported[item['slot_id']] = at
        elif at >= item['end_at'] + REPORT_GRACE and at - seen >= REPORT_GRACE:
            # No agent report past the slot's end (and for a grace this process watched): not STARTED forever.
            self.reported.pop(item['slot_id'], None)
            self._release(rid, None, item['run_id'])
            return [(item['slot_id'], 'FAILED', 'RUN_REPORT_LOST')]
        if not run or run.get('status') not in TERMINAL:
            return []
        state = TERMINAL[run['status']]
        code = None if state == 'DONE' else str(run.get('fail_code') or run['status'])[:64]
        holder = rt.arbiter.robot(rid).holder
        if holder and holder.holder_type == 'RUN' and holder.actor is None:
            start = rt.scheduled_runs.get(rid) or {}
            rt.apply(rt.arbiter.revoke(rid, op=None, cause='run_finished'))
            if run['status'] == 'COMPLETED' and start.get('run_id') == item['run_id']:
                rt.note_run_end_latch(rid, item['run_id'], start.get('stop_ref'))  # the agent's own run-end latch (#630)
        rt.scheduled_runs.pop(rid, None)
        self.reported.pop(item['slot_id'], None)
        return [(item['slot_id'], state, code)]


async def watch(app):
    scheduler = app.state.scheduler
    while True:
        await asyncio.sleep(1)
        try:
            await scheduler.tick()
        except Exception:
            log.warning('Schedule runner tick failed; retrying', exc_info=True)

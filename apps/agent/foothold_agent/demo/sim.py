"""Deterministic demo fleet simulation on an injectable clock.

Robots run the operator plan on time at the planned constant speed. The only
sources of deviation are the scenario's cause events (contract G): crowd,
path_conflict, wait_confirm, duration (per-mission difference) and fault (with
reassignment), plus charger_busy and battery_low when the plan itself fails.
Every late start records delay_cause / delay_min and is appended to the cause
event's affected list, so a delay can be traced through later items.

Time is sim seconds from scenario start; step(dt) may be called with any dt,
it is split internally into ticks of at most DT_MAX.
"""
from dataclasses import dataclass, field
import heapq
import math
import random
from types import SimpleNamespace
import uuid

from .measured import voltage
from .scenario import time_of_day

DT_MAX = 1.0
IDLE, MOVING, STEP, CHARGING, WAITING, FAULT = 'IDLE', 'MOVING', 'STEP', 'CHARGING', 'WAITING', 'FAULT'
LATE_S = 1.5  # a start later than this counts as delayed (above tick granularity)


@dataclass
class Item:
    id: str
    robot: str
    kind: str  # mission | charge
    planned_s: float
    mission: str | None = None
    charger: str | None = None
    until_soc: float | None = None
    duration_s: float | None = None
    reassigned_from: str | None = None
    inherent: tuple | None = None  # (cause, event) when the whole item exists because of an event
    preemptible: bool = False  # automatic return home; yields to the next due item
    status: str = 'pending'  # pending | active | done | failed | reassigned | dropped
    actual_s: float | None = None
    end_s: float | None = None
    delay_s: float = 0.0
    delay_cause: str | None = None
    delay_event: str | None = None
    lost: dict = field(default_factory=dict)  # (cause, event) -> seconds
    run_id: str | None = None
    step: int = 0
    phase: str | None = None
    left_s: float = 0.0
    extra_s: float = 0.0
    charge_started_s: float | None = None
    last: dict | None = None  # last reported run snapshot


class RobotSim:
    def __init__(self, spec, scenario):
        self.spec = spec
        wp = scenario.waypoints[spec.start]
        self.x, self.y, self.floor, self.node = wp.x, wp.y, wp.floor, wp.id
        self.yaw = 0.0
        self.route = []
        self.route_speed = 0.0
        self.speed = 0.0
        self.soc = spec.soc
        self.state = IDLE
        self.item = None
        self.queue = []
        self.holds = []  # dict(cause, event, until, status)
        self.pending = []  # events waiting until they can apply
        self.docked = None
        self.carry = None
        self.fault = None
        self.low_battery_handled = False

    @property
    def posture(self):
        return 'LYING' if self.docked or self.state == FAULT else 'STANDING'

    @property
    def activity(self):
        if self.docked or self.state == FAULT:
            return 'lie'
        return 'walk' if self.state == MOVING and self.speed > 0 else 'stand'


class Simulation:
    def __init__(self, scenario, *, run_id=None):
        self.scenario = scenario
        self.now = 0.0
        self.robots = {r.id: RobotSim(r, scenario) for r in scenario.robots}
        self.order = [r.id for r in scenario.robots]
        self.graph = {w: {} for w in scenario.waypoints}
        for a, b in scenario.edges:
            pa, pb = scenario.waypoints[a], scenario.waypoints[b]
            d = math.hypot(pa.x - pb.x, pa.y - pb.y)
            self.graph[a][b] = self.graph[b][a] = d
        self.run_id = run_id or (lambda item: str(uuid.uuid5(
            uuid.NAMESPACE_URL, f'foothold-demo/{scenario.name}/{item.id}')))
        self.occupancy = {c: 0 for c in scenario.chargers}
        self.history = []
        self.outbox = []
        self.causes = {}
        self.crowds = []  # active crowd events: (event, until)
        self.events = self._expand(scenario.events)
        self.items = []
        for spec in scenario.robots:
            for n, entry in enumerate(spec.schedule):
                self._enqueue(Item(f'{spec.id}/m{n}:{entry.mission}', spec.id, 'mission',
                                   entry.at_s, mission=entry.mission))
        for n, slot in enumerate(scenario.charge_rotation):
            self._enqueue(Item(f'{slot.robot}/c{n}:{slot.charger}', slot.robot, 'charge', slot.at_s,
                               charger=slot.charger, until_soc=slot.until_soc, duration_s=slot.duration_s))
        for robot in self.robots.values():
            for cid, charger in scenario.chargers.items():
                if charger.waypoint == robot.node and self.occupancy[cid] < charger.slots:
                    self._dock(robot, cid)
                    break

    # ---------- setup ----------
    def _expand(self, events):
        """Fixed-time events, plus p_per_hour events drawn once from the seed."""
        rng = random.Random(self.scenario.seed)
        out = []
        for ev in events:
            if ev.at_s is not None:
                out.append(ev)
                continue
            t, k = 0.0, 0
            while ev.p_per_hour > 0:
                t += rng.expovariate(ev.p_per_hour / 3600)
                if t > self.scenario.duration_s:
                    break
                out.append(type(ev)(**{**ev.__dict__, 'id': f'{ev.id}#{k}', 'at_s': t, 'p_per_hour': None}))
                k += 1
        out.sort(key=lambda e: e.at_s)
        return out

    def _enqueue(self, item):
        self.items.append(item)
        queue = self.robots[item.robot].queue
        index = next((i for i, other in enumerate(queue) if other.planned_s > item.planned_s), len(queue))
        queue.insert(index, item)

    def _cause(self, event):
        if event.id not in self.causes:
            self.causes[event.id] = dict(id=event.id, kind=event.kind, robot=event.robot, zone=event.zone,
                                         at_s=event.at_s, lost_s=0.0, affected=[])
        return self.causes[event.id]

    def _system_cause(self, kind, robot, key):
        eid = f'{kind}:{robot}:{key}'
        if eid not in self.causes:
            self.causes[eid] = dict(id=eid, kind=kind, robot=robot, zone=None, at_s=self.now,
                                    lost_s=0.0, affected=[])
        return eid

    def _lose(self, robot, cause, eid, seconds):
        if robot.item is not None:
            key = (cause, eid)
            robot.item.lost[key] = robot.item.lost.get(key, 0.0) + seconds
        if eid in self.causes:
            self.causes[eid]['lost_s'] += seconds

    def _log(self, kind, item, **extra):
        self.history.append(dict(t=round(self.now, 1), kind=kind, robot=item.robot, item=item.id,
                                 planned_s=item.planned_s, **extra))

    # ---------- routing ----------
    def _path(self, start, goal):
        dist, prev, todo = {start: 0.0}, {}, [(0.0, start)]
        while todo:
            d, node = heapq.heappop(todo)
            if node == goal:
                break
            if d > dist.get(node, math.inf):
                continue
            for nxt, w in sorted(self.graph[node].items()):
                if d + w < dist.get(nxt, math.inf):
                    dist[nxt], prev[nxt] = d + w, node
                    heapq.heappush(todo, (d + w, nxt))
        if goal not in dist:
            raise ValueError(f'no path {start} -> {goal}')
        path = [goal]
        while path[-1] != start:
            path.append(prev[path[-1]])
        return path[::-1]

    def _reaches(self, robot, item):
        """True when every place the item needs is on the robot's connected part of the graph."""
        start = robot.node if robot.node is not None else robot.route[0]
        seen, todo = {start}, [start]
        while todo:
            for nxt in self.graph[todo.pop()]:
                if nxt not in seen:
                    seen.add(nxt)
                    todo.append(nxt)
        goals = [step.target for step in self.scenario.missions[item.mission].steps if step.kind == 'goto'] if item.mission else []
        if item.charger:
            goals.append(self.scenario.chargers[item.charger].waypoint)
        return all(g in seen for g in goals)

    def _route(self, robot, goal, speed):
        if robot.node is not None:
            route = self._path(robot.node, goal)[1:]
        else:  # stopped mid edge: finish the edge first
            head = robot.route[0]
            route = [head] + self._path(head, goal)[1:]
        robot.route, robot.route_speed = route, speed

    def _crowd_factor(self, robot):
        """Speed factor inside crowded zones; returns (factor, cause event id)."""
        tod = time_of_day(self.scenario, self.now)
        worst = (1.0, None)
        for zone in self.scenario.zones.values():
            if zone.floor != robot.floor or not zone.contains(robot.x, robot.y):
                continue
            for n, w in enumerate(zone.crowd):
                inside = (w.start_s <= tod < w.end_s) if w.start_s <= w.end_s else (tod >= w.start_s or tod < w.end_s)
                if inside and 1 - w.level < worst[0]:
                    eid = f'zone:{zone.id}:{n}'
                    if eid not in self.causes:
                        self.causes[eid] = dict(id=eid, kind='crowd', robot=None, zone=zone.id, at_s=None,
                                                lost_s=0.0, affected=[])
                    worst = (1 - w.level, eid)
            for ev, until in self.crowds:
                if ev.zone == zone.id and self.now < until and 1 - ev.level < worst[0]:
                    worst = (1 - ev.level, ev.id)
        return worst

    def _move(self, robot, dt):
        factor, eid = self._crowd_factor(robot)
        if factor < 1:
            self._lose(robot, 'crowd', eid, dt * (1 - factor))
        budget = robot.route_speed * factor * dt
        robot.speed = robot.route_speed * factor
        while budget > 1e-9 and robot.route:
            wp = self.scenario.waypoints[robot.route[0]]
            dx, dy = wp.x - robot.x, wp.y - robot.y
            dist = math.hypot(dx, dy)
            if dist > 1e-9:
                robot.yaw = math.atan2(dy, dx)
            if budget >= dist:
                robot.x, robot.y, robot.node = wp.x, wp.y, wp.id
                robot.route.pop(0)
                budget -= dist
            else:
                robot.x += dx / dist * budget
                robot.y += dy / dist * budget
                robot.node = None
                budget = 0
        return not robot.route

    # ---------- docking ----------
    def _dock(self, robot, cid):
        robot.docked = cid
        self.occupancy[cid] += 1
        robot.yaw = self.scenario.chargers[cid].yaw

    def _undock(self, robot):
        if robot.docked:
            self.occupancy[robot.docked] -= 1
            robot.docked = None

    # ---------- run reporting ----------
    def _report(self, robot, status, fail_code=None):
        item = robot.item
        steps = self.scenario.missions[item.mission].steps
        done = min(item.step, len(steps)) if status != 'COMPLETED' else len(steps)
        snap = dict(run_id=item.run_id, status=status, step=min(item.step, len(steps) - 1),
                    progress=dict(done=done, total=len(steps)), wait_reason=None, fail_code=fail_code)
        if item.last != snap:
            item.last = snap
            self.outbox.append(dict(robot=robot.spec.id, item=item.id, **snap))

    def run_snapshot(self, robot_id):
        item = self.robots[robot_id].item
        if item is None or item.kind != 'mission' or item.last is None:
            return None
        return dict(item.last, progress=dict(item.last['progress']))

    # ---------- events ----------
    def _fire(self, ev):
        self._cause(ev)
        if ev.kind == 'crowd':
            self.crowds.append((ev, ev.at_s + ev.delay_s))
            return
        robot = self.robots[ev.robot]
        if ev.kind == 'fault':
            self._fault(robot, ev)
        else:
            robot.pending.append(ev)

    def _fault(self, robot, ev, cause='fault'):
        robot.state = FAULT
        robot.speed = 0.0
        robot.holds.clear()
        robot.fault = dict(event=ev.id, until=None if ev.recover_s is None else self.now + ev.recover_s)
        robot.carry = (cause, ev.id)
        item = robot.item
        if item is not None:
            if item.kind == 'mission':
                self._report(robot, 'FAILED', ev.fail_code)
                self._reassign(item, cause, ev.id)
            item.status, item.end_s = 'failed', self.now
            self._log('failed', item, cause=cause, event=ev.id)
            robot.item = None

    def _reassign(self, item, cause, eid):
        busy = lambda r: (r.item is not None, sum(1 for i in r.queue if i.planned_s <= self.now))
        candidates = [r for rid, r in self.robots.items() if rid != item.robot and r.state != FAULT
                      and r.soc > r.spec.reserve_soc + 20 and self._reaches(r, item)]
        if not candidates:
            self._log('dropped', item, cause=cause, event=eid)
            return
        target = min(candidates, key=lambda r: (busy(r), -r.soc, self.order.index(r.spec.id)))
        new = Item(f'{item.id}>{target.spec.id}', target.spec.id, item.kind, self.now, mission=item.mission,
                   charger=item.charger, until_soc=item.until_soc, duration_s=item.duration_s,
                   reassigned_from=item.id, inherent=(cause, eid))
        self._enqueue(new)
        self.causes[eid]['affected'].append(new.id)
        self._log('reassigned', item, to=new.id, cause=cause, event=eid)

    # ---------- main loop ----------
    def step(self, dt):
        while dt > 1e-9:
            h = min(dt, DT_MAX)
            self._tick(h)
            dt -= h

    def _tick(self, dt):
        self.now += dt
        while self.events and self.events[0].at_s <= self.now:
            self._fire(self.events.pop(0))
        self.crowds = [(ev, until) for ev, until in self.crowds if self.now < until]
        for rid in self.order:
            robot = self.robots[rid]
            self._robot(robot, dt)
            self._battery(robot, dt)

    def _battery(self, robot, dt):
        if robot.docked and robot.state != FAULT:
            if robot.soc < 100:
                robot.soc = min(100.0, robot.soc + self.scenario.chargers[robot.docked].charge_pct_per_h * dt / 3600)
            return
        robot.soc = max(0.0, robot.soc - robot.spec.drain_pct_per_h[robot.activity] * dt / 3600)
        if robot.soc <= 0 and robot.state != FAULT:
            eid = self._system_cause('battery_empty', robot.spec.id, round(self.now))
            self._fault(robot, SimpleNamespace(id=eid, recover_s=None, fail_code='BATTERY_LOW'),
                        cause='battery_empty')
        elif (robot.soc <= robot.spec.reserve_soc and not robot.low_battery_handled
              and robot.item is not None and robot.item.kind == 'mission'):
            self._battery_low(robot)

    def _battery_low(self, robot):
        """Plan failure: hand the mission over and go charge at home."""
        robot.low_battery_handled = True
        eid = self._system_cause('battery_low', robot.spec.id, round(self.now))
        item = robot.item
        self._report(robot, 'FAILED', 'BATTERY_LOW')
        self._reassign(item, 'battery_low', eid)
        item.status, item.end_s = 'failed', self.now
        self._log('failed', item, cause='battery_low', event=eid)
        robot.item = None
        robot.holds.clear()
        robot.carry = ('battery_low', eid)
        charge = Item(f'{robot.spec.id}/low@{round(self.now)}', robot.spec.id, 'charge', self.now,
                      charger=robot.spec.home_charger, until_soc=100.0, inherent=('battery_low', eid))
        self._enqueue(charge)

    def _robot(self, robot, dt):
        robot.speed = 0.0
        if robot.state == FAULT:
            until = robot.fault['until']
            if until is not None and self.now >= until:
                robot.state, robot.fault = IDLE, None
            else:
                if until is None:  # permanent: hand each due item to another robot
                    while robot.queue and robot.queue[0].planned_s <= self.now:
                        item = robot.queue.pop(0)
                        item.status = 'reassigned'
                        self._reassign(item, *robot.carry)
                return
        due = robot.queue and robot.queue[0].planned_s <= self.now
        if due and robot.item is not None and robot.item.preemptible:
            self._end(robot, 'preempted')
        if robot.item is None and due:
            self._start(robot, robot.queue.pop(0))
            return  # work begins on the next tick, so motion starts at the planned time
        if robot.item is None:
            self._idle_return(robot)
        if robot.item is None:
            robot.state = CHARGING if robot.docked and robot.soc < 100 else IDLE
            return
        if self._hold(robot, dt):
            return
        if robot.item.kind == 'mission':
            self._mission(robot, dt)
        else:
            self._charge(robot, dt)

    def _idle_return(self, robot):
        """Planned behaviour, not a deviation: go home when nothing is due soon."""
        wait = robot.spec.idle_return_min
        if wait is None or robot.docked or robot.state == FAULT:
            return
        if robot.queue and robot.queue[0].planned_s <= self.now + wait * 60:
            return
        item = Item(f'{robot.spec.id}/home@{round(self.now)}', robot.spec.id, 'charge', self.now,
                    charger=robot.spec.home_charger, until_soc=100.0, preemptible=True)
        self.items.append(item)
        self._start(robot, item)

    def _start(self, robot, item):
        late = self.now - item.planned_s
        if late > LATE_S:
            cause, eid = robot.carry or item.inherent or ('plan_overlap', None)
            item.delay_s, item.delay_cause, item.delay_event = late, cause, eid
            if eid in self.causes:
                self.causes[eid]['affected'].append(item.id)
        robot.carry = None
        item.status, item.actual_s = 'active', self.now
        robot.item = item
        if robot.soc > robot.spec.reserve_soc:
            robot.low_battery_handled = False
        self._log('start', item, delay_min=round(item.delay_s / 60, 2), delay_cause=item.delay_cause,
                  delay_event=item.delay_event)
        if item.kind == 'mission':
            item.run_id = self.run_id(item)
            self._undock(robot)
            item.step, item.phase = 0, None
            for ev in [e for e in robot.pending if e.kind == 'duration'
                       and (e.mission is None or e.mission == item.mission)]:
                robot.pending.remove(ev)
                item.extra_s += ev.delay_s
                self._lose(robot, 'duration', ev.id, ev.delay_s)
        else:
            item.phase = 'goto'
            if robot.docked == item.charger:
                item.phase = 'charge'
                item.charge_started_s = self.now
            else:
                self._undock(robot)
                self._route(robot, self.scenario.chargers[item.charger].waypoint, robot.spec.transit_mps)

    def _end(self, robot, status='done'):
        item = robot.item
        item.status, item.end_s = status, self.now
        robot.state = CHARGING if robot.docked and robot.soc < 100 else IDLE
        self._log('end', item, status=status, lost_min={f'{c}:{e}': round(s / 60, 2) for (c, e), s in item.lost.items()})
        robot.item = None
        if not item.preemptible and robot.queue and robot.queue[0].planned_s < self.now - LATE_S:
            candidates = [(item.delay_s, item.delay_cause, item.delay_event)] if item.delay_s else []
            candidates += [(s, c, e) for (c, e), s in item.lost.items()]
            if item.inherent:
                candidates.append((item.end_s - item.actual_s, *item.inherent))
            robot.carry = max(candidates, key=lambda c: c[0])[1:] if candidates else None

    def _hold(self, robot, dt):
        """Apply pending cause events and keep the robot waiting while any is active."""
        for ev in list(robot.pending):
            mission = robot.item.kind == 'mission'
            if ev.kind == 'path_conflict' and robot.state == MOVING:
                robot.holds.append(dict(cause=ev.kind, event=ev.id, until=self.now + ev.delay_s, status='PAUSED'))
            elif ev.kind == 'wait_confirm' and mission:
                robot.holds.append(dict(cause=ev.kind, event=ev.id, until=self.now + ev.delay_s,
                                        status='WAIT_CONFIRM'))
            elif ev.kind == 'duration' and mission and (ev.mission is None or ev.mission == robot.item.mission):
                robot.item.extra_s += ev.delay_s
                self._lose(robot, 'duration', ev.id, ev.delay_s)
            else:
                continue
            robot.pending.remove(ev)
        robot.holds = [h for h in robot.holds if h['until'] > self.now]
        if not robot.holds:
            return False
        hold = robot.holds[0]
        robot.state = WAITING
        self._lose(robot, hold['cause'], hold['event'], dt)
        if robot.item.kind == 'mission':
            self._report(robot, hold['status'])
        return True

    def _mission(self, robot, dt):
        item = robot.item
        steps = self.scenario.missions[item.mission].steps
        if item.step >= len(steps):
            if item.extra_s > 0 and item.phase != 'extra':
                item.phase, item.left_s, item.extra_s = 'extra', item.extra_s, 0.0
            if item.phase == 'extra' and item.left_s > 0:
                robot.state = STEP
                item.left_s -= dt
                self._report(robot, 'PERFORMING')
                return
            self._report(robot, 'COMPLETED')
            self._end(robot)
            return
        step = steps[item.step]
        if item.phase is None:
            if step.kind == 'goto':
                self._route(robot, step.target, robot.spec.patrol_mps)
                item.phase = 'goto'
            else:
                item.phase, item.left_s = 'timed', step.duration_s + item.extra_s
                item.extra_s = 0.0
        if item.phase == 'goto':
            robot.state = MOVING
            self._report(robot, 'MOVING')
            arrived = self._move(robot, dt)
        else:
            robot.state = STEP
            self._report(robot, 'PERFORMING')
            item.left_s -= dt
            arrived = item.left_s <= 1e-9
        if arrived:
            item.step += 1
            item.phase = None

    def _charge(self, robot, dt):
        item = robot.item
        charger = self.scenario.chargers[item.charger]
        if item.phase == 'goto':
            robot.state = MOVING
            if self._move(robot, dt):
                item.phase = 'dock'
            return
        if item.phase == 'dock':
            if self.occupancy[item.charger] >= charger.slots:
                robot.state = WAITING
                self._lose(robot, 'charger_busy', self._system_cause('charger_busy', robot.spec.id, item.id), dt)
                return
            self._dock(robot, item.charger)
            item.phase, item.charge_started_s = 'charge', self.now
        robot.state = CHARGING
        full = item.until_soc is not None and robot.soc >= item.until_soc
        timed = item.duration_s is not None and self.now - item.charge_started_s >= item.duration_s
        if full or timed or robot.soc >= 100:
            self._end(robot)

    # ---------- views ----------
    def snapshot(self, robot_id):
        r = self.robots[robot_id]
        return dict(robot=robot_id, x=r.x, y=r.y, yaw=r.yaw, floor=r.floor,
                    floor_id=self.scenario.floors[r.floor].floor_id,
                    map_version_id=self.scenario.floors[r.floor].map_version_id,
                    confidence=self.scenario.pose_confidence, speed=r.speed, soc=r.soc,
                    voltage=voltage(r.soc), state=r.state, posture=r.posture, activity=r.activity,
                    docked=r.docked, run=self.run_snapshot(robot_id))

    def drain_run_updates(self):
        out, self.outbox = self.outbox, []
        return out

    def schedule_report(self):
        rows = []
        for item in sorted(self.items, key=lambda i: (i.planned_s, i.robot)):
            rows.append(dict(item=item.id, robot=item.robot, kind=item.kind, status=item.status,
                             planned_s=item.planned_s, actual_s=item.actual_s, end_s=item.end_s,
                             delay_min=round(item.delay_s / 60, 2), delay_cause=item.delay_cause,
                             delay_event=item.delay_event, reassigned_from=item.reassigned_from,
                             lost_min={f'{c}:{e}': round(s / 60, 2) for (c, e), s in item.lost.items()}))
        causes = [dict(c, lost_min=round(c['lost_s'] / 60, 2)) for c in self.causes.values()]
        return dict(items=rows, causes=causes, history=list(self.history))

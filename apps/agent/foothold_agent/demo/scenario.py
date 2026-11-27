"""Demo scenario file (contract v0 sections D, F, G, H) to validated dataclasses.

The loader never guesses: every problem is collected and raised together as
ScenarioError. Times are "HH:MM" offsets from the start date's midnight
(HH may be 24..47 for the next day) and must fall inside the scenario window.
Contract G rules are enforced here: no jitter, no speed spread, no default
charger queue. Deviations come only from listed cause events.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import math
import re
from uuid import UUID

# Measured from real Go2 X traces (see measured.py for files and method).
from .measured import DRAIN_PCT_PER_H

EVENT_KINDS = ('crowd', 'path_conflict', 'wait_confirm', 'duration', 'fault')
CROWD_KINDS = ('person', 'forklift')
# Contract G withdrew these keys; reject them so an old file cannot sneak jitter in.
WITHDRAWN = {'jitter_min': 'robots[].jitter_min', 'spread': 'speed_mps.spread', 'video': 'zones[].video'}
FAIL_CODES = ('NAV_GOAL_REJECTED', 'NAV_TIMEOUT', 'LOCALIZATION_LOST', 'BATTERY_LOW', 'DEVICE_MISSING',
              'OPERATOR_ABORT', 'PAUSE_TIMEOUT', 'FLOOR_TRANSITION_FAILED', 'NAV_UNAVAILABLE',
              'MAP_VERSION_MISMATCH', 'FLOOR_TRANSITION_UNSUPPORTED', 'PLAN_UNAVAILABLE', 'RECORDING_REJECTED')
_HHMM = re.compile(r'^(\d{1,2}):([0-5]\d)$')


class ScenarioError(ValueError):
    def __init__(self, problems):
        self.problems = list(problems)
        super().__init__('scenario invalid:\n- ' + '\n- '.join(self.problems))


@dataclass(frozen=True)
class Floor:
    id: str
    floor_id: str
    map_version_id: str


@dataclass(frozen=True)
class Waypoint:
    id: str
    floor: str
    x: float
    y: float


@dataclass(frozen=True)
class Charger:
    id: str
    waypoint: str
    yaw: float
    slots: int
    charge_pct_per_h: float


@dataclass(frozen=True)
class CrowdWindow:
    start_s: float  # time of day, seconds
    end_s: float
    level: float
    kinds: tuple


@dataclass(frozen=True)
class Zone:
    id: str
    floor: str
    polygon: tuple
    crowd: tuple = ()

    def contains(self, x, y):
        inside = False
        pts = self.polygon
        for i in range(len(pts)):
            (x1, y1), (x2, y2) = pts[i], pts[i - 1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                inside = not inside
        return inside


@dataclass(frozen=True)
class Step:
    kind: str  # goto | action | wait
    target: str | None = None
    name: str | None = None
    duration_s: float = 0.0


@dataclass(frozen=True)
class Mission:
    id: str
    steps: tuple


@dataclass(frozen=True)
class ScheduleEntry:
    at_s: float
    mission: str


@dataclass(frozen=True)
class Robot:
    id: str
    model: str
    start: str
    home_charger: str
    soc: float
    reserve_soc: float
    drain_pct_per_h: dict
    patrol_mps: float
    transit_mps: float
    schedule: tuple
    idle_return_min: float | None = 10.0  # go home when the next item is further away


@dataclass(frozen=True)
class ChargeSlot:
    robot: str
    charger: str
    at_s: float
    until_soc: float | None
    duration_s: float | None


@dataclass(frozen=True)
class Event:
    id: str
    kind: str
    at_s: float | None
    robot: str | None = None
    zone: str | None = None
    mission: str | None = None
    delay_s: float = 0.0
    level: float = 1.0
    kinds: tuple = ()
    recover_s: float | None = None
    fail_code: str = 'NAV_UNAVAILABLE'
    p_per_hour: float | None = None


@dataclass(frozen=True)
class Scenario:
    name: str
    start: datetime
    start_tod_s: float
    duration_s: float
    seed: int | None
    pose_confidence: float
    floors: dict
    waypoints: dict
    edges: tuple
    chargers: dict
    zones: dict
    robots: tuple
    missions: dict
    charge_rotation: tuple
    events: tuple = field(default=())


def load(path, floors=None):
    import yaml  # optional dependency: foothold-agent[demo]
    with open(path, encoding='utf-8') as fh:
        doc = yaml.safe_load(fh)
    return parse(bind_floors(doc, floors) if floors else doc)


def bind_floors(doc, floors):
    """Put one server's floor/map ids into the scenario's site.floors.

    The scenario describes the site; which server ids it lands on belongs to
    the registration config (config.floors), so one scenario file can run
    against a local stack and a real server. Ids are still checked by parse().
    """
    entries = doc.get('site', {}).get('floors') if isinstance(doc, dict) and isinstance(doc.get('site'), dict) else None
    entries = entries if isinstance(entries, list) else []
    known = {f.get('id') for f in entries if isinstance(f, dict)}
    unknown = sorted(set(floors) - known)
    if unknown:
        raise ScenarioError([f'floors: {unknown} not in site.floors'])
    for entry in entries:
        if isinstance(entry, dict) and entry.get('id') in floors:
            entry.update(floor_id=floors[entry['id']]['floor_id'],
                         map_version_id=floors[entry['id']]['map_version_id'])
    return doc


def parse(doc):
    p = _Parser()
    scenario = p.scenario(doc)
    if p.problems:
        raise ScenarioError(p.problems)
    return scenario


class _Parser:
    def __init__(self):
        self.problems = []

    def bad(self, where, text):
        self.problems.append(f'{where}: {text}')

    def num(self, obj, key, where, *, low=-math.inf, high=math.inf, default=None, required=True):
        value = obj.get(key, default) if isinstance(obj, dict) else default
        if value is None and not required:
            return None
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            self.bad(where, f'{key} must be a number in [{low}, {high}] (got {value!r})')
            return low if math.isfinite(low) else 0.0
        return float(value)

    def text(self, obj, key, where, *, required=True):
        value = obj.get(key) if isinstance(obj, dict) else None
        if value is None and not required:
            return None
        if not isinstance(value, str) or not value.strip():
            self.bad(where, f'{key} must be a nonempty string')
            return ''
        return value

    def uuid(self, obj, key, where):
        value = self.text(obj, key, where)
        try:
            return str(UUID(value))
        except (ValueError, TypeError, AttributeError):
            if value:
                self.bad(where, f'{key} must be a UUID (server id)')
            return value

    def items(self, obj, key, where, *, required=True):
        value = obj.get(key) if isinstance(obj, dict) else None
        if value is None and not required:
            return []
        if not isinstance(value, list):
            self.bad(where, f'{key} must be a list')
            return []
        return value

    def unique(self, items, where):
        seen = {}
        for item in items:
            if item.id in seen:
                self.bad(where, f'duplicate id {item.id!r}')
            seen[item.id] = item
        return seen

    def clock(self, value, where):
        """Seconds from the start date's midnight to an "HH:MM" mark."""
        match = _HHMM.match(value) if isinstance(value, str) else None
        if not match or int(match.group(1)) > 47:
            self.bad(where, f'time must be "HH:MM" with HH 0..47 (got {value!r})')
            return None
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60

    def at(self, value, where):
        mark = self.clock(value, where)
        if mark is None:
            return 0.0
        offset = mark - self.start_tod
        if not 0 <= offset <= self.duration:
            self.bad(where, f'{value} is outside the scenario window')
        return float(offset)

    def withdrawn(self, obj, where):
        if isinstance(obj, dict):
            for key, name in WITHDRAWN.items():
                if key in obj:
                    self.bad(where, f'{name} was withdrawn by contract G (no jitter, spread or video)')

    def scenario(self, doc):
        if not isinstance(doc, dict):
            self.bad('file', 'top level must be a mapping')
            doc = {}
        if doc.get('version') != 0:
            self.bad('version', 'must be 0')
        name = self.text(doc, 'name', 'name')
        start = doc.get('start')
        try:
            start = start if isinstance(start, datetime) else datetime.fromisoformat(start)
            if start.tzinfo is None:
                raise ValueError
        except (TypeError, ValueError):
            self.bad('start', 'must be an ISO datetime with timezone')
            start = datetime.fromisoformat('2026-01-01T00:00:00+00:00')
        midnight = start.replace(hour=0, minute=0, second=0, microsecond=0)
        self.start_tod = (start - midnight).total_seconds()
        self.duration = self.num(doc, 'duration_h', 'duration_h', low=0.1, high=72, default=24) * 3600
        seed = doc.get('seed')
        if seed is not None and type(seed) is not int:
            self.bad('seed', 'must be an integer')
        confidence = self.num(doc, 'pose_confidence', 'pose_confidence', low=0, high=1, default=0.95)
        site = doc.get('site') if isinstance(doc.get('site'), dict) else {}
        if not site:
            self.bad('site', 'required mapping')
        floors = self.unique([Floor(self.text(f, 'id', f'site.floors[{i}]'),
                                    self.uuid(f, 'floor_id', f'site.floors[{i}]'),
                                    self.uuid(f, 'map_version_id', f'site.floors[{i}]'))
                              for i, f in enumerate(self.items(site, 'floors', 'site'))], 'site.floors')
        if not floors:
            self.bad('site.floors', 'at least one floor')
        waypoints = {}
        for i, w in enumerate(self.items(site, 'waypoints', 'site')):
            where = f'site.waypoints[{i}]'
            wp = Waypoint(self.text(w, 'id', where), self.text(w, 'floor', where),
                          self.num(w, 'x', where), self.num(w, 'y', where))
            if wp.floor not in floors:
                self.bad(where, f'unknown floor {wp.floor!r}')
            if wp.id in waypoints:
                self.bad('site.waypoints', f'duplicate id {wp.id!r}')
            waypoints[wp.id] = wp
        edges = []
        for i, e in enumerate(self.items(site, 'paths', 'site')):
            where = f'site.paths[{i}]'
            if not (isinstance(e, list) and len(e) == 2 and all(n in waypoints for n in e)):
                self.bad(where, 'must be [waypoint, waypoint] of known waypoints')
                continue
            a, b = (waypoints[n] for n in e)
            if a.floor != b.floor:
                self.bad(where, 'cross-floor paths are not supported in v0 (no floor transit)')
                continue
            edges.append((e[0], e[1]))
        chargers = {}
        for i, c in enumerate(self.items(site, 'chargers', 'site')):
            where = f'site.chargers[{i}]'
            self.withdrawn(c, where)
            ch = Charger(self.text(c, 'id', where), self.text(c, 'waypoint', where),
                         self.num(c, 'yaw', where, default=0.0, low=-math.pi, high=math.pi),
                         int(self.num(c, 'slots', where, low=1, high=16, default=1)),
                         # No default: charging cannot be measured from the traces
                         # (Go2 X does not charge while powered on).
                         self.num(c, 'charge_pct_per_h', where, low=1, high=500))
            if ch.waypoint not in waypoints:
                self.bad(where, f'unknown waypoint {ch.waypoint!r}')
            if ch.id in chargers:
                self.bad('site.chargers', f'duplicate id {ch.id!r}')
            chargers[ch.id] = ch
        zones = {}
        for i, z in enumerate(self.items(site, 'zones', 'site', required=False)):
            where = f'site.zones[{i}]'
            self.withdrawn(z, where)
            zones_id = self.text(z, 'id', where)
            polygon = z.get('polygon') if isinstance(z, dict) else None
            rect = z.get('rect') if isinstance(z, dict) else None
            if rect is not None:
                if isinstance(rect, list) and len(rect) == 4 and all(type(v) in (int, float) for v in rect):
                    x0, y0, x1, y1 = rect
                    polygon = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
                else:
                    self.bad(where, 'rect must be [x0, y0, x1, y1]')
                    polygon = None
            if not (isinstance(polygon, list) and len(polygon) >= 3 and all(
                    isinstance(p, list) and len(p) == 2 and all(type(v) in (int, float) for v in p)
                    for p in polygon)):
                self.bad(where, 'needs rect or polygon (>= 3 points)')
                polygon = [[0, 0], [0, 0], [0, 0]]
            floor = self.text(z, 'floor', where)
            if floor not in floors:
                self.bad(where, f'unknown floor {floor!r}')
            windows = []
            for j, c in enumerate(self.items(z, 'crowd', where, required=False)):
                cw = f'{where}.crowd[{j}]'
                hours = c.get('hours') if isinstance(c, dict) else None
                parts = hours.split('-') if isinstance(hours, str) else []
                marks = [self.clock(p.strip(), cw) for p in parts] if len(parts) == 2 else [None]
                if None in marks:
                    if len(parts) != 2:
                        self.bad(cw, 'hours must be "HH:MM-HH:MM"')
                    continue
                windows.append(CrowdWindow(marks[0] % 86400, marks[1] % 86400,
                                           self.num(c, 'level', cw, low=0, high=1),
                                           self.kinds(c, cw)))
            zones[zones_id] = Zone(zones_id, floor, tuple(map(tuple, polygon)), tuple(windows))
        missions = {}
        for i, m in enumerate(self.items(doc, 'missions', 'top')):
            where = f'missions[{i}]'
            mid = self.text(m, 'id', where)
            steps = []
            for j, s in enumerate(self.items(m, 'steps', where)):
                sw = f'{where}.steps[{j}]'
                if not isinstance(s, dict) or len({'goto', 'action', 'wait'} & set(s)) != 1:
                    self.bad(sw, 'exactly one of goto / action / wait')
                elif 'goto' in s:
                    if s['goto'] not in waypoints:
                        self.bad(sw, f'unknown waypoint {s["goto"]!r}')
                    steps.append(Step('goto', target=s['goto']))
                elif 'action' in s:
                    steps.append(Step('action', name=self.text(s, 'action', sw),
                                      duration_s=self.num(s, 'duration_s', sw, low=0, high=86400)))
                else:
                    steps.append(Step('wait', duration_s=self.num(s, 'wait', sw, low=0, high=86400)))
            if not steps:
                self.bad(where, 'needs at least one step')
            if mid in missions:
                self.bad('missions', f'duplicate id {mid!r}')
            missions[mid] = Mission(mid, tuple(steps))
        robots = []
        for i, r in enumerate(self.items(doc, 'robots', 'top')):
            where = f'robots[{i}]'
            self.withdrawn(r, where)
            speed = r.get('speed_mps') if isinstance(r, dict) else None
            self.withdrawn(speed, f'{where}.speed_mps')
            battery = r.get('battery') if isinstance(r, dict) and isinstance(r.get('battery'), dict) else {}
            drain = dict(DRAIN_PCT_PER_H)
            override = battery.get('drain_pct_per_h')
            if override is not None:
                if not isinstance(override, dict) or set(override) - set(drain):
                    self.bad(where, f'battery.drain_pct_per_h keys must be among {sorted(drain)}')
                else:
                    drain.update({k: self.num(override, k, where, low=0, high=500) for k in override})
            schedule = []
            for j, item in enumerate(self.items(r, 'schedule', where, required=False)):
                sw = f'{where}.schedule[{j}]'
                mission = self.text(item, 'mission', sw)
                if mission not in missions:
                    self.bad(sw, f'unknown mission {mission!r}')
                schedule.append(ScheduleEntry(self.at(item.get('at') if isinstance(item, dict) else None, sw),
                                              mission))
            robot = Robot(self.text(r, 'id', where), self.text(r, 'model', where),
                          self.text(r, 'start', where), self.text(r, 'home_charger', where),
                          self.num(battery, 'soc', where, low=0, high=100),
                          self.num(battery, 'reserve', where, low=0, high=50, default=10),
                          drain,
                          self.num(speed, 'patrol', where, low=0.05, high=3.0),
                          self.num(speed, 'transit', where, low=0.05, high=3.0),
                          tuple(sorted(schedule, key=lambda e: e.at_s)),
                          self.num(r, 'idle_return_min', where, low=0, high=1440, default=10.0, required=False)
                          if not (isinstance(r, dict) and 'idle_return_min' in r and r['idle_return_min'] is None)
                          else None)
            if robot.model != 'go2':
                self.bad(where, 'model must be "go2" (only Go2 traces exist)')
            if robot.start not in waypoints:
                self.bad(where, f'unknown start waypoint {robot.start!r}')
            if robot.home_charger not in chargers:
                self.bad(where, f'unknown home_charger {robot.home_charger!r}')
            robots.append(robot)
        robot_ids = self.unique(robots, 'robots')
        if not robots:
            self.bad('robots', 'at least one robot')
        rotation = []
        for i, c in enumerate(self.items(doc, 'charge_rotation', 'top', required=False)):
            where = f'charge_rotation[{i}]'
            slot = ChargeSlot(self.text(c, 'robot', where), self.text(c, 'charger', where),
                              self.at(c.get('at') if isinstance(c, dict) else None, where),
                              self.num(c, 'until_soc', where, low=1, high=100, required=False),
                              None)
            minutes = self.num(c, 'duration_min', where, low=1, high=24 * 60, required=False)
            if (slot.until_soc is None) == (minutes is None):
                self.bad(where, 'exactly one of until_soc / duration_min')
            slot = ChargeSlot(slot.robot, slot.charger, slot.at_s, slot.until_soc,
                              minutes * 60 if minutes is not None else None)
            if slot.robot not in robot_ids:
                self.bad(where, f'unknown robot {slot.robot!r}')
            if slot.charger not in chargers:
                self.bad(where, f'unknown charger {slot.charger!r}')
            rotation.append(slot)
        events = []
        for i, e in enumerate(self.items(doc, 'events', 'top', required=False)):
            where = f'events[{i}]'
            kind = e.get('kind') if isinstance(e, dict) else None
            if kind not in EVENT_KINDS:
                self.bad(where, f'kind must be one of {EVENT_KINDS} (charger_busy only arises from the plan)')
                continue
            has_at, has_p = 'at' in e, 'p_per_hour' in e
            if has_at == has_p:
                self.bad(where, 'exactly one of at / p_per_hour')
            if has_p and seed is None:
                self.bad(where, 'p_per_hour needs a top-level seed (deterministic runs only)')
            p = self.num(e, 'p_per_hour', where, low=0, high=60, required=False) if has_p else None
            at_s = self.at(e['at'], where) if has_at else None
            event = Event(id=str(e.get('id') or f'ev{i}'), kind=kind, at_s=at_s, p_per_hour=p,
                          robot=e.get('robot'), zone=e.get('zone'), mission=e.get('mission'))
            fields = {}
            if kind == 'crowd':
                if event.zone not in zones:
                    self.bad(where, f'unknown zone {event.zone!r}')
                fields = dict(delay_s=self.num(e, 'duration_min', where, low=0.1, high=1440) * 60,
                              level=self.num(e, 'level', where, low=0, high=1, default=1.0),
                              kinds=self.kinds(e, where))
            else:
                if event.robot not in robot_ids:
                    self.bad(where, f'unknown robot {event.robot!r}')
                if kind in ('path_conflict', 'wait_confirm'):
                    fields = dict(delay_s=self.num(e, 'delay_min', where, low=0.1, high=1440) * 60)
                elif kind == 'duration':
                    if event.mission is not None and event.mission not in missions:
                        self.bad(where, f'unknown mission {event.mission!r}')
                    fields = dict(delay_s=self.num(e, 'extra_min', where, low=0.1, high=1440) * 60)
                elif kind == 'fault':
                    recover = self.num(e, 'recover_min', where, low=0.1, high=1440, required=False)
                    code = e.get('fail_code', 'NAV_UNAVAILABLE')
                    if code not in FAIL_CODES:
                        self.bad(where, f'fail_code must be a RunFailCode, got {code!r}')
                    fields = dict(recover_s=recover * 60 if recover is not None else None, fail_code=code)
            events.append(Event(**{**event.__dict__, **fields}))
        self.unique(events, 'events')
        self.connectivity(waypoints, edges, robots, missions, chargers)
        return Scenario(name=name, start=start, start_tod_s=self.start_tod, duration_s=self.duration,
                        seed=seed, pose_confidence=confidence, floors=floors, waypoints=waypoints,
                        edges=tuple(edges), chargers=chargers, zones=zones, robots=tuple(robots),
                        missions=missions, charge_rotation=tuple(sorted(rotation, key=lambda c: c.at_s)),
                        events=tuple(events))

    def kinds(self, obj, where):
        kinds = obj.get('kinds', []) if isinstance(obj, dict) else []
        if not isinstance(kinds, list) or any(k not in CROWD_KINDS for k in kinds):
            self.bad(where, f'kinds must be a list from {CROWD_KINDS}')
            return ()
        return tuple(kinds)

    def connectivity(self, waypoints, edges, robots, missions, chargers):
        """Every place a robot is asked to reach must be reachable from its start."""
        graph = {w: set() for w in waypoints}
        for a, b in edges:
            graph[a].add(b)
            graph[b].add(a)

        def reach(origin):
            seen, todo = {origin}, [origin]
            while todo:
                for n in graph.get(todo.pop(), ()):
                    if n not in seen:
                        seen.add(n)
                        todo.append(n)
            return seen

        for robot in robots:
            if robot.start not in waypoints:
                continue
            seen = reach(robot.start)
            targets = {s.target for e in robot.schedule if e.mission in missions
                       for s in missions[e.mission].steps if s.kind == 'goto'}
            if robot.home_charger in chargers:
                targets.add(chargers[robot.home_charger].waypoint)
            for t in sorted(targets - seen):
                self.bad(f'robot {robot.id}', f'waypoint {t!r} not reachable from start {robot.start!r}')


def time_of_day(scenario, sim_s):
    return (scenario.start_tod_s + sim_s) % 86400


def wall_time(scenario, sim_s):
    return scenario.start + timedelta(seconds=sim_s)

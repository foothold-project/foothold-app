"""Demo simulation: constant speed, measured battery, on-time plan, cause-only delays."""
import math

import pytest

from foothold_agent.demo import scenario as sc
from foothold_agent.demo.measured import DRAIN_PCT_PER_H
from foothold_agent.demo.sim import Simulation, FAULT, CHARGING

F1 = '00000000-0000-4000-8000-0000000000f1'
V1 = '00000000-0000-4000-8000-0000000000a1'


def base(**over):
    """A straight 0-10-20 m corridor with two docks; start 00:00, 6 h."""
    doc = {
        'version': 0, 'name': 'line', 'start': '2026-11-26T00:00:00+09:00', 'duration_h': 6, 'seed': 1,
        'site': {
            'floors': [{'id': 'f1', 'floor_id': F1, 'map_version_id': V1}],
            'waypoints': [{'id': 'd1', 'floor': 'f1', 'x': 0, 'y': 0}, {'id': 'd2', 'floor': 'f1', 'x': 0, 'y': 2},
                          {'id': 'a', 'floor': 'f1', 'x': 10, 'y': 0}, {'id': 'b', 'floor': 'f1', 'x': 20, 'y': 0}],
            'paths': [['d1', 'a'], ['d2', 'a'], ['a', 'b']],
            'chargers': [{'id': 'c1', 'waypoint': 'd1', 'slots': 1, 'charge_pct_per_h': 50},
                         {'id': 'c2', 'waypoint': 'd2', 'slots': 1, 'charge_pct_per_h': 50}],
            'zones': [{'id': 'mid', 'floor': 'f1', 'rect': [12, -1, 18, 1]}],
        },
        'robots': [robot('r1', 'd1', 'c1'), robot('r2', 'd2', 'c2')],
        'missions': [{'id': 'go_b', 'steps': [{'goto': 'b'}, {'action': 'photo', 'duration_s': 60}, {'goto': 'd1'}]},
                     {'id': 'go_a', 'steps': [{'goto': 'a'}, {'wait': 30}]}],
        'events': [],
    }
    for key, value in over.items():
        doc[key] = value
    return doc


def robot(rid, start, home, schedule=(), soc=80, **extra):
    return {'id': rid, 'model': 'go2', 'start': start, 'home_charger': home, 'battery': {'soc': soc},
            'speed_mps': {'patrol': 1.0, 'transit': 1.0}, 'schedule': list(schedule),
            'idle_return_min': None, **extra}


def run(doc, seconds=None, dt=0.5):
    """dt=None: one big step (split internally); otherwise many small caller steps."""
    s = sc.parse(doc)
    sim = Simulation(s)
    total = s.duration_s if seconds is None else seconds
    if dt is None:
        sim.step(total)
    else:
        for _ in range(int(round(total / dt))):
            sim.step(dt)
    return sim


def items(sim):
    return {i['item']: i for i in sim.schedule_report()['items']}


def test_route_follows_graph_at_constant_speed_and_reports_pose():
    doc = base()
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_b'}]
    sim = run(doc, 3600 + 5)
    snap = sim.snapshot('r1')
    assert snap['x'] == pytest.approx(5) and snap['y'] == pytest.approx(0)  # 5 s at 1 m/s from d1
    assert snap['speed'] == 1.0 and snap['activity'] == 'walk' and snap['yaw'] == pytest.approx(0)
    assert snap['floor_id'] == F1 and snap['map_version_id'] == V1
    sim.step(16)  # 20 m reached at 3620 s, photo running
    assert sim.snapshot('r1')['x'] == pytest.approx(20) and sim.robots['r1'].state == 'STEP'
    sim.step(59 + 10)  # photo done at 3680; on the way back, 10 m covered
    snap = sim.snapshot('r1')
    assert snap['x'] == pytest.approx(10) and snap['yaw'] == pytest.approx(math.pi)
    sim.step(11)
    row = items(sim)['r1/m0:go_b']
    assert row['status'] == 'done' and row['end_s'] == pytest.approx(3600 + 20 + 60 + 20, abs=1)
    # Ending on a dock waypoint is not docking: only a charge item (or idle return) docks.
    assert sim.robots['r1'].docked is None and sim.robots['r1'].state == 'IDLE'


def test_battery_uses_measured_rates_and_charges_on_dock():
    doc = base()
    doc['robots'] = [robot('r1', 'a', 'c1', soc=80)]  # not on a dock: standing
    sim = run(doc, 3600, dt=None)
    assert sim.robots['r1'].soc == pytest.approx(80 - DRAIN_PCT_PER_H['stand'], abs=1e-6)
    doc = base()
    doc['robots'] = [robot('r1', 'd1', 'c1', soc=40)]  # docked: charges at the charger's rate
    sim = run(doc, 3600, dt=None)
    assert sim.robots['r1'].soc == pytest.approx(90) and sim.robots['r1'].posture == 'LYING'
    doc = base()
    doc['missions'] = [{'id': 'shuttle', 'steps': [{'goto': 'b'}, {'goto': 'a'}] * 90}]
    doc['robots'] = [robot('r1', 'a', 'c1', soc=90, schedule=[{'at': '00:00', 'mission': 'shuttle'}])]
    sim = run(doc, 1800, dt=None)  # 180 legs of 10 m at 1 m/s = 1800 s walking
    assert sim.robots['r1'].soc == pytest.approx(90 - DRAIN_PCT_PER_H['walk'] / 2, abs=0.05)


def test_plan_without_events_runs_on_time_and_is_repeatable():
    doc = base()
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_b'}, {'at': '02:00', 'mission': 'go_a'}]
    doc['robots'][1]['schedule'] = [{'at': '01:30', 'mission': 'go_a'}]
    doc['charge_rotation'] = [{'robot': 'r2', 'charger': 'c2', 'at': '03:00', 'duration_min': 30}]
    for r in doc['robots']:
        r['idle_return_min'] = 5
    a, b = run(doc), run(doc)
    assert a.schedule_report() == b.schedule_report()
    rows = [r for r in items(a).values() if '/home@' not in r['item']]
    assert len(rows) == 4
    assert all(r['delay_min'] == 0 and r['delay_cause'] is None for r in rows)
    assert all(r['actual_s'] == pytest.approx(r['planned_s'], abs=0.5) for r in rows)
    assert a.schedule_report()['causes'] == []


def test_path_conflict_delay_propagates_to_the_next_item_and_is_recorded():
    doc = base()
    # go_b takes 100 s; the next item is planned 60 s after the first ends nominally.
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_b'}, {'at': '01:03', 'mission': 'go_a'}]
    doc['events'] = [{'id': 'pc', 'kind': 'path_conflict', 'robot': 'r1', 'at': '01:00', 'delay_min': 2}]
    sim = run(doc, 2 * 3600)
    rows = items(sim)
    first, second = rows['r1/m0:go_b'], rows['r1/m1:go_a']
    assert first['lost_min'] == {'path_conflict:pc': 2.0}
    assert first['end_s'] == pytest.approx(3600 + 100 + 120, abs=1)
    assert second['delay_cause'] == 'path_conflict' and second['delay_event'] == 'pc'
    assert second['delay_min'] == pytest.approx((220 - 180) / 60, abs=0.05)
    cause = next(c for c in sim.schedule_report()['causes'] if c['id'] == 'pc')
    assert cause['affected'] == ['r1/m1:go_a'] and cause['lost_min'] == 2.0
    statuses = [u['status'] for u in sim.drain_run_updates()]
    assert 'PAUSED' in statuses and statuses.count('COMPLETED') == 2


def test_wait_confirm_reports_wait_status_and_duration_event_extends_mission():
    doc = base()
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_b'}]
    doc['events'] = [{'id': 'wc', 'kind': 'wait_confirm', 'robot': 'r1', 'at': '01:00', 'delay_min': 1},
                     {'id': 'dur', 'kind': 'duration', 'robot': 'r1', 'mission': 'go_b', 'at': '00:30',
                      'extra_min': 3}]
    sim = run(doc, 2 * 3600)
    row = items(sim)['r1/m0:go_b']
    assert row['lost_min'] == {'wait_confirm:wc': 1.0, 'duration:dur': 3.0}
    assert row['end_s'] == pytest.approx(3600 + 100 + 60 + 180, abs=1)
    assert 'WAIT_CONFIRM' in [u['status'] for u in sim.drain_run_updates()]


def test_crowd_zone_hours_slow_the_robot_inside_the_zone_only():
    doc = base()
    doc['site']['zones'][0]['crowd'] = [{'hours': '00:30-02:00', 'level': 0.5, 'kinds': ['person']}]
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_b'}]
    sim = run(doc, 2 * 3600)
    row = items(sim)['r1/m0:go_b']
    # 6 m zone crossed twice at half speed: 12 s extra, 6 s of lost time each way.
    assert row['end_s'] == pytest.approx(3600 + 100 + 12, abs=1)
    assert row['lost_min'] == {'crowd:zone:mid:0': pytest.approx(0.2, abs=0.02)}


def test_crowd_event_with_level_one_stops_the_robot_until_it_clears():
    doc = base()
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_b'}]
    doc['events'] = [{'id': 'fork', 'kind': 'crowd', 'zone': 'mid', 'at': '01:00', 'duration_min': 2,
                      'level': 1.0, 'kinds': ['forklift']}]
    sim = run(doc, 3600 + 60)
    assert sim.snapshot('r1')['x'] == pytest.approx(12, abs=0.6) and sim.snapshot('r1')['speed'] == 0
    sim.step(3600)
    row = items(sim)['r1/m0:go_b']
    assert row['end_s'] == pytest.approx(3600 + 100 + 120 - 12, abs=1.5)


def test_fault_fails_run_reassigns_mission_and_delays_own_later_items():
    doc = base()
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_b'}, {'at': '01:10', 'mission': 'go_a'}]
    doc['events'] = [{'id': 'f', 'kind': 'fault', 'robot': 'r1', 'at': '01:01', 'recover_min': 20,
                      'fail_code': 'NAV_UNAVAILABLE'}]
    sim = run(doc, 60 * 61 + 10)
    assert sim.robots['r1'].state == FAULT and sim.snapshot('r1')['posture'] == 'LYING'
    sim.step(3600)
    rows = items(sim)
    assert rows['r1/m0:go_b']['status'] == 'failed'
    moved = rows['r1/m0:go_b>r2']
    assert moved['status'] == 'done' and moved['reassigned_from'] == 'r1/m0:go_b'
    later = rows['r1/m1:go_a']
    assert later['delay_cause'] == 'fault' and later['delay_event'] == 'f'
    assert later['actual_s'] == pytest.approx(3660 + 1200, abs=2)
    cause = next(c for c in sim.schedule_report()['causes'] if c['id'] == 'f')
    assert cause['affected'] == ['r1/m0:go_b>r2', 'r1/m1:go_a']
    updates = sim.drain_run_updates()
    failed = [u for u in updates if u['status'] == 'FAILED']
    assert failed and failed[0]['fail_code'] == 'NAV_UNAVAILABLE' and failed[0]['robot'] == 'r1'
    assert any(u['robot'] == 'r2' and u['status'] == 'COMPLETED' for u in updates)
    assert failed[0]['run_id'] != next(u for u in updates if u['robot'] == 'r2')['run_id']


def test_permanent_fault_hands_every_due_item_to_another_robot():
    doc = base()
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_a'}, {'at': '02:00', 'mission': 'go_a'}]
    doc['events'] = [{'id': 'dead', 'kind': 'fault', 'robot': 'r1', 'at': '00:30'}]
    rows = items(run(doc))
    assert {r['item'] for r in rows.values() if r['robot'] == 'r2'} == {'r1/m0:go_a>r2', 'r1/m1:go_a>r2'}
    assert rows['r1/m0:go_a']['status'] == 'reassigned'


def test_charger_busy_only_when_the_plan_overbooks_a_charger():
    doc = base()
    doc['robots'][1]['schedule'] = []
    doc['charge_rotation'] = [{'robot': 'r2', 'charger': 'c1', 'at': '01:00', 'duration_min': 10}]
    sim = run(doc, 3600 + 120)  # r1 sits on c1 (1 slot): r2 waits at the dock
    assert sim.robots['r2'].state == 'WAITING'
    report = sim.schedule_report()
    assert [c['kind'] for c in report['causes']] == ['charger_busy']


def test_charge_rotation_moves_to_charger_and_stops_at_target_soc():
    doc = base()
    doc['robots'] = [robot('r1', 'a', 'c1', soc=50)]
    doc['charge_rotation'] = [{'robot': 'r1', 'charger': 'c1', 'at': '01:00', 'until_soc': 60}]
    sim = run(doc, 3600 + 11)
    assert sim.robots['r1'].docked == 'c1' and sim.robots['r1'].state == CHARGING
    sim.step(3600)
    row = items(sim)['r1/c0:c1']
    assert row['status'] == 'done'
    soc_at_dock = 50 - DRAIN_PCT_PER_H['stand'] - DRAIN_PCT_PER_H['walk'] * 10 / 3600
    assert row['end_s'] == pytest.approx(3610 + (60 - soc_at_dock) / 50 * 3600, abs=2)


def test_idle_return_goes_home_and_yields_to_the_next_item():
    doc = base()
    doc['robots'] = [robot('r1', 'd1', 'c1', soc=90, idle_return_min=5,
                           schedule=[{'at': '01:00', 'mission': 'go_a'}, {'at': '01:02', 'mission': 'go_a'}])]
    rows = items(run(doc, 2 * 3600))
    homes = [r for r in rows.values() if '/home@' in r['item']]
    assert homes and all(r['status'] in ('done', 'preempted') for r in homes)
    assert rows['r1/m1:go_a']['delay_min'] == 0  # going home never delays planned work


def test_low_battery_hands_over_the_mission_and_charges_at_home():
    doc = base()
    doc['missions'] = [{'id': 'long', 'steps': [{'goto': 'b'}, {'goto': 'a'}] * 200}]
    doc['robots'][0] = robot('r1', 'a', 'c1', soc=12, schedule=[{'at': '00:01', 'mission': 'long'}])
    doc['robots'][1]['soc'] = 90
    doc['robots'][1]['battery'] = {'soc': 90}
    sim = run(doc, 3600)
    rows = items(sim)
    assert rows['r1/m0:long']['status'] == 'failed'
    assert rows['r1/m0:long>r2']['delay_cause'] is None
    assert any(c['kind'] == 'battery_low' for c in sim.schedule_report()['causes'])
    assert any(u['fail_code'] == 'BATTERY_LOW' for u in sim.drain_run_updates())


def test_p_per_hour_events_are_fixed_by_the_seed():
    doc = base()
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_b'}]
    doc['events'] = [{'id': 'pc', 'kind': 'path_conflict', 'robot': 'r1', 'p_per_hour': 2, 'delay_min': 1}]
    one, two = sc.parse(doc), sc.parse(doc)
    times = [e.at_s for e in Simulation(one).events]
    assert times and times == [e.at_s for e in Simulation(two).events]
    doc['seed'] = 2
    assert times != [e.at_s for e in Simulation(sc.parse(doc)).events]


def test_reassign_skips_robots_that_cannot_reach_the_mission():
    # app-design 11/26 10:33: a fault on one site handed the mission to a robot on another map.
    doc = base()
    doc['site']['floors'].append({'id': 'f2', 'floor_id': '00000000-0000-4000-8000-0000000000f2',
                                  'map_version_id': '00000000-0000-4000-8000-0000000000a2'})
    doc['site']['waypoints'].append({'id': 'e1', 'floor': 'f2', 'x': 0, 'y': 0})
    doc['site']['chargers'].append({'id': 'c3', 'waypoint': 'e1', 'slots': 1, 'charge_pct_per_h': 50})
    doc['robots'].insert(1, robot('r3', 'e1', 'c3', soc=100))  # ahead of r2 in the tie order
    doc['robots'][0]['schedule'] = [{'at': '01:00', 'mission': 'go_a'}]
    doc['events'] = [{'id': 'dead', 'kind': 'fault', 'robot': 'r1', 'at': '00:30'}]
    rows = items(run(doc))
    assert 'r1/m0:go_a>r2' in rows and not any(r['robot'] == 'r3' for r in rows.values())

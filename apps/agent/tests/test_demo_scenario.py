"""Demo scenario loader: contract D/F/G fields and rejection of withdrawn keys."""
import copy
import os

import pytest

yaml = pytest.importorskip('yaml')

from foothold_agent.demo import scenario as sc
from foothold_agent.demo.measured import DRAIN_PCT_PER_H

EXAMPLE = os.path.join(os.path.dirname(__file__), 'fixtures', 'demo', 'scenario-small.yaml')


def example():
    with open(EXAMPLE, encoding='utf-8') as fh:
        return yaml.safe_load(fh)


def problems(doc):
    with pytest.raises(sc.ScenarioError) as info:
        sc.parse(doc)
    return '\n'.join(info.value.problems)


def test_example_loads_with_measured_defaults_and_offsets():
    s = sc.load(EXAMPLE)
    assert s.name == 'small-warehouse' and s.duration_s == 12 * 3600
    assert s.start_tod_s == 6 * 3600
    a = s.robots[0]
    assert a.schedule[0].at_s == 2 * 3600  # 08:00 is 2 h after a 06:00 start
    assert a.drain_pct_per_h == DRAIN_PCT_PER_H
    assert a.patrol_mps == 0.8 and a.transit_mps == 1.0
    assert s.chargers['ch_a'].charge_pct_per_h == 60
    assert s.zones['z_pick'].contains(15, 10) and not s.zones['z_pick'].contains(5, 10)
    assert s.zones['z_pick'].crowd[0].start_s == 8 * 3600 and s.zones['z_pick'].crowd[0].level == 0.5
    kinds = {e.id: e for e in s.events}
    assert kinds['fault-b'].recover_s == 30 * 60 and kinds['fault-b'].fail_code == 'NAV_UNAVAILABLE'
    assert kinds['slow-b'].delay_s == 5 * 60 and kinds['slow-b'].mission == 'patrol_b'
    assert [c.at_s for c in s.charge_rotation] == sorted(c.at_s for c in s.charge_rotation)


@pytest.mark.parametrize('edit, text', [
    (lambda d: d['robots'][0].__setitem__('jitter_min', 3), 'withdrawn by contract G'),
    (lambda d: d['robots'][0]['speed_mps'].__setitem__('spread', .1), 'withdrawn by contract G'),
    (lambda d: d['site']['zones'][0].__setitem__('video', {'file': 'x'}), 'withdrawn by contract G'),
    (lambda d: d['events'].append({'kind': 'charger_busy', 'at': '09:00'}), 'charger_busy only arises'),
    (lambda d: d['site']['chargers'][0].pop('charge_pct_per_h'), 'charge_pct_per_h'),
    (lambda d: d['site']['floors'][0].__setitem__('floor_id', 'f1'), 'must be a UUID'),
    (lambda d: d['missions'][0]['steps'].append({'goto': 'nowhere'}), "unknown waypoint 'nowhere'"),
    (lambda d: d['robots'][0]['schedule'].append({'at': '05:00', 'mission': 'patrol_a'}), 'outside the scenario window'),
    (lambda d: d['robots'][0]['schedule'].append({'at': '8:7', 'mission': 'patrol_a'}), 'HH:MM'),
    (lambda d: d.pop('seed') and d['events'].append(
        {'kind': 'path_conflict', 'robot': 'go2-a', 'p_per_hour': 1, 'delay_min': 1}), 'needs a top-level seed'),
    (lambda d: d['events'].append({'kind': 'fault', 'robot': 'go2-a', 'at': '09:00', 'fail_code': 'BROKEN'}),
     'RunFailCode'),
    (lambda d: d['robots'][1].__setitem__('id', 'go2-a'), "duplicate id 'go2-a'"),
    (lambda d: d['charge_rotation'][0].__setitem__('duration_min', 10), 'exactly one of until_soc'),
    (lambda d: d['robots'][0].__setitem__('model', 'b2'), 'model must be "go2"'),
])
def test_rejections_are_collected_with_location(edit, text):
    doc = example()
    edit(doc)
    assert text in problems(doc)


def test_unreachable_target_and_cross_floor_path_are_rejected():
    doc = example()
    doc['site']['waypoints'].append({'id': 'island', 'floor': 'f1', 'x': 50, 'y': 50})
    doc['missions'][0]['steps'].append({'goto': 'island'})
    assert "waypoint 'island' not reachable" in problems(doc)
    doc = example()
    doc['site']['floors'].append({'id': 'f2', 'floor_id': '00000000-0000-4000-8000-0000000000f2',
                                  'map_version_id': '00000000-0000-4000-8000-0000000000a2'})
    doc['site']['waypoints'].append({'id': 'up', 'floor': 'f2', 'x': 0, 'y': 0})
    doc['site']['paths'].append(['hub', 'up'])
    assert 'cross-floor paths are not supported' in problems(doc)


def test_several_problems_are_reported_together():
    doc = example()
    doc['robots'][0]['jitter_min'] = 1
    doc['site']['chargers'][0]['slots'] = 0
    text = problems(doc)
    assert 'jitter' in text and 'slots' in text


def test_drain_override_and_next_day_marks():
    doc = example()
    doc['robots'][0]['battery']['drain_pct_per_h'] = {'walk': 50}
    doc['duration_h'] = 24
    doc['robots'][0]['schedule'].append({'at': '29:30', 'mission': 'patrol_a'})
    s = sc.parse(copy.deepcopy(doc))
    assert s.robots[0].drain_pct_per_h == {**DRAIN_PCT_PER_H, 'walk': 50}
    assert s.robots[0].schedule[-1].at_s == (29.5 - 6) * 3600

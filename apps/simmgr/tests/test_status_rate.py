"""Producer scheduling only: no ROS imports, DDS, simulator or restamping."""
import ast
from copy import deepcopy
from types import SimpleNamespace

import pytest

from apps.simmgr.connected_runtime import MAP_STATUS_PERIOD_S, status_timer


SOURCE = '''
def publish_status():
    # Like the native producer, read source snapshot and TF on every invocation.
    status = dict(sim_t=snapshot['sim_t'], pose_map=dict(stamp_sim=tf['stamp_sim']))
    published.append(status)
node.create_timer(1.0, publish_status)
node.create_timer(.1, publish_state)
'''


def test_adapter_changes_only_status_timer_and_invokes_real_producer():
    tree = ast.parse(SOURCE)
    expected = ast.parse(SOURCE.replace('1.0, publish_status', '.2, publish_status'))
    status_timer(tree)
    assert ast.dump(tree) == ast.dump(expected)
    timers, published = [], []
    snapshot, tf = dict(sim_t=1.), dict(stamp_sim=.98)
    scope = dict(node=SimpleNamespace(create_timer=lambda *args: timers.append(args)),
                 snapshot=snapshot, tf=tf, published=published, publish_state=lambda: None)
    exec(compile(ast.fix_missing_locations(tree), 'offline-status-producer', 'exec'), scope)
    assert [period for period, _ in timers] == [MAP_STATUS_PERIOD_S, .1]
    callback = timers[0][1]
    callback()
    snapshot['sim_t'], tf['stamp_sim'] = 1.2, 1.18
    callback()
    assert published == [dict(sim_t=1., pose_map=dict(stamp_sim=.98)),
                         dict(sim_t=1.2, pose_map=dict(stamp_sim=1.18))]
    stalled = deepcopy(published[-1])
    callback()
    assert published[-1] == stalled  # no invented progress or refreshed TF stamp


@pytest.mark.parametrize('change', [
    lambda s: s.replace('1.0, publish_status', '.5, publish_status'),
    lambda s: s.replace('node.create_timer(1.0, publish_status)', ''),
    lambda s: s + '\nnode.create_timer(1.0, publish_status)',
    lambda s: s.replace('node.create_timer(1.0, publish_status)', 'other.create_timer(1.0, publish_status)'),
    lambda s: s.replace('1.0, publish_status', 'period, publish_status'),
    lambda s: s.replace('1.0, publish_status', '1.0, publish_status, callback_group=group'),
])
def test_upstream_status_scheduling_drift_fails_closed(change):
    with pytest.raises(ValueError, match='status timer hook changed'):
        status_timer(ast.parse(change(SOURCE)))

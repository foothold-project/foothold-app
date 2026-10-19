"""Offline sim-input and preregistered-verdict regression tests, no nodes."""
from dataclasses import asdict, replace
import json
import math
from pathlib import Path
import subprocess
import sys

import pytest

NAV = Path(__file__).parents[1]/'tools/nav2'
sys.path.insert(0, str(NAV))
from odometry import SimOdom
from prepare import MAP_HASHES, copy_map, map_manifest, swept
from ros_adapter import ActionMailbox, RosAdapter
from trial import Observation, Trial, aggregate
from resources import ResourceGate
from runner import replay
from foothold_agent.executor.nav2 import Binding

C = json.loads((NAV/'preregistration.json').read_text())
GOAL = C['points'][0]


def observation(**changes):
    return Observation(wall=0, sim=0, received=0, episode=1, map_sha=C['map_sha'],
        x=-12, y=-9, yaw=0, vx=0, vy=0, wz=0, tilt=0, fallen=False,
        policy_running=True, lockstep=True, cmd=(0, 0, 0), gt_clear=True,
        frames_ready=True, single_writer=True, resources_ok=True, lifecycle_ready=True, body_still=True, **changes)


def at(o, t, **changes):
    return replace(o, wall=t, sim=t, received=t, **changes)


def trial(kind='goal'):
    t = Trial(C, GOAL, 1, kind=kind)
    o = observation()
    assert t.start(o) == 'RUNNING'
    return t, o


def test_sim_time_tf_difference_and_child_frame_twist():
    s = SimOdom(.25, .02)
    assert s.update(episode=1, clock=1, scan_stamp=1, stamp=1, x=0, y=0, yaw=math.pi/2,
                    map_identity=True) is None
    o = s.update(episode=1, clock=1.1, scan_stamp=1.1, stamp=1.1, x=0, y=.06, yaw=math.pi/2,
                 map_identity=True)
    assert o['stamp'] == 1.1
    assert o['frame_id'] == 'odom' and o['child_frame_id'] == 'base_footprint'
    assert o['vx'] == pytest.approx(.6)
    assert abs(o['vy']) < 1e-9 and o['wz'] == 0


@pytest.mark.parametrize('change', [dict(clock=10000000), dict(scan_stamp=10000000),
    dict(parent='map'), dict(child='base_link'), dict(map_identity=False), dict(x=float('nan'))])
def test_wrong_frame_unpaired_or_wall_clock_never_becomes_odom(change):
    s = SimOdom(.25, .02)
    sample = dict(episode=1, clock=1, scan_stamp=1, stamp=1, x=0, y=0, yaw=0, map_identity=True)
    s.update(**sample)
    sample.update(clock=1.1, scan_stamp=1.1, stamp=1.1, x=.06)
    sample.update(change)
    assert s.update(**sample) is None
    assert s.reason == ('SCAN_PAIR_NOT_READY' if 'scan_stamp' in change else 'FRAME_OR_CLOCK_MISMATCH')


def test_odom_duplicate_gap_rewind_and_episode_are_fail_closed():
    s = SimOdom(.25, .02)
    def push(stamp, episode=1):
        return s.update(episode=episode, clock=stamp, scan_stamp=stamp, stamp=stamp,
                        x=stamp*.6, y=0, yaw=0, map_identity=True)
    assert push(1) is None
    assert push(1.1) is not None
    assert push(1.1) is None
    assert push(2) is None
    assert push(2.1) is not None
    assert push(1.9) is None
    assert push(2.2) is None and s.quarantined
    fresh = SimOdom(.25, .02)
    fresh.update(episode=1, clock=1, scan_stamp=1, stamp=1, x=0, y=0, yaw=0, map_identity=True)
    assert fresh.update(episode=2, clock=1.1, scan_stamp=1.1, stamp=1.1, x=0, y=0, yaw=0,
                        map_identity=True) is None
    assert fresh.quarantined


def test_yaw_wrap_is_not_a_full_revolution():
    s = SimOdom(.25, .02)
    for stamp, yaw in [(1, math.pi-.01), (1.1, -math.pi+.01)]:
        result = s.update(episode=1, clock=stamp, scan_stamp=stamp, stamp=stamp,
                          x=0, y=0, yaw=yaw, map_identity=True)
    assert result['wz'] == pytest.approx(.2)


def test_prestart_gt_refusal_separate_from_failure_denominator():
    t = Trial(C, GOAL, 1)
    assert t.start(replace(observation(), gt_clear=False)) == 'BLOCKED_NOT_STARTED'
    assert t.records[-1]['include_in_success_denominator'] is False
    assert t.records[-1]['r0_complete'] is False


@pytest.mark.parametrize('change', [dict(fallen=True), dict(policy_running=False), dict(lockstep=False),
    dict(frames_ready=False), dict(single_writer=False), dict(resources_ok=False),
    dict(lifecycle_ready=False), dict(gt_clear=False), dict(map_sha='wrong'), dict(episode=2),
    dict(tilt=21), dict(received=-.21), dict(vx=float('nan'))])
def test_started_gate_failure_is_failure_and_no_retry(change):
    t, o = trial()
    assert t.update(replace(o, **change), 'SUCCEEDED') == 'FAILED'
    assert t.reason == 'SAFETY_GATE'
    assert t.start(o) == 'FAILED'  # no automatic retry after a safety failure


def test_nav_success_alone_or_short_hold_is_not_arrival():
    t, o = trial()
    assert t.update(at(o, .1), 'SUCCEEDED') == 'RUNNING'
    g = replace(o, x=GOAL['x'])
    for i in range(1, 21):
        assert t.update(at(g, i/10+.1), 'SUCCEEDED') == 'RUNNING'
    assert t.update(at(g, 2.2), 'SUCCEEDED') == 'SUCCEEDED'
    assert t.reason == 'GT_GOAL_AND_ZERO_2_SIM_SECONDS'


def test_goal_hold_must_be_continuous_zero_same_episode():
    t, o = trial()
    g = replace(o, x=GOAL['x'])
    t.update(at(g, .1), 'SUCCEEDED')
    assert t.update(at(g, .2, cmd=(.6, 0, 0)), 'SUCCEEDED') == 'FAILED'
    assert t.reason == 'GOAL_HOLD_LOST'


@pytest.mark.parametrize('result', ['ABORTED', 'CANCELED', 'REJECTED', 'TIMEOUT'])
def test_nav_terminal_failure_is_not_success(result):
    t, o = trial()
    assert t.update(at(o, .1), result) == 'FAILED'
    assert t.reason == 'NAV2_'+result


def test_clock_stall_and_rewind_fail_even_with_new_receipts():
    t, o = trial()
    assert t.update(replace(at(o, .21), sim=0)) == 'FAILED'
    assert t.reason == 'CLOCK_STALLED'
    t, o = trial()
    t.update(at(o, .1))
    assert t.update(replace(at(o, .2), sim=.09)) == 'FAILED'
    assert t.reason == 'CLOCK_REWIND'


def test_motion_burst_budget_is_preregistered_one_second():
    t, o = trial()
    for i in range(1, 11):
        assert t.update(at(o, i/10, cmd=(.6, 0, 0))) == 'RUNNING'
    assert t.update(at(o, 1.01, cmd=(.6, 0, 0))) == 'FAILED'
    assert t.reason == 'MOTION_BUDGET'


def test_goal_wall_and_sim_limits_are_independent():
    config = {**C, 'goal_wall_s': .15, 'goal_sim_s': .15}
    for change in [dict(wall=.15, sim=.1, received=.15), dict(wall=.1, sim=.15, received=.1)]:
        t, o = Trial(config, GOAL, 1), observation()
        t.start(o)
        assert t.update(replace(o, **change)) == 'FAILED'
        assert t.reason == 'GOAL_TIMEOUT_OR_UNSUPPORTED_COMMAND'


def test_silence_needs_measured_ros_zero_within_half_second():
    t, o = trial('safety')
    t.trigger_stop(o, last_intent_receive=0)
    for i in range(1, 6):
        t.update(at(o, i/10, body_still=False))
    assert t.update(at(o, .500001)) == 'FAILED'
    assert t.reason == 'SILENCE_ZERO_LATE_OR_UNMEASURED'
    t, o = trial('safety')
    t.trigger_stop(o, last_intent_receive=0)
    for i in range(1, 6):
        t.update(at(o, i/10, body_still=False))
    t.ros_zero(.51)
    assert t.update(at(o, .52)) == 'FAILED'


def test_stop_displacement_and_body_timeout_are_holds():
    t, o = trial('safety')
    t.trigger_stop(o)
    assert t.update(at(o, .1, x=o.x+.50001)) == 'FAILED'
    assert t.reason == 'STOP_DISPLACEMENT'
    t, o = trial('safety')
    t.trigger_stop(o)
    for i in range(1, 51):
        t.update(at(o, i/10, vx=.06))
    assert t.reason == 'STOP_BODY_TIMEOUT'


def test_safety_success_needs_actual_ros_receive_and_native_body_still():
    t, o = trial('safety')
    t.trigger_stop(o, last_intent_receive=0)
    t.ros_zero(.4)
    for i in range(1, 22):
        t.update(at(o, i/10))
    assert t.status == 'SUCCEEDED'
    assert t.reason == 'SAFETY_CONTROL_STOPPED'


def test_selected_report_list_cannot_bypass_the_attempt_ledger():
    rows = [dict(trial=name, status='SUCCEEDED', isolated_start_id=str(i), cleanup_verified=True)
            for i, name in enumerate(C['trials'])]
    with pytest.raises(ValueError, match='complete registered attempt ledger'):
        aggregate(C, rows)


def test_action_queue_single_goal_and_cancel_before_acceptance():
    q = ActionMailbox()
    b = Binding('r', 'g', 1, 1, 'w', 'f', 'a'*64)
    q.submit(b, {'x': 1})
    q.cancel(b)
    item, cancelled = q.take()
    assert item[0] == b and b in cancelled
    with pytest.raises(ValueError):
        q.submit(b, {'x': 2})
    class Handle:
        accepted = True
        cancelled = False
        def cancel_goal_async(self):
            self.cancelled = True
        def get_result_async(self):
            return type('F', (), {'add_done_callback': lambda *args: None})()
    handle = Handle()
    glue = object.__new__(RosAdapter)
    glue.actions = q
    glue.executor = type('E', (), {'binding': None})()
    future = type('F', (), {'result': lambda _: handle})()
    glue._goal_response(future, b)
    assert handle.cancelled and glue.cancel_sent


def test_resource_thresholds_and_durations_are_fixed():
    now = [0.]
    g = ResourceGate(C, now=lambda: now[0])
    sample = dict(available_mib=3500, load1=9, gpu_free_mib=3000, swap_in_kib_s=0, rtf=1)
    assert g.update(sample, starting=True)
    assert not g.update({**sample, 'gpu_free_mib': 2999}, starting=True)
    assert not g.update({**sample, 'available_mib': 1499})
    assert g.update({**sample, 'rtf': .49})
    now[0] = 4.99
    assert g.update({**sample, 'rtf': .49})
    now[0] = 5
    assert not g.update({**sample, 'rtf': .49})
    assert g.update(sample)
    assert g.update({**sample, 'swap_in_kib_s': 2001})
    now[0] = 15
    assert not g.update({**sample, 'swap_in_kib_s': 2001})


def test_unrecognized_map_and_world_sha_are_rejected(tmp_path):
    for filename in MAP_HASHES:
        (tmp_path/filename).write_text('unrecognized')
    with pytest.raises(ValueError, match='SHA'):
        map_manifest(tmp_path)
    with pytest.raises(ValueError, match='SHA'):
        swept(tmp_path/'map.pgm', [{'x': 0, 'y': 0, 'z': .4, 'yaw': 0}])


def test_default_runner_and_import_are_ros_free():
    result = subprocess.run([sys.executable, str(NAV/'runner.py')], capture_output=True,
        text=True, check=True, env={**__import__('os').environ,
                                  'PYTHONPATH': str(NAV.parents[1])})
    assert json.loads(result.stdout)['ROS_started'] is False
    code = f"import sys; sys.path[:0]=[{str(NAV)!r}, {str(NAV.parents[1])!r}]; import runner; assert 'rclpy' not in sys.modules"
    subprocess.run([sys.executable, '-I', '-S', '-c', code], check=True)


def test_replay_incomplete_never_claims_success(tmp_path):
    file = tmp_path/'replay.jsonl'
    file.write_text(json.dumps({'observation': asdict(observation()), 'nav_result': 'SUCCEEDED'})+'\n')
    result = replay(C, GOAL, file)
    assert result['status'] == 'FAILED' and result['reason'] == 'REPLAY_INCOMPLETE'


def test_at_gt_goal_without_nav_success_cannot_finish():
    t, o = trial()
    g = replace(o, x=GOAL['x'])
    for i in range(1, 24):
        assert t.update(at(g, i/10)) == 'RUNNING'
    assert t.hold_since is None


def test_journal_is_bounded_and_disk_errors_are_visible(tmp_path):
    from journal import Journal
    file = tmp_path/'events.jsonl'
    j = Journal(file)
    j.emit({'event': 'unmeasured', 'value': float('nan')})
    j.emit({'event': 'stop', 'monotonic_s': 1.2})
    j.close()
    rows = [json.loads(line) for line in file.read_text().splitlines()]
    assert rows == [{'event': 'unmeasured', 'value': None}, {'event': 'stop', 'monotonic_s': 1.2}]
    with pytest.raises(RuntimeError, match='closed'):
        j.emit({'event': 'late'})
    j = Journal(tmp_path/'failed.jsonl')
    j.error = OSError('disk failure')
    with pytest.raises(RuntimeError, match='journal failed'):
        j.emit({'event': 'stop'})
    with pytest.raises(RuntimeError, match='journal failed'):
        j.close()


def test_occupancy_payload_matches_exact_static_map_binding():
    from array import array
    import hashlib
    from types import SimpleNamespace as N
    glue = object.__new__(RosAdapter)
    glue.data = {}
    data = array('b', [0])* (800*640)
    glue.map_manifest = {'occupancy_sha256': hashlib.sha256(data.tobytes()).hexdigest()}
    info = N(width=800, height=640, resolution=.05,
             origin=N(position=N(x=-20, y=-14, z=0), orientation=N(x=0, y=0, z=0, w=1)))
    message = N(header=N(frame_id='map'), info=info, data=data)
    glue._grid(message)
    assert glue.grid_ready
    data[1] = 100
    glue._grid(message)
    assert not glue.grid_ready
    data[1] = 0
    info.origin.position.x = -19
    glue._grid(message)
    assert not glue.grid_ready


def test_replay_accepts_recorded_jsonl_events_and_ignores_claimed_verdict(tmp_path):
    t, o = trial()
    g = replace(o, x=GOAL['x'])
    for i in range(1, 23):
        t.update(at(g, i/10), 'SUCCEEDED')
    assert t.status == 'SUCCEEDED'
    file = tmp_path/'recorded.jsonl'
    file.write_text('\n'.join(json.dumps(r) for r in t.records)+'\n')
    assert replay(C, GOAL, file)['status'] == 'SUCCEEDED'
    file.write_text(json.dumps({'event': 'verdict', 'status': 'SUCCEEDED'})+'\n')
    assert replay(C, GOAL, file)['status'] == 'BLOCKED_NOT_STARTED'


def test_safety_zero_without_native_body_still_fails_within_five_wall_seconds():
    t, o = trial('safety')
    t.trigger_stop(o)
    t.ros_zero(.1)
    for i in range(1, 51):
        t.update(at(o, i/10, body_still=False))
    assert t.status == 'FAILED' and t.reason == 'STOP_BODY_TIMEOUT'

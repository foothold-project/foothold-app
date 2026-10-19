#!/usr/bin/env python3
"""Assertion-only mutation gate in disposable copies. No ROS or port use.

Baseline must pass; a mutant is killed only by a test assertion (never an import,
collection, fixture or runtime error). Existing Core/tests remain byte-identical.
"""
import argparse
import ast
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
AGENT = HERE.parents[1]
MUTATIONS = [
    ('occupancy_sha_bypassed', 'tools/nav2/ros_adapter.py',
     "self.grid_ready = digest == self.map_manifest['occupancy_sha256']", 'self.grid_ready = True'),
    ('low_speed_amplified', 'foothold_agent/executor/nav2/intent.py',
     "if tuple(velocity) == tuple(item['si']):", "if tuple(velocity) == tuple(item['si']) or 0 < velocity[0] < .6 and item['si'][0] == .6:"),
    ('cached_intent_refreshes_deadman', 'foothold_agent/executor/nav2/intent.py',
     "if item is None or item[0] == self._consumed:", "if item is None:"),
    ('stale_mailbox_accepted', 'foothold_agent/executor/nav2/intent.py',
     "if not 0 <= self.now() - receipt <= self.dead_s:", 'if False:'),
    ('old_binding_intent_accepted', 'foothold_agent/executor/nav2/intent.py',
     'if binding != self.binding or self._revoked:\n                return False\n            self._sequence',
     'if self._revoked:\n                return False\n            self._sequence'),
    ('old_result_accepted', 'foothold_agent/executor/nav2/intent.py',
     'if binding != self.binding or self._revoked:\n                return False\n            self.result',
     'if False:\n                return False\n            self.result'),
    ('experimental_freshness_weakened', 'foothold_agent/executor/nav2/owner.py',
     'self.now, self.state_age_s = now, state_age_s', 'self.now, self.state_age_s = now, 1'),
    ('source_progress_freshness_removed', 'foothold_agent/executor/nav2/owner.py',
     '0 <= self.now()-self._progress <= self.state_age_s', 'True'),
    ('cancel_goal_removed', 'foothold_agent/executor/nav2/intent.py',
     '            self.actions.cancel(binding)', '            pass'),
    ('curve_enabled_without_review', 'foothold_agent/executor/nav2/intent.py',
     "if velocity[2] and not self.allow_curves:", 'if False:'),
    ('odom_wall_clock_accepted', 'tools/nav2/odometry.py',
     'abs(clock-stamp) > self.tolerance', 'False'),
    ('odom_bad_frame_accepted', 'tools/nav2/odometry.py',
     "child != 'base_footprint'", 'False'),
    ('odom_rewind_not_quarantined', 'tools/nav2/odometry.py',
     'if stamp < old[0]:', 'if False:'),
    ('goal_requires_no_nav_success', 'tools/nav2/trial.py',
     "at_goal = (nav_result == 'SUCCEEDED'", 'at_goal = (True'),
    ('goal_hold_removed', 'tools/nav2/trial.py',
     "elif o.sim-self.hold_since >= self.c['still_hold_sim_s']:", 'elif True:'),
    ('goal_zero_not_required', 'tools/nav2/trial.py',
     "and abs(o.wz) <= self.c['still_wz_rps'] and not any(o.cmd))", "and abs(o.wz) <= self.c['still_wz_rps'])"),
    ('prestart_gt_bypassed', 'tools/nav2/trial.py', 'and o.gt_clear and o.frames_ready', 'and True and o.frames_ready'),
    ('trial_retry_allowed', 'tools/nav2/trial.py', "if self.status != 'NOT_STARTED':", 'if False:'),
    ('blocked_counts_as_success', 'tools/nav2/trial.py', "all(r['status'] == 'SUCCEEDED' and r.get('cleanup_verified') is True for r in reports)",
     "all(r.get('cleanup_verified') is True for r in reports)"),
    ('silence_measurement_missing_allowed', 'tools/nav2/trial.py',
     "self.ros_zero_at is None and o.wall-self.last_intent > self.c['silence_zero_wall_s']", 'False'),
    ('stop_displacement_gate_removed', 'tools/nav2/trial.py',
     "if math.hypot(o.x-self.stop_pose[0], o.y-self.stop_pose[1]) > self.c['stop_displacement_m']:", 'if False:'),
    ('motion_burst_budget_removed', 'tools/nav2/trial.py',
     "self.burst_since is not None and o.wall-self.burst_since > self.c['nonzero_burst_wall_s']", 'False'),
    ('late_goal_acceptance_not_cancelled', 'tools/nav2/ros_adapter.py',
     '            handle.cancel_goal_async()', '            pass'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    results = []
    with tempfile.TemporaryDirectory(prefix='fh-nav2-mutations-') as folder:
        root = Path(folder)
        shutil.copytree(AGENT/'foothold_agent', root/'foothold_agent', ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copytree(AGENT/'tools/nav2', root/'tools/nav2', ignore=shutil.ignore_patterns('__pycache__'))
        (root/'tests').mkdir()
        for name in ('test_nav2_tools.py', 'test_executor_nav2.py'):
            shutil.copyfile(AGENT/'tests'/name, root/'tests'/name)
        shutil.copyfile(AGENT/'tools/mutation_reporter.py', root/'probe.py')
        env = {**os.environ, 'PYTHONPATH': str(root), 'PYTHONDONTWRITEBYTECODE': '1',
               'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1'}

        def check():
            report = root/'pytest.json'
            report.unlink(missing_ok=True)
            run = subprocess.run([sys.executable, '-m', 'pytest', 'tests', '-q', '-p', 'probe',
                '--link-mutation-report', str(report)], cwd=root, env=env,
                capture_output=True, text=True, timeout=30)
            data = json.loads(report.read_text()) if report.exists() else {'errors': ['report missing']}
            data['returncode'] = run.returncode
            return data

        baseline = check()
        if baseline.get('returncode') != 0 or baseline.get('errors'):
            raise RuntimeError('baseline failed; no mutation claims: '+str(baseline))
        for name, path, before, after in MUTATIONS:
            target = root/path
            original = target.read_text()
            if original.count(before) != 1:
                raise RuntimeError('mutation anchor not unique: '+name)
            changed = original.replace(before, after)
            ast.parse(changed)
            target.write_text(changed)
            try:
                data = check()
                killed = data['returncode'] == 1 and bool(data.get('assertions')) and not data.get('errors')
                results.append({'mutation': name, 'killed': killed, **data})
                print(name+': '+('KILLED' if killed else 'SURVIVED/ERROR'), flush=True)
            finally:
                target.write_text(original)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps({'baseline': baseline, 'mutations': results}, indent=2)+'\n')
    print(f"{sum(r['killed'] for r in results)}/{len(results)} KILLED")
    return 0 if all(r['killed'] for r in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())

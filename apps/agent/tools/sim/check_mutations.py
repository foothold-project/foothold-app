#!/usr/bin/env python3
"""Run the review's 13 mutations and two GT-structure mutations in temp copies.

Only ROS-free tools tests run. No simulation, systemd unit, server or ROS node is
started; the unit-environment test executes an empty fake setup and fake entry.
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
    ('unit_domain_61', 'isolation.py', 'export ROS_DOMAIN_ID=93', 'export ROS_DOMAIN_ID=61'),
    ('unit_fixed_name', 'isolation.py', "self.unit = 'fh-rb-sim-' + tag + '.service'", "self.unit = 'fh-rb-sim-fixed.service'"),
    ('live_main_domain_ignored', 'isolation.py', "main['domain'] != '93'", 'False'),
    ('nonforward_axis', 'motion.py', 'cmd([1, 0, 0])', 'cmd([1, 0, 1])'),
    ('burst_5_seconds', 'motion.py', 'while time.monotonic()-burst_start < .30:', 'while time.monotonic()-burst_start < 5.0:'),
    ('final_stop_removed', 'motion.py', '                finalize_stop()', '                None'),
    ('per_trial_gt_removed', 'motion.py', "                proof = prove(world, start['data'])", '                proof = proof'),
    ('production_port', 'app_probe.py', 'range(9020, 9040)', 'range(8453, 8454)'),
    ('domain61_change_ignored', 'isolation.py', "identities(after61) == identities(self.before['domain61'])", 'True'),
    ('run_dir_escape', 'd1.py', "not folder.is_relative_to(ROOT / 'runs/sim-d1')", 'False'),
    ('reused_pid_allowed', 'isolation.py', "int(stat[19]) != self.pid['start_ticks']", 'False'),
    ('duplicate_sigint', 'isolation.py', 'if self.interrupted:', 'if False:'),
    ('obstacle_height_ignored', 'clearance.py', 'elif bounds[2][1] > .02:', 'elif bounds[2][1] > 200:'),
    ('unknown_world_include_allowed', 'clearance.py', '    for include in includes:', '    for include in []:'),
    ('gt_structure_validation_removed', 'clearance.py', 'terrain = terrain_model(root)', 'terrain = root.find("./world/model")'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    env = {**os.environ, 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    results = []
    with tempfile.TemporaryDirectory(prefix='fh-sim-mutations-') as directory:
        root = Path(directory)
        target = root / 'apps/agent/tools/sim'
        shutil.copytree(HERE, target, ignore=shutil.ignore_patterns('__pycache__', '.pytest_cache'))
        shutil.copytree(AGENT / 'foothold_agent', root / 'apps/agent/foothold_agent', ignore=shutil.ignore_patterns('__pycache__'))
        env['PYTHONPATH'] = str(target)

        def check(name):
            report = root / (name + '.json')
            run = subprocess.run([sys.executable, '-m', 'pytest', str(target), '-q',
                '-p', 'mutation_probe', '--sim-mutation-report', str(report)],
                cwd=root, env=env, capture_output=True, text=True, timeout=40)
            if not report.exists():
                return {'errors': [{'phase': 'missing reporter'}], 'assertions': [], 'exitstatus': run.returncode}
            return json.loads(report.read_text())

        baseline = check('baseline')
        if baseline['exitstatus'] or baseline['errors'] or baseline['assertions']:
            raise RuntimeError('baseline tools tests failed; no mutation claims')
        for name, filename, before, after in MUTATIONS:
            file = target / filename
            original = file.read_text()
            if original.count(before) != 1:
                raise RuntimeError('mutation anchor not unique: ' + name)
            changed = original.replace(before, after, 1)
            ast.parse(changed)
            file.write_text(changed)
            try:
                result = check(name)
                killed = result['exitstatus'] == 1 and bool(result['assertions']) and not result['errors']
                results.append({'mutation': name, 'killed': killed, **result})
                print(name + ': ' + ('KILLED' if killed else 'SURVIVED/ERROR'), flush=True)
            finally:
                file.write_text(original)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps({'baseline': baseline, 'mutations': results}, indent=2)+'\n')
    print(f"{sum(r['killed'] for r in results)}/{len(results)} KILLED")
    return 0 if all(r['killed'] for r in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())

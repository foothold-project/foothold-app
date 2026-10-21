"""Offline phone mutation checks, disposable copies INSIDE this worktree only."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = [
    ('controller guard removed', 'hub.py',
     "elif self.owner != peer or f['lease_id'] != self.session.lease_id:", 'elif False:',
     'test_phone_single_controller_and_connection_bound_lease'),
    ('open ticket expiry removed', 'hub.py',
     'if p.user is not None and self.now() >= p.deadline:', 'if False:',
     'test_phone_open_ticket_expiry_stops_locks_and_clears'),
    ('disconnect STOP and revocation removed', 'hub.py',
     "self._drop(peer, reserve=reserve, reason='DISCONNECTED')", 'pass',
     'test_phone_disconnect_stops_and_reserves_then_reconnects_with_new_lease'),
    ('expired ticket admitted', 'tickets.py',
     'or not issued <= current < expires', 'or False',
     'test_phone_rejects_invalid_ticket'),
    ('same-device reconnect restriction removed', 'hub.py',
     "and self.reservation['identity'] != identity", 'and True',
     'test_phone_disconnect_stops_and_reserves_then_reconnects_with_new_lease'),
    ('cloud command isolation removed', 'observer.py',
     "return self.tick()  # lease/cmd/unlock/run.* never reach the real Session",
     'return self.phone.session.receive(f)',
     'test_phone_no_cloud_lease_cmd_unlock_run_or_reconnect_can_change_authority'),
    ('unsupported input fakes neutral', 'hub.py',
     "core_axes = (list(axes) if any(axes) or not any(f[k] for k in ('vx', 'vy', 'wz')) else None)",
     'core_axes = list(axes)', 'test_phone_clipped_zero_cannot_replace_explicit_neutral'),
]


def main():
    if sys.platform == 'linux':
        available = next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
                         if line.startswith('MemAvailable:'))
        if available < 2500000:
            raise SystemExit('MemAvailable below 2.5 GB; mutation checks not started')
    temp_root = ROOT.parents[1] / 'tmp' / 'phone-mutations'
    temp_root.mkdir(parents=True, exist_ok=True)
    failed = False
    for label, target, before, after, test in MUTATIONS:
        with tempfile.TemporaryDirectory(prefix='mutant-', dir=temp_root) as tmp:
            dest = Path(tmp)
            shutil.copytree(ROOT/'foothold_agent', dest/'foothold_agent', ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copytree(ROOT/'tests', dest/'tests', ignore=shutil.ignore_patterns('__pycache__'))
            shutil.copyfile(ROOT/'tools/mutation_reporter.py', dest/'foothold_link_mutation_probe.py')
            source = dest/'foothold_agent/phone'/target
            original = source.read_text()
            if original.count(before) != 1:
                raise RuntimeError('mutation anchor is not unique: ' + label)
            source.write_text(original.replace(before, after))
            report = dest/'report.json'
            env = {**os.environ, 'TMPDIR': str(dest)}
            result = subprocess.run([sys.executable, '-m', 'pytest', 'tests/test_phone.py::'+test,
                '-q', '--tb=short', '-p', 'foothold_link_mutation_probe', '--link-mutation-report', str(report)],
                cwd=dest, env=env, text=True, capture_output=True, timeout=25)
            data = json.loads(report.read_text()) if report.exists() else {}
            killed = (result.returncode == 1 and data.get('collected', 0) > 0
                      and bool(data.get('assertions')) and not data.get('errors'))
            print(f"{'KILLED' if killed else 'SURVIVED/ERROR'} | {label}", flush=True)
            if not killed:
                failed = True
                print(result.stdout[-2000:] + result.stderr[-500:])
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())

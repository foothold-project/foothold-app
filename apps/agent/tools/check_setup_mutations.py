"""Offline approval-boundary mutations in throwaway copies; no robot SDK or network beyond loopback."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = [
    ('preapproval command discard', 'setup/runtime.py', 'if not self.gate.allowed():', 'if False:',
     'test_no_motion_objects_before_approval_and_existing_locked_start_after'),
    ('wall expiry', 'setup/runtime.py', 'self.wall() < self.last_expiry', 'True',
     'test_revocation_stops_locks_and_cannot_rearm_same_approval[expiry]'),
    ('monotonic expiry', 'setup/runtime.py', 'self.now() < self.deadline', 'True',
     'test_revocation_stops_locks_and_cannot_rearm_same_approval[monotonic-expiry]'),
    ('NIC continuity', 'setup/runtime.py', 'self.ready and self.nic_matches() and self.now()', 'self.ready and True and self.now()',
     'test_revocation_stops_locks_and_cannot_rearm_same_approval[nic]'),
    ('physical STOP on revoke', 'setup/runtime.py', 'active.sink.close()', 'pass',
     'test_revocation_stops_locks_and_cannot_rearm_same_approval[revoke]'),
    ('replay after reconnect', 'setup/runtime.py', 'if expiry == self.last_expiry:', 'if False:',
     'test_revocation_stops_locks_and_cannot_rearm_same_approval[disconnect]'),
    ('persist before SDK', 'setup/runtime.py', 'self.remember(approval.expires_at)', 'None',
     'test_used_approval_is_saved_before_motion_and_rejected_after_restart'),
    ('maximum server approval upper bound', 'go2_direct/approval.py', 'not now < expiry <= now+1800+clock_skew_s', 'not now < expiry',
     'test_invalid_approval_never_constructs_motion[2831]'),
    ('pairing clock skew margin', 'setup/pairing.py', 'now+600+SERVER_CLOCK_SKEW_S', 'now+600',
     'test_server_pairing_expiry_clock_skew_only_relaxes_upper_bound[-1-True]'),
    ('approval clock skew margin', 'setup/runtime.py', 'clock_skew_s=SERVER_CLOCK_SKEW_S', 'clock_skew_s=0.',
     'test_server_field_approval_clock_skew_and_expired_boundary[-1-True]'),
    ('no past expiry grace', 'setup/pairing.py', 'not now < expires <= now+600+SERVER_CLOCK_SKEW_S',
     'not expires <= now+600+SERVER_CLOCK_SKEW_S',
     'test_server_pairing_expiry_clock_skew_only_relaxes_upper_bound[600-False]'),
    ('explicit repair selection', 'setup/__main__.py', "credentials is None or getattr(args, 'repair', False)",
     'credentials is None', 'test_explicit_repair_pairs_again_and_atomically_replaces_saved_token'),
    ('auth rejection repair guidance', 'setup/__main__.py', 'except ReconnectForbidden:', 'except KeyError:',
     'test_saved_connection_auth_rejection_shows_explicit_repair_without_pairing[ws-4403]'),
]


def main():
    failures = 0
    for label, target, before, after, test in MUTATIONS:
        with tempfile.TemporaryDirectory(prefix='agent-setup-mutant-') as tmp:
            copy = Path(tmp)/'agent'
            shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns('__pycache__', '.pytest_cache', '*.egg-info'))
            source = copy/'foothold_agent'/target
            text = source.read_text()
            if text.count(before) != 1:
                raise RuntimeError('mutation target must be unique: '+label)
            source.write_text(text.replace(before, after, 1))
            shutil.copyfile(ROOT/'tools/mutation_reporter.py', copy/'foothold_setup_probe.py')
            report = copy/'result.json'
            result = subprocess.run([sys.executable, '-m', 'pytest',
                'tests/test_setup_pairing.py::'+test, '-q', '--tb=no', '-p', 'foothold_setup_probe',
                '--link-mutation-report', str(report)], cwd=copy,
                env={**os.environ, 'PYTHONPATH':str(copy)}, text=True, capture_output=True, timeout=30)
            data = json.loads(report.read_text())
            killed = (result.returncode == data['exitstatus'] == 1 and data['collected'] > 0
                      and data['assertions'] and not data['errors'])
            print(label+': '+('KILLED' if killed else 'ERROR/SURVIVED'))
            if not killed:
                failures += 1
                print(result.stdout+result.stderr, file=sys.stderr)
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())

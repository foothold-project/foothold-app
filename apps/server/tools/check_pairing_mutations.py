"""Remove each motion boundary independently; only assertion failures kill mutants.

Run after the relevant server pytest succeeds. Source mutations live only in child
process memory; no repository file is changed.
"""
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
TEST = 'apps/server/tests/test_pairing.py::'
CASES = {
    'global switch removed': ('apps.server.fh_server.api',
        "return (self.server_drive_enabled if self.server_drive_enabled is not None\n"
        "                else UUID(str(robot_id)) in self.server_drive_robots)",
        'return True', TEST + 'test_both_motion_gates_required'),
    'input field gate removed': ('apps.server.fh_server.realtime',
        "permission == 'O_OWN' and agent is not None and not agent.simulation",
        'False and agent is not None and not agent.simulation', TEST + 'test_both_motion_gates_required'),
    'final send field gate removed': ('apps.server.fh_server.realtime',
        'and (rid in self.robot_changes or not self.field_approved(rid))',
        'and False', TEST + 'test_final_send_gate_cannot_leak_queued_command'),
    'automatic auth freshness removed': ('apps.server.fh_server.realtime',
        'and self.clock() - peer.auth_checked <= .5',
        'and True', 'apps/server/tests/test_automatic_field_gate.py::test_automatic_gate_checks_every_final_send[auth]'),
    'reconnect approval reset removed': ('apps.server.fh_server.realtime',
        "await self.reset_agent_field_approval(rid, digest(ws.headers['authorization'][7:]))",
        'pass', 'apps/server/tests/test_pairing_r1.py::test_agent_connect_clears_persisted_field_approval'),
    'orphan assignment fields guard removed': ('apps.server.fh_server.api',
        "if body.model_fields_set != {'owner_user_id'} or body.owner_user_id is None:",
        'if False:', 'apps/server/tests/test_pairing_r1.py::test_admin_can_only_assign_unowned_real_robot'),
}


def child(label, report):
    import pytest
    tests = list(dict.fromkeys(value[3] for value in CASES.values()))
    if label != 'baseline':
        target, before, after, selected = CASES[label]
        module = importlib.import_module(target)
        source = Path(module.__file__).read_text()
        if source.count(before) != 1:
            raise RuntimeError('mutation anchor must match exactly once')
        exec(compile(source.replace(before, after), module.__file__, 'exec'), module.__dict__)
        tests = [selected]
    return pytest.main(['-q', '-p', 'no:cacheprovider', '-p', 'mutation_reporter',
                        '--realtime-mutation-report', report, *tests])


def main():
    if len(sys.argv) > 1:
        return child(sys.argv[1], sys.argv[2])
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
    with tempfile.TemporaryDirectory(prefix='pairing-mutations-') as folder:
        for index, label in enumerate(['baseline', *CASES]):
            report = Path(folder) / f'{index}.json'
            result = subprocess.run([sys.executable, __file__, label, str(report)],
                cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
            if not report.exists():
                print(result.stdout, result.stderr)
                print(f'ERROR: {label} (no structured pytest report)')
                return 1
            data = json.loads(report.read_text())
            assertions, errors = len(data['assertions']), data['errors']
            passed = result.returncode == 0 and not assertions and not errors
            killed = result.returncode == 1 and assertions > 0 and not errors
            expected = passed if label == 'baseline' else killed
            status = ('PASS' if label == 'baseline' else 'KILLED') if expected else 'ERROR/SURVIVED'
            print(f'{status}: {label}; collected={data["collected"]}, assertions={assertions}, errors={len(errors)}', flush=True)
            if not expected:
                print(result.stdout, result.stderr)
                return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

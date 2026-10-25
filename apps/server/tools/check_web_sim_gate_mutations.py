"""Two offline gate mutations; assertion failures alone count as detection."""
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
CASES = {
    'server gate removed': ('apps.server.fh_server.phone_pass',
        "if body.surface == 'pc' and robot.simulation is not True:", 'if False:'),
    'agent hello gate removed': ('foothold_agent.phone.hub',
        "if ticket['surface'] == 'pc' and self.simulation is not True:", 'if False:'),
}
TESTS = ['apps/server/tests/test_web_sim_gate.py::test_surface_issuance',
         'apps/server/tests/test_web_sim_gate.py::test_agent_does_not_trust_server_simulation_flag']


def child(label, report):
    import pytest
    if label != 'baseline':
        target, before, after = CASES[label]
        module = importlib.import_module(target)
        source = Path(module.__file__).read_text()
        if source.count(before) != 1:
            raise RuntimeError('mutation anchor must match exactly once')
        exec(compile(source.replace(before, after), module.__file__, 'exec'), module.__dict__)
    return pytest.main(['-q', '-p', 'no:cacheprovider', '-p', 'mutation_reporter',
                        '--realtime-mutation-report', report, *TESTS])


def main():
    if len(sys.argv) > 1:
        return child(sys.argv[1], sys.argv[2])
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
    with tempfile.TemporaryDirectory(prefix='web-sim-gate-mutations-') as folder:
        for index, label in enumerate(['baseline', *CASES]):
            report = Path(folder) / f'{index}.json'
            result = subprocess.run([sys.executable, __file__, label, str(report)],
                                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
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
            print(f'{status}: {label}; collected={data["collected"]}, assertions={assertions}, errors={len(errors)}')
            if not expected:
                print(result.stdout, result.stderr)
                return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

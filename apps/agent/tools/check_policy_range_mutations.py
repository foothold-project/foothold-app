"""Two offline mutations for the simulation adapter; never writes source files."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
CASES = {
    'physical projection loses simulation guard': ('protocol', 'if simulation is True:', 'if True:'),
    'adapter loses range guard': ('policy_ranges',
        'if not (self.vx_min_moving <= vx <= self.vx_max',
        'if False and not (self.vx_min_moving <= vx <= self.vx_max'),
}
TESTS = ['apps/agent/tests/test_policy_ranges.py',
         'apps/agent/tests/test_phone_continuous.py::test_simulation_projection_boundaries',
         'apps/agent/tests/test_phone_continuous.py::test_physical_projection_is_identical_to_default']


def child(label, report):
    from foothold_agent import policy_ranges
    from foothold_agent.phone import hub, protocol
    import pytest
    if label != 'baseline':
        target, before, after = CASES[label]
        module = {'protocol': protocol, 'policy_ranges': policy_ranges}[target]
        source = Path(module.__file__).read_text()
        if source.count(before) != 1:
            raise RuntimeError('mutation anchor must match exactly once')
        exec(compile(source.replace(before, after), module.__file__, 'exec'), module.__dict__)
        if target == 'protocol':
            hub.project_velocity = protocol.project_velocity
        else:
            protocol.FOOTHOLD_V2 = policy_ranges.FOOTHOLD_V2
    return pytest.main(['-q', '-p', 'no:cacheprovider', '-p', 'mutation_reporter',
                        '--link-mutation-report', report, *TESTS])


def main():
    if len(sys.argv) > 1:
        return child(sys.argv[1], sys.argv[2])
    with tempfile.TemporaryDirectory(prefix='policy-range-mutations-') as folder:
        for index, label in enumerate(['baseline', *CASES]):
            report = Path(folder) / f'{index}.json'
            result = subprocess.run([sys.executable, __file__, label, str(report)],
                cwd=ROOT, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
                capture_output=True, text=True, timeout=60)
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

"""Two in-memory scenario safety mutations; tracked source/expectations stay intact."""
import json
from pathlib import Path
import os
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ('same-screen proof bypass',
     "        if not self.owns(peer, f, token=op == 'resume'):",
     '        if False:', 'test_other_screen_resume_rejected'),
    ('pause deadline extended by repeated STOP',
     "        if status == 'PAUSED' and not was_paused:",
     "        if status == 'PAUSED':", 'test_paused_deadline_cannot_extend_and_offline_timeout'),
]


def child(index, report):
    import pytest
    from foothold_agent.executor import scenario_run
    label, before, after, test = CASES[index]
    source = Path(scenario_run.__file__).read_text()
    assert source.count(before) == 1, label
    exec(compile(source.replace(before, after), scenario_run.__file__, 'exec'), scenario_run.__dict__)
    return pytest.main(['-q', '-p', 'no:cacheprovider', '-p', 'mutation_reporter',
                       '--link-mutation-report', report,
                       str(ROOT / 'tests/test_scenario_run.py') + '::' + test])


def main():
    scratch = ROOT.parents[1] / 'runs'
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='run-mutation-', dir=scratch) as folder:
        for index, (label, _, _, _) in enumerate(CASES):
            report = Path(folder) / (str(index) + '.json')
            result = subprocess.run([sys.executable, __file__, str(index), str(report)],
                                    env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'},
                                    capture_output=True, text=True, timeout=30)
            data = json.loads(report.read_text()) if report.exists() else {}
            if result.returncode != 1 or not data.get('assertions') or data.get('errors'):
                print(result.stdout, result.stderr)
                raise SystemExit('mutation was not detected cleanly: ' + label)
            print('DETECTED: ' + label)
    return 0


if __name__ == '__main__':
    raise SystemExit(child(int(sys.argv[1]), sys.argv[2]) if len(sys.argv) > 1 else main())

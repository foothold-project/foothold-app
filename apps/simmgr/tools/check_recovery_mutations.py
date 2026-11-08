"""Assert retained recovery guards in temporary copies, with no live runtime."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
MUTATIONS = (
    ('domain93-ignored', 'apps/simmgr/recovery.py', "row['domain'] == '93'", 'False'),
    ('running-slot-allowed', 'apps/simmgr/service.py', "row.state != 'ERROR'", 'False'),
    ('clean-latch-release', 'apps/simmgr/service.py', 'self.deployment_lease.release(False)', 'self.deployment_lease.release(True)'),
    ('native-target-proof-ignored', 'apps/simmgr/recovery.py', 'bool(base and target_zero)', 'bool(base)'),
    ('publish-attempt-unrecorded', 'apps/agent/tools/sim/target_recording.py', "self.value['attempts'] += 1", "self.value['attempts'] += 0"),
)


def main():
    results = []
    with tempfile.TemporaryDirectory(prefix='fh-recovery-mutations-') as directory:
        root = Path(directory)
        for part in ('apps/simmgr', 'apps/contracts', 'apps/agent/foothold_agent', 'apps/agent/tools/sim', 'deploy'):
            shutil.copytree(ROOT/part, root/part, ignore=shutil.ignore_patterns('__pycache__', '.pytest_cache'))
        env = {**os.environ, 'PYTHONPATH': str(root/'apps/agent')+os.pathsep+str(root),
               'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
        def run(name):
            report = root/(name+'.xml')
            result = subprocess.run([sys.executable, '-m', 'pytest', '-q',
                'apps/simmgr/tests/test_retained_recovery.py', 'deploy/tests/test_sim_retained.py',
                '--junitxml='+str(report)], cwd=root, env=env, capture_output=True, text=True, timeout=60)
            suites = ET.parse(report).getroot()
            return dict(exit=result.returncode, failures=len(suites.findall('.//failure')),
                        errors=len(suites.findall('.//error')))
        baseline = run('baseline')
        if baseline != dict(exit=0, failures=0, errors=0):
            raise RuntimeError('baseline failed: '+json.dumps(baseline))
        for name, relative, before, after in MUTATIONS:
            path = root/relative; original = path.read_text()
            if original.count(before) != 1:
                raise RuntimeError('mutation anchor not unique: '+name)
            path.write_text(original.replace(before, after))
            try:
                result = run(name)
                killed = result['exit']==1 and result['failures']>0 and result['errors']==0
                results.append(dict(mutation=name, killed=killed, **result))
            finally:
                path.write_text(original)
    print(json.dumps(dict(baseline=baseline, mutations=results), indent=2))
    return 0 if all(row['killed'] for row in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())

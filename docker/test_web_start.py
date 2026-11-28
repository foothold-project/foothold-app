"""Compose web start: npm ci -> prepare_sim (as node) -> npm run dev with FH_SIM_DIR.

Runs docker/web-start.sh with stub npm/runuser/python3 on PATH; Docker is never used.
A failing prepare_sim still starts the web, and localSim then serves the guide page.
"""
import json
from pathlib import Path
import re
import shutil
import subprocess

import pytest


REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY / 'docker/web-start.sh'


def stub(folder, name, body):
    path = folder / name
    path.write_text('#!/bin/sh\n' + body)
    path.chmod(0o755)


@pytest.fixture
def run(tmp_path):
    bin_dir, log = tmp_path / 'bin', tmp_path / 'calls.log'
    bin_dir.mkdir()
    stub(bin_dir, 'npm', f'echo "npm $* FH_SIM_DIR=${{FH_SIM_DIR:-}}" >> {log}\n')
    stub(bin_dir, 'runuser', f'echo "runuser $1 $2" >> {log}\nshift 3\nexec "$@"\n')
    stub(bin_dir, 'python3', f'echo "python3 $*" >> {log}\nexit ${{PREP_RC:-0}}\n')

    def start(rc=0):
        result = subprocess.run(['sh', str(SCRIPT)], capture_output=True, text=True, timeout=30,
            env={'PATH': f'{bin_dir}:/usr/bin:/bin', 'PREP_RC': str(rc)})
        return result, log.read_text().splitlines()
    return start


def test_start_order_and_sim_dir(run):
    result, calls = run()
    assert result.returncode == 0, result.stderr
    assert [c.split()[0] + ' ' + c.split()[1] for c in calls] == [
        'npm ci', 'runuser -u', 'python3 /workspace/deploy/prepare_sim.py', 'npm run']
    assert calls[1] == 'runuser -u node'  # non-root: prepare_sim refuses user-owned assets as root
    assert calls[2] == ('python3 /workspace/deploy/prepare_sim.py /workspace/mobile/sim '
                        '/workspace/sim-assets /tmp/fh-sim')
    assert calls[3] == 'npm run dev FH_SIM_DIR=/tmp/fh-sim/sim'


def test_prepare_failure_still_starts_web(run):
    result, calls = run(rc=3)
    assert result.returncode == 0
    assert calls[-1] == 'npm run dev FH_SIM_DIR=/tmp/fh-sim/sim'
    assert 'prepare_sim' in result.stderr and '/sim/' in result.stderr


@pytest.mark.skipif(shutil.which('node') is None, reason='node not installed')
def test_local_sim_serves_guide_when_prepared_folder_absent(tmp_path):
    """The existing localSim (apps/web/localsim.js, unchanged) on a FH_SIM_DIR that does not exist."""
    probe = f'''
import {{ localSim }} from {json.dumps(str(REPOSITORY / 'apps/web/localsim.js'))};
let handler; localSim({json.dumps(str(tmp_path / 'fh-sim/sim'))}).configureServer({{ middlewares: {{ use(h) {{ handler = h; }} }} }});
const res = {{ writeHead(s, h) {{ this.status = s; this.type = h['content-type']; }}, end(b) {{
  console.log(JSON.stringify({{ status: this.status, type: this.type, body: String(b) }})); }} }};
handler({{ url: '/sim/', method: 'GET' }}, res, () => console.log(JSON.stringify({{ next: true }})));
'''
    out = subprocess.run(['node', '--input-type=module', '-e', probe], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    page = json.loads(out.stdout)
    assert page['status'] == 404 and page['type'].startswith('text/html')
    assert '시뮬 파일이 없습니다' in page['body']


def test_compose_and_image_wire_the_start_script():
    compose = (REPOSITORY / 'compose.yaml').read_text()
    web = compose[compose.index('\n  web:'):compose.index('\nvolumes:')]
    mounts = re.findall(r'^\s+- (.+)$', web, re.M)
    assert './deploy/prepare_sim.py:/workspace/deploy/prepare_sim.py:ro' in mounts
    assert any(m.endswith(':/workspace/sim-assets:ro\'') or m.endswith(':/workspace/sim-assets:ro') for m in mounts)
    dockerfile = (REPOSITORY / 'docker/web.Dockerfile').read_text()
    assert 'python3' in dockerfile and 'docker/web-start.sh' in dockerfile
    assert re.search(r'^CMD \["sh", "/usr/local/bin/fh-web-start"\]$', dockerfile, re.M)

"""Compose web start: npm ci -> prepare_sim (as node) -> npm run dev with FH_SIM_DIR.

Runs docker/web-start.sh with stub npm/runuser/python3 on PATH; Docker is never used.
A failing prepare_sim still starts the web, and localSim then serves the guide page.
"""
import json
import os
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
    # PREP_PARTIAL: a crash after copying part of the simulator (e.g. an unreadable mesh).
    stub(bin_dir, 'python3', f'echo "python3 $*" >> {log}\n'
         '[ -n "$PREP_PARTIAL" ] && mkdir -p "$4/sim" && echo partial > "$4/sim/index.html" && echo partial > "$4/sim/go2.xml"\n'
         'exit ${PREP_RC:-0}\n')

    assets, out = tmp_path / 'sim-assets', tmp_path / 'fh-sim'
    assets.mkdir()
    (assets / 'policy_v2.f32').write_bytes(b'synthetic')

    def start(rc=0, partial=False):
        result = subprocess.run(['sh', str(SCRIPT)], capture_output=True, text=True, timeout=30,
            env={'PATH': f'{bin_dir}:/usr/bin:/bin', 'PREP_RC': str(rc), 'PREP_PARTIAL': '1' if partial else '',
                 'FH_SIM_ASSETS': str(assets), 'FH_SIM_OUT': str(out)})
        return result, log.read_text().splitlines() if log.exists() else []
    start.assets, start.out = assets, out
    return start


def test_start_order_and_sim_dir(run):
    result, calls = run()
    assert result.returncode == 0, result.stderr
    # runuser twice: the readability check, then prepare_sim; both as node.
    assert [c.split()[0] + ' ' + c.split()[1] for c in calls] == [
        'npm ci', 'runuser -u', 'runuser -u', 'python3 /workspace/deploy/prepare_sim.py', 'npm run']
    assert calls[1] == calls[2] == 'runuser -u node'  # non-root: prepare_sim refuses user-owned assets as root
    assert calls[3] == f'python3 /workspace/deploy/prepare_sim.py /workspace/mobile/sim {run.assets} {run.out}'
    assert calls[4] == f'npm run dev FH_SIM_DIR={run.out}/sim'


def test_prepare_failure_still_starts_web(run):
    result, calls = run(rc=3, partial=True)
    assert result.returncode == 0
    assert calls[-1] == f'npm run dev FH_SIM_DIR={run.out}/sim'
    assert 'prepare_sim' in result.stderr and '/sim/' in result.stderr
    # No half-copied simulator; /sim/ is a guide that says why.
    page = (run.out / 'sim/index.html').read_text()
    assert 'partial' not in page and 'prepare_sim' in page and sorted(p.name for p in (run.out / 'sim').iterdir()) == ['index.html']


def test_no_assets_skips_prepare_and_starts_web(run):
    """FH_SIM_ASSETS unset: compose mounts an empty volume; only /sim/ is missing."""
    run.assets.joinpath('policy_v2.f32').unlink()
    result, calls = run()
    assert result.returncode == 0
    assert [c.split()[0] for c in calls] == ['npm', 'npm'] and calls[-1] == f'npm run dev FH_SIM_DIR={run.out}/sim'
    assert 'FH_SIM_ASSETS' in result.stderr
    assert not (run.out / 'sim').exists()  # localSim shows its own guide page


def test_restart_without_assets_drops_previous_sim(run):
    """A simulator prepared on an earlier start must not outlive the assets that made it."""
    result, calls = run(partial=True)  # prepare_sim leaves a simulator in $OUT/sim
    assert result.returncode == 0 and (run.out / 'sim/go2.xml').exists()
    for path in run.assets.iterdir():
        path.unlink()
    result, calls = run()
    assert result.returncode == 0 and calls[-1] == f'npm run dev FH_SIM_DIR={run.out}/sim'
    assert not (run.out / 'sim').exists()  # localSim shows its own guide page, not the old simulator


@pytest.mark.skipif(hasattr(os, 'geteuid') and os.geteuid() == 0, reason='root reads 000 files')
def test_unreadable_assets_warn_on_sim_page(run):
    """Assets owned by another uid with mode 600 cannot be read by node (uid 1000) in the container."""
    secret = run.assets / 'policy_v2.f32'
    secret.chmod(0o000)
    try:
        result, calls = run()
    finally:
        secret.chmod(0o644)
    assert result.returncode == 0 and calls[-1] == f'npm run dev FH_SIM_DIR={run.out}/sim'
    assert not any(c.startswith('python3') for c in calls)
    assert '읽을 수 없' in result.stderr and '644' in result.stderr
    page = serve_sim(run.out / 'sim')
    assert page['status'] == 200 and page['type'].startswith('text/html')
    assert '읽을 수 없' in page['body'] and '644' in page['body'] and 'policy_v2' not in page['body']


def serve_sim(folder):
    """GET /sim/ through the existing localSim (apps/web/localsim.js, unchanged)."""
    if shutil.which('node') is None:
        pytest.skip('node not installed')
    probe = f'''
import {{ localSim }} from {json.dumps(str(REPOSITORY / 'apps/web/localsim.js'))};
import {{ Writable }} from 'node:stream';
let handler; localSim({json.dumps(str(folder))}).configureServer({{ middlewares: {{ use(h) {{ handler = h; }} }} }});
const chunks = [];
const res = new Writable({{ write(c, _e, done) {{ chunks.push(c); done(); }} }});
res.writeHead = function (s, h) {{ this.status = s; this.type = h['content-type']; }};
res.on('finish', () => console.log(JSON.stringify({{ status: res.status, type: res.type,
  body: Buffer.concat(chunks).toString() }})));
handler({{ url: '/sim/', method: 'GET' }}, res, () => console.log(JSON.stringify({{ next: true }})));
'''
    out = subprocess.run(['node', '--input-type=module', '-e', probe], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_local_sim_serves_guide_when_prepared_folder_absent(tmp_path):
    page = serve_sim(tmp_path / 'fh-sim/sim')
    assert page['status'] == 404 and page['type'].startswith('text/html')
    assert '시뮬 파일이 없습니다' in page['body']


def test_compose_and_image_wire_the_start_script():
    compose = (REPOSITORY / 'compose.yaml').read_text()
    web = compose[compose.index('\n  web:'):compose.index('\nvolumes:')]
    mounts = re.findall(r'^\s+- (.+)$', web, re.M)
    assert './deploy/prepare_sim.py:/workspace/deploy/prepare_sim.py:ro' in mounts
    assert any(m.endswith(':/workspace/sim-assets:ro\'') or m.endswith(':/workspace/sim-assets:ro') for m in mounts)
    # Checked-in policies sit where prepare_sim.py (mounted at /workspace/deploy) looks for them.
    assert './assets/sim-policy:/workspace/assets/sim-policy:ro' in mounts
    dockerfile = (REPOSITORY / 'docker/web.Dockerfile').read_text()
    assert 'python3' in dockerfile and 'docker/web-start.sh' in dockerfile
    assert re.search(r'^CMD \["sh", "/usr/local/bin/fh-web-start"\]$', dockerfile, re.M)


@pytest.mark.skipif(shutil.which('docker') is None, reason='docker not installed')
def test_compose_config_without_sim_assets(tmp_path):
    """No FH_SIM_ASSETS: the whole file still resolves; web gets an empty read-only volume."""
    env_file = tmp_path / 'synthetic.env'
    env_file.write_text('FH_DB_PASSWORD=synthetic\nFH_DATABASE_URL=postgresql://u:synthetic@db/x\n'
                        'FH_ORG_ID=00000000-0000-4000-8000-000000000001\nFH_BOOTSTRAP_PASSWORD=synthetic\n')
    env = {key: value for key, value in os.environ.items() if not key.startswith('FH_')}
    result = subprocess.run(['docker', 'compose', '--project-directory', str(REPOSITORY), '-f',
                             str(REPOSITORY / 'compose.yaml'), '--env-file', str(env_file), 'config', '--format', 'json'],
                            capture_output=True, text=True, timeout=60, env=env)
    assert result.returncode == 0, result.stderr
    web = json.loads(result.stdout)['services']['web']
    mount = next(v for v in web['volumes'] if v['target'] == '/workspace/sim-assets')
    assert mount['type'] == 'volume' and mount['read_only'] is True
    policy = next(v for v in web['volumes'] if v['target'] == '/workspace/assets/sim-policy')
    assert policy['type'] == 'bind' and policy['read_only'] is True
    assert Path(policy['source']) == REPOSITORY / 'assets/sim-policy'

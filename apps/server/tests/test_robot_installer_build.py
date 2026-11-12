"""Small offline builders test actual child processes, bounds and persistence."""
import os
from pathlib import Path
import subprocess
import sys
import time
import pytest

from apps.server.fh_server import robot_installer as R

ORIGIN = 'https://control.example.invalid'


def source(tmp_path, script=None):
    root = tmp_path / 'source'
    installer = root / 'apps/agent/installer'
    installer.mkdir(parents=True)
    (root / 'apps/agent/pyproject.toml').write_text('[project]\nversion="0.2.0"\n')
    (installer / 'build.py').write_text(script or '''import argparse,os,time
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--server');p.add_argument('--output',type=Path);p.add_argument('--version')
p.add_argument('--platform',default='linux')
a=p.parse_args()
assert 'FH_DATABASE_URL' not in os.environ
assert a.server == 'https://control.example.invalid'
time.sleep(.3)
name=f'foothold-robot_{a.version}_windows_amd64.zip' if a.platform=='windows' else f'foothold-robot_{a.version}_amd64.deb'
(a.output/name).write_bytes(b'fake built zip' if a.platform=='windows' else b'fake built deb')
''')
    return root


def manager(root, code, commit='1' * 40):
    return R.InstallerManager(root, code, commit, ORIGIN)


def wait(m):
    for process in m.children:
        assert process.wait(timeout=15) in (0, 1)


def test_single_flight_success_cached_and_unchanged_source_skipped(tmp_path, monkeypatch):
    code = source(tmp_path)
    root = tmp_path / 'state'
    monkeypatch.setenv('FH_DATABASE_URL', 'must-not-reach-child')
    first = manager(root, code)
    assert first.info()['items'][0]['reason'] == 'building'
    other = manager(root, code)
    assert other.info()['items'][0]['reason'] == 'building'
    assert not other.children
    wait(first)
    info = first.info()['items'][0]
    assert info['available'] is True and info['commit'] == '1' * 40
    assert len(first.children) == 0
    new = manager(root, code, '2' * 40)
    assert new.info()['items'][0] == info
    assert not new.children  # new dev SHA with no changed input: skip
    (code / 'apps/agent/new.py').write_text('# changed agent source')
    changed = manager(root, code, '3' * 40)
    # Last good file is served while the new build runs.
    assert changed.info()['items'][0] == info
    assert len(changed.children) == 2
    wait(changed)
    assert changed.info()['items'][0]['commit'] == '3' * 40
    assert (root / 'linux/previous/installer').is_file()


def test_failed_sha_not_retried_and_previous_success_kept(tmp_path):
    code = source(tmp_path)
    root = tmp_path / 'state'
    good = manager(root, code)
    good.info()
    wait(good)
    (code / 'apps/agent/installer/build.py').write_text('raise SystemExit(1)')
    failed = manager(root, code, '2' * 40)
    assert failed.info()['items'][0]['available']
    wait(failed)
    again = manager(root, code, '2' * 40)
    assert again.info()['items'][0]['commit'] == '1' * 40
    assert not again.children
    assert R.read_json(root / ('linux/attempts/' + '2' * 40 + '.json'))['reason'] == 'build_failed'


def test_failed_first_build_reason_and_dead_worker_never_retried(tmp_path):
    code = source(tmp_path, 'raise SystemExit(1)')
    root = tmp_path / 'state'
    m = manager(root, code)
    m.info()
    wait(m)
    again = manager(root, code)
    assert again.info()['items'][0]['reason'] == 'build_failed'
    assert not again.children
    R.atomic_json(root / ('linux/attempts/' + '1' * 40 + '.json'), {'reason': 'building'})
    assert manager(root, code).info()['items'][0]['reason'] == 'build_failed'


def test_missing_tools_disable_and_root_do_not_launch(tmp_path, monkeypatch):
    code = source(tmp_path)
    root = tmp_path / 'state'
    monkeypatch.setattr(R.shutil, 'which', lambda *args, **kwargs: None)
    m = manager(root, code)
    assert m.info()['items'][0]['reason'] == 'build_tools_missing'
    assert not m.children
    monkeypatch.setattr(R.shutil, 'which', lambda *args, **kwargs: '/usr/bin/tool')
    assert manager(root, code).info()['items'][0]['reason'] == 'build_tools_missing'
    monkeypatch.setattr(R.os, 'geteuid', lambda: 0)
    assert manager(root, code, '2' * 40).info()['items'][0]['reason'] == 'build_tools_missing'
    disabled = R.InstallerManager(tmp_path / 'off', code, '3' * 40, ORIGIN, enabled=False)
    assert disabled.info()['items'][0]['reason'] == 'disabled'
    assert not disabled.root.exists()


def test_time_and_disk_limits_kill_descendants(tmp_path):
    env = {'PATH': '/usr/bin:/bin'}
    for kind in ('time', 'disk'):
        root = tmp_path / kind
        root.mkdir()
        late = root / 'descendant-finished'
        script = ('import subprocess,sys,time; '
                  f'subprocess.Popen([sys.executable,"-c",{("import time;from pathlib import Path;time.sleep(1);Path(" + repr(str(late)) + ").touch()")!r}]); '
                  + (f'open({str(root / "full")!r},"wb").write(b"x"*300000); ' if kind == 'disk' else '')
                  + 'time.sleep(10)')
        result = R.bounded_run([sys.executable, '-c', script], root, env,
                               seconds=.3 if kind == 'time' else 5, byte_limit=200000)
        assert result == 'limit_exceeded'
        time.sleep(1.1)
        assert not late.exists()
    # Directory total, not merely individual file size, is bounded.
    root = tmp_path / 'total'
    root.mkdir()
    script = f'from pathlib import Path; import time; r=Path({str(root)!r}); [(r/str(i)).write_bytes(b"x"*60000) for i in range(3)];time.sleep(10)'
    assert R.bounded_run([sys.executable, '-c', script], root, env, 5, 100000) == 'limit_exceeded'


def test_build_failure_does_not_touch_deployment_state(tmp_path):
    code = source(tmp_path, 'raise SystemExit(1)')
    deployment = tmp_path / 'deployment'
    deployment.mkdir()
    for name in ('COMMIT', 'autodeploy.failed', 'deploys.log', 'deploy.lock'):
        (deployment / name).write_text('unchanged')
    m = manager(tmp_path / 'state', code)
    m.info()
    wait(m)
    assert {p.name: p.read_text() for p in deployment.iterdir()} == {
        name: 'unchanged' for name in ('COMMIT', 'autodeploy.failed', 'deploys.log', 'deploy.lock')}
    assert m.info()['items'][0]['reason'] == 'build_failed'


def test_source_preparation_failure_is_also_attempted_once(tmp_path):
    root = tmp_path / 'state'
    m = manager(root, tmp_path / 'missing-source')
    assert m.info()['items'][0]['reason'] == 'build_failed'
    # Even repairing the source under the same SHA must not trigger a build.
    code = source(tmp_path)
    again = manager(root, code)
    assert again.info()['items'][0]['reason'] == 'build_failed'
    assert not again.children


def test_unlinked_open_temporary_files_count_toward_disk_limit(tmp_path):
    # Two unlinked files are each below RLIMIT_FSIZE but together exceed it.
    script = (f'import tempfile,time; f=tempfile.TemporaryFile(dir={str(tmp_path)!r}); '
              f'g=tempfile.TemporaryFile(dir={str(tmp_path)!r}); '
              'f.write(b"x"*60000); f.flush();g.write(b"x"*60000);g.flush();time.sleep(10)')
    assert R.bounded_run([sys.executable, '-c', script], tmp_path,
                         {'PATH': '/usr/bin:/bin'}, 5, 100000) == 'limit_exceeded'


def test_windows_build_table_and_server_child_publish_zip(tmp_path):
    builder = R.BUILDERS['windows']
    assert builder.script == 'apps/agent/installer/build.py'
    assert builder.args == ('--platform', 'windows')
    assert builder.media_type == 'application/zip'
    assert R.DEFAULT_BYTES == 2 * 1024**3
    assert R.DEFAULT_SECONDS == 20 * 60
    code = source(tmp_path)
    m = manager(tmp_path/'state', code)
    assert m.platform_info('windows')['reason'] == 'building'
    wait(m)
    info, stream = m.current('windows')
    try:
        assert info['filename'] == 'foothold-robot_0.2.0+111111111111_windows_amd64.zip'
        assert info['available'] and info['platform'] == 'windows'
        assert stream.read() == b'fake built zip'
    finally:
        stream.close()
    assert m.platform_info('windows') == info
    assert len(m.children) == 1 and m.children[0].poll() == 0  # no second child


@pytest.mark.parametrize('platform', ['linux', 'windows'])
def test_platform_command_keeps_bounds_and_exact_server_output(tmp_path, monkeypatch, platform):
    code = source(tmp_path)
    root = tmp_path/'state'
    base = root/platform
    (base/'attempts').mkdir(parents=True)
    calls = []
    def run(command, state_root, env, seconds, byte_limit):
        calls.append((command, state_root, env, seconds, byte_limit))
        assert seconds == R.DEFAULT_SECONDS and byte_limit == R.DEFAULT_BYTES
        assert state_root == root and env['PIP_DISABLE_PIP_VERSION_CHECK'] == '1'
        output = Path(command[command.index('--output')+1])
        version = command[command.index('--version')+1]
        (output/R.BUILDERS[platform].filename.format(version=version)).write_bytes(b'fixture')
    monkeypatch.setattr(R, 'bounded_run', run)
    monkeypatch.setattr(R.os, 'nice', lambda amount: None)
    assert R.build_once(root, code, '1'*40, ORIGIN, platform, 'fingerprint') is None
    command = calls[0][0]
    assert command[command.index('--server')+1] == ORIGIN
    if platform == 'windows':
        assert command[command.index('--platform')+1] == 'windows'
    else:
        assert '--platform' not in command

"""Offline installer fixtures; subprocess builds are explicitly mocked on x86."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from types import SimpleNamespace

import pytest

DIRECTORY = Path(__file__).resolve().parents[1]/'installer'
sys.path.insert(0, str(DIRECTORY))
import jetson_bundle_common as common
import install_jetson_bundle as installer
import build_jetson_bundle as builder


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    directory = tmp_path/'bundle'
    (directory/'apps/agent/installer').mkdir(parents=True)
    (directory/'apps/agent/installer/jetson_autostart.py').write_text((DIRECTORY/'jetson_autostart.py').read_text())
    (directory/'sources').mkdir()
    (directory/'wheels').mkdir()
    source = directory/'sources/fake-source.tar.gz'
    source.write_bytes(b'fixture, not real source')
    wheel = directory/'wheels/pip-25.3-py3-none-any.whl'
    wheel.write_bytes(b'fixture, not a real wheel')
    lock = dict(wheels=[dict(name='pip', version='25.3', filename=wheel.name, sha256=common.digest(wheel))])
    (directory/'apps/agent/installer/jetson-wheels.lock.json').write_text(json.dumps(lock))
    monkeypatch.setattr(common, 'provenance', lambda _: SimpleNamespace(
        SOURCES={source.name: {'sha256': common.digest(source)}}))
    sums(directory)
    monkeypatch.setattr(installer, 'BUNDLE', directory)
    home = tmp_path/'fake-home'
    home.mkdir()
    monkeypatch.setenv('HOME', str(home))
    return directory, home, lock


def sums(bundle):
    (bundle/'SHA256SUMS').write_text(''.join(f'{common.digest(p)}  {p.relative_to(bundle)}\n'
        for p in sorted(bundle.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS'))


def test_plan_in_fake_home_is_readonly(bundle, monkeypatch):
    directory, home, _ = bundle
    monkeypatch.setattr(installer.subprocess, 'run', lambda *a, **kw: pytest.fail('plan executed subprocess'))
    assert installer.main(['--server', 'https://example.invalid']) == 0
    assert list(home.iterdir()) == []


@pytest.mark.parametrize('damage', ['hash', 'extra', 'symlink', 'traversal', 'incomplete', 'bad-wheel-lock'])
def test_bundle_rejects_modified_inputs(bundle, damage):
    directory, home, _ = bundle
    wheel = next((directory/'wheels').iterdir())
    if damage == 'hash':
        wheel.write_bytes(b'changed')
    elif damage == 'extra':
        (directory/'unlisted').write_text('not listed')
    elif damage == 'symlink':
        wheel.rename(directory.parent/'outside')
        wheel.symlink_to(directory.parent/'outside')
    elif damage == 'traversal':
        with (directory/'SHA256SUMS').open('a') as stream:
            stream.write('0'*64+'  ../outside\n')
    elif damage == 'incomplete':
        (directory/'INCOMPLETE').touch()
    else:
        lock = directory/'apps/agent/installer/jetson-wheels.lock.json'
        lock.write_text(lock.read_text().replace('25.3', '25.2'))
        sums(directory)
    assert installer.main(['--server', 'https://example.invalid']) == 2
    assert list(home.iterdir()) == []


@pytest.mark.parametrize('home_value', ['', None, 'relative'])
def test_home_empty_unset_relative_rejected(bundle, monkeypatch, home_value):
    _, home, _ = bundle
    if home_value is None:
        monkeypatch.delenv('HOME')
    else:
        monkeypatch.setenv('HOME', home_value)
    assert installer.main(['--server', 'https://example.invalid']) == 2
    assert list(home.iterdir()) == []


def test_existing_root_is_preserved(bundle):
    _, home, _ = bundle
    root = home/'foothold-robot'
    root.mkdir()
    (root/'keep').write_text('preserve')
    assert installer.main(['--server', 'https://example.invalid', '--install']) == 2
    assert (root/'keep').read_text() == 'preserve'


@pytest.mark.parametrize('port', sorted(installer.PROTECTED))
def test_protected_ports_rejected_without_bind(bundle, port):
    assert installer.main(['--server', 'https://example.invalid', '--port', str(port)]) == 2


def test_real_staging_and_mocked_build_install_stay_in_fake_home(bundle, monkeypatch):
    directory, home, lock = bundle
    root = home/'foothold-robot'
    calls = []
    monkeypatch.setattr(installer, 'bootstrap', lambda r, l, e: r/'venv/bin/python')
    monkeypatch.setattr(installer, 'build_sources', lambda r, p, e: calls.append(('mocked-ARM-build', str(r))))
    monkeypatch.setattr(installer, 'run', lambda argv, *a, **kw: calls.append(tuple(map(str, argv))))
    previous = os.umask(0o077)
    try:
        installer.install(directory, root, lock, installer.configuration('https://example.invalid', 'auto', 9539))
    finally:
        os.umask(previous)
    assert list(home.iterdir()) == [root]
    assert not (root/'INCOMPLETE').exists()
    assert (root/'connection.json').stat().st_mode & 0o777 == 0o600
    assert (root/'private').stat().st_mode & 0o777 == 0o700
    assert (root/'launch.py').is_file() and not (home/'.config').exists()
    assert '--onboard' in (root/'launch.py').read_text()
    assert 'Manual start only' not in (root/'launch.py').read_text()
    for action in ('enable', 'disable'):
        script = root/(action+'-autostart.sh')
        assert script.stat().st_mode & 0o777 == 0o700
        assert 'autostart.py' in script.read_text()
    assert not any(word in str(calls) for word in ('systemctl', 'sudo', 'apt', 'ssh'))
    assert '--write-receipt' in str(calls) and 'go2_direct.preflight' in str(calls)


def test_failed_build_keeps_incomplete_and_no_launcher(bundle, monkeypatch):
    directory, home, lock = bundle
    root = home/'foothold-robot'
    monkeypatch.setattr(installer, 'bootstrap', lambda *a: (_ for _ in ()).throw(ValueError('mock failure')))
    with pytest.raises(ValueError, match='mock failure'):
        installer.install(directory, root, lock, {})
    assert (root/'INCOMPLETE').exists() and not (root/'launch.py').exists()


def test_bootstrap_uses_without_pip_and_hashed_offline_wheel(bundle, monkeypatch):
    _, home, lock = bundle
    root = home/'foothold-robot'
    (root/'build').mkdir(parents=True)
    calls = []
    monkeypatch.setattr(installer, 'run', lambda argv, *a, **kw: calls.append(list(map(str, argv))))
    env = installer.child_environment(root)
    installer.bootstrap(root, lock, env)
    assert '--without-pip' in calls[0]
    assert '--no-index' in calls[1] and '--require-hashes' in calls[1] and '--no-deps' in calls[1]
    assert any(item.endswith('.whl') for item in calls[1])
    assert set(k for k in env if k.startswith('PIP_')) == {
        'PIP_CONFIG_FILE', 'PIP_NO_INDEX', 'PIP_DISABLE_PIP_VERSION_CHECK'}
    assert env['HOME'].startswith(str(root)) and env['TMPDIR'].startswith(str(root))
    assert not any(key in env for key in ('LD_LIBRARY_PATH', 'PYTHONPATH', 'CYCLONEDDS_HOME'))


def test_x86_real_install_refused_before_write(bundle):
    _, home, _ = bundle
    assert installer.main(['--server', 'https://example.invalid', '--install']) == 2
    assert list(home.iterdir()) == []


def test_unsafe_source_archive_rejected(tmp_path):
    archive = tmp_path/'source.tar'
    with tarfile.open(archive, 'w') as stream:
        member = tarfile.TarInfo('source/link')
        member.type = tarfile.SYMTYPE
        member.linkname = '/outside'
        stream.addfile(member)
    with pytest.raises(ValueError, match='unsafe'):
        common.unpack(archive, tmp_path/'extract')


def test_builder_plan_does_not_download_or_install(tmp_path, monkeypatch):
    monkeypatch.setattr(builder, 'REPO', tmp_path)
    monkeypatch.setattr(builder, 'download', lambda *a: pytest.fail('plan downloaded'))
    assert builder.main(['--output', str(tmp_path/'runs/new')]) == 0
    assert not (tmp_path/'runs').exists()


def test_install_shell_ignores_path_python_and_checks_system_version(tmp_path):
    script = tmp_path/'install.sh'
    script.write_text(builder.INSTALL_SH)
    fake_bin = tmp_path/'bin'
    fake_bin.mkdir()
    marker = tmp_path/'path-python-ran'
    fake_python = fake_bin/'python3'
    fake_python.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\nexit 99\n')
    fake_python.chmod(0o700)
    # A harmless stand-in proves whether version checking allowed dispatch;
    # it never invokes the real installer or builds anything.
    installer_script = tmp_path/'apps/agent/installer/install_jetson_bundle.py'
    installer_script.parent.mkdir(parents=True)
    installer_script.write_text('import sys; print("installer fixture", sys.argv[1:]); sys.exit(23)\n')
    home = tmp_path/'home'
    home.mkdir()
    system_is_310 = subprocess.run(['/usr/bin/python3', '-I', '-c',
        'import sys; sys.exit(0 if sys.version_info[:2] == (3, 10) else 1)']).returncode == 0
    result = subprocess.run(['/bin/sh', str(script), '--server', 'https://example.invalid'],
        env=dict(PATH=str(fake_bin)+':/usr/bin:/bin', HOME=str(home)), capture_output=True, text=True)
    assert not marker.exists()
    if system_is_310:
        assert result.returncode == 23
        assert "installer fixture ['--server', 'https://example.invalid']" in result.stdout
    else:
        assert result.returncode == 2
        assert '/usr/bin/python3의 판이 3.10이어야 합니다' in result.stderr
        assert 'installer fixture' not in result.stdout
    assert list(home.iterdir()) == []


def test_wheel_audit_ignores_vendored_distribution_metadata(tmp_path):
    import zipfile
    row = dict(name='rich-click', version='1.8.9', filename='rich_click-1.8.9-py3-none-any.whl')
    with zipfile.ZipFile(tmp_path/row['filename'], 'w') as wheel:
        wheel.writestr('rich_click-1.8.9.dist-info/METADATA',
                       'Name: rich-click\nVersion: 1.8.9\nRequires-Python: >=3.8\n')
        wheel.writestr('rich_click/_vendor/nested-1.0.dist-info/METADATA',
                       'Name: nested\nVersion: 1.0\nRequires-Dist: do-not-resolve-vendored-package\n')
    assert builder.audit_wheels(tmp_path, dict(wheels=[row]), tmp_path/'scratch.so') == []


def test_autostart_enable_disable_via_fake_systemctl(tmp_path):
    home = tmp_path/'fake-home'
    root = home/'foothold-robot'; root.mkdir(parents=True)
    (root/'launch.py').write_text('# fake launch; never invoked\n')
    (root/'autostart.py').write_text((DIRECTORY/'jetson_autostart.py').read_text())
    binary = tmp_path/'bin'; binary.mkdir()
    log = tmp_path/'systemctl-calls'
    fake = binary/'systemctl'
    fake.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n')
    fake.chmod(0o700)
    env = dict(os.environ, HOME=str(home), PATH=str(binary)+':/usr/bin:/bin', CALL_LOG=str(log))
    script = root/'autostart.py'
    result = subprocess.run([sys.executable, '-I', str(script), 'enable'], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout+result.stderr
    unit = home/'.config/systemd/user/foothold-robot.service'
    value = unit.read_text()
    for required in ('KillSignal=SIGINT', 'Restart=on-failure', 'RestartSec=20',
                     'StartLimitIntervalSec=600', 'StartLimitBurst=5', 'WantedBy=default.target',
                     'StandardOutput=append:%h/foothold-robot-run.log', '-I "'+str(root/'launch.py')+'"'):
        assert required in value
    assert log.read_text().splitlines() == ['--user daemon-reload', '--user reset-failed foothold-robot.service',
                                           '--user enable --now foothold-robot.service']
    (root/'private').mkdir(); key = root/'private/agent.json'; key.write_text('fake key')
    result = subprocess.run([sys.executable, '-I', str(script), 'disable'], env=env, capture_output=True, text=True)
    assert result.returncode == 0 and not unit.exists() and key.read_text() == 'fake key'
    assert log.read_text().splitlines()[-2:] == ['--user disable --now foothold-robot.service', '--user daemon-reload']
    assert 'sudo' not in value and 'linger' not in value


def test_autostart_failure_and_symlink_do_not_delete_unit(tmp_path, monkeypatch):
    import jetson_autostart as auto
    home = tmp_path/'fake-home'; root = home/'foothold-robot'; root.mkdir(parents=True)
    (root/'launch.py').touch()
    directory = home/'.config/systemd/user'; directory.mkdir(parents=True)
    unit = directory/auto.UNIT; unit.write_text('preserve on failed stop')
    monkeypatch.setenv('HOME', str(home))
    def failed(*args, **kwargs): raise subprocess.CalledProcessError(1, 'fake-systemctl')
    monkeypatch.setattr(auto.subprocess, 'run', failed)
    with pytest.raises(subprocess.CalledProcessError): auto.configure('disable', root)
    assert unit.read_text() == 'preserve on failed stop'
    unit.unlink(); unit.symlink_to(root/'launch.py')
    with pytest.raises(ValueError): auto.configure('enable', root)
    assert unit.is_symlink()


@pytest.mark.parametrize('name', ['foothold-robot', 'space % path'])
def test_autostart_unit_has_unquoted_working_directory_and_passes_systemd_verify(tmp_path, name):
    import jetson_autostart as auto
    root = tmp_path/name
    (root/'venv/bin').mkdir(parents=True)
    python = root/'venv/bin/python'
    python.write_text('#!/bin/sh\nexit 0\n')  # checked for existence, never executed
    python.chmod(0o700)
    (root/'launch.py').touch()
    text = auto.unit_text(root)
    working_directory = next(line for line in text.splitlines() if line.startswith('WorkingDirectory='))
    # Catch the regression even on platforms without systemd-analyze.
    assert working_directory == 'WorkingDirectory='+str(root).replace('%', '%%')
    assert working_directory.removeprefix('WorkingDirectory=').startswith('/')
    with pytest.raises(ValueError): auto.unit_text(Path('/fake/new\nline'))
    analyzer = shutil.which('systemd-analyze')
    if analyzer is None:
        return
    unit = tmp_path/auto.UNIT
    unit.write_text(text)
    home = tmp_path/'home'; home.mkdir()
    runtime = tmp_path/'runtime'; runtime.mkdir(mode=0o700)
    result = subprocess.run([analyzer, 'verify', '--user', '--generators=no', str(unit)],
        env=dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home/'.config'),
                 XDG_RUNTIME_DIR=str(runtime)), capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout+result.stderr


def test_autostart_working_directory_only_escapes_percent():
    import jetson_autostart as auto
    root = Path('/fake/space % $ " back\\slash')
    value = next(line for line in auto.unit_text(root).splitlines() if line.startswith('WorkingDirectory='))
    assert value == 'WorkingDirectory='+str(root).replace('%', '%%')


def test_installed_shell_wrappers_enable_disable_with_fake_systemctl(bundle, monkeypatch):
    directory, home, lock = bundle
    root = home/'foothold-robot'
    monkeypatch.setattr(installer, 'bootstrap', lambda r, l, e:r/'venv/bin/python')
    monkeypatch.setattr(installer, 'build_sources', lambda *a:None)
    monkeypatch.setattr(installer, 'run', lambda *a, **k:None)
    installer.install(directory, root, lock, installer.configuration('https://example.invalid', 'auto', 9570))
    binary = home/'bin'; binary.mkdir()
    fake = binary/'systemctl'; log = home/'calls'
    fake.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n'); fake.chmod(0o700)
    env = dict(os.environ, HOME=str(home), PATH=str(binary)+':/usr/bin:/bin', CALL_LOG=str(log))
    for action in ('enable', 'disable'):
        result = subprocess.run(['/bin/sh', str(root/(action+'-autostart.sh'))],
            cwd=directory, env=env, text=True, capture_output=True)
        assert result.returncode == 0, result.stdout+result.stderr
    assert '--user enable --now foothold-robot.service' in log.read_text()
    assert '--user disable --now foothold-robot.service' in log.read_text()
    assert not (home/'.config/systemd/user/foothold-robot.service').exists()

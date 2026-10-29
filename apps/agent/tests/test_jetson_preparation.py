"""Local fixtures only; do not install wheels or execute SDK/robot discovery."""
import hashlib
import importlib.util
from pathlib import Path

import pytest


def load(name):
    path = Path(__file__).resolve().parents[3]/'deploy/jetson'/f'{name}.py'
    spec = importlib.util.spec_from_file_location('jetson_'+name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load('install_offline')
preflight = load('preflight')


@pytest.fixture
def wheelhouse(tmp_path):
    path = tmp_path/'wheels'
    path.mkdir()
    locks = []
    for name, pin in installer.REQUIRED.items():
        wheel = path/f'{name.replace("-", "_")}-{pin}-py3-none-any.whl'
        # Intentionally NOT valid wheels: tests never execute pip or installation.
        wheel.write_bytes(('fake fixture '+name).encode())
        digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
        locks.append(f'{name}=={pin} --hash=sha256:{digest}')
    (path/'requirements.txt').write_text('\n'.join(locks)+'\n')
    manifest(path)
    return path


def manifest(path):
    (path/'SHA256SUMS').write_text(''.join(
        f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n'
        for p in sorted(path.iterdir()) if p.name != 'SHA256SUMS'))


def test_preflight_is_metadata_only_and_down_interface_does_not_pass():
    links = [dict(name='eth0', up=True, go2_subnet=True)]
    report = preflight.evaluate('aarch64', (3, 10), preflight.PINNED, links)
    assert report['ready_for_runtime_review']
    assert not report['motion_enabled'] and not report['robot_connected']
    assert not report['dds_runtime_verified'] and report['sdk_domain_planned'] == 0
    cases = [('x86_64', (3, 10), preflight.PINNED, links, False),
             ('aarch64', (3, 8), preflight.PINNED, links, False),
             ('aarch64', (3, 10), {}, links, False),
             ('aarch64', (3, 10), preflight.PINNED,
              [dict(name='eth0', up=False, go2_subnet=True)], False),
             ('aarch64', (3, 10), preflight.PINNED, links, True)]
    assert all(not preflight.evaluate(*args)['ready_for_runtime_review'] for args in cases)


def test_preflight_ip_failure_is_not_success(monkeypatch):
    def missing(*args, **kwargs):
        raise FileNotFoundError()
    monkeypatch.setattr(preflight.subprocess, 'run', missing)
    assert preflight.interfaces() == []


def test_plan_never_runs_subprocess_or_creates_venv(wheelhouse, tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('default plan must not execute anything')
    monkeypatch.setattr(installer.subprocess, 'run', forbidden)
    dest = tmp_path/'venv'
    assert installer.main(['--wheelhouse', str(wheelhouse), '--dest', str(dest)]) == 0
    assert not dest.exists()


def test_install_argv_is_offline_only_with_mocked_subprocess(wheelhouse, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(installer.subprocess, 'run', lambda argv, **kw: calls.append(argv))
    assert installer.main(['--wheelhouse', str(wheelhouse), '--dest', str(tmp_path/'venv'),
                           '--install']) == 0
    assert len(calls) == 3
    assert calls[0][-3:] == ['-m', 'venv', str(tmp_path/'venv')]
    assert '--no-index' in calls[1] and '--require-hashes' in calls[1]
    assert '--only-binary=:all:' in calls[1] and calls[2][-2:] == ['pip', 'check']
    assert not any('systemctl' in arg or 'unitree_sdk2py' in arg for cmd in calls for arg in cmd)


@pytest.mark.parametrize('damage', ['hash', 'symlink', 'unlisted', 'url', 'empty', 'pin'])
def test_reject_invalid_bundle(wheelhouse, damage):
    wheel = next(wheelhouse.glob('*.whl'))
    requirements = wheelhouse/'requirements.txt'
    if damage == 'hash':
        wheel.write_bytes(b'changed')
    elif damage == 'symlink':
        target = wheelhouse.parent/'outside.whl'
        wheel.rename(target)
        wheel.symlink_to(target)
    elif damage == 'unlisted':
        (wheelhouse/'unlisted.whl').write_bytes(b'x')
    else:
        if damage == 'url':
            requirements.write_text('package @ https://example.invalid/package.whl\n')
        elif damage == 'empty':
            requirements.write_text('')
        else:
            requirements.write_text(requirements.read_text().replace('numpy==1.26.4', 'numpy==2.0.0'))
        manifest(wheelhouse)
    with pytest.raises(ValueError):
        installer.checked_inputs(wheelhouse)


def test_existing_dest_is_preserved(wheelhouse, tmp_path):
    dest = tmp_path/'existing'
    dest.mkdir()
    sentinel = dest/'keep'
    sentinel.write_text('existing environment')
    assert installer.main(['--wheelhouse', str(wheelhouse), '--dest', str(dest), '--install']) == 2
    assert sentinel.read_text() == 'existing environment'

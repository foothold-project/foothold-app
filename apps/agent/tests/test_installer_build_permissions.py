"""Real deb permission checks; opt into a full build with a verified input cache."""
import importlib.util
import io
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tarfile

import pytest

AGENT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer_build', AGENT/'installer/build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def package_members(artifact):
    payload = subprocess.run(['dpkg-deb', '--fsys-tarfile', str(artifact)],
                             check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
        return archive.getmembers()


@pytest.mark.skipif(not shutil.which('dpkg-deb'), reason='requires dpkg-deb')
def test_private_stage_builds_readable_deb_without_relaxing_workspace(tmp_path):
    workspace = tmp_path/'work'
    workspace.mkdir(mode=0o700)
    stage = workspace/'stage'
    old_umask = os.umask(0o077)
    try:
        meta = stage/'DEBIAN'
        meta.mkdir(parents=True)
        (meta/'control').write_text('Package: permission-test\nVersion: 1.0\n'
                                   'Architecture: all\nMaintainer: Test <test@example.invalid>\n'
                                   'Description: permission regression fixture\n')
        opt = stage/'opt/foothold-robot'
        opt.mkdir(parents=True)
        (opt/'server.json').write_text('{}\n')
        launcher = opt/'launch'
        launcher.write_text('#!/bin/sh\nexit 0\n')
        launcher.chmod(0o700)
        cached = workspace/'input.whl'
        cached.write_bytes(b'private cached wheel')
        shutil.copy2(cached, opt/'input.whl')
        (opt/'private-link').symlink_to(cached)
        (opt/'directory-link').symlink_to(workspace, target_is_directory=True)
        # Exercise the exact pre-fix dpkg-deb failure before repairing the stage.
        artifact = workspace/'fixture.deb'
        command = ['dpkg-deb', '--root-owner-group', '--build', str(stage), str(artifact)]
        failed = subprocess.run(command, capture_output=True, text=True,
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        assert failed.returncode != 0
        assert 'control directory has bad permissions 700' in failed.stderr
        builder.normalize_stage_permissions(stage)
        subprocess.run(command, check=True, capture_output=True)
        assert os.umask(0o077) == 0o077
    finally:
        os.umask(old_umask)
    assert stat.S_IMODE(workspace.stat().st_mode) == 0o700
    assert stat.S_IMODE(cached.stat().st_mode) == 0o600
    assert stat.S_IMODE(meta.stat().st_mode) == 0o755
    assert stat.S_IMODE((meta/'control').stat().st_mode) == 0o644
    members = {m.name: m for m in package_members(artifact)}
    assert members['./opt/foothold-robot/launch'].mode == 0o755
    for name in ('server.json', 'input.whl'):
        assert members['./opt/foothold-robot/'+name].mode == 0o644
    assert members['./opt/foothold-robot/private-link'].issym()
    assert members['./opt/foothold-robot/directory-link'].issym()
    assert all(m.mode == 0o755 for m in members.values() if m.isdir())


@pytest.mark.skipif(not os.environ.get('FH_INSTALLER_TEST_CACHE'),
                    reason='set FH_INSTALLER_TEST_CACHE to run the full Linux build')
def test_full_linux_build_with_umask077_and_no_home(tmp_path):
    if platform.machine() != 'x86_64' or not shutil.which('dpkg-deb'):
        pytest.skip('requires Linux amd64 and dpkg-deb')
    checkout = tmp_path/'source'
    source = checkout/'apps/agent'
    shutil.copytree(AGENT, source, ignore=shutil.ignore_patterns(
        '__pycache__', '*.pyc', '*.egg-info', 'build'))
    output = checkout/'output/installer-test'
    output.mkdir(parents=True)
    (output/'cache').symlink_to(Path(os.environ['FH_INSTALLER_TEST_CACHE']).resolve(),
                               target_is_directory=True)
    result = subprocess.run(
        [sys.executable, str(source/'installer/build.py'), '--server',
         'https://control.example.invalid', '--output', str(output), '--version', '0.2.0+umask077'],
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, umask=0o077,
        capture_output=True, text=True, timeout=1200)
    assert result.returncode == 0, result.stdout+'\n'+result.stderr
    artifact = output/'foothold-robot_0.2.0+umask077_amd64.deb'
    listing = subprocess.run(['dpkg-deb', '-c', str(artifact)], check=True,
                             capture_output=True, text=True).stdout
    assert 'drwxr-xr-x root/root' in listing
    assert '-rwxr-xr-x root/root' in listing
    assert '-rw-r--r-- root/root' in listing
    members = {m.name: m for m in package_members(artifact)}
    opt = './opt/foothold-robot/'
    assert members[opt+'launch'].mode == 0o755
    assert members[opt+'python/bin/python3.10'].mode == 0o755
    assert members[opt+'server.json'].mode == 0o644
    assert members[opt+'extras.json'].mode == 0o644
    assert all(m.mode == (0o755 if m.isdir() or m.mode & 0o111 else 0o644)
               for name, m in members.items() if name.startswith('./opt/') and not m.issym())

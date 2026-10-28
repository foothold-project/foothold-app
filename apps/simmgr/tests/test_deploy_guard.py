"""Real flock/latch files only. No host state, user bus, or simulation."""
import fcntl
import os
import subprocess
import sys

import pytest

from apps.simmgr.deploy_guard import DeploymentLease


def contender(path):
    return subprocess.run([sys.executable, '-c',
        'import fcntl,os,sys; f=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',
        str(path / 'deploy.lock')], capture_output=True).returncode


def test_live_manager_and_unclean_exit(tmp_path):
    (tmp_path / 'deploy.lock').touch()
    (tmp_path / 'state').mkdir()
    lease = DeploymentLease(tmp_path)
    lease.acquire()
    assert contender(tmp_path) != 0
    lease.release(False)
    assert contender(tmp_path) == 0
    assert (tmp_path / 'state/unproven').exists()
    with pytest.raises(RuntimeError):
        DeploymentLease(tmp_path).acquire()
    assert (tmp_path / 'state/unproven').exists()


def test_clean_close_and_disabled(tmp_path):
    (tmp_path / 'deploy.lock').touch()
    (tmp_path / 'state').mkdir()
    lease = DeploymentLease(tmp_path)
    lease.acquire()
    lease.release(True)
    assert not (tmp_path / 'state/unproven').exists()
    assert contender(tmp_path) == 0
    DeploymentLease(None).acquire()


def test_deploy_blocks_manager(tmp_path):
    (tmp_path / 'deploy.lock').touch()
    (tmp_path / 'state').mkdir()
    fd = os.open(tmp_path / 'deploy.lock', os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(RuntimeError):
            DeploymentLease(tmp_path).acquire()
        assert not (tmp_path / 'state/unproven').exists()
    finally:
        os.close(fd)


@pytest.mark.parametrize('failure', ['none', 'startup', 'cleanup'])
def test_api_lifecycle_retains_latch_on_unproven_cleanup(tmp_path, monkeypatch, failure):
    from fastapi.testclient import TestClient
    from apps.simmgr.api import create_app
    from apps.simmgr.launcher import FakeLauncher
    from apps.simmgr.tests.test_manager import settings
    (tmp_path / 'deploy.lock').touch()
    (tmp_path / 'state').mkdir()
    monkeypatch.setenv('FH_SIM_DEPLOY_GUARD_DIR', str(tmp_path))
    def fail(*args):
        raise RuntimeError('unproven')
    if failure == 'startup':
        monkeypatch.setattr('apps.simmgr.api.startup_preflight', fail)
    class Launcher(FakeLauncher):
        async def close_world(self):
            if failure == 'cleanup':
                fail()
    app = create_app(settings(), Launcher())
    def run():
        with TestClient(app):
            assert contender(tmp_path) != 0
            assert (tmp_path / 'state/unproven').exists()
    if failure == 'none':
        run()
    else:
        with pytest.raises(RuntimeError, match='unproven'):
            run()
    assert (tmp_path / 'state/unproven').exists() == (failure != 'none')
    assert contender(tmp_path) == 0

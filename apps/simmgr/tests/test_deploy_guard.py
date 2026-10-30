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


def provision(tmp_path, monkeypatch):
    (tmp_path / 'deploy.lock').touch()
    (tmp_path / 'state').mkdir()
    monkeypatch.setenv('FH_SIM_DEPLOY_GUARD_DIR', str(tmp_path))


def test_idle_session_cleanup_and_next_sha(tmp_path, monkeypatch):
    import asyncio
    from uuid import uuid4
    from apps.simmgr.service import Manager
    from test_manager import settings
    provision(tmp_path, monkeypatch)
    async def run():
        manager = Manager(settings())
        assert contender(tmp_path) == 0  # idle manager admits deployment
        slot = next(iter(manager.settings.slots.values()))
        await manager.add('a', slot.robot_id, str(uuid4()), slot.org_id, 'x'*32, 1)
        assert contender(tmp_path) != 0
        assert (tmp_path / 'state/unproven').exists()
        await manager.close()
        assert contender(tmp_path) == 0
        assert not (tmp_path / 'state/unproven').exists()
    asyncio.run(run())


@pytest.mark.parametrize('failure', ['manager', 'launcher', 'cleanup'])
def test_session_failure_never_clears_latch(tmp_path, monkeypatch, failure):
    import asyncio
    from apps.simmgr.launcher import FakeLauncher
    from apps.simmgr.service import Manager
    from test_manager import settings
    provision(tmp_path, monkeypatch)
    class Launcher(FakeLauncher):
        failure = False
        async def close_world(self):
            if failure == 'cleanup':
                raise RuntimeError('unproven')
    async def run():
        launcher = Launcher()
        manager = Manager(settings(), launcher)
        await manager.start_world('a')
        manager.failed = failure == 'manager'
        launcher.failure = failure == 'launcher'
        if failure == 'cleanup':
            with pytest.raises(RuntimeError):
                await manager.close()
            manager.deployment_lease.release(False)  # process exit retains latch
        else:
            await manager.close()
        assert (tmp_path / 'state/unproven').exists()
        assert contender(tmp_path) == 0
    asyncio.run(run())


def test_precreation_resource_rejection_releases_lease(tmp_path, monkeypatch):
    import asyncio
    from apps.simmgr.launcher import FakeLauncher
    from apps.simmgr.preflight import ResourceGateError
    from apps.simmgr.service import Manager, SimError
    from test_manager import settings
    provision(tmp_path, monkeypatch)
    class Launcher(FakeLauncher):
        reject = True
        async def start_world(self, world):
            if self.reject:
                raise ResourceGateError()
    async def run():
        launcher = Launcher()
        manager = Manager(settings(), launcher)
        with pytest.raises(SimError) as error:
            await manager.start_world('a')
        assert error.value.detail['start_not_created'] is True
        assert not manager.failed and manager.world is None
        assert not (tmp_path / 'state/unproven').exists()
        assert contender(tmp_path) == 0
        launcher.reject = False
        await manager.start_world('a')
        assert contender(tmp_path) != 0
        await manager.close()
    asyncio.run(run())


def test_deployment_refusal_does_not_latch_manager(tmp_path, monkeypatch):
    import asyncio
    from apps.simmgr.service import Manager, SimError
    from test_manager import settings
    provision(tmp_path, monkeypatch)
    fd = os.open(tmp_path / 'deploy.lock', os.O_RDWR)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    async def run():
        manager = Manager(settings())
        with pytest.raises(SimError):
            await manager.start_world('a')
        assert not manager.failed and not manager.launcher.events
        assert not (tmp_path / 'state/unproven').exists()
    try:
        asyncio.run(run())
    finally:
        os.close(fd)


def test_user_unit_fixes_guard_after_private_env():
    from pathlib import Path
    unit = Path('deploy/foothold-simmgr.service').read_text()
    assert unit.index('EnvironmentFile=') < unit.index('Environment=FH_SIM_DEPLOY_GUARD_DIR=/var/lib/foothold-sim/guard')
    assert 'Restart=no' in unit
    assert 'ExecStart=/usr/bin/env FH_SIM_DEPLOY_GUARD_DIR=/var/lib/foothold-sim/guard ' in unit
    assert '/opt/foothold/current/.venv/bin/python -m apps.simmgr' in unit


def test_root_activation_latch_blocks_new_session(tmp_path):
    (tmp_path / 'deploy.lock').touch()
    (tmp_path / 'state').mkdir()
    (tmp_path / 'setup-unproven').touch()
    with pytest.raises(RuntimeError):
        DeploymentLease(tmp_path).acquire()
    assert (tmp_path / 'setup-unproven').exists()
    assert not (tmp_path / 'state/unproven').exists()
    assert contender(tmp_path) == 0


def test_package_transaction_latch_blocks_new_session(tmp_path, monkeypatch):
    from pathlib import Path
    original = Path.exists
    marker = Path('/var/lib/foothold/sim-packages-unproven')
    monkeypatch.setattr(Path, 'exists', lambda path: True if path == marker else original(path))
    (tmp_path / 'deploy.lock').touch()
    (tmp_path / 'state').mkdir()
    with pytest.raises(RuntimeError, match='package'):
        DeploymentLease(tmp_path).acquire()
    assert not (tmp_path / 'state/unproven').exists()
    assert contender(tmp_path) == 0


def test_package_release_barrier_blocks_without_original_name(tmp_path,monkeypatch):
    from pathlib import Path
    marker=Path('/var/lib/foothold/sim-packages-unproven.release-pending')
    original=Path.exists
    monkeypatch.setattr(Path,'exists',lambda path:True if path==marker else original(path))
    with pytest.raises(RuntimeError,match='package'):DeploymentLease(tmp_path).acquire()
    assert not (tmp_path/'state/unproven').exists()


def test_setup_release_barrier_blocks_without_original_name(tmp_path):
    (tmp_path/'state').mkdir();(tmp_path/'deploy.lock').touch()
    (tmp_path/'setup-unproven.release-pending').touch()
    with pytest.raises(RuntimeError):DeploymentLease(tmp_path).acquire()
    assert not (tmp_path/'state/unproven').exists()


@pytest.mark.parametrize('stage',['lock_open','lock_acquire','state_create'])
def test_access_error_preserves_stage_errno_without_private_logs_or_launch(tmp_path,monkeypatch,caplog,stage):
    import asyncio
    import errno
    from pathlib import Path
    from apps.simmgr import deploy_guard
    from apps.simmgr.service import Manager, SimError
    from test_manager import settings
    provision(tmp_path,monkeypatch)
    opened=os.open;flock=fcntl.flock
    def denied_open(path,*a,**kw):
        target=tmp_path/('deploy.lock' if stage=='lock_open' else 'state/unproven')
        if stage!='lock_acquire' and Path(path)==target:
            raise PermissionError(errno.EACCES,'private-token-and-detail','/secret/path')
        return opened(path,*a,**kw)
    def denied_lock(*_):raise PermissionError(errno.EACCES,'private-token-and-detail','/secret/path')
    async def run():
        manager=Manager(settings())
        with monkeypatch.context() as scoped:
            scoped.setattr(os,'open',denied_open)
            if stage=='lock_acquire':scoped.setattr(deploy_guard.fcntl,'flock',denied_lock)
            with pytest.raises(SimError) as caught:await manager.start_world('a')
        assert caught.value.status==503
        assert caught.value.detail=={'reason':'guard_access','start_not_created':True}
        assert manager.deployment_lease.fd is None
        assert manager.world is None and not manager.failed and not manager.launcher.events
        assert not (tmp_path/'state/unproven').exists()
        assert contender(tmp_path)==0
        await manager.close()
    asyncio.run(run())
    assert f'stage={stage} errno=13' in caplog.text
    assert 'private-token' not in caplog.text and '/secret/path' not in caplog.text
    assert str(tmp_path) not in caplog.text

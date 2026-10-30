"""Optional per-session deployment fence; unproven cleanup leaves a durable latch."""
import errno
import fcntl
import os
from pathlib import Path


class DeploymentGuardError(RuntimeError):
    """Fixed diagnostic labels, never the underlying exception text or path."""
    def __init__(self, stage, error):
        self.stage = stage
        self.errno = error.errno if isinstance(error, OSError) else None
        self.reason = 'guard_access' if self.errno in (errno.EACCES, errno.EPERM) else 'unknown'
        super().__init__('simulation deployment fence unavailable: ' + stage.replace('_', ' '))


class DeploymentLease:
    def __init__(self, directory):
        self.directory = Path(directory) if directory else None
        self.fd = None

    def acquire(self):
        if self.directory is None or self.fd is not None:
            return
        stage = 'host_package_proof'
        try:
            if 'FH_SIM_ROOTFS_LOCK' in os.environ:
                from .proc_proof import processes
                processes()  # prove the host package fence before opening guard
            stage = 'package_fence'
            packages = Path('/var/lib/foothold/sim-packages-unproven')
            package_pending = packages.with_name(packages.name+'.release-pending')
            if packages.exists() or packages.is_symlink() or package_pending.exists() or package_pending.is_symlink():
                raise RuntimeError('package transaction unproven')
            # Root owns the parent and lock inode. Runtime can only write state/.
            stage = 'lock_open'
            self.fd = os.open(self.directory / 'deploy.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
            stage = 'lock_acquire'
            fcntl.flock(self.fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            stage = 'host_package_recheck'
            if 'FH_SIM_ROOTFS_LOCK' in os.environ:
                processes()  # recheck under the admission lock
            stage = 'setup_fence'
            setup = self.directory / 'setup-unproven'
            setup_pending = setup.with_name(setup.name+'.release-pending')
            if setup.exists() or setup.is_symlink() or setup_pending.exists() or setup_pending.is_symlink():
                raise RuntimeError('initial activation unproven')
            stage = 'state_create'
            fd = os.open(self.directory / 'state/unproven', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        except (OSError, RuntimeError) as error:
            self.release(False)
            raise DeploymentGuardError(stage, error) from None
        except BaseException:
            self.release(False)
            raise

    def release(self, clean):
        if self.fd is not None:
            try:
                if clean:
                    (self.directory / 'state/unproven').unlink()
            finally:
                os.close(self.fd)
                self.fd = None

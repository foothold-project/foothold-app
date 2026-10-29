"""Optional per-session deployment fence; unproven cleanup leaves a durable latch."""
import fcntl
import os
from pathlib import Path


class DeploymentLease:
    def __init__(self, directory):
        self.directory = Path(directory) if directory else None
        self.fd = None

    def acquire(self):
        if self.directory is None or self.fd is not None:
            return
        if 'FH_SIM_ROOTFS_LOCK' in os.environ:
            from .proc_proof import processes
            processes()  # host package fence must be proven, not inferred in chroot
        packages = Path('/var/lib/foothold/sim-packages-unproven')
        package_pending=packages.with_name(packages.name+'.release-pending')
        if packages.exists() or packages.is_symlink() or package_pending.exists() or package_pending.is_symlink():
            raise RuntimeError('package transaction unproven')
        # Root owns the parent and lock inode. Runtime can only write state/.
        self.fd = os.open(self.directory / 'deploy.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            if 'FH_SIM_ROOTFS_LOCK' in os.environ:
                processes()  # recheck after locking against a root preparation race
            setup = self.directory / 'setup-unproven'
            setup_pending=setup.with_name(setup.name+'.release-pending')
            if setup.exists() or setup.is_symlink() or setup_pending.exists() or setup_pending.is_symlink():
                raise RuntimeError('initial activation unproven')
            fd = os.open(self.directory / 'state/unproven', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        except BaseException:
            self.release(False)
            raise RuntimeError('simulation deployment fence unavailable') from None

    def release(self, clean):
        if self.fd is not None:
            try:
                if clean:
                    (self.directory / 'state/unproven').unlink()
            finally:
                os.close(self.fd)
                self.fd = None

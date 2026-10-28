"""Optional server deployment fence. An unclean exit retains the durable latch."""
import fcntl
import os
from pathlib import Path


class DeploymentLease:
    def __init__(self, directory):
        self.directory = Path(directory) if directory else None
        self.fd = None

    def acquire(self):
        if self.directory is None:
            return
        # Provisioned by root. Never create/replace the lock inode at runtime.
        self.fd = os.open(self.directory / 'deploy.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            fd = os.open(self.directory / 'state/unproven', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        except BaseException:
            self.release(False)
            raise RuntimeError('simulation deployment fence unavailable; manual audit required') from None

    def release(self, clean):
        if self.fd is not None:
            try:
                if clean:
                    (self.directory / 'state/unproven').unlink()
            finally:
                os.close(self.fd)
                self.fd = None

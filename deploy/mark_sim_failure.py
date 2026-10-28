"""Create a root-only activation latch without opening any runtime-owned leaf."""
import os
from pathlib import Path
import stat
import sys

GUARD = Path('/var/lib/foothold-sim/guard')


def mark(guard=GUARD):
    parent = os.open(guard, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(parent)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('activation latch directory untrusted')
        fd = os.open('setup-unproven', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=parent)
        try:
            os.write(fd, b'activation-failed\n')
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(parent)
    finally:
        os.close(parent)


if __name__ == '__main__':
    try:
        if os.geteuid() != 0 or len(sys.argv) != 1:
            raise ValueError('server root only')
        mark()
    except Exception:
        raise SystemExit('Activation latch could not be recorded safely; retain deployment lock and escalate') from None

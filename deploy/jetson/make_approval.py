#!/usr/bin/env python3
"""Create an expiring local field marker only; never imports SDK or starts I/O."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import time


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--nic', required=True)
    parser.add_argument('--serial', required=True, help='confirmed LowState uint32-uint32')
    parser.add_argument('--minutes', type=int, default=15, choices=range(1, 31))
    parser.add_argument('--approve-field-motion', action='store_true', required=True,
                        help='operator confirms separate field authorization')
    args = parser.parse_args(argv)
    try:
        path = args.output
        parent = path.parent.stat()
        if (not path.is_absolute() or path.parent.is_symlink() or parent.st_uid != os.getuid()
                or stat.S_IMODE(parent.st_mode) & 0o077 or not stat.S_ISDIR(parent.st_mode)):
            raise ValueError('absolute new path in an owned private directory required')
        if (not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', args.nic) or
                not re.fullmatch(r'(0|[1-9][0-9]{0,9})-(0|[1-9][0-9]{0,9})', args.serial) or
                len(args.serial) < 4 or any(int(x) > 0xFFFFFFFF for x in args.serial.split('-'))):
            raise ValueError('explicit NIC and canonical DDS serial required')
        value = dict(v=1, purpose='go2-field-motion', nic=args.nic,
                     robot_serial=args.serial, expires_at=time.time()+args.minutes*60)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as target:
            json.dump(value, target)
            target.flush()
            os.fsync(target.fileno())
        print('Field marker created only; SDK, robot connection and service start: NONE')
        return 0
    except (OSError, ValueError):
        print('Field marker refused; check new private path, NIC and confirmed DDS serial', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

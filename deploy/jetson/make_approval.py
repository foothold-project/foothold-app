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
    identity = parser.add_mutually_exclusive_group(required=True)
    identity.add_argument('--serial', help='confirmed LowState uint32-uint32')
    identity.add_argument('--serial-unavailable', action='store_true', help='confirmed LowState 0-0; explicit server trial only')
    parser.add_argument('--robot-mac', help='confirmed canonical unicast MAC on dedicated robot NIC')
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
        regular = (args.serial is not None and args.robot_mac is None and
                re.fullmatch(r'(0|[1-9][0-9]{0,9})-(0|[1-9][0-9]{0,9})', args.serial) and
                len(args.serial) >= 4 and all(int(x) <= 0xFFFFFFFF for x in args.serial.split('-')))
        fallback = (args.serial_unavailable and isinstance(args.robot_mac,str) and
                re.fullmatch(r'[0-9a-f]{2}(?::[0-9a-f]{2}){5}',args.robot_mac) and
                args.robot_mac != '00:00:00:00:00:00' and not int(args.robot_mac[:2],16)&1)
        if (not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', args.nic) or not (regular or fallback)):
            raise ValueError('explicit NIC and canonical DDS serial required')
        value = dict(v=1, purpose='go2-field-motion', nic=args.nic,
                     robot_serial=args.serial, expires_at=time.time()+args.minutes*60)
        if fallback:
            value.update(robot_serial=None, serial_unavailable=True, robot_mac=args.robot_mac)
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

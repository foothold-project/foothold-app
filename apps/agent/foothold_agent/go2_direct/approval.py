"""Operator-owned, expiring field marker; not a phone credential or motion lease."""

import json
import os
import re
import stat
import time
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Approval:
    nic: str
    robot_serial: str | None
    expires_at: float
    serial_unavailable: bool = False
    robot_mac: str | None = field(default=None, repr=False)


def validate(env, *, now=None, uid=None):
    """Validate before any SDK import. A marker does NOT authorize live deployment."""
    if env.get('FH_GO2_DIRECT_ENABLED') != '1':
        raise PermissionError('Go2 direct adapter is disabled')
    nic = env.get('FH_GO2_DIRECT_NIC', '')
    if not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}', nic):
        raise ValueError('explicit robot NIC required')
    path = env.get('FH_GO2_FIELD_APPROVAL', '')
    if not os.path.isabs(path):
        raise PermissionError('absolute field approval path required')
    uid = os.getuid() if uid is None else uid
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != uid or
                stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1 or st.st_size > 4096):
            raise PermissionError('field approval must be owned, private, single-link regular file')
        value = json.loads(os.read(fd, 4097))
    finally:
        os.close(fd)
    now = time.time() if now is None else now
    if not isinstance(value, dict):
        raise PermissionError('field approval must be an object')
    expiry = value.get('expires_at')
    serial = value.get('robot_serial')
    unavailable = value.get('serial_unavailable', False)
    mac = value.get('robot_mac')
    fallback = (unavailable is True and 'robot_serial' in value and serial is None
                and isinstance(mac, str) and re.fullmatch(r'[0-9a-f]{2}(?::[0-9a-f]{2}){5}', mac)
                and mac != '00:00:00:00:00:00' and not int(mac[:2], 16) & 1)
    regular = (unavailable is False and mac is None and isinstance(serial, str)
               and re.fullmatch(r'[A-Za-z0-9_-]{4,80}', serial))
    if (type(value.get('v')) is not int or value.get('v') != 1 or
            value.get('purpose') != 'go2-field-motion' or
            value.get('nic') != nic or not (fallback or regular) or
            type(expiry) not in (int, float) or not now < expiry <= now+1800):
        raise PermissionError('field approval is invalid or expired')
    return Approval(nic, serial, float(expiry), bool(fallback), mac)

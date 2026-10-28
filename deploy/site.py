"""Derive API/phone Origins from one private site setting, without echoing config."""
from pathlib import Path
import json
import os
import re
import secrets
import shlex
import stat


def read_private(path):
    # Called only with fixed root-administered /etc paths. Never follow leaves.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o027:
            raise ValueError('private site configuration ownership invalid')
        data = stream.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError('private site configuration exceeds bound')
    return dict(line.split('=', 1) for line in shlex.split(data, comments=True)), info


def replace_private(path, config, info):
    tmp = path.with_name('.site-' + secrets.token_hex(16))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            for key, value in config.items():
                if not re.fullmatch('[A-Z_][A-Z0-9_]*', key) or '\x00' in value or '\n' in value:
                    raise ValueError('private environment value invalid')
                stream.write(f'{key}={shlex.quote(value)}\n')
            stream.flush()
            os.fsync(stream.fileno())
        # Refuse a replacement by another writer instead of silently overwriting it.
        current = path.lstat()
        if (current.st_ino, current.st_dev, current.st_mtime_ns) != (info.st_ino, info.st_dev, info.st_mtime_ns):
            raise ValueError('private environment changed during update')
        tmp.replace(path)
        directory = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        tmp.unlink(missing_ok=True)


def update(root=Path('/etc/foothold'), manager=Path('/etc/foothold-sim/manager.env')):
    site = read_private(root / 'site.env')[0]['FH_SITE']
    if (len(site) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', site)
            or '..' in site):
        raise ValueError('private site must be a plain hostname')
    origin = 'https://' + site
    path = root / 'server.env'
    config, info = read_private(path)
    # Validate both files before updating either. Missing manager is bootstrap mode.
    try: sim, sim_info = read_private(manager)
    except FileNotFoundError: sim = None
    config['FH_WS_ORIGIN'] = origin
    if sim is not None:
        sim['FOOTHOLD_PHONE_ORIGINS'] = json.dumps([origin], separators=(',', ':'))
        replace_private(manager, sim, sim_info)
    replace_private(path, config, info)


def main():
    if os.geteuid() != 0:
        raise PermissionError('root site update required')
    update()


if __name__ == '__main__':
    main()

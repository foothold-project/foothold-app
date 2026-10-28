"""Derive the API Origin from the single site setting; run before activation."""
from pathlib import Path
import os
import shlex


def main():
    path = Path('/etc/foothold/server.env')
    site = dict(line.split('=', 1) for line in shlex.split(Path('/etc/foothold/site.env').read_text()))['FH_SITE']
    config = dict(line.split('=', 1) for line in shlex.split(path.read_text()))
    config['FH_WS_ORIGIN'] = 'https://' + site
    tmp = path.with_suffix('.next')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        for key, value in config.items():
            stream.write(f'{key}={shlex.quote(value)}\n')
    os.chown(tmp, path.stat().st_uid, path.stat().st_gid)
    tmp.replace(path)


if __name__ == '__main__':
    main()

"""Root deployment-only idle manager transition; no simulator or robot commands."""
import json
import os
from pathlib import Path
import pwd
import shlex
import stat
import subprocess
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, ProxyHandler, build_opener
from uuid import UUID

GUARD = Path('/var/lib/foothold-sim/guard')
PACKAGE_LATCH = Path('/var/lib/foothold/sim-packages-unproven')
CURRENT = Path('/opt/foothold/current')
UNIT = 'foothold-simmgr.service'


def userctl(*args):
    uid = pwd.getpwnam('foothold-sim').pw_uid
    if uid == 0:
        raise ValueError('invalid simulation identity')
    return subprocess.run(['runuser', '-u', 'foothold-sim', '--', '/usr/bin/env', '-i',
        'PATH=/usr/bin:/bin', f'XDG_RUNTIME_DIR=/run/user/{uid}',
        f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus',
        'systemctl', '--user', *args], check=True, capture_output=True, text=True, timeout=190).stdout


def state():
    return dict(line.split('=', 1) for line in userctl('show', UNIT,
        '--property=LoadState,ActiveState,MainPID,ControlGroup').splitlines() if '=' in line)


def no_latch():
    if PACKAGE_LATCH.exists() or PACKAGE_LATCH.is_symlink():
        raise ValueError('package transaction unproven')
    for name in ('state/unproven', 'setup-unproven'):
        path = GUARD / name
        if path.exists() or path.is_symlink():
            raise ValueError('cleanup unproven')


def private_read(path, owner, modes):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or stat.S_IMODE(info.st_mode) not in modes:
            raise ValueError('untrusted simulation configuration')
        return stream.read(65537)


def ready():
    # Private env contains paths, not secret values. Credential copies belong
    # separately to API and simulation UIDs; never source an env file as root.
    config = dict(word.split('=', 1) for word in shlex.split(
        private_read('/etc/foothold-sim/manager.env', 0, (0o640,))))
    uid = pwd.getpwnam('foothold-sim').pw_uid
    secret = private_read(config['FH_SIM_AUTH_FILE'], uid, (0o600,)).strip()
    catalog = json.loads(private_read(config['FH_SIM_CATALOG'], 0, (0o640,)))
    org = str(UUID(catalog['slots'][0]['org_id']))
    request = Request('http://127.0.0.1:9430/v1/worlds?' + urlencode({'org_id': org}),
                      headers={'Authorization': 'Bearer ' + secret})
    opener = build_opener(ProxyHandler({}))
    with opener.open(request, timeout=2) as response:
        body = json.loads(response.read(65536))
    UUID(body['manager_instance_id'])
    if body['launcher'] != 'native-single' or body['max_robots'] != 1:
        raise ValueError('native-single manager required')


def stop():
    no_latch()
    before = state()
    if before.get('LoadState') != 'loaded' or before.get('ActiveState') not in ('active', 'inactive', 'failed'):
        raise ValueError('manager state unavailable')
    userctl('stop', UNIT)
    after = state()
    if after.get('ActiveState') != 'inactive' or after.get('MainPID') != '0':
        raise ValueError('manager exit unproven')
    group = before.get('ControlGroup')
    if group:
        if not group.startswith('/') or '..' in Path(group).parts:
            raise ValueError('invalid manager cgroup')
        events = Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.events'
        try:
            populated = dict(line.split() for line in events.read_text().splitlines())['populated']
        except FileNotFoundError:
            pass
        else:
            if populated != '0':
                raise ValueError('manager cgroup still populated')
    no_latch()


def same_release(pid):
    return Path(f'/proc/{pid}/cwd').resolve(strict=True) == CURRENT.resolve(strict=True)


def start():
    no_latch()
    # The user unit's fixed WorkingDirectory/ExecStart/PYTHONPATH all use current.
    # Stop first, even on rollback, to avoid adopting an older live manager.
    stop()
    userctl('start', UNIT)
    for attempt in range(30):
        try:
            running = state()
            pid = int(running.get('MainPID', '0'))
            if running.get('ActiveState') == 'active' and pid > 0:
                if not same_release(pid):
                    raise ValueError('manager release differs from API')
                ready()
                return
        except Exception:
            pass
        time.sleep(1)
    raise ValueError('simulation manager readiness failed')


if __name__ == '__main__':
    try:
        if os.geteuid() != 0 or sys.argv[1:] not in (['stop'], ['start']):
            raise ValueError('usage: root sim_control.py start|stop')
        {'stop': stop, 'start': start}[sys.argv[1]]()
    except Exception:
        raise SystemExit('simulation transition failed; private details suppressed') from None

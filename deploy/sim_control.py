"""Root deployment-only idle manager transition; no simulator or robot commands."""
import fcntl
import hashlib
import tempfile
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shlex
import stat
import subprocess
import sys
import time
import importlib
import types
from urllib.parse import urlencode
from urllib.request import Request, ProxyHandler, build_opener
from uuid import UUID

GUARD = Path('/var/lib/foothold-sim/guard')
LATCH_RELEASE_PROTOCOL=2
PACKAGE_LATCH = Path('/var/lib/foothold/sim-packages-unproven')
CURRENT = Path('/opt/foothold/current')
UNIT = 'foothold-simmgr.service'
ROOTFS_CONFIG = Path('/etc/foothold-sim/rootfs-runtime.json')


def rootfs_runtime():
    if __package__:
        return importlib.import_module('.rootfs_runtime',__package__)
    # The reviewed root-owned tools directory is not named as a Python package.
    # Give its relative imports a private package, never a runtime/user path.
    name='_foothold_deploy_tools'
    if name not in sys.modules:
        package=types.ModuleType(name)
        package.__path__=[str(Path(__file__).resolve().parent)]
        sys.modules[name]=package
    return importlib.import_module(name+'.rootfs_runtime')


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
    pending=PACKAGE_LATCH.with_name(PACKAGE_LATCH.name+'.release-pending')
    if PACKAGE_LATCH.exists() or PACKAGE_LATCH.is_symlink() or pending.exists() or pending.is_symlink():
        raise ValueError('package transaction unproven')
    for name in ('state/unproven', 'setup-unproven'):
        path = GUARD / name
        if path.exists() or path.is_symlink():
            raise ValueError('cleanup unproven')
        pending=path.with_name(path.name+'.release-pending')
        if pending.exists() or pending.is_symlink():raise ValueError('cleanup release unproven')


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


def stop_manager(fence=no_latch):
    fence()
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
    fence()


def same_release(pid):
    if ROOTFS_CONFIG.exists() or ROOTFS_CONFIG.is_symlink():
        runtime=rootfs_runtime()
        return runtime.attest(pid,runtime.load())
    return Path(f'/proc/{pid}/cwd').resolve(strict=True) == CURRENT.resolve(strict=True)


def start_manager():
    # The user unit's fixed WorkingDirectory/ExecStart/PYTHONPATH all use current.
    # Stop first, even on rollback, to avoid adopting an older live manager.
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


def stop():
    no_latch()
    if ROOTFS_CONFIG.exists() or ROOTFS_CONFIG.is_symlink():
        return rootfs_runtime().stop_pair(stop_manager,userctl)
    return stop_manager()


def start():
    no_latch()
    if ROOTFS_CONFIG.exists() or ROOTFS_CONFIG.is_symlink():
        return rootfs_runtime().start_pair(start_manager)
    stop()
    return start_manager()


DEPLOY_LOCK = Path('/var/lib/foothold/deploy.lock')
AUDITS = Path('/var/lib/foothold')


def recovery_module():
    path = CURRENT.resolve(strict=True) / 'apps/simmgr/recovery.py'
    for parent in (path, *path.parents):
        info = parent.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ValueError('untrusted recovery code')
    spec = importlib.util.spec_from_file_location('_retained_recovery', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def retained_latch():
    # This command recovers a retained episode, never a package/setup transaction.
    for marker in (PACKAGE_LATCH, GUARD / 'setup-unproven'):
        if marker.exists() or marker.is_symlink():
            raise ValueError('non-episode recovery required')
    for marker in (PACKAGE_LATCH, GUARD/'setup-unproven', GUARD/'state/unproven'):
        pending = marker.with_name(marker.name + '.release-pending')
        if pending.exists() or pending.is_symlink():
            raise ValueError('latch release pending')
    path = GUARD / 'state/unproven'
    uid = pwd.getpwnam('foothold-sim').pw_uid
    content = private_read(path, uid, (0o600,))
    if len(content.encode()) > 65536:
        raise ValueError('retained latch exceeds proof bound')
    info = path.lstat()
    return (info.st_dev, info.st_ino, hashlib.sha256(content.encode()).hexdigest())


def prepare_retained():
    config = dict(word.split('=', 1) for word in shlex.split(
        private_read('/etc/foothold-sim/manager.env', 0, (0o640,))))
    uid = pwd.getpwnam('foothold-sim').pw_uid
    secret = private_read(config['FH_SIM_AUTH_FILE'], uid, (0o600,)).strip()
    request = Request('http://127.0.0.1:9430/v1/recovery/retain-stop', data=b'',
                      headers={'Authorization': 'Bearer ' + secret}, method='POST')
    with build_opener(ProxyHandler({})).open(request, timeout=15) as response:
        body = json.loads(response.read(65536))
    if body.get('prepared') is not True or body.get('slots') != 'error-or-empty':
        raise ValueError('retained admission closure unconfirmed')


def stop_retained():
    runtime = rootfs_runtime()
    recovery = recovery_module()
    # Keep ordinary deploy/recovery mutually exclusive without taking the sim EX
    # lock that the retained manager's SH lease prevents us from acquiring.
    lock = os.open(DEPLOY_LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    guard_lock = None
    audit_fd = None
    record = dict(schema=1, operation='stop-retained', complete=False)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        guard_lock = os.open(GUARD/'deploy.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        fcntl.flock(guard_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        original = retained_latch()
        audit_fd, _ = tempfile.mkstemp(prefix='sim-retained-', suffix='.json', dir=AUDITS)
        directory_fd = os.open(AUDITS, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        def save():
            os.lseek(audit_fd, 0, os.SEEK_SET)
            os.ftruncate(audit_fd, 0)
            os.write(audit_fd, json.dumps(record).encode())
            os.fsync(audit_fd)
        save()  # Evidence storage must work before admission or service changes.
        def fence():
            if retained_latch() != original:
                raise ValueError('retained latch changed')
        def absence(stopped=False):
            reader = importlib.import_module(runtime.__package__ + '.proc_proof_server').process_rows
            return recovery.absence(reader, (lambda *args: '') if stopped else userctl,
                lambda: runtime.run(['ss', '-H', '-lntu']))
        before = state()
        if before.get('ActiveState') != 'active' or not same_release(int(before.get('MainPID', '0'))):
            raise ValueError('live reviewed manager required')
        record['before'] = absence()
        prepare_retained()
        fence()
        record['prepared'] = absence()
        save()
        def retained_ctl(*args):
            if args and args[0] == 'list-units':
                # Inert retained unit bookkeeping has no child to signal. The
                # normal namespace stop reaps it after independent fresh proof.
                absence()
                return ''
            return userctl(*args)
        transition_started = False
        def failure_fence():
            if not transition_started:
                return
            # An unavailable proof alone never fabricates a new failure marker.
            # Existing session latch remains the conservative admission fence.
            try:
                data = runtime.load()
                uid, _ = runtime.identity(data)
                residual = runtime.dedicated_pids(uid)
            except Exception:
                return
            if residual and not (GUARD/'setup-unproven').exists():
                runtime.create_install_latch(GUARD/'setup-unproven')
        def final_fence():
            nonlocal transition_started
            fence()
            absence()
            transition_started = True
        runtime.stop_pair(lambda: stop_manager(final_fence), retained_ctl, failure_fence=failure_fence)
        record['after'] = absence(stopped=True)
        fence()
        fcntl.flock(guard_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        record['complete'] = True
    finally:
        try:
            if audit_fd is not None:
                try:
                    save()
                finally:
                    os.close(audit_fd)
        finally:
            if guard_lock is not None:
                os.close(guard_lock)
            os.close(lock)


if __name__ == '__main__':
    try:
        args = sys.argv[1:]
        if os.geteuid() != 0:
            raise ValueError('root required')
        if len(args) in (2, 4) and args[0] == 'audit':
            print(json.dumps(recovery_module().audit(*args[1:])))
        elif args in (['stop'], ['start'], ['stop-retained']):
            {'stop': stop, 'start': start, 'stop-retained': stop_retained}[args[0]]()
        else:
            raise ValueError('usage: root sim_control.py start|stop|stop-retained|audit EPISODE')
    except Exception:
        raise SystemExit('simulation transition failed; private details suppressed') from None

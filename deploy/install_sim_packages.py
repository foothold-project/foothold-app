"""Install a separately reviewed private apt transaction lock, never latest.

The lock lists the entire resolved dependency closure as name/version/sha256;
apt metadata must already be signature-verified by apt-get update. No repository
or key is added here. --check performs simulation only; --install additionally
downloads, checks archive hashes and installs with --no-upgrade.
"""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

PROTECTED = re.compile(r'(nvidia|cuda|dcgm|rpcbind|mesa|libegl|libgl(?!ib)|libgbm|libvulkan)', re.I)
NEW_FORBIDDEN = re.compile(r'(nvidia|^linux-|dkms|firmware|cuda|dcgm|rpcbind|^datacenter-gpu-manager|^lib(?:cublas|nvrtc|npp|cufft|curand|cusolver|cusparse|nvjpeg)|^glx-diversions)', re.I)
INSTALL_LATCH = Path('/var/lib/foothold/sim-packages-unproven')
JOURNAL = None
SIMULATIONS = 0
NAME = re.compile(r'[a-z0-9][a-z0-9+.-]*(?::amd64)?\Z')
VERSION = re.compile(r'[0-9][a-zA-Z0-9.+:~_-]*\Z')


def run(*args):
    global SIMULATIONS
    result = subprocess.run(args, check=False, capture_output=True, text=True)
    if JOURNAL is not None and args[0] == 'apt-get' and '--simulate' in args:
        SIMULATIONS += 1
        (JOURNAL / ('simulate-' + str(SIMULATIONS) + '.txt')).write_text(result.stdout + result.stderr)
    result.check_returncode()
    return result.stdout


def upstream(version):
    return re.sub(r'\+(?:ds|dfsg)[0-9]*$', '', version.split(':')[-1].split('-')[0])


def validate_lock(rows, requirements):
    locked = {}
    if not isinstance(rows, list) or not rows or len(rows) > 2000:
        raise ValueError('invalid package closure')
    for row in rows:
        if set(row) != {'name', 'version', 'sha256'}:
            raise ValueError('invalid package fields')
        name, version, sha = (row[k] for k in ('name', 'version', 'sha256'))
        if not NAME.fullmatch(name) or not VERSION.fullmatch(version) or not re.fullmatch('[0-9a-f]{64}', sha):
            raise ValueError('invalid package identity')
        if name in locked:
            raise ValueError('duplicate package')
        locked[name] = row
        expected = requirements.get(name)
        if name.startswith('ros-jazzy-nav2-'):
            expected = '1.3.13'
        if name.startswith(('libprotobuf', 'protobuf-', 'python3-protobuf')):
            expected = '3.21.12'
        if expected and upstream(version) != expected:
            raise ValueError('upstream version differs from approved plan')
    if not set(requirements) <= set(locked):
        raise ValueError('required direct pin missing')
    return locked


def validate_simulation(output, locked):
    changes = []
    for line in output.splitlines():
        if line.startswith(('Remv ', 'Purg ')):
            raise ValueError('package removal forbidden')
        if not line.startswith('Inst '):
            continue
        match = re.match(r'Inst (\S+)(?: \[([^]]+)\])? \((\S+)', line)
        if not match:
            raise ValueError('unknown apt simulation format')
        name, installed, version = match.groups()
        if installed is not None:
            if PROTECTED.search(name):
                raise ValueError('existing GPU/GL/DCGM/rpcbind package change forbidden')
            raise ValueError('existing package change forbidden')
        if NEW_FORBIDDEN.search(name):
            raise ValueError('new driver/kernel/CUDA/DCGM/rpcbind package forbidden')
        if name not in locked or locked[name]['version'] != version:
            raise ValueError('unlocked transitive dependency')
        changes.append(name)
    return changes


def installed_versions():
    output = run('dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${db:Status-Status}\n')
    result = {}
    for line in output.splitlines():
        name, version, status = line.split('\t')
        name = name.removesuffix(':amd64')
        if status not in ('not-installed', 'config-files'):
            result[name] = (version, status)
    return result


def verify_installed(locked, installed, require_all=False):
    for name, row in locked.items():
        actual = installed.get(name.removesuffix(':amd64'))
        if actual is None:
            if require_all:
                raise ValueError('locked package not installed')
        elif actual != (row['version'], 'installed'):
            raise ValueError('installed version/status differs from lock; no upgrade allowed')


def metadata_sha(name, version):
    records = run('apt-cache', 'show', name + '=' + version).strip().split('\n\n')
    hashes = set()
    for record in records:
        fields = dict(line.split(': ', 1) for line in record.splitlines() if ': ' in line and not line.startswith(' '))
        if fields.get('Version') == version and fields.get('SHA256'):
            hashes.add(fields['SHA256'])
    if len(hashes) != 1:
        raise ValueError('exact package SHA unavailable in verified apt metadata')
    return hashes.pop()


def ensure_no_install_latch(path=INSTALL_LATCH):
    if path.exists() or path.is_symlink():
        raise ValueError('previous package transaction unproven; manual audit required')


def latch_parent(path):
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if info.st_uid != 0 or info.st_mode & 0o022:
        os.close(fd)
        raise ValueError('package latch directory untrusted')
    return fd


def create_install_latch(path=INSTALL_LATCH):
    parent = latch_parent(path)
    try:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=parent)
        try:
            os.write(fd, b'package-transaction-pending\n')
            os.fsync(fd)
            info = os.fstat(fd)
            identity = (info.st_dev, info.st_ino)
        finally:
            os.close(fd)
        os.fsync(parent)
        return identity
    finally:
        os.close(parent)


def clear_install_latch(identity, path=INSTALL_LATCH):
    parent = latch_parent(path)
    try:
        info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        if ((info.st_dev, info.st_ino) != identity or not stat.S_ISREG(info.st_mode)
                or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError('package latch identity changed')
        os.unlink(path.name, dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(parent)


def verify_gl_owners():
    if Path('/usr/bin/nvidia-uninstall').exists() or Path('/var/log/nvidia-installer.log').exists():
        raise ValueError('non-package NVIDIA installer indicator present; manual audit required')
    cache = run('ldconfig', '-p')
    owners = {}
    for name in ('libEGL_nvidia.so.0','libGLX_nvidia.so.0','libEGL.so.1',
                 'libGLX.so.0','libGLdispatch.so.0','libOpenGL.so.0'):
        paths = {line.split('=>', 1)[1].strip() for line in cache.splitlines()
                 if line.strip().startswith(name + ' ') and '=>' in line}
        if not paths and 'nvidia' in name:
            raise ValueError('NVIDIA rendering library absent')
        for path in paths:
            real = str(Path(path).resolve(strict=True))
            try:
                ownership = run('dpkg-query', '-S', real).strip()
            except subprocess.CalledProcessError:
                raise ValueError('existing NVIDIA/GL file owner unknown; installation forbidden') from None
            if not ownership:
                raise ValueError('existing NVIDIA/GL file owner unknown; installation forbidden')
            owners[real] = ownership
    return owners


def host_snapshot():
    services = {}
    for unit in ('nvidia-dcgm.service', 'foothold-server.service', 'caddy.service',
                 'postgresql.service', 'postgresql@16-main.service'):
        text = run('systemctl', 'show', unit,
            '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStartTimestampMonotonic')
        info = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
        if info.get('LoadState') != 'loaded' or info.get('ActiveState') != 'active':
            raise ValueError('required existing service not active')
        if unit != 'postgresql.service' and int(info.get('MainPID', '0')) <= 0:
            raise ValueError('required service process absent')
        if unit == 'nvidia-dcgm.service' and info.get('MainPID') != '719':
            raise ValueError('DCGM PID differs from approved baseline')
        services[unit] = info
    dcgm = Path('/proc/719/stat').read_text().rsplit(')', 1)[1].split()[19]
    gpu = run('nvidia-smi', '--query-gpu=driver_version,name,uuid', '--format=csv,noheader')
    return dict(services=services, dcgm_pid=719, dcgm_start_ticks=dcgm, gpu=gpu)


def verify_host_unchanged(before, after):
    if after != before:
        raise ValueError('protected GPU/DCGM/service identity changed; stop and escalate')


def install(lock_path, commit=False):
    fd = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or not stat.S_ISREG(info.st_mode):
            raise ValueError('lock must be root-owned 0600')
        rows = json.load(stream)
    if JOURNAL is not None:
        (JOURNAL / 'lock.json').write_text(json.dumps(rows, sort_keys=True) + '\n')
    requirements = json.loads(Path(__file__).with_name('sim-package-versions.json').read_text())
    locked = validate_lock(rows, requirements)
    verify_installed(locked, installed_versions())
    for name, row in locked.items():
        if metadata_sha(name, row['version']) != row['sha256']:
            raise ValueError('apt metadata SHA differs from reviewed lock')
    specs = [name + '=' + row['version'] for name, row in sorted(locked.items())]
    command = ['apt-get', '--no-upgrade', '--no-install-recommends', 'install', *specs]
    changes = validate_simulation(run(*command[:1], '--simulate', *command[1:]), locked)
    print('Simulation accepted: new packages=' + str(len(changes)) + ', existing changes=0, driver/DCGM/rpcbind changes=0')
    if not commit:
        return
    # Keep needrestart in list-only mode: do not restart unrelated services.
    os.environ.update(DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l')
    run(*command[:1], '--download-only', '--yes', *command[1:])
    downloaded = {}
    for path in Path('/var/cache/apt/archives').glob('*.deb'):
        name = run('dpkg-deb', '-f', str(path), 'Package').strip()
        version = run('dpkg-deb', '-f', str(path), 'Version').strip()
        if name in locked and version == locked[name]['version']:
            if hashlib.sha256(path.read_bytes()).hexdigest() != locked[name]['sha256']:
                raise ValueError('downloaded archive SHA mismatch')
            downloaded[name] = path
    if not set(changes) <= set(downloaded):
        raise ValueError('downloaded transaction incomplete')
    # Vendor ABI must be proven from these exact downloaded archives first.
    try:
        from .verify_gz_abi import verify
    except ImportError:
        from verify_gz_abi import verify
    verify(downloaded)
    # Resolve once more immediately before installation; no changed transaction.
    if validate_simulation(run(*command[:1], '--simulate', *command[1:]), locked) != changes:
        raise ValueError('apt transaction changed after download')
    transaction = create_install_latch()
    run(*command[:1], '--yes', *command[1:])
    verify_installed(locked, installed_versions(), require_all=True)
    print('Pinned package transaction installed; final host proof pending; simulator not started')
    return transaction


if __name__ == '__main__':
    try:
        if os.geteuid() != 0 or len(sys.argv) != 3 or sys.argv[1] not in ('--check', '--install'):
            raise ValueError('usage: server root install_sim_packages.py --check|--install private-lock.json')
        if sys.argv[1] == '--install':
            raise ValueError('system apt installation disabled; use reviewed private sysroot workflow')
        ensure_no_install_latch()
        os.umask(0o077)
        JOURNAL = Path(tempfile.mkdtemp(prefix='foothold-sim-packages-', dir='/root'))
        # Serialize against automatic deployment, and refuse any active episode.
        with open('/var/lib/foothold/deploy.lock', 'a') as deployment_lock:
            fcntl.flock(deployment_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            guard_fd = None
            guard = Path('/var/lib/foothold-sim/guard')
            if guard.exists() or guard.is_symlink():
                guard_fd = os.open(guard / 'deploy.lock', os.O_RDWR | os.O_NOFOLLOW)
                fcntl.flock(guard_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if any((guard / name).exists() or (guard / name).is_symlink() for name in ('state/unproven', 'setup-unproven')):
                    raise ValueError('simulation cleanup unproven')
            (JOURNAL / 'dpkg-before.txt').write_text(run('dpkg-query', '-W', '-f=${binary:Package}=${Version}\n'))
            # Installed tools must honor the persistent package fence first.
            for name in ('common.sh','autodeploy.sh','deploy.sh','rollback.sh','prepare-release.sh','sim_control.py'):
                if Path(__file__).with_name(name).read_bytes() != (Path('/opt/foothold/deploy-tools') / name).read_bytes():
                    raise ValueError('install reviewed deployment tools before package transaction')
            (JOURNAL / 'gl-owners-before.json').write_text(json.dumps(verify_gl_owners(), sort_keys=True))
            baseline = host_snapshot()
            (JOURNAL / 'host-before.json').write_text(json.dumps(baseline, sort_keys=True))
            transaction = install(sys.argv[2], sys.argv[1] == '--install')
            after = host_snapshot()
            (JOURNAL / 'host-after.json').write_text(json.dumps(after, sort_keys=True))
            verify_host_unchanged(baseline, after)
            (JOURNAL / 'gl-owners-after.json').write_text(json.dumps(verify_gl_owners(), sort_keys=True))
            (JOURNAL / 'dpkg-after.txt').write_text(run('dpkg-query', '-W', '-f=${binary:Package}=${Version}\n'))
            if transaction is not None:
                clear_install_latch(transaction)
            if guard_fd is not None:
                os.close(guard_fd)
    except Exception as error:
        if JOURNAL is not None:
            try:
                (JOURNAL / 'host-after.json').write_text(json.dumps(host_snapshot(), sort_keys=True))
                (JOURNAL / 'dpkg-after.txt').write_text(run('dpkg-query', '-W', '-f=${binary:Package}=${Version}\n'))
            except Exception:
                pass
            (JOURNAL / 'failure.txt').write_text(type(error).__name__ + ': ' + str(error))
        # Deliberately omit command output, private paths, env and exception text.
        raise SystemExit('Pinned package check/install refused; retain private evidence and escalate (' + type(error).__name__ + ')') from None

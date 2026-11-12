"""On-demand, unprivileged installer builds; no deploy tool or robot runtime calls.

The child receives a clean environment, a fixed release source, and only its own
single-flight fd. Source is copied under state so build.py's output guard stays
intact. Public files are immutable; switching current is one atomic rename.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import tomllib
from urllib.parse import urlsplit

PLATFORMS = ('linux', 'windows')
SHA = re.compile(r'^[0-9a-f]{40}$')
VERSION = re.compile(r'^[0-9][a-zA-Z0-9.+~-]*$')
REASONS = {'not_built', 'building', 'build_failed', 'disabled', 'build_tools_missing',
           'limit_exceeded', 'invalid_artifact', 'not_supported_yet'}
# Includes the cache, build workspace and two retained packages. One GiB can
# stop an otherwise valid rebuild once the first successful package is kept.
DEFAULT_BYTES = 2 * 1024 ** 3
DEFAULT_SECONDS = 20 * 60
SOURCE_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Builder:
    script: str
    filename: str
    media_type: str
    args: tuple[str, ...] = ()


# Keep platform commands and filenames fixed, never manifest-controlled.
BUILDERS = {
    'linux': Builder('apps/agent/installer/build.py', 'foothold-robot_{version}_amd64.deb',
                     'application/vnd.debian.binary-package'),
    'windows': Builder('apps/agent/installer/build.py',
                       'foothold-robot_{version}_windows_amd64.zip',
                       'application/zip', ('--platform', 'windows')),
}


def commit_at(source):
    try:
        value = (source / 'COMMIT').read_text().strip()
        return value if SHA.fullmatch(value) else None
    except OSError:
        return None


def origin_valid(origin):
    try:
        p = urlsplit(origin or '')
        return (p.scheme == 'https' and p.hostname and not p.username and not p.password
                and p.path in ('', '/') and not p.query and not p.fragment
                and not any(c.isspace() for c in origin))
    except ValueError:
        return False


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.next')
    with temporary.open('w') as stream:
        json.dump(value, stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def read_json(path):
    with path.open() as stream:
        return json.loads(stream.read(8193))


def source_digest(source, origin):
    h = hashlib.sha256(origin.rstrip('/').encode())
    agent = source / 'apps/agent'
    if not agent.is_dir():
        raise FileNotFoundError('agent source absent')
    for path in sorted(agent.rglob('*')):
        if any(part in ('__pycache__', '.venv', 'build') or part.endswith('.egg-info')
               for part in path.relative_to(agent).parts) or path.suffix == '.pyc':
            continue
        if path.is_symlink():
            raise ValueError('agent input symlink')
        if path.is_file():
            h.update(str(path.relative_to(source)).encode() + b'\0')
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(block)
    project = source / 'pyproject.toml'
    if project.is_file():
        h.update(b'pyproject.toml\0' + project.read_bytes())
    return h.hexdigest()


def disk_bytes(root, process_group=None):
    total = 0
    seen = set()
    def count(info):
        nonlocal total
        key = (info.st_dev, info.st_ino)
        if stat.S_ISREG(info.st_mode) and key not in seen:
            seen.add(key)
            total += info.st_size
    for directory, _, files in os.walk(root, followlinks=False):
        for name in files:
            try:
                info = (Path(directory) / name).lstat()
                count(info)
            except FileNotFoundError:
                pass
    if process_group is not None:
        # dpkg-deb may unlink its temporary archive while keeping the fd open;
        # directory sizes alone miss that disk use. Inspect only our group.
        for process in Path('/proc').iterdir():
            if not process.name.isdigit():
                continue
            try:
                fields = (process / 'stat').read_text().rsplit(')', 1)[1].split()
                if int(fields[2]) != process_group:
                    continue
                for fd in (process / 'fd').iterdir():
                    try:
                        info = fd.stat()
                        if info.st_nlink == 0:
                            count(info)
                    except OSError:
                        pass
            except (OSError, ValueError, IndexError):
                pass
    return total


def terminate(process):
    # Every builder has a separate process group; kill descendants as well.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def bounded_run(command, root, env, seconds=DEFAULT_SECONDS, byte_limit=DEFAULT_BYTES):
    if disk_bytes(root) >= byte_limit:
        return 'limit_exceeded'
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (byte_limit, byte_limit))
    # No builder stdout is retained: addresses, pip output and logs cannot fill
    # the state volume or leak into HTTP responses/journal.
    process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               start_new_session=True, preexec_fn=limits)
    deadline = time.monotonic() + seconds
    try:
        while True:
            result = process.poll()
            if time.monotonic() >= deadline or disk_bytes(root, process.pid) >= byte_limit:
                return 'limit_exceeded'
            if result is not None:
                return None if result == 0 else 'build_failed'
            time.sleep(0.25)
    finally:
        # Also reap descendants surviving a successful/failed parent exit.
        terminate(process)


def snapshot(base, platform):
    """Open the fixed artifact before returning headers, avoiding replace races."""
    builder = BUILDERS.get(platform)
    if not builder:
        return None
    try:
        target = os.readlink(base / 'current')
        if not re.fullmatch(r'releases/[0-9a-f]{40}', target):
            raise ValueError('invalid current pointer')
        directory = base / target
        if directory.is_symlink() or (base / 'releases').is_symlink():
            raise ValueError('invalid release directory')
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            meta_fd = os.open('info.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            with os.fdopen(meta_fd) as stream:
                info = json.loads(stream.read(8193))
            from apps.contracts.models import RobotInstallerAvailable
            info = RobotInstallerAvailable.model_validate(info).model_dump(mode='json')
            if (info['platform'] != platform or info['commit'] != target.split('/')[1]
                    or info['filename'] != builder.filename.format(version=info['version'])):
                raise ValueError('invalid artifact metadata')
            artifact_fd = os.open('installer', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            stream = os.fdopen(artifact_fd, 'rb')
            details = os.fstat(stream.fileno())
            if not stat.S_ISREG(details.st_mode) or details.st_size != info['size']:
                stream.close()
                raise ValueError('invalid artifact size')
            return info, stream
        finally:
            os.close(fd)
    except FileNotFoundError:
        return None


class InstallerManager:
    def __init__(self, root, source, commit, origin, *, enabled=True):
        self.root, self.source = Path(root), Path(source)
        self.commit, self.origin, self.enabled = commit, origin, enabled
        self.lock = threading.Lock()
        self.children = []
        self.fingerprint = None

    def unavailable(self, platform, reason):
        return {'platform': platform, 'available': False, 'reason': reason}

    def current(self, platform):
        return snapshot(self.root / platform, platform)

    def info(self):
        with self.lock:
            self.children = [child for child in self.children if child.poll() is None]
            return {'items': [self.platform_info(p) for p in PLATFORMS]}

    def platform_info(self, platform):
        if not self.enabled:
            return self.unavailable(platform, 'disabled')
        if platform not in BUILDERS:
            return self.unavailable(platform, 'not_supported_yet')
        try:
            current = self.current(platform)
        except (OSError, ValueError):
            return self.unavailable(platform, 'invalid_artifact')
        try:
            reason = self.schedule(platform, current[0] if current else None)
            return current[0] if current else self.unavailable(platform, reason)
        finally:
            if current:
                current[1].close()

    def schedule(self, platform, current):
        if not self.commit or not SHA.fullmatch(self.commit) or not origin_valid(self.origin):
            return 'not_built'
        base = self.root / platform
        try:
            base.mkdir(parents=True, exist_ok=True, mode=0o700)
            lock_fd = os.open(base / 'build.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        except OSError:
            return 'build_failed'
        attempt = None
        try:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 'building'
            attempts = base / 'attempts'
            attempts.mkdir(exist_ok=True)
            attempt = attempts / (self.commit + '.json')
            if attempt.exists():
                record = read_json(attempt)
                status = record.get('reason') if isinstance(record, dict) else None
                # A building record without its lock means the process died.
                return status if isinstance(status, str) and status in REASONS - {'building'} else 'build_failed'
            self.fingerprint = self.fingerprint or source_digest(self.source, self.origin)
            if current and (base / 'current/source.sha256').read_text() == self.fingerprint:
                return 'not_built'  # caller serves unchanged successful artifact
            reason = 'building'
            if (os.geteuid() == 0 or not shutil.which('python3', path='/usr/bin:/bin')
                    or (platform == 'linux' and not shutil.which('dpkg-deb', path='/usr/bin:/bin'))
                    or not (self.source / BUILDERS[platform].script).is_file()):
                reason = 'build_tools_missing'
            atomic_json(attempt, {'reason': reason})
            if reason != 'building':
                return reason
            # The child retains only this platform lock, never deployment locks,
            # credentials, sessions or database configuration from the API.
            command = [sys.executable, str(Path(__file__).resolve()), 'build',
                       '--root', str(self.root), '--source', str(self.source),
                       '--commit', self.commit, '--server', self.origin,
                       '--platform', platform, '--fingerprint', self.fingerprint,
                       '--lock-fd', str(lock_fd)]
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
            try:
                child = subprocess.Popen(command, env=env, pass_fds=(lock_fd,),
                                         start_new_session=True, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.children.append(child)
            except OSError:
                atomic_json(attempt, {'reason': 'build_failed'})
                return 'build_failed'
            return 'building'
        except (OSError, ValueError):
            # A damaged input/source marker is still a failed attempt for this
            # SHA; polling must not repeatedly re-run preparation either.
            if attempt is not None and not attempt.exists():
                try:
                    atomic_json(attempt, {'reason': 'build_failed'})
                except OSError:
                    pass
            return 'build_failed'
        finally:
            os.close(lock_fd)


def publish(base, artifact, info, fingerprint):
    releases = base / 'releases'
    releases.mkdir(exist_ok=True)
    directory = releases / info['commit']
    directory.mkdir()
    # Work and releases live on the same state filesystem: move the completed
    # file so publishing does not briefly need a third package-sized copy.
    artifact.replace(directory / 'installer')
    with (directory / 'installer').open('rb') as stream:
        os.fsync(stream.fileno())
    atomic_json(directory / 'info.json', info)
    (directory / 'source.sha256').write_text(fingerprint)
    current = base / 'current'
    if current.is_symlink():
        old = os.readlink(current)
        if not re.fullmatch(r'releases/[0-9a-f]{40}', old):
            raise ValueError('invalid previous pointer')
        (base / 'previous.next').unlink(missing_ok=True)
        os.symlink(old, base / 'previous.next')
        (base / 'previous.next').replace(base / 'previous')
    (base / 'current.next').unlink(missing_ok=True)
    os.symlink('releases/' + info['commit'], base / 'current.next')
    (base / 'current.next').replace(current)
    keep = {os.readlink(base / name) for name in ('current', 'previous') if (base / name).is_symlink()}
    for candidate in releases.iterdir():
        if SHA.fullmatch(candidate.name) and 'releases/' + candidate.name not in keep:
            shutil.rmtree(candidate)


def build_once(root, source, commit, origin, platform, fingerprint, *,
               seconds=DEFAULT_SECONDS, byte_limit=DEFAULT_BYTES):
    base = root / platform
    attempt = base / 'attempts' / (commit + '.json')
    work = base / 'work'
    reason = 'build_failed'
    try:
        if os.geteuid() == 0:
            reason = 'build_tools_missing'
            return reason
        os.nice(10)
        if work.exists():
            shutil.rmtree(work)
        work.mkdir(mode=0o700)
        checkout = work / 'source'
        agent = checkout / 'apps/agent'
        shutil.copytree(source / 'apps/agent', agent, ignore=shutil.ignore_patterns(
            '__pycache__', '*.pyc', '.venv', '*.egg-info', 'build'))
        output = checkout / 'output/easy-install'
        output.mkdir(parents=True)
        cache = base / 'cache'
        cache.mkdir(exist_ok=True)
        # Existing build.py re-verifies cached input SHA256 before using it.
        (output / 'cache').symlink_to(cache.resolve(), target_is_directory=True)
        project = tomllib.loads((agent / 'pyproject.toml').read_text())
        version = project['project']['version'] + '+' + commit[:12]
        if not VERSION.fullmatch(version):
            raise ValueError('invalid version')
        builder = BUILDERS[platform]
        command = ['/usr/bin/python3', str(checkout / builder.script), *builder.args, '--server', origin,
                   '--output', str(output), '--version', version]
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(work), 'TMPDIR': str(work),
               'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1',
               'PIP_DISABLE_PIP_VERSION_CHECK': '1'}
        reason = bounded_run(command, root, env, seconds, byte_limit)
        if reason:
            return reason
        artifact = output / builder.filename.format(version=version)
        if not artifact.is_file() or artifact.is_symlink() or artifact.stat().st_size <= 0:
            reason = 'invalid_artifact'
            return reason
        with artifact.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        info = dict(platform=platform, available=True, version=version,
                    filename=artifact.name, size=artifact.stat().st_size, sha256=checksum,
                    built_at=datetime.now(timezone.utc).isoformat(), commit=commit)
        if disk_bytes(root) >= byte_limit:
            reason = 'limit_exceeded'
            return reason
        publish(base, artifact, info, fingerprint)
        reason = 'not_built'  # attempt completed; current is authoritative
        return None
    except Exception:
        reason = reason or 'build_failed'
        return reason
    finally:
        shutil.rmtree(work, ignore_errors=True)
        atomic_json(attempt, {'reason': reason})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['build'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--server', required=True)
    parser.add_argument('--platform', choices=PLATFORMS, required=True)
    parser.add_argument('--fingerprint', required=True)
    parser.add_argument('--lock-fd', type=int, required=True)
    args = parser.parse_args()
    if not SHA.fullmatch(args.commit) or not origin_valid(args.server):
        parser.error('invalid build configuration')
    # Validate the inherited lock and retain it until publication/cleanup ends.
    os.fstat(args.lock_fd)
    return int(build_once(args.root, args.source, args.commit, args.server,
                          args.platform, args.fingerprint) is not None)


if __name__ == '__main__':
    sys.exit(main())

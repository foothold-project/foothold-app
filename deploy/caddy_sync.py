"""Root-only Caddy config transaction, under the existing deployment EX lock.

Keep Caddy's {$FH_SITE} template intact, as bootstrap does. validate inherits the
exported site.env; the systemd reload/start reads that same environment file.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_file(path, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('Caddy sync requires regular files')
        if private and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError('Caddy sync state must be root-owned mode 0600')
        return stream.read(), info


def replace(path, data, uid=0, gid=0, mode=0o600):
    """Write privately, then rename on the destination filesystem."""
    tmp = path.with_name('.caddy-sync-' + secrets.token_hex(16))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchown(stream.fileno(), uid, gid)
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


class Sync:
    def __init__(self, config=Path('/etc/caddy/Caddyfile'),
                 state=Path('/var/lib/foothold/caddy-sync')):
        self.config, self.state = config, state
        self.record = state / 'applied.sha256'
        self.pending = state / 'pending.json'
        self.backup = state / 'previous.Caddyfile'

    def check_state(self):
        self.state.mkdir(mode=0o700, exist_ok=True)
        info = self.state.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError('Caddy sync directory must be root-owned mode 0700')

    def metadata(self):
        return json.loads(read_file(self.pending, private=True)[0])

    def reload(self):
        # Preserve the previous first-deployment start behavior.
        active = subprocess.run(['systemctl', 'is-active', '--quiet', 'caddy']).returncode == 0
        subprocess.run(['systemctl', 'reload' if active else 'start', 'caddy'], check=True)

    def validate(self, config):
        subprocess.run(['caddy', 'validate', '--config', str(config),
                        '--adapter', 'caddyfile'], check=True)

    def prepare(self, candidate):
        self.check_state()
        if self.pending.exists() or self.pending.is_symlink():
            raise ValueError('Unfinished Caddy sync transaction; root recovery required')
        proposed, _ = read_file(candidate)
        current, info = read_file(self.config)
        try:
            recorded = read_file(self.record, private=True)[0].decode('ascii').strip()
            if not re.fullmatch('[0-9a-f]{64}', recorded):
                raise ValueError('Invalid Caddy sync hash record')
        except FileNotFoundError:
            recorded = None
        same = current == proposed
        if same and recorded is not None:
            return
        if not same and (recorded is None or digest(current) != recorded):
            print('WARNING: Caddyfile overwrite REFUSED: no matching deployment hash; '
                  'preserving operator configuration and legacy validate/reload.', file=sys.stderr)
            return
        # Enrolment only records the hash after smoke; never replaces /etc.
        metadata = dict(changed=not same, uid=info.st_uid, gid=info.st_gid,
                        mode=stat.S_IMODE(info.st_mode), previous_hash=recorded,
                        candidate_hash=digest(proposed))
        if not same:
            replace(self.backup, current)
        replace(self.pending, json.dumps(metadata).encode())
        if same:
            return
        candidate_file = self.state / 'candidate.Caddyfile'
        try:
            replace(candidate_file, proposed)
            self.validate(candidate_file)
            # Do not clobber an operator edit made during validation.
            latest, latest_info = read_file(self.config)
            if (latest != current or latest_info.st_ino != info.st_ino
                    or latest_info.st_mtime_ns != info.st_mtime_ns
                    or (latest_info.st_uid, latest_info.st_gid, latest_info.st_mode)
                    != (info.st_uid, info.st_gid, info.st_mode)):
                self.clear()
                raise ValueError('Caddyfile changed during validation; overwrite refused')
            replace(self.config, proposed, mode=0o644)
        except BaseException:
            if self.pending.exists():
                self.rollback()
            raise
        finally:
            candidate_file.unlink(missing_ok=True)

    def commit(self):
        self.check_state()
        if not self.pending.exists():
            return
        metadata = self.metadata()
        if digest(read_file(self.config)[0]) != metadata['candidate_hash']:
            raise ValueError('Caddyfile changed before smoke completed')
        replace(self.record, (metadata['candidate_hash'] + '\n').encode())
        self.clear()

    def clear(self):
        # Keep the last root-only backup for recovery/audit. It is overwritten
        # only when the next authorized transaction has taken its own snapshot.
        self.pending.unlink(missing_ok=True)

    def rollback(self):
        self.check_state()
        if not self.pending.exists():
            return
        metadata = self.metadata()
        if metadata['changed']:
            original = read_file(self.backup, private=True)[0]
            replace(self.config, original, metadata['uid'], metadata['gid'], metadata['mode'])
        if metadata['previous_hash'] is None:
            self.record.unlink(missing_ok=True)
        else:
            replace(self.record, (metadata['previous_hash'] + '\n').encode())
        if metadata['changed']:
            self.reload()
        # A failed restore/reload leaves the backup and pending evidence intact.
        self.clear()


def main():
    if os.geteuid() != 0:
        raise PermissionError('root Caddy sync required')
    sync = Sync()
    action, *args = sys.argv[1:]
    if action == 'prepare' and len(args) == 1:
        sync.prepare(Path(args[0]))
    elif action in ('commit', 'rollback') and not args:
        getattr(sync, action)()
    else:
        raise ValueError('Expected prepare <candidate>, commit, or rollback')


if __name__ == '__main__':
    main()

"""Private, atomic credentials; never consult the legacy go2-agent.env file."""
from dataclasses import dataclass, field, asdict
import json
import math
import os
from pathlib import Path
import re
import secrets
import stat
from uuid import UUID

from foothold_agent.link.client import Settings


def valid_serial(value):
    return (isinstance(value, str) and re.fullmatch(r'(0|[1-9][0-9]*)-(0|[1-9][0-9]*)', value)
            and value != '0-0' and all(int(x) <= 0xFFFFFFFF for x in value.split('-')))


@dataclass(frozen=True)
class Credentials:
    robot_id: str
    robot_serial: str
    agent_token: str = field(repr=False)
    agent_ws_url: str = field(repr=False)
    last_field_approval_expires_at: float | None = None

    def __post_init__(self):
        if str(UUID(self.robot_id)) != self.robot_id or not valid_serial(self.robot_serial):
            raise ValueError('invalid pairing identity')
        Settings(self.agent_ws_url, self.agent_token)
        used = self.last_field_approval_expires_at
        if used is not None and (type(used) not in (int, float) or not math.isfinite(used) or used <= 0):
            raise ValueError('invalid approval history')
        if len(self.agent_token) > 2048:
            raise ValueError('credential exceeds limit')

    @property
    def link(self):
        return Settings(self.agent_ws_url, self.agent_token)


def default_path():
    return Path.home()/'.config'/'foothold'/'agent.json'


def credential_path(path):
    path = Path(path or default_path())
    if path.name == 'go2-agent.env':
        raise PermissionError('legacy environment file is outside this program')
    return path


def private_file(st):
    if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid()
            or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1 or st.st_size > 8192):
        raise PermissionError('credentials require owned 0600 single-link regular file')


def parent_fd(path):
    path = Path(path)
    if not path.is_absolute():
        raise PermissionError('absolute credential path required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parent.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part, 0o700, dir_fd=fd)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        st = os.fstat(fd)
        if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
            raise PermissionError('credential directory requires owner and mode 0700')
        return fd
    except BaseException:
        os.close(fd)
        raise


def load(path=None):
    path = credential_path(path)
    directory = parent_fd(path)
    try:
        try:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        try:
            private_file(os.fstat(fd))
            value = json.loads(os.read(fd, 8193))
            return Credentials(**value)
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def save(credentials, path=None):
    path = credential_path(path)
    directory = parent_fd(path)
    temporary = '.agent-'+secrets.token_hex(16)
    try:
        try:
            private_file(os.stat(path.name, dir_fd=directory, follow_symlinks=False))
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        try:
            private_file(os.fstat(fd))
            with os.fdopen(fd, 'w', closefd=False) as stream:
                json.dump(asdict(credentials), stream)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)

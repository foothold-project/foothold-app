"""Local-only test data so a fresh server is not an empty organization.

Role accounts, one simulation robot slot, and the repository's static worlds
(SIM site, buildings, floors, approved maps, preset missions and scenarios).
Writes go through the server's own init code: ``sim_maps.sync_worlds`` and the
same User row + ``USER_CREATED`` event that ``POST /users`` writes.

Idempotent: existing accounts, robot and maps are kept; passwords are never
rotated or printed. Passwords live in a private file outside the repository.
"""
import os
from pathlib import Path
import secrets
from uuid import UUID, uuid5



ACCOUNTS = (('local-operator', '로컬 운영자', 'OPERATOR'),
            ('local-operator-2', '로컬 운영자 2', 'OPERATOR'))
SIM_ROBOT_NAME = '시뮬 로봇 1'
NAMESPACE = UUID('3f0c7a52-6f7e-4d36-9b8f-2a51c4d0e9a1')
BOOTSTRAP_KEYS = ('FH_DB_PASSWORD', 'FH_BOOTSTRAP_PASSWORD')


def sim_robot_id(org_id):
    """The seeded simulation robot; tools/local_up.py --sim gives simmgr this slot."""
    return uuid5(NAMESPACE, f'{org_id}/sim-robot-1')


def password_key(username):
    return 'FH_SEED_PASSWORD_' + username.upper().replace('-', '_')


def secret_keys():
    return BOOTSTRAP_KEYS + tuple(password_key(name) for name, *_ in ACCOUNTS)


def read_secrets(path):
    path = Path(path)
    info = path.stat()
    if info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise ValueError(f'로컬 계정 파일은 본인 소유 600 권한이어야 합니다: {path}')
    values = {}
    for line in path.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, _, value = line.partition('=')
            values[key.strip()] = value.strip()
    return values


def ensure_secrets(path, repository, preset=None):
    """Return local passwords; generate only keys with no value anywhere.

    Precedence: environment, then ``preset`` (filled .env values), then the file.
    A key filled in the environment or .env is never generated or stored here.
    """
    path = Path(path).expanduser().resolve()
    if path.is_relative_to(Path(repository).resolve()):
        raise ValueError('로컬 계정 파일은 저장소 밖에 두세요')
    given = {key: os.environ.get(key) or (preset or {}).get(key) for key in secret_keys()}
    given = {key: value for key, value in given.items() if value}
    stored = read_secrets(path) if path.exists() else {}
    missing = [key for key in secret_keys() if key not in given and not stored.get(key)]
    if missing:
        stored.update({key: secrets.token_urlsafe(24) for key in missing})
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = path.with_name(path.name + '.tmp')
        temporary.unlink(missing_ok=True)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write('# foothold 로컬 전용 계정 · 공유 · 커밋 금지\n')
            handle.writelines(f'{key}={stored[key]}\n' for key in sorted(stored))
        os.replace(temporary, path)
    return {key: given.get(key) or stored[key] for key in secret_keys()}


def seed(database_url, org_id, files_root, admin_username, passwords, worlds=None):
    # Server imports stay here: tools/local_up.py reads the account file with plain python3.
    from sqlalchemy import create_engine, func, select
    from sqlalchemy.orm import Session

    from apps.server.fh_server.api import event
    from apps.server.fh_server.models import Organization, Robot, User
    from apps.server.fh_server.security import digest, hash_password, token
    from apps.server.fh_server.sim_maps import WORLD_FOLDER, sync_worlds

    missing = [password_key(name) for name, *_ in ACCOUNTS if not passwords.get(password_key(name))]
    if missing:
        raise ValueError(f'.env의 {missing[0]} 값을 채우세요')
    engine = create_engine(database_url)
    try:
        with Session(engine) as db, db.begin():
            db.scalar(select(Organization).where(Organization.id == org_id).with_for_update())
            admin = db.scalar(select(User).where(User.org_id == org_id, User.role == 'ORG_ADMIN',
                func.lower(User.username) == admin_username.lower(), User.archived_at.is_(None)))
            if admin is None:
                raise ValueError('로컬 총괄 계정이 없습니다; 서버 초기화를 먼저 하세요')
            for username, display_name, role in ACCOUNTS:
                if db.scalar(select(User.id).where(User.org_id == org_id,
                        func.lower(User.username) == username.lower())) is None:
                    user = User(org_id=org_id, username=username, display_name=display_name, role=role,
                                password_hash=hash_password(passwords[password_key(username)]))
                    db.add(user)
                    db.flush()
                    event(db, org_id, 'USER_CREATED', admin.id, {'user_id': str(user.id), 'role': role})
            sync_worlds(db, org_id, admin.id, worlds or WORLD_FOLDER, files_root)
            robot_id = sim_robot_id(org_id)
            if db.get(Robot, robot_id) is None:
                # Same shape as an unowned slot after a rejected start; no manager needed.
                db.add(Robot(id=robot_id, org_id=org_id, name=SIM_ROBOT_NAME, model='unitree_go2',
                             simulation=True, sim_generation=0, sim_state='IDLE',
                             agent_token_hash=digest(token())))
    finally:
        engine.dispose()

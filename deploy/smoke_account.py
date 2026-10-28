"""Provision a dedicated lowest-role account; never reset an existing user."""
from pathlib import Path
import secrets
from uuid import UUID

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from apps.server.fh_server.models import User
from apps.server.fh_server.security import hash_password, verify_password
from .database import read_env
from .smoke import private_env

CREDENTIALS = Path('/etc/foothold/smoke.env')


def ensure_account():
    config = read_env('/etc/foothold/server.env')
    password = read_env('/etc/foothold/database.env')['FH_MIGRATE_PASSWORD']
    if not CREDENTIALS.exists():
        # Root-only credentials stay separate from initial administrator state.
        from importlib.util import module_from_spec, spec_from_file_location
        spec = spec_from_file_location('bootstrap_state', Path(__file__).with_name('bootstrap-state.py'))
        state = module_from_spec(spec)
        spec.loader.exec_module(state)
        state.write_private(CREDENTIALS, {
            'FH_SMOKE_USERNAME': 'deploy-check-' + secrets.token_hex(8),
            'FH_SMOKE_PASSWORD': secrets.token_urlsafe(36),
        })
    credentials = private_env(CREDENTIALS)
    engine = create_engine(f'postgresql+psycopg://fh_migrate:{password}@127.0.0.1/foothold')
    try:
        with Session(engine) as db:
            org_id = UUID(config['FH_ORG_ID'])
            user = db.scalar(select(User).where(User.org_id == org_id,
                             User.username == credentials['FH_SMOKE_USERNAME']))
            if user is None:
                db.add(User(org_id=org_id, username=credentials['FH_SMOKE_USERNAME'],
                            display_name='Deployment health check', role='OPERATOR',
                            password_hash=hash_password(credentials['FH_SMOKE_PASSWORD'])))
                db.commit()
            elif (user.role != 'OPERATOR' or user.locked or user.archived_at is not None
                  or not verify_password(credentials['FH_SMOKE_PASSWORD'], user.password_hash)):
                raise ValueError('Check account changed; manual recovery required')
    finally:
        engine.dispose()


if __name__ == '__main__':
    try:
        ensure_account()
    except Exception:
        raise SystemExit('Check account provisioning failed; private details suppressed') from None

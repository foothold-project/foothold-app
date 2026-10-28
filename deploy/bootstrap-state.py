"""Root-only state and local-peer DB provisioning; never print secrets."""
import os
from pathlib import Path
import secrets
import shlex
import subprocess
from uuid import uuid4

ROOT = Path('/etc/foothold')


def read_env(path):
    return dict(line.split('=', 1) for line in shlex.split(path.read_text(), comments=True))


def write_private(path, values):
    # O_EXCL prevents replacing pre-existing credentials, including symlinks.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        for key, value in values.items():
            stream.write(f'{key}={shlex.quote(value)}\n')
    os.chown(path, 0, __import__('grp').getgrnam('foothold').gr_gid)


def psql(query, database='postgres'):
    result = subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-qAt',
                             '-v', 'ON_ERROR_STOP=1', '-d', database], input=query,
                            text=True, capture_output=True, cwd='/tmp')
    if result.returncode:
        raise RuntimeError('Local database provisioning failed; inspect DB state privately')
    return result.stdout.strip()


def main():
    credentials = ROOT / 'database.env'
    names = [('fh_migrate', 'FH_MIGRATE_PASSWORD'), ('fh_app', 'FH_APP_PASSWORD'),
             ('fh_readonly', 'FH_READONLY_PASSWORD')]
    if not credentials.exists():
        if psql("SELECT rolname FROM pg_roles WHERE rolname IN ('fh_migrate','fh_app','fh_readonly')"):
            raise RuntimeError('Existing roles without deployment state require a manual grant audit')
        write_private(credentials, {key: secrets.token_hex(32) for _, key in names})
    passwords = read_env(credentials)
    for role, key in names:
        exists = psql(f"SELECT 1 FROM pg_roles WHERE rolname='{role}'")
        if not exists:
            # Password alphabet is validated before SQL interpolation.
            password = passwords[key]
            if len(password) != 64 or any(c not in '0123456789abcdef' for c in password):
                raise RuntimeError('Invalid private password state')
            psql("SET log_statement = 'none'; SET log_min_error_statement = 'panic'; "
                 f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '{password}';")
        if psql(f"SELECT 1 FROM pg_roles WHERE rolname='{role}' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit OR NOT rolcanlogin)"):
            raise RuntimeError('Existing role privilege audit failed')
    if not psql("SELECT 1 FROM pg_database WHERE datname='foothold'"):
        psql('CREATE DATABASE foothold;')
    psql('REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE, CREATE ON SCHEMA public TO fh_migrate;', 'foothold')
    psql('REVOKE CONNECT ON DATABASE foothold FROM PUBLIC; GRANT CONNECT ON DATABASE foothold TO fh_migrate, fh_app, fh_readonly;')
    admin = Path('/root/foothold-initial-admin.txt')
    if not admin.exists():
        if (ROOT / 'server.env').exists():
            raise RuntimeError('Initial admin file absent; manual recovery required, never replace it')
        write_private(admin, {key: os.environ[key] for key in
                      ('FH_BOOTSTRAP_USERNAME', 'FH_BOOTSTRAP_DISPLAY_NAME')} |
                      {'FH_BOOTSTRAP_PASSWORD': secrets.token_urlsafe(36)})
    if not (ROOT / 'server.env').exists():
        write_private(ROOT / 'server.env', {
            'FH_DATABASE_URL': f"postgresql+psycopg://fh_app:{passwords['FH_APP_PASSWORD']}@127.0.0.1/foothold",
            'FH_ORG_ID': str(uuid4()), 'FH_ORG_NAME': os.environ['FH_ORG_NAME'],
            'FH_WS_ORIGIN': 'https://' + os.environ['FH_SITE'],
            'FH_FILES_ROOT': '/var/lib/foothold/files'})
    if not (ROOT / 'site.env').exists():
        write_private(ROOT / 'site.env', {'FH_SITE': os.environ['FH_SITE']})


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Bootstrap state failed; private files retained for manual recovery') from None

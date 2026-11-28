#!/usr/bin/env python3
"""Local stack entry: .env from the example, free-port check, private account file.

  python3 tools/local_up.py              # prepare only, then print the next command
  python3 tools/local_up.py --docker     # prepare, then docker compose up --build
  <server venv>/bin/python tools/local_up.py --no-docker   # PostgreSQL (pgserver) + API, no Docker
  <server venv>/bin/python tools/local_up.py --stop        # stop the --no-docker PostgreSQL

Passwords are generated once into a 600 file outside the repository
(FH_LOCAL_SECRETS, default ~/.config/foothold-local/accounts.env) and never printed.
--no-docker keeps its database and files in FH_LOCAL_DATA (default ~/.local/share/foothold-local).
--no-docker needs apps/server/requirements-test.txt (pgserver) in the server venv.
"""
import argparse
import os
from pathlib import Path
import re
import socket
import sys
import tempfile

REPOSITORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY))
from docker import seed  # noqa: E402  (stdlib only at import time)


# Values from the developer's machine must not reach the local server.
DROPPED = ('FH_SIM_MANAGER_URL', 'FH_SIM_AUTH_FILE', 'FH_PHONE_PASS_KEYS', 'FH_SERVER_DRIVE_ROBOTS',
           'FH_TUNNEL_ORIGIN', 'FH_MIGRATE_DATABASE_URL', 'FH_BOOTSTRAP_DATABASE_DSN')


def default_path(variable, fallback):
    return Path(os.environ.get(variable) or Path.home() / fallback).expanduser()


def read_env(path):
    """The subset of dotenv syntax .env.example uses: KEY=VALUE, quotes, ${KEY}."""
    values = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, _, value = line.partition('=')
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '\'"':
            value = value[1:-1]
        values[key.strip()] = re.sub(r'\$\{(\w+)\}', lambda m: os.environ.get(m[1], values.get(m[1], '')), value)
    # Like Compose, the shell environment overrides .env.
    return {key: os.environ.get(key, value) for key, value in values.items()}


def port_free(port):
    with socket.socket() as sock:
        # Same as uvicorn/PostgreSQL: TIME_WAIT from a stopped server is not "in use".
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', int(port)))
        except OSError:
            return False
    return True


def prepare(repository, secrets_file, *, docker, check=True, db_running=False):
    env_file = Path(repository) / '.env'
    if not env_file.exists():
        # This script supplies the seed passwords, so its .env turns seeding on.
        text = (Path(repository) / '.env.example').read_text().replace('\nFH_SEED=0\n', '\nFH_SEED=1\n')
        fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(text)
        print(f'.env 를 .env.example 에서 만들었습니다: {env_file}')
    values = read_env(env_file)
    keys = ['FH_WEB_PORT', 'FH_API_PORT'] if docker else ['FH_API_PORT'] + ([] if db_running else ['FH_DB_PORT'])
    for key in keys:
        if not values.get(key, '').isdigit():
            raise SystemExit(f'.env 의 {key} 를 숫자로 채우세요')
    busy = [f'{key}={values[key]}' for key in keys if check and not port_free(values[key])]
    if busy:
        raise SystemExit('이미 쓰는 포트: ' + ', '.join(busy) + ' · .env 에서 빈 포트로 바꾸세요'
                         ' (FH_WEB_PORT 를 바꾸면 FH_WS_ORIGIN 도 같은 포트)')
    # A password filled in .env wins everywhere; the account file only fills blanks.
    passwords = seed.ensure_secrets(secrets_file, repository,
                                    {key: values[key] for key in seed.secret_keys() if values.get(key)})
    return values, passwords


def compose(repository, passwords):
    """Compose reads only .env; resolved passwords travel in the shell environment,
    which Compose ranks above .env, so blank .env fields are filled and filled ones kept."""
    command = ['docker', 'compose', '--env-file', str(Path(repository) / '.env'), 'up', '--build']
    return command, {**os.environ, **passwords}


def server_env(values, passwords, data):
    env = {key: value for key, value in os.environ.items() if key not in DROPPED}
    env.update(values)
    env.update(passwords)
    env.update({
        'FH_DATABASE_URL': f"postgresql+psycopg://fh_app@127.0.0.1:{values['FH_DB_PORT']}/{values['FH_DB_NAME']}",
        'FH_PORT': values['FH_API_PORT'], 'FH_API_HOST': '127.0.0.1',
        'FH_FILES_ROOT': str(Path(data) / 'files'),
        'FH_ROBOT_INSTALLER_ENABLED': '0', 'FH_SERVER_DRIVE_ENABLED': '0',
    })
    for key in DROPPED:
        env.pop(key, None)
    return env


def database(values, passwords, data):
    """A private PostgreSQL bound to 127.0.0.1 with password login, reused on restart."""
    from pgserver import initdb, pg_ctl
    import psycopg
    from psycopg import sql
    pgdata = Path(data) / 'pg'
    if not (pgdata / 'PG_VERSION').exists():
        Path(data).mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile('w', dir=data, prefix='.pw') as pwfile:
            pwfile.write(passwords['FH_DB_PASSWORD'])
            pwfile.flush()
            initdb(['--auth=scram-sha-256', '--encoding=UTF8', '--locale=C',
                    '-U', values['FH_DB_USER'], f'--pwfile={pwfile.name}'], pgdata=pgdata)
    if not running(pgdata):
        pg_ctl(['-w', '-o', f"-h 127.0.0.1 -p {values['FH_DB_PORT']} -k {pgdata}",
                '-l', str(Path(data) / 'pg.log'), 'start'], pgdata=pgdata)
    admin = dict(host='127.0.0.1', port=values['FH_DB_PORT'], user=values['FH_DB_USER'],
                 password=passwords['FH_DB_PASSWORD'], dbname='postgres', autocommit=True)
    with psycopg.connect(**admin) as conn:
        if conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (values['FH_DB_NAME'],)).fetchone() is None:
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(values['FH_DB_NAME'])))


def running(pgdata):
    return (Path(pgdata) / 'postmaster.pid').exists()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--docker', action='store_true')
    mode.add_argument('--no-docker', action='store_true')
    mode.add_argument('--stop', action='store_true')
    args = parser.parse_args()
    secrets_file = default_path('FH_LOCAL_SECRETS', '.config/foothold-local/accounts.env')
    data = default_path('FH_LOCAL_DATA', '.local/share/foothold-local')
    if args.stop:
        from pgserver import pg_ctl
        if running(data / 'pg'):
            pg_ctl(['-w', '-m', 'fast', 'stop'], pgdata=data / 'pg')
        print('로컬 PostgreSQL 을 멈췄습니다.')
        return
    values, passwords = prepare(REPOSITORY, secrets_file, docker=not args.no_docker,
                                db_running=args.no_docker and running(data / 'pg'))
    print(f'계정 파일 (600, 값은 출력하지 않음): {secrets_file}')
    if args.no_docker:
        database(values, passwords, data)
        print(f"API: http://127.0.0.1:{values['FH_API_PORT']} · 웹은 apps/web 에서 "
              f"FH_API=http://127.0.0.1:{values['FH_API_PORT']} npm run dev -- --port {values['FH_WEB_PORT']}")
        os.chdir(REPOSITORY)
        sys.stdout.flush()  # exec drops buffered output
        os.execve(sys.executable, [sys.executable, '-m', 'docker.server'],
                  server_env(values, passwords, data))
    if args.docker:
        os.chdir(REPOSITORY)
        sys.stdout.flush()
        command, env = compose(REPOSITORY, passwords)
        os.execvpe('docker', command, env)
    print('다음: python3 tools/local_up.py --docker  (또는 --no-docker)')


if __name__ == '__main__':
    main()

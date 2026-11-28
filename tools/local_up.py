#!/usr/bin/env python3
"""Local stack entry: .env from the example, free-port check, private account file.

  python3 tools/local_up.py              # prepare only, then print the next command
  python3 tools/local_up.py --docker     # prepare, then docker compose up --build
  <server venv>/bin/python tools/local_up.py --no-docker   # PostgreSQL (pgserver) + API, no Docker
  <server venv>/bin/python tools/local_up.py --no-docker --sim mujoco   # also simmgr (local MuJoCo, #594)
  <server venv>/bin/python tools/local_up.py --stop        # stop the --no-docker simmgr and PostgreSQL

Passwords are generated once into a 600 file outside the repository
(FH_LOCAL_SECRETS, default ~/.config/foothold-local/accounts.env) and never printed.
--no-docker keeps its database and files in FH_LOCAL_DATA (default ~/.local/share/foothold-local).
--no-docker needs apps/server/requirements-test.txt (pgserver) in the server venv.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import time
from uuid import UUID
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


ASSETS_HELP = ('시뮬 자산이 없습니다: 팀의 foothold-sim-assets 묶음(README · SHA256SUMS 포함)을 받아 '
               '이 PC 에 두고 .env 또는 셸의 FH_SIM_ASSETS 에 그 폴더를 적으세요')


# Bundle files that SHA256SUMS does not list; nothing reads them.
UNLISTED = {'SHA256SUMS', 'README.md'}


def check_assets(place):
    """Every SHA256SUMS line must name a regular file inside the folder with that digest,
    and every file in the folder (except UNLISTED) must be listed: the whole folder is mounted."""
    if not place:
        raise SystemExit(ASSETS_HELP + ' (FH_SIM_ASSETS 가 비어 있음)')
    root = Path(place).expanduser().resolve()
    sums = root / 'SHA256SUMS'
    if not root.is_dir() or not sums.is_file():
        raise SystemExit(ASSETS_HELP + f' (FH_SIM_ASSETS={place} 에 SHA256SUMS 없음)')
    lines = [line.split(None, 1) for line in sums.read_text().splitlines() if line.strip()]
    if not lines:
        raise SystemExit('시뮬 자산의 SHA256SUMS 가 비어 있습니다')
    # No links anywhere (so a listed name cannot point at another file), and nothing unlisted.
    listed = {os.path.normpath(name.strip().lstrip('*')) for _, name in lines}
    for path in root.rglob('*'):
        name = path.relative_to(root).as_posix()
        if path.is_symlink() or (not path.is_dir() and name not in listed | UNLISTED):
            raise SystemExit(f'시뮬 자산에 링크나 SHA256SUMS 에 없는 파일이 있습니다: {name} · 묶음을 다시 받으세요')
    for digest, name in lines:
        path = root / name.strip().lstrip('*')
        if (not path.resolve().is_relative_to(root) or not path.is_file()
                or hashlib.sha256(path.read_bytes()).hexdigest() != digest.lower()):
            raise SystemExit(f'시뮬 자산이 SHA256SUMS 와 다릅니다: {name.strip()} · 묶음을 다시 받으세요')
    return str(root)


def prepare(repository, secrets_file, *, docker, check=True, db_running=False, sim=False):
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
    if sim:
        keys.append('FH_SIM_PORT')
    for key in keys:
        if not values.get(key, '').isdigit():
            raise SystemExit(f'.env 의 {key} 를 숫자로 채우세요')
    if docker and values.get('FH_SIM_ASSETS'):
        values['FH_SIM_ASSETS'] = check_assets(values['FH_SIM_ASSETS'])
    elif docker:
        print(ASSETS_HELP + ' · 지금은 시뮬 없이 띄웁니다 (/sim/ 은 안내 화면)')
    busy = [f'{key}={values[key]}' for key in keys if check and not port_free(values[key])]
    if busy:
        raise SystemExit('이미 쓰는 포트: ' + ', '.join(busy) + ' · .env 에서 빈 포트로 바꾸세요'
                         ' (FH_WEB_PORT 를 바꾸면 FH_WS_ORIGIN 도 같은 포트)')
    # A password filled in .env wins everywhere; the account file only fills blanks.
    passwords = seed.ensure_secrets(secrets_file, repository,
                                    {key: values[key] for key in seed.secret_keys() if values.get(key)})
    return values, passwords


def compose(repository, passwords, values):
    """Compose reads only .env; resolved passwords travel in the shell environment,
    which Compose ranks above .env, so blank .env fields are filled and filled ones kept."""
    command = ['docker', 'compose', '--env-file', str(Path(repository) / '.env'), 'up', '--build']
    env = {**os.environ, **passwords}
    env.pop('FH_SIM_ASSETS', None)
    if values.get('FH_SIM_ASSETS'):
        env['FH_SIM_ASSETS'] = values['FH_SIM_ASSETS']
    return command, env


def private_file(path, text):
    """Write once with 0600; an existing file is kept (keys are never rotated here)."""
    path = Path(path)
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(text)
    return str(path)


def extra_sim_robot_id(org_id, number):
    """Slots 2..4 (FH_SIM_SLOTS). The server creates the row on the first POST /simulation/robots."""
    return seed.uuid5(seed.NAMESPACE, f'{org_id}/sim-robot-{number}')


# Read from the shell (or .env) only for --sim mujoco; never reaches the API server.
POLICY_KEYS = ('FH_SIM_ORT_NODE', 'FH_SIM_START_MAP', 'FH_SIM_POLICY_DIR')


def sim_setup(repository, values, data):
    """Private files for simmgr with the local MuJoCo backend.

    Default: one slot = the seeded robot, world collapsed-house-v2. FH_SIM_WORLD names another
    world (plant_a: the server sends its approved map bindings) and FH_SIM_SLOTS 1..4 adds slots."""
    if not (Path(repository) / 'apps/simmgr/mujoco_launcher.py').exists():
        raise SystemExit('--sim mujoco 는 simmgr 로컬 MuJoCo 백엔드 (#594) 가 들어간 저장소에서만 됩니다')
    if values.get('FH_SIM_SRC'):
        source = Path(values['FH_SIM_SRC']).expanduser()
        if not source.is_dir():
            raise SystemExit(f"FH_SIM_SRC={values['FH_SIM_SRC']} 폴더가 없습니다")
        source = str(source)
    else:
        source = check_assets(values.get('FH_SIM_ASSETS', ''))
    folder = Path(data) / 'sim'
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    org = values['FH_ORG_ID']
    count = os.environ.get('FH_SIM_SLOTS') or values.get('FH_SIM_SLOTS') or '1'
    if not count.isdigit() or not 1 <= int(count) <= 4:
        raise SystemExit('FH_SIM_SLOTS 는 1..4 (MuJoCo 로컬 로봇 수)')
    world = os.environ.get('FH_SIM_WORLD') or values.get('FH_SIM_WORLD') or 'collapsed-house-v2'
    robots = [str(seed.sim_robot_id(UUID(org)))] + [str(extra_sim_robot_id(UUID(org), n))
                                                    for n in range(2, int(count) + 1)]
    secret = lambda size: base64.urlsafe_b64encode(os.urandom(size)).rstrip(b'=').decode()
    catalog = {'worlds': [{'id': world, 'name': '무너진 집 (MuJoCo)' if world == 'collapsed-house-v2' else world + ' (MuJoCo)',
                           'world_file': '/nonexistent/mujoco', 'map_file': '/nonexistent/mujoco'}],
               'slots': [{'robot_id': robot, 'org_id': org, 'key_path': '/nonexistent/key',
                          'replay_path': '/nonexistent/replay', 'port': 9449 - i} for i, robot in enumerate(robots)]}
    catalog_file = folder / 'catalog.json'
    if catalog_file.exists() and json.loads(catalog_file.read_text()) != catalog:
        catalog_file.unlink()  # organization/world/slots changed; derived, holds no secret
    passes = folder / 'pass-keys.json'
    if passes.exists() and set(json.loads(passes.read_text())) != set(robots):
        passes.unlink()  # local-only keys for the current slots; never kept for removed robots
    return {'FH_SIM_AUTH_FILE': private_file(folder / 'service.key', secret(32)),
            'FH_PHONE_PASS_KEYS': private_file(passes, json.dumps(
                {robot: {'active': 'local', 'keys': {'local': secret(32)}} for robot in robots})),
            'max_robots': str(len(robots)),
            **{key: os.environ.get(key) or values[key] for key in POLICY_KEYS if os.environ.get(key) or values.get(key)},
            'FH_SIM_CATALOG': private_file(catalog_file, json.dumps(catalog, ensure_ascii=False)),
            'FH_SIM_SRC': source, 'SIM_RUN_DIR': str(folder / 'runs'),
            'pidfile': str(folder / 'simmgr.pid'), 'log': str(folder / 'simmgr.log')}


def simmgr_env(repository, values, sim):
    """Only what simmgr needs: no database URL, account passwords or ROS settings."""
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR',
                                                 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')  # preflight: systemctl --user
           if key in os.environ}
    env.update({
        'PYTHONPATH': os.pathsep.join((str(repository), str(Path(repository) / 'apps/agent'))),
        'FH_SIM_CATALOG': sim['FH_SIM_CATALOG'], 'FH_SIM_AUTH_FILE': sim['FH_SIM_AUTH_FILE'],
        'FH_SIM_PORT': values['FH_SIM_PORT'], 'FH_SIM_EXTRA_PORTS': values['FH_API_PORT'],
        'FH_SIM_AGENT_WS_URL': f"ws://127.0.0.1:{values['FH_API_PORT']}/api/v1/agent/ws",
        'FH_SIM_LOCAL_BACKEND': 'mujoco', 'FH_SIM_AGENT_PYTHON': sys.executable,
        'FH_SIM_SRC': sim['FH_SIM_SRC'], 'SIM_RUN_DIR': sim['SIM_RUN_DIR'],
        'FH_SIM_MAX_ROBOTS': sim.get('max_robots', '1'),
        **{key: sim[key] for key in POLICY_KEYS if key in sim},
    })
    return env


def start_simmgr(repository, values, sim):
    with open(sim['log'], 'ab') as log:
        child = subprocess.Popen([sys.executable, '-m', 'apps.simmgr'], cwd=repository, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, env=simmgr_env(repository, values, sim),
                                 start_new_session=True)
    Path(sim['pidfile']).write_text(str(child.pid))
    return child.pid


def stop_simmgr(pidfile):
    """Signal only the pid we recorded, and only while it is still our simmgr."""
    pidfile = Path(pidfile)
    if not pidfile.exists():
        return
    pid = int(pidfile.read_text().strip() or 0)
    pidfile.unlink()

    def ours():
        try:
            cmdline = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            zombie = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0] == 'Z'
        except (OSError, IndexError):
            return False
        return b'apps.simmgr' in cmdline and not zombie
    if pid <= 1 or not ours():
        return
    os.kill(pid, signal.SIGTERM)
    end = time.monotonic() + 10
    while ours() and time.monotonic() < end:
        time.sleep(.1)
    if ours():
        os.kill(pid, signal.SIGKILL)


def server_env(values, passwords, data, sim=None):
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
    if sim:
        env.update({'FH_SIM_MANAGER_URL': f"http://127.0.0.1:{values['FH_SIM_PORT']}",
                    'FH_SIM_AUTH_FILE': sim['FH_SIM_AUTH_FILE'], 'FH_PHONE_PASS_KEYS': sim['FH_PHONE_PASS_KEYS'],
                    'FH_SIM_EXTRA_PORTS': values['FH_API_PORT']})
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--docker', action='store_true')
    mode.add_argument('--no-docker', action='store_true')
    mode.add_argument('--stop', action='store_true')
    parser.add_argument('--sim', choices=['mujoco'], help='simmgr 로컬 MuJoCo 백엔드도 띄움 (기본 끔)')
    args = parser.parse_args(argv)
    if args.sim and not args.no_docker:
        raise SystemExit('--sim mujoco 는 --no-docker 와 함께 씁니다 (simmgr 는 이 PC 에서 돈다)')
    secrets_file = default_path('FH_LOCAL_SECRETS', '.config/foothold-local/accounts.env')
    data = default_path('FH_LOCAL_DATA', '.local/share/foothold-local')
    if args.stop:
        stop_simmgr(data / 'sim' / 'simmgr.pid')
        from pgserver import pg_ctl
        if running(data / 'pg'):
            pg_ctl(['-w', '-m', 'fast', 'stop'], pgdata=data / 'pg')
        print('로컬 simmgr · PostgreSQL 을 멈췄습니다.')
        return
    values, passwords = prepare(REPOSITORY, secrets_file, docker=not args.no_docker,
                                db_running=args.no_docker and running(data / 'pg'), sim=bool(args.sim))
    print(f'계정 파일 (600, 값은 출력하지 않음): {secrets_file}')
    if args.no_docker:
        sim = sim_setup(REPOSITORY, values, data) if args.sim else None
        database(values, passwords, data)
        if sim:
            print(f"simmgr (MuJoCo) pid {start_simmgr(REPOSITORY, values, sim)} · 127.0.0.1:{values['FH_SIM_PORT']}"
                  f" · 기록 {sim['log']}")
        print(f"API: http://127.0.0.1:{values['FH_API_PORT']} · 웹은 apps/web 에서 "
              f"FH_API=http://127.0.0.1:{values['FH_API_PORT']} npm run dev -- --port {values['FH_WEB_PORT']}")
        os.chdir(REPOSITORY)
        sys.stdout.flush()  # exec drops buffered output
        os.execve(sys.executable, [sys.executable, '-m', 'docker.server'],
                  server_env(values, passwords, data, sim))
    if args.docker:
        os.chdir(REPOSITORY)
        sys.stdout.flush()
        command, env = compose(REPOSITORY, passwords, values)
        os.execvpe('docker', command, env)
    print('다음: python3 tools/local_up.py --docker  (또는 --no-docker [--sim mujoco])')

if __name__ == '__main__':
    main()

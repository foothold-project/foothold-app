"""Explicit, local first-launch preparation/driver; never imported by runtime.

All credentials and evidence stay in a new ignored 0700 episode directory.
No install, asset generation, retry, protected service, or ROS discovery here.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT), str(ROOT / 'apps/agent')]


def private(path, value):
    with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as out:
        json.dump(value, out)


def request(method, path, body=None, bearer=None, timeout=190):
    headers = {'Content-Type': 'application/json'}
    if bearer:
        headers['Authorization'] = 'Bearer ' + bearer
    req = urllib.request.Request('http://127.0.0.1:9431/api/v1' + path,
        data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def prepare(args):
    from pgserver import initdb, pg_ctl
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import URL
    from sqlalchemy.orm import Session
    from alembic import command
    from alembic.config import Config
    from apps.server.fh_server.models import Organization, User
    from apps.server.fh_server.security import hash_password
    folder = args.episode.resolve()
    assert folder.is_relative_to(ROOT / 'runs/simmgr') and not folder.exists()
    subprocess.run(['git', 'check-ignore', str(folder)], cwd=ROOT, check=True, capture_output=True)
    folder.mkdir(parents=True, mode=0o700)
    os.chmod(folder, 0o700)
    source = args.source.resolve()
    sys.path.insert(0, str(source))
    import sensor_profile as sp
    import gen_runtime as gr
    _, manifest_sha, errors = sp.load_generated(gr.plan()['out_dir'], gr.OPS_SHA)
    assert not errors, errors
    assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == gr.OPS_SHA[f] for f, p in gr.OPS_MODEL.items())
    native = source.parents[2] / 'map-20261014'
    entry = json.loads((native / 'worlds.json').read_text())['worlds']['v5_single/f1']
    assert all((native / entry[k]).is_file() for k in ('world', 'gt_map'))
    rid, org = str(uuid4()), uuid4()
    key = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=').decode()
    private(folder / 'server-keys.json', {rid: {'active': 'first-launch', 'keys': {'first-launch': key}}})
    private(folder / 'agent-keys.json', {'first-launch': key})
    with os.fdopen(os.open(folder / 'service-secret', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as out:
        out.write(secrets.token_urlsafe(48))
    private(folder / 'catalogue.json', {'worlds': [{'id': 'v5_single/f1',
        'world_file': str(native / entry['world']), 'map_file': str(native / entry['gt_map'])}],
        'slots': [{'robot_id': rid, 'org_id': str(org), 'key_path': str(folder / 'agent-keys.json'),
                   'replay_path': str(folder / 'replay.sqlite'), 'port': 9433}]})
    # Unix socket only: never connect to a system PostgreSQL or bind TCP.
    pgroot = folder / 'pg'
    pgroot.mkdir(mode=0o700)
    data = pgroot / 'data'
    initdb(['--auth=trust', '--encoding=UTF8', '--locale=C', '-U', 'postgres'], pgdata=data)
    pg_ctl(['-w', '-o', f'-h "" -k {pgroot} -p 9431', '-l', str(pgroot / 'pg.log'), 'start'], pgdata=data)
    def url(user):
        return URL.create('postgresql+psycopg', username=user, database='postgres',
            query={'host': str(pgroot), 'port': '9431'}).render_as_string(hide_password=False)
    engine = create_engine(url('postgres'))
    with engine.begin() as conn:
        for role in ('fh_migrate', 'fh_app', 'fh_readonly'):
            conn.execute(text(f'CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT'))
        conn.execute(text('REVOKE CREATE ON SCHEMA public FROM PUBLIC'))
        conn.execute(text('GRANT USAGE, CREATE ON SCHEMA public TO fh_migrate'))
    engine.dispose()
    os.environ['FH_MIGRATE_DATABASE_URL'] = url('fh_migrate')
    command.upgrade(Config(str(ROOT / 'apps/server/alembic.ini')), '0014')
    engine = create_engine(url('fh_migrate'))
    password = secrets.token_urlsafe(24)
    with Session(engine) as db:
        db.add(Organization(id=org, name='First launch isolated test', settings={}))
        db.flush()
        db.add(User(org_id=org, username='first-launch', display_name='First launch', role='OPERATOR',
                    password_hash=hash_password(password)))
        db.commit()
    with engine.connect() as conn:
        revision = conn.execute(text('select version_num from alembic_version')).scalar_one()
    engine.dispose()
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ROS_', 'RMW_', 'FH_'))
        and k not in ('CYCLONEDDS_URI', 'FASTRTPS_DEFAULT_PROFILES_FILE', 'FASTDDS_DEFAULT_PROFILES_FILE',
                     'FASTDDS_ENVIRONMENT_FILE', 'PYTHONPATH')}
    env.update(PYTHONDONTWRITEBYTECODE='1', PYTHONPATH=str(ROOT) + ':' + str(ROOT / 'apps/agent'),
        FH_DATABASE_URL=url('fh_app'), FH_ORG_ID=str(org), FH_FILES_ROOT=str(folder / 'server-files'),
        FH_PHONE_PASS_KEYS=str(folder / 'server-keys.json'), FH_SIM_AUTH_FILE=str(folder / 'service-secret'),
        FH_SIM_CATALOG=str(folder / 'catalogue.json'), FH_SIM_DOMAIN='93', FH_SIM_PORT='9430',
        FH_SIM_MAX_ROBOTS='1', FH_SIM_MANAGER_URL='http://127.0.0.1:9430',
        FH_SIM_AGENT_WS_URL='ws://127.0.0.1:9431/api/v1/agent/ws', FH_SIM_AGENT_HOST='127.0.0.1',
        FH_SIM_AGENT_PYTHON=str(args.python.absolute()), SIM_SOURCE=str(source),
        SIM_ROS_SETUP=str(args.setup.resolve()), SIM_RUN_DIR=str(folder / 'native'),
        FOOTHOLD_PHONE_ORIGINS='["http://localhost:9440"]')
    (folder / 'server-files').mkdir(mode=0o700)
    private(folder / 'environment.json', env)
    private(folder / 'driver-private.json', {'robot': rid, 'password': password})
    private(folder / 'prepared.json', {'revision': revision, 'manifest_sha': manifest_sha, 'tcp_database': False})
    print(json.dumps({'prepared': True, 'revision': revision, 'manifest_valid': True}))


def gate(folder):
    sys.path.insert(0, str(ROOT / 'apps/agent/tools/sim'))
    from isolation import resources, processes, dds_ports
    resource = resources()
    rows, denied = processes()
    ports, _ = dds_ports()
    listeners = subprocess.check_output(['ss', '-H', '-ltn',
        '( sport = :9430 or sport = :9431 or sport = :9433 or sport = :9440 )'], text=True)
    result = {**resource, 'domain93_count': sum(r['domain'] == '93' for r in rows),
        'dds_ports': ports, 'listeners_clear': not listeners.strip(), 'proc_permission_denied': denied}
    private(folder / ('gate-' + str(time.monotonic_ns()) + '.json'), result)
    # Coordinator clarified the formal gate as FIRST-LAUNCH's 2500 MiB;
    # 3500 MiB remains a reported headroom target, not a bypassed native gate.
    assert resource['mem_available_mib'] >= 2500 and resource['load1'] <= 9, 'resource gate'
    assert not result['domain93_count'] and not ports and not listeners.strip(), 'isolation gate'
    print(json.dumps(result))


def start(folder):
    gate(folder)
    env = json.loads((folder / 'environment.json').read_text())
    python = env['FH_SIM_AGENT_PYTHON']
    children = {}
    for name, argv in [('server', [python, '-m', 'uvicorn', 'apps.server.fh_server.api:create_app',
            '--factory', '--host', '127.0.0.1', '--port', '9431', '--workers', '1', '--no-access-log']),
            ('manager', [python, str(Path(__file__).with_name('first_launch_instrument.py')), 'manager'])]:
        child_env = dict(env)
        if name == 'manager':
            child_env['FH_SIM_RUN'] = '1'
        with (folder / (name + '.log')).open('x') as log:
            child = subprocess.Popen(argv, env=child_env, cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
        children[name] = child.pid
        private(folder / (name + '-pid.json'), {'pid': child.pid,
            'start_ticks': Path(f'/proc/{child.pid}/stat').read_text().rsplit(')', 1)[1].split()[19]})
        port = 9431 if name == 'server' else 9430
        import socket
        deadline = time.monotonic() + 30
        while True:
            assert child.poll() is None, name + ' startup failed; preserve evidence and ask'
            try:
                with socket.create_connection(('127.0.0.1', port), .2):
                    break
            except OSError:
                assert time.monotonic() < deadline, name + ' startup timeout'
                time.sleep(.1)
    credentials = json.loads((folder / 'driver-private.json').read_text())
    status, auth = request('POST', '/auth/login', {'username': 'first-launch',
        'password': credentials['password'], 'client': 'app'})
    assert status == 200, 'login failed'
    credentials['bearer'] = auth['access_token']
    private(folder / 'session-private.json', credentials)
    sys.path.insert(0, str(ROOT / 'apps/agent/tools/sim'))
    from isolation import resources
    final_resources = resources()
    private(folder / 'post-gate.json', final_resources)
    assert final_resources['mem_available_mib'] >= 2500 and final_resources['load1'] <= 9, 'POST resource gate'
    started = time.monotonic()
    status, body = request('POST', '/simulation/robots', {'world_id': 'v5_single/f1', 'robot_id': credentials['robot']}, credentials['bearer'])
    private(folder / 'start-result.json', {'status': status, 'seconds': time.monotonic() - started,
        'state': body.get('state'), 'error': body.get('error')})
    print(json.dumps({'status': status, 'state': body.get('state'), 'error': body.get('error')}))
    assert status == 201 and body['state'] == 'RUNNING', 'launch failed; do not retry, preserve units and ask'


def observe_measure(folder):
    """One dependency chain: readiness -> measure -> observer exit -> DELETE."""
    import threading
    from apps.simmgr.environment import child_environment, BASE_KEYS
    from isolation import processes, dds_ports, resources
    env = json.loads((folder / 'environment.json').read_text())
    assert json.loads((folder / 'start-result.json').read_text())['state'] == 'RUNNING'
    assert not (folder / 'observer-pid.json').exists(), 'no observer reuse'
    observer_env = child_environment(93, {key: env[key] for key in BASE_KEYS if key in env})
    observer_env.update(PYTHONPATH=env['PYTHONPATH'], ROS_LOG_DIR=str(folder / 'observer-ros'))
    with (folder / 'observer.log').open('x') as log:
        observer = subprocess.Popen(['/bin/bash', '-c',
            'set -euo pipefail; source "$1"; exec /usr/bin/python3 "$2" "$3"',
            'first-launch-observer', env['SIM_ROS_SETUP'],
            str(Path(__file__).with_name('first_launch_observer.py')), str(folder)],
            env=observer_env, cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
    private(folder / 'observer-pid.json', {'pid': observer.pid,
        'start_ticks': Path(f'/proc/{observer.pid}/stat').read_text().rsplit(')', 1)[1].split()[19]})
    deadline = time.monotonic() + 15
    while not (folder / 'state.json').exists():
        assert observer.poll() is None, 'observer startup failed; driver forbidden'
        assert time.monotonic() < deadline, 'observer readiness timeout; driver forbidden'
        time.sleep(.05)
    private(folder / 'observer-ready.json', {'mono': time.monotonic(), 'pid': observer.pid})
    stop = threading.Event()
    sim_unit = json.loads((folder / 'native/unit.json').read_text())['unit']
    units = [sim_unit, 'fh-simmgr-agent-' + folder.name + '.service']
    def sample():
        with (folder / 'unit-samples.jsonl').open('x') as log:
            while not stop.is_set():
                rows = []
                for unit in units:
                    raw = subprocess.check_output(['systemctl','--user','show',unit,
                        '--property=MainPID,ActiveState,MemoryPeak,TasksCurrent,ControlGroup'], text=True)
                    rows.append({'unit': unit, **dict(line.split('=',1) for line in raw.splitlines() if '=' in line)})
                log.write(json.dumps({**resources(), 'units': rows}) + '\n'); log.flush()
                stop.wait(1)
    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    with (folder / 'driver.log').open('x') as log:
        result = subprocess.run([env['FH_SIM_AGENT_PYTHON'], str(Path(__file__).with_name('first_launch_measure.py')),
            '--episode', str(folder)], env=env, cwd=ROOT, stdout=log, stderr=log)
    stop.set(); sampler.join(5)
    # Always harvest observer, including a driver exception. A failed measurement
    # is preserved; only the explicitly authorized normal cleanup follows.
    observer.send_signal(signal.SIGINT)
    code = observer.wait(timeout=10)
    assert code == 0 and not Path(f'/proc/{observer.pid}').exists(), 'observer exit unconfirmed; DELETE forbidden'
    raw = subprocess.check_output(['ss', '-H', '-uapn'], text=True)
    assert f'pid={observer.pid},' not in raw, 'observer UDP sockets remain; DELETE forbidden'
    private(folder / 'observer-exited.json', {'mono': time.monotonic(), 'code': code, 'udp_absent': True})
    credentials = json.loads((folder / 'session-private.json').read_text())
    status, body = request('DELETE', '/simulation/robots/' + credentials['robot'], bearer=credentials['bearer'])
    private(folder / 'delete-result.json', {'status': status, 'body': body, 'driver_exit': result.returncode})
    print(json.dumps({'driver_exit': result.returncode, 'observer_exit': code, 'delete': status}))
    assert status == 204 and result.returncode == 0, 'measurement/cleanup failure; no retry'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'gate', 'start', 'observe_measure'])
    parser.add_argument('--episode', required=True, type=Path)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--python', type=Path)
    parser.add_argument('--setup', type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT / 'apps/agent/tools/sim'))
    if args.action == 'prepare':
        prepare(args)
    else:
        globals()[args.action](args.episode.resolve())

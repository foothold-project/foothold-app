"""Disposable real server + production ROS bridge, with credentials only in memory/env.

Uses the existing private PostgreSQL fixture and bootstrap/model/API paths; the
web preview runner is unsuitable because it persists raw credentials. No mocks.
"""
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time
from uuid import UUID, uuid4

from isolation import stamp, write

ROOT = Path(__file__).resolve().parents[4]


def probe(folder, ros_environment, simulation):
    from alembic import command
    from alembic.config import Config
    import httpx
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session
    from websockets.sync.client import connect
    from apps.server.tests.postgres import temporary_postgres
    from apps.server.fh_server.bootstrap import organization
    from apps.server.fh_server.models import Robot, Event
    from apps.server.fh_server.security import digest

    def terminate(child):
        if child and child.poll() is None:
            child.send_signal(signal.SIGINT)
            child.wait(timeout=15)

    # Bind before spawn; only the authorized loopback range, no probing production.
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    for port in range(9020, 9040):
        try:
            sock.bind(('127.0.0.1', port))
            break
        except OSError:
            continue
    else:
        sock.close()
        raise RuntimeError('no available authorized development port')
    port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    server = bridge = None
    org_id = uuid4()
    admin_password = secrets.token_urlsafe(32)
    operator_password = secrets.token_urlsafe(32)
    result = {'stage3': 'pending', 'stage4': 'pending'}
    prior = {k: os.environ.get(k) for k in ('FH_MIGRATE_DATABASE_URL', 'FH_ORG_ID', 'FH_ORG_NAME',
             'FH_BOOTSTRAP_USERNAME', 'FH_BOOTSTRAP_DISPLAY_NAME', 'FH_BOOTSTRAP_PASSWORD')}
    try:
        with temporary_postgres() as db_urls, (folder / 'server.log').open('w') as server_log, (folder / 'bridge.log').open('w') as bridge_log:
            os.environ.update(FH_MIGRATE_DATABASE_URL=db_urls['migrate'], FH_ORG_ID=str(org_id),
                FH_ORG_NAME='격리 시뮬 시험', FH_BOOTSTRAP_USERNAME='sim-admin',
                FH_BOOTSTRAP_DISPLAY_NAME='시험 총괄', FH_BOOTSTRAP_PASSWORD=admin_password)
            command.upgrade(Config(str(ROOT / 'apps/server/alembic.ini')), 'head')
            organization()
            engine = create_engine(db_urls['migrate'])
            try:
                env = {**os.environ, 'FH_DATABASE_URL': db_urls['app'], 'FH_ORG_ID': str(org_id)}
                # Do not copy bootstrap credentials into unrelated subprocesses.
                for key in ('FH_BOOTSTRAP_PASSWORD', 'FH_MIGRATE_DATABASE_URL'):
                    env.pop(key, None)
                server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'apps.server.fh_server.main:app',
                    '--fd', str(sock.fileno()), '--workers', '1', '--ws-max-size', '4096', '--no-proxy-headers'],
                    cwd=ROOT, env=env, stdout=server_log, stderr=server_log, pass_fds=(sock.fileno(),))
                with httpx.Client(base_url=base, timeout=3) as http:
                    deadline = time.monotonic() + 12
                    while time.monotonic() < deadline:
                        try:
                            response = http.post('/api/v1/auth/login', json={'username': 'sim-admin', 'password': admin_password, 'client': 'app'})
                            if response.status_code == 200:
                                break
                        except httpx.TransportError:
                            pass
                        if server.poll() is not None:
                            raise RuntimeError('private server exited')
                        time.sleep(.1)
                    else:
                        raise RuntimeError('private server login deadline')
                    admin = response.json()['access_token']
                    headers = {'authorization': 'Bearer ' + admin}
                    response = http.post('/api/v1/users', headers=headers, json={'username': 'sim-operator',
                        'display_name': '시험 운영', 'role': 'OPERATOR', 'temp_password': operator_password})
                    response.raise_for_status()
                    operator_id = UUID(response.json()['id'])
                    # No robot creation API exists at this baseline. Reuse the
                    # development stack's ORM registration, with no raw token file.
                    with Session(engine) as db:
                        robot = Robot(org_id=org_id, name='Isolated Go2', model='unitree_go2',
                            owner_user_id=operator_id, agent_token_hash=digest(secrets.token_urlsafe(32)))
                        db.add(robot)
                        db.commit()
                        robot_id = str(robot.id)
                    response = http.post(f'/api/v1/robots/{robot_id}/agent-token', headers=headers)
                    response.raise_for_status()
                    agent_token = response.json()['agent_token']
                    response = http.post('/api/v1/auth/login', json={'username': 'sim-operator',
                        'password': operator_password, 'client': 'app'})
                    response.raise_for_status()
                    operator = response.json()['access_token']
                    write(folder / 'server-start.json', {**stamp(), 'port': port, 'robot_id': robot_id,
                        'postgres': 'private Unix socket only', 'accounts': ['ORG_ADMIN', 'OPERATOR'],
                        'token_issued_via': 'agent-token API', 'registration': 'existing development ORM pattern'})
                    result['stage3'] = 'passed'
                    bridge_env = {**ros_environment, 'FOOTHOLD_ROBOT_ID': robot_id,
                        'FOOTHOLD_AGENT_WS_URL': base.replace('http:', 'ws:') + '/api/v1/agent/ws',
                        'FOOTHOLD_AGENT_TOKEN': agent_token, 'ROS_LOG_DIR': str(folder / 'bridge-ros')}
                    bridge = subprocess.Popen([sys.executable, '-m', 'foothold_agent.ros_bridge'], cwd=ROOT,
                        env=bridge_env, stdout=bridge_log, stderr=bridge_log)
                    samples = []
                    with connect(base.replace('http:', 'ws:') + '/api/v1/ws', additional_headers={
                            'authorization': 'Bearer ' + operator}) as screen:
                        screen.send(json.dumps({'t': 'sub', 'id': 'd1-observe', 'proto': 'fh-rt/1',
                            'robots': [robot_id], 'streams': ['state']}))
                        deadline = time.monotonic() + 18
                        while time.monotonic() < deadline:
                            if simulation.reason or bridge.poll() is not None:
                                raise RuntimeError('simulation/bridge stopped while connecting')
                            frame = json.loads(screen.recv(timeout=2))
                            if frame.get('t') == 'state':
                                samples.append({**stamp(), 'frame': frame})
                                if (frame.get('connection') == 'ONLINE' and frame.get('latched') is True
                                        and frame.get('applied') == [0, 0, 0]):
                                    if sum(s['frame'].get('status') == 'STOP_LATCHED' for s in samples) >= 5:
                                        break
                        else:
                            raise RuntimeError('authenticated live state not received')
                    write(folder / 'server-ws-state.json', samples)
                    # Repeat STOP while already locked; this is not a braking test.
                    sent = stamp()
                    response = http.post(f'/api/v1/robots/{robot_id}/stop', headers={'authorization': 'Bearer ' + operator})
                    response.raise_for_status()
                    write(folder / 'http-stop.json', {'request': sent, 'accepted': stamp(), 'status': response.status_code,
                        'scope': 'repeat STOP while already stationary; no motion or braking measurement'})
                    time.sleep(2)
                    response = http.get('/api/v1/robots?scope=all', headers=headers)
                    response.raise_for_status()
                    summary = next(r for r in response.json()['items'] if r['id'] == robot_id)
                    write(folder / 'robots-summary.json', {**stamp(), 'summary': summary})
                    with Session(engine) as db:
                        events = list(db.scalars(select(Event).where(Event.robot_id == UUID(robot_id))))
                        write(folder / 'server-events.json', [{'code': e.code, 'at': e.at.isoformat()} for e in events])
                    if not any(e.code == 'AGENT_CONNECTED' for e in events):
                        raise RuntimeError('server audit did not confirm accepted agent hello')
                    result['stage4'] = 'passed'
                    if summary['connection'] != 'ONLINE' or summary['status'] != 'STOP_LATCHED':
                        result['remaining_problem'] = 'REST /robots summary stays OFFLINE/null despite authenticated WS ONLINE/STOP_LATCHED (server S1 scope)'
                    from motion import exercise
                    result['stage5'] = exercise(folder, base, operator, robot_id, simulation)
            finally:
                try:
                    terminate(bridge)
                finally:
                    terminate(server)
                    engine.dispose()
    finally:
        sock.close()
        for key, value in prior.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        with socket.socket() as check:
            check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            check.bind(('127.0.0.1', port))
        write(folder / 'server-cleanup.json', {**stamp(), 'port': port, 'bind_available': True,
            'bridge_returncode': bridge.returncode if bridge else None,
            'server_returncode': server.returncode if server else None})
    return result

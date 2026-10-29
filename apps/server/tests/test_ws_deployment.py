"""Real uvicorn upgrade smoke test; loopback ephemeral socket, disposable DB only."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import Request, urlopen
from uuid import uuid4

from sqlalchemy import create_engine
from sqlalchemy.orm import Session as DBSession
from websockets.sync.client import connect

from apps.server.fh_server.models import Robot
from apps.server.fh_server.security import digest
from .test_realtime import hello, state


def test_deployment_pins_websocket_backend_and_wire_size():
    root = Path(__file__).resolve().parents[1]
    assert 'websockets==15.0.1' in (root / 'requirements.txt').read_text().splitlines()
    assert '--ws-max-size 4096' in (root / 'README.md').read_text()


def test_readme_uvicorn_really_upgrades_screen_and_agent(seeded, tmp_path):
    rid = seeded['robots']['mine']
    raw = 'fake-smoke-agent-token'
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.get(Robot, rid).agent_token_hash = digest(raw)
        db.get(Robot, rid).simulation = True
        db.commit()
    engine.dispose()
    # Passing an already bound ephemeral fd avoids port probes and bind races.
    with socket.socket() as sock, (tmp_path / 'uvicorn.log').open('w+') as log:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        env = {**os.environ, 'FH_DATABASE_URL': seeded['urls']['app'], 'FH_ORG_ID': str(seeded['org'])}
        process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'apps.server.fh_server.main:app',
            '--fd', str(sock.fileno()), '--ws-max-size', '4096', '--no-proxy-headers'],
            env=env, stdout=log, stderr=log, pass_fds=(sock.fileno(),))
        try:
            url = f'http://127.0.0.1:{port}'
            deadline = time.monotonic() + 10
            while True:
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError(log.read())
                try:
                    req = Request(url + '/api/v1/auth/login', data=json.dumps({
                        'username': 'one', 'password': 'fake-test-password', 'client': 'app'}).encode(),
                        headers={'content-type': 'application/json'})
                    with urlopen(req, timeout=.5) as response:
                        access = json.load(response)['access_token']
                    break
                except OSError:
                    assert time.monotonic() < deadline
                    time.sleep(.02)
            def read(ws, kind):
                for _ in range(100):
                    frame = json.loads(ws.recv(timeout=2))
                    if frame.get('t') == kind:
                        return frame
                raise AssertionError('Missing ' + kind)
            with connect(f'ws://127.0.0.1:{port}/api/v1/agent/ws', additional_headers={
                    'authorization': 'Bearer ' + raw}) as ag, connect(f'ws://127.0.0.1:{port}/api/v1/ws',
                    additional_headers={'authorization': 'Bearer ' + access}) as screen:
                assert ag.response.status_code == screen.response.status_code == 101
                ag.send(json.dumps(hello()))
                assert read(ag, 'lease')['lease_id'] is None
                read(ag, 'stop')
                screen.send(json.dumps({'t': 'ping', 'id': 'smoke', 'proto': 'fh-rt/1'}))
                assert read(screen, 'reply')['ok']
                screen.send(json.dumps({'t': 'lease.take', 'id': 'take', 'robot': str(rid)}))
                assert read(screen, 'reply')['ok']
                read(ag, 'lease'); stop = read(ag, 'stop')
                ag.send(json.dumps(state(3, stop_ref=stop['stop_ref'])))
                assert read(ag, 'lease')['lease_id']
                screen.send(json.dumps({'t': 'stop', 'id': 'stop', 'robot': str(rid)}))
                assert read(ag, 'stop')['by_user_id'] == str(seeded['users']['one'])
            log.flush(); log.seek(0)
            assert 'No supported WebSocket library' not in log.read()
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

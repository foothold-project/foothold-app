"""Private uvicorn process and an optional owner-lock blocker for integration tests."""
from contextlib import contextmanager
import json
import os
import socket
import subprocess
import sys
import time
from urllib.request import Request, urlopen

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session as DBSession

from apps.server.fh_server.models import Robot
from apps.server.fh_server.security import digest


@contextmanager
def server_process(seeded, tmp_path, *, hold_owner=False, app_target='apps.server.fh_server.main:app'):
    engine = create_engine(seeded['urls']['migrate'])
    admin = create_engine(seeded['urls']['admin'])
    raw = 'fake-recovery-agent-token'
    with DBSession(engine) as db:
        db.get(Robot, seeded['robots']['mine']).agent_token_hash = digest(raw)
        db.get(Robot, seeded['robots']['mine']).simulation = True
        db.commit()
    blocker = engine.connect() if hold_owner else None
    key = 'fh-realtime:' + str(seeded['org'])
    if blocker is not None:
        blocker.execute(text('SELECT pg_advisory_lock(hashtextextended(:key, 0))'), {'key': key})
        blocker.commit()
    with socket.socket() as sock, (tmp_path / 'uvicorn-recovery.log').open('w+') as log:
        sock.bind(('127.0.0.1', 0))
        env = {**os.environ, 'FH_DATABASE_URL': seeded['urls']['app'], 'FH_ORG_ID': str(seeded['org'])}
        process = subprocess.Popen([sys.executable, '-m', 'uvicorn', app_target,
            '--fd', str(sock.fileno()), '--ws-max-size', '4096', '--no-proxy-headers'],
            env=env, stdout=log, stderr=log, pass_fds=(sock.fileno(),))
        try:
            port = sock.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            deadline = time.monotonic() + 10
            while True:
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError(log.read())
                try:
                    req = Request(base + '/api/v1/auth/login', data=json.dumps({
                        'username': 'one', 'password': 'fake-test-password', 'client': 'app'}).encode(),
                        headers={'content-type': 'application/json'})
                    with urlopen(req, timeout=.5) as response:
                        access = json.load(response)['access_token']
                    break
                except OSError:
                    assert time.monotonic() < deadline
                    time.sleep(.02)
            yield {'base': f'ws://127.0.0.1:{port}', 'agent_token': raw, 'access': access,
                   'blocker': blocker, 'engine': engine, 'admin': admin, 'key': key}
        finally:
            if blocker is not None:
                with __import__('contextlib').suppress(Exception):
                    blocker.execute(text('SELECT pg_advisory_unlock_all()'))
                    blocker.commit()
                blocker.close()
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            engine.dispose()
            admin.dispose()

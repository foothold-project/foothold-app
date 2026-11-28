"""Real server + real simmgr (FH_SIM_LOCAL_BACKEND=mujoco) + real mujoco_bridge + Node MuJoCo child.

Skipped unless FH_SIM_SRC (MuJoCo wasm / policy / Go2 assets) is set. Disposable DB only;
nothing is sent to a real robot. Measures through the public API only:
POST /simulation/robots returns RUNNING (mujoco-local) only after the agent reached the
server -> agent ONLINE -> lease -> unlock -> short walk -> STOP latched -> DELETE reaps
the agent process group. Writes measurements to FH_E2E_OUT (JSON) when set.
FH_E2E_PORT pins the server port (default: any free port).
"""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import pytest
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[3]
pytestmark = pytest.mark.skipif(not os.environ.get('FH_SIM_SRC'), reason='FH_SIM_SRC (MuJoCo assets) not set')


def wait(predicate, seconds, what):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(.02)
    raise AssertionError('timeout: ' + what)


def free_port(candidates):
    for port in candidates:
        with socket.socket() as sock:
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                continue
            return port
    raise AssertionError('no free port')


def private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(text)
    return str(path)


def group_alive(group):
    for entry in os.listdir('/proc'):
        if entry.isdigit():
            try:
                fields = Path('/proc', entry, 'stat').read_text().rsplit(')', 1)[1].split()
            except OSError:
                continue
            if int(fields[2]) == group and fields[0] != 'Z':
                return True
    return False


def test_simmgr_mujoco_robot_is_live_through_the_api(seeded, tmp_path):
    rid, org = str(uuid4()), str(seeded['org'])
    server_port = int(os.environ.get('FH_E2E_PORT') or free_port(range(18960, 18990)))
    manager_port = free_port(range(9440, 9450))
    slot_port = free_port(p for p in range(9449, 9439, -1) if p != manager_port)
    extra = str(server_port)
    service_key = private(tmp_path / 'service.key', base64.urlsafe_b64encode(os.urandom(32)).decode())
    pass_keys = private(tmp_path / 'pass-keys.json', json.dumps({rid: {'active': 'test', 'keys': {
        'test': base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode()}}}))
    catalog = tmp_path / 'catalog.json'
    catalog.write_text(json.dumps({'worlds': [{'id': 'collapsed-house-v2', 'name': '무너진 집 (MuJoCo)',
        'world_file': '/nonexistent/mujoco', 'map_file': '/nonexistent/mujoco'}],
        'slots': [{'robot_id': rid, 'org_id': org, 'key_path': '/nonexistent/key',
                   'replay_path': '/nonexistent/replay', 'port': slot_port}]}))
    run_dir = tmp_path / 'runs'
    base = {k: v for k, v in os.environ.items() if not k.startswith(('ROS_', 'RMW_', 'FH_SIM_RUN'))}
    server = manager = None
    result = {}
    with (tmp_path / 'server.log').open('w+') as slog, (tmp_path / 'simmgr.log').open('w+') as mlog:
        try:
            manager = subprocess.Popen([sys.executable, '-m', 'apps.simmgr'], cwd=ROOT, stdout=mlog, stderr=mlog,
                env={**base, 'PYTHONPATH': os.pathsep.join((str(ROOT), str(ROOT / 'apps' / 'agent'))),
                     'FH_SIM_CATALOG': str(catalog), 'FH_SIM_AUTH_FILE': service_key,
                     'FH_SIM_PORT': str(manager_port), 'FH_SIM_EXTRA_PORTS': extra,
                     'FH_SIM_AGENT_WS_URL': f'ws://127.0.0.1:{server_port}/api/v1/agent/ws',
                     'FH_SIM_LOCAL_BACKEND': 'mujoco', 'FH_SIM_AGENT_PYTHON': sys.executable,
                     'SIM_RUN_DIR': str(run_dir), 'FH_SIM_RUNTIME_SECONDS': '600'})
            server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'apps.server.fh_server.main:app',
                '--host', '127.0.0.1', '--port', str(server_port), '--ws-max-size', '4096', '--no-proxy-headers'],
                cwd=ROOT, stdout=slog, stderr=slog,
                env={**base, 'FH_DATABASE_URL': seeded['urls']['app'], 'FH_ORG_ID': org,
                     'FH_SIM_MANAGER_URL': f'http://127.0.0.1:{manager_port}', 'FH_SIM_AUTH_FILE': service_key,
                     'FH_SIM_EXTRA_PORTS': extra, 'FH_PHONE_PASS_KEYS': pass_keys})
            url = f'http://127.0.0.1:{server_port}'

            def api(method, path, body=None, token=None, timeout=200):
                req = Request(url + path, method=method, data=None if body is None else json.dumps(body).encode(),
                              headers={'content-type': 'application/json',
                                       **({'authorization': 'Bearer ' + token} if token else {})})
                try:
                    with urlopen(req, timeout=timeout) as response:
                        raw = response.read()
                        return response.status, json.loads(raw) if raw else None
                except HTTPError as error:
                    return error.code, json.loads(error.read() or b'null')

            def login():
                try:
                    return api('POST', '/api/v1/auth/login', {'username': 'one', 'password': 'fake-test-password',
                                                               'client': 'app'}, timeout=1)[1]['access_token']
                except OSError:
                    assert server.poll() is None and manager.poll() is None, 'server or simmgr exited'
            access = wait(login, 30, 'server login')

            def catalogue():
                assert manager.poll() is None, 'simmgr exited'
                status, body = api('GET', '/api/v1/simulation/worlds', token=access)
                return body if status == 200 else None
            assert wait(catalogue, 30, 'simmgr catalogue')['launcher'] == 'mujoco-local'
            t0 = time.monotonic()
            status, robot = api('POST', '/api/v1/simulation/robots',
                                {'world_id': 'collapsed-house-v2', 'robot_id': rid}, token=access)
            result['post_s'] = round(time.monotonic() - t0, 2)
            assert status == 201, robot
            result['post_state'], result['launcher'] = robot['state'], robot['launcher']
            assert robot['state'] == 'RUNNING' and robot['launcher'] == 'mujoco-local'
            agent_pid = int((run_dir / rid / 'ready').read_text())

            with connect(url.replace('http:', 'ws:') + '/api/v1/ws',
                         additional_headers={'authorization': 'Bearer ' + access}) as ws:
                screen = {'state': {}, 'lease': None}
                counter = [0]

                def send(kind, **fields):
                    counter[0] += 1
                    m = {'t': kind, 'id': f'e2e-{counter[0]}', **fields}
                    if kind != 'sub':
                        m['robot'] = rid
                    if counter[0] == 1:
                        m['proto'] = 'fh-rt/1'
                    ws.send(json.dumps(m))
                    return time.monotonic()

                def pump(seconds=.01):
                    timeout = seconds
                    while True:
                        try:
                            f = json.loads(ws.recv(timeout=timeout))
                        except TimeoutError:
                            return
                        timeout = 0
                        f = f.get('_delivery', f)
                        if f.get('t') == 'state' and f.get('robot') == rid:
                            screen['state'] = {**f, '_rx': time.monotonic()}
                        elif f.get('t') == 'lease' and f.get('lease_id'):
                            screen['lease'] = f['lease_id']

                def until(predicate, seconds, what):
                    end = time.monotonic() + seconds
                    while time.monotonic() < end:
                        pump()
                        value = predicate()
                        if value:
                            return value
                    raise AssertionError('timeout: ' + what + ' ' + json.dumps(screen['state'])[:300])

                def pump_for(seconds):
                    end = time.monotonic() + seconds
                    while (left := end - time.monotonic()) > 0:
                        pump(min(left, .01))

                send('sub', robots=[rid], streams=['state'])
                online = until(lambda: screen['state'].get('connection') == 'ONLINE' and screen['state'], 20, 'online')
                result['online_latched'] = online.get('latched')
                send('lease.take')
                until(lambda: screen['lease'], 5, 'lease')
                pump_for(1.0)
                send('unlock', lease_id=screen['lease'], stop_gen=screen['state']['stop_gen'])
                until(lambda: screen['state'].get('latched') is False, 5, 'unlocked')
                seq = [0]

                def cmd(axes):
                    seq[0] += 1
                    send('cmd', lease_id=screen['lease'], seq=seq[0], axes=axes)
                end = time.monotonic() + .25
                while time.monotonic() < end:  # a held deadman starts from zero, as in #538
                    cmd([0, 0, 0]); pump_for(.05)
                end = time.monotonic() + 2.0
                applied, top = None, 0.0
                while time.monotonic() < end:
                    cmd([1, 0, 0])
                    pump_for(.05)
                    if (screen['state'].get('applied') or [0])[0] > 0:
                        applied = screen['state']['applied']
                    top = max(top, screen['state'].get('speed') or 0.0)
                result['walk_applied'], result['walk_top_speed'] = applied, round(top, 3)
                assert applied and applied[0] > 0 and top > .2, (applied, top)
                stop_t = send('stop')
                stopped = until(lambda: screen['state'].get('latched') is True
                                and screen['state'].get('applied') == [0, 0, 0]
                                and screen['state']['_rx'] > stop_t and screen['state'], 2, 'stop latched')
                result['screen_stop_s'] = round(stopped['_rx'] - stop_t, 3)
                refused_t0 = time.monotonic()
                while time.monotonic() - refused_t0 < 1.0:
                    cmd([1, 0, 0]); pump_for(.05)
                    assert screen['state'].get('latched') is True and screen['state'].get('applied') == [0, 0, 0]
                result['cmd_after_stop_refused'] = True

            t1 = time.monotonic()
            status, _ = api('DELETE', '/api/v1/simulation/robots/' + rid, token=access)
            result['delete_status'], result['delete_s'] = status, round(time.monotonic() - t1, 2)
            assert status == 204
            result['agent_group_gone'] = not group_alive(agent_pid)
            assert result['agent_group_gone']
            status, listing = api('GET', '/api/v1/simulation/robots', token=access)
            assert status == 200 and listing['items'] == []
        finally:
            for p in (server, manager):
                if p is not None and p.poll() is None:
                    p.terminate()
                    try:
                        p.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        p.kill(); p.wait(timeout=5)
            if os.environ.get('FH_E2E_OUT'):
                Path(os.environ['FH_E2E_OUT']).write_text(json.dumps(result, ensure_ascii=False, indent=1))
            print(json.dumps(result, ensure_ascii=False))
            for log in (mlog, slog):
                log.flush(); log.seek(0)
                tail = log.read()[-2500:]
                if 'Traceback' in tail or 'ERROR' in tail:
                    print(tail)
            agent_log = run_dir / rid / 'agent.log'
            if agent_log.exists() and 'Traceback' in (text := agent_log.read_text()):
                print(text[-2500:])

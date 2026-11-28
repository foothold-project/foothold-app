"""Real uvicorn + real mujoco_bridge agent + real Node MuJoCo child; disposable DB only.

Skipped unless FH_SIM_SRC (MuJoCo wasm / policy / Go2 assets) is set. Measures:
lease -> unlock -> cmd walks 1 m (child body position) -> STOP gives cmd 0 + latched
within 0.5 s -> cmd without unlock is refused (applied stays 0, body stays).
Writes measurements to FH_E2E_OUT (JSON) when set.
"""
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.request import Request, urlopen

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as DBSession
from websockets.sync.client import connect

from apps.server.fh_server.models import Robot
from apps.server.fh_server.security import digest

ROOT = Path(__file__).resolve().parents[3]
pytestmark = pytest.mark.skipif(not os.environ.get('FH_SIM_SRC'), reason='FH_SIM_SRC (MuJoCo assets) not set')


def wait(predicate, seconds, what):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(.005)
    raise AssertionError('timeout: ' + what)


def test_mujoco_agent_lease_walk_stop_refuse(seeded, tmp_path):
    rid, raw = str(seeded['robots']['mine']), 'fake-mujoco-agent-token'
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        robot.agent_token_hash, robot.simulation = digest(raw), True
        db.commit()
    engine.dispose()
    tap = tmp_path / 'child-states.jsonl'
    server = agent = None
    with socket.socket() as sock, (tmp_path / 'uvicorn.log').open('w+') as slog, \
            (tmp_path / 'agent.log').open('w+') as alog:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        try:
            server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'apps.server.fh_server.main:app',
                '--fd', str(sock.fileno()), '--ws-max-size', '4096', '--no-proxy-headers'], cwd=ROOT,
                env={**os.environ, 'FH_DATABASE_URL': seeded['urls']['app'], 'FH_ORG_ID': str(seeded['org'])},
                stdout=slog, stderr=slog, pass_fds=(sock.fileno(),))
            url = f'http://127.0.0.1:{port}'

            def login():
                try:
                    req = Request(url + '/api/v1/auth/login', data=json.dumps({'username': 'one',
                        'password': 'fake-test-password', 'client': 'app'}).encode(),
                        headers={'content-type': 'application/json'})
                    with urlopen(req, timeout=.5) as response:
                        return json.load(response)['access_token']
                except OSError:
                    assert server.poll() is None, 'server exited'
            access = wait(login, 15, 'server login')
            agent = subprocess.Popen([sys.executable, '-m', 'foothold_agent.mujoco_bridge'], cwd=ROOT,
                env={**os.environ, 'PYTHONPATH': str(ROOT / 'apps' / 'agent'),
                     'FOOTHOLD_AGENT_WS_URL': f'ws://127.0.0.1:{port}/api/v1/agent/ws',
                     'FOOTHOLD_AGENT_TOKEN': raw, 'FH_SIM_STATE_LOG': str(tap),
                     'FH_SIM_BATTERY_START': '90', 'FH_SIM_BATTERY_DRAIN': '0.05'},
                stdout=alog, stderr=alog)

            def child():
                try:
                    last = tap.read_text().splitlines()[-1]
                    return json.loads(last)
                except (OSError, IndexError, ValueError):
                    return None

            with connect(url.replace('http:', 'ws:') + '/api/v1/ws',
                         additional_headers={'authorization': 'Bearer ' + access}) as ws:
                screen = {'state': {}, 'lease': None, 'replies': {}}
                counter = [0]

                def send(kind, **fields):
                    counter[0] += 1
                    m = {'t': kind, 'id': f'e2e-{counter[0]}', **fields}
                    if kind != 'sub':
                        m['robot'] = rid
                    if counter[0] == 1:
                        m['proto'] = 'fh-rt/1'
                    ws.send(json.dumps(m))
                    return m['id'], time.monotonic()

                def pump(seconds=.01):
                    # Drain everything queued: replies and states must not back up the server queue.
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
                        elif f.get('t') == 'reply':
                            screen['replies'][f.get('id')] = f

                def pump_for(seconds):
                    # Paces commands by wall time (server ingress budget), draining frames meanwhile.
                    end = time.monotonic() + seconds
                    while (left := end - time.monotonic()) > 0:
                        pump(min(left, .01))

                def until(predicate, seconds, what):
                    end = time.monotonic() + seconds
                    while time.monotonic() < end:
                        pump()
                        value = predicate()
                        if value:
                            return value
                    raise AssertionError('timeout: ' + what + ' screen=' + json.dumps(screen['state'])[:400])

                send('sub', robots=[rid], streams=['state'])
                s = until(lambda: screen['state'].get('connection') == 'ONLINE' and screen['state'].get('latched') is True
                          and screen['state'], 40, 'agent online latched')
                online = dict(s)
                send('lease.take')
                until(lambda: screen['lease'], 5, 'lease')
                until(lambda: (c := child()) and c['state']['body_still'] and c['state']['stop_requested'], 10, 'still')
                send('unlock', lease_id=screen['lease'], stop_gen=screen['state']['stop_gen'])
                until(lambda: screen['state'].get('latched') is False, 5, 'unlocked')
                seq = [0]

                def cmd(axes):
                    seq[0] += 1
                    return send('cmd', lease_id=screen['lease'], seq=seq[0], axes=axes)
                end = time.monotonic() + .25
                while time.monotonic() < end:
                    cmd([0, 0, 0]); pump_for(.05)
                start = child()['state']
                walk_t0 = time.monotonic()
                moved = 0.0
                applied_seen = None
                while moved < 1.0:
                    assert time.monotonic() - walk_t0 < 10, f'walk timeout moved={moved:.3f}'
                    cmd([1, 0, 0])
                    pump_for(.05)
                    c = child()['state']
                    moved = math.hypot(c['x'] - start['x'], c['y'] - start['y'])
                    if screen['state'].get('applied', [0])[0] > 0:
                        applied_seen = screen['state']['applied']
                walk_s = time.monotonic() - walk_t0
                walking_screen = dict(screen['state'])
                _, stop_t = send('stop')
                stopped = until(lambda: screen['state'].get('latched') is True and screen['state'].get('applied') == [0, 0, 0]
                                and screen['state']['_rx'] > stop_t and screen['state'], 2, 'screen latched')
                screen_stop_s = stopped['_rx'] - stop_t
                zero = wait(lambda: (c := child()) and c['mono'] >= 0 and c['state']['cmd_applied'] == [0, 0, 0]
                            and c['state']['stop_requested'] and c, 2, 'child zero')
                # Host monotonic clocks are the same machine; the tap stamps receipt in the agent.
                child_stop_s = zero['mono'] - stop_t if zero['mono'] > stop_t else 0.0
                time.sleep(1.0)
                rest = child()['state']
                refused_t0 = time.monotonic()
                while time.monotonic() - refused_t0 < 1.0:
                    cmd([1, 0, 0]); pump_for(.05)
                    assert child()['state']['cmd_applied'] == [0, 0, 0]
                    assert screen['state'].get('latched') is True and screen['state'].get('applied') == [0, 0, 0]
                after = child()['state']
                refused_move = math.hypot(after['x'] - rest['x'], after['y'] - rest['y'])
                result = dict(
                    online_state={k: online.get(k) for k in ('connection', 'latched', 'stop_gen', 'battery', 'devices', 'speed')},
                    walk_m=round(moved, 3), walk_s=round(walk_s, 2), walk_applied=applied_seen,
                    walking_speed=walking_screen.get('speed'), walking_battery=walking_screen.get('battery'),
                    screen_stop_s=round(screen_stop_s, 3), child_stop_s=round(child_stop_s, 3),
                    refused_move_m=round(refused_move, 4), upright_end=round(after['upright'], 3),
                    agent_mode_note='mode is on the agent wire; screen state does not carry it')
                if os.environ.get('FH_E2E_OUT'):
                    Path(os.environ['FH_E2E_OUT']).write_text(json.dumps(result, ensure_ascii=False, indent=1))
                print(json.dumps(result, ensure_ascii=False))
                assert moved >= 1.0 and applied_seen == [0.6, 0.0, 0.0]
                assert screen_stop_s <= .5 and child_stop_s <= .5
                assert refused_move < .1
                assert online['battery']['soc'] is not None and online['devices']
        finally:
            for p in (agent, server):
                if p is not None and p.poll() is None:
                    p.terminate()
                    try:
                        p.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        p.kill(); p.wait(timeout=5)
            alog.flush(); alog.seek(0)
            tail = alog.read()[-3000:]
            if 'Traceback' in tail:
                print(tail)

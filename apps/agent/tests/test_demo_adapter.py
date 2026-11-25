"""Demo robots speak the real link protocol: schema-valid state / run.update, no command authority."""
import asyncio
import json
import os

import pytest

jsonschema = pytest.importorskip('jsonschema')
pytest.importorskip('yaml')

from foothold_agent.demo import config, replay, scenario as sc
from foothold_agent.demo.adapter import DemoSession, Fleet, run
from foothold_agent.go2_readonly.state import SDK_JOINTS
from foothold_agent.link.client import Settings

HERE = os.path.dirname(__file__)
SCHEMA = os.path.join(HERE, '..', '..', 'contracts', 'schema')
EXAMPLE = os.path.join(HERE, 'fixtures', 'demo', 'scenario-small.yaml')
TRACE = os.path.join(HERE, 'fixtures', 'demo', 'trace-slices.jsonl')


def validator(name):
    with open(os.path.join(SCHEMA, f'{name}.json'), encoding='utf-8') as fh:
        schema = json.load(fh)
    schema.pop('$id')  # relative ids confuse the resolver; all refs are local #/$defs
    return jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())


STATE, RUN = validator('AgentState'), validator('AgentRunUpdate')


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


def scenario(**edits):
    import yaml
    with open(EXAMPLE, encoding='utf-8') as fh:
        doc = yaml.safe_load(fh)
    doc['robots'][0]['schedule'].insert(0, {'at': '06:00', 'mission': 'patrol_a'})  # due at start
    for key, value in edits.items():
        doc[key] = value
    return sc.parse(doc)


def fleet(speed=1.0, clock=None):
    clock = clock or Clock()
    return Fleet(scenario(), replay.index([TRACE]), speed=speed, now=clock, wall=lambda: 1795600000.0), clock


def frames(session, kind):
    return [m for m in session.tick().messages if m['t'] == kind]


def test_states_and_run_updates_validate_against_contract_schemas():
    f, clock = fleet()
    sessions = f.sessions
    assert set(sessions) == {'go2-a', 'go2-b'}
    for session in sessions.values():
        hello = session.connect().messages
        assert hello[0]['t'] == 'hello' and hello[0]['robot_model'] == 'unitree_go2'
    seen_runs = []
    for _ in range(300):  # 30 s at 10 Hz
        clock.t += 0.1
        f.pump()
        for rid, session in sessions.items():
            messages = session.tick().messages
            for m in messages:
                if m['t'] == 'state':
                    STATE.validate(m)
                elif m['t'] == 'run.update':
                    RUN.validate(m)
                    seen_runs.append((rid, m))
    assert seen_runs and all(rid == 'go2-a' for rid, _ in seen_runs)
    assert seen_runs[0][1]['status'] == 'MOVING' and seen_runs[0][1]['progress'] == {'done': 0, 'total': 7}


def test_state_carries_sim_pose_battery_and_recorded_joints():
    f, clock = fleet()
    session = f.sessions['go2-a']
    session.connect()
    for _ in range(50):
        clock.t += 0.1
        f.pump()
    clock.t += 0.2
    f.pump()
    state = frames(session, 'state')[-1]
    snap = f.sim.snapshot('go2-a')
    pose = state['pose']
    assert pose['floor_id'] == '00000000-0000-4000-8000-0000000000f1'
    assert pose['map_version_id'] == '00000000-0000-4000-8000-0000000000a1'
    assert (pose['x'], pose['y']) == (round(snap['x'], 3), round(snap['y'], 3)) and pose['confidence'] == 0.95
    assert state['speed'] == 0.8 and state['battery']['soc'] == pytest.approx(snap['soc'], abs=0.01)
    assert state['battery']['voltage'] == snap['voltage']
    assert state['posture'] == {'state': 'STANDING', 'mode': None}
    assert state['reported_run']['status'] == 'MOVING'
    info = state['robot_info']
    assert info['joints']['names'] == list(SDK_JOINTS)
    walk_q = replay.index([TRACE])['clips']['walk'][0]['q']
    assert info['joints']['positions'] in walk_q  # a recorded walking frame
    assert all(19 <= t <= 74 for t in info['temperature']['joints'])
    docked = frames(f.sessions['go2-b'], 'state')
    assert docked == []  # not connected: nothing is emitted


def test_demo_robot_ignores_commands_and_never_unlatches():
    f, clock = fleet()
    session = f.sessions['go2-a']
    session.connect()
    for frame in ({'t': 'lease', 'lease_id': 'L', 'holder_type': 'USER'},
                  {'t': 'unlock', 'lease_id': 'L', 'stop_gen': session.core.stop_gen},
                  {'t': 'cmd', 'lease_id': 'L', 'seq': 1, 'axes': [1, 0, 0]},
                  {'t': 'run.start', 'run_id': 'x'}, {'t': 'stop'}):
        effects = session.receive(json.dumps(frame))
        assert all(c.kind == 'stop' or (c.kind == 'apply' and c.velocity == (0, 0, 0))
                   for c in effects.motion)
    assert session.lease_id is None and session.core.latch is True and session.run is None
    pong = session.receive({'t': 'ping', 'ping_id': 'p1'}).messages
    assert {'t': 'ping', 'ping_id': 'p1'} in pong


def test_fast_forward_runs_the_schedule_and_joints_stay_real_time():
    f, clock = fleet(speed=600)
    for _ in range(60):  # 6 s wall = 1 h sim
        clock.t += 0.1
        f.pump()
    assert f.sim.now == pytest.approx(3600, abs=1)
    assert f.players['go2-a'].pos < 7  # replay head moved by wall time only


def test_n_robots_report_over_loopback_websocket():
    websockets = pytest.importorskip('websockets')
    from websockets.asyncio.server import serve
    from foothold_agent.link.testing import reserved_socket
    seen = {}

    async def peer(ws):
        token = ws.request.headers['Authorization']
        async for raw in ws:
            message = json.loads(raw)
            seen.setdefault(token, []).append(message)

    async def scenario_run():
        with reserved_socket() as sock:
            port = sock.getsockname()[1]
            async with serve(peer, sock=sock):
                f = Fleet(scenario(), replay.index([TRACE]), speed=60)
                settings = {rid: Settings(url=f'ws://127.0.0.1:{port}/agent', token=f'tok-{rid}')
                            for rid in f.sessions}
                task = asyncio.create_task(run(f, settings))
                for _ in range(60):
                    await asyncio.sleep(0.05)
                    if len(seen) == 2 and any(m['t'] == 'run.update' for m in seen.get('Bearer tok-go2-a', [])):
                        break
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario_run())
    assert set(seen) == {'Bearer tok-go2-a', 'Bearer tok-go2-b'}
    for messages in seen.values():
        assert messages[0]['t'] == 'hello'
        states = [m for m in messages if m['t'] == 'state']
        assert states and all(STATE.validate(m) is None for m in states)
        assert states[-1]['pose']['x'] is not None
    runs = [m for m in seen['Bearer tok-go2-a'] if m['t'] == 'run.update']
    assert runs and all(RUN.validate(m) is None for m in runs)


def test_config_requires_demo_flag_own_tokens_and_clean_environment(tmp_path, monkeypatch):
    monkeypatch.delenv('FOOTHOLD_AGENT_TOKEN', raising=False)
    (tmp_path / 'a.token').write_text('token-a\n')
    (tmp_path / 'b.token').write_text('token-b\n')
    doc = {'demo': True, 'url': 'wss://demo.example.invalid/api/v1/agent/ws',
           'robots': {'go2-a': {'token_file': 'a.token'}, 'go2-b': {'token_file': 'b.token'}}}
    settings = config.parse(doc, ['go2-a', 'go2-b'], base=str(tmp_path))
    assert settings['go2-a'].token == 'token-a' and 'token-a' not in repr(settings['go2-a'])
    with pytest.raises(config.ConfigError, match='demo: true'):
        config.parse({**doc, 'demo': 'yes'}, ['go2-a', 'go2-b'], base=str(tmp_path))
    with pytest.raises(config.ConfigError, match='same token'):
        config.parse({**doc, 'robots': {'go2-a': {'token_file': 'a.token'}, 'go2-b': {'token_file': 'a.token'}}},
                     ['go2-a', 'go2-b'], base=str(tmp_path))
    with pytest.raises(config.ConfigError, match='missing'):
        config.parse(doc, ['go2-a', 'go2-b', 'go2-c'], base=str(tmp_path))
    with pytest.raises(config.ConfigError, match='WSS'):
        config.parse({**doc, 'url': 'ws://demo.example.invalid/ws'}, ['go2-a', 'go2-b'], base=str(tmp_path))
    monkeypatch.setenv('FOOTHOLD_AGENT_TOKEN', 'real')
    with pytest.raises(config.ConfigError, match='clean environment'):
        config.parse(doc, ['go2-a', 'go2-b'], base=str(tmp_path))


def test_cli_simulate_writes_schedule_report(tmp_path, capsys):
    from foothold_agent.demo.__main__ import main
    out = tmp_path / 'report.json'
    main(['simulate', EXAMPLE, '--report', str(out)])
    report = json.loads(out.read_text())
    late = {i['item']: i for i in report['items'] if i['delay_min']}
    assert late['go2-a/c0:ch_a']['delay_cause'] == 'path_conflict'
    assert 'conflict-a' in capsys.readouterr().out

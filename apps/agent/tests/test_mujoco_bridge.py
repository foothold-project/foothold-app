"""mujoco_bridge glue: a fake child (plain Python) on real pipes; no Node, server or robot.

The Node child itself is covered by apps/simagent/tests/child.test.mjs.
"""
import asyncio
import json
import os
import sys
import time

import pytest

from foothold_agent.link.session import MotionCommand, Session
from foothold_agent.mujoco_bridge.node import MujocoNode
from foothold_agent.mujoco_bridge.__main__ import identity

FAKE = r'''
import json, os, sys, threading, time
mode, log = sys.argv[1], sys.argv[2]
stop = True
sim_t = 0.0
out = open(log, 'a', buffering=1)
out.write(json.dumps({'env_token': any(k.startswith('FOOTHOLD_AGENT_') for k in os.environ)}) + '\n')
def read():
    global stop
    for line in sys.stdin:
        out.write(line)
        m = json.loads(line)
        if m['t'] == 'stop': stop = True
        if m['t'] == 'resume': stop = False
    os._exit(0)
threading.Thread(target=read, daemon=True).start()
start = time.monotonic()
while True:
    age = time.monotonic() - start
    if mode == 'die' and age > .5: os._exit(3)
    if mode == 'silent' and age > .5:
        time.sleep(.05); continue
    if mode == 'garbage' and age > .5:
        print('not json', flush=True); time.sleep(.05); continue
    sim_t += .05
    print(json.dumps({'schema': 'v2_live/state/1', 'episode': 0, 'sim_t': round(sim_t, 3), 'stop_requested': stop,
        'reset_in_progress': False, 'policy_running': True, 'x': 1.0, 'y': 2.0, 'yaw': 0.0, 'vx': 0.3, 'vy': 0.4,
        'wz': 0.0, 'fallen': False, 'cmd_applied': [0, 0, 0], 'battery_soc': 88.5}), flush=True)
    time.sleep(.05)
'''


def make(tmp_path, mode):
    log = tmp_path / 'stdin.log'
    env = {**os.environ, 'FOOTHOLD_AGENT_TOKEN': 'must-not-reach-child'}
    return MujocoNode([sys.executable, '-c', FAKE, mode, str(log)], env=env), log


def lines(log):
    return [json.loads(x) for x in log.read_text().splitlines()]


async def started(bridge, seen):
    return await asyncio.wait_for(bridge.start(seen.append, on_telemetry=seen.append), 10)


def test_normal_child_feeds_session_shapes_and_receives_stop_first(tmp_path):
    async def run():
        bridge, log = make(tmp_path, 'normal')
        seen = []
        try:
            sink = await started(bridge, seen)
            await asyncio.sleep(.3)
            raw = [s for s in seen if isinstance(s, dict) and s.get('schema')]
            assert raw and raw[-1]['stop_requested'] is True
            snap = bridge.inputs.telemetry.snapshot()
            assert snap['battery'] == {'soc': 88.5}
            assert snap['speed'] == pytest.approx(0.5)
            devices = bridge.inputs.device_snapshot()
            assert devices == [{'key': 'sim-battery', 'kind': 'BATTERY', 'label': '시뮬 배터리', 'state': 'OK'}]
            sink.apply(MotionCommand(velocity=(0.6, 0.0, 0.0)))  # latched sink: still zero
            await asyncio.sleep(.2)
        finally:
            bridge.close()
        got = lines(log)
        assert got[0] == {'env_token': False}, 'agent token must not reach the child'
        commands = got[1:]
        assert commands[0]['t'] in ('cmd', 'stop') and any(c['t'] == 'stop' for c in commands[:3])
        assert all(c['v'] == [0, 0, 0] for c in commands if c['t'] == 'cmd')
    asyncio.run(run())


def test_child_death_is_terminal_and_holds_output(tmp_path):
    async def run():
        bridge, _ = make(tmp_path, 'die')
        try:
            sink = await started(bridge, [])
            t0 = time.monotonic()
            with pytest.raises(RuntimeError, match='MuJoCo bridge failed'):
                await asyncio.wait_for(bridge.wait_failure(), 3)
            assert time.monotonic() - t0 < 1.5
            assert sink.output_safety()[1] is True  # held until fresh STOP + new unlock
        finally:
            with pytest.raises(RuntimeError):
                bridge.close()  # failed output stays visible at shutdown
    asyncio.run(run())


def test_garbage_state_line_holds_and_invalidates(tmp_path):
    async def run():
        bridge, _ = make(tmp_path, 'garbage')
        try:
            sink = await started(bridge, [])
            await asyncio.sleep(.8)
            assert sink.output_safety()[1] is True
            assert bridge.inputs.telemetry.snapshot()['observation'] is None
        finally:
            bridge.close()
    asyncio.run(run())


def test_silent_child_goes_stale_within_state_stale(tmp_path):
    async def run():
        bridge, _ = make(tmp_path, 'silent')
        try:
            sink = await started(bridge, [])
            await asyncio.sleep(1.8)  # 0.5 s output + STATE_STALE 1.0 s + margin
            assert sink.output_safety()[1] is True
            snap = bridge.inputs.telemetry.snapshot()
            assert snap['observation'] is None and snap['battery'] == {'soc': None}
            assert bridge.inputs.device_snapshot()[0]['state'] == 'MISSING'
        finally:
            bridge.close()
    asyncio.run(run())


def test_hello_identity_matches_contract_shape():
    session = Session(identity=identity(time.monotonic))
    session.update_devices([{'key': 'sim-battery', 'kind': 'BATTERY', 'label': '시뮬 배터리', 'state': 'OK'}])
    hello = session.connect().messages[0]
    assert hello['t'] == 'hello' and hello['proto'] == 'fh-agent/2' and hello['latched'] is True
    assert hello['robot_model'] == 'unitree_go2'
    caps = hello['execution_capabilities']
    assert caps['contract'] == 'scenario/2'
    # No step executor on this path: advertise nothing as SUPPORTED until run execution exists.
    assert caps['actions'] and not any(a['state'] == 'SUPPORTED' for a in caps['actions'])
    assert all(a['reason'] for a in caps['actions'])
    state = session._state()
    assert state['mode'] == 'FREE' and state['latched'] is True
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
        import contracts.models as C
    except ModuleNotFoundError:
        pytest.skip('pydantic/apps.contracts unavailable for wire validation')
    C.AgentHello.model_validate(hello)
    C.AgentState.model_validate(state)


def test_ready_file_written_with_own_pid_only_on_server_connect(tmp_path):
    from foothold_agent.mujoco_bridge.__main__ import ReadySession
    ready = tmp_path / 'ready'
    session = ReadySession(identity=identity(time.monotonic), ready_file=str(ready))
    assert not ready.exists()  # constructing (child up, no server yet) is not readiness
    session.connect()
    assert ready.read_text() == str(os.getpid())
    ready.unlink()
    session.connect()  # reconnects do not rewrite it
    assert not ready.exists()
    plain = ReadySession(identity=identity(time.monotonic), ready_file=None)
    plain.connect()  # no file configured: unchanged Session behaviour

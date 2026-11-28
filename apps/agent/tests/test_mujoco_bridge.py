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
        'wz': 0.0, 'fallen': False, 'cmd_applied': [0, 0, 0], 'battery_soc': 88.5,
        'joint_temp_c': [25.4, 31.6, 40.2, 25.0, 30.9, 39.5, 25.1, 33.2, 41.0, 24.6, 32.8, 40.4],
        'battery_minutes_left': 287, 'roll': 0.01, 'pitch': -0.02}), flush=True)
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
            assert snap['battery'] == {'soc': 88.5, 'minutes_left': 287}
            assert snap['speed'] == pytest.approx(0.5)
            devices = bridge.inputs.device_snapshot()
            assert devices == [{'key': 'sim-battery', 'kind': 'BATTERY', 'label': '시뮬 배터리', 'state': 'OK'},
                               {'key': 'sim-joint-temp', 'kind': 'OTHER', 'label': '시뮬 관절 온도', 'state': 'OK'}]
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


def test_sim_body_pose_reaches_agent_state_pose_on_the_bound_map_floor(tmp_path):
    """11/28: MuJoCo body pose (sim ground truth = map frame, as Gazebo gt_identity) fills AgentState.pose."""
    from uuid import uuid4
    from foothold_agent.link.telemetry import project
    from foothold_agent.ros_bridge.telemetry import MapBinding
    from apps.contracts.models import AgentState
    floor, version = str(uuid4()), str(uuid4())
    binding = MapBinding('plant_a', 'l1', 'plant_a-l1', floor, version, 'a' * 64, 0, 'mujoco-local')
    async def run():
        log = tmp_path / 'stdin.log'
        bridge = MujocoNode([sys.executable, '-c', FAKE, 'normal', str(log)], env=dict(os.environ), map_binding=binding)
        seen = []
        try:
            await started(bridge, seen)
            await asyncio.sleep(.3)
            snap = bridge.inputs.telemetry.snapshot()
            pose = project(snap, time.monotonic())['pose']
            assert (pose['floor_id'], pose['map_version_id'], pose['x'], pose['y'], pose['yaw']) == (floor, version, 1.0, 2.0, 0.0)
            session = Session(identity=identity(time.monotonic))
            session.update_telemetry(snap)
            state = session._state()
            assert state['pose']['x'] == 1.0 and state['pose']['y'] == 2.0 and state['pose']['floor_id'] == floor
            AgentState.model_validate({**state, 'stop_ref': 0, 'mode': state.get('mode') or 'IDLE'})
        finally:
            bridge.close()
    asyncio.run(run())


def test_no_map_binding_keeps_pose_empty(tmp_path):
    from foothold_agent.link.telemetry import project
    async def run():
        bridge, _ = make(tmp_path, 'normal')
        try:
            await started(bridge, [])
            await asyncio.sleep(.3)
            pose = project(bridge.inputs.telemetry.snapshot(), time.monotonic())['pose']
            assert pose['x'] is None and pose['floor_id'] is None
        finally:
            bridge.close()
    asyncio.run(run())


def test_run_config_binds_body_pose_to_the_spawn_floor():
    import json as _json
    from uuid import uuid4
    from foothold_agent.mujoco_bridge.__main__ import run_config, body_binding
    rows = [dict(world_id='plant_a', ros_floor_id=f, ros_map_version='plant_a-' + f, floor_id=str(uuid4()),
                 map_version_id=str(uuid4()), sha256=c * 64, building_id=str(uuid4()), ros_building_id='plant_a',
                 source_pgm_sha256='0' * 64) for f, c in (('l1', 'a'), ('l2', 'b'))]
    env = dict(FH_SIM_ROBOT_ID=str(uuid4()), FH_SIM_ORG_ID=str(uuid4()), FH_SIM_MAP_BINDINGS=_json.dumps(rows),
               FOOTHOLD_SCENARIO_DATA_ORIGIN='http://127.0.0.1:1', FOOTHOLD_RUN_OUTBOX_PATH='/tmp/x.sqlite')
    b = body_binding(run_config(env))
    assert (b.ros_floor_id, b.floor_id, b.map_version_id, b.sha256, b.episode) == ('l1', rows[0]['floor_id'], rows[0]['map_version_id'], 'a' * 64, 0)
    b = body_binding(run_config({**env, 'FH_SIM_SPAWN_FLOOR': 'l2'}))
    assert b.ros_floor_id == 'l2' and b.floor_id == rows[1]['floor_id']
    assert body_binding(run_config({**env, 'FH_SIM_SPAWN_FLOOR': 'l3'})) is None  # no approved map: no pose
    assert body_binding(None) is None


def test_sim_joint_temperatures_reach_agent_state_robot_info(tmp_path):
    """11/28 14:02: 시뮬 관절 온도 (MuJoCo 토크로 적분) 가 실기와 같은 칸 robot_info.temperature.joints (정수 °C, SDK 순서)."""
    from apps.contracts.models import AgentState
    async def run():
        bridge, _ = make(tmp_path, 'normal')
        try:
            await started(bridge, [])
            await asyncio.sleep(.3)
            session = Session(identity=identity(time.monotonic))
            session.update_telemetry(bridge.inputs.telemetry.snapshot())
            state = session._state()
            temp = state['robot_info']['temperature']
            assert temp['joints'] == [25, 32, 40, 25, 31, 40, 25, 33, 41, 25, 33, 40]
            assert temp['battery'] == [None] * 4 and temp['imu'] is None and temp['body'] == [None, None]
            assert 0 <= temp['age_s'] <= 1.0
            assert state['battery']['soc'] == 88.5
            parsed = AgentState.model_validate({**state, 'stop_ref': 0, 'mode': state.get('mode') or 'IDLE'})
            assert parsed.robot_info.temperature.joints == temp['joints']
            assert bridge.inputs.device_snapshot()[-1] == {'key': 'sim-joint-temp', 'kind': 'OTHER', 'label': '시뮬 관절 온도', 'state': 'OK'}
        finally:
            bridge.close()
    asyncio.run(run())


def test_sim_joint_temperatures_expire_with_state(tmp_path):
    async def run():
        bridge, _ = make(tmp_path, 'silent')
        try:
            await started(bridge, [])
            await asyncio.sleep(1.8)
            session = Session(identity=identity(time.monotonic))
            session.update_telemetry(bridge.inputs.telemetry.snapshot())
            assert 'robot_info' not in session._state()
        finally:
            bridge.close()
    asyncio.run(run())


def test_child_command_has_no_fixed_drain_and_passes_ambient():
    from foothold_agent.mujoco_bridge.__main__ import child_command
    env = {'FH_SIM_SRC': '/x', 'FH_SIM_NODE': sys.executable, 'FH_SIM_BATTERY_DRAIN': '5', 'FH_SIM_AMBIENT_C': '18'}
    cmd = child_command(env)
    assert '--battery-drain' not in cmd
    assert cmd[cmd.index('--ambient-c') + 1] == '18'
    default = child_command({'FH_SIM_SRC': '/x', 'FH_SIM_NODE': sys.executable})
    assert default[default.index('--ambient-c') + 1] == '25'


def test_sim_gait_attitude_fallen_and_minutes_left_reach_agent_state(tmp_path):
    """11/28 14:45: 걸음 이름 · 자세 · 넘어짐 · 남은 분도 실기와 같은 칸으로."""
    from apps.contracts.models import AgentState
    async def run():
        bridge, _ = make(tmp_path, 'normal')
        try:
            await started(bridge, [])
            await asyncio.sleep(.3)
            session = Session(identity=identity(time.monotonic))
            session.update_telemetry(bridge.inputs.telemetry.snapshot())
            state = session._state()
            # 자식은 START m15500 정책만 돌리고, 걸음 바꾸기 요청은 모두 GAIT_UNSUPPORTED: 고를 수 있는 것은 없음.
            assert state['gait'] == {'gait': 'start', 'available': []}
            info = state['robot_info']
            assert info['attitude'] == {'roll': 0.01, 'pitch': -0.02} and info['fallen'] is False
            assert state['battery'] == {'soc': 88.5, 'minutes_left': 287}
            parsed = AgentState.model_validate({**state, 'stop_ref': 0, 'mode': state.get('mode') or 'IDLE'})
            assert parsed.gait.gait == 'start' and parsed.battery.minutes_left == 287
            assert parsed.robot_info.attitude.pitch == -0.02 and parsed.robot_info.fallen is False
            # 걸음 요청이 거절돼도 지금 걸음은 그대로 보인다.
            session.gait_result = dict(request_id='g', gait='classic', status='REJECTED', code='GAIT_UNSUPPORTED', sdk_code=None)
            assert session._state()['gait'] == {'gait': 'start', 'available': []}
        finally:
            bridge.close()
    asyncio.run(run())


def test_sim_gait_and_attitude_expire_with_state(tmp_path):
    async def run():
        bridge, _ = make(tmp_path, 'silent')
        try:
            await started(bridge, [])
            await asyncio.sleep(1.8)
            session = Session(identity=identity(time.monotonic))
            session.update_telemetry(bridge.inputs.telemetry.snapshot())
            state = session._state()
            assert 'gait' not in state and 'robot_info' not in state and state['battery'] == {'soc': None}
        finally:
            bridge.close()
    asyncio.run(run())


def test_child_command_passes_slot_spawn_only_when_set():
    """app-lx 11/28 15:11: simmgr slot spawn_xyyaw -> FH_SIM_SPAWN -> child --spawn. 없으면 옛 인자 그대로."""
    from foothold_agent.mujoco_bridge.__main__ import child_command
    base = {'FH_SIM_SRC': '/x', 'FH_SIM_NODE': sys.executable}
    assert '--spawn' not in child_command(base)
    cmd = child_command({**base, 'FH_SIM_SPAWN': '438.5714,-253.4286,0.0'})
    assert cmd[cmd.index('--spawn') + 1] == '438.5714,-253.4286,0.0'
    for bad in ('1,2', '1,2,nan', 'a,b,c', '1,2,3,4'):
        with pytest.raises(ValueError):
            child_command({**base, 'FH_SIM_SPAWN': bad})

"""MuJoCo simulation agent: ros_bridge's non-phone Session path with MujocoNode.

Environment (fail-closed, no defaults for credentials):
  FOOTHOLD_AGENT_WS_URL, FOOTHOLD_AGENT_TOKEN  same as every agent (link.client.Settings)
  FH_SIM_SRC                                   MuJoCo wasm / policy / Go2 assets for the child
  FH_SIM_MAP (collapsed-house-v2), FH_SIM_SEED (0), FH_SIM_NODE (node)
  FH_SIM_BATTERY_START (100, start SoC %), FH_SIM_AMBIENT_C (25, joint motor ambient degC).
  Battery and joint temperatures are integrated by the child from MuJoCo torques (apps/simagent/vitals.mjs).
  FH_SIM_STATE_LOG (optional JSON-lines tap of child states for validation tools)
  FH_SIM_READY_FILE (optional; simmgr MujocoLauncher) gets this pid once the server WS opened
  Scenario runs (server run.start, 11/28): all of FH_SIM_ROBOT_ID, FH_SIM_ORG_ID, FH_SIM_MAP_BINDINGS
  (the server's SimMapBinding list, passed by simmgr), FOOTHOLD_SCENARIO_DATA_ORIGIN and
  FOOTHOLD_RUN_OUTBOX_PATH (FH_SIM_SPAWN_FLOOR, default l1, picks the binding for AgentState.pose). Then the phone Hub's ScenarioRun owns runs exactly as on the
  ROS path, with route.LocalNav in place of Nav2. Without them: Session only (no runs).
"""

import asyncio
import os
from pathlib import Path
import shutil
import signal

from foothold_agent.link.client import Client, Settings
from foothold_agent.link.session import Session
from .node import MujocoNode

CHILD = Path(__file__).resolve().parents[3] / 'simagent' / 'child.mjs'  # apps/simagent
VERSION = 'mujoco-bridge/0.1.0'


def child_command(env):
    node = shutil.which(env.get('FH_SIM_NODE', 'node'))
    if node is None or not env.get('FH_SIM_SRC'):
        raise ValueError('set FH_SIM_SRC and a Node 22+ executable (FH_SIM_NODE)')
    return [node, str(CHILD), '--map', env.get('FH_SIM_MAP', 'collapsed-house-v2'),
            '--seed', env.get('FH_SIM_SEED', '0'),
            '--battery-start', env.get('FH_SIM_BATTERY_START', '100'),
            '--ambient-c', env.get('FH_SIM_AMBIENT_C', '25')]


UNAVAILABLE = 'MuJoCo bridge has no scenario step executor yet'


def identity(now):
    # This Session-only path has no step executor, so nothing is SUPPORTED
    # (same keys as ros_bridge's ExecutionSupport, never a false claim).
    actions = [dict(key=key, state='UNAVAILABLE', reason=UNAVAILABLE) for key in ('wait', 'photo.rgb')]
    return {'agent_version': VERSION, 'robot_model': 'unitree_go2', 'firmware': None,
            'execution_capabilities': dict(contract='scenario/2', revision=1, actions=actions)}


def run_config(env):
    keys = ('FH_SIM_ROBOT_ID', 'FH_SIM_ORG_ID', 'FH_SIM_MAP_BINDINGS', 'FOOTHOLD_SCENARIO_DATA_ORIGIN',
            'FOOTHOLD_RUN_OUTBOX_PATH')
    if not any(env.get(k) for k in keys):
        return None
    if not all(env.get(k) for k in keys) or env['FOOTHOLD_RUN_OUTBOX_PATH'] == ':memory:':
        raise ValueError('scenario runs need all of ' + ', '.join(keys) + ' (durable outbox)')
    import json
    bindings = json.loads(env['FH_SIM_MAP_BINDINGS'])
    if not isinstance(bindings, list) or not bindings or not all(
            isinstance(b, dict) and {'world_id', 'floor_id', 'map_version_id', 'sha256'} <= set(b) for b in bindings):
        raise ValueError('FH_SIM_MAP_BINDINGS must be the server SimMapBinding list')
    return dict(robot=env['FH_SIM_ROBOT_ID'], org=env['FH_SIM_ORG_ID'], bindings=bindings,
                origin=env['FOOTHOLD_SCENARIO_DATA_ORIGIN'], outbox=env['FOOTHOLD_RUN_OUTBOX_PATH'],
                spawn_floor=env.get('FH_SIM_SPAWN_FLOOR') or 'l1')


def body_binding(cfg):
    """The server-approved map of the floor the MuJoCo body stands on (AgentState.pose); None = no pose."""
    from foothold_agent.ros_bridge.telemetry import MapBinding
    if cfg is None:
        return None
    for b in cfg['bindings']:
        if b.get('ros_floor_id') == cfg['spawn_floor']:
            return MapBinding(b['world_id'], b['ros_floor_id'], b.get('ros_map_version') or b['ros_floor_id'],
                              b['floor_id'], b['map_version_id'], b['sha256'], 0, 'mujoco-local')
    return None


class Pose:
    """Latest child state as (episode, x, y, yaw, received_monotonic); written by the reader callback."""

    def __init__(self, now):
        self.now, self.value = now, None

    def update(self, raw):
        import math
        try:
            values = (raw['episode'], raw['x'], raw['y'], raw['yaw'])
        except (KeyError, TypeError):
            return
        if type(values[0]) is int and all(type(v) in (int, float) and math.isfinite(v) for v in values[1:]):
            self.value = (values[0], float(values[1]), float(values[2]), float(values[3]), self.now())

    def __call__(self):
        return self.value


def build_hub(cfg, sink, settings, pose, now):
    """Same Hub/ScenarioRun/Observer wiring as ros_bridge.__main__, with LocalNav for Nav2."""
    import os
    from foothold_agent.executor.nav2 import NavExecutor, PolicyAdapter
    from foothold_agent.executor.nav2.actions import GoalActions
    from foothold_agent.executor.nav2.simulation import SimulationBinding
    from foothold_agent.executor.run_outbox import RunOutbox
    from foothold_agent.executor.scenario import ScenarioSource
    from foothold_agent.phone.hub import Hub
    from foothold_agent.phone.observer import Observer
    from foothold_agent.phone.tickets import Verifier
    from .route import GridSource, LocalNav
    maps = tuple((b['world_id'], str(b['floor_id']), b['sha256']) for b in cfg['bindings'])
    versions = {b['sha256']: str(b['map_version_id']) for b in cfg['bindings']}
    # The physical alphabet stays the fallback; the Hub swaps in the SI simulation adapter
    # only for a goal whose (world, floor, map sha) is one of the server-approved bindings.
    nav = NavExecutor(PolicyAdapter(dict(allow_curves=False, yaw_zero_threshold_rps=.04,
        commands=[dict(si=[0, 0, 0], axes=[0, 0, 0]), dict(si=[.6, 0, 0], axes=[1, 0, 0])])), GoalActions())
    grids = {}
    local = LocalNav(nav, pose, grids=grids, now=now)
    # No phone listener here: the verifier holds a random key nobody has, so no phone can connect.
    verifier = Verifier(cfg['robot'], {'mujoco-no-phone': os.urandom(32)}, org=cfg['org'],
                        replay_path=':memory:', clock_trusted=True)
    binding = SimulationBinding(verifier.robot, 'mujoco-local', 0, 0, maps)

    def context(request, plan):
        proof = plan.map_proof
        return (local.actions.ready() and (proof['world_id'], request['floor_id'], proof['image_sha256']) in maps
                and versions.get(proof['image_sha256']) == request['map_version_id'])

    def arrival(b, goal):
        p = pose()
        if p is None or p[0] != b.episode:
            return None
        return dict(binding=b, received_at=p[4], pose=dict(floor_id=b.floor, map_version_id=versions.get(b.map_sha),
                    x=p[1], y=p[2], yaw=p[3], confidence=1.))
    journal = RunOutbox(cfg['outbox'])
    source = GridSource(ScenarioSource(cfg['origin'], settings.token), grids)
    hub = Hub(verifier, sink, nav=nav, run_context=context, arrival_evidence=arrival,
              policy_name='start-m15500', policy_version='mujoco-local', simulation=True,
              scenario_source=source, run_journal=journal, simulation_binding=binding)
    session = Observer(hub)
    hub.record = session.retain
    return hub, session, local, journal, verifier


async def hub_loop(hub, local):
    while True:  # Hub is the only run/link timer (phone Server._watchdog does this at 50 ms)
        local.spin()
        hub.tick()
        await asyncio.sleep(.02)


class ReadySession(Session):
    """Session that tells a local launcher once the authenticated server WS opened.

    Client calls connect() only inside the websockets connect() context, i.e. after
    HTTP 101; a rejected token is 401/403 and never gets here. The file holds only
    this pid (no URL or token) and is replaced atomically.
    """

    def __init__(self, *args, ready_file=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.ready_file = ready_file

    def connect(self):
        effects = super().connect()
        if self.ready_file:
            path, self.ready_file = self.ready_file, None
            temporary = path + '.tmp'
            with open(temporary, 'w') as stream:
                stream.write(str(os.getpid()))
            os.replace(temporary, path)
        return effects


async def run(settings, command, cfg=None):
    bridge = MujocoNode(command, cwd=str(CHILD.parent), state_log=os.environ.get('FH_SIM_STATE_LOG'),
                        map_binding=body_binding(cfg))
    client = hub = local = journal = verifier = None
    pose = Pose(__import__('time').monotonic)
    tasks = []
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        def on_state(raw):
            pose.update(raw)
            if hub is not None:
                hub.on_robot_state(raw)
            if client is not None:
                client.on_robot_state(raw)

        def on_telemetry(snapshot):
            if hub is not None:
                hub.session.update_telemetry(snapshot)
            if client is not None:
                client.update_telemetry(snapshot)

        def on_devices(devices):
            if hub is not None:
                hub.session.update_devices(devices)
            if client is not None:
                client.update_devices(devices)

        sink = await bridge.start(on_state, on_telemetry=on_telemetry, on_devices=on_devices)
        if cfg is not None:
            from foothold_agent.phone.observer import DiscardSink
            hub, session, local, journal, verifier = build_hub(cfg, sink, settings, pose, __import__('time').monotonic)
            ready_file = os.environ.get('FH_SIM_READY_FILE')
            connect = session.connect
            def ready_connect():  # same readiness rule as ReadySession: only after the authenticated WS opened
                nonlocal ready_file
                effects = connect()
                if ready_file:
                    path, ready_file = ready_file, None
                    with open(path + '.tmp', 'w') as stream:
                        stream.write(str(os.getpid()))
                    os.replace(path + '.tmp', path)
                return effects
            session.connect = ready_connect
            client = Client(session, DiscardSink(), settings)
            hub.session.update_telemetry(bridge.inputs.telemetry.snapshot())
            hub.session.update_devices(bridge.inputs.device_observations())
        else:
            session = ReadySession(identity=identity(loop.time),  # always starts latched
                                   ready_file=os.environ.get('FH_SIM_READY_FILE'))
            client = Client(session, sink, settings)
        client.update_telemetry(bridge.inputs.telemetry.snapshot())
        client.update_devices(bridge.inputs.device_observations())
        tasks = [asyncio.create_task(client.run()), asyncio.create_task(bridge.wait_failure()),
                 asyncio.create_task(stop.wait())]
        if hub is not None:
            tasks.append(asyncio.create_task(hub_loop(hub, local)))
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        if hub is not None:
            hub.close()  # local STOP before network task cancellation
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            bridge.close()
        finally:
            for closer in (local and local.close, journal and journal.close, verifier and verifier.close):
                if closer:
                    closer()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.remove_signal_handler(sig)


def main():
    settings = Settings.from_env()  # never echoes URL/token
    asyncio.run(run(settings, child_command(os.environ), run_config(os.environ)))


if __name__ == '__main__':
    main()

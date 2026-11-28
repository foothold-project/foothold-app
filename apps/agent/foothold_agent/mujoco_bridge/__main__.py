"""MuJoCo simulation agent: ros_bridge's non-phone Session path with MujocoNode.

Environment (fail-closed, no defaults for credentials):
  FOOTHOLD_AGENT_WS_URL, FOOTHOLD_AGENT_TOKEN  same as every agent (link.client.Settings)
  FH_SIM_SRC                                   MuJoCo wasm / policy / Go2 assets for the child
  FH_SIM_MAP (collapsed-house-v2), FH_SIM_SEED (0), FH_SIM_NODE (node)
  FH_SIM_BATTERY_START (100), FH_SIM_BATTERY_DRAIN (%/s of sim time, 0.0139)
  FH_SIM_STATE_LOG (optional JSON-lines tap of child states for validation tools)
  FH_SIM_READY_FILE (optional; simmgr MujocoLauncher) gets this pid once the server WS opened
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
            '--battery-drain', env.get('FH_SIM_BATTERY_DRAIN', '0.0139')]


UNAVAILABLE = 'MuJoCo bridge has no scenario step executor yet'


def identity(now):
    # This Session-only path has no step executor, so nothing is SUPPORTED
    # (same keys as ros_bridge's ExecutionSupport, never a false claim).
    actions = [dict(key=key, state='UNAVAILABLE', reason=UNAVAILABLE) for key in ('wait', 'photo.rgb')]
    return {'agent_version': VERSION, 'robot_model': 'unitree_go2', 'firmware': None,
            'execution_capabilities': dict(contract='scenario/2', revision=1, actions=actions)}


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


async def run(settings, command):
    bridge = MujocoNode(command, cwd=str(CHILD.parent), state_log=os.environ.get('FH_SIM_STATE_LOG'))
    client = None
    tasks = []
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        def on_state(raw):
            if client is not None:
                client.on_robot_state(raw)

        def on_telemetry(snapshot):
            if client is not None:
                client.update_telemetry(snapshot)

        def on_devices(devices):
            if client is not None:
                client.update_devices(devices)

        sink = await bridge.start(on_state, on_telemetry=on_telemetry, on_devices=on_devices)
        session = ReadySession(identity=identity(loop.time),  # always starts latched
                               ready_file=os.environ.get('FH_SIM_READY_FILE'))
        client = Client(session, sink, settings)
        client.update_telemetry(bridge.inputs.telemetry.snapshot())
        client.update_devices(bridge.inputs.device_observations())
        tasks = [asyncio.create_task(client.run()), asyncio.create_task(bridge.wait_failure()),
                 asyncio.create_task(stop.wait())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            bridge.close()
        finally:
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.remove_signal_handler(sig)


def main():
    settings = Settings.from_env()  # never echoes URL/token
    asyncio.run(run(settings, child_command(os.environ)))


if __name__ == '__main__':
    main()

"""Fake by default. Native single-robot adapter is only constructed after opt-in."""
import asyncio
import os
from pathlib import Path
import signal
import subprocess
import sys

from foothold_agent.ros_bridge.config import validate_isolation
from foothold_agent.phone.tickets import load_keys
from .environment import validate_control_environment, child_environment

ROOT = Path(__file__).resolve().parents[2]


class FakeLauncher:
    real = False
    def __init__(self):
        self.events = []

    async def start_world(self, world):
        self.events.append(('world', world.id))

    async def add(self, slot, credentials):
        self.events.append(('agent', slot.robot_id, slot.namespace, slot.port))

    async def stop_agent(self, slot):
        self.events.extend([('STOP', slot.robot_id), ('zero', slot.robot_id), ('agent_exit', slot.robot_id)])

    async def remove(self, slot):
        self.events.append(('remove', slot.robot_id))

    async def close_world(self):
        self.events.append(('world_exit',))


class NativeLauncher:
    """Reuse D1 resource/identity gates; no second world or guessed ROS remapping.

    The upstream adapter has a baked-in robot, fixed frames and command topics.
    The manager therefore rejects a second real robot until a native adapter exists.
    Agent normal exit confirms existing bridge STOP/zero/ack cleanup, before Gazebo.
    """
    real = True
    def __init__(self, settings):
        if os.environ.get('FH_SIM_RUN') != '1':
            raise ValueError('FH_SIM_RUN=1 is required')
        validate_control_environment()
        self.settings = settings
        self.sim = self.child = None
        self.folder = None
        self.failed = False

    @property
    def failure(self):
        return self.failed or (self.sim is not None and bool(self.sim.reason)) or (self.child is not None and self.child.poll() is not None)

    async def start_world(self, world):
        validate_control_environment()
        if world.id != 'v5_single/f1':
            raise ValueError('native adapter only supports v5_single/f1')
        # Import the established supervisor without importing ROS or starting nodes.
        sim_tools = str(ROOT / 'apps/agent/tools/sim')
        if sim_tools not in sys.path:
            sys.path.insert(0, sim_tools)
        from isolation import Simulation
        folder = Path(self.settings.run_dir).resolve()
        if not folder.is_relative_to(ROOT / 'runs') or folder == ROOT / 'runs':
            raise ValueError('evidence must be a new directory under this worktree runs')
        folder.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.folder = folder
        sim = Simulation(folder, Path(self.settings.source), Path(self.settings.ros_setup),
                         launch_env=child_environment(self.settings.domain))
        # Match the catalogue pair against the exact native catalogue, never ignore it.
        import json
        from constants import MAP_DIRECTORY
        native_root = sim.source.parent.parent.parent / MAP_DIRECTORY
        entry = json.loads((native_root / 'worlds.json').read_text())['worlds'][world.id]
        if ((native_root / entry['world']).resolve() != world.world_file.resolve()
                or (native_root / entry['gt_map']).resolve() != world.map_file.resolve()):
            raise ValueError('configured world/map pair does not match native catalogue')
        self.sim = sim
        try:
            await asyncio.to_thread(sim.start)
            # MainPID appears before imports/assets/Gazebo are ready. D1 also
            # verifies the live partition only after startup, never at unit birth.
            deadline = asyncio.get_running_loop().time() + 110
            while True:
                if sim.reason:
                    raise RuntimeError('simulation supervisor stopped during startup')
                try:
                    await asyncio.to_thread(sim.live_identity)
                    break
                except RuntimeError:
                    if asyncio.get_running_loop().time() >= deadline:
                        raise RuntimeError('native identity readiness unconfirmed') from None
                    await asyncio.sleep(.1)
        except BaseException:
            self.failed = True
            if sim.started:
                await asyncio.to_thread(sim.close)
                self.sim = None
            raise

    async def add(self, slot, credentials):
        if self.child is not None or self.failed or self.sim is None or self.sim.reason:
            raise RuntimeError('native robot unavailable; no automatic restart')
        load_keys(slot.key_path)  # private file validation before process creation
        env = {**child_environment(self.settings.domain), 'FOOTHOLD_ROBOT_ID': slot.robot_id,
               'FOOTHOLD_AGENT_WS_URL': self.settings.agent_ws_url,
               'FOOTHOLD_AGENT_TOKEN': credentials['agent_token'],
               'FOOTHOLD_PHONE_HOST': self.settings.agent_host, 'FOOTHOLD_PHONE_PORT': str(slot.port),
               'FOOTHOLD_PHONE_KEY_PATH': slot.key_path, 'FOOTHOLD_PHONE_ORG_ID': slot.org_id,
               'FOOTHOLD_PHONE_REPLAY_DB': slot.replay_path, 'FOOTHOLD_PHONE_CLOCK_TRUSTED': '1',
               'FOOTHOLD_PHONE_POLICY_NAME': 'go2-simulation', 'FOOTHOLD_PHONE_POLICY_VERSION': 'stage1',
               'FOOTHOLD_PHONE_SIMULATION': '1',
               'FOOTHOLD_PHONE_ORIGINS': __import__('json').dumps(self.settings.origins),
               'PYTHONDONTWRITEBYTECODE': '1', 'ROS_LOG_DIR': str(self.folder / 'agent-ros'),
               'PYTHONPATH': os.pathsep.join([str(ROOT / 'apps/agent'), str(ROOT)])}
        validate_isolation(env)
        # Native stage1 topics/frames stay fixed; no fictitious namespace isolation.
        env['FOOTHOLD_CAMERA_ENABLED'] = '1'
        with (self.folder / 'agent.log').open('x') as log:
            script = ('set -e; source "$1"; '
                      'export PYTHONPATH="$2:/usr/lib/python3/dist-packages:${PYTHONPATH:-}"; '
                      'exec "$3" -m foothold_agent.ros_bridge')
            self.child = subprocess.Popen(['/bin/bash', '-c', script, 'simmgr-agent',
                self.settings.ros_setup, env['PYTHONPATH'], self.settings.agent_python],
                env=env, cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
        deadline = asyncio.get_running_loop().time() + 30
        while asyncio.get_running_loop().time() < deadline:
            if self.child.poll() is not None or self.sim.reason:
                self.failed = True
                raise RuntimeError('agent/simulation startup failed')
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_connection(self.settings.agent_host, slot.port), .2)
                writer.close()
                await writer.wait_closed()
                return
            except (OSError, asyncio.TimeoutError):
                await asyncio.sleep(.1)
        self.failed = True
        raise RuntimeError('agent listener readiness unconfirmed')

    async def stop_agent(self, slot):
        child = self.child
        if child is None:
            return
        if child.poll() is None:
            child.send_signal(signal.SIGINT)
        # Existing runner closes Hub first, bridge outputs ZERO/STOP, waits for ACK,
        # then tears down its node. Nonzero exit/timeout retains world and blocks reuse.
        try:
            code = await asyncio.to_thread(child.wait, timeout=15)
        except subprocess.TimeoutExpired:
            self.failed = True
            # Own process group only. A forced exit never confirms STOP/zero;
            # retain world/slot and require operator review before any retry.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                if child.poll() is not None:
                    break
                if os.getpgid(child.pid) != child.pid:
                    raise RuntimeError('agent process group ownership changed') from None
                os.killpg(child.pid, sig)
                try:
                    await asyncio.to_thread(child.wait, timeout=5)
                except subprocess.TimeoutExpired:
                    continue
                break
            raise RuntimeError('agent STOP/zero timeout; owned group cleanup attempted') from None
        if code != 0:
            self.failed = True
            raise RuntimeError('agent STOP/zero cleanup unconfirmed')
        self.child = None

    async def remove(self, slot):
        # The native robot belongs to the world. Its removal means world cleanup.
        await self.close_world()

    async def close_world(self):
        if self.child is not None:
            raise RuntimeError('agent must confirm STOP/zero before world cleanup')
        if self.sim is not None:
            await asyncio.to_thread(self.sim.close)
            self.sim = None
        # No restart of this native episode: a new manager/run directory is required.
        self.failed = True

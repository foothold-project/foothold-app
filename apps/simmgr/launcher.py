"""Fake by default. Native single-robot adapter is only constructed after opt-in."""
import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import signal
import subprocess
import sys

from foothold_agent.ros_bridge.config import validate_isolation
from foothold_agent.phone.tickets import load_keys
from .environment import validate_control_environment, child_environment
from .agent_unit import AgentUnit
from .preflight import startup_preflight

ROOT = Path(__file__).resolve().parents[2]


class FakeLauncher:
    real = False
    def __init__(self):
        self.events = []

    async def check_health(self):
        return False

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
        self.episode = 0

    @property
    def failure(self):
        # Pure cached state: synchronous systemctl never runs on the event loop.
        return self.failed or (self.sim is not None and bool(self.sim.reason))

    async def check_health(self):
        if self.sim is not None and self.sim.reason:
            self.failed = True
        try:
            if self.child is not None and await self._poll() is not None:
                self.failed = True
        except RuntimeError:
            self.failed = True
        return self.failure

    async def _poll(self):
        try:
            return await asyncio.to_thread(self.child.poll)
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.failed = True
            raise RuntimeError('agent unit status unavailable') from None

    async def _signal(self, sig):
        try:
            await asyncio.to_thread(self.child.send_signal, sig)
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.failed = True
            raise RuntimeError('agent unit signal failed') from None

    async def _wait(self, timeout):
        try:
            return await asyncio.to_thread(self.child.wait, timeout=timeout)
        except subprocess.TimeoutExpired:
            self.failed = True
            raise
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.failed = True
            raise RuntimeError('agent unit cleanup failed') from None

    async def start_world(self, world):
        validate_control_environment()
        if self.failure or self.sim is not None or self.child is not None:
            raise RuntimeError('native episode unavailable; no automatic restart')
        if world.id != 'v5_single/f1':
            raise ValueError('native adapter only supports v5_single/f1')
        # Import the established supervisor without importing ROS or starting nodes.
        sim_tools = str(ROOT / 'apps/agent/tools/sim')
        if sim_tools not in sys.path:
            sys.path.insert(0, sim_tools)
        from isolation import Simulation
        base = Path(self.settings.run_dir).resolve()
        if not base.is_relative_to(ROOT / 'runs') or base == ROOT / 'runs':
            raise ValueError('evidence must be a new directory under this worktree runs')
        base.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.episode += 1
        name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + f'-{self.episode:06d}'
        folder = base / name
        folder.mkdir(exist_ok=False, mode=0o700)
        self.folder = folder
        # Every new episode must prove absence again, including old sim/agent
        # units. Simulation.start independently repeats its original resource,
        # domain93 and DDS gates immediately before launching its own unit.
        await asyncio.to_thread(startup_preflight, True)
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
               'PYTHONDONTWRITEBYTECODE': '1', 'ROS_LOG_DIR': str(self.folder / 'agent-ros')}
        validate_isolation(env)
        # Native stage1 topics/frames stay fixed; no fictitious namespace isolation.
        env['FOOTHOLD_CAMERA_ENABLED'] = '1'
        try:
            self.child = await asyncio.to_thread(AgentUnit, self.folder, self.settings, env, ROOT)
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.failed = True
            raise RuntimeError('agent unit startup failed') from None
        deadline = asyncio.get_running_loop().time() + 30
        while asyncio.get_running_loop().time() < deadline:
            if await self._poll() is not None or self.sim.reason:
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
        if await self._poll() is None:
            await self._signal(signal.SIGINT)
        # Existing runner closes Hub first, bridge outputs ZERO/STOP, waits for ACK,
        # then tears down its node. Nonzero exit/timeout retains world and blocks reuse.
        try:
            code = await self._wait(15)
        except subprocess.TimeoutExpired:
            self.failed = True
            # Own transient unit only. A forced exit never confirms STOP/zero;
            # retain world/slot and require operator review before any retry.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                if await self._poll() is not None:
                    break
                await self._signal(sig)
                try:
                    await self._wait(5)
                except subprocess.TimeoutExpired:
                    continue
                break
            raise RuntimeError('agent STOP/zero timeout; owned unit cleanup attempted') from None
        if code != 0:
            self.failed = True
            raise RuntimeError('agent STOP/zero cleanup unconfirmed')
        self.child = None

    async def remove(self, slot):
        # The native robot belongs to the world. Its removal means world cleanup.
        await self.close_world()

    async def close_world(self):
        if self.child is not None:
            self.failed = True
            raise RuntimeError('agent must confirm STOP/zero before world cleanup')
        if self.sim is not None:
            sim = self.sim
            self.failed = self.failed or bool(sim.reason)
            try:
                await asyncio.to_thread(sim.close)
            except BaseException:
                self.failed = True
                raise
            # The watcher may observe the unit exiting during requested normal
            # cleanup. Only that observation is covered by close's successful
            # identity/manifest/cleanup checks; watcher errors still latch.
            if sim.reason and sim.reason != 'unit_exited':
                self.failed = True
        if self.failed:
            raise RuntimeError('native episode failed; operator review required')
        self.sim = self.child = self.folder = None
        self.failed = False

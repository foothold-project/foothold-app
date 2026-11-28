"""Local MuJoCo backend: one headless mujoco_bridge agent process per robot. No Gazebo/ROS.

Opt-in with FH_SIM_LOCAL_BACKEND=mujoco (never together with FH_SIM_RUN=1).
RUNNING means the agent child is alive AND it wrote its own pid to
FH_SIM_READY_FILE, which mujoco_bridge does only after the authenticated
server WebSocket opened (HTTP 101 after the agent token check). A child that
exits, times out or writes another pid is never RUNNING.

The child is its own session/process group (it starts the Node physics
child). Cleanup signals only that group by number: SIGTERM to the agent (it
sends STOP/zero to the physics child and closes it), then SIGKILL to the group
after stop_timeout. Absence of every group member is checked before success.
"""
import asyncio
import os
from pathlib import Path
import re
import signal
import json
import subprocess
import tempfile

from .environment import BASE_KEYS
from .native_catalogue import WorldValidationError

ROOT = Path(__file__).resolve().parents[2]
# Only these sim knobs reach the agent; never DB URLs, service keys or pass keys.
SIM_KEYS = ('FH_SIM_SRC', 'FH_SIM_NODE', 'FH_SIM_SEED', 'FH_SIM_BATTERY_START', 'FH_SIM_BATTERY_DRAIN',
            'FH_SIM_ORT_NODE', 'FH_SIM_START_MAP', 'FH_SIM_POLICY_DIR')  # START m15500 policy (world.mjs)
MAP_ID = re.compile(r'[a-z0-9-]{1,64}')
# Server world ids use '_' (plant_a); the MuJoCo map list (mobile/sim/maps.json) uses '-' (plant-a).


def mujoco_maps():
    try:
        return {item['id'] for item in json.loads((ROOT / 'mobile/sim/maps.json').read_text())}
    except (OSError, ValueError, KeyError, TypeError):
        return set()  # no list: refuse every world rather than start an unknown map


def mujoco_map(world_id):
    # plant_a/l1: the spawn floor is not a separate MuJoCo map.
    return world_id.partition('/')[0].replace('_', '-')


class MujocoLauncher:
    real = False   # not the native Gazebo episode; Manager keeps its non-native rules
    live = True    # but rows are live processes, so RUNNING/ERROR instead of PREPARED
    label = 'mujoco-local'

    def __init__(self, settings, *, command=None, env=None, ready_timeout=90.0, stop_timeout=5.0):
        source = os.environ if env is None else env
        if not source.get('FH_SIM_SRC'):
            raise ValueError('FH_SIM_LOCAL_BACKEND=mujoco requires FH_SIM_SRC (MuJoCo assets)')
        self.settings = settings
        self.command = list(command or [settings.agent_python, '-m', 'foothold_agent.mujoco_bridge'])
        self.base_env = {k: source[k] for k in (*BASE_KEYS, *SIM_KEYS) if k in source}
        self.base_env.setdefault('PATH', os.defpath)
        self.ready_timeout, self.stop_timeout = ready_timeout, stop_timeout
        self.children = {}
        self.world = None
        self.failure = False

    async def check_health(self):
        return False  # per-robot liveness is alive(); a dead child never latches the manager

    def alive(self, slot):
        child = self.children.get(slot.robot_id)
        return child is not None and child.poll() is None

    async def start_world(self, world):
        # The world id is the MuJoCo map id (mobile/sim/maps.json); the child checks the list itself.
        if not MAP_ID.fullmatch(mujoco_map(world.id)) or mujoco_map(world.id) not in mujoco_maps():
            raise WorldValidationError('MuJoCo map id required', 'SIM_WORLD_INVALID')
        self.world = world

    def _folder(self, slot):
        base = Path(self.settings.run_dir) if self.settings.run_dir else Path(tempfile.gettempdir()) / f'fh-mujoco-{os.getuid()}'
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        folder = base / slot.robot_id
        folder.mkdir(mode=0o700, exist_ok=True)
        return folder

    async def add(self, slot, credentials):
        if slot.robot_id in self.children or self.world is None:
            raise RuntimeError('MuJoCo slot busy or no world')
        folder = self._folder(slot)
        ready = folder / 'ready'
        ready.unlink(missing_ok=True)
        env = {**self.base_env,
               'PYTHONPATH': os.pathsep.join((str(ROOT / 'apps' / 'agent'), str(ROOT))),
               'PYTHONDONTWRITEBYTECODE': '1',
               'FOOTHOLD_AGENT_WS_URL': self.settings.agent_ws_url,
               'FOOTHOLD_AGENT_TOKEN': credentials['agent_token'],
               'FH_SIM_MAP': mujoco_map(self.world.id), 'FH_SIM_READY_FILE': str(ready)}
        bindings = credentials.get('map_bindings') or ()
        if bindings and self.settings.agent_ws_url:
            # Server-approved SIMULATION map bindings enable server run.start (route.LocalNav).
            import json
            from urllib.parse import urlsplit
            url = urlsplit(self.settings.agent_ws_url)
            env.update({'FH_SIM_ROBOT_ID': slot.robot_id, 'FH_SIM_ORG_ID': slot.org_id,
                        'FH_SIM_MAP_BINDINGS': json.dumps(list(bindings)),
                        'FOOTHOLD_SCENARIO_DATA_ORIGIN': ('https' if url.scheme == 'wss' else 'http') + '://' + url.netloc,
                        'FOOTHOLD_RUN_OUTBOX_PATH': str(folder / 'run-outbox.sqlite')})
        with open(folder / 'agent.log', 'ab') as log:
            child = subprocess.Popen(self.command, cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, start_new_session=True)
        self.children[slot.robot_id] = child
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.ready_timeout
        try:
            while True:
                if child.poll() is not None:
                    raise RuntimeError(f'MuJoCo agent exited before readiness (code {child.returncode})')
                try:
                    if ready.read_text().strip() == str(child.pid):
                        return
                except OSError:
                    pass
                if loop.time() > deadline:
                    raise RuntimeError('MuJoCo agent readiness unconfirmed (no server connection)')
                await asyncio.sleep(.05)
        except BaseException:
            # Never leave an unready child running; DELETE still confirms absence.
            await self._terminate(slot)
            raise

    async def _terminate(self, slot):
        child = self.children.get(slot.robot_id)
        if child is None:
            return
        group = child.pid  # start_new_session: pgid == pid of our own child
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(asyncio.to_thread(child.wait), self.stop_timeout)
            except asyncio.TimeoutError:
                pass
        # Leftover group members (the Node physics child) and a stubborn agent.
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await asyncio.wait_for(asyncio.to_thread(child.wait), 5)
        loop = asyncio.get_running_loop()
        end = loop.time() + 5
        while _group_alive(group):
            if loop.time() > end:
                self.failure = True
                raise RuntimeError('MuJoCo process group still present after SIGKILL')
            await asyncio.sleep(.05)

    async def stop_agent(self, slot):
        await self._terminate(slot)

    async def remove(self, slot):
        await self._terminate(slot)
        self.children.pop(slot.robot_id, None)
        (self._folder(slot) / 'ready').unlink(missing_ok=True)

    async def close_world(self):
        if self.children:
            raise RuntimeError('MuJoCo agents still present')
        self.world = None


def _group_alive(group):
    """Any non-zombie process in our own process group (by number, /proc only)."""
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            fields = Path('/proc', entry, 'stat').read_text().rsplit(')', 1)[1].split()
        except OSError:
            continue
        if int(fields[2]) == group and fields[0] != 'Z':
            return True
    return False

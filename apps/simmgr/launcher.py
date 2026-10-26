"""Fake by default. Native single-robot adapter is only constructed after opt-in."""
import asyncio
from datetime import datetime, timezone
import os
import json
import logging
from pathlib import Path
import signal
import subprocess
import sys

from foothold_agent.ros_bridge.config import validate_isolation
from foothold_agent.phone.tickets import load_keys
from .environment import validate_control_environment, child_environment
from .agent_unit import AgentUnit
from .nav2_unit import Nav2Unit
from .observer_unit import ObserverUnit
from .run_environment import map_assets, outbox_path, scenario_origin
from .preflight import ResourceGateError, startup_preflight, wait_resource_gate
from .native_catalogue import resolve_native_world, WorldValidationError

ROOT = Path(__file__).resolve().parents[2]
RESOURCE_EXITS = ('low_memory', 'swap_in_10s', 'runtime_limit')
# Both native unit launchers use TimeoutStopSec=45. Observe, never extend it
# with another signal; an unconfirmed exit still retains the cleanup latch.
RESOURCE_EXIT_WAIT_SECONDS = 45
RESOURCE_EXIT_POLL_SECONDS = .1


class CleanupUnconfirmed(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


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
    An already-failed agent instead requires verified destruction of its entire
    owned simulation before the slot or failure latch can be released.
    """
    real = True
    def __init__(self, settings):
        if os.environ.get('FH_SIM_RUN') != '1':
            raise ValueError('FH_SIM_RUN=1 is required')
        validate_control_environment()
        self.settings = settings
        self.sim = self.child = None
        self.nav2 = None
        self.observer = None
        self.observer_busy = False
        self.native_world = self.runtime_identity = None
        self._watching = False
        self.watch_task = None
        self.recovery_complete = False
        self.folder = None
        self.failed = False
        self.recovery_blocked = False
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
            if getattr(self, 'nav2', None) is not None and await asyncio.to_thread(self.nav2.poll) is not None:
                self.failed = True
            if getattr(self, 'observer', None) is not None and await asyncio.to_thread(self.observer.poll) is not None:
                self.failed = True
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.failed = True
        return self.failure

    @property
    def lifecycle_lock(self):
        if not hasattr(self, '_lifecycle_lock'):
            self._lifecycle_lock = asyncio.Lock()
        return self._lifecycle_lock

    async def _stop_nav2(self):
        if getattr(self, 'nav2', None) is None:
            return
        try:
            await asyncio.to_thread(self.nav2.stop)
        except BaseException as error:
            self.failed = self.recovery_blocked = True
            if isinstance(error, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
                raise
            raise CleanupUnconfirmed('SIM_CLEANUP_NAV2_UNPROVEN') from None
        self.nav2 = None

    async def _stop_observer(self):
        if getattr(self, 'observer', None) is None:
            return
        try:
            await asyncio.to_thread(self.observer.stop)
        except BaseException as error:
            self.failed = self.recovery_blocked = True
            if isinstance(error, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
                raise
            raise CleanupUnconfirmed('SIM_CLEANUP_OBSERVER_UNPROVEN') from None
        self.observer = None

    async def external_view(self, request, op):
        from .external_camera import log_ipc_failure
        # No manager lifecycle/control lock is acquired for observation work.
        observer = getattr(self, 'observer', None)
        if observer is None or self.failure or self.observer_busy or not self._watching:
            log_ipc_failure('client_unavailable')
            raise ValueError('external camera unavailable or busy')
        self.observer_busy = True
        stage = 'client_connect'
        async def relay(operation):
            nonlocal stage
            stage = 'client_connect'
            reader, writer = await asyncio.open_unix_connection(observer.socket_path, limit=4096)
            try:
                stage = 'client_write'
                writer.write(json.dumps(dict(op=operation, request=request.model_dump(mode='json'))).encode()+b'\n')
                await writer.drain()
                stage = 'client_ack'
                result = json.loads(await reader.readline())
                stage = 'client_validate'
                if result.get('accepted') is not True:
                    raise ValueError('external camera binding rejected')
                return result
            finally:
                writer.close()
                try:
                    await writer.wait_closed()
                except BaseException as error:
                    log_ipc_failure('client_close', error)
                    raise
        try:
            # Leave HTTP/dispatch headroom below the server's 500ms deadline.
            return await asyncio.wait_for(relay(op), .3)
        except BaseException as error:
            log_ipc_failure(stage, error)
            # Drop an unacknowledged pending request without touching a newer
            # viewer's sequence. No retry queue and no lifecycle lock.
            try:
                await asyncio.wait_for(relay('discard'), .05)
            except (OSError, ValueError, asyncio.TimeoutError) as discard_error:
                log_ipc_failure('client_discard', discard_error)
            raise
        finally:
            self.observer_busy = False

    async def _watch_children(self, folder):
        # Independent of HTTP polling. The same lock serializes explicit removal.
        while self._watching and self.folder == folder:
            await asyncio.sleep(.5)
            async with self.lifecycle_lock:
                if not self._watching or self.folder != folder:
                    return
                try:
                    if not await self.check_health():
                        continue
                    self._watching = False
                    await self._stop_agent(None)
                    await self._close_world()
                    self.recovery_complete = True
                    self.failed = True  # owner must still acknowledge the failed episode
                except Exception:
                    self.failed = self.recovery_blocked = True
                    self._watching = False
                    logging.getLogger(__name__).exception('episode child cleanup unconfirmed')
                return

    async def _cleanup_failed_start(self, slot):
        # Startup has no running watcher yet. Keep the same peer cleanup and
        # owner acknowledgement as an unexpected exit after listener readiness.
        await self.stop_agent(slot)
        await self.close_world()
        self.recovery_complete = True
        self.failed = True

    async def _poll(self):
        try:
            return await asyncio.to_thread(self.child.poll)
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.failed = True
            self.recovery_blocked = True
            raise RuntimeError('agent unit status unavailable') from None

    async def _signal(self, sig):
        try:
            await asyncio.to_thread(self.child.send_signal, sig)
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.failed = True
            self.recovery_blocked = True
            raise RuntimeError('agent unit signal failed') from None

    async def _wait(self, timeout):
        try:
            return await asyncio.to_thread(self.child.wait, timeout=timeout)
        except subprocess.TimeoutExpired:
            self.failed = True
            self.recovery_blocked = True
            raise
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.failed = True
            self.recovery_blocked = True
            raise RuntimeError('agent unit cleanup failed') from None

    async def start_world(self, world):
        validate_control_environment()
        if self.failure or self.sim is not None or self.child is not None:
            raise RuntimeError('native episode unavailable; no automatic restart')
        # Import the established supervisor without importing ROS or starting nodes.
        sim_tools = str(ROOT / 'apps/agent/tools/sim')
        if sim_tools not in sys.path:
            sys.path.insert(0, sim_tools)
        from isolation import Simulation
        from constants import MAP_DIRECTORY
        native_root = Path(self.settings.source).parent.parent.parent / MAP_DIRECTORY
        native = resolve_native_world(world, self.settings.worlds, native_root)
        if world.id.startswith('v5_building/'):
            from .connected_assets import verify_bindings
            try:
                verify_bindings(native.root, world.map_bindings)
            except (ValueError, KeyError, TypeError, OSError) as error:
                raise WorldValidationError('connected map bindings do not match cleared assets') from error
        if native.repository:
            from .repo_runtime import verify_bindings
            try:
                verify_bindings(native, world.map_bindings)
            except (ValueError, KeyError, TypeError, OSError) as error:
                raise WorldValidationError('repository map bindings do not match cleared assets') from error
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
        try:
            await asyncio.to_thread(wait_resource_gate, folder)
        except ResourceGateError:
            self.folder = None
            raise
        self.native_world = native
        extra = {}
        if world.id != 'v5_single/f1':
            from .native_simulation import CataloguedSimulation
            Simulation = CataloguedSimulation
            extra = dict(native=native, configured_world=world)
        sim = Simulation(folder, Path(self.settings.source), Path(self.settings.ros_setup),
                         launch_env=child_environment(self.settings.domain),
                         seconds=self.settings.unit_runtime_seconds, **extra)
        self.sim = sim
        resource_not_created = False
        try:
            try:
                await asyncio.to_thread(sim.start)
            except RuntimeError as error:
                # Simulation.start's first operation is its preflight. This
                # exact rejection precedes source hashing and unit creation.
                if (not sim.started and str(error) == 'preflight resource gate failed; no launch'
                        and not (folder / 'source-before.json').exists()
                        and not (folder / 'launch.json').exists() and not sim.out.exists()):
                    resource_not_created = True
                    raise ResourceGateError() from None
                raise
            # MainPID appears before imports/assets/Gazebo are ready. D1 also
            # verifies the live partition only after startup, never at unit birth.
            deadline = asyncio.get_running_loop().time() + 110
            while True:
                if sim.reason:
                    raise RuntimeError('simulation supervisor stopped during startup')
                try:
                    self.runtime_identity = await asyncio.to_thread(sim.live_identity)
                    break
                except RuntimeError:
                    if asyncio.get_running_loop().time() >= deadline:
                        raise RuntimeError('native identity readiness unconfirmed') from None
                    await asyncio.sleep(.1)
        except BaseException as error:
            if isinstance(error, ResourceGateError) and resource_not_created:
                # The exact first gate plus absence of any launch artifacts is
                # the sole exception to the native failure latch.
                self.sim = self.folder = None
                raise
            self.failed = True
            if sim.started:
                await asyncio.to_thread(sim.close)
                self.sim = None
            if isinstance(error, ResourceGateError):
                raise RuntimeError('resource failure after possible launch; review required') from None
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
        env['FOOTHOLD_RUN_OUTBOX_PATH'] = await asyncio.to_thread(outbox_path, self.settings, slot)
        env['FOOTHOLD_SCENARIO_DATA_ORIGIN'] = scenario_origin(self.settings)
        if self.settings.arrival_pose_max_age_s is not None:
            env['FH_RUN_ARRIVAL_POSE_MAX_AGE_S'] = str(self.settings.arrival_pose_max_age_s)
        env['FOOTHOLD_RUN_MAP_ASSETS_JSON'] = await asyncio.to_thread(
            map_assets, self.native_world, credentials.get('map_bindings', ()), self.folder)
        env['GZ_PARTITION'] = self.runtime_identity['partition']
        if credentials.get('map_bindings'):
            # The connected runtime exports its actual nonce before Gazebo starts.
            # manifest.json is written at exit; the output folder is a different ID.
            identity = json.loads((self.sim.out / 'run-identity.json').read_text())
            env['FOOTHOLD_FLOOR_BINDINGS'] = json.dumps(dict(robot_id=slot.robot_id,
                generation=credentials['generation'], run_id=identity['run_id'], epoch=1,
                spawn_floor_id=('f1' if credentials['map_bindings'][0]['world_id'] in ('warehouse', 'rubble')
                                else credentials['spawn_floor_id']), bindings=credentials['map_bindings']))
        try:
            if getattr(self.native_world, 'repository', False):
                from uuid import UUID
                episode = str(UUID(json.loads((self.sim.out/'run-identity.json').read_text())['run_id']))
                self.observer = await asyncio.to_thread(ObserverUnit, self.folder, self.settings,
                    ROOT, self.runtime_identity, slot.robot_id, episode)
                await asyncio.to_thread(self.observer.start)
            self.nav2 = await asyncio.to_thread(Nav2Unit, self.folder, self.settings, ROOT, self.runtime_identity)
            await asyncio.to_thread(self.nav2.start)
            self.child = await asyncio.to_thread(AgentUnit, self.folder, self.settings, env, ROOT)
            deadline = asyncio.get_running_loop().time() + 30
            while asyncio.get_running_loop().time() < deadline:
                if (await self._poll() is not None or self.sim.reason
                        or await asyncio.to_thread(self.nav2.poll) is not None
                        or (getattr(self, 'observer', None) is not None
                            and await asyncio.to_thread(self.observer.poll) is not None)):
                    raise RuntimeError('agent/Nav2/simulation startup failed')
                try:
                    reader, writer = await asyncio.wait_for(asyncio.open_connection(self.settings.agent_host, slot.port), .2)
                    writer.close()
                    await writer.wait_closed()
                    self._watching = True
                    self.watch_task = asyncio.create_task(self._watch_children(self.folder))
                    return
                except (OSError, asyncio.TimeoutError):
                    await asyncio.sleep(.1)
            raise RuntimeError('agent listener readiness unconfirmed')
        except BaseException:
            self.failed = True
            await self._cleanup_failed_start(slot)
            raise

    async def stop_agent(self, slot):
        self._watching = False
        async with self.lifecycle_lock:
            await self._stop_agent(slot)

    async def _stop_agent(self, slot):
        try:
            await self._stop_agent_process(slot)
        finally:
            # Even failed STOP/zero must not leave a command-producing Nav2 child.
            try:
                await self._stop_nav2()
            finally:
                await self._stop_observer()

    async def _stop_agent_process(self, slot):
        child = self.child
        if child is None:
            return
        code = await self._poll()
        if code is not None and code != 0:
            await self._stop_nav2()
            await self._stop_observer()
            await self._recover_failed_agent()
            return
        if code is None:
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
            self.recovery_blocked = True
            raise RuntimeError('agent STOP/zero cleanup unconfirmed')
        self.child = None

    def _verify_native_identity(self, sim):
        if sim is None or not sim.started or sim.identity is None or sim.folder != self.folder:
            raise RuntimeError('native ownership unavailable')
        saved = json.loads((self.folder / 'unit.json').read_text())
        if saved != {'unit': sim.unit, 'pid': sim.pid, 'cgroup': sim.cg}:
            raise RuntimeError('native unit record mismatch')
        identity = sim.identity
        if (identity.get('main_pid') != sim.pid['pid']
                or identity.get('main_start_ticks') != sim.pid['start_ticks']
                or identity.get('cgroup') != sim.cg or identity.get('ros_domain') != '93'):
            raise RuntimeError('native live record mismatch')
        if sim.reason in RESOURCE_EXITS:
            # A resource abort explains an exit; it is neither lost ownership
            # nor proof of cleanup. Never signal a still-live resource abort.
            self._verify_native_absence(sim)
        elif sim.reason not in (None, 'unit_exited'):
            raise RuntimeError('native supervisor failure')
        if int(sim.show().get('MainPID', 0)):
            try:
                live = sim.live_identity()  # exact PID/start_ticks/cgroup/domain93/partition
            except (OSError, RuntimeError):
                # The main process may exit between systemctl and /proc. An
                # inactive empty unit is an alternative proof, never a guessed PID.
                self._verify_native_absence(sim)
                return
            if any(live.get(key) != identity.get(key) for key in
                   ('main_pid', 'main_start_ticks', 'cgroup', 'ros_domain', 'partition')):
                raise RuntimeError('native live identity changed')

    def _verify_native_absence(self, sim):
        """Read-only recheck of the owned unit, cgroup and existing 93/DDS gates."""
        from isolation import processes, dds_ports
        info = sim.show()
        if info.get('MainPID') != '0' or info.get('ActiveState') not in ('inactive', 'failed'):
            raise RuntimeError('native unit exit unconfirmed')
        if not sim.cg or not sim.cg.startswith('/') or '..' in Path(sim.cg).parts:
            raise RuntimeError('invalid native cgroup')
        group = info.get('ControlGroup')
        if group not in ('', sim.cg):
            raise RuntimeError('native cgroup identity changed')
        try:
            events = (Path('/sys/fs/cgroup') / sim.cg.lstrip('/') / 'cgroup.events').read_text()
        except FileNotFoundError:
            pass  # systemd already removed the exited cgroup
        else:
            if dict(line.split() for line in events.splitlines()).get('populated') != '0':
                raise RuntimeError('native cgroup remains populated')
        rows, denied = processes()
        if denied:
            raise RuntimeError('native process absence unconfirmed: permission denied')
        partition = sim.identity['partition']
        if any(r['domain'] == '93' or r['partition'] == partition
               or r['cgroup'].split(':', 2)[-1] == sim.cg
               or r['cgroup'].split(':', 2)[-1].startswith(sim.cg + '/') for r in rows):
            raise RuntimeError('native processes remain')
        ports, _ = dds_ports()
        if ports:
            raise RuntimeError('native DDS ports remain')

    def _verify_native_cleanup(self, sim):
        result = json.loads((self.folder / 'cleanup.json').read_text())
        manifest = json.loads((sim.out / 'manifest.json').read_text())
        ledgers = manifest.get('isolation', {})
        before = ledgers.get('ledger_sha_before')
        required = ('native_manifest_matches_live', 'native_cleanup_complete',
                    'operating_ledgers_unchanged', 'native_world_matches_clearance',
                    'source_unchanged', 'domain61_unchanged')
        if (any(result.get(key) is not True for key in required)
                or result.get('leftovers') != [] or result.get('dds_ports') != []
                or str(result.get('unit', {}).get('MainPID')) != '0'
                or not isinstance(before, dict) or not before
                or before != ledgers.get('ledger_sha_after')
                or sim.reason not in (None, 'unit_exited', *RESOURCE_EXITS)):
            raise RuntimeError('native cleanup evidence incomplete')
        if sim.reason in RESOURCE_EXITS:
            self._verify_native_absence(sim)

    async def _wait_native_resource_exit(self, sim):
        """Bounded read-only grace for the supervisor's already-issued SIGINT."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + RESOURCE_EXIT_WAIT_SECONDS
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise RuntimeError('native resource exit timeout')
            info = await asyncio.wait_for(asyncio.to_thread(sim.show), remaining)
            if info.get('ControlGroup') not in ('', sim.cg):
                raise RuntimeError('native cgroup identity changed')
            if info.get('MainPID') == '0' and info.get('ActiveState') in ('inactive', 'failed'):
                return  # Full cgroup/process/DDS proof follows; status alone is insufficient.
            if (info.get('MainPID') not in ('0', str(sim.pid['pid']))
                    or info.get('ActiveState') not in ('active', 'activating', 'deactivating')):
                raise RuntimeError('native unit exit unconfirmed')
            await asyncio.sleep(min(RESOURCE_EXIT_POLL_SECONDS, max(0, deadline - loop.time())))

    async def _close_verified_native(self):
        """Reuse failed-agent proof for a native exit, even after agent exit0."""
        stage = 'SIM_CLEANUP_IDENTITY_UNPROVEN'
        latched = self.recovery_blocked
        try:
            sim = self.sim
            if not latched and sim is not None and sim.reason in RESOURCE_EXITS:
                await self._wait_native_resource_exit(sim)
            await asyncio.to_thread(self._verify_native_identity, sim)
            if latched:
                # An owner DELETE/deadline can recheck without a manager restart.
                # A latched retry may observe absence only, never signal survivors.
                await asyncio.to_thread(self._verify_native_absence, sim)
            stage = 'SIM_CLEANUP_NATIVE_UNPROVEN'
            await asyncio.to_thread(sim.close)
            await asyncio.to_thread(self._verify_native_cleanup, sim)
            if latched:
                await asyncio.to_thread(self._verify_native_absence, sim)
        except BaseException as error:
            self.failed = self.recovery_blocked = True
            if isinstance(error, (KeyboardInterrupt, SystemExit, asyncio.CancelledError, CleanupUnconfirmed)):
                raise
            logging.getLogger(__name__).warning('native cleanup unconfirmed stage=%s reason=%s error=%s',
                                               stage, getattr(self.sim, 'reason', None), type(error).__name__)
            if latched:
                raise CleanupUnconfirmed('SIM_CLEANUP_LATCHED') from None
            raise CleanupUnconfirmed(stage) from None
        self.recovery_blocked = False

    async def _recover_failed_agent(self):
        """Destroy the owned simulation; agent exit1 is never a STOP/zero ACK."""
        self.failed = True
        stage = 'SIM_CLEANUP_AGENT_UNPROVEN'
        try:
            if getattr(self, 'recovery_blocked', False):
                raise CleanupUnconfirmed('SIM_CLEANUP_LATCHED')
            await asyncio.to_thread(self.child.confirm_failed_exit)
            stage = 'SIM_CLEANUP_IDENTITY_UNPROVEN'
            await self._close_verified_native()
            stage = 'SIM_CLEANUP_AGENT_UNPROVEN'
            await asyncio.to_thread(self.child.reap_failed)
        except BaseException as error:
            self.recovery_blocked = True
            if isinstance(error, (KeyboardInterrupt, SystemExit, asyncio.CancelledError, CleanupUnconfirmed)):
                raise
            raise CleanupUnconfirmed(stage) from None
        self.sim = self.child = self.folder = None
        self.failed = False

    async def remove(self, slot):
        # The native robot belongs to the world. Its removal means world cleanup.
        await self.close_world()

    async def close_world(self):
        self._watching = False
        async with self.lifecycle_lock:
            await self._close_world()

    async def _close_world(self):
        if self.child is not None:
            self.failed = True
            raise RuntimeError('agent must confirm STOP/zero before world cleanup')
        try:
            await self._stop_nav2()
        finally:
            await self._stop_observer()
        if getattr(self, 'recovery_complete', False):
            self.recovery_complete = False
            self.failed = False
            return
        if self.failed or (self.sim is not None and self.sim.reason):
            # A native crash is recoverable only with the same ownership,
            # manifest/ledger and domain93 absence proof as a failed agent.
            await self._close_verified_native()
        elif self.sim is not None:
            sim = self.sim
            try:
                await asyncio.to_thread(sim.close)
                # unit_exited may race an intentional close; all other watcher
                # failures must retain ownership and the cleanup latch.
                if sim.reason not in (None, 'unit_exited'):
                    raise RuntimeError('native supervisor failure during cleanup')
            except BaseException as error:
                self.failed = self.recovery_blocked = True
                if isinstance(error, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
                    raise
                raise CleanupUnconfirmed('SIM_CLEANUP_NATIVE_UNPROVEN') from None
        self.sim = self.child = self.folder = None
        self.failed = False

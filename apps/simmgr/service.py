"""Serialized lifecycle transitions, one owner/robot and one active world."""
import asyncio
from dataclasses import dataclass
from uuid import UUID

from .launcher import FakeLauncher, NativeLauncher
from .environment import validate_control_environment


class SimError(Exception):
    def __init__(self, code, status=409, detail=None):
        self.code, self.status = code, status
        self.detail = detail or {'reason': 'slot_busy' if code == 'SIM_SLOT_BUSY' else 'unknown'}


@dataclass
class Robot:
    slot: object
    owner: str
    world: str
    state: str
    generation: int


class Manager:
    def __init__(self, settings, launcher=None):
        validate_control_environment()
        self.settings = settings
        self.launcher = launcher if launcher is not None else (NativeLauncher(settings) if settings.real else FakeLauncher())
        if self.launcher.real != settings.real:
            raise ValueError('launcher mode mismatch')
        self.lock = asyncio.Lock()
        self.world = None
        self.robots = {}
        # Process-local cancellation receipts; the server DB owns lifetime generations.
        self.removed_generation = {}
        self.closing = self.failed = False

    async def healthy(self):
        if self.launcher.real and await self.launcher.check_health():
            self.failed = True
        if self.closing or self.failed:
            raise SimError('SIM_UNAVAILABLE', 503)

    def describe(self, robot):
        slot = robot.slot
        native = self.launcher.real
        if native and getattr(self.launcher, 'failure', False):
            robot.state = 'ERROR'
        return dict(generation=robot.generation, robot_id=slot.robot_id, owner_id=robot.owner, world_id=robot.world,
            simulation=True, state=robot.state, agent_address=f'ws://{self.settings.agent_host}:{slot.port}/phone/ws',
            namespace='' if native else slot.namespace,
            tf_prefix='' if native else slot.namespace.lstrip('/') + '/',
            command_topic='/v2_live/cmd_vel' if native else slot.namespace + '/v2_live/cmd_vel',
            launcher='native-single' if native else 'fake')

    async def start_world(self, world_id):
        async with self.lock:
            return await self._world(world_id)

    async def _world(self, world_id):
        await self.healthy()
        if world_id not in self.settings.worlds:
            raise SimError('SIM_WORLD_NOT_FOUND', 404)
        if self.world is not None:
            if self.world != world_id:
                raise SimError('SIM_WORLD_BUSY')
            return
        world = self.settings.worlds[world_id]
        if self.launcher.real and (not world.world_file.is_file() or not world.map_file.is_file()):
            raise SimError('SIM_ASSET_MISSING', 503)
        try:
            await self.launcher.start_world(world)
        except BaseException:
            self.failed = True
            raise
        self.world = world_id

    async def add(self, world_id, robot_id, owner_id, org_id, agent_token, generation):
        async with self.lock:
            await self.healthy()
            for value in (robot_id, owner_id, org_id):
                if str(UUID(value)) != value:
                    raise SimError('SIM_IDENTITY_INVALID', 400)
            slot = self.settings.slots.get(robot_id)
            if slot is None or slot.org_id != org_id:
                raise SimError('SIM_SLOT_NOT_FOUND', 404)
            if generation <= self.removed_generation.get(robot_id, 0):
                raise SimError('SIM_GENERATION_STALE')
            existing = self.robots.get(robot_id)
            if existing is not None:
                if existing.generation == generation and existing.owner == owner_id and existing.world == world_id and existing.state not in ('ERROR', 'STOPPING'):
                    return self.describe(existing)
                raise SimError('SIM_SLOT_BUSY')
            if any(r.owner == owner_id for r in self.robots.values()):
                raise SimError('SIM_OWNER_LIMIT')
            if self.launcher.real and self.robots:
                raise SimError('SIM_NATIVE_SINGLE_ONLY')
            if len(self.robots) >= self.settings.max_robots:
                raise SimError('SIM_ROBOT_LIMIT')
            if not isinstance(agent_token, str) or not 32 <= len(agent_token) <= 256:
                raise SimError('SIM_CREDENTIAL_INVALID', 400)
            await self._world(world_id)
            row = Robot(slot, owner_id, world_id, 'STARTING', generation)
            self.robots[robot_id] = row
            try:
                await self.launcher.add(slot, {'agent_token': agent_token})
            except BaseException:
                row.state = 'ERROR'
                # Retain ownership and capacity until confirmed cleanup; never reuse.
                self.failed = True
                raise
            row.state = 'RUNNING' if self.launcher.real else 'PREPARED'
            return self.describe(row)

    async def remove(self, robot_id, generation):
        async with self.lock:
            self.removed_generation[robot_id] = max(generation, self.removed_generation.get(robot_id, 0))
            row = self.robots.get(robot_id)
            if row is None:
                return  # server DB owns generations; absent robots are already removed
            if generation != row.generation:
                raise SimError('SIM_GENERATION_MISMATCH')
            row.state = 'STOPPING'
            try:
                await self.launcher.stop_agent(row.slot)
                await self.launcher.remove(row.slot)
            except BaseException:
                row.state = 'ERROR'
                self.failed = True
                raise
            del self.robots[robot_id]
            if self.launcher.real:
                self.world = None

    async def close(self):
        self.closing = True
        errors = []
        for rid in list(self.robots):
            try:
                await self.remove(rid, self.robots[rid].generation)
            except BaseException as error:
                errors.append(error)
        if errors:
            raise RuntimeError('STOP/zero unconfirmed; world retained') from errors[0]
        async with self.lock:
            await self.launcher.close_world()
            self.world = None

    async def listing(self, org_id):
        if self.launcher.real:
            await self.launcher.check_health()
        return [self.describe(row) for row in self.robots.values() if row.slot.org_id == org_id]

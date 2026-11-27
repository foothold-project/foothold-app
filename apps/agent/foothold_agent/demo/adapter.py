"""Simulated robots on the real link path: Session -> Client -> server WS.

Each demo robot is one unmodified link Client with its own token, driving a
DemoSession (a Session subclass). State frames are built by Session._state()
from the same measured-cache projection the real robots use
(link/telemetry.project), plus robot_info / posture / reported_run shaped like
go2_direct/reporting.project(). Run progress goes out as run.update through the
Session history FIFO, exactly as the real agent's run transitions do.

Like the real read-only reporter (go2_direct/reporting.ReadOnlyObserver), a
demo robot takes no commands: every server frame except ping is reduced to a
no-authority envelope (liveness only). Nothing here can move hardware.
"""
import asyncio
from datetime import datetime, timezone
import json
import time

from foothold_agent.go2_readonly.state import SDK_JOINTS
from foothold_agent.link.session import Session
from .replay import Player
from .sim import Simulation

PUMP_HZ = 10
_IGNORED = {'t': 'demo.ignored'}  # unknown t: liveness only, never authority


class NullSink:
    """Demo robots have no motors; every motion command is dropped."""

    def apply(self, command):
        pass


class DemoSession(Session):
    def __init__(self, robot_id, *, now=time.monotonic):
        super().__init__(now=now, identity={'robot_model': 'unitree_go2'})
        self.robot_id = robot_id
        self.extra = {}

    def _state(self):
        return {**super()._state(), **self.extra}

    def receive(self, frame):
        if isinstance(frame, (str, bytes)):
            try:
                frame = json.loads(frame)
            except (ValueError, UnicodeError, RecursionError):
                return super().receive(frame)
        if isinstance(frame, dict) and frame.get('t') == 'ping':
            return super().receive(frame)
        if isinstance(frame, dict) and isinstance(frame.get('t'), str) and frame['t']:
            return super().receive(dict(_IGNORED))
        return super().receive(frame)

    def report_run(self, update):
        self.retain([update])


def telemetry(snap, now):
    """Measured-cache snapshot in the form link/telemetry.project() accepts."""
    observation = dict(clock='simulation', received_monotonic_s=now, progress_monotonic_s=now)
    return dict(observation=observation, speed=round(snap['speed'], 3),
                location=dict(observation, floor_id=snap['floor_id'], map_version_id=snap['map_version_id'],
                              x=round(snap['x'], 3), y=round(snap['y'], 3), yaw=round(snap['yaw'], 4),
                              confidence=snap['confidence']),
                battery=dict(soc=round(snap['soc'], 2), voltage=snap['voltage']))


def devices(now):
    # Same keys/labels as go2_direct/reporting.devices(), all observed now.
    return [dict(key='go2-battery', kind='BATTERY', label='기체 배터리', state='OK', received_monotonic_s=now),
            dict(key='go2-imu', kind='OTHER', label='기체 자세 센서', state='OK', received_monotonic_s=now),
            dict(key='go2-sport', kind='OTHER', label='기체 기본 보행 상태', state='OK', received_monotonic_s=now)]


def _reading(value):
    return value if type(value) is int and 1 <= value <= 150 else None


def robot_info(sample, wall):
    at = datetime.fromtimestamp(wall, timezone.utc).isoformat()
    attitude = sample['attitude'] or [None, None]
    battery = sample['battery_temp'] or [None] * 4
    error = sample['error_code']
    return dict(source='GO2_DDS', fallen=False, fallen_source='imu_tilt_estimate',
                attitude=dict(roll=attitude[0], pitch=attitude[1]),
                error_code=error if type(error) is int and 0 <= error <= 0xFFFFFFFF else None,
                joints=dict(received_at=at, age_s=0.0, names=list(SDK_JOINTS),
                            positions=list(sample['positions'])),
                temperature=dict(joints=[_reading(v) for v in sample['joint_temp']],
                                 battery=[_reading(v) for v in battery], imu=None, body=[None, None],
                                 age_s=0.0))


def run_update(update):
    return {'t': 'run.update', 'run_id': update['run_id'], 'status': update['status'],
            'step': update['step'], 'progress': dict(update['progress']), 'path_deviation_m': 0.0,
            'wait_reason': update['wait_reason'], 'fail_code': update['fail_code']}


class Fleet:
    """N simulated robots in one process; pump() is the only clock entry."""

    def __init__(self, scenario, library, *, speed=1.0, now=time.monotonic, wall=time.time, sim=None):
        if not speed > 0:
            raise ValueError('speed must be positive')
        self.scenario, self.speed, self.now, self.wall = scenario, speed, now, wall
        self.sim = sim or Simulation(scenario)
        ids = [r.id for r in scenario.robots]
        self.players = {rid: Player(library, offset=7 * i) for i, rid in enumerate(ids)}
        self.sessions = {rid: DemoSession(rid, now=now) for rid in ids}
        self.last = None
        self.pump()

    def pump(self):
        t = self.now()
        wall_dt = 0.0 if self.last is None else max(0.0, t - self.last)
        self.last = t
        if wall_dt:
            self.sim.step(wall_dt * self.speed)
        for update in self.sim.drain_run_updates():
            self.sessions[update['robot']].report_run(run_update(update))
        for rid, session in self.sessions.items():
            snap = self.sim.snapshot(rid)
            # Joints replay in real time even when the schedule is fast-forwarded.
            sample = self.players[rid].advance(snap['activity'], wall_dt)
            session.update_telemetry(telemetry(snap, t))
            session.update_devices(devices(t))
            session.extra = dict(robot_info=robot_info(sample, self.wall()),
                                 posture=dict(state=snap['posture'], mode=None),
                                 reported_run=snap['run'])


async def run(fleet, settings_by_robot, *, pump_hz=PUMP_HZ):
    """Run every robot's Client and the shared pump until cancelled or one fails."""
    from foothold_agent.link.client import Client
    missing = set(fleet.sessions) - set(settings_by_robot)
    if missing:
        raise ValueError(f'no demo registration for {sorted(missing)}')
    clients = [Client(fleet.sessions[rid], NullSink(), settings_by_robot[rid]) for rid in fleet.sessions]

    async def pump():
        while True:
            fleet.pump()
            await asyncio.sleep(1 / pump_hz)

    tasks = [asyncio.create_task(pump())] + [asyncio.create_task(c.run()) for c in clients]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

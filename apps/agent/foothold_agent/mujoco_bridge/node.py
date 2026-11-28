"""Node MuJoCo child (apps/simagent/child.mjs) in place of rclpy; everything else is ros_bridge's.

The child speaks one JSON object per line (apps/simagent/README.md). Its state
lines use the Gazebo `/v2_live/state` schema, so ros_bridge.Inputs, StateGate,
Telemetry and RosSink are reused unchanged: the safety contract stays in Python.
Only the transport (pipes instead of DDS topics) and the sim's own measurements are added
here: battery soc and joint motor temperatures, both integrated by the child from MuJoCo's
joint torques and velocities (apps/simagent/vitals.mjs), plus their devices. Temperatures
go out in the same field as the real Go2 (AgentState.robot_info.temperature, int degC,
SDK motor order).
"""

import asyncio
import json
import math
import os
import subprocess
import threading
import time

from foothold_agent.safety.core import STATE_STALE, finite
from foothold_agent.ros_bridge.diagnostics import StallDiagnostics
from foothold_agent.ros_bridge.node import Inputs
from foothold_agent.ros_bridge.sink import RosSink
from foothold_agent.ros_bridge.telemetry import Telemetry

# key -> (kind, label); same descriptor shape as ros_bridge SENSOR_TOPICS.
DEVICES = {'sim-battery': ('BATTERY', '시뮬 배터리'), 'sim-joint-temp': ('OTHER', '시뮬 관절 온도')}
FIRST_STATE_TIMEOUT = 30.0  # wasm compile + world load on a cold start
MAX_LINE = 65536


def joint_temperatures(raw):
    """Child joint_temp_c (12 finite degC, SDK order) -> contract ints, or None."""
    values = raw.get('joint_temp_c') if isinstance(raw, dict) else None
    if not isinstance(values, list) or len(values) != 12 or not all(finite(v) for v in values):
        return None
    return [round(v) for v in values]


def attitude(raw):
    """Child roll/pitch (rad, body quaternion) and fallen -> ((roll, pitch), fallen) or None."""
    if not isinstance(raw, dict):
        return None
    angles = tuple(raw.get(k) if finite(raw.get(k)) and -math.pi <= raw[k] <= math.pi else None
                   for k in ('roll', 'pitch'))
    fallen = raw.get('fallen') if type(raw.get('fallen')) is bool else None
    if all(v is None for v in angles) and fallen is None:
        return None
    return angles, fallen


class SimTelemetry(Telemetry):
    """Adds the child's own measurements; each expires with STATE_STALE like the state itself."""

    battery = None  # (soc, received_monotonic_s, minutes_left int | None)
    temperature = None  # (12 int degC SDK order, received_monotonic_s)
    attitude = None  # ((roll, pitch), fallen, received_monotonic_s)
    policy = None  # (policy_running bool, received_monotonic_s)

    def _fresh(self, sample, at):
        return sample is not None and 0 <= self.now() - sample[at] <= STATE_STALE

    def snapshot(self):
        snapshot = super().snapshot()
        observation = snapshot['observation']
        if observation is None:
            return snapshot
        if self._fresh(self.battery, 1):
            snapshot['battery'] = {'soc': self.battery[0], 'minutes_left': self.battery[2]}
        # The child only ever runs the START m15500 policy (world.mjs checks its sha256) and
        # Session rejects every gait request (GAIT_UNSUPPORTED): nothing is selectable.
        if self._fresh(self.policy, 1):
            snapshot['gait'] = {'gait': 'start' if self.policy[0] else None, 'available': []}
        temperature, pose = self._fresh(self.temperature, 1), self._fresh(self.attitude, 2)
        if temperature or pose:
            # Same Go2RobotInfo shape the real agent sends (go2_direct/reporting.py). The contract's
            # only source value is 'GO2_DDS'; RobotSummary.simulation marks this robot. error_code is
            # not modelled here, so it stays unknown (None), never invented.
            (roll, pitch), fallen = self.attitude[:2] if pose else ((None, None), None)
            info = dict(source='GO2_DDS', attitude=dict(roll=roll, pitch=pitch), error_code=None,
                        fallen=fallen, fallen_source='imu_tilt_estimate')
            if temperature:
                info['temperature'] = dict(joints=list(self.temperature[0]), battery=[None] * 4, imu=None,
                                           body=[None, None], age_s=self.now() - self.temperature[1])
            snapshot['robot_info'] = info
        return snapshot


class SimInputs(Inputs):
    def _consume(self, bundle):
        battery = bundle.pop('battery', None)
        if battery is not None:
            self.telemetry.battery = battery
            self.devices['sim-battery'] = battery[1]
        temperature = bundle.pop('temperature', None)
        if temperature is not None:
            self.telemetry.temperature = temperature
            self.devices['sim-joint-temp'] = temperature[1]
        pose = bundle.pop('attitude', None)
        if pose is not None:
            self.telemetry.attitude = pose
        policy = bundle.pop('policy', None)
        if policy is not None:
            self.telemetry.policy = policy
        super()._consume(bundle)

    def device_snapshot(self):
        return [{"key": key, "kind": DEVICES[key][0], "label": DEVICES[key][1],
                 "state": "OK" if 0 <= self.now() - receipt <= STATE_STALE else "MISSING"}
                for key, receipt in sorted(self.devices.items())]


class MujocoNode:
    """Same surface as ros_bridge.node.RosNode: start() -> sink, inputs, wait_failure(), close()."""

    def __init__(self, command, *, env=None, now=time.monotonic, cwd=None, state_log=None, map_binding=None):
        self.command, self.env, self.cwd, self.now = list(command), env, cwd, now
        # ros_bridge MapBinding of the floor the MuJoCo body walks. The child's body pose is the
        # simulation ground truth in that map's frame (Gazebo's 'gt_identity'), so it goes through
        # the same v2_map_status/1 -> Telemetry.location -> AgentState.pose path as Gazebo.
        self.map_binding = map_binding
        # Optional local measurement tap (JSON lines + host monotonic receipt) for
        # validation tools; never an input to safety decisions.
        self.state_log = open(state_log, 'a', buffering=1) if state_log else None
        self.diagnostics = StallDiagnostics(now=now)
        self.sink = self.inputs = self.child = None
        self.error = None
        self._write_lock = threading.Lock()
        self._closing = threading.Event()
        self._threads = []
        self._loop = self._ready = self._failure = None

    def _send(self, message):
        line = (json.dumps(message, allow_nan=False) + '\n').encode()
        with self._write_lock:
            self.child.stdin.write(line)
            self.child.stdin.flush()

    def _notify_failure(self, exc):
        self.error = self.error or exc
        if self._failure is not None and not self._failure.done():
            self._failure.set_result(exc)

    def _set_ready(self):
        if not self._ready.done():
            self._ready.set_result(None)

    def _set_failed(self, exc):
        if not self._ready.done():
            self._ready.set_exception(exc)
        self._notify_failure(exc)

    def _fail(self, exc):
        """Terminal: emergency ZERO/STOP via RosSink, then surface on the owning loop."""
        self.error = self.error or exc
        if self.sink is not None:
            try:
                self.sink.fail(exc)
            except BaseException:
                pass
        try:
            self._loop.call_soon_threadsafe(self._set_failed, exc)
        except RuntimeError:
            pass

    async def start(self, on_state, *, on_telemetry=None, on_devices=None):
        self._loop = asyncio.get_running_loop()
        self._ready = self._loop.create_future()
        self._failure = self._loop.create_future()
        self.diagnostics.start()
        # The child never needs agent credentials.
        env = {k: v for k, v in (self.env if self.env is not None else os.environ).items()
               if not k.startswith('FOOTHOLD_AGENT_')}
        self.child = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      env=env, cwd=self.cwd)
        # Buffered pipes (#640): an unbuffered stdout readline reads one byte per syscall and
        # re-takes the GIL per byte, so in-process grid/A* work starved state past STATE_STALE.
        # _send flushes every line, so stdin latency is unchanged.
        self.sink = RosSink(
            self.diagnostics.wrap('publish_velocity', lambda v: self._send({'t': 'cmd', 'v': list(v)})),
            self.diagnostics.wrap('publish_stop', lambda: self._send({'t': 'stop'})),
            self.diagnostics.wrap('publish_resume', lambda: self._send({'t': 'resume'})),
            now=self.now, diagnostics=self.diagnostics,
            on_error=lambda exc: self._loop.call_soon_threadsafe(self._set_failed, exc))
        self.inputs = SimInputs(self._loop, self.sink, on_state, now=self.now, on_error=self._notify_failure,
                                telemetry=SimTelemetry(now=self.now, binding=self.map_binding),
                                on_telemetry=on_telemetry, on_devices=on_devices)
        self._first = threading.Event()
        for target, name in ((self._read, 'mujoco-child-reader'), (self._publish, 'mujoco-child-output')):
            thread = threading.Thread(target=target, name=name, daemon=True)
            thread.start()
            self._threads.append(thread)
        await self._ready
        return self.sink

    async def wait_failure(self):
        error = await self._failure
        raise RuntimeError('MuJoCo bridge failed') from error

    def _map_status(self, raw):
        b = self.map_binding
        if b is None or not isinstance(raw, dict) or raw.get('episode') != b.episode:
            return None
        if not all(finite(raw.get(k)) for k in ('sim_t', 'x', 'y', 'yaw')):
            return None
        return {'schema': 'v2_map_status/1', 'map_frame': 'map', 'epoch': raw['episode'], 'sim_t': raw['sim_t'],
                'world_id': b.world_id, 'floor_id': b.ros_floor_id, 'map_version': b.ros_map_version,
                'run_id': b.run_id, 'map_accepting': True, 'map_error': None, 'pose_map_null_reason': None,
                'pose_map': {'source': 'gt_identity', 'x': raw['x'], 'y': raw['y'], 'yaw': raw['yaw'],
                             'stamp_sim': raw['sim_t']}}

    def _read(self):
        try:
            for line in self.child.stdout:
                if self._closing.is_set():
                    return
                received = self.now()
                if len(line) > MAX_LINE:
                    self.inputs.reject('oversize_line')
                    continue
                text = line.decode('utf-8', errors='replace')
                try:
                    raw = json.loads(text)
                except (ValueError, RecursionError):
                    raw = None
                soc = raw.get('battery_soc') if isinstance(raw, dict) else None
                if finite(soc) and 0 <= soc <= 100:
                    minutes = raw.get('battery_minutes_left')
                    self.inputs.mailbox.put(battery=(float(soc), received,
                                                     minutes if type(minutes) is int and minutes >= 0 else None))
                pose = attitude(raw)
                if pose is not None:
                    self.inputs.mailbox.put(attitude=(*pose, received))
                if isinstance(raw, dict) and type(raw.get('policy_running')) is bool:
                    self.inputs.mailbox.put(policy=(raw['policy_running'], received))
                temperature = joint_temperatures(raw)
                if temperature is not None:
                    self.inputs.mailbox.put(temperature=(temperature, received))
                self.inputs.state(text, received)
                status = self._map_status(raw)
                if status is not None:
                    self.inputs.mailbox.put(map=(status, received))
                if self.state_log is not None and isinstance(raw, dict):
                    self.state_log.write(json.dumps({'mono': received, 'state': raw}) + '\n')
                if not self._first.is_set() and self.inputs.last_state is not None:
                    self._first.set()
            if not self._closing.is_set():
                raise RuntimeError('MuJoCo child closed its state output')
        except BaseException as exc:
            if not self._closing.is_set():
                self._fail(exc)

    def _publish(self):
        try:
            self.sink.flush()  # startup ZERO/STOP before readiness/hello
            deadline = time.monotonic() + FIRST_STATE_TIMEOUT
            while not self._first.is_set():
                if self._closing.is_set():
                    return
                if self.child.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('MuJoCo child produced no valid state')
                self.sink.flush()
                time.sleep(0.01)
            self._loop.call_soon_threadsafe(self._set_ready)
            while not self._closing.is_set():
                if self.child.poll() is not None:
                    raise RuntimeError('MuJoCo child exited')
                self.inputs.stale()
                self.sink.flush()
                time.sleep(0.01)
        except BaseException as exc:
            if not self._closing.is_set():
                self._fail(exc)

    def close(self):
        self._closing.set()
        if self.inputs is not None:
            self.inputs.mailbox.close()
        try:
            if self.sink is not None:
                self.sink.close()  # final ZERO/STOP to the child before its stdin closes
        finally:
            if self.child is not None:
                try:
                    self.child.stdin.close()  # the child exits on stdin EOF
                except OSError:
                    pass
                try:
                    self.child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=2)
            for thread in self._threads:
                thread.join(timeout=1.0)
            self.diagnostics.close()
            if self.state_log is not None:
                self.state_log.close()
        if self.sink is not None:
            self.sink.check_health()

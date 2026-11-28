"""Node MuJoCo child (apps/simagent/child.mjs) in place of rclpy; everything else is ros_bridge's.

The child speaks one JSON object per line (apps/simagent/README.md). Its state
lines use the Gazebo `/v2_live/state` schema, so ros_bridge.Inputs, StateGate,
Telemetry and RosSink are reused unchanged: the safety contract stays in Python.
Only the transport (pipes instead of DDS topics) and two sim-only measurements
(battery soc, battery device) are added here.
"""

import asyncio
import json
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
DEVICES = {'sim-battery': ('BATTERY', '시뮬 배터리')}
FIRST_STATE_TIMEOUT = 30.0  # wasm compile + world load on a cold start
MAX_LINE = 65536


class SimTelemetry(Telemetry):
    """Adds the child's simulated battery; expires with the same STATE_STALE rule."""

    battery = None  # (soc, received_monotonic_s)

    def snapshot(self):
        snapshot = super().snapshot()
        if (self.battery is not None and snapshot['observation'] is not None
                and 0 <= self.now() - self.battery[1] <= STATE_STALE):
            snapshot['battery'] = {'soc': self.battery[0]}
        return snapshot


class SimInputs(Inputs):
    def _consume(self, bundle):
        battery = bundle.pop('battery', None)
        if battery is not None:
            self.telemetry.battery = battery
            self.devices['sim-battery'] = battery[1]
        super()._consume(bundle)

    def device_snapshot(self):
        return [{"key": key, "kind": DEVICES[key][0], "label": DEVICES[key][1],
                 "state": "OK" if 0 <= self.now() - receipt <= STATE_STALE else "MISSING"}
                for key, receipt in sorted(self.devices.items())]


class MujocoNode:
    """Same surface as ros_bridge.node.RosNode: start() -> sink, inputs, wait_failure(), close()."""

    def __init__(self, command, *, env=None, now=time.monotonic, cwd=None, state_log=None):
        self.command, self.env, self.cwd, self.now = list(command), env, cwd, now
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
                                telemetry=SimTelemetry(now=self.now),
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
                    self.inputs.mailbox.put(battery=(float(soc), received))
                self.inputs.state(text, received)
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

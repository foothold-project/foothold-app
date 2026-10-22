"""A dedicated rclpy thread and a coalescing, size-one owning-loop mailbox."""

import asyncio
from copy import deepcopy
import json
import threading
import time

from foothold_agent.safety.core import STATE_STALE
from .config import validate_isolation
from .sink import RosSink, twist_message
from .telemetry import StateGate, Telemetry


class LatestMailbox:
    """One pending bundle, one scheduled callback, no per-ROS-message asyncio queue.

    Each key is a latest cache (state/odom/map); rejection is sticky until drained
    so a subsequent good sample cannot erase the need to invalidate old telemetry.
    """

    def __init__(self, loop, consume):
        self.loop, self.consume = loop, consume
        self._lock = threading.Lock()
        self._pending = None
        self._scheduled = False
        self._closed = False

    def put(self, **latest):
        with self._lock:
            if self._closed:
                return
            if self._pending is None:
                self._pending = {}
            self._pending.update(deepcopy(latest))
            if not self._scheduled:
                self._scheduled = True
                try:
                    self.loop.call_soon_threadsafe(self._drain)
                except RuntimeError:
                    self._closed = True
                    self._pending = None
                    raise

    def _drain(self):
        with self._lock:
            bundle, self._pending = self._pending, None
            self._scheduled = False
            if self._closed:
                return
        if bundle is not None:
            self.consume(bundle)

    def close(self):
        with self._lock:
            self._closed = True
            self._pending = None


class Inputs:
    """No Core access from ROS callbacks: only Client.on_robot_state on its owner."""

    def __init__(self, loop, sink, on_state, *, telemetry=None, now=time.monotonic, on_error=None,
                 on_telemetry=None, on_devices=None):
        self.sink, self.on_state, self.now = sink, on_state, now
        self.telemetry = telemetry if telemetry is not None else Telemetry(now=now)
        self.on_error = on_error
        self.on_telemetry, self.on_devices = on_telemetry, on_devices
        self.devices = {}
        self._sensor_receipts = {}  # ROS thread only
        self._core_gates = self._core_stamp = None  # owning loop only
        self.gate = StateGate()  # exclusively used by the ROS thread
        self.last_state = None
        self.mailbox = LatestMailbox(loop, self._consume)

    def reject(self, reason):
        self.sink.hold()
        self.mailbox.put(state=None, invalid=reason)

    def state(self, raw, received_at=None):
        generation = self.sink.feedback_generation()
        received_at = self.now() if received_at is None else received_at
        if isinstance(raw, str):
            try:
                if len(raw) > 65536:
                    raise ValueError("oversize state")
                raw = json.loads(raw)
            except (ValueError, RecursionError):
                self.reject("invalid_json")
                return
        accepted = self.gate.accept(raw, received_at, self.now())
        if accepted is None:
            if self.gate.reason == "duplicate_stamp":
                return  # no refresh, no hold; receipt/state stale clocks still expire
            self.reject(self.gate.reason)
            return
        frame = (accepted, received_at, generation, self.gate.progress_at)
        if self.gate.advanced:
            self.last_state = received_at
        elif (accepted["stop_requested"] or accepted["reset_in_progress"] or not accepted["policy_running"]):
            self.sink.hold()
            self.mailbox.put(safety=frame)
        self.mailbox.put(state=frame)

    def stale(self):
        if self.last_state is not None and self.now() - self.last_state > STATE_STALE:
            self.last_state = None
            self.reject("stale")

    def sensor(self, key):
        self._sensor_receipts[key] = self.now()
        self.mailbox.put(sensors=self._sensor_receipts)

    def _consume(self, bundle):
        try:
            if "invalid" in bundle:
                self.telemetry.invalidate(bundle["invalid"])
                self._publish_telemetry()
            safety = bundle.get("safety")
            if safety is not None and safety != bundle.get("state"):
                self._deliver_state(safety)
            item = bundle.get("state")
            if item is not None:
                self._deliver_state(item)
            if "odom" in bundle:
                self.telemetry.update_odom(bundle["odom"])
            if "map" in bundle:
                raw, receipt = bundle["map"]
                self.telemetry.update_map(raw, receipt)
            self._publish_telemetry()
            if "sensors" in bundle:
                for key, receipt in bundle["sensors"].items():
                    if 0 <= self.now() - receipt <= STATE_STALE:
                        self.devices[key] = receipt
            if self.on_devices is not None:
                self.on_devices(self.device_observations())
        except BaseException as exc:
            self.sink.fail(exc)
            if self.on_error is not None:
                self.on_error(exc)
            else:
                raise

    def _deliver_state(self, item):
        raw, receipt, generation, progress_at = item
        if not 0 <= self.now() - receipt <= STATE_STALE:
            self.sink.hold()
            self.telemetry.invalidate("mailbox_stale")
            return
        if raw["reset_in_progress"]:
            self.sink.hold()
        elif raw["stop_requested"]:
            self.sink.observe_stop(generation)
        self.telemetry.update_state(raw, receipt, progress_at=progress_at)
        self._publish_telemetry()
        gates = tuple(raw[k] for k in ("stop_requested", "reset_in_progress", "policy_running"))
        gates += (bool(raw.get("fallen")),)
        stamp = (raw["episode"], raw["sim_t"])
        if stamp != self._core_stamp or gates != self._core_gates:
            self._core_stamp, self._core_gates = stamp, gates
            self.on_state(raw)  # measurement-only updates cannot refresh Core.state_t

    def _publish_telemetry(self):
        if self.on_telemetry is not None:
            self.on_telemetry(self.telemetry.snapshot())

    def device_snapshot(self):
        return [{"key": key, "kind": SENSOR_TOPICS[key][1], "label": SENSOR_TOPICS[key][2],
                 "state": "OK" if 0 <= self.now() - receipt <= STATE_STALE else "MISSING"}
                for key, receipt in sorted(self.devices.items())]

    def device_observations(self):
        """Keep receipt provenance for Session's input-independent expiry."""
        return [{**device, "received_monotonic_s": self.devices[device["key"]]}
                for device in self.device_snapshot()]


COMMAND_TOPICS = ("/v2_live/cmd_vel", "/v2_live/stop", "/v2_live/resume")
SENSOR_TOPICS = {
    "/v2_map/points": ("PointCloud2", "LIDAR", "L1 lidar"),
    "/v2_live/camera/compressed": ("CompressedImage", "CAMERA_RGB", "D435i RGB"),
    "/v2_live/sensor/d435i/depth/image_mm": ("Image", "CAMERA_DEPTH", "D435i depth"),
}


def require_single_writer(node):
    counts = {topic: node.count_publishers(topic) for topic in COMMAND_TOPICS}
    if any(count != 1 for count in counts.values()):
        raise RuntimeError(f"command writer conflict: {counts}")


def wait_for_stop_acks(publishers, duration, *, now=time.monotonic):
    """One shared second for reliable ZERO/STOP acknowledgements, before destroy."""
    deadline = now() + 1.0
    for publisher in publishers:
        remaining = max(0.0, deadline - now())
        if not publisher.wait_for_all_acked(duration(seconds=remaining)):
            raise RuntimeError("shutdown ZERO/STOP acknowledgement timed out")


class RosNode:
    """Starts nothing until start(); all optional ROS imports live in its thread.

    Normal ROS operations belong to that thread. The sink watchdog uses the
    thread-safe publishers only for emergency ZERO/STOP, including executor stall.
    """

    def __init__(self, config, *, now=time.monotonic, extension_factory=None, camera=None):
        self.config, self.now = config, now
        self.camera = camera
        self.extension_factory, self.extension = extension_factory, None
        self.sink = self.inputs = None
        self.error = None
        self._closing = threading.Event()
        self._thread = None
        self._loop = self._ready = self._failure = None

    def _notify_failure(self, exc):
        self.error = exc
        if self._failure is not None and not self._failure.done():
            self._failure.set_result(exc)

    async def start(self, on_state, *, on_telemetry=None, on_devices=None):
        validate_isolation()  # check again immediately before creating any DDS participant
        self._loop = asyncio.get_running_loop()
        self._ready = self._loop.create_future()
        self._failure = self._loop.create_future()
        self._on_telemetry, self._on_devices = on_telemetry, on_devices
        self._thread = threading.Thread(target=self._run, args=(on_state,), name="agent-rclpy", daemon=True)
        self._thread.start()
        await self._ready
        return self.sink

    async def wait_failure(self):
        error = await self._failure
        raise RuntimeError("ROS bridge failed") from error

    def _run(self, on_state):
        context = node = executor = None
        stop_publishers = ()
        Duration = None
        try:
            validate_isolation()
            import rclpy
            from rclpy.context import Context
            from rclpy.duration import Duration
            from rclpy.executors import SingleThreadedExecutor
            from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy, HistoryPolicy
            from geometry_msgs.msg import Twist
            from nav_msgs.msg import Odometry
            from std_msgs.msg import Empty, String
            from sensor_msgs import msg as sensor_messages

            context = Context()
            rclpy.init(args=[], context=context, domain_id=93)
            node = rclpy.create_node("foothold_sim_" + self.config.robot_id.replace("-", ""), context=context,
                                      enable_rosout=False, start_parameter_services=False,
                                      use_global_arguments=False)
            qos = QoSProfile(depth=1, history=HistoryPolicy.KEEP_LAST,
                             reliability=ReliabilityPolicy.RELIABLE, durability=DurabilityPolicy.VOLATILE)
            velocity = node.create_publisher(Twist, "/v2_live/cmd_vel", qos)
            stop = node.create_publisher(Empty, "/v2_live/stop", qos)
            resume = node.create_publisher(Empty, "/v2_live/resume", qos)
            stop_publishers = (velocity, stop)
            self.sink = RosSink(lambda v: velocity.publish(twist_message(v, Twist)),
                                lambda: stop.publish(Empty()), lambda: resume.publish(Empty()), now=self.now)
            self.inputs = Inputs(self._loop, self.sink, on_state, now=self.now, on_error=self._notify_failure,
                                 on_telemetry=self._on_telemetry, on_devices=self._on_devices)
            node.create_subscription(String, "/v2_live/state", lambda m: self.inputs.state(m.data), qos)

            def odom(m):
                self.inputs.mailbox.put(odom={
                    "header_stamp": m.header.stamp.sec + m.header.stamp.nanosec * 1e-9,
                    "clock": "unverified",
                    "received_monotonic_s": self.now(), "frame_id": m.header.frame_id,
                    "child_frame_id": m.child_frame_id, "x": m.pose.pose.position.x,
                    "y": m.pose.pose.position.y, "vx": m.twist.twist.linear.x,
                    "vy": m.twist.twist.linear.y, "wz": m.twist.twist.angular.z})

            def map_status(m):
                try:
                    raw = json.loads(m.data) if len(m.data) <= 65536 else None
                except (ValueError, RecursionError):
                    raw = None
                self.inputs.mailbox.put(map=(raw, self.now()))

            node.create_subscription(Odometry, "/v2_live/odom", odom, qos)
            node.create_subscription(String, "/v2_map/status", map_status, qos)
            # Metadata only: no images/clouds copied into the owning loop or persisted.
            # Best effort readers also match reliable publishers and depth is one.
            sensor_qos = QoSProfile(depth=1, history=HistoryPolicy.KEEP_LAST,
                                   reliability=ReliabilityPolicy.BEST_EFFORT, durability=DurabilityPolicy.VOLATILE)
            for topic, (typ, _, _) in SENSOR_TOPICS.items():
                node.create_subscription(getattr(sensor_messages, typ), topic,
                    lambda m, key=topic: self.inputs.sensor(key), sensor_qos)
            if self.camera is not None:
                node.create_subscription(sensor_messages.CompressedImage, '/v2_live/camera/compressed',
                    lambda m: self.camera.submit(m.data, m.format), sensor_qos)
            if self.extension_factory is not None:
                self.extension = self.extension_factory(node)
            executor = SingleThreadedExecutor(context=context)
            executor.add_node(node)
            self.sink.flush()  # startup ZERO/STOP before network connection/hello
            # Discovery settles before ready/network; later conflicts are terminal too.
            startup_until = time.monotonic() + 0.5
            while time.monotonic() < startup_until and not self._closing.is_set():
                executor.spin_once(timeout_sec=0.01)
                require_single_writer(node)
                if self.extension is not None:
                    self.extension.spin()
                self.sink.flush()
            require_single_writer(node)
            self._loop.call_soon_threadsafe(self._set_ready)
            while not self._closing.is_set():
                executor.spin_once(timeout_sec=0.01)
                require_single_writer(node)
                self.inputs.stale()
                if self.extension is not None:
                    self.extension.spin()
                self.sink.flush()
        except BaseException as exc:
            self.error = exc
            if self.sink is not None:
                self.sink.fail(exc)
            self._loop.call_soon_threadsafe(self._set_failed, exc)
        finally:
            if self.inputs is not None:
                self.inputs.mailbox.close()
            # Publishers/context stay alive until the emergency watchdog has stopped.
            if self.sink is not None:
                try:
                    self.sink.close()
                except BaseException as exc:
                    self.error = self.error or exc
                    self._loop.call_soon_threadsafe(self._set_failed, exc)
                    return  # incomplete output: never ACK/destroy live publishers
            try:
                if stop_publishers:
                    wait_for_stop_acks(stop_publishers, Duration)
            except BaseException as exc:
                self.error = self.error or exc
                self._loop.call_soon_threadsafe(self._set_failed, exc)
            try:
                if executor is not None:
                    executor.shutdown(timeout_sec=0.2)
                if node is not None:
                    node.destroy_node()
                if context is not None and context.ok():
                    context.shutdown()
            except BaseException as exc:
                self.error = self.error or exc
                self._loop.call_soon_threadsafe(self._set_failed, exc)

    def _set_ready(self):
        if not self._ready.done():
            self._ready.set_result(None)

    def _set_failed(self, exc):
        if not self._ready.done():
            self._ready.set_exception(exc)
        self._notify_failure(exc)

    def close(self):
        # Caller need not wait for a stuck executor before attempting emergency output.
        self._closing.set()
        if self.inputs is not None:
            self.inputs.mailbox.close()
        if self.sink is not None:
            self.sink.close()
        if self._thread is not None:
            self._thread.join(timeout=1.5)
            if self._thread.is_alive():
                raise RuntimeError("ROS executor did not stop; emergency output attempted")
        if self.sink is not None:
            self.sink.check_health()
        if self.error is not None:
            raise RuntimeError("ROS bridge failed during operation/shutdown") from self.error

"""Opt-in DDS-only synthetic test. Never launches Gazebo, policy, reset or WS.

Default pytest does not import rclpy. Before opting in, source Jazzy and set the
three required isolation variables; the test rechecks /proc + ss before DDS init.
"""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import time
import threading

import pytest

from foothold_agent.link.client import Client, Settings
from foothold_agent.link.session import Session
from foothold_agent.ros_bridge.config import Config, validate_isolation
from foothold_agent.ros_bridge.node import RosNode


def preflight():
    validate_isolation()
    occupied, unreadable = [], 0
    for p in Path("/proc").glob("[0-9]*/environ"):
        if p.parent.name == str(os.getpid()):
            continue
        try:
            if b"ROS_DOMAIN_ID=93" in p.read_bytes().split(b"\0"):
                occupied.append(p.parent.name)
        except (PermissionError, ProcessLookupError, FileNotFoundError):
            unreadable += 1
    sockets = subprocess.run(["ss", "-H", "-lun"], capture_output=True, text=True, check=True)
    ports = []
    for line in sockets.stdout.splitlines():
        address = line.split()[3]
        port = address.rsplit(":", 1)[-1]
        if port.isdigit() and 30650 <= int(port) <= 30899:
            ports.append(int(port))
    print(f"domain93 preflight: processes={occupied}, UDP_ports={ports}, unreadable/raced={unreadable}")
    if occupied or ports:
        pytest.skip("domain93 appears occupied; no DDS participant created")


@pytest.mark.skipif(os.environ.get("FOOTHOLD_ROS_SYNTHETIC") != "1", reason="explicit domain93 opt-in required")
def test_isolated_domain93_synthetic_ros():
    preflight()
    import rclpy
    from rclpy.context import Context
    from rclpy.executors import SingleThreadedExecutor
    from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
    from geometry_msgs.msg import Twist
    from std_msgs.msg import Empty, String

    class Peer:
        """Ingress-shaped peer with an executor independent of BOTH bridge threads."""
        def __init__(self):
            self.ready, self.closed, self.conflict = threading.Event(), threading.Event(), threading.Event()
            self.lock = threading.Lock()
            self.outputs, self.stops, self.resumes = [], [], []
            self.error = None
            self.thread = threading.Thread(target=self.run, name="synthetic-ingress", daemon=True)
            self.thread.start()
            assert self.ready.wait(3)
            assert self.error is None

        def run(self):
            context, node, executor = Context(), None, None
            try:
                rclpy.init(args=[], context=context, domain_id=93)
                node = rclpy.create_node("foothold_synthetic_ingress", context=context, enable_rosout=False,
                                         start_parameter_services=False, use_global_arguments=False)
                qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                                 durability=DurabilityPolicy.VOLATILE)
                publisher = node.create_publisher(String, "/v2_live/state", qos)
                stopped = True
                velocity = (0., 0., 0.)
                def cmd(m):
                    nonlocal velocity
                    velocity = (m.linear.x, m.linear.y, m.angular.z)
                    with self.lock:
                        self.outputs.append((time.monotonic(), velocity))
                def stop(m):
                    nonlocal stopped
                    stopped = True
                    with self.lock:
                        self.stops.append(time.monotonic())
                def resume(m):
                    nonlocal stopped
                    stopped = False
                    with self.lock:
                        self.resumes.append(time.monotonic())
                node.create_subscription(Twist, "/v2_live/cmd_vel", cmd, qos)
                node.create_subscription(Empty, "/v2_live/stop", stop, qos)
                node.create_subscription(Empty, "/v2_live/resume", resume, qos)
                executor = SingleThreadedExecutor(context=context)
                executor.add_node(node)
                stamp, published, intruder = 0., 0., None
                self.ready.set()
                while not self.closed.is_set():
                    executor.spin_once(timeout_sec=.002)
                    now = time.monotonic()
                    if self.conflict.is_set() and intruder is None:
                        intruder = node.create_publisher(Twist, "/v2_live/cmd_vel", qos)
                    if now - published >= .02:
                        stamp += .02
                        publisher.publish(String(data=json.dumps({"schema": "v2_live/state/1", "episode": 1,
                            "sim_t": stamp, "stop_requested": stopped, "reset_in_progress": False,
                            "policy_running": True, "vx": velocity[0], "vy": velocity[1]})))
                        published = now
            except BaseException as exc:
                self.error = exc
                self.ready.set()
            finally:
                if executor is not None:
                    executor.shutdown(timeout_sec=.2)
                if node is not None:
                    node.destroy_node()
                if context.ok():
                    context.shutdown()

        def close(self):
            self.closed.set()
            self.thread.join(timeout=2)
            assert not self.thread.is_alive() and self.error is None

    async def run():
        peer = Peer()
        bridge = RosNode(Config("00000000-0000-4000-8000-000000000001",
                               Settings("ws://127.0.0.1/api/v1/agent/ws", "synthetic-only")))
        client = None
        block = threading.Event()
        conflict_seen = False
        try:
            sink = await bridge.start(lambda raw: client.on_robot_state(raw) if client else None)
            session = Session()
            client = Client(session, sink, bridge.config.settings)
            client._emit(session.connect())
            client._emit(session.receive({"t": "lease", "lease_id": "L", "holder_type": "USER"}))

            async def until(predicate, timeout=2):
                deadline = time.monotonic() + timeout
                while not predicate():
                    assert time.monotonic() < deadline, "synthetic transition timed out"
                    client._emit(session.receive({"t": "ping"}))
                    await asyncio.sleep(.01)

            await until(lambda: session.core.st is not None and session.core.st["stop_requested"])
            client._emit(session.receive({"t": "unlock", "lease_id": "L", "stop_gen": session.core.stop_gen}))
            await until(lambda: session.core.resume_pending is None and not session.core.latch)
            assert len(peer.resumes) == 1
            # Core refuses nonzero before a new neutral, using actual ROS feedback.
            client._emit(session.receive({"t": "cmd", "lease_id": "L", "seq": 1, "axes": [1, 0, 1]}))
            assert session.core.out == (0, 0, 0)
            client._emit(session.receive({"t": "cmd", "lease_id": "L", "seq": 2, "axes": [0, 0, 0]}))
            client._emit(session.receive({"t": "cmd", "lease_id": "L", "seq": 3, "axes": [1, 0, 1]}))
            await until(lambda: peer.outputs and peer.outputs[-1][1] == (.6, 0, .5))
            assert session.core.out == (.6, 0, .5)

            # Exclude the ROS flush backup check in this phase, so ONLY the
            # independent thread can satisfy the deadline while asyncio stalls.
            original_watchdog = sink.check_watchdog
            def independent_only():
                if block.is_set() and threading.current_thread().name == "agent-rclpy":
                    return
                original_watchdog()
            sink.check_watchdog = independent_only
            client._emit(session.tick())
            block.set()
            last_apply = sink._last_apply
            started = time.monotonic()
            with peer.lock:
                assert peer.outputs[-1][1] == (.6, 0, .5)
            time.sleep(.42)  # owner blocked; peer observes the independent watchdog over DDS
            with peer.lock:
                zeros = [t for t, v in peer.outputs if t >= started and v == (0, 0, 0)]
                stops = [t for t in peer.stops if t >= started]
            # Removing/delaying only the independent watchdog MUST fail these.
            assert zeros and stops, "independent watchdog did not stop active motion"
            assert .28 <= zeros[0] - last_apply <= .38
            assert .28 <= stops[0] - last_apply <= .38
            print(f"watchdog DDS observations: zero={zeros[0]-last_apply:.4f}s STOP={stops[0]-last_apply:.4f}s")
            assert len(peer.resumes) == 1
            block.clear()
            await until(lambda: session.core.latch and session.core.st["stop_requested"])
            assert session.core.out == (0, 0, 0)
            # The same actual DDS graph must reject a second final cmd writer.
            peer.conflict.set()
            with pytest.raises(RuntimeError, match="ROS bridge failed"):
                await asyncio.wait_for(bridge.wait_failure(), timeout=2)
            assert "writer conflict" in str(bridge.error)
            conflict_seen = True
        finally:
            try:
                bridge.close()
            except RuntimeError:
                if not conflict_seen:
                    raise
            finally:
                peer.close()
    asyncio.run(run())

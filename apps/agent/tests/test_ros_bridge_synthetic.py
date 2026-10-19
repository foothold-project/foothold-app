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

import pytest

from foothold_agent.link.client import Settings
from foothold_agent.link.session import MotionCommand
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
    preflight()  # MUST precede every ROS import/init in this opt-in test
    import rclpy
    from rclpy.context import Context
    from rclpy.executors import SingleThreadedExecutor
    from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
    from geometry_msgs.msg import Twist
    from std_msgs.msg import Empty, String

    async def run():
        config = Config("00000000-0000-4000-8000-000000000001",
                        Settings("ws://127.0.0.1/api/v1/agent/ws", "synthetic-only"))
        bridge = RosNode(config)
        received, outputs, stops, resumes = [], [], [], []
        context = Context()
        node = executor = None
        try:
            sink = await bridge.start(received.append)
            rclpy.init(args=[], context=context, domain_id=93)
            node = rclpy.create_node("foothold_synthetic_peer", context=context, enable_rosout=False,
                                     start_parameter_services=False, use_global_arguments=False)
            qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                             durability=DurabilityPolicy.VOLATILE)
            publisher = node.create_publisher(String, "/v2_live/state", qos)
            node.create_subscription(Twist, "/v2_live/cmd_vel",
                lambda m: outputs.append((m.linear.x, m.linear.y, m.angular.z)), qos)
            node.create_subscription(Empty, "/v2_live/stop", lambda m: stops.append(True), qos)
            node.create_subscription(Empty, "/v2_live/resume", lambda m: resumes.append(True), qos)
            executor = SingleThreadedExecutor(context=context)
            executor.add_node(node)
            stamp = 0

            async def pump(duration, command=(0, 0, 0)):
                nonlocal stamp
                deadline = time.monotonic() + duration
                while time.monotonic() < deadline:
                    stamp += 0.02
                    publisher.publish(String(data=json.dumps({"schema": "v2_live/state/1", "episode": 1,
                        "sim_t": stamp, "stop_requested": True, "reset_in_progress": False,
                        "policy_running": True, "vx": 0.3, "vy": 0.4})))
                    sink.apply(MotionCommand(velocity=command))
                    executor.spin_once(timeout_sec=0)
                    await asyncio.sleep(0.01)

            await pump(2)
            assert received and outputs and stops and not resumes
            assert all(v == (0, 0, 0) for v in outputs)
            sink.apply(MotionCommand("unlock"))
            await pump(0.2)
            assert len(resumes) == 1
            await pump(0.25, (0.6, 0, 0.5))
            assert (0.6, 0.0, 0.5) in outputs
            sink.apply(MotionCommand("stop"))
            await pump(0.15)
            assert outputs[-1] == (0, 0, 0)
            prior_stops = len(stops)
            time.sleep(0.37)  # owning loop blocked; ROS + independent watchdog still run
            for _ in range(30):
                executor.spin_once(timeout_sec=0.005)
            assert len(stops) > prior_stops and outputs[-1] == (0, 0, 0)
            assert len(resumes) == 1
            assert bridge.inputs.telemetry.snapshot()["speed"] == 0.5
        finally:
            bridge.close()
            if executor is not None:
                executor.shutdown(timeout_sec=0.2)
            if node is not None:
                node.destroy_node()
            if context.ok():
                context.shutdown()
    asyncio.run(run())

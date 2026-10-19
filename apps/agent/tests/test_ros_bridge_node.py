"""Exercise real bridge threading/lifecycle against an in-process rclpy stub."""

import asyncio
import sys
import threading
import time
from types import SimpleNamespace

import pytest

from foothold_agent.link.client import Settings
from foothold_agent.ros_bridge.config import Config, DDS_OVERRIDES, REQUIRED_ENV
from foothold_agent.ros_bridge.node import RosNode


@pytest.fixture
def ros(monkeypatch):
    for key, value in REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    for key in DDS_OVERRIDES:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("RMW_IMPLEMENTATION", raising=False)
    trace = SimpleNamespace(events=[], subscriptions={}, qos=[], writers=1, fail=threading.Event(), init=None)

    class Context:
        alive = True
        def ok(self):
            return self.alive
        def shutdown(self):
            trace.events.append(("context_shutdown", threading.current_thread().name))
            self.alive = False

    class Twist:
        def __init__(self):
            self.linear = SimpleNamespace(x=0, y=0, z=0)
            self.angular = SimpleNamespace(x=0, y=0, z=0)

    class Node:
        def count_publishers(self, topic):
            return trace.writers
        def create_publisher(self, typ, topic, qos):
            trace.qos.append(qos)
            def publish(m):
                value = (m.linear.x, m.linear.y, m.angular.z) if typ is Twist else None
                trace.events.append((topic, threading.current_thread().name, value))
            def ack(duration):
                trace.events.append(("acked", threading.current_thread().name, topic))
                return True
            return SimpleNamespace(publish=publish, wait_for_all_acked=ack)
        def create_subscription(self, typ, topic, callback, qos):
            trace.subscriptions[topic] = callback
            trace.qos.append(qos)
        def destroy_node(self):
            trace.events.append(("destroy_node", threading.current_thread().name))

    class Executor:
        def __init__(self, **kwargs):
            pass
        def add_node(self, node):
            pass
        def spin_once(self, **kwargs):
            time.sleep(0.001)
            if trace.fail.is_set():
                raise RuntimeError("stub executor failure")
        def shutdown(self, **kwargs):
            trace.events.append(("executor_shutdown", threading.current_thread().name))

    def init(**kwargs):
        trace.init = kwargs
    def create_node(*args, **kwargs):
        trace.node_options = kwargs
        return Node()
    policy = SimpleNamespace(KEEP_LAST="KEEP_LAST", RELIABLE="RELIABLE", BEST_EFFORT="BEST_EFFORT", VOLATILE="VOLATILE")
    modules = {
        "rclpy": SimpleNamespace(init=init, create_node=create_node),
        "rclpy.context": SimpleNamespace(Context=Context),
        "rclpy.duration": SimpleNamespace(Duration=lambda **kw: kw),
        "rclpy.executors": SimpleNamespace(SingleThreadedExecutor=Executor),
        "rclpy.qos": SimpleNamespace(QoSProfile=lambda **kw: kw, HistoryPolicy=policy,
                                     ReliabilityPolicy=policy, DurabilityPolicy=policy),
        "geometry_msgs.msg": SimpleNamespace(Twist=Twist),
        "nav_msgs.msg": SimpleNamespace(Odometry=object),
        "std_msgs.msg": SimpleNamespace(Empty=object, String=object),
        "sensor_msgs": SimpleNamespace(msg=SimpleNamespace(Image=object, CompressedImage=object, PointCloud2=object)),
    }
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    return trace


def config():
    return Config("00000000-0000-4000-8000-000000000001",
                  Settings("ws://127.0.0.1/api/v1/agent/ws", "stub-only"))


def test_node_thread_qos_startup_stop_and_shutdown(ros):
    async def run():
        node = RosNode(config())
        sink = await node.start(lambda raw: None)
        assert ros.init["domain_id"] == 93 and ros.init["args"] == []
        assert ros.node_options["use_global_arguments"] is False
        from foothold_agent.ros_bridge.node import SENSOR_TOPICS
        assert set(ros.subscriptions) == {"/v2_live/state", "/v2_live/odom", "/v2_map/status", *SENSOR_TOPICS}
        assert all(q == {"depth": 1, "history": "KEEP_LAST", "reliability": "RELIABLE",
                         "durability": "VOLATILE"} for q in ros.qos[:6])
        assert all(q["reliability"] == "BEST_EFFORT" and q["depth"] == 1 for q in ros.qos[6:])
        assert [e[0] for e in ros.events[:2]] == ["/v2_live/cmd_vel", "/v2_live/stop"]
        assert all(e[1] in {"agent-rclpy", "ros-output-watchdog", "ros-sink-close"} for e in ros.events)
        assert not any(e[0] == "/v2_live/resume" for e in ros.events)
        node.close()
        assert not node._thread.is_alive() and not sink._watchdog.is_alive()
        assert ros.events[-1][0] == "context_shutdown"
        last_zero = max(i for i, e in enumerate(ros.events) if e[0] == "/v2_live/cmd_vel")
        destroy = next(i for i, e in enumerate(ros.events) if e[0] == "destroy_node")
        assert last_zero < destroy
        acks = [i for i, e in enumerate(ros.events) if e[0] == "acked"]
        assert len(acks) == 2 and all(last_zero < i < destroy for i in acks)
    asyncio.run(run())


def test_executor_error_zero_stop_visible_and_no_unlock(ros):
    async def run():
        node = RosNode(config())
        await node.start(lambda raw: None)
        ros.events.clear()
        ros.fail.set()
        with pytest.raises(RuntimeError, match="ROS bridge failed"):
            await asyncio.wait_for(node.wait_failure(), timeout=1)
        with pytest.raises(RuntimeError):
            node.close()
        assert any(e[0] == "/v2_live/cmd_vel" and e[2] == (0, 0, 0) for e in ros.events)
        assert any(e[0] == "/v2_live/stop" for e in ros.events)
        assert not any(e[0] == "/v2_live/resume" for e in ros.events)
    asyncio.run(run())


def test_start_revalidates_isolation_before_import_or_dds(ros, monkeypatch):
    monkeypatch.setenv("ROS_DOMAIN_ID", "61")
    async def run():
        node = RosNode(config())
        with pytest.raises(ValueError):
            await node.start(lambda raw: None)
        assert ros.init is None and not ros.events
        node.close()
    asyncio.run(run())


def test_missing_ros_fails_start_without_network(ros, monkeypatch):
    monkeypatch.setitem(sys.modules, "rclpy", None)
    async def run():
        node = RosNode(config())
        with pytest.raises(ModuleNotFoundError):
            await node.start(lambda raw: None)
        with pytest.raises(RuntimeError):
            node.close()
        assert ros.init is None
    asyncio.run(run())


def test_startup_writer_conflict_prevents_ready(ros):
    ros.writers = 2
    async def run():
        node = RosNode(config())
        with pytest.raises(RuntimeError, match="writer conflict"):
            await node.start(lambda raw: None)
        with pytest.raises(RuntimeError):
            node.close()
        assert not any(e[0] == "/v2_live/resume" for e in ros.events)
        assert any(e[0] == "/v2_live/stop" for e in ros.events)
    asyncio.run(run())


@pytest.mark.parametrize("first", ["owner", "ros"])
def test_close_completes_emergency_before_ack_and_destroy(ros, first):
    async def run():
        node = RosNode(config())
        sink = await node.start(lambda raw: None)
        started, release, waiting, complete = (threading.Event() for _ in range(4))
        errors = []
        original_emergency = sink._emergency
        def paused_emergency():
            first_thread = "ros-sink-close"
            if threading.current_thread().name == first_thread:
                started.set()
                assert release.wait(2)
            original_emergency()
        class Completion:
            def wait(self, timeout=None):
                waiting.set()
                return complete.wait(timeout)
            def set(self):
                complete.set()
        sink._close_complete = Completion()
        sink._emergency = paused_emergency
        ros.events.clear()
        def close():
            try:
                node.close()
            except BaseException as exc:
                errors.append(exc)
        owner = threading.Thread(target=close, name="owner-close")
        try:
            if first == "ros":
                node._closing.set()  # make ROS finally the first close caller
                assert started.wait(1)
                owner.start()
            else:
                owner.start()
                assert started.wait(1)
            assert waiting.wait(1), "second close did not wait for the first emergency"
            assert not any(e[0] in {"acked", "destroy_node"} for e in ros.events)
        finally:
            release.set()
            if owner.ident is not None:
                owner.join(timeout=2)
            else:
                node.close()
        assert not owner.is_alive() and not node._thread.is_alive() and not errors
        zero = max(i for i, e in enumerate(ros.events) if e[0] == "/v2_live/cmd_vel")
        stop = max(i for i, e in enumerate(ros.events) if e[0] == "/v2_live/stop")
        acks = [i for i, e in enumerate(ros.events) if e[0] == "acked"]
        destroy = next(i for i, e in enumerate(ros.events) if e[0] == "destroy_node")
        assert len(acks) == 2 and max(zero, stop) < min(acks) < destroy
    asyncio.run(run())


def test_incomplete_close_retains_publishers_without_ack_or_destroy(ros, monkeypatch):
    async def run():
        node = RosNode(config())
        sink = await node.start(lambda raw: None)
        original_close = sink.close
        def incomplete():
            raise RuntimeError('incomplete close for test')
        monkeypatch.setattr(sink, 'close', incomplete)
        ros.events.clear()
        try:
            node._closing.set()  # exercise the actual ROS finally branch
            with pytest.raises(RuntimeError, match='ROS bridge failed'):
                await asyncio.wait_for(node.wait_failure(), 3)
            node._thread.join(timeout=3)
            assert not node._thread.is_alive()
            assert not any(e[0] in {'acked', 'destroy_node', 'executor_shutdown', 'context_shutdown'}
                           for e in ros.events)
        finally:
            original_close()  # stop only the stub sink watchdog, never real ROS
    asyncio.run(run())

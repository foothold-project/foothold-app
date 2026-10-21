"""Exercise the optional same-node extension using the existing pure ROS stub."""
import asyncio
import threading
from types import SimpleNamespace

import pytest

from test_ros_bridge_node import ros  # unchanged in-process fixture; NO DDS
from foothold_agent.link.client import Settings
from foothold_agent.ros_bridge.config import Config
from foothold_agent.ros_bridge.node import RosNode


def test_nav_extension_uses_existing_bridge_ros_owner_and_single_motion_writer(ros):
    async def run():
        threads = []
        class Extension:
            def __init__(self, node):
                threads.append(threading.current_thread().name)
            def spin(self):
                threads.append(threading.current_thread().name)
        b = RosNode(Config('00000000-0000-0000-0000-000000000001',
                           Settings('ws://127.0.0.1:9170', 'fake-token')), extension_factory=Extension)
        try:
            await b.start(lambda _: None)
            assert isinstance(b.extension, Extension)
            assert len(threads) > 2 and set(threads) == {'agent-rclpy'}
            topics = {event[0] for event in ros.events}
            assert '/v2_live/cmd_vel' in topics and '/v2_live/stop' in topics
        finally:
            b.close()
    asyncio.run(run())


def test_extension_failure_enters_existing_emergency_stop_path(ros):
    async def run():
        class Extension:
            def __init__(self, node):
                pass
            def spin(self):
                raise RuntimeError('Nav extension failed')
        b = RosNode(Config('00000000-0000-0000-0000-000000000001',
                           Settings('ws://127.0.0.1:9170', 'fake-token')), extension_factory=Extension)
        with pytest.raises(RuntimeError, match='Nav extension failed'):
            await b.start(lambda _: None)
        with pytest.raises(RuntimeError):
            b.close()
        assert any(event[0] == '/v2_live/stop' for event in ros.events)
        assert any(event[0] == '/v2_live/cmd_vel' and event[2] == (0, 0, 0) for event in ros.events)
    asyncio.run(run())

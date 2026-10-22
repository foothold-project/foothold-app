"""Keep test configuration independent of the developer's ROS shell."""
import os
import pytest


@pytest.fixture(autouse=True)
def clean_ros_environment(monkeypatch):
    for name in tuple(os.environ):
        if name.startswith(('ROS_', 'RMW_', 'CYCLONEDDS_', 'FASTRTPS_', 'FASTDDS_')):
            monkeypatch.delenv(name)

"""Keep test configuration independent of the developer's ROS shell."""
import os
import pytest


@pytest.fixture(autouse=True)
def clean_ros_environment(monkeypatch):
    for name in tuple(os.environ):
        if name.startswith(('ROS_', 'RMW_', 'CYCLONEDDS_', 'FASTRTPS_', 'FASTDDS_')):
            monkeypatch.delenv(name)


@pytest.fixture(autouse=True)
def isolated_manager_startup(monkeypatch):
    # Runtime startup proof is exercised with dedicated doubles; never inspect
    # or touch the host's real ROS participants/user units during API tests.
    monkeypatch.setattr('apps.simmgr.api.startup_preflight',lambda: {'synthetic':True})

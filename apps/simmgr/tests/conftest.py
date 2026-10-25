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
    monkeypatch.setattr('apps.simmgr.api.startup_preflight',lambda *args: {'synthetic':True, 'resources_ok':True})
    # Dedicated gate tests advance a synthetic clock; lifecycle tests never
    # sample host resource pressure or wait a real minute.
    monkeypatch.setattr('apps.simmgr.launcher.wait_resource_gate', lambda *_: None)


@pytest.fixture
def synthetic_nav2(monkeypatch):
    """Only legacy synthetic supervisors use this; unit tests exercise real class."""
    class Nav2:
        def __init__(self, *args):
            self.code = None
        def start(self):
            pass
        def poll(self):
            return self.code
        def stop(self):
            self.code = 0
    monkeypatch.setattr('apps.simmgr.launcher.Nav2Unit', Nav2)
    return Nav2

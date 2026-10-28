"""Dedicated deployment declarations; no systemd, GPU or ROS calls."""
from pathlib import Path
import pytest
from apps.simmgr.environment import child_environment
from apps.simmgr.native_vendor import enable


def test_all_runtime_units_share_bounded_slice():
    for path in ('agent_unit.py', 'nav2_unit.py', 'observer_unit.py', 'native_simulation.py'):
        assert '--property=Slice=foothold-sim.slice' in (Path('apps/simmgr') / path).read_text()
    assert '--property=Slice=foothold-sim.slice' in Path('apps/agent/tools/sim/isolation.py').read_text()
    unit = Path('deploy/foothold-sim.slice').read_text()
    for value in ('MemoryMax=4G','MemorySwapMax=0','CPUQuota=400%','TasksMax=640'):
        assert value in unit


def test_vendor_only_allowlisted_for_child(monkeypatch):
    with pytest.raises(ValueError):
        child_environment(93, {'FH_SIM_NATIVE_PYTHON_DIR':'/tmp/untrusted'})
    monkeypatch.delenv('FH_SIM_NATIVE_PYTHON_DIR', raising=False)
    assert enable() is None
    monkeypatch.setenv('FH_SIM_NATIVE_PYTHON_DIR','/tmp/untrusted')
    with pytest.raises(ValueError):
        enable()
    child = child_environment(93, {'FH_SIM_NATIVE_PYTHON_DIR':'/opt/foothold-sim/python-vendor','FH_DATABASE_URL':'secret'})
    assert child['FH_SIM_NATIVE_PYTHON_DIR'] == '/opt/foothold-sim/python-vendor'
    assert 'FH_DATABASE_URL' not in child


def test_vendor_requires_root_immutable_directories_and_exact_metadata(monkeypatch):
    import stat
    import sys
    from types import SimpleNamespace
    from apps.simmgr import native_vendor
    monkeypatch.setenv('FH_SIM_NATIVE_PYTHON_DIR', str(native_vendor.VENDOR))
    monkeypatch.setattr(sys, 'path', list(sys.path))
    monkeypatch.delitem(sys.modules, 'trimesh', raising=False)
    def trusted(path):
        mode = stat.S_IFREG | 0o644 if path.name == 'METADATA' else stat.S_IFDIR | 0o755
        return SimpleNamespace(st_uid=0, st_mode=mode)
    monkeypatch.setattr(Path, 'lstat', trusted)
    monkeypatch.setattr(Path, 'read_text', lambda *_: 'Name: trimesh\nVersion: 5.1.0\n')
    monkeypatch.setattr(native_vendor.importlib.util, 'find_spec', lambda *_:
        SimpleNamespace(origin=str(native_vendor.VENDOR / 'trimesh/__init__.py')))
    enable()
    assert sys.path[0] == str(native_vendor.VENDOR)
    for bad in (SimpleNamespace(st_uid=1,st_mode=stat.S_IFDIR|0o755),
                SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o777),
                SimpleNamespace(st_uid=0,st_mode=stat.S_IFLNK|0o777)):
        monkeypatch.setattr(Path, 'lstat', lambda _, bad=bad: bad)
        with pytest.raises(ValueError):
            enable()
    monkeypatch.setattr(Path, 'lstat', trusted)
    monkeypatch.setattr(Path, 'read_text', lambda *_: 'Name: trimesh\nVersion: 5.2.0\n')
    with pytest.raises(ValueError):
        enable()

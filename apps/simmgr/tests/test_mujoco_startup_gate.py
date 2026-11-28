"""MuJoCo local only: the startup load gate scales with the core count (load1 <= nproc).

Memory (>= 2500 MiB, isolation.preflight) and the Gazebo/native values (startup load1 <= 9,
launch gate 3000 MiB / load1 <= 7 / 60 s) are unchanged. demo-day 11/28, app-lx (1).
"""
import json
from types import SimpleNamespace

import pytest

from apps.simmgr import preflight


def startup(monkeypatch, load1, mem=190000, **kw):
    monkeypatch.delenv('FH_SIM_LOCAL_BACKEND', raising=False)
    def checker(folder):
        (folder / 'preflight.json').write_text(json.dumps(
            {'mem_available_mib': mem, 'load1': load1, 'domain93': [], 'dds_ports': []}))
        if mem < 2500 or load1 > 9:
            raise RuntimeError('preflight resource gate failed; no launch')
        return {'mem_available_mib': mem, 'load1': load1}
    monkeypatch.setattr(preflight, 'isolation_preflight', checker)
    monkeypatch.setattr(preflight.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout=''))
    monkeypatch.setattr(preflight.os, 'cpu_count', lambda: 64)
    return preflight.startup_preflight(False, **kw)['resources_ok']


def test_mujoco_load_23_on_64_cores_passes(monkeypatch):
    assert startup(monkeypatch, 23, mujoco=True) is True


def test_mujoco_load_70_on_64_cores_refused(monkeypatch):
    assert startup(monkeypatch, 70, mujoco=True) is False


def test_mujoco_low_memory_still_refused(monkeypatch):
    assert startup(monkeypatch, 1, mem=2000, mujoco=True) is False


def test_gazebo_startup_values_unchanged(monkeypatch):
    assert startup(monkeypatch, 8) is True     # startup gate stays load1 <= 9
    assert startup(monkeypatch, 10) is False
    assert startup(monkeypatch, 23) is False   # no core scaling without MuJoCo


def test_gazebo_launch_gate_load_8_refused(monkeypatch, tmp_path):
    import sys
    fake = SimpleNamespace(resources=lambda: {'mem_available_mib': 190000, 'load1': 8})
    monkeypatch.setitem(sys.modules, 'isolation', fake)
    with pytest.raises(preflight.ResourceGateError):
        preflight.wait_resource_gate(tmp_path)


def test_backend_read_from_simmgr_env(monkeypatch):
    def run(value):
        monkeypatch.setattr(preflight, 'isolation_preflight', lambda folder: (folder / 'preflight.json').write_text(
            json.dumps({'mem_available_mib': 190000, 'load1': 23, 'domain93': [], 'dds_ports': []})) and
            (_ for _ in ()).throw(RuntimeError('preflight resource gate failed; no launch')))
        monkeypatch.setattr(preflight.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout=''))
        monkeypatch.setattr(preflight.os, 'cpu_count', lambda: 64)
        monkeypatch.setenv('FH_SIM_LOCAL_BACKEND', value)
        return preflight.startup_preflight(False)['resources_ok']
    assert run('mujoco') is True
    assert run('') is False

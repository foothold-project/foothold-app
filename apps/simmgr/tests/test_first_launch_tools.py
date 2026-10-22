"""ROS-free checks for the trial bootstrap and measured-sample validity."""
import importlib.util
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest

TOOLS = Path(__file__).resolve().parents[1] / 'tools'


def load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize('setup,expected', [(': "$UNSET_ROS_OPTION"\n', 0), ('false\n', 1)])
def test_source_optional_vars_allowed_but_failure_blocks_observer(tmp_path, setup, expected):
    launch = load('first_launch')
    source = tmp_path / 'setup.bash'
    source.write_text(setup)
    observer = tmp_path / 'observer.py'
    marker = tmp_path / 'ready'
    observer.write_text('import pathlib,sys; pathlib.Path(sys.argv[1]).touch()')
    result = subprocess.run(['/bin/bash', '-c', launch.OBSERVER_SHELL, 'trial',
        str(source), str(observer), str(marker)], env={'PATH': '/usr/bin:/bin'})
    assert result.returncode == expected
    assert marker.exists() == (expected == 0)


def test_zero_without_applied_motion_is_not_a_deadman_pass(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(TOOLS))
    measure = load('first_launch_measure')
    phone = SimpleNamespace(sent={1: 10.}, acks={1: {'applied': [0., 0., 0.]}})
    monkeypatch.setattr(measure, 'publications', lambda _: [
        {'kind': 'received', 'seq': 1, 'mono': 10.01},
        {'kind': 'published', 'mono': 10.05, 'velocity': [0., 0., 0.]}])
    assert measure.gap_sample(phone, tmp_path, [1])['pass'] is False
    phone.acks[1]['applied'] = [.6, 0., 0.]
    sample = measure.gap_sample(phone, tmp_path, [1])
    assert sample['pass'] is True
    assert sample['receive_to_zero_s'] == pytest.approx(.04)


def test_latency_distinguishes_latest_only_coalescing_from_loss(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(TOOLS))
    measure = load('first_launch_measure')
    phone = SimpleNamespace(sent={1: 10., 2: 10.05},
        acks={1: {'applied': [.6, 0., 0.]}, 2: {'applied': [.6, 0., 0.]}})
    rows = [{'kind': 'received', 'seq': 1, 'mono': 10.001, 'applied': [.6, 0., 0.]},
            {'kind': 'received', 'seq': 2, 'mono': 10.051, 'applied': [.6, 0., 0.]},
            {'kind': 'published', 'seq': 2, 'mono': 10.055, 'velocity': [.6, 0., 0.]}]
    monkeypatch.setattr(measure, 'publications', lambda _: rows)
    result = measure.latency(phone, tmp_path, [1, 2])
    assert result['coalesced'] == [1] and result['genuine_missing'] == []
    assert result['max_consecutive_missing'] == 1
    rows.pop(1)  # no newer admitted command before the flush: don't excuse it
    result = measure.latency(phone, tmp_path, [1, 2])
    assert result['coalesced'] == [] and result['genuine_missing'] == [1]

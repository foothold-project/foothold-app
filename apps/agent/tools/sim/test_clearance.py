from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from clearance import covered, prove
from motion import exercise
from types import SimpleNamespace
import json
import pytest


def test_exact_support_union_rejects_even_a_small_gap():
    assert covered((0, 4, -1, 1), [(0, 4, -1, 0), (0, 4, 0, 1)])
    assert not covered((0, 4, -1, 1), [(0, 4, -1, 0), (0, 4, .001, 1)])
    assert not covered((0, 4, -1, 1), [(0, 1.9, -1, 1), (2, 4, -1, 1)])


def test_clearance_uses_actual_heading_and_body_envelope(tmp_path):
    world = tmp_path / 'world.sdf'
    floor = '<collision name="floor"><pose>0 0 -0.5 0 0 0</pose><geometry><box><size>20 20 1</size></box></geometry></collision>'
    obstacle = '<collision name="wall"><pose>3.3 0 .5 0 0 0</pose><geometry><box><size>.2 1 1</size></box></geometry></collision>'
    world.write_text('<sdf><world><model name="v5_single"><link>'+floor+obstacle+'</link></model></world></sdf>')
    assert not prove(world, dict(x=0, y=0, yaw=0))['pass']
    assert prove(world, dict(x=0, y=0, yaw=3.14159265359))['pass']


def test_motion_requires_explicit_opt_in(monkeypatch):
    monkeypatch.delenv('FH_SIM_D1_MOTION', raising=False)
    assert exercise(None, None, None, None, None).startswith('skipped:')


def test_wrong_gt_world_rejected_before_ros_or_network(tmp_path, monkeypatch):
    source = tmp_path / 'sensor-spec-20261016/stage/sensor-runtime-r1'
    source.mkdir(parents=True)
    map_root = tmp_path / 'map-20261014'
    map_root.mkdir()
    (map_root / 'worlds.json').write_text(json.dumps({'worlds': {'v5_single/f1': {
        'world_id': 'v5_single', 'floor_id': 'f1', 'world': 'actual.sdf'}}}))
    monkeypatch.setenv('FH_SIM_D1_MOTION', '1')
    monkeypatch.setenv('SIM_WORLD_SDF', str(tmp_path / 'wrong.sdf'))
    with pytest.raises(RuntimeError, match='GT world must match'):
        exercise(None, None, None, None, SimpleNamespace(source=source))

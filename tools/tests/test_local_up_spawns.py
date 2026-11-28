"""local_up FH_SIM_SPAWNS -> simmgr 카탈로그 slot spawns (app-lx 11/28 15:18 · 15:20).

파일 꼴: {world_id: {robot_id: {spawn_xyyaw: [x, y, yaw], name: 참고}}}. 이번 기동 세계 값만 slot 에 {world_id: xyyaw}.
모르는 robot_id 는 경고하고 건너뜀 (기동을 막지 않음), 꼴이 틀린 값은 기동 전 거절.
"""
import json
import sys
from pathlib import Path
from uuid import uuid4

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools import local_up  # noqa: E402

A, B = str(uuid4()), str(uuid4())


def write(tmp_path, value):
    path = tmp_path / 'spawns.json'
    path.write_text(json.dumps(value))
    return str(path)


def test_no_file_keeps_old_slots():
    assert local_up.slot_spawns(None, [A, B], ['factory_site/f1']) == {}


def test_only_this_launch_world_values_reach_slots(tmp_path):
    path = write(tmp_path, {'note': '참고', 'factory_site/f1': {A: {'spawn_xyyaw': [1.0, -2.0, 0.5], 'name': 'K-01'}},
                            'plant_a/l1': {B: {'spawn_xyyaw': [3.0, 4.0, 0.0]}}})
    assert local_up.slot_spawns(path, [A, B], ['factory_site/f1']) == {A: {'factory_site/f1': [1.0, -2.0, 0.5]}}
    assert local_up.slot_spawns(path, [A, B], ['plant_a/l1', 'plant_a/l2']) == {B: {'plant_a/l1': [3.0, 4.0, 0.0]}}


def test_unknown_robot_is_skipped_with_a_warning(tmp_path, capsys):
    path = write(tmp_path, {'factory_site/f1': {str(uuid4()): {'spawn_xyyaw': [1.0, 1.0, 0.0], 'name': 'K-09'},
                                                A: {'spawn_xyyaw': [1.0, 1.0, 0.0]}}})
    assert local_up.slot_spawns(path, [A], ['factory_site/f1']) == {A: {'factory_site/f1': [1.0, 1.0, 0.0]}}
    assert 'K-09' in capsys.readouterr().err


@pytest.mark.parametrize('bad', [[1.0, 2.0], [1.0, 'x', 0.0], [1.0, float('inf'), 0.0], 'a', None])
def test_malformed_value_is_refused_before_start(tmp_path, bad):
    path = write(tmp_path, {'factory_site/f1': {A: {'spawn_xyyaw': bad}}}).replace('Infinity', '1e999')
    with pytest.raises(SystemExit):
        local_up.slot_spawns(path, [A], ['factory_site/f1'])


def test_unreadable_file_is_refused(tmp_path):
    (tmp_path / 'bad.json').write_text('{')
    with pytest.raises(SystemExit):
        local_up.slot_spawns(str(tmp_path / 'bad.json'), [A], ['factory_site/f1'])
    with pytest.raises(SystemExit):
        local_up.slot_spawns(str(tmp_path / 'missing.json'), [A], ['factory_site/f1'])


def test_catalog_slots_carry_spawns_only_when_given(tmp_path, monkeypatch):
    slots = local_up.catalog_slots('org', [A, B], {A: {'factory_site/f1': [1.0, 1.0, 0.0]}})
    assert slots[0]['spawns'] == {'factory_site/f1': [1.0, 1.0, 0.0]} and 'spawns' not in slots[1]
    assert [s['port'] for s in slots] == [9449, 9448]

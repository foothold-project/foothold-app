"""공정동 A(plant_a): 배치 JSON -> SDF 재현 · 2층 계단 구멍 · 지점 free 셀. ROS·서버 없음."""
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

from apps.simmgr.tools.import_building import build, slab_rectangles

WORLDS = Path(__file__).resolve().parents[2] / 'worlds'
OUT = WORLDS / 'plant_a'
LAYOUT = json.loads((OUT / 'layout.json').read_text())
META = json.loads((OUT / 'maps/metadata.json').read_text())
FREE = 254


def cell(floor_id, x, y):
    pixels = np.array(Image.open(OUT / 'maps' / f'{floor_id}.png'))
    res = META['resolution']
    ox, oy, _ = META['origin']
    height = pixels.shape[0]
    return pixels[height - 1 - math.floor((y - oy) / res), math.floor((x - ox) / res)]


def test_sdf_regenerates_byte_identical_from_layout_copy(tmp_path):
    assert hashlib.sha256((OUT / 'layout.json').read_bytes()).hexdigest() == \
        json.loads((OUT / 'sources.json').read_text())['inputs']['plant_a.json']
    build(OUT / 'layout.json', tmp_path)
    assert (tmp_path / 'plant_a.sdf').read_bytes() == (OUT / 'plant_a.sdf').read_bytes()


def test_slab_rectangles_cover_poly_minus_l_shaped_hole_exactly():
    poly = [[0, 0], [36, 0], [36, 20], [0, 20]]
    hole = [[2.2, 11.5], [3.6, 11.5], [3.6, 16.8], [0.6, 16.8], [0.6, 15.4], [2.2, 15.4]]
    rects = slab_rectangles(poly, [hole])
    area = 36 * 20 - (1.4 * 3.9 + 3.0 * 1.4)
    assert sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in rects) == pytest.approx(area)
    assert not any(x0 < 3 < x1 and y0 < 13 < y1 for x0, y0, x1, y1 in rects)
    assert any(x0 < 1.3 < x1 and y0 < 13 < y1 for x0, y0, x1, y1 in rects)


def region(floor_id, x0, y0, x1, y1):
    pixels = np.array(Image.open(OUT / 'maps' / f'{floor_id}.png'))
    res = META['resolution']
    ox, oy, _ = META['origin']
    height = pixels.shape[0]
    return pixels[height - math.floor((y1 - oy) / res):height - math.ceil((y0 - oy) / res),
                  math.ceil((x0 - ox) / res):math.floor((x1 - ox) / res)]


def test_l2_stair_hole_is_not_free_floor():
    # L 자 구멍: 둘째 줄 자리(x 2.2~3.6, y 11.5~15.4)와 중간 계단참 위(x 0.6~3.6, y 15.4~16.8).
    # 아래층 계단 마지막 단(y 11.5~11.8, 윗면 = l2 바닥)은 l2 바닥과 이어지는 free 라 뺀다.
    lane = region('l2', 2.2, 11.85, 3.6, 15.4)
    top = region('l2', 0.6, 15.4, 3.6, 16.8)
    assert lane.size > 1500 and top.size > 1500
    assert not (lane == FREE).any() and not (top == FREE).any()
    # 같은 자리 1층은 바닥판이 있고 높은 둘째 줄 밑이라 free(구멍이 l2 에만 있음을 대조).
    assert cell('l1', 3.0, 13.0) == FREE and cell('l2', 3.0, 13.0) != FREE


def test_stairs_start_on_floor_arrive_on_upper_floor_and_rise_equals_storey():
    floors = {f['floor_id']: f for f in LAYOUT['floors']}
    stairs = [s for f in LAYOUT['floors'] for s in f['stairs']]
    assert [s['id'] for s in stairs] == ['st-1-2', 'st-2-3']
    for stair in stairs:
        rise = sum(stair['flights']) * stair['step_h']
        assert rise == pytest.approx(floors[stair['to']]['floor_z'] - floors[stair['from']]['floor_z'])
        # start 는 첫 단 앞 모서리(그 칸은 첫 단이 차지). 한 디딤 앞 바닥이 free 인지 본다.
        x, y = stair['start']
        yaw = stair['yaw']
        assert cell(stair['from'], x - stair['tread'] * math.cos(yaw),
                    y - stair['tread'] * math.sin(yaw)) == FREE, stair['id']
        assert stair['arrive']['floor_id'] == stair['to']
        assert cell(stair['to'], *stair['arrive']['xy']) == FREE, stair['id']


def test_every_layout_point_and_spawn_is_free_on_its_floor():
    catalogue = json.loads((WORLDS / 'worlds.json').read_text())['worlds']
    for floor in LAYOUT['floors']:
        fid = floor['floor_id']
        assert floor['points']
        for point in floor['points']:
            assert cell(fid, *point['xy']) == FREE, (fid, point['id'])
        entry = catalogue[f'plant_a/{fid}']
        assert entry['floor_z'] == floor['floor_z'] == META['floors'][fid]['floor_z']
        assert cell(fid, *entry['spawn_xyyaw'][:2]) == FREE, fid

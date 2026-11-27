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


def test_slab_rectangles_cover_poly_minus_hole_exactly():
    poly = [[0, 0], [36, 0], [36, 20], [0, 20]]
    hole = [[0.6, 11.2], [3.6, 11.2], [3.6, 16.7], [0.6, 16.7]]
    rects = slab_rectangles(poly, [hole])
    assert sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in rects) == \
        pytest.approx(36 * 20 - 3 * 5.5)
    assert not any(x0 < 2 < x1 and y0 < 14 < y1 for x0, y0, x1, y1 in rects)


def test_l2_stair_hole_is_not_free_floor():
    # 구멍 0.6~3.6 × 11.2~16.7 중 아래층 계단 마지막 단·도착 계단참(y >= 15.0, 윗면 = l2 바닥)을 뺀 곳.
    pixels = np.array(Image.open(OUT / 'maps/l2.png'))
    res = META['resolution']
    ox, oy, _ = META['origin']
    height = pixels.shape[0]
    cols = slice(math.ceil((0.6 - ox) / res), math.floor((3.6 - ox) / res))
    rows = slice(height - math.floor((14.95 - oy) / res), height - math.ceil((11.2 - oy) / res))
    hole = pixels[rows, cols]
    assert hole.size > 2000 and not (hole == FREE).any()
    # 같은 자리 1층은 바닥판이 있어 계단 밖 남쪽 띠가 free 다(구멍이 l2 에만 있음을 대조).
    assert cell('l1', 3.0, 11.6) == FREE and cell('l2', 3.0, 11.6) != FREE


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

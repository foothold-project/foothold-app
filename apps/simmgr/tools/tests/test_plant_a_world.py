"""공정동 A(plant_a): 배치 JSON -> SDF 재현 · 2층 계단 구멍 · 지점 free 셀. ROS·서버 없음."""
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
import pytest
import xml.etree.ElementTree as ET

from apps.simmgr.tools.import_building import build, direction, slab_rectangles

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
    # 같은 자리 1층은 바닥판 위 통짜 단(occupied), 2층은 구멍이라 지지면 없음(unknown).
    assert cell('l1', 3.0, 13.0) == 0 and cell('l2', 3.0, 13.0) == 205


def boxes(sdf):
    """SDF link 이름 -> (가운데 xyz, 크기 xyz). 모든 상자는 yaw 0 으로 쓰인다."""
    result = {}
    for link in ET.parse(sdf).getroot().iter('link'):
        pose = [float(v) for v in link.findtext('pose').split()]
        assert pose[3:] == [0, 0, 0], link.get('name')
        size = [float(v) for v in link.findtext('collision/geometry/box/size').split()]
        result[link.get('name')] = (pose[:3], size)
    return result


def first_step_on_slab(layout, sdf):
    """각 계단 첫 단 발자국(JSON start · yaw · tread · width) 밑이 그 층 바닥판 상자로 다 덮이는지."""
    found = boxes(sdf)
    floors = {f['floor_id']: f for f in layout['floors']}
    result = {}
    for stair in [s for f in layout['floors'] for s in f['stairs']]:
        z0 = floors[stair['from']]['floor_z']
        slabs = [(c, d) for name, (c, d) in found.items()
                 if name.startswith(stair['from'] + '_slab_') and abs(c[2] + d[2] / 2 - z0) < 1e-6]
        fx, fy = direction(stair['yaw'])
        sx, sy = stair['start']
        covered = True
        for a in np.linspace(0.01, stair['tread'] - 0.01, 7):
            for b in np.linspace(-stair['width'] / 2 + 0.01, stair['width'] / 2 - 0.01, 15):
                x, y = sx + fx * a + fy * b, sy + fy * a - fx * b
                covered &= any(abs(x - c[0]) <= d[0] / 2 and abs(y - c[1]) <= d[1] / 2 for c, d in slabs)
        result[stair['id']] = covered
    return result


def test_first_step_footprint_sits_on_a_filled_slab():
    assert first_step_on_slab(LAYOUT, OUT / 'plant_a.sdf') == {'st-1-2': True, 'st-2-3': True}


def test_first_step_check_fails_when_l2_hole_reaches_south_to_11(tmp_path):
    # 변이: l2 구멍 남쪽 끝을 계단실 폭 전체에서 y 11.0 까지 늘리면 st-2-3 첫 단 밑이 빈다.
    layout = json.loads(json.dumps(LAYOUT))
    layout['floors'][1]['slab']['holes'] = [{'id': 'mut', 'poly': [[0.6, 11.0], [3.6, 11.0], [3.6, 16.8], [0.6, 16.8]]}]
    (tmp_path / 'layout.json').write_text(json.dumps(layout))
    build(tmp_path / 'layout.json', tmp_path)
    assert first_step_on_slab(layout, tmp_path / 'plant_a.sdf') == {'st-1-2': True, 'st-2-3': False}


def test_last_step_top_in_sdf_equals_upper_floor_z():
    found = boxes(OUT / 'plant_a.sdf')
    floors = {f['floor_id']: f for f in LAYOUT['floors']}
    stairs = [s for f in LAYOUT['floors'] for s in f['stairs']]
    assert [s['id'] for s in stairs] == ['st-1-2', 'st-2-3']
    for stair in stairs:
        k = len(stair['flights']) - 1
        centre, size = found[f'{stair["id"]}_f{k}_s{stair["flights"][k] - 1}']
        assert centre[2] + size[2] / 2 == pytest.approx(floors[stair['to']]['floor_z'], abs=1e-6)
        assert f'{stair["id"]}_f{k}_s{stair["flights"][k]}' not in found
        assert f'{stair["id"]}_land{k}' not in found  # 마지막 줄 뒤 계단참 없음


def test_floor_before_first_step_and_arrival_are_free():
    for stair in [s for f in LAYOUT['floors'] for s in f['stairs']]:
        # start 는 첫 단 앞 모서리(그 칸은 첫 단이 차지). 한 디딤 앞 바닥이 free 인지 본다.
        x, y = stair['start']
        fx, fy = direction(stair['yaw'])
        assert cell(stair['from'], x - stair['tread'] * fx, y - stair['tread'] * fy) == FREE, stair['id']
        assert stair['arrive']['floor_id'] == stair['to']
        assert cell(stair['to'], *stair['arrive']['xy']) == FREE, stair['id']


def test_space_under_stairs_is_not_free():
    # 두 줄(x 0.6~2.0 · 2.2~3.6)의 단 밑 y 12.7~15.4. 1층은 통짜 단, 2층은 첫째 줄 통짜 · 둘째 줄 구멍.
    for floor_id in ('l1', 'l2'):
        for x0, x1 in ((0.6, 2.0), (2.2, 3.6)):
            under = region(floor_id, x0, 12.7, x1, 15.4)
            assert under.size > 1000 and not (under == FREE).any(), (floor_id, x0)


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


def test_stair_mid_wall_blocks_between_lanes():
    found = boxes(OUT / 'plant_a.sdf')
    for floor in LAYOUT['floors'][:2]:
        fid = floor['floor_id']
        (wall,) = [w for w in floor['walls'] if w.get('note') == 'stair_mid']
        centre, size = found[f'{wall["id"]}_0']
        assert centre[2] + size[2] / 2 == pytest.approx(floor['floor_z'] + wall['h'])
        between = region(fid, 2.0, 11.2, 2.2, 15.4)
        assert between.size >= 80 and not (between == FREE).any(), fid


def test_l3_cover_plate_is_in_sdf():
    found = boxes(OUT / 'plant_a.sdf')
    l3 = LAYOUT['floors'][2]
    (cover,) = l3['covers']
    plates = [v for k, v in found.items() if k.startswith(f'l3_cover_{cover["id"]}_')]
    assert sum(d[0] * d[1] for _, d in plates) == pytest.approx(6 * 10)
    for centre, size in plates:
        assert centre[2] - size[2] / 2 == pytest.approx(l3['floor_z'] + cover['z'])
        assert size[2] == pytest.approx(cover['t'])

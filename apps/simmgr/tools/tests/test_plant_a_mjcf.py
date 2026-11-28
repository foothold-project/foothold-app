"""공정동 A(plant_a) 앱 시뮬 MJCF: SDF 와 같은 상자 목록 · 재현 · MuJoCo 컴파일 · 등록. ROS·서버 없음."""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
import pytest
import xml.etree.ElementTree as ET

from apps.simmgr.tools import import_building

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'apps/simmgr/worlds/plant_a'
SIM = ROOT / 'mobile/sim'
TARGET = SIM / 'assets/plant-a'
LAYOUT = json.loads((OUT / 'layout.json').read_text())
CATALOGUE = json.loads((ROOT / 'apps/simmgr/worlds/worlds.json').read_text())['worlds']
FLOORS = [f['floor_id'] for f in LAYOUT['floors']]
GENERATED = ['plant-a.xml', 'scene.json', 'map.json', 'scenarios.json', 'metadata.json',
             *[f'{kind}-{fid}.json' for fid in FLOORS for kind in ('map', 'scene', 'scenarios')]]


def read(name):
    return json.loads((TARGET / name).read_text())


def test_mobile_assets_regenerate_byte_identical(tmp_path):
    for run in ('a', 'b'):
        import_building.mobile_assets(OUT / 'layout.json', OUT, tmp_path / run)
    for name in GENERATED:
        assert (tmp_path / 'a' / name).read_bytes() == (tmp_path / 'b' / name).read_bytes(), name
        assert (tmp_path / 'a' / name).read_bytes() == (TARGET / name).read_bytes(), name
    # make-top.mjs 가 bounds · px · map 을 채우고 floors 는 그대로 둔다.
    assert json.loads((tmp_path / 'a/top.json').read_text())['floors'] == read('top.json')['floors']


def sdf_boxes():
    """SDF link 이름 -> (모양, pose, MJCF 꼴 반크기)."""
    result = {}
    for link in ET.parse(OUT / 'plant_a.sdf').getroot().iter('link'):
        pose = [float(v) for v in link.findtext('pose').split()]
        shape = link.find('collision/geometry')[0]
        if shape.tag == 'box':
            half = [float(v) / 2 for v in shape.findtext('size').split()]
        else:
            half = [float(shape.findtext('radius')), float(shape.findtext('length')) / 2]
        result[link.get('name')] = (shape.tag, pose, half)
    return result


def test_every_mjcf_geom_is_the_sdf_collision_shape():
    sdf = sdf_boxes()
    geoms = list(ET.parse(TARGET / 'plant-a.xml').getroot().find('worldbody'))
    assert len(geoms) == len(sdf) == sum(1 for _ in ET.parse(OUT / 'plant_a.sdf').getroot().iter('collision'))
    assert {g.get('name') for g in geoms} == set(sdf)
    # 배치 rev 6~7b: 탱크 둘은 원기둥, 밸브 둘은 원기둥 셋(몸통 · 보닛 · z0 1.3 핸들) + 가로관 상자,
    # 선반 · 배관대는 기둥 + 띄운 덩어리.
    assert sorted(n for n, (shape, _, _) in sdf.items() if shape == 'cylinder') == [
        'l1_T-1_c0', 'l1_T-2_c0', *[f'l3_V-30{k}_c{j}' for k in (1, 2) for j in (0, 2, 3)]]
    assert sdf['l3_V-301_c3'][1][2] == pytest.approx(6.75 + 1.3 + 0.05)  # 핸들 z0 1.3 · h 0.1
    assert sum(n.startswith(('l2_l2-rack-', 'l1_l1-pipe-p_')) for n in sdf) == 29 * 2 + 7
    for g in geoms:
        shape, pose, half = sdf[g.get('name')]
        assert g.tag == 'geom' and g.get('type') == shape and g.get('group') == '1'
        assert [float(v) for v in g.get('size').split()] == pytest.approx(half, abs=1e-6)
        assert [float(v) for v in g.get('pos').split()] == pytest.approx(pose[:3], abs=1e-6)
        yaw = pose[5]
        assert [float(v) for v in g.get('quat').split()] == pytest.approx(
            [math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)], abs=1e-6)


def test_mujoco_compiles_and_spawn_floor_ray_hits_floor_z():
    mujoco = pytest.importorskip('mujoco')
    model = mujoco.MjModel.from_xml_path(str(TARGET / 'plant-a.xml'))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    assert model.ngeom == len(sdf_boxes())
    geomid = np.zeros(1, dtype=np.int32)
    for fid in FLOORS:
        entry = CATALOGUE[f'plant_a/{fid}']
        x, y, _ = entry['spawn_xyyaw']
        start = entry['floor_z'] + 1.0
        distance = mujoco.mj_ray(model, data, np.array([x, y, start]), np.array([0, 0, -1.0]),
                                 None, 1, -1, geomid)
        assert distance > 0, fid
        assert start - distance == pytest.approx(entry['floor_z'], abs=1e-6), fid
        assert model.geom(geomid[0]).name.startswith(f'{fid}_'), (fid, model.geom(geomid[0]).name)


def test_registry_and_floor_metadata_match_worlds_json():
    maps = json.loads((SIM / 'maps.json').read_text())
    assert [m for m in maps if m['id'] == 'plant-a'] == [{'id': 'plant-a', 'name': '공정동 A · 초안'}]
    assert maps[0]['id'] == 'warehouse'
    floors = read('top.json')['floors']
    assert [f['id'] for f in floors] == FLOORS
    for i, f in enumerate(floors):
        entry = CATALOGUE[f'plant_a/{f["id"]}']
        mapping = read(f['map_file'])
        assert f['floor_z'] == mapping['floor_z'] == entry['floor_z']
        assert f['spawn_xyyaw'] == mapping['spawn_xyyaw'] == entry['spawn_xyyaw']
        assert mapping['spawn_z'] == entry['spawn_z'] and mapping['floor_id'] == f['id']
        assert f['z'][0] <= entry['floor_z'] < f['z'][1]
        if i:
            assert f['z'][0] == floors[i - 1]['z'][1]  # 띠가 빈틈 없이 이어진다
        assert all(s['floor_id'] == f['id'] for s in read(f['scenarios_file']))
    assert read('map.json') == read('map-l1.json')
    assert read('scenarios.json') == read('scenarios-l1.json')


def test_mobile_map_pixels_are_the_server_map():
    for fid in FLOORS:
        mapping = read(f'map-{fid}.json')
        import base64
        pixels = np.frombuffer(base64.b64decode(mapping['px']), dtype=np.uint8)
        assert (pixels == np.array(Image.open(OUT / 'maps' / f'{fid}.png')).flatten()).all(), fid


def test_every_route_leg_keeps_its_square_clear():
    # mobile/scripts/scenario-selftest.mjs 와 같은 검사 (곧은 다리 · 몸 둘레 사각). 기본(1층) 은 0.35 m,
    # 다른 층은 적힌 clearance_m (0.25 이상: l2 BAT-2 와 벽 사이 0.8 m 통로).
    for fid in FLOORS:
        mapping = read(f'map-{fid}.json')
        import base64
        px = np.frombuffer(base64.b64decode(mapping['px']), dtype=np.uint8).reshape(mapping['h'], mapping['w'])
        res, (ox, oy, _) = mapping['res'], mapping['origin']

        def cell(x, y):
            r, c = mapping['h'] - 1 - math.floor((y - oy) / res), math.floor((x - ox) / res)
            return px[r, c] if 0 <= r < mapping['h'] and 0 <= c < mapping['w'] else -1
        for route in read(f'scenarios-{fid}.json'):
            half = route['clearance_m']
            assert half == 0.35 if fid == FLOORS[0] else half >= 0.25, (fid, half)
            offsets = np.arange(-half, half + 1e-3, res)
            wanted = [tuple(p['xy']) for p in next(f for f in LAYOUT['floors'] if f['floor_id'] == fid)['points']]
            got = [tuple(mapping['spawn_xyyaw'][:2])] + [(p['x'], p['y']) for p in route['points']]
            assert [p for p in got if p in wanted] == wanted, fid  # 배치 지점을 순서대로 다 지난다
            prev = mapping['spawn_xyyaw'][:2]
            for p in route['points']:
                assert (p['x'], p['y']) != tuple(prev), (fid, '길이 0 다리')
                steps = max(1, math.ceil(math.hypot(p['x'] - prev[0], p['y'] - prev[1]) / (res / 2)))
                for k in range(steps + 1):
                    x = prev[0] + (p['x'] - prev[0]) * k / steps
                    y = prev[1] + (p['y'] - prev[1]) * k / steps
                    for dx in offsets:
                        for dy in offsets:
                            assert cell(x + dx, y + dy) == 254, (fid, route['id'], x + dx, y + dy)
                prev = (p['x'], p['y'])


TURN_RADIUS = 0.38  # Go2 (약 0.70 x 0.31 m) 제자리 돌기 반경 (검수 #540 L1)


def test_every_turning_point_has_038_m_free_radius():
    import base64
    bad = []
    for fid in FLOORS:
        mapping = read(f'map-{fid}.json')
        px = np.frombuffer(base64.b64decode(mapping['px']), dtype=np.uint8).reshape(mapping['h'], mapping['w'])
        res, (ox, oy, _) = mapping['res'], mapping['origin']
        for route in read(f'scenarios-{fid}.json'):
            pts = [tuple(mapping['spawn_xyyaw'][:2])] + [(p['x'], p['y']) for p in route['points']]
            for i in range(1, len(pts) - 1):
                (ax, ay), (bx, by), (cx, cy) = pts[i - 1], pts[i], pts[i + 1]
                turn = abs(math.remainder(math.atan2(cy - by, cx - bx) - math.atan2(by - ay, bx - ax), math.tau))
                if turn < 1e-3:
                    continue
                cols = np.arange(math.floor((bx - TURN_RADIUS - ox) / res), math.ceil((bx + TURN_RADIUS - ox) / res) + 1)
                rows = np.arange(math.floor((by - TURN_RADIUS - oy) / res), math.ceil((by + TURN_RADIUS - oy) / res) + 1)
                xx, yy = np.meshgrid(ox + (cols + .5) * res, oy + (rows + .5) * res)
                near = np.hypot(xx - bx, yy - by) <= TURN_RADIUS
                cc, rr = np.meshgrid(cols, mapping['h'] - 1 - rows)
                if not (px[rr[near], cc[near]] == 254).all():
                    bad.append((fid, i, (bx, by)))
    assert not bad, bad

"""공장 터 (factory_site): 좌표 · 격자 · 상자 충돌 = 지도 · 시나리오 · 앱 시뮬 자산. ROS · 서버 없음.

glb 는 커밋하지 않으므로 glb 가 필요한 시험은 models/ 에 파일이 없으면 건너뛴다.
"""
import base64
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

from apps.simmgr.tools.collision_map import FREE, OCCUPIED, raster_floor, read_collisions
from apps.simmgr.tools import import_site as S

OUT = S.OUT
MOBILE = S.MOBILE / 'assets' / S.MOBILE_ID
DESIGN = json.loads((OUT / 'design.json').read_text())
PRESETS = json.loads((OUT / 'scenarios-f1.json').read_text())
TABLE = json.loads((OUT / 'routes-table.json').read_text())
PNG = np.array(Image.open(OUT / 'maps/f1.png'))
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
has_glb = pytest.mark.skipif(not S.GLB.exists(), reason='factory_site.glb 는 커밋하지 않음 (models/ 에 복사해야 시험)')


def test_design_pixel_to_world_uses_svg_metres_with_y_flipped():
    t = DESIGN['transform']
    assert (t['px_per_m'], t['origin_px'], t['image_px'], t['site_m']) == (3.5, [25, 20], [3200, 2000], [900, 560])
    assert S.design_to_world(25, 20, t) == (0, 0)
    assert S.design_to_world(25 + 3.5 * 900, 20 + 3.5 * 560, t) == (900, -560)
    # 시안 K-01 지점 (1720, 976) -> SVG (484.2857, 273.1429) m -> 세계 y 는 부호만 바뀜
    assert S.design_to_world(1720, 976, t) == (484.2857, -273.1429)


def test_map_frame_size_and_cells():
    meta = json.loads((OUT / 'maps/metadata.json').read_text())
    assert meta['resolution'] == 0.5 and meta['origin'] == [0.0, -560.0, 0.0] and meta['size_pixels'] == [1800, 1120]
    assert PNG.shape == (1120, 1800) and set(np.unique(PNG)) == {OCCUPIED, FREE}
    assert meta['floors']['f1']['image_sha256'] == sha(OUT / 'maps/f1.png')
    # 모르는 칸 없음: 땅 상자가 터 전체를 받침
    assert meta['floors']['f1']['counts']['unknown'] == 0
    # 세계 -> 칸: 오른쪽 아래 끝 칸, 왼쪽 위 끝 칸
    assert S.world_cell(899.9, -559.9) == (1119, 1799) and S.world_cell(0.1, -0.1) == (0, 0)


def test_free_space_is_one_connected_piece_reaching_the_start():
    from scipy.ndimage import label
    labels, count = label(PNG == FREE)
    assert count == 1
    start = S.design_to_world(*DESIGN['places'][0]['px'], DESIGN['transform'])
    assert labels[S.world_cell(*start)] == 1


def test_known_places_on_the_grid():
    """주 동서 도로 (SVG 6,278 888x13) 는 비어 있고, 제어실 (SVG 333.9~398, 222.3~258.3) 가운데는 막힘."""
    for u in range(20, 880, 20):
        assert PNG[S.world_cell(u, -284.5)] == FREE, u
    assert PNG[S.world_cell(366, -240)] == OCCUPIED
    # 금지 구역 3 곳 (수소 압축 · 변전소 · 플레어) 가운데 막힘
    for u, v in ((256, 142), (563, 323), (55.7, 498.6)):
        assert PNG[S.world_cell(u, -v)] == OCCUPIED, (u, v)


def test_box_collision_rasterizes_back_to_the_grid():
    """SDF 상자 (땅 + 막힌 칸 직사각형, 1 cm 안쪽) 를 collision_map 으로 다시 굽으면 같은 칸."""
    collisions, _ = read_collisions(OUT / 'factory_site.sdf')
    again = raster_floor(collisions, list(S.BOUNDS), S.RESOLUTION, 0.0)
    assert np.array_equal(again, PNG)


def test_rectangles_cover_exactly_without_overlap():
    rng = np.random.default_rng(3)
    mask = rng.random((40, 60)) < 0.4
    cover = np.zeros(mask.shape, int)
    for r0, c0, r1, c1 in S.rectangles(mask):
        cover[r0:r1, c0:c1] += 1
    assert np.array_equal(cover, mask.astype(int))


def test_mjcf_is_the_same_box_list_as_sdf():
    import xml.etree.ElementTree as ET
    sdf = ET.parse(OUT / 'factory_site.sdf').getroot().findall('.//link')
    geoms = ET.parse(MOBILE / 'factory-site.xml').getroot().findall('.//geom')
    assert len(sdf) == len(geoms) > 1000
    assert all(g.get('type') == 'box' for g in geoms)
    ground = next(g for g in geoms if g.get('name') == 'ground')
    assert ground.get('size') == '450 280 0.1' and ground.get('pos') == '450 -280 -0.1'


def test_catalogue_entry_hashes_and_spawn():
    entry = json.loads((S.WORLDS / 'worlds.json').read_text())['worlds']['factory_site/f1']
    assert entry['sha256'] == dict(world=sha(OUT / 'factory_site.sdf'), map=sha(OUT / 'maps/f1.yaml'),
                                   metadata=sha(OUT / 'maps/metadata.json'))
    assert entry['spawn_xyyaw'][:2] == [350.0, -260.0] and entry['floor_z'] == 0.0
    assert 'model' not in entry  # glb 는 f1_floor 노드가 없어 서버 3D 검사를 통과하지 못함 · 붙이지 않음


def test_scenarios_keep_design_points_and_end_at_start():
    t = DESIGN['transform']
    start = S.design_to_world(*DESIGN['places'][0]['px'], t)
    by_id = {p['id']: p for p in PRESETS}
    moved = {(m['route'], *m['world_from']): tuple(m['world_to']) for m in TABLE['moved_points']}
    for route in DESIGN['routes']:
        preset = by_id[route['id']]
        expected = [S.design_to_world(px, py, t) for px, py, _ in route['points']]
        expected = [moved.get((route['id'], *p), p) for p in expected]
        got = [(w['x'], w['y']) for w in preset['waypoints'] if w['kind'] == 'design']
        assert got == expected, route['id']
        last = preset['waypoints'][-1]
        assert (last['kind'], last['x'], last['y']) == ('return', *start) and preset['finish'] == 'STAY'
    assert by_id['patrol-a']['name'] == '공정 순찰 A · 14:00'
    assert all(p['name'].endswith('제안') for p in PRESETS if p['id'] in ('patrol-b', 'patrol-c', 'gas-check-k03'))
    charger = S.design_to_world(*DESIGN['places'][1]['px'], t)
    assert [(w['x'], w['y']) for w in by_id['battery-swap']['waypoints'] if w['kind'] != 'via'] == [charger, start]
    assert [p['id'] for p in PRESETS if p['id'].startswith('charge-wait-')] == [f'charge-wait-{i}' for i in range(1, 8)]


def test_blocked_design_points_move_to_the_nearest_road_with_moved_from():
    """app-design-lx 13:00: 막힌 시안 지점 셋은 가장 가까운 도로 점으로. kind design · moved_from 에 원래 px."""
    assert TABLE['dropped_points'] == []
    assert {(m['route'], m['label']) for m in TABLE['moved_points']} == {
        ('patrol-a', '할 일 1'), ('gas-check', '꺾는 점'), ('valve-3f', '출발')}
    by_id = {p['id']: p for p in PRESETS}
    for m in TABLE['moved_points']:
        assert S.blocked(PNG, *m['world_from']) and not S.blocked(PNG, *m['world_to'])
        assert S.on_road(DESIGN, *m['world_to'])
        assert m['moved_m'] == round(math.dist(m['world_from'], m['world_to']), 2)
        for pid in [m['route']] + [p['id'] for p in DESIGN['proposals'] if p.get('same_as') == m['route']]:
            w = next(w for w in by_id[pid]['waypoints'] if 'moved_from' in w and w['moved_from']['px'] == m['px'])
            assert (w['kind'], w['x'], w['y']) == ('design', *m['world_to'])
    # 할 일 1 원래 자리는 제어실 (SVG 333.9~398, 222.3~258.3 m) 안
    u, v = TABLE['moved_points'][0]['world_from'][0], -TABLE['moved_points'][0]['world_from'][1]
    assert 333.9 < u < 398 and 222.3 < v < 258.3
    assert S.clearance_failures(PNG, PRESETS) == []


def test_road_path_follows_centre_lines():
    """도로 그물: 시작 위치 -> 공정 B 옆 세로 도로 (u 207) 는 주 동서 도로 (v 284.5) 로 꺾는다."""
    corners = S.road_path(DESIGN, (350.0, -260.0), (209.5, -154.2857))
    assert corners == [(350.0, -284.5), (207.0, -284.5), (207.0, -154.2857)]
    assert S.road_path(DESIGN, (350.0, -260.0), (350.0, -260.0)) == []
    for x, y in corners:
        assert S.on_road(DESIGN, x, y)


def test_generated_legs_stay_on_roads_except_place_connectors():
    """생성 다리 (제안 경로 · 배터리 교체 · 기다림 칸) 의 도로 밖 길이는 도로 밖 자리 (시작 · 충전소) 를 드나드는 몫뿐."""
    rows = TABLE['off_road_legs']['legs']
    for pid in ['patrol-b', 'patrol-c', 'battery-swap'] + [f'charge-wait-{i}' for i in range(1, 8)]:
        assert all(r['off_road_m'] <= 18.0 for r in rows if r['route'] == pid), pid
    assert len(TABLE['charge_queue']['distances']) == 7
    for row in TABLE['charge_queue']['distances']:
        assert row['nearest_nogo'] == '변전소' and row['nogo_m'] == 7.0 and not row['overlaps']
        assert row['nearest_blocked_cell_m'] > row['body_half_m']


def test_route_lengths_match_design_polyline():
    t = DESIGN['transform']
    row = next(r for r in TABLE['routes'] if r['id'] == 'gauge-read')
    pts = [S.design_to_world(px, py, t) for px, py, _ in next(r for r in DESIGN['routes'] if r['id'] == 'gauge-read')['points']]
    assert row['design_length_m'] == round(sum(math.dist(a, b) for a, b in zip(pts, pts[1:])), 1) == 120.0
    assert row['design_minutes_at_0_5'] == 4.0


def test_mobile_assets_match_server_map():
    grid = json.loads((MOBILE / 'map.json').read_text())
    px = np.frombuffer(base64.b64decode(grid['px']), np.uint8).reshape(grid['h'], grid['w'])
    assert np.array_equal(px, PNG)
    assert (grid['origin'], grid['res'], grid['spawn_xyyaw']) == ([0.0, -560.0, 0.0], 0.5, [350.0, -260.0, -1.5708])
    maps = json.loads((S.MOBILE / 'maps.json').read_text())
    assert sum(m['id'] == 'factory-site' for m in maps) == 1
    ids = {s['id'] for s in json.loads((MOBILE / 'scenarios.json').read_text())}
    assert ids == {p['id'] for p in PRESETS if not p['id'].startswith('charge-wait-')}


@has_glb
def test_glb_hash_and_layer_names():
    sources = json.loads((OUT / 'sources.json').read_text())
    assert sha(S.GLB) == sources['inputs']['factory_site.glb']
    meshes = S.read_glb(S.GLB)
    assert sorted(meshes) == ['fk_building', 'fk_dikefloor', 'fk_equip', 'fk_nogo_fence', 'fk_nogo_floor', 'fk_nogo_post',
                              'fk_pave', 'fk_pipe', 'fk_road', 'fk_steel', 'fk_tank', 'fk_tankroof', 'fk_wall', 'fk_water']
    roads = meshes['fk_road'][0]
    # glb 도로 범위 = SVG 도로 (6, 6) ~ (894, 554) m, 세계 y 는 -v
    assert np.allclose([roads[:, 0].min(), roads[:, 0].max(), -roads[:, 1].max(), -roads[:, 1].min()], [6, 894, 6, 554], atol=1e-3)


@has_glb
def test_glb_regenerates_the_same_grid():
    start = S.design_to_world(*DESIGN['places'][0]['px'], DESIGN['transform'])
    pixels, _ = S.site_grid(S.read_glb(S.GLB), start)
    assert np.array_equal(pixels, PNG)


def test_via_points_keep_every_leg_within_40_m_and_clear():
    """agent 지점당 120 s 제한: 시작 위치부터 지점 사이 곧은 거리가 40 m 이하 (길 위 거리도 40 m 이하로 넣음)."""
    start = S.design_to_world(*DESIGN['places'][0]['px'], DESIGN['transform'])
    for preset in PRESETS:
        pts = [start] + [(w['x'], w['y']) for w in preset['waypoints']]
        assert max(math.dist(a, b) for a, b in zip(pts, pts[1:])) <= S.VIA_M + 1e-3, preset['id']
        kinds = {w['kind'] for w in preset['waypoints']}
        assert kinds <= {'design', 'via', 'return', 'place'}
        for w in preset['waypoints']:
            assert w['mission_name'].endswith('경유') == (w['kind'] == 'via')
    assert S.clearance_failures(PNG, PRESETS) == []


def test_densify_inserts_only_on_the_path_and_keeps_given_points():
    start = (350.0, -260.0)
    pts = [(350.0, -284.5, 'a', 'design'), (450.0, -284.5, 'b', 'design')]
    full, walk = S.densify(PNG, start, pts)
    assert [p for p in full if p[3] != 'via'] == pts
    vias = [p for p in full if p[3] == 'via']
    assert len(vias) == 2 and all(p[1] == -284.5 and 350 < p[0] < 450 for p in vias)
    assert walk == pytest.approx(24.5 + 100)


def test_every_leg_keeps_body_radius_clear_and_corridor_fixes_are_listed():
    """app-design-lx 13:09: 곧은 다리는 몸 반지름 0.45 m 안에서 장비 · 벽에 걸리지 않는다. 고친 다리는 corridor_legs 표에."""
    start = S.design_to_world(*DESIGN['places'][0]['px'], DESIGN['transform'])
    for preset in PRESETS:
        pts = [start] + [(w['x'], w['y']) for w in preset['waypoints']]
        for a, b in zip(pts, pts[1:]):
            assert S.segment_blocked_m(PNG, a, b) == 0, (preset['id'], a, b)
    rows = TABLE['corridor_legs']['legs']
    assert rows and all(r['blocked_m'] > 0 and r['corners'] >= 1 for r in rows)
    assert {r['route'] for r in rows} >= {'gauge-read', 'valve-3f'}
    assert any(w['mission_name'].endswith('통로 경유') for p in PRESETS for w in p['waypoints'])


def test_body_clear_is_exact_box_distance():
    assert S.body_clear(PNG, 450.0, -284.5)  # 주 동서 도로 가운데
    assert not S.body_clear(PNG, 366.0, -240.0)  # 제어실 안

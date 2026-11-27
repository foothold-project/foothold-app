"""배치 JSON 장애물 collision 배열 (box + z0 · cyl): 지도 칸 · SDF · MJCF 가 같은 모양. ROS·서버 없음."""
import json
import math

import numpy as np
from PIL import Image
import pytest
import xml.etree.ElementTree as ET

from apps.simmgr.tools import import_building
from apps.simmgr.tools.collision_map import generate

FREE, OCCUPIED = 254, 0
# 바닥 10 x 6 m 한 층. 선반 = 기둥 둘 + 1.0 m 위 보, 탱크 = 원기둥 r 0.8.
LAYOUT = {
    'schema': 'foothold_building/1', 'rev': 6, 'building_id': 'toy', 'name': '시험 건물', 'units': 'm',
    'footprint': [10.0, 6.0], 'spawn': {'floor_id': 'l1', 'xyyaw': [1.0, 1.0, 0.0]},
    'floors': [{
        'floor_id': 'l1', 'name': '1층 · 시험', 'floor_z': 0.0, 'roof': False,
        'slab': {'t': 0.2, 'poly': [[0, 0], [10, 0], [10, 6], [0, 6]], 'holes': []},
        'walls': [], 'doors': [], 'rooms': [], 'stairs': [],
        'points': [{'id': 'p1', 'name': '앞', 'xy': [1.0, 5.0], 'yaw': 0.0}],
        'obstacles': [
            {'id': 'rack', 'kind': 'rack', 'box': [3.0, 3.0, 2.0, 0.4, 1.3], 'yaw': 0.0, 'collision': [
                {'box': [2.05, 3.0, 0.1, 0.1, 1.0]}, {'box': [3.95, 3.0, 0.1, 0.1, 1.0]},
                {'box': [3.0, 3.0, 2.0, 0.4, 0.3], 'z0': 1.0}]},
            {'id': 'tank', 'kind': 'tank', 'box': [7.0, 3.0, 1.6, 1.6, 1.5], 'yaw': 0.0,
             'collision': [{'cyl': [7.0, 3.0, 0.8, 1.5]}]},
            # 밸브: 가는 보닛 원기둥 + 1.3 m 위 넓은 핸들 원기둥(z0).
            {'id': 'valve', 'kind': 'valve', 'box': [5.0, 1.5, 0.8, 0.8, 1.4], 'yaw': 0.0, 'collision': [
                {'cyl': [5.0, 1.5, 0.1, 1.3]}, {'cyl': [5.0, 1.5, 0.4, 0.1], 'z0': 1.3}]},
            # yaw 30° 가늘고 긴 상자 (검수 #540 L3: yaw 부호 뒤집음을 잡는다).
            {'id': 'skew', 'kind': 'cabinet', 'box': [8.5, 1.2, 1.6, 0.2, 0.5], 'yaw': math.pi / 6},
        ],
    }],
}


@pytest.fixture(scope='module')
def toy(tmp_path_factory):
    out = tmp_path_factory.mktemp('toy')
    (out / 'layout.json').write_text(json.dumps(LAYOUT, ensure_ascii=False))
    import_building.build(out / 'layout.json', out)
    generate(out / 'toy.sdf', out / 'maps', {'l1': 0.0}, resolution=0.05, bounds=[-1, -1, 11, 7])
    import_building.mobile_assets(out / 'layout.json', out, out / 'mobile')
    return out


def pixels(toy):
    return np.array(Image.open(toy / 'maps/l1.png'))


def at(px, x, y, res=0.05, ox=-1.0, oy=-1.0):
    return px[px.shape[0] - 1 - math.floor((y - oy) / res), math.floor((x - ox) / res)]


def test_beam_with_z0_leaves_floor_under_it_free_and_posts_block(toy):
    px = pixels(toy)
    for x in np.arange(2.3, 3.75, 0.1):
        for y in (2.85, 3.0, 3.15):
            assert at(px, x, y) == FREE, (x, y)
    assert at(px, 2.05, 3.0) == OCCUPIED and at(px, 3.95, 3.0) == OCCUPIED


def test_cylinder_blocks_only_inside_its_circle(toy):
    px = pixels(toy)
    inside = outside = 0
    for x in np.arange(5.9, 8.1, 0.05):
        for y in np.arange(1.9, 4.1, 0.05):
            d = math.hypot(x - 7.0, y - 3.0)
            if d < 0.8 - 0.08:
                assert at(px, x, y) == OCCUPIED, (x, y); inside += 1
            elif d > 0.8 + 0.08:
                assert at(px, x, y) == FREE, (x, y); outside += 1
    assert inside > 600 and outside > 600
    # 네모 그림 상자(1.6 x 1.6) 귀퉁이는 막히지 않는다.
    assert at(px, 7.7, 3.7) == FREE


def sdf_shapes(sdf):
    result = {}
    for link in ET.parse(sdf).getroot().iter('link'):
        pose = [float(v) for v in link.findtext('pose').split()]
        geometry = link.find('collision/geometry')[0]
        if geometry.tag == 'box':
            result[link.get('name')] = ('box', pose, [float(v) for v in geometry.findtext('size').split()])
        else:
            result[link.get('name')] = ('cylinder', pose, [float(geometry.findtext('radius')), float(geometry.findtext('length'))])
        visual = link.find('visual/geometry')[0]
        assert ET.tostring(visual) == ET.tostring(geometry), link.get('name')  # 그림 = 충돌
    return result


def test_sdf_and_mjcf_have_the_same_shapes(toy):
    sdf = sdf_shapes(toy / 'toy.sdf')
    assert sdf['l1_rack_c2'] == ('box', [3, 3, 1.15, 0, 0, 0], [2, 0.4, 0.3])
    assert sdf['l1_tank_c0'] == ('cylinder', [7, 3, 0.75, 0, 0, 0], [0.8, 1.5])
    assert 'l1_rack' not in sdf and 'l1_tank' not in sdf  # 그림 상자는 충돌이 아니다
    geoms = {g.get('name'): g for g in ET.parse(toy / 'mobile/toy.xml').getroot().find('worldbody')}
    assert set(geoms) == set(sdf)
    for name, (shape, pose, size) in sdf.items():
        g = geoms[name]
        assert g.get('type') == shape
        half = [s / 2 for s in size] if shape == 'box' else [size[0], size[1] / 2]
        assert [float(v) for v in g.get('size').split()] == pytest.approx(half)
        assert [float(v) for v in g.get('pos').split()] == pytest.approx(pose[:3])


def test_mujoco_ray_hits_cylinder_and_passes_under_beam(toy):
    mujoco = pytest.importorskip('mujoco')
    model = mujoco.MjModel.from_xml_path(str(toy / 'mobile/toy.xml'))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    geomid = np.zeros(1, dtype=np.int32)
    ray = lambda o, d: mujoco.mj_ray(model, data, np.array(o, float), np.array(d, float), None, 1, -1, geomid)
    assert ray([7.0, 1.0, 0.3], [0, 1, 0]) == pytest.approx(2.0 - 0.8, abs=1e-6)
    assert model.geom(geomid[0]).name == 'l1_tank_c0'
    assert ray([3.0, 1.0, 0.3], [0, 1, 0]) < 0 or ray([3.0, 1.0, 0.3], [0, 1, 0]) > 5  # 보 밑은 트임
    assert 5 - ray([3.0, 3.0, 5.0], [0, 0, -1]) == pytest.approx(1.3, abs=1e-6)


def test_bad_collision_entries_are_refused(tmp_path):
    for bad in ({'box': [1, 1, 1, 1, 1], 'cyl': [1, 1, 1, 1]}, {'cyl': [1, 1, -1, 1]}, {'box': [1, 1, 1, 1, 1], 'zz': 1}, {}):
        layout = json.loads(json.dumps(LAYOUT))
        layout['floors'][0]['obstacles'][0]['collision'] = [bad]
        (tmp_path / 'layout.json').write_text(json.dumps(layout))
        with pytest.raises(ValueError):
            import_building.build(tmp_path / 'layout.json', tmp_path)


def test_raised_cylinder_with_z0_leaves_floor_under_it_free(toy):
    px = pixels(toy)
    assert at(px, 5.0, 1.5) == OCCUPIED  # 보닛
    ring = [(5.0 + d * math.cos(a), 1.5 + d * math.sin(a)) for d in (0.22, 0.3, 0.35) for a in np.linspace(0, 6.2, 12)]
    assert all(at(px, x, y) == FREE for x, y in ring)  # 핸들(1.3 m 위) 밑은 트임
    sdf = sdf_shapes(toy / 'toy.sdf')
    assert sdf['l1_valve_c1'] == ('cylinder', [5, 1.5, 1.35, 0, 0, 0], [0.4, 0.1])
    g = {g.get('name'): g for g in ET.parse(toy / 'mobile/toy.xml').getroot().find('worldbody')}['l1_valve_c1']
    assert (g.get('type'), g.get('pos'), g.get('size')) == ('cylinder', '5 1.5 1.35', '0.4 0.05')


def test_yawed_box_turns_the_same_way_in_sdf_mjcf_and_map(toy):
    yaw = math.pi / 6
    tip = (8.5 + 0.7 * math.cos(yaw), 1.2 + 0.7 * math.sin(yaw))     # 긴 축 위 (+30°)
    mirror = (8.5 + 0.7 * math.cos(yaw), 1.2 - 0.7 * math.sin(yaw))  # 부호를 뒤집으면 여기
    px = pixels(toy)
    assert at(px, *tip) == OCCUPIED and at(px, *mirror) == FREE
    pose = [float(v) for v in next(l for l in ET.parse(toy / 'toy.sdf').getroot().iter('link')
                                   if l.get('name') == 'l1_skew').findtext('pose').split()]
    assert pose == pytest.approx([8.5, 1.2, 0.25, 0, 0, yaw], abs=1e-6)
    g = {g.get('name'): g for g in ET.parse(toy / 'mobile/toy.xml').getroot().find('worldbody')}['l1_skew']
    assert [float(v) for v in g.get('quat').split()] == pytest.approx([math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)], abs=1e-6)
    mujoco = pytest.importorskip('mujoco')
    model = mujoco.MjModel.from_xml_path(str(toy / 'mobile/toy.xml'))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    geomid = np.zeros(1, dtype=np.int32)
    down = lambda x, y: 2.0 - mujoco.mj_ray(model, data, np.array([x, y, 2.0]), np.array([0, 0, -1.0]), None, 1, -1, geomid)
    assert down(*tip) == pytest.approx(0.5, abs=1e-6) and model.geom(geomid[0]).name == 'l1_skew'
    assert down(*mirror) == pytest.approx(0.0, abs=1e-6)  # 바닥판 윗면

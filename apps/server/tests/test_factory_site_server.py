"""공장 터 (factory_site/f1) 를 서버 시드 (sim_maps.sync_worlds) 로 올린 뒤 (app-lx 11/28 14:13 · 14:21 · 14:23 · 14:25).

- 세계 파일 zones-f1.json 의 AREA 구역이 승인 판 features 로 들어간다
- 조직 (8830 에서는 총괄 lead01 의 조직) 의 /sites 에 공장 터가 나오고, 시뮬 시작이 넘기는 판 id 가 그 판이다
- /sites 의 demo: 그 SIM 현장 세계에 demo 로봇이 있으면 true, 없거나 REAL 이면 false
- 기간 가용 location_label: 로봇이 든 구역 이름 (가장 작은 넓이 · id 순), 구역 밖은 건물 · 층
"""
import json
import os
import shutil
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from apps.server.fh_server.sim_maps import load_worlds, sync_worlds
from .test_maps import P, auth, maps  # noqa: F401  (maps 는 fixture)

SOURCE = Path(__file__).resolve().parents[2] / 'simmgr/worlds'
ZONES = json.loads((SOURCE / 'factory_site/zones-f1.json').read_text())['zones']
CHARGER = (564.2857, -261.4286)  # 충전소 1 (정비동 옆) 가운데, 시안 점 (2000, 935) px
OPEN_GROUND = (450.0, -284.5)    # 구역 밖 도로


@pytest.fixture
def factory_folder(tmp_path):
    root = tmp_path / 'factory_worlds'
    shutil.copytree(SOURCE / 'factory_site', root / 'factory_site', ignore=shutil.ignore_patterns('models'))
    catalog = json.loads((SOURCE / 'worlds.json').read_text())
    catalog['worlds'] = {'factory_site/f1': catalog['worlds']['factory_site/f1']}
    (root / 'worlds.json').write_text(json.dumps(catalog))
    return root


def seed(http, seeded, folder, files):
    with Session(http.app.state.engine) as db, db.begin():
        sync_worlds(db, seeded['org'], seeded['users']['admin'], folder, files)


def factory_floor(http, headers):
    sites = http.get(P + '/sites', headers=headers).json()['items']
    buildings = [b for s in sites for b in s['buildings'] if b['sim_world_id'] == 'factory_site']
    assert len(buildings) == 1
    (floor,) = buildings[0]['floors']
    return sites, buildings[0], floor


def test_world_file_zones_are_seven_areas():
    (entry, *_), = [row for row in load_worlds(SOURCE) if row[0]['world_id'] == 'factory_site']
    assert entry['zones'] == 'factory_site/zones-f1.json'
    assert len(ZONES) == 7 and {z['type'] for z in ZONES} == {'AREA'}


def test_seed_puts_area_zones_on_the_approved_version(maps, seeded, factory_folder):
    http, admin, files = maps
    seed(http, seeded, factory_folder, files)
    _, building, floor = factory_floor(http, admin)
    version = http.get(P + '/map-versions/' + floor['approved_version_id'], headers=admin).json()
    assert version['features']['zones'] == ZONES
    # AREA 는 움직임 규칙이 없다: 지도판 구역 격자에 칸이 없다
    grid = http.get(P + '/map-versions/' + floor['approved_version_id'] + '/zone-grid', headers=admin)
    assert grid.status_code == 200, grid.text
    assert grid.json()['cells'] == []
    # 다시 시드해도 판 · 구역이 그대로
    seed(http, seeded, factory_folder, files)
    assert factory_floor(http, admin)[2]['approved_version_id'] == floor['approved_version_id']


def test_seeded_org_sees_the_factory_site_and_sim_start_binds_that_version(maps, seeded, factory_folder, monkeypatch):
    from apps.simmgr.api import create_app as manager_app
    from apps.simmgr.config import Settings as ManagerSettings, Slot, World
    from .test_simulation import LocalRelay
    from .test_api import csrf
    http, admin, files = maps
    for name in tuple(os.environ):
        if name.startswith(('ROS_', 'RMW_', 'CYCLONEDDS_', 'FASTRTPS_', 'FASTDDS_')):
            monkeypatch.delenv(name)
    seed(http, seeded, factory_folder, files)
    sites, building, floor = factory_floor(http, admin)
    assert building['name'] == '공장 터 · 초안' and floor['name'] == '마당'
    rid = str(uuid4())
    slot = Slot(rid, str(seeded['org']), 'unused', 'unused.sqlite', 9433)
    config = ManagerSettings({'factory_site/f1': World('factory_site/f1', Path('unused'), Path('unused'), '공장 터')},
                             {rid: slot}, 'x' * 32)
    monkeypatch.setattr('apps.simmgr.api.startup_preflight', lambda *_: {'resources_ok': True})
    with TestClient(manager_app(config), client=('127.0.0.1', 9652)) as sim:
        class Relay(LocalRelay):
            sent = []
            def request(self, method, path, body=None):
                if method == 'POST':
                    self.sent.append(deepcopy(body))
                return super().request(method, path, body)
        relay = Relay(sim, config.secret)
        http.app.state.simmgr = relay
        http.app.state.phone_pass_issuer.keys[rid] = ('test', {'test': b'x' * 32})
        headers = csrf(http, 'one')
        result = http.post(P + '/simulation/robots', headers=headers, json=dict(world_id='factory_site/f1', robot_id=rid))
        assert result.status_code == 201, result.text
        (binding,) = relay.sent[0]['map_bindings']
        assert (binding['world_id'], binding['ros_floor_id']) == ('factory_site', 'f1')
        assert binding['map_version_id'] == floor['approved_version_id'] and binding['floor_id'] == floor['id']
        assert http.delete(P + '/simulation/robots/' + rid, headers=headers).status_code == 204


def set_robot(seeded, robot, **values):
    engine = create_engine(seeded['urls']['migrate'])
    with engine.begin() as conn:
        conn.execute(text('UPDATE robots SET ' + ', '.join(f'{k}=:{k}' for k in values) + ' WHERE id=:id'),
                     {**values, 'id': seeded['robots'][robot]})
    engine.dispose()


def test_sites_demo_true_only_for_a_sim_site_whose_world_has_a_demo_robot(maps, seeded, factory_folder):
    http, admin, files = maps
    seed(http, seeded, factory_folder, files)
    real = http.post(P + '/sites', headers=admin, json={'name': '실제 현장', 'purpose': 'REAL'})
    assert real.status_code == 201, real.text
    assert real.json()['demo'] is False
    demo = lambda: {s['purpose']: s['demo'] for s in http.get(P + '/sites', headers=admin).json()['items']}
    assert demo() == {'SIM': False, 'REAL': False}             # 데모 로봇 없음
    set_robot(seeded, 'mine', simulation=True, demo=False, sim_world_id='factory_site')
    assert demo() == {'SIM': False, 'REAL': False}             # 시뮬 로봇이지만 데모 아님
    set_robot(seeded, 'mine', simulation=True, demo=True, sim_world_id='factory_site')
    assert demo() == {'SIM': True, 'REAL': False}              # 공장 터 세계에 데모 로봇
    set_robot(seeded, 'mine', simulation=True, demo=True, sim_world_id='no_such_world')
    assert demo() == {'SIM': False, 'REAL': False}             # 현장에 없는 세계


def place_robot(http, robot, floor, x, y):
    rt = http.app.state.realtime
    rt.agents[str(robot)] = SimpleNamespace(closing=False, state_received_at=rt.clock(), socket=None, state={
        'battery': {'soc': 70, 'updated_at': '2026-11-28T00:00:00Z'}, 'devices': [], 'status': 'IDLE',
        'location': {'floor_id': floor['id'], 'map_version_id': floor['approved_version_id'], 'x': x, 'y': y,
                     'yaw': 0.0, 'confidence': 1.0, 'updated_at': '2026-11-28T00:00:00Z'}})


def test_location_label_is_the_zone_name_and_floor_outside(maps, seeded, factory_folder):
    http, admin, files = maps
    seed(http, seeded, factory_folder, files)
    _, building, floor = factory_floor(http, admin)
    query = {'start': '2026-12-02T00:00:00Z', 'end': '2026-12-02T01:00:00Z'}
    label = lambda: {i['robot_name']: i['location_label'] for i in
                     http.get(P + '/robots/availability', headers=admin, params=query).json()['items']}['theirs']
    place_robot(http, seeded['robots']['theirs'], floor, *CHARGER)
    assert label() == '충전소 1 (정비동 옆)'
    place_robot(http, seeded['robots']['theirs'], floor, 555.7143, -252.8571)   # 그 구역의 꼭짓점 (경계)
    assert label() == '충전소 1 (정비동 옆)'
    place_robot(http, seeded['robots']['theirs'], floor, *OPEN_GROUND)
    assert label() == building['name'] + ' · ' + floor['name']


def test_factory_version_frame_matches_design_transform(maps, seeded, factory_folder):
    """시안 px -> m (design.json transform) 와 m -> 판 px (판 resolution · origin) 가 같은 좌표계 (1 px 안)."""
    http, admin, files = maps
    seed(http, seeded, factory_folder, files)
    _, _, floor = factory_floor(http, admin)
    version = http.get(P + '/map-versions/' + floor['approved_version_id'], headers=admin).json()
    design = json.loads((SOURCE / 'factory_site/design.json').read_text())
    t = design['transform']
    assert (t['image_px'], t['px_per_m'], t['origin_px']) == ([3200, 2000], 3.5, [25, 20])
    res, (ox, oy, yaw) = version['resolution'], version['origin']
    assert (version['width'], version['height'], res, yaw) == (1800, 1120, .5, 0.0)
    points = [p['px'] for p in design['places']] + [[25, 20], [3175, 1980], [1600, 1000]]
    for px, py in points:
        x, y = (px - t['origin_px'][0]) / t['px_per_m'], -(py - t['origin_px'][1]) / t['px_per_m']   # 시안 px -> m
        col, row = (x - ox) / res, version['height'] - (y - oy) / res                                   # m -> 판 px (위가 0 행)
        expect_col, expect_row = (px - t['origin_px'][0]) / t['px_per_m'] / res, (py - t['origin_px'][1]) / t['px_per_m'] / res
        assert abs(col - expect_col) < 1 and abs(row - expect_row) < 1, (px, py, col, row)
        assert 0 <= col <= version['width'] and 0 <= row <= version['height']


def test_buildings_demo_true_only_for_the_world_with_a_demo_robot(maps, seeded, factory_folder):
    """건물 (세계) 단위 demo (app-design-lx 14:52 B): 한 SIM 현장에 세계가 모두 있으므로 건물마다 따로."""
    http, admin, files = maps
    for relative in ('warehouse/scenarios.json', 'warehouse/maps/f1.png', 'warehouse/maps/f1.yaml', 'warehouse/maps/metadata.json'):
        (factory_folder / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / relative, factory_folder / relative)
    catalog = json.loads((factory_folder / 'worlds.json').read_text())
    catalog['worlds']['warehouse/f1'] = json.loads((SOURCE / 'worlds.json').read_text())['worlds']['warehouse/f1']
    (factory_folder / 'worlds.json').write_text(json.dumps(catalog))
    seed(http, seeded, factory_folder, files)
    real = http.post(P + '/sites', headers=admin, json={'name': '실제 현장', 'purpose': 'REAL'}).json()
    building = http.post(P + '/sites/' + real['id'] + '/buildings', headers=admin, json={'name': '실제 건물'})
    assert building.status_code == 201, building.text
    assert building.json()['demo'] is False
    demo = lambda: {b['sim_world_id'] or b['name']: b['demo'] for s in http.get(P + '/sites', headers=admin).json()['items']
                    for b in s['buildings']}
    assert demo() == {'factory_site': False, 'warehouse': False, '실제 건물': False}
    set_robot(seeded, 'mine', simulation=True, demo=True, sim_world_id='factory_site')
    assert demo() == {'factory_site': True, 'warehouse': False, '실제 건물': False}


MODEL = SOURCE / 'factory_site/models/factory_site_f1floor.glb'


@pytest.mark.skipif(not MODEL.is_file(), reason='GLB 는 커밋하지 않음 (apps/simmgr/worlds/**/models/ gitignore)')
def test_seed_attaches_the_factory_model_with_its_f1_floor(maps, seeded, factory_folder):
    """f1_floor 마디를 더해 다시 내보낸 공장 GLB 가 load_model 검사를 지나 승인 판에 붙는다 (app-lx 11/28 15:03)."""
    from hashlib import sha256
    http, admin, files = maps
    (factory_folder / 'factory_site/models').mkdir()
    shutil.copyfile(MODEL, factory_folder / 'factory_site/models' / MODEL.name)
    seed(http, seeded, factory_folder, files)
    _, _, floor = factory_floor(http, admin)
    version = http.get(P + '/map-versions/' + floor['approved_version_id'], headers=admin).json()
    assert version['model_sha256'] == sha256(MODEL.read_bytes()).hexdigest()
    assert version['model_floor_z'] == 0.0

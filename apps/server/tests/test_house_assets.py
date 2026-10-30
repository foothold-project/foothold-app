"""Terrain-v2 registration and real-map route clearance, isolated from services."""
import base64
import json
from pathlib import Path
import shutil
import struct
import xml.etree.ElementTree as ET

import pytest
from sqlalchemy.orm import Session

from apps.server.fh_server.models import Building, Scenario
from apps.server.fh_server.sim_maps import load_worlds, sync_worlds
from sqlalchemy import select
from .test_maps import maps  # isolated PostgreSQL/files fixture

ROOT = Path(__file__).resolve().parents[3]
WORLDS = ROOT/'apps/simmgr/worlds'
MOBILE = ROOT/'mobile/sim/assets/collapsed-house-v2'


def test_house_surface_and_full_scenario_keep_collision_clearance():
    entries = load_worlds(WORLDS)
    entry = next(e for e in entries if e[0]['world_id'] == 'collapsed_house_v2')
    assert entry[0]['name'] == '붕괴 주택 · 초안'
    assert len(entry[5]) == 1 and entry[5][0]['finish'] == 'STAY'
    scene = json.loads((MOBILE/'scene.json').read_text())
    assert len(scene['meshes']['original_house']['i'])//3 == 2219
    house = scene['meshes']['original_house']
    assert len(house['uv']) == len(house['p'])//3*2
    assert next(m for m in scene['models'] if m['mesh']=='original_house')['texture'] == 'house-albedo.png'
    assert struct.unpack('>II',(MOBILE/'house-albedo.png').read_bytes()[16:24]) == (512,512)
    xml = ET.parse(MOBILE/'collapsed-house-v2.xml')
    hfield = xml.find('asset/hfield')
    assert hfield is not None and hfield.get('file') == 'height.png'
    assert struct.unpack('>II',(MOBILE/'height.png').read_bytes()[16:24]) == (1025,1025)
    assert len(xml.findall('worldbody/geom')) <= 3*(139+30)
    assert xml.find('worldbody/geom[@type="hfield"]').get('group') == '4'
    proxies=xml.findall('worldbody/geom[@contype="0"]')
    assert not proxies  # loose pieces themselves are ray-visible contacts
    meta = json.loads((MOBILE/'metadata.json').read_text())
    assert 30000 <= meta['triangles'] <= 100000
    assert meta['loose_pile_pieces'] > 100
    assert meta['perimeter_fragments']['rock'] >= 1000
    assert meta['perimeter_fragments']['wood'] >= 300
    assert meta['perimeter_fragments']['concrete'] >= 20
    assert meta['perimeter_max_above_ground_m'] <= .8
    assert meta['perimeter_contact_clusters'] > 50
    for name in meta['shared_rubble_textures']:
        assert struct.unpack('>II',(MOBILE/name).read_bytes()[16:24]) == (256,256)
    for kind in ('rock','wood','concrete'):
        model=next(m for m in scene['models'] if m['name']==f'perimeter_{kind}')
        assert model['texture_repeat'] and model['flat_shading']
        mesh=scene['meshes'][model['mesh']]
        assert len(mesh['uv']) == len(mesh['p'])//3*2
    assert meta['metrics']['indoor_max_above_floor_m'] == pytest.approx(.786, abs=.01)
    assert len(xml.findall('asset/mesh')) == meta['loose_pile_pieces']
    grid = json.loads((MOBILE/'map.json').read_text())
    pixels = base64.b64decode(grid['px'])
    def value(x, y):
        c = int((x-grid['origin'][0])//grid['res'])
        r = grid['h']-1-int((y-grid['origin'][1])//grid['res'])
        return pixels[r*grid['w']+c] if 0<=c<grid['w'] and 0<=r<grid['h'] else 205
    points = json.loads((MOBILE/'scenarios.json').read_text())[0]['points']
    for a,b in zip(points,points[1:]):
        length = ((b['x']-a['x'])**2+(b['y']-a['y'])**2)**.5
        for k in range(int(length/.025)+2):
            t = k/(int(length/.025)+1)
            x=a['x']+(b['x']-a['x'])*t
            y=a['y']+(b['y']-a['y'])*t
            # 90cm minimum corridor including cell-area margin.
            for dx,dy in ((.45,0),(-.45,0),(0,.45),(0,-.45),(0,0)):
                assert value(x+dx,y+dy)==254, (x,y,dx,dy)
    assert sum(p.stat().st_size for folder in (MOBILE,WORLDS/'collapsed_house_v2')
               for p in folder.rglob('*') if p.is_file()) <= 15_000_000


def test_house_registers_one_map_and_one_scenario_in_private_database(maps, seeded, tmp_path):
    http, _, files = maps
    folder = tmp_path/'catalogue'
    (folder/'collapsed_house_v2/maps').mkdir(parents=True)
    original = json.loads((WORLDS/'worlds.json').read_text())
    entry = original['worlds']['collapsed_house_v2/f1']
    original['worlds'] = {'collapsed_house_v2/f1': entry}
    (folder/'worlds.json').write_text(json.dumps(original))
    for name in ('scenarios.json','maps/f1.png','maps/f1.yaml','maps/metadata.json'):
        shutil.copyfile(WORLDS/'collapsed_house_v2'/name,folder/'collapsed_house_v2'/name)
    with Session(http.app.state.engine) as db, db.begin():
        changed = sync_worlds(db,seeded['org'],seeded['users']['admin'],folder,files)
        assert len(changed)==1
        assert sync_worlds(db,seeded['org'],seeded['users']['admin'],folder,files)==[]
        house=db.scalar(select(Building).where(Building.sim_world_id=='collapsed_house_v2'))
        assert house.name=='붕괴 주택 · 초안'
        assert len(list(db.scalars(select(Scenario).where(Scenario.name=='입구 → 시계 방향 세 방'))))==1

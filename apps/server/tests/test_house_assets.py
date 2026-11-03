"""Terrain-v2 registration and real-map route clearance, isolated from services."""
import base64
import json
import math
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


def test_large_house_rubble_spreads_across_floor_without_closing_routes():
    xml = ET.parse(MOBILE/'collapsed-house-v2.xml')
    server = WORLDS/'collapsed_house_v2'
    sdf = ET.parse(server/'collapsed_house_v2.sdf')
    # Companion contact meshes/tiles are required inputs, not optional previews.
    for uri in sdf.findall('.//uri'):
        assert (server/uri.text).is_file(), uri.text
    scene = json.loads((MOBILE/'scene.json').read_text())
    meta = json.loads((MOBILE/'metadata.json').read_text())
    route = [(3.85, -9.35), *[(p['x'], p['y']) for p in
              json.loads((MOBILE/'scenarios.json').read_text())[0]['points']]]
    geoms = xml.findall('worldbody/geom')
    walls = [g for g in geoms if g.get('name', '').startswith('house_wall_')]
    stairs = [g for g in geoms if g.get('type') == 'box' and
              not g.get('name', '').startswith(('house_wall_', 'outdoor_ground'))]
    loose = [g for g in geoms if g.get('name', '').startswith('loose_')]
    for prefix in ('house_support_', 'perimeter_contact_'):
        assert len([m for m in sdf.findall('world/model') if m.get('name').startswith(prefix)]) == \
               len([g for g in geoms if g.get('name', '').startswith(prefix)])
    assert len(loose) == 114
    assert {kind: sum(g.get('name').startswith(f'loose_{kind}_') for g in loose)
            for kind in ('rock', 'concrete', 'wood')} == dict(rock=76, concrete=25, wood=13)
    def numbers(value):
        return list(map(float, value.split()))
    def segment_distance(x, y, a, b):
        dx, dy = b[0]-a[0], b[1]-a[1]
        t = max(0, min(1, ((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)))
        return math.hypot(x-a[0]-t*dx, y-a[1]-t*dy)
    def box_gap(lo, hi, box):
        p, s = numbers(box.get('pos')), numbers(box.get('size'))
        return math.hypot(*[max(p[k]-s[k]-hi[k], lo[k]-p[k]-s[k], 0) for k in (0, 1)])
    # Spatial buckets check actual shipped visible vertices against every
    # collision vertex, allowing only the exporter's 0.1mm rounding.
    visible = {}
    for name, mesh in scene['meshes'].items():
        if '_batch_' not in name:
            continue
        for j in range(0, len(mesh['p']), 3):
            p = mesh['p'][j:j+3]
            visible.setdefault(tuple(round(v, 2) for v in p), []).append(p)
    centers, indoor, clearances = [], 0, []
    for geom in loose:
        assert geom.get('group') == '1'  # existing large-piece lidar rule
        mesh = xml.find(f'asset/mesh[@name="{geom.get("mesh")}"]')
        local, pos = numbers(mesh.get('vertex')), numbers(geom.get('pos'))
        vertices = [[local[j+k]+pos[k] for k in range(3)] for j in range(0, len(local), 3)]
        piece = geom.get('mesh').split('_')[-1]
        collision = sdf.find(f'world/model[@name="contact_{piece}"]/link/collision/geometry/mesh/uri')
        server_vertices = [numbers(line[2:]) for line in (server/collision.text).read_text().splitlines()
                           if line.startswith('v ')]
        assert len(server_vertices) == len(vertices)
        assert all(max(abs(a-b) for a, b in zip(p, q)) < .000011
                   for p, q in zip(vertices, server_vertices))
        lo = [min(p[k] for p in vertices) for k in range(3)]
        hi = [max(p[k] for p in vertices) for k in range(3)]
        center = [(a+b)/2 for a, b in zip(lo, hi)]
        centers.append(center)
        indoor += lo[2] > 1
        clearances.append(min(box_gap(lo, hi, wall) for wall in walls))
        assert clearances[-1] >= .25
        assert all(box_gap(lo, hi, stair) >= .25 for stair in stairs)
        # Sample the whole AABB at <=5cm, including edges and interior.
        for r in range(math.ceil((hi[1]-lo[1])/.05)+1):
            y = min(hi[1], lo[1]+r*.05)
            for c in range(math.ceil((hi[0]-lo[0])/.05)+1):
                x = min(hi[0], lo[0]+c*.05)
                assert min(segment_distance(x, y, a, b) for a, b in zip(route, route[1:])) >= .7499
        for p in vertices:
            # Try adjacent buckets for coordinates on a rounding boundary.
            nearby = [q for dx in (-.001, 0, .001) for dy in (-.001, 0, .001)
                      for dz in (-.001, 0, .001) for q in visible.get(
                          tuple(round(p[k]+d, 2) for k, d in enumerate((dx, dy, dz))), [])]
            assert any(max(abs(a-b) for a, b in zip(p, q)) < .0002 for q in nearby)
    assert 25 <= indoor <= 32 and 82 <= len(loose)-indoor <= 89
    assert min(math.dist(a[:2], b[:2]) for i, a in enumerate(centers) for b in centers[i+1:]) >= 1.1499
    assert max(p[0] for p in centers) > 10 and min(p[0] for p in centers) < -10
    assert max(p[1] for p in centers) > 10 and min(p[1] for p in centers) < -10
    assert meta['loose_distribution']['indoor_pieces'] == indoor
    assert min(clearances) >= meta['loose_distribution']['min_wall_footprint_clearance_m']-.08


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
    assert meta['perimeter_heightfield_tiles'] > 50
    assert meta['perimeter_lidar_group'] == 4
    for name in meta['shared_rubble_textures']:
        assert struct.unpack('>II',(MOBILE/name).read_bytes()[16:24]) == (256,256)
    for kind in ('rock','wood','concrete'):
        model=next(m for m in scene['models'] if m['name']==f'perimeter_{kind}')
        assert model['texture_repeat'] and model['flat_shading']
        mesh=scene['meshes'][model['mesh']]
        assert len(mesh['uv']) == len(mesh['p'])//3*2
    assert meta['metrics']['indoor_max_above_floor_m'] == pytest.approx(.786, abs=.01)
    assert len(xml.findall('asset/mesh')) == meta['loose_pile_pieces'] + meta['house_support_slabs']
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
    # #231 붕괴 주택 v2 실제 17.66MB, 2026-11-02 조정 승인
    assert sum(p.stat().st_size for folder in (MOBILE,WORLDS/'collapsed_house_v2')
               for p in folder.rglob('*') if p.is_file()) <= 18_000_000


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

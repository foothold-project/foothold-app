"""Export a validated local terrain-v2 bundle, preserving its surface and house.

Usage: python3 -m apps.simmgr.tools.import_house /path/to/terrain-v2
Inputs stay outside Git. The CC0 building is flattened to derived OBJ geometry;
MuJoCo receives a heightfield plus conservative 10cm wall columns, never one
convex hull/AABB around the house or the rough floor. No services are started.
"""
import argparse
import base64
import copy
import hashlib
import json
from pathlib import Path
import shutil
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
from scipy.interpolate import RegularGridInterpolator
from scipy.ndimage import distance_transform_edt
import trimesh

from .collision_map import clip_z, polygon_cells

ROOT = Path(__file__).resolve().parents[3]
WORLD_ID = 'collapsed_house_v2'
MOBILE_ID = 'collapsed-house-v2'
NAME = '붕괴 주택 · 초안'
LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/'
SOURCE_URL = 'https://fuel.gazebosim.org/1.0/OpenRobotics/models/Collapsed%20house'


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'))+'\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mesh_from(triangles):
    vertices, inverse = np.unique(np.round(triangles.reshape(-1, 3), 5), axis=0, return_inverse=True)
    return trimesh.Trimesh(vertices, inverse.reshape(-1, 3), process=False)


def obj(path, mesh):
    # Shared position/normal indices: small assets with finite normals for DART.
    vertices, faces, normals = mesh.vertices, mesh.faces, mesh.vertex_normals
    text = '# Terrain v2 derived geometry; Collapsed House CC0-1.0; local rubble.\n'
    text += ''.join('v '+' '.join(f'{v:.5f}' for v in p)+'\n' for p in vertices)
    text += ''.join('vn '+' '.join(f'{v:.5f}' for v in p)+'\n' for p in normals)
    text += ''.join('f '+' '.join(f'{i+1}//{i+1}' for i in f)+'\n' for f in faces)
    path.write_text(text)


def wall_pixels(building, xs, ys, floor):
    occupied = np.zeros((len(ys), len(xs)), bool)
    for tri in building:
        # Vertical faces and furniture only, support floors and overhead roof
        # stay in the visual mesh. The result is a conservative body-height band.
        polygon = clip_z(clip_z(tri, floor+.10, True), floor+.65, False)
        if len(polygon) < 2:
            continue
        iy, ix, hit = polygon_cells(polygon[:, :2], xs, ys, .05)
        occupied[np.ix_(iy, ix)] |= hit
    return occupied


def rectangles(mask):
    """Exact cover of occupied 10cm cells; each becomes a separate wall box."""
    left = mask.copy()
    result = []
    while left.any():
        row, col = np.argwhere(left)[0]
        end = col
        while end < left.shape[1] and left[row, end]:
            end += 1
        bottom = row+1
        while bottom < left.shape[0] and left[bottom, col:end].all():
            bottom += 1
        left[row:bottom, col:end] = False
        result.append((row, bottom, col, end))
    return result


def export(source):
    source = Path(source)
    data = np.load(source/'previews/v2_geometry.npz')
    layout = json.loads((source/'layout.json').read_text())
    assert layout['revision'] == 'terrain-v2' and layout['reused_fragments'] == 1085
    out = ROOT/'apps/simmgr/worlds'/WORLD_ID
    mobile = ROOT/'mobile/sim/assets'/MOBILE_ID
    for p in (out/'meshes', out/'maps', mobile):
        p.mkdir(parents=True, exist_ok=True)
    floor = layout['floor_z']
    root = ET.parse(source/'house_debris_world.sdf').getroot()
    world = root.find('world')
    # Resolve the included house to actual geometry so conversion cannot lose it.
    for inc in world.findall('include'):
        world.remove(inc)
    house = ET.SubElement(world, 'model', name='original_house')
    ET.SubElement(house, 'static').text = 'true'
    link = ET.SubElement(house, 'link', name='body')
    for kind in ('collision', 'visual'):
        element = ET.SubElement(link, kind, name=kind)
        ET.SubElement(ET.SubElement(ET.SubElement(element, 'geometry'), 'mesh'), 'uri').text = 'meshes/house.obj'
        if kind == 'visual':
            material = ET.SubElement(element, 'material')
            ET.SubElement(material, 'diffuse').text = '.56 .52 .45 1'
    obj(out/'meshes/house.obj', mesh_from(data['building']))
    meshes = {'original_house': mesh_from(data['building'])}
    for name in ['terrain_v2', *[f'fragments_{i}' for i in range(8)]]:
        mesh = mesh_from(trimesh.load_mesh(source/f'models/debris_assets/meshes/{name}.obj', process=False).triangles)
        obj(out/f'meshes/{name}.obj', mesh)
        meshes[name] = mesh
    shutil.copyfile(source/'models/debris_assets/height_v2.png', out/'height.png')
    for uri in root.findall('.//uri'):
        if uri.text.startswith('model://debris_assets/meshes/'):
            uri.text = 'meshes/'+Path(uri.text).name
        elif uri.text == 'model://debris_assets/height_v2.png':
            uri.text = 'height.png'
    # Shared dust texture is procedural; no Fuel textures enter the repository.
    shutil.copyfile(source/'models/debris_assets/materials/textures/dust_v2.png', out/'dust.png')
    for uri in root.findall('.//albedo_map'):
        uri.text = 'dust.png'
    ET.indent(root)
    ET.ElementTree(root).write(out/f'{WORLD_ID}.sdf', encoding='utf-8', xml_declaration=True)

    # 5cm local support map: the terrain has variable elevation. Occupancy is
    # the house body band plus piles >15cm, not each low traversable stone.
    res = .05
    xs = np.arange(-8.475, 8.5, res)
    ys = np.arange(-9.975, 8., res)
    x, y = np.meshgrid(xs, ys)
    wall = wall_pixels(data['building'], xs, ys, floor)
    height = RegularGridInterpolator((data['hy'], data['hx']), data['hz'], bounds_error=False, fill_value=-.02)(np.c_[y.ravel(), x.ravel()]).reshape(x.shape)
    occupied = wall | (height > floor+.15)
    px = np.where(occupied, 0, 254).astype('uint8')[::-1]
    Image.fromarray(px).save(out/'maps/f1.png')
    origin = [-8.5, -10., 0.]
    (out/'maps/f1.yaml').write_text('image: f1.png\nmode: trinary\nresolution: 0.05\norigin: [-8.5, -10.0, 0.0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n')
    route = [dict(x=float(p[0]), y=float(p[1])) for p in data['route']]
    # First point is a ground spawn; do not silently skip the nine entry steps.
    spawn = [*data['route'][0], np.pi/2]
    image_sha = sha(out/'maps/f1.png')
    metadata = dict(generator_version='terrain-v2-local-height/1', resolution=res, origin=origin,
        size_pixels=[len(xs), len(ys)], body_band_above_floor_m=[.10, .65],
        support_samples='continuous heightfield; outdoor ground and nine solid stair boxes',
        occupancy='actual house triangle body band; relief above indoor floor >0.15m; low rubble remains traversable',
        pixel_to_world='x=xmin+(column+0.5)*resolution; y=ymin+(height-row-0.5)*resolution',
        floors={'f1': dict(floor_z=floor, image='f1.png', yaml='f1.yaml', image_sha256=image_sha)},
        variable_elevation=True)
    write_json(out/'maps/metadata.json', metadata)
    server_scenario = [dict(id='clockwise-rooms', name='입구 → 시계 방향 세 방', finish='STAY',
        waypoints=[dict(**p, mission_name='붕괴 주택 경유점') for p in route])]
    write_json(out/'scenarios.json', server_scenario)
    write_json(mobile/'scenarios.json', [dict(id='clockwise-rooms', name='입구 → 시계 방향 세 방', points=route[1:])])
    write_json(mobile/'map.json', dict(res=res, origin=origin, w=len(xs), h=len(ys), floor_z=-.02,
        spawn_xyyaw=spawn, spawn_z=.38, physics_assets=['height.png'], px=base64.b64encode(px.tobytes()).decode()))

    # Preserve visible triangle topology. No floor or building bounding box.
    scene = dict(meshes={}, models=[])
    for name, mesh in meshes.items():
        scene['meshes'][name] = dict(p=np.round(mesh.vertices,5).ravel().tolist(), i=mesh.faces.ravel().tolist())
        color = [.56,.52,.45] if name == 'original_house' else [.57,.55,.51] if name == 'terrain_v2' else list(np.array([.58,.55,.50])*(.84+int(name[-1])*.04))
        scene['models'].append(dict(name=name,mesh=name,pos=[0,0,0],quat=[1,0,0,0],color=color))
    xml = ET.Element('mujoco', model=MOBILE_ID)
    asset = ET.SubElement(xml, 'asset')
    hmap = layout['heightmap']
    # External PNG keeps fine contact sampling small enough for phone bundles.
    elevation = (data['hz'][::-1]-hmap['min'])/hmap['range']
    Image.fromarray(np.round(elevation*255).astype('uint8')).save(mobile/'height.png')
    ET.SubElement(asset, 'hfield', name='terrain_v2', file='height.png',
        size=f'8.5 8.5 {hmap["range"]} .1')
    wb = ET.SubElement(xml, 'worldbody')
    ET.SubElement(wb, 'geom', group='4', type='hfield', hfield='terrain_v2', pos='0 -.5 -.02', friction='.85 .005 .0001')
    # Flat outdoor ground and exact entry boxes are also shown in three.js.
    for model in world.findall('model'):
        size = model.findtext('link/collision/geometry/box/size')
        if size is None:
            continue
        extents = np.fromstring(size,sep=' ')
        pose = np.fromstring(model.findtext('pose','0 0 0 0 0 0'),sep=' ')
        ET.SubElement(wb,'geom',name=model.get('name'),group='1',type='box',size=' '.join(map(str,extents/2)),pos=' '.join(map(str,pose[:3])))
        mesh = trimesh.creation.box(extents)
        name = model.get('name')
        scene['meshes'][name] = dict(p=np.round(mesh.vertices,5).ravel().tolist(),i=mesh.faces.ravel().tolist())
        scene['models'].append(dict(name=name,mesh=name,pos=pose[:3].tolist(),quat=[1,0,0,0],color=[.57,.54,.49]))
    wx=np.arange(-8.45,8.5,.1);wy=np.arange(-6.45,6.5,.1)
    cols = rectangles(wall_pixels(data['building'],wx,wy,floor))
    for i,(r0,r1,c0,c1) in enumerate(cols):
        ET.SubElement(wb,'geom',name=f'house_wall_{i}',group='1',type='box',
            size=f'{(c1-c0)*.05} {(r1-r0)*.05} 1.2',pos=f'{-8.5+(c0+c1)*.05} {-6.5+(r0+r1)*.05} {floor+1.2}')
    # Coarse rays-only proxies for >30cm piles; never touch robot contacts.
    coarse = np.zeros((34,34),bool)
    heights = np.zeros(coarse.shape)
    for row in range(34):
        for col in range(34):
            x0,y0=-8.5+col*.5,-9+row*.5
            ix=np.where((data['hx']>=x0)&(data['hx']<=x0+.5))[0]
            iy=np.where((data['hy']>=y0)&(data['hy']<=y0+.5))[0]
            top=float(data['hz'][np.ix_(iy,ix)].max())
            heights[row,col]=top
            coarse[row,col]=top>floor+.30
    ray_boxes=rectangles(coarse)
    for i,(r0,r1,c0,c1) in enumerate(ray_boxes):
        top=float(heights[r0:r1,c0:c1].max())
        ET.SubElement(wb,'geom',name=f'pile_scan_{i}',group='1',type='box',contype='0',conaffinity='0',
            size=f'{(c1-c0)*.25} {(r1-r0)*.25} {(top-floor)/2}',
            pos=f'{-8.5+(c0+c1)*.25} {-9+(r0+r1)*.25} {(top+floor)/2}')
    assert len(wb)<=200, 'Physics and rays-only geometry budget exceeded'
    ET.indent(xml)
    ET.ElementTree(xml).write(mobile/f'{MOBILE_ID}.xml',encoding='utf-8',xml_declaration=True)
    write_json(mobile/'scene.json',scene)
    write_json(mobile/'metadata.json',dict(draft=True,source=f'{WORLD_ID}/f1',
        triangles=sum(len(m.faces) for m in meshes.values())+11*12, house_triangles=len(data['building']),
        physics='1025x1025 actual surface heightfield; exact stairs; conservative 10cm house wall columns in body band',
        collision_geometries=len(wb)-len(ray_boxes),ray_only_proxies=len(ray_boxes),source_heightmap=sha(out/'height.png'),
        heightfield_quantization_m=hmap['range']/255, added_fragments=layout.get('added_fragments',0),
        limitations='horizontal virtual lidar uses coarse boxes for >30cm piles and exact walls/stairs; dense field omitted; roof/furniture visual retained; wall columns extend body-band occupancy vertically; phone unverified'))
    notice = f'# Sources\n\nCollapsed House by Nate Koenig / OpenRobotics: {SOURCE_URL}\n\nFuel API identifies Creative Commons Zero v1.0 Universal (CC0-1.0): {LICENSE_URL}\nChecked 2026-10-29. House geometry flattened from the local modified source; original textures omitted.\nRubble, layout and dust are locally generated; no source photographs, scans or policy weights included.\n'
    (out/'NOTICE.md').write_text(notice)
    (mobile/'NOTICE.md').write_text(notice)
    catalogue_path=out.parent/'worlds.json'
    catalogue=json.loads(catalogue_path.read_text())
    catalogue['worlds'][f'{WORLD_ID}/f1']=dict(world_id=WORLD_ID,floor_id='f1',building_id=WORLD_ID,name=NAME,
        floor_name='1층',level=1,description='고정 붕괴 주택; 9단 입구와 시계 방향 세 방. 보행 결과는 README 참조.',
        floor_z=floor,spawn_xyyaw=spawn,spawn_z=.38,world=f'{WORLD_ID}/{WORLD_ID}.sdf',
        gt_map=f'{WORLD_ID}/maps/f1.yaml',map_metadata=f'{WORLD_ID}/maps/metadata.json',scenarios=f'{WORLD_ID}/scenarios.json',
        ledger_key=f'{WORLD_ID}/f1',height_source='heightfield_and_house_triangles',readiness='draft',native_supported=False,
        notes='앱 오프라인 MuJoCo/three.js 전용; 서버 지도 등록 가능, Gazebo 실행 adapter 추가 필요.',
        sha256=dict(world=sha(out/f'{WORLD_ID}.sdf'),map=sha(out/'maps/f1.yaml'),metadata=sha(out/'maps/metadata.json')))
    catalogue_path.write_text(json.dumps(catalogue,ensure_ascii=False,indent=2)+'\n')
    maps_path=mobile.parents[1]/'maps.json'
    maps=[m for m in json.loads(maps_path.read_text()) if m['id']!=MOBILE_ID]
    maps_path.write_text(json.dumps(maps+[dict(id=MOBILE_ID,name=NAME)],ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(dict(image_sha256=image_sha,wall_columns=len(cols),collision_geometries=len(wb),
        asset_bytes=sum(p.stat().st_size for folder in (out,mobile) for p in folder.rglob('*') if p.is_file())),indent=2))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    export(parser.parse_args().source)

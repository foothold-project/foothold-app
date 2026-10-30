"""Rebuild one MuJoCo factory from the committed SDF; never edit server assets.

python3 mobile/scripts/factory-one.py
Then FH_SIM_SRC=<local dependencies> node mobile/scripts/make-top.mjs factory-zone
Floor z ranges describe robot base altitude, half-open [lo, hi); stairs switch at z=2.
"""
import base64
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
import trimesh
from trimesh.transformations import quaternion_from_matrix

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from apps.simmgr.tools.collision_map import pose_matrix

SOURCE = ROOT / 'apps/simmgr/worlds/factory_zone'
TARGET = ROOT / 'mobile/sim/assets/factory-zone'


def write(name, value):
    (TARGET / name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def batch(parts):
    """World-space static geometry, one draw call per colour, with no floor cull."""
    groups = {}
    for vertices, faces, color, _ in parts:
        groups.setdefault(tuple(color), []).append((vertices, faces))
    scene = dict(meshes={}, models=[])
    for i, (color, items) in enumerate(sorted(groups.items())):
        vv, ff, offset = [], [], 0
        for v, f in items:
            vv.append(v); ff.append(f + offset); offset += len(v)
        v, indices = np.unique(np.round(np.concatenate(vv), 6), axis=0, return_inverse=True)
        f = indices[np.concatenate(ff)]
        key = f'color-{i}'
        scene['meshes'][key] = dict(p=v.flatten().tolist(), i=f.flatten().tolist())
        scene['models'].append(dict(name=key, mesh=key, pos=[0, 0, 0], quat=[1, 0, 0, 0], color=list(color)))
    return scene


def main():
    TARGET.mkdir(parents=True, exist_ok=True)
    xml = ET.Element('mujoco', model='factory-zone')
    body = ET.SubElement(xml, 'worldbody')
    parts = []
    for model in ET.parse(SOURCE / 'factory_zone.sdf').findall('.//model'):
        for link in model.findall('link'):
            transform = pose_matrix(model.find('pose')) @ pose_matrix(link.find('pose'))
            for kind in ('collision', 'visual'):
                for n, item in enumerate(link.findall(kind)):
                    t = transform @ pose_matrix(item.find('pose'))
                    shape = item.find('geometry')[0]
                    if shape.tag == 'box':
                        mesh = trimesh.creation.box(extents=np.fromstring(shape.findtext('size'), sep=' '))
                    elif shape.tag == 'mesh':
                        mesh = trimesh.load(SOURCE / shape.findtext('uri'), force='mesh', process=False)
                        mesh.apply_scale(np.fromstring(shape.findtext('scale', '1 1 1'), sep=' '))
                    else:
                        raise ValueError(f'Unsupported SDF geometry: {shape.tag}')
                    if kind == 'collision':
                        lo, hi = mesh.bounds
                        center = t[:3, :3] @ ((lo + hi) / 2) + t[:3, 3]
                        ET.SubElement(body, 'geom', name=f'{model.get("name")}_{link.get("name")}_{n}', group='1', type='box',
                            size=' '.join(f'{v:.8g}' for v in (hi - lo) / 2),
                            pos=' '.join(map(str, center)), quat=' '.join(map(str, quaternion_from_matrix(t))))
                    else:
                        # Preserve the previous phone budget for visual gravel only.
                        if len(mesh.faces) > 2000:
                            proxy = trimesh.creation.box(extents=mesh.extents)
                            proxy.apply_translation(mesh.bounds.mean(axis=0)); mesh = proxy
                        vertices = trimesh.transform_points(mesh.vertices, t)
                        color = list(map(float, item.findtext('material/diffuse', '0.5 0.55 0.6 1').split()))[:3]
                        parts.append((vertices, mesh.faces, color, link.get('name')))
    ET.indent(xml)
    ET.ElementTree(xml).write(TARGET / 'factory-zone.xml', encoding='utf-8', xml_declaration=True)
    scene = batch(parts)
    write('scene.json', scene)
    meta = json.loads((SOURCE / 'maps/metadata.json').read_text())
    floors, scenarios = [], []
    for floor, z, spawn, band in [('f1', 0, [2, 4, 0], [-1, 2]), ('f2', 2, [5.65, 4.65, 0], [2, 8])]:
        pixels = np.array(Image.open(SOURCE / f'maps/{floor}.png'))
        grid = dict(origin=meta['origin'], res=meta['resolution'], w=pixels.shape[1], h=pixels.shape[0])
        mapping = dict(**grid, floor_id=floor, floor_z=z, spawn_xyyaw=spawn, spawn_z=z + .4,
                       px=base64.b64encode(pixels.tobytes()).decode())
        write(f'map-{floor}.json', mapping)
        if floor == 'f1':
            write('map.json', mapping)  # Existing single-map consumer defaults to first-floor spawn.
        # Only the top photo is sliced. The live scene above always has every level.
        sliced = [p for p in parts if p[0][:, 2].min() <= z + 1.8
                  and (floor != 'f2' or p[0][:, 2].max() >= z - .21)
                  and (floor != 'f1' or p[0][:, 2].min() < 1.79)]
        write(f'scene-{floor}.json', batch(sliced))
        floor_routes = []
        for route in json.loads((SOURCE / f'scenarios-{floor}.json').read_text()):
            floor_routes.append(dict(id=f'{floor}-{route["id"]}', floor_id=floor, name=f'{1 if floor == "f1" else 2}층 · {route["name"]}',
                                     points=[dict(x=p['x'], y=p['y']) for p in route['waypoints']]))
        write(f'scenarios-{floor}.json', floor_routes)
        scenarios.extend(floor_routes)
        floors.append(dict(id=floor, name='1층' if floor == 'f1' else '2층', z=band, top=f'top-{floor}.png', map=grid,
                           image_sha256=meta['floors'][floor]['image_sha256'], map_file=f'map-{floor}.json', scenarios_file=f'scenarios-{floor}.json', floor_z=z, spawn_xyyaw=spawn))
    write('scenarios.json', scenarios)
    write('top.json', dict(floors=floors))  # make-top fills shared bounds/px/map and preserves floors.
    write('metadata.json', dict(draft=True, source='factory_zone', source_sha256=hashlib.sha256((SOURCE/'factory_zone.sdf').read_bytes()).hexdigest(),
        triangles=sum(len(p[1]) for p in parts), meshes=len(scene['meshes']), models=len(scene['models']), scene_bytes=(TARGET/'scene.json').stat().st_size,
        physics='One world, original SDF heights; exact boxes; rough meshes use conservative local AABB; both stairs and rails retained',
        floor_z_semantics='top.json floors.z: half-open robot-base altitude bands; f1 [-1,2), f2 [2,8); stairs switch at base z=2',
        readiness='draft; headless regression only; phone FPS and real robot unverified'))
    print(f'factory-zone: {len(parts)} visuals, {len(body)} collisions, {len(floors)} floors')


if __name__ == '__main__':
    main()

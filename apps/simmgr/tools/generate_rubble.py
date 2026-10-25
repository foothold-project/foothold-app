"""Seeded, original static rubble: no downloads, textures, or dynamic debris.

Run with system Python (numpy/Pillow/trimesh are used only by collision_map).
All geometry and placement are authored here; the two small OBJ primitives
include finite vertex normals for both collision and Ogre2 visuals.
"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import random
import xml.etree.ElementTree as ET

from apps.simmgr.tools.collision_normals import add_normals

SEED = 20261025
BOUNDS = [-10.0, -10.0, 10.0, 10.0]
SPAWN = [0.0, -6.0, 0.0]
BANDS = [('easy', -9.0, -3.0, .05), ('medium', -2.0, 3.0, .10),
         ('hard', 4.0, 9.0, .15)]


def numbers(values):
    return ' '.join(f'{v:.8f}' for v in values)


def primitive_obj(mound=False):
    """Closed 12-sided unit cylinder or low, two-slope mound, z=0..1."""
    count = 12
    rings = [(1., 0.), (.5 if mound else 1., .7 if mound else 1.)]
    vertices = [(r*math.cos(2*math.pi*i/count), r*math.sin(2*math.pi*i/count), z)
                for r, z in rings for i in range(count)]
    vertices += [(0, 0, 0), (0, 0, 1)]
    faces = []
    for i in range(count):
        j = (i+1) % count
        faces += [(i, j, count+j), (i, count+j, count+i),
                  (2*count, j, i), (2*count+1, count+i, count+j)]
    text = '# Original procedural rubble primitive; no external inputs.\n'
    text += ''.join('v '+numbers(v)+'\n' for v in vertices)
    text += ''.join('f '+' '.join(str(i+1) for i in f)+'\n' for f in faces)
    return add_normals(text)


def model(world, name, pose, geometry, colour):
    node = ET.SubElement(world, 'model', name=name)
    ET.SubElement(node, 'static').text = 'true'
    ET.SubElement(node, 'pose').text = numbers(pose)
    link = ET.SubElement(node, 'link', name='body')
    ET.SubElement(link, 'collision', name='solid').append(copy.deepcopy(geometry))
    visual = ET.SubElement(link, 'visual', name='visible')
    visual.append(copy.deepcopy(geometry))
    material = ET.SubElement(visual, 'material')
    for key in ('ambient', 'diffuse'):
        ET.SubElement(material, key).text = numbers([*colour, 1])
    ET.SubElement(material, 'specular').text = '0.05 0.05 0.05 1'


def box(size):
    geometry = ET.Element('geometry')
    ET.SubElement(ET.SubElement(geometry, 'box'), 'size').text = numbers(size)
    return geometry


def mesh(name, scale):
    geometry = ET.Element('geometry')
    node = ET.SubElement(geometry, 'mesh')
    ET.SubElement(node, 'uri').text = f'meshes/{name}.obj'
    ET.SubElement(node, 'scale').text = numbers(scale)
    return geometry


def generate_assets(output):
    output = Path(output)
    (output / 'meshes').mkdir(parents=True, exist_ok=True)
    for name in ('cylinder', 'mound'):
        (output / f'meshes/{name}.obj').write_text(primitive_obj(name == 'mound'))
    rng = random.Random(SEED)
    tree = ET.Element('sdf', version='1.9')
    world = ET.SubElement(tree, 'world', name='rubble')
    for filename, system in [('physics', 'Physics'), ('user-commands', 'UserCommands'),
                             ('scene-broadcaster', 'SceneBroadcaster'), ('sensors', 'Sensors'), ('imu', 'Imu')]:
        plugin = ET.SubElement(world, 'plugin', filename=f'gz-sim-{filename}-system',
                               name=f'gz::sim::systems::{system}')
        if system == 'Sensors':
            ET.SubElement(plugin, 'render_engine').text = 'ogre2'
    physics = ET.SubElement(world, 'physics', name='default_physics', type='ignored')
    ET.SubElement(physics, 'max_step_size').text = '0.001'
    ET.SubElement(physics, 'real_time_factor').text = '1'
    ET.SubElement(world, 'gravity').text = '0 0 -9.8'
    scene = ET.SubElement(world, 'scene')
    ET.SubElement(scene, 'ambient').text = '0.45 0.45 0.45 1'
    ET.SubElement(scene, 'background').text = '0.22 0.28 0.34 1'
    light = ET.SubElement(world, 'light', name='sun', type='directional')
    ET.SubElement(light, 'pose').text = '0 0 10 0 0 0'
    ET.SubElement(light, 'diffuse').text = '0.7 0.7 0.7 1'
    ET.SubElement(light, 'direction').text = '-0.3 0.2 -1'
    model(world, 'ground', [0, 0, -.1, 0, 0, 0], box([20, 20, .2]), [.28, .32, .29])
    for band, ymin, ymax, limit in BANDS:
        for row in range(3):
            for column, x in enumerate((-8., -6., -4., -2.8, 2.8, 4., 6., 8.)):
                y = ymin + .7 + row*(ymax-ymin-1.4)/2
                x, y = x+rng.uniform(-.18,.18), y+rng.uniform(-.12,.12)
                kind = ('box', 'plate', 'cylinder', 'mound')[(row+column) % 4]
                yaw = rng.uniform(-math.pi, math.pi)
                height = rng.uniform(.65, .95)*limit
                # Hard clusters are a static two-piece pile. Total top <=15cm.
                layers = 2 if band == 'hard' else 1
                for layer in range(layers):
                    top = height/layers
                    base = layer*top
                    pitch = 0.
                    if kind in ('box', 'plate'):
                        length = rng.uniform(.28, .45) if kind == 'plate' else rng.uniform(.25,.42)
                        width = rng.uniform(.20,.32)
                        pitch = math.radians(rng.uniform(5, 14)) if band == 'medium' and kind == 'plate' else 0.
                        # Scale thickness to the available vertical envelope.
                        if pitch:
                            length = min(length, top*.75/math.sin(pitch))
                        thickness = (top-length*abs(math.sin(pitch)))/math.cos(pitch)
                        geometry = box([length, width, thickness])
                        z = base+top/2
                    else:
                        radius = rng.uniform(.16,.27)
                        geometry = mesh(kind, [radius, radius, top])
                        z = base
                    colour = {'easy': [.50,.46,.36], 'medium': [.48,.38,.29], 'hard': [.37,.35,.34]}[band]
                    model(world, f'{band}_{row}_{column}_{kind}_{layer}',
                          [x+layer*.04, y, z, 0, pitch, yaw], geometry, colour)
    ET.indent(tree, space='  ')
    (output / 'rubble.sdf').write_text(ET.tostring(tree, encoding='unicode')+'\n')
    scenarios = [dict(id='easy-patrol', name='잔해 쉬움 띠 순찰', finish='RETURN_TO_START',
        waypoints=[dict(x=x, y=y, mission_name=f'쉬움 띠 · 지점 {i+1}')
                   for i, (x,y) in enumerate([(0.,-8.), (0.,-6.), (0.,-4.)])])]
    (output / 'scenarios.json').write_text(json.dumps(scenarios, ensure_ascii=False, indent=2)+'\n')
    return output / 'rubble.sdf'


def generate(output):
    from apps.simmgr.tools.collision_map import generate as collision_map
    world = generate_assets(output)
    collision_map(world, world.parent / 'maps', {'f1': 0.0}, .05, BOUNDS)
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(world_id='rubble', floor_id='f1', building_id='rubble', name='잔해 험지',
        description='직접 생성한 20×20m 정적 잔해. 쉬움 5cm·보통 10cm·어려움 15cm. v2 보행 정책 잔해 미시험: 넘어질 수 있음.',
        floor_z=0.0, spawn_xyyaw=SPAWN, spawn_z=.4, world='rubble/rubble.sdf',
        gt_map='rubble/maps/f1.yaml', map_metadata='rubble/maps/metadata.json', ledger_key='rubble/f1',
        height_source='static_sdf_collision', readiness='offline_prepared', native_supported=True,
        notes='private 실행 목록·서버 지도 명시 등록 필요. 로봇 보행·주행 미검증.', scenarios='rubble/scenarios.json',
        sha256=dict(world=digest(world), map=digest(world.parent/'maps/f1.yaml'),
                    metadata=digest(world.parent/'maps/metadata.json')),
        mesh_sha256={f'meshes/{name}.obj':digest(world.parent/f'meshes/{name}.obj') for name in ('cylinder','mound')})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--catalogue', type=Path, help='Explicitly update this catalogue entry only')
    args = parser.parse_args()
    entry = generate(args.output)
    if args.catalogue:
        catalog = json.loads(args.catalogue.read_text())
        catalog['worlds']['rubble/f1'] = entry
        args.catalogue.write_text(json.dumps(catalog, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(entry, ensure_ascii=False, indent=2))

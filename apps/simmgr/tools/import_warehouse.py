"""Offline, texture-free import of the pinned AWS no-roof warehouse.

Input is an unpacked upstream tree, not a running Gazebo resource directory.
Only the selected world's model SDFs and DAE geometry plus LICENSE are read.
The small COLLADA reader intentionally accepts only the pinned export dialect.
"""
import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np

UPSTREAM = 'https://github.com/aws-robotics/aws-robomaker-small-warehouse-world'
REVISION = 'ee0af733315e78432408c3cd98d378ecee5f767c'
NS = {'c': 'http://www.collada.org/2005/11/COLLADASchema'}
WORLD = 'worlds/no_roof_small_warehouse/no_roof_small_warehouse.world'


def collada_mesh(path):
    root = ET.parse(path).getroot()
    if root.findtext('c:asset/c:up_axis', namespaces=NS) != 'Z_UP':
        raise ValueError('only the pinned Z_UP COLLADA dialect is supported')
    unit = float(root.find('c:asset/c:unit', NS).get('meter'))
    geometries = {}
    for geo in root.findall('c:library_geometries/c:geometry', NS):
        mesh = geo.find('c:mesh', NS)
        sources = {}
        for source in mesh.findall('c:source', NS):
            stride = int(source.find('c:technique_common/c:accessor', NS).get('stride'))
            sources[source.get('id')] = np.fromstring(
                source.findtext('c:float_array', namespaces=NS), sep=' ').reshape(-1, stride)
        positions = {v.get('id'): sources[v.find('c:input[@semantic="POSITION"]', NS)
                                         .get('source')[1:]][:, :3]
                     for v in mesh.findall('c:vertices', NS)}
        chunks = []
        for item in mesh:
            kind = item.tag.rsplit('}', 1)[-1]
            if kind in ('source', 'vertices'):
                continue
            if kind != 'triangles':
                raise ValueError(f'unsupported COLLADA primitive: {kind}')
            inputs = item.findall('c:input', NS)
            width = max(int(i.get('offset')) for i in inputs) + 1
            vertex = item.find('c:input[@semantic="VERTEX"]', NS)
            indices = np.fromstring(item.findtext('c:p', namespaces=NS), sep=' ', dtype=int)
            indices = indices.reshape(-1, width)[:, int(vertex.get('offset'))]
            chunks.append(positions[vertex.get('source')[1:]][indices].reshape(-1, 3, 3))
        geometries[geo.get('id')] = np.concatenate(chunks)
    triangles = []

    def walk(node, parent):
        matrix = parent.copy()
        for child in node:
            kind = child.tag.rsplit('}', 1)[-1]
            if kind == 'matrix':
                matrix = matrix @ np.fromstring(child.text, sep=' ').reshape(4, 4)
            elif kind in ('translate', 'rotate', 'scale', 'lookat', 'skew', 'instance_node'):
                raise ValueError(f'unsupported COLLADA transform: {kind}')
        for instance in node.findall('c:instance_geometry', NS):
            vertices = geometries[instance.get('url')[1:]]
            triangles.append((vertices @ matrix[:3, :3].T + matrix[:3, 3]) * unit)
        for child in node.findall('c:node', NS):
            walk(child, matrix)

    scene_id = root.find('c:scene/c:instance_visual_scene', NS).get('url')[1:]
    scene = root.find(f'c:library_visual_scenes/c:visual_scene[@id="{scene_id}"]', NS)
    for node in scene.findall('c:node', NS):
        walk(node, np.eye(4))
    return np.concatenate(triangles)


def import_world(source, output):
    pinned = json.loads((Path(__file__).resolve().parents[1] /
                         'worlds/warehouse/sources.json').read_text())
    if pinned['revision'] != REVISION:
        raise ValueError('pinned input manifest revision mismatch')
    output.mkdir(parents=True, exist_ok=True)
    (output / 'meshes').mkdir(exist_ok=True)
    used = set()

    def read(relative):
        data = (source / relative).read_bytes()
        expected = pinned['inputs'][relative]
        if (hashlib.sha256(data).hexdigest() != expected['sha256'] or
                hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest() != expected['git_blob']):
            raise ValueError(f'upstream input does not match pinned revision: {relative}')
        used.add(relative)
        return source / relative

    license_path = read('LICENSE')
    (output / 'LICENSE').write_bytes(license_path.read_bytes())
    sdf = ET.Element('sdf', version='1.9')
    world = ET.SubElement(sdf, 'world', name='warehouse')
    for filename, system in [('physics', 'Physics'), ('user-commands', 'UserCommands'),
                             ('scene-broadcaster', 'SceneBroadcaster'), ('sensors', 'Sensors'),
                             ('imu', 'Imu')]:
        plugin = ET.SubElement(world, 'plugin', filename=f'gz-sim-{filename}-system',
                               name=f'gz::sim::systems::{system}')
        if system == 'Sensors':
            ET.SubElement(plugin, 'render_engine').text = 'ogre2'
    physics = ET.SubElement(world, 'physics', name='default_physics', type='ignored')
    ET.SubElement(physics, 'max_step_size').text = '0.001'
    ET.SubElement(physics, 'real_time_factor').text = '1'
    ET.SubElement(world, 'gravity').text = '0 0 -9.8'
    upstream = ET.parse(read(WORLD)).getroot().find('world')
    converted = set()
    for instance in upstream.findall('model'):
        model_name = instance.findtext('include/uri').removeprefix('model://')
        model = ET.SubElement(world, 'model', name=instance.get('name'))
        ET.SubElement(model, 'static').text = 'true'
        ET.SubElement(model, 'pose').text = instance.findtext('pose', '0 0 0 0 0 0')
        original = ET.parse(read(f'models/{model_name}/model.sdf')).getroot().find('model')
        short = model_name.removeprefix('aws_robomaker_warehouse_')
        for original_link in original.findall('link'):
            link = ET.SubElement(model, 'link', name=original_link.get('name'))
            if original_link.find('pose') is not None:
                ET.SubElement(link, 'pose').text = original_link.findtext('pose')
            for kind in ('collision', 'visual'):
                for original_part in original_link.findall(kind):
                    part = ET.SubElement(link, kind, name=original_part.get('name'))
                    if original_part.find('pose') is not None:
                        ET.SubElement(part, 'pose').text = original_part.findtext('pose')
                    mesh = original_part.find('geometry/mesh')
                    relative = mesh.findtext('uri').removeprefix('file://')
                    obj_name = f'{short}_{kind}.obj'
                    if obj_name not in converted:
                        triangles = collada_mesh(read(relative))
                        # Exact vertex deduplication; keep source triangle winding.
                        vertices, indices = np.unique(triangles.reshape(-1, 3), axis=0,
                                                      return_inverse=True)
                        with (output / 'meshes' / obj_name).open('w') as stream:
                            stream.write('# AWS warehouse; MIT-0; metres; Z up; texture-free\n')
                            for vertex in vertices:
                                stream.write('v ' + ' '.join(f'{v:.9g}' for v in vertex) + '\n')
                            for face in indices.reshape(-1, 3) + 1:
                                stream.write('f ' + ' '.join(str(v) for v in face) + '\n')
                        converted.add(obj_name)
                    target = ET.SubElement(ET.SubElement(part, 'geometry'), 'mesh')
                    ET.SubElement(target, 'uri').text = 'meshes/' + obj_name
                    ET.SubElement(target, 'scale').text = mesh.findtext('scale', '1 1 1')
                    if kind == 'visual':
                        material = ET.SubElement(part, 'material')
                        color = ('0.55 0.56 0.57 1' if 'Ground' in short else
                                 '0.7 0.72 0.75 1' if 'Wall' in short else '0.34 0.46 0.62 1')
                        ET.SubElement(material, 'ambient').text = color
                        ET.SubElement(material, 'diffuse').text = color
        # Friction uses Harmonic engine defaults, not Classic ODE-only fields.
    for light in upstream.findall('light'):
        for pose in light.findall('pose'):
            pose.attrib.clear()
        world.append(light)
    ET.indent(sdf)
    ET.ElementTree(sdf).write(output / 'warehouse.sdf', encoding='utf-8', xml_declaration=True)
    manifest = {'repository': UPSTREAM, 'branch': 'ros2', 'revision': REVISION,
                'license': 'MIT-0', 'inputs': {}}
    for relative in sorted(used):
        data = (source / relative).read_bytes()
        manifest['inputs'][relative] = {
            'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'git_blob': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()}
    (output / 'sources.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    import_world(args.source, args.output)

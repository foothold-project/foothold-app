"""Conservative GT corridor proof for the first, straight-only simulation test.

Checks every terrain collision, with rotated boxes and OBJ mesh bounding boxes.
Unknown geometry/transforms fail closed. Exact rectangle-union coverage of flat
floor boxes proves support throughout a conservative enclosing corridor.
"""
import hashlib
import itertools
import math
from pathlib import Path
from urllib.parse import unquote, urlparse
import xml.etree.ElementTree as ET

from constants import WORLD_ID, ROBOT_NAME, ROBOT_URI


def terrain_model(root):
    """Interpret the one own-robot include; reject unparsed physical structures."""
    worlds = root.findall('world')
    if root.tag != 'sdf' or set(root.attrib)-{'version'} or len(root) != 1 or len(worlds) != 1:
        raise ValueError('unverified SDF/world layout')
    world = worlds[0]
    allowed = {'physics', 'plugin', 'gravity', 'scene', 'light', 'model', 'include'}
    if set(world.attrib)-{'name'} or any(child.tag not in allowed for child in world):
        raise ValueError('unverified world structure')
    for plugin in world.findall('plugin'):
        if (plugin.get('filename'), plugin.get('name')) not in {
                ('gz-sim-physics-system', 'gz::sim::systems::Physics'),
                ('gz-sim-sensors-system', 'gz::sim::systems::Sensors')}:
            raise ValueError('unverified world plugin')
    models = world.findall('model')
    if len(models) != 1 or models[0].get('name') != WORLD_ID:
        raise ValueError('unverified world model layout')
    terrain = models[0]
    if (set(terrain.attrib)-{'name'} or terrain.findtext('static', '').strip() not in {'1', 'true'}
            or terrain.find('pose') is not None or any(child.tag not in {'static', 'link'} for child in terrain)):
        raise ValueError('unverified terrain transform/structure')
    if any(child.tag in {'model', 'include', 'frame'} for child in terrain.iter() if child is not terrain):
        raise ValueError('nested model/include/frame is not supported')
    includes = world.findall('include')
    if len(includes) > 1:
        raise ValueError('only the one own-robot include is supported')
    for include in includes:
        # Name alone is not sufficient: the URI and override grammar must match.
        if (include.attrib or sorted(c.tag for c in include) != ['name', 'pose', 'uri']
                or include.findtext('name') != ROBOT_NAME or include.findtext('uri') != ROBOT_URI
                or any(c.attrib for c in include)):
            raise ValueError('unverified include (only the known own robot is excluded)')
        pose = list(map(float, include.findtext('pose').split()))
        if len(pose) != 6 or not all(math.isfinite(v) for v in pose):
            raise ValueError('invalid robot include pose')
    return terrain


def rotation(pose):
    _, _, _, r, p, y = pose
    cr, sr, cp, sp, cy, sy = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(y), math.sin(y)
    return [[cy*cp, cy*sp*sr-sy*cr, cy*sp*cr+sy*sr],
            [sy*cp, sy*sp*sr+cy*cr, sy*sp*cr-cy*sr], [-sp, cp*sr, cp*cr]]


def covered(rectangle, floors):
    x0, x1, y0, y1 = rectangle
    xs = sorted({x0, x1, *(max(x0, min(x1, f[k])) for f in floors for k in (0, 1))})
    for a, b in zip(xs, xs[1:]):
        if b <= a:
            continue
        mid = (a+b)/2
        spans = sorted((f[2], f[3]) for f in floors if f[0] <= mid <= f[1])
        end = y0
        for lo, hi in spans:
            if lo > end + 1e-8:
                break
            end = max(end, hi)
        if end < y1 - 1e-8:
            return False
    return True


def prove(world, state):
    data = world.read_bytes()
    root = ET.fromstring(data)
    terrain = terrain_model(root)
    x, y, yaw = (state[k] for k in ('x', 'y', 'yaw'))
    z = state['z']
    if not all(math.isfinite(v) for v in (x, y, z, yaw)) or not .20 <= z <= .75:
        raise ValueError('invalid actual GT pose')
    # 3 m measured ahead of a 0.5 m front envelope, lateral envelope 0.6 m.
    # The world-axis enclosing rectangle is conservative for nonzero yaw.
    cs, sn = math.cos(yaw), math.sin(yaw)
    corners = [(x+f*cs-l*sn, y+f*sn+l*cs) for f in (-.5, 3.5) for l in (-.6, .6)]
    rectangle = (min(v[0] for v in corners), max(v[0] for v in corners),
                 min(v[1] for v in corners), max(v[1] for v in corners))
    floors, obstacles, hashes = [], [], {str(world): hashlib.sha256(data).hexdigest()}
    for link in terrain.findall('link'):
        if set(link.attrib)-{'name'} or any(c.tag not in {'collision', 'visual'} for c in link):
            raise ValueError('unverified link transform')
        for collision in link.findall('collision'):
            pose_el = collision.find('pose')
            if pose_el is not None and pose_el.attrib:
                raise ValueError('relative collision pose unsupported')
            pose = list(map(float, collision.findtext('pose', '0 0 0 0 0 0').split()))
            geom = collision.find('geometry')
            if len(pose) != 6 or not all(math.isfinite(v) for v in pose) or geom is None or len(geom) != 1:
                raise ValueError('unverified geometry')
            box = geom.findtext('box/size')
            if box:
                sizes = list(map(float, box.split()))
                if len(sizes) != 3 or not all(math.isfinite(v) and v > 0 for v in sizes):
                    raise ValueError('invalid box dimensions')
                points = list(itertools.product(*[(-s/2, s/2) for s in sizes]))
            elif geom.find('mesh') is not None:
                mesh = geom.find('mesh')
                if {e.tag for e in mesh} != {'uri'}:
                    raise ValueError('mesh scale or transform unsupported')
                uri = urlparse(mesh.findtext('uri'))
                if uri.scheme != 'file' or uri.netloc:
                    raise ValueError('mesh must be a readable local OBJ')
                path = Path(unquote(uri.path))
                if path.suffix != '.obj':
                    raise ValueError('unverified mesh format')
                raw = path.read_bytes()
                hashes[str(path)] = hashlib.sha256(raw).hexdigest()
                points = [list(map(float, line.split()[1:4])) for line in raw.decode().splitlines() if line.startswith('v ')]
            else:
                raise ValueError('unknown collision shape')
            if not points or any(len(v) != 3 or not all(math.isfinite(n) for n in v) for v in points):
                raise ValueError('empty collision')
            rot = rotation(pose)
            vertices = [[pose[i] + sum(rot[i][j]*v[j] for j in range(3)) for i in range(3)] for v in points]
            bounds = [(min(v[i] for v in vertices), max(v[i] for v in vertices)) for i in range(3)]
            if (box and max(abs(a) for a in pose[3:]) < 1e-6 and abs(bounds[2][1]) < .001):
                floors.append((*bounds[0], *bounds[1]))
            elif bounds[2][1] > .02:
                # Treat even overhead collision bounds as obstacles.
                if not (bounds[0][1] < rectangle[0] or bounds[0][0] > rectangle[1]
                        or bounds[1][1] < rectangle[2] or bounds[1][0] > rectangle[3]):
                    obstacles.append(collision.attrib.get('name'))
    ok = not obstacles and covered(rectangle, floors)
    return {'pass': ok, 'pose': [x, y, yaw], 'clearance_ahead_m': 3.0,
            'floor_z': 0.0, 'body_z': z, 'ignored_own_robot_include': ROBOT_NAME,
            'body_envelope_front_m': .5, 'lateral_half_width_m': .6,
            'conservative_world_rectangle': rectangle, 'obstacle_intersections': obstacles,
            'flat_support_complete': covered(rectangle, floors), 'source_sha256': hashes,
            'method': 'GT collision bounding boxes + exact union of flat support rectangles; no sensor free-space inference'}

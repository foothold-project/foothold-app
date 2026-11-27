"""foothold_building/1 배치 JSON -> 정적 SDF 1.9 월드 · 층별 지도 · 시나리오 · 목록 항목.

사용: python3 -m apps.simmgr.tools.import_building LAYOUT.json
입력은 rev 2 이상(계단 lane_gap · arrive 필수). rev 1 배치는 오류로 멈춘다.
입력 JSON 은 자료로만 읽는다. 모든 형상은 static box 이고 메쉬·텍스처·외부 URI 가 없다.
같은 입력이면 같은 바이트를 낸다. Gazebo/ROS 실행·다운로드 없음.

규칙
- 층 바닥판: 윗면 = floor_z, 두께 slab.t. poly 에서 holes 를 뺀 직교 다각형을 직사각형으로 나눈다.
- 벽: a->b 중심선, 두께 t, 높이 h, 양 끝을 t/2 늘려 모서리를 닫는다. 문은 s(=a 에서 문 가운데까지
  거리) · w · h 로 틈을 내고, 문 높이 위는 상인방 상자로 남긴다.
- 장애물: box [cx, cy, w(x), d(y), h] + yaw, 층 바닥에서 시작.
- 계단: 디딤 한 단마다 상자. 상자는 단 윗면에서 계단이 시작하는 층 바닥(floor_z)까지 채운 통짜라
  단 밑이 지도에서 막힌다(계단참도 같음). 단, 상자 가운데가 그 층 바닥판 구멍 위면(아래층 계단 위)
  두께 step_h 로만 두어 아래층 계단의 머리 공간을 막지 않는다. 첫 줄은 start(첫 단 앞 모서리 가운데)에서 yaw 방향으로
  오르고, 줄 사이마다 계단참(두 줄 폭 전체, 깊이 landing_d)을 둔다. 마지막 줄 뒤에는 계단참이 없고
  마지막 단 윗면 = 도착 층 floor_z 로 위층 바닥에 바로 닿는다. U_right/U_left 는 다음 줄을
  오른쪽/왼쪽 줄로 옮겨 반대 방향으로 오른다. 줄 사이 틈은 lane_gap(필수).
- 덮개: covers [{id, poly, z, t}] 는 그 층 바닥 기준 아랫면 z, 두께 t 인 판(계단실 지붕 등).
  poly 는 바닥판처럼 직사각형으로 나눈다.
- 도착: arrive {floor_id, xy}. 위층 스폰은 arrive xy 와 teleport yaw.
- 지붕: roof=true 인 층은 바로 위 층 바닥판이 천장이어야 한다(floor_z+ceil_h = 위층 바닥판 밑면).
  roof=false 인 꼭대기 층은 천장이 없고 외벽 높이(난간)를 그대로 쓴다.
"""
import argparse
import base64
import hashlib
import heapq
import json
import math
from pathlib import Path
import warnings
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
from scipy.ndimage import minimum_filter

from .collision_map import generate

ROOT = Path(__file__).resolve().parents[3]
WORLDS = ROOT / 'apps/simmgr/worlds'
MOBILE = ROOT / 'mobile/sim'
# 앱 시뮬 시나리오 다리 둘레 사각 반폭. 0.35 = mobile/scripts/scenario-selftest.mjs 값, 안 되는 층만
# 0.25 (#528 nav2 팽창 반경 자리) 로 내리고 시나리오 clearance_m 에 적는다.
ROUTE_HALVES = (0.35, 0.25)
SPAWN_BASE = 0.4  # factory_zone 과 같은 floor_z 위 몸통 기준 높이
RESOLUTION = 0.05
MARGIN = 1.0
COLORS = {
    'slab': '0.62 0.62 0.60', 'wall': '0.82 0.81 0.78', 'lintel': '0.82 0.81 0.78',
    'stair': '0.55 0.58 0.62', 'landing': '0.55 0.58 0.62',
    'pump': '0.20 0.42 0.62', 'compressor': '0.25 0.48 0.40', 'tank': '0.70 0.72 0.74',
    'pipe': '0.78 0.55 0.20', 'cabinet': '0.45 0.47 0.50', 'rack': '0.60 0.45 0.30',
    'valve': '0.75 0.20 0.18', 'fan': '0.50 0.52 0.55', 'mast': '0.35 0.35 0.38',
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def num(v):
    # 결정적이고 짧은 숫자 표기. -0 은 0 으로.
    text = f'{v:.6f}'.rstrip('0').rstrip('.')
    return '0' if text in ('-0', '') else text


def quarter(yaw):
    """yaw 가 직각 배수에 1e-3 rad 안이면 그 배수(0..3), 아니면 None.

    JSON 의 1.5708 같은 반올림 각을 그대로 쓰면 긴 벽이 지도에서 한 칸 기운다.
    """
    k = round(yaw / (math.pi / 2))
    return k % 4 if abs(yaw - k * math.pi / 2) < 1e-3 else None


def direction(yaw):
    k = quarter(yaw)
    if k is None:
        return math.cos(yaw), math.sin(yaw)
    return ((1, 0), (0, 1), (-1, 0), (0, -1))[k]


def inside(poly, x, y):
    c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def rectilinear(poly):
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if abs(x1 - x2) > 1e-9 and abs(y1 - y2) > 1e-9:
            raise ValueError('slab polygons must be axis-aligned')


def slab_rectangles(poly, holes):
    """poly - holes 를 겹치지 않는 직사각형 (x0, y0, x1, y1) 목록으로. 행 병합 뒤 같은 폭 세로 병합."""
    rectilinear(poly)
    for h in holes:
        rectilinear(h)
    xs = sorted({float(p[0]) for q in [poly, *holes] for p in q})
    ys = sorted({float(p[1]) for q in [poly, *holes] for p in q})
    rows = []
    for y0, y1 in zip(ys, ys[1:]):
        cy = (y0 + y1) / 2
        runs, start = [], None
        for x0, x1 in zip(xs, xs[1:]):
            cx = (x0 + x1) / 2
            filled = inside(poly, cx, cy) and not any(inside(h, cx, cy) for h in holes)
            if filled and start is None:
                start = x0
            if not filled and start is not None:
                runs.append((start, x0)); start = None
        if start is not None:
            runs.append((start, xs[-1]))
        rows.append((y0, y1, runs))
    result, open_ = [], {}
    for y0, y1, runs in rows:
        nxt = {}
        for run in runs:
            bottom = open_.pop(run)[0] if run in open_ and open_[run][1] == y0 else y0
            nxt[run] = (bottom, y1)
        for run, (b, t) in open_.items():
            result.append((run[0], b, run[1], t))
        open_ = nxt
    for run, (b, t) in open_.items():
        result.append((run[0], b, run[1], t))
    return sorted(result, key=lambda r: (r[1], r[0]))


class World:
    def __init__(self, name):
        self.root = ET.Element('sdf', version='1.9')
        self.world = ET.SubElement(self.root, 'world', name=name)
        for filename, plugin in [('gz-sim-physics-system', 'Physics'),
                                 ('gz-sim-user-commands-system', 'UserCommands'),
                                 ('gz-sim-scene-broadcaster-system', 'SceneBroadcaster')]:
            ET.SubElement(self.world, 'plugin', filename=filename, name='gz::sim::systems::' + plugin)
        sensors = ET.SubElement(self.world, 'plugin', filename='gz-sim-sensors-system',
                                name='gz::sim::systems::Sensors')
        ET.SubElement(sensors, 'render_engine').text = 'ogre2'
        ET.SubElement(self.world, 'plugin', filename='gz-sim-imu-system', name='gz::sim::systems::Imu')
        physics = ET.SubElement(self.world, 'physics', name='default_physics', type='ignored')
        ET.SubElement(physics, 'max_step_size').text = '0.001'
        ET.SubElement(physics, 'real_time_factor').text = '1'
        ET.SubElement(self.world, 'gravity').text = '0 0 -9.8'
        scene = ET.SubElement(self.world, 'scene')
        ET.SubElement(scene, 'ambient').text = '0.38 0.38 0.40 1'
        ET.SubElement(scene, 'background').text = '0.62 0.72 0.85 1'
        ET.SubElement(scene, 'shadows').text = 'true'
        sun = ET.SubElement(self.world, 'light', type='directional', name='sun')
        ET.SubElement(sun, 'cast_shadows').text = 'true'
        ET.SubElement(sun, 'pose').text = '0 0 60 0 0 0'
        ET.SubElement(sun, 'diffuse').text = '1 0.96 0.88 1'
        ET.SubElement(sun, 'specular').text = '0.3 0.3 0.3 1'
        ET.SubElement(sun, 'direction').text = '-0.45 0.4 -0.75'
        self.model = None
        self.names = set()
        self.boxes = []  # (이름, 가운데, 크기, yaw, 종류) · SDF 와 MJCF 가 같은 목록을 쓴다

    def lamp(self, name, x, y, z):
        light = ET.SubElement(self.world, 'light', type='point', name=name)
        ET.SubElement(light, 'pose').text = f'{num(x)} {num(y)} {num(z)} 0 0 0'
        ET.SubElement(light, 'diffuse').text = '1 0.97 0.9 1'
        ET.SubElement(light, 'specular').text = '0.2 0.2 0.2 1'
        att = ET.SubElement(light, 'attenuation')
        for tag, value in [('range', '14'), ('constant', '0.3'), ('linear', '0.05'), ('quadratic', '0.006')]:
            ET.SubElement(att, tag).text = value
        ET.SubElement(light, 'cast_shadows').text = 'false'

    def start_model(self, name):
        self.model = ET.SubElement(self.world, 'model', name=name)
        ET.SubElement(self.model, 'static').text = 'true'

    def box(self, name, centre, size, yaw=0.0, kind='wall'):
        if name in self.names:
            raise ValueError(f'duplicate link name {name}')
        if min(size) <= 1e-9:
            raise ValueError(f'empty box {name}')
        self.names.add(name)
        k = quarter(yaw)
        if k is not None:
            # 직각 회전은 크기 축을 바꾼 yaw 0 상자로 쓴다(지도·충돌이 축에 정확히 맞게).
            size = (size[1], size[0], size[2]) if k % 2 else tuple(size)
            yaw = 0.0
        self.boxes.append((name, tuple(centre), tuple(size), yaw, kind))
        link = ET.SubElement(self.model, 'link', name=name)
        ET.SubElement(link, 'pose').text = ' '.join(num(v) for v in (*centre, 0, 0, yaw))
        for tag in ('collision', 'visual'):
            part = ET.SubElement(link, tag, name=tag[0])
            geometry = ET.SubElement(ET.SubElement(part, 'geometry'), 'box')
            ET.SubElement(geometry, 'size').text = ' '.join(num(v) for v in size)
            if tag == 'visual':
                material = ET.SubElement(part, 'material')
                colour = COLORS.get(kind, COLORS['cabinet'])
                ET.SubElement(material, 'ambient').text = colour + ' 1'
                ET.SubElement(material, 'diffuse').text = colour + ' 1'
                ET.SubElement(material, 'specular').text = '0.1 0.1 0.1 1'

    def write(self, path):
        ET.indent(self.root)
        ET.ElementTree(self.root).write(path, encoding='utf-8', xml_declaration=True)


def add_walls(world, floor):
    z0 = floor['floor_z']
    walls = {w['id']: w for w in floor['walls']}
    doors = {}
    for door in floor['doors']:
        if door['wall'] not in walls:
            raise ValueError(f'door on unknown wall {door["wall"]}')
        doors.setdefault(door['wall'], []).append(door)
    for wall in floor['walls']:
        (ax, ay), (bx, by) = wall['a'], wall['b']
        length = math.hypot(bx - ax, by - ay)
        ux, uy = (bx - ax) / length, (by - ay) / length
        yaw = math.atan2(uy, ux)
        if quarter(yaw) is not None:
            ux, uy = direction(yaw)
        t, h = wall['t'], wall['h']
        gaps = sorted((d['s'] - d['w'] / 2, d['s'] + d['w'] / 2, d['h']) for d in doors.get(wall['id'], []))
        cursor = -t / 2
        pieces = []
        for lo, hi, dh in gaps:
            if lo < 0 or hi > length or lo < cursor - 1e-9:
                raise ValueError(f'door outside or overlapping on wall {wall["id"]}')
            if lo - cursor > 1e-9:
                pieces.append((cursor, lo, 0.0, h))
            if dh < h:
                pieces.append((lo, hi, dh, h))  # 상인방
            cursor = hi
        if length + t / 2 - cursor > 1e-9:
            pieces.append((cursor, length + t / 2, 0.0, h))
        for i, (lo, hi, zlo, zhi) in enumerate(pieces):
            mid = (lo + hi) / 2
            world.box(f'{wall["id"]}_{i}', (ax + ux * mid, ay + uy * mid, z0 + (zlo + zhi) / 2),
                      (hi - lo, t, zhi - zlo), yaw, 'lintel' if zlo > 0 else 'wall')


def add_stairs(world, stair, floor, to_floor):
    z0 = floor['floor_z']
    if 'lane_gap' not in stair or 'arrive' not in stair:
        raise ValueError(f'rev 2 이상 배치 필요: 계단 {stair["id"]} 에 lane_gap · arrive 가 없다')
    h, tread, width = stair['step_h'], stair['tread'], stair['width']
    gap = stair['lane_gap']
    if any(abs(a - b) > 1e-9 for a, b in zip(stair['arrive']['xy'], stair['teleport']['xyyaw'][:2])):
        warnings.warn(f'계단 {stair["id"]}: teleport xy {stair["teleport"]["xyyaw"][:2]} 와 '
                      f'arrive xy {stair["arrive"]["xy"]} 가 다르다. 위층 스폰은 arrive xy 를 쓴다')
    holes = [hole['poly'] for hole in floor['slab']['holes']]
    total = sum(stair['flights'])
    if abs(z0 + total * h - to_floor['floor_z']) > 1e-6:
        raise ValueError(f'stair {stair["id"]} rise does not reach {to_floor["floor_id"]}')
    if not stair['teleport']['floor_id'] == stair['arrive']['floor_id'] == to_floor['floor_id']:
        raise ValueError('teleport/arrive floor differs from stair destination')
    turn = {'U_right': 1, 'U_left': -1}[stair['turn']]
    yaw = stair['yaw']
    fx, fy = direction(yaw)
    rx, ry = fy, -fx  # 진행 방향 기준 오른쪽
    sx, sy = stair['start']
    second = turn * (width + gap)  # 둘째 줄 가로 중심
    span_lo, span_hi = min(0, second) - width / 2, max(0, second) + width / 2

    def solid(name, along, lateral, top, size, kind):
        x, y = sx + fx * along + rx * lateral, sy + fy * along + ry * lateral
        # 바닥판 위면 층 바닥까지 통짜, 구멍 위(아래층 계단 위)면 한 단 두께.
        bottom = top - h if any(inside(hole, x, y) for hole in holes) else z0
        world.box(name, (x, y, (top + bottom) / 2), (*size, top - bottom), yaw, kind)

    along, count = 0.0, 0
    for k, steps in enumerate(stair['flights']):
        sign = 1 if k % 2 == 0 else -1
        lateral = 0.0 if k % 2 == 0 else second
        for i in range(steps):
            count += 1
            centre = along + sign * (i + 0.5) * tread
            solid(f'{stair["id"]}_f{k}_s{i}', centre, lateral, z0 + count * h, (tread, width), 'stair')
        along += sign * steps * tread
        if k == len(stair['flights']) - 1:
            break  # 마지막 줄은 위층 바닥에 바로 닿는다
        landing = along + sign * stair['landing_d'] / 2
        solid(f'{stair["id"]}_land{k}', landing, (span_lo + span_hi) / 2, z0 + count * h,
              (stair['landing_d'], span_hi - span_lo), 'landing')


def compose(layout_path):
    """배치 JSON -> (자료, World). SDF · MJCF · 앱 장면이 모두 이 상자 목록에서 나온다."""
    layout_path = Path(layout_path)
    data = json.loads(layout_path.read_text())
    if data.get('schema') != 'foothold_building/1' or data.get('units') != 'm':
        raise ValueError('expected foothold_building/1 in metres')
    if data.get('rev', 1) < 2:
        raise ValueError('rev 2 이상 배치 필요 (계단 lane_gap · arrive)')
    world_id = data['building_id']
    floors = data['floors']
    by_id = {f['floor_id']: f for f in floors}
    if len(by_id) != len(floors):
        raise ValueError('duplicate floor id')
    for index, floor in enumerate(floors):
        above = floors[index + 1] if index + 1 < len(floors) else None
        if floor['roof']:
            if above is None or abs(floor['floor_z'] + floor['ceil_h'] - (above['floor_z'] - above['slab']['t'])) > 1e-6:
                raise ValueError(f'roof of {floor["floor_id"]} must be the slab of the floor above')
        elif above is not None:
            raise ValueError('only the top floor may be open to the sky')
    world = World(world_id)
    for floor in floors:
        for room in floor['rooms']:
            xs = [p[0] for p in room['poly']]; ys = [p[1] for p in room['poly']]
            if floor['roof']:
                world.lamp(f'lamp_{floor["floor_id"]}_{room["id"]}', (min(xs) + max(xs)) / 2,
                           (min(ys) + max(ys)) / 2, floor['floor_z'] + floor['ceil_h'] - 0.3)
    world.start_model(world_id)
    for floor in floors:
        z0, t = floor['floor_z'], floor['slab']['t']
        holes = [h['poly'] for h in floor['slab']['holes']]
        for i, (x0, y0, x1, y1) in enumerate(slab_rectangles(floor['slab']['poly'], holes)):
            world.box(f'{floor["floor_id"]}_slab_{i}', ((x0 + x1) / 2, (y0 + y1) / 2, z0 - t / 2),
                      (x1 - x0, y1 - y0, t), 0.0, 'slab')
        add_walls(world, floor)
        for cover in floor.get('covers', []):
            bottom = z0 + cover['z']
            for i, (x0, y0, x1, y1) in enumerate(slab_rectangles(cover['poly'], [])):
                world.box(f'{floor["floor_id"]}_cover_{cover["id"]}_{i}',
                          ((x0 + x1) / 2, (y0 + y1) / 2, bottom + cover['t'] / 2),
                          (x1 - x0, y1 - y0, cover['t']), 0.0, 'slab')
        for obstacle in floor['obstacles']:
            cx, cy, w, d, h = obstacle['box']
            world.box(f'{floor["floor_id"]}_{obstacle["id"]}', (cx, cy, z0 + h / 2), (w, d, h),
                      obstacle.get('yaw', 0.0), obstacle['kind'])
        for stair in floor['stairs']:
            if stair['from'] != floor['floor_id']:
                raise ValueError('stair listed on a floor it does not start from')
            add_stairs(world, stair, floor, by_id[stair['to']])
    return data, world


def build(layout_path, out):
    data, world = compose(layout_path)
    out.mkdir(parents=True, exist_ok=True)
    world.write(out / f'{data["building_id"]}.sdf')
    return data


def spawns(data):
    """층마다 (스폰 xyyaw, 출처). 시작 층은 JSON spawn, 나머지는 그 층에 닿는 계단 arrive xy + teleport yaw."""
    arrivals = {s['arrive']['floor_id']: (s['id'], [*s['arrive']['xy'], s['teleport']['xyyaw'][2]])
                for f in data['floors'] for s in f['stairs']}
    result = {}
    for floor in data['floors']:
        fid = floor['floor_id']
        if data['spawn']['floor_id'] == fid:
            result[fid] = (list(data['spawn']['xyyaw']), 'layout JSON spawn')
        else:
            stair_id, spawn = arrivals[fid]
            result[fid] = (list(spawn), f'layout JSON stairs {stair_id} arrive xy + teleport yaw')
    return result


def mjcf(world, model):
    """World 상자 목록 -> MuJoCo 정적 geom(box, group 1). 크기는 반폭, quat = w x y z."""
    root = ET.Element('mujoco', model=model)
    body = ET.SubElement(root, 'worldbody')
    for name, centre, size, yaw, kind in world.boxes:
        ET.SubElement(body, 'geom', name=name, group='1', type='box',
                      size=' '.join(num(v / 2) for v in size), pos=' '.join(num(v) for v in centre),
                      quat=' '.join(num(v) for v in (math.cos(yaw / 2), 0, 0, math.sin(yaw / 2))))
    ET.indent(root)
    return ET.ElementTree(root)


def box_mesh(centre, size, yaw):
    corners = np.array([[sx, sy, sz] for sx in (-.5, .5) for sy in (-.5, .5) for sz in (-.5, .5)]) * size
    c, s = math.cos(yaw), math.sin(yaw)
    vertices = corners @ np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]]) + centre
    faces = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
                      [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])
    return vertices, faces


def batch(boxes):
    """상자를 색마다 한 메시로(폰 그리기 횟수 줄이기). mobile/scripts/factory-one.py batch 와 같은 꼴."""
    groups = {}
    for name, centre, size, yaw, kind in boxes:
        groups.setdefault(COLORS.get(kind, COLORS['cabinet']), []).append(box_mesh(centre, size, yaw))
    scene = dict(meshes={}, models=[])
    for i, (colour, parts) in enumerate(sorted(groups.items())):
        vv, ff, offset = [], [], 0
        for v, f in parts:
            vv.append(v); ff.append(f + offset); offset += len(v)
        v, index = np.unique(np.round(np.concatenate(vv), 6), axis=0, return_inverse=True)
        f = index.reshape(-1)[np.concatenate(ff)]
        key = f'color-{i}'
        scene['meshes'][key] = dict(p=[float(num(x)) for x in v.flatten()], i=f.flatten().tolist())
        scene['models'].append(dict(name=key, mesh=key, pos=[0, 0, 0], quat=[1, 0, 0, 0],
                                    color=[float(x) for x in colour.split()]))
    return scene


def route(pixels, meta, start, points, half):
    """스폰에서 배치 지점을 순서대로 잇는 곧은 다리 목록.

    다리마다 둘레 half 사각이 free 칸 안. A*(4 이웃) 뒤 보이는 데까지 줄인다. 배치 지점은 그대로 남기고 사이에 꺾는 점을 더한다.
    """
    res = meta['resolution']
    ox, oy, _ = meta['origin']
    h, w = pixels.shape
    r = round(half / res)
    safe = minimum_filter(pixels == 254, size=2 * r + 1, mode='constant', cval=False)

    def cell(x, y):
        return h - 1 - math.floor((y - oy) / res), math.floor((x - ox) / res)

    def centre(rc):
        return round(ox + (rc[1] + .5) * res, 4), round(oy + (h - rc[0] - .5) * res, 4)

    offsets = np.arange(-half, half + 1e-3, res)

    def visible(a, b):
        # scenario-selftest 와 같은 표본: 반 칸 간격, 둘레 사각 한 칸 간격.
        n = max(1, math.ceil(math.dist(a, b) / (res / 2)))
        k = np.arange(n + 1) / n
        x = (a[0] + (b[0] - a[0]) * k)[:, None, None] + offsets[None, :, None]
        y = (a[1] + (b[1] - a[1]) * k)[:, None, None] + offsets[None, None, :]
        rr = h - 1 - np.floor((y - oy) / res).astype(int)
        cc = np.floor((x - ox) / res).astype(int)
        rr, cc = np.broadcast_arrays(rr, cc)
        inside_ = (rr >= 0) & (rr < h) & (cc >= 0) & (cc < w)
        return bool(inside_.all() and (pixels[rr, cc] == 254).all())

    def astar(a, b):
        queue, cost, prev = [(0, a)], {a: 0}, {}
        while queue:
            _, cur = heapq.heappop(queue)
            if cur == b:
                path = [b]
                while path[-1] != a:
                    path.append(prev[path[-1]])
                return path[::-1]
            for dr, dc in ((0, 1), (1, 0), (0, -1), (-1, 0)):
                nxt = (cur[0] + dr, cur[1] + dc)
                if 0 <= nxt[0] < h and 0 <= nxt[1] < w and safe[nxt] and cost[cur] + 1 < cost.get(nxt, math.inf):
                    cost[nxt] = cost[cur] + 1; prev[nxt] = cur
                    heapq.heappush(queue, (cost[nxt] + abs(nxt[0] - b[0]) + abs(nxt[1] - b[1]), nxt))
        raise ValueError(f'no clear route to {centre(b)}')

    result, here = [], tuple(start)
    for target in points:
        target = tuple(target)
        if target == here:
            continue  # 길이 0 다리 없음(앱 시나리오 표본이 0 으로 나뉜다). 스폰 자리 지점은 이미 지났다.
        for xy in (here, target):
            if not visible(xy, xy):
                raise ValueError(f'route point {xy} lacks {half} m clearance')
        if not visible(here, target):
            # 셀 중심을 잇는 길: 출발 · 도착 자리는 실제 좌표로 바꿔 두고 보이는 데까지 건너뛴다.
            path = [here] + [centre(rc) for rc in astar(cell(*here), cell(*target))[1:-1]] + [target]
            i = 0
            while i < len(path) - 1:
                j = len(path) - 1
                while j > i + 1 and not visible(path[i], path[j]):
                    j -= 1
                if not visible(path[i], path[j]):
                    raise ValueError(f'route leg {path[i]} -> {path[j]} not clear')
                if j < len(path) - 1:
                    result.append(path[j])
                i = j
        result.append(target)
        here = target
    return [dict(x=x, y=y) for x, y in result]


def mobile_assets(layout_path, out, target):
    """앱 시뮬(mobile/sim) 월드 한 벌: <id>.xml · scene(-층).json · map(-층).json · scenarios(-층).json ·
    top.json floors · metadata.json. out 은 지도(maps/) 가 이미 있는 서버 월드 폴더.
    top.png · top-<층>.png 와 top.json bounds/px/map 은 mobile/scripts/make-top.mjs 가 채운다."""
    data, world = compose(layout_path)
    world_id = data['building_id']
    mobile_id = world_id.replace('_', '-')
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)

    def write(name, value):
        (target / name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')

    mjcf(world, mobile_id).write(target / f'{mobile_id}.xml', encoding='utf-8', xml_declaration=True)
    scene = batch(world.boxes)
    write('scene.json', scene)
    meta = json.loads((Path(out) / 'maps/metadata.json').read_text())
    starts = spawns(data)
    floors = []
    for index, floor in enumerate(data['floors']):
        fid, z = floor['floor_id'], floor['floor_z']
        above = data['floors'][index + 1]['floor_z'] if index + 1 < len(data['floors']) else z + 6
        band = [-1 if index == 0 else z, above]
        pixels = np.array(Image.open(Path(out) / 'maps' / f'{fid}.png'))
        grid = dict(origin=meta['origin'], res=meta['resolution'], w=pixels.shape[1], h=pixels.shape[0])
        spawn = starts[fid][0]
        write(f'map-{fid}.json', dict(**grid, floor_id=fid, floor_z=z, spawn_xyyaw=spawn,
                                      spawn_z=round(z + SPAWN_BASE, 6),
                                      px=base64.b64encode(pixels.tobytes()).decode()))
        # 위에서 본 사진만 층으로 자른다(그 층 바닥판 ~ 바닥 위 1.8 m). 실제 장면은 모든 층.
        sliced = [b for b in world.boxes
                  if b[1][2] - b[2][2] / 2 <= z + 1.8 and b[1][2] + b[2][2] / 2 >= z - .21]
        write(f'scene-{fid}.json', batch(sliced))
        short = floor['name'].split(' · ')[0]
        for half in ROUTE_HALVES:
            try:
                points = route(pixels, meta, spawn[:2], [p['xy'] for p in floor['points']], half)
                break
            except ValueError:
                if half == ROUTE_HALVES[-1]:
                    raise
        write(f'scenarios-{fid}.json', [dict(
            id=f'{fid}-inspection', floor_id=fid, name=f'{short} · {data["name"]} 점검 순회 · 초안',
            clearance_m=half, points=points)])
        floors.append(dict(id=fid, name=short, z=band, top=f'top-{fid}.png', map=grid,
                           image_sha256=meta['floors'][fid]['image_sha256'], map_file=f'map-{fid}.json',
                           scenarios_file=f'scenarios-{fid}.json', floor_z=z, spawn_xyyaw=spawn))
    first = data['floors'][0]['floor_id']
    (target / 'map.json').write_bytes((target / f'map-{first}.json').read_bytes())
    (target / 'scenarios.json').write_bytes((target / f'scenarios-{first}.json').read_bytes())
    top = target / 'top.json'
    previous = json.loads(top.read_text()) if top.exists() else {}
    write('top.json', {**{k: v for k, v in previous.items() if k != 'floors'}, 'floors': floors})
    write('metadata.json', dict(
        draft=True, source=f'{world_id}/layout.json',
        source_sha256=digest(Path(layout_path)), sdf_sha256=digest(Path(out) / f'{world_id}.sdf'),
        generator='apps/simmgr/tools/import_building.py mobile_assets',
        geoms=len(world.boxes), triangles=12 * len(world.boxes), meshes=len(scene['meshes']),
        models=len(scene['models']), scene_bytes=(target / 'scene.json').stat().st_size,
        physics='SDF 와 같은 상자 목록 · 모든 geom 정적 box · 층 높이 그대로 한 월드 · 계단 통짜 상자',
        floor_z_semantics='top.json floors.z: 몸 높이 반열린 띠 [아래, 위) · 위층 floor_z 에서 바뀜',
        readiness='draft; MuJoCo 컴파일 · 바닥 광선만 시험; 계단 보행 · 폰 FPS 미확인'))
    return floors


def register(layout_path, out=None):
    layout_path = Path(layout_path)
    raw = layout_path.read_bytes()
    data = json.loads(raw)
    world_id, rev = data['building_id'], data.get('rev_note') or data.get('rev', 1)
    out = Path(out) if out else WORLDS / world_id
    out.mkdir(parents=True, exist_ok=True)
    # 시험·재생성이 저장소 밖 원본 없이 돌도록 입력을 바이트 그대로 둔다.
    (out / 'layout.json').write_bytes(raw)
    write_json(out / 'sources.json', dict(
        revision=f'{world_id}-rev{rev}', author='app-design-lx 세션', draft=True,
        generated=True, imported='2026-11-28', schema=data['schema'],
        inputs={f'{world_id}.json': hashlib.sha256(raw).hexdigest()},
        copy='layout.json (입력 바이트 그대로)',
        generator='apps/simmgr/tools/import_building.py',
        conversion=f'모든 형상 static box. 바닥판 = poly - holes 직사각형 분할, 벽 문틈 + 상인방, 장애물 box+yaw, 덮개 판(covers), '
                   '계단 단마다 통짜 상자(구멍 위는 한 단 두께) + 줄 사이 계단참(마지막 줄 뒤 없음). 메쉬·텍스처 없음.'))
    (out / 'NOTICE').write_text(
        f'{data["name"]} ({world_id}) · 초안\n'
        f'출처: app-design-lx 세션 배치 JSON rev {rev} (schema foothold_building/1).\n'
        '생성: apps/simmgr/tools/import_building.py 가 JSON 에서 만든 정적 상자 월드. 원본 메쉬·텍스처 없음.\n'
        '입력 해시는 sources.json, 입력 사본은 layout.json.\n'
        '실행 · 보행 · 계단 오르기 · Gazebo/MuJoCo · 센서 미검증. 층 이동은 첫 판 순간 이동(teleport) 전제.\n')
    data = build(layout_path, out)
    floors = {f['floor_id']: f['floor_z'] for f in data['floors']}
    xmax, ymax = data['footprint']
    bounds = [-MARGIN, -MARGIN, xmax + MARGIN, ymax + MARGIN]
    generate(out / f'{world_id}.sdf', out / 'maps', floors, resolution=RESOLUTION, bounds=bounds)
    catalogue_path = WORLDS / 'worlds.json'
    catalogue = json.loads(catalogue_path.read_text())
    starts = spawns(data)
    for level, floor in enumerate(data['floors'], 1):
        fid = floor['floor_id']
        points = [dict(x=p['xy'][0], y=p['xy'][1], yaw=p['yaw'],
                       mission_name=f'{world_id}-{p["id"]} · {p["name"]}') for p in floor['points']]
        scenarios = [dict(id=f'{fid}-inspection', name=f'{data["name"]} {floor["name"].split(" · ")[0]} 점검 순회 · 초안',
                          finish='RETURN_TO_START', waypoints=points)]
        write_json(out / f'scenarios-{fid}.json', scenarios)
        spawn, source = starts[fid]
        rel = lambda p: f'{world_id}/{p}'
        catalogue['worlds'][f'{world_id}/{fid}'] = dict(
            world_id=world_id, floor_id=fid, building_id=world_id, name=data['name'] + ' · 초안',
            floor_name=floor['name'], level=level,
            description=f'{data["name"]} 배치 JSON rev {rev} 생성 {len(data["floors"])}층 실내 정적 월드. 실제 실행 미검증.',
            floor_z=floor['floor_z'], spawn_xyyaw=list(spawn),
            spawn_z=round(floor['floor_z'] + SPAWN_BASE, 6), spawn_source=source,
            world=rel(f'{world_id}.sdf'), gt_map=rel(f'maps/{fid}.yaml'), map_metadata=rel('maps/metadata.json'),
            ledger_key=f'{world_id}/{fid}', height_source='static_sdf_collision',
            readiness='offline_prepared', native_supported=False,
            notes='실행 · 보행 · 계단 미검증. 층 이동은 순간 이동 전제. 서버 실행 adapter의 새 ID/floor binding 연결 필요.',
            scenarios=rel(f'scenarios-{fid}.json'),
            sha256=dict(world=digest(out / f'{world_id}.sdf'), map=digest(out / 'maps' / f'{fid}.yaml'),
                        metadata=digest(out / 'maps/metadata.json')),
            mesh_sha256={})
    write_json(catalogue_path, catalogue)
    mobile_id = world_id.replace('_', '-')
    mobile_assets(out / 'layout.json', out, MOBILE / 'assets' / mobile_id)
    maps_path = MOBILE / 'maps.json'
    maps = json.loads(maps_path.read_text())
    if not any(m['id'] == mobile_id for m in maps):
        maps.append(dict(id=mobile_id, name=data['name'] + ' · 초안'))
        write_json(maps_path, maps)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('layout', type=Path)
    args = parser.parse_args()
    register(args.layout)

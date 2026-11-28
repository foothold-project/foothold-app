"""공장 터 (factory_site): 시안 3D (glb) -> 정적 상자 월드 · 지도 · 시나리오 · 앱 시뮬 자산.

사용: python -m apps.simmgr.tools.import_site            (worlds/factory_site/models/factory_site.glb 를 읽음)
glb 는 커밋하지 않는다 (models/ 는 git 무시). sources.json 의 SHA 와 같아야 만든다.

좌표 (design.json transform): 생성기 SVG 의 m (u, v, v 는 남쪽으로 커짐) 를 그대로 쓰고 y 만 뒤집는다.
  세계 x = u, y = -v, z = 높이.  glb 는 glTF (x, y, z) -> 세계 (x, -z, y).  시안 그림 px -> u = (px - 25) / 3.5.
지도: 원점 (0, -560), 0.5 m 칸, 1800 x 1120.

규칙
- 걷는 면 (fk_road · fk_pave · fk_dikefloor, 높이 0.1 m 이하) 은 땅으로 본다. 물리는 땅 상자 하나 (윗면 z = 0).
- 나머지 덩어리는 이어진 조각마다 collision_map 과 같은 몸 높이 띠 (0.05~0.6 m) 로 지도에 굽는다.
  닫힌 조각은 그대로, 열린 조각은 볼록 껍질 (탱크 · 플레어 원). 금지 구역 바닥 (fk_nogo_floor) 도 막힘.
  6 m 위 배관 (fk_pipe) 처럼 띠에 닿지 않는 것은 지나갈 수 있다.
- 시작 위치에서 이어지지 않는 빈칸 (건물 · 방류벽 안) 은 막힘으로 채운다.
- 막힌 칸을 직사각형으로 묶어 높이 1 m 상자로 둔다 (칸 경계에서 1 cm 안쪽). SDF · MJCF · 앱 장면이 같은 상자 목록을 쓰고,
  SDF 를 collision_map 으로 다시 굽은 지도가 위 격자와 같아야 한다.
"""
import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import struct

import numpy as np
from PIL import Image
from scipy.ndimage import label
import trimesh

from .collision_map import FREE, OCCUPIED, Collision, generate, raster_floor
from .import_building import MOBILE, SPAWN_BASE, WORLDS, World, batch, digest, mjcf, route, write_json

WORLD_ID = 'factory_site'
MOBILE_ID = 'factory-site'
FLOOR = 'f1'
OUT = WORLDS / WORLD_ID
GLB = OUT / 'models/factory_site.glb'
# 서버 3D 모형: 원본 GLB 에 없던 f1_floor 평면 (윗면 z -0.005 m, 지도 0~900 x 0~560 m) 을 더해 다시 내보낸 것 (app-lx 11/28 15:03).
# sim_maps.check_model_frame 은 `<floor>_floor` 마디를 요구한다. 없으면 worlds.json 에 model 을 적지 않는다
MODEL = OUT / 'models/factory_site_f1floor.glb'
MODEL_NOTE = ' 3D 모형은 원본에 없던 f1_floor 평면을 더해 다시 내보낸 것.'
RESOLUTION = 0.5
BOUNDS = (0.0, -560.0, 900.0, 0.0)
SURFACE = ('fk_road', 'fk_pave', 'fk_dikefloor')  # 걷는 면: 땅으로 본다
KINDS = {'fk_nogo_floor': 'valve', 'fk_nogo_fence': 'valve', 'fk_nogo_post': 'valve',
         'fk_tank': 'tank', 'fk_tankroof': 'tank', 'fk_building': 'wall', 'fk_wall': 'wall'}
PRIORITY = ('valve', 'tank', 'wall', 'cabinet')  # 한 칸에 여럿이면 앞의 것 색
BOX_H = 1.0
INSET = 0.01
SPEED = 0.5  # 시나리오 예상 시간 기준 m/s
CLEARANCE = 0.5  # 서버 프리셋 지점 여유 (sim_maps.check_clearance)
BODY_HALF = 0.45  # Go2 몸 (0.70 x 0.31 m) 반대각 0.38 m 에 여유를 더한 반지름
VIA_M = 40.0  # 경유 지점 간격 (길 위 거리). agent nav_timeout_s 120 s 안 (0.5 m/s 로 80 s)
COMPONENT_TYPES = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}


def read_glb(path):
    """glb -> {노드 이름: (세계 꼭짓점 Nx3, 면 Mx3)}. 노드 변환 · 희소 접근자는 받지 않는다."""
    data = Path(path).read_bytes()
    if data[:4] != b'glTF' or struct.unpack_from('<I', data, 4)[0] != 2:
        raise ValueError('not a glTF 2 binary')
    length, kind = struct.unpack_from('<II', data, 12)
    if kind != 0x4E4F534A:
        raise ValueError('first GLB chunk is not JSON')
    gltf = json.loads(data[20:20 + length])
    offset = 20 + length
    blob_length, blob_kind = struct.unpack_from('<II', data, offset)
    if blob_kind != 0x004E4942:
        raise ValueError('second GLB chunk is not BIN')
    blob = data[offset + 8:offset + 8 + blob_length]

    def accessor(index, width):
        a = gltf['accessors'][index]
        view = gltf['bufferViews'][a['bufferView']]
        dtype = np.dtype(COMPONENT_TYPES[a['componentType']])
        if 'sparse' in a or view.get('byteStride', width * dtype.itemsize) != width * dtype.itemsize:
            raise ValueError('sparse or strided accessor')
        start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
        return np.frombuffer(blob, dtype, a['count'] * width, start).reshape(-1, width)

    result = {}
    for node in gltf['nodes']:
        if any(k in node for k in ('matrix', 'translation', 'rotation', 'scale', 'children')):
            raise ValueError(f'node transform not supported: {node.get("name")}')
        vertices, faces, base = [], [], 0
        for primitive in gltf['meshes'][node['mesh']]['primitives']:
            if primitive.get('mode', 4) != 4:
                raise ValueError('only triangle primitives')
            v = accessor(primitive['attributes']['POSITION'], 3).astype(np.float64)
            f = accessor(primitive['indices'], 1).astype(np.int64).reshape(-1, 3)
            vertices.append(v); faces.append(f + base); base += len(v)
        v = np.concatenate(vertices)
        result[node['name']] = (np.c_[v[:, 0], -v[:, 2], v[:, 1]], np.concatenate(faces))
    return result


def design_to_world(px, py, transform):
    """시안 그림 px -> 세계 (x, y) m."""
    (ox, oy), k = transform['origin_px'], transform['px_per_m']
    return round((px - ox) / k, 4), round(-(py - oy) / k, 4)


def area_zones(design):
    """시안 구역 (px 다각형) -> 서버 MapZone (AREA, 세계 m). 세계 구역 정본 zones-f1.json 이 이 값."""
    return [{'id': z['id'], 'type': 'AREA', 'name': z['name'],
             'polygon': [list(design_to_world(px, py, design['transform'])) for px, py in z['px']]}
            for z in design['zones_svg_px']]


def world_cell(x, y, h=None):
    """세계 (x, y) -> 지도 (행, 열). 행 0 = 위쪽 (PNG)."""
    h = h or round((BOUNDS[3] - BOUNDS[1]) / RESOLUTION)
    return h - 1 - math.floor((y - BOUNDS[1]) / RESOLUTION), math.floor((x - BOUNDS[0]) / RESOLUTION)


def site_grid(meshes, start):
    """glb 덩어리 -> (픽셀, 종류 격자). 픽셀은 collision_map 값 (0 막힘 · 254 빈칸)."""
    ground = trimesh.creation.box((BOUNDS[2] - BOUNDS[0], BOUNDS[3] - BOUNDS[1], 1.0))
    ground.apply_translation(((BOUNDS[0] + BOUNDS[2]) / 2, (BOUNDS[1] + BOUNDS[3]) / 2, -0.5))
    shape = (round((BOUNDS[3] - BOUNDS[1]) / RESOLUTION), round((BOUNDS[2] - BOUNDS[0]) / RESOLUTION))
    occupied = np.zeros(shape, bool)
    kinds = np.full(shape, len(PRIORITY), np.uint8)  # 없음
    for name, (vertices, faces) in sorted(meshes.items()):
        if name in SURFACE:
            continue
        parts = []
        for part in trimesh.Trimesh(vertices, faces, process=True).split(only_watertight=False):
            if part.bounds[0, 2] > 0.6 or part.bounds[1, 2] < 0.05:
                continue  # 몸 높이 띠에 닿지 않음 (6 m 위 배관 등)
            closed = part.is_watertight and part.is_winding_consistent
            parts.append(Collision(part if closed else part.convex_hull, True))
        if not parts:
            continue
        pixels = raster_floor(parts + [Collision(ground, True)], BOUNDS, RESOLUTION, 0.0)
        mask = pixels == OCCUPIED
        occupied |= mask
        rank = PRIORITY.index(KINDS.get(name, 'cabinet'))
        kinds[mask] = np.minimum(kinds[mask], rank)
    free = ~occupied
    labels, _ = label(free)
    keep = labels[world_cell(*start, shape[0])]
    if keep == 0:
        raise ValueError(f'start {start} is not free')
    enclosed = free & (labels != keep)
    kinds[enclosed] = PRIORITY.index('wall')
    pixels = np.where(free & ~enclosed, FREE, OCCUPIED).astype(np.uint8)
    return pixels, kinds


def rectangles(mask):
    """막힌 칸 -> 겹치지 않는 직사각형 (행0, 열0, 행1, 열1) 목록 (끝 제외). 탐욕: 가로로 길게, 그 폭으로 아래로."""
    todo = mask.copy()
    result = []
    h, w = mask.shape
    for r in range(h):
        c = 0
        row = todo[r]
        while c < w:
            if not row[c]:
                nz = np.flatnonzero(row[c:])
                if not len(nz):
                    break
                c += int(nz[0])
                continue
            end = c + int(np.argmin(np.append(row[c:], False)))
            bottom = r + 1
            while bottom < h and todo[bottom, c:end].all():
                bottom += 1
            todo[r:bottom, c:end] = False
            result.append((r, c, bottom, end))
            c = end
    return result


def compose(pixels, kinds):
    world = World(WORLD_ID)
    world.start_model(WORLD_ID)
    w, d = BOUNDS[2] - BOUNDS[0], BOUNDS[3] - BOUNDS[1]
    world.box('ground', ((BOUNDS[0] + BOUNDS[2]) / 2, (BOUNDS[1] + BOUNDS[3]) / 2, -0.1), (w, d, 0.2), 0.0, 'slab')
    h = pixels.shape[0]
    count = 0
    for rank, kind in enumerate(PRIORITY):
        mask = (pixels == OCCUPIED) & (np.minimum(kinds, len(PRIORITY) - 1) == rank)
        for r0, c0, r1, c1 in rectangles(mask):
            x0, x1 = BOUNDS[0] + c0 * RESOLUTION, BOUNDS[0] + c1 * RESOLUTION
            y0, y1 = BOUNDS[1] + (h - r1) * RESOLUTION, BOUNDS[1] + (h - r0) * RESOLUTION
            world.box(f'b{count}', ((x0 + x1) / 2, (y0 + y1) / 2, BOX_H / 2),
                      (x1 - x0 - 2 * INSET, y1 - y0 - 2 * INSET, BOX_H), 0.0, kind)
            count += 1
    return world


def heading(a, b):
    return round(math.atan2(b[1] - a[1], b[0] - a[0]), 4)


def polyline_length(points):
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def place(design, pid):
    item = next(p for p in design['places'] if p['id'] == pid)
    return design_to_world(*item['px'], design['transform']), item['name']


def svg_world(u, v):
    return round(float(u), 4), round(-float(v), 4)


def route_points(design):
    """경로마다 (항목, [(x, y, 이름)], 상태). 시안 경로 (u5_3 · u7_3) 는 px 꼭짓점 그대로, 제안은 SVG m."""
    result = []
    for item in design['routes']:
        pts = [(*design_to_world(px, py, design['transform']), task or ('출발' if i == 0 else '꺾는 점'))
               for i, (px, py, task) in enumerate(item['points'])]
        result.append((item, pts, '시안'))
    for item in design.get('proposals', []):
        if 'same_as' in item:
            pts = next(p for i, p, _ in result if i['id'] == item['same_as'])
        else:
            pts = [(*svg_world(u, v), '도로 지점') for u, v in item['svg_m']]
        result.append((item, pts, '제안'))
    return result


def road_rects(design):
    """도로 19 개를 세계 m [x0, y0, x1, y1] (y 는 -v) 로."""
    return [(u0, -v1, u1, -v0) for u0, v0, u1, v1 in design['roads_svg_m']['rects']]


def on_road(design, x, y):
    return any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in road_rects(design))


def nearest_road_point(design, pixels, x, y):
    """도로 띠 안 0.5 m 칸 가운데 (가장자리에서 0.5 m 안쪽) 중 0.5 m 여유가 있는 가장 가까운 점."""
    best = None
    for x0, y0, x1, y1 in road_rects(design):
        cx = min(max(x, x0 + CLEARANCE), x1 - CLEARANCE)
        cy = min(max(y, y0 + CLEARANCE), y1 - CLEARANCE)
        for dx in np.arange(-5, 5.01, RESOLUTION):
            for dy in np.arange(-5, 5.01, RESOLUTION):
                q = (round(float(cx + dx), 4), round(float(cy + dy), 4))
                if not (x0 + CLEARANCE <= q[0] <= x1 - CLEARANCE and y0 + CLEARANCE <= q[1] <= y1 - CLEARANCE):
                    continue
                d = math.dist(q, (x, y))
                if (best is None or d < best[0] - 1e-9) and not blocked(pixels, *q):
                    best = (d, q)
    if best is None:
        raise ValueError(f'가까운 도로 점이 없음 ({x}, {y})')
    return best[1]


def road_lines(design):
    """도로 띠마다 중심선 (가로 'h' 는 y 고정 · 세로 'v' 는 x 고정) 과 그 범위."""
    lines = []
    for x0, y0, x1, y1 in road_rects(design):
        if x1 - x0 >= y1 - y0:
            lines.append(('h', round((y0 + y1) / 2, 4), x0, x1))
        else:
            lines.append(('v', round((x0 + x1) / 2, 4), y0, y1))
    return lines


def foot(line, x, y):
    kind, c, a, b = line
    t = min(max(x if kind == 'h' else y, a), b)
    return (round(t, 4), c) if kind == 'h' else (c, round(t, 4))


def road_path(design, a, b):
    """a 에서 가장 가까운 도로 중심선으로 곧게 들어가, 중심선 그물 위 가장 짧은 길로 가서, b 로 곧게 나온다.
    돌려주는 것은 꺾는 점들 (a · b 빼고). 중심선이 서로 만나는 곳은 띠 폭만큼 늘려 본다 (T 자 이음)."""
    import heapq
    if math.dist(a, b) < 1e-6:
        return []
    lines = road_lines(design)
    width = {i: (x1 - x0 if l[0] == 'v' else y1 - y0) for i, (l, (x0, y0, x1, y1)) in enumerate(zip(lines, road_rects(design)))}
    on = {i: set() for i in range(len(lines))}
    for i, h in enumerate(lines):
        for j, v in enumerate(lines):
            if h[0] == 'h' and v[0] == 'v':
                if h[2] - width[j] <= v[1] <= h[3] + width[j] and v[2] - width[i] <= h[1] <= v[3] + width[i]:
                    on[i].add((v[1], h[1]))
                    on[j].add((v[1], h[1]))
    ends = {}
    for name, q in (('a', a), ('b', b)):
        i = min(range(len(lines)), key=lambda k: (math.dist(foot(lines[k], *q), q), k))
        ends[name] = foot(lines[i], *q)
        on[i].add(ends[name])
    graph = {}
    for i, pts in on.items():
        key = (lambda p: p[0]) if lines[i][0] == 'h' else (lambda p: p[1])
        pts = sorted(pts, key=key)
        for p, q in zip(pts, pts[1:]):
            graph.setdefault(p, []).append(q)
            graph.setdefault(q, []).append(p)
    start, goal = ends['a'], ends['b']
    best, came, todo = {start: 0.0}, {start: None}, [(0.0, start)]
    while todo:
        d, p = heapq.heappop(todo)
        if p == goal:
            break
        if d > best[p]:
            continue
        for q in graph.get(p, []):
            nd = d + math.dist(p, q)
            if nd < best.get(q, math.inf) - 1e-9:
                best[q], came[q] = nd, p
                heapq.heappush(todo, (nd, q))
    if goal not in came:
        raise ValueError(f'도로 그물로 이어지지 않음 {a} -> {b}')
    path, p = [], goal
    while p is not None:
        path.append(p)
        p = came[p]
    path = [tuple(a)] + path[::-1] + [tuple(b)]
    corners = []  # 곧게 이어지는 가운데 점은 뺀다
    for i in range(1, len(path) - 1):
        (px, py), (qx, qy), (rx, ry) = path[i - 1], path[i], path[i + 1]
        if math.dist(path[i], path[i - 1]) < 1e-6 or math.dist(path[i], path[i + 1]) < 1e-6:
            continue
        if abs((qx - px) * (ry - qy) - (qy - py) * (rx - qx)) > 1e-6:
            corners.append(path[i])
    return corners


def off_road(design, pixels, start, waypoints):
    """시작부터 지점들을 잇는 앱 시뮬 다리 (막힘을 돈 직선) 를 0.5 m 마다 재어, 지점 k 로 들어가는 다리의 도로 밖 길이 (m)."""
    meta = dict(resolution=RESOLUTION, origin=[BOUNDS[0], BOUNDS[1], 0.0])
    legs = route(pixels, meta, start, [(w['x'], w['y']) for w in waypoints], 0.35)
    outside, prev, k = [0.0] * len(waypoints), tuple(start), 0
    while k < len(waypoints) and math.dist(prev, (waypoints[k]['x'], waypoints[k]['y'])) < 1e-6:
        k += 1  # route() 는 제자리 지점을 건너뛴다
    for q in legs:
        q = (q['x'], q['y'])
        n = max(1, math.ceil(math.dist(prev, q) / RESOLUTION))
        for i in range(n):
            t = (i + .5) / n
            if not on_road(design, prev[0] + (q[0] - prev[0]) * t, prev[1] + (q[1] - prev[1]) * t):
                outside[min(k, len(waypoints) - 1)] += math.dist(prev, q) / n
        while k < len(waypoints) and math.dist(q, (waypoints[k]['x'], waypoints[k]['y'])) < 1e-6:
            k += 1
        prev = q
    return outside


def body_clear(pixels, x, y, radius=None):
    """(x, y) 에서 반지름 radius (기본 몸 반지름) 안에 막힌 칸 (상자) 이 없으면 참. 정확한 칸-점 거리."""
    radius = BODY_HALF if radius is None else radius
    h, w = pixels.shape
    u, v = x - BOUNDS[0], y - BOUNDS[1]
    col, row = math.floor(u / RESOLUTION), math.floor(v / RESOLUTION)
    n = math.ceil(radius / RESOLUTION) + 1
    cy, cx = np.mgrid[max(0, row - n):min(h, row + n + 1), max(0, col - n):min(w, col + n + 1)]
    occupied = pixels[h - 1 - cy, cx] != FREE
    dx = np.maximum(np.maximum(cx * RESOLUTION - u, 0), u - (cx + 1) * RESOLUTION)
    dy = np.maximum(np.maximum(cy * RESOLUTION - v, 0), v - (cy + 1) * RESOLUTION)
    return not (occupied & (np.hypot(dx, dy) < radius - 1e-9)).any()


def segment_blocked_m(pixels, a, b, step=0.1):
    """곧은 선 a -> b 가운데 몸 반지름 안에 막힌 칸이 있는 길이 (m)."""
    length = math.dist(a, b)
    n = max(1, math.ceil(length / step))
    hits = sum(not body_clear(pixels, a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n + 1))
    return round(hits * length / n, 1)


def corridor(pixels, start, pts, pid):
    """지점 사이 곧은 선이 몸 반지름 (0.45 m) 안에서 장비 · 벽에 걸리면, 그 다리만 가장 가까운 빈 통로 (격자 A*, 둘레 0.5 m)
    의 꺾는 점을 「통로 경유」 로 끼운다. 걸리지 않는 다리는 그대로. 돌려줌: 새 지점들, 고친 다리 표."""
    meta = dict(resolution=RESOLUTION, origin=[BOUNDS[0], BOUNDS[1], 0.0])
    result, rows, prev = [], [], tuple(start)
    for p in pts:
        hit = segment_blocked_m(pixels, prev, p[:2])
        if hit > 0:
            legs = route(pixels, meta, prev, [p[:2]], CLEARANCE)
            corners = [(q['x'], q['y']) for q in legs[:-1]]
            line = [prev] + corners + [tuple(p[:2])]
            deviation = max((abs((p[0] - prev[0]) * (prev[1] - y) - (prev[0] - x) * (p[1] - prev[1])) / max(math.dist(prev, p[:2]), 1e-9)
                             for x, y in corners), default=0.0)
            rows.append(dict(route=pid, to=p[2], blocked_m=hit, corners=len(corners),
                             extra_m=round(polyline_length(line) - math.dist(prev, p[:2]), 1), max_shift_m=round(deviation, 1)))
            result += [(x, y, '통로 경유', 'via') for x, y in corners]
        result.append(p)
        prev = p[:2]
    return result, rows


def blocked(pixels, x, y):
    return bool(clearance_failures(pixels, [dict(id='', waypoints=[dict(x=x, y=y, mission_name='')])]))


def charge_queue(design, pixels):
    """충전소 1 기다림 칸 (제안): 주 동서 도로 남쪽 차선 v 위, 충전소 x 에서 서쪽으로 spacing 마다 여유 있는 자리."""
    rule = design['decided']['queue']
    (cx, _), _ = place(design, design['decided']['battery_swap']['place'])
    cells, x = [], round(cx, 1)
    while len(cells) < rule['count'] and x > BOUNDS[0] + 1:
        y = -rule['lane_v_m']
        if not blocked(pixels, x, y) and all(abs(x - c[0]) >= rule['spacing_m'] - 1e-9 for c in cells):
            cells.append((x, y))
        x = round(x - 0.5, 1)
    if len(cells) < rule['count']:
        raise ValueError('기다림 칸 자리가 모자람')
    return cells


def densify(pixels, start, pts):
    """시작에서 pts (x, y, 이름, 종류) 를 차례로 잇는 길 (앱 시뮬 다리 · 막힘을 돈 직선들) 위에 VIA_M 마다 경유 지점을 넣는다.

    agent ScenarioRun 의 지점당 시간 제한 (nav_timeout_s 120 s) 안에 들게 하는 장치 (app-lx 12:50 결정 (나)).
    시안 지점은 그대로 두고, 경유 지점은 길 위 0.5 m 여유가 있는 자리 (모자라면 0.5 m 씩 앞으로 당김).
    """
    meta = dict(resolution=RESOLUTION, origin=[BOUNDS[0], BOUNDS[1], 0.0])
    path = [tuple(start)] + [(q['x'], q['y']) for q in route(pixels, meta, start, [p[:2] for p in pts], 0.35)]
    along = [0.0]
    for a, b in zip(path, path[1:]):
        along.append(along[-1] + math.dist(a, b))

    def at(distance):
        i = max(0, min(len(path) - 2, next((k for k in range(len(path) - 1) if along[k + 1] >= distance), len(path) - 2)))
        f = 0.0 if along[i + 1] == along[i] else (distance - along[i]) / (along[i + 1] - along[i])
        a, b = path[i], path[i + 1]
        return round(a[0] + (b[0] - a[0]) * f, 4), round(a[1] + (b[1] - a[1]) * f, 4)

    marks, j = [], 0
    for p in pts:  # 각 지점의 길 위 거리 (같은 자리 거듭은 같은 거리)
        while path[j][:2] != tuple(p[:2]):
            j += 1
        marks.append(along[j])
    result, here = [], 0.0
    for p, mark in zip(pts, marks):
        while mark - here > VIA_M:
            cut = here + VIA_M
            while blocked(pixels, *at(cut)):
                cut -= RESOLUTION
                if cut <= here + 1.0:
                    raise ValueError(f'경유 지점 자리가 없음 ({at(here + VIA_M)})')
            result.append((*at(cut), '경유', 'via'))
            here = cut
        result.append(p)
        here = mark
    return result, along[-1]


def scenarios(design, pixels):
    """서버 프리셋 · 길이 표 · 옮긴 지점 · 빠진 지점 · 도로 밖 다리.

    시안 지점은 그대로. 0.5 m 여유가 없는 시안 지점은 design.json move_to_road 가 있으면 가장 가까운 도로 점으로 옮기고
    (moved_from = 원래 px), 없으면 빼고 적는다. 시안 지점끼리의 다리는 시안 그대로, 나머지 다리 (시작 -> 첫 지점 ·
    끝 -> 복귀 · 제안 경로 · 배터리 교체 · 기다림 칸) 는 도로 중심선을 따르도록 꺾는 점을 경유로 넣는다.
    끝에 복귀 (시작 위치), finish STAY. 지점마다 kind = design · via (경유) · return (복귀) · place (배터리 교체 · 기다림 칸).
    """
    (home, home_name) = place(design, design['decided']['return_point']['place'])
    (charger, charger_name) = place(design, design['decided']['battery_swap']['place'])
    presets, table, dropped, moved, outside, corridors = [], [], [], [], [], []
    routes = {item['id']: item for item in design['routes']}

    def roads(pts, keep):
        """keep[i] 가 참이면 pts[i-1] -> pts[i] 는 시안 다리 (그대로), 아니면 도로 꺾는 점을 끼운다."""
        result, prev = [], tuple(home)
        for p, straight in zip(pts, keep):
            if not straight:
                result += [(*q, '도로 경유', 'via') for q in road_path(design, prev, p[:2])]
            result.append(p)
            prev = p[:2]
        return result

    def preset(pid, name, pts, keep, status):
        fixed, rows = corridor(pixels, home, roads(pts, keep), pid)
        corridors.extend(rows)
        full, walk = densify(pixels, home, fixed)
        waypoints, via = [], 0
        for i, (x, y, label_, kind, *extra) in enumerate(full):
            nxt = full[i + 1] if i + 1 < len(full) else None
            yaw = heading((x, y), nxt[:2]) if nxt else heading(full[i - 1][:2], (x, y)) if i else 0.0
            tag = f'v{via}' if kind == 'via' else f'p{i - via}'
            via += kind == 'via'
            waypoints.append(dict(x=x, y=y, yaw=yaw, kind=kind, mission_name=f'{WORLD_ID}-{pid}-{tag} · {label_}',
                                  **(extra[0] if extra else {})))
        presets.append(dict(id=pid, name=name, status=status, finish='STAY', waypoints=waypoints))
        for w, length in zip(waypoints, off_road(design, pixels, home, waypoints)):
            if length >= 1.0:
                outside.append(dict(route=pid, to=w['mission_name'], to_kind=w['kind'], off_road_m=round(length, 1)))
        return walk, via

    for item, pts, status in route_points(design):
        source = routes.get(item.get('same_as', item['id']))
        moves = {m['index']: m for m in (source or {}).get('move_to_road', [])}
        kept, keep = [], []
        for i, (x, y, label_) in enumerate(pts):
            extra = {}
            if blocked(pixels, x, y) and i in moves:
                q = nearest_road_point(design, pixels, x, y)
                extra = dict(moved_from=dict(px=source['points'][i][:2], world=[x, y], note=moves[i]['note']))
                if item['id'] == source['id']:
                    moved.append(dict(route=item['id'], label=label_, px=source['points'][i][:2], world_from=[x, y],
                                      world_to=list(q), moved_m=round(math.dist(q, (x, y)), 2), note=moves[i]['note']))
                x, y = q
            if blocked(pixels, x, y):
                dropped.append(dict(route=item['id'], x=x, y=y, label=label_, reason='0.5 m 안에 막힌 칸 (건물 · 금지 구역 안)'))
                continue
            keep.append(bool(kept) and status == '시안' or bool(kept) and 'same_as' in item)
            kept.append((x, y, f'{item["name"]} · {label_}', 'design', extra) if extra else (x, y, f'{item["name"]} · {label_}', 'design'))
        kept.append((*home, f'복귀 · {home_name}', 'return'))
        keep.append(False)
        times = item.get('schedule') or []
        name = item['name'] + (f' · {times[0]["start"]}' if times else '') + (' · 제안' if status == '제안' else '')
        walk, via = preset(item['id'], name, kept, keep, status)
        design_len = polyline_length([p[:2] for p in pts])
        table.append(dict(id=item['id'], name=item['name'], status=status, robot=item.get('robot') or item.get('robots'),
                          points=len(pts), kept=len(kept) - 1, via=via, design_length_m=round(design_len, 1),
                          design_minutes_at_0_5=round(design_len / SPEED / 60, 1),
                          walk_from_start_m=round(walk, 1), walk_minutes_at_0_5=round(walk / SPEED / 60, 1),
                          schedule=times))
    walk, via = preset('battery-swap', f'배터리 교체 · {charger_name}',
                       [(*charger, f'배터리 교체 · {charger_name}', 'place'), (*home, f'복귀 · {home_name}', 'return')],
                       [False, False], '결정')
    table.append(dict(id='battery-swap', name='배터리 교체', status='결정', via=via, walk_from_start_m=round(walk, 1),
                      walk_minutes_at_0_5=round(walk / SPEED / 60, 1)))
    queue = charge_queue(design, pixels)
    for i, (x, y) in enumerate(queue, 1):
        preset(f'charge-wait-{i}', f'충전 기다림 칸 {i} · 제안', [(x, y, f'충전 기다림 칸 {i}', 'place')], [False], '제안')
    return presets, table, dropped, moved, outside, corridors, queue


def nogo_distances(design, pixels, cells):
    """기다림 칸마다: 금지 구역 (SVG 붉은 빗금 사각) 까지 거리 · 격자에서 가장 가까운 막힌 칸까지 거리 (m)."""
    rows = []
    h, w = pixels.shape
    for x, y in cells:
        zone = min(((max(u0 - x, 0, x - u1) ** 2 + max(v0 - (-y), 0, (-y) - v1) ** 2) ** .5, z['name'])
                   for z in design['nogo_svg_m']['rects'] for u0, v0, u1, v1 in [z['rect']])
        r, c = world_cell(x, y)
        n = 40
        rr, cc = np.mgrid[max(0, r - n):min(h, r + n + 1), max(0, c - n):min(w, c + n + 1)]
        occ = pixels[rr, cc] != FREE
        cx0 = BOUNDS[0] + cc * RESOLUTION
        cy0 = BOUNDS[3] - (rr + 1) * RESOLUTION
        dx = np.maximum.reduce([cx0 - x, np.zeros_like(cx0), x - (cx0 + RESOLUTION)])
        dy = np.maximum.reduce([cy0 - y, np.zeros_like(cy0), y - (cy0 + RESOLUTION)])
        grid = float(np.hypot(dx, dy)[occ].min()) if occ.any() else None
        rows.append(dict(x=x, y=y, nearest_nogo=zone[1], nogo_m=round(zone[0], 2),
                         nearest_blocked_cell_m=None if grid is None else round(grid, 2),
                         body_half_m=BODY_HALF, overlaps=zone[0] < BODY_HALF))
    return rows


def clearance_failures(pixels, presets):
    """서버 check_clearance 와 같은 규칙 (0.5 m 안에 막힌 칸 · 지도 끝)으로 걸리는 지점."""
    h, w = pixels.shape
    bad = []
    for preset in presets:
        for p in preset['waypoints']:
            x, y = p['x'] - BOUNDS[0], p['y'] - BOUNDS[1]
            if min(x, y, w * RESOLUTION - x, h * RESOLUTION - y) < CLEARANCE:
                bad.append((preset['id'], p['mission_name'], 'edge')); continue
            col, row = math.floor(x / RESOLUTION), math.floor(y / RESOLUTION)
            n = math.ceil(CLEARANCE / RESOLUTION) + 1
            for cy in range(max(0, row - n), min(h, row + n + 1)):
                for cx in range(max(0, col - n), min(w, col + n + 1)):
                    if pixels[h - 1 - cy, cx] == FREE:
                        continue
                    dx = max(cx * RESOLUTION - x, 0, x - (cx + 1) * RESOLUTION)
                    dy = max(cy * RESOLUTION - y, 0, y - (cy + 1) * RESOLUTION)
                    if math.hypot(dx, dy) < CLEARANCE - 1e-10:
                        bad.append((preset['id'], p['mission_name'], 'blocked'))
                        break
                else:
                    continue
                break
    return bad


def check_glb(sources):
    if not GLB.exists():
        raise SystemExit(f'{GLB.relative_to(WORLDS.parents[2])} 가 없다 (시안 3D 를 models/ 에 복사)')
    actual = digest(GLB)
    if actual != sources['inputs']['factory_site.glb']:
        raise SystemExit(f'factory_site.glb sha256 {actual} 이 sources.json 과 다르다')


def register():
    sources = json.loads((OUT / 'sources.json').read_text())
    check_glb(sources)
    design = json.loads((OUT / 'design.json').read_text())
    start = design_to_world(*next(p['px'] for p in design['places'] if p['id'] == 'start'), design['transform'])
    pixels, kinds = site_grid(read_glb(GLB), start)
    world = compose(pixels, kinds)
    world.write(OUT / f'{WORLD_ID}.sdf')
    generate(OUT / f'{WORLD_ID}.sdf', OUT / 'maps', {FLOOR: 0.0}, resolution=RESOLUTION, bounds=list(BOUNDS))
    again = np.array(Image.open(OUT / 'maps' / f'{FLOOR}.png'))
    if not np.array_equal(again, pixels):
        raise ValueError(f'collision 지도가 격자와 다르다: {int((again != pixels).sum())} 칸')
    presets, table, dropped, moved, outside, corridors, queue = scenarios(design, pixels)
    bad = clearance_failures(pixels, presets)
    if bad:
        raise ValueError(f'프리셋 지점이 0.5 m 여유 밖: {bad}')
    write_json(OUT / f'scenarios-{FLOOR}.json', presets)
    write_json(OUT / f'zones-{FLOOR}.json', dict(schema='factory_site_zones/1', zones=area_zones(design)))
    table_path = OUT / 'routes-table.json'

    spawn = [*start, round(-math.pi / 2, 4)]  # 제어실 앞에서 남쪽 (주도로) 을 봄
    catalogue_path = WORLDS / 'worlds.json'
    catalogue = json.loads(catalogue_path.read_text())
    rel = lambda p: f'{WORLD_ID}/{p}'
    catalogue['worlds'][f'{WORLD_ID}/{FLOOR}'] = dict(
        world_id=WORLD_ID, floor_id=FLOOR, building_id=WORLD_ID, name='공장 터 · 초안', floor_name='마당', level=1,
        description='시안 공장 터 3D (900 x 560 m) 를 0.5 m 격자 상자로 바꾼 옥외 정적 월드. 실제 실행 미검증.',
        floor_z=0.0, spawn_xyyaw=spawn, spawn_z=SPAWN_BASE,
        spawn_source='design.json places.start (시안 u5_3 K-08 시작 위치 · 제어실 앞)',
        world=rel(f'{WORLD_ID}.sdf'), gt_map=rel(f'maps/{FLOOR}.yaml'), map_metadata=rel('maps/metadata.json'),
        ledger_key=f'{WORLD_ID}/{FLOOR}', height_source='static_sdf_collision',
        readiness='offline_prepared', native_supported=False,
        notes='MuJoCo 로컬 전용.' + (MODEL_NOTE if MODEL.is_file() else ''),
        **(dict(model=rel('models/' + MODEL.name)) if MODEL.is_file() else {}),
        scenarios=rel(f'scenarios-{FLOOR}.json'), zones=rel(f'zones-{FLOOR}.json'),
        sha256=dict(world=digest(OUT / f'{WORLD_ID}.sdf'), map=digest(OUT / 'maps' / f'{FLOOR}.yaml'),
                    metadata=digest(OUT / 'maps/metadata.json'), **(dict(model=digest(MODEL)) if MODEL.is_file() else {})),
        mesh_sha256={})
    write_json(catalogue_path, catalogue)
    mobile_assets(world, pixels, spawn, presets)
    write_json(table_path, dict(
        speed_mps=SPEED,
        lengths='design_length_m = 시안 선 (꼭짓점 직선, 빠진 지점 포함) · '
                'walk_from_start = 시작 위치에서 출발해 남긴 지점을 막힘을 돌아 (앱 시뮬 다리, 둘레 0.35 m) 잇고 복귀까지',
        via_m=VIA_M,
        routes=table, moved_points=moved, dropped_points=dropped,
        corridor_legs=dict(note=f'곧은 다리가 몸 반지름 {BODY_HALF} m 안에서 장비 · 벽에 걸린 길이 (blocked_m) 와, 가장 가까운 빈 통로 '
                                f'(격자 A*, 둘레 {CLEARANCE} m) 꺾는 점을 끼워 늘어난 길이 (extra_m) · 원래 선에서 가장 멀리 비킨 거리 '
                                '(max_shift_m). app-design-lx 13:09',
                           legs=corridors),
        off_road_legs=dict(note='지점 to 로 들어가는 다리 (앱 시뮬 다리) 중 도로 19 개 밖 길이 1 m 이상. to_kind design 은 시안 다리이거나 '
                                 '도로 밖 시안 지점에 드나드는 연결',
                           legs=outside),
        charge_queue=dict(status='제안', cells=queue, distances=nogo_distances(design, pixels, queue))))
    return pixels, world, table


def mobile_assets(world, pixels, spawn, presets):
    """앱 시뮬 (mobile/sim/assets/factory-site): xml · map.json · scenarios.json · scene.json · top.json · top.png · metadata.json."""
    target = MOBILE / 'assets' / MOBILE_ID
    target.mkdir(parents=True, exist_ok=True)

    def write(name, value):
        (target / name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')

    mjcf(world, MOBILE_ID).write(target / f'{MOBILE_ID}.xml', encoding='utf-8', xml_declaration=True)
    write('scene.json', batch(world.shapes))
    h, w = pixels.shape
    grid = dict(origin=[BOUNDS[0], BOUNDS[1], 0.0], res=RESOLUTION, w=w, h=h)
    write('map.json', dict(**grid, floor_id=FLOOR, floor_z=0.0, spawn_xyyaw=spawn, spawn_z=SPAWN_BASE,
                           px=base64.b64encode(pixels.tobytes()).decode()))
    meta = dict(resolution=RESOLUTION, origin=[BOUNDS[0], BOUNDS[1], 0.0])
    mobile = []
    for item in presets:
        if item['id'].startswith('charge-wait-'):
            continue
        legs = route(pixels, meta, spawn[:2], [(p['x'], p['y']) for p in item['waypoints']], 0.35)
        mobile.append(dict(id=item['id'], floor_id=FLOOR, name=item['name'] + ' · 초안', clearance_m=0.35, points=legs))
    write('scenarios.json', mobile)
    Image.fromarray(pixels).save(target / 'top.png')  # 위에서 본 그림 = 지도 (make-top 없이)
    write('top.json', dict(bounds=list(BOUNDS), px=[w, h], map=grid))
    write('metadata.json', dict(
        draft=True, source=f'apps/simmgr/worlds/{WORLD_ID}/sources.json (glb sha256 만, 파일은 커밋 안 함)',
        sdf_sha256=digest(OUT / f'{WORLD_ID}.sdf'), generator='apps/simmgr/tools/import_site.py',
        geoms=len(world.shapes), physics=f'땅 상자 + 막힌 칸 직사각형 상자 (높이 {BOX_H} m)',
        readiness='draft; headless 보행은 probe 기록 참고 · 폰 FPS 미확인'))
    maps_path = MOBILE / 'maps.json'
    text = maps_path.read_text()
    if not any(m['id'] == MOBILE_ID for m in json.loads(text)):
        # 손으로 맞춘 줄 모양을 그대로 두고 끝에 한 항목만 붙인다.
        head = text.rstrip()
        if not head.endswith(']'):
            raise ValueError('maps.json 끝이 ] 가 아님')
        maps_path.write_text(head[:-1].rstrip() + f',\n  {{\n    "id": "{MOBILE_ID}",\n    "name": "공장 터 · 초안"\n  }}\n]\n')
        json.loads(maps_path.read_text())


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    _, built, rows = register()
    print(json.dumps(dict(geoms=len(built.shapes), routes=rows), ensure_ascii=False, indent=1))

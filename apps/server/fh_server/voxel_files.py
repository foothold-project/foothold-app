"""Bounded PCD/PLY XYZ readers and deterministic 10 cm map/terrain conversion."""
from collections import Counter
from io import BytesIO
import math
import struct

from apps.contracts import models as C
from .map_files import gray_png

MAX_BYTES = 50 * 1024 * 1024
MAX_POINTS = 5_000_000
MAX_VOXELS = 500_000
CELL = .1
HEADER_BYTES = 64 * 1024
TYPES = {'char': 'b', 'int8': 'b', 'uchar': 'B', 'uint8': 'B', 'short': 'h', 'int16': 'h',
         'ushort': 'H', 'uint16': 'H', 'int': 'i', 'int32': 'i', 'uint': 'I', 'uint32': 'I',
         'float': 'f', 'float32': 'f', 'double': 'd', 'float64': 'd'}


class PointCloudError(ValueError):
    """A safe Korean explanation, distinct from numeric/parser exception text."""


def bounded_count(value):
    n = int(value)
    if not 1 <= n <= MAX_POINTS:
        raise PointCloudError('점 수는 1~500만 개여야 합니다.')
    return n


def points(data, kind):
    """Read scalar XYZ plus ignored scalar attributes; reject compressed/list layouts."""
    if len(data) > MAX_BYTES:
        raise PointCloudError('점 지도는 50 MB 이하로 올려 주세요.')
    stream = BytesIO(data)
    def line():
        value = stream.readline(HEADER_BYTES + 1)
        if stream.tell() > HEADER_BYTES or not value or len(value) > 8192:
            raise PointCloudError('점 지도 머리글이 너무 길거나 끝나지 않았습니다.')
        return value.decode('ascii').strip()
    fields, formats, counts = [], [], []
    if kind == 'pcd':
        header = {}
        while True:
            value = line()
            if not value or value.startswith('#'):
                continue
            key, *args = value.split()
            key = key.upper()
            if key in header:
                raise PointCloudError('PCD 머리글 항목이 중복되었습니다.')
            header[key] = args
            if key == 'DATA':
                break
        fields = header['FIELDS']
        counts = [int(v) for v in header.get('COUNT', ['1'] * len(fields))]
        sizes = [int(v) for v in header['SIZE']]
        types = header['TYPE']
        if not 3 <= len(fields) <= 64 or not len(fields) == len(counts) == len(sizes) == len(types):
            raise PointCloudError('PCD 점 항목을 확인해 주세요.')
        lookup = {('F', 4): 'f', ('F', 8): 'd', ('I', 1): 'b', ('I', 2): 'h', ('I', 4): 'i',
                  ('U', 1): 'B', ('U', 2): 'H', ('U', 4): 'I'}
        for t, s, c in zip(types, sizes, counts):
            if not 1 <= c <= 16 or (t, s) not in lookup:
                raise PointCloudError('지원하지 않는 PCD 숫자 형식입니다.')
            formats.extend([lookup[t, s]] * c)
        n = bounded_count(header['POINTS'][0])
        if int(header['WIDTH'][0]) * int(header['HEIGHT'][0]) != n:
            raise PointCloudError('PCD 가로·세로와 점 수가 다릅니다.')
        mode = header['DATA'][0]
        endian = '<'
    elif kind == 'ply':
        if line() != 'ply':
            raise PointCloudError('PLY 파일의 시작 표시가 올바르지 않습니다.')
        mode, n, vertex = None, None, False
        while True:
            args = line().split()
            if not args or args[0] in ('comment', 'obj_info'):
                continue
            if args[0] == 'end_header':
                break
            if args[0] == 'format' and len(args) == 3 and args[2] == '1.0' and mode is None:
                mode = args[1]
            elif args[0] == 'element' and len(args) == 3:
                # XYZ point files only: no faces or variable-sized list data.
                if args[1] != 'vertex' or n is not None:
                    raise PointCloudError('PLY는 면 없이 XYZ 점만 담은 파일로 내보내 주세요.')
                n, vertex = bounded_count(args[2]), True
            elif args[0] == 'property' and vertex and len(args) == 3 and args[1] in TYPES:
                fields.append(args[2])
                formats.append(TYPES[args[1]])
            else:
                raise PointCloudError('지원하지 않는 PLY 항목입니다. XYZ 점 파일로 내보내 주세요.')
        if n is None or not 3 <= len(fields) <= 64:
            raise PointCloudError('PLY 점 항목을 확인해 주세요.')
        counts = [1] * len(fields)
        endian = '>' if mode == 'binary_big_endian' else '<'
        mode = 'binary' if mode in ('binary_little_endian', 'binary_big_endian') else mode
    else:
        raise PointCloudError('PCD 또는 PLY 점 지도 파일을 올려 주세요.')
    if len(set(fields)) != len(fields) or not {'x', 'y', 'z'} <= set(fields):
        raise PointCloudError('점 지도에 중복 없는 x·y·z 항목이 필요합니다.')
    offsets = []
    for axis in ('x', 'y', 'z'):
        i = fields.index(axis)
        if counts[i] != 1:
            raise PointCloudError('x·y·z는 각각 숫자 하나여야 합니다.')
        offsets.append(sum(counts[:i]))
    size = len(formats)
    layout = struct.Struct(endian + ''.join(formats))
    if mode == 'binary' and len(data) - stream.tell() != n * layout.size:
        raise PointCloudError('점 지도 본문 길이와 점 수가 다릅니다.')
    if mode not in ('ascii', 'binary'):
        raise PointCloudError('압축 PCD는 지원하지 않습니다. ASCII 또는 binary로 내보내 주세요.')
    for _ in range(n):
        if mode == 'binary':
            row = layout.unpack(stream.read(layout.size))
        else:
            raw = stream.readline(8193)
            if len(raw) > 8192:
                raise PointCloudError('점 한 줄이 너무 깁니다.')
            row = raw.split()
            if len(row) != size:
                raise PointCloudError('점 지도 한 줄의 숫자 수가 맞지 않습니다.')
            # Validate ignored attributes too, without building an unbounded token list.
            row = [float(v) if f in 'fd' else int(v) for v, f in zip(row, formats)]
        xyz = tuple(float(row[i]) for i in offsets)
        if not all(math.isfinite(v) and abs(v) <= 10_000 for v in xyz):
            raise PointCloudError('점 좌표는 ±10,000 m 안의 유한한 숫자여야 합니다.')
        yield xyz
    if stream.read().strip():
        raise PointCloudError('점 수 뒤에 알 수 없는 자료가 남아 있습니다.')


def rectangles(heights, width, height):
    # Keep the exact occupied footprint: filling gaps between occupied cells would turn
    # free 2D scenario points into terrain obstacles.
    remaining = heights.copy()
    boxes = []
    while remaining:
        x, y = min(remaining, key=lambda p: (p[1], p[0]))
        h = remaining.pop((x, y))
        right = x + 1
        while remaining.get((right, y)) == h:
            remaining.pop((right, y))
            right += 1
        top = y + 1
        while all(remaining.get((xx, top)) == h for xx in range(x, right)):
            for xx in range(x, right):
                remaining.pop((xx, top))
            top += 1
        left_m, bottom_m = x * CELL, y * CELL
        right_m, top_m = right * CELL, top * CELL
        boxes.append(dict(kind='box', x=(left_m + right_m - width * CELL) / 2,
            y=(bottom_m + top_m - height * CELL) / 2, yaw=0.,
            sx=round(right_m - left_m, 8), sy=round(top_m - bottom_m, 8), h=h * CELL))
        if len(boxes) > 60:
            break
    return boxes


def convert(data, kind, terrain_id, name):
    voxels, z_counts = set(), Counter()
    count = 0
    for xyz in points(data, kind):
        v = tuple(math.floor(round(a / CELL, 7)) for a in xyz)
        voxels.add(v)
        z_counts[v[2]] += 1
        count += 1
        if len(voxels) > MAX_VOXELS:
            raise PointCloudError('10 cm 칸 수가 50만 개를 넘었습니다. 구역을 나눠 올려 주세요.')
    # Lowest substantial horizontal band: ignore isolated low outliers and do
    # not prefer a densely scanned ceiling over a reasonably sampled floor.
    support = max(z_counts.values()) * .2
    floor_z = min(z for z, count in z_counts.items() if count >= support)
    low = [min(v[i] for v in voxels) for i in (0, 1)]
    high = [max(v[i] for v in voxels) + 1 for i in (0, 1)]
    size = [min(300, max(40, high[i] - low[i] + 2)) for i in (0, 1)]
    # Even cell counts give an exact shared origin in the centered TerrainSpec frame.
    size = [n + n % 2 for n in size]
    center = [(low[i] + high[i]) // 2 for i in (0, 1)]
    shift = [center[i] - size[i] // 2 for i in (0, 1)]
    cells = sorted((x - shift[0], y - shift[1], z - floor_z) for x, y, z in voxels
        if 0 <= x - shift[0] < size[0] and 0 <= y - shift[1] < size[1])
    warnings = []
    if len(cells) != len(voxels):
        warnings.append('30 m를 넘는 구역은 가운데 30 m만 지도·지형으로 만들었습니다. 원본 파일은 보관됩니다.')
    ground, blocked, columns = set(), set(), {}
    for x, y, z in cells:
        if z == 0:
            ground.add((x, y))
        if 1 <= z <= 6:
            blocked.add((x, y))
        if z >= 1:
            columns.setdefault((x, y), set()).add(z)
    heights, clamped = {}, False
    for xy in blocked:
        # Treat the estimated floor plane as the base. Require every occupied
        # vertical cell from z=1; stop at the first gap, ignoring overhead scans.
        top = 0
        while top + 1 in columns[xy]:
            top += 1
        if top:
            heights[xy] = min(10, top + 1)  # Cell top edge, not its bottom.
            clamped |= top + 1 > 10
    if clamped:
        warnings.append('바닥부터 이어진 지형 높이는 1 m까지만 만들었습니다.')
    width, height = size
    pixels = bytearray([205]) * (width * height)
    for x, y in ground:
        pixels[(height - 1 - y) * width + x] = 254
    for x, y in blocked:
        pixels[(height - 1 - y) * width + x] = 0
    boxes = rectangles(heights, width, height)
    if len(boxes) > 60:
        boxes = boxes[:60]
        warnings.append('빈 곳을 막지 않고 합칠 수 있는 물체가 60개를 넘어서, 지도 아래쪽부터 왼쪽 순서로 60개만 만들었습니다. 나머지는 지형 수정하기에서 보완해 주세요.')
    def safe(x, y):
        return all(math.hypot(max(0, abs(x - b['x']) - b['sx'] / 2),
                              max(0, abs(y - b['y']) - b['sy'] / 2)) >= .45 for b in boxes)
    spawn = None
    for x, y in sorted(ground - blocked):
        xx, yy = (x + .5 - width / 2) * CELL, (y + .5 - height / 2) * CELL
        if abs(xx) <= width * CELL / 2 - .45 and abs(yy) <= height * CELL / 2 - .45 and safe(xx, yy):
            spawn = [xx, yy, 0.]
            break
    if spawn is None:
        raise PointCloudError('물체·가장자리에서 0.45 m 떨어진 바닥 시작 위치를 찾지 못했습니다. 넓은 바닥을 포함해 올려 주세요.')
    spec = C.TerrainSpec.model_validate(dict(schema='fh_custom_terrain/1', id=terrain_id, name=name,
        size=[n * CELL for n in size], spawn=spawn, items=boxes))
    return dict(cells=cells, point_count=count, voxel_count=len(cells), floor_z=floor_z * CELL,
        source_translation=[-center[0] * CELL, -center[1] * CELL, -floor_z * CELL],
        origin=[-width * CELL / 2, -height * CELL / 2, 0.], width=width, height=height,
        png=gray_png(width, height, pixels), spec=spec, warnings=warnings)

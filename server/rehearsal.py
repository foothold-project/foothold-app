"""리허설 프로젝트(설계도 scene) 저장·검증·2D 기하 검토·내보내기 — 표준 라이브러리만, ROS·Gazebo 실행 없음.

계약 정본: runs/sim-fleet-planning-20261018/API.md (숫자·키·응답 모양). 연결(관문·v2_link)은 root 소유.
  Store(root).listing() -> dict            GET 목록(메타만)
  Store(root).apply(body, actor) -> (code, dict)   op = list | get | put | delete | analyze | export
하는 것: scene 형식·참조·좌표·상한 검증, 같은 기하에서 SDF 세계 + 층별 GT 지도(PGM/YAML) + 배치 계획 ZIP,
        2D 기하 경고(경로 막힘·연결 없음·로봇 간 경로 교차).
안 하는 것: Gazebo·ROS 기동, 로봇 명령, 물리·넘어짐·실제 도달 판정, 계단 오르기 검증(치수 범위 미확인).
래스터 수치는 control-app/sim/worlds/build_v5_world.py 와 같다(BAND·SUP·0.05 m·205/0/254).
"""
import base64, binascii, collections, contextlib, fcntl, hashlib, io, json, math, os, re, secrets, stat, struct, threading, time, zipfile
from pathlib import Path
from xml.sax.saxutils import quoteattr

SCHEMA = 'fh_rehearsal_scene/1'
REV_SCHEMA = 'fh_rehearsal_rev/1'
GEN = 'server/rehearsal.py r1'
RES, BAND, SUP = 0.05, (0.05, 0.60), (-0.06, 0.05)   # build_v5_world.py 와 같은 값
SLAB_T, BODY_R, COARSE = 0.10, 0.35, 0.2              # 위층 바닥판 두께 · 몸 반경(make_map_assets ③) · 검토 격자
EPS = 1e-9
LIMITS = dict(request_bytes=262144, response_bytes=1048576, zip_bytes=655360, scene_bytes=245760,
              background_bytes=131072, background_px=4096, projects=64, revisions=200, store_bytes=128 << 20,
              floors=8, elements=1500, boxes=2000, robots=12, sensors=6, equipment=200, routes=48,
              route_points=200, route_points_total=2000, scenarios=12, stairs_per_floor=16, issues=200, name_chars=60,
              total_cells=8_000_000, work_units=20_000_000, put_seconds=5, analyze_seconds=5, export_seconds=10)
L = LIMITS


class Damaged(Exception):
    """저장소 구조 이상(심볼릭 링크 등) — 따라가거나 고치지 않고 503."""


class Overload(Exception):
    """계산 자원 상한 초과 — 부분 결과 없이 요청 전체 실패. code 413(작업량) / 503(시간)."""

    def __init__(self, code, msg):
        super().__init__(msg); self.code, self.msg = code, msg


class Budget:
    """요청 하나의 계산 상한. 안쪽 루프(래스터 행·BFS·선분 표본·교차 비교)에서 tick — 끝난 뒤 한 번 재는 방식이 아니다."""

    def __init__(self, seconds, units=None):
        self.seconds, self.end = seconds, time.monotonic() + seconds
        self.left = L['work_units'] if units is None else units

    def tick(self, n=1):
        self.left -= n
        if self.left < 0:
            raise Overload(413, f"계산 작업량 상한({L['work_units']:,} 단위) 초과 — 세계 크기·층·요소·경로를 줄이세요")
        if time.monotonic() > self.end:
            raise Overload(503, f'계산 시간 상한({self.seconds} s) 초과 — 세계 크기·층·요소·경로를 줄이세요')


FREE = Budget(1e9, 1 << 62)                           # 시험·도구용(상한 없음에 가까움) — 서버 경로는 Store.apply 가 요청마다 새로 만든다
ID_RE = re.compile(r'[a-z][a-z0-9_]{0,31}')
PID_RE = re.compile(r'p[0-9a-f]{10}')
REV_RE = re.compile(r'r[0-9]{6}\.json')
CTRL_RE = re.compile(r'[\x00-\x1f\x7f]')
SENSOR_KINDS = ('lidar_l1', 'lidar_l2', 'lidar_unknown', 'camera', 'depth')
EQUIP_KINDS = ('camera_fixed', 'relay', 'marker', 'other')
NOTE = '2D 기하 검토 — 물리·넘어짐·실제 도달 판정 아님'
ONES = b'\x01' * 2000


# ───────────────────────────── 검증 ─────────────────────────────
class _V:
    """키·타입·범위 검사기. 오류는 모아 두고 처음 오류에서 멈추지 않는다(목록 상한까지)."""

    def __init__(self):
        self.issues, self.ids = [], {}

    def add(self, level, code, path, msg, **kw):
        self.issues.append(dict(level=level, code=code, path=path, msg=msg, **kw))

    def err(self, path, code, msg, **kw):
        self.add('error', code, path, msg, **kw)

    @property
    def bad(self):
        return any(i['level'] == 'error' for i in self.issues)

    def obj(self, o, path, keys):
        if not isinstance(o, dict):
            self.err(path, 'type', '객체여야 합니다'); return False
        miss, extra = [k for k in keys if k not in o], sorted(k for k in o if k not in keys)
        if miss or extra:
            self.err(path, 'keys', f'키가 맞지 않습니다 — 빠짐 {miss} · 모르는 키 {extra}'); return False
        return True

    def num(self, v, path, lo, hi, integer=False):
        if type(v) not in ((int,) if integer else (int, float)) or not math.isfinite(v):
            self.err(path, 'number', '정수여야 합니다' if integer else '유한한 숫자여야 합니다(참/거짓·NaN·Infinity 불가)'); return False
        if not lo - EPS <= v <= hi + EPS:
            self.err(path, 'range', f'{lo}–{hi} 범위여야 합니다'); return False
        return True

    def vec(self, v, path, n, lo, hi):
        if not isinstance(v, list) or len(v) != n:
            self.err(path, 'type', f'숫자 {n}개 목록이어야 합니다'); return False
        return all([self.num(x, f'{path}[{i}]', lo, hi) for i, x in enumerate(v)])

    def text(self, v, path, lo=0, hi=L['name_chars']):
        if not isinstance(v, str) or not lo <= len(v) <= hi or CTRL_RE.search(v):
            self.err(path, 'text', f'제어문자 없는 {lo}–{hi}자 글이어야 합니다'); return False
        return True

    def lst(self, v, path, hi, lo=0):
        if not isinstance(v, list) or not lo <= len(v) <= hi:
            self.err(path, 'count', f'{lo}–{hi}개 목록이어야 합니다'); return False
        return True

    def ident(self, v, path, maxlen=32):
        if not isinstance(v, str) or not ID_RE.fullmatch(v) or len(v) > maxlen:
            self.err(path, 'id', f'ID 는 영문 소문자로 시작하는 소문자·숫자·_ {maxlen}자 이하'); return False
        if v in self.ids:
            self.err(path, 'id_dup', f'ID «{v}» 가 {self.ids[v]} 와 겹칩니다'); return False
        self.ids[v] = path
        return True

    def enum(self, v, path, allowed):
        if v not in allowed:
            self.err(path, 'enum', f'{list(allowed)} 중 하나'); return False
        return True


def _img_size(mime, raw):
    """PNG IHDR / JPEG SOFn 에서 (가로, 세로). 형식이 틀리면 None."""
    if mime == 'image/png':
        if raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[12:16] != b'IHDR' or len(raw) < 24:
            return None
        return struct.unpack('>II', raw[16:24])
    if raw[:3] != b'\xff\xd8\xff':
        return None
    i = 2
    while i + 9 < len(raw):
        if raw[i] != 0xFF:
            return None
        m = raw[i + 1]
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2; continue
        seg = struct.unpack('>H', raw[i + 2:i + 4])[0]
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack('>HH', raw[i + 5:i + 9])
            return w, h
        i += 2 + seg
    return None


def _rect(cx, cy, hx, hy, yaw, z0, z1, kind, eid):
    return dict(cx=cx, cy=cy, hx=hx, hy=hy, c=math.cos(yaw), s=math.sin(yaw), z0=z0, z1=z1, kind=kind, eid=eid)


def _corners(r, grow=0.0):
    hx, hy = r['hx'] + grow, r['hy'] + grow
    return [(r['cx'] + a * hx * r['c'] - b * hy * r['s'], r['cy'] + a * hx * r['s'] + b * hy * r['c'])
            for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def _inside(r, x, y, grow=0.0):
    dx, dy = x - r['cx'], y - r['cy']
    return abs(dx * r['c'] + dy * r['s']) <= r['hx'] + grow + EPS and abs(-dx * r['s'] + dy * r['c']) <= r['hy'] + grow + EPS


def _stair_rects(e, z):
    """계단 → 단마다 바닥(z)부터 (i+1)·riser 까지 쌓은 상자 + 바닥 발자국."""
    c, s = math.cos(e['yaw']), math.sin(e['yaw'])
    out = []
    for i in range(e['steps']):
        a = (i + 0.5) * e['tread']
        out.append(_rect(e['start'][0] + c * a, e['start'][1] + s * a, e['tread'] / 2, e['width'] / 2, e['yaw'],
                         z, z + (i + 1) * e['riser'], 'stairs', e['id']))
    run = e['steps'] * e['tread'] / 2
    foot = _rect(e['start'][0] + c * run, e['start'][1] + s * run, run, e['width'] / 2, e['yaw'], z, z, 'foot', e['id'])
    return out, foot


def validate(scene, bud=FREE):
    """→ (issues, geo). geo 는 오류가 없을 때만(오류면 None). 경고는 issues 에 level='warn'. 자원 초과는 Overload."""
    v = _V()
    top = ('schema', 'name', 'world', 'floors', 'elements', 'robots', 'equipment', 'routes', 'scenarios')
    if not v.obj(scene, '$', top):
        return v.issues, None
    if scene['schema'] != SCHEMA:
        v.err('$.schema', 'schema', f'모르는 형식 판 — {SCHEMA} 만'); return v.issues, None
    v.text(scene['name'], '$.name', 1)
    w = scene['world']
    if not v.obj(w, '$.world', ('origin', 'size', 'resolution', 'background')):
        return v.issues, None
    v.vec(w['origin'], '$.world.origin', 2, -10000, 10000)
    v.vec(w['size'], '$.world.size', 2, 2, 100)
    if w['resolution'] != RES or type(w['resolution']) is bool:
        v.err('$.world.resolution', 'range', '0.05 만 허용합니다')
    if v.bad:
        return v.issues, None
    ox, oy = w['origin']; X1, Y1 = ox + w['size'][0], oy + w['size'][1]
    nf = len(scene['floors']) if isinstance(scene['floors'], list) else 0
    cells = math.ceil(w['size'][0] / RES - 1e-9) * math.ceil(w['size'][1] / RES - 1e-9) * max(nf, 1)
    if cells > L['total_cells']:
        v.err('$.world.size', 'too_large', f"층 지도 칸 합 {cells:,} > {L['total_cells']:,} — 세계를 줄이거나 층 수를 줄이세요"
              f" (예: 100×100 m 는 2층까지, 50×50 m 는 8층까지)")
        return v.issues, None

    def in_world(x, y):
        return ox - 1e-6 <= x <= X1 + 1e-6 and oy - 1e-6 <= y <= Y1 + 1e-6

    # 층
    fl = scene['floors']; fz, fidx = {}, {}
    if v.lst(fl, '$.floors', L['floors'], 1):
        for i, f in enumerate(fl):
            p = f'$.floors[{i}]'
            if v.obj(f, p, ('id', 'name', 'z', 'height')) and v.ident(f['id'], p + '.id'):
                v.text(f['name'], p + '.name')
                if v.num(f['z'], p + '.z', 0, 200) and v.num(f['height'], p + '.height', 1, 10):
                    fz[f['id']], fidx[f['id']] = f['z'], i
        zs = [f.get('z') for f in fl if isinstance(f, dict)]
        if not v.bad:
            if zs[0] != 0:
                v.err('$.floors[0].z', 'range', '첫 층 z 는 0(지면)이어야 합니다')
            for i in range(1, len(zs)):
                if zs[i] - zs[i - 1] < 1.0 - EPS:
                    v.err(f'$.floors[{i}].z', 'range', '층은 아래층보다 1 m 이상 위, 오름차순이어야 합니다')
    if v.bad:
        return v.issues, None
    order = [f['id'] for f in fl]

    def floor_ref(val, path):
        if not isinstance(val, str) or val not in fz:
            v.err(path, 'ref', f'없는 층 «{val}»'); return False
        return True

    # 요소
    rects, stairs = [], []
    els = scene['elements']
    if v.lst(els, '$.elements', L['elements']):
        for i, e in enumerate(els):
            p = f'$.elements[{i}]'
            t = e.get('type') if isinstance(e, dict) else None
            t = t if isinstance(t, str) else None
            keys = {'wall': ('id', 'type', 'floor', 'a', 'b', 'thickness', 'height'),
                    'box': ('id', 'type', 'floor', 'center', 'size', 'yaw'),
                    'stairs': ('id', 'type', 'floor', 'to_floor', 'start', 'yaw', 'steps', 'riser', 'tread', 'width')}.get(t)
            if keys is None:
                v.err(p + '.type', 'enum', "wall·box·stairs 중 하나"); continue
            if not v.obj(e, p, keys) or not v.ident(e['id'], p + '.id') or not floor_ref(e['floor'], p + '.floor'):
                continue
            z = fz[e['floor']]
            if t == 'wall':
                ok = [v.vec(e['a'], p + '.a', 2, -10000, 10000), v.vec(e['b'], p + '.b', 2, -10000, 10000),
                      v.num(e['thickness'], p + '.thickness', 0.05, 1.0), v.num(e['height'], p + '.height', 0.05, 10)]
                if not all(ok):
                    continue
                (ax, ay), (bx, by) = e['a'], e['b']
                ln = math.hypot(bx - ax, by - ay)
                if ln < 0.05 - EPS:
                    v.err(p, 'range', '벽 길이는 0.05 m 이상'); continue
                rs = [_rect((ax + bx) / 2, (ay + by) / 2, ln / 2, e['thickness'] / 2, math.atan2(by - ay, bx - ax), z, z + e['height'], 'wall', e['id'])]
            elif t == 'box':
                ok = [v.vec(e['center'], p + '.center', 2, -10000, 10000), v.vec(e['size'], p + '.size', 3, 0.05, 50),
                      v.num(e['yaw'], p + '.yaw', -2 * math.pi, 2 * math.pi)]
                if not all(ok):
                    continue
                sx, sy, sz = e['size']
                rs = [_rect(e['center'][0], e['center'][1], sx / 2, sy / 2, e['yaw'], z, z + sz, 'box', e['id'])]
            else:
                ok = [floor_ref(e['to_floor'], p + '.to_floor'), v.vec(e['start'], p + '.start', 2, -10000, 10000),
                      v.num(e['yaw'], p + '.yaw', -2 * math.pi, 2 * math.pi), v.num(e['steps'], p + '.steps', 2, 40, True),
                      v.num(e['riser'], p + '.riser', 0.05, 0.25), v.num(e['tread'], p + '.tread', 0.15, 0.60),
                      v.num(e['width'], p + '.width', 0.5, 4.0)]
                if not all(ok):
                    continue
                if fidx[e['to_floor']] != fidx[e['floor']] + 1:
                    v.err(p + '.to_floor', 'ref', '계단은 바로 위층으로만 이어집니다'); continue
                rise = fz[e['to_floor']] - z
                if abs(e['steps'] * e['riser'] - rise) > 0.005 + EPS:
                    v.err(p, 'stairs_rise', f"단 수×단 높이 {e['steps'] * e['riser']:.3f} m ≠ 두 층 높이 차 {rise:.3f} m"); continue
                if sum(1 for x, _ in stairs if x['to_floor'] == e['to_floor']) >= L['stairs_per_floor']:
                    v.err(p, 'count', f"한 층에 도착하는 계단은 {L['stairs_per_floor']}개까지"); continue
                rs, foot = _stair_rects(e, z)
                stairs.append((e, foot))
                v.add('warn', 'stairs_range_unverified', p, 'Gazebo 계단 오르기 검증 치수 범위 미확인 — 형식 상한만 검사', floor=e['floor'])
                if abs(math.sin(2 * e['yaw'])) > 1e-6:
                    v.add('warn', 'stair_hole_aabb', p, '회전된 계단의 위층 구멍은 축정렬 사각형으로 근사합니다', floor=e['to_floor'])
            for r in rs if t != 'stairs' else rs + [foot]:
                if not all(in_world(x, y) for x, y in _corners(r)):
                    v.err(p, 'outside', '세계 사각형 밖으로 나갑니다', at=[r['cx'], r['cy']], floor=e['floor']); break
            else:
                rects += rs
                k = fidx[e['floor']]
                if t != 'stairs' and k + 1 < len(order) and rs[0]['z1'] > fz[order[k + 1]] + BAND[0]:
                    v.add('warn', 'element_above_floor', p, '높이가 위층 바닥을 뚫습니다(위층 지도에도 막힘으로 나옴)', floor=e['floor'])

    # 로봇·센서
    robots = scene['robots']; rfloor = {}
    if v.lst(robots, '$.robots', L['robots']):
        lidar = False
        for i, r in enumerate(robots):
            p = f'$.robots[{i}]'
            if not v.obj(r, p, ('id', 'name', 'model', 'floor', 'pose', 'sensors')) or not v.ident(r['id'], p + '.id', 24):
                continue
            v.text(r['name'], p + '.name'); v.enum(r['model'], p + '.model', ('go2_proxy',))
            if floor_ref(r['floor'], p + '.floor') and v.vec(r['pose'], p + '.pose', 3, -10000, 10000):
                if not in_world(*r['pose'][:2]):
                    v.err(p + '.pose', 'outside', '세계 사각형 밖입니다')
                elif not abs(r['pose'][2]) <= 2 * math.pi + EPS:
                    v.err(p + '.pose[2]', 'range', '|yaw| ≤ 2π')
                else:
                    rfloor[r['id']] = r['floor']
            if v.lst(r['sensors'], p + '.sensors', L['sensors']):
                for j, s in enumerate(r['sensors']):
                    q = f'{p}.sensors[{j}]'
                    if v.obj(s, q, ('id', 'kind', 'mount')) and v.ident(s['id'], q + '.id'):
                        v.enum(s['kind'], q + '.kind', SENSOR_KINDS)
                        lidar |= isinstance(s['kind'], str) and s['kind'].startswith('lidar')
                        if v.vec(s['mount'], q + '.mount', 4, -2 * math.pi, 2 * math.pi):
                            m = s['mount']
                            if not (abs(m[0]) <= 1 and abs(m[1]) <= 1 and 0 <= m[2] <= 1.5):
                                v.err(q + '.mount', 'range', '장착 위치는 로봇 기준 |x|,|y| ≤ 1 m, 0 ≤ z ≤ 1.5 m')
        if robots:
            v.add('warn', 'generic_proxy_not_gait', '$.robots', '로봇 모델은 generic proxy — 보행·계단 검증 아님')
        if lidar:
            v.add('warn', 'lidar_spec_unconfirmed', '$.robots', '라이다 L1/L2 최종 선택·사양 미확인 — 종류 표기만')

    # 장비
    eq = scene['equipment']
    if v.lst(eq, '$.equipment', L['equipment']):
        for i, e in enumerate(eq):
            p = f'$.equipment[{i}]'
            if v.obj(e, p, ('id', 'kind', 'floor', 'pose', 'label')) and v.ident(e['id'], p + '.id'):
                v.enum(e['kind'], p + '.kind', EQUIP_KINDS); v.text(e['label'], p + '.label'); floor_ref(e['floor'], p + '.floor')
                if v.vec(e['pose'], p + '.pose', 3, -10000, 10000) and not in_world(*e['pose'][:2]):
                    v.err(p + '.pose', 'outside', '세계 사각형 밖입니다')

    # 경로
    rts = scene['routes']; rinfo = {}
    if v.lst(rts, '$.routes', L['routes']):
        total = 0
        for i, r in enumerate(rts):
            p = f'$.routes[{i}]'
            if not v.obj(r, p, ('id', 'robot', 'floor', 'points')) or not v.ident(r['id'], p + '.id'):
                continue
            ok = floor_ref(r['floor'], p + '.floor')
            if not isinstance(r['robot'], str) or r['robot'] not in rfloor:
                v.err(p + '.robot', 'ref', f"없는 로봇 «{r['robot']}»"); ok = False
            if v.lst(r['points'], p + '.points', L['route_points'], 2):
                total += len(r['points'])
                for j, pt in enumerate(r['points']):
                    if v.vec(pt, f'{p}.points[{j}]', 2, -10000, 10000) and not in_world(*pt):
                        v.err(f'{p}.points[{j}]', 'outside', '세계 사각형 밖입니다'); ok = False
            else:
                ok = False
            if ok and not v.bad:
                rinfo[r['id']] = r
        if total > L['route_points_total']:
            v.err('$.routes', 'count', f"경로 점 합계 {total} > {L['route_points_total']}")

    # 배치안
    sc = scene['scenarios']
    if v.lst(sc, '$.scenarios', L['scenarios']):
        for i, s in enumerate(sc):
            p = f'$.scenarios[{i}]'
            if not v.obj(s, p, ('id', 'name', 'robots', 'routes')) or not v.ident(s['id'], p + '.id'):
                continue
            v.text(s['name'], p + '.name')
            if v.lst(s['robots'], p + '.robots', L['robots']) and v.lst(s['routes'], p + '.routes', L['routes']):
                if len(set(map(str, s['robots']))) != len(s['robots']) or len(set(map(str, s['routes']))) != len(s['routes']):
                    v.err(p, 'dup', '배치안 안에서 같은 로봇·경로를 두 번 넣을 수 없습니다')
                for j, rid in enumerate(s['robots']):
                    if not isinstance(rid, str) or rid not in rfloor:
                        v.err(f'{p}.robots[{j}]', 'ref', f'없는 로봇 «{rid}»')
                for j, rt in enumerate(s['routes']):
                    if not isinstance(rt, str) or rt not in rinfo:
                        v.err(f'{p}.routes[{j}]', 'ref', f'없는 경로 «{rt}»')
                    elif rinfo[rt]['robot'] not in s['robots']:
                        v.err(f'{p}.routes[{j}]', 'ref', f"경로의 로봇 «{rinfo[rt]['robot']}» 이 이 배치안 로봇 목록에 없습니다")
    if v.bad:
        return v.issues, None

    geo = Geo(scene, rects, stairs, bud)
    if len(geo.rects) > L['boxes']:
        v.err('$.elements', 'count', f"계단·바닥판을 펼친 상자 {len(geo.rects)} > {L['boxes']}")
        return v.issues, None
    # 점 검사 = 그 층 래스터 칸값 그대로(지도와 같은 판정)
    for i, r in enumerate(robots):
        if geo.cell(r['floor'], *r['pose'][:2]) != 254:
            v.err(f'$.robots[{i}].pose', 'robot_blocked', '출발 위치가 막힌 칸이거나 바닥이 없습니다', at=r['pose'][:2], floor=r['floor'])
    for i, r in enumerate(rts):
        for j, pt in enumerate(r['points']):
            if geo.cell(r['floor'], *pt) == 205:
                v.err(f'$.routes[{i}].points[{j}]', 'route_no_floor', '경로 점에 바닥이 없습니다', at=pt, floor=r['floor'])
    bg = w['background']
    if bg is not None:
        _check_bg(v, bg, fz, in_world)
    return v.issues, (None if v.bad else geo)


def _check_bg(v, bg, fz, in_world):
    p = '$.world.background'
    if not v.obj(bg, p, ('mime', 'data_b64', 'floor', 'ref_px', 'ref_m')):
        return
    if not v.enum(bg['mime'], p + '.mime', ('image/png', 'image/jpeg')):
        return
    if not isinstance(bg['floor'], str) or bg['floor'] not in fz:
        v.err(p + '.floor', 'ref', f"없는 층 «{bg['floor']}»")
    d = bg['data_b64']
    if not isinstance(d, str) or len(d) > (L['background_bytes'] + 2) // 3 * 4:
        v.err(p + '.data_b64', 'size', f"배경 도면은 {L['background_bytes'] // 1024} KiB 이하(화면에서 축소·압축)"); return
    try:
        raw = base64.b64decode(d, validate=True)
    except (binascii.Error, ValueError):
        v.err(p + '.data_b64', 'base64', 'base64 형식이 아닙니다'); return
    wh = _img_size(bg['mime'], raw)
    if wh is None:
        v.err(p + '.data_b64', 'image', f"{bg['mime']} 머리를 읽을 수 없습니다"); return
    if not (1 <= wh[0] <= L['background_px'] and 1 <= wh[1] <= L['background_px']):
        v.err(p + '.data_b64', 'image', f"배경 도면은 가로·세로 {L['background_px']} px 이하"); return
    for k, lim in (('ref_px', (0, max(wh))), ('ref_m', (-10000, 10000))):
        if v.lst(bg[k], f'{p}.{k}', 2, 2) and all([v.vec(q, f'{p}.{k}[{i}]', 2, *lim) for i, q in enumerate(bg[k])]):
            (a, b), (c, d2) = bg[k]
            if math.hypot(c - a, d2 - b) < 1e-3:
                v.err(f'{p}.{k}', 'range', '두 기준점이 같습니다')
            if k == 'ref_px' and not all(0 <= q[0] <= wh[0] and 0 <= q[1] <= wh[1] for q in bg[k]):
                v.err(f'{p}.{k}', 'range', '기준점이 이미지 밖입니다')


# ───────────────────────────── 기하 ─────────────────────────────
class Geo:
    """검증을 통과한 scene 의 상자 목록(벽·상자·계단 단·위층 바닥판)과 층 정보. 세계·지도·검토가 모두 이것 하나에서 나온다."""

    def __init__(self, scene, rects, stairs, bud=FREE):
        self.bud, self._img = bud, {}
        w = scene['world']
        self.ox, self.oy = w['origin']; self.sx, self.sy = w['size']
        self.W, self.H = math.ceil(self.sx / RES - 1e-9), math.ceil(self.sy / RES - 1e-9)
        self.floors = scene['floors']; self.fz = {f['id']: f['z'] for f in self.floors}
        self.holes = collections.defaultdict(list)
        for e, foot in stairs:
            xs, ys = zip(*_corners(foot))
            self.holes[e['to_floor']].append((min(xs), min(ys), max(xs), max(ys)))
        self.rects = list(rects)
        for f in self.floors[1:]:
            self.rects += self._slab(f)

    def _slab(self, f):
        """위층 바닥판 = 세계 사각형 − 계단 도착 구멍(축정렬). 격자 분해 후 가로로 이어 붙인다."""
        x0, y0, x1, y1 = self.ox, self.oy, self.ox + self.sx, self.oy + self.sy
        hs = [(max(a, x0), max(b, y0), min(c, x1), min(d, y1)) for a, b, c, d in self.holes.get(f['id'], [])]
        xs = sorted({x0, x1, *[h[0] for h in hs], *[h[2] for h in hs]})
        ys = sorted({y0, y1, *[h[1] for h in hs], *[h[3] for h in hs]})
        out, z = [], f['z']
        for j in range(len(ys) - 1):
            run = None
            for i in range(len(xs) - 1):
                self.bud.tick(1 + len(hs))
                mx, my = (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2
                hole = any(a < mx < c and b < my < d for a, b, c, d in hs)
                if not hole and run is None:
                    run = xs[i]
                if (hole or i == len(xs) - 2) and run is not None:
                    end = xs[i] if hole else xs[i + 1]
                    if end - run > EPS and ys[j + 1] - ys[j] > EPS:
                        out.append(_rect((run + end) / 2, (ys[j] + ys[j + 1]) / 2, (end - run) / 2, (ys[j + 1] - ys[j]) / 2, 0.0,
                                         z - SLAB_T, z, 'slab', f['id']))
                    run = None
        return out

    def on_floor(self, fid):
        """이 층 지도에서 막힘 상자·지지 상자."""
        z = self.fz[fid]
        occ = [r for r in self.rects if r['z1'] > z + BAND[0] and r['z0'] < z + BAND[1]]
        sup = [r for r in self.rects if z + SUP[0] <= r['z1'] <= z + SUP[1]]
        return occ, sup

    def img(self, fid):
        """층 래스터(한 번만 만들고 재사용 — 검증·검토·내보내기가 같은 칸값)."""
        if fid not in self._img:
            self._img[fid] = raster(self, fid)
        return self._img[fid]

    def cell(self, fid, x, y):
        """그 점이 속한 0.05 m 칸의 지도값(0 막힘 / 254 빈칸 / 205 바닥 없음)."""
        ix = min(self.W - 1, max(0, int((x - self.ox) // RES))); iy = min(self.H - 1, max(0, int((y - self.oy) // RES)))
        return self.img(fid)[iy * self.W + ix]


def _fill(buf, W, H, ox, oy, res, r, grow=0.0, bud=FREE):
    """회전 사각형(+grow)이 덮는 칸(중심 포함)을 1 로. 행마다 두 띠(국소 x·y)의 교집합 = x 구간."""
    hx, hy, c, s = r['hx'] + grow, r['hy'] + grow, r['c'], r['s']
    ey = abs(s) * hx + abs(c) * hy
    r0 = max(0, math.ceil((r['cy'] - ey - oy) / res - 0.5 - 1e-6)); r1 = min(H - 1, math.floor((r['cy'] + ey - oy) / res - 0.5 + 1e-6))
    for row in range(r0, r1 + 1):
        bud.tick(1 + W // 256)
        dy = oy + (row + 0.5) * res - r['cy']
        lo, hi = -math.inf, math.inf
        for k, off, h in ((c, dy * s, hx), (-s, dy * c, hy)):      # |k·dx + off| ≤ h
            h += EPS
            if abs(k) < 1e-12:
                if abs(off) > h:
                    lo, hi = 1, 0
                continue
            a, b = (-h - off) / k, (h - off) / k
            lo, hi = max(lo, min(a, b)), min(hi, max(a, b))
        if lo > hi:
            continue
        a = max(0, math.ceil((r['cx'] + lo - ox) / res - 0.5 - 1e-6)); b = min(W - 1, math.floor((r['cx'] + hi - ox) / res - 0.5 + 1e-6))
        if a <= b:
            buf[row * W + a:row * W + b + 1] = ONES[:b - a + 1]


def raster(geo, fid):
    """층 하나의 trinary 칸값(행 0 = y 최소). 막힘 0 / 빈칸 254 / 바닥 없음 205."""
    W, H = geo.W, geo.H
    occ_r, sup_r = geo.on_floor(fid)
    geo.bud.tick(W * H // 4096 + 1)
    occ = bytearray(W * H)
    for r in occ_r:
        _fill(occ, W, H, geo.ox, geo.oy, RES, r, bud=geo.bud)
    if fid == geo.floors[0]['id']:
        sup = bytearray(ONES[:1]) * (W * H)
    else:
        sup = bytearray(W * H)
        for r in sup_r:
            _fill(sup, W, H, geo.ox, geo.oy, RES, r, bud=geo.bud)
    both = ((int.from_bytes(occ, 'big') << 1) | int.from_bytes(sup, 'big')).to_bytes(W * H, 'big')   # 칸마다 occ·2 + sup (0..3)
    return both.translate(bytes([205, 254, 0, 0] + [0] * 252))


def pgm(geo, img):
    W, H = geo.W, geo.H
    rows = b''.join(img[r * W:(r + 1) * W] for r in range(H - 1, -1, -1))    # 첫 줄 = y 최대
    return f'P5\n{W} {H}\n255\n'.encode() + rows


def map_yaml(geo):
    return (f'image: map.pgm\nmode: trinary\nresolution: {RES}\norigin: [{geo.ox!r}, {geo.oy!r}, 0]\n'
            'negate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.25\n')


# ───────────────────────────── 2D 기하 검토 ─────────────────────────────
def _seg_x(p, q, a, b):
    """선분 pq·ab 교점(끝점 닿음 포함) 또는 None."""
    d = (q[0] - p[0]) * (b[1] - a[1]) - (q[1] - p[1]) * (b[0] - a[0])
    if abs(d) < 1e-12:
        return None                                    # 평행(겹침은 교차로 세지 않는다 — 근사)
    t = ((a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0])) / d
    u = ((a[0] - p[0]) * (q[1] - p[1]) - (a[1] - p[1]) * (q[0] - p[0])) / d
    if -EPS <= t <= 1 + EPS and -EPS <= u <= 1 + EPS:
        return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
    return None


def analyze(scene, bud=FREE):
    """검증 + 2D 기하 검토. 반환 = API.md Analysis. 물리·넘어짐·실제 도달 판정 아님. 자원 초과는 Overload(부분 결과 없음)."""
    issues, geo = validate(scene, bud)
    out = dict(ok=False, issues=issues, truncated=False, floors=[], routes=[], crossings=[], note=NOTE)
    if geo is not None:
        out['ok'] = True
        for f in geo.floors:
            img = geo.img(f['id'])
            out['floors'].append(dict(id=f['id'], free=img.count(254), blocked=img.count(0), no_floor=img.count(205)))
        _review(scene, geo, out)
    for k in ('issues', 'crossings'):
        if len(out[k]) > L['issues']:
            out[k], out['truncated'] = out[k][:L['issues']], True
    return out


def _labels(g, CW, CH, bud):
    """막히지 않은 칸의 4-이웃 연결 성분 번호(0 = 막힘). 층마다 한 번 — 로봇 수와 무관."""
    lab, n = [0] * (CW * CH), 0
    for s in range(CW * CH):
        if g[s] or lab[s]:
            continue
        n += 1; lab[s] = n; q = collections.deque([s])
        while q:
            i = q.popleft(); x = i % CW
            bud.tick()
            for j, ok in ((i - 1, x > 0), (i + 1, x < CW - 1), (i - CW, i >= CW), (i + CW, i + CW < CW * CH)):
                if ok and not g[j] and not lab[j]:
                    lab[j] = n; q.append(j)
    return lab


def _review(scene, geo, out):
    bud = geo.bud
    CW, CH = math.ceil(geo.sx / COARSE - 1e-9), math.ceil(geo.sy / COARSE - 1e-9)
    used = {r['floor'] for r in scene['robots']} | {r['floor'] for r in scene['routes']}
    grids, labs = {}, {}
    for f in geo.floors:                               # 0.2 m 격자, 몸 반경 0.35 m 만큼 사각형을 키워 막음(모서리는 보수 근사)
        if f['id'] not in used:
            continue
        g = bytearray(CW * CH)
        occ, _ = geo.on_floor(f['id'])
        for r in occ:
            _fill(g, CW, CH, geo.ox, geo.oy, COARSE, r, BODY_R, bud)
        for a, b, c, d in geo.holes.get(f['id'], []):
            _fill(g, CW, CH, geo.ox, geo.oy, COARSE, _rect((a + c) / 2, (b + d) / 2, (c - a) / 2, (d - b) / 2, 0, 0, 0, 'hole', ''), BODY_R, bud)
        grids[f['id']], labs[f['id']] = g, _labels(g, CW, CH, bud)

    def ci(x, y):
        return min(CH - 1, max(0, int((y - geo.oy) // COARSE))) * CW + min(CW - 1, max(0, int((x - geo.ox) // COARSE)))

    def around(c, k):                                  # c 칸과 k 칸 이내 이웃
        x, y = c % CW, c // CW
        return [yy * CW + xx for xx in range(x - k, x + k + 1) for yy in range(y - k, y + k + 1) if 0 <= xx < CW and 0 <= yy < CH]

    reach = {}
    robots = {r['id']: r for r in scene['robots']}
    for rid, r in robots.items():                       # 출발 칸이 막혀(벽 가까이) 있어도 바로 옆 빈 칸의 성분에서 시작
        lab, s = labs[r['floor']], ci(*r['pose'][:2])
        reach[rid] = {lab[j] for j in around(s, 1) if lab[j]}

    def add(level, code, path, msg, **kw):
        out['issues'].append(dict(level=level, code=code, path=path, msg=msg, **kw))

    for i, rt in enumerate(scene['routes']):
        pts, g, rb = rt['points'], grids[rt['floor']], robots[rt['robot']]
        length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
        blocked, unreach = [], []
        for k, (a, b) in enumerate(zip(pts, pts[1:])):
            n = max(1, math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / (COARSE / 2)))
            bud.tick(n + 1)
            if any(g[ci(a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n)] for t in range(n + 1)):
                blocked.append(k)
                add('warn', 'route_blocked', f'$.routes[{i}].points[{k}]', '선분이 장애물(몸 반경 0.35 m 근사)에 걸립니다', at=a, floor=rt['floor'])
        if rb['floor'] != rt['floor']:
            add('warn', 'route_other_floor', f'$.routes[{i}]', '로봇 출발 층과 다른 층 경로 — 층 사이 이동은 지도로 판정하지 않습니다', floor=rt['floor'])
        else:
            lab, ok = labs[rt['floor']], reach[rt['robot']]
            for k, pt in enumerate(pts):
                if not any(lab[j] in ok for j in around(ci(*pt), 1)):
                    unreach.append(k)
                    add('warn', 'route_unreachable', f'$.routes[{i}].points[{k}]', '출발점에서 같은 층 2D 연결이 없습니다', at=pt, floor=rt['floor'])
        out['routes'].append(dict(id=rt['id'], robot=rt['robot'], length_m=round(length, 3), blocked_segments=blocked, unreachable_points=unreach))

    rmap = {r['id']: r for r in scene['routes']}
    memo = {}                                          # 경로 쌍의 첫 교점 — 여러 배치안이 같은 쌍을 써도 한 번만 계산

    def first_hit(A, B):
        key = (A['id'], B['id'])
        if key not in memo:
            memo[key] = None
            for p, q in zip(A['points'], A['points'][1:]):
                bud.tick(len(B['points']))
                memo[key] = next((h for a, b in zip(B['points'], B['points'][1:]) if (h := _seg_x(p, q, a, b))), None)
                if memo[key]:
                    break
        return memo[key]

    for si, s in enumerate(scene['scenarios']):
        ids = sorted(s['routes'])
        for x in range(len(ids)):
            for y in range(x + 1, len(ids)):
                A, B = rmap[ids[x]], rmap[ids[y]]
                if A['robot'] == B['robot'] or A['floor'] != B['floor']:
                    continue
                hit = first_hit(A, B)
                if hit:
                    out['crossings'].append(dict(scenario=s['id'], a=A['id'], b=B['id'], at=hit))
                    add('warn', 'route_crossing', f'$.scenarios[{si}]',
                        f"배치안 {s['id']}: 경로 {A['id']}·{B['id']} 가 교차합니다(시간 겹침은 판정하지 않음)", at=hit, floor=A['floor'])


# ───────────────────────────── 내보내기 ─────────────────────────────
WORLD_HEAD = """<?xml version="1.0" ?>
<!-- server/rehearsal.py 생성 — 계획용 정적 세계. 로봇·센서는 넣지 않음(plan.json). 손으로 고치지 말 것 -->
<sdf version="1.9">
  <world name="fh_rehearsal">
    <physics name="1ms" type="ignored"><max_step_size>0.001</max_step_size><real_time_factor>1.0</real_time_factor></physics>
    <plugin filename="gz-sim-physics-system" name="gz::sim::systems::Physics"/>
    <plugin filename="gz-sim-user-commands-system" name="gz::sim::systems::UserCommands"/>
    <plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"/>
    <scene><ambient>0.5 0.5 0.5 1</ambient><background>0.7 0.8 0.95 1</background><shadows>false</shadows><grid>false</grid></scene>
    <light type="directional" name="sun"><cast_shadows>false</cast_shadows><pose>0 0 10 0 0 0</pose><diffuse>0.9 0.9 0.9 1</diffuse><direction>-0.4 0.2 -0.9</direction></light>
    <model name="ground_plane"><static>true</static><link name="link">
      <collision name="collision"><geometry><plane><normal>0 0 1</normal><size>200 200</size></plane></geometry></collision>
      <visual name="visual"><geometry><plane><normal>0 0 1</normal><size>200 200</size></plane></geometry><material><ambient>0.8 0.8 0.8 1</ambient><diffuse>0.8 0.8 0.8 1</diffuse></material></visual>
    </link></model>
"""
COLORS = {'wall': '0.82 0.80 0.74', 'box': '0.55 0.45 0.35', 'stairs': '0.45 0.55 0.70', 'slab': '0.75 0.75 0.72'}


def world_sdf(geo):
    el = []
    for i, r in enumerate(geo.rects):
        size = f"{2 * r['hx']:.5f} {2 * r['hy']:.5f} {r['z1'] - r['z0']:.5f}"
        pose = f"{r['cx']:.5f} {r['cy']:.5f} {(r['z0'] + r['z1']) / 2:.5f} 0 0 {math.atan2(r['s'], r['c']):.6f}"
        col = COLORS[r['kind']]
        nm = quoteattr(f"{r['kind']}_{i}_{r['eid']}")       # eid 는 ID 규칙 통과값이지만 그래도 escape
        geom = f'<geometry><box><size>{size}</size></box></geometry>'
        el.append(f'      <collision name={nm}><pose>{pose}</pose>{geom}</collision>\n'
                  f'      <visual name={nm}><pose>{pose}</pose>{geom}<material><ambient>{col} 1</ambient><diffuse>{col} 1</diffuse></material></visual>\n')
    return (WORLD_HEAD + '    <model name="fh_scene"><static>true</static><link name="link">\n' + ''.join(el)
            + '    </link></model>\n  </world>\n</sdf>\n')


def plan(scene):
    robots = {r['id']: r for r in scene['robots']}
    fz = {f['id']: f['z'] for f in scene['floors']}
    out = []
    for s in scene['scenarios']:
        rs = []
        for rid in s['robots']:
            r = robots[rid]; ns = f'/{rid}'
            topics = {'cmd_vel': f'{ns}/cmd_vel', 'odom': f'{ns}/odom'}
            if any(x['kind'].startswith('lidar') for x in r['sensors']):
                topics['scan'] = f'{ns}/scan'
            rs.append(dict(robot_id=rid, namespace=ns, model='generic_proxy', floor=r['floor'],
                           spawn=dict(x=r['pose'][0], y=r['pose'][1], z=fz[r['floor']], yaw=r['pose'][2]),
                           planned_topics=topics, sensors=[dict(id=x['id'], kind=x['kind'], mount=x['mount']) for x in r['sensors']],
                           routes=[t for t in s['routes'] if any(rt['id'] == t and rt['robot'] == rid for rt in scene['routes'])]))
        out.append(dict(scenario=s['id'], name=s['name'], robots=rs))
    return dict(schema='fh_rehearsal_plan/1', note='계획값 — 기동·연결·이름공간 적용 아님. generic proxy 는 보행 검증 아님', scenarios=out)


def _jbytes(o):
    return json.dumps(o, ensure_ascii=False, indent=1, sort_keys=True).encode()


def export_zip(scene, project, bud=FREE):
    """검증 통과 scene → (zip bytes, issues). 같은 입력이면 같은 바이트(시각·순서 고정). 오류면 (None, issues). 자원 초과는 Overload."""
    issues, geo = validate(scene, bud)
    if geo is None:
        return None, issues
    sc = json.loads(json.dumps(scene))
    if sc['world']['background'] is not None:
        bg = sc['world']['background']
        bg['data_sha256'] = hashlib.sha256(base64.b64decode(bg.pop('data_b64'))).hexdigest()
    files = [('world.sdf', world_sdf(geo).encode())]
    for f in geo.floors:
        files += [(f"floors/{f['id']}/map.pgm", pgm(geo, geo.img(f['id']))), (f"floors/{f['id']}/map.yaml", map_yaml(geo).encode())]
        bud.tick(geo.W * geo.H // 4096 + 1)
    files += [('scene.json', _jbytes(sc)), ('plan.json', _jbytes(plan(scene)))]
    man = dict(schema='fh_rehearsal_export/1', generator=GEN, project=project, resolution=RES, origin=[geo.ox, geo.oy],
               size_cells=[geo.W, geo.H], floors=[dict(id=f['id'], z=f['z']) for f in geo.floors],
               files={n: hashlib.sha256(b).hexdigest() for n, b in files},
               provenance=dict(source='저장된 판 하나(project.id·rev)에서 서버가 생성', scene_sha256_of='저장 판 scene 정규 JSON(배경 본문 포함)',
                               generator=GEN, gazebo_or_ros_run=False),
               cautions=['계단 치수: Gazebo 오르기 검증 범위 미확인', '로봇 모델 generic proxy — 보행 검증 아님',
                         'Gazebo·ROS 실행 0 — 이 파일은 생성물이며 실행 증거가 아님', '2D 지도에서 계단은 아래층 막힘·위층 구멍 바닥 없음',
                         'scene.json 은 배경 본문을 data_sha256 으로 바꾼 기록본 — 다시 불러올 설계도가 아님(원 설계도 JSON 은 화면에서 따로 내보냄)'],
               warnings=[i for i in issues if i['level'] == 'warn'][:L['issues']])
    files.append(('manifest.json', _jbytes(man)))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for n, b in files:
            zi = zipfile.ZipInfo(n, date_time=(1980, 1, 1, 0, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, b)
    bud.tick(1)                                        # 압축 뒤 시간 한 번 더(압축 입력은 total_cells 로 묶임)
    return buf.getvalue(), issues


# ───────────────────────────── 저장소 ─────────────────────────────
def canon(scene):
    return json.dumps(scene, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def _canon_or_none(scene):
    try:
        return canon(scene)
    except (TypeError, ValueError, RecursionError):
        return None


def _sha(scene):
    return hashlib.sha256(canon(scene)).hexdigest()


class Store:
    """<root>/projects/<id>/r000001.json…(불변 판, envelope 안에 scene 정규 JSON sha256). 목록 메타는 최신 판에서 매번 유도(head 파일 없음).
    잠금 = 스레드 lock + flock(<root>/.lock). 삭제 = <root>/.trash/ 로 이동(파일 삭제 없음, 용량 상한에 계속 포함).
    심볼릭 링크·일반 파일/폴더가 아닌 것·판 내용 불일치는 따라가거나 고치지 않고 Damaged(→ 503, 목록은 damaged)."""

    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.Lock()
        self.broken = None
        try:
            if not os.path.lexists(self.root.parent):
                os.makedirs(self.root.parent, 0o700, exist_ok=True)
            self._chk_dir(self.root.parent, '상위 폴더', create=False)
            for p, what in ((self.root, '저장소 폴더'), (self.root / 'projects', 'projects'), (self.root / '.trash', '.trash')):
                self._chk_dir(p, what)
        except Damaged as e:
            self.broken = str(e)

    @staticmethod
    def _chk_dir(p, what, create=True):
        if create and not os.path.lexists(p):
            try:
                os.mkdir(p, 0o700)
            except FileExistsError:
                pass
        st = os.lstat(p)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            raise Damaged(f'{what}({p.name}) 가 심볼릭 링크이거나 폴더가 아닙니다 — 따라가거나 고치지 않았습니다')

    def _base(self):
        """매 요청 시작에 저장소 골격을 다시 확인(열 때 뒤 바꿔치기 대비)."""
        if self.broken:
            raise Damaged(self.broken)
        for p, what in ((self.root.parent, '상위 폴더'), (self.root, '저장소 폴더'), (self.root / 'projects', 'projects'), (self.root / '.trash', '.trash')):
            self._chk_dir(p, what, create=False)

    @contextlib.contextmanager
    def _locked(self):
        with self.lock:
            self._base()
            fd = os.open(self.root / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise Damaged('.lock 이 일반 파일이 아닙니다')
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                os.close(fd)                               # close 가 flock 도 푼다

    def _dir(self, pid):
        """프로젝트 폴더(없으면 None). 링크·폴더 아님 → Damaged."""
        d = self.root / 'projects' / pid
        if not os.path.lexists(d):
            return None
        self._chk_dir(d, f'프로젝트 {pid}', create=False)
        return d

    def _revs(self, pid):
        d = self._dir(pid)
        if d is None:
            return []
        revs = []
        for n in os.listdir(d):
            if REV_RE.fullmatch(n):
                if not stat.S_ISREG(os.lstat(d / n).st_mode):
                    raise Damaged(f'판 파일이 일반 파일이 아닙니다({pid}/{n})')
                revs.append(int(n[1:7]))
        return sorted(revs)

    def _read(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)     # 링크면 ELOOP
        with os.fdopen(fd, 'rb') as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > L['scene_bytes'] * 3 + 65536:
                raise Damaged(f'판 파일이 일반 파일이 아니거나 너무 큽니다({path.parent.name}/{path.name})')
            return json.loads(f.read().decode('utf-8'))

    def _env(self, pid, rev):
        """판 하나 = 형식·id·rev·scene 정규 sha 가 모두 맞아야 쓴다(아니면 Damaged)."""
        try:
            e = self._read(self.root / 'projects' / pid / f'r{rev:06d}.json')
            ok = (isinstance(e, dict) and e.get('schema') == REV_SCHEMA and e.get('id') == pid and type(e.get('rev')) is int
                  and e['rev'] == rev and isinstance(e.get('scene'), dict) and isinstance(e.get('at'), str) and isinstance(e.get('by'), str)
                  and e.get('sha256') == _sha(e['scene']))
        except (OSError, ValueError, UnicodeDecodeError) as x:
            raise Damaged(f'판 파일을 읽을 수 없습니다({pid} r{rev} · {type(x).__name__})')
        if not ok:
            raise Damaged(f'판 파일 내용이 맞지 않습니다({pid} r{rev}) — 손대지 않았습니다')
        return e

    def _meta_of(self, e):
        sc = e['scene']
        return dict(id=e['id'], name=sc.get('name', ''), rev=e['rev'], sha256=e['sha256'], at=e['at'], by=e['by'],
                    bytes=len(canon(sc)), counts={k: len(sc[k]) if isinstance(sc.get(k), list) else 0
                                                  for k in ('floors', 'elements', 'robots', 'routes', 'scenarios')})

    def _meta(self, pid):
        revs = self._revs(pid)
        return self._meta_of(self._env(pid, revs[-1])) if revs else None

    def listing(self):
        try:
            self._base()
        except (Damaged, OSError) as e:
            return dict(projects=[], damaged=[], limits=LIMITS, broken=str(e) if isinstance(e, Damaged) else '저장소를 읽을 수 없습니다')
        out, damaged = [], []
        for n in sorted(os.listdir(self.root / 'projects')):
            if not PID_RE.fullmatch(n):
                continue
            try:
                m = self._meta(n)
                if m:
                    out.append(m)
            except (Damaged, OSError):
                damaged.append(n)
        out.sort(key=lambda m: m['at'], reverse=True)
        return dict(projects=out, damaged=damaged, limits=LIMITS)

    def _used(self):
        """projects + .trash(삭제 보존분) + 임시 파일 전부 — 삭제를 반복해도 상한을 우회하지 못한다."""
        n = 0
        for top, dirs, files in os.walk(self.root, followlinks=False):
            n += sum(os.lstat(os.path.join(top, f)).st_size for f in files)
        return n

    def _write_rev(self, pid, rev, env, data):
        """data = env 를 직렬화한 바로 그 바이트(용량 검사에 쓴 것과 같은 것만 쓴다)."""
        d = self.root / 'projects' / pid
        if rev == 1:
            os.mkdir(d, 0o700)                             # 새 프로젝트 폴더는 반드시 새로(있으면 FileExistsError)
        self._chk_dir(d, f'프로젝트 {pid}', create=False)
        tmp = d / f'.tmp-{secrets.token_hex(8)}'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data); f.flush(); os.fsync(f.fileno())
            os.link(tmp, d / f'r{rev:06d}.json')          # 같은 판 이름이 있으면 FileExistsError — 판은 덮어쓰지 않는다
        finally:
            os.unlink(tmp)
        dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
        return self._meta_of(env)

    def _pid_rev(self, body, allow_latest=False):
        pid = body.get('id')
        if not isinstance(pid, str) or not PID_RE.fullmatch(pid):
            return None, (400, {'error': '프로젝트 id 형식이 아닙니다'})
        if 'rev' not in body and allow_latest:
            return (pid, None), None
        rev = body.get('rev')
        if type(rev) is not int or rev < 0:
            return None, (400, {'error': 'rev 는 0 이상 정수'})
        return (pid, rev), None

    def apply(self, body, actor):
        if not isinstance(body, dict):
            return 400, {'error': '요청은 객체여야 합니다'}
        op = body.get('op')
        allowed = {'list': {'op'}, 'get': {'op', 'id', 'rev'}, 'put': {'op', 'id', 'rev', 'scene'}, 'delete': {'op', 'id', 'rev'},
                   'analyze': {'op', 'id', 'rev', 'scene'}, 'export': {'op', 'id', 'rev'}}
        if not isinstance(op, str) or op not in allowed:
            return 400, {'error': 'op 는 list·get·put·delete·analyze·export 중 하나'}
        extra = sorted(set(body) - allowed[op])
        if extra:
            return 400, {'error': f'모르는 키 {extra}'}
        actor = (CTRL_RE.sub('', actor) if isinstance(actor, str) else '')[:48] or '알 수 없음'
        if op == 'list':
            return 200, self.listing()
        try:
            self._base()
            return self._apply(op, body, actor)
        except Overload as e:
            return e.code, {'error': e.msg}
        except Damaged as e:
            return 503, {'error': str(e)}
        except OSError as e:                               # 링크(.lock ELOOP)·권한·디스크 — 이전 판 그대로
            return 503, {'error': f'저장소 입출력 오류 · {type(e).__name__} — 기존 자료를 보존했습니다'}

    def _apply(self, op, body, actor):
        if op == 'analyze' and 'scene' in body:
            if 'id' in body or 'rev' in body:
                return 400, {'error': 'analyze 는 scene 또는 id(+rev) 중 하나만'}
            raw = _canon_or_none(body['scene'])
            if raw is None:
                return 400, {'error': 'scene 을 JSON 으로 만들 수 없습니다'}
            if len(raw) > L['scene_bytes']:
                return 413, {'error': f"scene 이 {L['scene_bytes'] // 1024} KiB 를 넘습니다"}
            return 200, analyze(body['scene'], Budget(L['analyze_seconds']))
        if op == 'put':
            return self._put(body, actor)
        pr, bad = self._pid_rev(body, allow_latest=op in ('get', 'analyze', 'export'))
        if bad:
            return bad
        pid, rev = pr
        with self._locked():
            revs = self._revs(pid)
            if not revs:
                return 404, {'error': '없는 프로젝트'}
            if op == 'delete':
                if rev != revs[-1]:
                    return 409, {'error': '다른 곳에서 바뀌었습니다 — 다시 불러와 확인하세요', 'cur': self._cur(pid, revs)}
                self._env(pid, rev)                        # R1 보완: 손상된 최신 판은 보관 이동으로도 가리지 않는다(503)
                dst = self.root / '.trash' / f"{pid}-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}"
                os.rename(self.root / 'projects' / pid, dst)
                return 200, {'id': pid, 'deleted': True}
            rev = revs[-1] if rev is None else rev
            if rev not in revs:
                return 404, {'error': '없는 판'}
            env = self._env(pid, rev)
        meta = self._meta_of(env)
        if op == 'get':
            return 200, {'project': meta, 'scene': env['scene']}
        if op == 'analyze':
            return 200, analyze(env['scene'], Budget(L['analyze_seconds']))
        data, issues = export_zip(env['scene'], dict(id=pid, rev=rev, sha256=env['sha256'], saved_at=env['at'], saved_by=env['by']),
                                  Budget(L['export_seconds']))
        if data is None:
            return 400, {'error': '저장본이 현재 검증을 통과하지 못합니다', 'issues': issues[:L['issues']]}
        if len(data) > L['zip_bytes']:
            return 413, {'error': f"내보내기 파일이 {L['zip_bytes'] // 1024} KiB 를 넘습니다({len(data)} B) — 세계 크기·층 수를 줄이세요"}
        return 200, {'filename': f'rehearsal-{pid}-r{rev}.zip', 'mime': 'application/zip', 'base64': base64.b64encode(data).decode(),
                     'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'project': meta}

    def _cur(self, pid, revs):
        return {'rev': revs[-1], 'sha256': self._env(pid, revs[-1])['sha256']}

    def _put(self, body, actor):
        if 'scene' not in body:
            return 400, {'error': 'scene 이 없습니다'}
        scene = body['scene']
        new = 'id' in body and body['id'] is None
        if new and 'rev' in body:
            return 400, {'error': '새 프로젝트에는 rev 를 보내지 않습니다'}
        if not new:
            pr, bad = self._pid_rev(body)
            if bad:
                return bad
            pid, rev = pr
        raw = _canon_or_none(scene)
        if raw is None:
            return 400, {'error': 'scene 을 JSON 으로 만들 수 없습니다'}
        if len(raw) > L['scene_bytes']:
            return 413, {'error': f"scene 이 {L['scene_bytes'] // 1024} KiB 를 넘습니다 — 배경 도면을 줄이세요"}
        issues, geo = validate(scene, Budget(L['put_seconds']))
        if geo is None:
            return 400, {'error': '설계도 검증 실패', 'issues': issues[:L['issues']]}
        sha = hashlib.sha256(raw).hexdigest()
        with self._locked():
            if new:
                if sum(1 for n in os.listdir(self.root / 'projects') if PID_RE.fullmatch(n)) >= L['projects']:
                    return 409, {'error': f"프로젝트 수 상한 {L['projects']}"}
                pid, nxt = 'p' + secrets.token_hex(5), 1
            else:
                revs = self._revs(pid)
                if not revs:
                    return 404, {'error': '없는 프로젝트'}
                if rev != revs[-1]:
                    return 409, {'error': '다른 곳에서 먼저 저장했습니다 — 다시 불러와 비교하세요', 'cur': self._cur(pid, revs)}
                self._env(pid, rev)                        # R1 보완: 최신 판 봉투·sha 확인 — 손상이면 503, 새 판 0(정상 수정으로 가리지 않음)
                if len(revs) >= L['revisions']:
                    return 409, {'error': f"판 수 상한 {L['revisions']} — 새 프로젝트로 복사하세요(옛 판은 지우지 않음)"}
                nxt = rev + 1
            env = dict(schema=REV_SCHEMA, id=pid, rev=nxt, at=time.strftime('%Y-%m-%dT%H:%M:%S%z'), by=actor, sha256=sha, scene=scene)
            data = json.dumps(env, ensure_ascii=False).encode()  # 실제로 쓸 바이트 — 어림 없이 이 길이로 상한 검사
            if self._used() + len(data) > L['store_bytes']:
                return 507, {'error': f"저장 공간 상한 {L['store_bytes'] >> 20} MiB(보관함 포함)"}
            try:
                meta = self._write_rev(pid, nxt, env, data)
            except FileExistsError:
                return 409, {'error': '같은 판·같은 id 가 이미 있습니다 — 다시 불러오세요'}
        return 200, {'project': meta, 'new': new, 'warnings': [i for i in issues if i['level'] == 'warn'][:L['issues']]}

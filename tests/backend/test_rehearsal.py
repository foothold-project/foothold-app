"""리허설 서버 모듈 시험 — 표준 라이브러리 + pytest, 임시 폴더만. ROS·Gazebo·네트워크·운영 저장소 0.
필수 범위(root): 2층+계단·비대칭 좌표 · CAS 경쟁 · symlink · 크기 초과 · 숫자 고정(pin) · 엄격 JSON 반례 · 자원 상한."""
import base64, copy, hashlib, io, json, math, multiprocessing as mp, os, re, struct, sys, time, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'tools'))
from server import rehearsal as R, rehearsal_http as H  # noqa: E402
from rehearsal_check import sample_scene  # noqa: E402

API_MD = ROOT / 'runs' / 'sim-fleet-planning-20261018' / 'API.md'


def post(st, m, actor='시험'):
    return H.handle_post(st, json.dumps(m, ensure_ascii=False).encode(), actor)


def codes(issues, level=None):
    return {i['code'] for i in issues if level is None or i['level'] == level}


def png(w, h, pad=0):
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + ihdr + b'\0' * (4 + pad)


@pytest.fixture
def st(tmp_path):
    return R.Store(tmp_path / 'media' / 'rehearsal')


def tree(p):
    return sorted((str(q.relative_to(p)), hashlib.sha256(q.read_bytes()).hexdigest() if q.is_file() and not q.is_symlink() else 'd')
                  for q in p.rglob('*'))


# ── 2층 + 계단 + 비대칭 좌표 ──
def test_two_floor_stairs_asymmetric_raster():
    sc = sample_scene()
    issues, geo = R.validate(sc)
    assert geo is not None and not codes(issues, 'error'), issues
    assert {'stairs_range_unverified', 'generic_proxy_not_gait', 'lidar_spec_unconfirmed'} <= codes(issues, 'warn')
    assert (geo.W, geo.H) == (246, 158)                       # ceil(12.3/0.05), ceil(7.9/0.05)
    assert geo.cell('f1', 2.0, 6.0) == 0                      # 계단 중간: 아래층 막힘
    assert geo.cell('f1', 1.0, 3.0) == 0                      # 벽
    assert geo.cell('f1', -1.0, 5.0) == 254
    assert geo.cell('f2', 2.0, 6.0) == 205                    # 위층 계단 구멍: 바닥 없음
    assert geo.cell('f2', 4.65, 6.0) == 254                   # 꼭대기 단: 지지
    assert geo.cell('f2', 4.4, 6.0) == 205                    # 그 아래 단: 지지 띠 밖
    assert geo.cell('f2', 8.0, 8.0) == 254 and geo.cell('f2', 6.0, 6.0) == 0
    assert geo.cell('f2', 1.0, 3.0) == 254                    # 1층 벽(1.2 m)은 2층 지도에 안 나옴
    slabs = [r for r in geo.rects if r['kind'] == 'slab']
    area = sum(4 * r['hx'] * r['hy'] for r in slabs)
    assert abs(area - (12.3 * 7.9 - 4.8 * 1.2)) < 1e-6           # 바닥판 = 세계 − 계단 구멍


def test_export_pgm_orientation_yaml_and_files():
    sc = sample_scene()
    data, _ = R.export_zip(sc, {'id': 'pt', 'rev': 1, 'sha256': 'x'})
    z = zipfile.ZipFile(io.BytesIO(data))
    assert z.namelist() == ['world.sdf', 'floors/f1/map.pgm', 'floors/f1/map.yaml', 'floors/f2/map.pgm', 'floors/f2/map.yaml',
                            'scene.json', 'plan.json', 'manifest.json']
    pg = z.read('floors/f1/map.pgm'); hdr = b'P5\n246 158\n255\n'
    assert pg.startswith(hdr) and len(pg) == len(hdr) + 246 * 158
    px = lambda row, col: pg[len(hdr) + row * 246 + col]
    iy, ix = int((3.0 - 2.43) // 0.05), int((1.0 + 3.17) // 0.05)
    assert px(157 - iy, ix) == 0 and px(iy, ix) == 254        # 첫 줄 = y 최대(뒤집힘 확인)
    assert 'origin: [-3.17, 2.43, 0]' in z.read('floors/f1/map.yaml').decode()
    w = ET.fromstring(z.read('world.sdf'))
    assert [p.get('filename') for p in w.iter('plugin')] == ['gz-sim-physics-system', 'gz-sim-user-commands-system', 'gz-sim-scene-broadcaster-system']
    assert sum(1 for _ in w.iter('collision')) == 1 + len(R.validate(sc)[1].rects)   # 지면 + 기하 상자 하나당 충돌체 하나(지도와 같은 원천)
    man = json.loads(z.read('manifest.json'))
    assert man['provenance']['gazebo_or_ros_run'] is False
    for n in z.namelist()[:-1]:
        assert man['files'][n] == hashlib.sha256(z.read(n)).hexdigest()
    plan = json.loads(z.read('plan.json'))
    a = plan['scenarios'][0]['robots']
    assert [r['namespace'] for r in a] == ['/r1', '/r2'] and a[0]['planned_topics']['scan'] == '/r1/scan' and 'scan' not in a[1]['planned_topics']


def test_export_deterministic_and_bg_not_in_zip():
    sc = sample_scene()
    sc['world']['background'] = {'mime': 'image/png', 'data_b64': base64.b64encode(png(800, 600)).decode(), 'floor': 'f1',
                                 'ref_px': [[0, 0], [800, 0]], 'ref_m': [[-3, 3], [9, 3]]}
    a, _ = R.export_zip(sc, {'id': 'p', 'rev': 1, 'sha256': 's'})
    b, _ = R.export_zip(copy.deepcopy(sc), {'id': 'p', 'rev': 1, 'sha256': 's'})
    assert a == b
    s = json.loads(zipfile.ZipFile(io.BytesIO(a)).read('scene.json'))
    assert 'data_b64' not in s['world']['background'] and len(s['world']['background']['data_sha256']) == 64


def test_analyze_geometry_review():
    a = R.analyze(sample_scene())
    assert a['ok'] and '기하' in a['note']
    rt = {r['id']: r for r in a['routes']}
    assert rt['rt1']['blocked_segments'] == [] and rt['rt1']['unreachable_points'] == []
    assert rt['rt3']['blocked_segments'] == [0]                # 2층 벽 w2
    assert abs(rt['rt1']['length_m'] - (math.hypot(3, 1) + math.hypot(4, 0.5))) < 1e-3
    cr = [c for c in a['crossings'] if c['scenario'] == 'a']
    assert len(cr) == 1 and abs(cr[0]['at'][0] - 5.902) < 0.01
    assert {'route_crossing', 'route_blocked', 'route_other_floor'} <= codes(a['issues'], 'warn')
    assert [f['id'] for f in a['floors']] == ['f1', 'f2'] and all(f['free'] + f['blocked'] + f['no_floor'] == 246 * 158 for f in a['floors'])



def test_unreachable_room():
    sc = sample_scene()
    sc['elements'] += [{'id': f'k{i}', 'type': 'wall', 'floor': 'f1', 'a': a, 'b': b, 'thickness': 0.15, 'height': 1}
                       for i, (a, b) in enumerate([([5.5, 6.5], [8.5, 6.5]), ([5.5, 9.5], [8.5, 9.5]), ([5.5, 6.5], [5.5, 9.5]), ([8.5, 6.5], [8.5, 9.5])])]
    sc['elements'] = [e for e in sc['elements'] if e['id'] != 'b1']
    sc['routes'][0]['points'].append([7, 8])
    a = R.analyze(sc)
    assert {r['id']: r for r in a['routes']}['rt1']['unreachable_points'] == [3]


# ── 검증 반례 ──
@pytest.mark.parametrize('mut,code', [
    (lambda s: s['elements'][2].update(riser=0.14), 'stairs_rise'),
    (lambda s: s['elements'][2].update(to_floor='f1'), 'ref'),
    (lambda s: s['floors'][1].update(z=True), 'number'),
    (lambda s: s['floors'][1].update(z=float('nan')), 'number'),
    (lambda s: s['floors'][1].update(z=float('inf')), 'number'),
    (lambda s: s['robots'][0].update(id='f1'), 'id_dup'),
    (lambda s: s['robots'][0].update(extra=1), 'keys'),
    (lambda s: s['robots'][0].update(pose=[1.0, 3.0, 0]), 'robot_blocked'),
    (lambda s: s['robots'][0].update(pose=[50, 5, 0]), 'outside'),
    (lambda s: s['routes'][2]['points'].append([2.0, 6.0]), 'route_no_floor'),
    (lambda s: s['floors'][0].update(id='../x'), 'id'),
    (lambda s: s['routes'][0].update(robot=['r1']), 'ref'),
    (lambda s: s['scenarios'][0].update(robots=[['r1'], 'r2']), 'ref'),
    (lambda s: s['elements'][0].update(type=['wall']), 'enum'),
    (lambda s: s.update(floors={}), 'count'),
    (lambda s: s['world'].update(size=[100, 100]) or s['floors'].append({'id': 'f3', 'name': '', 'z': 4.8, 'height': 2}), 'too_large'),
    (lambda s: s['routes'][1].update(robot='r9'), 'ref'),
    (lambda s: s.update(schema='x'), 'schema'),
])
def test_validate_rejects(mut, code):
    sc = sample_scene(); mut(sc)
    issues, geo = R.validate(sc)
    assert geo is None and code in codes(issues, 'error'), issues


def test_stairs_per_floor_limit_and_slab_budget():
    sc = sample_scene()
    sc['world'].update(origin=[0, 0], size=[100, 60]); sc['elements'] = []
    sc['robots'][0]['pose'] = [1, 1, 0]; sc['robots'][1]['pose'] = [2, 1, 0]
    sc['routes'] = []; sc['scenarios'] = []; sc['equipment'] = []
    sc['elements'] = [{'id': f's{i}', 'type': 'stairs', 'floor': 'f1', 'to_floor': 'f2', 'start': [5 + 5 * i, 10 + (i % 3) * 10], 'yaw': 0.4,
                       'steps': 16, 'riser': 0.15, 'tread': 0.3, 'width': 1.0} for i in range(17)]
    issues, geo = R.validate(sc)
    assert geo is None and 'count' in codes(issues, 'error')
    sc['elements'] = sc['elements'][:16]
    issues, geo = R.validate(sc)
    assert geo is not None and 'stair_hole_aabb' in codes(issues, 'warn')
    with pytest.raises(R.Overload) as e:                     # 바닥판 격자 분해도 작업량 안에서 센다
        R.validate(sc, R.Budget(5, units=50))
    assert e.value.code == 413


# ── 자원 상한(B6) ──
def test_budget_units_and_deadline():
    with pytest.raises(R.Overload) as e:
        R.analyze(sample_scene(), R.Budget(5, units=100))
    assert e.value.code == 413
    with pytest.raises(R.Overload) as e:
        R.analyze(sample_scene(), R.Budget(-1))
    assert e.value.code == 503


def test_store_overload_no_partial(st, monkeypatch):
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); pid = r['project']['id']
    monkeypatch.setitem(R.L, 'work_units', 100)
    for op in ('analyze', 'export'):
        c, r = post(st, {'op': op, 'id': pid})
        assert c == 413 and set(r) == {'error'}
    c, r = post(st, {'op': 'put', 'id': pid, 'rev': 1, 'scene': sample_scene()})
    assert c == 413 and len(list((st.root / 'projects' / pid).glob('r*.json'))) == 1


def test_big_world_two_floors_fits(st):
    sc = sample_scene()
    sc['world'].update(origin=[-50, -50], size=[100, 100])
    t0 = time.monotonic()
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sc}); assert c == 200, r
    c, a = post(st, {'op': 'analyze', 'id': r['project']['id']}); assert c == 200 and a['ok'], a
    c, e = post(st, {'op': 'export', 'id': r['project']['id']}); assert c == 200, e
    print(f'big 100x100x2 put+analyze+export {time.monotonic() - t0:.2f}s zip={e["bytes"]}B')


# ── 저장·CAS ──
def test_store_cas_and_trash(st):
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); assert c == 200 and r['new']
    pid = r['project']['id']
    assert post(st, {'op': 'put', 'id': pid, 'rev': 1, 'scene': sample_scene()})[0] == 200
    c, r = post(st, {'op': 'put', 'id': pid, 'rev': 1, 'scene': sample_scene()}); assert c == 409 and r['cur']['rev'] == 2
    assert post(st, {'op': 'put', 'id': pid, 'rev': 0, 'scene': sample_scene()})[0] == 409
    assert post(st, {'op': 'get', 'id': pid, 'rev': 1})[0] == 200 and post(st, {'op': 'get', 'id': pid, 'rev': 9})[0] == 404
    assert post(st, {'op': 'delete', 'id': pid, 'rev': 1})[0] == 409
    assert post(st, {'op': 'delete', 'id': pid, 'rev': 2}) == (200, {'id': pid, 'deleted': True})
    kept = list((st.root / '.trash').iterdir()); assert len(kept) == 1 and len(list(kept[0].glob('r*.json'))) == 2
    assert post(st, {'op': 'get', 'id': pid})[0] == 404


def test_store_bytes_include_trash(st, monkeypatch):
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); pid = r['project']['id']
    post(st, {'op': 'delete', 'id': pid, 'rev': 1})
    used = st._used(); assert used > 0                         # 보관함만 남아도 용량에 포함
    monkeypatch.setitem(R.L, 'store_bytes', used + 1000)
    assert post(st, {'op': 'put', 'id': None, 'scene': sample_scene()})[0] == 507


def test_store_cap_exact_written_bytes(st, monkeypatch):
    """715 비차단 memo: 상한 = 실제 쓰는 판 파일 바이트. 꼭 맞으면 저장, 1 B 모자라면 507·새 판 0."""
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); pid = r['project']['id']
    size1 = (st.root / 'projects' / pid / 'r000001.json').stat().st_size
    used = st._used()
    monkeypatch.setitem(R.L, 'store_bytes', used + size1 - 1)      # 같은 scene·같은 actor → r2 크기 = r1 크기(rev·시각 자릿수 동일)
    assert post(st, {'op': 'put', 'id': pid, 'rev': 1, 'scene': sample_scene()})[0] == 507
    assert not (st.root / 'projects' / pid / 'r000002.json').exists() and st._used() == used
    monkeypatch.setitem(R.L, 'store_bytes', used + size1)
    assert post(st, {'op': 'put', 'id': pid, 'rev': 1, 'scene': sample_scene()})[0] == 200
    assert st._used() == R.L['store_bytes']


def _racer(root, pid, rev, bar, q):
    s = R.Store(root); bar.wait()
    q.put(s.apply({'op': 'put', 'id': pid, 'rev': rev, 'scene': sample_scene()}, 'race')[0])


def test_cas_race_two_processes(st):
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); pid = r['project']['id']
    ctx = mp.get_context('fork')
    for rev in range(1, 6):
        bar, q = ctx.Barrier(2), ctx.Queue()
        ps = [ctx.Process(target=_racer, args=(st.root, pid, rev, bar, q)) for _ in range(2)]
        [p.start() for p in ps]; [p.join(30) for p in ps]
        assert sorted([q.get(timeout=5), q.get(timeout=5)]) == [200, 409], rev
    assert sorted(int(p.name[1:7]) for p in (st.root / 'projects' / pid).glob('r*.json')) == list(range(1, 7))


# ── symlink·손상 ──
def test_symlink_project_dir_not_followed(st, tmp_path):
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); pid = r['project']['id']
    out = tmp_path / 'outside'; os.rename(st.root / 'projects' / pid, out); os.symlink(out, st.root / 'projects' / pid)
    before = tree(out)
    assert post(st, {'op': 'get', 'id': pid})[0] == 503
    assert post(st, {'op': 'put', 'id': pid, 'rev': 1, 'scene': sample_scene()})[0] == 503
    assert post(st, {'op': 'delete', 'id': pid, 'rev': 1})[0] == 503
    g = H.handle_get(st)[1]; assert g['damaged'] == [pid] and g['projects'] == []
    assert tree(out) == before and (st.root / 'projects' / pid).is_symlink()


def test_symlink_rev_lock_root(st, tmp_path):
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); pid = r['project']['id']
    ext = tmp_path / 'ext.json'; ext.write_bytes((st.root / 'projects' / pid / 'r000001.json').read_bytes())
    os.symlink(ext, st.root / 'projects' / pid / 'r000002.json')
    assert post(st, {'op': 'get', 'id': pid})[0] == 503
    os.unlink(st.root / 'projects' / pid / 'r000002.json')
    assert post(st, {'op': 'get', 'id': pid})[0] == 200
    lock = st.root / '.lock'; lock.unlink(missing_ok=True); os.symlink(tmp_path / 'lk', lock)
    assert post(st, {'op': 'get', 'id': pid})[0] == 503 and not (tmp_path / 'lk').exists()
    lock.unlink()
    r2 = tmp_path / 'm2' / 'rehearsal'; r2.mkdir(parents=True); tgt = tmp_path / 'tgt'; tgt.mkdir(); os.symlink(tgt, r2 / 'projects')
    s2 = R.Store(r2)
    assert s2.broken and 'broken' in H.handle_get(s2)[1]
    assert post(s2, {'op': 'put', 'id': None, 'scene': sample_scene()})[0] == 503 and list(tgt.iterdir()) == []


def test_tampered_rev_is_damaged(st):
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); pid = r['project']['id']
    f = st.root / 'projects' / pid / 'r000001.json'
    e = json.loads(f.read_text()); e['scene']['name'] = '바뀜'; f.write_text(json.dumps(e, ensure_ascii=False))
    assert post(st, {'op': 'get', 'id': pid})[0] == 503 and H.handle_get(st)[1]['damaged'] == [pid]
    assert json.loads(f.read_text())['scene']['name'] == '바뀜'      # 고치지 않는다


def test_tampered_latest_blocks_put_and_delete(st):
    """715 R1: 손상된 최신 판 위에 같은 rev 로 put·delete 해도 503, 새 판·보관 이동 0, 모든 판 바이트 그대로."""
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); pid = r['project']['id']
    assert post(st, {'op': 'put', 'id': pid, 'rev': 1, 'scene': sample_scene()})[0] == 200
    d = st.root / 'projects' / pid
    e = json.loads((d / 'r000002.json').read_text()); e['scene']['name'] = '바뀜'
    (d / 'r000002.json').write_text(json.dumps(e, ensure_ascii=False))
    before = tree(d)
    assert post(st, {'op': 'put', 'id': pid, 'rev': 2, 'scene': sample_scene()})[0] == 503
    assert post(st, {'op': 'delete', 'id': pid, 'rev': 2})[0] == 503
    assert post(st, {'op': 'put', 'id': pid, 'rev': 1, 'scene': sample_scene()})[0] == 503   # 옛 rev 도 cur 계산에서 503
    assert tree(d) == before and not any((st.root / '.trash').glob('*'))
    assert H.handle_get(st)[1]['damaged'] == [pid]
    assert post(st, {'op': 'get', 'id': pid, 'rev': 1})[0] == 200                          # 이전 정상 판은 계속 읽힘


# ── 크기 초과 ──
def test_oversize(st, monkeypatch):
    assert H.handle_post(st, b' ' * (R.L['request_bytes'] + 1), 'x')[0] == 413
    big = sample_scene(); big['world']['background'] = {'mime': 'image/png', 'data_b64': 'A' * 300000, 'floor': 'f1',
                                                        'ref_px': [[0, 0], [1, 1]], 'ref_m': [[0, 3], [1, 3]]}
    assert st.apply({'op': 'put', 'id': None, 'scene': big}, 'x')[0] == 413      # scene 240 KiB(HTTP 우회 직접 호출)
    bg = sample_scene(); bg['world']['background'] = {'mime': 'image/png', 'data_b64': base64.b64encode(png(100, 100, 140000)).decode(),
                                                      'floor': 'f1', 'ref_px': [[0, 0], [100, 0]], 'ref_m': [[-3, 3], [9, 3]]}
    c, r = post(st, {'op': 'put', 'id': None, 'scene': bg}); assert c == 400 and 'size' in codes(r['issues'])
    bad = sample_scene(); bad['world']['background'] = {'mime': 'image/jpeg', 'data_b64': base64.b64encode(png(10, 10)).decode(),
                                                        'floor': 'f1', 'ref_px': [[0, 0], [10, 0]], 'ref_m': [[-3, 3], [9, 3]]}
    c, r = post(st, {'op': 'put', 'id': None, 'scene': bad}); assert c == 400 and 'image' in codes(r['issues'])
    c, r = post(st, {'op': 'put', 'id': None, 'scene': sample_scene()}); pid = r['project']['id']
    monkeypatch.setitem(R.L, 'zip_bytes', 100)
    c, r = post(st, {'op': 'export', 'id': pid}); assert c == 413 and 'base64' not in r
    monkeypatch.setattr(H, 'RESP_MAX', 10)
    assert H.handle_get(st)[0] == 500


# ── 엄격 JSON·요청 형식 ──
@pytest.mark.parametrize('raw,code', [
    (b'{"op":"list","op":"delete"}', 400), (b'{"op":"analyze","scene":NaN}', 400), (b'{"op":"analyze","scene":Infinity}', 400),
    (b'\xff\xfe', 400), (b'[' * 5000 + b']' * 5000, 400), (b'[]', 400), (b'{"op":"nope"}', 400), (b'{"op":["list"]}', 400),
    (b'{"op":"list","x":1}', 400), (b'{"op":"get","id":"../etc"}', 400), (b'{"op":"get","id":"p0123456789","rev":true}', 400),
    (b'{"op":"put","id":null,"rev":1,"scene":{}}', 400), (b'{"op":"analyze","scene":{},"id":"p0123456789"}', 400),
    (b'{"op":"get","id":"p0123456789"}', 404),
])
def test_http_strict(st, raw, code):
    assert H.handle_post(st, raw, 'x')[0] == code


def test_http_1e999_and_nested_wrong_types(st):
    sc = json.dumps(sample_scene()).replace('"z": 2.4', '"z": 1e999', 1)
    c, r = H.handle_post(st, ('{"op":"put","id":null,"scene":' + sc + '}').encode(), 'x')
    assert c == 400 and 'number' in codes(r['issues'])
    for mut in (lambda s: s.update(world=[]), lambda s: s['robots'][0].update(sensors={'a': 1}),
                lambda s: s['routes'][0].update(points=[[1, 'x']]), lambda s: s['scenarios'][0].update(routes=[{'id': 'rt1'}])):
        sc = sample_scene(); mut(sc)
        c, r = post(st, {'op': 'put', 'id': None, 'scene': sc}); assert c == 400, r
        c, r = post(st, {'op': 'analyze', 'scene': sc}); assert c == 200 and r['ok'] is False


def test_xml_and_text_injection():
    sc = sample_scene()
    sc['name'] = '"><plugin filename="evil"/><!--'
    sc['equipment'][0]['label'] = '</sdf><plugin filename="evil2"/>'
    data, _ = R.export_zip(sc, {'id': 'p', 'rev': 1, 'sha256': 's'})
    w = zipfile.ZipFile(io.BytesIO(data)).read('world.sdf').decode()
    assert 'evil' not in w and len(list(ET.fromstring(w).iter('plugin'))) == 3


def test_root_link_scene_roundtrip(st):
    """root tools/rehearsal_link_check.py 와 같은 정수 좌표 scene — 저장본이 보낸 그대로 돌아온다."""
    scene = {'schema': 'fh_rehearsal_scene/1', 'name': 'HTTP 검증',
             'world': {'origin': [0, 0], 'size': [8, 6], 'resolution': 0.05, 'background': None},
             'floors': [{'id': 'floor1', 'name': '1층', 'z': 0, 'height': 3}], 'elements': [],
             'robots': [{'id': 'robot1', 'name': '계획 로봇', 'model': 'go2_proxy', 'floor': 'floor1', 'pose': [1, 1, 0], 'sensors': []}],
             'equipment': [], 'routes': [{'id': 'route1', 'robot': 'robot1', 'floor': 'floor1', 'points': [[1, 1], [3, 1]]}],
             'scenarios': [{'id': 'case_a', 'name': 'A', 'robots': ['robot1'], 'routes': ['route1']}]}
    c, r = post(st, {'op': 'put', 'id': None, 'scene': scene}); assert c == 200
    assert post(st, {'op': 'get', 'id': r['project']['id']})[1]['scene'] == scene
    assert post(st, {'op': 'analyze', 'id': r['project']['id']})[1]['ok'] is True


# ── 숫자 고정(pin) ──
def test_pin_limits_against_api_md():
    t = API_MD.read_text()
    for k, s in (('request_bytes', '262144'), ('response_bytes', '1048576'), ('zip_bytes', '655360'), ('scene_bytes', '245760'),
                 ('background_bytes', '131072'), ('total_cells', '8,000,000'), ('work_units', '20,000,000')):
        assert R.L[k] == int(s.replace(',', '')) and s in t, k
    assert H.REQ_MAX == 262144 and H.RESP_MAX == 1048576
    assert (R.RES, R.BAND, R.SUP) == (0.05, (0.05, 0.60), (-0.06, 0.05))
    src = (Path('/home/hyeon/Desktop/foothold/control-app/sim/worlds/build_v5_world.py'))
    if src.exists():                                           # 래스터 수치가 기존 생성기와 같은지(읽기만)
        assert re.search(r'RES, BAND, SUP = 0\.05, \(0\.05, 0\.60\), \(-0\.06, 0\.05\)', src.read_text())

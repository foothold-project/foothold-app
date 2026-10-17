"""리허설 scene 점검 도구 — 표준 라이브러리만, ROS·Gazebo 실행 없음, 저장소 쓰기는 --selftest 의 임시 폴더뿐.

  python3 tools/rehearsal_check.py --scene <scene.json>                 검증 + 2D 기하 검토 요약(JSON)
  python3 tools/rehearsal_check.py --scene <scene.json> --export <out.zip>   내보내기 ZIP 쓰기(이미 있으면 거부)
  python3 tools/rehearsal_check.py --selftest                           2층+계단 표본으로 저장·CAS·검토·내보내기 1회
계약: runs/sim-fleet-planning-20261018/API.md
"""
import argparse, base64, hashlib, io, json, sys, tempfile, time, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import rehearsal as R  # noqa: E402
from server.rehearsal_http import handle_get, handle_post  # noqa: E402


def sample_scene():
    """2층 + 계단 1(16단 × 0.15 m = 2.4 m), 원점·크기 비대칭(0.05 배수 아님), 로봇 2, 경로 3, 배치안 2."""
    return {
        'schema': R.SCHEMA, 'name': '표본 2층 계단',
        'world': {'origin': [-3.17, 2.43], 'size': [12.3, 7.9], 'resolution': 0.05, 'background': None},
        'floors': [{'id': 'f1', 'name': '1층', 'z': 0, 'height': 2.4}, {'id': 'f2', 'name': '2층', 'z': 2.4, 'height': 2.4}],
        'elements': [
            {'id': 'w1', 'type': 'wall', 'floor': 'f1', 'a': [-2, 3], 'b': [5, 3], 'thickness': 0.15, 'height': 1.2},
            {'id': 'b1', 'type': 'box', 'floor': 'f1', 'center': [6, 8], 'size': [0.6, 0.4, 0.5], 'yaw': 0.3},
            {'id': 's1', 'type': 'stairs', 'floor': 'f1', 'to_floor': 'f2', 'start': [0, 6], 'yaw': 0,
             'steps': 16, 'riser': 0.15, 'tread': 0.3, 'width': 1.2},
            {'id': 'w2', 'type': 'wall', 'floor': 'f2', 'a': [6, 4], 'b': [6, 9], 'thickness': 0.2, 'height': 1.0}],
        'robots': [
            {'id': 'r1', 'name': '계획 로봇 1', 'model': 'go2_proxy', 'floor': 'f1', 'pose': [-1, 5, 0],
             'sensors': [{'id': 'r1_lidar', 'kind': 'lidar_l1', 'mount': [0.2, 0, 0.3, 0]}]},
            {'id': 'r2', 'name': '계획 로봇 2', 'model': 'go2_proxy', 'floor': 'f1', 'pose': [7, 5, 1.57], 'sensors': []}],
        'equipment': [{'id': 'e1', 'kind': 'relay', 'floor': 'f2', 'pose': [3, 9, 0], 'label': '중계기'}],
        'routes': [
            {'id': 'rt1', 'robot': 'r1', 'floor': 'f1', 'points': [[-1, 5], [2, 4], [6, 4.5]]},
            {'id': 'rt2', 'robot': 'r2', 'floor': 'f1', 'points': [[7, 5], [4, 3.6]]},
            {'id': 'rt3', 'robot': 'r1', 'floor': 'f2', 'points': [[1, 8], [8, 8]]}],
        'scenarios': [{'id': 'a', 'name': '배치안 A', 'robots': ['r1', 'r2'], 'routes': ['rt1', 'rt2']},
                      {'id': 'b', 'name': '배치안 B', 'robots': ['r1'], 'routes': ['rt1', 'rt3']}]}


def summary(a):
    return {'ok': a['ok'], 'errors': [i for i in a['issues'] if i['level'] == 'error'][:20],
            'warn_codes': sorted({i['code'] for i in a['issues'] if i['level'] == 'warn'}),
            'floors': a['floors'], 'routes': a['routes'], 'crossings': a['crossings'][:20], 'truncated': a['truncated'], 'note': a['note']}


def selftest():
    sc = sample_scene()
    with tempfile.TemporaryDirectory(prefix='fh-rehearsal-check-') as td:
        st = R.Store(Path(td) / 'media' / 'rehearsal')
        post = lambda m: handle_post(st, json.dumps(m).encode(), '도구')
        c, r = post({'op': 'put', 'id': None, 'scene': sc}); assert c == 200 and r['project']['rev'] == 1, (c, r)
        pid = r['project']['id']
        c, r = post({'op': 'put', 'id': pid, 'rev': 1, 'scene': sc}); assert c == 200 and r['project']['rev'] == 2, (c, r)
        c, r = post({'op': 'put', 'id': pid, 'rev': 1, 'scene': sc}); assert c == 409 and r['cur']['rev'] == 2, (c, r)
        c, r = post({'op': 'get', 'id': pid}); assert c == 200 and r['scene'] == sc
        t0 = time.monotonic(); c, a = post({'op': 'analyze', 'id': pid}); ta = time.monotonic() - t0
        assert c == 200 and a['ok'] and {x['code'] for x in a['issues']} >= {'stairs_range_unverified', 'route_crossing', 'route_blocked'}, a
        t0 = time.monotonic(); c, e = post({'op': 'export', 'id': pid}); te = time.monotonic() - t0
        raw = base64.b64decode(e['base64']); assert c == 200 and hashlib.sha256(raw).hexdigest() == e['sha256']
        names = zipfile.ZipFile(io.BytesIO(raw)).namelist()
        assert names == ['world.sdf', 'floors/f1/map.pgm', 'floors/f1/map.yaml', 'floors/f2/map.pgm', 'floors/f2/map.yaml',
                         'scene.json', 'plan.json', 'manifest.json'], names
        c, g = handle_get(st); assert c == 200 and g['projects'][0]['id'] == pid
        c, d = post({'op': 'delete', 'id': pid, 'rev': 2}); assert c == 200 and handle_get(st)[1]['projects'] == []
    print(f'REHEARSAL_CHECK_OK zip={len(raw)}B analyze={ta:.2f}s export={te:.2f}s temp_store_only')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--scene'); ap.add_argument('--export'); ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.scene:
        ap.error('--scene 또는 --selftest')
    from server.rehearsal_http import loads_strict
    sc = loads_strict(Path(a.scene).read_bytes())
    print(json.dumps(summary(R.analyze(sc, R.Budget(R.L['analyze_seconds']))), ensure_ascii=False, indent=1))
    if a.export:
        out = Path(a.export)
        if out.exists():
            sys.exit(f'이미 있음 — 덮어쓰지 않습니다: {out}')
        data, issues = R.export_zip(sc, {'id': 'local', 'rev': 0, 'sha256': hashlib.sha256(R.canon(sc)).hexdigest()},
                                    R.Budget(R.L['export_seconds']))
        if data is None:
            sys.exit('검증 실패 — 내보내기 안 함')
        with open(out, 'xb') as f:
            f.write(data)
        print(f'export {out} {len(data)}B sha256={hashlib.sha256(data).hexdigest()}')


if __name__ == '__main__':
    main()

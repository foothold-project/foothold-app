"""화면 미리보기용 로컬 가짜 서버(실제 로봇·원격 서버 0). 저장소 루트에서 apps/server 의 venv 로 실행한다.

  PYTHONPATH=apps/agent python apps/web/tools/preview_stack.py <폴더> [포트]

dev_stack.py 서버(임시 PostgreSQL·실제 서버 코드) 위에 예시 자료를 얹는다 — 화면마다 내용이 차게:
  계정 kim(총괄)·park·lee(운영) · 실기 로봇 4대(연결 2대는 가짜 로봇이 붙음, 끊김 1대, 연결 전·담당 없음 1대) · 시뮬 로봇 2대
  예시 공장 1·2층 지도(벽·접근 금지·감속 구역·지점·계단) · 할 일 2개·시나리오 2개 · 기록 사건·알림
예시 값은 모두 지어낸 것이다(실제 주소·사진·기체번호 없음). 비밀번호·로봇 토큰은 실행마다 새로 만들어 <폴더>/stack.json 에만 쓴다.
누르는 동작(저장·편집)은 이 임시 DB 에만 남고, 끄면(Ctrl+C) 같이 사라진다.
"""
from datetime import timedelta
import atexit
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dev_stack  # noqa: E402

ROOT = dev_stack.ROOT
RES = 0.05            # 지도 한 칸 = 5 cm
W, H = 280, 180       # 14 m × 9 m


def pgm(walls):
    """빈 칸(254)에 벽 사각형(0)을 그린 PGM. walls = [(x0,y0,x1,y1) m 단위, 지도 원점 왼쪽 아래]"""
    px = bytearray([254]) * (W * H)
    for x0, y0, x1, y1 in walls:
        for y in range(int(y0 / RES), int(y1 / RES)):
            for x in range(int(x0 / RES), int(x1 / RES)):
                px[(H - 1 - y) * W + x] = 0
    return f'P5\n# preview sample\n{W} {H}\n255\n'.encode() + bytes(px)


T = 0.15  # 벽 두께
OUTER = [(0, 0, 14, T), (0, 9 - T, 14, 9), (0, 0, T, 9), (14 - T, 0, 14, 9)]
FLOOR1 = OUTER + [(5, 0, 5 + T, 3.2), (5, 4.6, 5 + T, 9), (5, 5.5, 9, 5.5 + T), (10.2, 5.5, 14, 5.5 + T), (9.5, 0, 9.5 + T, 2.5)]
FLOOR2 = OUTER + [(4, 3, 4 + T, 9), (4, 3, 7, 3 + T), (8.4, 3, 14, 3 + T), (9, 3, 9 + T, 6.2)]
YAML = b'image: sample.pgm\nresolution: 0.05\norigin: [0, 0, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.2\n'


def seed(db, org, users, stack):
    from apps.server.fh_server.models import Event, Notification, Robot, now
    from apps.server.fh_server.security import digest

    t = now()
    tokens = {}

    def robot(key, name, owner, *, sim=False, seen=None, serial=None):
        tokens[key] = secrets.token_urlsafe(24)
        r = Robot(org_id=org.id, name=name, model='unitree_go2', owner_user_id=users[owner].id if owner else None,
                  agent_token_hash=digest(tokens[key]), simulation=sim, last_seen_at=seen, serial=serial)
        db.add(r)
        return r

    robots = {
        'go2-9': robot('go2-9', 'Go2-9', 'lee', seen=t, serial='SAMPLE-0009'),
        'go2-3': robot('go2-3', 'Go2-3', 'park', seen=t - timedelta(hours=2, minutes=14), serial='SAMPLE-0003'),
        'go2-12': robot('go2-12', 'Go2-12', None, serial='SAMPLE-0012'),
        'sim-a': robot('sim-a', '연습 1', 'park', sim=True),
        'sim-b': robot('sim-b', '연습 2', 'kim', sim=True),
    }
    db.flush()
    main = stack['robot']
    ev = [  # (몇 분 전, 분류, 코드, 심각도, 문장, 로봇)
        (3, 'LINK', 'AGENT_CONNECTED', 'INFO', 'Go2-7 이 서버에 연결됐습니다.', main),
        (9, 'LEASE', 'LEASE_ACQUIRED', 'INFO', '박운영 님이 Go2-7 조종을 시작했습니다.', main),
        (14, 'SAFETY', 'STOP_REQUESTED', 'WARN', 'Go2-7 정지를 요청했습니다.', main),
        (14, 'SAFETY', 'STOP_CONFIRMED', 'INFO', 'Go2-7 정지 잠금을 확인했습니다.', main),
        (41, 'RUN', 'RUN_COMPLETED', 'INFO', '1층 순찰 실행을 마쳤습니다(시뮬).', robots['sim-a'].id),
        (95, 'ROUTE', 'ROUTE_DEVIATION', 'WARN', 'Go2-9 가 정해진 길에서 1.2 m 벗어났습니다.', robots['go2-9'].id),
        (134, 'LINK', 'AGENT_DISCONNECTED', 'WARN', 'Go2-3 연결이 끊겼습니다.', robots['go2-3'].id),
        (180, 'RUN', 'RUN_FAILED', 'ERROR', '2층 점검 실행이 실패했습니다: 목표 지점에 갈 수 없음(시뮬).', robots['sim-a'].id),
        (300, 'ACCOUNT', 'LOGIN', 'INFO', '이운영 님이 로그인했습니다.', None),
        (60 * 26, 'LINK', 'BATTERY_LOW', 'WARN', 'Go2-3 배터리가 18% 입니다.', robots['go2-3'].id),
        (60 * 30, 'ACCOUNT', 'USER_CREATED', 'INFO', '김총괄 님이 이운영 계정을 만들었습니다.', None),
    ]
    rows = []
    for ago, cat, code, sev, msg, rid in ev:
        e = Event(org_id=org.id, at=t - timedelta(minutes=ago), category=cat, code=code, severity=sev, message=msg, robot_id=rid)
        db.add(e)
        rows.append(e)
    db.flush()
    for who, idx, kind, title in (('park', 6, 'LINK_LOST', '연결 끊김'), ('park', 2, 'STOP_REQUESTED', '정지 요청'),
                                  ('kim', 7, 'RUN_FAILED', '실행 실패'), ('kim', 5, 'ROUTE_DEVIATION', '경로 이탈')):
        e = rows[idx]
        db.add(Notification(org_id=org.id, user_id=users[who].id, event_id=e.id, kind=kind, title=title, body=e.message,
                            link=f'#/history?event_id={e.id}', created_at=e.at))
    stack['tokens'] = tokens
    stack['robots'] = {k: str(r.id) for k, r in robots.items()}


def http(base, method, path, body=None, token=None, raw=None, kind='application/json', params=''):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + '/api/v1' + path + params, data=data, method=method,
                                 headers={'content-type': kind, **({'authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        raise SystemExit(f'예시 자료 넣기 실패 {method} {path}: {e.code} {e.read()[:400]!r}')


def after(stack, folder):
    base = stack['base']
    for _ in range(100):  # uvicorn 이 뜰 때까지
        try:
            urllib.request.urlopen(base + '/api/v1/actions', timeout=1)
        except urllib.error.HTTPError:
            break
        except OSError:
            time.sleep(0.2)
    login = lambda who: http(base, 'POST', '/auth/login', {'username': who, 'password': stack['passwords'][who], 'client': 'app'})['access_token']
    kim, park = login('kim'), login('park')

    site = http(base, 'POST', '/sites', {'name': '예시 공장'}, kim)
    building = http(base, 'POST', f'/sites/{site["id"]}/buildings', {'name': 'A동'}, kim)
    f1 = http(base, 'POST', f'/buildings/{building["id"]}/floors', {'name': '1층', 'level': 1}, kim)['id']
    f2 = http(base, 'POST', f'/buildings/{building["id"]}/floors', {'name': '2층', 'level': 2}, kim)['id']
    other = http(base, 'POST', '/sites', {'name': '예시 물류창고'}, kim)
    ob = http(base, 'POST', f'/sites/{other["id"]}/buildings', {'name': '본관'}, kim)
    http(base, 'POST', f'/buildings/{ob["id"]}/floors', {'name': '1층', 'level': 1}, kim)   # 지도 없는 층

    def upload(walls):
        image = http(base, 'POST', '/uploads', raw=pgm(walls), token=kim, kind='image/x-portable-graymap')['upload_id']
        return http(base, 'POST', '/uploads', raw=YAML, token=kim, kind='text/yaml', params=f'?image={image}')['upload_id']

    feats1 = {'zones': [
        {'id': 'z-press', 'type': 'NO_GO', 'name': '프레스 작업장', 'polygon': [[6.2, 6.4], [9.0, 6.4], [9.0, 8.4], [6.2, 8.4]]},
        {'id': 'z-dock', 'type': 'SLOW', 'name': '출하장 통로', 'max_speed_mps': 0.5, 'polygon': [[10.0, 0.6], [13.4, 0.6], [13.4, 2.6], [10.0, 2.6]]}],
        'waypoints': [{'id': 'w-gate', 'name': '정문', 'x': 1.2, 'y': 1.2, 'yaw': 0}, {'id': 'w-line', 'name': '조립 라인', 'x': 7.5, 'y': 3.8, 'yaw': 1.57},
                      {'id': 'w-dock', 'name': '출하장', 'x': 12.0, 'y': 4.0, 'yaw': 3.14}],
        'connectors': [{'id': 'c-stairs', 'kind': 'STAIRS', 'pair_floor_id': f2, 'x': 2.4, 'y': 7.6, 'yaw': 0}], 'edits': []}
    feats2 = {'zones': [{'id': 'z-server', 'type': 'NO_GO', 'name': '전산실', 'polygon': [[9.4, 3.6], [13.4, 3.6], [13.4, 6.0], [9.4, 6.0]]}],
        'waypoints': [{'id': 'w-office', 'name': '사무실', 'x': 6.0, 'y': 6.5, 'yaw': 0}, {'id': 'w-store', 'name': '자재 창고', 'x': 11.5, 'y': 1.5, 'yaw': 0}],
        'connectors': [{'id': 'c-stairs', 'kind': 'STAIRS', 'pair_floor_id': f1, 'x': 2.4, 'y': 7.6, 'yaw': 0}], 'edits': []}
    u1 = upload(FLOOR1)
    v1 = http(base, 'POST', f'/floors/{f1}/map-versions', {'base_version_id': None, 'image': u1, 'features': {**feats1, 'zones': feats1['zones'][:1]}, 'reason': '처음 올린 지도'}, kim)
    v1 = http(base, 'POST', f'/floors/{f1}/map-versions', {'base_version_id': v1['id'], 'image': u1, 'features': feats1, 'reason': '출하장 감속 구역 추가'}, kim)
    v2 = http(base, 'POST', f'/floors/{f2}/map-versions', {'base_version_id': None, 'image': upload(FLOOR2), 'features': feats2, 'reason': '처음 올린 지도'}, kim)

    photo = http(base, 'POST', '/missions', {'name': '사진 찍기', 'steps': [{'action': 'PHOTO', 'params': {}}]}, park)
    wait = http(base, 'POST', '/missions', {'name': '30초 살피기', 'steps': [{'action': 'WAIT', 'params': {'seconds': 30}}]}, park)
    pt = lambda floor, v, x, y, m: {'floor_id': floor, 'map_version_id': v['id'], 'x': x, 'y': y, 'yaw': 0, 'waypoint_ref': None,
                                    'mission_id': m['id'], 'mission_version': 1}
    http(base, 'POST', '/scenarios', {'name': '1층 아침 순찰', 'notes': '정문 → 조립 라인 → 출하장', 'finish': {'mode': 'RETURN_TO_START'},
         'waypoints': [pt(f1, v1, 1.2, 1.2, wait), pt(f1, v1, 7.5, 3.8, photo), pt(f1, v1, 12.0, 4.0, photo)]}, park)
    http(base, 'POST', '/scenarios', {'name': '2층 자재 창고 점검', 'notes': '', 'finish': {'mode': 'STAY', 'target': None},
         'waypoints': [pt(f2, v2, 6.0, 6.5, wait), pt(f2, v2, 11.5, 1.5, photo)]}, park)

    poses = {stack['robot']: (f1, v1['id'], 3.0, 2.4, 0.4, 76), stack['robots']['go2-9']: (f1, v1['id'], 11.2, 4.2, 3.0, 54)}
    stack.update(floors={'f1': f1, 'f2': f2})
    (folder / 'stack.json').write_text(json.dumps(stack, ensure_ascii=False, indent=1))
    agents = []
    for rid, (floor, version, x, y, yaw, soc) in poses.items():
        token = stack['agent_token'] if rid == stack['robot'] else stack['tokens']['go2-9']
        env = {**os.environ, 'FH_AGENT_TOKEN': token, 'PYTHONPATH': str(ROOT / 'apps/agent'),
               'FH_AGENT_POSE': json.dumps({'floor_id': floor, 'map_version_id': version, 'x': x, 'y': y, 'yaw': yaw, 'soc': soc})}
        agents.append(subprocess.Popen([sys.executable, str(Path(__file__).with_name('dev_stack.py')), 'agent', str(folder)], env=env, cwd=ROOT))
    atexit.register(lambda: [a.terminate() for a in agents])
    print('예시 자료 넣음 · 가짜 로봇 2대 연결 중 — 로그인 kim(총괄)·park·lee(운영), 비밀번호는 stack.json', flush=True)


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    dev_stack.server(folder, int(sys.argv[2]) if len(sys.argv) > 2 else 8881, seed=seed, after=after)

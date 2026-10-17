"""SQLite 문서 저장 mock 확인(개발 사본 전용 — fixture 복사본·ROS_DOMAIN_ID=88, Gazebo·운영 자료 없음).
 쓰임: 저장소 루트에서 source /opt/ros/jazzy/setup.bash; python3 tests/sim/store_mock_check.py <작업폴더(그 안에 media/ = fixture 사본)> <비어 있는 로컬 포트>
 확인: GET 200·no-store·json 과 같은 목록 / SQLite 실사용 / POST 200·409·403 / WS status.docs_rev 증가 / 실행 중 DB 손상 500 JSON / docs.json 원본 불변 / 깨진 DB = GET broken·POST 503."""
import asyncio, json, os, shutil, signal, subprocess, sys, time, urllib.request, urllib.error
from tornado.websocket import websocket_connect
from tornado.httpclient import HTTPRequest
D, P = sys.argv[1], int(sys.argv[2]); B = f'http://127.0.0.1:{P}'
ENV = dict(os.environ, ROS_DOMAIN_ID='88', ROS_AUTOMATIC_DISCOVERY_RANGE='LOCALHOST')
def start(store, media, log):
    p = subprocess.Popen(['/usr/bin/python3', 'sim/v2_link.py', '--port', str(P), '--media', media, '--store', store], env=ENV, stdout=open(log, 'w'), stderr=subprocess.STDOUT)
    for _ in range(40):
        time.sleep(.25)
        try: urllib.request.urlopen(B + '/api/docs'); return p
        except Exception: pass
    raise SystemExit('기동 실패 ' + log)
def stop(p): p.send_signal(signal.SIGINT); p.wait(10)
def req(method, body=None, origin=True):
    r = urllib.request.Request(B + '/api/docs', method=method, data=None if body is None else json.dumps(body).encode(),
                               headers={'Content-Type': 'application/json', **({'Origin': B} if origin else {})})
    try: x = urllib.request.urlopen(r); return x.status, x.headers.get('Cache-Control'), json.loads(x.read())
    except urllib.error.HTTPError as e: return e.code, e.headers.get('Cache-Control'), json.loads(e.read() or b'{}')
async def ws_rev():
    c = await websocket_connect(HTTPRequest(f'ws://127.0.0.1:{P}/ws', headers={'Origin': B}))
    for _ in range(50):
        m = await c.read_message()
        if isinstance(m, str) and (j := json.loads(m)).get('op') == 'status': c.close(); return j.get('docs_rev')
res = []
def chk(name, cond, info=''): res.append(bool(cond)); print('PASS' if cond else 'FAIL', name, info)
for k in ('a', 'b', 'c'): shutil.copytree(f'{D}/media', f'{D}/m_{k}')
# 1) json 기준 vs sqlite: GET 같은 목록
pj = start('json', f'{D}/m_a', f'{D}/json.log'); cj, _, j = req('GET'); stop(pj)
ps = start(f'sqlite:{D}/b.db', f'{D}/m_b', f'{D}/sq.log')
c, cc, s = req('GET')
chk('GET 200 no-store', c == 200 and cc == 'no-store', f'{c} {cc}')
chk('GET 목록 = json 기준', s['docs'] == j['docs'] and s.get('broken', '') == j.get('broken', ''), f'docs {len(s["docs"])}/{len(j["docs"])} rev {s["rev"]}/{j["rev"]}')
chk('SQLite 실제 사용(폴백 아님)', 'SQLite 이전 실패' not in open(f'{D}/sq.log').read() and os.path.exists(f'{D}/b.db'))
r0 = asyncio.run(ws_rev()); d = s['docs'][0]
c, cc, r = req('POST', {'op': 'put', 'kind': d['kind'], 'id': d['id'], 'rev': d['rev'], 'doc': d['doc']})
chk('POST 같은 내용 수정 200 no-store', c == 200 and cc == 'no-store', f'{c} {r}')
time.sleep(.3); r1 = asyncio.run(ws_rev())
chk('WS status.docs_rev 증가', isinstance(r0, int) and isinstance(r1, int) and r1 > r0, f'{r0} → {r1}')
c, _, r = req('POST', {'op': 'put', 'kind': d['kind'], 'id': d['id'], 'rev': d['rev'], 'doc': d['doc']})
chk('POST 옛 rev 409', c == 409, f'{c} {r}')
c, _, r = req('POST', {'op': 'put', 'kind': d['kind'], 'id': d['id'], 'rev': d['rev'], 'doc': d['doc']}, origin=False)
chk('POST 다른 출처 403', c == 403, f'{c}')
# 실행 중 DB 손상 → 읽기 500 JSON
with open(f'{D}/b.db', 'r+b') as f: f.write(b'\0' * 4096 * 4)
c, cc, r = req('GET'); chk('실행 중 DB 읽기 오류 500 JSON no-store', c == 500 and cc == 'no-store' and 'error' in r, f'{c} {r}')
stop(ps)
chk('docs.json 원본 그대로', open(f'{D}/m_b/docs.json', 'rb').read() == open(f'{D}/media/docs.json', 'rb').read())
# 2) 열 때부터 깨진 DB → GET 200 + broken, POST 503
open(f'{D}/c.db', 'wb').write(b'not a database' * 100)
ps = start(f'sqlite:{D}/c.db', f'{D}/m_c', f'{D}/broken.log')
c, _, r = req('GET'); chk('깨진 DB GET 200 + broken', c == 200 and r.get('broken'), f'{c} {str(r.get("broken"))[:60]}')
c, _, r = req('POST', {'op': 'put', 'kind': d['kind'], 'id': d['id'], 'rev': d['rev'], 'doc': d['doc']}); chk('깨진 DB POST 503', c == 503, f'{c}')
stop(ps)
print('결과', f'{sum(res)}/{len(res)}'); sys.exit(0 if all(res) else 1)

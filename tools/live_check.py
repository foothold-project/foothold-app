#!/usr/bin/env python3
"""?live=v2 모의 시험 — 가짜 발행기(domain 88) + v2_link(8790) + headless Chrome 한 개(CDP). 실제 RL 근거가 아니다.
  source /opt/ros/jazzy/setup.bash; ROS_DOMAIN_ID=88 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST python3 tools/live_check.py <결과 폴더(없어야 함)>
검사: 초기 state 없음 · 첫 누름=조종권만 · 시험값 · 같은 막대 두 손가락 · STOP/옛 STOP 뒤 재개 · RESET 중 입력 · 끊김/복구 ·
      형식 오류 입력 · 보기 전용 화면의 보낸 명령 · 시안 값 숨김 · 링크 안내 · 44 px 겹침 · ?live 없으면 시안 그대로."""
import asyncio, base64, json, os, signal, subprocess, sys, tempfile, time, urllib.request
from tornado.websocket import websocket_connect
from tornado.httpclient import HTTPRequest

if os.environ.get('ROS_DOMAIN_ID') in (None, '', '61', '57'):
    sys.exit('live_check: ROS_DOMAIN_ID=88 같은 시험 전용 domain 에서만')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1]; os.makedirs(OUT)          # 이미 있으면 실패(덮어쓰지 않음)
PORT, DBG = int(os.environ.get('LIVE_PORT', '8791')), 9253   # 실연결 서버(8790)와 겹치지 않게
BASE = f'http://127.0.0.1:{PORT}'
RES, EXC, LOG = [], [], []
procs = {}


def check(name, ok, detail=''):
    RES.append({'name': name, 'ok': bool(ok), 'detail': detail}); print('PASS' if ok else 'FAIL', name, '' if ok else detail, flush=True)


def start(key, args):
    f = open(f'{OUT}/{key}.log', 'w'); LOG.append({'key': key, 'cmd': args})
    procs[key] = subprocess.Popen(args, stdout=f, stderr=subprocess.STDOUT, cwd=ROOT)


def stop(key):                                # 내가 띄운 프로세스만, INT 로
    p = procs.pop(key, None)
    if p and p.poll() is None:
        p.send_signal(signal.SIGINT)
        try: p.wait(8)
        except subprocess.TimeoutExpired: p.terminate(); p.wait(5)


FAKE = [sys.executable, 'tools/fake_v2_live.py', '--camera', '--fall-after', '45']


class CDP:
    async def open(self):
        for _ in range(60):
            try: tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json')); break
            except OSError: await asyncio.sleep(0.25)
        self.ws = await websocket_connect([t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl'], max_message_size=64 << 20); self.i = 0
        await self.call('Page.enable'); await self.call('Runtime.enable'); await self.call('Network.enable'); return self

    async def call(self, method, **params):
        self.i += 1; me = self.i
        await self.ws.write_message(json.dumps({'id': me, 'method': method, 'params': params}))
        while True:
            r = json.loads(await self.ws.read_message())
            if r.get('method') == 'Runtime.exceptionThrown':
                d = r['params']['exceptionDetails']; EXC.append(d.get('exception', {}).get('description') or d.get('text'))
            if r.get('id') == me: return r.get('result', r.get('error'))

    async def js(self, expr):
        r = await self.call('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
        return r.get('result', {}).get('value')

    async def go(self, url, w, h, touch=False):
        await self.call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=False)
        await self.call('Emulation.setTouchEmulationEnabled', enabled=touch, maxTouchPoints=5)
        await self.call('Page.navigate', url=url); await asyncio.sleep(2.0)

    async def shot(self, name):
        open(f'{OUT}/{name}.png', 'wb').write(base64.b64decode((await self.call('Page.captureScreenshot', format='png'))['data']))

    async def touch(self, kind, pts):         # pts: [(id, x, y)]
        await self.call('Input.dispatchTouchEvent', type=kind, touchPoints=[{'x': x, 'y': y, 'id': i} for i, x, y in pts])


class Peer:                                    # 두 번째 기기 겸 관찰자(파이썬 WebSocket)
    async def open(self):
        self.ws = await websocket_connect(HTTPRequest(f'ws://127.0.0.1:{PORT}/ws', headers={'Origin': BASE})); self.st = None
        asyncio.ensure_future(self.pump()); await asyncio.sleep(0.5); return self

    async def pump(self):
        while True:
            m = await self.ws.read_message()
            if m is None: return
            if isinstance(m, str): self.st = json.loads(m)

    def raw(self, s): return self.ws.write_message(s)
    def op(self, **o): return self.ws.write_message(json.dumps(o))


async def wait(pred, t=6.0):
    end = time.time() + t
    while time.time() < end:
        try:
            if pred(): return True
        except (TypeError, KeyError): pass
        await asyncio.sleep(0.1)
    return False


TEXT = "document.body.innerText.replace(/\\s+/g, ' ').trim()"
RECT = "(s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })"
CENTER = "(e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })"
DESIGN_FAKES = ['dBm', '68%', '0.19 s', '장애물', 'H₂S', 'ppm', '15 fps', '10-10 14:20', '저장 지도', 'WP3', '기록 중']


async def main():
    prof = tempfile.mkdtemp(prefix='livechk-')
    LOG.append({'key': 'chrome', 'cmd': 'headless chrome 1개 (CDP)'})
    procs['chrome'] = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', f'--remote-debugging-port={DBG}', f'--user-data-dir={prof}',
                                        '--no-first-run', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # 1) state 없이 서버만 먼저 — 초기 state 없음
    start('v2_link', [sys.executable, 'sim/v2_link.py', '--port', str(PORT)]); await asyncio.sleep(2.5)
    c = await CDP().open(); peer = await Peer().open()
    # ?live 없으면 live.js 는 아무것도 하지 않는다: live.js 막은 것과 글자·캡처가 같아야 함
    for page, w, h in [('MDrive.dc.html', 844, 390), ('Main.dc.html', 1440, 900)]:
        await c.go(f'{BASE}/{page}', w, h); a = await c.js(TEXT); await c.shot(f'nolive-{page[:-8]}')
        await c.call('Network.setBlockedURLs', urls=['*live.js']); await c.go(f'{BASE}/{page}', w, h); b = await c.js(TEXT)
        await c.shot(f'nolive-{page[:-8]}-blocked'); await c.call('Network.setBlockedURLs', urls=[])
        from PIL import Image, ImageChops
        d = ImageChops.difference(*(Image.open(f'{OUT}/nolive-{page[:-8]}{x}.png').convert('RGB') for x in ('', '-blocked')))
        npx = sum(1 for px in d.getdata() if max(px) > 16)          # 글꼴 안티앨리어싱 잡음 허용: 16 초과 화소 20 개 이하
        check(f'?live 없음 {page}: live.js 유무 글자 같음·캡처 차이 화소 ≤20', a == b and npx <= 20, f'text_eq={a == b} px>16={npx}')

    await c.go(f'{BASE}/MDrive.dc.html?live=v2', 844, 390, touch=True)
    q = lambda e: c.js(e)
    move = await q(f"{CENTER}(document.querySelector('[aria-label=\"이동 막대: 앞뒤와 옆걸음\"]'))")
    turn = await q(f"{CENTER}(document.querySelector('[aria-label=\"회전 막대: 왼쪽 오른쪽\"]'))")
    up = (move[0], move[1] - 60)
    await c.touch('touchStart', [(1, *move)]); await asyncio.sleep(0.4)
    await c.touch('touchMove', [(1, *up)]); await asyncio.sleep(0.8)
    t = await q(TEXT)
    check('초기 state 없음: 첫 누름은 조종권만 · 0 · «시뮬 상태 미수신» 표시 · 예외 없음',
          peer.st['role'] == 'view_other' and peer.st['applied'] == [0, 0, 0] and '시뮬 상태 미수신' in t and not EXC, f'{peer.st["role"]} {peer.st["applied"]} {EXC}')
    await c.shot('live-1-nostate')
    await c.touch('touchEnd', []); await asyncio.sleep(0.3)
    start('fake', FAKE); ok = await wait(lambda: peer.st['state_age'] is not None and peer.st['state_age'] < 0.5, 10)
    check('가짜 발행기 state 수신(domain 88)', ok, str(peer.st and peer.st['sim_block']))
    await c.touch('touchStart', [(2, *move)]); await asyncio.sleep(0.3); await c.touch('touchMove', [(2, *up)])
    ok = await wait(lambda: peer.st['applied'] == [0.6, 0, 0])
    check('새 누름 앞 끝까지 → (0.6, 0, 0)', ok, str(peer.st['applied']))
    await c.touch('touchStart', [(2, *up), (3, *turn)]); await asyncio.sleep(0.3)   # 두 번째 손가락 = 회전 막대(다른 막대), 왼쪽으로
    await c.touch('touchMove', [(2, *up), (3, turn[0] - 80, turn[1])]); await asyncio.sleep(0.6)
    check('두 막대: 앞 + 왼회전 → (0.6, 0, 0.5)', peer.st['applied'] == [0.6, 0, 0.5], str(peer.st['applied']))
    await c.shot('live-2-forward-turn')
    await c.touch('touchEnd', []); await asyncio.sleep(0.5)     # CDP touchEnd 는 모든 손가락을 뗀다
    check('모든 손 뗌 → 0', peer.st['applied'] == [0, 0, 0], str(peer.st['applied']))
    # 같은 막대에 두 번째 손가락 → 0, 원래 손가락도 죽음
    await c.touch('touchStart', [(2, *move)]); await c.touch('touchMove', [(2, *up)]); await wait(lambda: peer.st['applied'] == [0.6, 0, 0])
    await c.touch('touchStart', [(2, *up), (4, move[0] + 30, move[1])]); await asyncio.sleep(0.3)
    await c.touch('touchMove', [(2, up[0], up[1] - 2), (4, move[0] + 30, move[1])]); await asyncio.sleep(0.6)
    check('같은 막대 두 번째 손가락 → 0 · 원래 손가락 무효', peer.st['applied'] == [0, 0, 0], str(peer.st['applied']))
    await c.touch('touchEnd', []); await asyncio.sleep(0.4)
    # 미검증 입력: 후진
    down = (move[0], move[1] + 60)
    await c.touch('touchStart', [(5, *move)]); await c.touch('touchMove', [(5, *down)]); await asyncio.sleep(0.6)
    t = await q(TEXT)
    check('후진 → 0 + «후진 미검증» 표시', peer.st['applied'] == [0, 0, 0] and '후진 미검증' in t, peer.st['reason'])
    await c.touch('touchEnd', []); await asyncio.sleep(0.3)
    # 3) 누르는 중 STOP(버튼 pointerdown) → 0 래치. 시뮬 STOP 확인 → 해제 요청 → 확인 → 새 누름만
    await c.touch('touchStart', [(6, *move)]); await c.touch('touchMove', [(6, *up)]); await wait(lambda: peer.st['applied'] == [0.6, 0, 0])
    stopc = await q(f"{CENTER}(document.querySelector('[aria-label=\"비상 정지\"]'))")
    await c.touch('touchStart', [(6, *up), (7, *stopc)]); await asyncio.sleep(0.2)
    ok = await wait(lambda: peer.st['latch'] and peer.st['applied'] == [0, 0, 0] and peer.st['sim']['stop_requested'])
    check('누르는 중 STOP → 0 래치 · 시뮬 stop_requested=true', ok, str(peer.st['applied']))
    await c.touch('touchEnd', []); await asyncio.sleep(0.5)
    await c.shot('live-3-stop')
    geo = await q("""(() => { const R = (e) => { const r = e.getBoundingClientRect(); return {l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, n: e.getAttribute('aria-label') || e.textContent.trim()}; };
      const els = [document.querySelector('[aria-label="비상 정지"]'), ...document.querySelectorAll('.glass[role=group]'), ...[...document.querySelectorAll('button')].filter(b => ['STOP 해제', '시뮬 리셋'].includes(b.textContent.trim()))];
      const hud = [...document.querySelectorAll('.hud')].map(R); return {els: els.map(R), hudBottom: Math.max(...hud.map(h => h.b)), banner: R([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'STOP 해제').parentElement)}; })()""")
    els = geo['els']; small = [e['n'] for e in els if min(e['w'], e['h']) < 44]
    inter = [(a['n'], b['n']) for i, a in enumerate(els) for b in els[i + 1:] if a['l'] < b['r'] and b['l'] < a['r'] and a['t'] < b['b'] and b['t'] < a['b']]
    check('STOP·두 막대·해제/리셋 버튼 44 px 이상·서로 안 겹침', len(els) == 5 and not small and not inter, json.dumps({'n': len(els), 'small': small, 'inter': inter}, ensure_ascii=False))
    check('HUD 줄이 가운데 알림 위에서 끝남', geo['hudBottom'] <= geo['banner']['t'], f"hud={geo['hudBottom']} banner={geo['banner']['t']}")
    json.dump(geo, open(f'{OUT}/geometry-stop.json', 'w'), ensure_ascii=False, indent=1)
    # 옛 STOP 상태에서 해제: 버튼 → 대기(0) → 시뮬 false 확인 → 래치 풀림, 들고 있던 손가락 없음 → 새 누름에만 움직임
    rs = await q(f"{CENTER}([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'STOP 해제'))")
    await c.touch('touchStart', [(8, *rs)]); await c.touch('touchEnd', []); seen = await wait(lambda: peer.st['resume_pending'], 2)
    ok = await wait(lambda: not peer.st['latch'] and not peer.st['resume_pending'], 4)
    check('STOP 해제: 대기 거쳐 시뮬 확인 뒤 래치 풀림', ok, f'pending_seen={seen}')
    await c.touch('touchStart', [(9, *move)]); await c.touch('touchMove', [(9, *up)]); await asyncio.sleep(0.6)
    check('해제 뒤 첫 새 누름 → (0.6, 0, 0)', peer.st['applied'] == [0.6, 0, 0], str(peer.st['applied']))
    # 4) RESET: 누르는 중 리셋 → 즉시 잠금·0, 대기 중 입력·재개 0, 응답 뒤에도 STOP
    await c.touch('touchEnd', []); await asyncio.sleep(0.3)
    await c.touch('touchStart', [(10, *stopc)]); await c.touch('touchEnd', []); await wait(lambda: peer.st['sim']['stop_requested'])
    rb = await q(f"{CENTER}([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '시뮬 리셋'))")
    ep0 = peer.st['episode']
    await c.touch('touchStart', [(11, *rb)]); await c.touch('touchEnd', [])
    ok = await wait(lambda: peer.st['episode'] == ep0 + 1 and not peer.st['reset_pending'], 8)
    check('RESET → 새 에피소드, 응답 뒤 STOP 유지', ok and peer.st['latch'] and peer.st['applied'] == [0, 0, 0], f"ep {ep0}->{peer.st['episode']} latch={peer.st['latch']}")
    await c.touch('touchStart', [(12, *move)]); await c.touch('touchMove', [(12, *up)]); await asyncio.sleep(0.6)
    check('RESET 뒤 누름 → 0 (해제 필요)', peer.st['applied'] == [0, 0, 0], str(peer.st['applied']))
    await c.touch('touchEnd', []); await c.shot('live-4-after-reset')
    # 5) 형식 오류 입력(다른 기기가 조종권을 잡은 경우) — 서버 생존·0
    await c.call('Page.navigate', url='about:blank'); await asyncio.sleep(1.5)           # 이 화면 연결 끊김 → 조종권 해제
    check('화면 떠남 → 조종권 해제', await wait(lambda: peer.st['role'] == 'view'), peer.st['role'])
    await peer.op(op='take'); await asyncio.sleep(0.3)
    await wait(lambda: peer.st['sim']['stop_requested']); await peer.op(op='resume'); await wait(lambda: not peer.st['latch'], 4)
    for bad in ['{"op":"cmd","fx":NaN,"fy":0,"fw":0}', '{"op":"cmd","fx":Infinity,"fy":0,"fw":0}', '{"op":"cmd","fx":true,"fy":0,"fw":0}',
                '{"op":"cmd","fx":"1","fy":0,"fw":0}', '{"op":"cmd","fx":1.5,"fy":0,"fw":0}', '[1,2,3]', 'null', 'not json', '{"op":"cmd"}']:
        await peer.raw(bad); await asyncio.sleep(0.12)
        if peer.st['applied'] != [0, 0, 0]: break
    alive = procs['v2_link'].poll() is None
    check('형식 오류 입력 9종 → 0 · 서버 살아 있음', alive and peer.st['applied'] == [0, 0, 0], f'alive={alive} {peer.st["applied"]}')
    # 6) 보기 전용 Main: 다른 기기가 움직이는 동안 «보낸 명령»이 서버 출력 그대로, 시안 값 없음
    async def drive():
        await peer.op(op='cmd', fx=0, fy=0, fw=0); await asyncio.sleep(0.05)      # 새 손 뗌부터(0.3 s 넘게 비면 무효화)
        for _ in range(40):
            await peer.op(op='cmd', fx=1, fy=0, fw=0); await asyncio.sleep(0.05)
    await peer.op(op='cmd', fx=0, fy=0, fw=0); await asyncio.sleep(0.1)
    await c.go(f'{BASE}/Main.dc.html?live=v2', 1440, 900)
    task = asyncio.ensure_future(drive()); await asyncio.sleep(1.2)
    t = await q(TEXT); await c.shot('live-5-main-viewer'); await task
    check('보기 전용 Main: 보낸 명령 앞 +0.60 표시 · 실측 따로', '보낸 명령 앞 +0.60' in t and '다른 기기가 조종 중' in t and ('시뮬 실측' in t or '시뮬 몸' in t), t[:300])
    leak = [w for w in DESIGN_FAKES if w in t]
    check('Main 실모드: 시안 예시값 없음', not leak, str(leak))
    nav = await q("[...document.querySelectorAll('nav a')].map(a => [a.textContent.trim(), a.getAttribute('href')])")
    check('Main 메뉴: 관제만 ?live=v2, 나머지 href 없음(시안 안내)', nav[0][1] == 'Main.dc.html?live=v2' and all(h is None for _, h in nav[1:]), str(nav))
    await q("[...document.querySelectorAll('nav a')][2].click()"); await asyncio.sleep(0.4)
    url = await q('location.href'); t = await q(TEXT)
    check('시안 메뉴 누름 → 이동 없음 + 미연결 안내', url.endswith('Main.dc.html?live=v2') and '시안(미연결)' in t, url)
    # 7) 끊김: 발행기 끄면 0·표시, 다시 켜도(새 에피소드) STOP·새 입력 필요
    stop('fake'); ok = await wait(lambda: peer.st['sim_block'] == '시뮬 상태 끊김', 4)
    t = await q(TEXT); await c.shot('live-6-sim-lost')
    check('시뮬 끊김 → 0 · 화면 «시뮬 상태 끊김» · 예외 없음', ok and peer.st['applied'] == [0, 0, 0] and '시뮬 상태 끊김' in t and not EXC, str(EXC))
    start('fake', FAKE); await wait(lambda: not peer.st['sim_block'], 10)
    await peer.op(op='cmd', fx=1, fy=0, fw=0); await asyncio.sleep(0.3)
    check('복구 후 옛 입력 복원 없음', peer.st['applied'] == [0, 0, 0], f"{peer.st['applied']} latch={peer.st['latch']}")
    await peer.op(op='release'); await asyncio.sleep(0.3)
    # 8) MDrive 실모드: 시안 값 없음, 미니맵 → 안내
    await c.go(f'{BASE}/MDrive.dc.html?live=v2', 844, 390, touch=True); t = await q(TEXT)
    leak = [w for w in DESIGN_FAKES if w in t]
    check('MDrive 실모드: 시안 예시값 없음 · 짧은 시험 문구', not leak and 'Gazebo · foothold-v2 시험 · 낙상·정지 지연 미검증' in t and 'online_ready=' not in t, str(leak))
    mm = await q(f"{CENTER}(document.querySelector('[aria-label=\"큰 지도 열기\"]'))")
    await c.touch('touchStart', [(20, *mm)]); await c.touch('touchEnd', []); await asyncio.sleep(0.5)
    url = await q('location.href'); t = await q(TEXT)
    check('미니맵 누름 → 이동 없음 + 안내', url.endswith('MDrive.dc.html?live=v2') and '시안(미연결)' in t, url)
    # 9) 화면 숨김 → 조종권 해제
    await c.touch('touchStart', [(21, *move)]); await c.touch('touchEnd', []); await wait(lambda: peer.st['role'] == 'view_other')
    await q("Object.defineProperty(document, 'hidden', {value: true, configurable: true}); document.dispatchEvent(new Event('visibilitychange'))")
    check('화면 숨김 → 조종권 해제(보기 전용으로)', await wait(lambda: peer.st['role'] == 'view', 3), peer.st['role'])
    # 10) 넘어짐 표시(가짜 발행기 45 s 뒤 넘어짐)
    await c.go(f'{BASE}/MDrive.dc.html?live=v2', 844, 390, touch=True)
    ok = await wait(lambda: peer.st['sim'] and peer.st['sim']['fallen'], 60); await asyncio.sleep(0.5); t = await q(TEXT)
    check('넘어짐 표시', ok and '넘어짐' in t, t[:200]); await c.shot('live-7-fallen')
    check('페이지 예외 0', not EXC, str(EXC))
    return peer


try:
    asyncio.run(main())
finally:
    for k in list(procs): stop(k)
    left = subprocess.run(['pgrep', '-af', f'fake_v2_live|sim/v2_link.py --port {PORT}'], capture_output=True, text=True).stdout.strip()
    left = '\n'.join(l for l in left.splitlines() if 'pgrep' not in l)
    check('끝난 뒤 가짜 발행기·v2_link 프로세스 0', not left, left)
    json.dump({'cmd': sys.argv, 'domain': os.environ.get('ROS_DOMAIN_ID'), 'procs': LOG, 'results': RES, 'exceptions': EXC,
               'note': '가짜 발행기 모의 시험 — 실제 RL·Gazebo 근거 아님'}, open(f'{OUT}/manifest.json', 'w'), ensure_ascii=False, indent=1)
    print(f"{sum(r['ok'] for r in RES)}/{len(RES)} PASS")

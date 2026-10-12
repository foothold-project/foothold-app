#!/usr/bin/env python3
"""실연결 작은 E2E — 이미 떠 있는 v2_link(8790, domain 61)와 RL 세션에, 브라우저(MDrive ?live=v2) 터치 입력으로:
조종권 → STOP 해제 → 앞 → 앞+왼 아크 → 명시 0 → 앞+오른 아크 → 누르는 중 STOP → 해제 → RESET → 숨김 → 연결 끊김.
관찰자 WebSocket 이 서버 상태를 10 Hz 로 status.jsonl 에, 단계마다 캡처를 남긴다. Gazebo·RL 은 띄우지 않는다.
  python3 tools/live_e2e.py <결과 폴더(없어야 함)>"""
import asyncio, base64, json, os, subprocess, sys, tempfile, time, urllib.request
from tornado.websocket import websocket_connect
from tornado.httpclient import HTTPRequest

OUT = sys.argv[1]; os.makedirs(OUT); BASE = 'http://127.0.0.1:8790'; DBG = 9255
rows, marks, EXC, st = [], [], [], {}
t0 = time.monotonic(); phase = ['start']


def mark(name, **kw):
    marks.append({'t': round(time.monotonic() - t0, 2), 'wall': time.strftime('%H:%M:%S'), 'phase': name, **kw}); phase[0] = name
    print(marks[-1]['wall'], name, json.dumps(kw, ensure_ascii=False) if kw else '', flush=True)


async def main():
    for _ in range(60):
        try: tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json')); break
        except OSError: await asyncio.sleep(0.25)
    cdp = await websocket_connect([t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl'], max_message_size=64 << 20); n = [0]

    async def call(m, **p):
        n[0] += 1; me = n[0]; await cdp.write_message(json.dumps({'id': me, 'method': m, 'params': p}))
        while True:
            r = json.loads(await cdp.read_message())
            if r.get('method') == 'Runtime.exceptionThrown':
                d = r['params']['exceptionDetails']; EXC.append(d.get('exception', {}).get('description') or d.get('text'))
            if r.get('id') == me: return r.get('result')

    async def js(e): return (await call('Runtime.evaluate', expression=e, returnByValue=True))['result'].get('value')
    async def shot(name): open(f'{OUT}/{name}.png', 'wb').write(base64.b64decode((await call('Page.captureScreenshot', format='png'))['data']))
    async def touch(kind, pts): await call('Input.dispatchTouchEvent', type=kind, touchPoints=[{'x': x, 'y': y, 'id': i} for i, x, y in pts])
    async def center(sel): return await js(f"(e => {{ const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})({sel})")
    BTN = "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '{}')"

    peer = await websocket_connect(HTTPRequest('ws://127.0.0.1:8790/ws', headers={'Origin': BASE}))

    async def pump():
        while True:
            m = await peer.read_message()
            if m is None: return
            if isinstance(m, str):
                d = json.loads(m); st.clear(); st.update(d); s = d['sim'] or {}
                rows.append({'t': round(time.monotonic() - t0, 2), 'phase': phase[0], 'role_seen_by_observer': d['role'], 'latch': d['latch'], 'applied': d['applied'],
                             'reason': d['reason'], 'sim_block': d['sim_block'], 'resume_pending': d['resume_pending'], 'reset_pending': d['reset_pending'],
                             'episode': d['episode'], 'state_age': d['state_age'], 'cam_age': d['cam_age'],
                             'sim': {k: s.get(k) for k in ('stop_requested', 'reset_in_progress', 'policy_running', 'x', 'y', 'yaw', 'vx', 'vy', 'wz', 'tilt_deg', 'fallen', 'body_still', 'source', 'camera', 'cmd_applied')}})
    asyncio.ensure_future(pump())

    async def until(pred, t):
        end = time.time() + t
        while time.time() < end:
            try:
                if st and pred(): return True
            except (TypeError, KeyError): pass
            await asyncio.sleep(0.1)
        return False

    def S(): return st['sim'] or {}
    await call('Runtime.enable')
    await call('Emulation.setDeviceMetricsOverride', width=844, height=390, deviceScaleFactor=1, mobile=False)
    await call('Emulation.setTouchEmulationEnabled', enabled=True, maxTouchPoints=5)
    await call('Page.navigate', url=f'{BASE}/MDrive.dc.html?live=v2'); await asyncio.sleep(3)
    move = await center("document.querySelector('[aria-label=\"이동 막대: 앞뒤와 옆걸음\"]')")
    turn = await center("document.querySelector('[aria-label=\"회전 막대: 왼쪽 오른쪽\"]')")
    stopc = await center("document.querySelector('[aria-label=\"비상 정지\"]')")
    up, L, R = (move[0], move[1] - 60), (turn[0] - 80, turn[1]), (turn[0] + 80, turn[1])
    mark('0-loaded', sim_stop=S().get('stop_requested'), x=S().get('x')); await shot('0-loaded')

    mark('1-take'); await touch('touchStart', [(1, *move)]); await touch('touchEnd', [])
    mark('1-take-done', ok=await until(lambda: st['role'] == 'view_other', 3))
    mark('2-resume'); await until(lambda: S().get('stop_requested'), 3)
    await touch('touchStart', [(2, *await center(BTN.format('STOP 해제')))]); await touch('touchEnd', [])
    mark('2-resume-done', ok=await until(lambda: not st['latch'], 5)); await asyncio.sleep(0.5)

    x0 = S().get('x'); mark('3-fwd', x=x0)
    await touch('touchStart', [(3, *move)]); await touch('touchMove', [(3, *up)])
    await until(lambda: st['applied'] == [0.6, 0, 0], 2); await asyncio.sleep(1.5); await shot('3-fwd')
    mark('4-arc-left'); await touch('touchStart', [(3, *up), (4, *turn)]); await touch('touchMove', [(3, *up), (4, *L)])
    mark('4-arc-left-applied', ok=await until(lambda: st['applied'] == [0.6, 0, 0.5], 2)); await asyncio.sleep(1.5); await shot('4-arc-left')
    mark('5-zero'); await touch('touchEnd', [])
    mark('5-zero-applied', ok=await until(lambda: st['applied'] == [0, 0, 0], 1)); await asyncio.sleep(2.5); await shot('5-zero')
    mark('5-zero-end', vx=S().get('vx'), body_still=S().get('body_still'))
    mark('6-arc-right'); await touch('touchStart', [(5, *move)]); await touch('touchMove', [(5, *up)])
    await touch('touchStart', [(5, *up), (6, *turn)]); await touch('touchMove', [(5, *up), (6, *R)])
    mark('6-arc-right-applied', ok=await until(lambda: st['applied'] == [0.6, 0, -0.5], 2)); await asyncio.sleep(1.5); await shot('6-arc-right')
    await touch('touchEnd', []); await asyncio.sleep(0.5)
    mark('7-stop-while-pressing'); await touch('touchStart', [(7, *move)]); await touch('touchMove', [(7, *up)])
    await until(lambda: st['applied'] == [0.6, 0, 0], 2); await asyncio.sleep(1.0)
    await touch('touchStart', [(7, *up), (8, *stopc)])
    mark('7-stop-latched', ok=await until(lambda: st['latch'] and st['applied'] == [0, 0, 0] and S().get('stop_requested'), 2))
    await asyncio.sleep(1.0); await touch('touchEnd', []); await shot('7-stop')
    mark('8-resume'); await touch('touchStart', [(9, *await center(BTN.format('STOP 해제')))]); await touch('touchEnd', [])
    mark('8-resume-done', ok=await until(lambda: not st['latch'], 5), applied=st['applied'])
    mark('9-reset'); await touch('touchStart', [(10, *stopc)]); await touch('touchEnd', []); await until(lambda: S().get('stop_requested'), 3)
    ep = st['episode']; await touch('touchStart', [(11, *await center(BTN.format('시뮬 리셋')))]); await touch('touchEnd', [])
    await asyncio.sleep(1.0); await shot('9-reset-pending')
    ok = await until(lambda: st['episode'] == ep + 1 and not st['reset_pending'] and not st['sim_block'], 40)
    mark('9-reset-done', ok=ok, episode=st['episode'], latch=st['latch'], x=S().get('x')); await asyncio.sleep(1.0); await shot('9-reset-done')
    mark('10-hidden'); await js("Object.defineProperty(document, 'hidden', {value: true, configurable: true}); document.dispatchEvent(new Event('visibilitychange'))")
    mark('10-hidden-done', ok=await until(lambda: st['role'] == 'view', 3))
    await call('Page.navigate', url=f'{BASE}/MDrive.dc.html?live=v2'); await asyncio.sleep(2)
    await touch('touchStart', [(12, *move)]); await touch('touchEnd', []); await until(lambda: st['role'] == 'view_other', 3)
    mark('11-disconnect'); await call('Page.navigate', url='about:blank')
    mark('11-disconnect-done', ok=await until(lambda: st['role'] == 'view', 3), applied=st['applied'])
    await asyncio.sleep(1.0); mark('end', latch=st['latch'], role=st['role'], applied=st['applied'], episode=st['episode'])
    peer.close()


chrome = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', f'--remote-debugging-port={DBG}', f'--user-data-dir={tempfile.mkdtemp()}',
                           '--no-first-run', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    asyncio.run(main())
finally:
    chrome.terminate(); chrome.wait(5)
    with open(f'{OUT}/status.jsonl', 'w') as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    json.dump({'cmd': sys.argv, 'marks': marks, 'exceptions': EXC, 'test_process_env_ROS_DOMAIN_ID(ROS 미사용)': os.environ.get('ROS_DOMAIN_ID'), 'actual_gateway_domain': st.get('ros_domain'),
               'note': '실제 RL 세션(domain 61) 대상 · 브라우저 터치 입력 · 서버 상태는 관찰자 WebSocket 기록'},
              open(f'{OUT}/manifest.json', 'w'), ensure_ascii=False, indent=1)
    print('exceptions', EXC)

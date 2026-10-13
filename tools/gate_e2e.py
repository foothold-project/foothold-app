#!/usr/bin/env python3
"""실연결 E2E(두 기기·보호 경로) — 이미 떠 있는 v2_link(127.0.0.1:8792, domain 61)에 같은 코드의 시험 관문(127.0.0.1:8473, 임시 계정·임시 인증서)을 붙여
PC 화면에서 «시뮬 시작(30분)» 1회(RL 래퍼) → 휴대폰 화면(874×402·터치)으로 조종권 → STOP 해제 → 앞 → 왼/오 아크 → 손뗌 → STOP → 📷 → 재연결 → PC 기록에서 같은 사진.
관찰자 WebSocket(v2_link 8792 직접, 보기 전용)이 서버 상태를 status.jsonl 에 남긴다. 실제 계정(.gate)은 쓰지 않는다. 시뮬이 이미 돌고 있으면 시작을 누르지 않는다.
  python3 tools/gate_e2e.py <결과 폴더(없어야 함)>"""
import asyncio, base64, hashlib, json, os, secrets, shutil, signal, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from tornado.httpclient import HTTPRequest
from tornado.websocket import websocket_connect

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]).resolve(); OUT.mkdir(parents=True)
LINK, GATE, DBG = 8792, 8473, 9260
H = f'https://127.0.0.1:{GATE}'
IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1'
STATE = Path(tempfile.mkdtemp(prefix='v2gate-e2e-')); PW = secrets.token_urlsafe(12)
RES, MARKS, EXC, rows, st, procs = [], [], [], [], {}, {}
t0 = time.monotonic()


def mark(name, **kw):
    MARKS.append({'t': round(time.monotonic() - t0, 2), 'wall': time.strftime('%H:%M:%S'), 'phase': name, **kw})
    print(MARKS[-1]['wall'], name, json.dumps(kw, ensure_ascii=False) if kw else '', flush=True)


def check(name, ok, detail=''):
    RES.append({'name': name, 'ok': bool(ok), 'detail': str(detail)[:300]}); mark(('PASS ' if ok else 'FAIL ') + name, detail=str(detail)[:200] if not ok else '')


def spki():
    pub = subprocess.run(['openssl', 'x509', '-in', str(STATE / 'cert.pem'), '-pubkey', '-noout'], capture_output=True, check=True).stdout
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'der'], input=pub, capture_output=True, check=True).stdout
    return base64.b64encode(hashlib.sha256(der).digest()).decode()


def make_state():
    sys.path.insert(0, str(ROOT.parent / 'control-app' / 'ros'))
    import phone_gate as G
    G.add_user(STATE / 'accounts.json', 'e2e', PW); G.ensure_secrets(STATE, ['127.0.0.1'])
    fd = os.open(STATE / 'hmac.key', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(secrets.token_hex(32))


class Page:                                    # CDP 페이지 하나(브라우저 문맥 = 기기 하나, 쿠키 따로)
    def __init__(self, ws): self.ws, self.n = ws, 0

    async def call(self, m, **p):
        self.n += 1; me = self.n; await self.ws.write_message(json.dumps({'id': me, 'method': m, 'params': p}))
        while True:
            r = json.loads(await self.ws.read_message())
            if r.get('method') == 'Runtime.exceptionThrown':
                d = r['params']['exceptionDetails']; EXC.append(d.get('exception', {}).get('description') or d.get('text'))
            if r.get('id') == me: return r.get('result', r.get('error'))

    async def js(self, e): return (await self.call('Runtime.evaluate', expression=e, returnByValue=True, awaitPromise=True)).get('result', {}).get('value')
    async def shot(self, name): (OUT / f'{name}.png').write_bytes(base64.b64decode((await self.call('Page.captureScreenshot', format='png'))['data']))
    async def nav(self, url, t=3.0): await self.call('Page.navigate', url=url); await asyncio.sleep(t)
    async def center(self, sel): return await self.js(f"(e => {{ if (!e) return null; e.scrollIntoView({{block: 'nearest'}}); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})({sel})")

    async def click(self, sel):
        c = await self.center(sel)
        if not c: return None
        await self.call('Input.dispatchMouseEvent', type='mousePressed', x=c[0], y=c[1], button='left', buttons=1, clickCount=1)
        await self.call('Input.dispatchMouseEvent', type='mouseReleased', x=c[0], y=c[1], button='left', buttons=0, clickCount=1)
        return c

    async def touch(self, kind, pts): await self.call('Input.dispatchTouchEvent', type=kind, touchPoints=[{'x': x, 'y': y, 'id': i} for i, x, y in pts])
    async def toast(self): return await self.js("document.querySelector('[data-live-toast]')?.style.display === 'block' ? document.querySelector('[data-live-toast]').textContent : ''")


BTN = "[...document.querySelectorAll('button,a')].find(b => b.getClientRects().length && b.textContent.trim().startsWith({!r}))"
def vis(label):   # 보이는 요소 하나. 따옴표는 JSON 으로(repr 의 ' 가 JS 문자열을 끊던 버그)
    return '[...document.querySelectorAll(' + json.dumps(f'[aria-label="{label}"]') + ')].find(e => e.getClientRects().length && e.getBoundingClientRect().width > 0)'


async def main():
    obs = await websocket_connect(HTTPRequest(f'ws://127.0.0.1:{LINK}/ws', headers={'Origin': f'http://127.0.0.1:{LINK}'}))
    async def pump():
        while True:
            m = await obs.read_message()
            if m is None: return
            if isinstance(m, str):
                d = json.loads(m); st.clear(); st.update(d)
                rows.append({'t': round(time.monotonic() - t0, 2), 'phase': MARKS[-1]['phase'] if MARKS else '', **{k: d.get(k) for k in ('latch', 'applied', 'holder', 'sim_block', 'state_age', 'cam_age', 'episode', 'reason', 'resume_pending')},
                             'sim': d.get('sim'), 'session': (d.get('sim_start') or {}).get('session')})
    asyncio.ensure_future(pump())
    async def until(pred, t):
        end = time.time() + t
        while time.time() < end:
            try:
                if st and pred(): return True
            except (TypeError, KeyError, AttributeError): pass
            await asyncio.sleep(0.1)
        return False
    await until(lambda: True, 5)
    mark('관찰 시작', holder=st.get('holder'), sim_block=st.get('sim_block'), session=(st.get('sim_start') or {}).get('session'))
    if st.get('holder'):
        return check('시작 전 조종 기기 없음', False, st.get('holder'))

    for _ in range(80):
        try: json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json/version')); break
        except OSError: await asyncio.sleep(0.25)
    bws = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json/version'))['webSocketDebuggerUrl']
    br = Page(await websocket_connect(bws, max_message_size=64 << 20))
    pages = {}
    for name in ('pc', 'phone'):
        ctx = (await br.call('Target.createBrowserContext'))['browserContextId']
        tid = (await br.call('Target.createTarget', url='about:blank', browserContextId=ctx))['targetId']
        pages[name] = Page(await websocket_connect(f'ws://127.0.0.1:{DBG}/devtools/page/{tid}', max_message_size=64 << 20))
        await pages[name].call('Page.enable'); await pages[name].call('Runtime.enable')
    pc, ph = pages['pc'], pages['phone']
    await pc.call('Emulation.setDeviceMetricsOverride', width=1440, height=920, deviceScaleFactor=1, mobile=False)
    await ph.call('Emulation.setUserAgentOverride', userAgent=IPHONE)
    await ph.call('Emulation.setDeviceMetricsOverride', width=874, height=402, deviceScaleFactor=1, mobile=True)
    await ph.call('Emulation.setTouchEmulationEnabled', enabled=True, maxTouchPoints=5)

    async def login(p, uid, pwid, device, dvid=None):
        await p.js(f"document.querySelector('#{uid}').value = 'e2e'"); await p.js(f"document.querySelector('#{pwid}').value = {json.dumps(PW)}")
        if dvid: await p.js(f"document.querySelector('#{dvid}').value = {json.dumps(device)}")
        await p.click(BTN.format('로그인')); await asyncio.sleep(3.5)

    # 1) PC 로그인 → 관제 → 시뮬 시작(꺼져 있을 때만)
    await pc.nav(f'{H}/Main.dc.html?live=v2'); await login(pc, 'id', 'pw', '관제 PC', 'dv')
    check('PC 보호 경로 로그인 → 관제', await pc.js('location.pathname') == '/Main.dc.html', await pc.js('location.href'))
    await asyncio.sleep(1.5); await pc.shot('01-pc-before-start')
    started = False
    if st.get('sim_block') in ('시뮬 상태 끊김', '시뮬 상태 미수신'):
        ok_ = await until(lambda: st['sim_start']['ok'], 10)
        if not ok_:
            return check('시뮬 시작 가능', False, st.get('sim_start'))
        old = {(e['t'], e['text']) for e in st['events']}   # 누르기 전 이벤트(앞 사람의 결과)는 이번 결과로 치지 않는다
        await pc.js('window.confirm = () => true'); mark('시뮬 시작 누름')
        await pc.click(BTN.format('시뮬 시작(30분)')); await asyncio.sleep(1.0); t = await pc.toast()
        check('PC «시뮬 시작(30분)» → 요청 접수', t.startswith('시뮬 시작 요청함'), t); started = True
        new = lambda: [e['text'] for e in st['events'] if (e['t'], e['text']) not in old]
        res = await until(lambda: any('시뮬 시작 결과' in x for x in new()), 240)
        evs = new(); mark('래퍼 결과', events=evs[:4])
        if not res or not any('시뮬 시작 결과' in e and ('기동 중' in e or '수신 확인' in e) for e in evs):
            return check('래퍼 결과 starting/ready', False, evs[:4])
    live = await until(lambda: not st['sim_block'] and st['state_age'] < 1 and st['cam_age'] is not None and st['cam_age'] < 1, 120)
    check('시뮬 상태·영상 수신(서버 원값)', live, {k: st.get(k) for k in ('sim_block', 'state_age', 'cam_age')})
    if not live: return
    await asyncio.sleep(2.0); await pc.shot('02-pc-live')
    check('PC 영상 표시(프레임 그려짐)', await pc.js("[...document.querySelectorAll('img,canvas')].some(e => e.getClientRects().length && (e.naturalWidth || e.width) > 100 && e.getBoundingClientRect().width > 200)"))

    # 2) 휴대폰 로그인 → 조종 화면
    await ph.nav(f'{H}/'); await login(ph, 'mid', 'mpw', '휴대폰')
    lay = await ph.js("[location.pathname, new URLSearchParams(location.search).get('stickLayout')]")
    check('휴대폰 보호 경로 로그인 → 조종 화면(왼쪽 회전 · 오른쪽 앞뒤)', lay == ['/MDrive.dc.html', '왼쪽 회전 · 오른쪽 앞뒤'], lay)
    await asyncio.sleep(2.0); await ph.shot('03-phone-view')
    check('휴대폰 영상 표시', await ph.js("[...document.querySelectorAll('img,canvas')].some(e => e.getClientRects().length && (e.naturalWidth || e.width) > 100 && e.getBoundingClientRect().width > 200)"))
    await ph.click(BTN.format('조종권 받기'))
    check('휴대폰 조종권 → 조종 기기 «e2e · 휴대폰»', await until(lambda: st['holder'] == 'e2e · 휴대폰', 3), st.get('holder'))
    check('시작 상태 STOP 잠금', st.get('latch') is True, st.get('latch'))
    await ph.click(BTN.format('STOP 해제')); mark('STOP 해제 누름')
    check('STOP 해제(시뮬 확인)', await until(lambda: not st['latch'] and not st['resume_pending'], 8), {k: st.get(k) for k in ('latch', 'resume_pending', 'reason')})
    await asyncio.sleep(0.5)

    fwd = await ph.center(vis('앞뒤 막대')) or await ph.center(vis('이동 막대: 앞뒤와 옆걸음'))
    turn = await ph.center(vis('회전 막대: 왼쪽 오른쪽'))
    if not fwd or not turn:   # 막대를 못 찾으면 화면의 막대 라벨·크기를 남기고 멈춘다(추측 좌표로 누르지 않음)
        dom = await ph.js("[...document.querySelectorAll('[aria-label*=\"막대\"]')].map(e => [e.getAttribute('aria-label'), e.getClientRects().length, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().top)])")
        await ph.shot('04-phone-no-stick'); return check('막대 찾기', False, {'fwd': fwd, 'turn': turn, 'dom': dom})
    x0 = (st.get('sim') or {}).get('x')
    mark('앞 누름'); await ph.touch('touchStart', [(1, *fwd)]); await ph.touch('touchMove', [(1, fwd[0], fwd[1] - 60)])
    a = await until(lambda: st['applied'] == [0.6, 0, 0], 2); await asyncio.sleep(3.0); await ph.shot('04-phone-fwd')
    x1 = (st.get('sim') or {}).get('x'); await ph.touch('touchEnd', [])
    z = await until(lambda: st['applied'] == [0, 0, 0], 1)
    check('앞 0.6 · 3 s 이동 · 손 떼면 0', a and z, {'x0': x0, 'x1': x1})
    await asyncio.sleep(1.0)
    for name, dx, want in (('왼쪽 아크', -60, [0.6, 0, 0.5]), ('오른쪽 아크', 60, [0.6, 0, -0.5])):
        mark(f'{name} 누름')
        await ph.touch('touchStart', [(1, *fwd)]); await ph.touch('touchMove', [(1, fwd[0], fwd[1] - 60)])
        await ph.touch('touchStart', [(1, fwd[0], fwd[1] - 60), (2, *turn)]); await ph.touch('touchMove', [(1, fwd[0], fwd[1] - 60), (2, turn[0] + dx, turn[1])])
        a = await until(lambda: st['applied'] == want, 2); await asyncio.sleep(2.5)
        await ph.touch('touchEnd', []); z = await until(lambda: st['applied'] == [0, 0, 0], 1)
        check(f'{name} {want[0]}/{want[2]:+} · 손 떼면 0', a and z, st.get('applied')); await asyncio.sleep(1.0)
    mark('STOP 누름'); await ph.click(vis('비상 정지'))
    check('STOP → 잠금 · 0', await until(lambda: st['latch'] and st['applied'] == [0, 0, 0], 2), {k: st.get(k) for k in ('latch', 'applied')})
    await asyncio.sleep(1.5)
    n0 = sum(1 for _ in open(ROOT / 'runs/app-media/photos.jsonl')) if (ROOT / 'runs/app-media/photos.jsonl').exists() else 0
    await ph.click(vis('사진 찍기')); await asyncio.sleep(1.5); t = await ph.toast()
    n1 = sum(1 for _ in open(ROOT / 'runs/app-media/photos.jsonl')) if (ROOT / 'runs/app-media/photos.jsonl').exists() else 0
    check('휴대폰 📷 → 서버 저장', '서버 저장' in t and n1 == n0 + 1, [t, n0, n1]); await ph.shot('05-phone-photo')

    # 3) 재연결: 화면 떠남 → 조종권 해제·STOP 유지 → 다시 열면 보기 전용
    await ph.nav('about:blank', 1.0)
    check('휴대폰 화면 떠남 → 조종권 해제 · STOP 잠금', await until(lambda: st['holder'] is None and st['latch'], 3), st.get('holder'))
    await ph.nav(f'{H}/MDrive.dc.html?live=v2', 3.5); await ph.shot('06-phone-reconnect')
    check('다시 열기 → 로그인 유지 · 보기 전용 · STOP 유지', await ph.js('location.pathname') == '/MDrive.dc.html' and st.get('holder') is None and st.get('latch') is True)

    # 4) PC 기록: 휴대폰 사진이 같은 서버에
    await pc.click("document.querySelector('nav a[data-design-href=\"PcHistory.dc.html\"]')"); await asyncio.sleep(2.0)
    rec = await pc.js("document.querySelector('[role=dialog]')?.innerText || ''")
    check('PC 기록에 휴대폰 사진(e2e · 휴대폰)·미리보기', 'e2e · 휴대폰' in rec and await pc.js("[...document.querySelectorAll('[role=dialog] img')].some(i => i.complete && i.naturalWidth > 0)"), rec[:200])
    await pc.shot('07-pc-records')
    mark('끝', started=started, session=(st.get('sim_start') or {}).get('session'))
    obs.close()


chrome = None
try:
    make_state()
    LOG = OUT / 'gate.log'
    procs['gate'] = subprocess.Popen([sys.executable, 'sim/v2_gate.py', '--bind', '127.0.0.1', '--port', str(GATE), '--upstream', f'127.0.0.1:{LINK}', '--state', str(STATE)],
                                     stdout=open(LOG, 'w'), stderr=subprocess.STDOUT, cwd=ROOT)
    chrome = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', f'--remote-debugging-port={DBG}', f'--user-data-dir={tempfile.mkdtemp()}',
                               f'--ignore-certificate-errors-spki-list={spki()}', '--no-first-run', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)
    asyncio.run(main())
finally:
    if chrome: chrome.terminate(); chrome.wait(5)
    p = procs.get('gate')
    if p and p.poll() is None: p.send_signal(signal.SIGINT); p.wait(8)
    shutil.rmtree(STATE, ignore_errors=True)
    with open(OUT / 'status.jsonl', 'w') as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    json.dump({'cmd': sys.argv, 'link': LINK, 'gate': GATE, 'marks': MARKS, 'results': RES, 'exceptions': EXC, 'state_dir_removed': not STATE.exists(),
               'pass': sum(r['ok'] for r in RES), 'total': len(RES),
               'note': '실 v2(domain 61) + 같은 코드의 시험 관문(임시 계정·임시 인증서, Chrome 은 그 키 SPKI 만 신뢰). 휴대폰은 Chrome 모바일 에뮬레이션 — 실제 iPhone 근거 아님'},
              open(OUT / 'manifest.json', 'w'), ensure_ascii=False, indent=1)
    print(f"{sum(r['ok'] for r in RES)}/{len(RES)} exceptions {EXC}")

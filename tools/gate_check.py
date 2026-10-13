#!/usr/bin/env python3
"""v2 보호 관문(sim/v2_gate.py) 모의 시험 — 시험 전용 계정·인증서(임시 폴더, 실제 .gate 안 씀) + 가짜 발행기(domain 88)
+ v2_link(8791) + 관문 2개(8463: 12 h · 8464: 세션 3 s 만료 시험) + headless Chrome 한 개. 실제 RL 근거가 아니다.
  source /opt/ros/jazzy/setup.bash; ROS_DOMAIN_ID=88 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST python3 tools/gate_check.py <결과 폴더(없어야 함)>
검사: 로그인 전 차단(화면·사진·기록·WS) · 공개 파일 · Origin·틀린 비밀번호 · 쿠키 속성 · 허용 안 된 op 끊음 · 사진 서버 저장/인증 · 공용 문서(401·403·409·작성자) ·
      계정·기기 표시 · 로그아웃/만료 → 조종권 해제·0·STOP 잠금 · 휴대폰 로그인→조종→사진→로그아웃 · PC 로그인→같은 사진 보임."""
import asyncio, base64, hashlib, json, os, secrets, shutil, signal, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from tornado.httpclient import AsyncHTTPClient, HTTPRequest
from tornado.websocket import websocket_connect

if os.environ.get('ROS_DOMAIN_ID') in (None, '', '61', '57'):
    sys.exit('gate_check: ROS_DOMAIN_ID=88 같은 시험 전용 domain 에서만')
ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]).resolve(); OUT.mkdir(parents=True)
LINK, GATE, GATE2, DBG = 8791, 8463, 8464, 9258
H, H2 = f'https://127.0.0.1:{GATE}', f'https://127.0.0.1:{GATE2}'
IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1'
PC = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
RES, EXC, LOG, procs, st = [], [], [], {}, {}
STATE = Path(tempfile.mkdtemp(prefix='v2gate-test-'))          # 시험 계정·인증서 — 끝나면 지움
PW = secrets.token_urlsafe(12)                                   # 시험 계정 비밀번호(이 프로세스 안에만)


def check(name, ok, detail=''):
    RES.append({'name': name, 'ok': bool(ok), 'detail': str(detail)[:300]}); print('PASS' if ok else 'FAIL', name, '' if ok else detail, flush=True)


def start(key, args):
    f = open(OUT / f'{key}.log', 'a'); LOG.append({'key': key, 'cmd': args})
    procs[key] = subprocess.Popen(args, stdout=f, stderr=subprocess.STDOUT, cwd=ROOT)


def stop(key):                                # 내가 띄운 프로세스만, INT 로
    p = procs.pop(key, None)
    if p and p.poll() is None:
        p.send_signal(signal.SIGINT)
        try: p.wait(8)
        except subprocess.TimeoutExpired: p.terminate(); p.wait(5)


def spki():                                     # 브라우저 신뢰를 이 시험 서버 인증서 키 하나로만 한정(전역 우회 아님)
    pub = subprocess.run(['openssl', 'x509', '-in', str(STATE / 'cert.pem'), '-pubkey', '-noout'], capture_output=True, check=True).stdout
    der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'der'], input=pub, capture_output=True, check=True).stdout
    return base64.b64encode(hashlib.sha256(der).digest()).decode()


def make_state():
    sys.path.insert(0, str(ROOT.parent / 'control-app' / 'ros'))
    import phone_gate as G
    G.add_user(STATE / 'accounts.json', 'tester', PW)
    G.ensure_secrets(STATE, ['127.0.0.1'])
    fd = os.open(STATE / 'hmac.key', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(secrets.token_hex(32))


async def main():
    http = AsyncHTTPClient()

    async def req(url, method='GET', body=None, cookie='', origin=None, ua=PC):
        hd = {'User-Agent': ua}
        if cookie: hd['Cookie'] = cookie
        if origin: hd['Origin'] = origin
        if body is not None: hd['Content-Type'] = 'application/json'
        return await http.fetch(HTTPRequest(url, method=method, headers=hd, body=None if body is None else json.dumps(body),
                                            ca_certs=str(STATE / 'ca.crt'), follow_redirects=False), raise_error=False)   # 시험 CA 로만 검증

    def jar(r):                                # Set-Cookie → Cookie 헤더 + 속성 원문
        sc = r.headers.get_list('Set-Cookie')
        return '; '.join(c.split(';')[0] for c in sc), sc

    async def login(base, device):
        r = await req(f'{base}/api/login', 'POST', {'user': 'tester', 'pw': PW, 'device': device}, origin=base)
        return r, jar(r)

    async def ws(base, cookie, origin=None):
        hd = {'Origin': origin or base}
        if cookie: hd['Cookie'] = cookie
        return await websocket_connect(HTTPRequest(base.replace('https', 'wss') + '/ws', headers=hd, ca_certs=str(STATE / 'ca.crt')))

    async def wait_close(w, t=6):              # 닫힐 때까지 읽고 닫힘 코드
        end = time.time() + t
        while time.time() < end:
            try: m = await asyncio.wait_for(w.read_message(), end - time.time())
            except asyncio.TimeoutError: break
            if m is None: return w.close_code
        return None

    async def ask(w, op, **kw):                # 관문 WS 로 요청 → reply
        w.write_message(json.dumps({'op': op, 'rid': 7, **kw}))
        end = time.time() + 5
        while time.time() < end:
            m = await asyncio.wait_for(w.read_message(), 5)
            if m is None: return None
            if isinstance(m, str) and json.loads(m).get('op') == 'reply': return json.loads(m)

    async def first_status(w):
        while True:
            m = await asyncio.wait_for(w.read_message(), 5)
            if m is None: return None
            if isinstance(m, str) and json.loads(m).get('op') == 'status': return json.loads(m)

    peer = await websocket_connect(HTTPRequest(f'ws://127.0.0.1:{LINK}/ws', headers={'Origin': f'http://127.0.0.1:{LINK}'}))
    async def pump():
        while True:
            m = await peer.read_message()
            if m is None: return
            if isinstance(m, str): st.clear(); st.update(json.loads(m))
    asyncio.ensure_future(pump())
    async def until(pred, t):
        end = time.time() + t
        while time.time() < end:
            try:
                if st and pred(): return True
            except (TypeError, KeyError): pass
            await asyncio.sleep(0.1)
        return False
    await until(lambda: st.get('cam_age') is not None and st['cam_age'] < 1 and not st['sim_block'], 15)

    # 1) 로그인 전: 화면·기록·사진·WS 차단, 공개 파일만 열림
    r = await req(f'{H}/', ua=IPHONE); r2 = await req(f'{H}/', ua=PC)
    check('첫 주소: 휴대폰 → 조종, PC → 관제', r.code == 302 and r.headers['Location'] == 'MDrive.dc.html?live=v2' and r2.headers.get('Location') == 'Main.dc.html?live=v2', [r.code, r.headers.get('Location'), r2.headers.get('Location')])
    r = await req(f'{H}/MDrive.dc.html?live=v2&stickLayout=a', ua=IPHONE)
    check('로그인 전 조종 화면 → 휴대폰 로그인(next 보존)', r.code == 302 and r.headers['Location'] == '/MLogin.dc.html?live=v2&next=/MDrive.dc.html%3Flive%3Dv2%26stickLayout%3Da', r.headers.get('Location'))
    r = await req(f'{H}/Main.dc.html?live=v2'); check('로그인 전 관제 화면 → PC 로그인', r.code == 302 and r.headers['Location'].startswith('/PcLogin.dc.html'), r.headers.get('Location'))
    codes = {p: (await req(f'{H}/{p}')).code for p in ('api/media', 'media/photos/20261013/x.jpg', 'index.html', 'Main.dc.html', 'tools/gate_check.py', '../sim/v2_link.py')}
    check('로그인 전 기록·사진 401 · 다른 화면·파일 열림 없음', codes['api/media'] == 401 and codes['media/photos/20261013/x.jpg'] == 401 and all(c in (302, 403, 404) for k, c in codes.items() if not k.startswith(('api', 'media'))), codes)
    pub = {p: (await req(f'{H}/{p}')).code for p in ('MLogin.dc.html', 'PcLogin.dc.html', 'dc.js', 'live.js', 'start.html', 'manifest.webmanifest', 'icons/icon-192.png', 'ca.crt')}
    check('공개 파일(로그인 화면·안내·설치 정보·공개 인증서)', all(c == 200 for c in pub.values()), pub)
    r = await req(f'{H}/ca.key'); r2 = await req(f'{H}/accounts.json')
    check('비밀 파일 안 열림(ca.key·accounts.json)', r.code != 200 and r2.code != 200, [r.code, r2.code])
    try:
        w = await ws(H, ''); cc = await wait_close(w)
    except Exception as e:
        cc = type(e).__name__
    check('로그인 전 WS → 4401 끊음', cc == 4401, cc)

    # 2) 로그인: Origin·틀린 비밀번호·쿠키 속성
    r = await req(f'{H}/api/login', 'POST', {'user': 'tester', 'pw': PW}, origin='https://evil.example')
    r2 = await req(f'{H}/api/login', 'POST', {'user': 'tester', 'pw': PW})
    r3 = await req(f'{H}/api/login', 'POST', {'user': 'tester', 'pw': 'wrong-password'}, origin=H)
    check('다른 출처·출처 없음 403 · 틀린 비밀번호 401(쿠키 없음)', r.code == 403 and r2.code == 403 and r3.code == 401 and not r3.headers.get_list('Set-Cookie'), [r.code, r2.code, r3.code])
    r, (ck, sc) = await login(H, '관제 노트북')
    attrs = all(('HttpOnly' in c and 'Secure' in c and 'SameSite=Strict' in c) for c in sc)
    check('로그인 성공: fh2_s·fh2_dev(운영 fh_s 와 다른 이름) · HttpOnly·Secure·SameSite=Strict', r.code == 200 and {c.split('=')[0] for c in sc} == {'fh2_s', 'fh2_dev'} and attrs, [r.code, [c.split('=')[0] for c in sc]])
    who = json.loads((await req(f'{H}/api/whoami', cookie=ck)).body)
    check('whoami: 계정·기기 이름', who.get('account') == 'tester' and who.get('label') == '관제 노트북', who)
    r = await req(f'{H}/MDrive.dc.html?live=v2', cookie=ck, ua=IPHONE); check('로그인 뒤 조종 화면 200', r.code == 200, r.code)
    # 공용 문서(구역·임무): 로그인 뒤에만 · 쓰기는 같은 출처 · 작성자 = 계정 · 기기(관문이 붙임) · 같은 rev 두 번 → 409
    z = {'name': '시험 구역', 'type': '금지', 'pts': [[0, 0], [1, 0], [1, 1]]}
    r0 = await req(f'{H}/api/docs'); r1 = await req(f'{H}/api/docs', 'POST', {'op': 'put', 'kind': 'zone', 'id': None, 'doc': z}, cookie=ck, origin='https://evil.example')
    r2 = await req(f'{H}/api/docs', 'POST', {'op': 'put', 'kind': 'zone', 'id': None, 'doc': z}, cookie=ck, origin=H); d2 = json.loads(r2.body or b'{}')
    r3 = await req(f'{H}/api/docs', 'POST', {'op': 'put', 'id': d2.get('id'), 'rev': 1, 'doc': {**z, 'name': 'A'}}, cookie=ck, origin=H)
    r4 = await req(f'{H}/api/docs', 'POST', {'op': 'put', 'id': d2.get('id'), 'rev': 1, 'doc': {**z, 'name': 'B'}}, cookie=ck, origin=H)
    g = json.loads((await req(f'{H}/api/docs', cookie=ck)).body); zd = next((x for x in g.get('docs', []) if x.get('id') == d2.get('id')), {})
    check('공용 문서: 로그인 전 401 · 다른 출처 403 · 저장 200 · 같은 rev 두 번째 409 · 작성자 = 계정 · 기기',
          r0.code == 401 and r1.code == 403 and r2.code == 200 and r3.code == 200 and r4.code == 409 and zd.get('doc', {}).get('name') == 'A' and 'tester · 관제 노트북' in json.dumps(zd, ensure_ascii=False),
          [r0.code, r1.code, r2.code, r3.code, r4.code, zd])
    srv_log = (OUT / 'gate.log').read_text()
    check('관문 로그에 비밀번호·쿠키 값 없음', PW not in srv_log and ck.split('fh2_s=')[1].split(';')[0] not in srv_log)

    # 3) WS: 출처·허용 op·계정 표시·사진
    try:
        w = await ws(H, ck, origin='https://evil.example'); bad = await wait_close(w)
    except Exception as e:
        bad = type(e).__name__
    check('다른 출처 WS 거부', bad in ('HTTPClientError', 'HTTP403', 403) or bad == 'HTTPClientError', bad)
    w = await ws(H, ck); s0 = await first_status(w)
    check('관문 WS 상태: 이 기기 = 계정 · 기기 이름(서버가 붙임)', s0 and s0['me'] == 'tester · 관제 노트북', s0 and s0.get('me'))
    p = await ask(w, 'photo')
    check('관문 경유 사진: 서버 저장', p and p['ok'] and p['photo']['by'] == 'tester · 관제 노트북', p)
    if p and p['ok']:
        r = await req(f'{H}/{p["photo"]["url"]}', cookie=ck); r2 = await req(f'{H}/{p["photo"]["url"]}')
        check('사진 파일: 로그인 쿠키 있으면 jpeg · 없으면 401', r.code == 200 and r.body[:2] == b'\xff\xd8' and r2.code == 401, [r.code, r2.code])
    w.write_message(json.dumps({'op': 'call_service', 'service': '/x'})); cc = await wait_close(w)
    check('허용 안 된 op → 관문이 4403 끊음', cc == 4403, cc)
    w = await ws(H, ck); await first_status(w); w.write_message(json.dumps({'op': 'take', 'pad': 'x' * 1500})); cc = await wait_close(w)
    check('큰 메시지(>1 KiB) → 끊음', cc in (4403, 1009), cc)

    # 4) 로그아웃 → 조종권 해제·0·STOP 잠금
    w = await ws(H, ck); await first_status(w); w.write_message(json.dumps({'op': 'take'}))
    check('관문 WS 조종권 → v2_link 조종 기기 = 계정 · 기기', await until(lambda: st['holder'] == 'tester · 관제 노트북', 3), st.get('holder'))
    r = await req(f'{H}/api/logout', 'POST', {}, cookie=ck, origin=H); cc = await wait_close(w)
    ok = await until(lambda: st['holder'] is None and st['latch'] and st['applied'] == [0, 0, 0], 3)
    check('로그아웃 → 연결 4401 · 조종권 해제 · 0 · STOP 잠금', r.code == 200 and cc == 4401 and ok, [r.code, cc, st.get('holder'), st.get('latch')])
    r = await req(f'{H}/api/media', cookie=ck); check('로그아웃 뒤 같은 쿠키로 기록 401', r.code == 401, r.code)

    # 5) 세션 만료(관문 2, 3 s) → 끊음·잠금
    r, (ck2, _) = await login(H2, '만료 시험')
    w = await ws(H2, ck2); await first_status(w); w.write_message(json.dumps({'op': 'take'}))
    await until(lambda: st['holder'] == 'tester · 만료 시험', 3)
    cc = await wait_close(w, 8); ok = await until(lambda: st['holder'] is None and st['latch'], 3)
    r = await req(f'{H2}/Main.dc.html?live=v2', cookie=ck2)
    check('세션 만료 → 4401 · 조종권 해제 · STOP 잠금 · 화면 다시 로그인', cc == 4401 and ok and r.code == 302, [cc, ok, r.code])

    # 6) 브라우저: 휴대폰 로그인 → 조종 → 사진 → 로그아웃, PC 로그인 → 같은 사진
    for _ in range(80):
        try: tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json')); break
        except OSError: await asyncio.sleep(0.25)
    cdp = await websocket_connect([t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl'], max_message_size=64 << 20); n = [0]

    async def call(m, **pr):
        n[0] += 1; me = n[0]; await cdp.write_message(json.dumps({'id': me, 'method': m, 'params': pr}))
        while True:
            x = json.loads(await cdp.read_message())
            if x.get('method') == 'Runtime.exceptionThrown':
                d = x['params']['exceptionDetails']; EXC.append(d.get('exception', {}).get('description') or d.get('text'))
            if x.get('id') == me: return x.get('result', x.get('error'))
    async def js(e): return (await call('Runtime.evaluate', expression=e, returnByValue=True, awaitPromise=True)).get('result', {}).get('value')
    async def shot(name): open(OUT / f'{name}.png', 'wb').write(base64.b64decode((await call('Page.captureScreenshot', format='png'))['data']))
    async def click(sel):
        c = await js(f"(e => {{ if (!e) return null; e.scrollIntoView({{block: 'center'}}); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})({sel})")
        if not c: return None
        for t in ('mousePressed', 'mouseReleased'):
            await call('Input.dispatchMouseEvent', type=t, x=c[0], y=c[1], button='left', buttons=1 if t == 'mousePressed' else 0, clickCount=1)
        return c
    BTN = "[...document.querySelectorAll('button,a')].find(b => b.getClientRects().length && b.textContent.trim().startsWith({!r}))"
    async def device(ua, w_, h_, mobile):
        await call('Emulation.setUserAgentOverride', userAgent=ua)
        await call('Emulation.setDeviceMetricsOverride', width=w_, height=h_, deviceScaleFactor=1, mobile=mobile)
        await call('Emulation.setTouchEmulationEnabled', enabled=mobile, maxTouchPoints=5 if mobile else 1)
    async def nav(url, t=2.5): await call('Page.navigate', url=url); await asyncio.sleep(t)
    async def toast(): return await js("document.querySelector('[data-live-toast]')?.style.display === 'block' ? document.querySelector('[data-live-toast]').textContent : ''")
    await call('Page.enable'); await call('Runtime.enable')

    await device(IPHONE, 874, 402, True); await nav(f'{H}/')
    url = await js('location.pathname + location.search')
    check('휴대폰: 첫 주소 → 휴대폰 로그인 화면(실연결 문구)', url.startswith('/MLogin.dc.html') and 'v2 시뮬 관문' in await js('document.body.innerText'), url)
    await shot('g1-mlogin')
    await js("document.querySelector('#mid').value = 'tester'")
    await js(f"document.querySelector('#mpw').value = {json.dumps(PW)}")
    await click(BTN.format('로그인')); await asyncio.sleep(3.0)
    url = await js("[location.pathname, new URLSearchParams(location.search).get('live'), new URLSearchParams(location.search).get('stickLayout')]")
    check('휴대폰 로그인 → 조종 화면(기본 막대 배치)', url == ['/MDrive.dc.html', 'v2', '왼쪽 회전 · 오른쪽 앞뒤'], url)
    await asyncio.sleep(1.5); await shot('g2-mdrive')
    await click(BTN.format('조종권 받기'))
    check('휴대폰 조종권 → 조종 기기 «tester · 휴대폰»', await until(lambda: st['holder'] == 'tester · 휴대폰', 3), st.get('holder'))
    if st.get('latch'): await click(BTN.format('STOP 해제')); await until(lambda: not st['latch'], 5)
    await asyncio.sleep(0.4)
    mv = await js("(e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })(document.querySelector('[aria-label=\"앞뒤 막대\"]'))")
    await call('Input.dispatchTouchEvent', type='touchStart', touchPoints=[{'x': mv[0], 'y': mv[1]}])
    await call('Input.dispatchTouchEvent', type='touchMove', touchPoints=[{'x': mv[0], 'y': mv[1] - 60}])
    fwd = await until(lambda: st['applied'] == [0.6, 0, 0], 2)
    await call('Input.dispatchTouchEvent', type='touchEnd', touchPoints=[])
    check('휴대폰 터치 막대 앞 → 0.6 · 놓으면 0 (관문 경유)', fwd and await until(lambda: st['applied'] == [0, 0, 0], 1), st.get('applied'))
    await click("document.querySelector('button[aria-label=\"사진 찍기\"]')"); await asyncio.sleep(1.0); t = await toast()
    check('휴대폰 사진 → 서버 저장 안내', '서버 저장' in t, t)
    await click("document.querySelector('button[aria-label=\"안내·설정\"]')"); await asyncio.sleep(0.4)
    await click(BTN.format('로그아웃')); await asyncio.sleep(2.5)
    url = await js('location.pathname')
    check('휴대폰 로그아웃 → 로그인 화면 · 조종권 해제 · STOP 잠금', url == '/MLogin.dc.html' and await until(lambda: st['holder'] is None and st['latch'], 3), [url, st.get('holder')])

    await device(PC, 1440, 920, False); await nav(f'{H}/Main.dc.html?live=v2')
    check('PC: 로그인 전 관제 → PC 로그인 화면', await js('location.pathname') == '/PcLogin.dc.html')
    await js("document.querySelector('#id').value = 'tester'"); await js(f"document.querySelector('#pw').value = {json.dumps(PW)}")
    await js("document.querySelector('#dv').value = '관제 노트북'")
    await click(BTN.format('로그인')); await asyncio.sleep(3.0)
    check('PC 로그인 → 관제 화면', await js('location.pathname + location.search') == '/Main.dc.html?live=v2')
    await asyncio.sleep(1.0); await click("document.querySelector('nav a[href^=\"PcHistory.dc.html\"]')"); await asyncio.sleep(2.5)
    rec = await js("[...document.querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ')).filter(t => t.includes('관찰 사진'))") or []
    check('PC 기록 화면(관문 경유): 휴대폰·관문에서 찍은 사진 2장이 같은 서버에 보임', await js('location.pathname') == '/PcHistory.dc.html' and len(rec) == 2 and any('tester · 휴대폰' in t for t in rec), rec)
    await nav(f'{H}/PcReview.dc.html?live=v2', 2.5)
    check('관찰 사진 화면: 사진 실제 로드(관문 경유)', await js("[...document.querySelectorAll('img')].some(i => i.complete && i.naturalWidth > 0)"))
    await shot('g3-pc-records')
    await nav(f'{H}/start.html', 1.5); await shot('g4-start')
    check('시작 안내: PC·휴대폰 진입 링크 · 인증서·홈 화면 안내', await js("[...document.querySelectorAll('.go a')].map(a => a.getAttribute('href')).join()") == 'Main.dc.html?live=v2,MDrive.dc.html?live=v2'
          and '홈 화면에 추가' in await js('document.body.innerText'))
    peer.close()


chrome = None
try:
    make_state()
    start('fake', [sys.executable, 'tools/fake_v2_live.py', '--camera'])
    start('link', [sys.executable, 'sim/v2_link.py', '--port', str(LINK), '--media', str(OUT / 'media')])
    G = [sys.executable, 'sim/v2_gate.py', '--bind', '127.0.0.1', '--upstream', f'127.0.0.1:{LINK}', '--state', str(STATE)]
    start('gate', G + ['--port', str(GATE)]); start('gate2', G + ['--port', str(GATE2), '--ttl', '3'])
    chrome = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', f'--remote-debugging-port={DBG}', f'--user-data-dir={tempfile.mkdtemp()}',
                               f'--ignore-certificate-errors-spki-list={spki()}', '--no-first-run', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)
    asyncio.run(main())
finally:
    if chrome: chrome.terminate(); chrome.wait(5)
    for k in ('gate2', 'gate', 'link', 'fake'): stop(k)
    lst = subprocess.run(['ss', '-ltn'], capture_output=True, text=True).stdout
    shutil.rmtree(STATE, ignore_errors=True)                     # 시험 계정·인증서 키 삭제
    logs = ''.join((OUT / f'{k}.log').read_text() for k in ('gate', 'gate2') if (OUT / f'{k}.log').exists())
    RES.append({'name': '끝: 관문 로그에 시험 비밀번호 없음', 'ok': PW not in logs, 'detail': ''})
    json.dump({'cmd': sys.argv, 'env_ROS_DOMAIN_ID': os.environ.get('ROS_DOMAIN_ID'), 'ports': [LINK, GATE, GATE2], 'procs': LOG, 'results': RES, 'exceptions': EXC,
               'pw_sha256_prefix': hashlib.sha256(PW.encode()).hexdigest()[:8], 'state_dir_removed': not STATE.exists(),
               'pass': sum(r['ok'] for r in RES), 'total': len(RES), 'tls': 'python 은 시험 CA(ca_certs)로 검증, Chrome 은 시험 서버 키 SPKI 하나만 신뢰 — 실제 인증서·실기기 신뢰 근거 아님',
               'note': '모의(가짜 발행기 domain 88·시험 계정·시험 인증서) — 실제 RL·실아이폰 근거 아님'},
              open(OUT / 'manifest.json', 'w'), ensure_ascii=False, indent=1)
    print(f"{sum(r['ok'] for r in RES)}/{len(RES)} exceptions {EXC}")

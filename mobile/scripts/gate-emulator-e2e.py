#!/usr/bin/env python3
"""A 연결(관문 주소 로드) 개발 프로필 — fixture 관문 + 가짜 상태(domain 88, pause 는 89) + Android 에뮬레이터 1회 검증.

운영 관문(8453)·운영 v2_link(8792)·실계정(.gate)·실시뮬은 쓰지 않는다. full·ssl 범위는 조종권을 받지 않는다(읽기 검증만).
pause 범위는 가짜 상태에서만 조종권·STOP 해제·막대 입력을 한다(실시뮬·실기 아님, 몸 상태는 물리 정지 근거 아님).
- fixture 상태 폴더 2개(A: 이 APK 에 넣는 CA, B: 다른 CA)를 임시로 만든다. 계정·비밀번호는 메모리에서만 만들고 기록하지 않는다.
- 같은 v2_gate 코드(sim/v2_gate.py)를 127.0.0.1:18453 에만 띄우고, 에뮬레이터는 adb reverse 로 붙인다(공개 포트 없음).
- v2_link 는 127.0.0.1:18790 · domain 88, 상태는 tools/fake_v2_live.py(실제 시뮬 아님).
순서: 런처 → 앱(미인증 로그인 화면) → fixture 로그인 → 읽기 화면·WS → 배경·복귀(이벤트 실측) → 로그아웃 → 관문 끊김(오류 화면) → 다른 CA(거부).
사용(mobile 폴더): FH_GATE_SRC=<phone_gate.py 폴더> TMPDIR=<임시> python3 -B scripts/gate-emulator-e2e.py <결과 폴더(없어야 함)>
pause 범위(원격 React native pause 1회): FH_E2E_SCOPE=pause FH_UI_REV=<UI 커밋> FH_UI_MODULES=<ui/node_modules> 를 더한다.
  그 커밋 하나로 React 빌드·서버(sim·tools)·로그인 화면을 고정하고, 결과 폴더 front-manifest.json 에 판·파일 sha·실제 로드 origin 을 남긴다.
bundled 범위(최종 B 1기동 1회, mobile/docs/B-BUNDLED-TEST-PLAN.md): FH_E2E_SCOPE=bundled + 같은 FH_UI_REV·FH_UI_MODULES.
  fixture 빌드 타입(server.url 없음, 앱 안 번들 = 그 UI 판) + /api/app/*(네이티브 FhGate) · domain 89. A 원물과 섞지 않는다(결과 scope bundled-b).
"""
import asyncio, hashlib, json, math, os, re, secrets, shutil, signal, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

from tornado.websocket import websocket_connect

MOB = Path(__file__).resolve().parent.parent
REPO = MOB.parent
OUT = Path(sys.argv[1]).resolve(); OUT.mkdir(parents=True)
GATE_SRC = Path(os.environ['FH_GATE_SRC'])   # phone_gate.py 가 든 폴더 — 읽기만(import), 실제 .gate 상태는 쓰지 않음
SDK = Path.home() / 'Android/Sdk'
ADB, EMU = str(SDK / 'platform-tools/adb'), str(SDK / 'emulator/emulator')
AVDM = str(SDK / 'cmdline-tools/latest/bin/avdmanager')
IMG = 'system-images;android-34;google_apis;x86_64'
LINK, GATE, DEV = 18790, 18453, 9339
BUNDLED = os.environ.get('FH_E2E_SCOPE') == 'bundled'
PKG, ACT = 'org.footholdproject.app.fixture' if BUNDLED else 'org.footholdproject.app.gate', 'org.footholdproject.app.MainActivity'
TMP = Path(tempfile.mkdtemp(prefix='fh-a-e2e-'))
USER, PW = 'e2e', secrets.token_urlsafe(16)          # 기록·출력 금지
RES, procs, t0 = [], {}, time.monotonic()
SRV = {'n': 0, 'holders': set(), 'nonzero': 0}            # observer 가 본 status: 조종권자·비영 출력 횟수
UI_REV = os.environ.get('FH_UI_REV')                # pause: 이 UI 커밋 하나로 React 빌드·서버(sim·tools)·로그인 화면(web)을 고정
UI_MODULES = os.environ.get('FH_UI_MODULES')        # pause: 그 빌드에 쓸 ui/node_modules(읽기만, 링크)
SRVD, WEB, FRONT, SPA = REPO, None, {}, False                   # pause 에선 SRVD=TMP/srv(UI_REV git archive), WEB=TMP/web(로그인 공개 파일 + React dist)
STAT = []                                           # observer 가 본 status 시계열 (t, 조종권자, applied, latch)
DOMAIN = '89' if os.environ.get('FH_E2E_SCOPE') in ('pause', 'bundled') else '88'   # pause·bundled: UI 모의(domain 88)와 섞이지 않게 독립 89
ENV_ROS = {**os.environ, 'ROS_DOMAIN_ID': DOMAIN, 'ROS_AUTOMATIC_DISCOVERY_RANGE': 'LOCALHOST', 'PYTHONDONTWRITEBYTECODE': '1'}


def note(kind, name, detail=''):
    RES.append({'t': round(time.monotonic() - t0, 1), 'kind': kind, 'name': name, 'detail': detail})
    print(f'[{RES[-1]["t"]:7.1f}] {kind:5} {name} {detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)}'[:400], flush=True)


def check(name, ok, detail=''): note('PASS' if ok else 'FAIL', name, detail)


def adb(*a, check_=True, timeout=60):
    return subprocess.run([ADB, '-s', 'emulator-5554', *a], capture_output=True, text=True, check=check_, timeout=timeout).stdout


def shot(name): (OUT / f'{name}.png').write_bytes(subprocess.run([ADB, '-s', 'emulator-5554', 'exec-out', 'screencap', '-p'], capture_output=True, check=True).stdout)


def start(name, cmd, env=None, cwd=None):
    f = open(OUT / f'{name}.log', 'w')
    procs[name] = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT, env=env, cwd=cwd or SRVD, start_new_session=True)


def stop(name):
    """정상 정리만: INT → (15 s) → TERM → (15 s). 그래도 남으면 False(정리 미완료 보고, 강제 kill 없음)"""
    p = procs.get(name)
    if p is None: return True
    for sig in (signal.SIGINT, signal.SIGTERM):
        if group_gone(p.pid): break
        try: os.killpg(p.pid, sig)
        except ProcessLookupError: break
        end = time.monotonic() + 15
        while time.monotonic() < end and not group_gone(p.pid):
            p.poll(); time.sleep(0.5)
    p.poll()
    if group_gone(p.pid): procs.pop(name); return True
    return False


def group_gone(pg):
    try: os.killpg(pg, 0); return False
    except ProcessLookupError: return True


class Abort(Exception): pass


def need(name, ok, detail=''):
    """전제 확인 — 아니면 FAIL 기록 후 다음 단계로 넘어가지 않는다"""
    check(name, ok, detail)
    if not ok: raise Abort(name)


def wait_until(fn, secs, step=2):
    end = time.monotonic() + secs
    while time.monotonic() < end:
        if fn(): return True
        time.sleep(step)
    return False


def log(name): return (OUT / f'{name}.log').read_text(errors='replace')


def make_state(d):
    sys.path.insert(0, str(GATE_SRC)); import phone_gate as G
    G.add_user(d / 'accounts.json', USER, PW); G.ensure_secrets(d, ['127.0.0.1'])
    fd = os.open(d / 'hmac.key', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(secrets.token_hex(32))
    fp = subprocess.run(['openssl', 'x509', '-in', str(d / 'ca.crt'), '-noout', '-fingerprint', '-sha256'], capture_output=True, text=True).stdout.strip()
    return fp.split('=', 1)[-1]


# v2_gate 의 log_req 는 tornado access_log.info 인데 logging 설정이 없어 INFO 가 안 나온다(10-13 bundled 1회 B4) → 러너 쪽에서만 INFO 를 켜고 그대로 실행(sim 무수정).
# 접근 로그 경로는 관문이 /api/app/* 질의(1회용 표)를 지운 값. 비밀번호는 요청 본문이라 접근 로그에 없다(결과 폴더 비밀번호 검사가 그대로 지킴)
GATE_WRAP = ("import logging, runpy, sys; logging.basicConfig(level=logging.INFO, format='%(message)s'); "
             "sys.argv[0] = 'sim/v2_gate.py'; runpy.run_path('sim/v2_gate.py', run_name='__main__')")


def gate(state, name):
    start(name, [sys.executable, '-B', '-c', GATE_WRAP, '--bind', '127.0.0.1', '--port', str(GATE), '--upstream', f'127.0.0.1:{LINK}',
                   '--gate-src', str(GATE_SRC), '--state', str(state)] + (['--web', str(WEB)] if WEB else []) + (['--spa'] if SPA else []), env=ENV_ROS)
    for _ in range(40):
        if '열기:' in log(name): return True
        time.sleep(0.25)
    return False


class Cdp:                                            # 앱 WebView 의 DevTools(디버그 빌드에서만 열림)
    async def attach(self):
        if getattr(self, 'ws', None): self.ws.close()   # 화면이 새로 만들어지면 옛 대상은 사라진다 → 새로 붙는다
        pid = adb('shell', 'pidof', PKG).strip(); self.pid = pid
        adb('forward', f'tcp:{DEV}', f'localabstract:webview_devtools_remote_{pid}')
        for _ in range(30):
            try:
                pages = [p for p in json.loads(urllib.request.urlopen(f'http://127.0.0.1:{DEV}/json', timeout=3).read()) if p.get('type') == 'page']
                if pages: break
            except OSError: pass
            await asyncio.sleep(1)
        else:
            self.ws = None; return False
        self.ws, self.n = await websocket_connect(pages[0]['webSocketDebuggerUrl'], max_message_size=64 << 20), 0
        return True

    async def cmd(self, method, params):
        self.n += 1; me = self.n
        await self.ws.write_message(json.dumps({'id': me, 'method': method, 'params': params}))
        while True:
            r = json.loads(await self.ws.read_message())
            if r.get('id') == me: return r

    async def js(self, expr):
        r = await self.cmd('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
        return r.get('result', {}).get('result', {}).get('value')


PROBE = """(() => {                                   // 배경·복귀 때 원격 페이지가 받는 신호 실측
  window.__fh = []; const P = (k) => window.__fh.push([k, Math.round(performance.now()), document.visibilityState]);
  document.addEventListener('visibilitychange', () => P('visibilitychange')); addEventListener('pagehide', () => P('pagehide'));
  addEventListener('pageshow', () => P('pageshow')); addEventListener('blur', () => P('blur')); addEventListener('focus', () => P('focus'));
  document.addEventListener('pause', () => P('document.pause')); document.addEventListener('resume', () => P('document.resume'));
  const C = window.Capacitor, info = { capacitor: !!C };
  if (C) {
    info.native = C.isNativePlatform ? C.isNativePlatform() : null; info.platform = C.getPlatform ? C.getPlatform() : null;
    info.appAvailable = C.isPluginAvailable ? C.isPluginAvailable('App') : null; info.hasPluginsApp = !!(C.Plugins && C.Plugins.App);
    info.hasRegisterPlugin = typeof C.registerPlugin === 'function';
    try { const A = C.Plugins && C.Plugins.App; if (A && A.addListener) { A.addListener('pause', () => P('App.pause')); A.addListener('resume', () => P('App.resume'));
      A.addListener('appStateChange', (s) => P('App.appStateChange:' + s.isActive)); info.appListen = 'Plugins.App.addListener'; } } catch (e) { info.appListenErr = String(e); }
  }
  return info;
})()"""


async def observer(stop_evt):                          # v2_link 직접(127.0.0.1, 보기 전용) — 서버 쪽 사건 근거
    from tornado.httpclient import HTTPRequest
    seen = set()
    with open(OUT / 'link-events.jsonl', 'w') as f:
        try:
            ws = await websocket_connect(HTTPRequest(f'ws://127.0.0.1:{LINK}/ws', headers={'Origin': f'http://127.0.0.1:{LINK}'}))
        except Exception as e:
            note('FAIL', 'observer 연결', str(e)); return
        while not stop_evt.is_set():
            try: m = await asyncio.wait_for(ws.read_message(), 1.0)
            except asyncio.TimeoutError: continue
            if m is None: break
            if isinstance(m, bytes): continue
            try: d = json.loads(m)
            except ValueError: continue
            if d.get('op') == 'status':
                STAT.append((round(time.monotonic() - t0, 2), d.get('holder'), d.get('applied'), d.get('latch'))); SRV.setdefault('domains', set()).add(d.get('ros_domain'))
                SRV['n'] += 1; SRV['holders'].add(d.get('holder')); SRV['nonzero'] += any(abs(x) > 1e-9 for x in d.get('applied') or [])
            for e in d.get('events') or []:
                k = json.dumps(e, ensure_ascii=False, sort_keys=True)
                if k not in seen: seen.add(k); f.write(json.dumps({'t': round(time.monotonic() - t0, 1), 'event': e}, ensure_ascii=False) + '\n'); f.flush()
        ws.close()


LOGIN_JS = """(async () => { const id = document.querySelector('#mid'), pw = document.querySelector('#mpw');
  const b = [...document.querySelectorAll('a,[role=button]')].find((e) => e.textContent.trim() === '로그인');
  if (!id || !pw || !b) return 'no-form'; id.value = %s; pw.value = %s; b.click(); return 'clicked'; })()"""


async def login(cdp):                                  # fixture 계정만(실계정 없음)
    return await cdp.js(LOGIN_JS % (json.dumps(USER), json.dumps(PW)))


def sslcap(): return adb('logcat', '-d', '-v', 'time', 'Capacitor:V', 'chromium:V', 'cr_X509Util:V', '*:S', check_=False, timeout=30).splitlines()


async def attach(cdp, where):                          # CDP 대상 0 = 검사 도구 문제(TOOL_ERROR) — 앱 판정과 섞지 않는다
    if await cdp.attach(): return
    shot(f'tool-error-{where}')
    (OUT / f'tool-error-{where}-uihierarchy.xml').write_text(adb('exec-out', 'uiautomator', 'dump', '/dev/tty', check_=False, timeout=60))
    note('TOOL_ERROR', f'CDP 대상 0 ({where})', '화면·화면계층만 남김'); raise Abort(where)


def ospause(): return [l for l in adb('logcat', '-b', 'events', '-d', '-v', 'time', check_=False, timeout=30).splitlines() if 'wm_on_paused_called' in l and PKG + '/' in l]


def caplog(): return adb('logcat', '-d', '-v', 'time', 'Capacitor:V', '*:S', check_=False, timeout=30).splitlines()


async def wrong_ca(cdp):
    # ── 다른 CA 관문(B) → 신뢰 거부. 로그인 없음만으로 PASS 하지 않는다: 앱 SSL 거부 로그 + 관문 B 연결·로그인 0 + 로컬 안내 화면
    nB = len(sslcap())                                # B 단계 뒤 줄만 본다(앞 단계 -100 등 제외)
    gate_ok = gate(TMP / 'B', 'gate-B'); adb('shell', 'am', 'force-stop', PKG); await asyncio.sleep(1)
    adb('shell', 'am', 'start', '-W', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8)
    sslB = [l for l in sslcap()[nB:] if any(k in l for k in ('Trust anchor', 'net_error -202', 'handshake failed', 'Loading app at', 'Handling local request'))]
    (OUT / 'logcat-B-ssl.txt').write_text('\n'.join(sslB) + '\n')
    shot('06-wrong-ca')
    (OUT / '06-wrong-ca-uihierarchy.xml').write_text(adb('exec-out', 'uiautomator', 'dump', '/dev/tty', check_=False, timeout=60))
    gB = log('gate-B')
    check('B: 관문 B 기동', gate_ok)
    check('B: 앱 쪽 인증서 거부 로그(Trust anchor 또는 -202)', any('Trust anchor' in l or 'net_error -202' in l for l in sslB), len(sslB))
    check('B: 관문 B 에 로그인·WS 연결 0', '로그인 ' not in gB and '연결 ' not in gB, [l for l in gB.splitlines() if 'SSL' in l][:3])
    if await cdp.attach():
        loc4 = await cdp.js('location.href'); txt4 = await cdp.js('document.body.innerText') or ''
        check('B: 로컬 연결 오류 안내 화면(로그인·명령 불가)', loc4 == 'https://localhost/fh-offline.html' and '명령도 보내지 않습니다' in txt4
              and not await cdp.js("!!document.querySelector('#mpw')"), loc4)
    else:
        note('TOOL_ERROR', 'B: CDP 대상 0 — 화면은 06-wrong-ca.png·06-wrong-ca-uihierarchy.xml 로만 남김(판정 안 함)', '')
        check('B: 로컬 연결 오류 안내 화면(로그인·명령 불가)', False, 'CDP 대상 없음(TOOL_ERROR)')


async def scenario():
    cdp = Cdp()
    adb('reverse', f'tcp:{GATE}', f'tcp:{GATE}')
    shot('00-launcher')
    adb('shell', 'am', 'start', '-W', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8)
    await attach(cdp, 'start')
    loc = await cdp.js('location.href'); shot('01-login-unauth')
    check('미인증 → 관문 로그인 화면', isinstance(loc, str) and loc.startswith(f'https://127.0.0.1:{GATE}/MLogin.dc.html') and await cdp.js("!!document.querySelector('#mpw')"), loc)
    info = await cdp.js(PROBE); note('INFO', '원격 페이지의 Capacitor 브리지(로그인 화면)', info)
    r = await login(cdp)
    await asyncio.sleep(8)
    loc = await cdp.js('location.href')
    if not (isinstance(loc, str) and 'MDrive.dc.html' in loc):
        await cdp.js("(() => { const p = document.querySelector('#mpw'); if (p) p.value = ''; })()")   # 화면 캡처 전에 비밀번호 칸 비우기
    shot('02-read-after-login')
    check('fixture 로그인 → 읽기 화면', r == 'clicked' and isinstance(loc, str) and 'MDrive.dc.html' in loc and f'로그인 {USER}' in log('gate-A'), loc)
    check('읽기 화면 WS 가 관문을 거쳐 v2_link 에 연결', f'연결 {USER}' in log('gate-A'))
    who = await cdp.js("fetch('api/whoami', {credentials: 'same-origin'}).then((r) => r.status)")
    check('세션 쿠키로 whoami 200', who == 200, who)
    body = await cdp.js("document.body.innerText.slice(0, 400)"); note('INFO', '읽기 화면 글(앞 400자)', body)
    info = await cdp.js(PROBE); note('INFO', '원격 페이지의 Capacitor 브리지(읽기 화면)', info)
    if SCOPE == 'ssl':                                 # 좁은 실측(10-13 앱 Codex): 긍정 A 읽기 → 부정 B 만. 홈·로그아웃·끊김은 반복하지 않는다
        need('관문 A 정상 종료(INT/TERM)', stop('gate-A')); return await wrong_ca(cdp)
    # ── 배경·복귀
    # 옛 기준(3회차까지, 원문 보존): '복귀 뒤 같은 페이지 유지(자동 재로드 없음)'.
    # 정정(10-13 앱 Codex): Activity·WebView 재생성은 플랫폼상 일어날 수 있다 → 수락 기준은
    #   «보존 또는 재로그인 → 보기 전용» + «이전 조종권·비영 명령 자동 복원 0». 유지/재생성/로그인 재요청을 각각 보고
    note('INFO', '복귀 기준 정정', '옛 «같은 페이지 유지»를 플랫폼 보장으로 두지 않음 → 보존 또는 재로그인→보기 전용 + 자동 복원 0')
    pid1, n1 = cdp.pid, len(caplog())
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await asyncio.sleep(6)
    shot('03a-background-launcher')
    adb('shell', 'am', 'start', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8)
    new = caplog()[n1:]
    recreated = any('App destroyed' in l for l in new) and any('Starting BridgeActivity' in l for l in new)
    page_listen = sum('pluginId: App, methodName: addListener' in l for l in new)   # 재생성 뒤 페이지가 스스로 다시 붙인 수(검사 도구 PROBE 전)
    await attach(cdp, 'resume')
    loc2 = await cdp.js('location.href'); who_r = await cdp.js("fetch('api/whoami', {credentials: 'same-origin'}).then((r) => r.status)")
    ev = await cdp.js('window.__fh === undefined ? null : window.__fh')
    note('INFO', '복귀 결과', {'pid 전→후': [pid1, cdp.pid], 'Activity 재생성(logcat)': recreated, 'url': loc2, 'whoami': who_r,
                             '페이지 신호(window.__fh)': ev if ev is not None else '없음 — 이전 listener 증거 소실(활성화 완료 아님)',
                             '재생성 뒤 페이지가 스스로 붙인 App listener 수': page_listen})
    kind = '유지' if not recreated and loc2 == loc else ('로그인 재요청' if who_r == 401 or 'MLogin' in (loc2 or '') else '재생성·세션 유지')
    note('INFO', '복귀 분류', kind)
    shot('03b-after-resume')
    if 'MDrive.dc.html' not in (loc2 or ''):
        if who_r == 200:                               # 세션은 살아 있음 → 읽기 화면으로만 이동(조작 없음)
            await cdp.js("location.href = '/MDrive.dc.html?live=v2'")
        else:
            await login(cdp)                           # 인증이 끊겼으면 fixture 재로그인만
        await asyncio.sleep(8); await attach(cdp, 'relogin')
        await cdp.js("(() => { const p = document.querySelector('#mpw'); if (p) p.value = ''; })()")
    loc = await cdp.js('location.href'); body = await cdp.js("document.body.innerText") or ''
    shot('03c-view-after-resume')
    check('복귀 뒤 보존 또는 재로그인 → 보기 전용', 'MDrive.dc.html' in (loc or '') and '보기 전용' in body, {'분류': kind, 'url': loc})
    await asyncio.sleep(3)
    check('읽기 화면 왕복 중 조종권·비영 출력 자동 발생 없음(서버 status)', SRV['n'] > 0 and SRV['holders'] <= {None} and SRV['nonzero'] == 0,
          {'status 수': SRV['n'], '조종권자': sorted(map(str, SRV['holders'])), '비영 출력 횟수': SRV['nonzero']})
    # ── 로그아웃(버튼과 같은 요청을 페이지 문맥에서)
    st = await cdp.js("fetch('api/logout', {method: 'POST', credentials: 'same-origin'}).then((r) => r.status)")
    await asyncio.sleep(3)
    who2 = await cdp.js("fetch('api/whoami', {credentials: 'same-origin'}).then((r) => r.status)")
    check('로그아웃 200 → whoami 401', st == 200 and who2 == 401, [st, who2])
    check('관문 로그에 로그아웃', f'로그아웃 {USER}' in log('gate-A'))
    shot('04-after-logout')
    note('INFO', '로그아웃 뒤 화면 글(앞 300자)', await cdp.js("document.body.innerText.slice(0, 300)"))
    # ── 관문 끊김 → 앱 재시작 → 로컬 오류 화면
    need('관문 A 정상 종료(INT/TERM)', stop('gate-A')); adb('shell', 'am', 'force-stop', PKG); await asyncio.sleep(1)
    adb('shell', 'am', 'start', '-W', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8)
    await attach(cdp, 'offline'); loc3 = await cdp.js('location.href'); txt = await cdp.js("document.body.innerText")
    shot('05-gate-down-offline')
    check('관문 없음 → 로컬 보기 전용 오류 화면', loc3 == 'https://localhost/fh-offline.html' and '명령도 보내지 않습니다' in (txt or ''), loc3)
    check('오류 화면에 정지·STOPPED 단정 없음', txt is not None and 'STOPPED' not in txt and '정지했' not in txt)
    await wrong_ca(cdp)


# ── pause 범위(10-13 앱 Codex): 원격 A(쿠키 web 경로)에서 최신 React(--spa)를 띄워 HOME(실제 Activity pause) 1회 ─────────
# B1 앱 인증 경로(/api/app/*)는 쓰지 않는다. 실시뮬 아님(가짜 상태, domain 89) — body_still 등 몸 상태는 물리 정지 근거가 아니다.
PORTS = (GATE, LINK, DEV)                              # 이 실행이 쓰는 포트 — 시작 전 비어 있어야 한다(남의 것에 접속·정리하지 않음)
def sha(b): return hashlib.sha256(b).hexdigest()
def now(): return round(time.monotonic() - t0, 2)
def fin(x): return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
def row_ok(s):                                         # status 한 줄 형식: 누락·NaN·형식 이상을 0 으로 치지 않는다
    return (fin(s[0]) and isinstance(s[3], bool) and (s[1] is None or (isinstance(s[1], str) and s[1] != ''))
            and isinstance(s[2], list) and len(s[2]) == 3 and all(fin(x) for x in s[2]))
def nonzero(s): return row_ok(s) and any(abs(x) > 1e-9 for x in s[2])
def released(s): return row_ok(s) and s[1] is None and all(abs(x) <= 1e-9 for x in s[2]) and s[3] is True
def gaps(rows): return max((b[0] - a[0] for a, b in zip(rows, rows[1:])), default=None)


class QueryError(Exception): pass                     # 조회 실패(rc·시간초과·예외) — «없음»으로 읽지 않고 도구 오류로 멈춘다


def query(cmd, ok=(0,)):
    try: r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as e: raise QueryError(f'{Path(cmd[0]).name}: {type(e).__name__}')
    if r.returncode not in ok: raise QueryError(f'{Path(cmd[0]).name} rc={r.returncode}')
    return r.returncode, r.stdout


def adb_devices():
    out = query([ADB, 'devices'])[1].splitlines()
    if not out or not out[0].startswith('List of devices attached'): raise QueryError('adb devices 머리줄 없음')
    return [l.split()[0] for l in out[1:] if l.strip()]


def ports_open(ports, flags='-ltnH'):                 # ss 줄에서 지역 포트가 ports 인 줄
    return [l for l in query(['ss', flags])[1].splitlines() if l.split()[3:4] and l.split()[3].rsplit(':', 1)[-1] in {str(p) for p in ports}]


def tool_need(name, fn):                               # 조회 실패 = TOOL_ERROR 기록 후 멈춤(통과로 바꾸지 않음)
    try: ok, v = fn()
    except QueryError as e: note('TOOL_ERROR', name, str(e)); raise Abort
    need(name, ok, v)


def emu_absent():                                      # 시작 전: 남의 에뮬·기기에 붙지 않게 — adb 기기 0·qemu 프로세스 0·5554/5555 비어 있음
    devs = adb_devices()
    rc, out = query(['pgrep', '-f', 'qemu-system'], ok=(0, 1)); qemu = out.split() if rc == 0 else []   # pgrep rc 1 = 없음, 그 밖 = 조회 오류
    ports = sorted({int(l.split()[3].rsplit(':', 1)[-1]) for l in ports_open((5554, 5555))})
    return not devs and not qemu and not ports, {'adb 기기': devs, 'qemu pid': qemu, '포트': ports}


def emu_bound(root, avd):                               # 기동 뒤: 5554 를 연 프로세스가 이 러너가 띄운 에뮬(또는 그 자식)·AVD_HOME 이 이 회차 폴더·adb 기기는 emulator-5554 하나
    pids = sorted({int(m) for l in ports_open((5554,), '-ltnpH') for m in re.findall(r'pid=(\d+)', l)})
    def chain(p):
        seen = []
        while p > 1 and len(seen) < 20:
            seen.append(p)
            try: p = int(Path(f'/proc/{p}/stat').read_text().rsplit(')', 1)[1].split()[1])
            except (OSError, ValueError, IndexError): break
        return seen
    def avd_home(p):
        try: return next((e.split('=', 1)[1] for e in Path(f'/proc/{p}/environ').read_bytes().decode(errors='replace').split('\0') if e.startswith('ANDROID_AVD_HOME=')), None)
        except OSError: return None
    devs = adb_devices()
    v = {'5554 pid': pids, '띄운 pid': root, 'AVD_HOME': [avd_home(p) for p in pids], 'adb 기기': devs}
    return bool(pids) and all(root in chain(p) and avd_home(p) == str(avd) for p in pids) and devs == ['emulator-5554'], v


def listening():
    return sorted({int(l.split()[3].rsplit(':', 1)[-1]) for l in ports_open(PORTS)})


def prep_front():
    """UI_REV 하나에서: ① git archive → React 빌드 ② 같은 판 sim·tools ③ 관문 --web = dist 그대로 + --spa(그 판 v2_gate 에 있을 때만)."""
    global SRVD, WEB, SPA
    ok = bool(UI_REV and UI_MODULES) and subprocess.run(['git', '-C', str(REPO), 'cat-file', '-e', f'{UI_REV}^{{commit}}'], capture_output=True).returncode == 0
    need('pause 전제: FH_UI_REV 커밋·FH_UI_MODULES', ok and (Path(UI_MODULES) / '.bin/vite').exists(), UI_REV)
    rev = subprocess.run(['git', '-C', str(REPO), 'rev-parse', f'{UI_REV}^{{commit}}'], capture_output=True, text=True, check=True).stdout.strip()
    SRVD, ui = TMP / 'srv', TMP / 'ui'
    for d, parts in ((SRVD, ['sim', 'tools']), (ui, ['ui', 'contracts'])):
        d.mkdir(); tar = subprocess.run(['git', '-C', str(REPO), 'archive', rev, *parts], capture_output=True, check=True).stdout
        subprocess.run(['tar', '-x', '-C', str(d)], input=tar, check=True)
    SPA = "'--spa'" in (SRVD / 'sim/v2_gate.py').read_text()
    need('고정 판 관문에 --spa 있음', SPA)
    (ui / 'ui/node_modules').symlink_to(Path(UI_MODULES).resolve())
    with open(OUT / 'ui-build.log', 'w') as f:
        rc = subprocess.run(['npm', 'run', 'build'], cwd=ui / 'ui', env={**os.environ, 'PATH': f'{Path.home()}/.local/opt/node-v22.23.3-linux-x64/bin:' + os.environ['PATH']},
                            stdout=f, stderr=subprocess.STDOUT).returncode
    need('React 빌드(UI_REV git archive, npm run build)', rc == 0, f'rc={rc}')
    WEB = ui / 'ui/dist'
    served = {str(p.relative_to(WEB)): sha(p.read_bytes()) for p in sorted(WEB.rglob('*')) if p.is_file()}
    FRONT.update({'ui_rev': rev, 'build': 'git archive <ui_rev> ui contracts → npm run build (tsc --noEmit && vite build), node_modules 는 FH_UI_MODULES 링크',
                  'served_by': f'fixture v2_gate --web <dist 그대로> --spa={SPA} (쿠키 web 경로, 127.0.0.1:{GATE})', 'app_start_path': '/',
                  'not_used': '옛 .dc.html 로그인·조종 화면·app.html 개명 없음 · /api/app/*(B1) 없음', 'ros_domain': DOMAIN, 'server_rev': rev,
                  'server_files': {f: sha((SRVD / f).read_bytes()) for f in ('sim/v2_gate.py', 'sim/v2_link.py', 'tools/fake_v2_live.py')},
                  'served': served})
    (OUT / 'front-manifest.json').write_text(json.dumps(FRONT, ensure_ascii=False, indent=1))
    return WEB


async def until(fn, secs, step=0.25):                  # 이벤트 루프를 막지 않는 대기(observer 가 같은 루프에서 돈다)
    end = time.monotonic() + secs
    while time.monotonic() < end:
        if STAT and fn(STAT[-1]): return True
        await asyncio.sleep(step)
    return False


SRC_JS = """(async () => { const h = async (u) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch(u, {cache: 'no-store', credentials: 'same-origin'})).arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const mods = [...document.querySelectorAll('script[type=module][src]')].map((s) => new URL(s.src).pathname.slice(1));
  return {href: location.href, origin: location.origin, react_root: !!document.querySelector('#root > *'), live_js: !!document.querySelector('script[src*="live.js"]'),
    index_html: await h('index.html'), modules: Object.fromEntries(await Promise.all(mods.map(async (m) => [m, await h(m)])))}; })()"""
STICK_JS = """(() => { for (const k of ['앞뒤 막대', '이동 막대: 앞뒤와 옆걸음']) { const e = document.querySelector(`[aria-label="${k}"]`); if (!e) continue;
  const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return {k, x: r.left + r.width / 2, y: r.top + r.height * 0.15}; } return null; })()"""
BTN_JS = """((t) => { const b = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === t); if (!b) return false; b.click(); return true; })(%s)"""
VIEW_JS = """(() => { const t = document.body.innerText; return {href: location.href, ctl_hud: t.includes('직접 조종 · 시뮬 시험'), take_hint: t.includes('조종권 받기')}; })()"""
DRIVE = '#/MDrive'


async def touch(cdp, kind, x, y):
    r = await cdp.cmd('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [] if kind == 'touchEnd' else [{'x': x, 'y': y, 'id': 1}]})
    return 'error' not in r, r.get('error')


async def pause_scenario():
    cdp, G = Cdp(), f'https://127.0.0.1:{GATE}/'
    adb('reverse', f'tcp:{GATE}', f'tcp:{GATE}')
    adb('shell', 'am', 'start', '-W', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8)
    await attach(cdp, 'start')
    loc = await cdp.js('location.href')
    need('미인증 → React 로그인 화면(관문 /, WS 4401)', isinstance(loc, str) and loc.startswith(G + '#/MLogin'), loc)
    await cdp.js(f"location.replace('/{DRIVE}')"); await asyncio.sleep(5)          # 검사 도구 이동 ①: 조종 화면을 열면 앱이 next 를 달고 로그인으로
    loc = await cdp.js('location.href')
    need('조종 화면 요청 → React 로그인(next=#/MDrive)', isinstance(loc, str) and loc.startswith(G + '#/MLogin') and 'next=%23%2FMDrive' in loc, loc)
    r = await login(cdp); await asyncio.sleep(10)
    loc = await cdp.js('location.href')
    if not (isinstance(loc, str) and loc.endswith(DRIVE)):
        await cdp.js("(() => { const p = document.querySelector('#mpw'); if (p) p.value = ''; })()")
    need('fixture 로그인(React, 쿠키) → #/MDrive', r == 'clicked' and isinstance(loc, str) and loc == G + DRIVE and f'로그인 {USER}' in log('gate-A'), loc)
    src = await cdp.js(SRC_JS); FRONT['runtime'] = src; (OUT / 'front-manifest.json').write_text(json.dumps(FRONT, ensure_ascii=False, indent=1))
    sv = FRONT['served']
    need('시험 대상 = 관문에서 받은 React(origin·index.html·모듈 sha = 빌드, live.js 없음)', isinstance(src, dict) and src['origin'] == G[:-1]
         and src['index_html'] == sv['index.html'] and bool(src['modules']) and all(sv.get(k) == v for k, v in src['modules'].items()) and src['react_root'] and not src['live_js'],
         {k: src[k] for k in ('href', 'origin', 'react_root', 'live_js')} if isinstance(src, dict) else src)
    need(f'서버 status 의 ros_domain = {DOMAIN}', SRV.get('domains') == {DOMAIN}, sorted(map(str, SRV.get('domains', []))))
    note('INFO', '원격 페이지의 Capacitor 브리지(React MDrive)', await cdp.js(PROBE))
    stick = await cdp.js(STICK_JS); need('React 조종 화면 막대 위치', bool(stick), stick)
    await asyncio.sleep(1)                              # 버튼은 서버 status 로 다시 그려진 뒤에 누른다
    need('«조종권 받기» 누름', await cdp.js(BTN_JS % json.dumps('조종권 받기')))
    need('서버: 조종권자 = fixture 기기', await until(lambda s: row_ok(s) and USER in str(s[1]), 10), STAT[-1:])
    await asyncio.sleep(1)
    if STAT[-1][3] is True:                             # 잠겨 있을 때만 화면에 «STOP 해제»가 있다(새 링크는 처음에 안 잠김 — 모의 확인)
        need('«STOP 해제» 누름', await cdp.js(BTN_JS % json.dumps('STOP 해제')))
    else:
        note('INFO', '조종권 받은 뒤 이미 래치 없음 — «STOP 해제» 누르지 않음', STAT[-1:])
    need('서버: 래치 풀림(가짜 상태의 해제 확인)', await until(lambda s: row_ok(s) and s[3] is False and USER in str(s[1]), 10), STAT[-1:])
    # ── 손가락을 막대에 둔 채(touchEnd 없음) 비영 출력
    await asyncio.sleep(1); stick = await cdp.js(STICK_JS) or stick   # 안내 줄이 바뀐 뒤 위치 다시 잼
    x, y = stick['x'], stick['y']
    t_hold = now(); ok1, e1 = await touch(cdp, 'touchStart', x, y); await asyncio.sleep(0.2); ok2, e2 = await touch(cdp, 'touchMove', x, y - 2)
    nz = await until(lambda s: nonzero(s) and USER in str(s[1]), 5); await asyncio.sleep(2)
    need('잡은 채 비영 출력(서버 applied, 조종권자 fixture)', ok1 and ok2 and nz and nonzero(STAT[-1]) and USER in str(STAT[-1][1]),
         {'touch': [ok1, ok2, e1, e2], '잡은 뒤 비영 status 수': sum(nonzero(s) for s in STAT if s[0] >= t_hold), '마지막': STAT[-1:]})
    shot('p1-held')
    # ── HOME(손가락은 떼지 않음) → Activity pause
    n1, pid1 = len(caplog()), cdp.pid
    t_home = now(); adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await asyncio.sleep(6)
    shot('p2-background')
    cl = caplog()[n1:]
    paused = [l for l in cl if l.rstrip().endswith('App paused')]
    check('HOME: logcat 실제 Activity pause(Capacitor «App paused»)', bool(paused), paused[:2])
    after = [s for s in STAT if s[0] >= t_home]
    z = next((i for i, s in enumerate(after) if released(s)), None)
    tail = after[z:] if z is not None else []
    bad = [s for s in tail if not released(s)]
    check('HOME 뒤 서버: 조종권자 없음·applied 0·래치 — 그 뒤 위반(형식 이상 포함) 0', z is not None and not bad and len(tail) >= 5 and gaps(tail) <= 1.0,
          {'HOME→첫 해제(s)': None if z is None else round(after[z][0] - t_home, 2), 'HOME 뒤 status 수': len(after), '그 뒤 최대 간격(s)': gaps(tail),
           '위반': bad[:3], '형식 이상 수': sum(not row_ok(s) for s in after), '해제 전 비영 status 수': sum(nonzero(s) for s in after[:z or len(after)])})
    evs = [json.loads(l) for l in (OUT / 'link-events.jsonl').read_text().splitlines()]
    note('INFO', 'HOME 뒤 서버 사건(해제 원인 — 판정 아님)', [e for e in evs if e['t'] >= t_home - 0.5][:6])
    # ── 복귀
    n2 = len(caplog())
    adb('shell', 'am', 'start', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8)
    new = caplog()[n1:]
    recreated = any('App destroyed' in l for l in new) and any('Starting BridgeActivity' in l for l in new)
    await attach(cdp, 'resume'); t_back = now()
    ev = await cdp.js('window.__fh === undefined ? null : window.__fh'); loc2 = await cdp.js('location.href')
    page_sig = None if ev is None else [k for k, *_ in ev if k in ('App.pause', 'App.appStateChange:false', 'document.pause', 'visibilitychange', 'blur', 'pagehide')]
    note('INFO', 'HOME·복귀 신호', {'logcat App paused': len(paused), 'logcat App resumed(복귀)': sum(l.rstrip().endswith('App resumed') for l in caplog()[n2:]),
                                 '페이지 신호(PROBE)': page_sig if page_sig is not None else '미확인 — 페이지 다시 읽힘(기록 소실), logcat 만 근거',
                                 'Activity 재생성(logcat)': recreated, 'pid 전→후': [pid1, cdp.pid], 'url': loc2})
    if not (isinstance(loc2, str) and loc2 == G + DRIVE):
        note('INFO', '복귀 뒤 #/MDrive 아님 → 해시 이동만(조작·재로그인 없음)', loc2)
        await cdp.js(f"location.replace('/{DRIVE}')"); await asyncio.sleep(6); await attach(cdp, 'back-nav')
    v = await cdp.js(VIEW_JS); shot('p3-after-resume')
    check('복귀 = 보기 전용(조종 표시 없음·«조종권 받기» 안내)', isinstance(v, dict) and v['href'] == G + DRIVE and not v['ctl_hud'] and v['take_hint'], v)
    # ── 옛 손가락: 떼지 않았던 같은 id 로 움직임만(새 누름 없음). 전달 실패·새 WebView 면 판정 안 함
    t_f = now(); ok3, e3 = await touch(cdp, 'touchMove', x, y - 4); await asyncio.sleep(3); ok4, e4 = await touch(cdp, 'touchEnd', x, y)
    late = [s for s in STAT if s[0] >= t_back]
    check('복귀 뒤 서버 자동 복원 0(조종권자 없음·비영 0·래치, 형식 이상 포함)', len(late) >= 5 and all(released(s) for s in late) and gaps(late) <= 1.0,
          {'복귀 뒤 status 수': len(late), '최대 간격(s)': gaps(late), '위반': [s for s in late if not released(s)][:3]})
    fl = [s for s in STAT if s[0] >= t_f]
    if not ok3:
        note('TOOL_ERROR', '옛 손가락 touchMove 전달 실패 — 복원 0 근거로 세지 않음(미확인)', e3)
    elif recreated:
        note('UNVERIFIED', '옛 손가락: WebView 가 새로 만들어져 같은 id 손가락이 존재할 수 없음 — 복원 0 판정 안 함', {'touchMove 응답': 'ok', '그 뒤 status': len(fl)})
    else:
        check('옛 손가락(같은 id touchMove) 복원 0', len(fl) >= 5 and all(released(s) for s in fl), {'touchEnd': [ok4, e4], '그 뒤 status 수': len(fl)})
    need('관문 A 정상 종료(INT/TERM)', stop('gate-A'))


PAUSE_REQ = ['pause 전제: FH_UI_REV 커밋·FH_UI_MODULES', '고정 판 관문에 --spa 있음', 'React 빌드(UI_REV git archive, npm run build)', '포트 비어 있음(남의 프로세스 없음)',
             'APK 설치(180 s 안)', '미인증 → React 로그인 화면(관문 /, WS 4401)', '조종 화면 요청 → React 로그인(next=#/MDrive)', 'fixture 로그인(React, 쿠키) → #/MDrive',
             '시험 대상 = 관문에서 받은 React(origin·index.html·모듈 sha = 빌드, live.js 없음)', f'서버 status 의 ros_domain = {DOMAIN}', 'React 조종 화면 막대 위치',
             '«조종권 받기» 누름', '서버: 조종권자 = fixture 기기', '서버: 래치 풀림(가짜 상태의 해제 확인)', '잡은 채 비영 출력(서버 applied, 조종권자 fixture)',
             'HOME: logcat 실제 Activity pause(Capacitor «App paused»)', 'HOME 뒤 서버: 조종권자 없음·applied 0·래치 — 그 뒤 위반(형식 이상 포함) 0',
             '복귀 = 보기 전용(조종 표시 없음·«조종권 받기» 안내)', '복귀 뒤 서버 자동 복원 0(조종권자 없음·비영 0·래치, 형식 이상 포함)',
             '관문 A 정상 종료(INT/TERM)', '정리: 띄운 프로세스 INT/TERM 으로 모두 종료', '결과 폴더에 비밀번호 없음']
# 옛 손가락은 필수 목록에 넣지 않는다: 같은 WebView·전달 성공일 때만 PASS/FAIL, 아니면 TOOL_ERROR(실패로 셈)·UNVERIFIED 로 따로 보고

FX_CA = MOB / 'android/app/src/fixture/res/raw/fh_fixture_ca.pem'   # gate-profile.mjs --fixture 생성물(git 제외) — 빌드 뒤 지운다
APP = 'https://localhost'
NATIVE_JS = """(async () => { const P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FhGate; if (!P) return {err: 'no-plugin'};
  try { return await (%s); } catch (e) { return {err: e && e.code, msg: e && e.message, gen: e && e.data && e.data.gen}; } })()"""
CHANGE_JS = """((o) => { window.prompt = () => o; const b = [...document.querySelectorAll('a,[role=button]')].find((e) => e.textContent.trim() === '바꾸기');
  if (!b) return false; b.click(); return true; })(%s)"""
JSSTORE_JS = """(() => ({cookie: document.cookie, local: Object.keys(localStorage), session: Object.keys(sessionStorage)}))()"""


def apk_provenance(apk):                                # 실제 APK 안 설정·자원·번들 sha(출처 확인 runs/mobile-b-fixture-check-20261013-3 과 같은 항목)
    import zipfile
    aapt = str(SDK / 'build-tools/36.0.0/aapt2')
    man = subprocess.run([aapt, 'dump', 'xmltree', '--file', 'AndroidManifest.xml', str(apk)], capture_output=True, text=True).stdout
    nsc = subprocess.run([aapt, 'dump', 'xmltree', '--file', 'res/xml/fh_fixture_network_security.xml', str(apk)], capture_output=True, text=True).stdout
    z = zipfile.ZipFile(apk); src = json.loads(z.read('assets/public/SOURCE.json'))
    cfg = json.loads(z.read('assets/capacitor.config.json'))
    raw = [n for n in z.namelist() if n.startswith('res/raw/')]
    bad = [f for f, v in src['files'].items() if sha(z.read('assets/public/' + f)) != v]
    v = {'pkg': subprocess.run([aapt, 'dump', 'packagename', str(apk)], capture_output=True, text=True).stdout.strip(), 'raw': raw,
         'ca_sha': sha(z.read(raw[0])) if raw else None, 'server': cfg.get('server'), 'logging': (cfg.get('android') or {}).get('loggingBehavior'), 'ui_rev': src.get('ui_rev'), 'files': len(src['files']), 'mismatch': bad[:5]}
    ok = (v['pkg'] == PKG and 'networkSecurityConfig' in man and 'android:debuggable(0x0101000f)=true' in man and 'debug-overrides' in nsc and '"user"' not in nsc
          and raw == ['res/raw/fh_fixture_ca.pem'] and v['ca_sha'] == sha((TMP / 'A' / 'ca.crt').read_bytes()) and not (cfg.get('server') or {}).get('url')
          and z.read('assets/public/SOURCE.json') == (MOB / 'www/SOURCE.json').read_bytes() and src.get('ui_rev') == FRONT.get('ui_rev') and src['files'] and not bad)
    return ok, v


async def native(cdp, expr): return await cdp.js(NATIVE_JS % expr)


async def bundled_scenario():                           # B0~B8 (계획서 2절). 단계 실패 = need 로 그 자리 종료
    cdp, G = Cdp(), f'https://127.0.0.1:{GATE}'
    adb('reverse', f'tcp:{GATE}', f'tcp:{GATE}')
    adb('shell', 'am', 'start', '-W', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8)
    await attach(cdp, 'start')
    # B0 첫 기동: 관문 주소 없음 → 앱 출처의 로그인 화면 + 주소 안내, 관문 요청 0
    loc = await cdp.js('location.href'); txt = await cdp.js('document.body.innerText') or ''
    need('B0 첫 기동: 앱 출처 https://localhost 의 #/MLogin + «관문 주소를 먼저 정하세요» · 관문 /api/app 요청 0',
         isinstance(loc, str) and loc.startswith(APP + '/#/MLogin') and '관문 주소를 먼저 정하세요' in txt and '/api/app/' not in log('gate-A'), loc)
    # B1 «바꾸기»(화면 전송층 setGate — prompt 만 검사 도구가 대신 답함)
    need('B1 «바꾸기» 누름', await cdp.js(CHANGE_JS % json.dumps(G))); await asyncio.sleep(3)
    st = await native(cdp, 'P.state()')
    need('B1 관문 주소 설정: state.origin = fixture 관문 · 로그인 전', isinstance(st, dict) and st.get('origin') == G and st.get('loggedIn') is False, st)
    # B2 로그인(화면 → 네이티브 login → /api/app/login). 성공 뒤 화면이 next 로 다시 읽힌다
    r = await login(cdp); await asyncio.sleep(10); await attach(cdp, 'after-login')
    loc = await cdp.js('location.href'); st = await native(cdp, 'P.state()')
    need('B2 fixture 로그인(네이티브, 앱 출처) → 로그인 화면 벗어남 · state.loggedIn',
         r == 'clicked' and f'앱 로그인 {USER}' in log('gate-A') and isinstance(loc, str) and loc.startswith(APP + '/#/') and '#/MLogin' not in loc
         and isinstance(st, dict) and st.get('loggedIn') is True, {'href': loc, 'state': {k: st.get(k) for k in ('loggedIn', 'stored', 'gen')} if isinstance(st, dict) else st})
    note('INFO', 'B2 Origin 근거 범위: 관문 app_auth.ORIGINS 정확 일치(고정 판 sha) + 로그인 성공 — 보낸 헤더 원값을 패킷으로 읽은 것 아님', FRONT.get('server_files'))
    js = await cdp.js(JSSTORE_JS)
    check('B2 앱 출처 JS 쿠키 0', isinstance(js, dict) and js.get('cookie') == '', js)
    note('INFO', 'B2 JS 저장소 키 목록(토큰 부재는 계약·코드 근거 — 값 검색 실측 아님)', js)
    # B3 강제 종료 → 다시 기동: 재로그인 없이 보관 세션 복원(정상 경로만)
    adb('shell', 'am', 'force-stop', PKG); await asyncio.sleep(2)
    g0, t_re = len(log('gate-A')), now()               # B4 판정 구간 = 이 재시작 뒤 관문 로그·status
    adb('shell', 'am', 'start', '-W', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8); await attach(cdp, 'restart')
    st = await native(cdp, 'P.state()'); who = await native(cdp, "P.request({op: 'whoami'})")
    need('B3 force-stop 뒤 Keystore 복원(정상 경로): loggedIn·stored · whoami 200',
         isinstance(st, dict) and st.get('loggedIn') is True and st.get('stored') is True and isinstance(who, dict) and who.get('status') == 200,
         {'state': {k: st.get(k) for k in ('loggedIn', 'stored', 'gen')} if isinstance(st, dict) else st, 'whoami': (who or {}).get('status', who)})
    # B4 조종 화면 → 1회용 표 → /api/app/ws
    await cdp.js("location.hash = '#/MDrive'"); await asyncio.sleep(6)
    ga = log('gate-A'); g = ga[g0:]                    # 재시작 뒤 구간만(재시작 전 연결을 B4 근거로 쓰지 않음)
    tick, ws_ok = len(re.findall(r'^200 POST /api/app/ws-ticket ', g, re.M)), len(re.findall(r'^101 GET /api/app/ws ', g, re.M))
    # 같은 표 재사용은 101 뒤 open() 에서 «거부(로그인 없음)» + 4401 로 끊긴다(접근 로그는 101) → 거부 줄 0 + 표 수 ≥ 101 수로 본다(루프백 확인 10-13)
    ws_bad = re.findall(r'^[45]\d\d GET /api/app/ws\b.*', g, re.M) + [l for l in g.splitlines() if '거부(' in l]
    need('B4 조종 화면 WS: 표 발급 → 관문 /api/app/ws 연결(관문 로그에 표 원값 없음)',
         tick >= 1 and ws_ok >= 1 and not ws_bad and tick >= ws_ok and f'연결 {USER}' in g and '?t=' not in ga,
         {'재시작 뒤 ws-ticket 200': tick, 'ws 101': ws_ok, 'ws 거부·4xx/5xx': ws_bad[:3], '연결 로그': f'연결 {USER}' in g,
          '재시작 뒤 서버 status 수': sum(1 for s in STAT if s[0] >= t_re)})
    note('INFO', 'B4 근거 범위: 앱이 받은 status 는 직접 안 읽음 — 앱 WS 동작은 B5 take(앱 → 관문 → 서버 holder)로 확인', '')
    need(f'서버 status 의 ros_domain = {DOMAIN}', SRV.get('domains') == {DOMAIN}, sorted(map(str, SRV.get('domains', []))))
    note('INFO', '앱 Capacitor 브리지(bundled MDrive)', await cdp.js(PROBE))
    stick = await cdp.js(STICK_JS); need('React 조종 화면 막대 위치', bool(stick), stick)
    # B5 take → 잡은 채 비영
    await asyncio.sleep(1)
    need('«조종권 받기» 누름', await cdp.js(BTN_JS % json.dumps('조종권 받기')))
    need('서버: 조종권자 = fixture 기기', await until(lambda s: row_ok(s) and USER in str(s[1]), 10), STAT[-1:])
    await asyncio.sleep(1)
    if STAT[-1][3] is True: need('«STOP 해제» 누름', await cdp.js(BTN_JS % json.dumps('STOP 해제')))
    else: note('INFO', '조종권 받은 뒤 이미 래치 없음 — «STOP 해제» 누르지 않음', STAT[-1:])
    need('서버: 래치 풀림(가짜 상태의 해제 확인)', await until(lambda s: row_ok(s) and s[3] is False and USER in str(s[1]), 10), STAT[-1:])
    await asyncio.sleep(1); stick = await cdp.js(STICK_JS) or stick
    x, y = stick['x'], stick['y']
    t_hold = now(); ok1, e1 = await touch(cdp, 'touchStart', x, y); await asyncio.sleep(0.2); ok2, e2 = await touch(cdp, 'touchMove', x, y - 2)
    nz = await until(lambda s: nonzero(s) and USER in str(s[1]), 5); await asyncio.sleep(2)
    need('B5 잡은 채 비영 출력(서버 applied, 조종권자 fixture)', ok1 and ok2 and nz and nonzero(STAT[-1]) and USER in str(STAT[-1][1]),
         {'touch': [ok1, ok2, e1, e2], '잡은 뒤 비영 status 수': sum(nonzero(s) for s in STAT if s[0] >= t_hold), '마지막': STAT[-1:]})
    shot('b5-held')
    # B6 HOME(손가락 떼지 않음)
    # 10-13 뒤 android.loggingBehavior=none → Capacitor «App paused» 로그 없음. 대체 관측(사전 명시, 둘 다 필수):
    #  ① OS: events 버퍼 wm_on_paused_called 의 이 앱 Activity(구성요소 이름뿐, 비밀 없음) — HOME 전후 건수 증가
    #  ② 페이지: B4 의 PROBE 가 붙인 Plugins.App pause·appStateChange(false) 를 페이지 메모리(window.__fh)에서 복귀 뒤 읽음(콘솔 안 씀).
    #     복귀 때 페이지가 다시 읽히면 기록이 사라져 FAIL(약해진 관측 — 대신 쓰지 않음)
    n1 = len(ospause()); t_home = now(); adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await asyncio.sleep(6); shot('b6-background')
    paused = ospause()[n1:]
    check('HOME: OS Activity pause(events wm_on_paused_called, 이 앱)', bool(paused), paused[:2])
    after = [s for s in STAT if s[0] >= t_home]
    z = next((i for i, s in enumerate(after) if released(s)), None); tail = after[z:] if z is not None else []; bad = [s for s in tail if not released(s)]
    check('HOME 뒤 서버: 조종권자 없음·applied 0·래치 — 그 뒤 위반(형식 이상 포함) 0', z is not None and not bad and len(tail) >= 5 and gaps(tail) <= 1.0,
          {'HOME→첫 해제(s)': None if z is None else round(after[z][0] - t_home, 2), 'HOME 뒤 status 수': len(after), '그 뒤 최대 간격(s)': gaps(tail),
           '위반': bad[:3], '형식 이상 수': sum(not row_ok(s) for s in after), '해제 전 비영 status 수': sum(nonzero(s) for s in after[:z or len(after)])})
    evs = [json.loads(l) for l in (OUT / 'link-events.jsonl').read_text().splitlines()]
    note('INFO', 'HOME 뒤 서버 사건(해제 원인 — 판정 아님)', [e for e in evs if e['t'] >= t_home - 0.5][:6])
    await touch(cdp, 'touchEnd', x, y)                   # 손가락 정리(옛 손가락 판정은 이 범위 밖)
    # B7 복귀 = 보기 전용, 서버 자동 복원 0
    adb('shell', 'am', 'start', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8); await attach(cdp, 'resume'); t_back = now()
    ev = await cdp.js('window.__fh || null')           # 해시 이동 전에 읽는다
    sig = None if ev is None else [k for k, *_ in ev if k in ('App.pause', 'App.appStateChange:false')]
    check('HOME: 페이지 App pause·appStateChange(false)(PROBE 메모리)', bool(sig), sig if ev is not None else '페이지 다시 읽힘 — 기록 없음')
    loc2 = await cdp.js('location.href')
    if not (isinstance(loc2, str) and loc2.endswith(DRIVE)):
        note('INFO', '복귀 뒤 #/MDrive 아님 → 해시 이동만(조작·재로그인 없음)', loc2)
        await cdp.js(f"location.hash = '{DRIVE}'"); await asyncio.sleep(6)
    v = await cdp.js(VIEW_JS); shot('b7-after-resume'); await asyncio.sleep(4)
    check('복귀 = 보기 전용(조종 표시 없음·«조종권 받기» 안내)', isinstance(v, dict) and v['href'] == APP + '/' + DRIVE and not v['ctl_hud'] and v['take_hint'], v)
    late = [s for s in STAT if s[0] >= t_back]
    check('복귀 뒤 서버 자동 복원 0(조종권자 없음·비영 0·래치, 형식 이상 포함)', len(late) >= 5 and all(released(s) for s in late) and gaps(late) <= 1.0,
          {'복귀 뒤 status 수': len(late), '최대 간격(s)': gaps(late), '위반': [s for s in late if not released(s)][:3]})
    # B8 로그아웃(네이티브 호출 — 화면 버튼 경로는 이 범위 밖) → 서버 ok → 다시 기동하면 로그인 화면
    lo = await cdp.js(NATIVE_JS % """new Promise((res) => { let out = {}; P.addListener('logoutResult', (v) => { out.ev = v; if (out.r) res(out); });
      P.logout({reason: 'user'}).then((r) => { out.r = r; if (out.ev) res(out); setTimeout(() => res(out), 8000); }, (e) => res({err: e && e.code})); })""")
    adb('shell', 'am', 'force-stop', PKG); await asyncio.sleep(2)
    adb('shell', 'am', 'start', '-W', '-n', f'{PKG}/{ACT}'); await asyncio.sleep(8); await attach(cdp, 'after-logout')
    loc3 = await cdp.js('location.href'); st = await native(cdp, 'P.state()')
    need('B8 로그아웃: ok·서버 ok·관문 로그 · 다시 기동하면 로그인 화면(보관본 없음)',
         isinstance(lo, dict) and (lo.get('r') or {}).get('ok') is True and (lo.get('ev') or {}).get('server') == 'ok' and '200 POST /api/app/logout' in log('gate-A')
         and isinstance(loc3, str) and loc3.startswith(APP + '/#/MLogin') and isinstance(st, dict) and st.get('loggedIn') is False,
         {'logout': lo, 'href': loc3, 'state': {k: st.get(k) for k in ('loggedIn', 'stored', 'origin')} if isinstance(st, dict) else st})
    need('관문 A 정상 종료(INT/TERM)', stop('gate-A'))


BUNDLED_REQ = ['pause 전제: FH_UI_REV 커밋·FH_UI_MODULES', '고정 판 관문에 --spa 있음', 'React 빌드(UI_REV git archive, npm run build)', '포트 비어 있음(남의 프로세스 없음)',
               'fixture APK 출처(앱 id·NSC·CA 한 장·server.url 없음·번들 = UI 판)', 'APK 설치(180 s 안)',
               'B0 첫 기동: 앱 출처 https://localhost 의 #/MLogin + «관문 주소를 먼저 정하세요» · 관문 /api/app 요청 0', 'B1 «바꾸기» 누름',
               'B1 관문 주소 설정: state.origin = fixture 관문 · 로그인 전', 'B2 fixture 로그인(네이티브, 앱 출처) → 로그인 화면 벗어남 · state.loggedIn', 'B2 앱 출처 JS 쿠키 0',
               'B3 force-stop 뒤 Keystore 복원(정상 경로): loggedIn·stored · whoami 200', 'B4 조종 화면 WS: 표 발급 → 관문 /api/app/ws 연결(관문 로그에 표 원값 없음)',
               f'서버 status 의 ros_domain = {DOMAIN}', 'React 조종 화면 막대 위치', '«조종권 받기» 누름', '서버: 조종권자 = fixture 기기', '서버: 래치 풀림(가짜 상태의 해제 확인)',
               'B5 잡은 채 비영 출력(서버 applied, 조종권자 fixture)', 'HOME: OS Activity pause(events wm_on_paused_called, 이 앱)',
               'HOME: 페이지 App pause·appStateChange(false)(PROBE 메모리)', 'HOME 뒤 서버: 조종권자 없음·applied 0·래치 — 그 뒤 위반(형식 이상 포함) 0', '복귀 = 보기 전용(조종 표시 없음·«조종권 받기» 안내)',
               '복귀 뒤 서버 자동 복원 0(조종권자 없음·비영 0·래치, 형식 이상 포함)', 'B8 로그아웃: ok·서버 ok·관문 로그 · 다시 기동하면 로그인 화면(보관본 없음)',
               '관문 A 정상 종료(INT/TERM)', '정리: 띄운 프로세스 INT/TERM 으로 모두 종료', '결과 폴더에 비밀번호 없음',
               '에뮬 시작 전: adb 기기 0·qemu 0·5554/5555 비어 있음(남의 에뮬 없음)', '에뮬 결속: 5554 = 이 러너가 띄운 에뮬·AVD_HOME = 이 회차·adb 기기 하나',
               'fixture APK 설정: android.loggingBehavior = none']

SCOPE = os.environ.get('FH_E2E_SCOPE', 'full')     # full = 전체 시나리오, ssl = A 로그인·읽기 → B 인증서 거부만, pause = 원격 React native pause 1회
REQUIRED = ['미인증 → 관문 로그인 화면', 'fixture 로그인 → 읽기 화면', '읽기 화면 WS 가 관문을 거쳐 v2_link 에 연결', '세션 쿠키로 whoami 200',
            '복귀 뒤 보존 또는 재로그인 → 보기 전용', '읽기 화면 왕복 중 조종권·비영 출력 자동 발생 없음(서버 status)', '로그아웃 200 → whoami 401', '관문 로그에 로그아웃', '관문 A 정상 종료(INT/TERM)',
            '관문 없음 → 로컬 보기 전용 오류 화면', '오류 화면에 정지·STOPPED 단정 없음', 'B: 관문 B 기동', 'B: 앱 쪽 인증서 거부 로그(Trust anchor 또는 -202)', 'B: 관문 B 에 로그인·WS 연결 0', 'B: 로컬 연결 오류 안내 화면(로그인·명령 불가)',
            '정리: 띄운 프로세스 INT/TERM 으로 모두 종료', '결과 폴더에 비밀번호 없음', 'APK 설치(180 s 안)']


def main():
    # 10-13 1차: 실행 중 PC 부하 평균 27~33(12코어) → 에뮬 vCPU 15 s 멈춤 → 설치 180 s 초과로 시나리오 미실행.
    # 고친 전제: 시작 전·설치 전 부하 확인, 에뮬 2코어·2 GB, 부팅 완료·패키지 관리자 준비 확인 뒤에만 설치(시한은 그대로 180 s)
    thr = os.cpu_count() / 2
    if os.getloadavg()[0] > thr:
        TMP.rmdir(); sys.exit(f'PC 부하 {os.getloadavg()[0]:.1f} > {thr} — 다른 무거운 작업이 끝난 뒤 실행')
    os.chmod(TMP, 0o700)
    try:
        for s in ('A', 'B'): (TMP / s).mkdir(mode=0o700)
        fp_a, fp_b = make_state(TMP / 'A'), make_state(TMP / 'B'); note('INFO', 'fixture CA sha256', {'A(APK 에 넣음)': fp_a, 'B(거부 시험)': fp_b})
        nodeenv = {**os.environ, 'PATH': f'{Path.home()}/.local/opt/node-v22.23.3-linux-x64/bin:' + os.environ['PATH'],
                   'JAVA_HOME': '/usr/lib/jvm/java-21-openjdk-amd64', 'ANDROID_HOME': str(SDK)}
        steps = ((['npx', 'cap', 'sync', 'android'], MOB),
                             (['node', 'scripts/gate-profile.mjs'], MOB),
                 (['./gradlew', 'assembleGate', '--console=plain'], MOB / 'android'))
        if SCOPE == 'pause':                           # APK 안 번들(www)도 같은 판으로 — A 에선 로드되지 않지만 «어느 본문인지» 섞이지 않게
            steps = ((['node', 'scripts/sync-web.mjs', str(prep_front())], MOB),) + steps
        if BUNDLED:                                    # 앱 안 번들 = 그 UI 판, 설정은 main(bundled) 그대로, CA 한 장만 생성 → fixture 빌드
            steps = ((['node', 'scripts/sync-web.mjs', str(prep_front())], MOB), (['npx', 'cap', 'sync', 'android'], MOB),
                     (['node', 'scripts/gate-profile.mjs', '--fixture'], MOB), (['./gradlew', 'assembleFixture', '--console=plain'], MOB / 'android'))
            FRONT.update({'served_by': f'fixture v2_gate(--web dist --spa 는 켜 두지만 앱은 자기 번들을 씀) · /api/app/* 네이티브 FhGate (127.0.0.1:{GATE})',
                          'app_start_path': 'https://localhost/ (APK 안 번들)', 'not_used': '쿠키 web 경로·server.url·A 원물', 'scope': 'bundled-b'})
        with open(OUT / 'build.log', 'w') as f:
            for cmd, cwd in steps:
                env = {**nodeenv, 'FH_UI_REV': FRONT.get('ui_rev', ''), **({'FH_GATE_START': '/'} if SCOPE == 'pause' else {}), 'FH_GATE_URL': f'https://127.0.0.1:{GATE}', 'FH_GATE_CA': str(TMP / 'A' / 'ca.crt')}
                rc = subprocess.run(cmd, cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT).returncode
                need(f'빌드 {cmd[-1] if cmd[0] != "npx" else "cap sync"}', rc == 0, f'rc={rc}')
        if SCOPE == 'pause':
            FRONT['apk_bundled_www'] = {**{k: v for k, v in json.loads((MOB / 'www/SOURCE.json').read_text()).items() if k != 'files'},
                                        '로드 여부': 'A(server.url) 에선 로드 안 됨 — 시험 대상은 runtime.origin 의 원격 app.html'}
            (OUT / 'front-manifest.json').write_text(json.dumps(FRONT, ensure_ascii=False, indent=1))
        if BUNDLED:
            FX_CA.unlink(missing_ok=True)              # 생성 CA 는 APK 안에만(결과에는 sha)
            shutil.copy2(MOB / 'android/app/build/outputs/apk/fixture/app-fixture.apk', OUT / 'app-gate.apk')   # 설치 단계 이름 공용
            ok, v = apk_provenance(OUT / 'app-gate.apk'); FRONT['apk'] = {**v, 'sha256': sha((OUT / 'app-gate.apk').read_bytes())}
            (OUT / 'front-manifest.json').write_text(json.dumps(FRONT, ensure_ascii=False, indent=1))
            need('fixture APK 출처(앱 id·NSC·CA 한 장·server.url 없음·번들 = UI 판)', ok, v)
            need('fixture APK 설정: android.loggingBehavior = none', v['logging'] == 'none', v['logging'])
        else:
            shutil.copy2(MOB / 'android/app/build/outputs/apk/gate/app-gate.apk', OUT / 'app-gate.apk')
            shutil.copy2(MOB / 'android/app/src/gate/assets/capacitor.config.json', OUT / 'gate-capacitor.config.json')
        if SCOPE in ('pause', 'bundled'):
            tool_need('포트 비어 있음(남의 프로세스 없음)', lambda: (lambda b: (not b, b))(listening()))
            tool_need('에뮬 시작 전: adb 기기 0·qemu 0·5554/5555 비어 있음(남의 에뮬 없음)', emu_absent)
        start('v2_link', ['bash', '-c', f'source /opt/ros/jazzy/setup.bash && exec python3 -B sim/v2_link.py --port {LINK} --media {TMP}/media'], env=ENV_ROS)
        start('fake_v2_live', ['bash', '-c', 'source /opt/ros/jazzy/setup.bash && exec python3 -B tools/fake_v2_live.py'], env=ENV_ROS)
        time.sleep(6)
        need('fixture 관문 기동(127.0.0.1)', gate(TMP / 'A', 'gate-A'))
        need('에뮬 시작 전 PC 부하 ≤ 코어/2', wait_until(lambda: os.getloadavg()[0] <= thr, 180, 5), round(os.getloadavg()[0], 1))
        avd = TMP / 'avd'; avd.mkdir(); emuenv = {**os.environ, 'ANDROID_AVD_HOME': str(avd), 'ANDROID_SDK_ROOT': str(SDK), 'JAVA_HOME': nodeenv['JAVA_HOME']}
        subprocess.run([AVDM, 'create', 'avd', '-n', 'fh-a-e2e', '-k', IMG, '-d', 'pixel_6'], input='no\n', text=True, env=emuenv, capture_output=True, check=True)
        start('emulator', [EMU, '-avd', 'fh-a-e2e', '-no-window', '-no-snapshot', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-cores', '2', '-memory', '2048'], env=emuenv)
        try: subprocess.run([ADB, '-s', 'emulator-5554', 'wait-for-device'], timeout=300, check=True); dev = True
        except subprocess.TimeoutExpired: dev = False
        need('에뮬 adb 연결(300 s 안)', dev)
        if SCOPE in ('pause', 'bundled'): tool_need('에뮬 결속: 5554 = 이 러너가 띄운 에뮬·AVD_HOME = 이 회차·adb 기기 하나', lambda: emu_bound(procs['emulator'].pid, avd))
        need('부팅 완료 sys.boot_completed=1 (360 s 안)', wait_until(lambda: adb('shell', 'getprop', 'sys.boot_completed', check_=False, timeout=30).strip() == '1', 360))
        need('패키지 관리자 준비 pm path android (240 s 안)', wait_until(lambda: adb('shell', 'pm', 'path', 'android', check_=False, timeout=30).startswith('package:'), 240))
        time.sleep(20)
        need('설치 전 PC 부하 ≤ 코어/2', wait_until(lambda: os.getloadavg()[0] <= thr, 180, 5), round(os.getloadavg()[0], 1))
        out = adb('install', '-r', str(OUT / 'app-gate.apk'), check_=False, timeout=180)
        need('APK 설치(180 s 안)', 'Success' in out, out.strip()[-200:])
        stop_evt = asyncio.Event()

        async def run():
            obs = asyncio.ensure_future(observer(stop_evt))
            try: await (pause_scenario() if SCOPE == 'pause' else bundled_scenario() if BUNDLED else scenario())
            finally: stop_evt.set(); await obs
        asyncio.run(run())
    except Abort:
        pass                                            # 이미 FAIL 로 기록됨 — 다음 단계로 넘어가지 않음
    except BaseException as e:
        note('FAIL', '예외', repr(e)[:300])
    finally:
        FX_CA.unlink(missing_ok=True)                   # 빌드 중 실패해도 생성 CA 를 남기지 않는다
        try: (OUT / 'logcat.txt').write_text(adb('logcat', '-d', '-v', 'time', 'Capacitor:V', 'Capacitor/Console:V', 'chromium:V', 'cr_X509Util:V', '*:S', check_=False, timeout=30))
        except Exception as e: note('INFO', 'logcat 못 받음', repr(e)[:120])
        subprocess.run([ADB, '-s', 'emulator-5554', 'emu', 'kill'], capture_output=True, timeout=30)
        left = [n for n in ('emulator', 'gate-A', 'gate-B', 'fake_v2_live', 'v2_link') if not stop(n)]
        check('정리: 띄운 프로세스 INT/TERM 으로 모두 종료', not left, {n: procs[n].pid for n in left})
        subprocess.run([ADB, 'forward', '--remove', f'tcp:{DEV}'], capture_output=True)
        leak = [p.name for p in OUT.iterdir() if p.is_file() and PW.encode() in p.read_bytes()]
        check('결과 폴더에 비밀번호 없음', not leak, leak)
        if left: note('INFO', '정리 미완료 — 임시 원물 보존(개인키·계정·AVD)', str(TMP))
        else: shutil.rmtree(TMP)                        # fixture 개인키·계정·AVD 삭제(CA 지문만 결과에 남김)
        note('INFO', '서버 status 전체', {'수': SRV['n'], '조종권자': sorted(map(str, SRV['holders'])), '비영 출력 횟수': SRV['nonzero']})
        passed = {r['name'] for r in RES if r['kind'] == 'PASS'}
        (OUT / 'link-status.jsonl').write_text(''.join(json.dumps(x, ensure_ascii=False) + '\n' for x in STAT))
        req = REQUIRED if SCOPE == 'full' else PAUSE_REQ if SCOPE == 'pause' else BUNDLED_REQ if BUNDLED else [n for n in REQUIRED if n.startswith(('B:', 'APK', '미인증', 'fixture 로그인', '읽기 화면 WS', '세션 쿠키', '관문 A 정상', '정리', '결과 폴더'))]
        note('INFO', '실행 범위', {'scope': SCOPE, '필수 항목 수': len(req)})
        miss = [n for n in req if n not in passed]
        check('필수 성공 항목 전부 PASS', not miss, miss)
        (OUT / 'results.json').write_text(json.dumps(RES, ensure_ascii=False, indent=1))
        fails = sum(r['kind'] in ('FAIL', 'TOOL_ERROR') for r in RES)
        print('FAIL 수', fails, '· PASS 수', sum(r['kind'] == 'PASS' for r in RES), flush=True)
        sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()

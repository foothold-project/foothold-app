#!/usr/bin/env python3
"""A 연결(관문 주소 로드) 개발 프로필 — fixture 관문 + 가짜 상태(domain 88) + Android 에뮬레이터 1회 읽기 검증.

운영 관문(8453)·운영 v2_link(8792)·실계정(.gate)·실시뮬은 쓰지 않는다. 조종권을 받지 않는다(읽기 검증만).
- fixture 상태 폴더 2개(A: 이 APK 에 넣는 CA, B: 다른 CA)를 임시로 만든다. 계정·비밀번호는 메모리에서만 만들고 기록하지 않는다.
- 같은 v2_gate 코드(sim/v2_gate.py)를 127.0.0.1:18453 에만 띄우고, 에뮬레이터는 adb reverse 로 붙인다(공개 포트 없음).
- v2_link 는 127.0.0.1:18790 · domain 88, 상태는 tools/fake_v2_live.py(실제 시뮬 아님).
순서: 런처 → 앱(미인증 로그인 화면) → fixture 로그인 → 읽기 화면·WS → 배경·복귀(이벤트 실측) → 로그아웃 → 관문 끊김(오류 화면) → 다른 CA(거부).
사용(mobile 폴더): FH_GATE_SRC=<phone_gate.py 폴더> TMPDIR=<임시> python3 -B scripts/gate-emulator-e2e.py <결과 폴더(없어야 함)>
"""
import asyncio, json, os, secrets, shutil, signal, subprocess, sys, tempfile, time, urllib.request
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
PKG, ACT = 'org.footholdproject.app.gate', 'org.footholdproject.app.MainActivity'
TMP = Path(tempfile.mkdtemp(prefix='fh-a-e2e-'))
USER, PW = 'e2e', secrets.token_urlsafe(16)          # 기록·출력 금지
RES, procs, t0 = [], {}, time.monotonic()
SRV = {'n': 0, 'holders': set(), 'nonzero': 0}            # observer 가 본 status: 조종권자·비영 출력 횟수
ENV_ROS = {**os.environ, 'ROS_DOMAIN_ID': '88', 'ROS_AUTOMATIC_DISCOVERY_RANGE': 'LOCALHOST', 'PYTHONDONTWRITEBYTECODE': '1'}


def note(kind, name, detail=''):
    RES.append({'t': round(time.monotonic() - t0, 1), 'kind': kind, 'name': name, 'detail': detail})
    print(f'[{RES[-1]["t"]:7.1f}] {kind:5} {name} {detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)}'[:400], flush=True)


def check(name, ok, detail=''): note('PASS' if ok else 'FAIL', name, detail)


def adb(*a, check_=True, timeout=60):
    return subprocess.run([ADB, '-s', 'emulator-5554', *a], capture_output=True, text=True, check=check_, timeout=timeout).stdout


def shot(name): (OUT / f'{name}.png').write_bytes(subprocess.run([ADB, '-s', 'emulator-5554', 'exec-out', 'screencap', '-p'], capture_output=True, check=True).stdout)


def start(name, cmd, env=None, cwd=REPO):
    f = open(OUT / f'{name}.log', 'w')
    procs[name] = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT, env=env, cwd=cwd, start_new_session=True)


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


def gate(state, name):
    start(name, [sys.executable, '-B', 'sim/v2_gate.py', '--bind', '127.0.0.1', '--port', str(GATE), '--upstream', f'127.0.0.1:{LINK}',
                   '--gate-src', str(GATE_SRC), '--state', str(state)], env=ENV_ROS)
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

    async def js(self, expr):
        self.n += 1; me = self.n
        await self.ws.write_message(json.dumps({'id': me, 'method': 'Runtime.evaluate', 'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True}}))
        while True:
            r = json.loads(await self.ws.read_message())
            if r.get('id') == me: return r.get('result', {}).get('result', {}).get('value')


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


SCOPE = os.environ.get('FH_E2E_SCOPE', 'full')     # full = 전체 시나리오, ssl = A 로그인·읽기 → B 인증서 거부만
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
        with open(OUT / 'build.log', 'w') as f:
            for cmd, cwd in ((['npx', 'cap', 'sync', 'android'], MOB),
                             (['node', 'scripts/gate-profile.mjs'], MOB),
                             (['./gradlew', 'assembleGate', '--console=plain'], MOB / 'android')):
                env = {**nodeenv, 'FH_GATE_URL': f'https://127.0.0.1:{GATE}', 'FH_GATE_CA': str(TMP / 'A' / 'ca.crt')}
                rc = subprocess.run(cmd, cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT).returncode
                need(f'빌드 {cmd[-1] if cmd[0] != "npx" else "cap sync"}', rc == 0, f'rc={rc}')
        shutil.copy2(MOB / 'android/app/build/outputs/apk/gate/app-gate.apk', OUT / 'app-gate.apk')
        shutil.copy2(MOB / 'android/app/src/gate/assets/capacitor.config.json', OUT / 'gate-capacitor.config.json')
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
        need('부팅 완료 sys.boot_completed=1 (360 s 안)', wait_until(lambda: adb('shell', 'getprop', 'sys.boot_completed', check_=False, timeout=30).strip() == '1', 360))
        need('패키지 관리자 준비 pm path android (240 s 안)', wait_until(lambda: adb('shell', 'pm', 'path', 'android', check_=False, timeout=30).startswith('package:'), 240))
        time.sleep(20)
        need('설치 전 PC 부하 ≤ 코어/2', wait_until(lambda: os.getloadavg()[0] <= thr, 180, 5), round(os.getloadavg()[0], 1))
        out = adb('install', '-r', str(OUT / 'app-gate.apk'), check_=False, timeout=180)
        need('APK 설치(180 s 안)', 'Success' in out, out.strip()[-200:])
        stop_evt = asyncio.Event()

        async def run():
            obs = asyncio.ensure_future(observer(stop_evt))
            try: await scenario()
            finally: stop_evt.set(); await obs
        asyncio.run(run())
    except Abort:
        pass                                            # 이미 FAIL 로 기록됨 — 다음 단계로 넘어가지 않음
    except BaseException as e:
        note('FAIL', '예외', repr(e)[:300])
    finally:
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
        req = REQUIRED if SCOPE == 'full' else [n for n in REQUIRED if n.startswith(('B:', 'APK', '미인증', 'fixture 로그인', '읽기 화면 WS', '세션 쿠키', '관문 A 정상', '정리', '결과 폴더'))]
        note('INFO', '실행 범위', {'scope': SCOPE, '필수 항목 수': len(req)})
        miss = [n for n in req if n not in passed]
        check('필수 성공 항목 전부 PASS', not miss, miss)
        (OUT / 'results.json').write_text(json.dumps(RES, ensure_ascii=False, indent=1))
        fails = sum(r['kind'] in ('FAIL', 'TOOL_ERROR') for r in RES)
        print('FAIL 수', fails, '· PASS 수', sum(r['kind'] == 'PASS' for r in RES), flush=True)
        sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()

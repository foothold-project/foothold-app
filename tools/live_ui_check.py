#!/usr/bin/env python3
"""?live=v2 기능 연결 모의 시험 — 가짜 발행기(domain 88) + 이 작업트리의 v2_link(8791) + headless Chrome 한 개(CDP). 실제 RL 근거가 아니다.
  source /opt/ros/jazzy/setup.bash; ROS_DOMAIN_ID=88 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST python3 tools/live_ui_check.py <결과 폴더(없어야 함)>
검사(요청 기능만): 시안 안내·index 진입 · Main 조종권 받기/반납·누름 버튼(앞·아크)·이유 버튼 · 영상 크게 보기(STOP·Esc 폐기) ·
      사진(영상 없음 거부·저장·내려받기) · 궤적 확대/축소/따라가기/숨김 · 상태 상세 · 기록/로봇/설정 패널·테마 저장 ·
      MDrive 조종권 받기/반납·마우스 막대·전체화면·이유 버튼 · 화면 떠남 → 0."""
import asyncio, base64, json, os, signal, subprocess, sys, tempfile, time, urllib.request
from tornado.websocket import websocket_connect
from tornado.httpclient import HTTPRequest

if os.environ.get('ROS_DOMAIN_ID') in (None, '', '61', '57'):
    sys.exit('live_ui_check: ROS_DOMAIN_ID=88 같은 시험 전용 domain 에서만')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.abspath(sys.argv[1]); os.makedirs(OUT)          # 이미 있으면 실패(덮어쓰지 않음)
PORT, DBG = 8791, 9257
BASE = f'http://127.0.0.1:{PORT}'
RES, EXC, LOG, procs, st = [], [], [], {}, {}


def check(name, ok, detail=''):
    RES.append({'name': name, 'ok': bool(ok), 'detail': detail}); print('PASS' if ok else 'FAIL', name, '' if ok else detail, flush=True)


def start(key, args):
    f = open(f'{OUT}/{key}.log', 'a'); LOG.append({'key': key, 'cmd': args})
    procs[key] = subprocess.Popen(args, stdout=f, stderr=subprocess.STDOUT, cwd=ROOT)


def stop(key):                                # 내가 띄운 프로세스만, INT 로
    p = procs.pop(key, None)
    if p and p.poll() is None:
        p.send_signal(signal.SIGINT)
        try: p.wait(8)
        except subprocess.TimeoutExpired: p.terminate(); p.wait(5)


async def main():
    for _ in range(80):
        try: tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json')); break
        except OSError: await asyncio.sleep(0.25)
    cdp = await websocket_connect([t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl'], max_message_size=64 << 20); n = [0]

    async def call(m, **p):
        n[0] += 1; me = n[0]; await cdp.write_message(json.dumps({'id': me, 'method': m, 'params': p}))
        while True:
            r = json.loads(await cdp.read_message())
            if r.get('method') == 'Runtime.exceptionThrown':
                d = r['params']['exceptionDetails']; EXC.append(d.get('exception', {}).get('description') or d.get('text'))
            if r.get('id') == me: return r.get('result', r.get('error'))

    async def js(e): return (await call('Runtime.evaluate', expression=e, returnByValue=True, awaitPromise=True)).get('result', {}).get('value')
    async def shot(name): open(f'{OUT}/{name}.png', 'wb').write(base64.b64decode((await call('Page.captureScreenshot', format='png'))['data']))
    async def center(sel): return await js(f"(e => {{ if (!e) return null; e.scrollIntoView({{block: 'center'}}); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})({sel})")
    BTN = "[...document.querySelectorAll('button,a')].find(b => b.getClientRects().length && b.textContent.trim().startsWith({!r}))"
    async def mouse(sel, kind='click', hold=0.0):
        c = await center(sel)
        if not c: return False
        await call('Input.dispatchMouseEvent', type='mouseMoved', x=c[0], y=c[1])
        await call('Input.dispatchMouseEvent', type='mousePressed', x=c[0], y=c[1], button='left', buttons=1, clickCount=1)
        if kind == 'down': return c
        await asyncio.sleep(hold)
        await call('Input.dispatchMouseEvent', type='mouseReleased', x=c[0], y=c[1], button='left', buttons=0, clickCount=1); return c
    async def up(c): await call('Input.dispatchMouseEvent', type='mouseReleased', x=c[0], y=c[1], button='left', buttons=0, clickCount=1)
    async def key(k, code=None):
        for t in ('keyDown', 'keyUp'): await call('Input.dispatchKeyEvent', type=t, key=k, code=code or k, windowsVirtualKeyCode={'Escape': 27}.get(k, 0))
    async def toast(): return await js("document.querySelector('[data-live-toast]')?.style.display === 'block' ? document.querySelector('[data-live-toast]').textContent : ''")
    async def go(path, w, h, mobile=False):
        await call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=mobile)
        await call('Emulation.setTouchEmulationEnabled', enabled=mobile, maxTouchPoints=5 if mobile else 1)
        await call('Page.navigate', url=f'{BASE}/{path}'); await asyncio.sleep(2.5)

    peer = await websocket_connect(HTTPRequest(f'ws://127.0.0.1:{PORT}/ws', headers={'Origin': BASE}))
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
    async def page_role(): return await js("document.querySelector('header')?.innerText.includes('조종권 · 이 기기') || [...document.querySelectorAll('.hud')].some(h => h.textContent.includes('직접 조종'))")

    await call('Page.enable'); await call('Runtime.enable')
    await call('Browser.setDownloadBehavior', behavior='allow', downloadPath=f'{OUT}/dl')

    # 1) 시안 안내·index 진입
    await go('Main.dc.html', 1440, 920)
    href = await js("document.querySelector('[data-live-design-note] a')?.href")
    check('시안 Main: «시안·동작 안 함» 안내 + 실연결 링크', href == f'{BASE}/Main.dc.html?live=v2', href)
    await go('index.html', 1440, 920)
    hrefs = await js("[...document.querySelectorAll('a[data-live-entry]')].map(a => a.href)")
    check('index: v2 실연결 진입 2개 · 같은 origin', hrefs == [f'{BASE}/Main.dc.html?live=v2', f'{BASE}/MDrive.dc.html?live=v2'], hrefs)
    await js("localStorage.setItem('fh.live.log.v1', '{\"x\":1}')")   # 형식 틀린 예전 기록 → 읽기 실패 안내·원래 값 보존이어야 함

    # 2) 영상 없음 → 사진 거부 (카메라 없는 가짜로 시작)
    await go('Main.dc.html?live=v2', 1440, 920)
    await until(lambda: not st['sim_block'], 10)
    await mouse(BTN.format('사진 찍기')); await asyncio.sleep(0.3)
    t = await toast(); check('사진: 영상 없으면 거부 안내', t.startswith('사진 실패'), t)
    stop('fake'); start('fake', FAKE + ['--camera']); await until(lambda: st.get('cam_age') is not None and st['cam_age'] < 1 and not st['sim_block'], 15)
    await asyncio.sleep(1.5); await shot('1-main-loaded')

    # 3) Main 조종권·누름 버튼
    await mouse(BTN.format('▲ 앞 0.6')); await asyncio.sleep(0.3)
    t = await toast(); check('누름 버튼: 조종권 없으면 이유 안내·명령 0', '조종권' in t and st['applied'] == [0, 0, 0], t)
    await mouse(BTN.format('조종권 받기')); await asyncio.sleep(0.6)
    check('«조종권 받기» → 이 기기 조종', await page_role(), await js("document.querySelector('header').innerText.slice(0,300)"))
    if st.get('latch'):
        await mouse(BTN.format('▲ 앞 0.6')); await asyncio.sleep(0.3)
        t = await toast(); check('STOP 잠금 중 누름 → 이유 안내', 'STOP' in t, t)
        await mouse(BTN.format('STOP 해제')); check('STOP 해제', await until(lambda: not st['latch'], 5))
    await asyncio.sleep(0.5)
    c = await mouse(BTN.format('▲ 앞 0.6'), 'down')
    check('누르는 동안 앞 0.6', await until(lambda: st['applied'] == [0.6, 0, 0], 2), st.get('applied')); await shot('2-main-fwd')
    await up(c); check('손 떼면 0', await until(lambda: st['applied'] == [0, 0, 0], 1), st.get('applied'))
    c = await mouse(BTN.format('◀ 왼쪽 아크'), 'down')
    check('왼쪽 아크 0.6/+0.5', await until(lambda: st['applied'] == [0.6, 0, 0.5], 2), st.get('applied')); await up(c)
    c = await mouse(BTN.format('오른쪽 아크 ▶'), 'down')
    check('오른쪽 아크 0.6/−0.5', await until(lambda: st['applied'] == [0.6, 0, -0.5], 2), st.get('applied')); await up(c)
    await until(lambda: st['applied'] == [0, 0, 0], 1)
    await mouse(BTN.format('후진·제자리 회전')); await asyncio.sleep(0.3)
    t = await toast(); check('후진·제자리 회전: 누르면 미검증 이유', '검증 안 됨' in t, t)

    # 4) 사진 저장·기록·내려받기
    await mouse(BTN.format('사진 찍기')); await asyncio.sleep(1.5)
    t = await toast(); files = os.listdir(f'{OUT}/dl') if os.path.isdir(f'{OUT}/dl') else []
    check('사진: 찍으면 JPEG 바로 내려받기 + 프레임 수신 시각·좌표 안내', t.startswith('사진 내려받기 요청 · 프레임 수신') and ' x ' in t and sum(f.endswith('.jpg') for f in files) == 1, [t, files])
    await js("window._cib = window.createImageBitmap; window.createImageBitmap = () => Promise.reject(new Error('decode'))")
    await mouse(BTN.format('사진 찍기')); await asyncio.sleep(0.4); t = await toast()
    check('사진: 프레임 디코드 실패 → 실패 안내', t.startswith('사진 실패 · 영상 프레임을 읽을 수 없음'), t)
    await js("window.createImageBitmap = window._cib")

    # 5) 지도 궤적: 확대/축소/따라가기/숨김 · 레이어 이유
    V = "document.querySelector('canvas').dataset.view"
    await mouse("document.querySelector('button[aria-label=\"확대\"]')"); v1 = await js(V)
    await mouse("document.querySelector('button[aria-label=\"축소\"]')"); await mouse("document.querySelector('button[aria-label=\"축소\"]')"); v2 = await js(V)
    await mouse("document.querySelector('button[aria-label=\"로봇 따라가기\"]')"); v3 = await js(V)
    await mouse(BTN.format('경로')); v4 = await js(V); await mouse(BTN.format('경로'))
    check('궤적 확대·축소·따라가기·숨김', v1 == 'fit|1.5|trail' and v2 == 'fit|0.67|trail' and v3.startswith('follow|') and v4.endswith('notrail'), [v1, v2, v3, v4])
    await mouse(BTN.format('측정값')); await asyncio.sleep(0.2); t = await toast()
    check('미지원 레이어: 누르면 이유', t.startswith('측정값 —'), t)
    await mouse(BTN.format('뎁스')); await asyncio.sleep(0.2); t = await toast(); check('뎁스: 누르면 이유', t.startswith('뎁스 —'), t)

    # 6) 상태 상세·패널
    await mouse("document.querySelector('details summary')"); await asyncio.sleep(0.4)
    check('상태 상세 펼침: 서버 원값', await js("document.querySelector('details[open] dl')?.innerText.includes('sim.x')"))
    await mouse("document.querySelector('nav a[data-design-href=\"PcHistory.dc.html\"]')"); await asyncio.sleep(0.3)
    rec = await js("document.querySelector('[role=dialog]')?.innerText || ''")
    check('메뉴 «기록» → 실제 기록 패널(사진 1장·조종 기록)', '사진 1장' in rec and '조종 기록' in rec, rec[:200])
    check('기록 패널: 예전 기록 읽기 실패 안내 · 원래 값 보존', '읽기 실패' in rec and await js("localStorage.getItem('fh.live.log.v1') === '{\"x\":1}'"), rec[:300])
    await mouse(BTN.format('내려받기')); await asyncio.sleep(0.3); t = await toast()
    check('기록 패널에서 사진 다시 내려받기 요청', t.startswith('내려받기 요청: foothold-v2-') and '.jpg' in t, t)
    await mouse(BTN.format('CSV 내보내기')); await asyncio.sleep(1.5)
    files = os.listdir(f'{OUT}/dl'); check('조종 기록 CSV 내보내기', any(f.endswith('.csv') for f in files), files)
    await shot('3-records'); await key('Escape'); await asyncio.sleep(0.2)
    check('Esc → 패널 닫힘', await js("!document.querySelector('[role=dialog]')"))
    await mouse("document.querySelector('nav a[data-design-href=\"PcRobot.dc.html\"]')"); await asyncio.sleep(0.3)
    check('메뉴 «로봇» → 실제 상태 패널', await js("document.querySelector('[role=dialog]')?.innerText.includes('sim.policy_running')"))
    await mouse("document.querySelector('nav a[data-design-href=\"PcSettings.dc.html\"]')"); await asyncio.sleep(0.3)
    await mouse(BTN.format('테마:')); await asyncio.sleep(0.2)
    check('설정 테마 → 밝은 + 저장', await js("document.querySelector('.fh').classList.contains('light') && localStorage.getItem('fh.live.theme') === '\"light\"'"))
    await shot('4-settings-light')
    await js("window._si = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new Error('quota'); }")
    await mouse(BTN.format('테마:')); await asyncio.sleep(0.2); t = await toast()
    check('테마 저장 실패 → 이번 화면엔 적용 + 실패 안내', t.startswith('테마 저장 실패') and await js("!document.querySelector('.fh').classList.contains('light') && localStorage.getItem('fh.live.theme') === '\"light\"'"), t)
    await js("Storage.prototype.setItem = window._si"); await mouse(BTN.format('테마:')); await key('Escape'); await asyncio.sleep(3.6)   # 앞 안내가 사라진 뒤
    await mouse("document.querySelector('nav a[data-design-href=\"PcMissions.dc.html\"]')"); await asyncio.sleep(0.2); t = await toast(); await shot('4b-mission')
    check('메뉴 «임무» → 미지원 이유', t.startswith('임무 —'), t)

    # 7) 영상 크게 보기: STOP·조작 포함, Esc 로 닫으면 누름 폐기
    await mouse("document.querySelector('button[aria-label=\"영상 크게 보기\"]')"); await asyncio.sleep(0.8)
    mode = await js("document.fullscreenElement ? 'fs' : document.querySelector('.lv-big') ? 'page' : 'none'")
    check('크게 보기: 영상 상자 전체화면(또는 화면 안 확대) + STOP·조작 막대', mode != 'none' and await js("getComputedStyle(document.querySelector('[data-live-bigbar]')).display === 'flex'"), mode)
    await shot('5-big')
    c = await mouse("document.querySelector('[data-live-bigbar] [data-live-hold]:nth-child(2)')", 'down')
    ok_big = await until(lambda: st['applied'] == [0.6, 0, 0], 2)
    await key('Escape'); dropped = await until(lambda: st['applied'] == [0, 0, 0], 1); await up(c)
    check('확대 중 누름 → 이동, Esc → 닫힘·명령 0', ok_big and dropped and await js("!document.fullscreenElement && !document.querySelector('.lv-big')"), [ok_big, dropped])
    await asyncio.sleep(0.4)
    c = await mouse("document.querySelector('[data-live-hold]')", 'down'); await asyncio.sleep(0.4)
    await mouse("document.querySelector('button[aria-label=\"영상 크게 보기\"]')"); await up(c)
    check('누르는 중 크게 보기 진입 → 누름 폐기(새로 눌러야 이동)', await until(lambda: st['applied'] == [0, 0, 0], 1.5), st.get('applied'))
    await mouse("document.querySelector('[aria-label=\"비상 정지(확대 화면)\"]')", 'down')
    check('확대 화면 STOP → 잠금', await until(lambda: st['latch'] and st['applied'] == [0, 0, 0], 2))
    await key('Escape'); await asyncio.sleep(0.3)
    # 사진 확인(디코드) 중 리셋 → 섞인 사진 저장 거부
    await js("window.createImageBitmap = (b) => new Promise((r) => setTimeout(() => r({ close() {} }), 1500))")
    await mouse(BTN.format('사진 찍기')); await mouse(BTN.format('시뮬 리셋')); await asyncio.sleep(2.0); t = await toast()
    check('사진 확인 중 리셋 → 섞인 사진 거부', t.startswith('사진 실패 · 확인 중 재연결·리셋'), t)
    await js("window.createImageBitmap = window._cib"); await until(lambda: not st['reset_pending'], 10)
    await mouse(BTN.format('조종권 반납')); await asyncio.sleep(0.5); check('«조종권 반납» → 보기 전용', not await page_role())

    # 8) MDrive: 조종권 받기 버튼·마우스 막대·전체화면·이유·반납
    await go('MDrive.dc.html?live=v2', 844, 390, mobile=False)
    await shot('6-mdrive')
    await mouse(BTN.format('조종권 받기')); await asyncio.sleep(0.5)
    check('MDrive «조종권 받기» 버튼 → 조종', await page_role())
    if st.get('latch'): await mouse(BTN.format('STOP 해제')); await until(lambda: not st['latch'], 5)
    await asyncio.sleep(0.4)
    mv = await center("document.querySelector('[aria-label=\"이동 막대: 앞뒤와 옆걸음\"]')")
    await call('Input.dispatchMouseEvent', type='mousePressed', x=mv[0], y=mv[1], button='left', buttons=1, clickCount=1)
    await call('Input.dispatchMouseEvent', type='mouseMoved', x=mv[0], y=mv[1] - 70, button='left', buttons=1)
    check('MDrive 마우스로 막대 앞 → 0.6', await until(lambda: st['applied'] == [0.6, 0, 0], 2), st.get('applied'))
    await call('Input.dispatchMouseEvent', type='mouseReleased', x=mv[0], y=mv[1] - 70, button='left', buttons=0, clickCount=1)
    check('MDrive 막대 놓으면 0', await until(lambda: st['applied'] == [0, 0, 0], 1))
    await mouse(BTN.format('자세')); await asyncio.sleep(0.2); t = await toast(); check('MDrive 자세: 누르면 이유', t.startswith('자세 —'), t)
    await mouse("document.querySelector('button[aria-label=\"전체화면\"]')"); await asyncio.sleep(0.6)
    fs = await js("!!document.fullscreenElement"); t = await toast()
    check('MDrive 전체화면(또는 거절 안내)', fs or '전체화면' in t, [fs, t]); await shot('7-mdrive-fs')
    if fs: await mouse("document.querySelector('button[aria-label=\"전체화면 닫기\"]')"); await asyncio.sleep(0.4)
    await mouse("document.querySelector('button[aria-label=\"안내·설정\"]')"); await asyncio.sleep(0.3)
    check('MDrive 안내·설정 패널: 미지원 목록', await js("document.querySelector('[role=dialog]')?.innerText.includes('안 되는 기능과 이유')")); await shot('8-mdrive-settings')
    await key('Escape')
    await shot('9-mdrive-control-row')
    await mouse(BTN.format('조종권 반납')); await asyncio.sleep(0.4)
    check('MDrive «조종권 반납»', not await page_role())
    await mouse(BTN.format('조종권 받기')); await asyncio.sleep(0.4)
    await call('Page.navigate', url='about:blank')
    check('화면 떠남 → 명령 0', await until(lambda: st['applied'] == [0, 0, 0], 2))
    peer.close()


FAKE = [sys.executable, 'tools/fake_v2_live.py']
chrome = None
try:
    start('fake', FAKE)
    start('link', [sys.executable, 'sim/v2_link.py', '--port', str(PORT)])
    chrome = subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', f'--remote-debugging-port={DBG}', f'--user-data-dir={tempfile.mkdtemp()}',
                               '--no-first-run', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    asyncio.run(main())
finally:
    if chrome: chrome.terminate(); chrome.wait(5)
    stop('link'); stop('fake')
    json.dump({'cmd': sys.argv, 'env_ROS_DOMAIN_ID': os.environ.get('ROS_DOMAIN_ID'), 'port': PORT, 'procs': LOG, 'results': RES, 'exceptions': EXC,
               'pass': sum(r['ok'] for r in RES), 'total': len(RES), 'note': '모의(가짜 발행기 domain 88) — 실제 RL 근거 아님'},
              open(f'{OUT}/manifest.json', 'w'), ensure_ascii=False, indent=1)
    print(f"{sum(r['ok'] for r in RES)}/{len(RES)} exceptions {EXC}")

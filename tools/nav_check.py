#!/usr/bin/env python3
"""화면 탐색 기본 검사 (로컬 전용, headless Chrome + CDP).
1) web/ 의 시안 화면마다: 열림 · 페이지 예외 0 · 화면 간 링크 목록(있는 화면 / 아직 없는 화면)
2) 링크를 실제로 눌러 그 화면이 열리는지
3) 상호작용이 있는 화면(임무 양식): 같은 조작을 원본 시안 런타임과 구현에 똑같이 하고 화면 글자·캡처가 같은지
python3 tools/nav_check.py <결과 폴더(없어야 함)> [화면 이름…(없으면 전체)]   — 필요: python3-tornado, Pillow"""
import asyncio, base64, glob, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from tornado.websocket import websocket_connect
from PIL import Image, ImageChops
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); PORT, DBG = 8773, 9251
BASE = f'http://127.0.0.1:{PORT}'
EXC, RES = [], []


class CDP:
    async def open(self):
        for _ in range(40):
            try: tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json')); break
            except OSError: await asyncio.sleep(0.25)
        self.ws = await websocket_connect([t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl'], max_message_size=64 << 20); self.i = 0
        await self.call('Page.enable'); await self.call('Runtime.enable'); return self

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

    async def go(self, url, w, h):
        await self.call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=False)
        await self.call('Page.navigate', url=url); await asyncio.sleep(1.8)

    async def shot(self, path):
        open(path, 'wb').write(base64.b64decode((await self.call('Page.captureScreenshot', format='png'))['data']))


def check(name, ok, detail):
    RES.append({'name': name, 'ok': bool(ok), 'detail': detail}); print('PASS' if ok else 'FAIL', name)


SIZE = {}
for f in glob.glob(f'{ROOT}/web/*.dc.html'):
    import re
    m = re.search(r'"\$preview":\{"width":(\d+),"height":(\d+)\}', open(f, encoding='utf-8').read())
    SIZE[os.path.basename(f)] = (int(m.group(1)), int(m.group(2))) if m else (1440, 900)

OVER = "(() => { const d = document.documentElement; return {sw: d.scrollWidth, sh: d.scrollHeight, w: innerWidth, h: innerHeight, x_over: d.scrollWidth > innerWidth, y_over: d.scrollHeight > innerHeight}; })()"
TEXT = "document.body.innerText.replace(/\\s+/g, ' ').trim()"
# 임무 양식: 원본과 구현에 똑같이 할 조작(선택자는 시안 class 그대로)
MISSION_STEPS = [
    ('두 번째 양식 고르기', "document.querySelectorAll('.tp')[1].click()"),
    ('새 양식 추가', "document.querySelector('.btn.pri').click()"),
    ('할 일 «운영자 확인» 추가', "[...document.querySelectorAll('.pal')].find(b => b.textContent.includes('운영자 확인')).click()"),
    ('이름 칸에 글자 넣기', "INSERT"),
    ('복제', "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '복제').click()"),
    ('삭제', "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '삭제').click()"),
    ('되돌리기', "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '되돌리기')?.click()"),
]


async def run_steps(c, url, out, tag):
    w, h = SIZE['PcMissions.dc.html']; await c.go(url, w, h); texts = []
    for name, js in MISSION_STEPS:
        if js == 'INSERT':
            await c.js("document.getElementById('nm').focus(); document.getElementById('nm').select()")
            await c.call('Input.insertText', text='현장 확인 A')
        else:
            await c.js(js)
        await asyncio.sleep(0.3); texts.append(await c.js(TEXT))
    await c.shot(f'{out}/mission-steps-{tag}.png')
    return texts


async def main(out, only=()):
    c = await CDP().open()
    screens = sorted(s for s in SIZE if not only or s[:-8] in only)
    for s in screens:
        w, h = SIZE[s]; n0 = len(EXC)
        await c.go(f'{BASE}/web/{s}', w, h)
        links = await c.js("[...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))")
        ok_root = await c.js("!!document.getElementById('dc-root') && document.getElementById('dc-root').children.length > 0")
        targets = sorted({l for l in links if l.endswith('.dc.html')})
        have = [t for t in targets if t in SIZE]; missing = [t for t in targets if t not in SIZE]
        check(f'{s}: 열림 · 예외 0', ok_root and len(EXC) == n0, {'links': targets, 'have': have, 'missing_screens': missing, 'hash_links': links.count('#'), 'exc': EXC[n0:]})
        # 스크롤 넘침: 시안 크기 창에서 문서가 창보다 큰지 — 원본 런타임과 구현을 같이 잰다(다르면 구현 문제, 같으면 원본 그대로)
        ov = {}
        for tag, url in (('orig', f'{BASE}/reference/src/{s[:-8]}/{s}'), ('impl', f'{BASE}/web/{s}')):
            await c.go(url, w, h); ov[tag] = await c.js(OVER)
        check(f'{s}: 스크롤 넘침 원본=구현', ov['orig'] == ov['impl'], ov)
        for t in have:   # 링크를 눌러 이동
            await c.go(f'{BASE}/web/{s}', w, h)
            await c.js(f"document.querySelector('a[href=\"{t}\"]').click()"); await asyncio.sleep(1.5)
            here = await c.js('location.pathname.split("/").pop()'); good = await c.js("document.getElementById('dc-root')?.children.length > 0")
            check(f'{s} → {t} 링크 이동', here == t and good, {'at': here})
    if only and 'PcMissions' not in only:   # 바뀐 화면만 볼 때는 임무 양식 조작 검사를 건너뛴다
        check('페이지 예외 0 (전체)', not EXC, EXC); return
    # 임무 양식 조작: 원본 런타임 vs 구현
    a = await run_steps(c, f'{BASE}/reference/src/PcMissions/PcMissions.dc.html', out, 'orig')
    b = await run_steps(c, f'{BASE}/web/PcMissions.dc.html', out, 'impl')
    A, B = Image.open(f'{out}/mission-steps-orig.png').convert('RGB'), Image.open(f'{out}/mission-steps-impl.png').convert('RGB')
    px = sum(1 for p in ImageChops.difference(A, B).getdata() if max(p) > 16)
    same = [x == y for x, y in zip(a, b)]
    check('임무 양식 조작 7단계: 단계마다 화면 글자 원본=구현 · 마지막 캡처 차이 0', all(same) and px == 0,
          {'steps': [n for n, _ in MISSION_STEPS], 'same': same, 'diff_px': px,
           'first_diff': next(({'step': MISSION_STEPS[i][0], 'orig': a[i][:300], 'impl': b[i][:300]} for i, s in enumerate(same) if not s), None)})
    check('페이지 예외 0 (전체)', not EXC, EXC)


async def run(out, only=()):
    os.makedirs(out)
    prof = tempfile.mkdtemp(prefix='fh-nav-')
    procs = [subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
             subprocess.Popen(['/opt/google/chrome/chrome', '--headless=new', f'--remote-debugging-port={DBG}', f'--user-data-dir={prof}', '--no-first-run', 'about:blank'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
    try:
        await asyncio.sleep(1); await main(out, only)
    finally:
        for p in procs[::-1]:
            p.terminate()
            try: p.wait(5)
            except subprocess.TimeoutExpired: print('남음 pid', p.pid)
        shutil.rmtree(prof, ignore_errors=True)
    json.dump({'when': time.strftime('%Y-%m-%d %H:%M:%S'), 'results': RES}, open(f'{out}/results.json', 'x'), ensure_ascii=False, indent=1)
    ok = RES and all(r['ok'] for r in RES); print('nav_check', 'OK' if ok else 'FAIL'); return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(run(sys.argv[1], tuple(sys.argv[2:]))))

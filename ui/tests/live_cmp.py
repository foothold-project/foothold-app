#!/usr/bin/env python3
"""실데이터 대조: 기존 실연결 화면(web/<화면>.dc.html?live=v2, 2dfc0e9 동작 = 결과 기준) vs React 화면(#/<화면>), 같은 모의 링크 데이터.
화면 전체의 보이는 글(줄 단위)을 비교하고 둘 다 캡처한다. 시안 예시 글자가 React 화면에 남았는지도 본다.
쓰임: python3 ui/tests/live_cmp.py <결과 폴더(없어야 함)> 화면[?값] …   예) Report?run=r10131246269513
환경: LEGACY=http://127.0.0.1:8791  REACT=http://127.0.0.1:5181  (로컬 전용, 이미 뜬 headless Chrome CDP 9258 재사용)
판정: 글 차이 줄은 IGNORE(만든 시각처럼 매번 바뀌는 줄)만 허용. 차이·예시 글자가 있으면 FAIL, 종료값 1."""
import asyncio, base64, json, os, re, sys, urllib.request
from tornado.websocket import websocket_connect
LEGACY = os.environ.get('LEGACY', 'http://127.0.0.1:8791'); REACT = os.environ.get('REACT', 'http://127.0.0.1:5181'); DBG = int(os.environ.get('DBG', '9258'))
SIZE = {'Report': (794, 1300), 'PcHistory': (1440, 940), 'MHistory': (390, 844)}
IGNORE = [re.compile(r'^기록 보관: 서버 공유 문서·사진 · 이 쪽은 .*에 만듦$')]
# 시안 예시값(원본 Component·마크업) — 실화면에 나오면 안 된다
EXAMPLES = ['FH-20261012-03', '[현장명]', 'Unitree Go2 EDU', '운영자 A', '계단실 하부', '펌프실 A', '10:33:02', '[이름]', '주행 거리 148 m', '보존 기간 1년']
TEXT = "document.body.innerText.split('\\n').map((s) => s.trim()).filter(Boolean)"   # 화면 전체 글(도구줄·STOP 포함)

async def main(outdir, items):
    os.makedirs(outdir); tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json'))
    ws = await websocket_connect([t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl'], max_message_size=128 << 20); n = [0]
    async def call(m, **p):
        n[0] += 1; me = n[0]; await ws.write_message(json.dumps({'id': me, 'method': m, 'params': p}))
        while True:
            r = json.loads(await ws.read_message())
            if r.get('id') == me: return r.get('result', r.get('error'))
    async def js(e): return (await call('Runtime.evaluate', expression=e, returnByValue=True, awaitPromise=True)).get('result', {}).get('value')
    async def grab(url, w, h, png):
        await call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=False)
        await call('Page.navigate', url=url); await asyncio.sleep(4); await js('document.fonts.ready.then(() => 1)')
        open(png, 'wb').write(base64.b64decode((await call('Page.captureScreenshot', format='png'))['data']))
        return await js(TEXT)
    bad = 0
    for it in items:
        name, _, qs = it.partition('?'); w, h = SIZE[name]; tag = re.sub(r'[^\w]+', '_', it)
        a = await grab(f'{LEGACY}/{name}.dc.html?live=v2{"&" + qs if qs else ""}', w, h, f'{outdir}/{tag}_legacy.png')
        b = await grab(f'{REACT}/#/{name}{"?" + qs if qs else ""}', w, h, f'{outdir}/{tag}_react.png')
        keep = lambda L: [x for x in (L or []) if not any(p.match(x) for p in IGNORE)]
        da, db = keep(a), keep(b)
        diff = [f'- {x}' for x in da if x not in db] + [f'+ {x}' for x in db if x not in da]
        ex = [e for e in EXAMPLES if any(e in x for x in (b or []))]
        ok = b is not None and not diff and not ex; bad += not ok
        print(('PASS' if ok else 'FAIL'), it, f'lines {len(da)}/{len(db)}', 'examples', ex or '-')
        for d in diff[:30]: print('   ', d)
        json.dump({'legacy': a, 'react': b, 'diff': diff, 'examples': ex}, open(f'{outdir}/{tag}.json', 'w'), ensure_ascii=False, indent=1)
    ws.close(); sys.exit(1 if bad else 0)

if __name__ == '__main__':
    asyncio.run(main(sys.argv[1], sys.argv[2:]))

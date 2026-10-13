#!/usr/bin/env python3
"""변환 대조: 원본(web/*.dc.html + dc.js, 시안 예시값) vs React 틀(ui parity.html, 같은 예시값).
DOM 구조(태그·속성·style 정규화·글자) 일치 + 같은 뷰포트 캡처 픽셀 차이.
쓰임: python3 ui/tests/parity.py <결과 폴더(없어야 함)> 화면 …   (로컬 전용, 이미 뜬 headless Chrome CDP 9258 재사용)
환경: LEGACY=http://127.0.0.1:8791  REACT=http://127.0.0.1:5181"""
import asyncio, base64, io, json, os, sys, urllib.request
from PIL import Image, ImageChops
from tornado.websocket import websocket_connect
LEGACY = os.environ.get('LEGACY', 'http://127.0.0.1:8791'); REACT = os.environ.get('REACT', 'http://127.0.0.1:5181'); DBG = int(os.environ.get('DBG', '9258'))
SIZE = {'Report': (794, 1123, ['', 'mission=가스 사전 측정']), 'PcHistory': (1440, 940, ['']), 'MHistory': (390, 844, ['']),
        'PcReview': (1440, 1060, ['']), 'MAlerts': (390, 844, ['']), 'MAlert': (390, 844, ['']), 'MFinding': (390, 844, ['']),
        'PcRobot': (1440, 1040, ['']), 'PcSettings': (1440, 1500, ['']), 'MHome': (390, 844, ['']), 'MMap': (390, 844, ['']),
        'PcMap': (1440, 980, ['']), 'PcMissions': (1440, 1100, ['']), 'PcPlan': (1440, 1120, ['']), 'Main': (1440, 920, ['']),
        'MDrive': (844, 390, ['stickLayout=왼쪽 회전 · 오른쪽 앞뒤']), 'PcLogin': (1440, 900, ['']), 'MLogin': (390, 844, ['']), 'System': (1440, 1560, [''])}
# DOM 서명: 태그·속성(정렬, style 은 브라우저 정규화 cssText)·비지 않은 글자(공백 접기)
SIG = r"""(() => { const out = []; const w = (n, d) => { for (const c of n.childNodes) {
  if (c.nodeType === 3) { const t = c.data.replace(/\s+/g, ' ').trim(); if (t) out.push(d + '#' + t); continue; }
  if (c.nodeType !== 1 || c.localName === 'script') continue;   // 틀 안 시안 스크립트(그려지지 않음)는 비교 밖
  const a = [...c.attributes].filter((x) => x.name !== 'style' && !(c.localName === 'select' && x.name === 'value') && !(c.localName === 'option' && x.name === 'selected')).map((x) => x.name + '=' + x.value).sort();
  if (c.getAttribute('style') != null) a.push('style=' + c.style.cssText);
  if (c.localName === 'select') a.push('selected=' + c.value);   // <select value> 는 React 가 속성 대신 선택 상태로 둔다 — 실제 선택값으로 비교
  out.push(d + '<' + c.localName + ' ' + a.join(' ')); w(c, d + ' '); } }; w(document.getElementById('dc-root'), ''); return out; })()"""
async def main(outdir, names):
    os.makedirs(outdir); tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json'))
    ws = await websocket_connect([t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl'], max_message_size=128 << 20); n = [0]
    async def call(m, **p):
        n[0] += 1; me = n[0]; await ws.write_message(json.dumps({'id': me, 'method': m, 'params': p}))
        while True:
            r = json.loads(await ws.read_message())
            if r.get('id') == me: return r.get('result', r.get('error'))
    async def js(e): return (await call('Runtime.evaluate', expression=e, returnByValue=True, awaitPromise=True)).get('result', {}).get('value')
    async def shot(url, w, h, legacy):
        await call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=False)
        await call('Page.navigate', url=url); await asyncio.sleep(2.5)
        await js('document.fonts.ready.then(() => 1)')
        if legacy: await js("[...document.body.children].forEach((c) => { if (c.id !== 'dc-root' && c.localName !== 'script') c.remove(); }); 1")
        await asyncio.sleep(0.4); sig = await js(SIG)
        png = base64.b64decode((await call('Page.captureScreenshot', format='png', clip={'x': 0, 'y': 0, 'width': w, 'height': h, 'scale': 1}))['data'])
        return sig, Image.open(io.BytesIO(png)).convert('RGB')
    res = []
    for name in names:
        w, h, qs = SIZE[name]
        for q in qs:
            a_sig, a = await shot(f'{LEGACY}/{name}.dc.html?{q}', w, h, True)
            b_sig, b = await shot(f'{REACT}/parity.html?screen={name}&{q}', w, h, False)
            diff = ImageChops.difference(a, b); px = sum(1 for p in diff.getdata() if max(p) > 24)
            first = next((i for i, (x, y) in enumerate(zip(a_sig or [], b_sig or [])) if x != y), None)
            if first is None and len(a_sig or []) != len(b_sig or []): first = min(len(a_sig or []), len(b_sig or []))
            tag = f'{name}{("_" + q.split("=")[1][:6]) if q else ""}'
            a.save(f'{outdir}/{tag}_legacy.png'); b.save(f'{outdir}/{tag}_react.png'); diff.point(lambda v: 255 if v > 24 else 0).save(f'{outdir}/{tag}_diff.png')
            ok = first is None and px == 0
            res.append({'screen': name, 'q': q, 'dom_nodes': [len(a_sig or []), len(b_sig or [])], 'dom_first_diff': None if first is None else [(a_sig or [None])[first:first + 1], (b_sig or [None])[first:first + 1]], 'px_diff': px, 'ok': ok})
            print('PASS' if ok else 'FAIL', tag, 'dom', len(a_sig or []), len(b_sig or []), 'first', first, 'px', px, flush=True)
            if first is not None: print('   legacy:', (a_sig or [''])[first][:160] if first < len(a_sig or []) else '-', '\n   react :', (b_sig or [''])[first][:160] if first < len(b_sig or []) else '-')
    json.dump(res, open(f'{outdir}/parity.json', 'w'), ensure_ascii=False, indent=1)
    print(f"{sum(r['ok'] for r in res)}/{len(res)} PASS")
asyncio.run(main(sys.argv[1], sys.argv[2:]))

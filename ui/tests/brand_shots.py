#!/usr/bin/env python3
"""브랜드 적용 전후 캡처·측정 (parity.html 예시값, 모의 전용).
쓰임: python3 ui/tests/brand_shots.py <결과 폴더(없어야 함)> [화면 …(생략 = 전부)]   (이미 뜬 headless Chrome CDP 9258 재사용)
환경: REACT=http://127.0.0.1:5181
측정: STOP 상자·화면 안·elementFromPoint 적중·글자/바탕 대비, 로고 상자·img src 의 sha256(ui/public 원본과 대조),
      가로 넘침, <html data-theme>, 실제 쓰인 글꼴, .fh font-family → measure.json"""
import asyncio, base64, hashlib, json, os, sys, urllib.request
from pathlib import Path
from tornado.websocket import websocket_connect
REACT = os.environ.get('REACT', 'http://127.0.0.1:5181'); DBG = int(os.environ.get('DBG', '9258'))
PUB = Path(__file__).resolve().parent.parent / 'public'
SHOTS = [('Main', 1440, 920, ''), ('PcLogin', 1440, 900, ''), ('Report', 794, 1123, ''),
         ('MDrive', 844, 390, 'stickLayout=왼쪽 회전 · 오른쪽 앞뒤'), ('MHome', 390, 844, ''), ('MLogin', 390, 844, '')]
THEMES = ['어두운', '밝은']
MEASURE = r"""(async () => {
  const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  const stops = [...document.querySelectorAll('button[aria-label="비상 정지"]')].map((e) => { const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2, hit = document.elementFromPoint(cx, cy);
    return { box: r(e), inView: b.x >= 0 && b.y >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, hit: !!hit && (hit === e || e.contains(hit)), color: cs.color, bg: cs.backgroundColor }; });
  let logo = [...document.querySelectorAll('[data-brand-box]')];
  if (!logo.length) logo = [...document.querySelectorAll('span')].filter((s) => s.textContent.trim() === 'FOOTHOLD' || s.textContent.includes('FOOTHOLD ·')).map((s) => s.parentElement);
  const imgs = [...document.querySelectorAll('img[data-brand]')].filter((i) => getComputedStyle(i).display !== 'none').map((i) => ({ src: i.getAttribute('src'), box: r(i), nat: [i.naturalWidth, i.naturalHeight] }));
  await document.fonts.ready; const fonts = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
  const fh = document.querySelector('.fh'), acc = document.querySelector('.fh button[class*="btn-p"], .fh .btn-p');
  return { stops, logo: logo.map(r), imgs, hOverflow: document.documentElement.scrollWidth > innerWidth, dataTheme: document.documentElement.dataset.theme || null,
    fonts: [...new Set(fonts)], fhFont: fh ? getComputedStyle(fh).fontFamily : getComputedStyle(document.body).fontFamily,
    fhBg: fh ? getComputedStyle(fh).backgroundColor : null, fhText: fh ? getComputedStyle(fh).color : null,
    accent: acc ? { color: getComputedStyle(acc).color, bg: getComputedStyle(acc).backgroundColor } : null };
})()"""
def rgb(s):
    v = [float(x) for x in s[s.index('(') + 1:s.index(')')].replace('/', ' ').replace(',', ' ').split()[:3]]
    return v
def lum(c):
    c = [x / 255 for x in c]; c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
def contrast(a, b):
    try: la, lb = lum(rgb(a)), lum(rgb(b))
    except Exception: return None   # transparent·color-mix 원문 등 숫자로 못 읽으면 기록만
    return round((max(la, lb) + 0.05) / (min(la, lb) + 0.05), 2)
async def main(outdir, only):
    os.makedirs(outdir); tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DBG}/json'))
    ws = await websocket_connect([t for t in tabs if t['type'] == 'page'][0]['webSocketDebuggerUrl'], max_message_size=128 << 20); n = [0]
    async def call(m, **p):
        n[0] += 1; me = n[0]; await ws.write_message(json.dumps({'id': me, 'method': m, 'params': p}))
        while True:
            r = json.loads(await ws.read_message())
            if r.get('id') == me: return r.get('result', r.get('error'))
    async def js(e): return (await call('Runtime.evaluate', expression=e, returnByValue=True, awaitPromise=True)).get('result', {}).get('value')
    out = {}
    for name, w, h, q in [x for x in SHOTS if not only or x[0] in only]:
        for th in THEMES:
            await call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=False)
            await call('Page.navigate', url=f'{REACT}/parity.html?screen={name}&theme={th}&{q}'); await asyncio.sleep(2.5)
            m = await js(MEASURE); await asyncio.sleep(0.3)
            png = base64.b64decode((await call('Page.captureScreenshot', format='png', clip={'x': 0, 'y': 0, 'width': w, 'height': h, 'scale': 1}))['data'])
            tag = f'{name}_{"dark" if th == "어두운" else "light"}'; open(f'{outdir}/{tag}.png', 'wb').write(png)
            for s in m['stops']: s['contrast'] = contrast(s['color'], s['bg'])
            if m['accent']: m['accent']['contrast'] = contrast(m['accent']['color'], m['accent']['bg'])
            if m['fhBg']: m['textContrast'] = contrast(m['fhText'], m['fhBg'])
            for i in m['imgs']:   # 받은 바이트 = 저장소 원본 바이트인지
                src = i['src'].split('?')[0]; rel = src[src.index('brand/'):] if 'brand/' in src else None
                got = hashlib.sha256(urllib.request.urlopen(f'{REACT}/{rel}').read()).hexdigest() if rel else None
                i['sha256'] = got; i['same_as_public'] = bool(rel) and got == hashlib.sha256((PUB / rel).read_bytes()).hexdigest()
            out[tag] = m; print(tag, 'stops', [(s['box'], s['inView'], s['hit'], s['contrast']) for s in m['stops']], 'logo', m['logo'][:2],
                               'imgs', [(Path(i['src']).name, i['box'], i['same_as_public']) for i in m['imgs']], 'hOv', m['hOverflow'], 'theme', m['dataTheme'], flush=True)
    json.dump(out, open(f'{outdir}/measure.json', 'w'), ensure_ascii=False, indent=1)
asyncio.run(main(sys.argv[1], sys.argv[2:]))

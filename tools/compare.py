#!/usr/bin/env python3
"""원본 시안(reference/src, 시안 도구 런타임) vs 구현(web/, dc.js) 같은 뷰포트 캡처 + 픽셀 차이.
python3 tools/compare.py <결과 폴더(없어야 함)> [화면이름 …]   — 로컬 전용(127.0.0.1), headless Chrome.
글꼴은 시안 그대로 Google Fonts 에서 받는다(네트워크 필요)."""
import json, os, re, subprocess, sys, tempfile, time, shutil, urllib.parse
from PIL import Image, ImageChops
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); PORT = 8771
CHROME = '/opt/google/chrome/chrome'
# 화면이름: (뷰포트 w, h — 시안 $preview, 상태 쿼리 목록)
SCREENS = {
    'Main': (1440, 920, ['', 'scenario=경보 규칙 발동&mission=가스 사전 측정', 'scenario=통신 끊김', 'theme=밝은']),
    'PcMissions': (1440, 1100, ['', 'theme=밝은']),
    'PcPlan': (1440, 1120, ['']),
    'PcReview': (1440, 1060, ['']),
    'MDrive': (844, 390, ['', 'stickLayout=왼쪽 회전 · 오른쪽 앞뒤']),
    'MHome': (390, 844, ['', 'mission=가스 사전 측정', 'theme=어두운']),
    'MAlert': (390, 844, ['', 'theme=어두운']),
    'MFinding': (390, 844, ['', 'theme=어두운']),
    'Report': (794, 1123, ['', 'mission=가스 사전 측정', 'mission=시설 순찰']),
    'System': (1440, 1560, ['', 'theme=밝은']),
}


def shot(url, w, h, out, prof):
    subprocess.run([CHROME, '--headless=new', f'--user-data-dir={prof}', '--hide-scrollbars', '--no-first-run', f'--window-size={w},{h}',
                    '--virtual-time-budget=6000', '--run-all-compositor-stages-before-draw', f'--screenshot={out}', url],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True)


def main(out, names):
    os.makedirs(out)
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', ROOT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    prof = tempfile.mkdtemp(prefix='fh-cmp-'); res = []
    try:
        time.sleep(0.8)
        for n in names:
            w, h, qs = SCREENS[n]
            for i, q in enumerate(qs):
                tag = f'{n}-{i}'
                a, b = f'{out}/{tag}-orig.png', f'{out}/{tag}-impl.png'
                sfx = ('?' + q) if q else ''
                ourl = f'http://127.0.0.1:{PORT}/reference/src/{n}/{n}.dc.html'
                if q:   # 원본 런타임은 주소 쿼리를 안 읽는다 → 비교용 사본에서 data-props 기본값만 바꿔 같은 상태를 그리게 한다(원본 파일은 그대로)
                    d = f'{out}/orig-src/{tag}'; shutil.copytree(f'{ROOT}/reference/src/{n}', d)
                    html = open(f'{d}/{n}.dc.html', encoding='utf-8').read()
                    m = re.search(r"data-props='([^']*)'", html); spec = json.loads(m.group(1))
                    for k, v in urllib.parse.parse_qsl(q): spec[k]['default'] = v
                    open(f'{d}/{n}.dc.html', 'w', encoding='utf-8').write(html[:m.start(1)] + json.dumps(spec, ensure_ascii=False) + html[m.end(1):])
                    ourl = f'http://127.0.0.1:{PORT}/{os.path.relpath(d, ROOT)}/{n}.dc.html'
                shot(ourl, w, h, a, prof)
                shot(f'http://127.0.0.1:{PORT}/web/{n}.dc.html{sfx}', w, h, b, prof)
                A, B = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
                d = ImageChops.difference(A, B) if A.size == B.size else None
                px = sum(1 for p in d.getdata() if max(p) > 16) if d else -1
                if d and px: d.point(lambda v: 255 if v > 16 else 0).save(f'{out}/{tag}-diff.png')
                r = {'screen': n, 'query': q, 'size': [w, h], 'diff_px': px, 'diff_ratio': round(px / (w * h), 5) if px >= 0 else None}
                res.append(r); print(json.dumps(r, ensure_ascii=False))
    finally:
        srv.terminate(); srv.wait(5); shutil.rmtree(prof, ignore_errors=True)
    json.dump(res, open(f'{out}/results.json', 'x'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == '--tall':   # 창 높이를 늘려 시안 높이 아래로 넘치는 부분까지 대조: compare.py --tall 2200 <폴더> [화면…]
        T = int(a[1]); a = a[2:]
        SCREENS = {k: (w, max(h, T), q) for k, (w, h, q) in SCREENS.items()}
    main(a[0], a[1:] or list(SCREENS))

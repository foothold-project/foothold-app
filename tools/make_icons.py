#!/usr/bin/env python3
"""홈 화면 아이콘(web/icons/) 만들기 — 시안 로고(산 모양 선 + 점, #38C6D9)를 어두운 바탕(#05080A)에. 다시 만들 때만 실행."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'web' / 'icons'
PATH = [(3, 23), (10, 9), (14, 16), (18, 6), (25, 23)]      # 시안 svg: M3 23 L10 9 L14 16 L18 6 L25 23 Z (28×28)
for name, n in [('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)]:
    k = 4                                                     # 4배로 그린 뒤 줄여 가장자리를 부드럽게
    S = n * k; im = Image.new('RGB', (S, S), '#05080A'); d = ImageDraw.Draw(im)
    sc, off = S * 0.62 / 28, S * 0.19                         # 가운데 62% (홈 화면 둥근 모서리에 잘리지 않게)
    P = [(off + x * sc, off + y * sc) for x, y in PATH]
    d.line(P + [P[0]], fill='#38C6D9', width=max(2, int(2.2 * sc)), joint='curve')
    cx, cy, r = off + 18 * sc, off + 6 * sc, 2.4 * sc
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill='#38C6D9')
    im.resize((n, n), Image.LANCZOS).save(OUT / name, optimize=True)
    print(OUT / name)

"""브랜드 공식 래스터 → Android/iOS 앱 아이콘 파생 (모양은 그대로, 여백·배경만 용도별로).

출처: foothold-project/foothold-brand 7afd2416d266f9a2d6d6166c66e576eacef524b9
  assets/raster/v1/logo/foothold-favicon.png        512x512  (원본: assets/logo/v1/foothold-favicon.svg)
  assets/raster/v1/logo/foothold-symbol-brand.png   512x587  (원본: assets/logo/v1/foothold-symbol-brand.svg)
sha256 은 브랜드 assets/raster/v1/manifest.json 값과 같아야 한다. 다르면 아무것도 쓰지 않고 멈춘다.
하는 일: 축소(LANCZOS)·가운데 배치·배경 채움뿐이다. 다시 그리기·늘이기·색 바꾸기는 하지 않는다(BRAND_USAGE_POLICY).
사용: python3 -I scripts/make-icons.py <브랜드 PNG 두 개가 든 폴더>   (mobile 폴더에서)
"""
import hashlib
import sys
from pathlib import Path

from PIL import Image

SHA = {
    'foothold-favicon.png': 'fdfa03e1841ac819eed6edb61ab946978198c729fd826fc9bfd372deb7a945d7',
    'foothold-symbol-brand.png': 'a2f555a4fab67d4e2ba46c0ca8625d857d672ee88347098cafb7b7aa8c01ef7d',
}
PAPER = (0xF6, 0xF5, 0xF1, 255)          # favicon.svg 바탕 rect 색 그대로
RES = Path('android/app/src/main/res')
DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def load(src, name):
    raw = (src / name).read_bytes()
    got = hashlib.sha256(raw).hexdigest()
    if got != SHA[name]:
        sys.exit(f'{name} sha256 불일치: {got}')
    return Image.open(src / name).convert('RGBA')


def place(mark, size, diag, bg=None, circle=False):
    """mark 의 잉크 상자를 대각선 = size*diag 로 축소(비율 유지)해 가운데 둔다. bg 는 배경색(없으면 투명)."""
    w, h = mark.size
    k = size * diag / (w * w + h * h) ** 0.5
    m = mark.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    if bg:
        if circle:
            disk = Image.new('L', (size * 4, size * 4), 0)
            from PIL import ImageDraw
            ImageDraw.Draw(disk).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
            out.paste(Image.new('RGBA', (size, size), bg), (0, 0), disk.resize((size, size), Image.LANCZOS))
        else:
            out.paste(Image.new('RGBA', (size, size), bg), (0, 0))
    out.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return out


def main(src):
    fav = load(src, 'foothold-favicon.png')
    sym = load(src, 'foothold-symbol-brand.png')
    ink = sym.crop(sym.getbbox())           # 투명 여백만 잘라냄(잉크 비율 그대로)
    for d, s in DENS.items():
        dst = RES / f'mipmap-{d}'
        n = round(48 * s)
        fav.resize((n, n), Image.LANCZOS).save(dst / 'ic_launcher.png')          # 공식 favicon 그대로 축소
        place(ink, n, 0.72, PAPER, circle=True).save(dst / 'ic_launcher_round.png')
        f = round(108 * s)                  # 적응형 전경 108dp, 안전 원 지름 66dp 안에 잉크 대각선(≈0.6)
        place(ink, f, 0.60).save(dst / 'ic_launcher_foreground.png')
    # iOS 는 OS 가 모서리를 깎는다 → 꽉 찬 정사각 + 불투명(앱스토어는 알파 금지)
    place(ink, 1024, 0.72, PAPER).convert('RGB').save(
        'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')
    print('아이콘 파생 완료')


if __name__ == '__main__':
    main(Path(sys.argv[1]))

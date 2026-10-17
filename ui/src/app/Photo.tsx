// 서버 사진 하나 — 웹은 주소 그대로, 네이티브(B)는 FhGate.photo → blob: (바뀌거나 떠나면 revoke).
// 못 읽으면 빈 칸 + «사진 미확인»(다른 사진·시안 그림으로 채우지 않음).
import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { T } from '../data/transport';

export function Photo({ src, ...p }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [u, setU] = useState<string | null>(T.kind === 'web' ? src : null);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (T.kind === 'web') { setU(src); return; }
    let live = true, made: string | null = null;
    setU(null); setBad(false);
    T.photo(src).then((x) => { if (!live) { if (x) URL.revokeObjectURL(x); return; } made = x; setU(x); setBad(!x); }, () => live && setBad(true));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [src]);
  return u ? <img src={u} {...p} /> : <span role="img" aria-label={bad ? '사진 미확인' : '사진 읽는 중'} title={bad ? '사진 미확인' : ''} style={{ ...p.style, display: 'block' }} />;
}

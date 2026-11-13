// 조종 화면 «쌓이는 라이다» 지도(11-13 RB-MAP-VIEW-WEB): drivemedia.ts 가 쌓아 둔 점을 위에서 본 그림으로(x 오른쪽·y 위 — 지도 만들기 창 그림과 같은 방향).
// 색 = 로봇 기준 높이, 로봇 화살표 + 지나온 길. 바뀐 때만 0.5초에 한 번 다시 그림(끌기·확대는 화면 한 장에 한 번). 그림만 — 명령 0.
import { useEffect, useRef, useState } from 'react';
import { CELL_M, type DriveFeed } from './drivemedia';
import { QEmpty, hue } from './quad';

/** 처음 보이는 범위(로봇 둘레 ±m) · 확대 한계(화면 px / m) */
const SPAN_M = 10, K_MIN = 4, K_MAX = 400;
const ZL = -1, ZH = 1, N = 64;
/** 높이 색표(hsl(hue 80% 60%) → 화소 ABGR) — 점마다 글자 색을 만들지 않게 */
const LUT = Uint32Array.from({ length: N }, (_, i) => {
  const h = hue(ZL + (i / (N - 1)) * (ZH - ZL)), a = 0.8 * 0.4, f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (0.6 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return (0xff000000 | (f(4) << 16) | (f(8) << 8) | f(0)) >>> 0;
});

export function LidarMap({ feed, empty }: { feed: DriveFeed; empty: string }) {
  const cv = useRef<HTMLCanvasElement>(null), cur = useRef(feed), [free, setFree] = useState(false);
  const view = useRef({ x: 0, y: 0, k: 0, follow: true, ver: -1, w: 0, h: 0 }), redraw = useRef(() => {});
  cur.current = feed;
  useEffect(() => {
    const el = cv.current!, v = view.current;
    let img: ImageData | null = null;
    const draw = redraw.current = () => {
      const dpr = window.devicePixelRatio || 1, W = Math.round(el.clientWidth * dpr), H = Math.round(el.clientHeight * dpr), c = cur.current;
      v.ver = c.ver; v.w = el.clientWidth; v.h = el.clientHeight;
      const g = W && H ? el.getContext('2d') : null;
      if (!g) return;
      if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
      if (!img || img.width !== W || img.height !== H) img = g.createImageData(W, H);
      if (v.follow && c.pose) { v.x = c.pose.x; v.y = c.pose.y; }
      const k = (v.k ||= Math.min(el.clientWidth, el.clientHeight) / (SPAN_M * 2)) * dpr, px = new Uint32Array(img.data.buffer), z0 = c.pose?.z ?? 0;
      const r = Math.max(1, Math.min(8, Math.ceil(CELL_M * k))), X = (x: number) => W / 2 + (x - v.x) * k, Y = (y: number) => H / 2 - (y - v.y) * k;
      px.fill(0);
      for (let i = 0; i < c.n; i++) {
        const u = Math.floor(X(c.xyz[i * 3])), w = Math.floor(Y(c.xyz[i * 3 + 1]));
        if (u < 0 || w < 0 || u + r > W || w + r > H) continue;
        const col = LUT[Math.max(0, Math.min(N - 1, Math.round(((c.xyz[i * 3 + 2] - z0 - ZL) / (ZH - ZL)) * (N - 1))))];
        for (let b = 0; b < r; b++) for (let a = 0; a < r; a++) px[(w + b) * W + u + a] = col;
      }
      g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(img, 0, 0);
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2 * dpr; g.beginPath();
      for (let i = 0; i < c.path.length; i += 2) { if (i) g.lineTo(X(c.path[i]), Y(c.path[i + 1])); else g.moveTo(X(c.path[i]), Y(c.path[i + 1])); }
      g.stroke();
      if (c.pose) {   // 로봇: 앞을 가리키는 화살표
        const s = 9 * dpr, t = -c.pose.yaw;   // 화면 y 는 아래로
        g.save(); g.translate(X(c.pose.x), Y(c.pose.y)); g.rotate(t);
        g.fillStyle = getComputedStyle(el).getPropertyValue('--warn').trim() || '#e90'; g.strokeStyle = '#fff'; g.lineWidth = dpr;
        g.beginPath(); g.moveTo(s * 1.6, 0); g.lineTo(-s, s * 0.9); g.lineTo(-s * 0.4, 0); g.lineTo(-s, -s * 0.9); g.closePath(); g.fill(); g.stroke(); g.restore();
      }
    };
    const t = setInterval(() => { if (cur.current.ver !== v.ver || el.clientWidth !== v.w || el.clientHeight !== v.h) draw(); }, 500);
    let d: null | { id: number; x: number; y: number; vx: number; vy: number } = null, raf = 0;
    const soon = () => { raf ||= requestAnimationFrame(() => { raf = 0; draw(); }); };
    const down = (e: PointerEvent) => { if (d || !v.k) return; d = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: v.x, vy: v.y }; try { el.setPointerCapture(e.pointerId); } catch { /* 없음 */ } };
    const move = (e: PointerEvent) => {
      if (!d || e.pointerId !== d.id) return;
      v.x = d.vx - (e.clientX - d.x) / v.k; v.y = d.vy + (e.clientY - d.y) / v.k;
      if (v.follow) { v.follow = false; setFree(true); }
      soon();
    };
    const end = (e?: PointerEvent) => { if (d && (!e || e.pointerId === d.id)) d = null; };
    const wheel = (e: WheelEvent) => { if (!v.k) return; e.preventDefault(); v.k = Math.max(K_MIN, Math.min(K_MAX, v.k * Math.exp(-e.deltaY * 0.0015))); soon(); };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
    draw();
    return () => {
      clearInterval(t); cancelAnimationFrame(raf); el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('wheel', wheel);
      el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); el.removeEventListener('lostpointercapture', end);
    };
  }, []);
  const back = () => { view.current.follow = true; setFree(false); redraw.current(); };
  return <div style={{ position: 'absolute', inset: 0 }} data-lidar-map={feed.n} data-path={feed.path.length / 2}>
    <canvas ref={cv} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: 'grab' }} aria-label="라이다로 그린 지도 — 위에서 본 그림(끌어서 옮기고 휠로 확대)" />
    <div className="fh-row" style={{ position: 'absolute', left: 8, top: 8 }}>
      <button type="button" className="btn" data-lm-wipe onClick={() => { feed.wipe(); back(); }}>처음부터 다시</button>
      {free && <button type="button" className="btn" data-lm-back onClick={back}>로봇 위치로</button>}
    </div>
    {empty && (feed.n ? <div className="qd-legend" role="status" style={{ right: 'auto', left: 8 }}>{empty}</div> : <QEmpty text={empty} />)}
    <div className="qd-legend" aria-label="점 높이 범례">
      <div style={{ height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `hsl(${hue(ZL + t * (ZH - ZL))} 80% 60%)`).join(',')})` }} />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{`${ZL} m`}</span><span>로봇 높이</span><span>{`+${ZH} m`}</span></div>
      <div>{`색 = 로봇 기준 높이 · 점 ${feed.n.toLocaleString('ko-KR')}`}</div></div>
  </div>;
}

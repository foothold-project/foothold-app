// 조종 화면 지도 칸 «걸으며 만드는 지도»(11-20 RB-SLAM-GRID-WEB): occgrid.ts 격자를 흰(빈 바닥)·검정(벽)·회색(모름)으로, 파란 지나온 길 + 주황 로봇 화살표.
// x 오른쪽·y 위(위에서 본 그림과 같은 방향). 끌기 = 옮기기, 휠 = 확대. 바뀐 때만 0.5초에 한 번 다시 그림(끌기·확대는 화면 한 장에 한 번), 탭이 숨으면 멈춤. 그림만 — 명령 0.
import { useEffect, useRef, useState } from 'react';
import type { DriveFeed } from './drivemedia';
import { GRID_RES, SHOW_OCC, cellState } from './occgrid';
import { QEmpty } from './quad';

/** 처음 보이는 범위(로봇 둘레 ±m) · 확대 한계(화면 px / m) */
const SPAN_M = 6, K_MIN = 4, K_MAX = 400;
/** 칸 색(화소 ABGR): 모름 회색 · 빈 바닥 흰색 · 벽 검정 */
const RGB = [[158, 158, 158], [255, 255, 255], [20, 20, 26]], COL = Uint32Array.from(RGB, ([r, g, b]) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0);
const css = (c: number[]) => `rgb(${c.join(',')})`;

/** small = 작은 칸(그림만 — 단추·범례 없음) */
export function OccMap({ feed, empty, small = false }: { feed: DriveFeed; empty: string; small?: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null), cur = useRef(feed), sm = useRef(small), [free, setFree] = useState(false);
  const view = useRef({ x: 0, y: 0, k: 0, follow: true, ver: -1, w: 0, h: 0 }), redraw = useRef(() => {});
  cur.current = feed; sm.current = small;
  useEffect(() => {
    const el = cv.current!, v = view.current;
    let img: ImageData | null = null;
    const draw = redraw.current = () => {
      const dpr = window.devicePixelRatio || 1, W = Math.round(el.clientWidth * dpr), H = Math.round(el.clientHeight * dpr), c = cur.current, gr = c.grid;
      v.ver = c.ver; v.w = el.clientWidth; v.h = el.clientHeight;
      const g = W && H ? el.getContext('2d') : null;
      if (!g) return;
      if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
      if (!img || img.width !== W || img.height !== H) img = g.createImageData(W, H);
      if (v.follow && c.pose) { v.x = c.pose.x; v.y = c.pose.y; }
      const k = (v.k ||= Math.min(el.clientWidth, el.clientHeight) / (SPAN_M * 2)) * dpr, px = new Uint32Array(img.data.buffer);
      const X = (x: number) => W / 2 + (x - v.x) * k, Y = (y: number) => H / 2 - (y - v.y) * k;
      px.fill(COL[0]);
      if (gr) {   // 화면 화소마다 그 자리 칸 — 열·행은 한 번씩만 계산
        const n = gr.size, cols = new Int32Array(W), L = gr.L;
        for (let u = 0; u < W; u++) { const q = Math.floor((v.x + (u + 0.5 - W / 2) / k) / GRID_RES) - gr.c0; cols[u] = q >= 0 && q < n ? q : -1; }
        for (let w = 0; w < H; w++) {
          const r = Math.floor((v.y - (w + 0.5 - H / 2) / k) / GRID_RES) - gr.r0;
          if (r < 0 || r >= n) continue;
          for (let u = 0, o = w * W, b = r * n; u < W; u++) if (cols[u] >= 0) px[o + u] = COL[cellState(L[b + cols[u]])];
        }
        // 벽 우선(RV-438 ②): 줄여 그리면(1 px > 1 칸) 화소 가운데 칸만 봐서는 가는 벽이 사라짐 — 보이는 벽 칸마다 그 칸 가운데가 든 화소를 검정으로
        const cl = (a: number) => Math.max(0, Math.min(n - 1, a)), hw = W / 2 / k, hh = H / 2 / k;
        const qa = cl(Math.floor((v.x - hw) / GRID_RES) - gr.c0), qb = cl(Math.floor((v.x + hw) / GRID_RES) - gr.c0);
        for (let r = cl(Math.floor((v.y - hh) / GRID_RES) - gr.r0), rb = cl(Math.floor((v.y + hh) / GRID_RES) - gr.r0); r <= rb; r++) {
          const w = Math.floor(H / 2 - ((r + gr.r0 + 0.5) * GRID_RES - v.y) * k);
          if (w < 0 || w >= H) continue;
          for (let q = qa, b = r * n; q <= qb; q++) if (L[b + q] > SHOW_OCC) {
            const u = Math.floor(W / 2 + ((q + gr.c0 + 0.5) * GRID_RES - v.x) * k);
            if (u >= 0 && u < W) px[w * W + u] = COL[2];
          }
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(img, 0, 0);
      const st = getComputedStyle(el);
      g.strokeStyle = st.getPropertyValue('--accent').trim() || '#2a7de1'; g.lineWidth = 2 * dpr; g.beginPath();
      for (let i = 0; i < c.path.length; i += 2) { if (i) g.lineTo(X(c.path[i]), Y(c.path[i + 1])); else g.moveTo(X(c.path[i]), Y(c.path[i + 1])); }
      g.stroke();
      if (c.pose) {   // 로봇: 앞을 가리키는 화살표(화면 y 는 아래로)
        const s = 9 * dpr;
        g.save(); g.translate(X(c.pose.x), Y(c.pose.y)); g.rotate(-c.pose.yaw);
        g.fillStyle = st.getPropertyValue('--warn').trim() || '#e90'; g.strokeStyle = '#fff'; g.lineWidth = dpr;
        g.beginPath(); g.moveTo(s * 1.6, 0); g.lineTo(-s, s * 0.9); g.lineTo(-s * 0.4, 0); g.lineTo(-s, -s * 0.9); g.closePath(); g.fill(); g.stroke(); g.restore();
      }
    };
    const t = setInterval(() => { if (!document.hidden && (cur.current.ver !== v.ver || el.clientWidth !== v.w || el.clientHeight !== v.h)) draw(); }, 500);
    let d: null | { id: number; x: number; y: number; vx: number; vy: number } = null, raf = 0;
    const soon = () => { raf ||= requestAnimationFrame(() => { raf = 0; draw(); }); };
    const down = (e: PointerEvent) => { if (sm.current || d || !v.k) return; d = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: v.x, vy: v.y }; try { el.setPointerCapture(e.pointerId); } catch { /* 없음 */ } };
    const move = (e: PointerEvent) => {
      if (!d || e.pointerId !== d.id) return;
      v.x = d.vx - (e.clientX - d.x) / v.k; v.y = d.vy + (e.clientY - d.y) / v.k;
      if (v.follow) { v.follow = false; setFree(true); }
      soon();
    };
    const end = (e?: PointerEvent) => { if (d && (!e || e.pointerId === d.id)) d = null; };
    const wheel = (e: WheelEvent) => { if (sm.current || !v.k) return; e.preventDefault(); v.k = Math.max(K_MIN, Math.min(K_MAX, v.k * Math.exp(-e.deltaY * 0.0015))); soon(); };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
    draw();
    return () => {
      clearInterval(t); cancelAnimationFrame(raf); el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('wheel', wheel);
      el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); el.removeEventListener('lostpointercapture', end);
    };
  }, []);
  const back = () => { view.current.follow = true; setFree(false); redraw.current(); };
  const known = feed.grid ? feed.grid.free + feed.grid.wall : 0;
  return <div style={{ position: 'absolute', inset: 0 }} data-occ-map={known} data-occ-wall={feed.grid?.wall ?? 0} data-path={feed.path.length / 2}>
    <canvas ref={cv} style={{ width: '100%', height: '100%', display: 'block', touchAction: small ? 'auto' : 'none', cursor: small ? undefined : 'grab' }}
      aria-label={`걸으며 만드는 지도${small ? '' : '(끌어서 옮기고 휠로 확대)'}`} />
    {!small && <div className="fh-row" style={{ position: 'absolute', left: 8, top: 8 }}>
      <button type="button" className="btn" data-occ-wipe onClick={() => feed.wipe()}>처음부터 다시</button></div>}
    {free && !small && <button type="button" className="btn" data-occ-back style={{ position: 'absolute', left: 8, bottom: 8 }} onClick={back}>로봇 위치로</button>}
    {empty && (known ? <div className="qd-legend" role="status" style={{ right: 'auto', left: 8, top: 52, bottom: 'auto' }}>{empty}</div> : <QEmpty text={empty} />)}
    {!small && <div className="qd-legend" aria-label="지도 범례" data-occ-legend>
      {(['빈 바닥', '벽·물건', '아직 못 본 곳'] as const).map((t, i) =>
        <span key={t} style={{ marginRight: 8, whiteSpace: 'nowrap' }}><i style={{ display: 'inline-block', width: 9, height: 9, marginRight: 3, verticalAlign: -1, background: css(RGB[(i + 1) % 3]), border: '1px solid rgba(255,255,255,.5)' }} />{t}</span>)}
    </div>}
  </div>;
}

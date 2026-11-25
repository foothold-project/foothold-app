// 조종 화면 라이다 칸(11-13 RB-MAP-VIEW-WEB): drivemedia.ts 가 준 한 판의 점을 위에서 본 그림으로(11-25 RB-SLAM-WEB3: 판을 쌓지 않음)(x 오른쪽·y 위 — 지도 만들기 창 그림과 같은 방향).
// 11-19 RB-LIDAR-3D: 기본은 3D(lidar3d.tsx), «위에서» 단추로 이 그림. WebGL 이 없으면 이 그림만.
// 색 = 바닥부터 높이(3D 와 같은 색표 — lidar3d.tsx, 같은 자리에 겹치면 높은 점이 위 — 벽이 바닥에 묻히지 않게), 로봇 화살표. 바뀐 때만 0.5초에 한 번 다시 그림(끌기·확대는 화면 한 장에 한 번). 그림만 — 명령 0.
// 11-20 RB-UNITREE-LOOK-WEB: 3D 는 높은 점도 그리고, 이 그림만 로봇보다 CEIL_M 넘게 높은 점(천장)을 숨긴다 — 천장이 바닥 그림을 덮지 않게.
import { useEffect, useRef, useState } from 'react';
import { CEIL_M, CELL_M, driveFeedHeld, type DriveFeed } from './drivemedia';
import { FLOOR_DZ, HeightLegend, Lidar3D, levelOf, rgbOf, type Look } from './lidar3d';
import type { Pose } from './go2model';
import { QEmpty } from './quad';

/** 처음 보이는 범위(로봇 둘레 ±m) · 확대 한계(화면 px / m) */
const SPAN_M = 6, K_MIN = 4, K_MAX = 400;
/** 높이 색표(3D 와 같음 → 화소 ABGR) — 점마다 글자 색을 만들지 않게 */
const LUT = Uint32Array.from({ length: 64 }, (_, i) => { const [r, g, b] = rgbOf(i); return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0; });

/** small = 작은 칸(단추·범례 없이 보기만), start = 처음 보기(지도 칸은 위에서), tag = false 면 «마지막 그림» 표시를 칸 머리줄이 대신 띄움(PC 4칸 큰 칸).
 *  look = 3D 를 점(라이다)·상자(«상자» 보기)로, pick = «보기» 줄에 «상자»도(PC 4칸 — 같은 3D 그림에서 모양만 바꿈), go2 = 3D 속 Go2 관절각·기울기(lidar3d.tsx — 11-20 RB-UNITREE-LOOK-FIX) */
export function LidarMap({ feed, empty, small = false, start = '3d', tag = true, look = 'points', pick = false, go2 = null }: { feed: DriveFeed; empty: string; small?: boolean; start?: '3d' | 'top'; tag?: boolean; look?: Look; pick?: boolean; go2?: Pose }) {
  const [mode, setMode] = useState<'3d' | 'box' | 'top'>(start), [no3d, setNo3d] = useState(false), is3d = mode !== 'top' && !no3d;
  return <div style={{ position: 'absolute', inset: 0 }} data-lidar-map={feed.n} data-lm-mode={is3d ? '3d' : 'top'}>
    {is3d ? <Lidar3D feed={feed} small={small} look={mode === 'box' ? 'boxes' : look} go2={go2} onFail={() => setNo3d(true)} /> : <TopView feed={feed} small={small} />}
    {!small && <div className="fh-row" style={{ position: 'absolute', left: 8, top: 8, flexWrap: 'wrap' }}>
      {!no3d && <div className="fh-row" role="group" aria-label="보기">{(pick ? ['3d', 'box', 'top'] as const : ['3d', 'top'] as const).map((m) =>
        <button key={m} type="button" className="btn" aria-pressed={mode === m} data-lm-view={m} onClick={() => setMode(m)}>{m === '3d' ? '3D' : m === 'box' ? '상자' : '위에서'}</button>)}</div>}
    </div>}
    {no3d && !small && <div className="qd-legend" role="status" style={{ right: 'auto', left: 8, top: 52, bottom: 'auto' }} data-lm-no3d>이 브라우저는 3D 를 그릴 수 없어 위에서 본 그림으로 보입니다</div>}
    {empty && (feed.n ? tag && <HeldTag text={driveFeedHeld(feed)} /> : <QEmpty text={empty} />)}
    {!small && !is3d && <HeightLegend />}
  </div>;
}

/** 끊긴 뒤 남겨 둔 마지막 그림 위 오른쪽 구석 표시(카메라·뎁스·라이다 같은 꼴) — 매초 바뀌므로 읽어 주는 영역(role=status)으로 두지 않는다 */
export function HeldTag({ text }: { text: string }) {
  return text ? <div className="qd-legend" style={{ top: 8, bottom: 'auto', whiteSpace: 'pre-line' }} data-feed-held>{text}</div> : null;
}

/** 위에서 본 그림(11-13 그대로) — 끌어서 옮기고 휠로 확대 */
function TopView({ feed, small }: { feed: DriveFeed; small: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null), cur = useRef(feed), sm = useRef(small), [free, setFree] = useState(false);
  const view = useRef({ x: 0, y: 0, k: 0, follow: true, ver: -1, w: 0, h: 0, frame: feed.frame }), redraw = useRef(() => {});
  cur.current = feed; sm.current = small;   // 칸 크기가 바뀌면 끌기·휠도 새 값으로
  useEffect(() => {
    const el = cv.current!, v = view.current;
    let img: ImageData | null = null, top = new Uint8Array(0);   // top = 그 화소에 이미 그린 높이 단계 + 1
    const draw = redraw.current = () => {
      const dpr = window.devicePixelRatio || 1, W = Math.round(el.clientWidth * dpr), H = Math.round(el.clientHeight * dpr), c = cur.current;
      v.ver = c.ver; v.w = el.clientWidth; v.h = el.clientHeight;
      const g = W && H ? el.getContext('2d') : null;
      if (!g) return;
      if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
      if (!img || img.width !== W || img.height !== H) { img = g.createImageData(W, H); top = new Uint8Array(W * H); }
      if (c.frame !== v.frame) { v.frame = c.frame; v.x = v.y = 0; if (!v.follow) { v.follow = true; setFree(false); } }   // 기준이 바뀌면 옛 중심은 뜻이 없다 — 원점·따라가기로
      if (v.follow && c.pose) { v.x = c.pose.x; v.y = c.pose.y; }
      const k = (v.k ||= Math.min(el.clientWidth, el.clientHeight) / (SPAN_M * 2)) * dpr, px = new Uint32Array(img.data.buffer), z0 = c.pose?.z ?? 0, ceil = z0 + CEIL_M;
      const r = Math.max(1, Math.min(8, Math.ceil(CELL_M * k))), X = (x: number) => W / 2 + (x - v.x) * k, Y = (y: number) => H / 2 - (y - v.y) * k;
      px.fill(0); top.fill(0);
      for (let i = 0; i < c.n; i++) {
        const u = Math.floor(X(c.xyz[i * 3])), w = Math.floor(Y(c.xyz[i * 3 + 1])), z = c.xyz[i * 3 + 2];
        if (u < 0 || w < 0 || u + r > W || w + r > H || z > ceil) continue;   // 천장 숨김 — 지금 로봇 높이 기준
        const zi = levelOf(z, z0 + FLOOR_DZ), col = LUT[zi];
        for (let b = 0; b < r; b++) for (let a = 0; a < r; a++) { const q = (w + b) * W + u + a; if (zi >= top[q]) { top[q] = zi + 1; px[q] = col; } }
      }
      g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(img, 0, 0);
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
  return <>
    <canvas ref={cv} style={{ width: '100%', height: '100%', display: 'block', touchAction: small ? 'auto' : 'none', cursor: small ? undefined : 'grab' }} aria-label={`라이다로 그린 지도 — 위에서 본 그림${small ? '' : '(끌어서 옮기고 휠로 확대)'}`} />
    {free && !small && <button type="button" className="btn" data-lm-back style={{ position: 'absolute', left: 8, bottom: 8 }} onClick={back}>로봇 위치로</button>}
  </>;
}

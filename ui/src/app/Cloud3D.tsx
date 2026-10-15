// 3D 점군 누적 보기(canvas 2D 정사영, 드래그로 돌려 봄). 데이터는 data/views.ts CLOUD — 바뀐 때·드래그 때만 다시 그림.
// 작은 칸은 일부(간격 추림)만 그린다. 로봇 표시 = 마지막 점군의 base_pose_map(map 프레임). Three.js 없이 충분(점 ≤30만, 정사영)
import { useEffect, useRef } from 'react';
import { CLOUD, type Scan } from '../data/views';

const LO = -0.5, HI = 2.0;   // 색 범위(로봇 기준 상대 높이 m)
export const hue = (dz: number) => Math.round(200 - Math.max(0, Math.min(1, (dz - LO) / (HI - LO))) * 170);
/** 높이 범례: 측정점 높이(map 프레임 z, 로봇 기준 상대) — 층 기준 높이·벽 전체 높이·위험 판정 아님 */
const LEGEND = <div aria-label="점 높이 범례" style={{ position: 'absolute', right: 8, bottom: 8, padding: '4px 6px', borderRadius: 6, background: 'rgba(0,0,0,.55)', color: '#DDE5EC', fontSize: 10, lineHeight: 1.3, pointerEvents: 'none', maxWidth: 220 }}>
  <div style={{ height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => `hsl(${hue(LO + t * (HI - LO))} 80% 60%)`).join(',')})` }} />
  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{`${LO} m`}</span><span>0</span><span>+1</span><span>{`+${HI} m 이상`}</span></div>
  <div>점 높이 = map z − 로봇 기준 z · 라이다 측정점(벽 전체 높이·위험 판정 아님)</div></div>;

export function Cloud3D({ small, bind, empty, big = false }: { small: boolean; bind: string; empty: string; big?: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null), view = useRef({ a: -0.6, b: 0.9, ver: -1, w: 0, h: 0 }), msg = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cv.current!, v = view.current;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, W = el.clientWidth, H = el.clientHeight, c = CLOUD, ok = !!bind && c.bind === bind && c.n > 0;   // 결속이 지금과 다르면 아무것도 안 그림
      if (!W || !H) return;
      if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) { el.width = Math.round(W * dpr); el.height = Math.round(H * dpr); }
      const g = el.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      v.ver = c.ver; v.w = W; v.h = H;
      if (msg.current) msg.current.textContent = ok ? '' : empty;
      if (!ok) return;
      const p = c.pose, cx = p ? p.x : 0, cy = p ? p.y : 0, cz = p ? p.z : 0, s = Math.min(W, H) / 22;   // 약 ±11 m 가 보임
      const ca = Math.cos(v.a), sa = Math.sin(v.a), cb = Math.cos(v.b), sb = Math.sin(v.b);
      const proj = (x: number, y: number, z: number) => { const X = (x - cx) * ca - (y - cy) * sa, Y = (x - cx) * sa + (y - cy) * ca; return [W / 2 + X * s, H / 2 - ((z - cz) * cb + Y * sb) * s]; };
      // 색 = 점 z − 로봇 기준 z(둘 다 map 프레임, m): −0.5 파랑 → +2.0 주황. 범례(LEGEND)와 같은 식 — 바꾸면 둘 다
      const step = Math.max(1, Math.ceil(c.n / (small ? 6000 : 60000))), r = small ? 1 : 1.6;
      for (let i = 0; i < c.n; i += step) {
        const z = c.xyz[i * 3 + 2], [u, w] = proj(c.xyz[i * 3], c.xyz[i * 3 + 1], z);
        if (u < 0 || w < 0 || u > W || w > H) continue;
        g.fillStyle = `hsl(${hue(z - cz)} 80% 60%)`;   // 낮음 파랑 → 높음 주황
        g.fillRect(u - r / 2, w - r / 2, r, r);
      }
      if (p) {                                    // 로봇: 흰 삼각형(머리 방향 = yaw)
        const [u, w] = proj(p.x, p.y, p.z), [u2, w2] = proj(p.x + Math.cos(p.yaw) * 0.6, p.y + Math.sin(p.yaw) * 0.6, p.z);
        g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(u, w, 4, 0, 7); g.moveTo(u, w); g.lineTo(u2, w2); g.stroke();
      }
    };
    const t = setInterval(() => { if (CLOUD.ver !== v.ver || el.clientWidth !== v.w || el.clientHeight !== v.h) draw(); }, 250);
    // 회전 드래그: 첫 손가락(pointerId) 하나만 · up/cancel/화면 숨김이면 끝 · 작은 칸은 회전 없음(폰 스크롤 그대로). 명령 0(그림만)
    let d: null | { id: number; x: number; y: number; a: number; b: number } = null;
    const down = (e: PointerEvent) => { if (small || d) return; d = { id: e.pointerId, x: e.clientX, y: e.clientY, a: v.a, b: v.b }; try { el.setPointerCapture(e.pointerId); } catch { /* 없음 */ } };
    const move = (e: PointerEvent) => { if (!d || e.pointerId !== d.id) return; v.a = d.a + (e.clientX - d.x) * 0.01; v.b = Math.max(0, Math.min(1.5, d.b + (e.clientY - d.y) * 0.01)); draw(); };
    const end = (e?: PointerEvent) => { if (d && (!e || e.pointerId === d.id)) d = null; };
    const vis = () => { if (document.hidden) end(); };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end); document.addEventListener('visibilitychange', vis);
    draw();
    return () => {
      clearInterval(t); el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); el.removeEventListener('lostpointercapture', end); document.removeEventListener('visibilitychange', vis);
    };
  }, [small, bind, empty]);
  return <div style={{ position: 'absolute', inset: 0 }}>
    <canvas ref={cv} style={{ width: '100%', height: '100%', display: 'block', touchAction: small ? 'auto' : 'none' }} aria-label="3D 점군 누적 보기(드래그로 회전)" />
    <div ref={msg} className="qd-empty" />{big && bind && LEGEND}</div>;
}

// ── raw 라이다 1 scan: 센서 원점 위에서 본 평면(위 = x 앞, 왼쪽 = y 왼쪽), ±10 m, 1 m 눈금. 색 = 센서 기준 높이 z(map 높이·로봇 pose 0). 누적 0
const LR = 10, ZL = -1, ZH = 1;
const hueL = (z: number) => Math.round(200 - Math.max(0, Math.min(1, (z - ZL) / (ZH - ZL))) * 170);
export function LidarTop({ scan, small }: { scan: Scan; small: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = cv.current!; let w0 = 0, h0 = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, W = el.clientWidth, H = el.clientHeight; w0 = W; h0 = H;
      if (!W || !H) return;
      if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) { el.width = Math.round(W * dpr); el.height = Math.round(H * dpr); }
      const g = el.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      const s = Math.min(W, H) / (2 * LR), cx = W / 2, cy = H / 2;
      for (let k = -LR; k <= LR; k++) {           // 1 m 눈금(5 m 마다 진하게)
        g.strokeStyle = k % 5 ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.18)'; g.lineWidth = 1; g.beginPath();
        g.moveTo(cx + k * s, cy - LR * s); g.lineTo(cx + k * s, cy + LR * s); g.moveTo(cx - LR * s, cy + k * s); g.lineTo(cx + LR * s, cy + k * s); g.stroke();
      }
      const f = scan.xyz, r = small ? 1.2 : 2;
      for (let i = 0; i < scan.n; i++) {
        const x = f[i * 3], y = f[i * 3 + 1];
        if (Math.abs(x) > LR || Math.abs(y) > LR) continue;
        g.fillStyle = `hsl(${hueL(f[i * 3 + 2])} 80% 60%)`; g.fillRect(cx - y * s - r / 2, cy - x * s - r / 2, r, r);
      }
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(cx, cy - 7); g.lineTo(cx - 5, cy + 5); g.lineTo(cx + 5, cy + 5); g.closePath(); g.fill();   // 센서 원점(위 = 앞)
    };
    draw();
    const t = setInterval(() => { if (el.clientWidth !== w0 || el.clientHeight !== h0) draw(); }, 250);
    return () => clearInterval(t);
  }, [scan, small]);
  return <div style={{ position: 'absolute', inset: 0 }} data-lidar-raw={scan.seq}>
    <canvas ref={cv} style={{ width: '100%', height: '100%', display: 'block' }} aria-label="실시간 라이다 1 scan, 센서 원점 위에서 본 평면(누적 없음)" />
    {!small && <div aria-label="라이다 범례" style={{ position: 'absolute', right: 8, bottom: 8, padding: '4px 6px', borderRadius: 6, background: 'rgba(0,0,0,.55)', color: '#DDE5EC', fontSize: 10, lineHeight: 1.3, pointerEvents: 'none', maxWidth: 240 }}>
      <div style={{ height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `hsl(${hueL(ZL + t * (ZH - ZL))} 80% 60%)`).join(',')})` }} />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{`${ZL} m`}</span><span>0</span><span>{`+${ZH} m`}</span></div>
      <div>색 = 센서 기준 높이(라이다 원점 z) · 위 = 로봇 앞 · 눈금 1 m · ±{LR} m</div>
      <div>{`1 scan · 점 ${scan.n}${scan.trunc ? ` / 원자료 ${scan.nRaw}(상한으로 일부)` : ''} · 지도·누적 아님`}</div></div>}</div>;
}

// 공용 지도(Canvas) — web/live.js mapView 를 옮김. 그리는 순서·색·글·data-view 표시는 원본 그대로.
// 시뮬 바닥 도면(±10 m, 1 m 격자) + 구역 + 경유점 + 지나온 길 + 로봇. 북쪽 위. 기본 로봇 중심(지도가 움직임), 손으로 끌면 따라가기 해제.
// 위치는 Gazebo 정답 위치(GT)이지 SLAM 지도가 아니다. 위치가 없으면 «위치 없음 · GT 미수신», 오래되면 «위치 오래됨 N s», 도면 밖이면 «도면 밖».
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ZoneEnv } from '@contracts';
import { ok, store } from '../data/fmt';
import type { Raster } from '../data/maps';

export const FLOOR = 10;   // online-20261012/gz/world_live.sdf: 평평한 바닥, 격자 선 −10~10 m
export type Mode = 'robot' | 'all' | 'free';
export type Robot = { x: number; y: number; yaw?: number | null; fallen?: boolean | null; t: number; fresh: boolean } | null;
export type Wp = { x: number; y: number; st?: string };
export const MODE_KO: Record<Mode, string> = { robot: '로봇 중심', all: '전체 보기', free: '손으로 옮김(◎ 로 복귀)' };

type Props = {
  name?: string; small?: boolean; mode?: Mode; zones?: ZoneEnv[]; wps?: Wp[] | null; trail?: number[][];
  robot?: Robot; noRobot?: boolean; showTrail?: boolean; showZones?: boolean; hiZone?: string | null; hiWp?: number | null;
  draft?: { type: string; pts: number[][] } | null; sel?: number[] | null; onTap?: (x: number, y: number, k: number) => void;
  btns?: boolean;
  raster?: Raster | null;   // 저장 지도 보기: 바닥 도면 대신 이 그림. 로봇·길·구역·경유점은 부르는 쪽이 끈다(좌표계 결속 전)
  api?: { current: MapApi | null };   // 화면의 자체 버튼(휴대폰 fab·레이어 서랍)이 보기 방식·확대를 바꿀 때   // live.js mapBtns(아이콘): 로봇 중심 · 전체 보기 · 확대 · 축소
};

export type MapApi = { mode: () => Mode; setMode: (m: Mode) => void; zoomBy: (f: number) => void };

export function MapCanvas(p: Props) {
  const cv = useRef<HTMLCanvasElement>(null);
  const V = useRef({ mode: (p.mode || (store.get<string>('fh.live.mapmode', 'robot') === 'all' ? 'all' : 'robot')) as Mode,   // 설정 «지도 기본 보기»(live.js 931)
    zoom: 1, c: [0, 0], kBase: 20, kFree: 20, k: 20, toWorld: (x: number, y: number) => [x, y] });
  const P = useRef(p); P.current = p;

  const draw = () => {
    const el = cv.current, box = el?.parentElement; if (!el || !box) return;
    const W = box.clientWidth, H = box.clientHeight; if (!W || !H) return;
    const v = V.current, o = P.current, dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) { el.width = Math.round(W * dpr); el.height = Math.round(H * dpr); }
    const g = el.getContext('2d'); if (!g) return; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(el), col = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    const C = { map: col('--map', '#0E1317'), bg: col('--bg', '#05080A'), line: col('--line2', '#34424D'), mut: col('--muted', '#9AA7B3'), acc: col('--accent', '#38C6D9'),
      bad: col('--bad', '#FF5A52'), warn: col('--warn', '#FFB547'), ok: col('--ok', '#5AA9FF') };
    const rs = o.raster, B = rs ? [rs.ox, rs.ox + rs.w * rs.res, rs.oy, rs.oy + rs.h * rs.res] : [-FLOOR, FLOOR, -FLOOR, FLOOR];   // 바탕 범위 x0 x1 y0 y1
    const r = o.noRobot ? null : o.robot || null, fr = !!r?.fresh, showTrail = o.showTrail !== false, pts = showTrail ? o.trail || [] : [], wps = o.wps || [];
    let cx: number, cy: number, kBase: number;
    if (v.mode === 'robot' && r) { cx = r.x; cy = r.y; kBase = Math.min(W, H) / (o.small ? 6 : 10); }
    else if (v.mode === 'free') { [cx, cy] = v.c; kBase = v.kFree; }
    else {   // 전체 보기(또는 위치가 아직 없을 때): 바닥 + 지나온 길 + 로봇 + 경유점이 다 들어오게
      const xs = [B[0], B[1], ...pts.map((q) => q[0]), ...wps.map((w) => w.x)], ys = [B[2], B[3], ...pts.map((q) => q[1]), ...wps.map((w) => w.y)];
      if (r) { xs.push(r.x); ys.push(r.y); }
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; kBase = Math.min(W / (x1 - x0 + 2), H / (y1 - y0 + 2));
    }
    const k = kBase * v.zoom; v.kBase = kBase; v.k = k; v.c = [cx, cy];
    const X = (x: number) => W / 2 + (x - cx) * k, Y = (y: number) => H / 2 - (y - cy) * k;
    v.toWorld = (px, py) => [cx + (px - W / 2) / k, cy - (py - H / 2) / k];
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    g.fillStyle = C.map; g.fillRect(X(B[0]), Y(B[3]), (B[1] - B[0]) * k, (B[3] - B[2]) * k);
    if (rs) {   // 어두운 테마: 반전(빈칸 어둡게·벽 밝게). ctx.filter 없는 브라우저는 원래 색
      const dark = /^#?[0-3]/.test(C.bg.replace('#', '')) || /rgb\(\s*\d{1,2}\s*,/.test(C.bg);
      g.save(); g.imageSmoothingEnabled = k < 1 / rs.res; if (dark) g.filter = 'invert(1) brightness(.85)';
      g.drawImage(rs.img, X(B[0]), Y(B[3]), (B[1] - B[0]) * k, (B[3] - B[2]) * k); g.restore();
    }   // PGM 첫 행 = y 큰 쪽(위)
    if (k >= 4) {
      g.strokeStyle = 'rgba(128,140,150,.22)'; g.lineWidth = 1; g.beginPath();
      for (let i = Math.max(Math.ceil(B[0]), Math.ceil(cx - W / 2 / k)); i <= Math.min(B[1], cx + W / 2 / k); i++) { g.moveTo(X(i), Y(B[3])); g.lineTo(X(i), Y(B[2])); }
      for (let j = Math.max(Math.ceil(B[2]), Math.ceil(cy - H / 2 / k)); j <= Math.min(B[3], cy + H / 2 / k); j++) { g.moveTo(X(B[0]), Y(j)); g.lineTo(X(B[1]), Y(j)); }
      g.stroke();
    }
    g.strokeStyle = C.line; g.lineWidth = 2; g.strokeRect(X(B[0]), Y(B[3]), (B[1] - B[0]) * k, (B[3] - B[2]) * k);
    const poly = (q: number[][]) => { g.beginPath(); q.forEach((a, i) => (i ? g.lineTo(X(a[0]), Y(a[1])) : g.moveTo(X(a[0]), Y(a[1])))); };
    g.font = '600 12px sans-serif';
    if (o.showZones !== false) for (const z of o.zones || []) {
      const c = z.doc.type === '금지' ? C.bad : C.warn; poly(z.doc.pts); g.closePath();
      g.globalAlpha = 0.18; g.fillStyle = c; g.fill(); g.globalAlpha = 1; g.strokeStyle = c; g.lineWidth = z.id === o.hiZone ? 3.5 : 1.5; g.stroke();
      if (!o.small) { const m = z.doc.pts.reduce((a, q) => [a[0] + q[0] / z.doc.pts.length, a[1] + q[1] / z.doc.pts.length], [0, 0]); g.fillStyle = c; g.fillText(`${z.doc.type} · ${z.doc.name}`, X(m[0]) - 20, Y(m[1])); }
    }
    if (o.draft && o.draft.pts.length) {
      const c = o.draft.type === '금지' ? C.bad : C.warn; poly(o.draft.pts); if (o.draft.pts.length > 2) g.closePath();
      g.setLineDash([6, 4]); g.strokeStyle = c; g.lineWidth = 2; g.stroke(); g.setLineDash([]);
      for (const q of o.draft.pts) { g.beginPath(); g.arc(X(q[0]), Y(q[1]), 4, 0, 7); g.fillStyle = c; g.fill(); }
    }
    if (wps.length) {
      g.setLineDash([6, 5]); g.strokeStyle = C.acc; g.lineWidth = 2; poly(wps.map((w) => [w.x, w.y])); g.stroke(); g.setLineDash([]);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      wps.forEach((w, i) => {
        const c = w.st === '방문' ? C.ok : w.st === '미방문' ? C.mut : C.acc;
        g.beginPath(); g.arc(X(w.x), Y(w.y), o.small ? 4 : i === o.hiWp ? 13 : 10, 0, 7); g.fillStyle = w.st === '방문' ? c : C.map; g.fill(); g.strokeStyle = c; g.lineWidth = 2; g.stroke();
        if (!o.small) { g.fillStyle = w.st === '방문' ? C.bg : c; g.fillText(w.st === '미방문' ? '×' : String(i + 1), X(w.x), Y(w.y) + 0.5); }
      });
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    }
    if (showTrail && pts.length > 1) { g.strokeStyle = C.acc; g.globalAlpha = 0.8; g.lineWidth = o.small ? 2 : 3; poly(pts); g.stroke(); g.globalAlpha = 1; }
    g.strokeStyle = C.mut; g.lineWidth = 1; g.beginPath(); g.moveTo(X(0) - 6, Y(0)); g.lineTo(X(0) + 6, Y(0)); g.moveTo(X(0), Y(0) - 6); g.lineTo(X(0), Y(0) + 6); g.stroke();
    if (o.sel) {
      const sx = X(o.sel[0]), sy = Y(o.sel[1]); g.fillStyle = C.acc;
      g.beginPath(); g.moveTo(sx, sy); g.arc(sx, sy - 16, 8, Math.PI * 0.8, Math.PI * 2.2); g.closePath(); g.fill(); g.beginPath(); g.arc(sx, sy - 16, 3, 0, 7); g.fillStyle = C.map; g.fill();
    }
    if (r) {
      g.save(); g.translate(X(r.x), Y(r.y)); if (ok(r.yaw)) g.rotate(-r.yaw);
      g.globalAlpha = fr ? 1 : 0.45; g.fillStyle = !fr ? C.mut : r.fallen === true ? C.bad : C.acc;
      const q = o.small ? 0.75 : 1; g.beginPath(); g.moveTo(14 * q, 0); g.lineTo(-10 * q, 9 * q); g.lineTo(-5 * q, 0); g.lineTo(-10 * q, -9 * q); g.closePath(); g.fill(); g.restore();
      const tags = [];
      if (!fr) tags.push(`위치 오래됨 ${((performance.now() - r.t) / 1000).toFixed(0)} s`);
      if (Math.abs(r.x) > FLOOR || Math.abs(r.y) > FLOOR) tags.push('도면 밖');   // 가두지 않고 그대로 그린다
      if (tags.length) { g.font = `600 ${o.small ? 10 : 12}px sans-serif`; g.fillStyle = C.warn; g.fillText(tags.join(' · '), X(r.x) + 12, Y(r.y) - 12); }
    } else if (!o.noRobot && !rs) { g.font = '600 13px sans-serif'; g.fillStyle = C.warn; g.textAlign = 'center'; g.fillText('위치 없음 · GT 미수신', W / 2, H / 2); g.textAlign = 'left'; }
    g.font = '600 11px sans-serif'; g.fillStyle = C.mut; g.textAlign = 'right'; g.fillText('N ↑', W - 8, H - 9); g.textAlign = 'left';
    if (!o.small) {
      const t = `${rs ? `위치 미표시(지도와 결속 안 됨) · ${rs.label} · 격자 1 m` : `격자 1 m · ${W < 520 ? '' : '바닥 ±10 m · '}${W < 520 ? 'GT 위치(SLAM 아님)' : 'Gazebo GT 위치(지도·SLAM 아님)'}`} · ${MODE_KO[v.mode]} ×${+v.zoom.toFixed(2)}${showTrail ? '' : ' · 길 숨김'}`;
      g.font = '12px sans-serif'; const w = g.measureText(t).width; g.globalAlpha = 0.75; g.fillStyle = C.bg; g.fillRect(4, H - 24, w + 10, 20); g.globalAlpha = 1; g.fillStyle = C.mut; g.fillText(t, 9, H - 9);
    }
    box.querySelectorAll<HTMLElement>('[data-m]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === v.mode)));   // live.js 1024: 눌림 = 지금 방식
    el.dataset.view = `${v.mode}|${+v.zoom.toFixed(2)}|${showTrail ? 'trail' : 'notrail'}|${r ? (fr ? 'fresh' : 'stale') : 'none'}${rs ? '|saved' : ''}`;   // 시험·상태 확인용
  };

  useLayoutEffect(draw);   // 값이 바뀔 때마다 다시 그림
  useEffect(() => {
    const el = cv.current!, box = el.parentElement!, ro = new ResizeObserver(draw); ro.observe(box);
    let drag: { id: number; x: number; y: number; c: number[]; moved: boolean } | null = null;
    const v = V.current;
    const down = (e: PointerEvent) => { if (e.button) return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY, c: v.c.slice(), moved: false }; el.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (!drag.moved) { drag.moved = true; if (v.mode !== 'free') { v.kFree = v.kBase; v.mode = 'free'; } }   // 손으로 끌면 따라가기 해제
      v.c = [drag.c[0] - dx / v.k, drag.c[1] + dy / v.k]; draw();
    };
    const up = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return; const d = drag; drag = null;
      const tap = P.current.onTap; if (!d.moved && tap) { const r = el.getBoundingClientRect(); const [x, y] = v.toWorld(e.clientX - r.left, e.clientY - r.top); tap(x, y, v.k); }
    };
    const cancel = () => { drag = null; };
    const wheel = (e: WheelEvent) => { if (P.current.small) return; e.preventDefault(); v.zoom = Math.min(8, Math.max(0.25, v.zoom * (e.deltaY < 0 ? 1.25 : 0.8))); draw(); };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', cancel);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', cancel); el.removeEventListener('wheel', wheel); };
  }, []);

  if (p.api) p.api.current = { mode: () => V.current.mode, setMode: (m) => { V.current.mode = m; V.current.zoom = 1; draw(); },
    zoomBy: (f) => { V.current.zoom = Math.min(8, Math.max(0.25, V.current.zoom * f)); draw(); } };
  const v = V.current, b = (t: string, label: string, f: () => void, m?: Mode) => <button type="button" className="lv-btn" data-m={m} aria-label={label} title={label} onClick={() => { f(); draw(); }}>{t}</button>;
  return <>
    <canvas ref={cv} data-live-map={p.name || '1'} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', ...(p.small ? { pointerEvents: 'none' } : { cursor: 'crosshair' }) }} />
    {p.btns && <div className="lv-mapbtns">
      {b('◎', '로봇 중심(지도가 따라 움직임)', () => { v.mode = 'robot'; v.zoom = 1; }, 'robot')}{b('⤢', '전체 보기', () => { v.mode = 'all'; v.zoom = 1; }, 'all')}
      {b('+', '확대', () => { v.zoom = Math.min(8, v.zoom * 1.5); })}{b('−', '축소', () => { v.zoom = Math.max(0.25, v.zoom / 1.5); })}
    </div>}
  </>;
}

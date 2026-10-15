// 건물 전체 3D — GT 간략 기하(RL v2_building_geom/1)만. canvas 2D 정사영 + 면 깊이 정렬(Three.js 없이, 상자 ≤ 2000), 드래그로 돌림.
// SLAM 격자·로봇·점군은 겹치지 않는다(좌표 출처 다름). 외곽 상자(mesh)는 실제 면이 아님 → 점선 외곽만(채움 0). 계단·경사로 = 구조상 연결 선만(통과 가능 표시 0)
import { useEffect, useRef, useState } from 'react';
import type { Geom } from '../data/geom';
import { FLOOR } from '../data/maps';

type V3 = number[];
const FACES = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];   // corners 순서 = x·y·z 비트(4·2·1) — RL make_geom.py
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
const corners = (a: number[]): V3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [a[i & 4 ? 3 : 0], a[i & 2 ? 4 : 1], a[i & 1 ? 5 : 2]]);

/** 보기: 'all' = 전체(층마다 다른 색) · 층 id = 그 층만. 층 색은 GT floor_id 정본만(null = 층 공통 구조 → 중립색, 높이로 층 지정 0).
 *  층만 보기: 다른 층 소속 0 · 층 공통 구조는 흐리게, 단 다음 층 높이 위에서 시작하는 것은 뺌(표시 거르기일 뿐 층 지정 아님). 좌표는 그대로 */
export function shown(fl: string | null, zmin: number, view: string, floors: { floor_id: string; z: number }[]): number {
  if (view === 'all') return fl === null ? 0.3 : 0.55;
  if (fl !== null) return fl === view ? 0.6 : 0;
  const fz = floors.find((f) => f.floor_id === view)?.z ?? 0, up = floors.filter((f) => f.z > fz).map((f) => f.z), next = up.length ? Math.min(...up) : Infinity;
  return zmin >= next - 1e-6 ? 0 : 0.2;
}
/** 층 색: floors 를 높이순으로 놓은 차례 → 고정 팔레트(1층 파랑·2층 자홍 …). 모르는 층 id·null = 중립 */
export const FLOOR_COL = ['#5AA9FF', '#E070C0', '#7BD389', '#C9A2FF', '#FF8A65', '#4DD0C8', '#B0BEC5', '#FFD54F'];
export const floorCol = (fl: string | null, floors: { floor_id: string; z: number }[], neutral: string) => {
  const i = fl === null ? -1 : [...floors].sort((a, b) => a.z - b.z).findIndex((f) => f.floor_id === fl);
  return i < 0 ? neutral : FLOOR_COL[i % FLOOR_COL.length];
};

export function Geom3D({ g, bind }: { g: Geom; bind: string }) {
  const cv = useRef<HTMLCanvasElement>(null), view = useRef({ a: -0.6, b: 0.9 });
  const [vw, setVw] = useState('all');   // 'all' = 전체(층 색 비교) · 층 id = 그 층만 — 보기만(시뮬 층 바꾸기 아님)
  useEffect(() => {
    const el = cv.current!, v = view.current;
    const xs = g.boxes.flatMap((b) => [b.aabb[0], b.aabb[3]]), ys = g.boxes.flatMap((b) => [b.aabb[1], b.aabb[4]]), zs = g.boxes.flatMap((b) => [b.aabb[2], b.aabb[5]]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, W = el.clientWidth, H = el.clientHeight; if (!W || !H) return;
      if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) { el.width = Math.round(W * dpr); el.height = Math.round(H * dpr); }
      const c = el.getContext('2d')!; c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cs = getComputedStyle(el), col = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
      const C = { bg: col('--bg', '#05080A'), line: col('--line2', '#34424D'), mut: col('--muted', '#9AA7B3'), acc: col('--accent', '#38C6D9'), warn: col('--warn', '#FFB547'), wall: col('--wall', '#4C5A66') };
      const NEU = col('--muted', '#9AA7B3'), FC = (fl: string | null) => floorCol(fl, g.floors, NEU);   // 색 = 층(GT floor_id) · 중립 = 층 공통 구조
      c.fillStyle = C.bg; c.fillRect(0, 0, W, H);
      const s = Math.min(W, H) / (span * 1.15), ca = Math.cos(v.a), sa = Math.sin(v.a), cb = Math.cos(v.b), sb = Math.sin(v.b);
      const P = (p: V3) => { const X = (p[0] - cx) * ca - (p[1] - cy) * sa, Y = (p[0] - cx) * sa + (p[1] - cy) * ca, z = p[2] - cz; return [W / 2 + X * s, H / 2 - (z * cb + Y * sb) * s, z * sb - Y * cb]; };   // [화면x, 화면y, 깊이(클수록 앞)]
      const fs: { d: number; q: number[][]; a: number; k: string }[] = [];
      for (const b of g.boxes) {
        const a = shown(b.floor_id, b.aabb[2], vw, g.floors); if (!a) continue;
        const pp = b.corners.map(P), k = FC(b.floor_id);
        for (const f of FACES) fs.push({ d: f.reduce((t, i) => t + pp[i][2], 0) / 4, q: f.map((i) => pp[i]), a: b.kind === 'floor' ? a * 0.7 : a, k });
      }
      fs.sort((p, q) => p.d - q.d);   // 뒤 → 앞(화가 알고리즘 — 상자끼리 관통하면 일부 어긋날 수 있음. ponytail: 정밀 가림 필요하면 z-buffer/WebGL)
      for (const f of fs) {
        c.beginPath(); f.q.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.closePath();
        c.globalAlpha = f.a * 0.5; c.fillStyle = f.k; c.fill(); c.globalAlpha = Math.min(1, f.a + 0.2); c.strokeStyle = f.k; c.lineWidth = 1; c.stroke();
      }
      c.globalAlpha = 1; c.setLineDash([5, 4]); c.strokeStyle = C.warn; c.lineWidth = 1.5;   // 외곽 상자(실제 모양 아님) — 점선만
      for (const m of g.meshes) {
        if (!shown(m.floor_id, m.aabb[2], vw, g.floors)) continue;
        const pp = corners(m.aabb).map(P); c.beginPath(); for (const [i, j] of EDGES) { c.moveTo(pp[i][0], pp[i][1]); c.lineTo(pp[j][0], pp[j][1]); } c.stroke();
      }
      c.setLineDash([]); c.globalAlpha = 1; c.font = '700 13px sans-serif';   // 층 직접 라벨: 그 층 소속 상자 범위 가운데, 층 바닥 높이(GT floors.z) — 좌표 그대로
      for (const fl of g.floors) {
        if (vw !== 'all' && vw !== fl.floor_id) continue;
        const bs = g.boxes.filter((b) => b.floor_id === fl.floor_id); if (!bs.length) continue;
        const mx = Math.max(...bs.map((b) => b.aabb[3])), my = Math.max(...bs.map((b) => b.aabb[4])), q = P([mx, my, fl.z]), t = FLOOR[fl.floor_id as keyof typeof FLOOR] || fl.floor_id;
        const tw = c.measureText(t).width; c.fillStyle = C.bg; c.fillRect(q[0] + 4, q[1] - 16, tw + 10, 20); c.fillStyle = FC(fl.floor_id); c.fillText(t, q[0] + 9, q[1]);
      }
      const CN = col('--text', '#E6EDF3'); c.strokeStyle = CN; c.fillStyle = CN; c.lineWidth = 3; c.font = '600 12px sans-serif';   // 연결 = 글자색(층 색·외곽 점선과 구분)
      for (const k of g.connectors) {   // 층 사이 구조상 연결: entry→exit 선 + 끝점
        const [p, q] = [P(k.entry), P(k.exit)]; c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke();
        for (const r of [p, q]) { c.beginPath(); c.arc(r[0], r[1], 4, 0, 7); c.fill(); }
        c.fillText(`${k.kind === 'stair' ? '계단' : '경사로'} · ${FLOOR[k.from as keyof typeof FLOOR] || k.from}↔${FLOOR[k.to as keyof typeof FLOOR] || k.to} 구조상 연결`, (p[0] + q[0]) / 2 + 6, (p[1] + q[1]) / 2 - 6);
      }
    };
    let d: null | { id: number; x: number; y: number; a: number; b: number } = null;
    const down = (e: PointerEvent) => { if (d) return; d = { id: e.pointerId, x: e.clientX, y: e.clientY, a: v.a, b: v.b }; try { el.setPointerCapture(e.pointerId); } catch { /* 없음 */ } };
    const move = (e: PointerEvent) => { if (!d || e.pointerId !== d.id) return; v.a = d.a + (e.clientX - d.x) * 0.01; v.b = Math.max(0, Math.min(1.5, d.b + (e.clientY - d.y) * 0.01)); draw(); };
    const end = (e?: PointerEvent) => { if (d && (!e || e.pointerId === d.id)) d = null; };
    const ro = new ResizeObserver(draw); ro.observe(el);
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
    el.dataset.floorView = vw; draw();   // floorView: 시험·상태 확인용
    return () => { ro.disconnect(); el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); el.removeEventListener('lostpointercapture', end); };
  }, [g, vw]);
  const nM = g.meshes.length, chip: React.CSSProperties = { fontSize: 11, lineHeight: 1.35, padding: '3px 6px', borderRadius: 4, background: 'rgba(0,0,0,.6)', color: '#DDE5EC' };
  return <>
    <canvas ref={cv} data-live-map="geom3d" aria-label="건물 전체 3D · GT 간략 기하(드래그로 회전)" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', cursor: 'grab' }} />
    <div style={{ position: 'absolute', left: 8, right: 64, bottom: 8, zIndex: 2, pointerEvents: 'none', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>{/* 왼쪽 아래 한 열 — 위쪽은 지도 화면 안내 카드, 오른쪽은 기존 확대·로봇 버튼 열 */}
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', pointerEvents: 'auto' }}>
      <span role="group" aria-label="3D 층 보기(보기만)" style={{ display: 'flex', gap: 4 }}>
        <button type="button" className="lv-btn" aria-pressed={vw === 'all'} style={{ minHeight: 32 }} onClick={() => setVw('all')}>전체 비교</button>
        {g.floors.map((f) => <button key={f.floor_id} type="button" className="lv-btn" aria-pressed={vw === f.floor_id} style={{ minHeight: 32 }} onClick={() => setVw(f.floor_id)}>{`${FLOOR[f.floor_id as keyof typeof FLOOR] || f.floor_id}만`}</button>)}</span>
    </div>
    <div aria-label="층 색 범례" style={{ ...chip, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {[...g.floors.map((f) => [FLOOR[f.floor_id as keyof typeof FLOOR] || f.floor_id, floorCol(f.floor_id, g.floors, '')] as const), ['층 공통 구조(층 미지정)', 'var(--muted)'] as const].map(([t, c]) =>
        <span key={t} style={{ display: 'flex', gap: 4, alignItems: 'center' }}><span style={{ width: 10, height: 10, borderRadius: 2, background: c }} />{t}</span>)}
      <span>{'색 = GT 층 소속(이동 가능 판정 아님)'}</span>
    </div>
    <div role="status" style={{ pointerEvents: 'none', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
      <span style={chip}>{`${g.label} · 상자 ${g.boxes.length}${nM ? ` · 외곽 점선 ${nM}(실제 mesh 미지원)` : ''}`}</span>
      <span style={chip}>{'계단·경사로 선 = 구조상 연결(통과 가능 아님)'}</span>
      <span style={chip}>{bind === 'ok' ? '● 지금 시뮬과 같은 world(기동 층 SDF sha 일치)' : 'GT 미리보기 — 이 건물 시뮬은 지금 안 열림'}</span>
    </div></div>
  </>;
}

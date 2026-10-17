// 리허설 설계도 그림(Canvas) — 편집기(MapEditor)·전체 관제(Fleet)·현장(Field) 공용. 계획 좌표만 그린다:
//   실제 로봇 위치·지나온 길(GT/odom)은 이 좌표와 정합 근거가 없어 여기에 얹지 않는다(10-18 root — 분리 패널 «좌표 정합 미확인»).
// 색은 브랜드 토큰(--ink·--ink-2·--brand·--note·--rule·--paper·--paper-2·--card·--stop)만 — 새 색 0. 로봇 구분 = R1… 표지 + 선 무늬 + 색 세 단계.
// 좌표: 화면 X = W/2 + (x − cx)·k, Y = H/2 − (y − cy)·k (북쪽 위, MapCanvas 와 같은 규칙).
import { useEffect, useLayoutEffect, useRef } from 'react';
import { scaleBar } from './MapCanvas';
import { type Analysis, type Issue, type Scenario, type Scene, type Sel, type Vec2, bgXf, inPoly, outline, segDist } from '../data/rehearsal';

export type Draft = { kind: 'wall' | 'route' | 'scale'; pts: Vec2[] } | null;
export type Focus = { at: Vec2; floor?: string; n: number } | null;
type Props = {
  scene: Scene; floor: string; sel?: Sel; scenario?: Scenario | null; analysis?: Analysis | null; issues?: Issue[];
  draft?: Draft; focus?: Focus; height: number | string; label: string;
  /** 누름: true 를 돌려주면 화면이 처리(끌기 등) · 아니면 지도 이동 */
  onDown?: (p: Vec2, e: React.PointerEvent, tol: number) => boolean | void;   // tol = 화면 8 px 를 m 로(누름 판정용)
  onMove?: (p: Vec2, e: React.PointerEvent) => void;
  onUp?: (p: Vec2, e: React.PointerEvent) => void;
  /** 취소(pointercancel·lostpointercapture): 화면이 끌던 것·미리보기를 버림(715 U4) */
  onCancel?: () => void;
};

/** 배치안 안 순서로 표지 R1…(배치안 없으면 설계도 순서). 무늬 = 실선·긴 점선·짧은 점선 */
export function robotTags(s: Scene, sc?: Scenario | null): Map<string, { tag: string; i: number }> {
  const ids = sc ? sc.robots : s.robots.map((r) => r.id);
  return new Map(ids.map((id, i) => [id, { tag: `R${i + 1}`, i }]));
}
export const DASH = [[], [10, 6], [3, 4]];

/** 누른 자리의 대상(로봇 > 장비 > 경로 > 요소). tol = 화면 8 px 를 m 로 */
export function hitTest(s: Scene, floor: string, p: Vec2, tol: number): Sel {
  const d = (q: Vec2) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  for (const r of s.robots) if (r.floor === floor && d([r.pose[0], r.pose[1]]) < Math.max(0.35, tol)) return { k: 'robot', id: r.id };
  for (const e of s.equipment) if (e.floor === floor && d([e.pose[0], e.pose[1]]) < Math.max(0.3, tol)) return { k: 'equip', id: e.id };
  for (const r of s.routes) if (r.floor === floor && r.points.some((q, i) => d(q) < tol || (i > 0 && segDist(p, r.points[i - 1], q) < tol))) return { k: 'route', id: r.id };
  for (let i = s.elements.length - 1; i >= 0; i--) {
    const e = s.elements[i];
    if (e.floor !== floor) continue;
    if (e.type === 'wall' ? segDist(p, e.a, e.b) < Math.max(e.thickness / 2, tol) : inPoly(p, outline(e))) return { k: 'el', id: e.id };
  }
  return null;
}

const TOK = ['--ink', '--ink-2', '--brand', '--note', '--rule', '--paper', '--paper-2', '--card', '--stop'] as const;
const FALL: Record<string, string> = { '--ink': '#161C26', '--ink-2': '#4A5260', '--brand': '#0E7A6E', '--note': '#A86A08', '--rule': '#D8D4CA', '--paper': '#F6F5F1', '--paper-2': '#EEECE6', '--card': '#FFFFFF', '--stop': '#A3342A' };
const imgCache = new Map<string, HTMLImageElement>();

export function SceneCanvas(p: Props) {
  const cv = useRef<HTMLCanvasElement>(null), box = useRef<HTMLDivElement>(null);
  const v = useRef({ cx: 0, cy: 0, k: 20, fitKey: '', pan: null as null | { x: number; y: number; cx: number; cy: number } });
  const P = useRef(p); P.current = p;
  const raf = useRef(0);

  const draw = () => {
    const c = cv.current, b = box.current; if (!c || !b) return;
    const { scene: s, floor, sel, scenario: sc, analysis: an, issues, draft } = P.current;
    const W = b.clientWidth, H = b.clientHeight, dpr = globalThis.devicePixelRatio || 1;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d'); if (!g) return;
    const cs = getComputedStyle(c), col = Object.fromEntries(TOK.map((t) => [t, cs.getPropertyValue(t).trim() || FALL[t]])) as Record<string, string>;
    const [ox, oy] = s.world.origin, [sx, sy] = s.world.size, fk = `${ox},${oy},${sx},${sy},${W},${H}`;
    const V = v.current;
    if (V.fitKey !== fk) { V.fitKey = fk; V.k = Math.max(2, Math.min((W - 32) / sx, (H - 32) / sy)); V.cx = ox + sx / 2; V.cy = oy + sy / 2; }
    const { k, cx, cy } = V, X = (x: number) => W / 2 + (x - cx) * k, Y = (y: number) => H / 2 - (y - cy) * k;
    const path = (q: Vec2[], close = true) => { g.beginPath(); q.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); if (close) g.closePath(); };
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = col['--paper-2']; g.fillRect(0, 0, W, H);
    g.fillStyle = col['--card']; g.fillRect(X(ox), Y(oy + sy), sx * k, sy * k);
    // 도면(이 층 것만) — 닮음 변환 그대로
    const bg = s.world.background, xf = bg && bg.floor === floor ? bgXf(bg) : null;
    if (bg && xf) {
      const key = bg.data_b64;   // 내용 전체가 key(715 비차단: 길이+앞뒤 64자는 다른 도면과 겹칠 수 있음) · 캐시는 1장만(아래 clear)
      let im = imgCache.get(key);
      if (!im) { im = new Image(); im.onload = () => schedule(); im.src = `data:${bg.mime};base64,${bg.data_b64}`; imgCache.clear(); imgCache.set(key, im); }
      if (im.complete && im.naturalWidth) {
        g.save(); g.globalAlpha = 0.45;
        g.setTransform(dpr * k * xf.ar, -dpr * k * xf.ai, dpr * k * xf.ai, dpr * k * xf.ar, dpr * (W / 2 + k * (xf.br - cx)), dpr * (H / 2 - k * (xf.bi - cy)));
        g.drawImage(im, 0, 0); g.restore(); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    // 격자(1 m · 너무 촘촘하면 5 m)
    const step = k >= 8 ? 1 : 5;
    g.save(); g.beginPath(); g.rect(X(ox), Y(oy + sy), sx * k, sy * k); g.clip();
    g.strokeStyle = col['--rule']; g.lineWidth = 1; g.beginPath();
    // 정수 번호로 세고 줄 수 상한(715 U1): 큰 원점에서 x+step===x 여도 반드시 끝남. 상한 넘는 값은 파서(drawBounds)가 먼저 거부
    const x0 = Math.ceil(ox / step) * step, y0 = Math.ceil(oy / step) * step, GMAX = 400;
    for (let i = 0; i <= GMAX && x0 + i * step <= ox + sx; i++) { const x = x0 + i * step; g.moveTo(X(x) + 0.5, Y(oy)); g.lineTo(X(x) + 0.5, Y(oy + sy)); }
    for (let i = 0; i <= GMAX && y0 + i * step <= oy + sy; i++) { const y = y0 + i * step; g.moveTo(X(ox), Y(y) + 0.5); g.lineTo(X(ox + sx), Y(y) + 0.5); }
    g.stroke(); g.restore();
    g.strokeStyle = col['--ink-2']; g.lineWidth = 1.5; g.strokeRect(X(ox), Y(oy + sy), sx * k, sy * k);
    // 아래층 요소(참고 · 흐리게)
    const fi = s.floors.findIndex((f) => f.id === floor), below = fi > 0 ? s.floors[fi - 1].id : null;
    if (below) { g.globalAlpha = 0.15; g.fillStyle = col['--ink-2']; for (const e of s.elements) if (e.floor === below) { path(outline(e)); g.fill(); } g.globalAlpha = 1; }
    // 요소
    for (const e of s.elements) {
      if (e.floor !== floor) continue;
      const o = outline(e); path(o);
      if (e.type === 'wall') { g.fillStyle = col['--ink']; g.fill(); }
      else if (e.type === 'box') { g.fillStyle = col['--paper-2']; g.fill(); g.strokeStyle = col['--ink-2']; g.lineWidth = 1.5; g.stroke(); g.beginPath(); g.moveTo(X(o[0][0]), Y(o[0][1])); g.lineTo(X(o[2][0]), Y(o[2][1])); g.moveTo(X(o[1][0]), Y(o[1][1])); g.lineTo(X(o[3][0]), Y(o[3][1])); g.stroke(); }
      else {
        g.fillStyle = col['--paper']; g.fill(); g.strokeStyle = col['--ink-2']; g.lineWidth = 1.5; g.stroke();
        const co = Math.cos(e.yaw), si = Math.sin(e.yaw), hw = e.width / 2; g.beginPath();
        for (let i = 1; i < Math.min(e.steps, 40); i++) { const t = i * e.tread, mx = e.start[0] + co * t, my = e.start[1] + si * t; g.moveTo(X(mx - si * hw), Y(my + co * hw)); g.lineTo(X(mx + si * hw), Y(my - co * hw)); }
        g.lineWidth = 0.75; g.stroke();
        const L = e.steps * e.tread, a0: Vec2 = [e.start[0] + co * L * 0.15, e.start[1] + si * L * 0.15], a1: Vec2 = [e.start[0] + co * L * 0.85, e.start[1] + si * L * 0.85];   // 오르는 방향 화살표
        g.strokeStyle = col['--ink']; g.lineWidth = 2; g.beginPath(); g.moveTo(X(a0[0]), Y(a0[1])); g.lineTo(X(a1[0]), Y(a1[1]));
        const ah = Math.min(0.4, L * 0.2); g.lineTo(X(a1[0] - co * ah + si * ah * 0.6), Y(a1[1] - si * ah - co * ah * 0.6)); g.moveTo(X(a1[0]), Y(a1[1])); g.lineTo(X(a1[0] - co * ah - si * ah * 0.6), Y(a1[1] - si * ah + co * ah * 0.6)); g.stroke();
      }
    }
    // 장비(마름모 + 이름)
    g.font = '12px Pretendard, "Malgun Gothic", "Segoe UI", sans-serif'; g.textBaseline = 'middle';
    for (const e of s.equipment) {
      if (e.floor !== floor) continue;
      const x = X(e.pose[0]), y = Y(e.pose[1]);
      g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7, y); g.lineTo(x, y + 7); g.lineTo(x - 7, y); g.closePath(); g.fillStyle = col['--card']; g.fill(); g.strokeStyle = col['--ink']; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = col['--ink']; g.fillText(e.label || e.id, x + 10, y);
    }
    // 경로(배치안이 있으면 그 경로만) · 막힌 구간 · 연결 없는 점
    const tags = robotTags(s, sc), selC = (on: boolean, i: number) => (on ? col['--brand'] : i % 2 ? col['--ink-2'] : col['--ink']);
    const ar = new Map((an?.routes || []).map((r) => [r.id, r]));
    for (const r of s.routes) {
      if (r.floor !== floor || (sc && !sc.routes.includes(r.id))) continue;
      const t = tags.get(r.robot), i = t?.i ?? 0, on = (sel?.k === 'route' && sel.id === r.id) || (sel?.k === 'robot' && sel.id === r.robot);
      g.setLineDash(DASH[i % 3].length ? DASH[i % 3] : [8, 5]); g.strokeStyle = selC(on, i); g.lineWidth = on ? 3 : 2; path(r.points, false); g.stroke(); g.setLineDash([]);
      const a = ar.get(r.id);
      if (a) {
        g.strokeStyle = col['--note']; g.lineWidth = 6;
        for (const j of a.blocked_segments) { const q0 = r.points[j], q1 = r.points[j + 1]; if (q0 && q1) { g.beginPath(); g.moveTo(X(q0[0]), Y(q0[1])); g.lineTo(X(q1[0]), Y(q1[1])); g.stroke(); } }
      }
      r.points.forEach((q, j) => {
        const x = X(q[0]), y = Y(q[1]);
        if (a?.unreachable_points.includes(j)) { g.fillStyle = col['--note']; g.beginPath(); g.moveTo(x, y - 9); g.lineTo(x + 8, y + 6); g.lineTo(x - 8, y + 6); g.closePath(); g.fill(); }
        g.beginPath(); g.arc(x, y, 8, 0, 7); g.fillStyle = col['--card']; g.fill(); g.strokeStyle = selC(on, i); g.lineWidth = 1.5; g.stroke();
        g.fillStyle = col['--ink']; g.textAlign = 'center'; g.font = '11px Pretendard, "Malgun Gothic", sans-serif'; g.fillText(String(j + 1), x, y + 0.5); g.textAlign = 'left';
      });
    }
    // 경로 교차(같은 층 · 이 배치안)
    if (an && sc) for (const x of an.crossings) {
      if (x.scenario !== sc.id || s.routes.find((r) => r.id === x.a)?.floor !== floor) continue;
      g.beginPath(); g.arc(X(x.at[0]), Y(x.at[1]), 11, 0, 7); g.strokeStyle = col['--note']; g.lineWidth = 2.5; g.stroke();
    }
    // 로봇(삼각형 + 표지) · 센서(점 + 방향 화살표 — 범위 부채꼴 없음: 사양 미확인)
    g.font = '600 12px Pretendard, "Malgun Gothic", sans-serif';
    for (const r of s.robots) {
      if (r.floor !== floor) continue;
      const t = tags.get(r.id), on = sel?.k === 'robot' && sel.id === r.id || (sel?.k === 'sensor' && sel.of === r.id);
      const [px, py, yaw] = r.pose, co = Math.cos(yaw), si = Math.sin(yaw), Lr = 0.35;
      g.globalAlpha = sc && !t ? 0.3 : 1;
      path([[px + co * Lr, py + si * Lr], [px - co * Lr * 0.7 - si * Lr * 0.6, py - si * Lr * 0.7 + co * Lr * 0.6], [px - co * Lr * 0.7 + si * Lr * 0.6, py - si * Lr * 0.7 - co * Lr * 0.6]]);
      g.fillStyle = selC(on, t?.i ?? 0); g.fill();
      for (const q of r.sensors) {
        const mx = px + co * q.mount[0] - si * q.mount[1], my = py + si * q.mount[0] + co * q.mount[1], yy = yaw + q.mount[3];
        const x = X(mx), y = Y(my); g.beginPath(); g.arc(x, y, 3.5, 0, 7); g.fillStyle = col['--card']; g.fill(); g.strokeStyle = col['--ink']; g.lineWidth = 1.5; g.stroke();
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(yy) * 16, y - Math.sin(yy) * 16); g.stroke();
      }
      g.fillStyle = col['--ink']; g.fillText(t ? `${t.tag} ${r.name}` : r.name, X(px) + 12, Y(py) - 12);
      g.globalAlpha = 1;
    }
    // 검사 결과 위치(■ 오류 · ▲ 경고)
    for (const q of issues || []) {
      if (!q.at || (q.floor && q.floor !== floor)) continue;
      const x = X(q.at[0]), y = Y(q.at[1]);
      g.fillStyle = q.level === 'error' ? col['--stop'] : col['--note']; g.beginPath();
      if (q.level === 'error') g.rect(x - 5, y - 5, 10, 10); else { g.moveTo(x, y - 7); g.lineTo(x + 6, y + 5); g.lineTo(x - 6, y + 5); g.closePath(); }
      g.fill();
    }
    // 선택 윤곽
    if (sel?.k === 'el') { const e = s.elements.find((x) => x.id === sel.id); if (e) { path(outline(e)); g.strokeStyle = col['--brand']; g.lineWidth = 3; g.stroke(); } }
    if (sel?.k === 'equip') { const e = s.equipment.find((x) => x.id === sel.id); if (e) { g.beginPath(); g.arc(X(e.pose[0]), Y(e.pose[1]), 12, 0, 7); g.strokeStyle = col['--brand']; g.lineWidth = 3; g.stroke(); } }
    // 그리는 중
    if (draft && draft.pts.length) {
      g.setLineDash([4, 4]); g.strokeStyle = col['--brand']; g.lineWidth = draft.kind === 'wall' ? 4 : 2; path(draft.pts, false); g.stroke(); g.setLineDash([]);
      for (const q of draft.pts) { g.beginPath(); g.arc(X(q[0]), Y(q[1]), 4, 0, 7); g.fillStyle = col['--brand']; g.fill(); }
    }
    // 축척 막대
    const sb = scaleBar(k, 140);
    if (sb) { g.fillStyle = col['--ink']; g.fillRect(12, H - 18, sb.L, 3); g.font = '12px Pretendard, "Malgun Gothic", sans-serif'; g.fillText(sb.t, 12, H - 28); }
  };
  const schedule = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(draw); };

  useLayoutEffect(() => { schedule(); });
  useEffect(() => {
    const b = box.current; if (!b || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(schedule); ro.observe(b); return () => { ro.disconnect(); cancelAnimationFrame(raf.current); };
  }, []);
  useEffect(() => { const f = p.focus; if (!f) return; const V = v.current; V.cx = f.at[0]; V.cy = f.at[1]; V.k = Math.max(V.k, 30); schedule(); }, [p.focus?.n]);   // eslint-disable-line react-hooks/exhaustive-deps

  const world = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = box.current!.getBoundingClientRect(), V = v.current;
    return [V.cx + (e.clientX - r.left - r.width / 2) / V.k, V.cy - (e.clientY - r.top - r.height / 2) / V.k];
  };
  const zoom = (f: number, at?: Vec2) => {
    const V = v.current, k2 = Math.max(2, Math.min(400, V.k * f));
    if (at) { V.cx = at[0] - (at[0] - V.cx) * (V.k / k2); V.cy = at[1] - (at[1] - V.cy) * (V.k / k2); }
    V.k = k2; schedule();
  };
  useEffect(() => {   // wheel 은 passive 가 아니어야 페이지가 같이 굴러가지 않음
    const c = cv.current; if (!c) return;
    const h = (e: WheelEvent) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, world(e)); };
    c.addEventListener('wheel', h, { passive: false }); return () => c.removeEventListener('wheel', h);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const zb: React.CSSProperties = { minWidth: 44, minHeight: 44, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--text)', fontSize: 16, cursor: 'pointer' };
  return (
    <div ref={box} style={{ position: 'relative', height: p.height, minHeight: 200, overflow: 'hidden', borderRadius: 8, border: '1px solid var(--line)' }}>
      <canvas ref={cv} role="img" aria-label={p.label} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        onPointerDown={(e) => {
          const w = world(e); (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          if (P.current.onDown?.(w, e, 8 / v.current.k) !== true) { const V = v.current; V.pan = { x: e.clientX, y: e.clientY, cx: V.cx, cy: V.cy }; }
        }}
        onPointerMove={(e) => {
          const V = v.current;
          if (V.pan) { V.cx = V.pan.cx - (e.clientX - V.pan.x) / V.k; V.cy = V.pan.cy + (e.clientY - V.pan.y) / V.k; schedule(); }
          else P.current.onMove?.(world(e), e);
        }}
        onPointerUp={(e) => { const V = v.current; if (V.pan) V.pan = null; else P.current.onUp?.(world(e), e); }}
        onPointerCancel={() => { v.current.pan = null; P.current.onCancel?.(); }}
        onLostPointerCapture={() => { v.current.pan = null; P.current.onCancel?.(); }} />
      <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" style={zb} aria-label="확대" onClick={() => zoom(1.3)}>＋</button>
        <button type="button" style={zb} aria-label="축소" onClick={() => zoom(1 / 1.3)}>－</button>
        <button type="button" style={{ ...zb, fontSize: 12 }} aria-label="전체 보기" onClick={() => { v.current.fitKey = ''; schedule(); }}>전체</button>
      </div>
    </div>
  );
}

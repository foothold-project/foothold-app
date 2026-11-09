// 시뮬 지형 직접 만들기(TERRAIN-EDITOR 1단계, PC 틀 숨은 탭 #/terrain — 입구 = 시뮬 시작 화면 «지형 만들기»).
// 위에서 본 판에 상자·계단·경사·틈을 놓고 고치면 이 브라우저에 바로 저장되고, «시뮬로 열기»는 같은 출처 시뮬(map=custom)이 그 저장본을 읽어 연다.
// 지형 설명 = 약속 fh_custom_terrain/1: 원점 = 바닥 가운데, x·y = 물체 차지 면적 가운데, yaw = 라디안·반시계, 몸 기준 +x = 길이·오르는 방향. 서버 저장 없음(4단계).
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { CLEARANCE, validateTerrain, type TerrainItem, type TerrainSpec } from '../../../../mobile/sim/terrain/index.js';
import { simUrl } from '../simdrive';
import { toWorld } from '../simstart';
import { Menu, shut } from './mapscen';
import './mapscen.css';
import './terrain.css';

const Terrain3D = lazy(() => import('./terrain3d'));   // three 는 3D 를 열 때만 받는다(첫 로딩 묶음 밖)

type At = { x: number; y: number; yaw: number };
type Item = TerrainItem;
type Spec = TerrainSpec;
type Kind = Item['kind'];

const MAX_ITEMS = 60, LANDING = 1;
const deg = (rad: number) => (rad * 180) / Math.PI;
/** 물체가 차지하는 면적 [몸 기준 x 길이, y 길이] */
const foot = (it: Item): [number, number] =>
  it.kind === 'box' ? [it.sx, it.sy] : it.kind === 'stairs' ? [it.steps * it.run + LANDING, it.width] : [it.length, it.width];
/** 도는 면적의 세계 축 반폭 */
function reach(it: Item) {
  const [L, W] = foot(it), c = Math.abs(Math.cos(it.yaw)), s = Math.abs(Math.sin(it.yaw));
  return [c * L / 2 + s * W / 2, s * L / 2 + c * W / 2];
}
const PREFIX = 'fh.customTerrain.', LAST = 'fh.customTerrainLast';
export const keyOf = (id: string) => PREFIX + id;
/** 약속의 열기 주소(정책은 시뮬 화면 안 모드 고르기) */
export const terrainUrl = (id: string) => `${simUrl('custom')}&terrain=${id}`;
const NUMS: Record<Kind, string[]> = { box: ['sx', 'sy', 'h'], stairs: ['width', 'steps', 'rise', 'run'], ramp: ['length', 'width', 'h'], gap: ['length', 'width'] };
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** 저장본은 손으로 고쳐졌거나 옛 형식일 수 있다 — 그릴 수 있는 모양일 때만 받는다 */
function parse(raw: string | null, id: string): Spec | null {
  try {
    const s = JSON.parse(raw ?? 'null');
    const ok = s?.schema === 'fh_custom_terrain/1' && s.id === id && typeof s.name === 'string' && Array.isArray(s.size) && s.size.length === 2 && s.size.every(finite)
      && Array.isArray(s.spawn) && s.spawn.length === 3 && s.spawn.every(finite)
      && Array.isArray(s.items) && s.items.every((it: Item & Record<string, unknown>) => NUMS[it?.kind] && ['x', 'y', 'yaw', ...NUMS[it.kind]].every((k) => finite(it[k])));
    return ok ? s : null;
  } catch { return null; }
}
const save = (s: Spec) => { try { localStorage.setItem(keyOf(s.id), JSON.stringify(s)); localStorage.setItem(LAST, s.id); return true; } catch { return false; } };
function loadLast() {
  try { const id = localStorage.getItem(LAST); return id ? parse(localStorage.getItem(keyOf(id)), id) : null; } catch { return null; }
}
/** 이 브라우저에 저장된 지형. 읽지 못하는 저장본도 지울 수 있게 목록에 남긴다(spec = null) */
function listSaved() {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => {
      const id = k.slice(PREFIX.length);
      return { id, spec: parse(localStorage.getItem(k), id) };
    }).sort((a, b) => (a.spec?.name ?? a.id).localeCompare(b.spec?.name ?? b.id));
  } catch { return []; }
}
const newId = () => { let id: string; do id = `t-${Math.random().toString(36).slice(2, 10)}`; while (listSaved().some((s) => s.id === id)); return id; };
const blank = (): Spec => ({ schema: 'fh_custom_terrain/1', id: newId(), name: '새 지형', size: [12, 12], spawn: [-4.5, 0, 0], items: [] });

const KIND: Record<Kind, { name: string; make: () => Item; icon: ReactNode; hint: string }> = {
  box: { name: '상자', make: () => ({ kind: 'box', x: 0, y: 0, yaw: 0, sx: 1, sy: 1, h: 0.2 }), hint: '판을 눌러 상자를 놓습니다',
    icon: <rect x="5" y="5" width="14" height="14" rx="1" /> },
  stairs: { name: '계단', make: () => ({ kind: 'stairs', x: 0, y: 0, yaw: 0, width: 1.2, steps: 5, rise: 0.12, run: 0.3 }), hint: '판을 눌러 계단을 놓습니다 — 화살표 쪽으로 올라갑니다',
    icon: <path d="M3 20v-4h5v-4h5V8h5V4h3" /> },
  ramp: { name: '경사', make: () => ({ kind: 'ramp', x: 0, y: 0, yaw: 0, length: 2, width: 1.2, h: 0.3 }), hint: '판을 눌러 경사를 놓습니다 — 화살표 쪽이 높습니다',
    icon: <path d="M3 19L21 6v13z" /> },
  gap: { name: '틈', make: () => ({ kind: 'gap', x: 0, y: 0, yaw: 0, length: 0.4, width: 1.5 }), hint: '판을 눌러 바닥이 빠진 틈을 놓습니다',
    icon: <path d="M3 8h6v8H3M21 8h-6v8h6M11 4v2M11 10v2M11 16v2M13 4v2M13 10v2M13 16v2" /> },
};
type Tool = 'select' | Kind | 'spawn';
const HINT3 = '물체를 끌어 바닥 위로 옮기고 둥근 손잡이로 돌립니다(R 15°) · 화살로 높이 · 빈 곳 끌기 = 카메라 돌리기, 오른쪽 끌기 = 이동, 휠 = 확대';
const HINT: Record<'select' | 'spawn', string> = { select: '물체를 끌어 옮기고 둥근 손잡이로 돌립니다 · 방향키 5 cm(Shift 50 cm) · Delete 지우기', spawn: '판을 눌러 로봇 시작 위치를 정합니다' };
const IconTool = ({ d }: { d: ReactNode }) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">{d}</svg>;

const snap = (v: number, by = 0.05) => +(Math.round(v / by) * by).toFixed(2);
const clamp = (v: number, a: number) => Math.max(-a, Math.min(a, v));
const toRad = (d: number) => +((d * Math.PI) / 180).toFixed(4);
const describe = (it: Item) => it.kind === 'box' ? `${it.sx}×${it.sy} m · 높이 ${it.h} m`
  : it.kind === 'stairs' ? `${it.steps}단 · 끝 높이 ${+(it.steps * it.rise).toFixed(2)} m`
  : it.kind === 'ramp' ? `${it.length} m · 높이 ${it.h} m · ${deg(Math.atan2(it.h, it.length)).toFixed(1)}°` : `${it.length}×${it.width} m · 깊이 0.5 m`;
const tone = (k: number) => `color-mix(in srgb, var(--accent) ${Math.round(14 + 66 * Math.max(0, Math.min(1, k)))}%, var(--panel2))`;

/** 숫자 칸: 치는 동안의 글자(«0.»·빈칸)는 그대로 두고, 숫자가 되는 순간만 올린다. 범위 밖 값도 올려서 validate 가 이유를 보인다 */
function Num({ label, value, step, onSet, className }: { label: string; value: number; step: number; onSet: (v: number) => void; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label className={`fh-field${className ? ` ${className}` : ''}`}><span className="lbl">{label}</span>
    <input className="inp" type="number" step={step} value={draft ?? String(value)} onBlur={() => setDraft(null)}
      onChange={(e) => { const t = e.target.value; setDraft(t); if (t !== '' && Number.isFinite(Number(t))) onSet(Number(t)); }} /></label>;
}

/** 물체 모양(몸 기준: +x = 오른쪽). 위치·방향은 바깥 g 가 준다 */
function Shape({ it }: { it: Item }) {
  const [L0, W0] = foot(it), L = Math.max(L0, 0.01), W = Math.max(W0, 0.01), x0 = -L / 2, y0 = -W / 2;
  const box = { x: x0, y: y0, width: L, height: W };
  if (it.kind === 'box') return <rect {...box} fill={tone(it.h)} />;
  if (it.kind === 'gap') return <><rect {...box} fill="#14171C" /><rect {...box} fill="url(#tr-hatch)" /></>;
  if (it.kind === 'ramp') return <rect {...box} fill="url(#tr-ramp)" />;
  const n = Math.max(0, Math.min(Math.floor(it.steps), 200));   // 칸에 큰 수를 쳐도 그리기가 멎지 않게(200단 = 바닥 30 m 를 넘는 값, 판정은 validate)
  return <>{Array.from({ length: n }, (_, i) => <rect key={i} x={x0 + i * it.run} y={y0} width={Math.max(it.run, 0.01)} height={W} fill={tone((i + 1) / (n + 1))} className="tr-step" />)}
    <rect x={x0 + n * it.run} y={y0} width={LANDING} height={W} fill={tone(1)} /></>;
}

export function Terrain() {
  const [spec, setSpec] = useState<Spec>(() => loadLast() ?? blank());
  const [sel, setSel] = useState<number | 'spawn' | null>(null), [tool, setTool] = useState<Tool>('select');
  const [failed, setFailed] = useState(false), [wipe, setWipe] = useState(''), [, again] = useState(0), [view, setView] = useState<'top' | '3d'>('top');
  const update = (next: Spec) => { setSpec(next); setFailed(!save(next)); };
  const open = (next: Spec) => { setSpec(next); setSel(null); setTool('select'); setWipe(''); setFailed(false); };
  const [W, H] = spec.size, m = Math.max(W, H) * 0.06;
  const bounds: [number, number, number, number] = [-W / 2 - m, -H / 2 - m, W / 2 + m, H / 2 + m];

  // 글자·손잡이 크기는 화면 px 기준 — 판을 world 단위로 그리므로 지금 축척을 잰다
  const svg = useRef<SVGSVGElement>(null), [box, setBox] = useState({ w: 600, h: 600 });
  useEffect(() => {
    if (!svg.current || typeof ResizeObserver === 'undefined') return;
    const o = new ResizeObserver(([e]) => { if (e.contentRect.width) setBox({ w: e.contentRect.width, h: e.contentRect.height }); });
    o.observe(svg.current);
    return () => o.disconnect();
  }, [view]);   // 3D 에서 돌아오면 새 판을 잰다
  const px = 1 / Math.min(box.w / (bounds[2] - bounds[0]), box.h / (bounds[3] - bounds[1]));   // 화면 1 px = 몇 m

  const { errors, warnings } = validateTerrain(spec);
  const issuesOf = (i: number) => [...errors.filter((e) => e.item === i).map((e) => ({ ...e, bad: true })), ...warnings.filter((e) => e.item === i).map((e) => ({ ...e, bad: false }))];
  const general = [...errors, ...warnings].filter((e) => e.item == null);

  const setItem = (i: number, patch: Record<string, number>) => update({ ...spec, items: spec.items.map((it, j) => (j === i ? { ...it, ...patch } as Item : it)) });
  const setPose = (what: number | 'spawn', p: Partial<At>) => {
    if (what === 'spawn') { const [x, y, yaw] = spec.spawn; update({ ...spec, spawn: [p.x ?? x, p.y ?? y, p.yaw ?? yaw] }); } else setItem(what, p);
  };
  const remove = (i: number) => { update({ ...spec, items: spec.items.filter((_, j) => j !== i) }); setSel(null); };
  const poseOf = (what: number | 'spawn'): At => (what === 'spawn' ? { x: spec.spawn[0], y: spec.spawn[1], yaw: spec.spawn[2] } : spec.items[what]);

  const at = (e: RPointerEvent) => toWorld(svg.current!.getBoundingClientRect(), bounds, e.clientX, e.clientY);
  const drag = useRef<{ what: number | 'spawn'; turn: boolean; dx: number; dy: number; cx: number; cy: number; live: boolean } | null>(null);
  const grab = (e: RPointerEvent, what: number | 'spawn', turn = false) => {
    if (tool !== 'select') return;   // 놓기 도구면 물체 위에도 놓는다(판으로 올라감)
    e.stopPropagation();
    svg.current?.setPointerCapture?.(e.pointerId);
    setSel(what);
    const o = poseOf(what), [wx, wy] = at(e);
    drag.current = { what, turn, dx: o.x - wx, dy: o.y - wy, cx: e.clientX, cy: e.clientY, live: false };
  };
  const down = (e: RPointerEvent) => place(...at(e));
  /** 판 누름(2D·3D 공통): 놓기 도구면 놓고, 고르기면 고른 것 풀기 */
  const place = (wx: number, wy: number) => {
    const x = snap(clamp(wx, W / 2)), y = snap(clamp(wy, H / 2));
    if (tool === 'spawn') { update({ ...spec, spawn: [x, y, spec.spawn[2]] }); setSel('spawn'); setTool('select'); }
    else if (tool !== 'select') { update({ ...spec, items: [...spec.items, { ...KIND[tool].make(), x, y }] }); setSel(spec.items.length); setTool('select'); }
    else setSel(null);
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.live && !d.turn && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 3) return;   // 고르려는 누름에 흔들려 옮겨지지 않게
    d.live = true;
    const [wx, wy] = at(e), o = poseOf(d.what);
    if (d.turn) setPose(d.what, { yaw: toRad(Math.round(deg(Math.atan2(wy - o.y, wx - o.x)) / 5) * 5) });
    else setPose(d.what, { x: snap(clamp(wx + d.dx, W / 2)), y: snap(clamp(wy + d.dy, H / 2)) });
  };
  const up = () => { drag.current = null; };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.5 : 0.05, arrow: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (e.key === 'Escape') { setTool('select'); setSel(null); }
    else if (sel != null && arrow[e.key]) {
      e.preventDefault();
      const o = poseOf(sel);
      setPose(sel, { x: snap(clamp(o.x + arrow[e.key][0], W / 2)), y: snap(clamp(o.y + arrow[e.key][1], H / 2)) });
    } else if (typeof sel === 'number' && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); remove(sel); }
  };

  const chosen = typeof sel === 'number' ? spec.items[sel] : null, full = spec.items.length >= MAX_ITEMS;
  const saved = listSaved();
  const fontPx = 13 * px, hPos = (it: At, r: number) => ({ cx: it.x + r * Math.cos(it.yaw), cy: -(it.y + r * Math.sin(it.yaw)) });
  /** 고른 것의 돌림 손잡이 */
  const handle = (what: number | 'spawn', r: number) => { const o = poseOf(what), c = hPos(o, r); return <g data-terrain-turn>
    <line x1={o.x} y1={-o.y} x2={c.cx} y2={c.cy} className="tr-hline" />
    <circle {...c} r={7 * px} className="tr-handle" />
    <circle {...c} r={18 * px} fill="transparent" style={{ cursor: 'grab' }} onPointerDown={(e) => grab(e, what, true)} /></g>; };

  return <div className="mx tr" data-terrain>
    <div className="mx-bar tr-bar">
      <a className="btn" href="#/sim" data-terrain-back>← 시뮬</a>
      <Menu label="내 지형" title="이 브라우저에 저장된 지형">
        <button type="button" className="btn" data-terrain-new onClick={(e) => { open(blank()); shut(e); }}>+ 새 지형</button>
        {saved.length ? <ul className="mx-list tr-saved" aria-label="저장된 지형">{saved.map((t) => <li key={t.id} className="mx-row" data-terrain-saved={t.id}>
          {wipe === t.id ? <span className="tr-wipe"><span className="fh-grow">«{t.spec?.name ?? t.id}» 을 지울까요?</span>
            <button type="button" className="btn" data-terrain-wipe-yes onClick={() => {
              try { localStorage.removeItem(keyOf(t.id)); if (localStorage.getItem(LAST) === t.id) localStorage.removeItem(LAST); } catch { /* 못 지우면 목록에 남음 */ }
              setWipe('');
              if (t.id === spec.id) open(blank()); else again((n) => n + 1);
            }}>지우기</button>
            <button type="button" className="btn" onClick={() => setWipe('')}>취소</button></span>
          : <><button type="button" className="mx-name mx-name2" aria-pressed={t.id === spec.id} disabled={!t.spec} onClick={(e) => { if (t.spec) { open(t.spec); shut(e); } }}>
              <b>{t.spec?.name ?? t.id}</b><small>{t.spec ? `${t.spec.size[0]}×${t.spec.size[1]} m · 물체 ${t.spec.items.length}개` : '읽을 수 없는 저장본'}</small></button>
            <button type="button" className="mx-x" aria-label={`${t.spec?.name ?? t.id} 지우기`} title="지우기" data-terrain-wipe onClick={() => setWipe(t.id)}>✕</button></>}
        </li>)}</ul> : <p className="lv-note">아직 저장된 지형이 없습니다.</p>}
      </Menu>
      <label className="tr-inline"><span className="lbl">이름</span><input className="inp tr-name" value={spec.name} maxLength={40} aria-label="지형 이름" data-terrain-name onChange={(e) => update({ ...spec, name: e.target.value })} /></label>
      <Num className="tr-inline" label="가로 m" step={1} value={W} onSet={(v) => update({ ...spec, size: [v, H] })} />
      <Num className="tr-inline" label="세로 m" step={1} value={H} onSet={(v) => update({ ...spec, size: [W, v] })} />
      <span className="mx-seg" role="group" aria-label="보기">{([['top', '위에서'], ['3d', '3D']] as const).map(([v, t]) =>
        <button key={v} type="button" className="btn" aria-pressed={view === v} data-terrain-view={v} onClick={() => setView(v)}>{t}</button>)}</span>
      <span className="fh-grow" />
      <span className="mx-tag" data-terrain-count>{errors.length ? `오류 ${errors.length}` : '오류 없음'}{warnings.length ? ` · 경고 ${warnings.length}` : ''}</span>
      {errors.length
        ? <button type="button" className="btn pri" disabled title="오류를 고쳐야 열 수 있습니다" data-terrain-open>시뮬로 열기</button>
        : <a className="btn pri" href={terrainUrl(spec.id)} data-terrain-open onClick={(e) => { if (!save(spec)) { e.preventDefault(); setFailed(true); } }}>시뮬로 열기</a>}
    </div>
    <div className="mx-body">
      <div className="mx-tools tr-tools" role="toolbar" aria-label="지형 도구" aria-orientation="vertical">
        <button type="button" className="btn" aria-pressed={tool === 'select'} data-terrain-tool="select" onClick={() => setTool('select')}>
          <IconTool d={<path d="M6 3l12 10-5 1 3 6-3 1-3-6-4 3z" />} />고르기</button>
        <hr />
        {(Object.keys(KIND) as Kind[]).map((k) => <button key={k} type="button" className="btn" aria-pressed={tool === k} disabled={full} title={full ? `물체는 ${MAX_ITEMS}개까지입니다` : undefined}
          data-terrain-tool={k} onClick={() => setTool(k)}><IconTool d={KIND[k].icon} />{KIND[k].name}</button>)}
        <hr />
        <button type="button" className="btn" aria-pressed={tool === 'spawn'} data-terrain-tool="spawn" onClick={() => setTool('spawn')}>
          <IconTool d={<><circle cx="12" cy="12" r="5" /><path d="M12 12h9" /></>} />시작</button>
      </div>
      <div className="mx-map">
        {view === '3d' && <Suspense fallback={<p className="lv-note tr-pad">3D 화면을 불러오는 중…</p>}>
          <Terrain3D spec={spec} sel={sel} tool={tool} onSel={setSel} onFloor={place} onKeyDown={key}
            onPose={(w, p) => (w === 'spawn' ? setPose(w, p) : setItem(w, p))} state={spec.items.map((_, i) => { const iss = issuesOf(i); return iss.some((x) => x.bad) ? 'bad' : iss.length ? 'warn' : undefined; })} />
        </Suspense>}
        {view === 'top' && <svg ref={svg} className="tr-board" data-tool={tool} viewBox={`${bounds[0]} ${-bounds[3]} ${bounds[2] - bounds[0]} ${bounds[3] - bounds[1]}`} tabIndex={0} role="application"
          aria-label={`${spec.name} 위에서 본 판 — ${W}×${H} m`} data-terrain-board onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}>
          <defs>
            <linearGradient id="tr-ramp"><stop offset="0" stopColor="var(--panel2)" /><stop offset="1" stopColor="color-mix(in srgb, var(--accent) 80%, var(--panel2))" /></linearGradient>
            <pattern id="tr-hatch" width={12 * px} height={12 * px} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2={12 * px} stroke="var(--warn)" strokeWidth={3 * px} /></pattern>
          </defs>
          <rect x={-W / 2} y={-H / 2} width={Math.max(W, 0)} height={Math.max(H, 0)} className="tr-floor" />
          {W <= 30 && Array.from({ length: Math.max(0, Math.floor(W)) + 1 }, (_, i) => <line key={i} x1={-W / 2 + i} x2={-W / 2 + i} y1={-H / 2} y2={H / 2} className="tr-grid" />)}
          {H <= 30 && Array.from({ length: Math.max(0, Math.floor(H)) + 1 }, (_, i) => <line key={i} y1={-H / 2 + i} y2={-H / 2 + i} x1={-W / 2} x2={W / 2} className="tr-grid" />)}
          {spec.items.map((it, i) => {
            const iss = issuesOf(i), [L, W2] = foot(it), hasArrow = it.kind === 'stairs' || it.kind === 'ramp', a = Math.max(L, 0.01) * 0.3, k = 7 * px;
            return <g key={i} transform={`translate(${it.x} ${-it.y}) rotate(${-deg(it.yaw)})`} className="tr-item" data-terrain-item={i} data-kind={it.kind} data-state={iss.some((x) => x.bad) ? 'bad' : iss.length ? 'warn' : undefined}
              onPointerDown={(e) => grab(e, i)}>
              <Shape it={it} />
              <rect x={-Math.max(L, 0.01) / 2} y={-Math.max(W2, 0.01) / 2} width={Math.max(L, 0.01)} height={Math.max(W2, 0.01)} className="tr-edge" data-sel={sel === i || undefined} />
              {hasArrow && <path d={`M${-a} 0H${a}M${a - k} ${-k}L${a} 0L${a - k} ${k}`} className="tr-arrow" />}
            </g>;
          })}
          {spec.items.map((it, i) => {
            const iss = issuesOf(i), [, ey] = reach(it), top = -it.y - ey - 6 * px, below = top - fontPx < -bounds[3];   // 판 위끝에 닿으면 물체 아래에 쓴다
            const text = iss[0] && `${iss[0].bad ? '✕' : '▲'} ${iss[0].msg}${iss.length > 1 ? ` 외 ${iss.length - 1}` : ''}`;
            const half = Math.min(((text?.length ?? 0) * fontPx * 0.8) / 2, W / 2 + m), tx = Math.max(bounds[0] + half, Math.min(bounds[2] - half, it.x));   // 어림 글자 폭으로 판 안에 가둔다
            return <g key={i} pointerEvents="none" strokeWidth={3 * px}>
              <text x={it.x} y={-it.y + 4.5 * px} fontSize={fontPx} textAnchor="middle" className="tr-num">{i + 1}</text>
              {iss[0] && <text x={tx} y={below ? -it.y + ey + 18 * px : top} fontSize={fontPx} textAnchor="middle" className="tr-issue" data-bad={iss[0].bad || undefined} data-terrain-issue={i}>{text}</text>}
            </g>;
          })}
          <g className="tr-spawn" data-terrain-spawn data-sel={sel === 'spawn' || undefined} onPointerDown={(e) => grab(e, 'spawn')}>
            <line x1={spec.spawn[0]} y1={-spec.spawn[1]} x2={spec.spawn[0] + 26 * px * Math.cos(spec.spawn[2])} y2={-spec.spawn[1] - 26 * px * Math.sin(spec.spawn[2])} />
            <circle cx={spec.spawn[0]} cy={-spec.spawn[1]} r={CLEARANCE} className="tr-keep" />
            <circle cx={spec.spawn[0]} cy={-spec.spawn[1]} r={8 * px} />
          </g>
          {sel != null && (sel !== 'spawn' ? chosen && handle(sel, foot(chosen)[0] / 2 + 26 * px) : handle('spawn', 44 * px))}
        </svg>}
        <p className="mx-hint tr-hint" data-terrain-hint>{tool === 'select' || tool === 'spawn' ? (view === '3d' && tool === 'select' ? HINT3 : HINT[tool]) : KIND[tool].hint}</p>
      </div>
      <aside className="mx-pane tr-pane" aria-label="지형 내용">
        {failed && <p className="fh-msg tr-pad" role="alert" data-terrain-failed>이 브라우저에 저장하지 못했습니다 — 저장 공간을 확인해 주세요. 저장되기 전에는 시뮬로 열 수 없습니다.</p>}
        {general.length > 0 && <ul className="tr-general" aria-label="지형 전체 오류·경고">{general.map((g) => <li key={g.msg} className="fh-msg">✕ {g.msg}</li>)}</ul>}
        <div className="mx-head"><b className="fh-grow">{chosen ? `${(sel as number) + 1} · ${KIND[chosen.kind].name}` : sel === 'spawn' ? '시작 위치' : '고른 것 없음'}</b>
          {chosen && <button type="button" className="btn" data-terrain-del onClick={() => remove(sel as number)}>지우기</button>}</div>
        <div className="mx-in" data-terrain-fields>
          {sel == null ? <p className="lv-note">왼쪽 도구로 판에 물체를 놓거나, 판·목록에서 물체를 고르면 여기서 고칩니다. 고친 내용은 이 브라우저에 바로 저장됩니다.</p>
            : <div className="tr-fields">
              <Num key={`${sel}-x`} label="x m" step={0.05} value={poseOf(sel).x} onSet={(x) => setPose(sel, { x })} />
              <Num key={`${sel}-y`} label="y m" step={0.05} value={poseOf(sel).y} onSet={(y) => setPose(sel, { y })} />
              <Num key={`${sel}-yaw`} label="방향 °" step={5} value={+deg(poseOf(sel).yaw).toFixed(1)} onSet={(d) => setPose(sel, { yaw: toRad(d) })} />
              {chosen?.kind === 'box' && <>
                <Num key={`${sel}-sx`} label="가로 m" step={0.1} value={chosen.sx} onSet={(sx) => setItem(sel as number, { sx })} />
                <Num key={`${sel}-sy`} label="세로 m" step={0.1} value={chosen.sy} onSet={(sy) => setItem(sel as number, { sy })} />
                <Num key={`${sel}-h`} label="높이 m" step={0.05} value={chosen.h} onSet={(h) => setItem(sel as number, { h })} /></>}
              {chosen?.kind === 'stairs' && <>
                <Num key={`${sel}-width`} label="폭 m" step={0.1} value={chosen.width} onSet={(width) => setItem(sel as number, { width })} />
                <Num key={`${sel}-steps`} label="단 수" step={1} value={chosen.steps} onSet={(steps) => setItem(sel as number, { steps })} />
                <Num key={`${sel}-rise`} label="단 높이 m" step={0.01} value={chosen.rise} onSet={(rise) => setItem(sel as number, { rise })} />
                <Num key={`${sel}-run`} label="단 깊이 m" step={0.05} value={chosen.run} onSet={(run) => setItem(sel as number, { run })} /></>}
              {chosen?.kind === 'ramp' && <>
                <Num key={`${sel}-length`} label="길이 m" step={0.1} value={chosen.length} onSet={(length) => setItem(sel as number, { length })} />
                <Num key={`${sel}-width`} label="폭 m" step={0.1} value={chosen.width} onSet={(width) => setItem(sel as number, { width })} />
                <Num key={`${sel}-h`} label="높이 m" step={0.05} value={chosen.h} onSet={(h) => setItem(sel as number, { h })} /></>}
              {chosen?.kind === 'gap' && <>
                <Num key={`${sel}-length`} label="길이 m" step={0.1} value={chosen.length} onSet={(length) => setItem(sel as number, { length })} />
                <Num key={`${sel}-width`} label="폭 m" step={0.1} value={chosen.width} onSet={(width) => setItem(sel as number, { width })} /></>}
            </div>}
          {chosen && <p className="lv-note">{describe(chosen)}</p>}
        </div>
        <div className="mx-head"><b className="fh-grow">물체</b><span className="mx-tag">{spec.items.length} / {MAX_ITEMS}</span></div>
        <ul className="mx-list" aria-label="물체 목록">
          <li className="mx-row"><button type="button" className="mx-name" aria-pressed={sel === 'spawn'} data-terrain-row="spawn" onClick={() => setSel('spawn')}><b>시작 위치</b><small>{spec.spawn[0]}, {spec.spawn[1]}</small></button></li>
          {spec.items.map((it, i) => { const iss = issuesOf(i); return <li key={i} className="mx-row" data-bad={iss.some((x) => x.bad) || undefined}>
            <button type="button" className="mx-name mx-name2" aria-pressed={sel === i} data-terrain-row={i} onClick={() => setSel(i)}>
              <b>{i + 1} · {KIND[it.kind].name}</b><small>{describe(it)}</small>
              {iss.map((x) => <span key={x.msg} className="tr-msg" data-bad={x.bad || undefined} data-terrain-row-issue={i}>{x.bad ? '✕' : '▲'} {x.msg}</span>)}
            </button>
            <button type="button" className="mx-x" aria-label={`${i + 1}번 ${KIND[it.kind].name} 지우기`} title="지우기" onClick={() => remove(i)}>✕</button>
          </li>; })}
        </ul>
      </aside>
    </div>
  </div>;
}

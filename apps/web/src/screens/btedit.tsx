// 시뮬 탭 «임무 편집»(BT-NODE-EDITOR 1단계, 11-09): 고른 지도의 BT 임무를 들여쓴 나무 목록으로 고치고 이 브라우저(localStorage)에만 저장 → 시뮬을 ?bt=<id> 로 연다.
// 검사는 시뮬 실행기 mobile/sim/bt.js validateTree 그대로(새 규칙 없음). 시뮬 쪽(main.js)은 같은 키 fh.btMission.<id> 를 읽어 다시 검사한 뒤 «내 임무 · 이름» 으로 넣는다.
// 총괄(admin)만 고치고 저장, 운영자는 보기만(10-25 역할). 서버 저장·공유·끌어다 놓기 그래프는 다음 판.
import { useMemo, useState, type MouseEvent } from 'react';
import * as BT from '../../../../mobile/sim/bt.js';
import type { BtNode, BtPoint as Pt, BtTree as Tree } from '../../../../mobile/sim/bt.js';
import './btedit.css';

export type { BtNode, Pt, Tree };
export type Mission = { id: string; name: string; map: string; floor: string; tree: Tree };
type Scenario = { id: string; name: string; points: Pt[]; tree?: Tree };

const GROUPS = ['sequence', 'fallback', 'reactive_fallback'], CONDS = ['fallen', 'battery_low', 'review_is'];
const MESSAGE = ['alert', 'sensor_log', 'skip_log', 'report', 'hold'];
const NAME: Record<string, string> = { sequence: '차례대로', fallback: '대안(앞이 실패하면 다음)', reactive_fallback: '늘 다시 확인(위 갈래 우선)', retry: '다시 시도',
  for_each_point: '지점마다', fallen: '넘어졌으면', battery_low: '배터리 부족이면', review_is: '운영자 판단이', goto: '이동', photo: '모의 촬영', wait: '대기',
  operator_review: '운영자 판단 받기', sensor_log: '기록', map_mark: '지도 표시', alert: '모의 알림', skip_log: '건너뜀 기록', return_home: '출발점 복귀', hold: '정지·잠금', report: '모의 보고서' };
const LEVEL: Record<string, string> = { clear: '이상 없음', minor: '사소함', danger: '위험' };
export const KINDS = [...GROUPS, 'retry', 'for_each_point', ...CONDS, ...Object.keys(BT.ACTION_SECONDS)];

/** 새 노드 기본값 — bt.js 가 받는 칸만. 묶음은 빈 채로(검사가 «children 필요»로 알려 준다) */
export function make(type: string): BtNode {
  if (GROUPS.includes(type)) return { type, children: [] };
  if (type === 'retry') return { type, times: 2, child: { type: 'photo' } };
  if (type === 'for_each_point') return { type, points: [], child: { type: 'sequence', children: [{ type: 'goto', point: 'current' }, { type: 'photo' }] } };
  if (type === 'review_is') return { type, level: 'clear' };
  if (type === 'map_mark') return { type, level: 'minor' };
  if (type === 'wait') return { type, seconds: 5 };
  if (type === 'goto') return { type, point: 'current' };
  if (MESSAGE.includes(type)) return { type, message: NAME[type] };
  return { type };
}

// ── 나무 고치기: 경로(path) = 뿌리부터 자식 번호. 고칠 때마다 통째 복사본을 돌려준다(되돌릴 상태가 섞이지 않게). 안 되면 이유 문자열
const kids = (n: BtNode) => n.children ?? (n.child ? [n.child] : []);
export const nodeAt = (root: BtNode, path: number[]) => path.reduce<BtNode>((n, i) => kids(n)[i], root);
export type Op = 'add' | 'remove' | 'up' | 'down' | 'in' | 'out';
export function edit(tree: Tree, path: number[], op: Op, type = 'photo'): { tree: Tree; path: number[] } | string {
  const t = structuredClone(tree), n = nodeAt(t.root, path), i = path[path.length - 1] ?? -1, up = path.slice(0, -1);
  const parent = path.length ? nodeAt(t.root, up) : null, list = parent?.children;
  if (op === 'add') {
    if (n.children) { n.children.push(make(type)); return { tree: t, path: [...path, n.children.length - 1] }; }
    if (!list) return path.length ? '«다시 시도»·«지점마다» 안에는 노드 하나만 둡니다 — 그 노드를 고르고 추가하세요.' : '맨 위 노드 옆에는 넣을 수 없습니다.';
    list.splice(i + 1, 0, make(type)); return { tree: t, path: [...up, i + 1] };
  }
  if (!path.length) return '맨 위 노드는 옮기거나 지울 수 없습니다.';
  if (!list) return '«다시 시도»·«지점마다» 안의 노드는 옮기거나 지울 수 없습니다 — 바깥 노드를 고치세요.';
  if (op === 'remove') { list.splice(i, 1); return { tree: t, path: list.length ? [...up, Math.min(i, list.length - 1)] : up }; }
  if (op === 'up' || op === 'down') {
    const j = i + (op === 'up' ? -1 : 1);
    if (j < 0 || j >= list.length) return op === 'up' ? '이미 맨 위입니다.' : '이미 맨 아래입니다.';
    [list[i], list[j]] = [list[j], list[i]]; return { tree: t, path: [...up, j] };
  }
  if (op === 'in') {
    const prev = list[i - 1];
    if (!prev?.children) return '바로 위 노드가 묶음(차례대로·대안·늘 다시 확인)이어야 안으로 넣을 수 있습니다.';
    prev.children.push(...list.splice(i, 1)); return { tree: t, path: [...up, i - 1, prev.children.length - 1] };
  }
  const grand = up.length ? nodeAt(t.root, up.slice(0, -1)) : null;
  if (!grand?.children) return '바깥이 묶음일 때만 밖으로 뺄 수 있습니다.';
  const k = up[up.length - 1];
  grand.children.splice(k + 1, 0, ...list.splice(i, 1)); return { tree: t, path: [...up.slice(0, -1), k + 1] };
}
/** 한 노드의 칸 하나를 바꾼 복사본. v = undefined 면 그 칸을 뺀다(선택 칸 max_seconds·finish·remaining) */
export function setField(tree: Tree, path: number[], key: keyof BtNode, v: unknown): Tree {
  const t = structuredClone(tree), n = nodeAt(t.root, path) as Record<string, unknown>;
  if (v === undefined) delete n[key]; else n[key] = v;
  return t;
}
/** 시뮬이 시나리오 points 로 쓰는 지점(main.js ?bt= 와 같은 순서): 지점마다의 points 다음 이동의 좌표 */
export const treePoints = (t: Tree) => {
  const out: Pt[] = [], walk = (n: BtNode) => { if (n.points) out.push(...n.points); if (n.point && n.point !== 'current') out.push(n.point); kids(n).forEach(walk); };
  walk(t.root); return out;
};
/** validateTree 결과: '' = 통과. 시뮬은 지점 0개 시나리오를 받지 않으므로(scenario.js validateScenarios) 그 이유도 함께 */
export function check(t: Tree) {
  try { BT.validateTree(t); } catch (e) { return (e as Error).message; }
  return treePoints(t).length ? '' : '순찰 지점이 하나도 없습니다 — 시뮬은 지점 없는 임무를 받지 않습니다.';
}

// ── 저장: 이 브라우저만. 키 = fh.btMission.<id>(id [a-z0-9-] 32자 이내 — 시뮬 main.js 가 같은 형식만 읽는다). 저장 실패(사생활 창)는 false
const PREFIX = 'fh.btMission.';
export function listMissions(map: string, floor: string): Mission[] {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).flatMap((k) => {
      try { const m = JSON.parse(localStorage.getItem(k) ?? '') as Mission; return m?.id === k.slice(PREFIX.length) && m.map === map && (m.floor ?? '') === floor && m.tree ? [m] : []; } catch { return []; }
    }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  } catch { return []; }
}
export const saveMission = (m: Mission) => { try { localStorage.setItem(PREFIX + m.id, JSON.stringify(m)); return true; } catch { return false; } };
const dropMission = (id: string) => { try { localStorage.removeItem(PREFIX + id); return true; } catch { return false; } };
const newId = () => crypto.randomUUID().slice(0, 8);

/** 지도·층 기본 임무: 나무 있는 첫 시나리오, 없으면 첫 시나리오 지점을 차례로 가는 나무(bt.js treeFromScenario) */
export function defaultMission(list: Scenario[] | undefined): { name: string; tree: Tree } | null {
  const s = list?.find((x) => x.tree) ?? list?.[0];
  return s ? { name: s.name, tree: structuredClone(s.tree ?? BT.treeFromScenario(s)) } : null;
}

const pointText = (p: Pt) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;
function label(n: BtNode) {
  const bits = [NAME[n.type] ?? n.type];
  if (n.type === 'retry') bits.push(`${n.times}번`);
  if (n.type === 'for_each_point') bits.push(`${n.points?.length ?? 0}곳`);
  if (n.type === 'goto') bits.push(n.point === 'current' ? '지금 지점' : n.point ? pointText(n.point) : '지점 없음');
  if (n.type === 'wait') bits.push(`${n.seconds}초`);
  if (n.level) bits.push(LEVEL[n.level] ?? n.level);
  if (n.message) bits.push(`«${n.message}»`);
  if (n.finish) bits.push('끝내기');
  return bits.join(' · ');
}
const rows = (root: BtNode) => {
  const out: { node: BtNode; path: number[] }[] = [], walk = (n: BtNode, p: number[]) => { out.push({ node: n, path: p }); kids(n).forEach((c, i) => walk(c, [...p, i])); };
  walk(root, []); return out;
};
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** 숫자 칸: 비우면 undefined(선택 칸 빼기), 숫자가 아니면 그대로 두지 않고 NaN 을 넣어 검사가 알리게 */
function Num({ label: l, value, on, ro, step = 'any', min, max }: { label: string; value: number | undefined; on: (v: number | undefined) => void; ro: boolean; step?: string; min?: number; max?: number }) {
  return <label className="be-field"><span className="lbl">{l}</span>
    <input className="fh-user" type="number" inputMode="decimal" step={step} min={min} max={max} readOnly={ro} value={value === undefined || Number.isNaN(value) ? '' : value}
      onChange={(e) => on(e.target.value === '' ? undefined : Number(e.target.value))} /></label>;
}

/** at = 화면 점 → 지도 좌표(simstart toWorld), blocked = 그 점에 설 수 없으면 이유(simstart blocked — 시작 위치와 같은 규칙) */
export type Top = { href: string; bounds: [number, number, number, number]; at: (r: DOMRect, cx: number, cy: number) => [number, number]; blocked: (x: number, y: number) => string };
/** map·floor = 고른 지도·층 id(한 층 지도면 ''), scenarios = 그 층 시나리오 파일, top = 위에서 본 사진(없으면 숫자로만), openUrl = 시작 위치까지 붙은 열기 주소 */
export function BtEditor({ map, floor, scenarios, top, openUrl, admin }: { map: string; floor: string; scenarios?: Scenario[]; top?: Top; openUrl: string; admin: boolean }) {
  const base = useMemo(() => defaultMission(scenarios), [scenarios]);
  const [saved, setSaved] = useState(() => listMissions(map, floor));
  const [cur, setCur] = useState(''), [tree, setTree] = useState<Tree | null>(base?.tree ?? null), [name, setName] = useState('');
  const [sel, setSel] = useState<number[]>([]), [kind, setKind] = useState('photo'), [why, setWhy] = useState(''), [dirty, setDirty] = useState(false), [note, setNote] = useState('');
  const [key, setKey] = useState(map + '/' + floor);
  if (key !== map + '/' + floor) {   // 지도·층을 바꾸면 그 지도 기본 임무부터(고치던 것은 버림 — 저장한 것은 목록에 남음)
    setKey(map + '/' + floor); setSaved(listMissions(map, floor)); setCur(''); setTree(base?.tree ?? null); setName(''); setSel([]); setWhy(''); setDirty(false); setNote('');
  }
  if (!base || !tree) return <section className="lv-card be" aria-label="임무 편집" data-bt-editor><h2>임무 편집</h2><p className="lv-note">이 지도에는 기본 임무가 없습니다.</p></section>;
  const ro = !admin, err = check(tree), mine = saved.find((m) => m.id === cur), node = nodeAt(tree.root, sel) ?? tree.root;
  const change = (t: Tree) => { setTree(t); setDirty(true); setNote(''); };
  const run = (op: Op) => { const r = edit(tree, sel, op, kind); if (typeof r === 'string') setWhy(r); else { setWhy(''); change(r.tree); setSel(r.path); } };
  const field = (k: keyof BtNode, v: unknown) => change(setField(tree, sel, k, v));
  const open = (id: string) => {
    const m = saved.find((x) => x.id === id);
    setCur(m ? id : ''); setTree(structuredClone(m?.tree ?? base.tree)); setName(m?.name ?? ''); setSel([]); setWhy(''); setDirty(false); setNote('');
  };
  const store = (copy: boolean) => {
    const m: Mission = { id: copy || !mine ? newId() : mine.id, name: name.trim() || `내 임무 ${saved.length + 1}`, map, floor, tree };
    if (!saveMission(m)) { setNote('이 브라우저에 저장하지 못했습니다(사생활 창·저장 공간) — 저장되기 전에는 이 임무로 시뮬을 열 수 없습니다.'); return; }
    setSaved(listMissions(map, floor)); setCur(m.id); setName(m.name); setDirty(false); setNote(`저장했습니다 — ${m.name}`);
  };
  const remove = () => {
    if (!mine) return;
    if (!dropMission(mine.id)) { setNote('지우지 못했습니다 — 저장소를 확인해 주세요.'); return; }
    setSaved(listMissions(map, floor)); open('');
  };
  const press = (e: MouseEvent<SVGSVGElement>) => {
    if (ro || !top) return;
    // 소수 2자리로 먼저 확정해 검사·표시·저장이 같은 점(simstart 시작 위치와 같음)
    const [x, y] = top.at(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY).map((v) => +v.toFixed(2)), p = { x, y };
    if (node.type !== 'for_each_point' && node.type !== 'goto') { setWhy('«지점마다»나 «이동» 노드를 고른 뒤 사진을 누르세요.'); return; }
    const no = top.blocked(p.x, p.y);
    if (no) { setWhy(no); return; }
    setWhy('');
    field(node.type === 'goto' ? 'point' : 'points', node.type === 'goto' ? p : [...(node.points ?? []), p]);
  };
  const pts = treePoints(tree), mark = node.points ?? (node.point && node.point !== 'current' ? [node.point] : []);
  const [x0, y0, x1, y1] = top?.bounds ?? [0, 0, 1, 1], k = Math.max(x1 - x0, y1 - y0) * 0.012;
  const canOpen = !err && !dirty, href = cur ? `${openUrl}&bt=${cur}` : openUrl;
  const opener = canOpen ? <a className="btn pri" href={href} data-bt-open>이 임무로 시뮬 열기</a>
    : <button type="button" className="btn pri" disabled data-bt-open aria-describedby="be-open-why">이 임무로 시뮬 열기</button>;
  const pointList = (list: Pt[], set: (l: Pt[]) => void) => <ol className="be-points" aria-label="순찰 지점">{list.map((p, i) => <li key={i} className="fh-row">
    <b>{i + 1}</b>
    <Num label="x (m)" value={p.x} ro={ro} on={(v) => set(list.map((q, j) => (j === i ? { ...q, x: v ?? NaN } : q)))} />
    <Num label="y (m)" value={p.y} ro={ro} on={(v) => set(list.map((q, j) => (j === i ? { ...q, y: v ?? NaN } : q)))} />
    {!ro && <button type="button" className="btn" onClick={() => set(list.filter((_, j) => j !== i))} aria-label={`지점 ${i + 1} 빼기`}>빼기</button>}</li>)}</ol>;
  return <section className="lv-card be" aria-label="임무 편집" data-bt-editor>
    <h2>임무 편집</h2>
    <p className="lv-note">{ro ? '보기 전용 — 임무 편집·저장은 총괄 계정에서 합니다.' : '이 브라우저에만 저장됩니다(서버 저장·공유 없음). 검사는 시뮬 실행기와 같은 규칙입니다.'}</p>
    <div className="fh-row">
      <label className="fh-row"><span className="lbl">임무</span>
        <select className="fh-user fh-sel" aria-label="임무 고르기" value={cur} onChange={(e) => open(e.target.value)} data-bt-pick>
          <option value="">기본 임무 · {base.name}</option>{saved.map((m) => <option key={m.id} value={m.id}>내 임무 · {m.name}</option>)}
        </select></label>
      {!ro && <label className="fh-row be-grow"><span className="lbl">이름</span>
        <input className="fh-user be-grow" value={name} placeholder={mine?.name ?? '새 임무 이름'} maxLength={40} onChange={(e) => { setName(e.target.value); if (mine) setDirty(true); }} data-bt-name /></label>}
    </div>
    {!ro && <div className="fh-row" role="group" aria-label="저장">
      <button type="button" className="btn" disabled={!mine || !dirty} onClick={() => store(false)} data-bt-save>저장</button>
      <button type="button" className="btn" onClick={() => store(true)} data-bt-save-new>{mine ? '새 임무로 저장' : '내 임무로 저장'}</button>
      <button type="button" className="btn" onClick={() => { change(structuredClone(base.tree)); setSel([]); }} data-bt-reset>기본 임무로 되돌리기</button>
      {mine && <button type="button" className="btn" onClick={remove} data-bt-delete>이 임무 지우기</button>}
    </div>}
    {note && <p className={`fh-msg${note.startsWith('저장했') ? ' ok' : ''}`} role="status" data-bt-note>{note}</p>}
    <div className="be-grid">
      <div className="be-col">
        <Num label="전체 시간 상한 (초, 1~3600)" value={tree.max_seconds} ro={ro} step="1" min={1} max={3600} on={(v) => change({ ...tree, max_seconds: v ?? NaN })} />
        <ul className="be-tree" aria-label="임무 나무" data-bt-tree>{rows(tree.root).map(({ node: n, path }) => <li key={path.join('.')} style={{ paddingLeft: path.length * 14 }}>
          <button type="button" aria-pressed={same(path, sel)} onClick={() => { setSel(path); setWhy(''); }} data-bt-row={path.join('.')}>{label(n)}</button></li>)}</ul>
        {!ro && <div className="fh-row be-tools" role="toolbar" aria-label="노드 고치기">
          <label className="fh-row"><span className="lbl">종류</span><select className="fh-user fh-sel" aria-label="추가할 종류" value={kind} onChange={(e) => setKind(e.target.value)} data-bt-kind>
            {KINDS.map((t) => <option key={t} value={t}>{NAME[t]}</option>)}</select></label>
          <button type="button" className="btn" onClick={() => run('add')} data-bt-op="add">추가</button>
          <button type="button" className="btn" onClick={() => run('remove')} data-bt-op="remove">지우기</button>
          <button type="button" className="btn" onClick={() => run('up')} data-bt-op="up" aria-label="위로">↑ 위로</button>
          <button type="button" className="btn" onClick={() => run('down')} data-bt-op="down" aria-label="아래로">↓ 아래로</button>
          <button type="button" className="btn" onClick={() => run('in')} data-bt-op="in">안으로</button>
          <button type="button" className="btn" onClick={() => run('out')} data-bt-op="out">밖으로</button>
        </div>}
        {why && <p className="fh-why" role="status" data-bt-why>{why}</p>}
      </div>
      <div className="be-col" aria-label="고른 노드" data-bt-node={node.type}>
        <b>{NAME[node.type] ?? node.type}</b>
        {node.type === 'retry' && <Num label="시도 횟수 (1~3)" value={node.times} ro={ro} step="1" min={1} max={3} on={(v) => field('times', v ?? NaN)} />}
        {node.type === 'wait' && <Num label="기다릴 초" value={node.seconds} ro={ro} on={(v) => field('seconds', v ?? NaN)} />}
        {node.type in BT.ACTION_SECONDS && <Num label={`시간 상한 (초, 비우면 ${BT.ACTION_SECONDS[node.type]})`} value={node.max_seconds} ro={ro} on={(v) => field('max_seconds', v)} />}
        {MESSAGE.includes(node.type) && <label className="be-field"><span className="lbl">문구</span>
          <input className="fh-user" value={node.message ?? ''} readOnly={ro} maxLength={80} onChange={(e) => field('message', e.target.value)} data-bt-message /></label>}
        {(node.type === 'review_is' || node.type === 'map_mark') && <label className="be-field"><span className="lbl">단계</span>
          <select className="fh-user fh-sel" value={node.level} disabled={ro} onChange={(e) => field('level', e.target.value)} data-bt-level>
            {(node.type === 'review_is' ? ['clear', 'minor', 'danger'] : ['minor', 'danger']).map((l) => <option key={l} value={l}>{LEVEL[l]}</option>)}</select></label>}
        {node.type === 'report' && <label className="fh-row"><input type="checkbox" checked={!!node.finish} disabled={ro} onChange={(e) => field('finish', e.target.checked || undefined)} />보고 뒤 임무 끝내기</label>}
        {node.type === 'skip_log' && <label className="fh-row"><input type="checkbox" checked={!!node.remaining} disabled={ro} onChange={(e) => field('remaining', e.target.checked || undefined)} />남은 지점 모두 건너뜀으로 기록</label>}
        {node.type === 'goto' && <>
          <label className="fh-row"><input type="checkbox" checked={node.point === 'current'} disabled={ro} onChange={(e) => field('point', e.target.checked ? 'current' : { x: 0, y: 0 })} data-bt-current />지금 순찰 지점(«지점마다» 안에서만)</label>
          {node.point && node.point !== 'current' && pointList([node.point], ([p]) => field('point', p ?? 'current'))}</>}
        {node.type === 'for_each_point' && pointList(node.points ?? [], (l) => field('points', l))}
        {top && <svg className="dv-start-map be-map" viewBox={`${x0} ${-y1} ${x1 - x0} ${y1 - y0}`} role="img" onClick={press} data-bt-top
          aria-label={ro ? '순찰 지점 보기' : '위에서 본 모습 — «지점마다»를 고르고 누르면 지점 추가, «이동»을 고르고 누르면 그 지점'}>
          <image href={top.href} x={x0} y={-y1} width={x1 - x0} height={y1 - y0} preserveAspectRatio="none" />
          {pts.map((p, i) => <circle key={i} cx={p.x} cy={-p.y} r={k * .7} className="be-dot" />)}
          {mark.map((p, i) => <g key={i} pointerEvents="none"><circle cx={p.x} cy={-p.y} r={k * 1.4} className="be-pick" /><text x={p.x} y={-p.y + k * .5} fontSize={k * 1.5} textAnchor="middle" className="be-num">{i + 1}</text></g>)}
        </svg>}
      </div>
    </div>
    {err ? <p className="fh-msg" role="alert" data-bt-err>검사 실패: {err}</p> : <p className="fh-msg ok" data-bt-ok>검사 통과 · 지점 {pts.length}곳</p>}
    <div className="fh-row">{opener}
      {!canOpen && <span id="be-open-why" className="fh-why">{err ? '검사를 통과해야 열 수 있습니다.' : '바꾼 내용을 저장한 뒤 열 수 있습니다.'}</span>}</div>
  </section>;
}

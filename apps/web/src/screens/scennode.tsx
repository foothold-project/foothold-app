// SCEN-LIFECYCLE-EDITOR 11-09 — 시나리오 편집 오른쪽 창의 «운영 흐름»(React Flow). 위 = 상시 감시 + 단계 띠 5개(됨·일부·아직 없음 개수), 아래 = 노드·상세.
// SCEN-ONE-FLOW 11-10 — 다섯 단계를 한 캔버스에 묶음 상자로. 단계 띠 = 그 묶음으로 화면 이동(거르기 아님).
// 임무 단계 = 지금 시나리오(시작 → 지점 → 끝나면) 그대로 — 이 칸은 api 를 부르지 않는다(지점 편집 창 내용은 missions.tsx 가 지금 편집 함수로 만들어 넘김).
// 다른 단계 = lifecycle.ts 판정 읽기만(끌기·연결·추가 없음). 시뮬 탭 = 웹 시뮬(websim) 판정, 지도 탭 = 실기(real) 판정.
// SCEN-ONE-FLOW-R1·R2 11-10 — «크게 보기»(처음부터 기본) = 노드가 본문 전체, 캔버스 = 그래프 1배 높이(휠은 창 스크롤), 지도는 떠 있는 작은 창(mapscen.tsx Float).
// SCEN-ONE-FLOW-R3 11-10 — Codex 예시 «접힌 운영 흐름»: 고정 절차 넷은 요약 카드(누르면 펼침·묶음 «접기»), 기둥 = 연결·운행 준비 | 임무 | 복귀·종료·예외 처리,
// 판정 배지는 «지원 현황»을 켰을 때만(시뮬 거절 «시뮬에서 실행 못 함»은 늘), 예외 처리는 시작에서 점선 하나(«발생할 때 확인») — 정상 순서 선 없음. 지점을 고르면 편집 창(form).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Background, BackgroundVariant, ControlButton, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow,
  type Edge, type Node, type NodeProps, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './scennode.css';
import { LIFE, STAGES, type Judge, type LifeNode, type Stage, type Where } from './lifecycle';
import { inApp } from '../screens';

export type StepKind = 'MOVE' | 'PHOTO' | 'WAIT' | 'OTHER';
/** title = 지점 이름 자리, sub = 할 일, at = 자리(좌표), no = 시뮬에서 실행 못 하는 이유(시뮬 탭에서 scenarioTree 가 거절한 지점) */
export type NodeIn = { title: string; sub: string; kind: StepKind; at?: string; no?: string };
type Badge = { st: Judge | 'na' | 'no'; text: string };
/** kind = 카드 맨 위 작은 글(«고정 절차 · 읽기 전용» 등), meta = 둘째 설명 줄, count = «N개 항목», stage = 요약 카드(누르면 그 묶음 펼침) */
type Data = { kind?: string; title: string; sub?: string; meta?: string; count?: string; wp?: number; on?: boolean; badge?: Badge; stage?: Stage };
type N = Node<Data, 'step'>;
type BoxData = { stage: Stage; title: string; sub: string; on?: boolean; fold?: () => void };
type B = Node<BoxData, 'box'>;
type F = N | B;
const W = 220, PADY = 16;
// 화면 맞춤: 글자가 읽히게 0.8 아래로는 줄이지 않고, 넘치면 위(시작)부터 보인다 — 나머지는 끌어 내려 본다
const FIT = { padding: 0.12, maxZoom: 1, minZoom: 0.8 };
/** 묶음 상자: 옆·아래 여백, 위 = 제목 칸, GAP = 묶음 사이, HS = 요약 카드 높이. 카드 높이 어림(H) = 임무(작은 글·이름·할 일·자리·배지) / 고정 절차(작은 글·이름·배지) */
const PAD = 16, TOP = 48, GAP = 56, HS = 128, GX = W + 24;
const MISSION = { gy: 136, h: 120 }, FIXED = { gy: 104, h: 88 };
/** 지점 할 일 → 표의 임무 노드(처리 주체·실패 시·판정을 빌려 씀). 여러 할 일이 섞인 임무(OTHER)는 대응 없음 */
const KIND_LIFE: Partial<Record<StepKind, string>> = { MOVE: 'gotoA', PHOTO: 'capture', WAIT: 'wait' };
/** 갈래(실패·대기 때만 가는 노드) — 본 줄 옆 칸에 선 없이 */
const SIDE = new Set(['retry', 'connection_failed', 'lease_wait', 'not_ready']);
/** 상시 안전 감시 한 줄 = 이 노드들의 판정 */
const WATCH: [string, string][] = [['통신', 'link_lost'], ['조종권', 'lease'], ['배터리', 'battery_low'], ['장치', 'check'], ['STOP', 'safe_stop']];
/** 고정 절차 묶음(접고 펼침)과 요약 카드 대표 항목 한 줄 */
export const FOLDS = ['연결', '운행 준비', '복귀·종료', '예외 처리'] as const satisfies readonly Stage[];
const GIST: Record<(typeof FOLDS)[number], string> = { 연결: '연결 대상 · 인증 · 상태 수신', '운행 준비': '지도·위치 · 조종권 · 운행 승인', '복귀·종료': '복귀 · 도착 확인 · 결과 기록', '예외 처리': '통신 끊김 · 장애물 · 운영자 대응' };
/** 기둥(왼쪽 → 오른쪽, 기둥 안은 위 → 아래) */
const COLS: Stage[][] = [['연결', '운행 준비'], ['임무'], ['복귀·종료', '예외 처리']];
const life = (id?: string) => LIFE.find((n) => n.id === id);

export function badgeOf(n: LifeNode, w: Where): Badge {
  const s = n.status[w];
  if (s === '없음' && w === 'websim' && n.missing.websim.startsWith('해당 없음')) return { st: 'na', text: '브라우저 시뮬엔 없음' };
  return { st: s, text: s === '없음' ? '아직 없음' : s };
}
/** 단계별 됨·일부·없음 개수 */
export const counts = (stage: Stage, w: Where) => { const l = LIFE.filter((n) => n.stage === stage);
  return { done: l.filter((n) => n.status[w] === '됨').length, part: l.filter((n) => n.status[w] === '일부').length, none: l.filter((n) => n.status[w] === '없음').length }; };
const countText = (s: Stage, w: Where) => { const c = counts(s, w); return `됨 ${c.done} · 일부 ${c.part} · 아직 없음 ${c.none}`; };

const Tag = ({ b }: { b: Badge }) => <span className="sn-badge" data-st={b.st}>{b.text}</span>;

/** 노드 카드: 작은 글·(번호)이름·설명·자리·개수·판정. 점 넷(위 = 들어옴, 아래 = 나감, 오른쪽 = 옆 기둥으로 나감, 왼쪽 = 옆 기둥에서 들어옴)은 모두 안 보임 — 화살표가 방향 */
function Step({ data }: NodeProps<N>) {
  return <div className="sn-card" data-on={data.on ? '' : undefined} data-num={data.wp} data-sum={data.stage}>
    {/* handle 을 안 적은 선은 첫 점을 쓴다 — 위(target)·아래(source)를 먼저 둔다 */}
    <Handle type="target" position={Position.Top} isConnectable={false} /><Handle type="source" position={Position.Bottom} isConnectable={false} />
    {data.kind && <small className="sn-kind">{data.kind}</small>}
    <div className="sn-head">{data.wp != null && <span className="sn-num">{data.wp + 1}</span>}<b className="sn-title">{data.title}</b></div>
    {data.sub && <div className="sn-sub">{data.sub}</div>}
    {data.meta && <div className="sn-sub">{data.meta}</div>}
    {data.count && <span className="sn-count">{data.count}</span>}
    {data.badge && <div className="sn-foot"><Tag b={data.badge} /></div>}
    <Handle id="r" type="source" position={Position.Right} isConnectable={false} /><Handle id="l" type="target" position={Position.Left} isConnectable={false} />
  </div>;
}
/** 펼친 묶음 상자(배경): 제목(지원 현황이면 개수) + «접기», 왼쪽 점 = 시작에서 오는 예외 점선용(안 보임) */
function Box({ data }: NodeProps<B>) {
  return <div className="sn-box" data-group={data.stage} data-on={data.on ? '' : undefined}>
    <div className="sn-box-head"><b>{data.title}</b>{data.sub && <> · {data.sub}</>}
      {data.fold && <button type="button" className="sn-chip sn-fold nodrag nopan" data-fold-stage={data.stage} onClick={data.fold}>접기 ▴</button>}</div>
    <Handle id="l" type="target" position={Position.Left} isConnectable={false} />
  </div>;
}
const TYPES = { step: Step, box: Box };
const line = (source: string, target: string): Edge => ({ id: `${source}>${target}`, source, target, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } });
const at = (x: number, y: number, gy: number) => ({ position: { x: x * GX, y: y * gy }, style: { width: W } });
type G = { nodes: N[]; edges: Edge[]; first: string; last: string; h: number };

/** 임무 단계: 시작 → 지점 1..n → 끝나면, 앞에서 뒤로 선 하나씩. sup = 지원 현황(할 일에 맞는 표 노드 판정) — 시뮬이 거절한 지점의 «시뮬에서 실행 못 함»은 늘 */
export function missionGraph(items: NodeIn[], end: string, w: Where, sup = false): G {
  const { gy, h } = MISSION;
  const nodes: N[] = [
    { id: 'start', type: 'step', ...at(0, 0, gy), data: { kind: '시작', title: '순찰 시작', sub: '정해진 순서대로 지점 방문' } },
    ...items.map((t, i): N => { const l = life(KIND_LIFE[t.kind]);
      return { id: `w${i}`, type: 'step', ...at(0, i + 1, gy), data: { kind: '편집 가능한 지점', title: t.title, sub: t.sub, meta: t.at, wp: i,
        badge: t.no && w === 'websim' ? { st: 'no', text: '시뮬에서 실행 못 함' } : sup && l ? badgeOf(l, w) : undefined } }; }),
    { id: 'end', type: 'step', ...at(0, items.length + 1, gy), data: { kind: '종료 설정', title: '끝나면', sub: end } },
  ];
  return { nodes, edges: nodes.slice(1).map((n, i) => line(nodes[i].id, n.id)), first: 'start', last: 'end', h };
}
/** 고정 절차 단계(읽기만): 본 줄은 위→아래 선으로, 갈래는 바로 앞 본 노드 옆에 선 없이(갈래가 이어지면 한 칸씩 아래로 — 겹치지 않게). 예외 처리는 순서가 아니라 두 줄 격자(선 없음) */
export function stageGraph(stage: Stage, w: Where, sup = false): G {
  const l = LIFE.filter((n) => n.stage === stage), grid = stage === '예외 처리', { gy, h } = FIXED;
  const nodes: N[] = [], main: string[] = [];
  let sideRow = -1;
  l.forEach((n, i) => {
    const side = !grid && SIDE.has(n.id);
    if (side) sideRow = Math.max(main.length - 1, sideRow + 1, 0);
    const pos = grid ? at(i % 2, Math.floor(i / 2), gy) : side ? at(1, sideRow, gy) : at(0, main.length, gy);
    if (!grid && !side) main.push(n.id);
    nodes.push({ id: n.id, type: 'step', ...pos, data: { kind: '고정 절차 · 읽기 전용', title: n.name, badge: sup ? badgeOf(n, w) : undefined } });
  });
  return { nodes, edges: main.slice(1).map((id, i) => line(main[i], id)), first: main[0] ?? l[0].id, last: main[main.length - 1] ?? l[0].id, h };
}

const dash = (source: string, target: string, label: string): Edge => ({ id: `${source}>${target}`, source, target, sourceHandle: 'r', targetHandle: 'l',
  label, type: 'smoothstep', className: 'sn-jump', style: { strokeDasharray: '6 4' }, markerEnd: { type: MarkerType.ArrowClosed } });
export type Area = { id: string; x: number; y: number; w: number; h: number };
/** 한 캔버스: 임무 = 늘 펼친 묶음, 고정 절차 넷 = open 에 있으면 묶음 상자 + 그 노드(stageGraph), 없으면 요약 카드 하나(s:단계). 기둥 = COLS.
 *  선 = 연결 → 운행 준비, 운행 준비 → 시작, 끝나면 → 복귀·종료, 시작 → 예외 처리 점선 «발생할 때 확인» 하나(예외 노드 사이·예외 → 복귀 선은 만들지 않는다 —
 *  실행기가 못 하는 흐름을 된다고 보이지 않게). fold = 펼친 묶음 «접기» */
export function flowGraph(items: NodeIn[], end: string, w: Where, open: ReadonlySet<Stage> = new Set(), sup = false, fold?: (s: Stage) => void) {
  const boxes: B[] = [], nodes: N[] = [], edges: Edge[] = [], areas = {} as Record<Stage, Area>, ends = {} as Record<Stage, [string, string]>;
  const block = (s: Stage) => {
    const title = `${STAGES.indexOf(s) + 1}. ${s}`;
    if (s !== '임무' && !open.has(s)) {
      const id = `s:${s}`;
      return { w: W, h: HS, put: (x: number, y: number) => { ends[s] = [id, id];
        nodes.push({ id, type: 'step', position: { x, y }, style: { width: W, height: HS },
          data: { kind: '고정 절차 · 펼쳐보기', title, sub: GIST[s as (typeof FOLDS)[number]], count: `${LIFE.filter((n) => n.stage === s).length}개 항목`, stage: s, meta: sup ? countText(s, w) : undefined } });
        return id; } };
    }
    const g = s === '임무' ? missionGraph(items, end, w, sup) : stageGraph(s, w, sup);
    const width = Math.max(...g.nodes.map((n) => n.position.x)) + W + PAD * 2, height = Math.max(...g.nodes.map((n) => n.position.y)) + g.h + TOP + PAD;
    return { w: width, h: height, put: (x: number, y: number) => { ends[s] = [g.first, g.last];
      boxes.push({ id: `g:${s}`, type: 'box', position: { x, y }, zIndex: -1, selectable: false, focusable: false, style: { width, height },
        data: { stage: s, title: s === '임무' ? `${title} · 지점과 할 일 편집` : title, sub: sup ? countText(s, w) : '', fold: s === '임무' || !fold ? undefined : () => fold(s) } });
      edges.push(...g.edges);
      nodes.push(...g.nodes.map((n) => ({ ...n, position: { x: n.position.x + x + PAD, y: n.position.y + y + TOP } })));
      return `g:${s}`; } };
  };
  let x = 0;
  for (const col of COLS) {
    const bl = col.map(block);
    let y = 0;
    col.forEach((s, i) => { areas[s] = { id: bl[i].put(x, y), x, y, w: bl[i].w, h: bl[i].h }; y += bl[i].h + GAP; });
    x += Math.max(...bl.map((b) => b.w)) + GAP;
  }
  edges.push({ ...line(ends['연결'][1], ends['운행 준비'][0]), className: 'sn-link' },
    { ...line(ends['운행 준비'][1], 'start'), sourceHandle: 'r', targetHandle: 'l', className: 'sn-link' },
    { ...line('end', ends['복귀·종료'][0]), sourceHandle: 'r', targetHandle: 'l', className: 'sn-link' },
    dash('start', open.has('예외 처리') ? 'g:예외 처리' : 's:예외 처리', '발생할 때 확인'));
  return { boxes, nodes, edges, areas };
}

/** where = 이 탭 판정(websim·real), items = 지점 순서대로, end = «끝나면», on = 지도에서 고른 지점, pick = 지점 노드를 고르면 지도 강조, edit = 그 지점을 목록에서 편집,
 *  form = 고른 지점(on) 편집 칸(할 일·X/Y·순서·지우기 — missions.tsx 의 지금 편집 함수). 없으면 지점도 읽기 상세 */
export const ScenNodes = (p: { where: Where; items: NodeIn[]; end: string; on: number | null; pick: (i: number) => void; edit: (i: number) => void; form?: ReactNode }) =>
  <ReactFlowProvider><Lifecycle {...p} /></ReactFlowProvider>;

function Lifecycle({ where, items, end, on, pick, edit, form }: { where: Where; items: NodeIn[]; end: string; on: number | null; pick: (i: number) => void; edit: (i: number) => void; form?: ReactNode }) {
  // sel = 누른 노드(누를 때의 지도 선택과 함께) — 그 뒤 지도에서 다른 지점을 고르면 그 지점을 따른다
  // stage = 화면을 맞춘 묶음(띠에서 고름), open = 펼친 고정 절차 묶음(처음 = 모두 접힘), sup = 지원 현황(판정 배지)
  const [stage, setStage] = useState<Stage>('임무'), [sel, setSel0] = useState<{ id: string; on: number | null } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<Stage>>(() => new Set()), [sup, setSup] = useState(false);
  // shut = 크게 보기에서 × 로 닫은 상세(그 노드) — 다른 노드를 누르거나 같은 노드를 다시 누르면 다시 뜬다(지도에서 다른 지점을 골라도)
  const [shut, setShut] = useState<string | null>(null);
  useEffect(() => setShut(null), [on]);
  const setSel = (id: string) => { setSel0({ id, on }); setShut(null); };
  const flow = useReactFlow();
  // 캔버스는 노드 내용이 바뀌면 새로 그린다(key) — 지점·할 일만 바뀐 뒤 = 보던 화면 그대로(keep).
  // R7 11-10 «열거나 접을 때 시점이 이상한 데로»: 접고 펼친 뒤 = 다시 맞추지 않고(옛 init → view(s) = 배율·위치 새로 맞춤) 누른 묶음(모두 = 임무)의
  // 제목 자리가 같은 화면 위치에 남게 새 배치 좌표 차이만큼만 옮김(배율 그대로, anchor = 누르기 전 그 묶음 좌표)
  const anchor = useRef<{ s: Stage; x: number; y: number } | null>(null), keep = useRef<Viewport | null>(null);
  const pin = (s: Stage) => { anchor.current = { s, x: g.areas[s].x, y: g.areas[s].y }; };
  const fold = (s: Stage) => { pin(s); setStage(s); setOpen((o) => { const n = new Set(o); if (n.has(s)) n.delete(s); else n.add(s); return n; }); };
  const all = FOLDS.every((s) => open.has(s));
  const g = flowGraph(items, end, where, open, sup, fold);
  const key = JSON.stringify(g.nodes.map((n) => [n.id, n.data])), was = useRef(key);
  if (was.current !== key) { was.current = key; keep.current = flow.getViewport(); }
  const focus = sel && sel.on === on ? sel.id : on != null ? `w${on}` : null;
  const tap = (id: string) => { const n = g.nodes.find((x) => x.id === id); if (n?.data.stage) return fold(n.data.stage); setSel(id); if (n?.data.wp != null) pick(n.data.wp); };
  const root = useRef<HTMLDivElement>(null), A = Object.values(g.areas), gw = Math.max(...A.map((a) => a.x + a.w)), gh = Math.max(...A.map((a) => a.y + a.h));
  const canvas = () => root.current?.querySelector('.sn-canvas');
  // 묶음 맞춤 = 읽히는 배율(FIT)로, 묶음이 화면보다 크면 묶음 위·왼쪽부터. s 없음 = 전체 보기(배율 제한 없이)
  // 크게 보기 = 1배 그대로: 그 묶음이 가로 가운데(그래프 끝 넘지 않게)·위가 캔버스 위에(R6 — 창 스크롤 없이 캔버스 안에서 옮김)
  const view = (s?: Stage) => {
    if (big) { const cw = canvas()?.clientWidth ?? 0;
      if (!s) { const vh = canvas()?.clientHeight ?? 0, z = Math.max(0.05, Math.min(1, (cw - PADY * 2) / gw, (vh - PADY * 2) / gh));   // 전체 = 캔버스에 다 들어오게
        return void flow.setViewport({ zoom: z, x: (cw - gw * z) / 2, y: PADY }); }
      const b = g.areas[s];
      return void flow.setViewport({ zoom: 1, y: PADY - b.y, x: Math.min(PADY, Math.max(cw - gw - PADY, (cw - b.w) / 2 - b.x)) }); }
    if (!s) return void flow.fitView({ padding: 0.04 });
    const id = g.areas[s].id;
    void flow.fitView({ ...FIT, nodes: [{ id }] }).then(() => { const b = flow.getNode(id), v = flow.getViewport(); if (!b) return;
      const x = b.position.x * v.zoom + v.x < 0 ? 16 - b.position.x * v.zoom : v.x, y = b.position.y * v.zoom + v.y < 0 ? 16 - b.position.y * v.zoom : v.y;
      if (x !== v.x || y !== v.y) void flow.setViewport({ ...v, x, y }); }); };
  const init = () => { const a = anchor.current, v = keep.current; anchor.current = null; keep.current = null;
    if (a && v) { const b = g.areas[a.s]; return void flow.setViewport({ zoom: v.zoom, x: v.x - (b.x - a.x) * v.zoom, y: v.y - (b.y - a.y) * v.zoom }); }
    if (v) void flow.setViewport(v); else view(stage); };
  const go = (s: Stage) => { setStage(s); view(s); };
  // 크게 보기 = 오른쪽 창 전체가 캔버스(윗줄 = 단계 이동·확대·모두 펼치기·지원 현황, 그 아래 상시 안전 감시 한 줄, 상세는 누를 때만 캔버스 위 카드). 창 넓이·창 위 줄 숨김은 mapscen.css.
  // R4 11-10 «원래 크기 없애고 크게 보기만»: PC 넓은 창은 늘 크게(켜고 끄는 단추·Esc·기억값 없음). 앱(WebView)·좁은 창(1023.98px 아래)은 지금처럼 나란히·한 열
  const big = !inApp() && !globalThis.matchMedia?.('(max-width:1023.98px)').matches;
  useEffect(() => { const t = setTimeout(() => view(stage), 150); return () => clearTimeout(t); }, [big]);   // 캔버스 크기가 바뀐 뒤 고른 묶음에 다시 맞춤
  const wp = focus && /^w\d+$/.test(focus) ? Number(focus.slice(1)) : null, close = big ? () => setShut(focus) : undefined;

  return <div ref={root} className="sn" data-scen-nodes data-big={big ? '' : undefined} data-stage={stage} data-groups={g.boxes.length} data-nodes={g.nodes.length} data-edges={g.edges.length} data-support={sup ? '' : undefined}>
    <div className="sn-top">
      {/* 크게 보기: 캔버스가 길어 안쪽 확대·축소 칸이 화면 밖으로 가므로 윗줄(창 위에 붙음)로 */}
      {big && <span className="sn-zoom" role="group" aria-label="확대·축소">
        <button type="button" className="sn-chip" aria-label="축소" title="축소 (휠)" onClick={() => void flow.zoomOut()}>−</button>
        <button type="button" className="sn-chip" aria-label="확대" title="확대 (휠)" onClick={() => void flow.zoomIn()}>+</button>
        <button type="button" className="sn-chip" aria-label="화면 맞춤" title="화면 맞춤(고른 단계, 1배)" onClick={() => view(stage)}>⤢</button>
        <button type="button" className="sn-chip" aria-label="전체 보기" title="전체 보기" data-fit-all onClick={() => view()}>⊞</button></span>}
      <div className="sn-stages" role="group" aria-label="운영 흐름 단계">
        {STAGES.map((s, i) => { const c = counts(s, where);
          return <button type="button" key={s} className="btn sn-stage" aria-pressed={stage === s} data-stage={s} data-done={c.done} data-part={c.part} data-none={c.none}
            title={countText(s, where)} onClick={() => go(s)}>
            <b>{i + 1}. {s}</b><small>{countText(s, where)}</small></button>; })}
      </div>
      <span className="sn-tools">
        <button type="button" className="sn-chip" data-all-open aria-pressed={all} title="두 번째 안(단계 펼침) = 고정 절차를 모두 펼친 모양"
          onClick={() => { pin('임무'); setOpen(all ? new Set() : new Set(FOLDS)); }}>{all ? '모두 접기' : '모두 펼치기'}</button>
        <label className="sn-sup" title="코드 기준 판정(됨·일부·아직 없음) — 실기체 검증과 다름"><input type="checkbox" data-support-toggle checked={sup} onChange={(e) => setSup(e.target.checked)} />지원 현황</label>
      </span>
      <div className="sn-watch" data-watch><b>상시 안전 감시</b>
        {WATCH.map(([t, id]) => { const b = badgeOf(life(id)!, where);
          return <button type="button" key={id} className="sn-chip" data-st={b.st} data-life={id} title={`${life(id)!.name} — ${b.text}`} onClick={() => setSel(id)}>{t}</button>; })}
        <span className="sn-muted">임무와 별도로 항상 · 실행 상태 아님</span></div>
    </div>
    <p className="sn-hint">{stage === '임무' ? '임무 = 지금 시나리오 — 지점 카드를 누르면 편집 창(할 일·위치·순서), 지도를 눌러 지점 추가 · 고정 절차는 눌러 펼쳐 읽기만'
      : stage === '예외 처리' ? '읽기만 — 예외 갈래는 내장 «모의 BT 공장 순찰»에만 있고 시나리오 편집기로는 만들지 않습니다'
      : '읽기만 — 코드 기준 판정(11-09 대조표)'}{where === 'real' ? ' · 실기 «됨» = 코드 경로 기준, 실기체 검증과 다름' : ''}</p>
    <div className="sn-main">
      <Flow key={key} nodes={[...g.boxes, ...g.nodes]} edges={g.edges} on={focus} stage={stage} tap={tap} init={init} view={view} big={big} />
      {(!big || (focus && shut !== focus)) && (form && wp != null && wp === on && items[wp]
        ? <PointEdit i={wp} it={items[wp]} where={where} form={form} edit={edit} close={close} />
        : <Detail id={focus} g={g.nodes} where={where} items={items} edit={edit} close={close} />)}</div>
  </div>;
}

/** on = 밝힐 노드, stage = 밝힐 묶음(상자·요약 카드), init = 처음 화면(묶음 맞춤 또는 보던 화면), view = 묶음 맞춤 · 전체 보기 */
/** big = 크게 보기(안쪽 확대·축소 칸 없음 — 윗줄 단추). R6 11-10 «스크롤 빼고 마우스 끌기로 이동»: 휠 = 확대·축소, 왼쪽 끌기 = 이동(카드 위에서도 — 노드는 안 옮김),
 *  짧은 누름 = 카드 고르기(paneClickDistance 안 흔들림까지 누름으로 — 넘게 끌면 React Flow 가 그 click 을 먹음) */
function Flow({ nodes: first, edges, on, stage, tap, init, view, big }: { nodes: F[]; edges: Edge[]; on: string | null; stage: Stage; tap: (id: string) => void; init: () => void; view: (s?: Stage) => void; big: boolean }) {
  const [nodes, setNodes] = useState(first);
  const shown = nodes.map((n): F => { const want = n.type === 'box' || n.data.stage ? n.data.stage === stage : n.id === on;
    return want !== !!n.data.on ? { ...n, data: { ...n.data, on: want } } as F : n; });
  return <div className="sn-canvas">
    <ReactFlow<F> nodes={shown} edges={edges} nodeTypes={TYPES} onInit={init} panOnScroll={false} panOnDrag zoomOnScroll paneClickDistance={4} minZoom={0.05} maxZoom={2} nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null}
      onNodesChange={(c) => setNodes((l) => applyNodeChanges(c, l))} onNodeClick={(_, n) => n.type === 'step' && tap(n.id)} aria-label="운영 흐름 노드 캔버스">
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
      {!big && <Controls showInteractive={false} showFitView={false} aria-label="확대·축소">
        <ControlButton onClick={() => view(stage)} title="화면 맞춤(고른 단계)" aria-label="화면 맞춤">⤢</ControlButton>
        <ControlButton onClick={() => view()} title="전체 보기" aria-label="전체 보기" data-fit-all>⊞</ControlButton></Controls>}
    </ReactFlow>
  </div>;
}

/** 지점 편집 창(예시 «지점 편집»): 머리 = «N번 지점»(+ 이어진 지도 지점 이름), 시뮬 거절 이유, form(missions.tsx), 안내 두 줄, 목록에서 자세히(이름·대기 초 등) */
function PointEdit({ i, it, where, form, edit, close }: { i: number; it: NodeIn; where: Where; form: ReactNode; edit: (i: number) => void; close?: () => void }) {
  const name = `${i + 1}번 지점`, no = where === 'websim' ? it.no : undefined;
  return <section className="sn-detail sn-edit" data-detail={`w${i}`} data-point-edit={i} aria-label={`${name} 편집`}>
    <div className="sn-name"><b>지점 편집 · {name}{it.title !== name ? ` · ${it.title}` : ''}</b>
      {close && <button type="button" className="sn-x" aria-label="지점 편집 닫기" title="닫기" data-detail-close onClick={close}>×</button>}</div>
    {no && <p className="sn-why"><span className="sn-badge" data-st="no">시뮬에서 실행 못 함</span><em data-miss> {no}</em></p>}
    {form}
    <p className="sn-muted">이동·할 일만 편집됩니다. 안전 절차는 고정입니다.</p>
    <p className="sn-warn">위치 변경 뒤에는 실제 경로 검사가 필요합니다.</p>
    <button type="button" className="btn" data-edit-point={i} onClick={() => edit(i)}>목록에서 자세히</button>
  </section>;
}

/** 고른 노드 상세: 이름·처리 주체·실패 시·이 탭 판정(+빠진 것). 지점이면 할 일과 «목록에서 이 지점 편집» */
function Detail({ id, g, where, items, edit, close }: { id: string | null; g: N[]; where: Where; items: NodeIn[]; edit: (i: number) => void; close?: () => void }) {
  const n = g.find((x) => x.id === id), wp = n?.data.wp, it = wp != null ? items[wp] : undefined, l = it ? life(KIND_LIFE[it.kind]) : life(id ?? undefined);
  if (!n && !l) return <p className="sn-detail sn-muted" data-detail="">노드를 누르면 처리 주체·실패 시·판정을 봅니다.</p>;
  const no = where === 'websim' ? it?.no : undefined, b = no ? { st: 'no' as const, text: '시뮬에서 실행 못 함' } : l && badgeOf(l, where);
  const miss = no ?? (l && b && b.st !== '됨' ? l.missing[where].replace(/^해당 없음 — /, '') : '');
  return <dl className="sn-detail" data-detail={id}>
    <dt className="sn-name">{it ? `${wp! + 1}번 지점 · ${it.title}` : n?.data.title ?? l!.name}
      {close && <button type="button" className="sn-x" aria-label="상세 닫기" title="닫기" data-detail-close onClick={close}>×</button>}</dt>
    {it ? <dd><span>할 일</span>{it.sub}</dd> : n && !l && n.data.sub && <dd><span>내용</span>{n.data.sub}</dd>}
    {l && <><dd><span>처리 주체</span>{l.owner}</dd><dd><span>실패 시</span>{l.onFail}</dd></>}
    {b && <dd><span>{where === 'websim' ? '웹 시뮬' : '실기'}</span><span><Tag b={b} />{miss && <em data-miss> {miss}</em>}</span></dd>}
    {wp != null && <dd><span /><span><button type="button" className="btn" data-edit-point={wp} onClick={() => edit(wp)}>목록에서 이 지점 편집</button></span></dd>}
  </dl>;
}

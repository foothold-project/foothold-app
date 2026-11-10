// SCEN-LIFECYCLE-EDITOR 11-09 — 시나리오 편집 오른쪽 창의 «운영 흐름»(React Flow). 위 = 상시 감시 + 단계 띠 5개(됨·일부·아직 없음 개수), 아래 = 노드·상세.
// SCEN-ONE-FLOW 11-10 — 다섯 단계를 한 캔버스에 묶음 상자로(본 줄 연결 → 운행 준비 → 임무 → 복귀·종료, 예외 처리는 임무 오른쪽). 단계 띠 = 그 묶음으로 화면 이동(거르기 아님).
// 임무 단계 = 지금 시나리오(시작 → 지점 → 끝나면) 그대로 — 고치는 곳은 지도·목록(저장 규칙 그대로), 이 칸은 api 를 부르지 않는다.
// 다른 단계 = lifecycle.ts 판정 읽기만(끌기·연결·추가 없음). 시뮬 탭 = 웹 시뮬(websim) 판정, 지도 탭 = 실기(real) 판정.
import { useState } from 'react';
import { Background, BackgroundVariant, ControlButton, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow,
  type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './scennode.css';
import { LIFE, STAGES, type Judge, type LifeNode, type Stage, type Where } from './lifecycle';

export type StepKind = 'MOVE' | 'PHOTO' | 'WAIT' | 'OTHER';
/** no = 시뮬에서 실행 못 하는 이유(시뮬 탭에서 scenarioTree 가 거절한 지점) */
export type NodeIn = { title: string; sub: string; kind: StepKind; no?: string };
type Badge = { st: Judge | 'na' | 'no'; text: string };
type Data = { icon: string; title: string; sub: string; wp?: number; on?: boolean; edge?: 'in' | 'out' | 'none'; badge?: Badge };
type N = Node<Data, 'step'>;
type BoxData = { stage: Stage; title: string; sub: string; on?: boolean };
type B = Node<BoxData, 'box'>;
type F = N | B;
const ICON: Record<StepKind | 'START' | 'END', string> = { START: '▷', END: '◎', MOVE: '↗', PHOTO: '▣', WAIT: '◷', OTHER: '≡' };
const W = 200, GX = 224, GY = 112;
// 화면 맞춤: 글자가 읽히게 0.8 아래로는 줄이지 않고, 넘치면 위(시작)부터 보인다 — 나머지는 끌어 내려 본다
const FIT = { padding: 0.12, maxZoom: 1, minZoom: 0.8 };
/** 묶음 상자: 옆·아래 여백, 위 = 제목 칸, H = 카드 높이 어림(제목·설명·배지 세 줄), GAP = 묶음 사이 */
const PAD = 16, TOP = 44, H = 84, GAP = 56;
/** 지점 할 일 → 표의 임무 노드(처리 주체·실패 시·판정을 빌려 씀). 여러 할 일이 섞인 임무(OTHER)는 대응 없음 */
const KIND_LIFE: Partial<Record<StepKind, string>> = { MOVE: 'gotoA', PHOTO: 'capture', WAIT: 'wait' };
/** 갈래(실패·대기 때만 가는 노드) — 본 줄 옆 칸에 선 없이 */
const SIDE = new Set(['retry', 'connection_failed', 'lease_wait', 'not_ready']);
/** 상시 감시 한 줄 = 이 노드들의 판정 */
const WATCH: [string, string][] = [['STOP', 'safe_stop'], ['통신', 'link_lost'], ['조종권', 'lease'], ['배터리', 'battery_low'], ['장치', 'check']];
const life = (id?: string) => LIFE.find((n) => n.id === id);

export function badgeOf(n: LifeNode, w: Where): Badge {
  const s = n.status[w];
  if (s === '없음' && w === 'websim' && n.missing.websim.startsWith('해당 없음')) return { st: 'na', text: '브라우저 시뮬엔 없음' };
  return { st: s, text: s === '없음' ? '아직 없음' : s };
}
/** 단계별 됨·일부·없음 개수 */
export const counts = (stage: Stage, w: Where) => { const l = LIFE.filter((n) => n.stage === stage);
  return { done: l.filter((n) => n.status[w] === '됨').length, part: l.filter((n) => n.status[w] === '일부').length, none: l.filter((n) => n.status[w] === '없음').length }; };

const Tag = ({ b }: { b: Badge }) => <span className="sn-badge" data-st={b.st}>{b.text}</span>;

/** 노드 카드: 아이콘·이름·한 줄 설명·판정, 위 = 들어오는 점, 아래 = 나가는 점 */
function Step({ data }: NodeProps<N>) {
  return <div className="sn-card" data-on={data.on ? '' : undefined} data-plain={!data.icon && data.wp == null ? '' : undefined}>
    {data.edge !== 'in' && data.edge !== 'none' && <Handle type="target" position={Position.Top} isConnectable={false} />}
    <div className="sn-head">{data.wp != null ? <span className="sn-num">{data.wp + 1}</span> : data.icon && <span className="sn-icon" aria-hidden="true">{data.icon}</span>}
      <b className="sn-title">{data.title}</b>{data.wp != null && <span className="sn-icon" aria-hidden="true">{data.icon}</span>}</div>
    <div className="sn-sub">{data.sub}</div>
    {data.badge && <div className="sn-foot"><Tag b={data.badge} /></div>}
    {data.edge !== 'out' && data.edge !== 'none' && <Handle type="source" position={Position.Bottom} isConnectable={false} />}
  </div>;
}
/** 단계 묶음 상자(배경): 제목 «n. 단계 · 됨·일부·아직 없음», 점들은 묶음 사이 점선용(안 보임) */
function Box({ data }: NodeProps<B>) {
  return <div className="sn-box" data-group={data.stage} data-on={data.on ? '' : undefined}>
    <div className="sn-box-head"><b>{data.title}</b> · {data.sub}</div>
    <Handle id="r" type="source" position={Position.Right} isConnectable={false} /><Handle id="l" type="target" position={Position.Left} isConnectable={false} />
    <Handle id="b" type="source" position={Position.Bottom} isConnectable={false} /><Handle id="ri" type="target" position={Position.Right} isConnectable={false} />
  </div>;
}
const TYPES = { step: Step, box: Box };
const line = (source: string, target: string): Edge => ({ id: `${source}>${target}`, source, target, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } });
const at = (x: number, y: number) => ({ position: { x: x * GX, y: y * GY }, style: { width: W } });

/** 임무 단계: 시작 → 지점 1..n → 끝나면, 앞에서 뒤로 선 하나씩. 지점 판정 = 할 일에 맞는 표 노드(시뮬이 거절한 지점은 «시뮬에서 실행 못 함») */
export function missionGraph(items: NodeIn[], end: string, w: Where): { nodes: N[]; edges: Edge[] } {
  const nodes: N[] = [
    { id: 'start', type: 'step', ...at(0, 0), data: { icon: ICON.START, title: '시작', sub: '순찰 시작', edge: 'in' } },
    ...items.map((t, i): N => { const l = life(KIND_LIFE[t.kind]);
      return { id: `w${i}`, type: 'step', ...at(0, i + 1), data: { icon: ICON[t.kind], title: t.title, sub: t.sub, wp: i,
        badge: t.no && w === 'websim' ? { st: 'no', text: '시뮬에서 실행 못 함' } : l && badgeOf(l, w) } }; }),
    { id: 'end', type: 'step', ...at(0, items.length + 1), data: { icon: ICON.END, title: '끝나면', sub: end, edge: 'out' } },
  ];
  return { nodes, edges: nodes.slice(1).map((n, i) => line(nodes[i].id, n.id)) };
}
/** 다른 단계(읽기만): 본 줄은 위→아래 선으로, 갈래는 바로 앞 본 노드 옆에 선 없이(갈래가 이어지면 한 칸씩 아래로 — 겹치지 않게). 예외 처리는 순서가 아니라 두 줄 격자(선 없음) */
export function stageGraph(stage: Stage, w: Where): { nodes: N[]; edges: Edge[] } {
  const l = LIFE.filter((n) => n.stage === stage), grid = stage === '예외 처리';
  const nodes: N[] = [], main: string[] = [];
  let sideRow = -1;
  l.forEach((n, i) => {
    const side = !grid && SIDE.has(n.id);
    if (side) sideRow = Math.max(main.length - 1, sideRow + 1, 0);
    const pos = grid ? at(i % 2, Math.floor(i / 2)) : side ? at(1, sideRow) : at(0, main.length);
    if (!grid && !side) main.push(n.id);
    nodes.push({ id: n.id, type: 'step', ...pos, data: { icon: '', title: n.name, sub: n.owner, badge: badgeOf(n, w), edge: grid || side ? 'none' : undefined } });
  });
  for (const n of nodes) if (main[0] === n.id) n.data.edge = main.length > 1 ? 'in' : 'none'; else if (main[main.length - 1] === n.id) n.data.edge = 'out';
  return { nodes, edges: main.slice(1).map((id, i) => line(main[i], id)) };
}

/** 단계 사이 본 줄 선(앞 단계 끝 → 다음 단계 처음) */
const LINKS: [string, string][] = [['connected', 'mode'], ['ready', 'start'], ['end', 'return']];
const dash = (source: string, target: string, sourceHandle: string, targetHandle: string, label?: string): Edge => ({ id: `${source}>${target}`, source, target, sourceHandle, targetHandle,
  label, type: 'smoothstep', className: 'sn-jump', style: { strokeDasharray: '6 4' }, markerEnd: { type: MarkerType.ArrowClosed } });
/** 한 캔버스: 단계마다 묶음 상자 + 그 단계 노드(stageGraph·missionGraph 를 상자 안으로 옮김). 본 줄은 위→아래, 예외 처리는 임무 오른쪽.
 *  예외 = 묶음끼리 점선 둘(임무 → 예외 «임무 중 언제든», 예외 → 복귀·종료)만 — 개별 예외 노드 사이 갈래는 만들지 않는다(실행기가 못 하는 흐름을 된다고 보이지 않게) */
export function flowGraph(items: NodeIn[], end: string, w: Where): { boxes: B[]; nodes: N[]; edges: Edge[] } {
  const boxes: B[] = [], nodes: N[] = [], edges: Edge[] = [];
  const put = (stage: Stage, x: number, y: number) => {
    const g = stage === '임무' ? missionGraph(items, end, w) : stageGraph(stage, w), c = counts(stage, w);
    const width = Math.max(...g.nodes.map((n) => n.position.x)) + W + PAD * 2, height = Math.max(...g.nodes.map((n) => n.position.y)) + H + TOP + PAD;
    const box: B = { id: `g:${stage}`, type: 'box', position: { x, y }, zIndex: -1, selectable: false, focusable: false, style: { width, height },
      data: { stage, title: `${STAGES.indexOf(stage) + 1}. ${stage}`, sub: `됨 ${c.done} · 일부 ${c.part} · 아직 없음 ${c.none}` } };
    boxes.push(box); edges.push(...g.edges);
    nodes.push(...g.nodes.map((n) => ({ ...n, position: { x: n.position.x + x + PAD, y: n.position.y + y + TOP } })));
    return { right: x + width, bottom: y + height };
  };
  const a = put('연결', 0, 0), b = put('운행 준비', 0, a.bottom + GAP), m = put('임무', 0, b.bottom + GAP);
  put('예외 처리', m.right + GAP * 2, b.bottom + GAP); put('복귀·종료', 0, m.bottom + GAP);
  const ends = new Set(LINKS.flat());
  for (const n of nodes) if (ends.has(n.id)) n.data = { ...n.data, edge: undefined };
  edges.push(...LINKS.map(([s, t]) => ({ ...line(s, t), className: 'sn-link' })),
    dash('g:임무', 'g:예외 처리', 'r', 'l', '임무 중 언제든'), dash('g:예외 처리', 'g:복귀·종료', 'b', 'ri'));
  return { boxes, nodes, edges };
}

/** where = 이 탭 판정(websim·real), items = 지점 순서대로, end = «끝나면», on = 지도에서 고른 지점, pick = 지점 노드를 고르면 지도 강조, edit = 그 지점을 목록에서 편집 */
export const ScenNodes = (p: { where: Where; items: NodeIn[]; end: string; on: number | null; pick: (i: number) => void; edit: (i: number) => void }) =>
  <ReactFlowProvider><Lifecycle {...p} /></ReactFlowProvider>;

function Lifecycle({ where, items, end, on, pick, edit }: { where: Where; items: NodeIn[]; end: string; on: number | null; pick: (i: number) => void; edit: (i: number) => void }) {
  // sel = 누른 노드(누를 때의 지도 선택과 함께) — 그 뒤 지도에서 다른 지점을 고르면 그 지점을 따른다
  // stage = 화면을 맞춘 묶음(띠에서 고름) — 노드는 늘 다섯 단계 전부
  const [stage, setStage] = useState<Stage>('임무'), [sel, setSel0] = useState<{ id: string; on: number | null } | null>(null);
  const setSel = (id: string) => setSel0({ id, on });
  const g = flowGraph(items, end, where), flow = useReactFlow();
  const focus = sel && sel.on === on ? sel.id : on != null ? `w${on}` : null;
  const tap = (id: string) => { const n = g.nodes.find((x) => x.id === id); setSel(id); if (n?.data.wp != null) pick(n.data.wp); };
  // 묶음 맞춤 = 읽히는 배율(FIT)로, 묶음이 화면보다 크면 묶음 위·왼쪽부터. s 없음 = 전체 보기(배율 제한 없이)
  const view = (s?: Stage) => { if (!s) return void flow.fitView({ padding: 0.04 });
    const id = `g:${s}`;
    void flow.fitView({ ...FIT, nodes: [{ id }] }).then(() => { const b = flow.getNode(id), v = flow.getViewport(); if (!b) return;
      const x = b.position.x * v.zoom + v.x < 0 ? 16 - b.position.x * v.zoom : v.x, y = b.position.y * v.zoom + v.y < 0 ? 16 - b.position.y * v.zoom : v.y;
      if (x !== v.x || y !== v.y) void flow.setViewport({ ...v, x, y }); }); };
  const go = (s: Stage) => { setStage(s); view(s); };

  return <div className="sn" data-scen-nodes data-stage={stage} data-groups={g.boxes.length} data-nodes={g.nodes.length} data-edges={g.edges.length}>
    <div className="sn-watch" data-watch><b>상시 감시</b>
      {WATCH.map(([t, id]) => { const b = badgeOf(life(id)!, where);
        return <button type="button" key={id} className="sn-chip" data-st={b.st} data-life={id} title={`${life(id)!.name} — ${b.text}`} onClick={() => setSel(id)}>{t}</button>; })}
      <span className="sn-muted">임무와 별도로 항상</span></div>
    <div className="sn-stages" role="group" aria-label="운영 흐름 단계">
      {STAGES.map((s, i) => { const c = counts(s, where);
        return <button type="button" key={s} className="btn sn-stage" aria-pressed={stage === s} data-stage={s} data-done={c.done} data-part={c.part} data-none={c.none} onClick={() => go(s)}>
          <b>{i + 1}. {s}</b><small>됨 {c.done} · 일부 {c.part} · 아직 없음 {c.none}</small></button>; })}
    </div>
    <p className="sn-hint">{stage === '임무' ? '임무 = 지금 시나리오 — 지점은 지도를 눌러 넣고, 할 일·순서는 목록에서 고칩니다 · 다른 단계는 읽기만(코드 기준 판정)'
      : stage === '예외 처리' ? '읽기만 — 예외 갈래는 내장 «모의 BT 공장 순찰»에만 있고 시나리오 편집기로는 만들지 않습니다'
      : '읽기만 — 코드 기준 판정(11-09 대조표)'}{where === 'real' ? ' · 실기 «됨» = 코드 경로 기준, 실기체 검증과 다름' : ''}</p>
    <Flow key={JSON.stringify(g.nodes.map((n) => n.data))} nodes={[...g.boxes, ...g.nodes]} edges={g.edges} on={focus} stage={stage} tap={tap} view={view} />
    <Detail id={focus} g={g.nodes} where={where} items={items} edit={edit} />
  </div>;
}

/** on = 밝힐 노드, stage = 밝힐 묶음, view = 묶음 맞춤(처음 = 띠에서 고른 묶음) · 전체 보기 */
function Flow({ nodes: first, edges, on, stage, tap, view }: { nodes: F[]; edges: Edge[]; on: string | null; stage: Stage; tap: (id: string) => void; view: (s?: Stage) => void }) {
  const [nodes, setNodes] = useState(first);
  const shown = nodes.map((n): F => { const want = n.type === 'box' ? n.data.stage === stage : n.id === on;
    return want !== !!n.data.on ? { ...n, data: { ...n.data, on: want } } as F : n; });
  return <div className="sn-canvas">
    <ReactFlow<F> nodes={shown} edges={edges} nodeTypes={TYPES} onInit={() => view(stage)} minZoom={0.05} maxZoom={2} nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null}
      onNodesChange={(c) => setNodes((l) => applyNodeChanges(c, l))} onNodeClick={(_, n) => n.type === 'step' && tap(n.id)} aria-label="운영 흐름 노드 캔버스">
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
      <Controls showInteractive={false} showFitView={false} aria-label="확대·축소">
        <ControlButton onClick={() => view(stage)} title="화면 맞춤(고른 단계)" aria-label="화면 맞춤">⤢</ControlButton>
        <ControlButton onClick={() => view()} title="전체 보기" aria-label="전체 보기" data-fit-all>⊞</ControlButton></Controls>
    </ReactFlow>
  </div>;
}

/** 고른 노드 상세: 이름·처리 주체·실패 시·이 탭 판정(+빠진 것). 지점이면 할 일과 «목록에서 이 지점 편집» */
function Detail({ id, g, where, items, edit }: { id: string | null; g: N[]; where: Where; items: NodeIn[]; edit: (i: number) => void }) {
  const n = g.find((x) => x.id === id), wp = n?.data.wp, it = wp != null ? items[wp] : undefined, l = it ? life(KIND_LIFE[it.kind]) : life(id ?? undefined);
  if (!n && !l) return <p className="sn-detail sn-muted" data-detail="">노드를 누르면 처리 주체·실패 시·판정을 봅니다.</p>;
  const no = where === 'websim' ? it?.no : undefined, b = no ? { st: 'no' as const, text: '시뮬에서 실행 못 함' } : l && badgeOf(l, where);
  const miss = no ?? (l && b && b.st !== '됨' ? l.missing[where].replace(/^해당 없음 — /, '') : '');
  return <dl className="sn-detail" data-detail={id}>
    <dt className="sn-name">{it ? `${wp! + 1}번 지점 · ${it.title}` : n?.data.title ?? l!.name}</dt>
    {it ? <dd><span>할 일</span>{it.sub}</dd> : n && !l && <dd><span>내용</span>{n.data.sub}</dd>}
    {l && <><dd><span>처리 주체</span>{l.owner}</dd><dd><span>실패 시</span>{l.onFail}</dd></>}
    {b && <dd><span>{where === 'websim' ? '웹 시뮬' : '실기'}</span><span><Tag b={b} />{miss && <em data-miss> {miss}</em>}</span></dd>}
    {wp != null && <dd><span /><span><button type="button" className="btn" data-edit-point={wp} onClick={() => edit(wp)}>목록에서 이 지점 편집</button></span></dd>}
  </dl>;
}

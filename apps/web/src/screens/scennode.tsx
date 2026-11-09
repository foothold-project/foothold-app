// SCEN-LIFECYCLE-EDITOR 11-09 — 시나리오 편집 오른쪽 창의 «운영 흐름»(React Flow). 위 = 상시 감시 + 단계 띠 5개(됨·일부·아직 없음 개수), 아래 = 고른 단계의 노드·상세.
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
const ICON: Record<StepKind | 'START' | 'END', string> = { START: '▷', END: '◎', MOVE: '↗', PHOTO: '▣', WAIT: '◷', OTHER: '≡' };
const W = 200, GX = 224, GY = 112;
// 화면 맞춤: 글자가 읽히게 0.8 아래로는 줄이지 않고, 넘치면 위(시작)부터 보인다 — 나머지는 끌어 내려 본다
const FIT = { padding: 0.12, maxZoom: 1, minZoom: 0.8 };
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
const TYPES = { step: Step };
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

/** where = 이 탭 판정(websim·real), items = 지점 순서대로, end = «끝나면», on = 지도에서 고른 지점, pick = 지점 노드를 고르면 지도 강조, edit = 그 지점을 목록에서 편집 */
export const ScenNodes = (p: { where: Where; items: NodeIn[]; end: string; on: number | null; pick: (i: number) => void; edit: (i: number) => void }) =>
  <ReactFlowProvider><Lifecycle {...p} /></ReactFlowProvider>;

function Lifecycle({ where, items, end, on, pick, edit }: { where: Where; items: NodeIn[]; end: string; on: number | null; pick: (i: number) => void; edit: (i: number) => void }) {
  // sel = 누른 노드(누를 때의 지도 선택과 함께) — 그 뒤 지도에서 다른 지점을 고르면 그 지점을 따른다
  const [stage, setStage] = useState<Stage>('임무'), [sel, setSel0] = useState<{ id: string; on: number | null } | null>(null);
  const setSel = (id: string | null) => setSel0(id == null ? null : { id, on });
  const mission = stage === '임무';
  const g = mission ? missionGraph(items, end, where) : stageGraph(stage, where);
  const focus = sel && (sel.on === on || !mission) ? sel.id : mission && on != null ? `w${on}` : null;
  const tap = (id: string) => { const n = g.nodes.find((x) => x.id === id); setSel(id); if (n?.data.wp != null) pick(n.data.wp); };
  const go = (s: Stage) => { setStage(s); setSel(null); };

  return <div className="sn" data-scen-nodes data-stage={stage} data-nodes={g.nodes.length} data-edges={g.edges.length}>
    <div className="sn-watch" data-watch><b>상시 감시</b>
      {WATCH.map(([t, id]) => { const b = badgeOf(life(id)!, where);
        return <button type="button" key={id} className="sn-chip" data-st={b.st} data-life={id} title={`${life(id)!.name} — ${b.text}`} onClick={() => setSel(id)}>{t}</button>; })}
      <span className="sn-muted">임무와 별도로 항상</span></div>
    <div className="sn-stages" role="group" aria-label="운영 흐름 단계">
      {STAGES.map((s, i) => { const c = counts(s, where);
        return <button type="button" key={s} className="btn sn-stage" aria-pressed={stage === s} data-stage={s} data-done={c.done} data-part={c.part} data-none={c.none} onClick={() => go(s)}>
          <b>{i + 1}. {s}</b><small>됨 {c.done} · 일부 {c.part} · 아직 없음 {c.none}</small></button>; })}
    </div>
    <p className="sn-hint">{mission ? '노드 = 지금 시나리오 — 지점은 지도를 눌러 넣고, 할 일·순서는 목록에서 고칩니다'
      : stage === '예외 처리' ? '읽기만 — 예외 갈래는 내장 «모의 BT 공장 순찰»에만 있고 시나리오 편집기로는 만들지 않습니다'
      : '읽기만 — 코드 기준 판정(11-09 대조표)'}{where === 'real' ? ' · 실기 «됨» = 코드 경로 기준, 실기체 검증과 다름' : ''}</p>
    <Flow key={`${stage}|${JSON.stringify(g.nodes.map((n) => n.data))}`} nodes={g.nodes} edges={g.edges} on={focus} tap={tap} />
    <Detail id={focus} g={g.nodes} where={where} items={items} edit={edit} />
  </div>;
}

function Flow({ nodes: first, edges, on, tap }: { nodes: N[]; edges: Edge[]; on: string | null; tap: (id: string) => void }) {
  const [nodes, setNodes] = useState(first), flow = useReactFlow();
  const fit = () => flow.fitView(FIT).then(() => { const v = flow.getViewport(); if (v.y < 0) flow.setViewport({ ...v, y: 16 }); });
  const shown = nodes.map((n) => ((n.id === on) !== !!n.data.on ? { ...n, data: { ...n.data, on: n.id === on } } : n));
  return <div className="sn-canvas">
    <ReactFlow<N> nodes={shown} edges={edges} nodeTypes={TYPES} onInit={() => void fit()} minZoom={0.3} maxZoom={2} nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null}
      onNodesChange={(c) => setNodes((l) => applyNodeChanges(c, l))} onNodeClick={(_, n) => tap(n.id)} aria-label="운영 흐름 노드 캔버스">
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
      <Controls showInteractive={false} showFitView={false} aria-label="확대·축소">
        <ControlButton onClick={() => void fit()} title="화면 맞춤" aria-label="화면 맞춤">⤢</ControlButton></Controls>
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

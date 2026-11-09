// SCEN-NODE-PREVIEW 11-09 — 시나리오 편집 오른쪽 창의 «노드 보기»(모양 확인용 미리보기, React Flow). 세로 흐름: 시작 → 지점(순서대로) → 끝나면.
// 저장하지 않는다: 이 칸은 서버·시나리오 본문을 건드리지 않고(api 를 부르지 않음) 화면 안 상태만 바꾼다. 다시 열거나 본문이 바뀌면 처음 배치로.
import { useState } from 'react';
import { Background, BackgroundVariant, ControlButton, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges, useReactFlow,
  type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './scennode.css';

export type StepKind = 'MOVE' | 'PHOTO' | 'WAIT' | 'OTHER';
export type NodeIn = { title: string; sub: string; kind: StepKind };
type Data = { icon: string; title: string; sub: string; wp?: number; on?: boolean; edge?: 'in' | 'out' };
type N = Node<Data, 'step'>;
const ICON: Record<StepKind | 'START' | 'END' | 'NEW', string> = { START: '▷', END: '◎', MOVE: '↗', PHOTO: '▣', WAIT: '◷', OTHER: '≡', NEW: '＋' };
const W = 200, GX = 224, GY = 96;
// 화면 맞춤: 글자가 읽히게 0.8 아래로는 줄이지 않고, 넘치면 위(시작)부터 보인다 — 나머지는 끌어 내려 본다
const FIT = { padding: 0.12, maxZoom: 1, minZoom: 0.8 };

/** 노드 카드: 아이콘·이름·한 줄 설명, 위 = 들어오는 점, 아래 = 나가는 점(시작은 들어오는 점 없음, 끝은 나가는 점 없음) */
function Step({ data }: NodeProps<N>) {
  return <div className="sn-card" data-on={data.on ? '' : undefined}>
    {data.edge !== 'in' && <Handle type="target" position={Position.Top} />}
    <div className="sn-head">{data.wp != null ? <span className="sn-num">{data.wp + 1}</span> : <span className="sn-icon" aria-hidden="true">{data.icon}</span>}
      <b className="sn-title">{data.title}</b>{data.wp != null && <span className="sn-icon" aria-hidden="true">{data.icon}</span>}</div>
    <div className="sn-sub">{data.sub}</div>
    {data.edge !== 'out' && <Handle type="source" position={Position.Bottom} />}
  </div>;
}
const TYPES = { step: Step };

/** 처음 노드·선: 시작 → 지점 1..n → 끝나면, 앞에서 뒤로 선 하나씩 */
export function initial(items: NodeIn[], end: string): { nodes: N[]; edges: Edge[] } {
  const nodes: N[] = [
    { id: 'start', type: 'step', position: { x: 0, y: 0 }, deletable: false, data: { icon: ICON.START, title: '시작', sub: '순찰 시작', edge: 'in' } },
    ...items.map((t, i): N => ({ id: `w${i}`, type: 'step', position: { x: 0, y: 0 }, data: { icon: ICON[t.kind], title: t.title, sub: t.sub, wp: i } })),
    { id: 'end', type: 'step', position: { x: 0, y: 0 }, data: { icon: ICON.END, title: '끝나면', sub: end, edge: 'out' } },
  ];
  const edges = nodes.slice(1).map((n, i) => line(nodes[i].id, n.id));
  return { nodes: arrange(nodes, edges), edges };
}
const line = (source: string, target: string): Edge => ({ id: `${source}>${target}`, source, target });

/** 자동 정렬: 시작에서 선을 따라 단(깊이)을 매겨 위→아래, 같은 단은 옆으로 나란히. 선이 닿지 않는 노드는 맨 아래 단부터 하나씩 */
export function arrange(nodes: N[], edges: Edge[]): N[] {
  const depth = new Map<string, number>(), q = nodes.some((n) => n.id === 'start') ? ['start'] : nodes.filter((n) => !edges.some((e) => e.target === n.id)).map((n) => n.id);
  q.forEach((id) => depth.set(id, 0));
  for (let i = 0; i < q.length; i++) for (const e of edges) if (e.source === q[i] && !depth.has(e.target)) { depth.set(e.target, depth.get(q[i])! + 1); q.push(e.target); }
  let last = Math.max(-1, ...depth.values());
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, ++last);
  const rows = new Map<number, string[]>();
  for (const n of nodes) { const d = depth.get(n.id)!; rows.set(d, [...(rows.get(d) ?? []), n.id]); }
  return nodes.map((n) => { const d = depth.get(n.id)!, r = rows.get(d)!, k = r.indexOf(n.id);
    return { ...n, position: { x: (k - (r.length - 1) / 2) * GX, y: d * GY }, style: { width: W } }; });
}
/** 한 노드에서 둘 이상 나가는 선(갈래)에는 글자 — 무엇으로 가르는지는 아직 정하지 않아 «갈래 N» */
const labeled = (edges: Edge[]): Edge[] => edges.map((e) => { const out = edges.filter((x) => x.source === e.source);
  return { ...e, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, ...(out.length > 1 && { label: `갈래 ${out.indexOf(e) + 1}` }) }; });

/** items = 지점 순서대로(이름·할 일·종류), end = «끝나면» 내용, on = 지도에서 고른 지점, pick = 노드를 고르면 그 지점을 지도에서 강조 */
export const ScenNodes = (p: { items: NodeIn[]; end: string; on: number | null; pick: (i: number) => void }) => <ReactFlowProvider><Flow {...p} /></ReactFlowProvider>;

function Flow({ items, end, on, pick }: { items: NodeIn[]; end: string; on: number | null; pick: (i: number) => void }) {
  const [g] = useState(() => initial(items, end));
  const [nodes, setNodes] = useState<N[]>(g.nodes), [edges, setEdges] = useState<Edge[]>(g.edges), [link, setLink] = useState<string | null>(null), [seq, setSeq] = useState(0);
  const flow = useReactFlow();
  const chosen = nodes.filter((n) => n.selected), cut = edges.filter((e) => e.selected);
  const connect = (source: string, target: string) => { if (source !== target) setEdges((l) => addEdge(line(source, target), l)); };
  const remove = () => {
    const gone = new Set(chosen.filter((n) => n.deletable !== false).map((n) => n.id));
    setNodes((l) => l.filter((n) => !gone.has(n.id)));
    setEdges((l) => l.filter((e) => !e.selected && !gone.has(e.source) && !gone.has(e.target)));
    setLink(null);
  };
  const add = () => {
    const id = `new${seq}`, y = Math.max(0, ...nodes.map((n) => n.position.y)) + GY;
    setSeq(seq + 1);
    setNodes((l) => [...l.map((n) => ({ ...n, selected: false })), { id, type: 'step', position: { x: GX, y }, style: { width: W }, selected: true, data: { icon: ICON.NEW, title: '빈 노드', sub: '할 일 미정' } }]);
  };
  const fit = () => flow.fitView(FIT).then(() => { const v = flow.getViewport(); if (v.y < 0) flow.setViewport({ ...v, y: 16 }); });
  const tidy = () => { setNodes((l) => arrange(l, edges)); requestAnimationFrame(() => void fit()); };
  const shown = nodes.map((n) => (n.data.wp != null && (n.data.wp === on) !== !!n.data.on ? { ...n, data: { ...n.data, on: n.data.wp === on } } : n));

  return <div className="sn" data-scen-nodes data-nodes={nodes.length} data-edges={edges.length}>
    <p className="sn-note" role="status" data-preview-only>노드 보기 미리보기 — 저장 안 됨</p>
    <div className="sn-bar" role="toolbar" aria-label="노드 도구">
      <button type="button" className="btn" onClick={add}>＋ 빈 노드</button>
      <button type="button" className="btn" aria-pressed={!!link} disabled={!link && chosen.length !== 1} title="고른 노드에서 다음에 누르는 노드로 선을 잇습니다(노드 아래 점을 끌어 다른 노드 위 점에 놓아도 됩니다)"
        onClick={() => setLink(link ? null : chosen[0].id)}>잇기</button>
      <button type="button" className="btn" disabled={!chosen.some((n) => n.deletable !== false) && !cut.length} title="고른 노드·선을 지웁니다(Delete)" onClick={remove}>선택 지우기</button>
      <span className="fh-grow" />
      <button type="button" className="btn" onClick={tidy}>자동 정렬</button>
    </div>
    <div className="sn-canvas" data-link={link ? '' : undefined}>
      <ReactFlow<N> nodes={shown} edges={labeled(edges)} nodeTypes={TYPES} onInit={() => void fit()} minZoom={0.3} maxZoom={2} deleteKeyCode={['Delete', 'Backspace']}
        onNodesChange={(c) => setNodes((l) => applyNodeChanges(c, l))} onEdgesChange={(c) => setEdges((l) => applyEdgeChanges(c, l))}
        onConnect={(c) => connect(c.source, c.target)}
        onNodeClick={(_, n) => { if (link) { connect(link, n.id); setLink(null); } if (n.data.wp != null) pick(n.data.wp); }}
        onPaneClick={() => setLink(null)} aria-label="시나리오 노드 캔버스">
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
        <Controls showInteractive={false} showFitView={false} aria-label="확대·축소">
          <ControlButton onClick={() => void fit()} title="화면 맞춤" aria-label="화면 맞춤">⤢</ControlButton></Controls>
      </ReactFlow>
    </div>
    <p className="sn-hint">노드를 끌어 옮김 · 아래 점을 끌어 다른 노드에 이음 · 빈 곳을 끌어 이동 · 휠로 확대 · Delete 로 지움</p>
  </div>;
}

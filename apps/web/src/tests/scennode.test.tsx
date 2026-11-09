// SCEN-NODE-PREVIEW 11-09 — 시나리오 노드 보기(React Flow 미리보기): 지점 노드 수 = 지점 수, 처음 선 = 순서(시작→지점→끝나면), 고르면 지도 강조(pick),
// 잇기·지우기·빈 노드·자동 정렬·갈래 글자, 저장(네트워크) 호출 없음. (jsdom 대역 = setup.ts)
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScenNodes, arrange, initial, type NodeIn } from '../screens/scennode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: NodeIn[] = [{ title: '«입구»', sub: '이동', kind: 'MOVE' }, { title: '(1.0, 0.5) m', sub: '사진 찍기(RGB)', kind: 'PHOTO' }, { title: '(2.0, 1.0) m', sub: '대기 30초', kind: 'WAIT' }];
let box: HTMLDivElement, root: Root, fetchSpy: ReturnType<typeof vi.fn>;
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t)!;
const flow = () => box.querySelector<HTMLElement>('[data-scen-nodes]')!;
const count = () => ({ nodes: Number(flow().dataset.nodes), edges: Number(flow().dataset.edges) });
const node = (id: string) => box.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const tap = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };

beforeEach(() => {
  fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
});
afterEach(() => { act(() => root.unmount()); box.remove(); vi.unstubAllGlobals(); });

describe('시나리오 노드 보기(React Flow)', () => {
  it('처음 = 시작 + 지점마다 노드 하나 + 끝나면, 순서대로 선 · 자동 정렬은 위에서 아래로', () => {
    const g = initial(ITEMS, '시작 지점으로 복귀');
    expect(g.nodes.filter((n) => n.data.wp != null)).toHaveLength(ITEMS.length);
    expect(g.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['start>w0', 'w0>w1', 'w1>w2', 'w2>end']);
    expect(g.nodes.map((n) => n.position.y)).toEqual([0, 96, 192, 288, 384]);
    // 갈래(시작에서 w2 로도) = 같은 단 나란히
    const two = arrange(g.nodes, [...g.edges, { id: 'x', source: 'start', target: 'w2' }]);
    expect(two.find((n) => n.id === 'w0')!.position.y).toBe(two.find((n) => n.id === 'w2')!.position.y);
  });

  it('지점 노드 수 = 지점 수, 고르면 지도에 알림, 잇기·지우기·빈 노드 — 저장(fetch) 없음', async () => {
    const pick = vi.fn();
    await act(async () => root.render(<ScenNodes items={ITEMS} end="마지막 지점에서 대기" on={1} pick={pick} />));
    expect(box.querySelectorAll('.react-flow__node')).toHaveLength(ITEMS.length + 2);
    expect(box.querySelectorAll('.react-flow__node .sn-num')).toHaveLength(ITEMS.length);
    expect(count()).toEqual({ nodes: 5, edges: 4 });
    expect(box.querySelector('[data-preview-only]')!.textContent).toContain('저장 안 됨');
    expect(node('w1').querySelector('[data-on]')).toBeTruthy();   // 지도에서 고른 지점 = 노드 강조

    await tap(node('w2'));
    expect(pick).toHaveBeenLastCalledWith(2);
    // 잇기: w2 고른 채 «잇기» → w0 누름 = w2→w0 선, 같은 선은 두 번 생기지 않는다
    await tap(btn('잇기')); await tap(node('w0'));
    expect(count().edges).toBe(5);
    await tap(node('w2')); await tap(btn('잇기')); await tap(node('w0'));
    expect(count().edges).toBe(5);
    // 노드 지우기 = 그 노드에 붙은 선도(w0: start>w0, w0>w1, w2>w0)
    await tap(node('w0')); await tap(btn('선택 지우기'));
    expect(count()).toEqual({ nodes: 4, edges: 2 });
    // 시작 노드는 지우지 않는다
    await tap(node('start'));
    expect(btn('선택 지우기').disabled).toBe(true);
    // 빈 노드 더하기(지점 아님)
    const before = pick.mock.calls.length;
    await tap(btn('＋ 빈 노드'));
    expect(count().nodes).toBe(5);
    await tap(node('new0'));
    expect(pick.mock.calls.length).toBe(before);
    await tap(btn('자동 정렬'));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// 4칸 보기(quad.tsx) — 작은 칸을 숨기면(›) 그 칸의 media 구독을 놓는다(display:none 만으로는 받기가 계속됨, #130 검토).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { media, useFeed } from '../media';
import { Quad, type QTile } from '../quad';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); });

function Sub({ ch }: { ch: 'rgb' | 'external' | 'lidar' }) { useFeed(ch); return <i data-sub={ch} />; }

it('작은 칸 숨기면 그 칸 내용을 내려 구독 해지, 다시 보이면 다시 구독', () => {
  const want = vi.spyOn(media, 'want'), held = () => {
    const n = new Map<string, number>();
    for (const [ch, d] of want.mock.calls) n.set(ch, (n.get(ch) ?? 0) + d);
    return n;
  };
  const tiles: QTile[] = (['rgb', 'external', 'lidar'] as const).map((ch) => ({ id: ch, label: ch, body: () => <Sub ch={ch} /> }));
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Quad label="q" tiles={tiles} fs={<button data-stop>STOP</button>} />); });
  expect([...held().values()]).toEqual([1, 1, 1]);
  act(() => { box.querySelector<HTMLButtonElement>('[data-tile="rgb"] .qh')!.click(); });   // rgb 크게
  act(() => { box.querySelector<HTMLButtonElement>('.qpip')!.click(); });   // 작은 칸 숨김
  expect(Object.fromEntries(held())).toEqual({ rgb: 1, external: 0, lidar: 0 });
  expect(box.querySelectorAll('[data-sub]').length).toBe(1);
  act(() => { box.querySelector<HTMLButtonElement>('.qpip')!.click(); });   // 다시 보임
  expect(Object.fromEntries(held())).toEqual({ rgb: 1, external: 1, lidar: 1 });
});

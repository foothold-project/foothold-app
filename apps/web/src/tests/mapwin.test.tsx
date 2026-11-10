// SCEN-ONE-FLOW-R2 — 노드 «크게 보기»의 떠 있는 지도 창(mapscen.tsx Float): 가두기·끌기·크기 한계·접기·기억값 복원(망가진 값 = 기본값)
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Float, WIN, dragWin, fitWin, readWin } from '../screens/mapscen';

const KEY = 'fh.scen.mapwin', BW = 1600, BH = 900;
let root: Root, body: HTMLDivElement;
beforeEach(() => { localStorage.removeItem(KEY); });
afterEach(() => { act(() => root?.unmount()); body?.remove(); localStorage.removeItem(KEY); });

/** 본문(.mx-body) 1600×900 안에 창 하나 */
const show = () => {
  body = document.createElement('div'); body.className = 'mx-body'; document.body.append(body);
  body.getBoundingClientRect = () => ({ left: 0, top: 0, width: BW, height: BH, right: BW, bottom: BH, x: 0, y: 0, toJSON() {} }) as DOMRect;
  act(() => { root = createRoot(body); root.render(<Float><svg data-scenario-map /></Float>); });
};
const win = () => body.querySelector<HTMLElement>('[data-win]')!;
const box = () => ['--wx', '--wy', '--ww', '--wh'].map((k) => win().style.getPropertyValue(k));
const ptr = (el: Element, type: string, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })); });
const drag = (el: Element, dx: number, dy: number) => { ptr(el, 'pointerdown', 500, 500); ptr(el, 'pointermove', 500 + dx / 2, 500 + dy / 2); ptr(el, 'pointerup', 500 + dx, 500 + dy); };

describe('지도 창 가두기(fitWin·dragWin)', () => {
  it('처음 = 왼쪽 아래 360×260(R3)(12px 띄움), 크기 220×160 ~ 본문 90%, 자리는 본문 안 — 본문이 줄면 다시 가둠', () => {
    expect(fitWin(WIN, BW, BH)).toMatchObject({ x: 12, y: 628, w: 360, h: 260 });
    expect(fitWin({ ...WIN, w: 100, h: 50 }, BW, BH)).toMatchObject({ w: 220, h: 160 });
    expect(fitWin({ ...WIN, w: 5000, h: 5000 }, BW, BH)).toMatchObject({ w: 1440, h: 810, x: 12, y: 78 });
    expect(fitWin({ ...WIN, x: -50, y: -50 }, BW, BH)).toMatchObject({ x: 0, y: 0 });
    expect(fitWin({ ...WIN, x: 1500, y: 800 }, BW, BH)).toMatchObject({ x: 1240, y: 640 });
    expect(fitWin({ ...WIN, x: 1000, y: 600, w: 500, h: 300 }, 800, 500)).toMatchObject({ x: 300, y: 200, w: 500, h: 300 });   // 창이 작아지면 안으로
    expect(fitWin({ ...WIN, x: 0, y: 0 }, 200, 100)).toMatchObject({ x: 0, y: 0, w: 220, h: 160 });                          // 본문이 최소보다 작으면 최소 크기, 왼쪽 위
  });
  it('끌기: 옮김은 본문 밖으로 못 나감, 오른쪽 아래 모서리 = 크기, 왼쪽 위 모서리 = 오른쪽 아래 끝 고정', () => {
    const s = fitWin({ ...WIN, x: 1228 }, BW, BH);   // 오른쪽 아래로 옮겨 둔 창
    expect(dragWin(s, 'move', -300, -200, BW, BH)).toMatchObject({ x: 928, y: 428, w: 360, h: 260 });
    expect(dragWin(s, 'move', -5000, 5000, BW, BH)).toMatchObject({ x: 0, y: 640 });            // 바닥까지(12px 띄움은 처음 자리만)
    expect(dragWin({ ...s, x: 100, y: 100 }, 'se', 140, 40, BW, BH)).toMatchObject({ x: 100, y: 100, w: 500, h: 300 });
    expect(dragWin({ ...s, x: 100, y: 100 }, 'se', -1000, -1000, BW, BH)).toMatchObject({ w: 220, h: 160 });
    const n = dragWin(s, 'nw', -240, -140, BW, BH);
    expect([n.x + n.w, n.y + n.h, n.w, n.h]).toEqual([1588, 888, 600, 400]);
    const m = dragWin(s, 'nw', -5000, -5000, BW, BH);
    expect([m.w, m.h, m.x + m.w, m.y + m.h]).toEqual([1440, 810, 1588, 888]);                                                // 최대 = 본문 90%
  });
  it('기억값: 맞는 값만 되살리고 망가진 값·JSON 아님·막힌 저장소는 기본값', () => {
    expect(readWin()).toEqual(WIN);
    localStorage.setItem(KEY, JSON.stringify({ x: 10, y: 20, w: 400, h: 300, fold: true }));
    expect(readWin()).toEqual({ x: 10, y: 20, w: 400, h: 300, fold: true });
    for (const bad of ['{', 'null', '{"x":1,"y":2,"w":"400","h":300,"fold":false}', '{"x":null,"y":null,"w":400,"h":300}', '{"x":1e999,"y":0,"w":1,"h":1,"fold":false}']) {
      localStorage.setItem(KEY, bad); expect(readWin()).toEqual(WIN);
    }
  });
});

describe('지도 창(Float)', () => {
  it('윗줄을 끌어 옮김·모서리로 크기·접기 칩 — 끝나면 이 브라우저에 기억, 다시 열면 그 자리', () => {
    show();
    expect(box()).toEqual(['12px', '628px', '360px', '260px']);
    expect(win().querySelector('svg[data-scenario-map]')).toBeTruthy();                         // 지도는 창 안
    drag(win().querySelector('.mx-win-head')!, -300, -200);                                   // 왼쪽 끝에서 더 왼쪽 = 0 에 막힘
    expect(box()).toEqual(['0px', '428px', '360px', '260px']);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ x: 0, y: 428, w: 360, h: 260, fold: false });
    drag(win().querySelector('[data-grip="se"]')!, 5000, 5000);                                 // 최대 90% — 넘치는 만큼 안으로 밀림
    expect(box()).toEqual(['0px', '90px', '1440px', '810px']);
    drag(win().querySelector('[data-grip="nw"]')!, 2000, 2000);                                 // 최소 220×160, 오른쪽 아래 끝 그대로
    expect(box()).toEqual(['1220px', '740px', '220px', '160px']);
    const fold = win().querySelector<HTMLButtonElement>('[aria-label="지도 창 접기"]')!;
    ptr(fold, 'pointerdown', 1, 1); act(() => fold.click());                                   // 접기 단추 누름은 끌기가 아님
    expect([win().hasAttribute('data-fold'), box()[0]]).toEqual([true, '1220px']);
    expect(JSON.parse(localStorage.getItem(KEY)!).fold).toBe(true);
    act(() => root.unmount()); body.remove(); show();                                            // 다시 열면 접힌 그대로
    expect([win().hasAttribute('data-fold'), ...box()]).toEqual([true, '1220px', '740px', '220px', '160px']);
    act(() => win().querySelector<HTMLButtonElement>('[aria-label="지도 창 펼치기"]')!.click());
    expect(win().hasAttribute('data-fold')).toBe(false);
  });
  it('망가진 기억값이면 기본 자리·크기로 뜬다', () => {
    localStorage.setItem(KEY, '{"x":"왼쪽","w":-1}');
    show();
    expect([win().hasAttribute('data-fold'), ...box()]).toEqual([false, '12px', '628px', '360px', '260px']);
  });
});

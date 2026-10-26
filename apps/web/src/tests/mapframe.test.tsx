// 지도 그림 공용 틀(mapframe): 벽 범위·처음 화면·축척 계산, 확대·자르기 뒤 화면 → 그림 좌표, 편집 중 누름 나누기(한 손가락 = 부른 쪽, 두 손가락·가운데 단추 = 이동).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapFrame, around, bounds, scaleBar, toView, type Box } from '../mapframe';
import { fromScreen } from '../screens/mapedit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); });
const r3 = (xs: number[]) => xs.map((x) => Math.round(x * 1000) / 1000);
const sized = (el: Element, width: number, height: number) => { el.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON() {} }) as DOMRect; };

describe('계산', () => {
  it('bounds = 벽(빨강 < 102, 불투명) 화소 범위, 미확인 205·빈 곳 254·투명은 벽 아님, 없으면 null', () => {
    const w = 6, h = 4, d = new Uint8ClampedArray(w * h * 4).fill(254);
    const px = (x: number, y: number, v: number, a = 255) => { d.set([v, v, v, a], (y * w + x) * 4); };
    px(0, 0, 205); px(5, 3, 0, 0);   // 미확인·투명 벽
    expect(bounds(d, w, h)).toBeNull();
    px(1, 1, 0); px(4, 2, 101);
    expect(bounds(d, w, h)).toEqual([1, 1, 4, 2]);
    px(3, 3, 102);   // 경계값은 벽 아님
    expect(bounds(d, w, h)).toEqual([1, 1, 4, 2]);
  });
  it('around = 벽 범위 + 요소 점 + 여백(1 m 또는 6%), 전체 안으로. 벽을 모르면 전체', () => {
    const full: Box = [0, 0, 400, 300];
    expect(around(null, [[1, 1]], full, 0.05)).toEqual(full);
    expect(around([100, 100, 50, 50], [], full, 0.05)).toEqual([80, 80, 90, 90]);           // 여백 1 m = 20 픽셀
    expect(around([100, 100, 50, 50], [[300, 120]], full, 0.05)).toEqual([80, 80, 240, 90]);   // 점까지 넓힘
    expect(around([0, 0, 1000, 10], [], [0, 0, 2000, 2000], 0.05)).toEqual([0, 0, 1060, 70]);   // 큰 범위는 6% = 60
    expect(around([0, 0, 400, 300], [], full, 0.05)).toEqual(full);                          // 전체를 넘지 않음
  });
  it('scaleBar = 화면 100px 안의 1·2·5 단위, 확대하면 짧은 단위', () => {
    expect(scaleBar(0.05, 4)).toEqual({ m: 1, px: 80, text: '1 m' });        // 1 m = 20 픽셀 × 4
    expect(scaleBar(0.05, 0.5)).toEqual({ m: 10, px: 100, text: '10 m' });   // 100px = 10 m 꼭 맞음
    expect(scaleBar(0.05, 0.3)).toEqual({ m: 10, px: 60, text: '10 m' });
    expect(scaleBar(0.05, 40)).toEqual({ m: 0.1, px: 80, text: '10 cm' });
    expect(scaleBar(0.05, 0)).toBeNull();
  });
});

describe('확대·자르기 뒤 좌표', () => {
  const g = { origin: [-1, -2, 0] as [number, number, number], resolution: 0.05, width: 100, height: 80 };
  it('toView·fromScreen 은 지금 viewBox(자른 범위·가운데 맞춤 여백)를 따른다', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '20 10 40 20'); sized(svg, 400, 400);   // 10배, 위아래 여백 100px
    expect(r3(toView(svg, 0, 100))).toEqual([20, 10]);
    expect(r3(toView(svg, 400, 300))).toEqual([60, 30]);
    expect(r3(fromScreen(svg, g, 200, 200))).toEqual([-1 + 40 * 0.05, -2 + (80 - 20) * 0.05]);
  });
});

describe('누름 나누기', () => {
  type Ev = { type: string; x: number; y: number; button?: number; id?: number; touch?: boolean };
  const fire = (el: Element, { type, x, y, button = 0, id = 1, touch }: Ev) => act(() => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
    Object.defineProperty(e, 'pointerId', { value: id }); Object.defineProperty(e, 'pointerType', { value: touch ? 'touch' : 'mouse' });
    el.dispatchEvent(e);
  });
  const mount = (edit: boolean) => {
    const got: string[] = [], log = (e: { type: string; pointerId: number }) => { got.push(`${e.type}:${e.pointerId}`); };
    box = document.createElement('div'); document.body.append(box); root = createRoot(box);
    act(() => root!.render(<MapFrame full={[0, 0, 100, 80]} res={0.05} edit={edit} data-t onPointerDown={log} onPointerMove={log} onPointerUp={log} onPointerCancel={log} />));
    const svg = box.querySelector('svg[data-t]')!;
    sized(svg, 400, 320);
    return { svg, got, vb: () => r3(svg.getAttribute('viewBox')!.split(' ').map(Number)) };
  };
  it('편집: 왼쪽 단추·한 손가락은 부른 쪽, 가운데 단추 끌기는 이동만', () => {
    const { svg, got, vb } = mount(true);
    fire(svg, { type: 'pointerdown', x: 10, y: 10 }); fire(svg, { type: 'pointermove', x: 20, y: 10 }); fire(svg, { type: 'pointerup', x: 20, y: 10 });
    fire(svg, { type: 'pointerdown', x: 10, y: 10, button: 1, id: 2 }); fire(svg, { type: 'pointermove', x: 50, y: 10, id: 2 }); fire(svg, { type: 'pointerup', x: 50, y: 10, id: 2 });
    expect(got).toEqual(['pointerdown:1', 'pointermove:1', 'pointerup:1']);
    expect(vb()).toEqual([-10, 0, 100, 80]);   // 40px ÷ 4배
  });
  it('편집: 두 번째 손가락 = 부른 쪽 그리기 취소 + 집기(확대), 두 손가락 움직임·뗌은 넘기지 않음', () => {
    const { svg, got, vb } = mount(true);
    fire(svg, { type: 'pointerdown', x: 100, y: 160, id: 1, touch: true });
    fire(svg, { type: 'pointerdown', x: 300, y: 160, id: 2, touch: true });
    fire(svg, { type: 'pointermove', x: 0, y: 160, id: 1, touch: true });   // 간격 200 → 300 = 1.5배, 가운데 200 → 150
    fire(svg, { type: 'pointerup', x: 0, y: 160, id: 1, touch: true }); fire(svg, { type: 'pointerup', x: 300, y: 160, id: 2, touch: true });
    expect(got).toEqual(['pointerdown:1', 'pointerdown:2']);   // 두 번째는 취소(onPointerCancel)로 알린다
    const [x, y, w, h] = vb();
    expect([w, h]).toEqual([66.667, 53.333]);
    expect(r3([x + (w * 150) / 400, y + h / 2])).toEqual([50, 40]);   // 처음 손가락 가운데(200px)의 그림 점 50 이 새 가운데(150px) 아래로 따라 옴
    fire(svg, { type: 'pointerdown', x: 10, y: 10, id: 3, touch: true });
    expect(got[got.length - 1]).toBe('pointerdown:3');   // 다 뗀 뒤 한 손가락은 다시 부른 쪽
  });
  it('보기: 왼쪽 끌기 = 이동(부른 쪽에 안 넘김), 휠 = 확대', () => {
    const { svg, got, vb } = mount(false);
    fire(svg, { type: 'pointerdown', x: 200, y: 160 }); fire(svg, { type: 'pointermove', x: 160, y: 160 }); fire(svg, { type: 'pointerup', x: 160, y: 160 });
    expect(got).toEqual([]);
    expect(vb()).toEqual([10, 0, 100, 80]);
    act(() => { svg.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 200, clientY: 160 })); });
    expect(vb()[2]).toBeLessThan(100);
  });
});

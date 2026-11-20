// RB-LIDAR-3D · RB-UNITREE-LOOK-WEB: 라이다 칸 3D/위에서 바꾸기, 상자 상한·색, 시점 되돌림, 천장 숨김은 위에서만, 안 보이면 그리기 멈춤. jsdom 엔 WebGL 이 없어 three 의 WebGLRenderer 만 그리기 횟수를 세는 가짜로 바꾼다(그림은 headless Chrome 캡처 runs/rb-lidar-3d).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveFeed } from '../drivemedia';
import { CAP_BIG, CAP_PHONE, CAP_SMALL, capFor, fillBoxes } from '../lidar3d';
import { CEIL_M } from '../drivemedia';
import { LidarMap } from '../lidarmap';

const gl = { ok: true, renders: 0, alive: 0, drawn: -1 };
vi.mock('three', async (orig) => {
  const T = await orig<typeof import('three')>();
  class FakeRenderer {
    domElement = document.createElement('canvas');
    constructor() { if (!gl.ok) throw new Error('Error creating WebGL context.'); gl.alive++; }
    setPixelRatio() {} setSize() {} dispose() {}
    forceContextLoss() { gl.alive--; }
    render(scene: { children: { isInstancedMesh?: boolean; count?: number }[] }) { gl.renders++; gl.drawn = scene.children.find((c) => c.isInstancedMesh)!.count!; }
  }
  return { ...T, WebGLRenderer: FakeRenderer };
});

const feed = (n: number, ver: number, frame = 'odom'): DriveFeed => ({ state: 'live', why: '', at: 0, seq: ver, img: '', xyz: new Float32Array(n * 3).map((_, i) => i % 7), n, frame, truncated: false, ver,
  range: null, pose: frame === 'odom' ? { x: 1, y: 2, z: 0, yaw: 0.3 } : null, path: [], grid: null, wipe: () => {} } as DriveFeed);
let root: Root | null = null, box: HTMLDivElement;
const show = (f: DriveFeed, o: { small?: boolean; start?: '3d' | 'top' } = {}) => act(() => { root!.render(<LidarMap feed={f} empty="" {...o} />); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const setHidden = (h: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });

beforeEach(() => {
  gl.ok = true; gl.renders = 0; gl.alive = 0; gl.drawn = -1; vi.useFakeTimers(); setHidden(false);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);   // jsdom 엔 그림판 없음(상자 면 무늬는 없이) — «Not implemented» 소음 끔
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
});
afterEach(() => { act(() => root?.unmount()); root = null; box.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setHidden(false); });

/** jsdom 엔 2D 그림판이 없어 위에서 본 그림이 그리는 화소만 받아 둔다 */
function fake2d() {
  const put: Uint8ClampedArray[] = [], noop = () => {};
  const g = { createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: (img: ImageData) => { put.push(img.data.slice()); },
    setTransform: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, save: noop, restore: noop, translate: noop, rotate: noop, closePath: noop, fill: noop };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g as unknown as CanvasRenderingContext2D);
  return () => { const d = put[put.length - 1]; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) k++; return k; };   // 마지막 그림의 칠한 화소 수
}

describe('라이다 칸 3D', () => {
  it('기본 3D, «위에서»를 누르면 지금 2D 그림, 다시 «3D»', () => {
    show(feed(3, 1));
    expect($('[data-lm-mode]')!.dataset.lmMode).toBe('3d');
    expect($('[data-lidar3d]')!.dataset.lidar3d).toBe('3');
    expect($('[data-lm-view="3d"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(gl.renders).toBeGreaterThan(0);
    act(() => { $('[data-lm-view="top"]')!.click(); });
    expect($('[data-lm-mode]')!.dataset.lmMode).toBe('top');
    expect($('[data-lidar3d]')).toBeNull();
    expect($('canvas')!.getAttribute('aria-label')).toContain('위에서 본 그림');
    act(() => { $('[data-lm-view="3d"]')!.click(); });
    expect($('[data-lidar3d]')).toBeTruthy();
    expect(box.textContent).not.toMatch(/point cloud|odom|WebGL/i);
  });

  it('상자 상한: 넘으면 고르게 솎아 상한 이하만, 자리는 5 cm 칸 가운데, 색은 바닥 청록 → 위 분홍', () => {
    const n = CAP_BIG * 2 + 5, xyz = new Float32Array(n * 3), mat = new Float32Array(CAP_BIG * 16), col = new Float32Array(CAP_BIG * 3);
    for (let i = 0; i < n; i++) { xyz[i * 3] = 1.01; xyz[i * 3 + 2] = i % 2 ? 3 : -0.29; }
    const m = fillBoxes(mat, col, xyz, n, CAP_BIG, -0.3);
    expect(m).toBeLessThanOrEqual(CAP_BIG); expect(m).toBeGreaterThan(CAP_BIG * 0.6);
    expect(fillBoxes(mat, col, xyz, 10, CAP_BIG, -0.3)).toBe(10);   // 상한 아래는 다
    expect(mat[12]).toBeCloseTo(1.025); expect(mat[14]).toBeCloseTo(-0.275);   // 칸 [1.00,1.05)·[-0.30,-0.25) 가운데
    const [r0, g0, b0] = col.slice(0, 3), [r1, g1, b1] = col.slice(3, 6);
    expect(g0).toBeGreaterThan(r0); expect(b0).toBeGreaterThan(r0);   // 바닥 = 청록
    expect(r1).toBeGreaterThan(g1); expect(b1).toBeGreaterThan(g1);   // 3 m(위쪽 끝 넘음) = 분홍
  });

  it('상자 상한은 칸 크기별: 작은 칸 < 폰 < PC', () => {
    expect([capFor(true, 1280, 800), capFor(false, 390, 844), capFor(false, 844, 390), capFor(false, 1280, 800)]).toEqual([CAP_SMALL, CAP_PHONE, CAP_PHONE, CAP_BIG]);
  });

  it('범례 «바닥 → 높음»(개발자 말 없음), 손으로 확대하면 «로봇 뒤에서 보기» 하나로 되돌림', () => {
    show(feed(3, 1));
    expect($('[data-height-legend]')!.textContent).toBe('바닥높음');
    expect($('[data-l3-view]')!.dataset.l3View).toBe('chase');
    expect($('[data-l3-follow]')).toBeNull();
    act(() => { $('canvas')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true })); });
    expect($('[data-l3-view]')!.dataset.l3View).toBe('follow');
    act(() => { $('[data-l3-follow]')!.click(); });
    expect($('[data-l3-view]')!.dataset.l3View).toBe('chase');
    act(() => { $('[data-lm-view="top"]')!.click(); });
    expect($('[data-height-legend]')).toBeTruthy();
  });

  it('3D 는 높은 점까지 다 그리고, 위에서 본 그림만 로봇보다 CEIL_M 넘게 높은 점(천장)을 숨긴다', () => {
    const hi = (z: number, ver: number) => ({ ...feed(1, ver), xyz: Float32Array.of(1, 2, z), pose: { x: 1, y: 2, z: 0, yaw: 0 } }) as DriveFeed;
    show(hi(CEIL_M + 1, 1));
    expect(gl.drawn).toBe(1);
    act(() => root!.unmount()); root = createRoot(box);
    const painted = fake2d();
    show(hi(CEIL_M + 1, 2), { start: 'top' });
    expect(painted()).toBe(0);
    show(hi(CEIL_M - 0.1, 3), { start: 'top' });
    act(() => { vi.advanceTimersByTime(600); });
    expect(painted()).toBeGreaterThan(0);
  });

  it('판이 그대로면 다시 그리지 않고, 탭이 숨으면 새 판이 와도 그리지 않다가 돌아오면 그린다', () => {
    show(feed(3, 1));
    const r0 = gl.renders;
    act(() => { vi.advanceTimersByTime(2000); });
    expect(gl.renders).toBe(r0);   // 바뀐 것 없음 = 그리기 0
    setHidden(true);
    show(feed(4, 2));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(gl.renders).toBe(r0);
    expect($('[data-lidar3d]')!.dataset.lidar3d).toBe('4');
    setHidden(false);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(gl.renders).toBe(r0 + 1);
  });

  it('칸 크기가 0(숨긴 칸)이면 그리지 않는다', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(0);
    show(feed(3, 1));
    show(feed(5, 2));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(gl.renders).toBe(0);
  });

  it('lidar_link(센서 기준 한 장)도 3D, 쌓지 않으니 «처음부터 다시» 없음', () => {
    show(feed(2, 1, 'lidar_link'));
    expect($('[data-lidar3d]')!.dataset.lidar3d).toBe('2');
    expect($('[data-lm-wipe]')).toBeNull();
  });

  it('3D↔위에서를 30번 바꿔도 살아 있는 WebGL 문맥은 하나', () => {
    show(feed(3, 1));
    expect(gl.alive).toBe(1);
    for (let i = 0; i < 30; i++) {
      act(() => { $('[data-lm-view="top"]')!.click(); });
      act(() => { $('[data-lm-view="3d"]')!.click(); });
    }
    expect(gl.alive).toBe(1);
    act(() => root!.unmount()); root = null;
    expect(gl.alive).toBe(0);
  });

  it('칸이 화면 밖이면 새 판이 와도 버퍼·그리기 멈춤, 돌아오면 최신 판으로 한 번', () => {
    let seen: (es: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal('IntersectionObserver', class { constructor(cb: typeof seen) { seen = cb; } observe() {} disconnect() {} });
    show(feed(3, 1));
    expect(gl.drawn).toBe(3);
    const r0 = gl.renders;
    act(() => seen([{ isIntersecting: false }]));
    show(feed(4, 2)); show(feed(5, 3));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(gl.renders).toBe(r0);
    act(() => seen([{ isIntersecting: true }]));
    expect(gl.renders).toBe(r0 + 1);
    expect(gl.drawn).toBe(5);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(gl.renders).toBe(r0 + 1);
  });

  it('위에서 보기 그대로 frame 이 odom(20,12) → lidar_link 로 바뀌면 원점으로 다시 맞춰 점이 보인다', () => {
    const painted = fake2d(), xyz = (x: number, y: number) => Float32Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? x : i % 3 === 1 ? y : 0) + (i % 3 === 2 ? 0 : (i / 3) * 0.1));
    const at = (frame: string, x: number, y: number, ver: number) => ({ ...feed(10, ver, frame), xyz: xyz(x, y), pose: frame === 'odom' ? { x, y, z: 0, yaw: 0 } : null }) as DriveFeed;
    show(at('odom', 20, 12, 1), { start: 'top' });
    expect(painted()).toBeGreaterThan(0);
    show(at('lidar_link', 0.2, 0.1, 2), { start: 'top' });
    act(() => { vi.advanceTimersByTime(600); });
    expect(painted()).toBeGreaterThan(0);
  });

  it('작은 위에서 지도 칸을 크게 열면 바로 휠 확대가 된다', () => {
    fake2d();
    show(feed(3, 1), { small: true, start: 'top' });
    const wheel = () => $('canvas')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    expect(wheel()).toBe(true);   // 작은 칸 = 보기만
    show(feed(3, 1), { small: false, start: 'top' });
    expect(wheel()).toBe(false);   // 큰 칸 = 휠을 잡아 확대
  });

  it('WebGL 이 없으면 위에서 본 그림 + 까닭 한 줄, 바꾸기 단추는 숨김', () => {
    gl.ok = false;
    show(feed(3, 1));
    expect($('[data-lm-mode]')!.dataset.lmMode).toBe('top');
    expect($('[data-lm-no3d]')).toBeTruthy();
    expect($('[data-lm-view]')).toBeNull();
  });
});

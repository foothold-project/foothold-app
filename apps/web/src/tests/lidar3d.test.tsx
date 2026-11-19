// RB-LIDAR-3D: 라이다 칸 3D/위에서 바꾸기, 점 상한, 안 보이면 그리기 멈춤. jsdom 엔 WebGL 이 없어 three 의 WebGLRenderer 만 그리기 횟수를 세는 가짜로 바꾼다(그림은 headless Chrome 캡처 runs/rb-lidar-3d).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveFeed } from '../drivemedia';
import { CAP_BIG, fillPoints } from '../lidar3d';
import { LidarMap } from '../lidarmap';

const gl = { ok: true, renders: 0, alive: 0, drawn: -1 };
vi.mock('three', async (orig) => {
  const T = await orig<typeof import('three')>();
  class FakeRenderer {
    domElement = document.createElement('canvas');
    constructor() { if (!gl.ok) throw new Error('Error creating WebGL context.'); gl.alive++; }
    setPixelRatio() {} setSize() {} dispose() {}
    forceContextLoss() { gl.alive--; }
    render(scene: { children: { geometry?: { drawRange: { count: number } } }[] }) { gl.renders++; gl.drawn = scene.children[0].geometry!.drawRange.count; }
  }
  return { ...T, WebGLRenderer: FakeRenderer };
});

const feed = (n: number, ver: number, frame = 'odom'): DriveFeed => ({ state: 'live', why: '', at: 0, seq: ver, img: '', xyz: new Float32Array(n * 3).map((_, i) => i % 7), n, frame, truncated: false, ver,
  range: null, pose: frame === 'odom' ? { x: 1, y: 2, z: 0, yaw: 0.3 } : null, path: [], wipe: () => {} } as DriveFeed);
let root: Root | null = null, box: HTMLDivElement;
const show = (f: DriveFeed, o: { small?: boolean; start?: '3d' | 'top' } = {}) => act(() => { root!.render(<LidarMap feed={f} empty="" {...o} />); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const setHidden = (h: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });

beforeEach(() => {
  gl.ok = true; gl.renders = 0; gl.alive = 0; gl.drawn = -1; vi.useFakeTimers(); setHidden(false);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
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

  it('점 상한: 넘으면 고르게 솎아 상한 이하만 버퍼에, 색은 높이 색표', () => {
    const n = CAP_BIG * 2 + 5, xyz = new Float32Array(n * 3), pos = new Float32Array(CAP_BIG * 3), col = new Float32Array(CAP_BIG * 3);
    for (let i = 0; i < n; i++) xyz[i * 3 + 2] = i % 2 ? 1 : -1;
    const m = fillPoints(pos, col, xyz, n, CAP_BIG, 0);
    expect(m).toBeLessThanOrEqual(CAP_BIG); expect(m).toBeGreaterThan(CAP_BIG * 0.6);
    expect(fillPoints(pos, col, xyz, 10, CAP_BIG, 0)).toBe(10);   // 상한 아래는 다
    expect(col[2]).toBeGreaterThan(col[0]);   // 낮은 점(-1 m) = 파랑 쪽(hue 200)
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

// RB-LIDAR-3D: 라이다 칸 3D/위에서 바꾸기, 점 상한, 안 보이면 그리기 멈춤. jsdom 엔 WebGL 이 없어 three 의 WebGLRenderer 만 그리기 횟수를 세는 가짜로 바꾼다(그림은 headless Chrome 캡처 runs/rb-lidar-3d).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveFeed } from '../drivemedia';
import { CAP_BIG, fillPoints } from '../lidar3d';
import { LidarMap } from '../lidarmap';

const gl = { ok: true, renders: 0 };
vi.mock('three', async (orig) => {
  const T = await orig<typeof import('three')>();
  class FakeRenderer {
    domElement = document.createElement('canvas');
    constructor() { if (!gl.ok) throw new Error('Error creating WebGL context.'); }
    setPixelRatio() {} setSize() {} dispose() {}
    render() { gl.renders++; }
  }
  return { ...T, WebGLRenderer: FakeRenderer };
});

const feed = (n: number, ver: number, frame = 'odom'): DriveFeed => ({ state: 'live', why: '', at: 0, seq: ver, img: '', xyz: new Float32Array(n * 3).map((_, i) => i % 7), n, frame, truncated: false, ver,
  range: null, pose: frame === 'odom' ? { x: 1, y: 2, z: 0, yaw: 0.3 } : null, path: [], wipe: () => {} } as DriveFeed);
let root: Root | null = null, box: HTMLDivElement;
const show = (f: DriveFeed) => act(() => { root!.render(<LidarMap feed={f} empty="" />); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const setHidden = (h: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });

beforeEach(() => {
  gl.ok = true; gl.renders = 0; vi.useFakeTimers(); setHidden(false);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
});
afterEach(() => { act(() => root?.unmount()); root = null; box.remove(); vi.useRealTimers(); vi.restoreAllMocks(); setHidden(false); });

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

  it('WebGL 이 없으면 위에서 본 그림 + 까닭 한 줄, 바꾸기 단추는 숨김', () => {
    gl.ok = false;
    show(feed(3, 1));
    expect($('[data-lm-mode]')!.dataset.lmMode).toBe('top');
    expect($('[data-lm-no3d]')).toBeTruthy();
    expect($('[data-lm-view]')).toBeNull();
  });
});

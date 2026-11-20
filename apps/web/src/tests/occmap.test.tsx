// 지도 칸 «걸으며 만드는 지도»(occmap.tsx, 11-20 RB-SLAM-GRID-WEB): 흰 빈 바닥·검정 벽·회색 모름 화소, 0.5초에 한 번만·숨으면 멈춤, 작은 칸은 그림만, 개발자 용어 없음
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveFeed } from '../drivemedia';
import { FLOOR_DZ, GRID_RES, OBST_DZ, occGrid } from '../occgrid';
import { OccMap } from '../occmap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const P = { x: 0, y: 0, z: 0.3, yaw: 0 }, WALL = P.z + FLOOR_DZ + OBST_DZ + 0.1, c = (m: number) => (m + 0.5) * GRID_RES;
const grid = () => { const g = occGrid(400); for (let i = 0; i < 3; i++) g.add(new Float32Array([c(40), c(0), WALL]), P); return g; };
const feed = (ver: number, g = grid(), wipe = () => {}): DriveFeed => ({ state: 'live', why: '', at: 0, seq: ver, img: '', xyz: new Float32Array(0), n: 0, frame: 'odom', truncated: false, ver,
  range: null, pose: P, path: [0, 0, 0.5, 0], grid: g, wipe } as DriveFeed);
let root: Root | null = null, box: HTMLDivElement, frames: Uint32Array[] = [];
const show = (f: DriveFeed, small = false) => act(() => { root!.render(<OccMap feed={f} empty="" small={small} />); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const setHidden = (h: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
const W = 800, H = 500, px = (u: number, w: number) => frames[frames.length - 1][w * W + u];
const ABGR = (r: number, g: number, b: number) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;

beforeEach(() => {
  vi.useFakeTimers(); setHidden(false); frames = [];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(W);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(H);
  const noop = () => {};
  const g = { createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData: (img: ImageData) => { frames.push(new Uint32Array(img.data.slice().buffer)); },
    setTransform: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, save: noop, restore: noop, translate: noop, rotate: noop, closePath: noop, fill: noop };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g as unknown as CanvasRenderingContext2D);
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
});
afterEach(() => { act(() => root?.unmount()); root = null; box.remove(); vi.useRealTimers(); vi.restoreAllMocks(); setHidden(false); });

describe('걸으며 만드는 지도 칸', () => {
  it('로봇 자리·벽 앞 = 흰색, 벽 칸 = 검정, 못 본 곳 = 회색 · 범례 한 줄 · 개발자 용어 없음', () => {
    show(feed(1));
    const k = Math.min(W, H) / 12, u = (x: number) => Math.floor(W / 2 + x * k);   // 처음 = 로봇 둘레 ±6 m, y 는 249 줄이 0 번 행
    expect(px(W / 2, 249)).toBe(ABGR(255, 255, 255));
    expect(px(u(c(20)), 249)).toBe(ABGR(255, 255, 255));
    expect(px(u(c(40)), 249)).toBe(ABGR(20, 20, 26));
    expect(px(u(c(45)), 249)).toBe(ABGR(158, 158, 158));
    expect(px(10, 10)).toBe(ABGR(158, 158, 158));
    expect($('[data-occ-map]')!.dataset.occMap).toBe('41');
    expect($('[data-occ-wall]')!.dataset.occWall).toBe('1');
    expect($('[data-occ-legend]')!.textContent).toBe('빈 바닥벽·물건아직 못 본 곳');
    expect(box.textContent).not.toMatch(/SLAM|odom|로그|오즈|grid|격자/i);
  });
  it('작은 칸(160×120)에서 줄여 그려도 벽은 남는다 — 한 화소에 벽 칸이 하나라도 있으면 검정(RV-438 ②)', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(160);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120);
    const g = occGrid(400), pts: number[] = [];
    for (let m = -40; m < 40; m++) pts.push(c(m), c(20), WALL);   // 4 m 벽(80칸), 1 m 앞 — 1 화소 = 2칸이라 이 줄은 화소 가운데에 안 걸림
    for (let i = 0; i < 3; i++) g.add(new Float32Array(pts), P);
    expect(g.wall).toBe(80);
    show(feed(1, g), true);
    const last = frames[frames.length - 1];
    expect(last.length).toBe(160 * 120);
    expect(last.filter((p) => p === ABGR(20, 20, 26)).length).toBeGreaterThanOrEqual(39);   // 4 m × 10 px/m
  });
  it('격자가 없으면(쌓기 전) 온통 회색', () => {
    show({ ...feed(1), grid: null });
    expect(new Set(frames[0]).size).toBe(1);
    expect(frames[0][0]).toBe(ABGR(158, 158, 158));
  });
  it('0.5초에 한 번만 다시 그리고, 탭이 숨으면 멈췄다가 돌아오면 그린다', () => {
    show(feed(1));
    expect(frames.length).toBe(1);
    for (let v = 2; v <= 6; v++) { show(feed(v)); act(() => { vi.advanceTimersByTime(50); }); }
    expect(frames.length).toBe(1);
    act(() => { vi.advanceTimersByTime(300); });
    expect(frames.length).toBe(2);
    setHidden(true); show(feed(7));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(frames.length).toBe(2);
    setHidden(false);
    act(() => { vi.advanceTimersByTime(500); });
    expect(frames.length).toBe(3);
  });
  it('작은 칸은 그림만(단추·범례 없음, 휠 안 잡음), 큰 칸은 «처음부터 다시»가 화면만 지움', () => {
    show(feed(1), true);
    expect($('[data-occ-legend]')).toBeNull();
    expect($('[data-occ-wipe]')).toBeNull();
    expect($('canvas')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))).toBe(true);
    const wipe = vi.fn();
    show(feed(1, grid(), wipe));
    expect($('canvas')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))).toBe(false);
    act(() => { $('[data-occ-wipe]')!.click(); });
    expect(wipe).toHaveBeenCalledTimes(1);
  });
});

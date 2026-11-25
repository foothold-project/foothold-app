// RB-LIDAR-3D · RB-UNITREE-LOOK-WEB: 라이다 칸 3D/위에서 바꾸기, 상자 상한·색, 시점 되돌림, 천장 숨김은 위에서만, 안 보이면 그리기 멈춤. jsdom 엔 WebGL 이 없어 three 의 WebGLRenderer 만 그리기 횟수를 세는 가짜로 바꾼다(그림은 headless Chrome 캡처 runs/rb-lidar-3d).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveFeed } from '../drivemedia';
import { BLOCK, BLOCK_UP, CAP_BIG, CAP_PHONE, CAP_SMALL, EDGE_LUT, EDGE_PX, EDGE_SCALE, LUT, Lidar3D, capFor, fillBoxes, fillEdges, fillRange, rgbOf } from '../lidar3d';
import { BANDS, HEX, LEGEND_BG, TOP_M, levelOf } from '../heightcolor';
import { JOINTS, type Pose } from '../go2model';
import { CEIL_M } from '../drivemedia';
import { LidarMap } from '../lidarmap';

const gl = { ok: true, renders: 0, alive: 0, drawn: -1, up: 0, inst: 0, pts: 0, snap: '' };
type Inst = { rotation: { x: number; y: number }; isInstancedMesh?: boolean; isPoints?: boolean; count: number; instanceMatrix: { version: number }; geometry: { drawRange: { count: number }; attributes: { position: { version: number } } } };
const seenVer = new WeakMap<object, number>();
vi.mock('three', async (orig) => {
  const T = await orig<typeof import('three')>();
  class FakeRenderer {
    domElement = document.createElement('canvas'); debug = { checkShaderErrors: true };
    constructor() { if (!gl.ok) throw new Error('Error creating WebGL context.'); gl.alive++; }
    setPixelRatio() {} setSize() {} dispose() {}
    forceContextLoss() { gl.alive--; }
    render(scene: { traverse: (f: (o: Inst) => void) => void }) {   // drawn = 상자 묶음 합, up = 이번에 GPU 로 다시 올린 묶음 수(가장 큰 값)
      gl.renders++; gl.drawn = 0; gl.inst = 0; gl.pts = 0; let up = 0; const rot: number[] = [];
      scene.traverse((o) => {   // 상자 묶음(InstancedMesh)·점 묶음(Points) 둘 다 · snap = 모든 것의 돌림(Go2 다리)
        rot.push(o.rotation.x, o.rotation.y);
        if (!o.isInstancedMesh && !o.isPoints) return;
        const [n, ver] = o.isInstancedMesh ? [o.count, o.instanceMatrix.version] : [o.geometry.drawRange.count, o.geometry.attributes.position.version];
        gl.drawn += n; if (o.isInstancedMesh) gl.inst++; else gl.pts++; if (seenVer.get(o) !== ver) { up++; seenVer.set(o, ver); }
      });
      gl.snap = rot.join();
      gl.up = Math.max(gl.up, up);
    }
  }
  return { ...T, WebGLRenderer: FakeRenderer };
});

const feed = (n: number, ver: number, frame = 'odom'): DriveFeed => ({ state: 'live', why: '', at: 0, seq: ver, img: '', xyz: new Float32Array(n * 3).map((_, i) => i % 7), n, frame, truncated: false, ver,
  range: null, pose: frame === 'odom' ? { x: 1, y: 2, z: 0, yaw: 0.3 } : null } as DriveFeed);
let root: Root | null = null, box: HTMLDivElement;
const show = (f: DriveFeed, o: { small?: boolean; start?: '3d' | 'top' } = {}) => { act(() => { root!.render(<LidarMap feed={f} empty="" {...o} />); }); act(() => { vi.advanceTimersByTime(5); }); };   // 처음 열기는 다섯 조각(문맥·확장·렌더러·Go2·첫 판, setTimeout 0 — 가짜 타이머는 안에서 건 0 을 1 ms 로)으로 나뉨
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const setHidden = (h: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });

beforeEach(() => {
  gl.ok = true; gl.renders = 0; gl.alive = 0; gl.drawn = -1; gl.up = 0; vi.useFakeTimers(); setHidden(false);
  vi.stubGlobal('WebGL2RenderingContext', class {});   // jsdom 엔 없다 — 있으면 3D 를 만들어 본다(없으면 lidar3d 가 곧바로 위에서 본 그림)
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
    expect(capFor(false, 203, 152)).toBe(CAP_SMALL);   // 폰 직결 작은 창(small 아님)도 크기로 작은 칸
  });

  /** 프레임 대기열(jsdom 엔 그리기 프레임이 없다) — frames() = 남은 프레임을 다 돌리고 돈 수 */
  const rafQueue = () => {
    let q: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => q.push(f));
    vi.stubGlobal('cancelAnimationFrame', () => { q = []; });
    return () => { let k = 0; while (q.length && k < 500) { const f = q; q = []; act(() => f.forEach((x) => x(0))); k++; } return k; };
  };

  it('RV-460 1: 20만 칸 3D 는 한 번에 다 만들지 않고 여러 프레임에 나눠 채운다(한 번에 GPU 로 올리는 묶음 ≤ BLOCK_UP)', () => {
    const frames = rafQueue();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1268);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(614);
    show(feed(CAP_BIG, 1));
    expect(gl.drawn).toBeLessThanOrEqual(BLOCK * BLOCK_UP);   // 첫 손 = 묶음 몇 개만
    expect(frames()).toBeGreaterThan(3);
    expect(gl.drawn).toBe(CAP_BIG);
    expect(gl.up).toBeLessThanOrEqual(BLOCK_UP);
    const r0 = gl.renders;   // 새 판인데 내용이 같으면 다시 올리지 않는다(바뀐 묶음만)
    show(feed(CAP_BIG, 2)); act(() => { vi.advanceTimersByTime(600); }); frames();
    expect(gl.renders).toBe(r0 + 1);
  });

  it('RV-460 2: 칸 크기가 바뀌면 그 크기의 상한으로 다시(PC 20만 → 폰 6만 → 작은 창 2만 → PC)', () => {
    const frames = rafQueue();
    const size = (w: number, h: number) => { vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w); vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(h); };
    size(1268, 614);
    show(feed(CAP_BIG, 1)); frames();
    expect(gl.drawn).toBe(CAP_BIG);
    size(378, 658); act(() => { vi.advanceTimersByTime(600); }); frames();
    expect(gl.drawn).toBeLessThanOrEqual(CAP_PHONE); expect(gl.drawn).toBeGreaterThan(CAP_PHONE * 0.6);
    size(203, 152); act(() => { vi.advanceTimersByTime(600); }); frames();
    expect(gl.drawn).toBeLessThanOrEqual(CAP_SMALL); expect(gl.drawn).toBeGreaterThan(CAP_SMALL * 0.6);
    size(1268, 614); act(() => { vi.advanceTimersByTime(600); }); frames();
    expect(gl.drawn).toBe(CAP_BIG);
  });

  it('범례 «바닥 · 1 m · 2 m+»(개발자 말 없음), 손으로 확대하면 «로봇 뒤에서 보기» 하나로 되돌림', () => {
    show(feed(3, 1));
    expect($('[data-height-legend]')!.textContent).toBe('바닥1 m2 m+');
    const band = ($('[data-height-legend] > div') as HTMLElement).style.background;   // 점·상자·지도 탭 같은 막대(LEGEND_BG)
    expect(band).toContain('linear-gradient'); expect(band).toBe(Object.assign(document.createElement('i').style, { background: LEGEND_BG }).background);
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
    act(() => { vi.advanceTimersByTime(5); });   // 마지막 3D 만 문맥까지 간다(빨리 바꾸면 그 사이 것은 문맥을 만들지 않음)
    expect(gl.alive).toBe(1);
    act(() => root!.unmount()); root = null;
    expect(gl.alive).toBe(0);
  });

  it('RB-UNITREE-LOOK-FIX A·B: 라이다 칸은 점(Points), «보기» 줄 «상자»는 같은 그림을 상자(InstancedMesh)로 — WebGL 하나 그대로, 다시 3D 면 점', () => {
    act(() => root!.render(<LidarMap feed={feed(3, 1)} empty="" pick />)); act(() => { vi.advanceTimersByTime(600); });
    expect(gl.pts).toBeGreaterThan(0); expect(gl.inst).toBe(0); expect($('[data-lidar3d]')!.dataset.l3Look).toBe('points');
    expect($('.qd-legend')?.textContent).toContain('바닥');
    act(() => { $('[data-lm-view="box"]')!.click(); }); act(() => { vi.advanceTimersByTime(600); });
    expect($('[data-lidar3d]')!.dataset.l3Look).toBe('boxes'); expect(gl.inst).toBeGreaterThan(0); expect(gl.pts).toBe(0);
    expect(gl.alive).toBe(1); expect(gl.drawn).toBe(3);
    act(() => { $('[data-lm-view="3d"]')!.click(); }); act(() => { vi.advanceTimersByTime(600); });
    expect(gl.pts).toBeGreaterThan(0); expect(gl.inst).toBe(0); expect(gl.alive).toBe(1);
    act(() => root!.render(<LidarMap feed={feed(3, 1)} empty="" />));
    expect($('[data-lm-view="box"]')).toBeNull();   // pick 없으면(서버 경유 — 바깥 고르기가 «상자») 줄엔 3D·위에서만
  });

  it('RB-LIDAR-COLOR: 바닥·0.3·0.75·1.2 m 가 서로 다른 색, 점·상자·위에서 본 그림·범례가 같은 표, 자리는 받은 그대로(점은 5 cm 맞춤 없음)', () => {
    const hs = [0, 0.3, 0.75, 1.2], floor = -0.3, xyz = new Float32Array(hs.flatMap((h) => [0.013, 0, floor + h + 0.01]));
    const pts = [new Float32Array(12), new Float32Array(12)], box = [new Float32Array(64), new Float32Array(12)];
    expect(fillRange(pts[0], pts[1], xyz, 4, 10, floor, 0, 4, false)).toEqual([4, true]);
    fillRange(box[0], box[1], xyz, 4, 10, floor, 0, 4, true);
    expect(pts[0][0]).toBeCloseTo(0.013, 5);
    expect([...pts[1]]).toEqual([...box[1]]);   // 점 = 상자
    const hex = hs.map((h) => HEX[levelOf(floor + h + 0.01, floor)]);
    expect(new Set(hex).size).toBe(4);
    expect(hex[0]).toBe(BANDS[0][1]);   // 바닥 띠
    hs.forEach((_, i) => expect(rgbOf(levelOf(floor + hs[i] + 0.01, floor))).toEqual([1, 3, 5].map((j) => parseInt(hex[i].slice(j, j + 2), 16))));
    BANDS.forEach(([, c]) => expect(LEGEND_BG).toContain(c));
    expect([levelOf(floor - 1, floor), levelOf(floor + TOP_M + 1, floor)]).toEqual([0, HEX.length - 1]);   // 꺼진 점 = 바닥색, 높은 점 = 끝 색
  });

  it('RB-LIDAR-COLOR: 0.1~1.2 m 는 20 cm 이하 간격, 이웃 띠는 밝기(L*)가 15 이상 달라 다크·라이트 배경·색각 이상에서도 갈린다', () => {
    const tops = BANDS.map(([t]) => t), inner = tops.filter((t) => t > 0.1 && t <= 1.2);
    inner.forEach((t, i) => expect(t - (i ? inner[i - 1] : 0.1)).toBeLessThanOrEqual(0.2 + 1e-9));
    const lin = (v: number) => (v <= 0.04045 * 255 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const L = (h: string) => { const [r, g, b] = [1, 3, 5].map((j) => lin(parseInt(h.slice(j, j + 2), 16))), y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return 116 * Math.cbrt(y) - 16; };
    BANDS.slice(1).forEach(([, c], i) => expect(Math.abs(L(c) - L(BANDS[i][1]))).toBeGreaterThan(15));
    BANDS.forEach(([, c]) => { expect(L(c)).toBeGreaterThan(35); expect(L(c)).toBeLessThan(85); });   // 검은·흰 배경 둘 다에서 보이게
  });

  it('RB-UNITREE-LOOK-FIX E: 받은 관절각이 바뀌면 3D 속 Go2 다리가 그 판에 바로 움직이고, 없으면 선 자세 + «자세 정보 없음»', () => {
    const f = feed(3, 1), at = (go2: Pose) => act(() => root!.render(<Lidar3D feed={f} small={false} onFail={() => {}} go2={go2} />));
    at(null); act(() => { vi.advanceTimersByTime(600); });
    const stand = gl.snap;
    expect($('[data-l3-nopose]')!.textContent).toBe('자세 정보 없음 — 서 있는 모양으로 보입니다');
    const pose = (v: number): Pose => ({ q: JOINTS.map(() => v), wxyz: [1, 0, 0, 0] });
    let r0 = gl.renders; at(pose(0.3));
    expect(gl.renders).toBe(r0 + 1); expect(gl.snap).not.toBe(stand); expect($('[data-l3-nopose]')).toBeNull();   // 2 Hz 판 기다리지 않음
    const a = gl.snap; r0 = gl.renders; at(pose(0.3));
    expect(gl.renders).toBe(r0);   // 값이 같은 새 객체 = 다시 그리지 않음
    at(pose(0.6)); expect(gl.snap).not.toBe(a);
    at(null); expect(gl.snap).toBe(stand); expect($('[data-l3-nopose]')).toBeTruthy();   // 끊기면 선 자세로(꾸미지 않음)
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

  it('처음 열기를 잘게: 누른 작업에선 문맥 0 — 문맥(getContext)·렌더러는 다음 작업들에서 하나씩 (RV-466 2)', () => {
    const ctx = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    act(() => { root!.render(<LidarMap feed={feed(3, 1)} empty="" />); });
    expect(ctx.mock.calls.filter(([k]) => k === 'webgl2')).toHaveLength(0); expect(gl.alive).toBe(0);
    act(() => { vi.advanceTimersToNextTimer(); });   // 작업 하나씩
    expect(ctx.mock.calls.filter(([k]) => k === 'webgl2')).toHaveLength(1); expect(gl.alive).toBe(0);
    act(() => { vi.advanceTimersToNextTimer(); });   // 확장
    expect(gl.alive).toBe(0);
    act(() => { vi.advanceTimersToNextTimer(); });
    expect(gl.alive).toBe(1);
  });

  it('WebGL2 가 아예 없는 환경이면 기다리지 않고 바로 위에서 본 그림', () => {
    vi.stubGlobal('WebGL2RenderingContext', undefined);
    act(() => { root!.render(<LidarMap feed={feed(3, 1)} empty="" />); });
    expect($('[data-lm-mode]')!.dataset.lmMode).toBe('top');
    expect(gl.alive).toBe(0);
  });

  it('WebGL 이 없으면 위에서 본 그림 + 까닭 한 줄, 바꾸기 단추는 숨김', () => {
    gl.ok = false;
    show(feed(3, 1));
    expect($('[data-lm-mode]')!.dataset.lmMode).toBe('top');
    expect($('[data-lm-no3d]')).toBeTruthy();
    expect($('[data-lm-view]')).toBeNull();
  });
});

describe('RB-LIDAR-EDGEWEB 모서리 점', () => {
  const withEdge = (n: number, ver: number, e: number[] | null, frame = 'odom') => ({ ...feed(n, ver, frame), edge: e && Uint8Array.from(e) }) as DriveFeed;

  it('버퍼: 모서리(양수)만 채우고, 자리는 보통 점·상자와 같게 — 상자 색은 같은 높이 색을 더 밝게, 점 색은 테두리 색 · 점·상자는 더 크게', () => {
    const floor = -0.3, xyz = new Float32Array([0.013, 0, floor + 0.01, 0.5, 0.5, floor + 0.3, 1, 1, floor + 0.75]), e = Uint8Array.of(0, 255, 7);
    const p = [new Float32Array(9), new Float32Array(9)], b = [new Float32Array(48), new Float32Array(9)], q = [new Float32Array(9), new Float32Array(9)], r = [new Float32Array(48), new Float32Array(9)];
    expect(fillEdges(p[0], p[1], xyz, 3, e, floor, false)).toBe(2);
    expect(fillEdges(b[0], b[1], xyz, 3, e, floor, true)).toBe(2);
    fillRange(q[0], q[1], xyz, 3, 10, floor, 0, 3, false); fillRange(r[0], r[1], xyz, 3, 10, floor, 0, 3, true);
    expect([...p[0].slice(0, 6)]).toEqual([...q[0].slice(3, 9)]);   // 점 자리 = 받은 그대로(1·2번 점)
    expect([b[0][12], b[0][13], b[0][14], b[0][28], b[0][29], b[0][30]]).toEqual([r[0][28], r[0][29], r[0][30], r[0][44], r[0][45], r[0][46]]);   // 상자 = 5 cm 칸 가운데
    for (let m = 0; m < 2; m++) for (let a = 0; a < 3; a++) {   // 상자: 같은 높이 색보다 밝게(흰색 쪽)
      expect(b[1][m * 3 + a]).toBeGreaterThanOrEqual(r[1][(m + 1) * 3 + a]); expect(b[1][m * 3 + a]).toBeLessThanOrEqual(1);
    }
    expect(b[1].slice(0, 3).reduce((x, y) => x + y)).toBeGreaterThan(r[1].slice(3, 6).reduce((x, y) => x + y) + 0.3);
    expect(EDGE_LUT.length).toBe(LUT.length);
    expect(fillEdges(p[0], p[1], xyz, 3, e, floor, false, [0.1, 0.2, 0.3])).toBe(2);   // 점: 테두리 색 그대로
    expect([...p[1].slice(0, 6)].map((x) => +x.toFixed(4))).toEqual([0.1, 0.2, 0.3, 0.1, 0.2, 0.3]);
    expect(EDGE_PX).toBeGreaterThan(1.5); expect(EDGE_SCALE).toBeGreaterThan(1);
    expect(fillEdges(p[0], p[1], xyz, 3, Uint8Array.of(0, 0, 0), floor, false)).toBe(0);
  });

  it('3D 점·상자: edge 가 있으면 모서리 층(큰 점·큰 상자)을 더 그리고 범례 «모서리», 없으면 지금과 같음', () => {
    act(() => root!.render(<LidarMap feed={withEdge(5, 1, null)} empty="" pick />)); act(() => { vi.advanceTimersByTime(600); });
    expect(gl.drawn).toBe(5); expect(gl.pts).toBe(1); expect($('[data-lidar3d]')!.dataset.l3Edges).toBeUndefined(); expect($('[data-edge-legend]')).toBeNull();
    act(() => root!.render(<LidarMap feed={withEdge(5, 2, [255, 0, 255, 0, 0])} empty="" pick />)); act(() => { vi.advanceTimersByTime(600); });
    expect($('[data-lidar3d]')!.dataset.l3Edges).toBe('2'); expect(gl.drawn).toBe(7); expect(gl.pts).toBe(2);
    expect($('[data-edge-legend]')!.textContent).toContain('모서리');
    act(() => { $('[data-lm-view="box"]')!.click(); }); act(() => { vi.advanceTimersByTime(600); });
    expect($('[data-lidar3d]')!.dataset.l3Edges).toBe('2'); expect(gl.drawn).toBe(7); expect(gl.inst).toBe(2); expect(gl.pts).toBe(0);
    act(() => root!.render(<LidarMap feed={withEdge(5, 3, [0, 0, 0, 0, 0])} empty="" pick />)); act(() => { vi.advanceTimersByTime(600); });
    expect(gl.drawn).toBe(5); expect(gl.inst).toBe(1);   // 모서리 0 개면 층을 장면에서 뺀다
    act(() => root!.render(<LidarMap feed={withEdge(5, 4, null)} empty="" pick />)); act(() => { vi.advanceTimersByTime(600); });
    expect(gl.drawn).toBe(5); expect($('[data-edge-legend]')).toBeNull();
  });

  it('위에서 본 그림: 모서리 점은 테두리를 둘러 더 크게 맨 위에, 범례 «모서리» — 없으면 그대로', () => {
    const painted = fake2d(), pts = (e: number[] | null, ver: number) => ({ ...withEdge(2, ver, e, 'lidar_link'), xyz: new Float32Array([0, 0, -0.29, 1, 0, -0.29]) }) as DriveFeed;
    show(pts(null, 1), { start: 'top' });
    const k0 = painted();
    expect($('[data-edge-legend]')).toBeNull();
    act(() => root!.render(<LidarMap feed={pts([255, 0], 2)} empty="" start="top" />)); act(() => { vi.advanceTimersByTime(600); });
    expect(painted()).toBeGreaterThan(k0);
    expect($('[data-edge-legend]')).toBeTruthy();
  });
});

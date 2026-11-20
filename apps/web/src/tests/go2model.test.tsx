// RB-GO2-REAL-RENDER(11-19) Go2 그림: 메시 없으면 상자 그림, 관절 값 12개, 움직임 문턱(정지 = 화살표 없음 · 움직임 = 방향 맞음). 메시 파일 자체는 go2mesh.test.js.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Go2RobotInfo } from '../../../contracts/ts';
import pcCss from '../pcdrive.css?raw';
import { Go2Figure, JOINTS, TEMP_MAX, TEMP_MIN, resetGo2Cache, spread, tempColor, useGo2Motion, type Motion, type Pose } from '../go2model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom 엔 WebGL 이 없다 — WebGLRenderingContext 를 넣은 시험에서만 쓰이는, 그리기 횟수·그린 자세를 세는 가짜 그리개(RV-437 2)
const gl = { renders: 0, snap: '' };
vi.mock('three', async (orig) => {
  const T = await orig<typeof import('three')>();
  class FakeRenderer {
    domElement = document.createElement('canvas');
    setPixelRatio() {} setSize() {} dispose() {} forceContextLoss() {}
    render(scene: import('three').Scene) { gl.renders++; const r: number[] = []; scene.traverse((o) => r.push(o.rotation.x, o.rotation.y)); gl.snap = r.join(); }
  }
  return { ...T, WebGLRenderer: FakeRenderer };
});
let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); resetGo2Cache(); vi.unstubAllGlobals(); });
const show = (el: JSX.Element) => { box = document.createElement('div'); document.body.append(box); act(() => { root = createRoot(box); root.render(el); }); };
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });
const POSE: Pose = { q: JOINTS.map(() => 0.3), wxyz: [1, 0, 0, 0] };
const $ = (s: string) => box.querySelector<HTMLElement>(s);

/** 보고 두 개(i = 0 → 1, 0.1 s 간격)를 차례로 넣고 그 움직임으로 그림 */
function Two({ a, b, i, on }: { a: Partial<Snap>; b: Partial<Snap>; i: number; on: boolean }) {
  const s = i ? b : a, pose: Pose = { q: s.q ?? POSE!.q, wxyz: quat(s.yaw ?? 0) };
  last = useGo2Motion(mk(s, i), pose);
  return <Go2Figure pose={pose} motion={last} showJoints={on} />;
}
type Snap = { q: number[]; xy: number[]; yaw: number };
let last: Motion | null = null;
const quat = (y: number) => [Math.cos(y / 2), 0, 0, Math.sin(y / 2)];
const mk = (s: Partial<Snap>, i: number) => {
  const at = new Date(Date.UTC(2026, 10, 19, 0, 0, 0, i * 100)).toISOString();
  return { source: 'GO2_DDS', attitude: { roll: 0, pitch: 0 }, error_code: 0, fallen: false, fallen_source: 'imu_tilt_estimate',
    joints: { received_at: at, age_s: 0, names: JOINTS, positions: s.q ?? POSE!.q },
    quaternion: { received_at: at, age_s: 0, wxyz: quat(s.yaw ?? 0) },
    position: { received_at: at, age_s: 0, xyz: [...(s.xy ?? [0, 0]), 0.3], origin: 'BOOT_ORIGIN_UNVERIFIED' } } as unknown as Go2RobotInfo;
};
function step(a: Partial<Snap>, b: Partial<Snap>, on = true) {
  show(<Two a={a} b={b} i={0} on={on} />);
  act(() => root!.render(<Two a={a} b={b} i={1} on={on} />));
}
const qWith = (name: string, v: number) => JOINTS.map((n) => (n === name ? 0.3 + v : 0.3));

describe('Go2 그림', () => {
  it('메시를 못 받으면(파일 없음) 상자 그림으로 — 화면 안 깨짐, 관절 값은 그대로', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    show(<Go2Figure pose={POSE} />);
    await flush();
    expect($('[data-go2-model]')!.dataset.go2Model).toBe('box');
    expect(box.querySelectorAll('[data-go2-joint]')).toHaveLength(12);
  });

  it('관절 값 12개(도, 소수 0자리) · 끄면 0개 · 보고 없으면 0개', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    show(<Go2Figure pose={{ q: JOINTS.map((_, i) => (i * Math.PI) / 180 * 10), wxyz: [1, 0, 0, 0] }} />);
    const tags = [...box.querySelectorAll<HTMLElement>('[data-go2-joint]')];
    expect(tags.map((t) => t.dataset.go2Joint)).toEqual(JOINTS);
    expect(tags.map((t) => t.textContent)).toEqual(JOINTS.map((_, i) => `${i * 10}°`));
    act(() => root!.render(<Go2Figure pose={POSE} showJoints={false} />));
    expect(box.querySelectorAll('[data-go2-joint]')).toHaveLength(0);
    act(() => root!.render(<Go2Figure pose={null} />));
    expect(box.querySelectorAll('[data-go2-joint]')).toHaveLength(0);
  });

  it('정지(작은 떨림만) = 관절·몸 화살표 없음', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    step({ xy: [0, 0], yaw: 0 }, { q: qWith('FL_thigh_joint', 0.005), xy: [0.002, 0], yaw: 0.002 });   // 0.05 rad/s · 0.02 m/s · 0.02 rad/s
    expect(box.querySelectorAll('[data-moving]')).toHaveLength(0);
    expect($('[data-go2-move]')).toBeNull(); expect($('[data-go2-turn]')).toBeNull();
    expect(box.textContent).not.toMatch(/°\/s|m\/s|rad\/s/);
  });

  it('관절이 돌면 그 관절에만 방향 화살표 + °/s — 부호가 바뀌면 방향도 바뀜(카메라는 오른쪽 앞에서 봄)', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    step({}, { q: qWith('FL_thigh_joint', 0.1) });   // +1 rad/s
    const moving = () => [...box.querySelectorAll<HTMLElement>('[data-moving]')];
    expect(moving().map((t) => t.dataset.go2Joint)).toEqual(['FL_thigh_joint']);
    // 왼쪽 허벅지 축(+y)은 카메라 반대쪽을 향함 → + 회전은 보는 사람에게 시계 방향
    expect(moving()[0].dataset.moving).toBe('cw'); expect(moving()[0].textContent).toBe('23°↻ 57°/s');
    act(() => root!.unmount()); box.remove();
    step({}, { q: qWith('FL_thigh_joint', -0.1) });
    expect(moving()[0].dataset.moving).toBe('ccw');
    act(() => root!.unmount()); box.remove();
    step({}, { q: qWith('FR_hip_joint', 0.1) });   // 엉덩이 축(+x 앞)은 카메라 쪽 → + 는 반시계
    expect(moving().map((t) => [t.dataset.go2Joint, t.dataset.moving])).toEqual([['FR_hip_joint', 'ccw']]);
  });

  it('몸이 움직이면 바닥 화살표 + m/s(몸 기준 방향), 돌면 굽은 화살표 + rad/s(왼쪽 = 반시계)', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    // 로봇이 왼쪽(+90°)을 보고 세계 +y 로 0.5 m/s → 몸 기준으로는 앞으로
    step({ xy: [0, 0], yaw: Math.PI / 2 }, { xy: [0, 0.05], yaw: Math.PI / 2 });
    expect(last!.v![0]).toBeCloseTo(0.5); expect(last!.v![1]).toBeCloseTo(0);
    expect($('[data-go2-move]')!.textContent).toBe('0.5 m/s'); expect($('[data-go2-turn]')).toBeNull();
    act(() => root!.unmount()); box.remove();
    step({ yaw: 3.1 }, { yaw: -3.13 });   // ±π 넘김: 왼쪽으로 0.053 rad/0.1 s
    expect(last!.wz).toBeCloseTo(0.532, 2);
    expect($('[data-go2-turn]')!.dataset.go2Turn).toBe('left'); expect($('[data-go2-turn]')!.textContent).toBe('↺ 0.53 rad/s');
    act(() => root!.unmount()); box.remove();
    step({ yaw: 0 }, { yaw: -0.03 });
    expect($('[data-go2-turn]')!.dataset.go2Turn).toBe('right');
  });

  it('tempColor: 한 색상 눈금 20°C 연함 → 50°C → 80°C 진함(토큰 값), 범위 밖은 끝 색, 없음은 회색', () => {
    expect([20, 50, 80].map(tempColor)).toEqual(['#e0f0ed', '#3ec7b4', '#0b6459']);
    expect(tempColor(-5)).toBe(tempColor(TEMP_MIN)); expect(tempColor(120)).toBe(tempColor(TEMP_MAX));
    expect([null, undefined, NaN].map(tempColor)).toEqual(['#7d8693', '#7d8693', '#7d8693']);
    const lum = (h: string) => [1, 3, 5].reduce((a, o, k) => a + [0.2126, 0.7152, 0.0722][k] * parseInt(h.slice(o, o + 2), 16), 0);
    const L = Array.from({ length: 61 }, (_, i) => lum(tempColor(20 + i)));
    expect(L.every((v, i) => i === 0 || v < L[i - 1])).toBe(true);   // 뜨거울수록 늘 더 진함
  });

  it('spread: 겹치는 글자는 위아래로 비켜 놓고 칸 밖으로 안 나감', () => {
    const b = spread([{ x: 50, y: 50, side: 1, w: 30, h: 14 }, { x: 50, y: 50, side: 1, w: 30, h: 14 }, { x: 95, y: 50, side: 1, w: 30, h: 14 }], 100, 100);
    expect(b.every(Boolean)).toBe(true);
    expect(noOverlap(b as Box[])).toBe(true);
    for (const x of b as Box[]) { expect(x.x).toBeGreaterThanOrEqual(0); expect(x.x + x.w).toBeLessThanOrEqual(100); }
    // 자리가 없으면 null(그림 아래 줄로), pin(몸 화살표 글자)은 칸 안으로 당김
    const c = spread([{ x: 5, y: 5, side: -1, w: 90, h: 90 }, { x: 5, y: 5, side: -1, w: 90, h: 90 }, { x: 99, y: 99, side: 1, w: 40, h: 16, pin: true }], 100, 100);
    expect(c[0]).not.toBeNull(); expect(c[1]).toBeNull(); expect(c[2]).toEqual({ x: 60, y: 84, w: 40, h: 16 });
  });
});

type Box = { x: number; y: number; w: number; h: number };
const noOverlap = (b: Box[]) => b.every((p, i) => b.every((o, j) => j <= i || !(p.x < o.x + o.w && o.x < p.x + p.w && p.y < o.y + o.h && o.y < p.y + p.h)));
/** 보고 목록 중 i 번째까지 차례로 넣는다(센서마다 시각·값·만료를 따로) */
type Rep = { t: number; xy?: number[] | null; pt?: number; page?: number; yaw?: number; qt?: number };
const info = (r: Rep) => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 19, 0, 0, 0, ms)).toISOString();
  return { joints: { received_at: at(r.t), age_s: 0, names: JOINTS, positions: POSE!.q },
    quaternion: { received_at: at(r.qt ?? r.t), age_s: 0, wxyz: quat(r.yaw ?? 0) },
    position: r.xy === null ? null : { received_at: at(r.pt ?? r.t), age_s: r.page ?? 0, xyz: [...(r.xy ?? [0, 0]), 0.3], origin: 'BOOT_ORIGIN_UNVERIFIED' } } as unknown as Go2RobotInfo;
};
function Seq({ reps, i }: { reps: Rep[]; i: number }) {
  const pose: Pose = { q: POSE!.q, wxyz: quat(reps[i].yaw ?? 0) };
  last = useGo2Motion(info(reps[i]), pose);
  return <Go2Figure pose={pose} motion={last} />;
}
function run(reps: Rep[]) {
  show(<Seq reps={reps} i={0} />);
  const at = (i: number) => act(() => root!.render(<Seq reps={reps} i={i} />));
  return at;
}

describe('RV-403 막는 결함', () => {
  it('1 위치 보고가 빠지거나 만료되면 몸 속도·화살표가 사라진다, 관절 보고는 계속 와도', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const go = run([{ t: 0, xy: [0, 0] }, { t: 100, xy: [0.05, 0] }, { t: 200, xy: null }, { t: 300, xy: [0.05, 0] }, { t: 400, xy: [0.1, 0] }, { t: 500, xy: [0.1, 0], pt: 400, page: 1.2 }]);
    go(1); expect($('[data-go2-move]')!.textContent).toBe('0.5 m/s');
    go(2); expect(last!.v).toBeNull(); expect($('[data-go2-move]')).toBeNull();          // position 빠짐(관절만 옴)
    go(3); expect(last!.v).toBeNull();                                                   // 다시 와도 앞 이력 없이 하나뿐 → 아직 모름
    go(4); expect(last!.v![0]).toBeCloseTo(0.5); expect($('[data-go2-move]')).not.toBeNull();
    go(5); expect(last!.v).toBeNull(); expect($('[data-go2-move]')).toBeNull();          // 같은 위치 보고가 1.2초 묵음 = 만료
  });

  it('1 시각이 같거나 거꾸로 간 보고는 버린다', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const go = run([{ t: 0, xy: [0, 0] }, { t: 100, xy: [0.05, 0] }, { t: 150, xy: [9, 0], pt: 50 }, { t: 160, xy: [7, 0], pt: 100 }]);
    go(1); expect(last!.v![0]).toBeCloseTo(0.5);
    go(2); expect(last!.v![0]).toBeCloseTo(0.5);   // 위치 시각 50 ms(거꾸로) — 무시
    go(3); expect(last!.v![0]).toBeCloseTo(0.5);   // 위치 시각 100 ms(같음) — 무시
  });

  it('RV-405 늦게 온 옛 방향 보고(yaw π)는 버린다 — 몸 기준 화살표는 그대로 앞(+)', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const go = run([{ t: 1000, xy: [0, 0] }, { t: 1100, xy: [0.05, 0] }, { t: 1150, xy: [0.05, 0], pt: 1100, yaw: Math.PI, qt: 1050 }]);
    go(1); expect(last!.v![0]).toBeCloseTo(0.5);
    go(2); expect(last!.v![0]).toBeCloseTo(0.5); expect(last!.v![1]).toBeCloseTo(0); expect(last!.wz).toBeCloseTo(0);
    expect($('[data-go2-move]')!.textContent).toBe('0.5 m/s');
  });

  it('RV-405 1.16초 묵은 역순 위치 보고는 최신 이력을 지우지 않는다, 같은 보고가 묵으면 지금처럼 만료', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const go = run([{ t: 1000, xy: [0, 0] }, { t: 1100, xy: [0.05, 0] }, { t: 1150, xy: [9, 0], pt: 40, page: 1.16 }, { t: 1200, xy: [0.05, 0], pt: 1100, page: 1.2 }]);
    go(1); expect(last!.v![0]).toBeCloseTo(0.5);
    go(2); expect(last!.v![0]).toBeCloseTo(0.5); expect($('[data-go2-move]')!.textContent).toBe('0.5 m/s');
    go(3); expect(last!.v).toBeNull(); expect($('[data-go2-move]')).toBeNull();
  });

  it('RV-406 위치가 1050 ms 짜리 역순 보고만 반복되면 마지막 유효 위치(1100 ms)가 1초 넘게 묵은 때 화살표가 사라진다', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const old = (t: number, page: number) => ({ t, xy: [0.01, 0], pt: 1050, page });
    const go = run([{ t: 1000, xy: [0, 0] }, { t: 1100, xy: [0.05, 0] }, old(1500, 0.45), old(2300, 1.25), old(3000, 1.95)]);
    go(1); expect(last!.v![0]).toBeCloseTo(0.5);
    go(2); expect(last!.v![0]).toBeCloseTo(0.5);   // 0.4초 묵음 — 아직 그대로
    go(3); expect(last!.v).toBeNull(); expect($('[data-go2-move]')).toBeNull();   // 1.2초
    go(4); expect(last!.v).toBeNull(); expect($('[data-go2-move]')).toBeNull();   // 1.9초
  });

  it('RV-406 age_s 가 0 으로 오는(잘못 적힌) 역순 위치 보고도 관절·방향 시각으로 만료', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const old = (t: number) => ({ t, xy: [0.01, 0], pt: 1050, page: 0 });
    const go2 = run([{ t: 1000, xy: [0, 0] }, { t: 1100, xy: [0.05, 0] }, old(2300), old(3000)]);
    go2(1); expect(last!.v![0]).toBeCloseTo(0.5);
    go2(2); expect(last!.v).toBeNull(); go2(3); expect(last!.v).toBeNull();
  });

  it('RV-406 시계가 크게 되감기면(새 보고인데 1초 넘게 뒤) 옛 시각을 기다리지 않고 새 이력으로 다시 속도', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const go = run([{ t: 100000, xy: [0, 0] }, { t: 100100, xy: [0.05, 0] }, { t: 1000, xy: [1, 0] }, { t: 1100, xy: [1.03, 0] }]);
    go(1); expect(last!.v![0]).toBeCloseTo(0.5);
    go(2); expect(last!.v).toBeNull();   // 되감김 = 새 이력 한 개
    go(3); expect(last!.v![0]).toBeCloseTo(0.3); expect($('[data-go2-move]')!.textContent).toBe('0.3 m/s');
  });

  it('RV-409 1 위치가 5000→5100→5200 ms 로 가는데 4000 ms 옛 방향(yaw π, age_s 0)이 오면 되감김으로 보지 않는다 — 몸 기준 +0.5 그대로', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const go = run([{ t: 5000, xy: [0, 0] }, { t: 5100, xy: [0.05, 0] }, { t: 5200, xy: [0.1, 0], yaw: Math.PI, qt: 4000 }]);
    go(1); expect(last!.v![0]).toBeCloseTo(0.5);
    go(2); expect(last!.v![0]).toBeCloseTo(0.5); expect(last!.v![1]).toBeCloseTo(0);
    expect($('[data-go2-move]')!.textContent).toBe('0.5 m/s');
  });

  it('RV-409 2 받아들이지 않는 옛 보고(10050 ms·age_s 0)가 100 ms 마다 계속 와도 화면 시계로 1초 뒤 화살표 만료', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const old = { t: 10050, xy: [0.025, 0] }, go = run([{ t: 10000, xy: [0, 0] }, { t: 10100, xy: [0.05, 0] }, ...Array(13).fill(old)]);
      go(1); expect(last!.v![0]).toBeCloseTo(0.5);
      for (let i = 2; i <= 14; i++) { vi.advanceTimersByTime(100); go(i); }   // 1.3초
      expect(last!.v).toBeNull(); expect($('[data-go2-move]')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('RV-409 5 WebGL 이 없을 때 «간단한 그림» 안내는 그림 칸 밖 아래 줄 — 범례(그림 칸 오른쪽 아래)와 겹치지 않는다', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    show(<Go2Figure pose={POSE} temps={JOINTS.map(() => 40)} />);
    const note = $('.pd-go2-fail')!;
    expect(note.textContent).toBe('간단한 그림(3D 를 못 그리는 브라우저)');
    expect(note.closest('.pd-go2-view')).toBeNull(); expect(note.closest('.pd-go2-dots')).toBeNull();
    expect(pcCss).not.toMatch(/\.pd-go2-fail\{[^}]*position:absolute/);
  });

  it('2 WebGL 이 없으면 선 그림(몸통 상자·다리 4개)이 관절각대로 그려진다', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    expect(typeof WebGLRenderingContext).toBe('undefined');   // jsdom = WebGL 없음
    show(<Go2Figure pose={POSE} />);
    const svg = $('[data-go2-sketch]')!;
    expect(svg).not.toBeNull(); expect(svg.querySelectorAll('[data-go2-leg]')).toHaveLength(4);
    const leg = () => svg.querySelector('[data-go2-leg="RR"] polyline')!.getAttribute('points');
    const before = leg(), fl = svg.querySelector('[data-go2-leg="FL"] polyline')!.getAttribute('points');
    act(() => root!.render(<Go2Figure pose={{ q: qWith('RR_calf_joint', -0.8), wxyz: [1, 0, 0, 0] }} />));
    expect(leg()).not.toBe(before);                                                     // 뒤 오른 무릎만 바뀜
    expect(svg.querySelector('[data-go2-leg="FL"] polyline')!.getAttribute('points')).toBe(fl);
    expect(box.textContent).toContain('간단한 그림(3D 를 못 그리는 브라우저)');
  });

  it('3 1280×800 의 좁은 그림(243×368)·12관절 1.5 rad/s: 그림 안 글자는 경계 안·겹침 없음, 나머지는 그림 아래 줄', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('pd-go2-view') ? 243 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList.contains('pd-go2-view') ? 368 : 0; } });
    try {
      const fast = JOINTS.map((_, i) => 0.3 + 0.15 * (i % 2 ? 1 : -1));   // 0.1 s 에 ±0.15 = 1.5 rad/s
      step({}, { q: fast, xy: [0.05, 0], yaw: 0.05 });
      const all = [...box.querySelectorAll<HTMLElement>('[data-go2-joint]')];
      expect(all.map((t) => t.dataset.go2Joint).sort()).toEqual([...JOINTS].sort());
      expect(all.every((t) => t.dataset.moving)).toBe(true);
      const inFig = [...box.querySelectorAll<HTMLElement>('.pd-go2-view .pd-tag')].map((t) => ({ x: parseFloat(t.style.left), y: parseFloat(t.style.top), w: parseFloat(t.style.width), h: t.classList.contains('pd-tag-move') ? 16 : 14 }));
      expect(inFig.length).toBeGreaterThan(2);
      for (const b of inFig) { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0); expect(b.x + b.w).toBeLessThanOrEqual(243); expect(b.y + b.h).toBeLessThanOrEqual(368); }
      expect(noOverlap(inFig)).toBe(true);
      const more = box.querySelectorAll('[data-go2-more] [data-go2-joint]');
      expect(inFig.length - 2 + more.length).toBe(12);   // 화살표 글자 2개(움직임·회전) 빼고
      if (more.length) expect($('[data-go2-more]')!.textContent).toMatch(/(앞|뒤) (오른|왼) (엉덩이|허벅지|종아리)/);
    } finally { delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth; delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight; }
  });
  it('RB-GO2-ORBIT 끌면 시점이 바뀌고(관절 자리·선 그림이 따라 움직임) «처음 보기»·두 번 누름이면 돌아온다 · 휠 확대 · 위아래는 한계', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    show(<Go2Figure pose={POSE} temps={JOINTS.map(() => 40)} />);
    const view = $('[data-go2-orbit]')!, dot = () => $('[data-go2-temp="FR_calf_joint"]')!.style.cssText, sk = () => $('[data-go2-leg="RR"] polyline')!.getAttribute('points');
    const fire = (type: string, x: number, y: number, el: Element = view) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })); });
    const home = [dot(), sk()];
    expect(view.dataset.go2Orbit).toBe('home'); expect($('[data-go2-home]')).toBeNull();
    fire('pointerdown', 100, 100); fire('pointermove', 160, 100); fire('pointerup', 160, 100);
    expect(view.dataset.go2Orbit).toBe('moved'); expect([dot(), sk()]).not.toEqual(home);
    fire('pointermove', 260, 100); const after = dot();   // 뗀 뒤 움직임은 무시
    expect(dot()).toBe(after);
    act(() => $('[data-go2-home]')!.click());
    expect(view.dataset.go2Orbit).toBe('home'); expect([dot(), sk()]).toEqual(home);
    // 휠 = 확대(기본 스크롤 막음) · 두 번 누름 = 처음 보기
    const w = new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true });
    act(() => { view.dispatchEvent(w); });
    expect(w.defaultPrevented).toBe(true); expect(dot()).not.toBe(home[0]);
    fire('dblclick', 0, 0); expect(dot()).toBe(home[0]);
    // 위아래로 아주 많이 끌어도 한계에서 멈춤(바닥 밑 안 감) — 더 끌어도 그대로
    fire('pointerdown', 0, 0); fire('pointermove', 0, 5000); const top = dot(); fire('pointermove', 0, 9000); expect(dot()).toBe(top);
    fire('pointermove', 0, -20000); const low = dot(); fire('pointermove', 0, -30000); expect(dot()).toBe(low); fire('pointerup', 0, 0);
  });

  it('RB-GO2-ORBIT 그림·«처음 보기» 를 눌러도 초점을 옮기지 않고(mousedown 기본 막음) 끄는 중 조종 키 입력은 창까지 그대로 간다', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    show(<Go2Figure pose={POSE} />);
    const view = $('[data-go2-orbit]')!, md = (el: Element) => { const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true }); act(() => { el.dispatchEvent(e); }); return e.defaultPrevented; };
    const got: string[] = [], key = (e: KeyboardEvent) => got.push(e.code);
    addEventListener('keydown', key, true);
    try {
      expect(md(view)).toBe(true);
      act(() => { view.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 })); view.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 0 })); });
      act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })); });
      expect(got).toEqual(['KeyW']);
      expect(md($('[data-go2-home]')!)).toBe(true);
    } finally { removeEventListener('keydown', key, true); }
  });

  it('RV-437 1 정면 가까이 돌려 앞·뒤 오른 엉덩이 온도 점이 겹치면 카메라에 가까운 앞(80°C)이 위 — 그리기·마우스 판정 모두(z-index)', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    show(<Go2Figure pose={POSE} temps={JOINTS.map((n) => (n === 'FR_hip_joint' ? 80 : n === 'RR_hip_joint' ? 20 : 40))} />);
    const view = $('[data-go2-orbit]')!, fire = (type: string, x: number, y: number) => act(() => { view.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })); });
    fire('pointerdown', 200, 0); fire('pointermove', 112, -50); fire('pointerup', 112, -50);   // 정면 가까이(az ≈ 1.55)·el ≈ 0.18 — 두 점 1.4 px 차
    const dot = (n: string) => $(`[data-go2-temp="${n}"]`)!, fr = dot('FR_hip_joint'), rr = dot('RR_hip_joint');
    expect(Math.hypot(parseFloat(fr.style.left) - parseFloat(rr.style.left), parseFloat(fr.style.top) - parseFloat(rr.style.top))).toBeLessThan(3);   // 겹침(점 지름 12 px)
    expect(Number(fr.style.zIndex)).toBeGreaterThan(Number(rr.style.zIndex));
    expect(Number(rr.style.zIndex)).toBeGreaterThanOrEqual(2);   // 범례(z 1)·관절 글자(z 1) 위 그대로
    fire('dblclick', 0, 0);   // 처음 보기(오른쪽 앞 위) — 가장 가까운 점은 앞 오른 다리, 가장 먼 점은 뒤 왼 다리
    const zs = JOINTS.map((n) => Number(dot(n).style.zIndex)), by = (z: number) => JOINTS[zs.indexOf(z)];
    expect(new Set(zs).size).toBe(12); expect(by(Math.max(...zs))).toMatch(/^FR_/); expect(by(Math.min(...zs))).toMatch(/^RL_/);
  });

  it('RV-437 2 탭 숨김·칸이 화면 밖이면 부모가 여러 번 갱신해도 그리지 않고, 다시 보이면 최신 자세로 한 번', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    vi.stubGlobal('WebGLRenderingContext', class {});
    let seen: (es: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal('IntersectionObserver', class { constructor(cb: typeof seen) { seen = cb; } observe() {} disconnect() {} });
    const setHidden = (h: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    const at = (k: number): Pose => ({ q: JOINTS.map(() => 0.3 + k * 0.1), wxyz: [1, 0, 0, 0] });
    try {
      show(<Go2Figure pose={at(0)} />); act(() => root!.render(<Go2Figure pose={at(0)} />));   // 보일 때는 갱신마다 그림
      const r0 = gl.renders, s0 = gl.snap;
      expect(r0).toBeGreaterThan(0);
      act(() => seen([{ isIntersecting: false }]));
      for (const k of [1, 2, 3, 4]) act(() => root!.render(<Go2Figure pose={at(k)} />));
      expect(gl.renders).toBe(r0);
      act(() => seen([{ isIntersecting: true }]));
      expect(gl.renders).toBe(r0 + 1);
      const s4 = gl.snap; expect(s4).not.toBe(s0);
      act(() => root!.render(<Go2Figure pose={at(4)} />)); expect(gl.snap).toBe(s4);   // 다시 보일 때 그린 것 = 최신(4번째)
      // 탭 숨김도 같다
      const r1 = gl.renders;
      setHidden(true); act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      for (const k of [5, 6, 7, 8]) act(() => root!.render(<Go2Figure pose={at(k)} />));
      expect(gl.renders).toBe(r1);
      setHidden(false); act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(gl.renders).toBe(r1 + 1);
      const s8 = gl.snap; act(() => root!.render(<Go2Figure pose={at(8)} />)); expect(gl.snap).toBe(s8);
    } finally { delete (document as { hidden?: boolean }).hidden; }
  });
});

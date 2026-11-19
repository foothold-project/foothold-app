// RB-GO2-REAL-RENDER(11-19) Go2 그림: 메시 없으면 상자 그림, 관절 값 12개, 움직임 문턱(정지 = 화살표 없음 · 움직임 = 방향 맞음). 메시 파일 자체는 go2mesh.test.js.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Go2RobotInfo } from '../../../contracts/ts';
import { Go2Figure, JOINTS, resetGo2Cache, spread, useGo2Motion, type Motion, type Pose } from '../go2model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
type Rep = { t: number; xy?: number[] | null; pt?: number; page?: number };
const info = (r: Rep) => {
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 19, 0, 0, 0, ms)).toISOString();
  return { joints: { received_at: at(r.t), age_s: 0, names: JOINTS, positions: POSE!.q },
    quaternion: { received_at: at(r.t), age_s: 0, wxyz: [1, 0, 0, 0] },
    position: r.xy === null ? null : { received_at: at(r.pt ?? r.t), age_s: r.page ?? 0, xyz: [...(r.xy ?? [0, 0]), 0.3], origin: 'BOOT_ORIGIN_UNVERIFIED' } } as unknown as Go2RobotInfo;
};
function Seq({ reps, i }: { reps: Rep[]; i: number }) {
  last = useGo2Motion(info(reps[i]), POSE);
  return <Go2Figure pose={POSE} motion={last} />;
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
});

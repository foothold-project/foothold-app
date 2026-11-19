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
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++)
      expect(b[i].x < b[j].x + b[j].w && b[j].x < b[i].x + b[i].w && b[i].y < b[j].y + b[j].h && b[j].y < b[i].y + b[i].h).toBe(false);
    for (const x of b) { expect(x.x).toBeGreaterThanOrEqual(0); expect(x.x + x.w).toBeLessThanOrEqual(100); }
  });
});

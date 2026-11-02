// 설정 › 시뮬 조작값(11-02 SETTINGS-WEB) — 시뮬 연결만 조직 값으로 좁히고, 실기 limits(simulation false)는 값·동작 변화 0.
import { afterEach, describe, expect, it } from 'vitest';
import type { OrgSettings } from '../../../contracts/ts';
import { DEAD, simTune, tuned, velocity, type Axes } from '../phone';
import { KEY_VX, forward } from '../simdrive';

type W = Parameters<typeof velocity>[1];
// 에이전트 SIMULATION_LIMITS(apps/agent/foothold_agent/phone/protocol.py)·실기 LIMITS 와 같은 모양
const SIM = { vx_mode: 'continuous', vx_min: -0.3, vx_min_moving: 0.2, vx_max: 1.0, vy_min: -0.3, vy_max: 0.3, wz_min: -0.5, wz_max: 0.5, commands: [], experimental: ['reverse', 'lateral', 'turn_in_place'] };
const REAL = { vx_min: 0, vx_max: 0.6, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [[0, 0, 0], [0.6, 0, 0], [0.6, 0, -0.5], [0.6, 0, 0.5]] };
const hello = (simulation: boolean, limits: object) => ({ t: 'hello', simulation, limits }) as unknown as W;
const ORG: Partial<OrgSettings> = { sim_max_vx: 0.5, sim_min_vx: 0.1, sim_max_vy: 0.1, sim_max_wz: 0.25, sim_key_vx: 0.4, stick_deadzone: 0.3 };
const GRID: Axes[] = [];
for (let f = -1; f <= 1.001; f += 0.1) for (const t of [-1, -0.6, -0.2, 0, 0.3, 0.7, 1]) for (const y of [-1, -0.2, 0, 0.4, 1]) GRID.push([f, t, y]);

afterEach(() => simTune(null));

describe('시뮬 연결: 조직 값으로 좁힘', () => {
  it('상한 = min(에이전트, 조직), 최소 이동 = sim_min_vx, 데드존 = stick_deadzone', () => {
    simTune(ORG);
    const w = hello(true, SIM);
    expect(tuned(w).L).toMatchObject({ vx_max: 0.5, vx_min_moving: 0.1, vy_max: 0.1, vy_min: -0.1, wz_max: 0.25, wz_min: -0.25, vx_min: -0.3 });
    expect(velocity([1, 0, 0], w).vx).toBe(0.5);
    expect(velocity([0.29, 0, 0], w).vx).toBe(0);   // 데드존 0.3 안
    expect(velocity([0.31, 0, 0], w).vx).toBeCloseTo(0.1, 1);
    expect(velocity([0, 0, 1], w).vy).toBeCloseTo(0.1, 9);
    expect(velocity([0, 1, 0], w).wz).toBe(0.25);
    for (const a of GRID) {   // 어떤 입력도 조직 상한·에이전트 상한 밖으로 나가지 않음
      const v = velocity(a, w);
      expect(v.vx).toBeLessThanOrEqual(0.5); expect(v.vx).toBeGreaterThanOrEqual(-0.3);
      expect(Math.abs(v.vy)).toBeLessThanOrEqual(0.1 + 1e-12); expect(Math.abs(v.wz)).toBeLessThanOrEqual(0.25);
    }
  });
  it('조직 값이 에이전트보다 커도 넓히지 않음(최종 자르기는 에이전트)', () => {
    simTune({ sim_max_vx: 1, sim_max_vy: 0.3, sim_max_wz: 0.5 });
    const w = hello(true, { ...SIM, vx_max: 0.8, vy_max: 0.2, vy_min: -0.2, wz_max: 0.4, wz_min: -0.4 });
    expect(tuned(w).L).toMatchObject({ vx_max: 0.8, vy_max: 0.2, vy_min: -0.2, wz_max: 0.4, wz_min: -0.4 });
  });
  it('키보드 전진: sim_key_vx 가 끝까지 민 기울기의 속도', () => {
    simTune(ORG);
    const w = hello(true, SIM);
    expect(velocity([forward(w), 0, 0], w).vx).toBeCloseTo(0.4, 9);
    simTune(null);
    expect(velocity([forward(w), 0, 0], w).vx).toBeCloseTo(KEY_VX, 9);   // 값 없으면 기본 0.6
  });
});

describe('실기 연결(simulation false): 조직 값이 있어도 그대로', () => {
  it('velocity·forward·tuned 가 조직 값 없을 때와 같다', () => {
    const w = hello(false, REAL), cont = hello(false, { ...SIM, experimental: [] });
    const before = [w, cont].map((x) => ({ out: GRID.map((a) => velocity(a, x)), key: forward(x), t: tuned(x) }));
    simTune({ ...ORG, sim_max_vx: 0.2, sim_max_wz: 0, stick_deadzone: 0.5, sim_key_vx: 0.1 });
    const after = [w, cont].map((x) => ({ out: GRID.map((a) => velocity(a, x)), key: forward(x), t: tuned(x) }));
    expect(after).toEqual(before);
    expect(tuned(w)).toEqual({ L: REAL, dead: DEAD, key: undefined });
    expect(velocity([1, 1], w)).toEqual({ vx: 0.6, vy: 0, wz: 0.5 });
  });
});

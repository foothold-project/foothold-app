import { afterEach, describe, expect, it } from 'vitest';
import type { OrgSettings, PhoneWelcome } from '../../../contracts/ts';
import { realCaps, simTune, tuned, velocity } from '../phone';
import { permitted, TABLE } from '../serverdrive';
const L = { vx_min: -1.5, vx_max: 1.5, vy_min: -1, vy_max: 1, wz_min: -4, wz_max: 4,
  commands: [], experimental: ['reverse', 'lateral', 'turn_in_place'] };
const welcome = (limits = L) => ({ simulation: false, limits }) as unknown as PhoneWelcome;
afterEach(() => simTune(null));

describe('실기 조직 상한: 로봇 상한과 min, 0은 축 끄기', () => {
  it('앞·뒤·옆·회전 끝과 중간 입력은 각 실효 상한에 비례', () => {
    simTune({ real_max_vx: .8, real_max_vx_back: .4, real_max_vy: .6, real_max_wz: .2 });
    const w = welcome();
    expect(velocity([1, 1, 1], w)).toEqual({ vx: .8, vy: .6, wz: .2 });
    expect(velocity([-1, -1, -1], w)).toEqual({ vx: -.4, vy: -.6, wz: -.2 });
    expect(velocity([.5, .5], w)).toEqual({ vx: .4, vy: 0, wz: .1 });
    expect(velocity([-.5, -.5], w)).toEqual({ vx: -.2, vy: 0, wz: -.1 });
    expect(velocity([0, 0, .55], w).vy).toBeCloseTo(.3);
  });
  it('조직 최대도 현재 에이전트의 후진·옆·회전 상한을 넓히지 않음', () => {
    simTune(realCaps(null));
    const w = welcome({ ...L, vx_min: 0, vy_min: 0, vy_max: 0, wz_min: -.5, wz_max: .5 });
    expect(tuned(w).L).toEqual(w.limits);
    expect(velocity([-1, 1, 1], w)).toEqual({ vx: 0, vy: 0, wz: .5 });
  });
  it('각 축 0은 다른 축에 영향 없이 꺼지고, 모든 축 0에서는 눌러도 0', () => {
    for (const [key, a, axis] of [
      ['real_max_vx', [1, 0, 0], 'vx'], ['real_max_vx_back', [-1, 0, 0], 'vx'],
      ['real_max_vy', [0, 0, 1], 'vy'], ['real_max_wz', [0, 1, 0], 'wz'],
    ] as const) {
      simTune({ [key]: 0 });
      expect(Math.abs(velocity([...a], welcome())[axis])).toBe(0);
    }
    simTune({ real_max_vx: 0, real_max_vx_back: 0, real_max_vy: 0, real_max_wz: 0 });
    expect(velocity([1, 1, 1], welcome())).toEqual({ vx: 0, vy: 0, wz: 0 });
    expect(velocity([1, 1, 1], welcome({ ...L, vx_mode: 'continuous' } as typeof L))).toEqual({ vx: 0, vy: 0, wz: 0 });
  });
  it('잘못된 값은 기본 최대, 시뮬 설정·스위치는 직접 폰 상한을 바꾸지 않음', () => {
    simTune({ real_max_vx: NaN, real_max_vy: -1, real_max_wz: 4.1, real_max_vx_back: 'x' } as unknown as OrgSettings);
    expect(tuned(welcome()).L).toEqual(L);
    simTune({ sim_max_vx: .2, sim_max_wz: 0, real_no_fast_server_drive: true });
    expect(tuned(welcome()).L).toEqual(L);
  });
  it('입력 전체 격자에서 양방향 실효 상한을 넘지 않음', () => {
    simTune({ real_max_vx: .7, real_max_vx_back: .3, real_max_vy: .2, real_max_wz: .1 });
    for (const f of [-1, -.5, 0, .5, 1]) for (const t of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
      const v = velocity([f, t, y], welcome());
      expect(v.vx).toBeGreaterThanOrEqual(-.3); expect(v.vx).toBeLessThanOrEqual(.7);
      expect(Math.abs(v.vy)).toBeLessThanOrEqual(.2); expect(Math.abs(v.wz)).toBeLessThanOrEqual(.1);
    }
  });
});

it('서버 단추: 고정표 경계·0·빠른 이동 금지는 더 엄격한 쪽 적용', () => {
  expect(permitted(TABLE.up, null)).toBe(true);
  expect(permitted(TABLE.left, null)).toBe(true); // SDK 최대 1.0
  expect(permitted(TABLE.right, null)).toBe(true);
  expect(permitted(TABLE.left, { real_max_vy: .99 })).toBe(false);
  expect(permitted(TABLE.up, { real_max_vx: 1.49 })).toBe(false);
  expect(permitted(TABLE.down, { real_max_vx_back: 0 })).toBe(false);
  expect(permitted(TABLE.rotl, { real_max_wz: .5 })).toBe(true);
  expect(permitted(TABLE.rotl, { real_max_wz: .49 })).toBe(false);
  expect(permitted(TABLE.up, { real_no_fast_server_drive: true })).toBe(false);
  expect(permitted(TABLE.rotl, { real_no_fast_server_drive: true })).toBe(true);
  expect(permitted(TABLE[''], { real_max_vx: 0, real_max_vx_back: 0, real_max_vy: 0, real_max_wz: 0, real_no_fast_server_drive: true })).toBe(true);
});

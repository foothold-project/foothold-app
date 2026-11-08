import { afterEach, expect, it } from 'vitest';
import { DEAD, simTune, tuned, velocity } from '../phone';
const real = { simulation: false, limits: { vx_min: 0, vx_max: 1.5, vy_min: 0, vy_max: 0, wz_min: -.5, wz_max: .5, commands: [] } } as unknown as Parameters<typeof tuned>[0];
afterEach(() => simTune(null));
it('accepts browser caps 0.5/1.2 but preserves the final simulation agent envelope', () => {
  simTune({ sim_max_vy: .5, sim_max_wz: 1.2 });
  const large = { ...real, simulation: true, limits: { ...real.limits, vy_min: -.8, vy_max: .8, wz_min: -2, wz_max: 2 } };
  expect(tuned(large).L).toMatchObject({ vy_min: -.5, vy_max: .5, wz_min: -1.2, wz_max: 1.2 });
  simTune({ sim_max_vy: .51, sim_max_wz: 1.21 });
  expect(tuned(large).L).toEqual(large.limits);
  simTune({ sim_max_vy: .4, sim_max_wz: .8 });
  expect(tuned(large).L).toMatchObject({ vy_min: -.4, vy_max: .4, wz_min: -.8, wz_max: .8 });
  const agent = { ...large, limits: { ...large.limits, vy_min: -.3, vy_max: .3, wz_min: -.5, wz_max: .5 } };
  expect(tuned(agent).L).toEqual(agent.limits);
});
it.each([false, undefined])('physical welcome simulation=%s ignores both new defaults and restrictive simulation settings', (simulation) => {
  const welcome = { ...real, simulation } as unknown as Parameters<typeof tuned>[0];
  for (const org of [{ sim_max_vx: 1.5, sim_key_vx: 1.5, sim_max_vy: .5, sim_max_wz: 1.2 },
    { sim_max_vx: .2, sim_key_vx: .1, sim_max_vy: 0, sim_max_wz: 0, stick_deadzone: .5 }]) {
    simTune(org);
    expect(tuned(welcome)).toEqual({ L: real.limits, dead: DEAD, key: undefined });
    expect(tuned(welcome).L).toBe(real.limits);
    expect(velocity([1, 1, 1], welcome)).toEqual({ vx: 1.5, vy: 0, wz: .5 });
    expect(velocity([1, -1, -1], welcome)).toEqual({ vx: 1.5, vy: 0, wz: -.5 });
    expect(velocity([-1, 1, 1], welcome)).toEqual({ vx: 0, vy: 0, wz: 0 });
  }
});

// Pure settings selection: no browser, physics, service, model or robot.
import assert from 'node:assert/strict';
import { POLICY_MODES, getPolicyMode } from '../sim/policy-modes.js';
import { effectiveSettings, simSettings } from '../sim/settings.js';
import { manualSettings, manualCommand } from '../sim/manual-settings.js';
import { createScenarioRunner } from '../sim/scenario.js';

const org = { sim_max_vx: 1.5, sim_min_vx: .2, sim_key_vx: 1.5,
  sim_runner_vx: .4, sim_runner_wz: .6, lidar_view_m: 12,
  model_overrides: {
    'nvidia-demo': { sim_max_vx: .5, sim_key_vx: .3, sim_runner_vx: .2, lidar_view_m: 20 },
    'start-demo': { sim_max_vx: .8, sim_key_vx: .7, sim_runner_vx: .6, sim_runner_wz: .3, lidar_view_m: 5 },
  } };
for (const [id, cap, key, runnerVx, view] of [
  ['nvidia-demo', .5, .3, .2, 20], ['start-demo', .8, .7, .6, 5],
]) {
  const mode = getPolicyMode(id), manual = manualSettings(org, mode.command, mode.id);
  assert.equal(manualCommand([1, 0, 0], manual)[0], cap);
  assert.equal(manualCommand([1, 0, 0], manual, true)[0], key);
  const settings = simSettings(org, { vx: mode.command.caps.forward, wz: mode.command.caps.turnInPlace }, mode.id);
  assert.equal(settings.viewRange, view);
  const sim = { cmd: [0, 0, 0], d: { qpos: [0, 0, .4, 1, 0, 0, 0] } };
  const runner = createScenarioRunner(sim, () => false, settings);
  runner.start([{ x: 10, y: 0 }]);
  assert.equal(runner.tick()[0], runnerVx);
}
assert.equal(simSettings(org, {}, 'ame2-demo').viewRange, 12);
assert.deepEqual(effectiveSettings(org, 'go2-flat'), org);
assert.deepEqual(effectiveSettings(org, 'foothold-v2'), effectiveSettings(org, 'nvidia-demo'));
const capped = simSettings(org, { vx: .1, wz: .1 }, 'start-demo');
assert.deepEqual(capped.caps, { vx: .1, wz: .1 });
const manual = manualSettings(org, { caps: { forward: .1, reverse: .1, lateral: .1, turnInPlace: .1, turnWalking: .1 } }, 'start-demo');
assert.equal(manualCommand([1, 0, 0], manual)[0], .1);
// GO2 remains display-only with zero command capabilities.
assert.equal(POLICY_MODES.go2.command.kind, 'none');
assert.ok(Object.values(POLICY_MODES.go2.command.caps).every((n) => n === 0));
console.log('model settings PASS: mode switches, sparse inheritance, aliases, manual/key/runner/lidar, caps, real replay unchanged');

// Per-mode runner defaults never replace explicit organization/model settings.
const startMode = POLICY_MODES.start;
const startCaps = { vx: startMode.command.caps.forward, wz: startMode.command.caps.turnInPlace, runnerVx: startMode.command.runnerVx };
for (const [organization, patrolVx, goalVx] of [
  [{}, .4, 1.2],
  [{ sim_runner_vx: .4 }, .4, .4],
  [{ sim_runner_vx: .7 }, .7, .7],
  [{ sim_runner_vx: .4, model_overrides: { 'start-demo': { sim_runner_vx: 1.2 } } }, 1.2, 1.2],
]) {
  const limits = simSettings(organization, startCaps, startMode.id);
  assert.equal(limits.vx, patrolVx); assert.equal(limits.goalVx, goalVx);
  const sim = { adapterId: startMode.id, cmd: [0, 0, 0], d: { qpos: [0, 0, .4, 1, 0, 0, 0] } };
  const runner = createScenarioRunner(sim, () => false, limits);
  runner.start([{ x: 10, y: 0 }]); assert.equal(runner.tick()[0], patrolVx);
  runner.cancel(); runner.start([{ x: 10, y: 0 }], true); assert.equal(runner.tick()[0], goalVx);
}
assert.equal(simSettings({}, {}, 'nvidia-demo').vx, .4);
assert.equal(simSettings({}, {}, 'ame2-demo').vx, .4);
console.log('start runner default PASS: patrol .4, clicked goal 1.2, explicit organization and model override win for both');

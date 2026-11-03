// Policy-boundary observations without weights, ROS, services, or a robot.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POLICY_ADAPTERS } from '../sim/policy-adapters.js';
import { ame2Joystick } from '../sim/ame2-adapter.js';
import { manualSettings, manualAxis, manualCommand, commandCaps, MODE_COMMAND_CAPS, modeCapText } from '../sim/manual-settings.js';
import { simSettings, loadSimSettings } from '../sim/settings.js';
const properties = JSON.parse(readFileSync(new URL('../../apps/contracts/schema/OrgSettings.json', import.meta.url))).properties;
const defaults = Object.fromEntries(Object.entries(properties).filter(([, s]) => 'default' in s).map(([k, s]) => [k, s.default]));
assert.equal(defaults.sim_max_vx, 1.5); assert.equal(defaults.sim_key_vx, 1.5);
assert.equal(defaults.sim_max_vy, .5); assert.equal(defaults.sim_max_wz, 1.2);
const web = await loadSimSettings(new URL('https://example.invalid/sim/?from=web'), async () => ({ ok: true, json: async () => defaults }));
const nvidia = POLICY_ADAPTERS['nvidia-demo'], ame2 = POLICY_ADAPTERS['ame2-demo'];
const start = POLICY_ADAPTERS['start-demo'].command;
function observe(adapter, cmd) {
  const obs = new Float32Array(adapter.observations.size);
  adapter.observe({ cmd, observation: obs, lastAction: new Float32Array(12), heightScanner: () => {}, linB: [0, 0, 0], angB: [0, 0, 0], grav: [0, 0, -1],
    d: { qpos: new Float64Array(19), qvel: new Float64Array(18) }, M2I: Array.from({ length: 12 }, (_, i) => i), mapping: new Float32Array(1131) }, cmd, {});
  return obs;
}
for (const org of [{}, web]) for (const keyboard of [false, true]) {
  const n = manualSettings(org, nvidia.command), a = manualSettings(org, ame2.command), s = manualSettings(org, start);
  assert.deepEqual(commandCaps(nvidia.command), MODE_COMMAND_CAPS.nvidia);
  for (const [raw, expected] of [[[1, 0, 0], [1.5, 0, 0]], [[-1, 0, 0], [-1.5, 0, 0]],
    [[0, 1, 0], [0, .5, 0]], [[0, -1, 0], [0, -.5, 0]], [[0, 0, 1], [0, 0, 1]], [[0, 0, -1], [0, 0, -1]]]) {
    const cmd = manualCommand(raw, n, keyboard);
    assert.deepEqual(cmd, expected);
    assert.deepEqual(Array.from(observe(nvidia, cmd).slice(9, 12)), expected);
  }
  assert.equal(nvidia.command.inRange([-1.5, 0, 0]), false, 'NVIDIA reverse retained, untrained');
  assert.equal(nvidia.command.inRange([0, .5, 0]), false, 'NVIDIA lateral retained, untrained');
  assert.equal(manualAxis(-1, 0, s, keyboard), -1);
  assert.deepEqual(manualCommand([0, 0, 1], s, keyboard), [0, 0, 1.2]);
  assert.deepEqual(manualCommand([1, 0, 1], s, keyboard), [1.5, 0, 1]);
  assert.deepEqual(manualCommand([0, 1, -1], s, keyboard), [0, .5, -1]);
  for (const side of [-1, 1]) {
    const cmd = ame2Joystick(null, 0, manualCommand([0, side, 0], a, keyboard)).command;
    assert.equal(observe(ame2, cmd)[46], side, 'actual AME-2 prop[46] reaches ±1');
  }
}
const reduced = { sim_max_vx: .3, sim_key_vx: .2, sim_max_vy: 0, sim_max_wz: 0, stick_deadzone: .2 };
assert.deepEqual(manualCommand([1, 1, 1], manualSettings(reduced, ame2.command), true), [1, 1, 1]);
assert.deepEqual(manualCommand([1, 1, 1], manualSettings(reduced, start)), [.3, 0, 0]);
assert.deepEqual(manualCommand([1, 1, 1], manualSettings(reduced, start), true), [.2, 0, 0]);
assert.equal(manualCommand([.1, 0, 1], manualSettings({ stick_deadzone: .2 }, start))[2], 1.2, 'deadzone translation remains in-place');
assert.equal(simSettings(web, { vx: 1.5, wz: 1.2 }).caps.wz, 1.2, '1.2 mode cap is not reset to 0.6');
assert.equal(simSettings({ sim_runner_wz: 1.2 }, { vx: 1.5, wz: 1.2 }).wz, 1.2, 'start runner turn 1.2 survives validation');
assert.equal(simSettings({ sim_max_wz: .7 }, { vx: 1.5, wz: 1.2 }).caps.wz, .7);
assert.match(modeCapText(start), /뒤1 .*회전1.2\/이동1/);
assert.match(modeCapText(ame2.command), /목표 2 m.*1.2 m\/s/);
const chosen = { sim_max_vx: 1, sim_max_vy: .3, sim_max_wz: .5, sim_key_vx: .6 };
assert.match(modeCapText(nvidia.command, manualSettings(chosen, nvidia.command)),
  /적용 상한.*앞1 뒤1 옆0.3.*회전0.5\/이동0.5.*키0.6/);
assert.match(modeCapText(start, manualSettings(reduced, start)), /앞0.3 뒤0.3 옆0.*회전0\/이동0.*키0.2/);
assert.equal(modeCapText(ame2.command, manualSettings(chosen, ame2.command)), modeCapText(ame2.command), 'goal HUD ignores body speed caps too');
console.log('PASS nvidia obs[9:12]: +1.5 / -1.5 / ±0.5 / ±1; ame2 prop[46]: ±1; offline+web defaults, stick+keys; prepared start: +1.5 / -1 / ±0.5 / ±1.2 (walking ±1)');

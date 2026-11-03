import assert from 'node:assert/strict';
import { manualSettings, manualAxis } from '../sim/manual-settings.js';
const scale = [1, .5, 1], defaults = manualSettings({}, scale);
assert.deepEqual(defaults, { caps: scale, key: 1, dead: 0 });
const configured = manualSettings({ sim_max_vx: .5, sim_max_vy: .2, sim_max_wz: .3, sim_key_vx: .4, stick_deadzone: .2 }, scale);
assert.equal(manualAxis(1, 0, configured, true), .4);
assert.equal(manualAxis(-1, 0, configured), -.5);
assert.equal(manualAxis(.2, 0, configured), 0);
assert.ok(Math.abs(manualAxis(.6, 0, configured) - .25) < 1e-12);
assert.equal(manualAxis(1, 1, configured), .2);
assert.equal(manualAxis(1, 2, configured), .3);
assert.equal(manualSettings({ sim_max_vx: .2, sim_key_vx: .5 }, scale).key, .2, 'cross-field invalid key falls back to cap');
assert.equal(manualSettings({ sim_max_vx: .7, sim_key_vx: .5 }, [.3, .5, 1]).key, .3, 'adapter cap');
for (const bad of [null, '0.2', true, NaN, Infinity, -1, 10]) {
  assert.deepEqual(manualSettings(Object.fromEntries(['sim_max_vx', 'sim_max_vy', 'sim_max_wz', 'sim_key_vx', 'stick_deadzone'].map((k) => [k, bad])), scale), defaults);
}
console.log('manual settings PASS: #241 per-field/cross-field validation, organization/adapter caps, key speed, stick deadzone, defaults');

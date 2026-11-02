// Real MuJoCo fall guards; no policy weights, browser, port, server or robot.
// FH_SIM_SRC=<deps> node mobile/scripts/support-fall-selftest.mjs
// FH_SIM_MODULE=<prior sim.js> gathers all negative controls before failing.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../sim/sim.js';

const src = process.env.FH_SIM_SRC;
assert.ok(src, 'FH_SIM_SRC required (existing local files)');
const code = process.env.FH_SIM_MODULE ? await import(pathToFileURL(resolve(process.env.FH_SIM_MODULE))) : current;
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
const plane = (z) => `<geom group="1" type="plane" pos="0 0 ${z}" size="3 3 .1"/>`;
const box = (x, y, z, sx, sy, sz) => `<geom group="1" type="box" pos="${x} ${y} ${z}" size="${sx} ${sy} ${sz}"/>`;
const gap = plane(-1) + box(-1.075, 0, -.1, .925, 3, .1) + box(1.075, 0, -.1, .925, 3, .1);
const gapYaw = plane(-1) + box(0, -1.075, -.1, 3, .925, .1) + box(0, 1.075, -.1, 3, .925, .1);
const ledge = plane(-2) + box(-1, 0, -.1, 1, 3, .1);
const shallowGap = (depth) => plane(-depth) + box(-1.075, 0, -.1, .925, 3, .1) + box(1.075, 0, -.1, .925, 3, .1);
const shallowGapYaw = (depth) => plane(-depth) + box(0, -1.075, -.1, 3, .925, .1) + box(0, 1.075, -.1, 3, .925, .1);
const shallowLedge = plane(-.4) + box(-1, 0, -.1, 1, 3, .1);
const results = [];
for (const id of ['foothold-v2', 'ame2-demo']) {
  for (const [name, geoms, x, y, yaw, hold] of [
    ['slumped-over-0.3m-gap', gap, 0, 0, 0, 0],
    ['slumped-over-gap-yaw90', gapYaw, 0, 0, Math.PI / 2, 0],
    ['slumped-over-gap-depth-0.18m', shallowGap(.18), 0, 0, 0, 0],
    ['slumped-over-gap-depth-0.3m', shallowGap(.3), 0, 0, 0, 0],
    ['slumped-over-gap-depth-0.45m', shallowGap(.45), 0, 0, 0, 0],
    ['slumped-over-gap-depth-0.5m', shallowGap(.5), 0, 0, 0, 0],
    ['slumped-over-shallow-gap-yaw90', shallowGapYaw(.3), 0, 0, Math.PI / 2, 0],
    ['slumped-just-outside-0.4m-ledge', shallowLedge, .05, 0, 0, 0],
    ['slumped-just-outside-0.4m-ledge-yaw180', shallowLedge, .05, 0, Math.PI, 0],
    ['slumped-just-outside-2m-ledge', ledge, .05, 0, 0, 0],
    ['slumped-beyond-footprint-2m-ledge', ledge, .5, 0, 0, 0],
    ['freefall-to-5m-lower-floor', plane(-5), 0, 0, 0, .3],
  ]) {
    mj.FS.writeFile('/go2/world.xml', `<mujoco><worldbody>${geoms}</worldbody></mujoco>`);
    const sim = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, () => new Float32Array(12), { floorZ: 0, spawn: [x, y, yaw] }, id);
    try {
      if (!hold) { sim.d.qpos[2] = .1; mj.mj_forward(sim.m, sim.d); }
      sim.hold(hold);
      const row = { policy: id, test: name, fell: sim.fell, clearance: sim.z, xyz: Array.from(sim.d.qpos.slice(0, 3)), vz: sim.d.qvel[2], grav: sim.grav[2] };
      assert.ok(sim.d.qpos.every(Number.isFinite));
      if (hold) { assert.ok(row.xyz[2] < .18 && row.vz < -2 && row.grav < -.9, 'actual upright freefall, not a tipped pose'); }
      results.push(row); console.log(JSON.stringify(row));
      if (sim.fell) {
        sim.d.qpos[2] = 3; mj.mj_forward(sim.m, sim.d); sim.hold(0);
        assert.equal(sim.fell, true, `${name}: fall remains latched`);
      }
    } finally { sim.dispose(); }
  }
  // Retaining the edge datum must neither stop an upright bridging pose nor
  // prevent a real descent once the entire trunk footprint clears the edge.
  mj.FS.writeFile('/go2/world.xml', `<mujoco><worldbody>${shallowLedge}</worldbody></mujoco>`);
  const descent = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, () => new Float32Array(12), { floorZ: 0, spawn: [.05, 0, 0] }, id);
  try {
    assert.equal(descent.fell, false, `${id}: upright over shallow ledge`);
    assert.ok(Math.abs(descent.z - .4) < 1e-9, `${id}: upper edge remains support`);
    descent.d.qpos[0] = .5; descent.d.qpos[2] = 0;
    mj.mj_forward(descent.m, descent.d); descent.hold(0);
    assert.equal(descent.fell, false, `${id}: entire footprint on lower floor`);
    assert.ok(Math.abs(descent.z - .4) < 1e-9, `${id}: adopts lower floor after clearing edge`);
    descent.d.qpos[2] = -.3; mj.mj_forward(descent.m, descent.d); descent.hold(0);
    assert.equal(descent.fell, true, `${id}: slump on lower floor still stops`);
  } finally { descent.dispose(); }
  mj.FS.writeFile('/go2/world.xml', `<mujoco><worldbody>${shallowGap(.3)}</worldbody></mujoco>`);
  const bridge = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, () => new Float32Array(12), { floorZ: 0, spawn: [0, 0, 0] }, id);
  try {
    assert.equal(bridge.fell, false, `${id}: upright over shallow gap`);
    assert.ok(Math.abs(bridge.z - .4) < 1e-9, `${id}: both gap edges provide support`);
  } finally { bridge.dispose(); }
  // A valid lower floor must remain the fallback after stepping into a void;
  // reset must discard a previous raised support, and restore the reset datum.
  mj.FS.writeFile('/go2/world.xml', `<mujoco><worldbody>${box(0, 0, -.7, 1, 1, .1)}</worldbody></mujoco>`);
  const sim = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, () => new Float32Array(12), { floorZ: -.6, spawn: [0, 0, 0] }, id);
  try {
    assert.equal(sim.fell, false);
    sim.d.qpos[0] = 3; sim.d.qpos[2] = -.45; mj.mj_forward(sim.m, sim.d); sim.hold(0);
    assert.equal(sim.fell, true, `${id}: void retains last valid lower datum`);
    sim.reset(); assert.equal(sim.fell, false); assert.ok(Math.abs(sim.z - .4) < 1e-9);
  } finally { sim.dispose(); }
  mj.FS.writeFile('/go2/world.xml', `<mujoco><worldbody>${plane(0)}${box(4, 0, 1.9, 1, 1, .1)}</worldbody></mujoco>`);
  const raised = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, () => new Float32Array(12), { floorZ: 0, spawn: [0, 0, 0] }, id);
  try {
    raised.d.qpos[0] = 4; raised.d.qpos[2] = 2.4; mj.mj_forward(raised.m, raised.d); raised.hold(0);
    assert.equal(raised.fell, false);
    raised.reset(); assert.equal(raised.fell, false); assert.ok(Math.abs(raised.z - .4) < 1e-9);
  } finally { raised.dispose(); }
}
assert.ok(results.every((r) => r.fell), 'gap/ledge/freefall must all latch a fall for both adapters');
console.log('support fall PASS: shallow/deep gaps and ledges, upright bridge/descent, retained datum beyond ledge, 5m freefall, yaw, latch and reset; both adapters');

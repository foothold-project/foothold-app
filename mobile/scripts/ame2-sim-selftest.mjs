// Existing local assets only; no browser/server/robot. No gait success assertion.
// FH_SIM_SRC=<assets> AME2_EXPORT=<export> node mobile/scripts/ame2-sim-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPolicyAdapter } from '../sim/policy-adapters.js';
import { ame2Joystick, ame2Torque } from '../sim/ame2-adapter.js';
import { createSim, ISAAC_LIKE, MJ_J } from '../sim/sim.js';

const adapter = getPolicyAdapter('ame2-demo'), src = process.env.FH_SIM_SRC;
assert.ok(src && process.env.AME2_EXPORT, 'FH_SIM_SRC and AME2_EXPORT required');
assert.deepEqual(ame2Joystick(1, .8, [0, 0, 0]), { heading: null, command: [0, 0, 0, 1] });
const goal = ame2Joystick(null, 1.5, [1, 1, 1]);
assert.ok(Math.abs(Math.hypot(...goal.command.slice(0, 2)) - 1) < 1e-12);
assert.ok(Math.abs(Math.atan2(goal.command[2], goal.command[3]) - .02) < 1e-12);
assert.ok(Math.abs(Math.atan2(...ame2Joystick(99, 0, [1, 0, 0]).command.slice(2))) <= Math.PI / 3);
// 시뮬 잠금 풀기(10-31): 후진 목표도 자르지 않고 보낸다 — 앞쪽 가정 밖이라 inRange false(테두리 색 알림만), 옆·제자리 회전은 범위 안
const back = ame2Joystick(null, 0, [-1, 0, 0]);
assert.deepEqual(back.command, [-1, 0, 0, 1]); assert.equal(adapter.command.inRange(back.command), false);
assert.equal(adapter.command.inRange(goal.command), true);
assert.equal(adapter.command.inRange(ame2Joystick(null, 0, [0, -1, 0]).command), true);
assert.ok(ame2Joystick(null, 0, [0, 0, 1]).heading > 0, 'turn in place = heading target');
assert.equal(ame2Torque(100, 1, 0), 20.2);
assert.equal(ame2Torque(-100, 1, 0), -23.4);
assert.equal(ame2Torque(100, 30, 0), 0);
assert.ok(Math.abs(ame2Torque(100, 1, 8) - 38.72738853503185) < 1e-12);
assert.ok(Math.abs(ame2Torque(100, 21.75, 0) - 10.1) < 1e-12);

const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
let maxHeightError = 0;
function terrainTest(name, geoms, expected, q = [0, 0, .4, 1, 0, 0, 0]) {
  mj.FS.writeFile('/height.xml', `<mujoco><compiler angle="radian"/><worldbody>${geoms}
    <geom type="box" group="1" size="3 3 .1" pos="0 0 10"/>
    <geom type="box" group="1" contype="0" conaffinity="0" size="3 3 .1" pos="0 0 .7"/>
    <body pos="0 0 1"><freejoint/><geom type="sphere" group="1" size=".5"/></body></worldbody></mujoco>`);
  const m = mj.MjModel.from_xml_path('/height.xml'), d = new mj.MjData(m);
  mj.mj_forward(m, d);
  const groups = Array.from(m.geom_group), scan = adapter.makeHeightScanner(mj, m, d, { floorZ: 0 });
  try {
    const out = new Float32Array(1131); scan(q, out);
    const yaw = adapter.yawOf(q), c = Math.cos(yaw), s = Math.sin(yaw);
    for (let i = 0; i < 377; i++) {
      const [x, y] = adapter.observations.height.grid[i];
      assert.ok(Math.abs(out[3 * i] - x) < 1e-6 && Math.abs(out[3 * i + 1] - y) < 1e-6, `${name} xyz order`);
      const z = Math.max(-1.5, Math.min(1.5, expected(q[0] + c * x - s * y, q[1] + s * x + c * y) - q[2] + .27));
      const error = Math.abs(out[3 * i + 2] - z);
      assert.ok(error <= .001, `${name}/${i}: ${out[3 * i + 2]} vs ${z}`);
      maxHeightError = Math.max(maxHeightError, error);
    }
    assert.deepEqual(Array.from(m.geom_group), groups);
  } finally { scan.dispose(); d.delete(); m.delete(); }
}
const floor = '<geom type="plane" group="4" size="3 3 .01"/>';
terrainTest('flat', floor, () => 0);
terrainTest('slope', '<geom type="plane" group="4" size="3 3 .01" euler="0 -.15 0"/>', (x) => Math.tan(.15) * x);
const steps = floor + '<geom type="box" group="1" size=".45 3 .1" pos=".75 0 .1"/>';
terrainTest('step', steps, (x) => x >= .3 && x <= 1.2 ? .2 : 0);
terrainTest('yaw90', steps, (x) => x >= .3 && x <= 1.2 ? .2 : 0, [0, 0, .4, Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
terrainTest('yaw with roll/pitch', floor, () => 0, [0, 0, .4, .8, .2, .4, .4].map((v, i) => i < 3 ? v : v / Math.sqrt(.8 ** 2 + .2 ** 2 + .4 ** 2 + .4 ** 2)));
terrainTest('all void', '', () => -.7);
terrainTest('partial void', '<geom type="box" group="4" size=".3 3 .01" pos="-.3 0 -.01"/>', (x) => x <= 0 ? 0 : -.7);
terrainTest('clip', floor, () => 0, [0, 0, 3, 1, 0, 0, 0]);
console.log(`AME-2 height PASS: max error=${maxHeightError}m, flat/slope/step/yaw/roll-pitch/void/clip/geometry exclusion`);

mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
mj.FS.writeFile('/go2/flat.xml', '<mujoco><include file="go2.xml"/><worldbody><geom type="plane" group="1" size="10 10 .01"/></worldbody></mujoco>');
const bytes = readFileSync(join(process.env.AME2_EXPORT, 'ame2_actor.f32'));
const policy = adapter.loadPolicy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), JSON.parse(readFileSync(join(process.env.AME2_EXPORT, 'ame2_actor.json'))));
let previousObs, previousMap;
const sim = createSim(mj, '/go2/flat.xml', ISAAC_LIKE, (obs, map) => { previousObs = obs.slice(); previousMap = map.slice(); return policy(obs, map); }, { floorZ: 0, spawn: [0, 0, 0] }, adapter.id);
try {
  assert.deepEqual(sim.M2I, adapter.action.joints.map((n) => MJ_J.indexOf(n)));
  for (let i = 0; i < 150; i++) {
    sim.cmd = i < 75 ? [1, 0, 0, 1] : [0, 0, 0, 1]; sim.step();
    assert.ok(sim.d.qpos.every(Number.isFinite) && sim.d.qvel.every(Number.isFinite) && sim.d.ctrl.every(Number.isFinite));
  }
  assert.ok(Math.abs(sim.t - 3) < 1e-12);
  sim.clearPolicyState(); sim.step();
  assert.deepEqual(Array.from(previousObs.slice(33, 45)), Array(12).fill(0));
  assert.deepEqual(Array.from(previousObs.slice(45)), [0, 0, 0, 1]);
  assert.equal(previousMap.length, 1131);
  sim.reset(); sim.step();
  assert.deepEqual(Array.from(previousObs.slice(33, 45)), Array(12).fill(0));
  console.log('AME-2 sim PASS: 3s/150 steps finite, clear/reset discard action and target; no gait verdict');
} finally { sim.dispose(); }

// Observation contract with distinct values catches ordering and history clipping.
const obs = new Float32Array(49), state = { d: { qpos: Float64Array.from([0, 0, 0, 1, 0, 0, 0, ...MJ_J.map((n) => adapter.action.defaultPose[adapter.action.joints.indexOf(n)] + .125)]), qvel: Float64Array.from([...Array(6).fill(0), ...MJ_J.map((_, i) => i + 1)]) }, M2I: adapter.action.joints.map((n) => MJ_J.indexOf(n)), linB: [1, 2, 3], angB: [4, 5, 6], grav: [0, 0, -1], cmd: [1, 0, 0, 1], mapping: new Float32Array(1131) };
adapter.observe(obs, state, Float32Array.from([-100, 100, ...Array(10).fill(2)]), () => {});
assert.deepEqual(Array.from(obs.slice(0, 9)), [1, 2, 3, 4, 5, 6, 0, 0, -1]);
assert.ok(obs.slice(9, 21).every((v) => v === .125));
assert.deepEqual(Array.from(obs.slice(21, 33)), state.M2I.map((i) => i + 1));
assert.deepEqual(Array.from(obs.slice(33, 35)), [-50, 50]);
console.log('AME-2 observation/motor/joystick PASS');

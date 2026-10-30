// Local MuJoCo/policies only; no listening port, browser, server or robot.
// FH_SIM_SRC=<deps> AME2_EXPORT=<export> node mobile/scripts/factory-outside-selftest.mjs
// FH_SIM_MODULE=<baseline sim.js> proves the roundtrip assertion fails before the fix.
// FH_FACTORY_XML=<old factory-zone-f1.xml> also exercises the legacy scene.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../sim/sim.js';
import { getPolicyAdapter, makeTerrainSampler } from '../sim/policy-adapters.js';
import { ame2Joystick } from '../sim/ame2-adapter.js';
import { makeLidar } from '../sim/lidar.js';

const src = process.env.FH_SIM_SRC, ame = process.env.AME2_EXPORT;
assert.ok(src && ame, 'FH_SIM_SRC and AME2_EXPORT required (existing local files)');
const code = process.env.FH_SIM_MODULE ? await import(pathToFileURL(resolve(process.env.FH_SIM_MODULE))) : current;
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
const policies = new Map();
for (const id of ['foothold-v2', 'ame2-demo']) {
  const adapter = getPolicyAdapter(id), root = id === 'foothold-v2' ? src : ame;
  const b = readFileSync(join(root, adapter.network.file));
  policies.set(id, adapter.loadPolicy(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), adapter.network.manifest ? JSON.parse(readFileSync(join(root, adapter.network.manifest))) : undefined));
}
function world(id) {
  const dir = new URL(`../sim/assets/${id}/`, import.meta.url), map = JSON.parse(readFileSync(new URL('map.json', dir)));
  for (const f of map.physics_assets ?? []) { const b = readFileSync(new URL(f, dir)); mj.FS.writeFile(`/go2/${f}`, b); mj.FS.writeFile(`/go2/assets/${f}`, b); }
  mj.FS.writeFile('/go2/world.xml', readFileSync(id === 'factory-zone' && process.env.FH_FACTORY_XML ? process.env.FH_FACTORY_XML : new URL(`${id}.xml`, dir)));
  return map;
}
const yaw = (q) => Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] ** 2 + q[6] ** 2));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (a, limit) => Math.max(-limit, Math.min(limit, a));

world('factory-zone');
for (const id of policies.keys()) {
  const sim = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, policies.get(id), { floorZ: 0, spawn: [19, -1.3, -Math.PI / 2] }, id);
  const adapter = getPolicyAdapter(id), scan = adapter.makeHeightScanner(mj, sim.m, sim.d, { floorZ: 0 });
  const obs = new Float32Array(id === 'foothold-v2' ? 235 : 1131), lidar = makeLidar(mj, sim.m, sim.d, 360);
  let heading = null, target = 0, minClearance = Infinity, worstGravity = -1, minBase = Infinity;
  const arrivals = [], targets = [[19, -8], [19, -1.3]];
  try {
    sim.hold(.5);
    for (let i = 0; i < 4000 && target < targets.length && !sim.fell; i++) {
      const q = sim.d.qpos, [x, y] = targets[target], angle = wrap(Math.atan2(y - q[1], x - q[0]) - yaw(q));
      const axes = [Math.abs(angle) < .3 ? .6 : 0, 0, clamp(angle * 2, .8)];
      if (id === 'ame2-demo') { const goal = ame2Joystick(heading, yaw(q), axes); heading = goal.heading; sim.cmd = goal.command; }
      else sim.cmd = axes;
      sim.step();
      assert.ok(sim.d.qpos.every(Number.isFinite) && sim.d.qvel.every(Number.isFinite));
      minClearance = Math.min(minClearance, sim.z); minBase = Math.min(minBase, q[2]); worstGravity = Math.max(worstGravity, sim.grav[2]);
      if (i % 25 === 0) {
        scan(q, obs, id === 'foothold-v2' ? 48 : 0);
        assert.ok(obs.every(Number.isFinite), `${id}: finite height observations`);
        assert.ok(Array.from(lidar(q[0], q[1], q[2] + .1, yaw(q))).every((v) => v === Infinity || Number.isFinite(v) && v >= 0), `${id}: valid lidar`);
      }
      if (Math.hypot(x - q[0], y - q[1]) < .22) { arrivals.push({ target: target++, t: +sim.t.toFixed(2), xyz: Array.from(q.slice(0, 3)) }); heading = null; }
    }
    const result = { test: 'factory-ramp-roundtrip', policy: id, fell: sim.fell, seconds: +sim.t.toFixed(2), minBase, minClearance, worstGravity, arrivals, end: Array.from(sim.d.qpos.slice(0, 3)) };
    console.log(JSON.stringify(result));
    assert.equal(sim.fell, false, `${id}: normal ramp descent must not latch a fall`);
    assert.equal(target, targets.length, `${id}: outside and back through the same ramp`);
    assert.ok(minBase < -.2, `${id}: actually reached lower outdoor ground`);
    assert.ok(sim.d.qpos[2] > .25, `${id}: returned to indoor datum`);
  } finally { scan.dispose(); sim.dispose(); }
}

// A lowered/raised support changes the datum, never the 18cm / 60° limits.
// Include void, overhead slab, robot exclusion, contact-free proxy and latched fall.
for (const id of policies.keys()) for (const [label, geoms, z, roll, expected, floorZ = 0] of [
  ['lower-flat', '<geom group="1" type="plane" pos="0 0 -.6" size="2 2 .1"/>', -.2, 0, false, -.6],
  ['upper-flat', '<geom group="1" type="box" pos="0 0 1.9" size="2 2 .1"/>', 2.4, 0, false],
  ['low-body', '<geom group="1" type="plane" pos="0 0 -.6" size="2 2 .1"/>', -.43, 0, true, -.6],
  ['tipped', '<geom group="1" type="plane" pos="0 0 -.6" size="2 2 .1"/>', -.2, 1.1, true, -.6],
  ['void', '', .17, 0, true],
  ['overhead-and-proxy', '<geom group="1" type="plane" size="2 2 .1"/><geom group="1" type="box" size="2 2 .1" pos="0 0 2"/><geom group="1" type="box" contype="0" conaffinity="0" size="2 2 .05" pos="0 0 .3"/>', .4, 0, false],
]) {
  mj.FS.writeFile('/go2/world.xml', `<mujoco><worldbody>${geoms}</worldbody></mujoco>`);
  const sim = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, policies.get(id), { floorZ, spawn: [0, 0, 0] }, id);
  try {
    sim.d.qpos[2] = z; sim.d.qpos[3] = Math.cos(roll / 2); sim.d.qpos[4] = Math.sin(roll / 2); sim.d.qpos[5] = sim.d.qpos[6] = 0;
    mj.mj_forward(sim.m, sim.d); sim.hold(0);
    assert.equal(sim.fell, expected, `${id}/${label}`);
    if (expected) { sim.d.qpos[2] = 3; mj.mj_forward(sim.m, sim.d); sim.hold(0); assert.equal(sim.fell, true, `${id}: fall stays latched`); }
  } finally { sim.dispose(); }
}
console.log('factory outside PASS: both joystick contracts, actual ramp roundtrip, finite scans/lidar, unchanged fall thresholds and latch, conservative void');

// Survey map edges separately from the factory's lowered-ground false positive.
// Record actual support separately: a map image boundary alone is not a fall.
// Future asset extensions may supply ground here without changing this test.
for (const [id, spawn] of [['warehouse', [8, 0, 0]], ['element-course', [35, 0, 0]], ['collapsed-house-v2', [0, 14, 0]]]) {
  const map = world(id), sim = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, policies.get('foothold-v2'), { floorZ: map.floor_z, spawn });
  const sample = makeTerrainSampler(mj, sim.m, sim.d, { grid: [[0, 0]], rayOffset: 0 }), support = new Float64Array(1);
  try {
    sample(sim.d.qpos, support);
    sim.hold(.5);
    for (let i = 0; i < 100 && !sim.fell; i++) { sim.cmd = [.6, 0, 0]; sim.step(); }
    console.log(JSON.stringify({ test: 'finite-asset-edge-survey', map: id, support: support[0], xyz: Array.from(sim.d.qpos.slice(0, 3)), fell: sim.fell, clearance: sim.z }));
    assert.ok(sim.d.qpos.every(Number.isFinite), `${id}: finite state outside map`);
    if (!Number.isFinite(support[0])) assert.equal(sim.fell, true, `${id}: actual void must remain guarded`);
  } finally { sample.dispose(); sim.dispose(); }
}

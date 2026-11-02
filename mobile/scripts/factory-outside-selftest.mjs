// Local MuJoCo/policies only; no listening port, browser, server or robot.
// FH_SIM_SRC=<deps> AME2_EXPORT=<export> node mobile/scripts/factory-outside-selftest.mjs
// FH_SIM_MODULE optionally selects a baseline sim.js for measurements.
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
  let heading = null, target = 0, worstGravity = -1, minBase = Infinity;
  const arrivals = [], targets = [[19, -8], [19, -1.3]];
  try {
    sim.hold(.5);
    for (let i = 0; i < 4000 && target < targets.length; i++) {
      const q = sim.d.qpos, [x, y] = targets[target], angle = wrap(Math.atan2(y - q[1], x - q[0]) - yaw(q));
      const axes = [Math.abs(angle) < .3 ? .6 : 0, 0, clamp(angle * 2, .8)];
      if (id === 'ame2-demo') { const goal = ame2Joystick(heading, yaw(q), axes); heading = goal.heading; sim.cmd = goal.command; }
      else sim.cmd = axes;
      sim.step();
      assert.ok(sim.d.qpos.every(Number.isFinite) && sim.d.qvel.every(Number.isFinite));
      minBase = Math.min(minBase, q[2]); worstGravity = Math.max(worstGravity, sim.grav[2]);
      if (i % 25 === 0) {
        scan(q, obs, id === 'foothold-v2' ? 48 : 0);
        assert.ok(obs.every(Number.isFinite), `${id}: finite height observations`);
        assert.ok(Array.from(lidar(q[0], q[1], q[2] + .1, yaw(q))).every((v) => v === Infinity || Number.isFinite(v) && v >= 0), `${id}: valid lidar`);
      }
      if (Math.hypot(x - q[0], y - q[1]) < .22) { arrivals.push({ target: target++, t: +sim.t.toFixed(2), xyz: Array.from(q.slice(0, 3)) }); heading = null; }
    }
    const result = { test: 'factory-ramp-roundtrip', policy: id, seconds: +sim.t.toFixed(2), minBase, worstGravity, arrivals, end: Array.from(sim.d.qpos.slice(0, 3)) };
    console.log(JSON.stringify(result));
    assert.equal(target, targets.length, `${id}: outside and back through the same ramp`);
    assert.ok(minBase < -.2, `${id}: actually reached lower outdoor ground`);
    assert.ok(sim.d.qpos[2] > .25, `${id}: returned to indoor datum`);
  } finally { scan.dispose(); sim.dispose(); }
}

console.log('factory outside PASS: both joystick contracts, actual ramp roundtrip, finite scans/lidar');

// Survey finite state at map edges; reaching a void does not stop policy/physics.
for (const [id, spawn] of [['warehouse', [8, 0, 0]], ['element-course', [35, 0, 0]], ['collapsed-house-v2', [0, 14, 0]]]) {
  const map = world(id), sim = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, policies.get('foothold-v2'), { floorZ: map.floor_z, spawn });
  const sample = makeTerrainSampler(mj, sim.m, sim.d, { grid: [[0, 0]], rayOffset: 0 }), support = new Float64Array(1);
  try {
    sample(sim.d.qpos, support);
    sim.hold(.5);
    for (let i = 0; i < 100; i++) { sim.cmd = [.6, 0, 0]; sim.step(); }
    console.log(JSON.stringify({ test: 'finite-asset-edge-survey', map: id, support: support[0], xyz: Array.from(sim.d.qpos.slice(0, 3)) }));
    assert.ok(sim.d.qpos.every(Number.isFinite), `${id}: finite state outside map`);
  } finally { sample.dispose(); sim.dispose(); }
}

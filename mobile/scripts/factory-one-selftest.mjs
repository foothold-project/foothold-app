// Existing local dependencies only; no server, browser, download or robot.
// FH_SIM_SRC=<local dependencies> node mobile/scripts/factory-one-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim, loadPolicy, ISAAC_LIKE } from '../sim/sim.js';
import { getPolicyAdapter } from '../sim/policy-adapters.js';
import { makeLidar } from '../sim/lidar.js';

const src = process.env.FH_SIM_SRC;
assert.ok(src, 'FH_SIM_SRC required (existing local dependencies)');
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(), adapter = getPolicyAdapter();
const dir = new URL('../sim/assets/factory-zone/', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, dir)));
const top = read('top.json');
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
mj.FS.writeFile('/go2/world.xml', readFileSync(new URL('factory-zone.xml', dir)));
mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
const bytes = readFileSync(join(src, 'policy_v2.f32'));
const policy = loadPolicy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const m = mj.MjModel.from_xml_path('/go2/scene.xml'), d = new mj.MjData(m);
mj.mj_forward(m, d);
const scan = adapter.makeHeightScanner(mj, m, d), lidar = makeLidar(mj, m, d, 360), out = new Float32Array(235), hit = new mj.IntBuffer(1);
const rays = [];
try {
  for (const [label, x, y, floor] of [['under-deck', 13, 6, 0], ['on-deck', 13, 6, 2], ['east-stair', 24.25, 3.8, 1.066], ['north-stair', 4.85, 11.75, 1.066]]) {
    const q = [x, y, floor + .4, 1, 0, 0, 0], before = Array.from(m.geom_group);
    scan(q, out, 48);
    assert.ok(Math.abs(out[48 + 93] + .1) < 1e-5, `${label}: local support height, overhead deck excluded`);
    assert.deepEqual(Array.from(m.geom_group), before, `${label}: groups restored for lidar`);
    // Compare 360-ray lidar against independent single rays at the robot's own altitude.
    const horizontal = lidar(x, y, q[2] + .1, 0).slice();
    for (let i = 0; i < 360; i++) {
      const a = i * Math.PI / 180;
      const distance = mj.mj_ray(m, d, [x, y, q[2] + .1], [Math.cos(a), Math.sin(a), 0], [0, 1, 0, 0, 0, 0], true, -1, hit, null);
      const expected = distance < 0 || distance > 12 ? Infinity : distance;
      assert.ok(horizontal[i] === expected || Math.abs(horizontal[i] - expected) < 1e-7, `${label}: lidar ray ${i}`);
    }
    assert.ok(horizontal.some((v) => Number.isFinite(v) && v > .05), `${label}: horizontal obstacles detected`);
    rays.push({ label, support: +(q[2] - .5 - out[48 + 93]).toFixed(4), nearestLidar: Math.min(...horizontal) });
  }
  // Both SDF stairs: 15 treads, 0.3m run, ~0.133m rise; joins meet z=2 deck.
  for (const axis of ['east', 'north']) {
    let previous = 0;
    for (let i = 0; i < 15; i++) {
      const [x, y] = axis === 'east' ? [26.35 - .3 * i, 3.8] : [4.85, 13.85 - .3 * i];
      const distance = mj.mj_ray(m, d, [x, y, 2.5], [0, 0, -1], [0, 1, 0, 0, 0, 0], true, -1, hit, null);
      const support = 2.5 - distance;
      assert.ok(Math.abs(support - (i + 1) * 2 / 15) < .002, `${axis}: tread ${i + 1}`);
      assert.ok(support > previous && support - previous < .135); previous = support;
    }
  }
  console.log(JSON.stringify({ sensorChecks: rays, stairGeometry: 'both 15 treads continuous to 2m deck' }));
} finally { scan.dispose(); hit.delete(); d.delete(); m.delete(); }

for (const f of top.floors) {
  const map = read(f.map_file), sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, policy, { floorZ: f.floor_z, spawn: map.spawn_xyyaw });
  try {
    sim.hold(.5);
    const start = Array.from(sim.d.qpos.slice(0, 3));
    for (let i = 0; i < 150; i++) { sim.cmd = [.6, 0, 0]; sim.step(); assert.equal(sim.fell, false, `${f.id}: fall at ${sim.t}`); }
    const distance = Math.hypot(sim.d.qpos[0] - start[0], sim.d.qpos[1] - start[1]);
    assert.ok(distance > 1, `${f.id}: walking made progress`);
    assert.ok(Math.abs(sim.d.qpos[2] - f.floor_z - .3) < .2, `${f.id}: stayed on selected floor`);
    console.log(JSON.stringify({ floor: f.id, seconds: sim.t, falls: 0, distance, end: Array.from(sim.d.qpos.slice(0, 3)) }));
  } finally { sim.dispose(); }
}
// An actual stair attempt, with no ramps, teleports, gait changes or altered collision.
// Require the existing policy to reach the other floor with the unified world datum.
for (const [name, floorZ, spawn, steps] of [
  ['east-up', 0, [27.3, 3.8, Math.PI], 600],
  ['east-down', 2, [21, 3.8, 0], 600],
  ['north-up', 0, [4.85, 14.8, -Math.PI / 2], 600],
  ['north-down', 2, [4.85, 8.5, Math.PI / 2], 600],
]) {
  const sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, policy, { floorZ: 0, spawn });
  try {
    // The unified world uses f1 as its fixed reset datum; raise only this test's initial pose.
    sim.d.qpos[2] = floorZ + .4; mj.mj_forward(sim.m, sim.d);
    sim.hold(.5);
    for (let i = 0; i < steps && !sim.fell; i++) { sim.cmd = [.6, 0, 0]; sim.step(); }
    const end = Array.from(sim.d.qpos.slice(0, 3));
    assert.equal(sim.fell, false, `${name}: fall`);
    assert.ok(name.endsWith('up') ? end[2] > 2.2 : end[2] < .6, `${name}: reached other floor`);
    console.log(JSON.stringify({ stairAttempt: name, seconds: +sim.t.toFixed(2), fell: sim.fell, end }));
  } finally { sim.dispose(); }
}

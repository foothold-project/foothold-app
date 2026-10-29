// Uses existing local RS-6 dependencies only. No server, browser, download, or real robot.
// FH_SIM_SRC=<local sim bundle source> node mobile/scripts/scenario-headless.mjs [map-id] [scenario-id]
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createSim, loadPolicy, ISAAC_LIKE, POLICY_DT } from '../sim/sim.js';
import { makeLidar, decodeMap } from '../sim/lidar.js';
import { createScenarioRunner, validateScenarios, frontDistance } from '../sim/scenario.js';

const src = process.env.FH_SIM_SRC;
if (!src) throw new Error('FH_SIM_SRC is required (existing local RS-6 dependencies)');
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
const buf = readFileSync(join(src, 'policy_v2.f32'));
const policy = loadPolicy(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const id = process.argv[2] || 'warehouse';
assert.ok(read('../sim/maps.json').some((m) => m.id === id), 'listed map required');
const map = decodeMap(read(`../sim/assets/${id}/map.json`));
for (const f of map.physics_assets ?? []) { const b = readFileSync(new URL(`../sim/assets/${id}/${f}`, import.meta.url)); mj.FS.writeFile(`/go2/${f}`, b); mj.FS.writeFile(`/go2/assets/${f}`, b); }
mj.FS.writeFile('/go2/world.xml', readFileSync(new URL(`../sim/assets/${id}/${id}.xml`, import.meta.url)));
mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
const sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, policy, { floorZ: map.floor_z, spawn: map.spawn_xyyaw });
const scan = makeLidar(mj, sim.m, sim.d, 360);
const runner = createScenarioRunner(sim, () => false);
const routes = validateScenarios(read(`../sim/assets/${id}/scenarios.json`).filter((s) => !process.argv[3] || s.id === process.argv[3]), map);
assert.ok(routes.length, 'at least one selected route required');
for (const route of routes) {
  sim.reset(); sim.hold(0.5); runner.start(route.points);
  let front = Infinity, steps = 0, scanMs = 0, followMs = 0, last = 0;
  const arrived = [], start = performance.now();
  while (runner.active && sim.t < 180) {
    if (steps % 5 === 0) {
      const q = sim.d.qpos, t = performance.now();
      front = frontDistance(scan(q[0], q[1], q[2] + 0.1, 2 * Math.atan2(q[6], q[3]))); scanMs += performance.now() - t;
    }
    const t = performance.now(); runner.tick(front); followMs += performance.now() - t;
    if (runner.index > last) { arrived.push({ point: runner.index, seconds: +sim.t.toFixed(2) }); last = runner.index; }
    if (!runner.active) break;
    sim.step(); steps++;
    if (sim.fell) runner.cancel('넘어짐');
  }
  assert.equal(sim.fell, false, `${route.id}: fall`);
  assert.equal(runner.status, '완료', `${route.id}: ${runner.status} at ${sim.t}s`);
  assert.equal(runner.index, route.points.length); assert.deepEqual(sim.cmd, [0, 0, 0]);
  console.log(JSON.stringify({ id: route.id, status: runner.status, falls: 0, seconds: +(steps * POLICY_DT).toFixed(2), arrived,
    wallMs: +(performance.now() - start).toFixed(1), followUsPerStep: +(followMs * 1000 / steps).toFixed(2), scanMs: +scanMs.toFixed(1) }));
}

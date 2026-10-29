// Existing local dependencies only; no server, browser or robot.
// FH_SIM_SRC=<dependencies> FH_SIM_BASE=<base commit's sim.js> node mobile/scripts/height-walk-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as head from '../sim/sim.js';

const src = process.env.FH_SIM_SRC, basePath = process.env.FH_SIM_BASE;
assert.ok(src && basePath, 'FH_SIM_SRC and FH_SIM_BASE required (existing dependencies and exact baseline sim.js)');
const base = await import(pathToFileURL(resolve(basePath)));
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) {
  if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
}
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
const weights = readFileSync(join(src, 'policy_v2.f32'));
const buffer = weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength);
const results = [];
for (const id of ['factory-inspection', 'factory-inspection-alt1', 'factory-zone-f1', 'warehouse', 'element-course']) {
  const dir = new URL(`../sim/assets/${id}/`, import.meta.url);
  const map = JSON.parse(readFileSync(new URL('map.json', dir)));
  for (const f of map.physics_assets ?? []) {
    const bytes = readFileSync(new URL(f, dir));
    mj.FS.writeFile(`/go2/${f}`, bytes); mj.FS.writeFile(`/go2/assets/${f}`, bytes);
  }
  mj.FS.writeFile('/go2/world.xml', readFileSync(new URL(`${id}.xml`, dir)));
  mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  const result = { map: id };
  for (const [label, code] of [['base', base], ['head', head]]) {
    const sim = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, code.loadPolicy(buffer), { floorZ: map.floor_z, spawn: map.spawn_xyyaw });
    try {
      sim.hold(0.5);
      const start = Array.from(sim.d.qpos.slice(0, 2));
      sim.cmd = [0.6, 0, 0];
      let fellAt = sim.fell ? 0 : null;
      for (let i = 0; i < 300; i++) {
        sim.step();
        if (sim.fell && fellAt === null) fellAt = +sim.t.toFixed(2);
      }
      result[label] = { fellAt, distance: +Math.hypot(sim.d.qpos[0] - start[0], sim.d.qpos[1] - start[1]).toFixed(3), seconds: +sim.t.toFixed(2) };
    } finally {
      if (sim.dispose) sim.dispose(); else { sim.d.delete(); sim.m.delete(); }
    }
  }
  results.push(result);
  console.log(JSON.stringify(result));
}
for (const r of results) {
  assert.equal(r.base.fellAt, null, `${r.map}: baseline must not fall`);
  assert.equal(r.head.fellAt, null, `${r.map}: height scan must not regress to falling`);
}
console.log('height walk PASS: five maps, spawn, (0.6,0,0), 6 s, no falls in base or head');

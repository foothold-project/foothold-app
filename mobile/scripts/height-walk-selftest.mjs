// Existing local dependencies only; no server, browser or robot.
// FH_SIM_SRC=<dependencies> FH_SIM_BASE=<base commit's sim.js> node mobile/scripts/height-walk-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as head from '../sim/sim.js';

const src = process.env.FH_SIM_SRC, basePath = process.env.FH_SIM_BASE;
assert.ok(src, 'FH_SIM_SRC required (existing dependencies)');
const baseline=basePath ? null : execFileSync('git',['show','b5cf2e5:mobile/sim/sim.js'],{encoding:'utf8'}).replace("'./policy-adapters.js'",JSON.stringify(new URL('../sim/policy-adapters.js',import.meta.url).href));
const base = await import(basePath ? pathToFileURL(resolve(basePath)).href : 'data:text/javascript;base64,'+Buffer.from(baseline).toString('base64'));
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
for (const id of ['factory-inspection', 'factory-inspection-alt1', 'factory-zone', 'warehouse', 'element-course']) {
  const dir = new URL(`../sim/assets/${id}/`, import.meta.url);
  const map = JSON.parse(readFileSync(new URL('map.json', dir)));
  for (const f of map.physics_assets ?? []) {
    const bytes = readFileSync(new URL(f, dir));
    mj.FS.writeFile(`/go2/${f}`, bytes); mj.FS.writeFile(`/go2/assets/${f}`, bytes);
  }
  mj.FS.writeFile('/go2/world.xml', readFileSync(new URL(`${id}.xml`, dir)));
  mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  const result = { map: id };
  let reference;
  for (const [label, code] of [['base', base], ['head', head]]) {
    const sim = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, code.loadPolicy(buffer), { floorZ: map.floor_z, spawn: map.spawn_xyyaw });
    try {
      sim.hold(0.5);
      const start = Array.from(sim.d.qpos.slice(0, 2));
      sim.cmd = [0.6, 0, 0];
      const trajectory = [];
      for (let i = 0; i < 300; i++) {
        sim.step();
        assert.ok(sim.d.qpos.every(Number.isFinite) && sim.d.qvel.every(Number.isFinite));
        trajectory.push([Array.from(sim.d.qpos), Array.from(sim.d.qvel), Array.from(sim.d.ctrl)]);
      }
      if (label === 'base') reference = trajectory; else assert.deepEqual(trajectory, reference, `${id}: physics and policy trajectory unchanged`);
      result[label] = { distance: +Math.hypot(sim.d.qpos[0] - start[0], sim.d.qpos[1] - start[1]).toFixed(3), seconds: +sim.t.toFixed(2) };
    } finally {
      if (sim.dispose) sim.dispose(); else { sim.d.delete(); sim.m.delete(); }
    }
  }
  results.push(result);
  console.log(JSON.stringify(result));
}
console.log('height walk PASS: five maps, spawn, (0.6,0,0), 6 s, finite and bit-identical base/head trajectories; no fall assessment');

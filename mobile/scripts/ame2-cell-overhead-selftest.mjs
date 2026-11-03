// Local native MuJoCo + f32/ONNX WASM, eight maps, no browser/server or gait verdict.
// FH_SIM_SRC, AME2_EXPORT (dev f32 + ONNX), FH_ORT_WEB are local assets.
// AME2_OVERHEAD_REPORT optionally saves measurements outside the source tree.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim, ISAAC_LIKE } from '../sim/sim.js';
import { getPolicyAdapter, makeTerrainSampler } from '../sim/policy-adapters.js';
import { ame2Joystick, makeAme2Adapter, AME2_OVERHEAD_CLEARANCE } from '../sim/ame2-adapter.js';
import { loadAme2OnnxPolicy } from '../sim/ame2-onnx.js';

for (const key of ['FH_SIM_SRC', 'AME2_EXPORT', 'FH_ORT_WEB']) assert.ok(process.env[key], `${key} required; no downloads`);
// Freeze dev's original body-wide cap; unrelated integration modes stay out.
const source = execFileSync('git', ['show', '1fd19f1:mobile/sim/ame2-adapter.js'], { encoding: 'utf8' })
  .replace("'./ame2-network.js'", JSON.stringify(new URL('../sim/ame2-network.js', import.meta.url).href));
const { makeAme2Adapter: makeBefore } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const baselineSamplerSource = execFileSync('git', ['show', '1fd19f1:mobile/sim/policy-adapters.js'], { encoding: 'utf8' })
  .match(/export function makeTerrainSampler[\s\S]*?\n}/)?.[0];
assert.ok(baselineSamplerSource, 'dev baseline sampler source');
const { makeTerrainSampler: baselineSampler } = await import('data:text/javascript;base64,' + Buffer.from(baselineSamplerSource).toString('base64'));
const adapter = getPolicyAdapter('ame2-demo'), before = makeBefore(baselineSampler);
// Exercise the scalar fallback too, independently of the optimized broad phase.
const scalar = makeAme2Adapter((mj, ...args) => makeTerrainSampler(new Proxy(mj, {
  get: (target, key) => key === 'mju_rayGeom' ? undefined : target[key],
}), ...args));
const { default: load } = await import(pathToFileURL(resolve(process.env.FH_SIM_SRC, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(process.env.FH_SIM_SRC, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile('/go2/assets/' + f, readFileSync(join(process.env.FH_SIM_SRC, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(process.env.FH_SIM_SRC, 'assets/unitree_go2/go2.xml')));
const bytes = readFileSync(join(process.env.AME2_EXPORT, 'ame2_actor.f32'));
const f32 = adapter.loadPolicy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), JSON.parse(readFileSync(join(process.env.AME2_EXPORT, 'ame2_actor.json'))));
const ort = await import(pathToFileURL(resolve(process.env.FH_ORT_WEB, 'dist/ort.wasm.min.mjs'))); ort.env.wasm.numThreads = 1;
// dev's existing actor has action/offsets/gaze_logits outputs. The integration
// demo model has a different contract and is deliberately not substituted.
const onnx = await loadAme2OnnxPolicy(ort, readFileSync(join(process.env.AME2_EXPORT, 'ame2_actor.onnx')), 'wasm');
const maps = ['flat', ...JSON.parse(readFileSync(new URL('../sim/maps.json', import.meta.url))).map((m) => m.id)]
  .filter((id) => !process.env.ONLY_MAPS || process.env.ONLY_MAPS.split(',').includes(id));
const records = [];
const changedMaps = new Set(['warehouse', 'factory-inspection', 'factory-inspection-alt1', 'factory-zone']);
function scene(id) {
  let map = { floor_z: 0, spawn_xyyaw: [0, 0, 0] }, xml = '<mujoco><worldbody><geom group="1" type="box" size="50 50 .05" pos="0 0 -.05"/></worldbody></mujoco>';
  if (id !== 'flat') {
    const dir = new URL('../sim/assets/' + id + '/', import.meta.url);
    map = JSON.parse(readFileSync(new URL('map.json', dir))); xml = readFileSync(new URL(id + '.xml', dir));
    for (const f of map.physics_assets ?? []) { const b = readFileSync(new URL(f, dir)); mj.FS.writeFile('/go2/' + f, b); mj.FS.writeFile('/go2/assets/' + f, b); }
  }
  mj.FS.writeFile('/go2/world.xml', xml);
  mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  return map;
}
// Same cover-only removal as the diagnostic: world AABB bottom > floor + .8m.
// Used only as a reference; collision physics and actual scanner retain covers.
function covers(m, d, floor) {
  const pos = d.geom_xpos, mat = d.geom_xmat, aabb = m.geom_aabb, out = [];
  for (let g = 0; g < m.ngeom; g++) {
    if (m.geom_bodyid[g] !== 0 || m.geom_type[g] <= 1 || (!m.geom_contype[g] && !m.geom_conaffinity[g])) continue;
    const a = 6 * g, t = 9 * g;
    const z = pos[3 * g + 2] + mat[t + 6] * aabb[a] + mat[t + 7] * aabb[a + 1] + mat[t + 8] * aabb[a + 2];
    const r = Math.abs(mat[t + 6]) * aabb[a + 3] + Math.abs(mat[t + 7]) * aabb[a + 4] + Math.abs(mat[t + 8]) * aabb[a + 5];
    if (z - r > floor + .8) out.push(g);
  }
  return out;
}
const clip15 = (a) => a.filter((_, i) => i % 3 === 2).filter((z) => z >= 1.5).length;
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
try {
  for (const id of maps) for (const [engine, drive] of [['f32', f32], ['onnx', onnx]].filter(([engine]) => !process.env.ENGINES || process.env.ENGINES.split(',').includes(engine))) {
    const map = scene(id), prior = new Float32Array(1131), reference = new Float32Array(1131), exact = new Float32Array(1131);
    let sim, oldScan, newScan, scalarScan, hidden, groups0, tick = 0, beforeMs = 0, afterMs = 0;
    let changedMax = 0, oldCoverMax = 0, newCoverMax = 0, unchangedMax = 0, scalarMax = 0, first, wallClip15Max = 0, beforeClip15Max = 0, afterClip15Max = 0;
    const policy = async (prop, mapping) => {
      const q = sim.d.qpos, t = performance.now(); oldScan(q, prior); beforeMs += performance.now() - t;
      const u = performance.now(); newScan(q, exact); afterMs += performance.now() - u;
      assert.deepEqual(exact, mapping, `${id}/${engine}/${tick}: policy receives the cell scan`);
      let changed = 0, oldCover = 0, newCover = 0;
      if (!['ame2-train-terrain', 'collapsed-house-v2'].includes(id)) {
        const groups = sim.m.geom_group;
        for (const g of hidden) groups[g] = 3;
        try { oldScan(q, reference); } finally { for (const g of hidden) groups[g] = groups0[g]; }
        for (let i = 2; i < 1131; i += 3) {
          if (Math.abs(prior[i] - reference[i]) > 1e-5) oldCover++;
          if (Math.abs(mapping[i] - reference[i]) > 1e-5) newCover++;
          // Every original terrain cell must remain identical, including stairs.
          if (Math.abs(prior[i] - reference[i]) < 1e-5) unchangedMax = Math.max(unchangedMax, Math.abs(prior[i] - mapping[i]));
        }
      }
      beforeClip15Max = Math.max(beforeClip15Max, clip15(prior)); afterClip15Max = Math.max(afterClip15Max, clip15(mapping));
      if (id === 'collapsed-house-v2' && clip15(mapping)) {
        // The diagnostic's floor+.8 AABB filter also removed walls built on
        // raised terrain. These tall boxes either contain the ray origin
        // (upward-facing exit), or begin below the clearance threshold.
        const groups = sim.m.geom_group, saved = Array.from(groups), hit = new mj.IntBuffer(1), n = new mj.DoubleBuffer(3);
        let walls = 0;
        try {
          for (let g = 0; g < sim.m.ngeom; g++) if (sim.m.geom_bodyid[g] !== 0 || (!sim.m.geom_contype[g] && !sim.m.geom_conaffinity[g])) groups[g] = 5;
          const yaw = adapter.yawOf(q), c = Math.cos(yaw), s = Math.sin(yaw);
          for (let i = 2; i < 1131; i += 3) if (mapping[i] >= 1.5) {
            const [x, y] = adapter.observations.height.grid[(i - 2) / 3];
            const distance = mj.mj_ray(sim.m, sim.d, [q[0] + c * x - s * y, q[1] + s * x + c * y, q[2]], [0, 0, 1], [1, 1, 0, 0, 1, 0], true, -1, hit, n);
            const g = hit.GetView()[0];
            assert.ok(distance >= 0 && sim.m.geom_type[g] === 6 && sim.m.geom_size[3 * g + 2] >= .6
              && (n.GetView()[2] > 0 || distance <= AME2_OVERHEAD_CLEARANCE), `${id}/${tick}/${i}: retained +1.5 is a tall terrain wall`); walls++;
          }
        } finally { groups.set(saved); hit.delete(); n.delete(); }
        wallClip15Max = Math.max(wallClip15Max, walls);
      }
      for (let i = 2; i < 1131; i += 3) if (mapping[i] !== prior[i]) changed++;
      changedMax = Math.max(changedMax, changed); oldCoverMax = Math.max(oldCoverMax, oldCover); newCoverMax = Math.max(newCoverMax, newCover);
      if (tick % 50 === 0) { scalarScan(q, reference); scalarMax = Math.max(scalarMax, maxDiff(mapping, reference)); }
      if (!tick) first = { beforeClip15: clip15(prior), afterClip15: clip15(mapping), beforeCover: oldCover, afterCover: newCover };
      tick++;
      const result = await drive(prop, mapping);
      return Float32Array.from(result.action ?? result);
    };
    policy.async = true;
    sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, policy, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }, 'ame2-demo', { ame2DelaySteps: 0 });
    oldScan = before.makeHeightScanner(mj, sim.m, sim.d, { floorZ: map.floor_z });
    // dev keeps its observation scanner private; create a matching scanner
    // against the same live state instead of importing the integration API.
    newScan = adapter.makeHeightScanner(mj, sim.m, sim.d, { floorZ: map.floor_z });
    scalarScan = scalar.makeHeightScanner(mj, sim.m, sim.d, { floorZ: map.floor_z });
    hidden = covers(sim.m, sim.d, map.floor_z); groups0 = Array.from(sim.m.geom_group);
    let heading = null, maxLat = 0, x2 = 0, fell = null;
    try {
      sim.hold(.5);
      const q0 = Array.from(sim.d.qpos), yaw0 = adapter.yawOf(q0), c = Math.cos(yaw0), s = Math.sin(yaw0);
      for (let k = 0; k < 300; k++) {
        const goal = ame2Joystick(heading, adapter.yawOf(sim.d.qpos), [1, 0, 0], .02); heading = goal.heading; sim.cmd = goal.command;
        await sim.step();
        const q = sim.d.qpos, x = c * (q[0] - q0[0]) + s * (q[1] - q0[1]), y = -s * (q[0] - q0[0]) + c * (q[1] - q0[1]);
        maxLat = Math.max(maxLat, Math.abs(y)); if (k === 99) x2 = x;
        if (fell === null && (sim.grav[2] > -.5 || q[2] < map.floor_z + .15)) fell = +sim.t.toFixed(2);
      }
      const q = sim.d.qpos, fwd = c * (q[0] - q0[0]) + s * (q[1] - q0[1]);
      const yaw = adapter.yawOf(q) - yaw0;
      const record = { id, engine, ...first, changedMax, oldCoverMax, newCoverMax, unchangedMax, scalarMax, beforeClip15Max, afterClip15Max, wallClip15Max,
        fwd: +fwd.toFixed(3), v26: +((fwd - x2) / 4).toFixed(3), maxLat: +maxLat.toFixed(3), yaw: +Math.atan2(Math.sin(yaw), Math.cos(yaw)).toFixed(3), fell,
        beforeScanMs: +(beforeMs / 300).toFixed(3), afterScanMs: +(afterMs / 300).toFixed(3) };
      records.push(record); console.log(JSON.stringify(record));
      if (process.env.AME2_OVERHEAD_REPORT) writeFileSync(process.env.AME2_OVERHEAD_REPORT, JSON.stringify(records, null, 2));
      assert.ok(scalarMax < 1e-5, `${id}: batched/scalar scan`);
      assert.equal(newCoverMax, 0, `${id}: no overhead hit throughout 6s`);
      assert.equal(unchangedMax, 0, `${id}: original terrain values preserved`);
      if (!changedMaps.has(id)) assert.equal(changedMax, 0, `${id}: uncovered terrain unchanged`);
      if (id.startsWith('factory-')) assert.equal(first.afterClip15, 0, `${id}: initial +1.5 cells`);
    } finally { oldScan.dispose(); newScan.dispose(); scalarScan.dispose(); sim.dispose(); }
  }
} finally { await onnx.dispose(); }
console.log(`AME-2 cell overhead PASS: ${records.length} runs / ${maps.length} maps × 300 ticks, terrain/scalar regression and scan timings; no gait verdict`);

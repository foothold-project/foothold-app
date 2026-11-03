// Narrow dev hotfix regression: source snapshots, native MuJoCo, JS f32 / ORT WASM.
// Local assets only; run under the shared heavy-test flock. No gait verdict.
// AME2_HOTFIX_REPORT optionally writes measurements outside the source tree.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as after from '../sim/sim.js';
import { getPolicyAdapter, makeTerrainSampler } from '../sim/policy-adapters.js';
import { ame2Joystick } from '../sim/ame2-adapter.js';
import { loadOnnxPolicy } from '../sim/policy-onnx.js';

for (const key of ['FH_SIM_SRC', 'AME2_EXPORT', 'FH_ORT_WEB', 'FH_POLICY_ONNX_SRC']) assert.ok(process.env[key], `${key} required; no downloads`);
const baselineRef = '1fd19f1', integrationRef = 'ef26183';
const source = (ref, file) => execFileSync('git', ['show', `${ref}:mobile/sim/${file}`], { encoding: 'utf8' });
const url = (text) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const ameSource = (ref) => source(ref, 'ame2-adapter.js').replace("'./ame2-network.js'", JSON.stringify(new URL('../sim/ame2-network.js', import.meta.url).href));
const baselineAdaptersUrl = url(source(baselineRef, 'policy-adapters.js').replace("'./ame2-adapter.js'", JSON.stringify(url(ameSource(baselineRef)))));
const baselineAdapters = await import(baselineAdaptersUrl);
const before = await import(url(source(baselineRef, 'sim.js').replace("'./policy-adapters.js'", JSON.stringify(baselineAdaptersUrl))));
// Extract ONLY the sampler: do not load the integration registry/start/ONNX defaults.
const samplerSource = source(integrationRef, 'policy-adapters.js').match(/export function makeTerrainSampler[\s\S]*?\n}/)?.[0];
assert.ok(samplerSource, 'integration sampler source');
const integrationSampler = (await import(url(samplerSource))).makeTerrainSampler;
const integration = (await import(url(ameSource(integrationRef)))).makeAme2Adapter(integrationSampler);
const adapter = getPolicyAdapter('ame2-demo');
const { default: load } = await import(pathToFileURL(resolve(process.env.FH_SIM_SRC, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const file of readdirSync(join(process.env.FH_SIM_SRC, 'assets/unitree_go2/assets'))) if (file.endsWith('.obj')) mj.FS.writeFile('/go2/assets/' + file, readFileSync(join(process.env.FH_SIM_SRC, 'assets/unitree_go2/assets', file)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(process.env.FH_SIM_SRC, 'assets/unitree_go2/go2.xml')));
const maps = ['flat', ...JSON.parse(readFileSync(new URL('../sim/maps.json', import.meta.url))).map((m) => m.id)];
function scene(id) {
  let map = { floor_z: 0, spawn_xyyaw: [0, 0, 0] }, xml = '<mujoco><worldbody><geom group="1" type="box" size="50 50 .05" pos="0 0 -.05"/></worldbody></mujoco>';
  if (id !== 'flat') {
    const dir = new URL('../sim/assets/' + id + '/', import.meta.url);
    map = JSON.parse(readFileSync(new URL('map.json', dir))); xml = readFileSync(new URL(id + '.xml', dir));
    for (const file of map.physics_assets ?? []) { const b = readFileSync(new URL(file, dir)); mj.FS.writeFile('/go2/' + file, b); mj.FS.writeFile('/go2/assets/' + file, b); }
  }
  mj.FS.writeFile('/go2/world.xml', xml);
  mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  return map;
}
const maxDiff = (a, b) => {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) { const delta = Math.abs(a[i] - b[i]); assert.ok(Number.isFinite(delta)); max = Math.max(max, delta); }
  return max;
};
const report = { baselineRef, integrationRef, conditions: 'ISAAC_LIKE; hold 0.5s; forward stick 1; fixed action delay 0; 300 ticks/6s; ORT WASM 1 thread', poses: [], walks: [], nvidia: [] };
const save = () => { if (process.env.AME2_HOTFIX_REPORT) writeFileSync(process.env.AME2_HOTFIX_REPORT, JSON.stringify(report, null, 2)); };
for (const id of maps) {
  const map = scene(id), m = mj.MjModel.from_xml_path('/go2/scene.xml'), d = new mj.MjData(m); mj.mj_forward(m, d);
  const world = { floorZ: map.floor_z }, scan = adapter.makeHeightScanner(mj, m, d, world), reference = integration.makeHeightScanner(mj, m, d, world);
  const old = baselineAdapters.getPolicyAdapter('ame2-demo').makeHeightScanner(mj, m, d, world);
  const actual = new Float64Array(1131), expected = new Float64Array(1131), prior = new Float64Array(1131);
  const [x, y, yaw] = map.spawn_xyyaw, poses = [];
  for (let i = 0; i < 32; i++) {
    const angle = yaw + (i % 8) * Math.PI / 4, radius = Math.floor(i / 8) * .8;
    const heading = yaw + i * .37;
    poses.push([x + radius * Math.cos(angle), y + radius * Math.sin(angle), map.floor_z + [.3, .4, .7, 3.8][i % 4], Math.cos(heading / 2), 0, 0, Math.sin(heading / 2)]);
  }
  if (id === 'factory-inspection') poses.push([40.70054, 46.97936, .32887, .72889, 0, 0, .68463], [29.74458, 25.77593, .29935, .98566, 0, 0, .16876]);
  let integrationMaxAbs = 0, rooflessMaxAbs = 0;
  try {
    for (const q of poses) {
      scan(q, actual); reference(q, expected); old(q, prior);
      integrationMaxAbs = Math.max(integrationMaxAbs, maxDiff(actual, expected));
      if (['flat', 'element-course', 'ame2-train-terrain'].includes(id)) rooflessMaxAbs = Math.max(rooflessMaxAbs, maxDiff(actual, prior));
    }
    assert.equal(integrationMaxAbs, 0, `${id}: integration matches all 377 cells at every pose`);
    assert.equal(rooflessMaxAbs, 0, `${id}: uncovered map matches dev`);
    report.poses.push({ id, poses: poses.length, cellsPerPose: 377, integrationMaxAbs, rooflessMaxAbs }); console.log('Poses PASS', JSON.stringify(report.poses.at(-1))); save();
  } finally { scan.dispose(); reference.dispose(); old.dispose(); d.delete(); m.delete(); }
}
const ort = await import(pathToFileURL(resolve(process.env.FH_ORT_WEB, 'dist/ort.wasm.min.mjs'))); ort.env.wasm.numThreads = 1;
for (const mode of ['ame2-demo', 'foothold-v2']) for (const backend of ['f32', 'wasm']) {
  const current = getPolicyAdapter(mode), root = mode === 'ame2-demo' ? process.env.AME2_EXPORT : process.env.FH_SIM_SRC;
  const bytes = readFileSync(join(root, current.network.file));
  const policy = backend === 'f32'
    ? current.loadPolicy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mode === 'ame2-demo' ? JSON.parse(readFileSync(join(root, current.network.manifest))) : undefined)
    : await loadOnnxPolicy(ort, readFileSync(join(mode === 'ame2-demo' ? process.env.AME2_EXPORT : process.env.FH_POLICY_ONNX_SRC, current.onnx.file)), current.onnx, 'wasm');
  try {
    for (const id of mode === 'ame2-demo' ? maps : ['warehouse', 'factory-inspection', 'element-course']) {
      const map = scene(id), versions = [], trajectories = [], mappings = [];
      for (const [version, module] of [['before', before], ['after', after]]) {
        const received = [], wrapped = (...args) => { if (mode === 'ame2-demo') received.push(Array.from(args[1])); return policy(...args); }; wrapped.async = backend === 'wasm';
        const sim = module.createSim(mj, '/go2/scene.xml', module.ISAAC_LIKE, wrapped, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }, mode, { ame2DelaySteps: 0 });
        const trajectory = []; let heading = null;
        try {
          sim.hold(.5); const q0 = Array.from(sim.d.qpos), yaw0 = adapter.yawOf(q0), c = Math.cos(yaw0), s = Math.sin(yaw0);
          for (let k = 0; k < 300; k++) {
            if (mode === 'ame2-demo') { const goal = ame2Joystick(heading, adapter.yawOf(sim.d.qpos), [1, 0, 0], .02); heading = goal.heading; sim.cmd = goal.command; }
            else {
              // Include neutral/STOP state clearing and reset in the 6s regression.
              if (k === 200) sim.clearPolicyState(); if (k === 250) sim.reset();
              sim.cmd = k < 100 ? [.6, 0, 0] : k < 200 ? [.6, 0, .5] : [0, 0, 0];
            }
            await sim.step(); trajectory.push([...sim.d.qpos, ...sim.d.qvel, ...sim.d.ctrl, ...sim.grav, sim.t]);
          }
          const q = sim.d.qpos;
          versions.push({ version, distance: c * (q[0] - q0[0]) + s * (q[1] - q0[1]) });
        } finally { sim.dispose(); }
        trajectories.push(trajectory.flat()); mappings.push(received.flat());
      }
      const trajectoryMaxAbs = maxDiff(...trajectories), mappingMaxAbs = mode === 'ame2-demo' ? maxDiff(...mappings) : 0;
      const covered = ['warehouse', 'factory-inspection', 'factory-inspection-alt1', 'factory-zone', 'collapsed-house-v2'].includes(id);
      // Covered maps intentionally change the observation input. Exact value
      // correctness is checked by pose parity and the cell/solid-start tests.
      if (mode === 'foothold-v2' || !covered) assert.equal(trajectoryMaxAbs, 0, `${mode}/${backend}/${id}: unchanged trajectory`);
      if (mode === 'ame2-demo' && !covered) assert.equal(mappingMaxAbs, 0, `${id}: unchanged uncovered mapping`);
      if (trajectoryMaxAbs > 0) assert.ok(mappingMaxAbs > 0, 'trajectory difference requires different mapping inputs');
      const record = { mode, backend, id, seconds: 6, ticks: 300, ...Object.fromEntries(versions.map(({ version, distance }) => [version, +distance.toFixed(6)])), trajectoryMaxAbs, mappingMaxAbs };
      report[mode === 'ame2-demo' ? 'walks' : 'nvidia'].push(record); console.log('Walk PASS', JSON.stringify(record)); save();
    }
  } finally { await policy.dispose?.(); }
}
console.log('AME-2 dev hotfix PASS: integration pose parity; uncovered mapping/trajectory exact; f32/WASM distances; nvidia 6 trajectories exact; no gait verdict');

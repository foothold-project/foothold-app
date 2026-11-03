// Compare the source snapshot with the current scanner/registry, same backend.
// POLICY_MODES_BASE=<baseline sim directory>; required local assets, no downloads.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as after from '../sim/sim.js';
import { POLICY_MODES } from '../sim/policy-modes.js';
import { loadOnnxPolicy } from '../sim/policy-onnx.js';
import { loadAme2Policy } from '../sim/ame2-network.js';
assert.ok(process.env.POLICY_MODES_BASE, 'POLICY_MODES_BASE required');
const before = await import(pathToFileURL(resolve(process.env.POLICY_MODES_BASE, 'sim.js')));
const beforeModes = await import(pathToFileURL(resolve(process.env.POLICY_MODES_BASE, 'policy-adapters.js')));
const beforeOnnx = await import(pathToFileURL(resolve(process.env.POLICY_MODES_BASE, 'policy-onnx.js')));
const src = process.env.FH_SIM_SRC;
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const file of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (file.endsWith('.obj')) mj.FS.writeFile('/go2/assets/' + file, readFileSync(join(src, 'assets/unitree_go2/assets', file)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
const ort = await import(pathToFileURL(resolve(process.env.POLICY_ORT_NODE)));
const records = [];
for (const [key, mode] of Object.entries(POLICY_MODES)) for (const backend of ['f32', 'onnx']) {
  const root = key === 'ame2' ? process.env.FH_AME2_F32_SRC : src;
  const bytes = readFileSync(join(root, mode.fallback.file));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const fallback = key === 'ame2' ? loadAme2Policy(buffer, JSON.parse(readFileSync(join(root, mode.fallback.manifest)))) : mode.loadPolicy(buffer);
  const oldMode = beforeModes.getPolicyAdapter(key === 'nvidia' ? 'foothold-v2' : mode.id);
  const oldFallback = oldMode.loadPolicy(buffer, mode.fallback.manifest ? JSON.parse(readFileSync(join(root, mode.fallback.manifest))) : undefined);
  const modelRoot = key === 'ame2' ? process.env.FH_AME2_SRC : process.env.FH_POLICY_ONNX_SRC;
  const policy = backend === 'f32' ? fallback : await loadOnnxPolicy(ort, readFileSync(join(modelRoot, mode.onnx.file)), mode.onnx, 'cpu');
  const oldPolicy = backend === 'f32' ? oldFallback : await beforeOnnx.loadOnnxPolicy(ort, readFileSync(join(modelRoot, mode.onnx.file)), oldMode.onnx, 'cpu');
  try {
    for (const mapId of ['warehouse', 'factory-inspection', 'element-course']) {
      const dir = new URL('../sim/assets/' + mapId + '/', import.meta.url);
      const map = JSON.parse(readFileSync(new URL('map.json', dir)));
      for (const file of map.physics_assets ?? []) {
        const bytes = readFileSync(new URL(file, dir)); mj.FS.writeFile('/go2/' + file, bytes); mj.FS.writeFile('/go2/assets/' + file, bytes);
      }
      mj.FS.writeFile('/go2/world.xml', readFileSync(new URL(mapId + '.xml', dir)));
      mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
      const trajectories = [], mappings = [];
      for (const [version, module] of [['before', before], ['after', after]]) {
        const run = version === 'before' ? oldPolicy : policy;
        const maps = [];
        const wrapped = (...args) => { if (key === 'ame2') maps.push(Array.from(args[1])); return run(...args); }; wrapped.async = backend === 'onnx';
        const id = version === 'before' && key === 'nvidia' ? 'foothold-v2' : mode.id;
        const sim = module.createSim(mj, '/go2/scene.xml', module.ISAAC_LIKE, wrapped, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }, id, { ame2DelaySteps: 0 });
        const trajectory = [];
        try {
          sim.hold(.5);
          for (let k = 0; k < 300; k++) {
            if (k === 200) sim.clearPolicyState();
            if (k === 250) sim.reset();
            sim.cmd = key === 'ame2'
              ? (k < 100 ? [1, 0, 0, 1] : k < 200 ? [.5, .3, Math.sin(.2), Math.cos(.2)] : mode.stop.input.slice())
              : (k < 100 ? [.6, 0, 0] : k < 200 ? [.6, 0, .5] : mode.stop.input.slice());
            await sim.step();
            trajectory.push([...sim.d.qpos, ...sim.d.qvel, ...sim.d.ctrl, ...sim.grav, sim.t]);
          }
          if (version === 'after') assert.equal(sim.adapterId, mode.id);
        } finally { sim.dispose(); }
        trajectories.push(trajectory);
        mappings.push(maps);
      }
      let maxAbs = 0;
      for (let k = 0; k < 300; k++) for (let i = 0; i < trajectories[0][k].length; i++) {
        const delta = Math.abs(trajectories[0][k][i] - trajectories[1][k][i]);
        assert.ok(Number.isFinite(delta)); maxAbs = Math.max(maxAbs, delta);
      }
      let mappingMaxAbs = 0;
      if (key === 'ame2') for (let k = 0; k < mappings[0].length; k++) for (let i = 0; i < mappings[0][k].length; i++) {
        mappingMaxAbs = Math.max(mappingMaxAbs, Math.abs(mappings[0][k][i] - mappings[1][k][i]));
      }
      // Per-cell cover removal changes AME-2's inputs in these covered maps.
      // nvidia and uncovered AME-2 maps must still match every state exactly.
      const coverCorrection = key === 'ame2' && ['warehouse', 'factory-inspection'].includes(mapId);
      if (coverCorrection && maxAbs > 0) assert.ok(mappingMaxAbs > 0, `${key}/${mapId}: trajectory change requires changed map inputs`);
      else assert.equal(maxAbs, 0, `${key}/${backend}/${mapId}: before/after`);
      records.push({ mode: mode.id, backend, map: mapId, ticks: 300, seconds: 6, maxAbs, mappingMaxAbs, coverCorrection });
      console.log('Trajectory PASS', JSON.stringify(records.at(-1)));
    }
  } finally { await policy.dispose?.(); await oldPolicy.dispose?.(); }
}
if (process.env.POLICY_MODES_TRAJECTORY_REPORT) writeFileSync(process.env.POLICY_MODES_TRAJECTORY_REPORT, JSON.stringify(records, null, 2));
console.log('Policy modes trajectories PASS: f32/ONNX × 3 maps × 6 s, STOP clear/reset; nvidia/uncovered AME-2 exact, covered AME-2 input/trajectory differences reported');

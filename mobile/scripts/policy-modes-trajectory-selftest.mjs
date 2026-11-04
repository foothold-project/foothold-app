// Compare the source snapshot with the current scanner/registry, same backend.
// POLICY_MODES_BASE=<baseline sim directory>; required local assets, no downloads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as after from '../sim/sim.js';
import { POLICY_MODES } from '../sim/policy-modes.js';
import { loadOnnxPolicy, withPolicyState, inputData } from '../sim/policy-onnx.js';
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
// Exercise the shipped Worker module with Node's transport, keeping the exact
// same MuJoCo WASM as the browser bundle. No browser-only silent fallback.
let depthWorkerOptions;
if (process.env.POLICY_MODES_DEPTH_WORKER === '1') {
  const { Worker } = await import('node:worker_threads');
  depthWorkerOptions = { createWorker() {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      global.self = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
      import(workerData).then(() => parentPort.on('message', data => self.onmessage({ data })));
    `, { eval: true, workerData: pathToFileURL(resolve('mobile/www/sim/start-depth-worker.js')).href });
    const transport = { postMessage: (packet, transfer) => worker.postMessage(packet, transfer), terminate: () => worker.terminate() };
    worker.on('message', (data) => transport.onmessage?.({ data }));
    worker.on('error', (error) => transport.onerror?.({ message: error.message }));
    return transport;
  } };
}
// Go2 replays robot state without a policy, so it has no policy trajectory to compare.
for (const [key, mode] of Object.entries(POLICY_MODES).filter(([, mode]) => mode.onnx || mode.fallback)) for (const backend of mode.fallback ? ['f32', 'onnx'] : ['onnx']) {
  const root = key === 'ame2' ? process.env.FH_AME2_F32_SRC : src;
  const oldMode = beforeModes.getPolicyAdapter(key === 'nvidia' ? 'foothold-v2' : mode.id);
  const networkInputs = [[], []];
  const traceInputs = (run, records) => {
    const traced = (...args) => {
      records.push(args.map((x, i) => createHash('sha256').update(inputData(x, mode.onnx.inputs[i])).digest('hex')));
      return run(...args);
    };
    return Object.assign(traced, run);
  };
  let policy, oldPolicy;
  if (backend === 'f32') {
    const bytes = readFileSync(join(root, mode.fallback.file)), buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const manifest = mode.fallback.manifest ? JSON.parse(readFileSync(join(root, mode.fallback.manifest))) : undefined;
    policy = key === 'ame2' ? loadAme2Policy(buffer, manifest) : mode.loadPolicy(buffer);
    oldPolicy = oldMode.loadPolicy(buffer, manifest);
  } else {
    const modelRoot = key === 'start' ? process.env.FH_START_SRC : key === 'ame2' ? process.env.FH_AME2_SRC : process.env.FH_POLICY_ONNX_SRC;
    const bytes = readFileSync(join(modelRoot, mode.onnx.file));
    policy = await loadOnnxPolicy(ort, bytes, mode.onnx, 'cpu');
    oldPolicy = await beforeOnnx.loadOnnxPolicy(ort, bytes, oldMode.onnx, 'cpu');
    if (key === 'start') {
      if (depthWorkerOptions) { policy = traceInputs(policy, networkInputs[1]); oldPolicy = traceInputs(oldPolicy, networkInputs[0]); }
      policy = withPolicyState(policy, mode.onnx); oldPolicy = beforeOnnx.withPolicyState(oldPolicy, oldMode.onnx);
    }
  }
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
      networkInputs.forEach((x) => { x.length = 0; });
      for (const [version, module] of [['before', before], ['after', after]]) {
        const run = version === 'before' ? oldPolicy : policy;
        const maps = [];
        const wrapped = (...args) => {
          if (key === 'ame2' || key === 'start') maps.push(Array.from(args[key === 'start' ? 8 : 1]));
          return run(...args);
        };
        Object.assign(wrapped, run); wrapped.async = backend === 'onnx';
        const id = version === 'before' && key === 'nvidia' ? 'foothold-v2' : mode.id;
        const sim = module.createSim(mj, '/go2/scene.xml', module.ISAAC_LIKE, wrapped, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }, id, { ame2DelaySteps: 0, ...(version === 'after' ? { depthWorkerOptions } : {}) });
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
          if (version === 'after' && key === 'start' && depthWorkerOptions) {
            assert.equal(sim.depthScanner.async, true);
            assert.ok(sim.depthScanner.roundtripMs > 0, 'real depth Worker, no native fallback');
          }
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
      if (key === 'ame2' || key === 'start') for (let k = 0; k < mappings[0].length; k++) for (let i = 0; i < mappings[0][k].length; i++) {
        mappingMaxAbs = Math.max(mappingMaxAbs, Math.abs(mappings[0][k][i] - mappings[1][k][i]));
      }
      // Per-cell cover removal changes AME-2/start inputs in covered maps.
      // nvidia and uncovered maps must still match every state exactly.
      const coverCorrection = ['ame2', 'start'].includes(key) && ['warehouse', 'factory-inspection'].includes(mapId);
      if (depthWorkerOptions) { assert.equal(maxAbs, 0, `${key}/${mapId}: Worker trajectory exact`); assert.equal(mappingMaxAbs, 0); assert.deepEqual(networkInputs[0], networkInputs[1], 'all model input bytes exact, including recurrent state'); }
      else if (coverCorrection && maxAbs > 0) assert.ok(mappingMaxAbs > 0, `${key}/${mapId}: trajectory change requires changed map inputs`);
      else assert.equal(maxAbs, 0, `${key}/${backend}/${mapId}: before/after`);
      records.push({ mode: mode.id, backend, map: mapId, ticks: 300, seconds: 6, maxAbs, mappingMaxAbs, coverCorrection, ...(depthWorkerOptions && key === 'start' ? { modelInputBytesExact: true, modelInputTensors: networkInputs[1].length * mode.onnx.inputs.length } : {}) });
      console.log('Trajectory PASS', JSON.stringify(records.at(-1)));
    }
  } finally { await policy.dispose?.(); await oldPolicy.dispose?.(); }
}
if (process.env.POLICY_MODES_TRAJECTORY_REPORT) writeFileSync(process.env.POLICY_MODES_TRAJECTORY_REPORT, JSON.stringify(records, null, 2));
console.log('Policy modes trajectories PASS: nvidia/AME-2 f32+ONNX, start stateful ONNX × 3 maps × 6 s, STOP clear/reset; nvidia/uncovered exact, covered input/trajectory differences reported');

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim, ISAAC_LIKE } from '../sim/sim.js';
import { getPolicyAdapter } from '../sim/policy-adapters.js';
import { loadOnnxPolicy } from '../sim/policy-onnx.js';
import { comparePolicyWalk, AME2_WALK_MAPS } from '../sim/ame2-onnx-walk.js';
const src = process.env.FH_SIM_SRC, dir = 'runs/policy-onnx/out', adapter = getPolicyAdapter();
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile('/go2/assets/' + f, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
const bytes = readFileSync(join(dir, 'policy_v2.f32'));
const f32 = adapter.loadPolicy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const ort = await import(pathToFileURL(resolve(process.env.POLICY_ORT_NODE)));
const onnx = await loadOnnxPolicy(ort, readFileSync(join(dir, 'policy_v2.onnx')), adapter.onnx, 'cpu');
try {
  const result = await comparePolicyWalk(mj, createSim, ISAAC_LIKE, f32, onnx, async (p) => readFileSync(new URL('../sim/' + p, import.meta.url)), { adapterId: adapter.id, maps: AME2_WALK_MAPS.slice(0, 5) });
  writeFileSync('runs/policy-onnx/walk-node.json', JSON.stringify(result));
  writeFileSync('runs/policy-onnx/out/observations.json', JSON.stringify(result.observations));
  console.log(JSON.stringify(result.records.map(({ trajectories, ...summary }) => summary)));
} finally { await onnx.dispose(); }
mj.FS.writeFile('/go2/flat.xml', '<mujoco><include file="go2.xml"/><worldbody><geom type="plane" size="10 10 .01"/></worldbody></mujoco>');
for (const id of ['foothold-v2', 'ame2-demo']) {
  let complete, calls = 0;
  const delayed = () => { calls++; return new Promise((r) => { complete = r; }); }; delayed.async = true;
  const sim = createSim(mj, '/go2/flat.xml', ISAAC_LIKE, delayed, undefined, id, { ame2DelaySteps: 4 });
  for (const action of ['cancelPolicyStep', 'clearPolicyState', 'reset', 'dispose']) {
    const pending = sim.step(); await Promise.resolve(); assert.equal(sim.step(), false);
    const time = sim.d.time; sim[action](); complete(new Float32Array(12).fill(1));
    assert.equal(await pending, false);
    if (action !== 'dispose') assert.equal(sim.d.time, action === 'reset' ? 0 : time);
  }
  assert.equal(calls, 4);
}
console.log('Policy ONNX async PASS: both adapters, one pending inference, cancel/clear/reset/dispose discard late actions without physics');

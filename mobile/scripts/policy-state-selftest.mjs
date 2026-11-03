// Real simulation applyAction/reset/cancel boundary with controlled inference.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim, ISAAC_LIKE } from '../sim/sim.js';
import { getPolicyAdapter } from '../sim/policy-adapters.js';
import { withPolicyState } from '../sim/policy-onnx.js';
assert.ok(process.env.FH_SIM_SRC, 'FH_SIM_SRC required; no SKIP');
const src = process.env.FH_SIM_SRC;
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const name of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (name.endsWith('.obj')) mj.FS.writeFile('/go2/assets/' + name, readFileSync(join(src, 'assets/unitree_go2/assets', name)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
mj.FS.writeFile('/go2/flat.xml', '<mujoco><include file="go2.xml"/><worldbody><geom type="plane" size="10 10 .01"/></worldbody></mujoco>');
const adapter = getPolicyAdapter(), original = Object.fromEntries(['observe', 'inputs', 'reset', 'commit'].map((k) => [k, adapter[k]]));
const contract = { inputs: [{ name: 'observation', dims: [1,235] }, { name: 'h', dims: [1] }, { name: 'historyTick', dims: [1] }], outputs: [{ name: 'action', dims: [1,12] }, { name: 'next', dims: [1] }], state: [{ in: 'h', out: 'next' }] };
let finish, commits = 0, seen = [];
const policy = withPolicyState((obs, h, historyTick) => {
  seen.push([h[0], historyTick[0]]);
  return new Promise((resolve) => { finish = (expired = false) => resolve(expired ? null : { action: new Float32Array(12), next: Float32Array.of(h[0] + 1) }); });
}, contract);
let sim;
try {
  adapter.reset = (mem) => { mem.ticks = 0; };
  adapter.observe = (obs, s, last, scan, mem) => { original.observe.call(adapter, obs, s, last, scan); mem.ticks++; };
  adapter.inputs = (s, mem, obs) => [obs, [999], [mem.ticks]];
  adapter.commit = () => { commits++; };
  sim = createSim(mj, '/go2/flat.xml', ISAAC_LIKE, policy);
  const step = async (event) => {
    const promise = sim.step(); await Promise.resolve(); assert.equal(sim.step(), false);
    if (event) sim[event]();
    finish(); return promise;
  };
  assert.equal(await step('cancelPolicyStep'), false); assert.equal(commits, 0); assert.equal(sim.t, 0);
  let pending = sim.step(); await Promise.resolve(); finish(true); assert.equal(await pending, false); assert.equal(commits, 0);
  assert.equal(await step(), true); assert.equal(commits, 1); assert.equal(sim.t, .02);
  assert.equal(await step(), true); assert.equal(commits, 2);
  assert.deepEqual(seen, [[0,1], [0,1], [0,1], [1,2]]);
  assert.equal(await step('reset'), false); assert.equal(sim.t, 0);
  assert.equal(await step(), true); assert.deepEqual(seen.at(-1), [0,1]);
  assert.equal(await step('clearPolicyState'), false);
  assert.equal(await step(), true); assert.deepEqual(seen.at(-1), [0,1]);
  console.log('Policy state PASS: real applyAction only commits feedback/history, expiry/cancel/reset/STOP discard candidates, reset zeros hidden state');
} finally {
  sim?.dispose(); await policy.dispose();
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete adapter[key]; else adapter[key] = value; }
}

import assert from 'node:assert/strict';
import { POLICY_MODES, DEFAULT_POLICY_ID, getPolicyMode, registerPolicyModes, PICK_POLICY_IDS, DEFAULT_PICK_POLICY_ID, pickPolicyId } from '../sim/policy-modes.js';
import { readFileSync } from 'node:fs';
import { getPolicyAdapter, POLICY_ADAPTERS } from '../sim/policy-adapters.js';
assert.deepEqual(Object.keys(POLICY_MODES), ['nvidia', 'start', 'ame2', 'go2']);
assert.equal(DEFAULT_POLICY_ID, 'nvidia-demo');
assert.equal(getPolicyMode(), POLICY_MODES.nvidia);
assert.equal(getPolicyMode('foothold-v2'), POLICY_MODES.nvidia);
assert.equal(getPolicyAdapter('foothold-v2'), POLICY_MODES.nvidia);
assert.deepEqual(Object.keys(POLICY_ADAPTERS), ['nvidia-demo', 'start-demo', 'ame2-demo', 'go2-demo']);
for (const unknown of ['', 'nvidia', 'ame2', 'toString', '__proto__', 'FOOTHOLD-V2']) assert.throws(() => getPolicyMode(unknown), /알 수 없는 정책 모드/);
for (const mode of Object.values(POLICY_MODES)) {
  assert.equal(typeof mode.depth, mode.id === 'start-demo' ? 'function' : 'object');
  assert.equal(mode.delay, 0);
  assert.equal(mode.fallback, ['start-demo', 'go2-demo'].includes(mode.id) ? null : mode.network);
  for (const field of ['id', 'label', 'onnx', 'observe', 'map', 'depth', 'command', 'act', 'torque', 'timing', 'delay', 'stop', 'reset', 'fallback']) {
    const missing = { ...mode }; delete missing[field];
    assert.throws(() => registerPolicyModes({ missing }), new RegExp(field), `missing ${field}`);
    assert.throws(() => registerPolicyModes({ missing: { ...mode, [field]: undefined } }), new RegExp(field));
  }
  assert.deepEqual(Array.from(mode.act(new Float32Array(12))), Array.from(mode.action.defaultPose));
}
assert.throws(() => registerPolicyModes({ a: POLICY_MODES.nvidia, b: POLICY_MODES.nvidia }), /중복/);
const broken = { ...POLICY_MODES.nvidia, onnx: { ...POLICY_MODES.nvidia.onnx, sha256: {} } };
assert.throws(() => registerPolicyModes({ broken }), /sha256/);
assert.throws(() => registerPolicyModes({ broken: { ...POLICY_MODES.nvidia, command: { ...POLICY_MODES.nvidia.command, caps: {} } } }), /command.caps.forward/);
// Screen choice (operating decision 2026-11-28): START (m15500) · AME-2 only, START first.
// nvidia-demo stays registered for the Node core and old records but is never picked.
assert.deepEqual(PICK_POLICY_IDS, ['start-demo', 'ame2-demo']);
assert.equal(DEFAULT_PICK_POLICY_ID, 'start-demo');
for (const old of [null, undefined, 'nvidia-demo', 'foothold-v2']) assert.equal(pickPolicyId(old), 'start-demo');
assert.equal(pickPolicyId('ame2-demo'), 'ame2-demo');
assert.equal(pickPolicyId('go2-demo'), 'go2-demo'); // view-only replay still opens from its own link
assert.throws(() => pickPolicyId('bogus'), /알 수 없는 정책 모드/);
const main = readFileSync(new URL('../sim/main.js', import.meta.url), 'utf8');
assert.match(main, /pickPolicyId\(new URLSearchParams\(location\.search\)\.get\('policy'\)\)/);
assert.doesNotMatch(main, /Object\.values\(POLICY_MODES\)\.map\(\(mode\) => new Option/);
console.log('Policy modes PASS: complete registrations, missing/undefined fields rejected, canonical ids/default, one legacy alias, unknown ids rejected');

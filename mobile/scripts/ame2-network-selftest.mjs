// AME2_EXPORT=<local export directory> node mobile/scripts/ame2-network-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadAme2Policy, cropOffsets } from '../sim/ame2-network.js';

assert.ok(process.env.AME2_EXPORT, 'AME2_EXPORT required');
const read = (name) => readFileSync(join(process.env.AME2_EXPORT, name));
const manifest = JSON.parse(read('ame2_actor.json')), check = JSON.parse(read('check.json'));
const bytes = read('ame2_actor.f32'), buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
const policy = loadAme2Policy(buffer, manifest);
assert.throws(() => loadAme2Policy(buffer.slice(4), manifest), /길이/);
const badLayout = structuredClone(manifest); badLayout.tensors[1].shape = [3, 16];
assert.throws(() => loadAme2Policy(buffer, badLayout), /shape/);
const badWeights = buffer.slice(0); new Float32Array(badWeights)[12] = NaN;
assert.throws(() => loadAme2Policy(badWeights, manifest), /유한/);
assert.throws(() => policy(new Float32Array(48), new Float32Array(1131)), /입력/);
for (const [center, offset] of [[[6, 5], [0, 0]], [[7, 6], [2, 2]], [[8, 7], [2, 2]], [[22, 7], [16, 2]]]) assert.deepEqual(cropOffsets(center), offset);
let maxAbs = 0, count = 0;
const times = [];
let firstMs;
for (const [name, group] of Object.entries(check.cases)) {
  let groupMax = 0;
  for (let i = 0; i < group.n; i++) {
    const prop = Float32Array.from(group.prop[i]), map = Float32Array.from(group.mapping[i].flat(2));
    const start = performance.now();
    const out = policy(prop, map, group.forced_centers?.[i]);
    times.push(performance.now() - start);
    firstMs ??= times.at(-1);
    assert.deepEqual(policy.offsets, group.crop_offsets[i], `${name}/${i} crop`);
    assert.ok(out.every(Number.isFinite));
    for (let j = 0; j < 12; j++) groupMax = Math.max(groupMax, Math.abs(out[j] - group.numpy_outputs[i][j]));
    count++;
  }
  console.log(`${name}: n=${group.n}, max_abs=${groupMax}`);
  maxAbs = Math.max(maxAbs, groupMax);
}
assert.equal(count, 274);
assert.ok(maxAbs <= 1e-4, `JS/NumPy max ${maxAbs}`);
times.sort((a, b) => a - b);
console.log(JSON.stringify({ pass: true, count, maxAbs, node: process.version, inferenceMs: { first: firstMs, median: times[times.length >> 1], p95: times[Math.floor(times.length * .95)] }, scope: 'Node CPU; not phone timing' }));

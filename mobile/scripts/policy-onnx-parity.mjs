import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPolicyAdapter } from '../sim/policy-adapters.js';
import { loadOnnxPolicy } from '../sim/policy-onnx.js';
import { comparePolicyCases, benchmarkPolicy } from './policy-onnx-check.mjs';
const dir = 'runs/policy-onnx/out', adapter = getPolicyAdapter();
const read = (name) => readFileSync(join(dir, name));
let t = performance.now();
const buf = read('policy_v2.f32');
const f32 = adapter.loadPolicy(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const input = new Float32Array(235); f32(input);
const f32FirstLoadMs = performance.now() - t;
t = performance.now();
const ort = await import(pathToFileURL(resolve(process.env.POLICY_ORT_NODE)));
const onnx = await loadOnnxPolicy(ort, read('policy_v2.onnx'), adapter.onnx, 'cpu');
const first = performance.now(); await onnx(input);
const result = { node: process.version, f32FirstLoadMs, onnxFirstLoadMs: performance.now() - t, firstInferenceMs: performance.now() - first };
try {
  result.benchmark = await benchmarkPolicy(f32, onnx, input);
  for (const name of ['fixed', 'recorded']) if (existsSync(join(dir, name + '.json'))) result[name] = await comparePolicyCases(f32, onnx, JSON.parse(read(name + '.json')));
  writeFileSync('runs/policy-onnx/parity-node.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (Object.values(result).some((x) => x?.pass === false)) process.exitCode = 1;
} finally { await onnx.dispose(); }

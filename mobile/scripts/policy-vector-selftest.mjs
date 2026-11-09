// Required external assets; nothing is downloaded and no vectors/models are bundled.
// FH_START_SRC, FH_AME2_SRC, FH_AME2_F32_SRC, POLICY_ORT_NODE, FH_ORT_WEB,
// FH_PLAYWRIGHT; optional FH_CHROME and POLICY_VECTOR_REPORT.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPolicyAdapter } from '../sim/policy-adapters.js';
import { loadAme2Policy } from '../sim/ame2-network.js';
import { loadOnnxPolicy, withPolicyState, selectOnnxPolicy } from '../sim/policy-onnx.js';
import { loadWorkerPolicy } from '../sim/policy-worker-client.js';
import { checkPolicyVectors, checkF32Vectors } from '../sim/policy-vector-check.js';
const required = ['FH_START_SRC', 'FH_AME2_SRC', 'FH_AME2_F32_SRC', 'POLICY_ORT_NODE', 'FH_ORT_WEB', 'FH_PLAYWRIGHT'];
for (const name of required) assert.ok(process.env[name], `${name} is required: set the external asset/dependency path; no SKIP`);
const read = (p) => readFileSync(p), json = (p) => JSON.parse(read(p));
const hash = (b) => createHash('sha256').update(b).digest('hex');
const arrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const start = getPolicyAdapter('start-demo').onnx;
assert.deepEqual(start.inputs, json(join(process.env.FH_START_SRC, 'contract.json')).app_onnx.inputs);
const ame2 = getPolicyAdapter('ame2-demo').onnx;
const cases = ['reconstruction', 'gt', 'off'].map((mode) => ({ name: `start/${mode}`, root: process.env.FH_START_SRC,
  tv: json(join(process.env.FH_START_SRC, `test_vectors_flat20_${mode}.json`)), contract: start }));
cases.push({ name: 'ame2/gt', root: process.env.FH_AME2_SRC, tv: json(join(process.env.FH_AME2_SRC, 'test_vectors_flat20.json')), contract: ame2 });
const approved = { 'start-m13000_map_on.onnx': '4799677acdc9fbc22da28fd56fefa3181f24b38b198e3bea02270c1c1cd11d93',
  'start-m13000_map_off.onnx': '8317548f51a046afb537c212eec47a12b2888b6ea049fa84361d83aa8c30849f', [ame2.file]: ame2.sha256[ame2.file] };
for (const c of cases) {
  assert.equal(c.tv.steps, 20); assert.ok(c.tv.tolerance <= 1e-4);
  const [file, sha] = Object.entries(c.tv.onnx)[0];
  assert.equal(sha, approved[file], `${c.name} unapproved model SHA`);
  c.file = file; c.model = read(join(c.root, file));
  assert.equal(hash(c.model), sha, `${c.name} vector/model SHA mismatch`);
  if (c.contract.sha256) assert.equal(sha, typeof c.contract.sha256 === 'string' ? c.contract.sha256 : c.contract.sha256[file]);
  for (const spec of c.contract.inputs) {
    assert.deepEqual(spec.dims, c.tv.input_shapes[spec.name]);
    assert.equal(spec.type ?? 'float32', c.tv.input_types[spec.name] === 'tensor(bool)' ? 'bool' : 'float32');
  }
}
const f32buf = read(join(process.env.FH_AME2_F32_SRC, 'ame2_actor.f32'));
assert.equal(hash(f32buf), getPolicyAdapter('ame2-demo').network.sha256);
const manifest = json(join(process.env.FH_AME2_F32_SRC, 'ame2_actor.json'));
const f32 = loadAme2Policy(arrayBuffer(f32buf), manifest);
// A delayed result must not survive cancellation/reset or consume hidden state.
const stateContract = { inputs: [{ name: 'h', dims: [1] }], outputs: [{ name: 'next', dims: [1] }], state: [{ in: 'h', out: 'next' }] };
let release;
const delayed = withPolicyState((h) => new Promise((r) => { release = () => r({ next: Float32Array.of(h[0] + 1) }); }), stateContract);
for (const event of ['cancel', 'reset']) { const promise = delayed([999]); delayed[event](); release(); assert.equal(await promise, null); }
await delayed.dispose();
// Worker transport: typed bool buffers, all outputs, timeout/drain/cancel.
let transport;
const createWorker = () => (transport = { postMessage(m) { this.packet = m; if (m.type === 'init') queueMicrotask(() => this.onmessage({ data: { type: 'ready', seq: m.seq } })); }, terminate() {} });
const client = await loadWorkerPolicy(new ArrayBuffer(1), { inputs: [{ name: 'flag', dims: [1], type: 'bool' }] }, 'wasm', { createWorker, deadlineMs: 25 });
let pending = client([true]); assert.ok(transport.packet.inputs[0] instanceof Uint8Array);
const outputs = { action: Float32Array.of(2), next: Float32Array.of(3) };
transport.onmessage({ data: { type: 'result', seq: transport.packet.seq, outputs } }); assert.equal(await pending, outputs);
pending = client([false]); client.cancel(); assert.equal(await pending, null); assert.equal(await client([true]), null);
transport.onmessage({ data: { type: 'result', seq: transport.packet.seq, outputs } });
pending = client([true]); assert.equal(await pending, null); // expire
assert.equal(await client([true]), null); transport.onmessage({ data: { type: 'result', seq: transport.packet.seq, outputs } });
await client.dispose();
let reason = '';
const unavailable = { backend: 'wasm', fetchModel: async () => ({ ok: false, status: 404 }), notify: (text) => { reason = text; } };
assert.equal(await selectOnnxPolicy(getPolicyAdapter('ame2-demo'), f32, unavailable), f32);
assert.match(reason, /AME-2 · JS f32 되돌림 중 · ONNX 파일 없음/);
await assert.rejects(selectOnnxPolicy(getPolicyAdapter('ame2-demo'), null, unavailable), /ONNX 사용 불가/);
assert.match(reason, /AME-2 · 정책 잠금 · ONNX 파일 없음/);
const ort = await import(pathToFileURL(resolve(process.env.POLICY_ORT_NODE)));
const result = { node: {}, browser: {}, worker: {}, ame2F32: {}, versions: { node: process.version } };
for (const c of cases) {
  result.node[c.name] = await checkPolicyVectors(await loadOnnxPolicy(ort, c.model, c.contract, 'cpu'), c.contract, c.tv);
  console.log('Node', c.name, JSON.stringify(result.node[c.name]));
}
result.ame2F32.node = checkF32Vectors(f32, cases.at(-1).tv);
const simRoot = resolve('mobile/sim'), ortRoot = resolve(process.env.FH_ORT_WEB);
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Policy vectors</title>'); return; }
  let file;
  if (url.pathname.startsWith('/ort/')) file = join(ortRoot, url.pathname.split('/').at(-1));
  else file = resolve(simRoot, '.' + url.pathname);
  if (!(file.startsWith(simRoot + sep) || file.startsWith(ortRoot + sep))) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' })[extname(file)] ?? 'application/octet-stream'); res.end(read(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  const { chromium } = await import(pathToFileURL(resolve(process.env.FH_PLAYWRIGHT)));
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  result.versions.browser = browser.version();
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (const c of cases) {
    const row = await page.evaluate(async ({ model, contract, tv }) => {
      const { loadOnnxPolicy } = await import('/policy-onnx.js');
      const { loadWorkerPolicy } = await import('/policy-worker-client.js');
      const { checkPolicyVectors } = await import('/policy-vector-check.js');
      const ort = await import('/ort/ort.wasm.min.mjs'); ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmPaths = new URL('/ort/', location.href).href;
      const bytes = Uint8Array.from(atob(model), (c) => c.charCodeAt(0)).buffer;
      const main = await checkPolicyVectors(await loadOnnxPolicy(ort, bytes, contract), contract, tv);
      const worker = await checkPolicyVectors(await loadWorkerPolicy(bytes, contract, 'wasm', { deadlineMs: 60000 }), contract, tv);
      return { main, worker };
    }, { model: c.model.toString('base64'), contract: c.contract, tv: c.tv });
    result.browser[c.name] = row.main; result.worker[c.name] = row.worker;
    console.log('Browser+Worker', c.name, JSON.stringify(row));
  }
  result.ame2F32.browser = await page.evaluate(async ({ weights, manifest, tv }) => {
    const { loadAme2Policy } = await import('/ame2-network.js'); const { checkF32Vectors } = await import('/policy-vector-check.js');
    return checkF32Vectors(loadAme2Policy(Uint8Array.from(atob(weights), (c) => c.charCodeAt(0)).buffer, manifest), tv);
  }, { weights: f32buf.toString('base64'), manifest, tv: cases.at(-1).tv });
  if (process.env.POLICY_VECTOR_REPORT) writeFileSync(process.env.POLICY_VECTOR_REPORT, JSON.stringify(result, null, 2));
  console.log('Policy vector PASS', JSON.stringify(result));
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

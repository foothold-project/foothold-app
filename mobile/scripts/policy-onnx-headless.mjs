// Existing Chrome/Playwright only; one browser, ephemeral loopback, no robot endpoints.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www'), out = resolve('runs/policy-onnx/out');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  let file = resolve(root, '.' + path);
  if (['/fixed.json', '/recorded.json'].includes(path)) file = join(out, path.slice(1));
  else if (path === '/scripts/policy-onnx-check.mjs') file = resolve('mobile/scripts/policy-onnx-check.mjs');
  else if (path === '/sim/test.html') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Policy offline test</title>'); return; }
  else if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/sim/`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const manualOnly = process.argv.includes('--manual-only');
  if (!process.argv.includes('--ui-only') && !manualOnly) {
    const page = await browser.newPage(); await page.goto(base + 'test.html');
    const result = await page.evaluate(async () => {
      const buffer = async (p) => { const r = await fetch(p); if (!r.ok) throw Error(p); return r.arrayBuffer(); };
      const json = async (p) => (await fetch(p)).json();
      const { getPolicyAdapter } = await import('./policy-adapters.js');
      const { loadOnnxPolicy } = await import('./policy-onnx.js');
      const { comparePolicyCases, benchmarkPolicy } = await import('../scripts/policy-onnx-check.mjs');
      const adapter = getPolicyAdapter(), input = new Float32Array(235);
      let t = performance.now(); const f32 = adapter.loadPolicy(await buffer('policy_v2.f32')); f32(input);
      const f32FirstLoadMs = performance.now() - t;
      t = performance.now();
      const ort = await import('./ort/ort.wasm.min.mjs');
      ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmPaths = new URL('./ort/', location.href).href;
      const onnx = await loadOnnxPolicy(ort, await buffer('policy_v2.onnx'), adapter.onnx);
      const first = performance.now(); await onnx(input);
      const metrics = { f32FirstLoadMs, onnxFirstLoadMs: performance.now() - t, firstInferenceMs: performance.now() - first };
      try {
        metrics.benchmark = await benchmarkPolicy(f32, onnx, input);
        metrics.fixed = await comparePolicyCases(f32, onnx, await json('/fixed.json'));
        metrics.recorded = await comparePolicyCases(f32, onnx, await json('/recorded.json'));
        const { default: load } = await import('./mujoco/mujoco.js');
        const { createSim, ISAAC_LIKE } = await import('./sim.js');
        const { comparePolicyWalk, AME2_WALK_MAPS } = await import('./ame2-onnx-walk.js');
        const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
        const bytes = async (p) => new Uint8Array(await buffer(p));
        mj.FS.writeFile('/go2/go2.xml', await bytes('assets/unitree_go2/go2.xml'));
        const meshes = ['base_0','base_1','base_2','base_3','base_4','hip_0','hip_1','thigh_0','thigh_1','thigh_mirror_0','thigh_mirror_1','calf_0','calf_1','calf_mirror_0','calf_mirror_1','foot'];
        for (const f of meshes) mj.FS.writeFile('/go2/assets/' + f + '.obj', await bytes('assets/unitree_go2/assets/' + f + '.obj'));
        metrics.walk = await comparePolicyWalk(mj, createSim, ISAAC_LIKE, f32, onnx, bytes, { adapterId: adapter.id, maps: AME2_WALK_MAPS.slice(0, 5) });
        // Store WASM-recorded observations for a subsequent NumPy reference pass.
        metrics.wasmRecorded = [];
        for (const sample of metrics.walk.observations) metrics.wasmRecorded.push({ ...sample, js_outputs: Array.from(f32(Float32Array.from(sample.observation))), onnx_outputs: Array.from(await onnx(Float32Array.from(sample.observation))) });
        return metrics;
      } finally { await onnx.dispose(); }
    });
    result.browser = browser.version();
    writeFileSync('runs/policy-onnx/browser-wasm.json', JSON.stringify(result));
    writeFileSync('runs/policy-onnx/out/browser-observations.json', JSON.stringify(result.wasmRecorded));
    console.log(JSON.stringify({ ...result, walk: result.walk.records.map(({ trajectories, ...s }) => s), wasmRecorded: result.wasmRecorded.length }));
    assert.ok(result.fixed.pass && result.recorded.pass);
    await page.close();
  }
  const pageErrors = [];
  const open = async (id, backend = 'wasm', configure = async () => {}) => {
    const p = await browser.newPage(); p.setDefaultTimeout(30000); p.on('pageerror', (e) => pageErrors.push(e.message));
    await configure(p);
    await p.goto(base + `index.html?map=warehouse&policy=${id}&policyBackend=${backend}`);
    await p.waitForFunction(() => window.__sim?.ready, null, { timeout: 60000 });
    return p;
  };
  for (const id of ['foothold-v2', 'ame2-demo']) {
    const model = id === 'foothold-v2' ? 'policy_v2.onnx' : 'ame2_actor.onnx';
    // Hold real session.run; prove synchronous cancellation before releasing it.
    for (const event of (manualOnly ? ['manual'] : ['stop', 'blur', 'visibilitychange', 'pagehide', 'reset', 'manual'])) {
      console.log(`${id} lifecycle ${event}`);
      const p = await open(id); assert.match(await p.locator('#policyEngine').textContent(), /ONNX WASM/);
      await p.evaluate(async () => {
        const ort = await import('./ort/ort.wasm.min.mjs'), original = ort.InferenceSession.prototype.run;
        window.__runs = { active: 0, max: 0, release: null, results: [] };
        ort.InferenceSession.prototype.run = async function (...args) {
          __runs.active++; __runs.max = Math.max(__runs.max, __runs.active);
          try { await new Promise((r) => { __runs.release = r; }); return await original.apply(this, args); }
          finally { __runs.active--; }
        };
        const step = __sim.sim.step;
        __sim.sim.step = () => { const r = step(); if (r?.then) r.then((applied) => __runs.results.push(applied)); return r; };
      });
      await p.click('#go'); await p.waitForFunction(() => __runs.active === 1);
      const before = await p.evaluate(() => __sim.sim.t);
      if (event === 'stop') await p.dispatchEvent('#stop', 'pointerdown');
      else if (event === 'reset') await p.click('#reset');
      else if (event === 'manual') {
        assert.equal(await p.evaluate(() => __sim.scenario.start([{ x: __sim.sim.d.qpos[0] + 1, y: __sim.sim.d.qpos[1] }], true)), true);
        await p.keyboard.down('KeyW');
        assert.deepEqual(await p.evaluate(() => [__sim.scenario.active, __sim.scenario.status, __sim.stopped()]), [false, '손 조종', false]);
      }
      else await p.evaluate((ev) => {
        if (ev === 'visibilitychange') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event(ev)); delete document.hidden; }
        else window.dispatchEvent(new Event(ev));
      }, event);
      if (event !== 'manual') {
        assert.equal(await p.evaluate(() => __sim.stopped()), true);
        assert.deepEqual(await p.evaluate(() => __sim.cmd()), id === 'foothold-v2' ? [0, 0, 0] : [0, 0, 0, 1]);
      }
      await p.evaluate(() => __runs.release()); await p.waitForFunction(() => __runs.results.length > 0);
      assert.equal(await p.evaluate(() => __runs.results[0]), false, id + '/' + event);
      assert.equal(await p.evaluate(() => __sim.sim.t), event === 'reset' ? 0 : before);
      assert.equal(await p.evaluate(() => __runs.max), 1);
      if (event === 'manual' && id === 'foothold-v2') assert.ok((await p.evaluate(() => __sim.joy()))[0] > 0);
      await p.close();
    }
    if (manualOnly) continue;
    for (const failure of ['model', 'html', 'runtime', 'wasm', 'hash', 'first', 'run']) {
      console.log(`${id} fallback ${failure}`);
      const p = await open(id, 'wasm', async (p) => {
        const block = (path, status, body) => p.route('**/' + path, (r) => r.fulfill({ status, body }));
        if (failure === 'model') await block(model, 404, 'missing');
        if (failure === 'html') await p.route('**/' + model, (r) => r.fulfill({ status: 200,
          contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><title>SPA fallback</title></html>' }));
        if (failure === 'runtime') await block('ort.wasm.min.mjs', 404, 'missing');
        if (failure === 'wasm') await block('ort-wasm-simd-threaded.wasm', 404, 'missing');
        if (failure === 'hash') await block(model, 200, 'bad model');
        if (failure === 'first') await p.route('**/ort.wasm.min.mjs', async (route) => {
          await route.fulfill({ contentType: 'text/javascript', body: `export * from './ort.wasm.min.mjs?original'; import { InferenceSession } from './ort.wasm.min.mjs?original'; InferenceSession.prototype.run=async()=>{throw Error('injected first inference failure');};` });
        });
      });
      if (failure === 'run') await p.evaluate(async () => { const ort = await import('./ort/ort.wasm.min.mjs'); ort.InferenceSession.prototype.run = async () => { throw Error('injected run failure'); }; });
      await p.click('#go'); await p.waitForFunction(() => __sim.sim.t > .08);
      assert.match(await p.locator('#policyEngine').textContent(), /기본 계산 사용/);
      if (failure === 'html') assert.match(await p.locator('#policyEngine').textContent(), /기본 계산 사용: ONNX 파일 없음 \(f32 JS\)/);
      assert.ok(await p.locator('#policyEngine').isVisible());
      if (failure === 'first') assert.match(await p.locator('#policyEngine').textContent(), /injected first inference failure/);
      assert.equal(await p.evaluate(() => __sim.sim.adapterId), id);
      if (['model', 'html'].includes(failure) && id === 'foothold-v2') {
        await p.keyboard.down('KeyW');
        const start = await p.evaluate(() => Array.from(__sim.sim.d.qpos.slice(0, 2)));
        const time = await p.evaluate(() => __sim.sim.t);
        await p.waitForFunction((t) => __sim.sim.t > t + 1, time);
        const end = await p.evaluate(() => Array.from(__sim.sim.d.qpos.slice(0, 2)));
        assert.ok(Math.hypot(end[0] - start[0], end[1] - start[1]) > .05, 'default f32 moves when ONNX absent');
        await p.screenshot({ path: `runs/policy-onnx/f32-missing-${failure}.png` });
      }
      await p.close();
    }
    const f32 = await open(id, 'f32'); assert.match(await f32.locator('#policyEngine').textContent(), /f32 JS/); await f32.close();
  }
  assert.deepEqual(pageErrors, []);
  console.log(manualOnly ? 'Policy ONNX manual takeover PASS: both adapters, active goal cancelled without lock, hand input retained, late action discarded' : 'Policy ONNX headless PASS: both policies, WASM, one inference, STOP/blur/hidden/pagehide/reset/manual stale discard, file/200-HTML/runtime/wasm/SHA/first/run fallback, visible badge, same adapter and default f32 motion');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

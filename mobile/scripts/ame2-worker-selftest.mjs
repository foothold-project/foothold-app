// Existing local dependencies only; headless Chrome, ephemeral loopback port.
// sync-web first. AME2_EXPORT, POLICY_ONNX_FIXTURES, FH_PLAYWRIGHT required.
// --measure: compare AME2_WORKER_BASE sources with this tree, 30s per policy/path.
// --slow-only: rerun the CPU/delay recovery regression without parity/lifecycle tests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadWorkerPolicy, WORKER_TIMEOUT_LIMIT } from '../sim/policy-worker-client.js';

// Controlled transport: sequence mismatch, timeout, cancellation, no queued work.
let transport;
const fake = () => (transport = {
  sent: [], terminated: false,
  postMessage(message) { this.sent.push(message); if (message.type === 'init') queueMicrotask(() => this.reply({ type: 'ready', seq: message.seq })); },
  terminate() { this.terminated = true; },
  reply(data) { this.onmessage({ data }); },
});
const contract = { inputs: [{ dims: [1] }] };
const client = await loadWorkerPolicy(new ArrayBuffer(1), contract, 'wasm', { deadlineMs: 10, createWorker: fake });
let pending = client([1]);
transport.reply({ type: 'result', seq: 999, action: [99] });
assert.equal(await pending, null);
assert.equal(await client([2]), null);
assert.equal(transport.sent.length, 2);
transport.reply({ type: 'result', seq: 2, action: [99] });
pending = client([3]); client.cancel(); assert.equal(await pending, null);
assert.equal(await client([4]), null);
transport.reply({ type: 'result', seq: 3, action: [99] });
pending = client([5]); transport.reply({ type: 'result', seq: 4, action: [5] });
assert.deepEqual(await pending, [5]);
pending = client([6]);
const blockedAt = performance.now(); while (performance.now() - blockedAt < 15) {} // timer cannot run during this task
transport.reply({ type: 'result', seq: 5, action: [6] });
assert.equal(await pending, null, 'late reply rejected even before overdue timer callback');
await client.dispose(); assert.equal(transport.terminated, true);
let failureSeen = '';
const cancelled = await loadWorkerPolicy(new ArrayBuffer(1), contract, 'wasm', { deadlineMs: 20, createWorker: fake, onFailure: (e) => { failureSeen = e.message; } });
pending = cancelled([1]); cancelled.cancel(); assert.equal(await pending, null);
transport.onerror({ message: 'lost Worker after STOP' });
assert.equal(failureSeen, 'lost Worker after STOP');
await assert.rejects(cancelled([2]), /lost Worker/); await cancelled.dispose();
await assert.rejects(loadWorkerPolicy(new ArrayBuffer(1), contract, 'wasm', { createWorker: () => { throw Error('blocked'); } }), /blocked/);
await assert.rejects(loadWorkerPolicy(new ArrayBuffer(1), contract, 'wasm', { initTimeoutMs: 5, createWorker: () => ({ postMessage() {}, terminate() {} }) }), /초기화 시간 초과/);
const slowClient = await loadWorkerPolicy(new ArrayBuffer(1), contract, 'wasm', { deadlineMs: 1, createWorker: fake });
for (let i = 1; i <= WORKER_TIMEOUT_LIMIT; i++) {
  const result = slowClient([i]);
  if (i === WORKER_TIMEOUT_LIMIT) await assert.rejects(result, /Worker 늦음/);
  else {
    assert.equal(await result, null);
    assert.equal(await slowClient([99]), null, 'no queue between timeout and drain');
    transport.reply({ type: 'result', seq: i + 1, action: [99] });
  }
}
assert.equal(transport.terminated, true); await slowClient.dispose();
console.log('Worker transport PASS: sequence/timeout/cancel/drain/no queue/create failure/init timeout');

const root = resolve('mobile/www'), out = resolve('runs/ame2-worker'); mkdirSync(out, { recursive: true });
const before = new Map();
const measure = process.argv.includes('--measure') || process.argv.includes('--measure-only');
if (measure) {
  assert.ok(process.env.AME2_WORKER_BASE, 'AME2_WORKER_BASE required for measured baseline');
  for (const name of ['main.js', 'sim.js', 'policy-onnx.js']) before.set(name,
    execFileSync('git', ['show', `${process.env.AME2_WORKER_BASE}:mobile/sim/${name}`], { encoding: 'utf8' }));
}
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const baseline = path.startsWith('/before/');
  const relative = baseline ? path.slice('/before'.length) : path;
  let file = resolve(root, '.' + relative);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  if (relative.startsWith('/fixtures/ame2/')) file = join(process.env.AME2_EXPORT, relative.split('/').at(-1));
  if (relative.startsWith('/fixtures/v2/')) file = join(process.env.POLICY_ONNX_FIXTURES, relative.split('/').at(-1));
  try {
    let body = baseline && before.has(relative.split('/').at(-1)) ? before.get(relative.split('/').at(-1)) : readFileSync(file);
    if (relative.endsWith('/policy-onnx.js')) {
      // Main inference latency, excluding observation/physics/render.
      body = String(body).replace('try { return await onnx(...args); }',
        "try { const t=performance.now(); const a=await onnx(...args); if(a && (typeof inWorker === 'undefined' || !inWorker)) globalThis.__inferenceTimes?.push(performance.now()-t); return a; }");
    }
    if (relative.endsWith('/policy-worker-client.js')) {
      // Actual Worker roundtrip, including responses discarded after 20ms.
      // Measuring only accepted actions would censor the slow observations.
      body = String(body).replace('const request = active;',
        "const request = active; if(request.reply === 'result') globalThis.__inferenceTimes?.push(performance.now()-request.started);");
    }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  if (!process.argv.includes('--measure-only')) {
  if (!process.argv.includes('--slow-only')) {
  const page = await browser.newPage();
  await page.goto(base + '/sim/index.html?policyBackend=f32'); await page.waitForFunction(() => window.__sim?.ready);
  const parity = await page.evaluate(async () => {
    const { getPolicyAdapter } = await import('./policy-adapters.js');
    const { loadOnnxPolicy } = await import('./policy-onnx.js');
    const { loadWorkerPolicy } = await import('./policy-worker-client.js');
    const { fixedAme2Cases } = await import('./ame2-onnx-check.js');
    const ort = await import('./ort/ort.wasm.min.mjs');
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmPaths = new URL('./ort/', location.href).href;
    const json = async (p) => (await fetch(p)).json(), results = [];
    for (const id of ['foothold-v2', 'ame2-demo']) {
      const adapter = getPolicyAdapter(id), model = await (await fetch(adapter.onnx.file)).arrayBuffer();
      const main = await loadOnnxPolicy(ort, model, adapter.onnx);
      // Parity is deliberately independent of the 20ms simulation budget.
      const worker = await loadWorkerPolicy(model, adapter.onnx, 'wasm', { deadlineMs: 60000 });
      const groups = id === 'ame2-demo' ? [fixedAme2Cases(await json('/fixtures/ame2/check.json')), await json('/fixtures/ame2/onnx-observations.json')]
        : [await json('/fixtures/v2/fixed.json'), await json('/fixtures/v2/recorded.json')];
      let maxAbs = 0, n = 0;
      try {
        for (const samples of groups) for (const sample of samples) {
          const args = id === 'ame2-demo' ? [sample.prop, sample.mapping] : [sample.observation];
          const a = await main(...args), b = await worker(...args);
          if (!b) throw Error('parity result missing');
          for (let i = 0; i < a.length; i++) { if (!Number.isFinite(b[i])) throw Error('nonfinite'); maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i])); }
          n++;
        }
      } finally { await main.dispose(); await worker.dispose(); }
      results.push({ id, n, maxAbs });
    }
    return results;
  });
  for (const row of parity) assert.ok(row.maxAbs <= 1e-5, JSON.stringify(row));
  writeFileSync(join(out, 'parity.json'), JSON.stringify(parity)); console.log('Worker parity', JSON.stringify(parity));
  await page.close();

  for (const id of ['foothold-v2', 'ame2-demo']) {
    for (const event of ['stop', 'blur', 'visibilitychange', 'pagehide', 'freeze', 'reset', 'manual', 'policy', 'timeout']) {
      const p = await browser.newPage();
      await p.goto(base + `/sim/index.html?policy=${id}`); await p.waitForFunction(() => window.__sim?.ready);
      assert.match(await p.locator('#policyEngine').textContent(), /ONNX WASM · Worker/); // actual page CSP
      // foothold-v2 also evaluates neutral commands while locked. Drain that
      // frame request before holding exactly one explicit simulation step.
      await p.evaluate(() => { window.originalStep = __sim.sim.step; __sim.sim.step = () => false; });
      await p.waitForTimeout(75);
      const worker = p.workers().find((w) => w.url().endsWith('/policy-worker.js')); assert.ok(worker);
      await worker.evaluate(async () => {
        const ort = await import('./ort/ort.wasm.min.mjs'), run = ort.InferenceSession.prototype.run;
        self.held = 0; self.maxHeld = 0;
        ort.InferenceSession.prototype.run = async function (...args) {
          self.held++; self.maxHeld = Math.max(self.maxHeld, self.held);
          try { await new Promise((r) => { self.release = r; }); return await run.apply(this, args); }
          finally { self.held--; }
        };
      });
      // Run one real sim request, without a frame issuing another after discard.
      await p.evaluate(() => { originalStep().then((v) => { window.stepApplied = v; }); });
      // A Worker evaluation is serialized behind message dispatch, not its held await.
      await worker.evaluate(() => { if (self.held !== 1) throw Error('no held inference'); });
      const beforeTime = await p.evaluate(() => __sim.sim.t);
      if (event === 'stop') await p.dispatchEvent('#stop', 'pointerdown');
      else if (event === 'reset') await p.click('#reset');
      else if (event === 'manual') await p.keyboard.down('KeyW');
      else if (event === 'policy') {
        const next = id === 'ame2-demo' ? 'foothold-v2' : 'ame2-demo';
        await p.evaluate((next) => { const choice = document.querySelector('#policySelect'); choice.value = next; choice.dispatchEvent(new Event('change')); }, next);
        await p.waitForFunction((next) => window.__sim?.ready && __sim.sim.adapterId === next, next);
        assert.equal(await p.evaluate(() => __sim.stopped()), true);
        assert.deepEqual(await p.evaluate(() => __sim.joy()), next === 'ame2-demo' ? [0, 0, 0, 1] : [0, 0, 0]);
        await p.close(); console.log(`${id} Worker discard policy PASS`); continue;
      } else if (event === 'timeout') await p.waitForTimeout(50);
      else await p.evaluate((ev) => {
        if (ev === 'visibilitychange') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event(ev)); delete document.hidden; }
        else window.dispatchEvent(new Event(ev));
      }, event);
      await worker.evaluate(() => self.release());
      await p.waitForFunction(() => window.stepApplied === false);
      assert.equal(await p.evaluate(() => __sim.sim.t), event === 'reset' ? 0 : beforeTime);
      assert.equal(await worker.evaluate(() => self.maxHeld), 1);
      if (!['manual', 'timeout'].includes(event)) {
        assert.equal(await p.evaluate(() => __sim.stopped()), true);
        await p.click('#go');
        assert.deepEqual(await p.evaluate(() => __sim.joy()), id === 'ame2-demo' ? [0, 0, 0, 1] : [0, 0, 0]);
      }
      await p.close(); console.log(`${id} Worker discard ${event} PASS`);
    }
    for (const failure of ['create', 'csp', 'script', 'worker-runtime', 'runtime', 'run', 'hash']) {
      const p = await browser.newPage();
      if (failure === 'create') await p.addInitScript(() => { window.Worker = class { constructor() { throw Error('Worker blocked'); } }; });
      if (failure === 'csp') await p.route('**/index.html?*', (r) => r.fulfill({ contentType: 'text/html',
        headers: { 'Content-Security-Policy': "worker-src 'none'" }, body: readFileSync(join(root, 'sim/index.html')) }));
      if (['script', 'worker-runtime', 'runtime'].includes(failure)) await p.route('**/' + (failure === 'script' ? 'policy-worker.js' : 'ort.wasm.min.mjs'), (r) => {
        // Worker-only loader failure must recover through main ONNX.
        const inWorker = r.request().headers().referer?.includes('/policy-worker.js');
        if (failure !== 'worker-runtime' || inWorker) return r.fulfill({ status: 404, body: 'missing' });
        return r.continue();
      });
      if (failure === 'hash') await p.route('**/' + (id === 'ame2-demo' ? 'ame2_actor.onnx' : 'policy_v2.onnx'), (r) => r.fulfill({ body: 'bad model' }));
      await p.goto(base + `/sim/index.html?policy=${id}`); await p.waitForFunction(() => window.__sim?.ready);
      if (failure === 'run') {
        await p.evaluate(() => { window.originalStep = __sim.sim.step; __sim.sim.step = () => false; }); await p.waitForTimeout(75);
        const worker = p.workers().find((w) => w.url().endsWith('/policy-worker.js'));
        await worker.evaluate(async () => { const ort = await import('./ort/ort.wasm.min.mjs'); ort.InferenceSession.prototype.run = async () => { throw Error('Worker run failure'); }; });
        await p.evaluate(() => originalStep());
      }
      const badge = await p.locator('#policyEngine').textContent();
      assert.match(badge, ['runtime', 'hash'].includes(failure) ? /기본 계산 사용/ : /화면 계산.*Worker 사용 불가/);
      assert.ok(await p.locator('#policyEngine').isVisible());
      assert.equal(await p.evaluate(() => __sim.sim.adapterId), id);
      await p.close(); console.log(`${id} Worker fallback ${failure} PASS`);
    }
  }
  }
  const slowResults = [];
  for (const id of ['foothold-v2', 'ame2-demo']) {
    for (const scenario of [{ cpu: 1, delay: 35 }, { cpu: 4, delay: 0 }, { cpu: 6, delay: 0 }]) {
      const p = await browser.newPage();
      await p.goto(base + `/sim/index.html?policy=${id}`); await p.waitForFunction(() => window.__sim?.ready);
      await p.evaluate(() => { window.originalStep = __sim.sim.step; __sim.sim.step = () => false; }); await p.waitForTimeout(75);
      await p.evaluate(() => __sim.sim.cancelPolicyStep()); // start a fresh consecutive-timeout window
      const w = p.workers().find((w) => w.url().endsWith('/policy-worker.js')); assert.ok(w);
      if (scenario.delay) await w.evaluate(async (delay) => {
        const ort = await import('./ort/ort.wasm.min.mjs'), run = ort.InferenceSession.prototype.run;
        ort.InferenceSession.prototype.run = async function (...args) { await new Promise((r) => setTimeout(r, delay)); return run.apply(this, args); };
      }, scenario.delay);
      await p.evaluate(async () => {
        const ort = await import('./ort/ort.wasm.min.mjs'), run = ort.InferenceSession.prototype.run;
        // Main recovery must apply despite this additional >20ms latency.
        ort.InferenceSession.prototype.run = async function (...args) {
          if (window.holdMain) await new Promise((r) => { window.releaseMain = r; });
          else await new Promise((r) => setTimeout(r, 35));
          return run.apply(this, args);
        };
        window.slowBadges = [];
        new MutationObserver(() => {
          const text = document.querySelector('#policyEngine').textContent;
          if (text.includes('Worker 늦음 → 화면 계산') && slowBadges.at(-1) !== text) slowBadges.push(text);
        }).observe(document.querySelector('#policyEngine'), { childList: true, subtree: true, characterData: true });
      });
      const cdp = await p.context().newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: scenario.cpu });
      let applied = 0, attempts = 0, badge;
      for (; attempts < WORKER_TIMEOUT_LIMIT;) {
        attempts++;
        if (await p.evaluate(() => originalStep())) applied++;
        badge = await p.locator('#policyEngine').textContent();
        if (applied || badge.includes('Worker 늦음 → 화면 계산')) break;
        await p.waitForTimeout(75); // drain the single late job; no queued requests
      }
      assert.ok(applied > 0 || badge.includes('Worker 늦음 → 화면 계산'), `${id}/${JSON.stringify(scenario)} stalled after ${attempts} steps`);
      if (scenario.delay) {
        assert.equal(attempts, WORKER_TIMEOUT_LIMIT); assert.equal(applied, 1);
        assert.match(badge, /Worker 늦음 → 화면 계산/);
        assert.equal(await p.evaluate(() => slowBadges.length), 1);
        assert.equal(await p.evaluate(() => originalStep()), true, 'late main ONNX applies after Worker recovery');
        await p.evaluate(() => { window.holdMain = true; originalStep().then((a) => { window.lateMainApplied = a; }); });
        await p.waitForFunction(() => typeof window.releaseMain === 'function');
        const time = await p.evaluate(() => __sim.sim.t);
        await p.dispatchEvent('#stop', 'pointerdown'); await p.evaluate(() => releaseMain());
        await p.waitForFunction(() => window.lateMainApplied === false);
        assert.equal(await p.evaluate(() => __sim.sim.t), time, 'STOP invalidates delayed recovered main result');
        await p.click('#go'); assert.deepEqual(await p.evaluate(() => __sim.joy()), id === 'ame2-demo' ? [0, 0, 0, 1] : [0, 0, 0]);
      }
      const result = { id, ...scenario, attempts, applied, badge }; slowResults.push(result); console.log('Worker slow recovery PASS', JSON.stringify(result));
      await p.close();
    }
    const p = await browser.newPage();
    await p.addInitScript(() => { window.Worker = class { constructor() { throw Error('Worker blocked'); } }; });
    await p.goto(base + `/sim/index.html?policy=${id}`); await p.waitForFunction(() => window.__sim?.ready);
    await p.evaluate(() => { window.originalStep = __sim.sim.step; __sim.sim.step = () => false; }); await p.waitForTimeout(75);
    await p.evaluate(async () => {
      const ort = await import('./ort/ort.wasm.min.mjs'), run = ort.InferenceSession.prototype.run;
      ort.InferenceSession.prototype.run = async function (...args) { await new Promise((r) => setTimeout(r, 35)); return run.apply(this, args); };
    });
    assert.equal(await p.evaluate(() => originalStep()), true, 'Worker creation failure: delayed main ONNX applies');
    await p.evaluate(async () => {
      const ort = await import('./ort/ort.wasm.min.mjs');
      ort.InferenceSession.prototype.run = async () => { await new Promise((r) => setTimeout(r, 35)); throw Error('delayed main failure'); };
    });
    assert.equal(await p.evaluate(() => originalStep()), true, 'late main failure: f32 recovery applies');
    assert.match(await p.locator('#policyEngine').textContent(), /기본 계산 사용.*f32 JS/);
    await p.close(); console.log(`${id} delayed main/f32 fallback PASS`);
  }
  writeFileSync(join(out, 'slow-recovery.json'), JSON.stringify(slowResults, null, 2));
  }
  if (measure) {
    const metrics = [];
    for (const id of ['foothold-v2', 'ame2-demo']) for (const version of ['before', 'after']) {
      const p = await browser.newPage({ viewport: { width: 960, height: 720 } });
      await p.goto(base + `${version === 'before' ? '/before' : ''}/sim/index.html?map=warehouse&policy=${id}`);
      await p.waitForFunction(() => window.__sim?.ready);
      assert.match(await p.locator('#policyEngine').textContent(), version === 'after' ? /Worker/ : /ONNX WASM/);
      await p.click('#go'); await p.keyboard.down('KeyW'); await p.waitForTimeout(2000);
      const result = await p.evaluate(() => new Promise((resolve) => {
        const frames = [], longs = []; globalThis.__inferenceTimes = [];
        const observer = new PerformanceObserver((list) => longs.push(...list.getEntries().map((e) => e.duration)));
        observer.observe({ type: 'longtask' });
        let previous = performance.now(), alive = true;
        const frame = (t) => { if (!alive) return; frames.push(t - previous); previous = t; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        setTimeout(() => {
          alive = false; longs.push(...observer.takeRecords().map((e) => e.duration)); observer.disconnect();
          const p95 = (a) => { a.sort((a, b) => a - b); return a.length ? a[Math.floor(a.length * .95)] : null; };
          resolve({ durationMs: 30000, longTasksOver50ms: longs.filter((x) => x > 50).length, frameIntervalP95Ms: p95(frames), inferenceP95Ms: p95(globalThis.__inferenceTimes), frames: frames.length, inferenceResults: globalThis.__inferenceTimes.length });
        }, 30000);
      }));
      metrics.push({ id, version, ...result }); console.log('Worker measurement', JSON.stringify(metrics.at(-1)));
      await p.close();
    }
    writeFileSync(join(out, 'metrics.json'), JSON.stringify({ browser: browser.version(), baseline: process.env.AME2_WORKER_BASE, map: 'warehouse', input: 'KeyW held after go', gpu: 'ANGLE SwiftShader', metrics }, null, 2));
  }
  console.log(process.argv.includes('--measure-only') ? 'Worker measurement complete' : process.argv.includes('--slow-only') ? 'Worker slow recovery PASS: both adapters, delay/CPU/main/f32/STOP' : 'Worker headless PASS: both adapters, real CSP, parity, lifecycle/deadline discard, visible main ONNX/f32 fallback, delay/CPU recovery');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

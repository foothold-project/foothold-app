// Existing assets/dependencies only; headless Chrome, ephemeral loopback HTTP.
// FH_SIM_SRC=<bundle dependencies> AME2_EXPORT=<private export> FH_PLAYWRIGHT=<index.mjs>
// node mobile/scripts/ame2-perf.mjs [--compare=directory | --baseline=directory] [--seconds=12]
// Baseline directory contains the old ame2-network.js and policy-adapters.js.
// Measurements are injected into HTTP responses; production main.js stays untouched.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, loadavg } from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const seconds = Number(args.seconds ?? 12);
const angle = args.angle ?? 'gl';
assert.ok(['gl', 'vulkan', 'swiftshader'].includes(angle));
assert.ok(seconds >= 5 && seconds <= 120);
assert.ok(process.env.FH_SIM_SRC && process.env.AME2_EXPORT && process.env.FH_PLAYWRIGHT);
const root = resolve('mobile/sim'), src = resolve(process.env.FH_SIM_SRC);
assert.ok(!(args.baseline && args.compare));
const baseline = (args.baseline || args.compare) && resolve(args.baseline || args.compare);
let useBaseline = !!args.baseline;
const { chromium } = await import(pathToFileURL(resolve(process.env.FH_PLAYWRIGHT)));
const mime = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' };
const replace = (s, from, to) => { assert.ok(s.includes(from), `instrumentation anchor: ${from}`); return s.replace(from, to); };
const metrics = `window.__perf = { network: [], height: [], physics4: [], step: [], draw: [], frameInterval: [], frames: 0 };`;
const server = createServer((req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    assert.ok(pathname.startsWith('/sim/'));
    const rel = decodeURIComponent(pathname.slice(5)), local = resolve(root, rel);
    assert.ok(local.startsWith(root + sep));
    let file = local;
    if (useBaseline && ['ame2-network.js', 'policy-adapters.js'].includes(rel)) file = join(baseline, rel);
    else if (['ame2_actor.json', 'ame2_actor.f32'].includes(rel)) file = join(process.env.AME2_EXPORT, rel);
    else if (!existsSync(file)) file = resolve(src, rel.startsWith('mujoco/') ? `node_modules/@mujoco/${rel}` : rel);
    let body = readFileSync(file);
    if (rel === 'sim.js') {
      let s = body.toString();
      s = replace(s, 'const sampleHeight = adapter.makeHeightScanner(mj, m, d, world);', `const originalSample = adapter.makeHeightScanner(mj, m, d, world);
        const sampleHeight = (...args) => { const t = performance.now(); const r = originalSample(...args); window.__perf.height.push(performance.now() - t); return r; };
        sampleHeight.dispose = originalSample.dispose;`);
      s = replace(s, 'const a = policy(obs, s.mapping);', `const networkStart = performance.now(); const a = policy(obs, s.mapping); window.__perf.network.push(performance.now() - networkStart);`);
      s = replace(s, 's.t += POLICY_DT;', 'window.__perf.physics4.push(s.physMs); s.t += POLICY_DT;');
      body = s;
    }
    if (rel === 'main.js') {
      let s = body.toString();
      s = replace(s, 'const st = (window.__sim', `${metrics}\nconst st = (window.__sim`);
      // Replay identical initial pose every tick: both policies remain active even
      // if the demo teacher falls. Reset work is outside step, inside frame time.
      s = replace(s, '  sim.hold(0.5);\n  ready = true;', `sim.hold(0.5);
        const originalStep = sim.step;
        sim.step = () => { sim.reset(); const t = performance.now(); originalStep(); window.__perf.step.push(performance.now() - t); };
        ready = true;`);
      s = replace(s, 'draw();', 'const drawStart = performance.now(); draw();');
      s = replace(s, 'acc += Math.min((now - lastT)', 'window.__perf.frameInterval.push(now - lastT); acc += Math.min((now - lastT)');
      s = replace(s, 'renderer.render(scene, camera);', 'renderer.render(scene, camera); window.__perf.draw.push(performance.now() - drawStart); window.__perf.frames++;');
      body = s;
    }
    res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch (e) { res.writeHead(404); res.end(String(e.message)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
const stats = (a) => {
  assert.ok(a.length, 'nonempty metric');
  const s = [...a].sort((a, b) => a - b);
  return { n: s.length, median: +s[s.length >> 1].toFixed(3), p95: +s[Math.floor(s.length * .95)].toFixed(3) };
};
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', `--use-angle=${angle}`] });
  for (const rate of [1, 4]) for (const policy of ['ame2-demo', 'foothold-v2']) for (const version of args.compare ? ['before', 'after'] : [useBaseline ? 'before' : 'after']) {
    useBaseline = version === 'before';
    const hostLoadBefore = loadavg();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse&policy=${policy}`);
    await page.waitForFunction(() => window.__sim?.ready, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => __sim.sim.adapterId), policy);
    const renderer = await page.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    });
    await page.click('#go');
    await page.waitForTimeout(4000); // JIT / wasm / renderer warmup, excluded.
    const start = await page.evaluate(() => {
      for (const key of ['network', 'height', 'physics4', 'step', 'draw', 'frameInterval']) __perf[key].length = 0;
      __perf.frames = 0;
      return { t: performance.now(), behind: __sim.stepsBehind, steps: __sim.steps };
    });
    await page.waitForTimeout(seconds * 1000);
    const result = await page.evaluate(() => ({ ...__perf, elapsed: performance.now(), behind: __sim.stepsBehind, steps: __sim.steps, fell: __sim.sim.fell }));
    assert.deepEqual(errors, []);
    const elapsed = (result.elapsed - start.t) / 1000;
    console.log(JSON.stringify({ version, policy, cpuRate: rate, browser: browser.version(), cpu: cpus()[0].model, hostLoadBefore, hostLoadAfter: loadavg(),
      viewport: '1280x720', renderer, drawMeaning: 'CPU scene/camera update and renderer submission; GPU completion is asynchronous', workload: 'warehouse, neutral, initial-pose replay each policy tick; reset excluded from step but included in scheduler',
      elapsedSeconds: +elapsed.toFixed(2), metricsMs: Object.fromEntries(['network', 'height', 'physics4', 'step', 'draw', 'frameInterval'].map((k) => [k, stats(result[k])])),
      stepsBehind: result.behind - start.behind, frames: result.frames, steps: result.steps - start.steps,
      behindPerSecond: +((result.behind - start.behind) / elapsed).toFixed(3),
      behindFramePercent: +(100 * (result.behind - start.behind) / result.frames).toFixed(2) }));
    await page.close();
  }
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

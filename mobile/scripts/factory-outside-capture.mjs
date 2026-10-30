// Headless real keyboard → joy → policy → physics, with intercepted local files.
// No listening port, visible browser, server, robot, or external network.
// FH_SIM_SRC=<deps> AME2_EXPORT=<export> FH_PLAYWRIGHT=<index.mjs> FH_CAPTURE_DIR=<outside repo> node mobile/scripts/factory-outside-capture.mjs
// Optional FH_SIM_MODULE=<baseline sim.js>, FH_FACTORY_XML=<old f1.xml>.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const repo = resolve(new URL('../..', import.meta.url).pathname), assets = resolve(process.env.FH_SIM_SRC), ame = resolve(process.env.AME2_EXPORT);
const out = resolve(process.env.FH_CAPTURE_DIR);
const policies = process.env.FH_POLICY ? [process.env.FH_POLICY] : ['foothold-v2', 'ame2-demo'];
assert.ok(policies.every((id) => ['foothold-v2', 'ame2-demo'].includes(id)), 'known FH_POLICY required');
assert.ok(out !== repo && !out.startsWith(repo + sep), 'Capture directory must be outside repository');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
try {
  for (const policy of policies) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== 'http://factory.localhost') return route.abort();
      const rel = decodeURIComponent(u.pathname).replace(/^\/sim\//, '');
      let root = resolve(repo, 'mobile/sim'), file = resolve(root, rel);
      if (rel.startsWith('vendor/') || rel.startsWith('assets/unitree_go2/') || rel === 'policy_v2.f32') { root = assets; file = resolve(root, rel); }
      if (rel.startsWith('mujoco/')) { root = resolve(assets, 'node_modules/@mujoco/mujoco'); file = resolve(root, rel.slice(7)); }
      if (rel === 'ame2_actor.f32' || rel === 'ame2_actor.json') { root = ame; file = resolve(root, rel); }
      if (!file.startsWith(root + sep)) return route.abort();
      if (rel === 'sim.js' && process.env.FH_SIM_MODULE) file = resolve(process.env.FH_SIM_MODULE);
      if (rel === 'assets/factory-zone/factory-zone.xml' && process.env.FH_FACTORY_XML) file = resolve(process.env.FH_FACTORY_XML);
      try { await route.fulfill({ body: readFileSync(file), contentType: ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream' }); }
      catch { await route.fulfill({ status: 404, body: 'missing' }); }
    });
    await page.goto(`http://factory.localhost/sim/index.html?map=factory-zone&policy=${policy}`);
    await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => __sim.err), null);
    assert.equal(await page.evaluate(() => __sim.sim.adapterId), policy);
    await page.click('#cam');
    // Only initial placement is changed: start on the apron at the pictured ramp.
    // All subsequent movement uses real keyboard events and the existing UI loop.
    await page.evaluate(() => {
      const s = __sim.sim, q = s.d.qpos;
      q[0] = 19; q[1] = -1.3; q[2] = .4; q[3] = Math.SQRT1_2; q[4] = q[5] = 0; q[6] = -Math.SQRT1_2;
      s.d.qvel.fill(0); s.hold(.5);
    });
    const state = () => page.evaluate(() => ({ xyz: Array.from(__sim.sim.d.qpos.slice(0, 3)), clearance: __sim.sim.z, grav: __sim.sim.grav[2], fell: __sim.sim.fell,
      joy: __sim.joy(), cmd: __sim.cmd(), stopped: __sim.stopped(), seconds: __sim.sim.t, steps: __sim.steps, camera: __sim.cam() }));
    // Follow camera lerps from the initial top view; settle before driving.
    await page.waitForFunction(() => Math.abs(__sim.cam()[2] - __sim.sim.d.qpos[2] - .75) < .05, null, { timeout: 60000 });
    console.log(JSON.stringify({ policy, stage: 'ramp-start', ...await state() }));
    await page.click('#go'); await page.keyboard.down('ArrowUp');
    await page.waitForFunction(() => __sim.sim.d.qpos[1] < -7 || __sim.sim.fell || __sim.sim.t > 25, null, { timeout: 180000 });
    const outside = await state();
    console.log(JSON.stringify({ policy, stage: 'outside', ...outside }));
    await page.screenshot({ path: resolve(out, `${policy}-outside.png`) });
    await page.keyboard.up('ArrowUp'); await page.keyboard.press('Escape');
    const stopped = await state();
    assert.equal(stopped.stopped, true);
    assert.deepEqual(stopped.cmd, policy === 'ame2-demo' ? [0, 0, 0, 1] : [0, 0, 0]);
    results.push({ policy, outside, stopped, errors });
    writeFileSync(resolve(out, 'capture.json'), JSON.stringify({ headless: true, network: 'intercepted local files; no listener', results }, null, 2));
    assert.equal(outside.fell, false, `${policy}: key/joy descent must not latch a false fall`);
    assert.ok(outside.xyz[1] < -7 && outside.xyz[2] < -.2, `${policy}: walked onto lower outdoor ground`);
    assert.equal(outside.joy[0], 1, `${policy}: actual full-forward key input`);
    assert.ok(outside.clearance > .18 && outside.grav < -.5);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`factory outside keyboard headless PASS: both policies, real key→joy descent, STOP zero/lock; captures ${out}`);
} finally { await browser.close(); }

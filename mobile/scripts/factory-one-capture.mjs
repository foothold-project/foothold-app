// Headless captures through intercepted local requests: no listening port/server/window.
// FH_SIM_SRC=<deps> FH_PLAYWRIGHT=<existing playwright-core/index.mjs> FH_CAPTURE_DIR=<outside repo> node mobile/scripts/factory-one-capture.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const repo = resolve(new URL('../..', import.meta.url).pathname), assets = resolve(process.env.FH_SIM_SRC);
const out = resolve(process.env.FH_CAPTURE_DIR);
assert.ok(!out.startsWith(repo + sep), 'Capture directory must be outside repository');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== 'http://factory.invalid') return route.abort();
    const rel = decodeURIComponent(u.pathname).replace(/^\/sim\//, '');
    let root = resolve(repo, 'mobile/sim'), file = resolve(root, rel);
    if (rel.startsWith('vendor/') || rel.startsWith('assets/unitree_go2/') || rel === 'policy_v2.f32') { root = assets; file = resolve(root, rel); }
    if (rel.startsWith('mujoco/')) { root = resolve(assets, 'node_modules/@mujoco/mujoco'); file = resolve(root, rel.slice(7)); }
    if (!file.startsWith(root + sep)) return route.abort();
    try { await route.fulfill({ body: readFileSync(file), contentType: ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream' }); }
    catch { await route.fulfill({ status: 404, body: 'missing' }); }
  });
  await page.goto('http://factory.invalid/sim/index.html?map=factory-zone');
  await page.waitForFunction(() => __sim?.ready || __sim?.err, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => __sim.err), null);
  await page.screenshot({ path: resolve(out, 'whole-world.png') });
  await page.click('#cam');
  // Follow view, first-floor robot at the east stair entrance facing toward the deck.
  await page.evaluate(() => { const s = __sim.sim, q = s.d.qpos; q[0] = 27.5; q[1] = 3.8; q[2] = .4; q[3] = 0; q[4] = q[5] = 0; q[6] = 1; s.d.qvel.fill(0); s.hold(.5); });
  await page.mouse.move(600, 400); await page.mouse.wheel(0, 150);
  await page.evaluate(() => new Promise((ok) => { let n = 0; const frame = () => ++n >= 12 ? ok() : requestAnimationFrame(frame); requestAnimationFrame(frame); }));
  await page.screenshot({ path: resolve(out, 'f1-stair-to-f2.png') });
  const firstFloor = await page.evaluate(() => ({ qpos: Array.from(__sim.sim.d.qpos.slice(0, 7)), camera: __sim.cam(), fell: __sim.sim.fell }));
  // Side view from ground level: slab, upper rail and walls in the same image.
  await page.evaluate(() => { const s = __sim.sim, q = s.d.qpos; q[0] = 24.5; q[1] = 6.25; q[2] = .4; q[3] = 0; q[4] = q[5] = 0; q[6] = 1; s.d.qvel.fill(0); s.fell = false; s.hold(.5); });
  await page.mouse.move(600, 400); await page.mouse.down(); await page.mouse.move(600, 339, { steps: 5 }); await page.mouse.up();
  await page.mouse.wheel(0, 480);
  await page.evaluate(() => new Promise((ok) => { let n = 0; const frame = () => ++n >= 12 ? ok() : requestAnimationFrame(frame); requestAnimationFrame(frame); }));
  await page.screenshot({ path: resolve(out, 'f1-deck-side.png') });
  const groundSide = await page.evaluate(() => ({ qpos: Array.from(__sim.sim.d.qpos.slice(0, 7)), camera: __sim.cam(), fell: __sim.sim.fell }));

  await page.evaluate(() => { const s = __sim.sim, q = s.d.qpos; q[0] = 5.65; q[1] = 4.65; q[2] = 2.4; q[3] = 1; q[4] = q[5] = q[6] = 0; s.d.qvel.fill(0); s.fell = false; s.hold(.5); });
  await page.evaluate(() => new Promise((ok) => { let n = 0; const frame = () => ++n >= 12 ? ok() : requestAnimationFrame(frame); requestAnimationFrame(frame); }));
  await page.screenshot({ path: resolve(out, 'f2-deck.png') });
  const secondFloor = await page.evaluate(() => ({ qpos: Array.from(__sim.sim.d.qpos.slice(0, 7)), camera: __sim.cam(), fell: __sim.sim.fell }));
  assert.deepEqual(errors, []);
  writeFileSync(resolve(out, 'capture.json'), JSON.stringify({ headless: true, network: 'all requests intercepted from local files; no listening port', firstFloor, groundSide, secondFloor, errors }, null, 2));
  console.log(`Headless captures: ${out}; page errors=0`);
} finally { await browser.close(); }

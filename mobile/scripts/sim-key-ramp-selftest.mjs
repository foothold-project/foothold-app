// Fast command regression; --headless also checks real handlers and measures
// warehouse ArrowUp for 3 simulation seconds, before/after in the same browser.
// After sync-web, run --headless under the shared heavy-test flock.
import assert from 'node:assert/strict';
import { createKeyboardRamp } from '../sim/keyboard-ramp.js';
import { POLICY_MODES } from '../sim/policy-modes.js';
import { manualCommand, manualSettings } from '../sim/manual-settings.js';
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} != ${b}`));
const ramp = createKeyboardRamp(POLICY_MODES.start.command.keyboardRamp);
const settings = manualSettings({}, POLICY_MODES.start.command);
const command = (dt) => manualCommand(ramp.advance(dt), settings, true);
near(ramp.target([1, 1, 1]), [0, 0, 0]);
near(command(.1), [.15, .05, .2]);
near(command(.4), [.75, .25, 1]);
near(command(.5), [1.5, .5, 1]);
ramp.target([0, 0, 0]);
near(command(.1), [1.125, .375, .75]);
near(command(.3), [0, 0, 0]);
near(command(.1), [0, 0, 0]);
ramp.target([-1, 0, 0]); near(command(1), [-1, 0, 0]);
ramp.target([1, 0, 0]); near(command(.2), [-.5, 0, 0]); near(command(.2), [0, 0, 0]);
near(command(1), [1.5, 0, 0]);
ramp.reset(); near(command(0), [0, 0, 0]); near(command(1), [0, 0, 0]);
ramp.target([0, 0, 1]); near(command(.1), [0, 0, .24]); near(command(.4), [0, 0, 1.2]);
for (const mode of [POLICY_MODES.nvidia, POLICY_MODES.ame2]) {
  const step = createKeyboardRamp(mode.command.keyboardRamp), s = manualSettings({}, mode.command);
  assert.equal(step.enabled, false);
  for (const target of [[1, 1, 1], [-1, 0, -1], [0, 0, 0]]) {
    const expected = manualCommand(target, s, true);
    near(manualCommand(step.target(target), s, true), expected);
    for (const dt of [.1, .5, 1]) near(manualCommand(step.advance(dt), s, true), expected);
  }
}
console.log('keyboard ramp PASS: .1/.5/1 s, vx/vy/wz caps, .4 s release, reversal, immediate reset, nvidia/AME-2 step delta=0');
if (!process.argv.includes('--headless')) process.exit(0);

const { createServer } = await import('node:http');
const { readFileSync, writeFileSync } = await import('node:fs');
const { resolve, extname, sep } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www'), rows = [];
const server = createServer((req, res) => {
  const [variant, ...parts] = new URL(req.url, 'http://localhost').pathname.slice(1).split('/');
  const file = resolve(root, parts.join('/'));
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  try {
    let body = readFileSync(file);
    if (file.endsWith(`${sep}sim${sep}main.js`)) {
      // Test-only hook: fixed policy time, no RAF debt or inference retry bias.
      body = body.toString().replace('prepare: () => {', 'prepare: st.keyTestPrepare = () => {');
      body = body.replaceAll('requestAnimationFrame(frame);', '/* test drives policy ticks */');
      if (variant === 'before') body = body.replace('createKeyboardRamp(adapter.command.keyboardRamp)', 'createKeyboardRamp(null)');
    }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
assert.ok(![8453, 8792, 5190, 5191, 5195, 8870, 9430, 9761].includes(server.address().port));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  for (const variant of ['before', 'after']) {
    const page = await browser.newPage({ hasTouch: true, viewport: { width: 520, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/${variant}/sim/index.html?map=warehouse&policy=start-demo`);
    await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, undefined, { timeout: 90000 });
    assert.equal(await page.evaluate(() => __sim.err), null);
    await page.click('#go');
    const warmup = await page.evaluate(async () => {
      const sim = __sim.sim; let rejected = 0;
      for (let n = 0; n < 75; n++) {
        __sim.keyTestPrepare();
        while (await sim.step() === false) { if (++rejected > 2000) throw Error('warmup retry limit'); await new Promise((r) => setTimeout(r, 5)); }
      }
      return { t: sim.t, rejected };
    });
    await page.keyboard.down('ArrowUp');
    const metrics = await page.evaluate(async () => {
      const sim = __sim.sim, origin = Array.from(sim.d.qpos.slice(0, 2));
      let peak = 0, policyPeak = 0, rejected = 0, tick = 0; const samples = [];
      const physicsStep = sim.physStep;
      sim.physStep = () => {
        physicsStep();
        if (tick <= 25) peak = Math.max(peak, Math.hypot(sim.d.qacc[0], sim.d.qacc[1]));
      };
      for (let n = 1; n <= 150; n++) {
        tick = n;
        __sim.keyTestPrepare();
        const velocity = Array.from(sim.d.qvel.slice(0, 2));
        while (await sim.step() === false) { if (++rejected > 4000) throw Error('motion retry limit'); await new Promise((r) => setTimeout(r, 5)); }
        if (n <= 25) policyPeak = Math.max(policyPeak, Math.hypot(sim.d.qvel[0] - velocity[0], sim.d.qvel[1] - velocity[1]) / .02);
        if ([5, 25, 50].includes(n)) samples.push({ seconds: n * .02, cmd: __sim.cmd() });
      }
      sim.physStep = physicsStep;
      return { peakHorizontalAccelerationFirstHalfSecond: peak, peakPolicyAveragedAcceleration: policyPeak, distance3Seconds: Math.hypot(sim.d.qpos[0] - origin[0], sim.d.qpos[1] - origin[1]), samples, rejected };
    });
    if (variant === 'after') metrics.samples.forEach((s, i) => near(s.cmd, [[.15, 0, 0], [.75, 0, 0], [1.5, 0, 0]][i]));
    await page.keyboard.up('ArrowUp');
    const release = await page.evaluate(() => { for (let n = 0; n < 20; n++) __sim.keyTestPrepare(); return __sim.cmd(); });
    near(release, [0, 0, 0]);
    // Real touch stick remains an immediate full command, then keys own input.
    const box = await page.locator('#stickL').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 10);
    near(await page.evaluate(() => __sim.joy()), [1.5, 0, 0]); await page.mouse.up();
    for (const event of ['stop', 'blur', 'hidden', 'pagehide', 'freeze']) {
      await page.keyboard.down('ArrowUp');
      await page.evaluate(() => { for (let n = 0; n < 25; n++) __sim.keyTestPrepare(); });
      assert.ok((await page.evaluate(() => __sim.cmd()))[0] > 0);
      if (event === 'stop') await page.click('#stop');
      else await page.evaluate((event) => {
        if (event === 'hidden') {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange')); delete document.hidden;
        } else window.dispatchEvent(new Event(event));
      }, event);
      assert.equal(await page.evaluate(() => __sim.stopped()), true);
      near(await page.evaluate(() => __sim.cmd()), [0, 0, 0]);
      await page.click('#go');
      await page.evaluate(() => __sim.keyTestPrepare()); near(await page.evaluate(() => __sim.cmd()), [0, 0, 0]);
      await page.keyboard.down('ArrowUp'); // repeat cannot revive a locked key
      await page.evaluate(() => __sim.keyTestPrepare()); near(await page.evaluate(() => __sim.cmd()), [0, 0, 0]);
      await page.keyboard.up('ArrowUp');
    }
    assert.deepEqual(errors, []);
    rows.push({ variant, warmup, ...metrics }); console.log(JSON.stringify(rows.at(-1)));
    await page.close();
  }
  if (process.env.KEY_RAMP_REPORT) writeFileSync(process.env.KEY_RAMP_REPORT, JSON.stringify({ browser: browser.version(), time: 'simulation seconds', acceleration: 'max horizontal world qacc at each 5 ms physics step (m/s²); also 20 ms velocity finite difference', rows }, null, 2));
  console.log('keyboard ramp headless PASS: real start keys, release, STOP/blur/hidden/pagehide/freeze immediate zero, fresh press required, touch stick unchanged');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

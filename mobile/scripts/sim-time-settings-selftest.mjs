// Headless, local generated bundle only; deterministic RAF timestamps, real
// MuJoCo/f32/main WASM/Worker. FH_PLAYWRIGHT; sync-web (with ONNX assets) first.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www'), out = resolve('runs/sim-time-settings');
mkdirSync(out, { recursive: true });
const server = createServer((req, res) => {
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    let body = readFileSync(file);
    if (file.endsWith('/main.js')) body = String(body).replace('renderer.render(scene, camera);', 'scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
assert.ok(![8453, 8792, 5190, 5191, 8870, 9430, 9761].includes(server.address().port));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] });
const rows = [], errors = [];
async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { window.requestAnimationFrame = (cb) => { window.__frame = cb; return 1; }; Math.random = () => 0; });
  await page.goto(base + '/sim/index.html?map=warehouse&' + query);
  await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 60000, polling: 100 });
  assert.equal(await page.evaluate(() => __sim.err), null);
  return page;
}
try {
  // No backend parameter: both adapters use JS for the presentation path.
  for (const policy of ['foothold-v2', 'ame2-demo']) {
    const page = await open(policy === 'foothold-v2' ? '' : `policy=${policy}`);
    const badge = await page.locator('#policyEngine').textContent();
    assert.match(badge, /기본 계산 사용 \(f32 JS\)/);
    assert.equal(page.workers().length, 0);
    const motion = await page.evaluate(async (policy) => {
      await document.getElementById('go').onclick();
      if (policy === 'ame2-demo') await document.getElementById('scenarioRun').onclick();
      else window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
      const start = Array.from(__sim.sim.d.qpos.slice(0, 2)), t = performance.now();
      const scenario = __sim.scenario.active;
      __frame(t);
      for (let i = 1; i <= 120; i++) __frame(t + i * 1000 / 60);
      const end = Array.from(__sim.sim.d.qpos.slice(0, 2));
      return { scenario, seconds: __sim.sim.t, distance: Math.hypot(end[0] - start[0], end[1] - start[1]) };
    }, policy);
    if (policy === 'ame2-demo') assert.equal(motion.scenario, true);
    assert.ok(motion.seconds > 1.9 && motion.distance > .05, JSON.stringify({ policy, ...motion }));
    console.log('Default f32 JS motion PASS', JSON.stringify({ policy, badge, ...motion }));
    await page.close();
  }
  if (!process.argv.includes('--settings-only')) for (const policy of ['foothold-v2', 'ame2-demo']) for (const engine of ['f32', 'main', 'worker']) for (const fps of [60, 30, 5]) {
    const page = await open(`policy=${policy}&policyBackend=${engine === 'f32' ? 'f32' : 'wasm'}&policyThread=${engine === 'main' ? 'main' : 'worker'}`);
    assert.match(await page.locator('#policyEngine').textContent(), engine === 'f32' ? /f32 JS/ : engine === 'main' ? /화면 계산/ : /Worker/);
    const row = await page.evaluate(async ({ fps, policy, engine }) => {
      await document.getElementById('go').onclick();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
      const sim = __sim.sim, { getPolicyAdapter } = await import('./policy-adapters.js');
      const contract = getPolicyAdapter(policy).timing, step = sim.step, phys = sim.physStep;
      let calls = 0, physical = 0, busy = false, overlap = 0;
      sim.physStep = () => { physical++; return phys(); };
      sim.step = () => {
        if (busy) overlap++;
        calls++;
        const result = step();
        if (result?.then) { busy = true; return result.finally(() => { busy = false; }); }
        return result;
      };
      const start = performance.now(); __frame(start);
      const t = sim.t, physics = sim.d.time;
      for (let i = 1; i <= fps * 2; i++) {
        __frame(start + i * 1000 / fps);
        while (__sim.timing().pending) await new Promise((r) => setTimeout(r, 0));
        await Promise.resolve();
      }
      const seconds = sim.t - t;
      return { policy, engine, fps, wall: 2, seconds, physics: sim.d.time - physics, ratio: seconds / 2,
        pose: Array.from(sim.d.qpos), physical, decisions: Math.round(seconds / contract.policyDt), decimation: contract.decimation, calls, overlap, timing: __sim.timing(), badge: __sim.policyEngine };
    }, { fps, policy, engine });
    assert.ok(row.ratio >= .95 || (row.timing.dropped > 0 && row.timing.slow), JSON.stringify(row));
    assert.ok(Math.abs(row.physics - row.seconds) < 1e-9, JSON.stringify(row));
    assert.equal(row.physical, row.decisions * row.decimation); assert.equal(row.overlap, 0);
    if (row.timing.dropped > 0) assert.equal(await page.locator('#simSlow').isVisible(), true, 'discarded debt is visible');
    rows.push(row); writeFileSync(resolve(out, 'timing-progress.json'), JSON.stringify(rows, null, 2));
    console.log(JSON.stringify(row)); await page.close();
  }
  // Same command/physics sequence across FPS; main and Worker transfer exactly
  // the same inputs. Compare closed-loop poses at equal physics time only.
  for (const policy of ['foothold-v2', 'ame2-demo']) {
    const equalTime = rows.filter((r) => r.policy === policy && r.decisions === 100);
    for (const engine of ['f32', 'main', 'worker']) {
      const group = equalTime.filter((r) => r.engine === engine);
      for (const row of group.slice(1)) assert.ok(row.pose.every((v, i) => Math.abs(v - group[0].pose[i]) < 1e-10), `FPS trajectory ${policy}/${engine}`);
    }
    const f32 = equalTime.find((r) => r.engine === 'f32');
    for (const row of equalTime.filter((r) => r.engine !== 'f32')) {
      assert.ok(row.pose.every((v, i) => Math.abs(v - f32.pose[i]) < 1e-4), `f32/ONNX warehouse trajectory ${policy}/${row.engine}/${row.fps}`);
    }
  }
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => { window.requestAnimationFrame = (cb) => { window.__frame = cb; return 1; }; Math.random = () => 0; });
  let org = { sim_max_vx: 1, sim_runner_vx: 1, sim_key_vx: .8 }, requests = 0, failure = false, hold = false, held;
  await p.route('**/api/v1/org/settings', async (route) => {
    requests++;
    if (hold) await new Promise((r) => { held = r; });
    await route.fulfill(failure ? { status: 500, body: 'failure' } : { json: org });
  });
  await p.goto(base + '/sim/index.html?policyBackend=f32&from=web'); await p.waitForFunction(() => window.__sim?.ready, null, { polling: 100 });
  const go = () => p.evaluate(async () => { await document.getElementById('go').onclick(); __frame(performance.now()); });
  const stop = () => p.evaluate(() => document.getElementById('stop').click());
  const scenario = () => p.evaluate(async () => {
    __sim.scenario.cancel(); __sim.sim.reset(); __sim.sim.hold(.5);
    await document.getElementById('scenarioRun').onclick();
    return __sim.scenario.tick(Infinity)[0];
  });
  await go(); assert.equal(await scenario(), 1);
  org = { sim_max_vx: .2, sim_runner_vx: .2, sim_key_vx: .1, stick_deadzone: .3 };
  assert.equal(await p.evaluate(() => __sim.scenario.tick(Infinity)[0]), 1, 'saved response does not alter active run');
  assert.equal(await scenario(), .2, 'next scenario fetches without reload');
  await stop(); await go();
  await p.keyboard.down('KeyW'); assert.equal(await p.evaluate(() => __sim.joy()[0]), .1); await p.keyboard.up('KeyW');
  await p.evaluate(() => { document.getElementById('stickL').style.display = 'block'; });
  const rect = await p.locator('#stickL').boundingBox(), cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  await p.mouse.move(cx, cy - rect.height * .1); await p.mouse.down();
  assert.equal(await p.evaluate(() => __sim.joy()[0]), 0, 'organization stick deadzone');
  await p.mouse.move(cx, cy - rect.height * .325);
  assert.equal(await p.evaluate(() => __sim.joy()[0]), .1, 'stick rescales outside organization deadzone');
  await p.mouse.move(cx, cy - rect.height / 2);
  assert.equal(await p.evaluate(() => __sim.joy()[0]), .2, 'stick organization max');
  await p.mouse.up();
  failure = true; await stop(); await go(); assert.equal(await scenario(), .2, 'failed fetch keeps last valid values');
  failure = false; org = {}; await stop(); await go(); assert.equal(await scenario(), .4, 'successful missing fields restore defaults');
  // A new clicked goal fetches settings; appending a goal keeps this run snapshot.
  await p.evaluate(() => { __sim.scenario.cancel(); __sim.sim.reset(); __sim.sim.hold(.5); document.getElementById('cam').click(); __frame(performance.now()); });
  org = { sim_max_vx: .3, sim_runner_vx: .3 };
  const tap = async (distance) => {
    const point = await p.evaluate((distance) => __sim.toScreen(__sim.sim.d.qpos[0] + distance, __sim.sim.d.qpos[1]), distance);
    await p.mouse.click(...point); await p.evaluate(() => __sim.settled());
  };
  await tap(1.5);
  assert.equal(await p.evaluate(() => __sim.scenario.active && __sim.scenario.goal), true);
  assert.equal(await p.evaluate(() => __sim.scenario.tick(Infinity)[0]), .3);
  const beforeAppend = requests; org = { sim_max_vx: .5, sim_runner_vx: .5 };
  await tap(2); assert.equal(requests, beforeAppend); assert.equal(await p.evaluate(() => __sim.scenario.tick(Infinity)[0]), .3);
  // STOP during settings fetch must prevent a delayed start.
  await stop(); hold = true;
  await p.evaluate(() => { window.pendingGo = document.getElementById('go').onclick(); });
  while (!held) await new Promise((r) => setTimeout(r, 5));
  await stop(); held(); await p.evaluate(() => window.pendingGo);
  assert.equal(await p.evaluate(() => __sim.stopped()), true);
  const settings = { requests, scenarioBefore: 1, nextScenario: .2, keyboard: .1, stickAtDeadzone: 0, stickAtHalfRange: .1, stickAtMax: .2, retainedOnFailure: .2, defaults: .4, clickedGoal: .3, appendedGoal: .3, lateStartDiscarded: true };
  console.log('settings', JSON.stringify(settings));
  await p.close();
  // Visible cap indicator with a real frame timestamp stall.
  const slow = await open('policyBackend=f32');
  await slow.evaluate(() => { window.clockOrigin = performance.now(); __frame(clockOrigin); __frame(clockOrigin + 2000); });
  assert.equal(await slow.locator('#simSlow').isVisible(), true);
  assert.match(await slow.locator('#simSlow').textContent(), /한도 초과/);
  const capped = await slow.evaluate(() => __sim.timing()); assert.ok(capped.dropped > 1.4);
  await slow.evaluate(() => { for (let i = 1; i <= 600; i++) __frame(clockOrigin + 2000 + i * 1000 / 60); });
  assert.equal(await slow.evaluate(() => __sim.timing().slow), false, '10s normal clears a past cap');
  assert.equal(await slow.locator('#simSlow').isVisible(), false);
  await slow.evaluate(() => { __frame(clockOrigin + 14000); });
  assert.ok(await slow.evaluate(() => __sim.timing().dropped > 0));
  await slow.evaluate(async () => { await document.getElementById('go').onclick(); __frame(performance.now()); });
  assert.deepEqual(await slow.evaluate(() => [__sim.timing().dropped, __sim.timing().drops, __sim.timing().slow]), [0, 0, false], 'new run clears drop counters');
  await slow.close();
  const hidden = await open('policyBackend=f32');
  const resumed = await hidden.evaluate(() => {
    const start = performance.now(); __frame(start);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    __frame(start + 1000); // a throttled hidden RAF must not seed the clock
    const before = __sim.steps;
    delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
    __frame(start + 30000); __frame(start + 30016);
    const burst = __sim.steps - before;
    for (let i = 2; i <= 627; i++) __frame(start + 30000 + i * 16);
    return { burst, timing: __sim.timing(), stopped: __sim.stopped(), slowVisible: !document.getElementById('simSlow').hidden };
  });
  assert.ok(resumed.burst <= 1, JSON.stringify(resumed)); assert.equal(resumed.stopped, true);
  assert.equal(resumed.timing.slow, false); assert.equal(resumed.timing.dropped, 0); assert.equal(resumed.slowVisible, false);
  await hidden.close(); assert.deepEqual(errors, []);
  writeFileSync(resolve(out, process.argv.includes('--settings-only') ? 'settings-only.json' : 'time-settings.json'), JSON.stringify({ rows, settings, capped, resumed, port: server.address().port, errors }, null, 2));
  console.log('sim time/settings PASS: both policies × all engines × 60/30/5 FPS, decimation, live next-start settings, key speed, STOP race, visible cap');
} finally { await browser.close(); await new Promise((r) => server.close(r)); }

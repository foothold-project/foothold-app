// Local headless browser, real MuJoCo gait/f32 policy; no pose edits, robot or remote service.
// First sync mobile/www. FH_PLAYWRIGHT points to an existing playwright-core entry;
// FH_BT_REPORT_DIR chooses the ignored evidence directory. Run under the shared heavy-test flock.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www'), out = resolve(process.env.FH_BT_REPORT_DIR ?? 'runs/bt-patrol');
mkdirSync(out, { recursive: true });
const forbidden = [8453, 8792, 5190, 5191, 5195, 8870, 9430, 9761];
const server = createServer((req, res) => {
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  try {
    let body = readFileSync(file);
    // Draw on capture only; retain original frame clock, UI, scan, runner and physics.
    if (file.endsWith('/main.js')) body = String(body).replace('renderer.render(scene, camera);', 'if (window.__btDraw) renderer.render(scene, camera);');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
assert.ok(!forbidden.includes(server.address().port));
const browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const results = [], errors = [], stopChecks = [];
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
async function capture(page, name) {
  if (name.startsWith('progress')) await page.locator('#btNodes .btActive').last().scrollIntoViewIfNeeded();
  await page.evaluate(() => { window.__btDraw = true; __frame(window.__btNow); window.__btDraw = false; });
  await page.screenshot({ path: resolve(out, name + '.png') });
}
async function checkStoppedPhysics(page, label) {
  const check = await page.evaluate(async (label) => {
    const before = __sim.steps, time = __sim.sim.d.time, events = __sim.patrol.events.length;
    for (let i = 0; i < 30; i++) { __btNow += 100; __frame(__btNow); await new Promise((r) => setTimeout(r, 0)); }
    return { label, steps: __sim.steps - before, seconds: __sim.sim.d.time - time, slow: !document.getElementById('simSlow').hidden,
      active: __sim.patrol.active, stopped: __sim.stopped(), cmd: __sim.cmd(), followingEvents: __sim.patrol.events.length - events };
  }, label);
  assert.ok(check.steps > 0 && check.seconds > 0, `${label}: STOP retains zero-input policy physics`);
  assert.deepEqual([check.active, check.stopped, check.cmd, check.slow, check.followingEvents], [false, true, [0, 0, 0], false, 0], label);
  stopChecks.push(check); writeFileSync(resolve(out, 'stop-regression.json'), JSON.stringify(stopChecks, null, 2));
  console.log('BT STOP physics PASS', JSON.stringify(check));
}
try {
  for (const mode of ['normal', 'minor', 'danger', 'battery', 'move', 'fallen', 'photo-stop']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => { window.requestAnimationFrame = (cb) => { window.__frame = cb; return 1; }; Math.random = () => 0; });
    await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?map=factory-inspection&policy=nvidia-demo&policyBackend=f32`);
    await page.waitForFunction(() => __sim?.ready || __sim?.err, null, { polling: 100, timeout: 60000 });
    assert.equal(await page.evaluate(() => __sim.err), null);
    await page.evaluate(async (mode) => {
      document.getElementById('scenarioMenu').click();
      document.getElementById('scenarioSelect').value = 'bt-patrol'; document.getElementById('scenarioSelect').onchange();
      await document.getElementById('go').onclick();
      if (mode === 'move') document.getElementById('btMoveFail').click();
      window.__btOrigin = Array.from(__sim.sim.d.qpos.slice(0, 2));
      window.__btNow = performance.now(); __frame(__btNow);
    }, mode);
    if (mode === 'normal') {
      const layouts = [];
      for (const [width, height] of [[1280, 800], [390, 844], [844, 390]]) {
        await page.setViewportSize({ width, height }); await page.waitForTimeout(100);
        await page.locator('#scenarioPanel').evaluate((el) => { el.scrollTop = 0; });
        const layout = await page.evaluate(() => {
          const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
          const button = document.getElementById('scenarioRun'), r = button.getBoundingClientRect();
          return { panel: rect('scenarioPanel'), stop: rect('stop'), left: rect('stickL'), right: rect('stickR'), run: rect('scenarioRun'),
            runHit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === button, scroll: document.getElementById('scenarioPanel').scrollTop };
        });
        assert.equal(layout.scroll, 0);
        for (const id of ['stop', 'left', 'right']) assert.equal(overlap(layout.panel, layout[id]), false, `${width}: panel clears ${id}`);
        assert.ok(layout.run.top >= layout.panel.top && layout.run.bottom <= layout.panel.bottom && layout.runHit, `${width}: Run visible without scrolling`);
        layouts.push({ width, height, ...layout });
        if (width === 844) await capture(page, 'landscape-844');
      }
      writeFileSync(resolve(out, 'layouts.json'), JSON.stringify(layouts, null, 2));
      await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(100);
    }
    await page.evaluate(async () => { await document.getElementById('scenarioRun').onclick(); __btNow = performance.now(); __frame(__btNow); });
    let progressCaptured = false;
    for (let round = 0; round < 900; round++) {
      const snap = await page.evaluate(async (mode) => {
        for (let i = 0; i < 5 && __sim.patrol.active; i++) {
          const p = __sim.patrol;
          const photo = [...p.execution.states].some(([path, s]) => s.result === 'running' && p.execution.tree && path && s.handle && path === '0.2.0.0.1.0.0');
          if (mode === 'photo-stop' && photo) document.getElementById('stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          if (p.reviewPending) {
            if (mode === 'battery' && !p.mock.battery) document.getElementById('btBattery').click();
            else if (mode === 'fallen' && !p.mock.fallen) document.getElementById('btFall').click();
            else p.review(mode === 'minor' || mode === 'danger' ? mode : 'clear');
          }
          __btNow += 100; __frame(__btNow);
          await new Promise((r) => setTimeout(r, 0));
        }
        return { active: __sim.patrol.active, pending: __sim.patrol.reviewPending, elapsed: __sim.patrol.execution.elapsed, err: __sim.err };
      }, mode);
      assert.equal(snap.err, null);
      if (mode === 'normal' && snap.active && snap.elapsed > .5 && !progressCaptured) {
        await capture(page, 'progress-1280');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(100);
        await capture(page, 'progress-390');
        const bounds = await page.evaluate(() => {
          const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
          return { panel: rect('scenarioPanel'), stop: rect('stop'), stick: rect('stickL'), scroll: document.getElementById('scenarioPanel').scrollHeight };
        });
        assert.ok(bounds.panel.top >= bounds.stop.bottom, 'panel clears STOP');
        assert.ok(bounds.panel.bottom < bounds.stick.top, 'panel clears joystick');
        assert.ok(bounds.scroll > bounds.panel.height, 'phone panel scrolls');
        await page.evaluate(() => { document.getElementById('scenarioPanel').scrollTop = 0; });
        await page.waitForTimeout(150);
        const cdp = await context.newCDPSession(page);
        // Explicit touch moves also work with this harness's deterministic RAF.
        // Drag inside the (now half-height) panel: bottom edge up to its top edge.
        const touchTop = Math.round(bounds.panel.top + 20), touchBottom = Math.round(bounds.panel.bottom - 20);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 330, y: touchBottom }] });
        for (let y = touchBottom - 20; y >= touchTop; y -= 30) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 330, y }] });
          await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(150);
        bounds.touchScrollTop = await page.locator('#scenarioPanel').evaluate((el) => el.scrollTop);
        console.log('BT phone gesture', JSON.stringify(bounds));
        assert.ok(bounds.touchScrollTop > 100, 'phone touch scroll reaches lower content');
        await cdp.detach();
        writeFileSync(resolve(out, 'phone-layout.json'), JSON.stringify(bounds, null, 2));
        await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(100); progressCaptured = true;
      }
      if (!snap.active) break;
    }
    const result = await page.evaluate((mode) => ({ mode, status: __sim.patrol.status, active: __sim.patrol.active, stopped: __sim.stopped(),
      cmd: __sim.cmd(), summary: __sim.patrol.summary, events: __sim.patrol.events, steps: __sim.steps,
      origin: __btOrigin, end: Array.from(__sim.sim.d.qpos.slice(0, 2)), qpos: Array.from(__sim.sim.d.qpos.slice(0, 7)) }), mode);
    results.push(result); writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
    assert.equal(result.active, false, `${mode} deadline`);
    assert.deepEqual(result.cmd, [0, 0, 0]);
    if (mode === 'normal') { assert.equal(result.status, 'success'); assert.equal(result.summary.visited, 4); assert.equal(result.summary.skipped, 0); }
    if (mode === 'minor') { assert.equal(result.summary.minor, 4); assert.equal(result.summary.visited, 4); }
    if (mode === 'danger') { assert.equal(result.summary.danger, 1); assert.equal(result.summary.skipped, 3); assert.match(result.summary.reason, /위험 대피 완료/); }
    if (mode === 'battery') { assert.match(result.summary.reason, /배터리 부족 복귀/); assert.equal(result.summary.skipped, 3); }
    if (mode === 'move') { assert.equal(result.summary.skipped, 1); assert.equal(result.summary.visited, 3); }
    if (mode === 'fallen' || mode === 'photo-stop') { assert.equal(result.status, 'abort'); assert.equal(result.stopped, true); }
    if (mode === 'fallen') assert.match(result.summary.reason, /사람 회수 필요/);
    if (mode === 'photo-stop') {
      const events = result.events.length;
      await page.evaluate(() => { for (let i = 0; i < 10; i++) { __btNow += 100; __frame(__btNow); } });
      assert.equal(await page.evaluate(() => __sim.patrol.events.length), events, 'STOP has no following action');
    }
    if (mode === 'fallen' || mode === 'photo-stop') await checkStoppedPhysics(page, 'after-' + mode);
    assert.ok(result.steps > 0, 'real policy physics stepped');
    await page.evaluate(() => { const el = document.getElementById('scenarioPanel'); el.scrollTop = el.scrollHeight; });
    await capture(page, 'end-' + mode);
    console.log('BT browser PASS', JSON.stringify({ mode, status: result.status, stopped: result.stopped, summary: result.summary, steps: result.steps, end: result.end }));
    if (mode === 'minor') {
      assert.equal(await page.evaluate(() => __sim.patrolMarks()), 4, 'minor map markers rendered');
      await page.evaluate(async () => { await document.getElementById('scenarioRun').onclick(); });
      assert.deepEqual(await page.evaluate(() => [__sim.patrol.marks.length, __sim.patrolMarks()]), [0, 0], 'rerun clears model and rendered map markers');
      await page.evaluate(() => document.getElementById('stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    }
    if (mode === 'photo-stop') {
      await page.evaluate(async () => {
        await document.getElementById('go').onclick();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
        for (let i = 0; i < 10; i++) { __btNow += 100; __frame(__btNow); await new Promise((r) => setTimeout(r, 0)); }
        document.getElementById('stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
      await checkStoppedPhysics(page, 'later-manual-STOP');
      await page.evaluate(async () => {
        document.getElementById('scenarioSelect').value = 'short-loop'; document.getElementById('scenarioSelect').onchange();
        await document.getElementById('go').onclick(); await document.getElementById('scenarioRun').onclick();
        __btNow += 100; __frame(__btNow);
      });
      assert.equal(await page.locator('#btDisclaimer').isVisible(), false, 'legacy scenario hides mock patrol disclaimer');
      assert.equal(await page.evaluate(() => __sim.scenario.active && !__sim.scenario.goal), true, 'legacy route running');
      await page.evaluate(() => document.getElementById('stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      await checkStoppedPhysics(page, 'later-legacy-STOP');
      await page.evaluate(() => document.getElementById('reset').onclick());
      await checkStoppedPhysics(page, 'later-reset');
    }
    if (mode === 'normal') {
      const guards = await page.evaluate(async () => {
        const r = __sim.scenario;
        r.start([{ x: __sim.sim.d.qpos[0] + 1, y: __sim.sim.d.qpos[1] }], true);
        await document.getElementById('scenarioRun').onclick();
        const goalBlocked = !__sim.patrol.active && r.active && r.goal;
        r.cancel('중단');
        const starting = document.getElementById('scenarioRun').onclick();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
        await starting;
        const staleBlocked = !__sim.patrol.active;
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));
        document.getElementById('stop').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await document.getElementById('go').onclick();
        await document.getElementById('scenarioRun').onclick();
        __btNow += 100; __frame(__btNow);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
        await new Promise((r) => setTimeout(r, 30));
        return { goalBlocked, staleBlocked, active: __sim.patrol.active, stopped: __sim.stopped(), cmd: __sim.cmd() };
      });
      assert.deepEqual(guards, { goalBlocked: true, staleBlocked: true, active: false, stopped: true, cmd: [0, 0, 0] });
      await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?from=server&map=factory-inspection&policy=nvidia-demo&policyBackend=f32`);
      await page.waitForFunction(() => __sim?.ready || __sim?.err, null, { polling: 100, timeout: 60000 });
      assert.equal(await page.evaluate(async () => {
        await document.getElementById('go').onclick();
        document.getElementById('scenarioSelect').value = 'bt-patrol'; document.getElementById('scenarioSelect').onchange();
        await document.getElementById('scenarioRun').onclick();
        return !__sim.patrol.active && document.getElementById('scenarioRun').disabled;
      }), true, 'server entry blocks tree');
      console.log('BT UI guards PASS: tapped-goal, stale settings/manual input, keyboard/late-plan STOP, server entry');
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('BT browser 7/7 PASS: actual gait, no pose changes, UI actions, neutral ends, phone/landscape layout, STOP physics regression, marker cleanup, screenshots');
} finally { await browser.close(); await new Promise((r) => server.close(r)); }

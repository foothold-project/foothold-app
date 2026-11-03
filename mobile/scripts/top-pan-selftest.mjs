// Headless real camera/input regression. Sync www first; FH_PLAYWRIGHT required.
// --baseline with FH_TOP_BASE=<old commit> renders the old main.js for a before screenshot.
// FH_SHOT=<png> optionally retains local evidence; server uses an ephemeral port.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const baseline = process.argv.includes('--baseline');
if (baseline) assert.ok(process.env.FH_TOP_BASE, 'FH_TOP_BASE=<pre-change commit> required');
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www');
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = baseline && pathname === '/sim/main.js'
      ? execFileSync('git', ['show', `${process.env.FH_TOP_BASE}:mobile/sim/main.js`]) : readFileSync(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
assert.ok(![8453, 8792, 5190, 5191, 8870, 9430, 9761].includes(server.address().port));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, hasTouch: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const state = () => page.evaluate(() => ({ v: __sim.view(), cam: __sim.cam(), marks: __sim.marks(), stopped: __sim.stopped(), cmd: __sim.cmd() }));
  const drag = async (x, y, dx, dy) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 3 }); await page.mouse.up(); await frame(); };
  const url = `http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse&from=web`;
  await page.goto(url); await page.waitForFunction(() => __sim.ready || __sim.err, null, { timeout: 90000 });
  assert.equal(await page.evaluate(() => __sim.err), null);
  const follow = await state(); assert.equal(await page.isVisible('#topCenter'), false);
  await page.click('#cam'); await frame();
  const initial = await state(); console.log('top input: loaded');
  await page.mouse.move(550, 390); await page.mouse.wheel(0, -950); await frame();
  const zoomed = await state(); assert.ok(zoomed.v.topH < .4);
  await drag(550, 390, 170, 85);
  const moved = await state();
  if (process.env.FH_SHOT) await page.screenshot({ path: process.env.FH_SHOT });
  if (baseline) {
    assert.equal(moved.cam[0], initial.cam[0]); assert.equal(moved.cam[1], initial.cam[1]);
    assert.notEqual(moved.v.topRot, 0);
    console.log('baseline reproduced: zoomed drag rotates while camera center remains fixed');
  } else {
    assert.ok(Math.hypot(moved.cam[0] - zoomed.cam[0], moved.cam[1] - zoomed.cam[1]) > 1, 'drag pans');
    assert.equal(moved.v.topRot, 0); assert.equal(moved.marks.length, 0); assert.equal(moved.stopped, true);
    await page.waitForTimeout(250); assert.deepEqual((await state()).cam, moved.cam, 'pan survives frames');
    const center = async () => { await page.click('#topCenter'); await frame(); };
    await center(); assert.deepEqual((await state()).cam, initial.cam); assert.equal((await state()).v.topH, 1);
    // Wheel anchor at an off-center world point.
    const point = await page.evaluate(async () => { const m = await (await fetch('assets/warehouse/map.json')).json(); return [m.origin[0] + m.w * m.res / 2, m.origin[1] + m.h * m.res / 2 + .5]; });
    const project = () => page.evaluate(p => __sim.toScreen(...p), point);
    const anchor = await project(); await page.mouse.move(...anchor); await page.mouse.wheel(0, -700); await frame();
    let projected = await project(); assert.ok(Math.hypot(projected[0] - anchor[0], projected[1] - anchor[1]) < 2, `wheel anchor ${JSON.stringify({anchor,projected,state:await state()})}`);
    console.log('top input: persistent pan/center/wheel anchor pass');
    // Huge pan/zoom cannot leave a completely blank map; limits persist after resize.
    for (let i = 0; i < 3; i++) await drag(550, 390, 480, 280);
    const edge = await state(); await drag(550, 390, 480, 280); assert.deepEqual((await state()).cam, edge.cam, 'pan clamps at map edge');
    await page.mouse.move(550, 390); await page.mouse.wheel(0, -20000); await frame(); assert.equal((await state()).v.topH, .08);
    await page.mouse.wheel(0, 20000); await frame(); assert.equal((await state()).v.topH, 3);
    assert.deepEqual((await state()).cam, initial.cam, 'zoom out recenters axes that fit');
    console.log('top input: limits/bounds pass');
    await page.setViewportSize({ width: 412, height: 915 }); await frame(); await center();
    await page.mouse.move(206, 340); await page.mouse.wheel(0, -700); await frame();
    await drag(206, 340, 70, 40); assert.notDeepEqual((await state()).cam, initial.cam, 'portrait pan');
    await page.setViewportSize({ width: 1100, height: 800 }); await frame(); await center();
    console.log('top input: portrait pan pass');
    // Actual touch stream: one-finger pan, two-finger anchored zoom, cancel/lift never taps.
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) });
    await page.mouse.move(550, 390); await page.mouse.wheel(0, -700); await frame();
    const t0 = await state();
    await touch('touchStart', [[1, 550, 390]]); await touch('touchMove', [[1, 620, 430]]); await touch('touchEnd', []); await frame();
    assert.notDeepEqual((await state()).cam, t0.cam, 'one finger pans');
    console.log('top input: one finger pan pass');
    await center();
    const tp = await project();
    await touch('touchStart', [[1, tp[0] - 40, tp[1]], [2, tp[0] + 40, tp[1]]]);
    await touch('touchMove', [[1, tp[0] - 80, tp[1]], [2, tp[0] + 80, tp[1]]]); await frame();
    assert.ok((await state()).v.topH < .6, 'pinch zooms');
    projected = await project(); assert.ok(Math.hypot(projected[0] - tp[0], projected[1] - tp[1]) < 2, 'pinch anchor');
    await touch('touchEnd', []); await frame(); assert.equal((await state()).marks.length, 0);
    assert.equal(await page.evaluate(() => __sim.goalNote()), '', 'pinch never attempts a goal, even while stopped');
    console.log('top input: pinch pass');
    // Short tap still sends a goal; jitter, drag, pinch, cancellation and long press do not.
    await center(); await page.click('#go');
    const floor = await page.evaluate(async () => { const m = await (await fetch('assets/warehouse/map.json')).json(); return __sim.toScreen(m.spawn_xyyaw[0] - 1, m.spawn_xyyaw[1]); });
    await drag(...floor, 30, 15); assert.equal((await state()).marks.length, 0);
    await touch('touchStart', [[1, ...floor]]); await touch('touchCancel', []); await frame(); assert.equal((await state()).marks.length, 0);
    await page.mouse.move(...floor); await page.mouse.down(); await page.waitForTimeout(550); await page.mouse.up(); await frame(); assert.equal((await state()).marks.length, 0);
    await center();
    const tap = await page.evaluate(async () => { const m = await (await fetch('assets/warehouse/map.json')).json(); return __sim.toScreen(m.spawn_xyyaw[0] - 1, m.spawn_xyyaw[1]); });
    const preTap = (await state()).cam;
    // Queue a short burst, as mouse.click does, so renderer load between CDP
    // round trips cannot turn this intended short tap into a >500ms hold.
    await page.mouse.move(...tap);
    await Promise.all([
      cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tap[0], y: tap[1], button: 'left', buttons: 1, clickCount: 1 }),
      cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tap[0] + 2, y: tap[1] + 1, buttons: 1 }),
      cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tap[0] + 2, y: tap[1] + 1, button: 'left', buttons: 0, clickCount: 1 }),
    ]);
    await page.evaluate(() => __sim.settled()); await frame();
    assert.deepEqual((await state()).cam, preTap, 'tap jitter does not pan'); assert.equal((await state()).marks.length, 1, `short tap makes goal: ${await page.evaluate(() => __sim.goalNote())}`);
    await center(); assert.equal((await state()).stopped, false); assert.equal((await state()).marks.length, 1, 'center preserves the running goal');
    await page.click('#wpClear'); await frame();
    await Promise.all([touch('touchStart', [[1, ...tap]]), touch('touchEnd', [])]); await page.evaluate(() => __sim.settled()); await frame();
    assert.equal((await state()).marks.length, 1, 'short finger tap makes goal');
    await page.click('#stop'); await frame(); assert.equal((await state()).marks.length, 0); assert.ok((await state()).cmd.every(v => v === 0));
    console.log('top input: tap/drag/cancel/long press pass');
    // Camera center reset only changes the view; 3D orbit/zoom and manual keys retain behavior.
    await page.click('#cam'); await frame(); assert.equal(await page.isVisible('#topCenter'), false);
    await drag(550, 390, 35, 20); const orbit = await state(); assert.notEqual(orbit.v.yaw, follow.v.yaw); assert.notEqual(orbit.v.pitch, follow.v.pitch);
    await page.mouse.wheel(0, -200); await frame(); assert.ok((await state()).v.dist < orbit.v.dist);
    await page.click('#go'); await page.keyboard.down('KeyW'); assert.ok((await page.evaluate(() => __sim.joy()))[0] > 0); await page.keyboard.up('KeyW'); await page.click('#stop');
    assert.deepEqual(errors, []);
    console.log('top-pan headless PASS: persistent mouse/touch pan, bounds/resize, wheel/pinch anchor and limits, center, drag/pinch/cancel/long-press vs jitter tap, STOP, 3D orbit/zoom and keys');
  }
} finally { await browser?.close(); await new Promise(r => server.close(r)); }

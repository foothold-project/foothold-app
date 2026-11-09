// node mobile/sim/start-pick-selftest.mjs [--headless]
// Headless: prepare mobile/www, set FH_PLAYWRIGHT; optional FH_SCREENSHOTS.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { topFrame, topPoint, validateStart, startPickUrl } from './top-fit.js';

const map = { w: 40, h: 40, res: .1, origin: [0, 0], spawn_xyyaw: [1, 1, .25], px: new Uint8Array(1600).fill(254) };
map.px[20 * map.w + 20] = 0;
for (const text of ['', '1', '1,2,3,4', 'NaN,1', '1,Infinity', '1,,2', '0x10,1']) assert.ok((await validateStart(map, text)).reason, text);
assert.equal((await validateStart(map, '-.01,1')).reason, '지도 밖');
assert.equal((await validateStart(map, '4,1')).reason, '지도 밖');
assert.equal((await validateStart(map, '2.05,1.95')).reason, '장애물·모르는 칸');
assert.match((await validateStart(map, '2.25,1.95')).reason, /벽·물건/);
assert.deepEqual((await validateStart(map, '1,1')).start, [1, 1, .25]);
const href = 'https://example.test/sim/index.html?map=factory-zone&policy=start&floor=f1&from=web&bt=mine&startMap=off&policyBackend=f32&other=a&other=b#keep';
const accepted = await startPickUrl(map, href, 1.234, 1.234, -.456, 'f2');
assert.equal(accepted.reason, '');
const url = new URL(accepted.url), original = new URL(href);
assert.equal(url.searchParams.get('start'), '1.23,1.23,-0.46');
assert.equal(url.searchParams.get('floor'), 'f2');
assert.equal(url.hash, original.hash);
for (const key of original.searchParams.keys()) if (key !== 'floor') assert.deepEqual(url.searchParams.getAll(key), original.searchParams.getAll(key));
assert.deepEqual((await validateStart(map, url.searchParams.get('start'))).start, accepted.start);
assert.equal((await startPickUrl(map, href, -1, 1, 0, 'f2')).url, null);
assert.equal((await startPickUrl(map, href, -.001, 1, 0, 'f2')).reason, '지도 밖');
assert.equal((await startPickUrl(map, href, 2.05, 1.95, 0, 'f2')).url, null);
assert.equal(new URL((await startPickUrl(map, href, 1, 1, 0, null)).url).searchParams.has('floor'), false);
for (const aspect of [.5, 2]) {
  const frame = topFrame(map, aspect);
  assert.deepEqual(topPoint(frame, 0, .5, .5), [frame.cx, frame.cy]);
}
console.log('start pick validation + URL PASS');

if (process.argv.includes('--headless')) {
  const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
  const root = resolve('mobile/www');
  const server = createServer((req, res) => {
    const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + sep)) return res.writeHead(403).end();
    try {
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
      res.end(readFileSync(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  assert.ok(![8453, 8792, 5190, 5191, 5195, 8870, 9430, 9761].includes(server.address().port));
  console.log(`isolated preview port ${server.address().port}`);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
      args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Step RAF manually while real pointer events run; each draw retains normal STOP physics.
    await page.addInitScript(() => { window.__nativeRAF = requestAnimationFrame; requestAnimationFrame = (f) => { window.__frame = f; return 1; }; Math.random = () => 0; });
    const draw = () => page.evaluate(() => __frame(performance.now()));
    const ready = async () => {
      await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 120000, polling: 50 });
      assert.equal(await page.evaluate(() => __sim.err), null);
      await draw();
    };
    const shot = async (name) => {
      if (!process.env.FH_SCREENSHOTS) return;
      mkdirSync(process.env.FH_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(process.env.FH_SCREENSHOTS, name + '.png') });
    };
    const clickWorld = async (xy) => { await page.mouse.click(...await page.evaluate(([x, y]) => __sim.toScreen(x, y), xy)); };
    const base = `http://127.0.0.1:${server.address().port}/sim/index.html`;
    await page.goto(base + '?map=warehouse&policyBackend=f32&from=web&other=keep#retain');
    await ready();
    assert.equal(await page.evaluate(() => __sim.locator().visible), false);
    await shot('01-follow');
    await page.click('#cam'); await draw();
    assert.equal(await page.evaluate(() => __sim.locator().visible), true);
    await shot('02-top');
    await page.mouse.move(640, 400); await page.mouse.wheel(0, -600); await draw();
    assert.ok(await page.evaluate(() => __sim.view().topH < 1));
    assert.ok(await page.evaluate(() => Math.abs(__sim.locator().pixels - 1) < 1e-12));
    await page.click('#cam'); await draw();
    await page.click('#cam'); await draw();
    assert.equal(await page.evaluate(() => __sim.view().topH), 1);
    await page.click('#topCenter'); await draw();
    assert.equal(await page.getAttribute('#topCenter', 'aria-pressed'), 'true');
    await shot('03-picking');
    const before = page.url();
    await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(740, 440, { steps: 3 }); await page.mouse.up(); await draw();
    assert.equal(page.url(), before, 'drag must not restart');
    assert.equal(await page.getAttribute('#topCenter', 'aria-pressed'), 'true');
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) });
    await touch('touchStart', [[1, 600, 400], [2, 680, 400]]);
    await touch('touchMove', [[1, 560, 400], [2, 720, 400]]); await draw();
    await touch('touchEnd', []); await draw();
    assert.ok(await page.evaluate(() => __sim.view().topH < 1), 'pinch still zooms during picking');
    assert.equal(page.url(), before, 'pinch must not restart');
    assert.deepEqual(await page.evaluate(() => __sim.marks()), []);
    assert.equal(await page.getAttribute('#topCenter', 'aria-pressed'), 'true');
    await page.keyboard.press('Escape'); await draw();
    assert.equal(await page.getAttribute('#topCenter', 'aria-pressed'), 'false');
    await page.click('#topCenter'); await page.click('#topCenter');
    assert.equal(await page.getAttribute('#topCenter', 'aria-pressed'), 'false');
    await page.click('#topCenter'); await page.click('#cam'); await draw();
    assert.equal(await page.getAttribute('#topCenter', 'aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => __sim.locator().visible), false);
    await page.click('#cam'); await draw(); await page.click('#topCenter');
    const targets = await page.evaluate(async () => {
      const { decodeMap } = await import('./lidar.js'), { fits } = await import('./astar.js');
      const map = decodeMap(await (await fetch('assets/warehouse/map.json')).json());
      const world = (i) => [map.origin[0] + (i % map.w + .5) * map.res, map.origin[1] + (map.h - Math.floor(i / map.w) - .5) * map.res];
      const blocked = world(Array.from(map.px).findIndex((v, i) => v !== 254 && i % map.w > 5 && i % map.w < map.w - 5 && i > map.w * 5 && i < map.w * (map.h - 5)));
      let clear;
      for (let i = Math.floor(map.px.length / 3); i < map.px.length; i++) {
        const [x, y] = world(i);
        if (Math.hypot(x - __sim.sim.d.qpos[0], y - __sim.sim.d.qpos[1]) > 1 && await fits(map, { x, y })) { clear = [x, y]; break; }
      }
      return { blocked, clear, outside: [map.origin[0] - .1, map.origin[1] + map.h * map.res / 2] };
    });
    for (const [target, reason, name] of [[targets.outside, '지도 밖', '04-outside'], [targets.blocked, '장애물', '05-blocked']]) {
      await clickWorld(target);
      await page.waitForFunction(() => !__sim.startPicking().busy);
      await draw();
      assert.match(await page.textContent('#goalNote'), new RegExp(reason));
      assert.equal(await page.getAttribute('#topCenter', 'aria-pressed'), 'true');
      assert.deepEqual(await page.evaluate(() => __sim.marks()), []);
      assert.equal(page.url(), before);
      await shot(name);
    }
    const yaw = await page.evaluate(() => __sim.locator().yaw);
    await Promise.all([page.waitForURL((url) => url.searchParams.has('start')), clickWorld(targets.clear)]);
    await ready();
    const opened = new URL(page.url()), start = await page.evaluate(() => __sim.start());
    assert.equal(start.custom, true);
    start.xy.forEach((v, i) => assert.ok(Math.abs(v - targets.clear[i]) <= .005001, 'projected click is rounded to two decimals'));
    assert.equal(start.yaw, +yaw.toFixed(2));
    assert.equal(opened.searchParams.get('other'), 'keep'); assert.equal(opened.hash, '#retain');
    assert.equal(await page.evaluate(() => __sim.stopped()), true);
    await shot('06-reopened-follow');
    await page.click('#cam'); await draw(); await shot('07-reopened-top');
    // Position and direction track the actual pose; CSS size survives zoom and resize.
    await page.evaluate(() => { __sim.sim.d.qpos[0] += .25; __sim.sim.d.qpos[1] += .25; __sim.sim.d.qpos[3] = Math.SQRT1_2; __sim.sim.d.qpos[4] = 0; __sim.sim.d.qpos[5] = 0; __sim.sim.d.qpos[6] = Math.SQRT1_2; });
    await draw();
    const tracked = await page.evaluate(() => ({ locator: __sim.locator(), xy: Array.from(__sim.sim.d.qpos.slice(0, 2)), yaw: 2 * Math.atan2(__sim.sim.d.qpos[6], __sim.sim.d.qpos[3]) }));
    assert.deepEqual(tracked.locator.xy, tracked.xy, 'locator follows pose after that frame’s normal policy/physics tick');
    assert.equal(tracked.locator.yaw, tracked.yaw);
    assert.ok(Math.abs(tracked.locator.yaw - Math.PI / 2) < .1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise((r) => __nativeRAF(() => __nativeRAF(r))));
    console.log('phone viewport', await page.evaluate(() => ({ width: innerWidth, canvas: document.querySelector('canvas').width, dpr: devicePixelRatio })));
    await draw();
    assert.ok(await page.evaluate(() => Math.abs(__sim.locator().pixels - 1) < 1e-12));
    await shot('08-phone-top');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => new Promise((r) => __nativeRAF(() => __nativeRAF(r))));
    await page.goto(base + '?map=factory-zone&floor=f1&policyBackend=f32&other=keep'); await ready();
    await page.click('#cam'); await draw(); await page.click('[data-floor="all"]'); await draw();
    await page.click('#topCenter'); await page.mouse.click(640, 400); await draw();
    assert.match(await page.textContent('#goalNote'), /층을 먼저/);
    await page.click('[data-floor="1"]'); await draw();
    const upstairs = await page.evaluate(async () => {
      const { decodeMap } = await import('./lidar.js');
      return decodeMap(await (await fetch('assets/factory-zone/map-f2.json')).json()).spawn_xyyaw.slice(0, 2);
    });
    await Promise.all([page.waitForURL((url) => url.searchParams.get('floor') === 'f2'), clickWorld(upstairs)]);
    await ready();
    assert.equal(await page.evaluate(() => __sim.start().floor), 'f2');
    assert.equal(await page.evaluate(() => __sim.start().custom), true);
    await page.click('#cam'); await draw(); await shot('09-floor2-top');
    await page.click('#go'); await page.waitForFunction(() => !__sim.stopped()); await draw();
    await page.click('#scenarioMenu'); await page.click('#scenarioRun');
    await page.evaluate(() => __sim.settled()); await draw();
    assert.equal(await page.evaluate(() => __sim.scenario.active || __sim.patrol.active), true);
    assert.equal(await page.isDisabled('#topCenter'), true);
    // Replay stays local to this test server; no robot endpoint is contacted.
    await page.route('**/api/v1/robots/**', (route) => route.fulfill({ status: 403, body: '{}' }));
    await page.goto(base + '?map=warehouse&policy=go2-demo&from=web&robot=00000000-0000-0000-0000-000000000001'); await ready();
    await page.click('#cam'); await draw();
    assert.equal(await page.isDisabled('#topCenter'), true);
    assert.equal(await page.evaluate(() => __sim.locator().visible), true);
    assert.equal(await page.evaluate(() => __sim.startPicking().active), false);
    await page.goto(base + '?map=collapsed-house-v2&policyBackend=f32'); await ready();
    await page.click('#cam'); await draw(); await shot('10-house-top');
    assert.deepEqual(errors, []);
    console.log('start pick headless PASS: cancel, drag, framing, invalid picks, reopen, floor, locator, scenario guard');
  } finally { await browser?.close(); await new Promise((r) => server.close(r)); }
}

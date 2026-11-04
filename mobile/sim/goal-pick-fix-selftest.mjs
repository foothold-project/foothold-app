// Run from repository root after sync-web, under the shared heavy-test lock.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
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
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const open = async (params) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: .5 });
    await p.addInitScript(() => { requestAnimationFrame = (f) => { window.__frame = f; return 1; }; Math.random = () => 0; });
    await p.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?${new URLSearchParams({ policyBackend: 'f32', ...params })}`);
    await p.waitForFunction(() => __sim?.ready || __sim?.err, null, { polling: 50, timeout: 120000 });
    assert.equal(await p.evaluate(() => __sim.err), null);
    await p.evaluate(() => __frame(performance.now()));
    return p;
  };
  for (const [id, floor, target] of [['factory-inspection', '', [49.5, 49.5]], ['collapsed-house-v2', '', [4.7, -3.3]], ['factory-zone', 'f1', null], ['warehouse', '', null]]) {
    const p = await open({ map: id, floor });
    const result = await p.evaluate(async ({ id, floor, target }) => {
      const { decodeMap } = await import('./lidar.js'), { inflate, findPath } = await import('./astar.js');
      const map = decodeMap(await (await fetch(`assets/${id}/${floor ? 'map-' + floor : 'map'}.json`)).json());
      __sim.sim.walkSurface.attach(map, floor === 'f1' ? 1.6 : Infinity);
      const from = { x: map.spawn_xyyaw[0], y: map.spawn_xyyaw[1] };
      const grid = await inflate(map);
      let to = target && { x: target[0], y: target[1] }, far = 0;
      if (!to) for (let i = 0; i < grid.length; i++) if (!grid[i]) {
        const x = map.origin[0] + (i % map.w + .5) * map.res, y = map.origin[1] + (map.h - Math.floor(i / map.w) - .5) * map.res;
        const distance = Math.hypot(x - from.x, y - from.y);
        if (distance > far) { far = distance; to = { x, y }; }
      }
      const flat = map.prepareNavigation(grid), start = performance.now();
      const path = await findPath(map, from, to), ms = performance.now() - start;
      if (!path) throw Error(`no path ${JSON.stringify(to)}`);
      // Independent height-free baseline retains A* tie breaking/smoothing.
      const plain = { ...map }; delete plain.heightAt; delete plain.prepareNavigation;
      const base = await findPath(plain, from, to);
      return { id, floor, from, to, flat, ms, path, flatParity: JSON.stringify(path) === JSON.stringify(base) };
    }, { id, floor, target });
    console.log(JSON.stringify({ firstPath: result }));
    assert.ok(result.ms <= (id === 'factory-inspection' ? 2000 : 3000), `${id}: ${result.ms} ms`);
    if (id !== 'collapsed-house-v2') assert.ok(result.flatParity, 'flat map path matches height-free A*');
    if (id === 'factory-inspection') {
      await p.click('#cam'); await p.click('#go'); await p.evaluate(() => __frame(performance.now()));
      const screen = await p.evaluate(() => __sim.toScreen(49.5, 49.5));
      const start = performance.now(); await p.mouse.click(...screen); await p.evaluate(() => __sim.settled());
      const ms = performance.now() - start, marks = await p.evaluate(() => __sim.marks());
      console.log(JSON.stringify({ firstActualClick: { id, ms, marks } }));
      assert.equal(marks.length, 1); assert.ok(ms <= 2000);
    }
    await p.close();
  }
  const p = await open({ map: 'collapsed-house-v2', start: '3.85,-4.85,1.57' });
  // Reproduce the review's raised follow camera through real drag + wheel.
  await p.mouse.move(640, 350); await p.mouse.down(); await p.mouse.move(640, 475, { steps: 10 }); await p.mouse.up();
  await p.mouse.wheel(0, 3000); await p.evaluate(() => { for (let i = 0; i < 20; i++) __frame(performance.now()); });
  const camera = await p.evaluate(() => __sim.cam());
  await p.click('#go');
  let departures = 0;
  const hits = [];
  for (const roof of [[2.22, -4.13, 5.27], [3.24, -4.73, 5.20], [2.22, -4.13, 5.27], [3.24, -4.73, 5.20], [2.22, -4.13, 5.27], [3.24, -4.73, 5.20]]) {
    const screen = await p.evaluate(([x, y, z]) => __sim.toScreen(x, y, z), roof);
    assert.ok(screen[0] > 0 && screen[0] < 1280 && screen[1] > 0 && screen[1] < 800, `roof on screen: ${screen}`);
    await p.mouse.click(...screen); await p.evaluate(() => __sim.settled()); await p.evaluate(() => __frame(performance.now()));
    const hit = await p.evaluate(() => ({ active: __sim.scenario.active, marks: __sim.marks(), note: __sim.goalNote() }));
    if (hit.active || hit.marks.length) departures++;
    assert.match(hit.note, /바닥|가파른|장애물/); hits.push(hit);
  }
  console.log(JSON.stringify({ roofClicks: { camera, clicks: 6, departures, hits } }));
  assert.equal(departures, 0);
  await p.click('#cam'); await p.evaluate(() => __frame(performance.now()));
  await p.mouse.click(...await p.evaluate(() => __sim.toScreen(3.85, -3.85)));
  await p.evaluate(() => __sim.settled());
  const indoor = await p.evaluate(() => ({ marks: __sim.marks(), note: __sim.goalNote(), status: __sim.scenario.status }));
  console.log(JSON.stringify({ topIndoor: indoor }));
  assert.equal(indoor.marks.length, 1, `top-view indoor floor remains pickable: ${JSON.stringify(indoor)}`);
  await p.close();
  const slow = await open({ map: 'warehouse', from: 'web' });
  await slow.click('#cam'); await slow.click('#go');
  await slow.waitForFunction(() => !__sim.stopped(), null, { polling: 25 });
  await slow.evaluate(() => __frame(performance.now()));
  let release;
  const held = new Promise((r) => { release = r; });
  await slow.route('**/api/v1/org/settings', async (route) => { await held; await route.fulfill({ json: {} }); });
  await slow.mouse.click(...await slow.evaluate(() => __sim.toScreen(-1, 0)));
  await slow.waitForTimeout(650); await slow.evaluate(() => __frame(performance.now()));
  assert.match(await slow.evaluate(() => __sim.goalNote()), /길 찾는 중/, 'pending planning is visible after 0.5 seconds');
  await slow.mouse.click(...await slow.evaluate(() => __sim.toScreen(-2, 0)));
  release(); await slow.evaluate(() => __sim.settled());
  const single = await slow.evaluate(() => __sim.marks());
  assert.equal(single.length, 1, 'busy rejects duplicate click'); assert.ok(Math.abs(single[0].x + 1) < .01);
  await slow.close();
  console.log('goal pick fix PASS: cold path latency, flat A* parity, six actual roof clicks rejected, top-view indoor click accepted');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

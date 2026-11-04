// REVIEW-282B fans / raised-camera grid, using real headless pointer clicks.
// sync-web first; run each --part=range|latency|roof|frames under the shared flock.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www'), part = process.argv.find((a) => a.startsWith('--part='))?.slice(7) ?? 'range';
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
  const open = async (params, revision) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: .5 });
    // Expose the same read-only closure inspector as the review; leave all
    // handlers, rays, navigation and policies unchanged.
    await p.route('**/sim/main.js', async (route) => {
      const source = revision ? execFileSync('git', ['show', `${revision}:mobile/sim/main.js`], { encoding: 'utf8' }) : readFileSync(resolve(root, 'sim/main.js'), 'utf8');
      const anchor = 'const say = (text) => { note =';
      assert.ok(source.includes(anchor));
      await route.fulfill({ contentType: 'text/javascript', body: source.replace(anchor,
        'window.__review = { solids, ray, THREE, layers, floors, cam: () => camera, map: () => map, vp: () => vp }; const say = (text) => { window.__lastSay = text; note =') });
    });
    if (revision) for (const file of ['astar.js', 'walk-surface.js']) await p.route(`**/sim/${file}`, (route) => route.fulfill({
      contentType: 'text/javascript', body: execFileSync('git', ['show', `${revision}:mobile/sim/${file}`], { encoding: 'utf8' }),
    }));
    await p.addInitScript(() => { requestAnimationFrame = (f) => { window.__frame = f; return 1; }; Math.random = () => 0; });
    await p.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?${new URLSearchParams({ policyBackend: 'f32', ...params })}`);
    await p.waitForFunction(() => globalThis.__sim?.ready || globalThis.__sim?.err, null, { polling: 50, timeout: 120000 });
    assert.equal(await p.evaluate(() => __sim.err), null);
    await p.evaluate(() => __frame(performance.now()));
    return p;
  };
  const tap = async (p, screen) => {
    await p.mouse.click(...screen); await p.evaluate(() => __sim.settled());
    return p.evaluate(() => {
      const marks = __sim.marks(), active = __sim.scenario.active, note = window.__lastSay;
      if (marks.length || active) document.getElementById('wpClear').click();
      return { marks, active, note };
    });
  };
  const fan = (cx, cy, fx, fy, ds, z) => ds.flatMap((d) => [-.3, -.2, -.1, -.05, 0, .05, .1, .2, .3].map((a) =>
    [cx + d * (fx * Math.cos(a) - fy * Math.sin(a)), cy + d * (fx * Math.sin(a) + fy * Math.cos(a)), z]));
  if (part === 'range') {
    for (const [params, points, minimum] of [
      [{ map: 'factory-inspection' }, fan(24, 21.43, 0, 1, [8, 9, 10, 12, 15, 20, 25], 0), 50],
      [{ map: 'factory-zone', floor: 'f2' }, fan(5.65, 4.65, 1, 0, [1.5, 2], 2), 16],
      [{ map: 'warehouse' }, fan(-.066, 0, 1, 0, [4, 6], .034226), 14],
    ]) {
      const p = await open(params); await p.click('#go'); await p.evaluate(() => __frame(performance.now()));
      const groups = await p.evaluate(() => Array.from(__sim.sim.m.geom_group));
      let accepted = 0; const rejected = [];
      for (const point of points) {
        const screen = await p.evaluate(([x, y, z]) => __sim.toScreen(x, y, z), point);
        assert.ok(screen[0] > 0 && screen[0] < 1280 && screen[1] > 0 && screen[1] < 800);
        assert.equal(await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, screen), 'CANVAS');
        const result = await tap(p, screen);
        if (result.marks.length) accepted++; else rejected.push({ point, note: result.note });
      }
      console.log(JSON.stringify({ followFan: params, accepted, total: points.length, rejected }));
      assert.ok(accepted >= minimum, `${JSON.stringify(params)}: ${accepted}/${points.length}, need ${minimum}`);
      assert.deepEqual(await p.evaluate(() => Array.from(__sim.sim.m.geom_group)), groups, 'camera/contact exclusions restored before policy input');
      await p.close();
    }
  } else if (part === 'latency') {
    for (const [params, target, margin, limit] of [
      [{ map: 'factory-inspection' }, [49.5, 49.5], false, 2000],
      [{ map: 'factory-inspection' }, [49.5, 49.5], true, 2000],
      [{ map: 'factory-inspection-alt1' }, null, true, 2000],
      [{ map: 'collapsed-house-v2' }, [-12.975, 12.975], false, 3000],
      [{ map: 'collapsed-house-v2', start: '3.85,-4.85,1.57' }, [-12.975, 12.975], false, 3000],
      [{ map: 'factory-zone', floor: 'f1' }, null, false, 3000],
    ]) {
      const p = await open(params);
      const setup = await p.evaluate(async ({ target, margin }) => {
        const { inflate } = await import('./astar.js'), map = __review.map(), grid = await inflate(map), q = __sim.sim.d.qpos;
        const point = (i) => ({ x: map.origin[0] + (i % map.w + .5) * map.res, y: map.origin[1] + (map.h - Math.floor(i / map.w) - .5) * map.res });
        let nearest = null, nd = Infinity, farthest = null, fd = 0;
        for (let i = 0; i < grid.length; i++) {
          const pt = point(i), distance = Math.hypot(pt.x - q[0], pt.y - q[1]);
          if (grid[i] && map.px[i] === 254 && distance < nd) { nd = distance; nearest = pt; }
          if (!grid[i] && distance > fd) { fd = distance; farthest = pt; }
        }
        // ?start correctly rejects inflated-margin starts; pose the robot
        // there to reproduce a robot that has walked beside a wall.
        if (margin) { q[0] = nearest.x; q[1] = nearest.y; }
        return { from: [q[0], q[1]], target: target ?? [farthest.x, farthest.y] };
      }, { target, margin });
      await p.click('#cam'); await p.click('#go'); await p.evaluate(() => __frame(performance.now()));
      const pose = await p.evaluate(async () => {
        const { inflate } = await import('./astar.js'), map = __review.map(), grid = await inflate(map), q = __sim.sim.d.qpos;
        const i = (map.h - 1 - Math.floor((q[1] - map.origin[1]) / map.res)) * map.w + Math.floor((q[0] - map.origin[0]) / map.res);
        return { actualFrom: [q[0], q[1]], inBand: !!grid[i] };
      });
      if (margin) assert.equal(pose.inBand, true, 'actual click starts in the inflated wall margin');
      const screen = await p.evaluate(([x, y]) => __sim.toScreen(x, y), setup.target);
      const start = performance.now(), result = await tap(p, screen), ms = performance.now() - start;
      console.log(JSON.stringify({ coldActualClick: params, margin, ...setup, ...pose, ms, marks: result.marks.length, note: result.note }));
      assert.equal(result.marks.length, 1); assert.ok(ms <= limit, `${params.map}: ${ms} > ${limit}`);
      await p.close();
    }
  } else if (part === 'roof') {
    const p = await open({ map: 'collapsed-house-v2', start: '3.85,-4.85,1.57' });
    await p.mouse.move(640, 350); await p.mouse.down(); await p.mouse.move(640, 475, { steps: 10 }); await p.mouse.up();
    await p.mouse.wheel(0, 3000); await p.evaluate(() => { for (let i = 0; i < 20; i++) __frame(performance.now()); });
    await p.click('#go'); await p.evaluate(() => __frame(performance.now()));
    let departures = 0;
    for (let i = 0; i < 6; i++) {
      const point = i % 2 ? [3.24, -4.73, 5.20] : [2.22, -4.13, 5.27];
      const result = await tap(p, await p.evaluate(([x, y, z]) => __sim.toScreen(x, y, z), point));
      if (result.marks.length || result.active) departures++;
    }
    assert.equal(departures, 0);
    let sampled = 0, roofs = 0, roofDepartures = 0;
    // Exactly the review's 26 x 16 screen grid, excluding UI pixels.
    for (let iy = 0; iy < 16; iy++) for (let ix = 0; ix < 26; ix++) {
      const screen = [(ix + .5) * 1280 / 26, (iy + .5) * 800 / 16];
      const renderZ = await p.evaluate(([sx, sy]) => {
        if (document.elementFromPoint(sx, sy)?.tagName !== 'CANVAS') return null;
        const { ray, THREE, solids, cam, vp } = __review, [l, t, w, h] = vp();
        ray.setFromCamera(new THREE.Vector2(((sx - l) / w) * 2 - 1, 1 - ((sy - t) / h) * 2), cam());
        return ray.intersectObjects(solids, false)[0]?.point.z ?? -Infinity;
      }, screen);
      if (renderZ === null) continue;
      sampled++; if (renderZ > 2) roofs++;
      const result = await tap(p, screen);
      if (result.marks.length && renderZ > result.marks[0].z + 1) roofDepartures++;
    }
    console.log(JSON.stringify({ raisedRoof: { camera: await p.evaluate(() => __sim.cam()), departures, sampled, roofs, roofDepartures } }));
    assert.ok(roofs > 20); assert.equal(roofDepartures, 0);
    await p.click('#cam'); await p.evaluate(() => __frame(performance.now()));
    const indoor = await tap(p, await p.evaluate(() => __sim.toScreen(3.85, -3.85)));
    assert.equal(indoor.marks.length, 1);
    console.log(JSON.stringify({ topIndoor: indoor.marks }));
    await p.close();
  } else if (part === 'frames') {
    // No background terrain fill is needed by corridor validation. Measure
    // initial running frames against the reviewed head, including rendering.
    const rows = [];
    for (const revision of ['d384c14', null]) {
      const p = await open({ map: 'collapsed-house-v2' }, revision);
      await p.click('#go');
      const samples = [];
      for (let i = 0; i < 24; i++) {
        samples.push(await p.evaluate(() => { const t = performance.now(); __frame(t); return performance.now() - t; }));
        await p.waitForTimeout(50);
      }
      samples.sort((a, b) => a - b);
      rows.push({ revision: revision ?? 'working', p50: samples[12], p95: samples[22], max: samples[23], frames: samples.length });
      await p.close();
    }
    console.log(JSON.stringify({ startupFrames: rows, backgroundHeightFill: false }));
  } else throw Error(`unknown part ${part}`);
  console.log(`goal pick ${part} PASS`);
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

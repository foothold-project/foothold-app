// Sync www first; run under the shared heavy-test flock. Real headless page,
// real policies, static top-view picking comparison, no remote requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www'), reserved = [8453, 8792, 5190, 5191, 5195, 8870, 9430, 9761];
const server = createServer((req, res) => {
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  try {
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
do {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  if (!reserved.includes(server.address().port)) break;
  await new Promise((r) => server.close(r));
} while (true);
let browser;
const errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const open = async (params) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: .5, hasTouch: true });
    p.on('pageerror', (e) => errors.push(e.message));
    // Freeze only RAF: tests can measure exact simulated seconds without
    // depending on policy speed or rendering speed.
    await p.addInitScript(() => { window.__realRAF = requestAnimationFrame.bind(window); requestAnimationFrame = (f) => { window.__frame = f; return 1; }; Math.random = () => 0; });
    await p.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?${new URLSearchParams(params)}`);
    await p.waitForFunction(() => __sim?.ready || __sim?.err, null, { timeout: 120000, polling: 100 });
    assert.equal(await p.evaluate(() => __sim.err), null);
    await p.evaluate(() => __frame(performance.now() + 50));
    return p;
  };
  const onlyMap = process.argv.find((a) => a.startsWith('--map='))?.slice(6);
  if (!process.argv.includes('--house-only')) for (const [map, floor] of [['warehouse', ''], ['factory-inspection', ''], ['factory-zone', 'f1'], ['factory-zone', 'f2'], ['collapsed-house-v2', '']].filter(([map]) => !onlyMap || map === onlyMap)) {
    const p = await open({ map, floor, policyBackend: 'f32' });
    const result = await p.evaluate(async ({ map, floor }) => {
      const THREE = await import('./vendor/three.module.js');
      const { decodeMap } = await import('./lidar.js'), { inflate } = await import('./astar.js');
      const grid = decodeMap(await (await fetch(`assets/${map}/${floor ? 'map-' + floor : 'map'}.json`)).json());
      const inflated = await inflate(grid), candidates = [];
      for (let i = 0; i < inflated.length; i++) if (grid.px[i] === 254 && !inflated[i]) candidates.push(i);
      const scene = await (await fetch(`assets/${map}/scene.json`)).json();
      const oldTop = new Float64Array(grid.w * grid.h).fill(-Infinity);
      const meshes = [];
      const cameraZ = floor === 'f1' ? 1.8 : grid.floor_z + 100;
      // Rasterize vertical intersections once, rather than raycasting every
      // triangle again for every cell. Float32 vertices and DoubleSide match
      // the old Three.js scene; record the first hit below the top camera.
      for (const md of scene.models) {
        const src = scene.meshes[md.mesh], local = Float32Array.from(src.p), world = new Float64Array(local.length);
        const q = new THREE.Quaternion(md.quat[1], md.quat[2], md.quat[3], md.quat[0]), v = new THREE.Vector3();
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(local, 3)); geometry.setIndex(src.i);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        mesh.position.set(...md.pos); mesh.quaternion.copy(q); mesh.updateMatrixWorld(true); meshes.push(mesh);
        for (let i = 0; i < local.length; i += 3) {
          v.fromArray(local, i).applyQuaternion(q); world[i] = v.x + md.pos[0]; world[i + 1] = v.y + md.pos[1]; world[i + 2] = v.z + md.pos[2];
        }
        for (let i = 0; i < src.i.length; i += 3) {
          const ia = src.i[i] * 3, ib = src.i[i + 1] * 3, ic = src.i[i + 2] * 3;
          const ax = world[ia], ay = world[ia + 1], az = world[ia + 2], bx = world[ib] - ax, by = world[ib + 1] - ay, bz = world[ib + 2] - az,
            cx = world[ic] - ax, cy = world[ic + 1] - ay, cz = world[ic + 2] - az, det = bx * cy - by * cx;
          if (Math.abs(det) < 1e-12) continue;
          const c0 = Math.max(0, Math.ceil((Math.min(ax, ax + bx, ax + cx) - grid.origin[0]) / grid.res - .5 - 1e-8));
          const c1 = Math.min(grid.w - 1, Math.floor((Math.max(ax, ax + bx, ax + cx) - grid.origin[0]) / grid.res - .5 + 1e-8));
          const r0 = Math.max(0, Math.ceil((Math.min(ay, ay + by, ay + cy) - grid.origin[1]) / grid.res - .5 - 1e-8));
          const r1 = Math.min(grid.h - 1, Math.floor((Math.max(ay, ay + by, ay + cy) - grid.origin[1]) / grid.res - .5 + 1e-8));
          for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
            const j = (grid.h - 1 - r) * grid.w + c;
            if (inflated[j]) continue;
            const dx = grid.origin[0] + (c + .5) * grid.res - ax, dy = grid.origin[1] + (r + .5) * grid.res - ay;
            const u = (dx * cy - dy * cx) / det, v = (bx * dy - by * dx) / det;
            if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
            const z = az + u * bz + v * cz;
            if (z <= cameraZ) oldTop[j] = Math.max(oldTop[j], z);
          }
        }
      }
      const referenceRay = new THREE.Raycaster();
      let referenceChecks = 0;
      for (let k = 0; k < candidates.length; k += Math.max(1, Math.ceil(candidates.length / 64))) {
        const i = candidates[k], x = grid.origin[0] + (i % grid.w + .5) * grid.res, y = grid.origin[1] + (grid.h - 1 - Math.floor(i / grid.w) + .5) * grid.res;
        referenceRay.set(new THREE.Vector3(x, y, cameraZ), new THREE.Vector3(0, 0, -1));
        const first = referenceRay.intersectObjects(meshes, false)[0];
        const allowed = !(first && first.distance < cameraZ - grid.floor_z - .02 && Math.abs(first.point.z - grid.floor_z) > .05);
        if (allowed !== (oldTop[i] <= grid.floor_z + .05)) throw new Error(`old-pick raster/reference disagree: ${x},${y}`);
        referenceChecks++;
      }
      let before = 0, after = 0, n = 0, raised = 0;
      const ceiling = floor === 'f1' ? 1.6 : floor === 'f2' ? 7.6 : Infinity;
      for (const i of candidates) {
        const x = grid.origin[0] + (i % grid.w + .5) * grid.res, y = grid.origin[1] + (grid.h - 1 - Math.floor(i / grid.w) + .5) * grid.res;
        if (oldTop[i] <= grid.floor_z + .05) before++;
        const hit = __sim.sim.walkSurface.pick([x, y, Math.min(cameraZ, ceiling)], [0, 0, -1], grid, ceiling);
        const support = __sim.sim.walkSurface.floorAt(x, y, ceiling, Math.SQRT1_2, grid.floor_z);
        if (hit && hit.up >= Math.SQRT1_2 && hit.z < ceiling && Number.isFinite(support) && Math.abs(hit.z - support) <= .05) { after++; if (hit.z > grid.floor_z + .1) raised++; }
        n++;
      }
      return { map, floor, denominator: 'all XY-clear cell centers; robot excluded', totalCells: grid.w * grid.h, clearCells: candidates.length,
        cells: n, referenceChecks, before, after, raised, beforePercent: +(before / n * 100).toFixed(2), afterPercent: +(after / n * 100).toFixed(2) };
    }, { map, floor });
    console.log(JSON.stringify({ picking: result }));
    assert.ok(result.after > 0, `${map}/${floor} has pickable cells`);
    if (map === 'collapsed-house-v2') assert.ok(result.after > result.before, 'house elevated surfaces become pickable');
    if (map === 'warehouse') {
      await p.click('#go'); await p.click('#cam'); await p.evaluate(() => __frame(performance.now() + 50));
      await p.mouse.click(...await p.evaluate(() => __sim.toScreen(-1, 0)));
      await p.evaluate(() => __sim.settled()); await p.evaluate(() => __frame(performance.now() + 50));
      const click = await p.evaluate(() => ({ marks: __sim.marks(), note: __sim.goalNote(), pose: Array.from(__sim.sim.d.qpos.slice(0, 3)),
        support: __sim.sim.walkSurface.floorAt(-1, 0), hit: __sim.sim.walkSurface.raycast([-1, 0, 100], [0, 0, -1]) }));
      assert.equal(click.marks.length, 1, `warehouse floor click: ${JSON.stringify(click)}`);
    }
    await p.close();
  }
  if (!process.argv.includes('--coverage-only')) for (const [policy, label, start, goal] of [
    ['foothold-v2', 'entrance', [3.85, -4.85, Math.PI / 2], [3.85, -3.85]],
    ['ame2-demo', 'room1E', [4.7, -3.3, Math.PI], [3.7, -3.3]],
    ['start-demo', 'mid', [.65, 1.25, Math.PI], [-.35, 1.25]],
  ]) {
    const p = await open({ map: 'collapsed-house-v2', policy, start: start.join(','), policyBackend: policy === 'start-demo' ? 'wasm' : 'f32' });
    const initial = await p.evaluate(() => {
      __sim.sim.reset();
      return { q: Array.from(__sim.sim.d.qpos.slice(0, 3)), start: __sim.start() };
    });
    assert.equal(initial.start.custom, true, `${label} accepted`);
    assert.ok(initial.start.spawnFloorZ > 1, `inside actual house floor: ${JSON.stringify(initial)}`);
    assert.ok(Math.abs(initial.q[2] - initial.start.spawnFloorZ - .4) < 1e-9, 'exact actual floor + .4');
    await p.evaluate(() => { __sim.sim.hold(.5); document.getElementById('go').click(); document.getElementById('cam').click(); });
    await p.evaluate(() => __frame(performance.now()));
    const screen = await p.evaluate(([x, y]) => __sim.toScreen(x, y), goal);
    await p.mouse.click(...screen);
    await p.evaluate(() => __sim.settled());
    const accepted = await p.evaluate(() => ({ marks: __sim.marks(), active: __sim.scenario.active, note: __sim.goalNote() }));
    assert.equal(accepted.marks.length, 1, `${label} real screen click accepted: ${JSON.stringify(accepted)}`);
    assert.ok(accepted.marks[0].z > 1, 'goal uses elevated surface');
    // The UI's runner already owns interruption and retry state. Run actual
    // RAF for this portion, keeping policy inference and lidar in main.js.
    await p.evaluate(() => {
      window.__pump = true;
      let drawn = -Infinity;
      const tick = (now) => {
        if (!__pump) return;
        // Preview at 10 Hz; the app's fixed policy clock still runs at 50 Hz.
        // Software WebGL must not flood the GPU while async depth is pending.
        if (now - drawn >= 100) { __frame(now); drawn = now; }
        __realRAF(tick);
      };
      __realRAF(tick);
    });
    const startTime = await p.evaluate(() => __sim.sim.t);
    await p.waitForFunction((t) => (!__sim.scenario.active && !__sim.marks().length) || __sim.sim.t > t + 35, startTime, { timeout: 240000, polling: 100 });
    const moved = await p.evaluate(([sx, sy, gx, gy]) => {
      __pump = false;
      const q = __sim.sim.d.qpos;
      return { status: __sim.scenario.status, active: __sim.scenario.active, seconds: __sim.sim.t,
        moved: Math.hypot(q[0] - sx, q[1] - sy), remaining: Math.hypot(q[0] - gx, q[1] - gy) };
    }, [...start, ...goal].filter((_, i) => i !== 2));
    assert.equal(moved.active, false, `${label} goal must finish or block within 35 simulated seconds`);
    console.log(JSON.stringify({ goal: { policy, label, ...moved } }));
    // Reset to the same URL start, use the real forward stick, then step
    // exactly five policy seconds with that UI-derived command.
    await p.evaluate(() => { document.getElementById('reset').click(); document.getElementById('go').click(); });
    const box = await p.locator('#stickL').boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await p.mouse.move(cx, cy); await p.mouse.down(); await p.mouse.move(cx, cy - box.height);
    await p.evaluate(async () => {
      for (let i = 0; i < 200; i++) {
        __frame(performance.now() + 50);
        if (__sim.sim.cmd[0] > 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('forward stick did not reach the policy command');
    });
    const stick = await p.evaluate(async () => {
      const { getPolicyMode } = await import('./policy-modes.js');
      const s = __sim.sim, from = Array.from(s.d.qpos.slice(0, 2)), command = s.cmd.slice(), dt = getPolicyMode(s.adapterId).timing.policyDt, t0 = s.t;
      while (s.t - t0 < 5 - dt / 2) { s.cmd = command.slice(); if (await s.step() === false) await new Promise((r) => setTimeout(r, 0)); }
      return { command, seconds: s.t - t0, moved: Math.hypot(s.d.qpos[0] - from[0], s.d.qpos[1] - from[1]), z: s.d.qpos[2] };
    });
    await p.mouse.up();
    assert.ok(stick.command[0] > 0, 'real forward-stick command');
    console.log(JSON.stringify({ start: { policy, label, floorZ: initial.start.spawnFloorZ, resetZ: initial.q[2], ...stick } }));
    await p.close();
  }
  assert.deepEqual(errors, []);
  console.log('elevated goals PASS: map sampling, three indoor URL starts and real goal clicks/policies, exact reset height, five simulated seconds of forward stick');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

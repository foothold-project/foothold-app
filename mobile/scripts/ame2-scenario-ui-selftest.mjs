// Headless Chrome only, ephemeral port, generated offline bundle; no server/robot.
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
    let body = readFileSync(file);
    if (file.endsWith('/main.js')) body = String(body)
      .replace('front = frontDistance(r); rays = r;', 'front = frontDistance(r); rays = r; window.__scanCount = (window.__scanCount || 0) + 1;')
      .replace('renderer.render(scene, camera);', "window.__lidarDraws = scene.children.filter(c => c.material?.color?.getHex() === 0x39ff88).length; renderer.render(scene, camera);");
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse&policy=ame2-demo`);
  await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => __sim.err), null);
  await page.click('#scenarioMenu');
  assert.equal(await page.locator('#scenarioSelect').isEnabled(), true);
  await page.click('#scenarioMenu');   // 바깥 누름은 닫기만 하므로 시작 전에 창을 닫는다
  await page.click('#go'); await page.click('#scenarioMenu'); await page.click('#scenarioRun');
  await page.waitForFunction(() => __sim.scenario.active && __sim.cmd().length === 4);
  assert.match(await page.locator('#scenarioStatus').textContent(), /지점 [1-4]\/4/);
  await page.dispatchEvent('#stop', 'pointerdown');
  const snap = await page.evaluate(() => ({ t: __sim.sim.d.time, active: __sim.scenario.active, stopped: __sim.stopped(), cmd: __sim.cmd() }));
  assert.equal(snap.active, false); assert.equal(snap.stopped, true); assert.deepEqual(snap.cmd, [0, 0, 0, 1]);
  await page.waitForTimeout(200); assert.equal(await page.evaluate(() => __sim.sim.d.time), snap.t);
  assert.equal(await page.evaluate(() => __lidarDraws), 0);
  assert.ok(await page.evaluate(() => __scanCount > 1), '10 Hz scan continues without drawings');
  // Controlled pose changes verify stage/completion UI; gait is measured separately.
  await page.click('#reset'); await page.click('#go'); await page.click('#scenarioMenu'); await page.click('#scenarioRun');
  await page.waitForFunction(() => __sim.scenario.active);
  await page.evaluate(() => {
    const { sim, scenario: r } = __sim;
    while (r.active) { const p = r.points[r.index]; sim.d.qpos[0] = p.x; sim.d.qpos[1] = p.y; r.tick(Infinity, .02); }
  });
  await page.waitForFunction(() => document.querySelector('#scenarioStatus').textContent === '완료');
  await page.click('#scenarioMenu');   // 실행 준비의 reset·시작 누름은 창이 닫힌 상태에서
  await page.click('#reset'); await page.click('#go'); await page.click('#scenarioMenu'); await page.click('#scenarioRun');
  await page.waitForFunction(() => __sim.scenario.active);
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => __sim.stopped() && !__sim.scenario.active), true);
  await page.click('#scenarioMenu');
  await page.click('#reset'); await page.click('#go'); await page.click('#scenarioMenu'); await page.click('#scenarioRun');
  await page.waitForFunction(() => __sim.scenario.active);
  await page.click('#scenarioHalt');
  assert.equal(await page.evaluate(() => __sim.stopped() && !__sim.scenario.active), true);
  assert.deepEqual(errors, []);
  console.log('AME-2 scenario UI PASS: enabled, 4D goal, stage N/M, completion UI (controlled pose), STOP immediate physics delta 0/no resume, keyboard/halt locks, lidar draws 0/scans continue, pageerrors 0');
} finally { await browser.close(); await new Promise((r) => server.close(r)); }

// Headless only, ephemeral loopback port; existing Playwright/Chrome, no install.
// Run sync-web first. FH_PLAYWRIGHT=<existing playwright-core/index.mjs> node ...
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www');
const server = createServer((req, res) => {
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = readFileSync(file);
    res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ hasTouch: true });   // 터치 기기 = 조이스틱(컴퓨터는 키 — sim-keys-selftest)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const url = `http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse&policyBackend=wasm`;
  await page.route('**/ame2-demo.onnx', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto(url + '&policy=ame2-demo');
  await page.waitForFunction(() => window.__sim?.ready);
  assert.equal(await page.evaluate(() => __sim.sim.adapterId), 'ame2-demo');
  assert.equal(await page.locator('#policySelect option[value="ame2-demo"]').isDisabled(), true);
  assert.match(await page.locator('#policyEngine').textContent(), /AME-2 · JS f32 되돌림 중 · ONNX 파일 없음/);
  assert.ok(await page.locator('#policyEngine').isVisible());
  await page.unroute('**/ame2-demo.onnx');
  await page.route('**/ame2_actor*', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto(url + '&policy=ame2-demo');
  await page.waitForFunction(() => window.__sim?.ready);
  assert.equal(await page.evaluate(() => __sim.sim.adapterId), 'ame2-demo');
  assert.match(await page.locator('#policyEngine').textContent(), /ONNX WASM/);
  assert.equal(await page.locator('#policySelect option[value="ame2-demo"]').isDisabled(), false);
  await page.route('**/ame2-demo.onnx', (route) => route.fulfill({ contentType: 'text/html', body: '<html>SPA</html>' }));
  await page.goto(url + '&policy=ame2-demo');
  await page.waitForFunction(() => window.__sim?.err);
  assert.match(await page.locator('#policyEngine').textContent(), /AME-2 · 정책 잠금 · ONNX 파일 없음/);
  assert.equal(await page.evaluate(() => __sim.ready), false);
  await page.unroute('**/ame2-demo.onnx');
  await page.unroute('**/ame2_actor*');
  await page.goto(url);
  await page.waitForFunction(() => window.__sim?.ready);
  assert.equal(await page.evaluate(() => __sim.sim.adapterId), 'foothold-v2');
  await page.click('#scenarioMenu');
  await page.selectOption('#policySelect', 'ame2-demo');
  await page.waitForURL('**policy=ame2-demo');
  await page.waitForFunction(() => window.__sim?.ready && __sim.sim.adapterId === 'ame2-demo');
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  assert.equal(await page.evaluate(() => __sim.sim.t), 0);
  await page.click('#go');
  await page.waitForFunction(() => __sim.sim.t > .04);
  const stick = await page.locator('#stickL').boundingBox();
  await page.mouse.move(stick.x + stick.width / 2, stick.y + stick.height * .2);
  await page.mouse.down();
  await page.waitForFunction(() => __sim.cmd()[0] > .1);
  const cmd = await page.evaluate(() => __sim.cmd());
  assert.equal(cmd.length, 4); assert.ok(cmd[0] <= 1 && Math.hypot(cmd[0], cmd[1]) <= 1);
  const tippedAt=await page.evaluate(()=>{const s=__sim.sim,q=s.d.qpos;q[2]=.12;q[3]=0;q[4]=1;q[5]=q[6]=0;s.d.qvel.fill(0);s.hold(0);return s.t;});
  await page.waitForFunction((t)=>__sim.sim.t>t+.1,tippedAt);
  assert.equal(await page.evaluate(()=>__sim.stopped()||Object.hasOwn(__sim.sim,'fell')),false,'inverted pose keeps AME-2 running');
  assert.ok((await page.evaluate(()=>__sim.cmd()))[0]>.1,'inverted pose retains joystick goal');
  await page.dispatchEvent('#stop', 'pointerdown');
  const t = await page.evaluate(() => __sim.sim.t);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => __sim.sim.t), t);
  assert.deepEqual(await page.evaluate(() => __sim.cmd()), [0, 0, 0, 1]);
  assert.deepEqual(await page.evaluate(() => __sim.joy()), [0, 0, 0, 1]);
  await page.mouse.up(); await page.click('#go');
  assert.deepEqual(await page.evaluate(() => __sim.joy()), [0, 0, 0, 1]);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  const hiddenT = await page.evaluate(() => __sim.sim.t);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => __sim.sim.t), hiddenT);
  assert.deepEqual(await page.evaluate(() => __sim.cmd()), [0, 0, 0, 1]);
  assert.equal(await page.locator('#scenarioRun').isDisabled(), true);
  await page.click('#reset');
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  await page.click('#go');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  const visibilityT = await page.evaluate(() => __sim.sim.t);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => __sim.sim.t), visibilityT);
  assert.deepEqual(await page.evaluate(() => __sim.cmd()), [0, 0, 0, 1]);
  assert.deepEqual(errors, []);
  await page.goto(url.replace('map=warehouse', 'map=ame2-train-terrain') + '&policy=ame2-demo');
  await page.waitForFunction(() => window.__sim?.ready && __sim.sim.adapterId === 'ame2-demo');
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  await page.click('#go');
  await page.waitForFunction(() => __sim.sim.t >= .1);
  await page.dispatchEvent('#stop', 'pointerdown');
  assert.equal(await page.evaluate(() => __sim.sim.mapping.every(Number.isFinite)), true);
  assert.deepEqual(errors, []);
  if (process.argv.includes('--default')) {
    for (const id of ['foothold-v2', 'ame2-demo']) {
      await page.goto(url.replace('&policyBackend=wasm', '') + '&policy=' + id);
      await page.waitForFunction(() => window.__sim?.ready);
      assert.match(await page.locator('#policyEngine').textContent(), /ONNX WASM/);
    }
  }
  console.log('AME-2 headless UI PASS: ONNX absence/f32 fallback reason, ONNX without f32, both absent locked, optional ONNX default, select/reload locked, joystick goal, STOP clears/pauses, lifecycle locks/no auto-resume, no page errors');
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}

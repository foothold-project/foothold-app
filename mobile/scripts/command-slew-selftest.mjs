// Pure rate checks; --headless also exercises real app STOP/lock/reset handlers.
// Sync www first, set FH_PLAYWRIGHT and run headless under the heavy-test flock.
import assert from 'node:assert/strict';
import { slewCommand, START_COMMAND_SLEW as S } from '../sim/keyboard-ramp.js';
const rounded = (c) => c.map((v) => +v.toFixed(6));
let c = slewCommand([0, 0, 0], [1.5, 0, 1], .02, S);
assert.deepEqual(rounded(c), [.03, 0, .048]);
for (let i = 1; i < 50; i++) c = slewCommand(c, [1.5, 0, 1], .02, S);
assert.deepEqual(rounded(c), [1.5, 0, 1]);
let n = 0;
while (c[0] > 0) { c = slewCommand(c, [0, 0, 0], .02, S); n++; }
assert.ok(n <= 21, `release in approximately .4 seconds (${n} ticks)`);
c = [1.5, 0, 0]; let reversal = 0;
while (Math.abs(c[0] + 1.3) > 1e-9) { c = slewCommand(c, [-1.3, 0, 0], .02, S); assert.ok(++reversal < 100); }
assert.deepEqual(rounded(slewCommand([0, 0, 0], [1.5, .5, 1.2], 0, S)), [0, 0, 0]);
assert.deepEqual(rounded(slewCommand([], [1.5, .5, 1.2], .02, S)), [.03, .01, .048]);
console.log(`command slew PASS: first [.03,0,.048], full at 1s, release ${n} ticks, reverse -1.3 in ${reversal} ticks`);
if (!process.argv.includes('--headless')) process.exit(0);
const { createServer } = await import('node:http');
const { readFileSync } = await import('node:fs');
const { resolve, extname, sep } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www');
const server = createServer((req, res) => {
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  try {
    let body = readFileSync(file);
    if (file.endsWith(`${sep}sim${sep}main.js`)) body = body.toString()
      .replace('prepare: () => {', 'prepare: st.slewTestPrepare = () => {')
      .replaceAll('requestAnimationFrame(frame);', '/* test controls policy decisions */');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
do {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  if (![8453, 8792, 5190, 5191, 5195, 8870, 9430, 9761].includes(server.address().port)) break;
  await new Promise((r) => server.close(r));
} while (true);
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 520, height: 900 } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?policy=start-demo`);
  await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 90000, polling: 100 });
  assert.equal(await page.evaluate(() => __sim.err), null);
  const prepare = (ticks) => page.evaluate((ticks) => { for (let i = 0; i < ticks; i++) __sim.slewTestPrepare(); return __sim.cmd(); }, ticks);
  const stick = async () => {
    const b = await page.locator('#stickL').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y - 10);
  };
  for (const event of ['stop', 'blur', 'hidden', 'pagehide', 'freeze', 'Escape', 'Space', 'reset']) {
    await page.click('#go'); await stick();
    assert.deepEqual(rounded(await prepare(1)), [.03, 0, 0], `${event}: fresh history`);
    assert.deepEqual(rounded(await prepare(49)), [1.5, 0, 0]);
    if (event === 'stop') await page.dispatchEvent('#stop', 'pointerdown');
    else if (event === 'reset') await page.dispatchEvent('#reset', 'click');
    else if (['Escape', 'Space'].includes(event)) await page.keyboard.press(event);
    else await page.evaluate((event) => {
      if (event === 'hidden') {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange')); delete document.hidden;
      } else window.dispatchEvent(new Event(event));
    }, event);
    // No prepare/physics step between the event and this assertion.
    assert.deepEqual(await page.evaluate(() => [__sim.stopped(), __sim.cmd()]), [true, [0, 0, 0]], event);
    await page.mouse.up(); assert.deepEqual(await prepare(1), [0, 0, 0]);
    await page.click('#go'); assert.deepEqual(await prepare(1), [0, 0, 0], `${event}: old input cannot revive`);
    await stick(); assert.deepEqual(rounded(await prepare(1)), [.03, 0, 0], `${event}: restart from zero`);
    await page.mouse.up(); await page.dispatchEvent('#stop', 'pointerdown');
  }
  await page.click('#go');
  await page.evaluate(() => { const q = __sim.sim.d.qpos; __sim.scenario.start([{ x: q[0] + 5, y: q[1] }], true); });
  assert.equal(rounded(await prepare(1))[0], .03, 'runner passes through the same limiter');
  assert.deepEqual(errors, []);
  console.log('command slew headless PASS: real sticks+runner, STOP/blur/hidden/pagehide/freeze/Escape/Space/reset immediate zero, restart from zero');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

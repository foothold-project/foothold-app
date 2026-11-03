// Headless real stick/key handlers -> actual policy observation, offline/web.
// Prepare mobile/www/sim with local assets, then run with FH_PLAYWRIGHT.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www'), schema = JSON.parse(readFileSync('apps/contracts/schema/OrgSettings.json'));
const defaults = Object.fromEntries(Object.entries(schema.properties).filter(([, p]) => 'default' in p).map(([k, p]) => [k, p.default]));
let fetches = 0;
const server = createServer((req, res) => {
  if (req.url === '/api/v1/org/settings') { fetches++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(defaults)); return; }
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  for (const web of [false, true]) for (const id of ['foothold-v2', 'ame2-demo']) {
    const page = await browser.newPage({ hasTouch: true, viewport: { width: 520, height: 900 } }), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const before = fetches;
    await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?policy=${id}${web ? '&from=web' : ''}`);
    await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, undefined, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__sim.err), null);
    assert.match(await page.locator('#modeCaps').textContent(), id === 'ame2-demo' ? /목표 2 m.*1.2 m\/s/ : /앞1.5 뒤1.5 옆0.5/);
    await page.evaluate(async (id) => {
      const { getPolicyAdapter } = await import('./policy-adapters.js');
      const a = getPolicyAdapter(id), original = a.observe;
      a.observe = function (...args) { original.apply(this, args); window.__policyInput = Array.from(args[0].slice(id === 'ame2-demo' ? 45 : 9, id === 'ame2-demo' ? 49 : 12)); };
    }, id);
    await page.click('#go');
    await page.waitForFunction(() => !window.__sim.stopped());
    const cases = id === 'ame2-demo' ? [['ArrowLeft', 'stickL', -1, 0, 1, 1], ['ArrowRight', 'stickL', 1, 0, 1, -1]]
      : [['ArrowUp', 'stickL', 0, -1, 0, 1.5], ['ArrowDown', 'stickL', 0, 1, 0, -1.5],
        ['ArrowLeft', 'stickL', -1, 0, 1, .5], ['ArrowRight', 'stickL', 1, 0, 1, -.5],
        ['KeyA', 'stickR', -1, 0, 2, 1], ['KeyD', 'stickR', 1, 0, 2, -1]];
    const check = async (axis, expected) => page.waitForFunction(([axis, expected]) => Math.abs((window.__policyInput?.[axis] ?? Infinity) - expected) < 1e-5, [axis, expected]);
    for (const [key, stick, x, y, axis, expected] of cases) {
      await page.keyboard.down(key); await check(axis, expected); await page.keyboard.up(key);
      const r = await page.locator('#' + stick).boundingBox(), cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      await page.mouse.move(cx, cy); await page.mouse.down();
      await page.mouse.move(cx + x * (r.width / 2 + 10), cy + y * (r.height / 2 + 10));
      await check(axis, expected); await page.mouse.up();
    }
    await page.click('#stop');
    assert.equal(await page.evaluate(() => window.__sim.stopped()), true);
    assert.equal(fetches > before, web);
    assert.deepEqual(errors, []);
    console.log(`PASS ${id} ${web ? '?from=web organization defaults' : 'offline'} real sticks+keys -> policy observations`);
    await page.close();
  }
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

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
let organization = defaults;
let fetches = 0;
const server = createServer((req, res) => {
  if (req.url === '/api/v1/org/settings') { fetches++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(organization)); return; }
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
  const profiles = [{ name: 'offline', web: false, org: defaults }, { name: 'web-default', web: true, org: defaults },
    { name: 'web-explicit', web: true, org: { ...defaults, sim_max_vx: 1, sim_max_vy: .3, sim_max_wz: .5, sim_key_vx: .6 } }];
  for (const profile of profiles) for (const id of ['foothold-v2', 'ame2-demo']) {
    const { web, org } = profile;
    organization = org;
    const page = await browser.newPage({ hasTouch: true, viewport: { width: 520, height: 900 } }), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const before = fetches;
    await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?policy=${id}${web ? '&from=web' : ''}`);
    await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, undefined, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__sim.err), null);
    const hud = await page.locator('#modeCaps').textContent();
    if (id === 'ame2-demo') assert.match(hud, /목표 2 m.*1.2 m\/s/);
    else {
      assert.ok(hud.includes(`앞${org.sim_max_vx} 뒤${org.sim_max_vx} 옆${org.sim_max_vy}`), hud);
      assert.ok(hud.includes(`회전${Math.min(1, org.sim_max_wz)}/이동${Math.min(1, org.sim_max_wz)}`), hud);
      if (profile.name === 'web-explicit') assert.match(hud, /키0.6/);
    }
    await page.evaluate(async (id) => {
      const { getPolicyAdapter } = await import('./policy-adapters.js');
      const a = getPolicyAdapter(id), original = a.observe;
      a.observe = function (...args) { original.apply(this, args); window.__policyInput = Array.from(args[0].slice(id === 'ame2-demo' ? 45 : 9, id === 'ame2-demo' ? 49 : 12)); };
    }, id);
    await page.click('#go');
    await page.waitForFunction(() => !window.__sim.stopped());
    const vx = org.sim_max_vx, key = org.sim_key_vx, vy = org.sim_max_vy, wz = Math.min(1, org.sim_max_wz);
    const cases = id === 'ame2-demo' ? [['ArrowLeft', 'stickL', -1, 0, 1, 1, 1], ['ArrowRight', 'stickL', 1, 0, 1, -1, -1]]
      : [['ArrowUp', 'stickL', 0, -1, 0, key, vx], ['ArrowDown', 'stickL', 0, 1, 0, -key, -vx],
        ['ArrowLeft', 'stickL', -1, 0, 1, vy, vy], ['ArrowRight', 'stickL', 1, 0, 1, -vy, -vy],
        ['KeyA', 'stickR', -1, 0, 2, wz, wz], ['KeyD', 'stickR', 1, 0, 2, -wz, -wz]];
    const check = async (axis, expected) => page.waitForFunction(([axis, expected]) => Math.abs((window.__policyInput?.[axis] ?? Infinity) - expected) < 1e-5, [axis, expected]);
    for (const [key, stick, x, y, axis, keyExpected, stickExpected] of cases) {
      await page.keyboard.down(key); await check(axis, keyExpected); await page.keyboard.up(key);
      const r = await page.locator('#' + stick).boundingBox(), cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      await page.mouse.move(cx, cy); await page.mouse.down();
      await page.mouse.move(cx + x * (r.width / 2 + 10), cy + y * (r.height / 2 + 10));
      await check(axis, stickExpected); await page.mouse.up();
    }
    await page.click('#stop');
    assert.equal(await page.evaluate(() => window.__sim.stopped()), true);
    assert.equal(fetches > before, web);
    if (profile.name === 'web-explicit' && id === 'foothold-v2') {
      organization = { ...org, sim_max_vx: .8, sim_key_vx: .5, sim_max_vy: .2, sim_max_wz: .4 };
      await page.click('#go'); await page.waitForFunction(() => !window.__sim.stopped());
      const updated = await page.locator('#modeCaps').textContent();
      assert.match(updated, /앞0.8 뒤0.8 옆0.2.*회전0.4\/이동0.4.*키0.5/);
      await page.keyboard.down('ArrowLeft'); await check(1, .2); await page.keyboard.up('ArrowLeft');
      await page.click('#stop');
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${id} ${profile.name} real sticks+keys -> policy observations and effective HUD`);
    await page.close();
  }
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

// sync-web first; headless Chrome, ephemeral loopback port.
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
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const base = `http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse`;
  for (const query of ['', '&policy=foothold-v2', '&policy=nvidia-demo']) {
    const page = await browser.newPage();
    try {
      await page.goto(base + query + '&policyBackend=f32');
      await page.waitForFunction(() => window.__sim?.ready);
      assert.equal(await page.evaluate(() => __sim.sim.adapterId), 'nvidia-demo');
      assert.equal(await page.locator('#policySelect').inputValue(), 'nvidia-demo');
      assert.deepEqual(await page.locator('#policySelect option').evaluateAll((options) => options.map((o) => o.value)), ['nvidia-demo', 'start-demo', 'ame2-demo']);
      assert.equal(await page.locator('#policySelect option[value="nvidia-demo"]').textContent(), 'nvidia-demo');
      await page.click('#scenarioMenu'); await page.selectOption('#policySelect', 'ame2-demo');
      await page.waitForFunction(() => window.__sim?.ready && __sim.sim.adapterId === 'ame2-demo');
      await page.click('#scenarioMenu'); await page.selectOption('#policySelect', 'nvidia-demo');
      await page.waitForFunction(() => window.__sim?.ready && __sim.sim.adapterId === 'nvidia-demo');
      assert.match(page.url(), /policy=nvidia-demo/);
    } finally { await page.close(); }
  }
  for (const id of ['', 'unknown', 'nvidia', '__proto__']) {
    const page = await browser.newPage();
    try {
      await page.goto(base + '&policy=' + encodeURIComponent(id));
      await page.waitForFunction(() => window.__sim?.err);
      assert.equal(await page.evaluate(() => __sim.ready), false);
      assert.match(await page.locator('#policyReason').textContent(), /알 수 없는 정책 모드/);
      assert.match(await page.locator('#policyEngine').textContent(), /알 수 없는 정책 모드/);
      assert.ok(await page.locator('#policyEngine').isVisible());
      assert.ok(await page.locator('#fail').isVisible());
      assert.equal(await page.evaluate(() => __sim.sim), undefined);
    } finally { await page.close(); }
  }
  console.log('Policy modes UI PASS: default/new id/legacy alias, registry menu and mode switches, invalid/empty policies visibly fail without starting simulation');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

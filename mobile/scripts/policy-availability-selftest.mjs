// sync-web first; headless, ephemeral loopback port, no checkout changes.
// The f32 fixture reverses only the constant changed by ab997e0.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.env.FH_PLAYWRIGHT, 'FH_PLAYWRIGHT required');
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www');
const main = readFileSync(resolve(root, 'sim/main.js'), 'utf8');
const defaultLine = "const DEFAULT_POLICY_BACKEND = 'wasm';";
assert.equal(main.split(defaultLine).length, 2, 'bundle must contain the ONNX default constant exactly once');
const server = createServer((req, res) => {
  const [backend, assets, ...parts] = new URL(req.url, 'http://localhost').pathname.slice(1).split('/');
  if (!['wasm', 'f32'].includes(backend) || !['onnx-only', 'f32-only', 'both', 'neither'].includes(assets)) {
    res.writeHead(404).end(); return;
  }
  const name = parts.join('/');
  const file = resolve(root, name);
  const missing = (name === 'sim/ame2-demo.onnx' && ['f32-only', 'neither'].includes(assets))
    || (['sim/ame2_actor.f32', 'sim/ame2_actor.json'].includes(name) && ['onnx-only', 'neither'].includes(assets));
  if (!file.startsWith(root + sep) || missing) { res.writeHead(404).end(); return; }
  try {
    const body = name === 'sim/main.js' ? main.replace(defaultLine, `const DEFAULT_POLICY_BACKEND = '${backend}';`) : readFileSync(file);
    res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm',
      '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
const results = [];
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  for (const backend of ['wasm', 'f32']) for (const assets of ['onnx-only', 'f32-only', 'both', 'neither']) {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}/${backend}/${assets}/sim/index.html?map=warehouse`;
    try {
      await page.goto(url);
      await page.waitForFunction(() => window.__sim?.ready);
      const available = backend === 'f32' ? ['f32-only', 'both'].includes(assets) : assets !== 'neither';
      const option = page.locator('#policySelect option[value="ame2-demo"]');
      assert.equal(await option.isDisabled(), !available, `${backend}/${assets}: selector`);
      if (available) {
        await page.click('#scenarioMenu');
        await page.selectOption('#policySelect', 'ame2-demo');
        await page.waitForFunction(() => window.__sim?.ready && __sim.sim.adapterId === 'ame2-demo');
        const engine = await page.locator('#policyEngine').textContent();
        if (backend === 'wasm' && assets !== 'f32-only') assert.match(engine, /ONNX WASM/);
        else {
          assert.match(engine, /JS f32/);
          if (backend === 'wasm') assert.match(engine, /JS f32 되돌림 중 · ONNX 파일 없음/);
        }
        assert.ok(await page.locator('#policyEngine').isVisible());
        assert.equal(await page.evaluate(() => __sim.err), null);
        await page.click('#go');
        await page.waitForFunction(() => __sim.sim.t >= .04);
        await page.dispatchEvent('#stop', 'pointerdown');
        results.push({ backend, assets, available, engine, stepped: true });
      } else {
        // An explicit URL must explain the unavailable requested engine too.
        await page.goto(url + '&policy=ame2-demo');
        await page.waitForFunction(() => window.__sim?.err);
        assert.equal(await page.evaluate(() => __sim.ready), false);
        const engine = await page.locator('#policyEngine').textContent();
        assert.match(engine, /AME-2 · 정책 잠금/);
        assert.ok(await page.locator('#policyEngine').isVisible());
        results.push({ backend, assets, available, engine, stepped: false });
      }
      assert.deepEqual(errors, []);
      console.log('Policy availability PASS', JSON.stringify(results.at(-1)));
    } finally { await page.close(); }
  }
  // Explicit backend selection uses the same resolver as the availability gate.
  for (const query of ['policyBackend=wasm', 'ame2Backend=wasm']) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/f32/onnx-only/sim/index.html?policy=ame2-demo&${query}`);
      await page.waitForFunction(() => window.__sim?.ready);
      assert.equal(await page.locator('#policySelect option[value="ame2-demo"]').isDisabled(), false);
      assert.match(await page.locator('#policyEngine').textContent(), /ONNX WASM/);
    } finally { await page.close(); }
  }
  if (process.env.POLICY_AVAILABILITY_REPORT) writeFileSync(process.env.POLICY_AVAILABILITY_REPORT,
    JSON.stringify({ node: process.version, browser: browser.version(), results, overrides: 2 }, null, 2));
  console.log('Policy availability matrix PASS: both default-commit states × ONNX-only/f32-only/both/neither, dropdown selection/physics or lock reason, 2 backend overrides');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

// Real MuJoCo/JS policy, loopback only. FH_SIM_SRC supplies untracked runtime assets.
// Deterministic visibilitychange + suspended RAF; HIDDEN_SECONDS=310 covers >5min.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../sim');
const seconds = Number(process.env.HIDDEN_SECONDS || 10);
assert.ok(Number.isFinite(seconds) && seconds > 0);
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/sim\//, '');
  let file = resolve(root, path);
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  if (!existsSync(file) && process.env.FH_SIM_SRC) {
    file = resolve(process.env.FH_SIM_SRC, path.startsWith('mujoco/') ? path.replace('mujoco/', 'node_modules/@mujoco/mujoco/') : path);
  }
  try {
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { get: () => window.__hidden ? 'hidden' : 'visible' });
    const raf = window.requestAnimationFrame, held = [];
    window.requestAnimationFrame = cb => raf(t => window.__hidden ? held.push(cb) : cb(t));
    window.__show = () => {
      window.__hidden = false; document.dispatchEvent(new Event('visibilitychange'));
      held.splice(0).forEach(cb => raf(cb));
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse&policy=nvidia-demo&policyBackend=f32&from=web`);
  await page.waitForFunction(() => __sim?.ready || __sim?.err, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => __sim.err), null);
  await page.click('#go'); await page.click('#scenarioMenu'); await page.click('#scenarioRun');
  await page.evaluate(() => __sim.settled());
  await page.waitForFunction(() => __sim.scenario.active);
  const before = await page.evaluate(() => {
    window.__hidden = true;
    window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('freeze'));
    return { index: __sim.scenario.index, t: __sim.sim.t };
  });
  await new Promise(r => setTimeout(r, seconds * 1000));
  assert.deepEqual(await page.evaluate(() => ({ active: __sim.scenario.active, stopped: __sim.stopped(), index: __sim.scenario.index, t: __sim.sim.t })),
    { active: true, stopped: false, ...before });
  await page.evaluate(() => window.__show());
  await page.waitForFunction(t => __sim.sim.t > t, before.t);
  assert.equal(await page.evaluate(() => __sim.scenario.active), true);
  await page.click('#scenarioHalt');
  assert.equal(await page.evaluate(() => __sim.scenario.active), false);
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  await page.click('#scenarioMenu'); await page.click('#go');
  await page.keyboard.down('ArrowUp');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  await page.keyboard.up('ArrowUp');
  console.log(`PASS: MuJoCo mission retained ${seconds}s hidden/blur/freeze, same waypoint resumes physics; explicit Halt and manual blur still stop`);
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
}

// Real MuJoCo/three headless rendering, fake same-origin cookie GET only.
// FH_SIM_BUNDLE=<existing private sim bundle> FH_PLAYWRIGHT=<playwright/index.mjs>
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GO2_JOINTS, createReplayReader, replayRequirement } from '../sim/go2-replay.js';
import { POLICY_MODES } from '../sim/policy-modes.js';
import { createScenarioRunner } from '../sim/scenario.js';

const rid = '00000000-0000-4000-8000-000000000001';
const validUrl = new URL(`http://localhost/sim/index.html?from=web&policy=go2-demo&robot=${rid}`);
for (const search of ['', '?from=server', '?from=web', '?from=web&robot=bad']) assert.match(replayRequirement(new URL(search, validUrl.origin)), /웹에서/);
let calls = 0;
await createReplayReader({}, new URL('http://localhost/sim/'), { fetcher: () => { calls++; } }).poll();
assert.equal(calls, 0);
const mockSim = { adapterId: 'go2-demo', d: { qpos: [] }, cmd: [0, 0, 0] };
assert.equal(createScenarioRunner(mockSim, () => false).start([{ x: 1, y: 0 }]), false);
assert.equal(POLICY_MODES.go2.onnx, null); assert.equal(POLICY_MODES.go2.fallback, null); assert.equal(POLICY_MODES.go2.depth, null);
// Agent/browser wall clocks need not agree. Monotonic ages include server
// residence and browser round-trip, and already-old first responses are ignored.
let time = 0, applied = 0;
const fakeInfo = { simulation: false, robot_info: {
  joints: { names: GO2_JOINTS, positions: Array(12).fill(0), received_at: '1970-01-01T00:00:00Z', age_s: 0 },
  quaternion: { wxyz: [1, 0, 0, 0], received_at: '1970-01-01T00:00:00Z', age_s: 0 },
  position: { xyz: [0, 0, .3], origin: 'BOOT_ORIGIN_UNVERIFIED', received_at: '1970-01-01T00:00:00Z', age_s: 0 },
} };
const reader = createReplayReader({ applyReplay: () => { applied++; } }, validUrl,
  { now: () => time, fetcher: async () => ({ ok: true, json: async () => fakeInfo }) });
await reader.poll(); assert.equal(applied, 1); assert.match(reader.status(), /상태 수신 중/);
time = 500;
fakeInfo.robot_info.joints.received_at = fakeInfo.robot_info.quaternion.received_at = '1970-01-01T00:00:01Z';
fakeInfo.robot_info.joints.age_s = fakeInfo.robot_info.quaternion.age_s = 1.1;
await reader.poll(); assert.equal(applied, 1);
time = 1500; assert.match(reader.status(), /상태 끊김 1초/);
fakeInfo.robot_info.joints.age_s = fakeInfo.robot_info.quaternion.age_s = 0;
await reader.poll(); assert.equal(applied, 2); assert.match(reader.status(), /상태 수신 중/);

const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
assert.ok(process.env.FH_SIM_BUNDLE, 'FH_SIM_BUNDLE required (MuJoCo, three, Go2 meshes only)');
const root = resolve('mobile/sim'), bundle = resolve(process.env.FH_SIM_BUNDLE);
const defaults = GO2_JOINTS.map((n) => POLICY_MODES.nvidia.action.defaultPose[POLICY_MODES.nvidia.action.joints.indexOf(n)]);
let stamp = new Date().toISOString(), advance = true, omitted = false, positionMissing = false, code = 200, sample = 0;
const requests = [];
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    requests.push({ path, method: req.method, cookie: req.headers.cookie });
    if (path !== `/api/v1/robots/${rid}`) { res.writeHead(404); return res.end(); }
    if (advance) stamp = new Date().toISOString();
    const order = [7, 1, 11, 0, 4, 6, 9, 3, 5, 10, 2, 8];
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ simulation: false, robot_info: omitted ? {} : {
      joints: { received_at: stamp, age_s: 0, names: order.map((i) => GO2_JOINTS[i]), positions: order.map((i) => defaults[i] + sample * (i + 1) / 100) },
      quaternion: { received_at: stamp, age_s: 0, wxyz: [Math.cos(.2), 0, 0, Math.sin(.2)] },
      ...(positionMissing ? {} : { position: { received_at: stamp, age_s: 0, xyz: [1.2, -.7, .35], origin: 'BOOT_ORIGIN_UNVERIFIED' } }),
    } }));
  }
  if (!path.startsWith('/sim/')) { res.writeHead(404); return res.end(); }
  for (const base of [root, bundle]) {
    const file = resolve(base, '.' + path.slice(4));
    if (!file.startsWith(base + sep)) continue;
    try {
      const body = readFileSync(file);
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
      return res.end(body);
    } catch { /* Try private assets, never a real server. */ }
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'fake_session', value: 'test', url: origin }]);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/sim/index.html?from=web&policy=go2-demo&robot=${rid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__sim.err), null);
  await page.waitForFunction(() => document.getElementById('policyEngine').textContent.includes('상태 수신 중'));
  const joints = () => page.evaluate(() => {
    const s = window.__sim.sim;
    return Array.from(s.d.qpos).slice(7);
  });
  const mjNames = ['FL', 'FR', 'RL', 'RR'].flatMap((leg) => ['hip', 'thigh', 'calf'].map((part) => `${leg}_${part}_joint`));
  const target = mjNames.map((name) => defaults[GO2_JOINTS.indexOf(name)]);
  const q = await joints(); assert.ok(q.every((v, i) => Math.abs(v - target[i]) < .05), 'default pose reordered by names');
  sample = 1;
  await page.waitForFunction(() => Math.abs(window.__sim.sim.d.qpos[7] - .14) < 1e-6);
  assert.deepEqual(await joints(), mjNames.map((name) => { const i = GO2_JOINTS.indexOf(name); return defaults[i] + (i + 1) / 100; }));
  assert.deepEqual(await page.evaluate(() => Array.from(window.__sim.sim.d.qpos).slice(0, 3)), [1.2, -.7, .35]);
  assert.ok(await page.evaluate(() => Math.abs(window.__sim.sim.d.qpos[3] - Math.cos(.2)) < 1e-10));
  const pose = await page.evaluate(() => Array.from(window.__sim.sim.d.qpos));
  advance = false;
  await page.waitForFunction(() => document.getElementById('policyEngine').textContent.includes('상태 끊김'), { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => Array.from(window.__sim.sim.d.qpos)), pose);
  await page.keyboard.press('KeyW'); await page.keyboard.press('Space');
  await page.locator('canvas').click({ position: { x: 200, y: 200 } });
  await page.evaluate(() => { document.getElementById('go').click(); document.getElementById('scenarioRun').click(); });
  assert.equal(await page.locator('#scenarioRun').isDisabled(), true);
  assert.equal(await page.locator('#reset').isDisabled(), true);
  assert.equal(await page.locator('#go').isVisible(), false);
  assert.equal(await page.locator('#stop').isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.__sim.cmd()), [0, 0, 0]);
  assert.equal(await page.evaluate(() => window.__sim.sim.d.time), 0, 'no mj_step, hold, policy, or frame-clock tick');
  assert.equal(await page.evaluate(() => window.__sim.steps), 0);
  assert.equal(await page.evaluate(() => window.__sim.scenario.active), false);
  assert.deepEqual(await page.evaluate(() => Array.from(window.__sim.sim.d.qpos)), pose);
  advance = true;
  await page.waitForFunction(() => document.getElementById('policyEngine').textContent.includes('상태 수신 중'));
  positionMissing = true;
  await page.waitForFunction(() => document.getElementById('policyEngine').textContent.includes('상태 끊김'), { timeout: 5000 });
  positionMissing = false;
  await page.waitForFunction(() => document.getElementById('policyEngine').textContent.includes('상태 수신 중'));
  omitted = true;
  await page.waitForFunction(() => document.getElementById('policyEngine').textContent.includes('상태 끊김'), { timeout: 5000 });
  code = 403;
  await page.waitForFunction(() => document.getElementById('policyEngine').textContent.includes('권한 확인 필요'));
  assert.ok(requests.length > 3 && requests.every((r) => r.method === 'GET' && r.cookie === 'fake_session=test'));
  for (const query of ['policy=go2-demo', `from=server&policy=go2-demo&robot=${rid}`, 'from=web&policy=go2-demo']) {
    await page.goto(`${origin}/sim/index.html?${query}`);
    await page.waitForFunction(() => !!window.__sim?.err);
    assert.match(await page.locator('#policyEngine').textContent(), /웹에서 로봇을 골라 열어야 함/);
    assert.equal(await page.locator('#policySelect').inputValue(), 'go2-demo');
    assert.equal(await page.locator('#policySelect option[value="go2-demo"]').isDisabled(), true);
  }
  assert.deepEqual(errors, []);
  console.log('Go2 headless PASS: named joints/default error <.05, quaternion/position, stale/repeated/absent samples freeze and recover, cookie GET, denied access, all commands disabled, no physics/policy, invalid launch stays Go2');
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }

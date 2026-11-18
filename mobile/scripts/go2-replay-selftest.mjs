// Real MuJoCo/three headless rendering, fake same-origin cookie GET + fake /api/v1/ws only (no real server, robot or DB).
// FH_SIM_BUNDLE=<existing private sim bundle> FH_PLAYWRIGHT=<playwright/index.mjs> [FH_REPLAY_SHOTS=<folder for screenshots>]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep, join } from 'node:path';
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
const reader = createReplayReader({ world: { spawn: [0, 0, 0], floorZ: 0 }, applyReplay: () => { applied++; } }, validUrl,
  { now: () => time, WebSocket: null, fetcher: async () => ({ ok: true, json: async () => fakeInfo }) });
await reader.poll(); reader.frame(); assert.equal(applied, 1); assert.match(reader.status(), /상태 수신 중/);
time = 500;
fakeInfo.robot_info.joints.received_at = fakeInfo.robot_info.quaternion.received_at = '1970-01-01T00:00:01Z';
fakeInfo.robot_info.joints.age_s = fakeInfo.robot_info.quaternion.age_s = 1.1;
await reader.poll(); reader.frame(); assert.equal(applied, 1);
time = 1500; assert.match(reader.status(), /상태 끊김/);
fakeInfo.robot_info.joints.age_s = fakeInfo.robot_info.quaternion.age_s = 0; fakeInfo.robot_info.joints.positions = Array(12).fill(.1);   // 같은 자세는 다시 그리지 않으므로 값을 바꾼다
await reader.poll(); reader.frame(); assert.equal(applied, 2); assert.match(reader.status(), /상태 수신 중/);

const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
assert.ok(process.env.FH_SIM_BUNDLE, 'FH_SIM_BUNDLE required (MuJoCo, three, Go2 meshes only)');
const shots = process.env.FH_REPLAY_SHOTS; if (shots) mkdirSync(shots, { recursive: true });
const root = resolve('mobile/sim'), bundle = resolve(process.env.FH_SIM_BUNDLE);
const defaults = GO2_JOINTS.map((n) => POLICY_MODES.nvidia.action.defaultPose[POLICY_MODES.nvidia.action.joints.indexOf(n)]);
let stamp = new Date().toISOString(), advance = true, omitted = false, positionMissing = false, code = 200, sample = 0, raw = [1.2, -.7, .35], wsOn = false;
const requests = [], wsSeen = [], clients = new Set();
const order = [7, 1, 11, 0, 4, 6, 9, 3, 5, 10, 2, 8];
const robotInfo = () => {
  if (advance) stamp = new Date().toISOString();
  return omitted ? {} : {
    joints: { received_at: stamp, age_s: 0, names: order.map((i) => GO2_JOINTS[i]), positions: order.map((i) => defaults[i] + sample * (i + 1) / 100) },
    quaternion: { received_at: stamp, age_s: 0, wxyz: [Math.cos(.2), 0, 0, Math.sin(.2)] },
    ...(positionMissing ? {} : { position: { received_at: stamp, age_s: 0, xyz: raw.slice(), origin: 'BOOT_ORIGIN_UNVERIFIED' } }),
  };
};
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    requests.push({ path, method: req.method, cookie: req.headers.cookie });
    if (path !== `/api/v1/robots/${rid}`) { res.writeHead(404); return res.end(); }
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ simulation: false, robot_info: robotInfo() }));
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
// 가짜 실시간 연결(RFC 6455 최소: 받은 글 프레임만 풀고, 보내는 건 가리지 않은 글 프레임) — 구독한 연결에 0.1 s 마다 state
const frame = (obj) => { const b = Buffer.from(JSON.stringify(obj)); return Buffer.concat([b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]), b]); };
server.on('upgrade', (req, sock) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/api/v1/ws' || !wsOn) return sock.destroy();
  wsSeen.push({ cookie: req.headers.cookie, origin: req.headers.origin, msgs: [] });
  const seen = wsSeen.at(-1), accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { sock, sub: false }; clients.add(client);
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 6) {
      let len = buf[1] & 127, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4])), op = buf[0] & 15;
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return sock.destroy();
      if (op !== 1) continue;
      const m = JSON.parse(data.toString()); seen.msgs.push(m);
      if (m.t === 'sub') { client.sub = m.robots?.[0] === rid && m.proto === 'fh-rt/1'; sock.write(frame({ t: 'reply', id: m.id, ok: true })); }
    }
  });
  sock.on('close', () => clients.delete(client)); sock.on('error', () => {});
});
const pushTimer = setInterval(() => { for (const c of clients) if (c.sub) c.sock.write(frame({ t: 'state', robot: rid, connection: 'ONLINE', robot_info: robotInfo() })); }, 100);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.addCookies([{ name: 'fake_session', value: 'test', url: origin }]);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const engine = () => page.locator('#policyEngine').textContent();
  const waitText = (text, timeout = 5000) => page.waitForFunction((t) => document.getElementById('policyEngine').textContent.includes(t), text, { timeout });
  const qpos = () => page.evaluate(() => Array.from(window.__sim.sim.d.qpos));
  const shot = (name) => shots && page.screenshot({ path: join(shots, `${name}.png`) });

  // ① 지도 없이 연 실기 보기(지금 웹 링크와 같음): «지도 없음», 맞추기 꺼짐, «위치 미정», 시작 자리에 관절·자세만
  await page.goto(`${origin}/sim/index.html?from=web&policy=go2-demo&robot=${rid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__sim.err), null);
  await waitText('상태 수신 중');
  assert.match(await page.locator('#replayMap').textContent(), /지도 없음/);
  assert.match(await page.locator('#replayWhere').textContent(), /위치 미정\(켤 때 기준\)/);
  assert.equal(await page.locator('#replayAlign').isDisabled(), true);
  assert.match(await engine(), /실시간 연결 안 됨/, 'ws 가 없으면 GET');
  const spawn = await page.evaluate(() => window.__sim.start());
  const mjNames = ['FL', 'FR', 'RL', 'RR'].flatMap((leg) => ['hip', 'thigh', 'calf'].map((part) => `${leg}_${part}_joint`));
  const target = mjNames.map((name) => defaults[GO2_JOINTS.indexOf(name)]);
  assert.ok((await qpos()).slice(7).every((v, i) => Math.abs(v - target[i]) < .05), 'default pose reordered by names');
  sample = 1;
  await page.waitForFunction(() => Math.abs(window.__sim.sim.d.qpos[7] - .14) < 1e-6);
  assert.deepEqual((await qpos()).slice(7), mjNames.map((name) => { const i = GO2_JOINTS.indexOf(name); return defaults[i] + (i + 1) / 100; }));
  const p0 = await qpos();
  assert.ok(Math.abs(p0[0] - spawn.xy[0]) < 1e-9 && Math.abs(p0[1] - spawn.xy[1]) < 1e-9, '맞추기 전 = 시작 자리(켤 때 기준 x·y 무시)');
  assert.ok(Math.abs(p0[2] - (spawn.floorZ + .35)) < 1e-9);
  assert.ok(Math.abs(p0[3] - Math.cos(.2)) < 1e-10);
  // 끊김: 같은 표본만 오면 1초 뒤 «끊김», 자세 그대로, 명령·물리 없음
  advance = false;
  await waitText('상태 끊김');
  const pose = await qpos();
  await page.waitForTimeout(400); assert.deepEqual(await qpos(), pose, '끊긴 동안 동결');
  assert.match(await engine(), /마지막 자세로 멈춤 · 마지막 수신 \d\d:\d\d:\d\d/);
  await page.keyboard.press('KeyW'); await page.keyboard.press('Space');
  await page.locator('canvas').click({ position: { x: 500, y: 450 } });
  await page.evaluate(() => { document.getElementById('go').click(); document.getElementById('scenarioRun').click(); });
  for (const id of ['#scenarioRun', '#reset']) assert.equal(await page.locator(id).isDisabled(), true);
  for (const id of ['#go', '#stop']) assert.equal(await page.locator(id).isVisible(), false);
  assert.deepEqual(await page.evaluate(() => window.__sim.cmd()), [0, 0, 0]);
  assert.equal(await page.evaluate(() => window.__sim.sim.d.time), 0, 'no mj_step, hold, policy, or frame-clock tick');
  assert.equal(await page.evaluate(() => window.__sim.steps), 0);
  assert.equal(await page.evaluate(() => window.__sim.scenario.active), false);
  assert.deepEqual(await qpos(), pose);
  advance = true;
  await waitText('상태 수신 중');
  positionMissing = true; await waitText('상태 끊김'); positionMissing = false; await waitText('상태 수신 중');

  // ② 지도를 골라 연 실기 보기 + 실시간 연결: 쿠키·같은 출처로 구독, 받는 동안 GET 멈춤
  wsOn = true;
  const mapUrl = `${origin}/sim/index.html?from=web&policy=go2-demo&robot=${rid}&map=warehouse&mapName=${encodeURIComponent('본관 · 1층')}`;
  await page.goto(mapUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 60000 });
  await page.waitForFunction(() => document.getElementById('policyEngine').textContent.includes('상태 수신 중 ') && !document.getElementById('policyEngine').textContent.includes('실시간 연결 안 됨'), null, { timeout: 5000 });
  assert.equal(await page.locator('#replayMap').textContent(), '지도: 본관 · 1층');
  assert.ok(wsSeen.length >= 1 && wsSeen.at(-1).cookie === 'fake_session=test' && wsSeen.at(-1).origin === origin);
  assert.deepEqual(wsSeen.at(-1).msgs[0], { t: 'sub', robots: [rid], streams: ['state'], id: '1', proto: 'fh-rt/1' });
  const g0 = requests.length; await page.waitForTimeout(800);
  assert.ok(requests.length - g0 <= 1, `실시간 받는 동안 GET 거의 없음 (${requests.length - g0})`);
  assert.ok(wsSeen.at(-1).msgs.every((m) => ['sub', 'ping'].includes(m.t)), '보기 전용: 구독·ping 만 보냄');
  await shot('replay-1-before-align');

  // ③ 수동 맞추기: 위에서 보기 → 자리 누름 → 바라보는 쪽 누름 → 바닥 높이 고침 → 저장
  await page.click('#cam');
  await page.click('#replayAlign');
  assert.match(await page.locator('#replayStep').textContent(), /서 있는 곳을 누르세요/);
  const box = await page.locator('canvas').boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height * .55 };
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => document.getElementById('replayFloor').value !== '');
  await page.mouse.click(at.x + 120, at.y);   // 화면 오른쪽 = 지도 +x(위에서 보기 돌리기 0)
  assert.match(await page.locator('#replayStep').textContent(), /맞춤 저장/);
  assert.equal(Number(await page.locator('#replayYaw').inputValue()), 0);
  await page.fill('#replayFloor', '0.10');
  await page.click('#replaySave');
  assert.match(await page.locator('#replayWhere').textContent(), /지도에 맞춤.*어긋날 수 있으니 다시 맞추세요/);
  const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), `fh.replayAlign.${rid}.warehouse.`);
  assert.ok(saved && saved.floor === .1 && saved.yaw === 0 && saved.raw.length === 4);
  await page.waitForTimeout(300);
  const a1 = await qpos();
  assert.ok(Math.hypot(a1[0] - saved.x, a1[1] - saved.y) < .02, '맞춘 자리에 그림');
  assert.ok(Math.abs(a1[2] - (.1 + .35)) < 1e-6, '높이 = 바닥 높이 + 몸 높이(한 번 정함)');
  assert.ok(Math.abs(2 * Math.atan2(a1[6], a1[3])) < 1e-6, '바라보는 쪽 = +x');
  // 로봇이 켤 때 기준으로 앞(방향 0.4 rad)으로 1 m → 지도에서는 +x 로 1 m
  raw = [raw[0] + Math.cos(.4), raw[1] + Math.sin(.4), raw[2]];
  await page.waitForFunction((x) => Math.abs(window.__sim.sim.d.qpos[0] - x) < .02, saved.x + 1, { timeout: 3000 });
  const a2 = await qpos(); assert.ok(Math.abs(a2[1] - saved.y) < .02, '이동량을 돌려 더함');
  await shot('replay-2-after-align');
  // 다시 열어도 이 브라우저 저장본으로 맞춘 채 — 다른 지도(층)에는 따로
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__sim?.ready, null, { timeout: 60000 });
  assert.equal(await page.locator('#replayWhere').getAttribute('data-aligned'), 'true');
  await page.goto(mapUrl.replace('map=warehouse', 'map=factory-zone'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__sim?.ready, null, { timeout: 60000 });
  assert.equal(await page.locator('#replayWhere').getAttribute('data-aligned'), 'false');
  await page.goto(mapUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__sim?.ready && document.getElementById('policyEngine').textContent.includes('상태 수신 중'), null, { timeout: 60000 });

  // ④ 실시간 끊김 → GET 으로 이어 받음 → 둘 다 멈추면 «끊김»·동결
  wsOn = false; for (const c of clients) c.sock.destroy();
  await waitText('실시간 연결 안 됨');
  await waitText('상태 수신 중');
  advance = false;
  await waitText('상태 끊김');
  const frozen = await qpos(); await page.waitForTimeout(300); assert.deepEqual(await qpos(), frozen);
  await shot('replay-3-disconnected');
  advance = true;
  // 맞춤 지우기 → 다시 «위치 미정»
  await page.click('#replayClear');
  assert.equal(await page.locator('#replayWhere').getAttribute('data-aligned'), 'false');
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), `fh.replayAlign.${rid}.warehouse.`), null);

  omitted = true;
  await waitText('상태 끊김');
  code = 403;
  await waitText('권한 확인 필요');
  assert.ok(requests.length > 3 && requests.every((r) => r.method === 'GET' && r.cookie === 'fake_session=test'));
  for (const query of ['policy=go2-demo', `from=server&policy=go2-demo&robot=${rid}`, 'from=web&policy=go2-demo']) {
    await page.goto(`${origin}/sim/index.html?${query}`);
    await page.waitForFunction(() => !!window.__sim?.err);
    assert.match(await page.locator('#policyEngine').textContent(), /웹에서 로봇을 골라 열어야 함/);
    assert.equal(await page.locator('#policySelect').inputValue(), 'go2-demo');
    assert.equal(await page.locator('#policySelect option[value="go2-demo"]').isDisabled(), true);
  }
  assert.deepEqual(errors, []);
  console.log('Go2 headless PASS: no-map label/align off, position unknown = spawn + joints/attitude, ws subscribe (cookie, same origin, GET paused), manual align (place/face/floor) + moved distance, per-map storage, ws loss → GET → stale freeze, clear, denied access, no commands/physics, invalid launch stays Go2');
} finally { clearInterval(pushTimer); await browser?.close(); for (const c of clients) c.sock.destroy(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }

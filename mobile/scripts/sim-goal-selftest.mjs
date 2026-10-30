// 찍은 곳으로 가기(MuJoCo 시뮬) headless 시험 — 위에서 보기·따라가기에서 바닥 찍기 → 목표 → 도착 0.3 m·명령 0,
// STOP 중 무시·STOP/흐림/reset/넘어짐 = 취소(+잠금)·키 = 취소만(손 조종)·끌기는 찍기 아님·장애물 칸/지도 밖 거절·벽 뒤 목표 = 막혀서 멈춤·AME-2 목표 경로.
// sim-keys-selftest 와 같은 틀: sync-web 먼저. FH_PLAYWRIGHT=<기존 playwright-core/index.mjs> node mobile/scripts/sim-goal-selftest.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeMap, cell } from '../sim/lidar.js';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www');
const server = createServer((req, res) => {
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = readFileSync(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});

// 지도에서 시험 점 고르기: 출발점에서 곧게 가도 몸 폭(±0.35 m)이 빈 칸인 1.5 m 앞 점, 벽 칸, 벽 너머 빈 칸
const map = decodeMap(JSON.parse(readFileSync(new URL('../sim/assets/warehouse/map.json', import.meta.url))));
const [sx, sy] = map.spawn_xyyaw;
const clear = (x, y) => { for (let dx = -0.35; dx <= 0.351; dx += map.res) for (let dy = -0.35; dy <= 0.351; dy += map.res) if (cell(map, x + dx, y + dy) !== 254) return false; return true; };
let free = null, wall = null, behind = null;
for (let k = 0; k < 72 && !(free && behind); k++) {
  const a = (k * Math.PI) / 36, c = Math.cos(a), s = Math.sin(a);
  if (!free && [...Array(31).keys()].every((i) => clear(sx + c * i * 0.05, sy + s * i * 0.05))) free = { x: sx + c * 1.5, y: sy + s * 1.5 };
  if (!behind) {   // 빈 칸 ≥ 1 m 뒤 벽(0) 0.3 m 안 두께, 그 너머 빈 칸
    let t = 0; while (t < 6 && cell(map, sx + c * t, sy + s * t) === 254) t += 0.05;
    if (t >= 1 && cell(map, sx + c * t, sy + s * t) === 0) {
      const w = t; while (t < w + 0.3 && cell(map, sx + c * t, sy + s * t) !== 254) t += 0.05;
      if (t < w + 0.3 && clear(sx + c * (t + 0.5), sy + s * (t + 0.5))) { wall = { x: sx + c * (w + 0.02), y: sy + s * (w + 0.02) }; behind = { x: sx + c * (t + 0.5), y: sy + s * (t + 0.5) }; }
    }
  }
}
assert.ok(free && wall && behind, 'test points in warehouse map');

await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const url = `http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse`;
  const errors = [];
  const open = async (q = '') => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } }); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url + q); await p.waitForFunction(() => window.__sim?.ready); await p.waitForTimeout(200); return p;
  };
  const page = await open();
  const ev = (f, a) => page.evaluate(f, a);
  const frame = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));   // 안내 글은 다음 프레임에 바뀐다
  const tapAt = async ({ x, y }) => { const [cx, cy] = await ev(([x, y]) => __sim.toScreen(x, y), [x, y]); await page.mouse.click(cx, cy); await frame(); };
  const goal = () => ev(() => ({ active: __sim.scenario.active, goal: __sim.scenario.goal, status: __sim.scenario.status, note: __sim.goalNote(), stopped: __sim.stopped(), cmd: __sim.cmd() }));
  const pos = () => ev(() => [__sim.sim.d.qpos[0], __sim.sim.d.qpos[1]]);

  // STOP 중에는 찍어도 무시(안내만)
  await tapAt(free);
  let g = await goal();
  assert.equal(g.active, false); assert.match(g.note, /정지 중/);

  // 시작 → 찍기 → 목표 표시·이동 → 0.3 m 안 도착 = 명령 0, «도착했습니다»
  await page.click('#go');
  await tapAt(free);
  g = await goal();
  assert.equal(g.active && g.goal, true); assert.match(g.note, /찍은 곳으로 가는 중/);
  await page.waitForFunction(() => !__sim.scenario.active, null, { timeout: 90000 });
  g = await goal();
  assert.equal(g.status, '완료'); assert.deepEqual(g.cmd, [0, 0, 0]); assert.match(g.note, /도착/);
  const [px, py] = await pos();
  assert.ok(Math.hypot(px - free.x, py - free.y) <= 0.45, `arrived near goal (${px.toFixed(2)},${py.toFixed(2)})`);   // 0.3 m 에서 0 → 멈추며 조금 더 감
  assert.equal(g.stopped, false, 'arrival does not lock');

  // 끌기(8 px 넘게)는 찍기 아님 — 지도 돌리기만
  const [cx, cy] = await ev(([x, y]) => __sim.toScreen(x, y), [sx - 1, sy]);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 40, cy, { steps: 4 }); await page.mouse.up();
  assert.equal((await goal()).active, false, 'drag is not a tap');

  // 장애물 칸·지도 밖 = 거절(목표 없음)
  await tapAt(wall);
  g = await goal(); assert.equal(g.active, false); assert.match(g.note, /장애물/);
  await tapAt({ x: map.origin[0] - 0.4, y: map.origin[1] + 2 });
  g = await goal(); assert.equal(g.active, false); assert.match(g.note, /지도 밖/);

  // 키 = 목표 취소만(잠금 없음), 그 키로 바로 손 조종
  await tapAt({ x: sx - 1, y: sy }); assert.equal((await goal()).active, true);
  await page.keyboard.down('ArrowLeft');
  g = await goal();
  assert.equal(g.active, false); assert.equal(g.status, '손 조종'); assert.equal(g.stopped, false);
  assert.deepEqual(await ev(() => __sim.joy()), [0, 0, 1]);
  await page.keyboard.up('ArrowLeft');
  await page.waitForFunction(() => __sim.cmd().every((v) => v === 0));
  await page.click('#stop');   // 손 조종 취소는 잠그지 않았으므로 아래 반복의 «시작» 앞에 잠근다

  // STOP·흐림·숨김·pagehide·reset = 취소 + 잠금, 자동 재개 없음
  const fires = {
    stop: () => page.click('#stop'),
    blur: () => ev(() => window.dispatchEvent(new Event('blur'))),
    pagehide: () => ev(() => window.dispatchEvent(new Event('pagehide'))),
    hidden: () => ev(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; }),
    reset: () => page.click('#reset'),
  };
  for (const [name, fire] of Object.entries(fires)) {
    await page.click('#go'); await tapAt({ x: sx - 1, y: sy });
    assert.equal((await goal()).active, true, name);
    await fire();
    g = await goal();
    assert.equal(g.active, false, name); assert.equal(g.stopped, true, name);
    await page.waitForTimeout(100);
    assert.equal((await goal()).cmd.every((v) => v === 0), true, `${name}: command 0`);
    await page.click('#go'); await page.waitForTimeout(100);
    assert.equal((await goal()).active, false, `${name}: no automatic resume`);
    await page.click('#stop');
    if (name === 'reset') await page.waitForTimeout(600);   // 다시 세우기 hold
  }

  // 넘어짐 = 취소 + 명령 0
  await page.click('#go'); await tapAt({ x: sx - 1, y: sy });
  await ev(() => { __sim.sim.fell = true; });
  await page.waitForFunction(() => !__sim.scenario.active);
  g = await goal(); assert.equal(g.status, '넘어짐'); assert.deepEqual(g.cmd, [0, 0, 0]);
  await page.click('#reset'); await page.waitForTimeout(600);

  // 벽 너머 목표 = 곧게 가다 앞 막힘(0.6 m) 또는 5초 진전 없음 → «막혀서 멈췄습니다»
  await page.click('#go'); await tapAt(behind);
  assert.equal((await goal()).active, true);
  await page.waitForFunction(() => !__sim.scenario.active, null, { timeout: 90000 });
  g = await goal(); assert.equal(g.status, '막힘'); assert.deepEqual(g.cmd, [0, 0, 0]); assert.match(g.note, /막혀서 멈췄습니다/);
  await page.click('#stop'); await page.click('#reset'); await page.waitForTimeout(600);

  // 따라가기(3D) 화면에서도 바닥 찍기 — 로봇 앞 바닥
  await page.click('#cam'); await page.waitForTimeout(300); await page.click('#go');
  await page.mouse.click(640, 470); await frame();   // 화면 가운데 조금 아래 = 로봇 앞 바닥(가운데보다 많이 아래는 로봇 발밑·뒤)
  g = await goal(); assert.equal(g.active && g.goal, true, `3D floor tap: ${g.note}`);
  await page.click('#stop');
  await page.close();

  // AME-2(시연): 찍은 곳 가기도 자체 목표 입력 — 명령 4칸, 앞으로 감, STOP = [0,0,0,1]
  const ame = await open('&policy=ame2-demo');
  if (await ame.evaluate(() => __sim.sim.adapterId) === 'ame2-demo') {
    await ame.click('#go');
    const [ax, ay] = await ame.evaluate(([x, y]) => __sim.toScreen(x, y), [free.x, free.y]);
    await ame.mouse.click(ax, ay);
    assert.equal(await ame.evaluate(() => __sim.scenario.active && __sim.scenario.goal), true);
    await ame.waitForFunction(() => __sim.cmd().length === 4 && __sim.cmd()[0] > .1, null, { timeout: 30000 });
    await ame.click('#stop');
    assert.equal(await ame.evaluate(() => __sim.scenario.active), false);
    assert.deepEqual(await ame.evaluate(() => __sim.cmd()), [0, 0, 0, 1]);
  } else console.log('AME-2 가중치 없음 — AME-2 찍기 생략');
  await ame.close();
  assert.deepEqual(errors, []);
  console.log('sim goal headless PASS: STOP ignores taps, top-view tap → goal → arrive ≤0.3 m cmd 0 no lock, drag not a tap, obstacle/outside rejected, key = cancel only + hand drive, STOP/blur/pagehide/hidden/reset cancel+lock no resume, fall cancel, wall-behind goal → blocked stop, 3D floor tap, AME-2 goal path');
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}

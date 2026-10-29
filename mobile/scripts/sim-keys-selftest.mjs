// 컴퓨터 키 조종(MuJoCo 시뮬) headless 시험 — 조이스틱 숨김·키 → 명령 값·STOP 중 무시·시작 뒤 다시 눌러야 함·흐림/숨김/reset 0·입력칸 무시·시나리오 끊기·AME-2 목표 경로.
// ame2-ui-selftest 와 같은 틀: sync-web 먼저. FH_PLAYWRIGHT=<기존 playwright-core/index.mjs> node mobile/scripts/sim-keys-selftest.mjs
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
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const url = `http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse`;
  const errors = [];
  const open = async (o, q = '') => {
    const p = await browser.newPage(o); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url + q); await p.waitForFunction(() => window.__sim?.ready); return p;
  };
  const touch = await open({ hasTouch: true });   // 터치 기기는 지금처럼 조이스틱, 키 안내 없음
  assert.equal(await touch.locator('#stickL').isVisible(), true);
  assert.equal(await touch.locator('#keys').isVisible(), false);
  await touch.close();

  const page = await open({});   // headless 기본 = (hover: hover) and (pointer: fine)
  const joy = () => page.evaluate(() => __sim.joy());
  const k = page.keyboard;
  assert.equal(await page.locator('#stickL').isVisible(), false);
  assert.equal(await page.locator('#stickR').isVisible(), false);
  assert.match(await page.locator('#keys').textContent(), /회전/);
  assert.equal(await page.evaluate(() => __sim.stopped()), true);

  // STOP 중 누른 키는 무시, 시작 뒤에도 쥐고 있는(반복) 키로는 안 움직이고 떼고 다시 눌러야 한다
  await k.down('ArrowUp');
  assert.deepEqual(await joy(), [0, 0, 0]);
  await page.click('#go');
  assert.equal(await page.evaluate(() => __sim.stopped()), false);
  await k.down('ArrowUp');   // 같은 키 다시 down = repeat
  assert.deepEqual(await joy(), [0, 0, 0]);
  await k.up('ArrowUp'); await k.down('ArrowUp');
  assert.deepEqual(await joy(), [1, 0, 0]);
  await page.waitForFunction(() => __sim.cmd()[0] === 1);
  await k.down('ArrowLeft');
  assert.deepEqual(await joy(), [1, 0, 1]);
  await k.down('KeyD');   // ← + D = 0
  assert.deepEqual(await joy(), [1, 0, 0]);
  await k.up('KeyD'); await k.up('ArrowLeft'); await k.down('ArrowRight');
  assert.deepEqual(await joy(), [1, 0, -1]);
  await k.up('ArrowRight'); await k.down('KeyS');   // ↑ + S = 0
  assert.deepEqual(await joy(), [0, 0, 0]);
  await k.up('ArrowUp');
  assert.deepEqual(await joy(), [-1, 0, 0]);
  await k.up('KeyS');
  assert.deepEqual(await joy(), [0, 0, 0]);
  await page.waitForFunction(() => __sim.cmd().every((v) => v === 0));

  // Esc = STOP(명령 0), STOP 중 키 무시
  await k.down('KeyW');
  await k.press('Escape');
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  assert.deepEqual(await joy(), [0, 0, 0]);
  await k.up('KeyW'); await k.down('KeyW');
  assert.deepEqual(await joy(), [0, 0, 0]);
  await k.up('KeyW');

  // Space = STOP, 초점 있는 #go 가 Space 를 뗄 때 눌려 다시 시작되지 않는다
  await page.click('#go');
  await k.press('Space');
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  await page.focus('#go');   // 멈춘 동안 보이는 «시작»에 초점
  assert.equal(await page.evaluate(() => document.activeElement.id), 'go');
  await k.press('Space');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => __sim.stopped()), true);

  // 창 흐림·탭 숨김·pagehide = 잠금 + 키 0, 계속 쥔 키로 재개 없음
  for (const fire of [() => window.dispatchEvent(new Event('blur')), () => window.dispatchEvent(new Event('pagehide')), () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; }]) {
    await page.click('#go'); await k.down('KeyW');
    assert.deepEqual(await joy(), [1, 0, 0]);
    await page.evaluate(fire);
    assert.equal(await page.evaluate(() => __sim.stopped()), true);
    assert.deepEqual(await joy(), [0, 0, 0]);
    await page.click('#go'); await k.down('KeyW');
    assert.deepEqual(await joy(), [0, 0, 0]);
    await k.up('KeyW'); await k.press('Escape');
  }

  // reset = 키 0(쥔 키는 다시 눌러야)
  await page.click('#go'); await k.down('KeyW');
  assert.deepEqual(await joy(), [1, 0, 0]);
  await page.click('#reset');
  assert.deepEqual(await joy(), [0, 0, 0]);
  await k.down('KeyW');
  assert.deepEqual(await joy(), [0, 0, 0]);
  await k.up('KeyW');

  // 고르기 칸에 초점이면 화살표는 그 칸 몫 — 주행 안 함. Esc 는 거기서도 STOP
  await page.click('#scenarioMenu');
  await page.focus('#scenarioSelect');
  await k.press('ArrowDown');
  assert.deepEqual(await joy(), [0, 0, 0]);
  await k.press('Escape');
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  await page.evaluate(() => document.activeElement.blur());

  // 시나리오 실행 중 조종 키 = 실행 중단 + 잠금(막대 누름과 같음)
  await page.click('#go');
  await page.click('#scenarioRun');
  assert.equal(await page.evaluate(() => __sim.scenario.active), true);
  await k.down('ArrowLeft');
  assert.equal(await page.evaluate(() => __sim.scenario.active), false);
  assert.equal(await page.evaluate(() => __sim.stopped()), true);
  assert.deepEqual(await joy(), [0, 0, 0]);
  await k.up('ArrowLeft');
  await page.close();

  // AME-2(시연): 키도 goalAxes 경로 — 막대와 같은 범위, STOP 이면 [0,0,0,1]
  const ame = await open({}, '&policy=ame2-demo');
  assert.equal(await ame.evaluate(() => __sim.sim.adapterId), 'ame2-demo');
  await ame.click('#go');
  await ame.keyboard.down('ArrowUp');
  await ame.waitForFunction(() => __sim.cmd()[0] > .1);
  const cmd = await ame.evaluate(() => __sim.cmd());
  assert.equal(cmd.length, 4); assert.ok(cmd[0] <= 1 && Math.hypot(cmd[0], cmd[1]) <= 1);
  await ame.keyboard.press('Escape');
  const t = await ame.evaluate(() => __sim.sim.t);
  await ame.waitForTimeout(150);
  assert.equal(await ame.evaluate(() => __sim.sim.t), t);
  assert.deepEqual(await ame.evaluate(() => __sim.cmd()), [0, 0, 0, 1]);
  await ame.keyboard.up('ArrowUp');
  assert.deepEqual(errors, []);
  console.log('sim keys headless PASS: PC sticks hidden/touch sticks kept, keys → joystick-scale values, STOP ignores keys, re-press after start, Esc/Space/blur/pagehide/hidden/reset zero, select focus ignored, keys cancel scenario, AME-2 goal path');
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}

// 찍은 점 가기(MuJoCo 시뮬) headless 시험 — 위에서 보기·따라가기에서 바닥 찍기 = 점 추가 → «출발» → 도착 0.3 m·명령 0,
// 점 3개(가는 중 추가 포함) A* 로 벽 돌아 도착(스크린샷 FH_SHOT), 막힘 = 한 번만 다시 찾고 또 막히면 멈춤·남은 점 유지, «점 지우기»,
// STOP 중 무시·STOP/흐림/reset/넘어짐 = 취소(+잠금)·키 = 취소만(손 조종)·끌기는 찍기 아님·장애물 칸/지도 밖 거절·벽 뒤 목표 = 막혀서 멈춤·AME-2 목표 경로.
// sim-keys-selftest 와 같은 틀: sync-web 먼저. FH_PLAYWRIGHT=<기존 playwright-core/index.mjs> node mobile/scripts/sim-goal-selftest.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeMap, cell } from '../sim/lidar.js';
import { findPath, inflate, visible } from '../sim/astar.js';
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
// 점 3개: free → 출발점 뒤 1 m → 그 자리에서 곧게는 막혀 A* 로 돌아야 하는 빈 칸(사방 0.5 m 빈 칸, 도는 길 9 m 안, 가장 많이 돌아가는 곳)
const back = { x: sx - 1, y: sy }, grid = inflate(map), len = (a, p) => p.reduce((t, q, i) => t + Math.hypot(q.x - (i ? p[i - 1] : a).x, q.y - (i ? p[i - 1] : a).y), 0);
let around = null, ratio = 1;
for (let x = map.origin[0] + 0.5; x < map.origin[0] + map.w * map.res; x += 0.5) for (let y = map.origin[1] + 0.5; y < map.origin[1] + map.h * map.res; y += 0.5) {
  const p = { x, y }, d = Math.hypot(x - back.x, y - back.y);
  if (d > 6 || !clear(x, y) || ![[-.5, 0], [.5, 0], [0, -.5], [0, .5]].every(([a, b]) => clear(x + a, y + b)) || visible(map, grid, back, p)) continue;
  const r = findPath(map, back, p);
  if (r && len(back, r) < 9 && len(back, r) / d > ratio) { ratio = len(back, r) / d; around = p; }
}
assert.ok(around, 'detour point in warehouse map');

await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
  const url = `http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse`;
  const errors = [];
  const open = async (q = '') => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } }); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url + q); await p.waitForFunction(() => window.__sim?.ready); await p.waitForTimeout(200);
    // 처음 = 따라가기(10-30): 단추 «위에서 보기»·눌리지 않음, 지도판 숨김, 카메라는 로봇 뒤·위(첫 프레임부터)
    assert.deepEqual(await p.evaluate(() => [__sim.top(), document.getElementById('cam').getAttribute('aria-pressed'), document.getElementById('cam').getAttribute('aria-label')]), [false, 'false', '위에서 보기']);
    const [cx, cy, cz] = await p.evaluate(() => __sim.cam()), [bx, by, bz] = await p.evaluate(() => Array.from(__sim.sim.d.qpos.slice(0, 3)));
    assert.ok(Math.hypot(cx - bx, cy - by) < 3 && cz > bz, `follow cam near robot (${cx.toFixed(2)},${cy.toFixed(2)},${cz.toFixed(2)})`);
    await p.click('#cam'); await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); return p;   // 아래 찍기 시험은 위에서 보기부터
  };
  const page = await open();
  const ev = (f, a) => page.evaluate(f, a);
  const frame = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));   // 안내 글은 다음 프레임에 바뀐다
  const tapAt = async ({ x, y }) => { const [cx, cy] = await ev(([x, y]) => __sim.toScreen(x, y), [x, y]); await page.mouse.click(cx, cy); await frame(); };
  const goal = () => ev(() => ({ active: __sim.scenario.active, goal: __sim.scenario.goal, status: __sim.scenario.status, note: __sim.goalNote(), stopped: __sim.stopped(), cmd: __sim.cmd(), marks: __sim.marks().length }));
  const go = async () => { await page.click('#wpGo'); await frame(); };
  const clearMarks = async () => { if (await page.isVisible('#wpClear')) await page.click('#wpClear'); await frame(); };
  const goTo = async (p) => { await tapAt(p); await go(); };
  const pos = () => ev(() => [__sim.sim.d.qpos[0], __sim.sim.d.qpos[1]]);

  // STOP 중에는 찍어도 무시(안내만)
  await tapAt(free);
  let g = await goal();
  assert.equal(g.active, false); assert.match(g.note, /정지 중/);

  // 시작 → 찍기 = 점 추가(아직 안 움직임, «출발»·«점 지우기» 보임) → «출발» → 이동 → 0.3 m 안 도착 = 명령 0, «도착했습니다»
  await page.click('#go');
  assert.equal(await page.isVisible('#wpGo'), false, 'no marks = no 출발');
  await tapAt(free);
  g = await goal();
  assert.equal(g.active, false); assert.equal(g.marks, 1); assert.match(g.note, /점 1 추가/);
  assert.equal(await page.isVisible('#wpGo') && await page.isVisible('#wpClear'), true);
  await go();
  g = await goal();
  assert.equal(g.active && g.goal, true, JSON.stringify(g) + JSON.stringify(errors)); assert.match(g.note, /찍은 곳으로 가는 중 · 점 1\/1/);
  await page.waitForFunction(() => !__sim.scenario.active, null, { timeout: 90000 });
  g = await goal();
  assert.equal(g.status, '완료'); assert.deepEqual(g.cmd, [0, 0, 0]); assert.match(g.note, /도착/);
  const [px, py] = await pos();
  assert.ok(Math.hypot(px - free.x, py - free.y) <= 0.45, `arrived near goal (${px.toFixed(2)},${py.toFixed(2)})`);   // 0.3 m 에서 0 → 멈추며 조금 더 감
  assert.equal(g.stopped, false, 'arrival does not lock');
  assert.equal(g.marks, 0, 'reached marks cleared'); assert.equal(await page.isVisible('#wpGo'), false);

  // 끌기(8 px 넘게)는 찍기 아님 — 지도 돌리기만
  const [cx, cy] = await ev(([x, y]) => __sim.toScreen(x, y), [sx - 1, sy]);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 40, cy, { steps: 4 }); await page.mouse.up();
  assert.equal((await goal()).marks, 0, 'drag is not a tap');

  // 장애물 칸(위에서 보면 선반 메시가 먼저 맞음 = «바닥만», 메시 없는 점유 칸 = «장애물»)·지도 밖 = 거절(목표 없음)
  await tapAt(wall);
  g = await goal(); assert.equal(g.marks, 0); assert.match(g.note, /장애물|바닥만/);
  await tapAt({ x: map.origin[0] - 0.4, y: map.origin[1] + 2 });
  g = await goal(); assert.equal(g.marks, 0); assert.match(g.note, /지도 밖/);

  // 키 = 목표 취소만(잠금 없음), 그 키로 바로 손 조종. 못 간 점은 남는다 → «점 지우기»
  await goTo({ x: sx - 1, y: sy }); assert.equal((await goal()).active, true);
  await page.keyboard.down('KeyA');
  g = await goal();
  assert.equal(g.active, false); assert.equal(g.status, '손 조종'); assert.equal(g.stopped, false);
  assert.deepEqual(await ev(() => __sim.joy()), [0, 0, 1]);
  await frame();
  g = await goal(); assert.equal(g.marks, 1); assert.match(g.note, /손 조종으로 목표를 취소했습니다 — 남은 점 1개/);
  await clearMarks();
  g = await goal(); assert.equal(g.marks, 0); assert.match(g.note, /점을 지웠습니다/);
  await page.keyboard.up('KeyA');
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
    await page.click('#go'); await goTo({ x: sx - 1, y: sy });
    assert.equal((await goal()).active, true, name);
    await fire();
    g = await goal();
    assert.equal(g.active, false, name); assert.equal(g.stopped, true, name);
    await page.waitForTimeout(100);
    assert.equal((await goal()).cmd.every((v) => v === 0), true, `${name}: command 0`);
    await page.click('#go'); await page.waitForTimeout(100);
    assert.equal((await goal()).active, false, `${name}: no automatic resume`);
    await page.click('#stop'); await clearMarks();
    if (name === 'reset') await page.waitForTimeout(600);   // 다시 세우기 hold
  }

  // 넘어짐 = 취소 + 명령 0
  await page.click('#go'); await goTo({ x: sx - 1, y: sy });
  await ev(() => { __sim.sim.fell = true; });
  await page.waitForFunction(() => !__sim.scenario.active);
  g = await goal(); assert.equal(g.status, '넘어짐'); assert.deepEqual(g.cmd, [0, 0, 0]);
  await page.click('#reset'); await page.waitForTimeout(600); await clearMarks();

  // 벽 너머 목표 = 곧게 가다 앞 막힘(0.6 m) 또는 5초 진전 없음 → «막혀서 멈췄습니다»
  // 그 점은 선반 아래라 위에서 찍으면 «바닥만»으로 거절된다(가린 바닥) — 막힘 동작은 실행기에 직접 목표를 넣어 본다
  await page.click('#go'); await tapAt(behind);
  g = await goal(); assert.equal(g.marks, 0); assert.match(g.note, /바닥만/);
  await ev((b) => __sim.scenario.start([b], true), behind);
  assert.equal((await goal()).active, true);
  await page.waitForFunction(() => !__sim.scenario.active, null, { timeout: 90000 });
  g = await goal(); assert.equal(g.status, '막힘'); assert.deepEqual(g.cmd, [0, 0, 0]); assert.match(g.note, /막혀서 멈췄습니다/);
  await page.click('#stop'); await page.click('#reset'); await page.waitForTimeout(600);

  // 점 3개(셋째는 둘째에서 곧게는 막힘): 둘을 찍고 «출발», 가는 중에 셋째를 찍으면 끝에 이어 붙여 A* 로 벽을 돌아 도착
  await page.mouse.wheel(0, -500); await frame();   // 스크린샷이 보이게 조금 확대(찍기 좌표는 toScreen 이 따라감)
  await page.click('#go'); await tapAt(free); await tapAt(back);
  assert.equal((await goal()).marks, 2);
  await go();
  const before = await ev(() => __sim.plan().length);
  await tapAt(around);
  g = await goal(); assert.equal(g.active, true); assert.equal(g.marks, 3); assert.match(g.note, /점 3 추가 — 이어서/);
  const plan = await ev(() => __sim.plan());
  assert.ok(plan.length >= before + 2, `third leg detours (${before} → ${plan.length} waypoints)`);
  assert.ok(plan.at(-1).mark === 2 && Math.hypot(plan.at(-1).x - around.x, plan.at(-1).y - around.y) < 0.01, 'plan ends at third mark');
  assert.equal(await ev(() => __sim.scenario.points.length), plan.length, 'runner follows appended plan');
  // 도착 직전(셋째 점 0.6 m 안 — 번호 셋·A* 경로 선이 아직 보임) 스크린샷
  await page.waitForFunction((p) => !__sim.scenario.active || Math.hypot(__sim.sim.d.qpos[0] - p.x, __sim.sim.d.qpos[1] - p.y) < 0.6, around, { timeout: 180000 });
  if (process.env.FH_SHOT) await page.screenshot({ path: process.env.FH_SHOT });
  await page.waitForFunction(() => !__sim.scenario.active, null, { timeout: 30000 });
  g = await goal();
  assert.equal(g.status, '완료', `3 marks: ${g.note}`); assert.equal(g.marks, 0);
  const [ax3, ay3] = await pos();
  assert.ok(Math.hypot(ax3 - around.x, ay3 - around.y) <= 0.45, `arrived at third mark (${ax3.toFixed(2)},${ay3.toFixed(2)})`);
  console.log(`3 marks: free (${free.x.toFixed(2)},${free.y.toFixed(2)}) → back → around (${around.x},${around.y}) detour ×${ratio.toFixed(2)}, ${plan.length} waypoints`);

  // 막힘 = 지금 자리에서 한 번만 다시 찾기, 또 막히면 멈춤 + 못 간 점 남김
  await page.click('#stop'); await page.click('#go'); await goTo(free);
  assert.equal((await goal()).active, true);
  await ev(() => __sim.scenario.cancel('막힘')); await frame();
  g = await goal(); assert.equal(g.active, true, 'replanned once'); assert.match(g.note, /다시 찾았습니다/);
  await ev(() => __sim.scenario.cancel('막힘')); await frame();
  g = await goal(); assert.equal(g.active, false); assert.equal(g.status, '막힘'); assert.equal(g.marks, 1); assert.match(g.note, /막혀서 멈췄습니다 — 남은 점 1개/);
  assert.deepEqual(g.cmd, [0, 0, 0]);
  await clearMarks(); await page.click('#stop'); await page.click('#reset'); await page.waitForTimeout(600);   // 아래 3D 찍기는 출발점에서

  // 따라가기(3D) 화면에서도 바닥 찍기 — 로봇 앞 바닥
  await page.click('#cam'); await page.waitForTimeout(300); await page.click('#go');
  // 따라가기는 몸통을 화면 가운데에 둔다 — 몸통 가운데 누르기는 그 뒤 바닥이 아니라 몸통이 먼저 맞음 = 거절·명령 0
  await page.mouse.click(640, 400); await frame();
  g = await goal(); assert.equal(g.active, false, 'body click is not a goal'); assert.match(g.note, /바닥만/); assert.deepEqual(g.cmd, [0, 0, 0]);
  const [tx, ty] = await ev(() => __sim.toScreen(__sim.sim.d.qpos[0] + 2, __sim.sim.d.qpos[1]));   // 로봇 앞 2 m 바닥(1 m 는 이 카메라에서 몸통에 가림)
  await page.mouse.click(tx, ty); await frame();
  g = await goal(); assert.equal(g.marks, 1, `3D floor tap: ${g.note}`);
  await go(); assert.equal((await goal()).active, true, '3D 출발');
  await page.click('#stop');
  await page.close();

  // 여러 층(2층 공장, top.json floors): 몸 높이로 지금 층 자동, «전체 · 1층 · 2층», 다른 층 보기에서 찍기 거절, 다른 층 시나리오는 그 층 출발점에서
  const fz = await browser.newPage({ viewport: { width: 1280, height: 800 } }); fz.on('pageerror', (e) => errors.push(e.message));
  await fz.goto(url.replace('map=warehouse', 'map=factory-zone')); await fz.waitForFunction(() => window.__sim?.ready); await fz.waitForTimeout(300);
  assert.equal(await fz.evaluate(() => document.getElementById('floorBar').hidden), true, 'floor bar only in top view');
  await fz.click('#cam'); await fz.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const fl = () => fz.evaluate(() => __sim.floor()), bar = () => fz.evaluate(() => [...document.querySelectorAll('#floorBar button')].map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')));
  assert.deepEqual(await fl(), { here: 0, view: 0, names: ['1층', '2층'] });
  assert.deepEqual(await bar(), ['전체', '1층 · 지금*', '2층']);
  assert.deepEqual(await fz.evaluate(() => [...document.querySelectorAll('#scenarioSelect option')].map((o) => o.value)), ['f1-short-loop', 'f2-short-loop']);
  await fz.evaluate(() => { const x = document.getElementById('scenarioSelect'); x.value = 'f2-short-loop'; x.dispatchEvent(new Event('change')); });   // 시나리오 칸은 접혀 있음
  assert.match(await fz.textContent('#scenarioStatus'), /2층 시나리오 — 실행하면 2층 출발점/);
  await fz.click('#go');
  await fz.click('#floorBar [data-floor="1"]'); assert.equal((await fl()).view, 1);
  const [fx, fy] = await fz.evaluate(() => __sim.toScreen(__sim.sim.d.qpos[0] + 0.8, __sim.sim.d.qpos[1]));
  await fz.mouse.click(fx, fy); await fz.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.equal(await fz.evaluate(() => __sim.scenario.active), false); assert.match(await fz.evaluate(() => __sim.goalNote()), /로봇이 선 층\(1층\)/);
  await fz.click('#floorBar [data-floor="all"]'); assert.equal((await fl()).view, 'all');
  await fz.click('#floorBar [data-floor="0"]'); assert.equal((await fl()).view, 0, 'robot floor = back to auto');
  // 2층 시나리오 실행 = 2층 출발점(5.65, 4.65)에 다시 세워 시작(datum 0, 몸 높이 2 + 0.4) → 지금 층 2층·안내 사라짐
  await fz.evaluate(() => document.getElementById('scenarioRun').click());
  const f2 = await fz.evaluate(() => ({ q: Array.from(__sim.sim.d.qpos.slice(0, 3)), active: __sim.scenario.active, fell: __sim.sim.fell, here: __sim.floor().here }));
  assert.ok(f2.active && !f2.fell && f2.here === 1 && Math.hypot(f2.q[0] - 5.65, f2.q[1] - 4.65) < 0.1 && f2.q[2] > 2.2 && f2.q[2] < 2.5, `f2 scenario start ${JSON.stringify(f2)}`);
  await fz.waitForTimeout(1500);
  assert.equal(await fz.evaluate(() => __sim.sim.fell || __sim.floor().here !== 1), false, 'stays up on 2층');
  assert.deepEqual(await bar(), ['전체', '1층', '2층 · 지금*']);
  assert.doesNotMatch(await fz.textContent('#scenarioStatus'), /출발점/);
  await fz.click('#stop');
  await fz.close();

  // AME-2(시연): 찍은 곳 가기도 자체 목표 입력 — 명령 4칸, 앞으로 감, STOP = [0,0,0,1]
  const ame = await open('&policy=ame2-demo');
  if (await ame.evaluate(() => __sim.sim.adapterId) === 'ame2-demo') {
    await ame.click('#go');
    const [ax, ay] = await ame.evaluate(([x, y]) => __sim.toScreen(x, y), [free.x, free.y]);
    await ame.mouse.click(ax, ay); await ame.click('#wpGo');
    assert.equal(await ame.evaluate(() => __sim.scenario.active && __sim.scenario.goal), true);
    await ame.waitForFunction(() => __sim.cmd().length === 4 && __sim.cmd()[0] > .1, null, { timeout: 30000 });
    await ame.click('#stop');
    assert.equal(await ame.evaluate(() => __sim.scenario.active), false);
    assert.deepEqual(await ame.evaluate(() => __sim.cmd()), [0, 0, 0, 1]);
  } else console.log('AME-2 가중치 없음 — AME-2 찍기 생략');
  await ame.close();
  assert.deepEqual(errors, []);
  console.log('sim goal headless PASS: tap = add mark + 출발, 3 marks (one appended while moving) A* detour arrive, blocked = one replan then stop keeping marks, clear marks, first view = follow, floors auto by body z + 전체/층 toggle + other-floor tap blocked + other-floor scenario starts at that floor spawn, STOP ignores taps, top-view tap → goal → arrive ≤0.3 m cmd 0 no lock, drag not a tap, obstacle/outside rejected, key = cancel only + hand drive, STOP/blur/pagehide/hidden/reset cancel+lock no resume, fall cancel, covered floor tap rejected, wall-behind goal → blocked stop, 3D floor tap + body click rejected, AME-2 goal path');
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}

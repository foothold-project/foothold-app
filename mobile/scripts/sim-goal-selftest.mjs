// 찍은 점 가기(MuJoCo 시뮬) headless 시험 — 위에서 보기·따라가기에서 바닥 누름 = 바로 출발 → 도착 0.3 m·명령 0, 노란 고리(지금 목적지 1개만 진하게),
// 가는 중 누름 = 끝에 줄 세움 → 닿으면 멈추지 않고 다음으로, 점 3개 A* 로 벽 돌아 도착(스크린샷 FH_SHOT), 막힘 = 한 번만 다시 찾고 또 막히면 멈춤·고리 0, «점 지우기»,
// STOP 중 누름 = 출발 안 함·STOP/흐림/숨김/pagehide/reset = 취소(+잠금)·고리 0·뒤집혀도 실행 계속·키 = 취소만(손 조종)·고리 0·끌기는 찍기 아님·장애물 칸/지도 밖 거절·벽 뒤 목표 = 막혀서 멈춤·AME-2 목표 경로.
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
const back = { x: sx - 1, y: sy }, grid = await inflate(map), len = (a, p) => p.reduce((t, q, i) => t + Math.hypot(q.x - (i ? p[i - 1] : a).x, q.y - (i ? p[i - 1] : a).y), 0);
let around = null, ratio = 1;
for (let x = map.origin[0] + 0.5; x < map.origin[0] + map.w * map.res; x += 0.5) for (let y = map.origin[1] + 0.5; y < map.origin[1] + map.h * map.res; y += 0.5) {
  const p = { x, y }, d = Math.hypot(x - back.x, y - back.y);
  if (d > 6 || !clear(x, y) || ![[-.5, 0], [.5, 0], [0, -.5], [0, .5]].every(([a, b]) => clear(x + a, y + b)) || visible(map, grid, back, p)) continue;
  const r = await findPath(map, back, p);
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
  const settled = () => ev(() => __sim.settled());   // 길 찾기는 async(큰 지도는 쉬어 가며)
  const tapAt = async ({ x, y }) => { const [cx, cy] = await ev(([x, y]) => __sim.toScreen(x, y), [x, y]); await page.mouse.click(cx, cy); await settled(); await frame(); };
  const goal = () => ev(() => ({ active: __sim.scenario.active, goal: __sim.scenario.goal, status: __sim.scenario.status, note: __sim.goalNote(), stopped: __sim.stopped(), cmd: __sim.cmd(), marks: __sim.marks().length, rings: __sim.rings() }));
  const clearMarks = async () => { if (await page.isVisible('#wpClear')) await page.click('#wpClear'); await frame(); };
  const goTo = tapAt;   // 누름 = 바로 출발
  assert.equal(await page.$('#wpGo'), null, 'no 출발 button');
  const pos = () => ev(() => [__sim.sim.d.qpos[0], __sim.sim.d.qpos[1]]);

  // STOP 잠금 중 누름 = 출발 안 함·고리 없음(안내만)
  await tapAt(free);
  let g = await goal();
  assert.equal(g.active, false); assert.equal(g.marks, 0); assert.deepEqual(g.rings, []); assert.match(g.note, /정지 중입니다 — ▶ 로 시작한 뒤 다시 누르세요/);

  // 시작 → 누름 = 바로 출발(진한 고리 1개, «점 지우기» 보임) → 0.3 m 안 도착 = 명령 0, «도착했습니다», 고리 사라짐
  await page.click('#go');
  assert.equal(await page.isVisible('#wpClear'), false, 'no marks = no 점 지우기');
  await tapAt(free);
  g = await goal();
  assert.equal(g.active && g.goal, true, JSON.stringify(g) + JSON.stringify(errors)); assert.equal(g.marks, 1); assert.deepEqual(g.rings, [1]);
  assert.equal(await page.isVisible('#wpClear'), true);
  assert.match(g.note, /찍은 곳으로 가는 중 · 목적지 1\/1/);
  await page.waitForFunction(() => !__sim.scenario.active, null, { timeout: 90000 });
  g = await goal();
  assert.equal(g.status, '완료'); assert.deepEqual(g.cmd, [0, 0, 0]); assert.match(g.note, /도착/);
  const [px, py] = await pos();
  assert.ok(Math.hypot(px - free.x, py - free.y) <= 0.45, `arrived near goal (${px.toFixed(2)},${py.toFixed(2)})`);   // 0.3 m 에서 0 → 멈추며 조금 더 감
  assert.equal(g.stopped, false, 'arrival does not lock');
  assert.equal(g.marks, 0, 'reached marks cleared'); assert.deepEqual(g.rings, []); assert.equal(await page.isVisible('#wpClear'), false);

  // 끌기(8 px 넘게)는 찍기 아님 — 지도 돌리기만
  const [cx, cy] = await ev(([x, y]) => __sim.toScreen(x, y), [sx - 1, sy]);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 40, cy, { steps: 4 }); await page.mouse.up();
  assert.equal((await goal()).marks, 0, 'drag is not a tap');

  // 장애물 칸(위에서 보면 선반 메시가 먼저 맞음 = «바닥만», 메시 없는 점유 칸 = «장애물»)·지도 밖 = 거절(목표 없음)
  await tapAt(wall);
  g = await goal(); assert.equal(g.marks, 0); assert.match(g.note, /장애물|바닥만/);
  await tapAt({ x: map.origin[0] - 0.4, y: map.origin[1] + 2 });
  g = await goal(); assert.equal(g.marks, 0); assert.match(g.note, /지도 밖/);

  // «점 지우기» = 가는 중·줄 선 목적지 모두 지우고 이동 취소(잠금 없음)
  await goTo({ x: sx - 1, y: sy }); await tapAt({ x: sx, y: sy - 1 });   // 출발점 자리는 장면 물체가 먼저 맞아 «바닥만»
  g = await goal(); assert.equal(g.active, true); assert.equal(g.marks, 2, JSON.stringify(g)); assert.deepEqual(g.rings, [1, 0.3], 'current ring strong, queued faint');
  await clearMarks();
  g = await goal(); assert.equal(g.active, false); assert.equal(g.marks, 0); assert.deepEqual(g.rings, []); assert.equal(g.stopped, false); assert.match(g.note, /점을 지웠습니다/);

  // 키 = 목표 취소만(잠금 없음), 그 키로 바로 손 조종. 남은 고리는 모두 지운다
  await goTo({ x: sx - 1, y: sy }); await tapAt({ x: sx, y: sy - 1 });   // 출발점 자리는 장면 물체가 먼저 맞아 «바닥만»
  g = await goal(); assert.equal(g.active, true); assert.equal(g.marks, 2);
  await page.keyboard.down('KeyA');
  g = await goal();
  assert.equal(g.active, false); assert.equal(g.status, '손 조종'); assert.equal(g.stopped, false);
  assert.deepEqual(await ev(() => __sim.joy()), [0, 0, 1]);
  await frame();
  g = await goal(); assert.equal(g.marks, 0); assert.deepEqual(g.rings, []); assert.match(g.note, /손 조종으로 목표를 취소했습니다 — 남은 목적지 2개 지움/);
  assert.equal(await page.isVisible('#wpClear'), false);
  await page.keyboard.up('KeyA');
  await page.waitForFunction(() => __sim.cmd().every((v) => v === 0));
  await page.click('#stop');   // 손 조종 취소는 잠그지 않았으므로 아래 반복의 «시작» 앞에 잠근다

  // STOP·흐림·숨김·pagehide·reset = 취소 + 잠금 + 남은 고리 0, 자동 재개 없음
  const fires = {
    stop: () => page.click('#stop'),
    blur: () => ev(() => window.dispatchEvent(new Event('blur'))),
    pagehide: () => ev(() => window.dispatchEvent(new Event('pagehide'))),
    hidden: () => ev(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; }),
    reset: () => page.click('#reset'),
  };
  for (const [name, fire] of Object.entries(fires)) {
    await page.click('#go'); await goTo({ x: sx - 1, y: sy }); await tapAt({ x: sx, y: sy - 1 });
    g = await goal(); assert.equal(g.active, true, name); assert.equal(g.marks, 2, name);
    await fire();
    g = await goal();
    assert.equal(g.active, false, name); assert.equal(g.stopped, true, name);
    await frame(); g = await goal(); assert.equal(g.marks, 0, `${name}: marks cleared`); assert.deepEqual(g.rings, [], `${name}: rings cleared`);
    await page.waitForTimeout(100);
    assert.equal((await goal()).cmd.every((v) => v === 0), true, `${name}: command 0`);
    await page.click('#go'); await page.waitForTimeout(100);
    assert.equal((await goal()).active, false, `${name}: no automatic resume`);
    await page.click('#stop'); await clearMarks();
    if (name === 'reset') await page.waitForTimeout(600);   // 다시 세우기 hold
  }

  // 낮고 뒤집힌 자세여도 목표·정책·물리는 자동 취소/정지되지 않는다.
  await page.click('#go'); await goTo({ x: sx - 1, y: sy });
  const tippedAt = await ev(() => {
    const s=__sim.sim,q=s.d.qpos;q[2]=.12;q[3]=0;q[4]=1;q[5]=q[6]=0;s.d.qvel.fill(0);s.hold(0);
    return s.t;
  });
  await page.waitForFunction((t) => __sim.sim.t > t+.1, tippedAt);
  g=await goal();assert.equal(g.active,true);assert.equal(g.stopped,false);
  assert.equal(await ev(() => Object.hasOwn(__sim.sim,'fell')),false);
  assert.equal(await page.locator('#reset').evaluate((el)=>el.classList.contains('fell')),false);
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

  // 점 3개(셋째는 둘째에서 곧게는 막힘): 첫 누름 = 바로 출발, 가는 중 둘째·셋째 = 끝에 줄 세워 A* 로 벽을 돌아 도착. 닿으면 멈추지 않고 다음으로
  await page.mouse.wheel(0, -500); await frame();   // 스크린샷이 보이게 조금 확대(찍기 좌표는 toScreen 이 따라감)
  await page.click('#go'); await tapAt(free);
  assert.equal((await goal()).active, true);
  await tapAt(back);
  g = await goal(); assert.equal(g.active, true); assert.equal(g.marks, 2); assert.match(g.note, /목적지 추가/);
  const before = await ev(() => __sim.plan().length);
  await tapAt(around);
  g = await goal(); assert.equal(g.active, true); assert.equal(g.marks, 3); assert.match(g.note, /목적지 추가 — 남은 3곳/); assert.deepEqual(g.rings, [1, 0.3, 0.3]);
  const plan = await ev(() => __sim.plan());
  assert.ok(plan.length >= before + 2, `third leg detours (${before} → ${plan.length} waypoints)`);
  assert.ok(plan.at(-1).mark === 2 && Math.hypot(plan.at(-1).x - around.x, plan.at(-1).y - around.y) < 0.01, 'plan ends at third mark');
  assert.equal(await ev(() => __sim.scenario.points.length), plan.length, 'runner follows appended plan');
  // 첫 목적지 도착 = 그 고리 사라지고 다음 고리 진하게, 멈추지 않음(같은 실행 계속)
  await page.waitForFunction(() => !__sim.scenario.active || __sim.scenario.points[__sim.scenario.index].mark >= 1, null, { timeout: 90000 }); await frame();
  g = await goal(); assert.equal(g.active, true, `moves on to next: ${g.status} ${g.note}`); assert.deepEqual(g.rings, [1, 0.3]); assert.match(g.note, /목적지 2\/3|목적지 추가/);
  if (process.env.FH_SHOT) await page.screenshot({ path: process.env.FH_SHOT.replace(/\.png$/, '-mid.png') });
  // 도착 직전(셋째 점 0.6 m 안 — 진한 고리 하나만 남음) 스크린샷
  await page.waitForFunction((p) => !__sim.scenario.active || Math.hypot(__sim.sim.d.qpos[0] - p.x, __sim.sim.d.qpos[1] - p.y) < 0.6, around, { timeout: 180000 });
  if (process.env.FH_SHOT) await page.screenshot({ path: process.env.FH_SHOT });
  await page.waitForFunction(() => !__sim.scenario.active, null, { timeout: 30000 });
  g = await goal();
  assert.equal(g.status, '완료', `3 marks: ${g.note}`); assert.equal(g.marks, 0); assert.deepEqual(g.rings, []);
  const [ax3, ay3] = await pos();
  assert.ok(Math.hypot(ax3 - around.x, ay3 - around.y) <= 0.45, `arrived at third mark (${ax3.toFixed(2)},${ay3.toFixed(2)})`);
  console.log(`3 marks: free (${free.x.toFixed(2)},${free.y.toFixed(2)}) → back → around (${around.x},${around.y}) detour ×${ratio.toFixed(2)}, ${plan.length} waypoints`);

  // 막힘 = 지금 자리에서 한 번만 다시 찾기, 또 막히면 멈춤 + 남은 고리 지움
  await page.click('#stop'); await page.click('#go'); await goTo(free);
  assert.equal((await goal()).active, true);
  await ev(() => __sim.scenario.cancel('막힘')); await frame(); await settled(); await frame();
  g = await goal(); assert.equal(g.active, true, 'replanned once'); assert.match(g.note, /다시 찾았습니다/);
  await ev(() => __sim.scenario.cancel('막힘')); await frame();
  g = await goal(); assert.equal(g.active, false); assert.equal(g.status, '막힘'); assert.equal(g.marks, 0); assert.deepEqual(g.rings, []); assert.match(g.note, /막혀서 멈췄습니다 — 남은 목적지 1개 지움/);
  assert.deepEqual(g.cmd, [0, 0, 0]);
  await clearMarks(); await page.click('#stop'); await page.click('#reset'); await page.waitForTimeout(600);   // 아래 3D 찍기는 출발점에서

  // 따라가기(3D) 화면에서도 바닥 찍기 — 로봇 앞 바닥
  await page.click('#cam'); await page.waitForTimeout(300); await page.click('#go');
  // 따라가기는 몸통을 화면 가운데에 둔다 — 몸통 가운데 누르기는 그 뒤 바닥이 아니라 몸통이 먼저 맞음 = 거절·명령 0
  await page.mouse.click(640, 400); await frame();
  g = await goal(); assert.equal(g.active, false, 'body click is not a goal'); assert.match(g.note, /바닥만/); assert.deepEqual(g.cmd, [0, 0, 0]);
  const [tx, ty] = await ev(() => __sim.toScreen(__sim.sim.d.qpos[0] + 2, __sim.sim.d.qpos[1]));   // 로봇 앞 2 m 바닥(1 m 는 이 카메라에서 몸통에 가림)
  await page.mouse.click(tx, ty); await settled(); await frame();
  g = await goal(); assert.equal(g.marks, 1, `3D floor tap: ${g.note}`); assert.equal(g.active, true, '3D 바로 출발');
  await page.click('#stop');
  await page.close();

  // 취소 경합(REVIEW-228): 길 찾기 하나를 시험용으로 멈춰 두고(astar.js 를 이 페이지에만 바꿔 줌) 그 사이 끊으면 늦은 결과는 버린다
  {
    const astarSrc = readFileSync(resolve(root, 'sim/astar.js'), 'utf8'), needle = 'export async function findPath(map, from, to, extra) {';
    assert.ok(astarSrc.includes(needle));
    const rp = await browser.newPage({ viewport: { width: 1280, height: 800 } }); rp.on('pageerror', (e) => errors.push(e.message));
    await rp.route('**/sim/astar.js', (r) => r.fulfill({ contentType: 'text/javascript', body: astarSrc.replace(needle, needle + ' if (window.__pauseNextPath) { window.__pauseNextPath = false; await new Promise((r) => (window.__releasePath = r)); }') }));
    const rf = () => rp.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const ropen = async () => { await rp.goto(url); await rp.waitForFunction(() => window.__sim?.ready); await rp.click('#cam'); await rf(); await rp.click('#go'); };
    const rtap = async (x, y) => { const [cx, cy] = await rp.evaluate(([x, y]) => __sim.toScreen(x, y), [x, y]); await rp.mouse.click(cx, cy); };
    const hold = async () => { await rp.evaluate(() => { window.__pauseNextPath = true; window.__releasePath = null; }); };
    const pending = () => rp.waitForFunction(() => typeof window.__releasePath === 'function');
    const release = async () => { await rp.evaluate(() => window.__releasePath()); await rp.evaluate(() => __sim.settled()); await rf(); };
    const rs = () => rp.evaluate(() => ({ active: __sim.scenario.active, marks: __sim.marks().length, rings: __sim.rings(), cmd: __sim.cmd(), joy: __sim.joy() }));
    // ① 첫 길 찾기 중 STOP → ▶ → 결과 = 다시 누르지 않으면 출발 안 함
    await ropen(); await hold(); await rtap(free.x, free.y); await pending();
    await rp.click('#stop'); await rf(); await rp.click('#go'); await release();
    let r = await rs(); assert.equal(r.active, false, `stale path after STOP: ${JSON.stringify(r)}`); assert.equal(r.marks, 0); assert.deepEqual(r.rings, []);
    // ② 첫 길 찾기 중 조종 키 = 손 조종 우선, 늦은 결과가 덮지 않음
    await ropen(); await hold(); await rtap(free.x, free.y); await pending();
    await rp.keyboard.down('KeyA'); await release();
    r = await rs(); assert.equal(r.active, false, `stale path after key: ${JSON.stringify(r)}`); assert.deepEqual(r.joy, [0, 0, 1]); assert.deepEqual(r.rings, []);
    await rp.keyboard.up('KeyA');
    // ③ 가는 중 둘째 찾는 동안 셋째 예약 → «점 지우기» → 결과 = 둘 다 버림(지우기 이전 누름이 살아나지 않음)
    await ropen(); await rtap(free.x, free.y); await rp.evaluate(() => __sim.settled()); await rf();
    await hold(); await rtap(sx - 1, sy); await pending(); await rtap(sx, sy - 1);
    await rp.click('#wpClear'); await release();
    r = await rs(); assert.equal(r.active, false, `queued tap survived clear: ${JSON.stringify(r)}`); assert.equal(r.marks, 0); assert.deepEqual(r.rings, []);
    await rp.close();
  }

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
  await fz.evaluate(() => document.getElementById('scenarioRun').click()); await fz.evaluate(() => __sim.settled());
  const f2 = await fz.evaluate(() => ({ q: Array.from(__sim.sim.d.qpos.slice(0, 3)), active: __sim.scenario.active, here: __sim.floor().here }));
  assert.ok(f2.active && f2.here === 1 && Math.hypot(f2.q[0] - 5.65, f2.q[1] - 4.65) < 0.1 && f2.q[2] > 2.2 && f2.q[2] < 2.5, `f2 scenario start ${JSON.stringify(f2)}`);
  await fz.waitForTimeout(1500);
  assert.equal(await fz.evaluate(() => __sim.floor().here !== 1), false, 'remains on 2층');
  assert.deepEqual(await bar(), ['전체', '1층', '2층 · 지금*']);
  assert.doesNotMatch(await fz.textContent('#scenarioStatus'), /출발점/);
  await fz.click('#stop');
  await fz.close();

  // AME-2(시연): 찍은 곳 가기도 자체 목표 입력 — 명령 4칸, 앞으로 감, STOP = [0,0,0,1]
  const ame = await open('&policy=ame2-demo');
  if (await ame.evaluate(() => __sim.sim.adapterId) === 'ame2-demo') {
    await ame.click('#go');
    const [ax, ay] = await ame.evaluate(([x, y]) => __sim.toScreen(x, y), [free.x, free.y]);
    await ame.mouse.click(ax, ay); await ame.evaluate(() => __sim.settled());
    assert.equal(await ame.evaluate(() => __sim.scenario.active && __sim.scenario.goal), true);
    await ame.waitForFunction(() => __sim.cmd().length === 4 && __sim.cmd()[0] > .1, null, { timeout: 30000 });
    await ame.click('#stop');
    assert.equal(await ame.evaluate(() => __sim.scenario.active), false);
    assert.deepEqual(await ame.evaluate(() => __sim.cmd()), [0, 0, 0, 1]);
  } else console.log('AME-2 가중치 없음 — AME-2 찍기 생략');
  await ame.close();
  assert.deepEqual(errors, []);
  console.log('sim goal headless PASS: tap = go now (one strong ring), taps while moving queue at end (faint rings) + arrival moves on without stopping, 3 marks A* detour arrive, blocked = one replan then stop clearing rings, clear marks, key/STOP/blur/pagehide/hidden/reset clear rings, first view = follow, floors auto by body z + 전체/층 toggle + other-floor tap blocked + other-floor scenario starts at that floor spawn, STOP ignores taps, top-view tap → goal → arrive ≤0.3 m cmd 0 no lock, drag not a tap, obstacle/outside rejected, key = cancel only + hand drive, STOP/blur/pagehide/hidden/reset cancel+lock no resume, inverted pose keeps goal/policy running, covered floor tap rejected, wall-behind goal → blocked stop, 3D floor tap + body click rejected, pending path dropped on STOP/key/clear (REVIEW-228 races), AME-2 goal path');
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}

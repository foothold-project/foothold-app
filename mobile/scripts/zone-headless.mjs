// 구역 지키기 headless 시험(브라우저 MuJoCo 시뮬, 창고 지도) — 가짜 zone-grid 응답(쪽 나눔)으로: 구역 그림, 손 조종 진입 0·감속 상한·뒤로 나가기,
// 찍은 곳 가기 돌아가기·구역 안 목표 거절, 받기 실패(안내·자동 이동 안 함·손 조종 됨), zones 없음·앱 안(from=server) = 요청 없음, 위치 목표 모델 안내.
// 서버·로그인·실기 없음(127.0.0.1 빈 포트). FH_WWW=<sync-web 묶음, 기본 mobile/www> FH_PLAYWRIGHT=<playwright-core/index.mjs> [FH_SHOTS=<캡처 폴더>] node mobile/scripts/zone-headless.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BODY_MARGIN, PLAN_MARGIN } from '../sim/zones.js';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve(process.env.FH_WWW || 'mobile/www'), shots = process.env.FH_SHOTS && resolve(process.env.FH_SHOTS);
if (shots) mkdirSync(shots, { recursive: true });

// 가짜 구역: 창고 지도와 같은 격자. 로봇(-5,-2, +x 보기) 앞에 감속(0.5 m/s) → 접근 금지, 왼쪽 위에 속도 값 없는 감속
const OK = '11111111-2222-4333-8444-555555555555', FAIL = '99999999-2222-4333-8444-555555555555';
const map = JSON.parse(readFileSync(resolve(root, 'sim/assets/warehouse/map.json'), 'utf8'));
const NO_GO = [-3.6, -3, -3.0, -1], SLOW = [-4.6, -3, -4.0, -1], BARE = [-5.8, -0.2, -5.0, 0.6];
const cells = new Map();
const fill = ([x0, y0, x1, y1], cell) => {
  for (let c = Math.round((x0 - map.origin[0]) / map.res); c < Math.round((x1 - map.origin[0]) / map.res); c++)
    for (let r = map.h - Math.round((y1 - map.origin[1]) / map.res); r < map.h - Math.round((y0 - map.origin[1]) / map.res); r++) cells.set(r * map.w + c, { index: r * map.w + c, ...cell });
};
fill(SLOW, { no_go: false, slow: true, max_speed_mps: 0.5 }); fill(BARE, { no_go: false, slow: true, max_speed_mps: null }); fill(NO_GO, { no_go: true, slow: false, max_speed_mps: null });
const sorted = [...cells.values()].sort((a, b) => a.index - b.index), PAGE = 700, api = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'), grid = url.pathname.match(/^\/api\/v1\/map-versions\/([^/]+)\/zone-grid$/);
  if (url.pathname.startsWith('/api/')) api.push(req.url);
  if (grid) {
    if (grid[1] !== OK) { res.writeHead(500); res.end(); return; }
    const cursor = +url.searchParams.get('cursor'), next = cursor + PAGE < sorted.length ? cursor + PAGE : null;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ format_version: 1, map_version_id: OK, origin: map.origin, resolution: map.res, width: map.w, height: map.h, row_order: 'TOP_TO_BOTTOM', cursor, cells: sorted.slice(cursor, cursor + PAGE), next_cursor: next }));
    return;
  }
  const file = resolve(root, '.' + url.pathname);
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
  const base = `http://127.0.0.1:${server.address().port}/sim/index.html?map=warehouse`, errors = [];
  const open = async (q) => {
    const p = await browser.newPage({ viewport: { width: 1366, height: 768 } }); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + q); await p.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 120000 });
    assert.equal(await p.evaluate(() => __sim.err), null); return p;
  };
  const shot = async (p, name) => { if (shots) await p.screenshot({ path: resolve(shots, name) }); };
  const state = (p) => p.evaluate(() => ({ x: __sim.sim.d.qpos[0], y: __sim.sim.d.qpos[1], cmd: __sim.cmd(), joy: __sim.joy(), note: __sim.zones().note, goal: __sim.goalNote() }));
  const START = '&start=-5,-2,0';

  // 1) 구역이 보인다 + 손 조종: 감속 구역에서 0.5 m/s 로 줄고, 접근 금지 앞에서 이동 0·안내, 뒤로는 나간다
  {
    const page = await open(`${START}&zones=${OK}`);
    assert.deepEqual(await page.evaluate(() => ({ failed: __sim.zones().failed, on: __sim.zones().on })), { failed: false, on: true });
    assert.equal(api.filter((u) => u.includes('zone-grid')).length, Math.ceil(sorted.length / PAGE), '끝까지(next_cursor) 받음');
    await page.waitForFunction(() => __sim.zoneDrawn);
    await page.waitForTimeout(1500); await shot(page, 'zone-follow.png');
    await page.click('#go'); await page.keyboard.down('ArrowUp');
    let capped = 0, fastInSlow = 0, s;
    for (let k = 0; k < 1200; k++) {
      s = await state(page);
      if (s.x > SLOW[0] + 0.1 && s.x < SLOW[2] - 0.05 && s.cmd[0] > 0) { if (Math.abs(s.cmd[0] - 0.5) < 1e-6 && /감속 구역 · 최고 0.5 m\/s/.test(s.note)) capped++; else if (s.cmd[0] > 0.5 + 1e-6) fastInSlow++; }
      if (s.cmd[0] === 0 && /접근 금지 구역입니다/.test(s.note)) break;
      await page.waitForTimeout(50);
    }
    assert.match(s.note, /접근 금지 구역입니다/, `구역 앞 안내 (x=${s.x.toFixed(2)})`);
    assert.ok(s.joy[0] > 0 && s.cmd[0] === 0, '키는 누른 채 이동 명령 0');
    assert.ok(capped > 0 && fastInSlow === 0, `감속 구역 안 명령 상한 0.5 (본 횟수 ${capped}, 넘은 횟수 ${fastInSlow})`);
    await page.waitForTimeout(1500); s = await state(page);
    assert.ok(NO_GO[0] - s.x >= BODY_MARGIN - 0.1, `멈춘 자리 x=${s.x.toFixed(2)}: 금지 구역 가장자리(${NO_GO[0]})에서 몸체 여유`);
    console.log(`손 조종: x=${s.x.toFixed(2)} 에서 멈춤(구역까지 ${(NO_GO[0] - s.x).toFixed(2)} m), 감속 상한 관측 ${capped}회`);
    await shot(page, 'zone-hand-stop.png');
    await page.keyboard.down('KeyA'); await page.waitForFunction(() => __sim.cmd()[2] > 0 && __sim.cmd()[0] === 0); await page.keyboard.up('KeyA');   // 제자리 회전은 허용
    await page.keyboard.up('ArrowUp'); await page.keyboard.down('ArrowDown');
    await page.waitForFunction(() => __sim.cmd()[0] < 0);   // 멀어지는 방향은 허용
    const x0 = s.x; await page.waitForFunction((x) => __sim.sim.d.qpos[0] < x - 0.2, x0, { timeout: 60000 });
    await page.keyboard.up('ArrowDown'); await page.close();
  }

  // 2) 찍은 곳 가기: 구역 안 목표는 거절, 구역 건너편 목표는 돌아간다(경유점·실제 걸은 자리 모두 구역 밖)
  {
    const page = await open(`${START}&zones=${OK}`);
    await page.click('#cam'); await page.waitForFunction(() => __sim.top() && __sim.zoneDrawn); await page.waitForTimeout(500);
    await page.click('#go');
    const tap = async (x, y) => { const [sx, sy] = await page.evaluate(([a, b]) => __sim.toScreen(a, b), [x, y]); await page.mouse.click(sx, sy); await page.evaluate(() => __sim.settled()); };
    await tap(-3.3, -2);
    await page.waitForFunction(() => /접근 금지 구역이거나 구역에 너무 가까워/.test(__sim.goalNote()), null, { timeout: 10000 });
    await tap(-1, -2);
    await page.waitForFunction(() => __sim.scenario.active && __sim.plan().length, null, { timeout: 10000 });
    const plan = await page.evaluate(() => __sim.plan());
    assert.ok(plan.length >= 2, `돌아가는 경유점 ${plan.length}개`);
    const gap = (p) => Math.hypot(Math.max(NO_GO[0] - p.x, 0, p.x - NO_GO[2]), Math.max(NO_GO[1] - p.y, 0, p.y - NO_GO[3]));
    assert.ok(plan.every((p) => gap(p) > PLAN_MARGIN - map.res), '경유점이 길 찾기 여유 밖');
    let min = Infinity, shotDone = false, s;
    for (let k = 0; k < 3600; k++) {
      s = await state(page); min = Math.min(min, gap(s));
      if (!shotDone && s.x > NO_GO[0] - 0.2) { await shot(page, 'zone-auto-detour.png'); shotDone = true; }
      if (/도착했습니다/.test(s.goal) || !(await page.evaluate(() => __sim.scenario.active))) break;
      await page.waitForTimeout(100);
    }
    assert.equal(await page.evaluate(() => __sim.scenario.status), '완료', `찍은 곳 도착 (끝 자리 ${s.x.toFixed(2)}, ${s.y.toFixed(2)})`);
    assert.ok(min >= BODY_MARGIN, `걷는 동안 구역까지 가장 가까운 거리 ${min.toFixed(2)} m`);
    console.log(`자동 이동: 경유점 ${plan.length}개, 걷는 동안 구역까지 최소 ${min.toFixed(2)} m, 도착`);
    await shot(page, 'zone-auto-arrived.png'); await page.close();
  }

  // 3) 받기 실패: 안내, 자동 이동(시나리오·찍은 곳) 시작 안 함, 손 조종은 됨
  {
    const page = await open(`${START}&zones=${FAIL}`);
    assert.deepEqual(await page.evaluate(() => ({ failed: __sim.zones().failed, on: __sim.zones().on })), { failed: true, on: false });
    await page.waitForFunction(() => /구역 정보를 받지 못했습니다/.test(__sim.zones().note));
    await page.click('#go');
    assert.equal(await page.locator('#scenarioRun').isDisabled(), true);
    assert.match(await page.locator('#scenarioStatus').textContent(), /구역 정보를 받지 못했습니다/);
    const [sx, sy] = await page.evaluate(() => __sim.toScreen(-4, -2)); await page.mouse.click(sx, sy); await page.evaluate(() => __sim.settled());
    await page.waitForFunction(() => /구역 정보를 받지 못했습니다 — 찍어서 이동할 수 없습니다/.test(__sim.goalNote()), null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => __sim.scenario.active), false);
    await shot(page, 'zone-fail.png');
    await page.keyboard.down('ArrowUp'); await page.waitForFunction(() => __sim.cmd()[0] > 0); await page.keyboard.up('ArrowUp');
    await page.close();
  }

  // 4) zones 없음·앱 안(from=server): 구역 요청 없음, 안내 없음 — 지금 그대로
  for (const q of [START, `${START}&from=server&zones=${OK}`]) {
    api.length = 0;
    const page = await open(q);
    assert.deepEqual(await page.evaluate(() => __sim.zones()), { failed: false, on: false, note: '' });
    assert.equal(api.filter((u) => u.includes('zone-grid')).length, 0, q);
    await page.click('#go'); await page.keyboard.down('ArrowUp'); await page.waitForFunction(() => __sim.cmd()[0] > 0); await page.keyboard.up('ArrowUp');
    await page.close();
  }

  // 5) 속도 값이 없는 감속 구역 안에서 시작: 한 줄 안내, 명령은 줄이지 않음
  {
    const page = await open(`&start=-5.4,0.2,0&zones=${OK}`);
    await page.waitForFunction(() => /속도 값이 없는 감속 구역/.test(__sim.zones().note));
    await page.close();
  }

  // 6) 위치 목표 모델(AME-2): 감속 구역 미지원 안내(묶음에 모델이 없으면 건너뜀)
  {
    const probe = await open(START), has = await probe.evaluate(() => { const o = [...document.getElementById('policySelect').options].find((x) => x.value === 'ame2-demo'); return !!o && !o.disabled; });
    await probe.close();
    if (!has) console.log('AME-2 모델이 묶음에 없어 미지원 안내 화면 시험은 건너뜀');
    else {
      const page = await open(`${START}&policy=ame2-demo&zones=${OK}`);
      await page.waitForFunction(() => /이 모델은 감속 구역을 지원하지 않습니다/.test(__sim.zones().note));
      await shot(page, 'zone-ame2-unsupported.png'); await page.close();
      console.log('AME-2: 미지원 안내 확인');
    }
  }
  assert.deepEqual(errors, []);
  console.log('zone-headless ok');
} finally { await browser?.close(); server.close(); }

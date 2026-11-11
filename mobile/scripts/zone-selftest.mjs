// 구역 지키기(mobile/sim/zones.js · astar.js · scenario.js) 순수 시험 — 격자 맞추기·서버 정답 사례, 쪽 나눠 받기·받기 실패, A* 회피·길 없음·탈출 보정 분리,
// 달리는 중 진입 멈춤, 손 조종 진입 0·나가기 허용, 감속 상한·값 없음, 구역 없음 = 지금 그대로.
// node mobile/scripts/zone-selftest.mjs   (화면·안내 줄·받기 실패 화면은 zone-headless.mjs)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { BODY_MARGIN, PLAN_MARGIN, ZONE_STOP, loadZoneGrid, addZonePage, zoneIndex, zoneCenter, zoneLayer, zoneEnters, guardCommand, zoneSpeed, capCommand, zoneQuads } from '../sim/zones.js';
import { CLEARANCE, SNAP, fits, findPath, planRoute, visible, inflate } from '../sim/astar.js';
import { createScenarioRunner } from '../sim/scenario.js';

const ID = '11111111-2222-4333-8444-555555555555';
const here = new URL('.', import.meta.url);
const fixtureText = readFileSync(new URL('zone-grid-v1.fixture.json', here), 'utf8'), fixture = JSON.parse(fixtureText);
// 서버 정본(apps/server/tests/fixtures/zone-grid-v1.json)이 이 나무에 있으면 사본과 같아야 한다(서버 PR 이 합쳐진 뒤부터 검사)
const serverFixture = new URL('../../apps/server/tests/fixtures/zone-grid-v1.json', here);
if (existsSync(serverFixture)) assert.deepEqual(JSON.parse(readFileSync(serverFixture, 'utf8')), fixture, '서버 정답 사례와 사본이 다름');

const page = (c, extra = {}) => ({ format_version: 1, map_version_id: ID, origin: c.origin, resolution: c.resolution, width: c.width, height: c.height,
  row_order: 'TOP_TO_BOTTOM', cursor: 0, cells: c.cells, next_cursor: null, ...extra });
const simMap = (w, h, res = 0.1, origin = [0, 0, 0], walls = []) => {
  const px = new Uint8Array(w * h).fill(254);
  for (const [c0, r0, c1, r1] of walls) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) px[r * w + c] = 0;
  return { w, h, res, origin, px };
};
const at = (m, c, r) => ({ x: m.origin[0] + (c + 0.5) * m.res, y: m.origin[1] + (m.h - 1 - r + 0.5) * m.res });
const cellOf = (m, p) => (m.h - 1 - Math.floor((p.y - m.origin[1]) / m.res)) * m.w + Math.floor((p.x - m.origin[0]) / m.res);
// 구역 칸 목록(시뮬 칸 사각형 [c0,r0,c1,r1])으로 같은 격자의 zone-grid 응답을 만든다
const gridOf = (m, rects, cell = { no_go: true, slow: false, max_speed_mps: null }) => {
  const cells = [];
  for (const [c0, r0, c1, r1] of rects) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push({ index: r * m.w + c, ...cell });
  return addZonePage(null, page({ origin: m.origin, resolution: m.res, width: m.w, height: m.h, cells }), ID);
};
const on = (a) => [...a].flatMap((v, i) => (v ? [i] : []));

// 1) 격자 맞추기 + 서버 정답 사례: 칸 번호 ↔ 세계 좌표(행 0 = 위, 원점 회전), 같은 격자의 시뮬 지도로 옮기면 칸이 그대로
assert.equal(fixture.format_version, 1); assert.equal(fixture.row_order, 'TOP_TO_BOTTOM');
for (const c of fixture.cases) {
  const g = addZonePage(null, page(c), ID);
  assert.equal(g.count, c.cells.length, c.name);
  for (let i = 0; i < c.width * c.height; i++) {
    const p = zoneCenter(g, i), want = c.cells.find((x) => x.index === i);
    assert.equal(zoneIndex(g, p.x, p.y), i, `${c.name}: 칸 ${i} 가운데 → 같은 칸`);
    assert.equal(g.flag[i], want ? (want.no_go ? 1 : 0) | (want.slow ? 2 : 0) : 0, `${c.name}: 칸 ${i} 구역`);
  }
  // 구역 다각형의 가운데는 그 구역 칸 안이다(위아래·회전이 뒤집히면 여기서 걸린다)
  for (const z of c.zones) {
    const mx = z.polygon.reduce((s, p) => s + p[0], 0) / z.polygon.length, my = z.polygon.reduce((s, p) => s + p[1], 0) / z.polygon.length;
    assert.ok(g.flag[zoneIndex(g, mx, my)] & (z.type === 'NO_GO' ? 1 : 3), `${c.name}: 다각형 가운데가 구역 칸`);
  }
  if (c.origin[2] !== 0) continue;
  const m = simMap(c.width, c.height, c.resolution, c.origin), layer = zoneLayer(m, g);
  assert.deepEqual(on(layer.noGo), c.cells.filter((x) => x.no_go).map((x) => x.index), `${c.name}: 금지 칸`);
  assert.deepEqual(on(layer.slow), c.cells.filter((x) => x.slow && !x.no_go).map((x) => x.index), `${c.name}: 감속 칸(금지 우선)`);
  for (const x of c.cells) assert.equal(layer.cap[x.index], x.no_go || x.max_speed_mps == null ? Infinity : Math.fround(x.max_speed_mps), `${c.name}: 칸 ${x.index} 상한`);
}
{ // 돌아간 원점(π/2): 구역 칸 6 = 세계 x 9..10·y 20..21 → 원점 (7,20) 3×3 시뮬 지도의 오른쪽 아래 칸(8)
  const c = fixture.cases.find((x) => x.name === 'rotated-origin'), layer = zoneLayer(simMap(3, 3, 1, [7, 20, 0]), addZonePage(null, page(c), ID));
  assert.deepEqual(on(layer.noGo), [8]);
}
{ // 해상도·원점이 다른 격자: 5 cm 구역 칸 하나(x 1.00..1.05, y 0.50..0.55)는 10 cm 시뮬 칸 (10, 아래에서 5) 하나에만 닿는다. 거친 구역 칸은 닿은 시뮬 칸 모두
  const m = simMap(30, 20), fine = addZonePage(null, page({ origin: [0, 0, 0], resolution: 0.05, width: 60, height: 40, cells: [{ index: (40 - 1 - 10) * 60 + 20, no_go: true, slow: false, max_speed_mps: null }] }), ID);
  assert.deepEqual(on(zoneLayer(m, fine).noGo), [(20 - 1 - 5) * 30 + 10]);
  const coarse = addZonePage(null, page({ origin: [0.05, 0.05, 0], resolution: 0.5, width: 4, height: 4, cells: [{ index: 3 * 4, no_go: false, slow: true, max_speed_mps: 0.5 }] }), ID);
  const hit = on(zoneLayer(m, coarse).slow);   // x 0.05..0.55 → 칸 0..5, y 0.05..0.55 → 아래에서 0..5
  assert.equal(hit.length, 36); assert.ok(hit.every((i) => i % 30 <= 5 && Math.floor(i / 30) >= 14));
}

// 2) 받기: next_cursor 끝까지, 같은 출처 쿠키. 실패(응답 오류·형식·다른 판·끝나지 않는 목록·id 형식)는 throw
{
  const c = fixture.cases.find((x) => x.name === 'overlap-no-go-and-minimum-speed'), urls = [];
  const fetchPages = async (url, init) => {
    urls.push(url); assert.equal(init.credentials, 'same-origin');
    const cursor = +new URL(url, 'http://x').searchParams.get('cursor'), cells = c.cells.slice(cursor, cursor + 4);
    return { ok: true, json: async () => page(c, { cursor, cells, next_cursor: cursor + 4 < c.cells.length ? cursor + 4 : null }) };
  };
  const g = await loadZoneGrid(ID, fetchPages);
  assert.equal(urls.length, 3); assert.equal(urls[1], `/api/v1/map-versions/${ID}/zone-grid?cursor=4&limit=20000`);
  assert.equal(g.count, 9); assert.equal(g.flag[2], 3); assert.ok(Number.isNaN(g.cap[2])); assert.equal(g.cap[4], Math.fround(0.3));
  const answer = (j, ok = true) => async () => ({ ok, status: ok ? 200 : 404, json: async () => j });
  await assert.rejects(loadZoneGrid(ID, answer({}, false)), /응답 404/);
  await assert.rejects(loadZoneGrid(ID, answer(page(c, { row_order: 'BOTTOM_TO_TOP' }))));
  await assert.rejects(loadZoneGrid(ID, answer(page(c, { map_version_id: ID.replace('1', '9') }))), /다른 지도 판/);
  await assert.rejects(loadZoneGrid(ID, answer(page(c, { next_cursor: 0 }))), /next_cursor/);
  await assert.rejects(loadZoneGrid(ID, answer(page(c, { cells: [{ index: 99, no_go: true, slow: false, max_speed_mps: null }] }))));
  await assert.rejects(loadZoneGrid(ID, async () => { throw new Error('network'); }), /network/);
  await assert.rejects(loadZoneGrid('../x', answer(page(c))), /지도 판 id/);
  await assert.rejects(loadZoneGrid(ID, (u, init) => new Promise((_, no) => init.signal.addEventListener('abort', () => no(new Error('시간 초과')))), 20), /시간 초과/);
}

// 3) 구역 없음 = 지금 그대로: 빈 구역은 얹지 않고(null), 판정은 모두 통과
{
  const m = simMap(40, 40), empty = addZonePage(null, page({ origin: [0, 0, 0], resolution: 0.1, width: 40, height: 40, cells: [] }), ID);
  assert.equal(zoneLayer(m, empty), null); assert.equal(zoneLayer(m, null), null);
  assert.equal(zoneEnters(null, m, 1, 1, 0, 1.5), false);
  const cmd = [1.5, 0, 0.3]; assert.equal(guardCommand(undefined, m, 1, 1, 0, cmd).cmd, cmd);
  assert.deepEqual(zoneSpeed(undefined, m, 1, 1), { slow: false, cap: Infinity });
  assert.deepEqual(await findPath(m, at(m, 5, 20), at(m, 35, 20)), [at(m, 35, 20)]);
}

// 4) A*: 가운데 세로 금지 띠(아래 틈) — 구역이 없으면 직선, 있으면 틈으로 돌아가고 모든 구간이 금지 칸 + 길 찾기 여유 밖
{
  const strip = [[39, 0, 40, 49]], open = simMap(80, 80), m = simMap(80, 80), a = at(m, 10, 20), b = at(m, 70, 20);
  m.zones = zoneLayer(m, gridOf(m, strip));
  assert.deepEqual(await findPath(open, a, b), [b]);
  const p = await findPath(m, a, b);
  assert.ok(p && p.length >= 2, '구역을 돌아가는 경유점'); assert.deepEqual(p.at(-1), b);
  const blocked = m.zones.plan, legs = [a, ...p];
  for (let i = 0; i + 1 < legs.length; i++) assert.ok(visible(m, blocked, legs[i], legs[i + 1]), `구간 ${i} 이 구역 여유 밖`);
  // 여유: 경로 위 모든 점(5 cm 간격)이 금지 칸에서 PLAN_MARGIN 넘게 떨어져 있다
  for (let i = 0; i + 1 < legs.length; i++) for (let t = 0; t <= 1; t += 0.05 / Math.hypot(legs[i + 1].x - legs[i].x, legs[i + 1].y - legs[i].y)) {
    const x = legs[i].x + (legs[i + 1].x - legs[i].x) * t, y = legs[i].y + (legs[i + 1].y - legs[i].y) * t;
    assert.ok(m.zones.away[cellOf(m, { x, y })] > PLAN_MARGIN, '경로가 길 찾기 여유 안으로 들어감');
  }
  assert.ok(p.some((q) => q.y < 2.5), '띠 아래 틈으로 지나감');
  assert.equal((await planRoute(m, a, [b])).at(-1).mark, 0);
  // 목표가 금지 칸·여유 안 = 길 없음. 시작 위치 검사(fits)는 벽만 본다 — 구역 때문에 바뀌지 않는다
  assert.equal(await findPath(m, a, at(m, 39, 20)), null);
  assert.equal(await findPath(m, a, at(m, 45, 20)), null, '여유 안 목표');
  assert.equal(await fits(m, at(m, 39, 20)), true);
  // 지도에 없는 장애물(다시 찾기)도 구역과 같이 막는다
  assert.equal(await findPath(m, a, b, Array.from({ length: 30 }, (_, k) => at(m, 39, 50 + k))), null, '틈이 막히면 길 없음');
  assert.ok(await findPath(m, a, b), '다시 찾기 뒤에도 원래 격자는 그대로');
}
{ // 길 없음: 금지 띠가 끝까지 막으면 null(화면 문구 «갈 수 있는 길이 없습니다»)
  const m = simMap(80, 40); m.zones = zoneLayer(m, gridOf(m, [[39, 0, 40, 39]]));
  assert.equal(await findPath(m, at(m, 10, 20), at(m, 70, 20)), null);
  assert.equal(await planRoute(m, at(m, 10, 20), [at(m, 20, 20), at(m, 70, 20)]), null);
}
{ // 탈출 보정 분리: 여유 안(손 조종으로 구역 앞까지 간 자리)에서는 빠져나와 이어 가지만 금지 칸을 밟지 않는다. 구역 안에서는 자동 이동 길 없음.
  const m = simMap(80, 40), zone = [[39, 0, 40, 39]]; m.zones = zoneLayer(m, gridOf(m, zone));
  const near = at(m, 34, 20), goal = at(m, 10, 20);   // 금지 칸에서 0.5 m — 여유(0.85) 안, 몸체 여유(0.4) 밖
  assert.ok(m.zones.plan[cellOf(m, near)] && !m.zones.noGo[cellOf(m, near)]);
  const out = await findPath(m, near, goal);
  assert.ok(out, '여유 안 출발은 빠져나온다'); assert.ok(out[0].x < near.x, '구역에서 멀어지는 쪽으로');
  assert.equal(await findPath(m, near, at(m, 70, 20)), null, '구역 건너편으로는 건너가지 않는다');
  assert.equal(await findPath(m, at(m, 39, 20), goal), null, '구역 안 출발은 자동 이동 없음');
  // 벽 띠 안 출발(기존 탈출)은 그대로이되, 금지 칸 너머의 빈 칸으로는 나가지 않는다: 벽과 한 칸 금지 줄 사이에 낀 자리
  const w = simMap(60, 40, 0.1, [0, 0, 0], [[0, 0, 1, 39]]), wz = simMap(60, 40, 0.1, [0, 0, 0], [[0, 0, 1, 39]]);
  wz.zones = zoneLayer(wz, gridOf(wz, [[6, 0, 6, 39]]));
  const band = at(w, 4, 20);
  assert.ok((await inflate(w))[cellOf(w, band)], '벽 띠 안'); assert.ok(SNAP > CLEARANCE);
  assert.ok(await findPath(w, band, at(w, 40, 20)), '구역 없음: 벽 옆에서 빠져나와 간다');
  assert.equal(await findPath(wz, band, at(wz, 40, 20)), null, '금지 줄을 넘어 빠져나오지 않는다');
}

// 5) 달리는 중 진입 멈춤: 길을 무시하고 구역으로 곧장 가는 경유점 — 다음 걸음이 구역(몸체 여유 포함)이면 멈추고 이유를 남긴다. 제자리 회전은 멈추지 않는다
{
  const m = simMap(100, 40); m.zones = zoneLayer(m, gridOf(m, [[50, 0, 59, 39]]));   // x 5.0..6.0 금지
  const enters = (x, y, angle, speed) => zoneEnters(m.zones, m, x, y, angle, speed);
  for (const adapterId of [undefined, 'ame2-demo']) {
    const sim = { adapterId, cmd: [0, 0, 0], d: { qpos: [1, 2, 0.4, 1, 0, 0, 0] }, cancelPolicyStep() {} };
    const r = createScenarioRunner(sim, () => false, { vx: 1.5, caps: { vx: 1.5 } }, enters);
    assert.equal(r.start([{ x: 8, y: 2 }]), true);
    let k = 0;
    for (; k < 2000 && r.active; k++) { r.tick(Infinity, 0.02); if (r.active) sim.d.qpos[0] += (adapterId ? 1.2 : sim.cmd[0]) * 0.02; }
    assert.equal(r.status, ZONE_STOP, `${adapterId ?? '속도 정책'}: 구역 앞에서 멈춤`); assert.equal(r.active, false);
    assert.deepEqual(sim.cmd, adapterId ? [0, 0, 0, 1] : [0, 0, 0]);
    assert.ok(sim.d.qpos[0] > 3 && 5 - sim.d.qpos[0] >= BODY_MARGIN, `멈춘 자리 x=${sim.d.qpos[0].toFixed(2)} 는 몸체 여유 밖`);
  }
  // 구역 바로 앞(여유 밖)에서 뒤쪽 지점으로 도는 것은 걸음이 아니다
  const sim = { cmd: [0, 0, 0], d: { qpos: [4.5, 2, 0.4, 1, 0, 0, 0] } }, r = createScenarioRunner(sim, () => false, {}, enters);
  r.start([{ x: 1, y: 2 }]); r.tick(Infinity, 0.02);
  assert.equal(r.active, true); assert.equal(sim.cmd[0], 0); assert.ok(Math.abs(sim.cmd[2]) > 0);
  // 구역 검사 없이 만든 실행기는 지금 그대로(구역으로도 감)
  const plain = createScenarioRunner({ cmd: [0, 0, 0], d: { qpos: [4.55, 2, 0.4, 1, 0, 0, 0] } }, () => false);
  plain.start([{ x: 8, y: 2 }]); plain.tick(Infinity, 0.02); assert.equal(plain.active, true);
}

// 6) 손 조종: 들어가는 방향 = 0, 멀어지는 방향·제자리 회전·옆으로 = 그대로. 느리게 조금씩 밀어도 못 들어간다. 구역 안에서 시작 = 나가는 방향만
{
  const m = simMap(100, 40); m.zones = zoneLayer(m, gridOf(m, [[50, 0, 59, 39]]));
  const g = (x, yaw, cmd, y = 2) => guardCommand(m.zones, m, x, y, yaw, cmd);
  assert.deepEqual(g(2, 0, [1.5, 0, 0.3]), { cmd: [1.5, 0, 0.3], blocked: false }, '멀리서는 그대로');
  assert.deepEqual(g(4.6, 0, [1.5, 0, 0.3]), { cmd: [0, 0, 0.3], blocked: true }, '앞이 구역: 이동 0, 회전 유지');
  const slowing = g(4.3, 0, [1.5, 0.3, 0.3]);   // 다음 걸음(0.6 m) 안에 구역: 남은 거리만큼 미리 줄인다(방향·회전 그대로)
  assert.ok(!slowing.blocked && slowing.cmd[0] > 0 && slowing.cmd[0] < 1.5 && Math.abs(slowing.cmd[1] / slowing.cmd[0] - 0.2) < 1e-12 && slowing.cmd[2] === 0.3);
  assert.deepEqual(g(4.6, 0, [-1, 0, 0]), { cmd: [-1, 0, 0], blocked: false }, '뒤로 = 멀어짐');
  assert.equal(g(4.6, 0, [0, 0, 1]).blocked, false, '제자리 회전');
  assert.deepEqual(g(4.6, 0, [0, 0.5, 0]), { cmd: [0, 0.5, 0], blocked: false }, '옆걸음(구역과 나란히)');
  assert.equal(g(4.6, Math.PI / 2, [0, -0.5, 0]).blocked, true, '옆걸음이 구역 쪽이면 막음');
  assert.equal(g(4.6, Math.PI, [-1, 0, 0]).blocked, true, '등지고 뒷걸음도 막음');
  assert.equal(guardCommand(m.zones, m, 4.6, 2, 0, [1, 0, 0], 1.2).blocked, true, '위치 목표 손 조종(속력 따로)');
  for (const v of [1.5, 0.4, 0.05]) {   // 앞으로만 계속 밀기(50 Hz) — 어떤 속도로도 몸 가운데가 금지 칸에서 몸체 여유 − 한 칸 안으로 못 들어간다
    let x = 2;
    for (let k = 0; k < 6000; k++) x += guardCommand(m.zones, m, x, 2, 0, [v, 0, 0]).cmd[0] * 0.02;
    assert.ok(x > 3 && 5 - x >= BODY_MARGIN - m.res - 1e-9, `v=${v}: 멈춘 자리 x=${x.toFixed(3)}`);
    assert.equal(guardCommand(m.zones, m, x, 2, 0, [v, 0, 0]).blocked, true);
  }
  // 구역 안(x 5.25, 가까운 가장자리 = 왼쪽)에서 시작: 왼쪽(나가는 쪽)만, 오른쪽(더 깊이)은 0. 다 나오면 다시 못 들어감
  assert.equal(g(5.25, 0, [-1, 0, 0]).blocked, false, '구역 안: 나가는 방향 허용');
  assert.equal(g(5.25, 0, [1, 0, 0]).blocked, true, '구역 안: 더 들어가는 방향 0');
  assert.equal(g(5.25, 0, [0, 0, 1]).blocked, false);
  let x = 5.25;
  for (let k = 0; k < 400; k++) x += guardCommand(m.zones, m, x, 2, 0, [-0.5, 0, 0]).cmd[0] * 0.02;
  assert.ok(x < 5 - BODY_MARGIN, '밖으로 걸어 나옴');
}

// 7) 감속: 그 칸의 상한으로 줄이기만(방향 유지·회전 그대로·넓히지 않음), 값 없음 = 제한 없음(안내용 slow 만), 금지 우선·낮은 속도는 서버 칸 그대로
{
  const m = simMap(60, 40), cells = [];
  for (let r = 0; r < 40; r++) for (let c = 20; c < 40; c++) cells.push({ index: r * 60 + c, no_go: false, slow: true, max_speed_mps: c < 30 ? 0.5 : null });
  const layer = zoneLayer(m, addZonePage(null, page({ origin: [0, 0, 0], resolution: 0.1, width: 60, height: 40, cells }), ID));
  assert.equal(layer.hasSlow, true); assert.equal(on(layer.noGo).length, 0); assert.equal(on(layer.plan).length, 0, '감속 구역은 길을 막지 않는다');
  assert.deepEqual(zoneSpeed(layer, m, 1, 2), { slow: false, cap: Infinity });
  assert.deepEqual(zoneSpeed(layer, m, 2.5, 2), { slow: true, cap: 0.5 });
  assert.deepEqual(zoneSpeed(layer, m, 3.5, 2), { slow: true, cap: Infinity }, '속도 값이 없는 감속 구역');
  assert.deepEqual(capCommand([1.5, 0, 0.8], 0.5), [0.5, 0, 0.8]);
  const d = capCommand([-1.2, 0.5, 0], 0.5); assert.ok(Math.abs(Math.hypot(d[0], d[1]) - 0.5) < 1e-12 && d[0] < 0 && d[1] > 0);
  const slowCmd = [0.3, 0, 0.2]; assert.equal(capCommand(slowCmd, 0.5), slowCmd, '상한보다 느린 명령은 그대로(넓히지 않음)');
  assert.equal(capCommand(slowCmd, Infinity), slowCmd);
  assert.equal(guardCommand(layer, m, 1.9, 2, 0, [1.5, 0, 0]).blocked, false, '감속 구역은 들어갈 수 있다');
  assert.equal(zoneQuads(layer, m, 'slow', false).length, 800);
  assert.equal(zoneQuads(layer, m, 'slow', true).length, 2 * 40 + 2 * 18, '테두리 = 구역 가장자리 칸(지도 끝에 닿은 줄 포함)');
}
assert.equal(BODY_MARGIN, 0.4); assert.equal(PLAN_MARGIN, 0.4 + CLEARANCE);
console.log('zone-selftest ok');

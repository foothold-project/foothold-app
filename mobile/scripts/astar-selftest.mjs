// 찍은 점 길 찾기(mobile/sim/astar.js) 순수 시험 — 빈 격자 직선, 벽 돌아가기, 길 없음, 대각선 모서리 금지, 부풀림, 경로 줄이기, 벽 옆 출발,
// 여러 점·라이다 장애물, 검토 재현 2개(띠 안 목표·대각 꼭짓점 선분), 실제 지도 모든 구간 검사, 공장 지도 탐색이 쉬어 가며 도는지.
// node mobile/scripts/astar-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLEARANCE, SNAP, SLICE_MS, inflate, fits, visible, findPath, planRoute } from '../sim/astar.js';
import { decodeMap, cell } from '../sim/lidar.js';

// 0.1 m 칸 w×h 지도(원점 0,0), 행 0 = 위(y 큰 쪽). walls = [[c0,r0,c1,r1], …] 점유(0) 사각형(양끝 포함)
const grid = (w, h, walls = []) => {
  const px = new Uint8Array(w * h).fill(254);
  for (const [c0, r0, c1, r1] of walls) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) px[r * w + c] = 0;
  return { w, h, res: 0.1, origin: [0, 0, 0], px };
};
const at = (m, c, r) => ({ x: (c + 0.5) * m.res, y: (m.h - 1 - r + 0.5) * m.res });   // 칸 가운데
const len = (from, pts) => pts.reduce((s, p, i) => s + Math.hypot(p.x - (i ? pts[i - 1] : from).x, p.y - (i ? pts[i - 1] : from).y), 0);
const rawOf = (m) => Uint8Array.from(m.px, (v) => (v === 254 ? 0 : 1));
// 돌려준 경로의 모든 구간이 부풀린 격자에서 보인다 — 띠 안 출발이면 첫 구간만 원래 지도에서
const legsOk = async (m, from, p, extra) => {
  const g = await inflate(m, extra), inBand = !!g[(m.h - 1 - Math.floor((from.y - m.origin[1]) / m.res)) * m.w + Math.floor((from.x - m.origin[0]) / m.res)];
  return [from, ...p].every((q, i, all) => i === all.length - 1 || visible(m, i === 0 && inBand ? rawOf(m) : g, q, all[i + 1]));
};

// 1) 빈 격자 = 직선 한 구간(경유점 = 도착 하나)
{
  const m = grid(40, 40), a = at(m, 10, 20), b = at(m, 30, 20);
  assert.deepEqual(await findPath(m, a, b), [b]);
  const d = at(m, 30, 8);   // 대각선 방향도 한 구간
  assert.deepEqual(await findPath(m, a, d), [d]);
}

// 2) 벽 돌아가기: 가운데 세로 벽(아래 틈) — 직선은 막혀 경유점 ≥ 2, 모든 구간이 부풀린 격자에서 보임
{
  const m = grid(60, 50, [[29, 0, 31, 31]]), a = at(m, 10, 10), b = at(m, 50, 10), p = await findPath(m, a, b);
  assert.ok(p && p.length >= 2, 'detour has waypoints');
  assert.deepEqual(p.at(-1), b);
  assert.equal(visible(m, await inflate(m), a, b), false);
  assert.ok(await legsOk(m, a, p), 'every leg visible on inflated grid');
  assert.ok(p.some((q) => q.y < (50 - 32) * 0.1), 'goes under the wall through the gap');
  assert.ok(len(a, p) > 4 && len(a, p) < 12, `detour length ${len(a, p).toFixed(2)}`);
}

// 3) 길 없음: 벽이 끝까지 막음 = null, 도착이 장애물 칸 = null
{
  const m = grid(60, 40, [[29, 0, 31, 39]]);
  assert.equal(await findPath(m, at(m, 10, 10), at(m, 50, 10)), null);
  assert.equal(await findPath(m, at(m, 10, 10), at(m, 30, 10)), null);
  assert.equal(await planRoute(m, at(m, 10, 10), [at(m, 20, 10), at(m, 50, 10)]), null, 'any leg without path = null');
}

// 4) 대각선 모서리 금지: 두 덩어리가 대각선으로만 닿는 틈은 지나지 못한다(막힘 격자를 직접 만든다)
{
  const m = grid(20, 20), g = await inflate(m);
  g.fill(1);
  for (let r = 2; r <= 9; r++) for (let c = 2; c <= 9; c++) g[r * 20 + c] = 0;
  for (let r = 10; r <= 17; r++) for (let c = 10; c <= 17; c++) g[r * 20 + c] = 0;
  assert.equal(await findPath(m, at(m, 3, 6), at(m, 15, 15)), null, 'no corner cutting');
  g[9 * 20 + 10] = 0;   // 옆 칸 하나를 열면 그 칸을 거쳐(곧은 두 걸음) 지나간다
  assert.ok(await findPath(m, at(m, 3, 6), at(m, 15, 15)), 'side cell open = pass');
}

// 5) 부풀림: 장애물 칸 가운데에서 CLEARANCE 안 칸은 막힘, 밖은 열림. 통로는 2×CLEARANCE 넘어야 지나감
{
  const m = grid(40, 40, [[20, 20, 20, 20]]), g = await inflate(m), k = Math.floor(CLEARANCE / m.res + 1e-9);
  assert.equal(g[20 * 40 + 20 + k], 1); assert.equal(g[20 * 40 + 20 + k + 1], 0);
  assert.equal(g[(20 - k) * 40 + 20], 1); assert.equal(g[(20 - k - 1) * 40 + 20], 0);
  const narrow = grid(60, 40, [[29, 0, 31, 15], [29, 24, 31, 39]]);   // 0.8 m
  assert.equal(await findPath(narrow, at(narrow, 10, 20), at(narrow, 50, 20)), null, 'body+margin does not fit 0.8 m gap');
  const wide = grid(60, 40, [[29, 0, 31, 9], [29, 30, 31, 39]]);      // 2.0 m
  assert.ok(await findPath(wide, at(wide, 10, 20), at(wide, 50, 20)), 'fits 2.0 m gap');
}

// 6) 경로 줄이기: ㄱ자 벽을 도는 길은 A* 칸 수보다 훨씬 적은 경유점(직선 구간은 하나로)
{
  const m = grid(80, 80, [[20, 20, 59, 22], [57, 20, 59, 70]]), a = at(m, 30, 50), b = at(m, 70, 50), p = await findPath(m, a, b);
  assert.ok(p && p.length <= 4, `smoothed to ${p?.length} waypoints`);
  assert.ok(await legsOk(m, a, p));
}

// 7) 벽 옆(띠 안)에 선 로봇: 띠 밖 첫 칸으로 나가는 첫 구간(원래 지도)부터 잇는다. 띠 안 목표는 받지 않는다(fits)
{
  const m = grid(60, 50, [[29, 0, 31, 31]]), b = at(m, 36, 10);
  for (const a of [at(m, 27, 10), at(m, 28, 10)]) {
    const p = await findPath(m, a, b);
    assert.ok(p && p.length >= 3, 'starts next to wall');
    assert.ok(Math.hypot(p[0].x - a.x, p[0].y - a.y) <= SNAP, 'first hop within SNAP');
    assert.ok(await legsOk(m, a, p), 'first hop raw-visible, rest inflated-visible');
    assert.deepEqual(p.at(-1), b);
  }
  assert.equal(await fits(m, at(m, 33, 10)), false); assert.equal(await findPath(m, at(m, 10, 10), at(m, 33, 10)), null, 'goal in band rejected');
  assert.equal(await fits(m, b), true);
}

// 8) 여러 점 이어 붙이기(mark = 향하는 점 번호), 라이다로 본 장애물(extra)은 그 자리를 피해 다시 찾는다
{
  const m = grid(60, 40), a = at(m, 5, 20), goals = [at(m, 30, 20), at(m, 55, 20), at(m, 55, 8)], r = await planRoute(m, a, goals);
  assert.deepEqual(r.map((p) => p.mark), [0, 1, 2]);
  const seen = [at(m, 15, 20), at(m, 15, 19), at(m, 15, 21)], p = await findPath(m, a, goals[0], seen);
  assert.ok(p.length >= 2, 'detours around lidar obstacle');
  assert.ok(await legsOk(m, a, p, seen));
  assert.deepEqual(await findPath(m, a, goals[0]), [goals[0]], 'base grid untouched by extra');
}

// 9) 검토 재현 1(PR #211 r1): SNAP 뒤 원래 목표를 무조건 붙여 띠 안 목표로 경로를 돌려주던 것 → 이제 null
{
  const m = grid(60, 40, [[29, 0, 31, 31]]);
  assert.equal(await findPath(m, { x: 1.05, y: 2.95 }, { x: 2.75, y: 2.95 }), null);
}

// 10) 검토 재현 2: 점 표본 검사가 양옆 막힌 대각 꼭짓점을 곧게 통과하던 것 → 지나는 모든 칸 + 꼭짓점 양옆 검사
{
  const m = grid(30, 30), g = new Uint8Array(900), a = { x: 0.75, y: 2.25 }, b = { x: 1.04, y: 1.96 };
  assert.equal(visible(m, g, a, b), true, 'open grid');
  g[9 * 30 + 10] = 1; g[10 * 30 + 9] = 1;     // 꼭짓점 (10,20)-(9,19)(아래에서 센 줄)의 양옆
  assert.equal(visible(m, g, a, b), false, 'both sides of the corner blocked');
  g[9 * 30 + 10] = 0;
  assert.equal(visible(m, g, a, b), false, 'one side blocked = same rule as A*');
  const r = grid(30, 30, [[13, 9, 13, 9], [9, 13, 9, 13]]);   // 검토가 쓴 지도 그대로
  assert.equal(await findPath(r, a, b), null);
  // 선이 꼭짓점이 아닌 칸을 스치면 그 칸을 본다(표본 사이를 건너뛰지 않음)
  const s = new Uint8Array(900); s[(29 - 20) * 30 + 10] = 1;   // (10,20)
  assert.equal(visible(m, s, { x: 0.05, y: 2.05 }, { x: 2.95, y: 2.12 }), false);
}

// 11) 실제 지도: 출발점에서 여러 곳까지 — 나온 경로의 모든 구간 검사, 경유점은 빈 칸
const load = (id) => decodeMap(JSON.parse(readFileSync(new URL(`../sim/assets/${id}/map.json`, import.meta.url))));
{
  const m = load('warehouse'), [sx, sy] = m.spawn_xyyaw, t0 = performance.now();
  let found = 0;
  for (const [dx, dy] of [[3, 0], [-3, 2], [0, 4], [2, -5], [-4, -4], [-3, 4], [5, 5], [-6, 1]]) {
    const to = { x: sx + dx, y: sy + dy }, p = await findPath(m, { x: sx, y: sy }, to);
    assert.equal(!!p || !(await fits(m, to)), true, `${dx},${dy}: fits = path or blocked (not in band)`);
    if (p) { found++; assert.ok(p.every((q) => cell(m, q.x, q.y) === 254)); assert.ok(await legsOk(m, { x: sx, y: sy }, p), `${dx},${dy} legs`); }
  }
  assert.ok(found >= 3, `warehouse paths ${found}`);
  console.log(`warehouse 8 searches ${(performance.now() - t0).toFixed(0)} ms (첫 번은 부풀림 포함)`);
}

// 12) 공장 1002×1002(검토 측정 경로, 그때 동기 231~288 ms): 부풀림·탐색이 SLICE_MS 마다 setTimeout 으로 쉰다 — 쉬지 않고 붙잡는 가장 긴 구간을 잰다
{
  const m = load('factory-inspection'), from = { x: 24, y: 21.5 }, to = { x: 13.475, y: 49.025 }, orig = globalThis.setTimeout;
  let mark = performance.now(), run = 0, rests = 0;
  globalThis.setTimeout = (f, d) => { run = Math.max(run, performance.now() - mark); rests++; return orig(() => { mark = performance.now(); f(); }, d); };
  const t0 = performance.now(), p = await findPath(m, from, to);
  run = Math.max(run, performance.now() - mark); globalThis.setTimeout = orig;
  const total = performance.now() - t0;
  assert.ok(p, 'factory path'); assert.ok(await legsOk(m, from, p));
  assert.ok(rests > 3 && run < 50, `longest synchronous run ${run.toFixed(0)} ms over ${rests} rests`);
  console.log(`factory 1002×1002 첫 탐색(부풀림 포함) ${total.toFixed(0)} ms, 쉬지 않고 붙잡는 가장 긴 구간 ${run.toFixed(0)} ms(SLICE ${SLICE_MS} ms, ${rests}번 쉼), 경유점 ${p.length}`);
}
console.log('astar PASS: empty straight, wall detour (legs visible on inflated grid), no path/obstacle goal null, no diagonal corner cutting, clearance radius + narrow gap, smoothing, start next to wall (raw first hop) + band goal rejected, multi-point marks + lidar extra obstacles, review repro 1 (band goal) + 2 (diagonal corner), real map legs, factory time-sliced');

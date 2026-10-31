// 찍은 점 길 찾기(mobile/sim/astar.js) 순수 시험 — 빈 격자 직선, 벽 돌아가기, 길 없음, 대각선 모서리 금지, 부풀림, 경로 줄이기, 벽 옆 출발, 여러 점·라이다 장애물, 실제 창고 지도.
// node mobile/scripts/astar-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BODY_HALF, inflate, visible, findPath, planRoute } from '../sim/astar.js';
import { decodeMap, cell } from '../sim/lidar.js';

// 0.1 m 칸 w×h 지도(원점 0,0), 행 0 = 위(y 큰 쪽). walls = [[c0,r0,c1,r1], …] 점유(0) 사각형(양끝 포함)
const grid = (w, h, walls = []) => {
  const px = new Uint8Array(w * h).fill(254);
  for (const [c0, r0, c1, r1] of walls) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) px[r * w + c] = 0;
  return { w, h, res: 0.1, origin: [0, 0, 0], px };
};
const at = (m, c, r) => ({ x: (c + 0.5) * m.res, y: (m.h - 1 - r + 0.5) * m.res });   // 칸 가운데
const len = (from, pts) => pts.reduce((s, p, i) => s + Math.hypot(p.x - (i ? pts[i - 1] : from).x, p.y - (i ? pts[i - 1] : from).y), 0);

// 1) 빈 격자 = 직선 한 구간(경유점 = 도착 하나)
{
  const m = grid(40, 40), a = at(m, 10, 20), b = at(m, 30, 20);
  assert.deepEqual(findPath(m, a, b), [b]);
  const d = at(m, 30, 5);   // 대각선 방향도 한 구간
  assert.deepEqual(findPath(m, a, d), [d]);
}

// 2) 벽 돌아가기: 가운데 세로 벽(아래 틈) — 직선은 막혀 경유점 ≥ 2, 모든 구간이 부풀린 격자에서 보이고, 벽 칸·부풀린 띠를 지나지 않음
{
  const m = grid(60, 40, [[29, 0, 31, 31]]), a = at(m, 10, 10), b = at(m, 50, 10), p = findPath(m, a, b);
  assert.ok(p && p.length >= 2, 'detour has waypoints');
  assert.deepEqual(p.at(-1), b);
  const g = inflate(m);
  assert.equal(visible(m, g, a, b), false);
  assert.ok([a, ...p].every((q, i, all) => i === all.length - 1 || visible(m, g, q, all[i + 1])), 'every leg visible on inflated grid');
  assert.ok(p.some((q) => q.y < (40 - 32) * 0.1), 'goes under the wall through the gap');
  assert.ok(len(a, p) > 4 && len(a, p) < 8, `detour length ${len(a, p).toFixed(2)}`);
}

// 3) 길 없음: 벽이 끝까지 막음 = null, 도착이 장애물 칸 = null
{
  const m = grid(60, 40, [[29, 0, 31, 39]]);
  assert.equal(findPath(m, at(m, 10, 10), at(m, 50, 10)), null);
  assert.equal(findPath(m, at(m, 10, 10), at(m, 30, 10)), null);
  assert.equal(planRoute(m, at(m, 10, 10), [at(m, 20, 10), at(m, 50, 10)]), null, 'any leg without path = null');
}

// 4) 대각선 모서리 금지: 부풀림 0 인 격자에서 두 칸이 대각선으로만 닿는 틈은 지나지 못한다
//    (부풀린 격자가 대각 틈을 만든 경우를 직접 만든다 — 막힘 격자를 덮어 쓴 지도)
{
  const m = grid(20, 20);
  const g = inflate(m);
  g.fill(1);
  // 열린 칸: 왼쪽 위 덩어리, 오른쪽 아래 덩어리, 둘은 (9,9)-(10,10) 대각선으로만 닿음
  for (let r = 2; r <= 9; r++) for (let c = 2; c <= 9; c++) g[r * 20 + c] = 0;
  for (let r = 10; r <= 17; r++) for (let c = 10; c <= 17; c++) g[r * 20 + c] = 0;
  assert.equal(findPath(m, at(m, 3, 6), at(m, 15, 15)), null, 'no corner cutting');
  g[9 * 20 + 10] = 0;   // 옆 칸 하나를 열면 그 칸을 거쳐(곧은 두 걸음) 지나간다
  assert.ok(findPath(m, at(m, 3, 6), at(m, 15, 15)), 'side cell open = pass');
}

// 5) 부풀림: 장애물 칸 가운데에서 BODY_HALF 안 칸은 막힘, 밖은 열림
{
  const m = grid(40, 40, [[20, 20, 20, 20]]), g = inflate(m), k = Math.floor(BODY_HALF / m.res + 1e-9);
  assert.equal(g[20 * 40 + 20 + k], 1); assert.equal(g[20 * 40 + 20 + k + 1], 0);
  assert.equal(g[(20 - k) * 40 + 20], 1); assert.equal(g[(20 - k - 1) * 40 + 20], 0);
  // 폭 0.4 m 통로(부풀리면 막힘) = 길 없음, 폭 0.8 m = 지나감
  const narrow = grid(60, 40, [[29, 0, 31, 17], [29, 22, 31, 39]]);
  assert.equal(findPath(narrow, at(narrow, 10, 20), at(narrow, 50, 20)), null, 'body does not fit 0.4 m gap');
  const wide = grid(60, 40, [[29, 0, 31, 15], [29, 24, 31, 39]]);
  assert.ok(findPath(wide, at(wide, 10, 20), at(wide, 50, 20)), 'body fits 0.8 m gap');
}

// 6) 경로 줄이기: ㄱ자 벽을 도는 길은 A* 칸 수보다 훨씬 적은 경유점(직선 구간은 하나로)
{
  const m = grid(80, 80, [[20, 20, 59, 22], [57, 20, 59, 70]]), a = at(m, 30, 50), b = at(m, 70, 50), p = findPath(m, a, b);
  assert.ok(p && p.length <= 4, `smoothed to ${p?.length} waypoints`);
}

// 7) 벽 옆(부풀린 띠 안)에 선 로봇·벽 옆 점도 이어진다(SNAP), 바로 보이면 한 구간
{
  const m = grid(60, 40, [[29, 0, 31, 31]]), a = at(m, 27, 10), b = at(m, 33, 10), p = findPath(m, a, b);
  assert.ok(p && p.length >= 3, 'starts next to wall and ends next to wall');
  assert.deepEqual(p.at(-1), b);
}

// 8) 여러 점 이어 붙이기(mark = 향하는 점 번호), 라이다로 본 장애물(extra)은 그 자리를 피해 다시 찾는다
{
  const m = grid(60, 40), a = at(m, 5, 20), goals = [at(m, 30, 20), at(m, 55, 20), at(m, 55, 5)], r = planRoute(m, a, goals);
  assert.deepEqual(r.map((p) => p.mark), [0, 1, 2]);
  const seen = [at(m, 15, 20), at(m, 15, 19), at(m, 15, 21)], p = findPath(m, a, goals[0], seen);
  assert.ok(p.length >= 2, 'detours around lidar obstacle');
  assert.ok(p.every((q, i, all) => i === all.length - 1 || visible(m, inflate(m, seen), q, all[i + 1])));
  assert.deepEqual(findPath(m, a, goals[0]), [goals[0]], 'base grid untouched by extra');
}

// 9) 실제 창고 지도: 출발점에서 빈 칸 몇 곳까지 길이 나오고(또는 null), 나온 경유점은 모두 빈 칸
{
  const m = decodeMap(JSON.parse(readFileSync(new URL('../sim/assets/warehouse/map.json', import.meta.url))));
  const [sx, sy] = m.spawn_xyyaw, t0 = performance.now();
  let found = 0;
  for (const [dx, dy] of [[3, 0], [-3, 2], [0, 4], [2, -5], [-4, -4]]) {
    const p = findPath(m, { x: sx, y: sy }, { x: sx + dx, y: sy + dy });
    if (cell(m, sx + dx, sy + dy) === 254 && p) { found++; assert.ok(p.every((q) => cell(m, q.x, q.y) === 254)); }
  }
  assert.ok(found >= 2, `warehouse paths ${found}`);
  console.log(`warehouse 5 searches ${(performance.now() - t0).toFixed(0)} ms (첫 번은 부풀림 포함)`);
}
console.log('astar PASS: empty straight, wall detour (legs visible on inflated grid), no path/obstacle goal null, no diagonal corner cutting, inflation radius + narrow gap, smoothing, snap next to wall, multi-point marks + lidar extra obstacles, warehouse map');

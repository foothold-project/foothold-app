// 찍은 점 길 찾기(브라우저·Node 같이 씀): 층 지도(lidar.js cell 과 같은 칸, 행 0 = 위) 위 8방향 A*, octile 거리.
// 장애물(254 아닌 칸)을 몸 반폭 BODY_HALF 만큼 부풀린 격자에서 찾는다. 대각선은 옆 두 칸 중 하나라도 막혔으면 못 간다(모서리 자르기 금지).
// 찾은 칸 경로는 부풀린 격자 위 선분이 보이는 구간끼리 줄여 경유점만 남긴다.
export const BODY_HALF = 0.3;   // m — 몸 반폭(장애물 부풀림)
export const SNAP = 0.5;        // m — 출발·도착 칸이 부풀린 띠 안(벽 옆에 선 로봇·벽 옆 점)이면 이 거리 안 가장 가까운 빈 칸에서 잇는다

const base = new WeakMap();
const idx = (map, x, y) => {
  const c = Math.floor((x - map.origin[0]) / map.res), r = map.h - 1 - Math.floor((y - map.origin[1]) / map.res);
  return c < 0 || r < 0 || c >= map.w || r >= map.h ? -1 : r * map.w + c;
};
const center = (map, i) => ({ x: map.origin[0] + (i % map.w + 0.5) * map.res, y: map.origin[1] + (map.h - 1 - Math.floor(i / map.w) + 0.5) * map.res });

/** 막힘 격자(1 = 못 감): 254 아닌 칸 + 그 칸 가운데에서 BODY_HALF 안의 칸. extra = 지도에 없는 장애물 점(라이다로 본 것) — 있으면 새로 만든다 */
export function inflate(map, extra = []) {
  let grid = base.get(map);
  if (!grid) {
    const { w, h, px } = map, k = Math.ceil(BODY_HALF / map.res), disk = [];
    for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) if (Math.hypot(dr, dc) * map.res <= BODY_HALF + 1e-9) disk.push([dr, dc]);
    grid = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (px[i] === 254) continue;
      grid[i] = 1;
      // 빈 칸과 맞닿은 장애물 칸만 퍼뜨린다(안쪽 칸의 원은 가장자리 칸의 원들이 덮는다)
      if (!((c > 0 && px[i - 1] === 254) || (c < w - 1 && px[i + 1] === 254) || (r > 0 && px[i - w] === 254) || (r < h - 1 && px[i + w] === 254))) continue;
      for (const [dr, dc] of disk) { const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < h && cc < w) grid[rr * w + cc] = 1; }
    }
    base.set(map, grid);
  }
  if (!extra.length) return grid;
  grid = grid.slice();
  const k = Math.ceil(BODY_HALF / map.res);
  for (const p of extra) {
    const i = idx(map, p.x, p.y);
    if (i < 0) continue;
    const r = Math.floor(i / map.w), c = i % map.w;
    for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) {
      const rr = r + dr, cc = c + dc;
      if (Math.hypot(dr, dc) * map.res <= BODY_HALF + 1e-9 && rr >= 0 && cc >= 0 && rr < map.h && cc < map.w) grid[rr * map.w + cc] = 1;
    }
  }
  return grid;
}

/** 두 점 사이 선분이 부풀린 격자에서 막힘 없이 보이나(res/4 걸음) */
export function visible(map, grid, a, b) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (map.res / 4));
  for (let s = 0; s <= n; s++) { const i = idx(map, a.x + ((b.x - a.x) * s) / n, a.y + ((b.y - a.y) * s) / n); if (i < 0 || grid[i]) return false; }
  return true;
}

// 부풀린 띠 안 칸 → 지도 빈 칸(254)으로만 걸어 SNAP 안 가장 가까운(넓이 우선) 막히지 않은 칸. 없으면 -1
function snap(map, grid, i0) {
  if (!grid[i0]) return i0;
  const { w, h, px } = map, limit = SNAP / map.res, r0 = Math.floor(i0 / w), c0 = i0 % w, seen = new Set([i0]), q = [i0];
  for (let k = 0; k < q.length; k++) {
    const i = q[k], r = Math.floor(i / w), c = i % w;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc, j = rr * w + cc;
      if (rr < 0 || cc < 0 || rr >= h || cc >= w || seen.has(j) || px[j] !== 254 || Math.hypot(rr - r0, cc - c0) > limit) continue;
      if (!grid[j]) return j;
      seen.add(j); q.push(j);
    }
  }
  return -1;
}

/** from → to 경유점 목록(from 은 빼고 마지막 = to). 도착 칸이 빈 칸(254)이 아니거나 길이 없으면 null */
export function findPath(map, from, to, extra) {
  const grid = inflate(map, extra), si = idx(map, from.x, from.y), gi = idx(map, to.x, to.y);
  if (si < 0 || gi < 0 || map.px[gi] !== 254) return null;
  if (visible(map, grid, from, to)) return [{ x: to.x, y: to.y }];
  const s = snap(map, grid, si), g = snap(map, grid, gi);
  if (s < 0 || g < 0) return null;
  const { w, h } = map, N = w * h, cost = new Float64Array(N).fill(Infinity), parent = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const gr = Math.floor(g / w), gc = g % w;
  const octile = (i) => { const dr = Math.abs(Math.floor(i / w) - gr), dc = Math.abs(i % w - gc); return Math.max(dr, dc) + (Math.SQRT2 - 1) * Math.min(dr, dc); };
  // 이진 힙(우선값 f, 칸 번호)
  const hf = [], hi = [];
  const push = (f, i) => { let k = hf.length; hf.push(f); hi.push(i); while (k) { const p = (k - 1) >> 1; if (hf[p] <= f) break; hf[k] = hf[p]; hi[k] = hi[p]; k = p; } hf[k] = f; hi[k] = i; };
  const pop = () => {
    const top = hi[0], f = hf.pop(), i = hi.pop(), n = hf.length;
    if (n) { let k = 0; for (;;) { let m = 2 * k + 1; if (m >= n) break; if (m + 1 < n && hf[m + 1] < hf[m]) m++; if (hf[m] >= f) break; hf[k] = hf[m]; hi[k] = hi[m]; k = m; } hf[k] = f; hi[k] = i; }
    return top;
  };
  cost[s] = 0; push(octile(s), s);
  while (hf.length) {
    const i = pop();
    if (done[i]) continue;
    if (i === g) break;
    done[i] = 1;
    const r = Math.floor(i / w), c = i % w;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc, j = rr * w + cc;
      if ((!dr && !dc) || rr < 0 || cc < 0 || rr >= h || cc >= w || grid[j] || done[j]) continue;
      if (dr && dc && (grid[r * w + cc] || grid[rr * w + c])) continue;   // 모서리 자르기 금지
      const nc = cost[i] + (dr && dc ? Math.SQRT2 : 1);
      if (nc < cost[j]) { cost[j] = nc; parent[j] = i; push(nc + octile(j), j); }
    }
  }
  if (!Number.isFinite(cost[g])) return null;
  const cells = [];
  for (let i = g; i >= 0; i = parent[i]) cells.push(center(map, i));
  cells.reverse();
  cells.push({ x: to.x, y: to.y });
  // 줄이기: 기준점에서 보이는 데까지 늘이다 막히면 그 앞 점을 경유점으로. 출발(띠 안일 수 있음)은 첫 칸에서 센다
  const out = [];
  let a = cells[0];
  if (s !== si) out.push(a);
  for (let k = 1; k < cells.length; k++) if (!visible(map, grid, a, cells[k]) && cells[k - 1] !== a) { a = cells[k - 1]; out.push(a); }
  out.push(cells[cells.length - 1]);
  return out;
}

/** 출발 → 점1 → 점2 … 이어 붙인 경유점(각 경유점 mark = 그 구간이 향하는 찍은 점 번호). 한 구간이라도 길이 없으면 null */
export function planRoute(map, from, goals, extra) {
  const out = [];
  let a = from;
  for (let m = 0; m < goals.length; m++) {
    const leg = findPath(map, a, goals[m], extra);
    if (!leg) return null;
    for (const p of leg) out.push({ ...p, mark: m });
    a = goals[m];
  }
  return out;
}

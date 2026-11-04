// 찍은 점 길 찾기(브라우저·Node 같이 씀): 층 지도(lidar.js cell 과 같은 칸, 행 0 = 위) 위 8방향 A*, octile 거리.
// 장애물(254 아닌 칸)을 CLEARANCE 만큼 부풀린 격자에서 찾는다. 대각선은 옆 두 칸 중 하나라도 막혔으면 못 간다(모서리 자르기 금지).
// 찾은 칸 경로는 부풀린 격자 위 선분이 보이는 구간끼리 줄여 경유점만 남긴다. 돌려준 모든 구간은 부풀린 격자에서 보인다
// (띠 안에 선 로봇이 띠 밖 첫 칸으로 나가는 첫 구간만 원래 지도로 검사).
// 큰 지도(공장 1002×1002)는 부풀림·탐색이 수백 ms — SLICE_MS 마다 쉬어(setTimeout) 화면·STOP·입력이 막히지 않게 한다. 그래서 async.
import { CLEARANCE, MAX_STEP } from './walk-surface.js';
export { CLEARANCE }; // m: arrival 0.3 + walking error 0.15, shared with terrain support queries
export const SNAP = 0.6;       // m — 로봇이 띠 안(벽 옆)에 서 있으면 이 거리 안 가장 가까운 띠 밖 칸에서 잇는다(CLEARANCE 보다 커야 벽에 붙어도 나옴)
export const SLICE_MS = 8;

const bases = new WeakMap(), raws = new WeakMap(), bufs = new WeakMap();   // bufs = 지도마다 A* 배열 다시 씀(큰 지도 할당·GC 멈춤 줄이기)
const navigation = new WeakMap();
const rest = () => new Promise((r) => setTimeout(r, 0));
const idx = (map, x, y) => {
  const c = Math.floor((x - map.origin[0]) / map.res), r = map.h - 1 - Math.floor((y - map.origin[1]) / map.res);
  return c < 0 || r < 0 || c >= map.w || r >= map.h ? -1 : r * map.w + c;
};
const center = (map, i) => ({ x: map.origin[0] + (i % map.w + 0.5) * map.res, y: map.origin[1] + (map.h - 1 - Math.floor(i / map.w) + 0.5) * map.res });
const stepOK = (map, a, b) => !map.heightAt || Math.abs(map.heightAt(a.x, a.y) - map.heightAt(b.x, b.y)) <= MAX_STEP + 1e-6;
const stepCells = (map, i, j) => map.cellHeight ? Math.abs(map.cellHeight(i) - map.cellHeight(j)) <= MAX_STEP + 1e-6 : stepOK(map, center(map, i), center(map, j));
const disk = (map) => {
  const k = Math.ceil(CLEARANCE / map.res), out = [];
  for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) if (Math.hypot(dr, dc) * map.res <= CLEARANCE + 1e-9) out.push([dr, dc]);
  return out;
};
const stamp = (map, grid, d, r, c) => { for (const [dr, dc] of d) { const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < map.h && cc < map.w) grid[rr * map.w + cc] = 1; } };
// 원래 지도 막힘 격자(254 아닌 칸 = 1)
const raw = (map) => { let g = raws.get(map); if (!g) raws.set(map, g = Uint8Array.from(map.px, (v) => (v === 254 ? 0 : 1))); return g; };

/** 막힘 격자(1 = 못 감): 254 아닌 칸 + 그 칸 가운데에서 CLEARANCE 안의 칸(지도마다 한 번, 쉬어 가며). extra = 지도에 없는 장애물 점(라이다로 본 것) — 있으면 사본에 더한다 */
export async function inflate(map, extra = []) {
  let base = bases.get(map);
  if (!base) bases.set(map, base = (async () => {
    const { w, h, px } = map, d = disk(map), grid = new Uint8Array(w * h);
    let t = performance.now();
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        if (!(i & 31) && performance.now() - t > SLICE_MS) { await rest(); t = performance.now(); }
        if (px[i] === 254) continue;
        grid[i] = 1;
        // 빈 칸과 맞닿은 장애물 칸만 퍼뜨린다(안쪽 칸의 원은 가장자리 칸의 원들이 덮는다)
        if ((c > 0 && px[i - 1] === 254) || (c < w - 1 && px[i + 1] === 254) || (r > 0 && px[i - w] === 254) || (r < h - 1 && px[i + w] === 254)) stamp(map, grid, d, r, c);
      }
    }
    return grid;
  })());
  const grid = await base;
  if (!extra.length) return grid;
  const out = grid.slice(), d = disk(map);
  for (const p of extra) { const i = idx(map, p.x, p.y); if (i >= 0) stamp(map, out, d, Math.floor(i / map.w), i % map.w); }
  return out;
}

/** 점이 목표가 될 수 있나 — 지도 안·빈 칸이고 부풀린 띠 밖 */
export async function fits(map, p) {
  const i = idx(map, p.x, p.y);
  return i >= 0 && map.px[i] === 254 && !(await inflate(map))[i];
}

/** 두 점 사이 선분이 지나는 모든 칸이 막히지 않았나(칸 경계 따라 걷기). 칸 꼭짓점을 곧게 지나면 양옆 칸도 열려 있어야 한다(A* 의 모서리 금지와 같음) */
export function visible(map, grid, a, b) {
  const { w, h, res } = map, x0 = (a.x - map.origin[0]) / res, y0 = (a.y - map.origin[1]) / res, dx = (b.x - a.x) / res, dy = (b.y - a.y) / res;
  const blocked = (c, r) => c < 0 || r < 0 || c >= w || r >= h || grid[(h - 1 - r) * w + c];   // r = 아래에서 센 줄
  let c = Math.floor(x0), r = Math.floor(y0);
  const endC = Math.floor((b.x - map.origin[0]) / res), endR = Math.floor((b.y - map.origin[1]) / res);
  if (blocked(c, r) || (map.heightAt && !stepOK(map, a, a))) return false;
  const sx = Math.sign(dx), sy = Math.sign(dy), tdx = sx ? 1 / Math.abs(dx) : Infinity, tdy = sy ? 1 / Math.abs(dy) : Infinity;
  let tx = sx > 0 ? (c + 1 - x0) * tdx : sx < 0 ? (x0 - c) * tdx : Infinity;
  let ty = sy > 0 ? (r + 1 - y0) * tdy : sy < 0 ? (y0 - r) * tdy : Infinity;
  while (Math.min(tx, ty) <= 1) {
    // Lower cell boundaries belong to the endpoint's own cell. A negative
    // ray ending there must not step beyond it into the next cell at t=1.
    if (c === endC && r === endR) break;
    const previous = map.heightAt && { x: map.origin[0] + (c + .5) * res, y: map.origin[1] + (r + .5) * res };
    if (Math.abs(tx - ty) < 1e-9) {
      if (blocked(c + sx, r) || blocked(c, r + sy)) return false;
      if (map.heightAt) {
        const sideX = { x: previous.x + sx * res, y: previous.y }, sideY = { x: previous.x, y: previous.y + sy * res }, next = { x: sideX.x, y: sideY.y };
        if (!stepOK(map, previous, sideX) || !stepOK(map, previous, sideY) || !stepOK(map, next, sideX) || !stepOK(map, next, sideY)) return false;
      }
      c += sx; r += sy; tx += tdx; ty += tdy;
    } else if (tx < ty) { c += sx; tx += tdx; } else { r += sy; ty += tdy; }
    if (blocked(c, r)) return false;
    if (map.heightAt && !stepOK(map, previous, { x: map.origin[0] + (c + .5) * res, y: map.origin[1] + (r + .5) * res })) return false;
  }
  return true;
}

// Native terrain rays can be expensive on the first visit. Warm only the
// segment's cells in slices, then the synchronous visibility check reads the
// height cache. Don't block STOP while checking a long factory sight line.
async function sight(map, grid, a, b) {
  if (!map.heightAt) return visible(map, grid, a, b);
  const samples = [];
  if (!visible({ ...map, heightAt: (x, y) => { samples.push([x, y]); return 0; } }, grid, a, b)) return false;
  let t = performance.now();
  for (const [x, y] of samples) {
    map.heightAt(x, y);
    if (performance.now() - t > SLICE_MS) { await rest(); t = performance.now(); }
  }
  return visible(map, grid, a, b);
}

// 띠 안 칸 → 원래 지도 빈 칸으로만 걸어 SNAP 안 가장 가까운(넓이 우선) 띠 밖 칸. 없으면 -1
async function snap(map, grid, i0) {
  if (!grid[i0]) return i0;
  const { w, h, px } = map, limit = SNAP / map.res, r0 = Math.floor(i0 / w), c0 = i0 % w, seen = new Set([i0]), q = [i0];
  let t = performance.now();
  for (let k = 0; k < q.length; k++) {
    if (map.heightAt && performance.now() - t > SLICE_MS) { await rest(); t = performance.now(); }
    const i = q[k], r = Math.floor(i / w), c = i % w;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc, j = rr * w + cc;
      if (rr < 0 || cc < 0 || rr >= h || cc >= w || seen.has(j) || px[j] !== 254 || Math.hypot(rr - r0, cc - c0) > limit || (map.heightAt && !stepCells(map, i, j))) continue;
      if (!grid[j]) return j;
      seen.add(j); q.push(j);
    }
  }
  return -1;
}

// A*(s → g 칸) — 칸 가운데 목록, 없으면 null. 배열(cost·parent·done·힙)은 지도마다 다시 쓴다(큰 지도 할당·GC 멈춤 줄이기), 쓰는 중이면 새로 만든다
async function search(map, grid, s, g) {
  const { w, h } = map, N = w * h;
  let b = bufs.get(map);
  if (!b || b.busy) {
    b = { cost: new Float64Array(N), parent: new Int32Array(N), done: new Uint8Array(N), hf: new Float64Array(1 << 16), hi: new Int32Array(1 << 16) };
    if (!bufs.has(map)) bufs.set(map, b);
  }
  b.busy = true;
  try {
    const { cost, parent, done } = b;
    cost.fill(Infinity); parent.fill(-1); done.fill(0);
    const gr = Math.floor(g / w), gc = g % w;
    const octile = (i) => { const dr = Math.abs(Math.floor(i / w) - gr), dc = Math.abs(i % w - gc); return Math.max(dr, dc) + (Math.SQRT2 - 1) * Math.min(dr, dc); };
    // 이진 힙(우선값 f, 칸 번호) — 꽉 차면 두 배로
    let hf = b.hf, hi = b.hi, n = 0;
    const push = (f, i) => {
      if (n === hf.length) { const F = new Float64Array(n * 2), I = new Int32Array(n * 2); F.set(hf); I.set(hi); hf = b.hf = F; hi = b.hi = I; }
      let k = n++;
      while (k) { const p = (k - 1) >> 1; if (hf[p] <= f) break; hf[k] = hf[p]; hi[k] = hi[p]; k = p; }
      hf[k] = f; hi[k] = i;
    };
    const pop = () => {
      const top = hi[0], f = hf[--n], i = hi[n];
      if (n) { let k = 0; for (;;) { let m = 2 * k + 1; if (m >= n) break; if (m + 1 < n && hf[m + 1] < hf[m]) m++; if (hf[m] >= f) break; hf[k] = hf[m]; hi[k] = hi[m]; k = m; } hf[k] = f; hi[k] = i; }
      return top;
    };
    cost[s] = 0; push(octile(s), s);
    let t = performance.now(), k = 0;
    while (n) {
      if (!(++k & (map.heightAt ? 7 : 127)) && performance.now() - t > SLICE_MS) { await rest(); t = performance.now(); }
      const i = pop();
      if (done[i]) continue;
      if (i === g) break;
      done[i] = 1;
      const r = Math.floor(i / w), c = i % w;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc, j = rr * w + cc;
        if ((!dr && !dc) || rr < 0 || cc < 0 || rr >= h || cc >= w || grid[j] || done[j]) continue;
        if (dr && dc && (grid[r * w + cc] || grid[rr * w + c])) continue;   // 모서리 자르기 금지
        if (map.heightAt && !stepCells(map, i, j)) continue;
        if (map.heightAt && dr && dc && (!stepCells(map, i, r * w + cc) || !stepCells(map, i, rr * w + c)
          || !stepCells(map, j, r * w + cc) || !stepCells(map, j, rr * w + c))) continue;
        const nc = cost[i] + (dr && dc ? Math.SQRT2 : 1);
        if (nc < cost[j]) { cost[j] = nc; parent[j] = i; push(nc + octile(j), j); }
      }
    }
    if (!Number.isFinite(cost[g])) return null;
    const cells = [];
    for (let i = g; i >= 0; i = parent[i]) cells.push(center(map, i));
    return cells.reverse();
  } finally { b.busy = false; }
}

/** from → to 경유점 목록(from 은 빼고 마지막 = to). to 가 목표가 될 수 없거나(fits) 길이 없으면 null */
export async function findPath(map, from, to, extra) {
  const grid = await inflate(map, extra), si = idx(map, from.x, from.y), g = idx(map, to.x, to.y);
  if (si < 0 || g < 0 || map.px[g] !== 254 || grid[g]) return null;
  if (map.prepareNavigation) {
    if (!navigation.has(map)) navigation.set(map, map.prepareNavigation(await inflate(map)) ? { ...map, heightAt: undefined } : null);
    // A start in the inflated margin may need a height-aware SNAP over cells
    // outside the proven free area. Keep that existing check unchanged.
    const flat = navigation.get(map);
    if (flat && !grid[si]) map = flat;
  }
  if (map.heightAt && (!stepOK(map, from, from) || !stepOK(map, to, to))) return null;
  if (await sight(map, grid, from, to)) return [{ x: to.x, y: to.y }];
  const s = await snap(map, grid, si);
  if (s < 0 || (s !== si && !await sight(map, raw(map), from, center(map, s)))) return null;
  const cells = await search(map, grid, s, g);
  if (!cells) return null;
  // 이웃 칸 가운데끼리는 늘 보인다(모서리 금지) — from·to 는 첫·끝 칸 안이라 그 칸 가운데와 보인다. 띠 안 출발은 첫 칸 가운데(위에서 원래 지도로 검사)부터
  if (s === si) cells.unshift({ x: from.x, y: from.y });
  cells.push({ x: to.x, y: to.y });
  // 줄이기: 기준점에서 보이는 데까지 늘이다 막히면 그 앞 점을 경유점으로
  const out = s === si ? [] : [cells[0]];
  let a = cells[0], t = performance.now();
  for (let k = 1; k < cells.length; k++) {
    if (!(k & 3) && performance.now() - t > SLICE_MS) { await rest(); t = performance.now(); }
    if (!await sight(map, grid, a, cells[k])) { a = cells[k - 1]; out.push(a); }
  }
  out.push(cells[cells.length - 1]);
  return out;
}

/** 출발 → 점1 → 점2 … 이어 붙인 경유점(각 경유점 mark = 그 구간이 향하는 찍은 점 번호). 한 구간이라도 길이 없으면 null */
export async function planRoute(map, from, goals, extra) {
  const out = [];
  let a = from;
  for (let m = 0; m < goals.length; m++) {
    const leg = await findPath(map, a, goals[m], extra);
    if (!leg) return null;
    for (const p of leg) out.push({ ...p, mark: m });
    a = goals[m];
  }
  return out;
}

// 구역 지키기 1차(RB-ZONE-WEB 11-12) — 시나리오 편집 지도의 접근 금지 칸과 돌아가는 길.
// 금지 칸은 서버가 준 구역 칸(GET /map-versions/{id}/zone-grid — 구역이 닿은 칸만, 줄 0 = 위)이고, 막힌 칸은 지도 그림(254 아닌 칸)이다.
// 길 찾기는 브라우저 시뮬(mobile/sim/astar.js)과 같은 방식: 막힌 칸을 몸체 여유만큼 부풀린 격자 위 8방향 A*(모서리 자르기 금지), 보이는 구간끼리 줄임.
// 좌표는 모두 지도 그림 픽셀(= 칸, maps.toPixel) — 부른 쪽이 지도 좌표(m)와 바꾼다. 화면에 그리는 용도라 한 번에 계산한다(시뮬처럼 쉬어 가지 않음).
import { api } from '../api';

type P = [number, number];
/** 몸체 여유(m)·띠 안에서 나오는 거리(m) — mobile/sim/walk-surface.js CLEARANCE·astar.js SNAP 과 같은 값 */
export const CLEARANCE = 0.45, SNAP = 0.6;
/** no = 접근 금지 칸, wall = 지도 그림의 막힌 칸(못 읽었으면 null — 금지 칸만으로 찾는다), band = 둘을 몸체 여유만큼 부풀린 칸(처음 쓸 때 한 번) */
export type Cells = { w: number; h: number; res: number; no: Uint8Array; wall: Uint8Array | null; band?: Uint8Array };

/** 접근 금지 칸 전부(쪽 넘김 끝까지). 판 크기와 다르면 실패로 본다 */
export async function loadNoGo(v: { id: string; width: number; height: number }, cancel?: AbortSignal) {
  const no = new Uint8Array(v.width * v.height);
  for (let c: number | null = 0; c != null;) {
    const r = await api.zoneGrid(v.id, c, cancel);
    if (!r || !Array.isArray(r.cells) || r.width !== v.width || r.height !== v.height) throw new Error('zone-grid');
    for (const x of r.cells) if (x.no_go && x.index >= 0 && x.index < no.length) no[x.index] = 1;
    c = typeof r.next_cursor === 'number' && r.next_cursor > c ? r.next_cursor : null;
  }
  return no;
}

/** 지도 그림의 막힌 칸(254 아닌 칸 = 1, 시뮬과 같음). 그림을 못 읽으면 null */
export function loadWalls(url: string, w: number, h: number) {
  return new Promise<Uint8Array | null>((done) => {
    const img = new Image();
    img.onerror = () => done(null);
    img.onload = () => {
      try {
        if (img.naturalWidth !== w || img.naturalHeight !== h) return done(null);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
        for (let i = 0; i < out.length; i++) out[i] = d[i * 4] >= 250 ? 0 : 1;
        done(out);
      } catch { done(null); }
    };
    img.src = url;
  });
}

const cell = (w: number, h: number, [x, y]: P) => { const c = Math.floor(x), r = Math.floor(y); return c < 0 || r < 0 || c >= w || r >= h ? -1 : r * w + c; };
/** 그 자리가 접근 금지 칸인가 */
export const noGoAt = (g: Pick<Cells, 'w' | 'h' | 'no'>, p: P) => { const i = cell(g.w, g.h, p); return i >= 0 && !!g.no[i]; };
/** 선분 a–b 를 1/4 칸씩 걸으며 test(칸) 이 참인 칸이 있나. 지도 밖 칸은 out 값 */
function walk(w: number, h: number, a: P, b: P, test: (i: number) => boolean, out: boolean) {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 4));
  for (let k = 0; k <= n; k++) { const i = cell(w, h, [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]); if (i < 0 ? out : test(i)) return true; }
  return false;
}
/** 곧은 길 a–b 가 접근 금지 칸을 지나나 */
export const crosses = (g: Pick<Cells, 'w' | 'h' | 'no'>, a: P, b: P) => walk(g.w, g.h, a, b, (i) => !!g.no[i], false);

/** 막힌 칸(금지 + 벽)에서 몸체 여유 안의 칸 — 빈 칸과 맞닿은 막힌 칸만 퍼뜨린다(astar.js inflate 와 같음) */
function band(g: Cells) {
  if (g.band) return g.band;
  const { w, h } = g, hard = (i: number) => g.no[i] || g.wall?.[i], k = Math.ceil(CLEARANCE / g.res), disk: P[] = [], out = new Uint8Array(w * h);
  for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) if (Math.hypot(dr, dc) * g.res <= CLEARANCE + 1e-9) disk.push([dr, dc]);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c;
    if (!hard(i)) continue;
    out[i] = 1;
    if ((c > 0 && !hard(i - 1)) || (c < w - 1 && !hard(i + 1)) || (r > 0 && !hard(i - w)) || (r < h - 1 && !hard(i + w)))
      for (const [dr, dc] of disk) { const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < h && cc < w) out[rr * w + cc] = 1; }
  }
  return (g.band = out);
}

const DIRS: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
/** a → b 돌아가는 길(그림 픽셀 꺾인 선, 양 끝 포함). 길이 없으면 null.
 *  끝점이 부풀린 띠 안(구역·벽 바로 옆)이면 SNAP 안에서는 띠를 무시한다 — 금지 칸·벽 칸 자체는 언제나 못 지난다.
 *  ponytail: 부를 때마다 칸 수만큼 배열을 새로 잡는다(1000×1000 칸 ≈ 수십 ms). 더 큰 지도·끄는 동안 버벅이면 astar.js 처럼 배열을 다시 쓰고 쉬어 가며 계산 */
export function route(g: Cells, a: P, b: P): P[] | null {
  const { w, h } = g, s = cell(w, h, a), t = cell(w, h, b), bd = band(g), near = SNAP / g.res;
  const by = (i: number, p: P) => Math.hypot((i % w) + 0.5 - p[0], Math.floor(i / w) + 0.5 - p[1]) <= near;
  const open = (i: number) => !g.no[i] && !g.wall?.[i] && (!bd[i] || by(i, a) || by(i, b));
  if (s < 0 || t < 0 || !open(s) || !open(t)) return null;
  const cost = new Float32Array(w * h).fill(Infinity), from = new Int32Array(w * h).fill(-1), done = new Uint8Array(w * h), tc = t % w, tr = Math.floor(t / w);
  const est = (i: number) => { const dx = Math.abs((i % w) - tc), dy = Math.abs(Math.floor(i / w) - tr); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
  // 작은 값 먼저 꺼내는 더미(같은 칸이 여러 번 들어갈 수 있음 — 꺼낼 때 done 으로 거른다)
  const heap: number[] = [], key: number[] = [];
  const push = (i: number, f: number) => { let k = heap.length; heap.push(i); key.push(f);
    while (k > 0) { const p = (k - 1) >> 1; if (key[p] <= f) break; heap[k] = heap[p]; key[k] = key[p]; k = p; } heap[k] = i; key[k] = f; };
  const pop = () => { const top = heap[0], i = heap.pop()!, f = key.pop()!, n = heap.length; let k = 0;
    if (n) { for (;;) { let c = 2 * k + 1; if (c >= n) break; if (c + 1 < n && key[c + 1] < key[c]) c++; if (key[c] >= f) break; heap[k] = heap[c]; key[k] = key[c]; k = c; } heap[k] = i; key[k] = f; }
    return top; };
  cost[s] = 0; push(s, est(s));
  while (heap.length) {
    const i = pop();
    if (done[i]) continue;
    if (i === t) break;
    done[i] = 1;
    const c = i % w, r = Math.floor(i / w);
    for (const [dc, dr, d] of DIRS) {
      const cc = c + dc, rr = r + dr, j = rr * w + cc;
      if (cc < 0 || rr < 0 || cc >= w || rr >= h || done[j] || !open(j)) continue;
      if (dc && dr && (!open(r * w + cc) || !open(rr * w + c))) continue;   // 모서리 자르기 금지
      const n = cost[i] + d;
      if (n < cost[j]) { cost[j] = n; from[j] = i; push(j, n + est(j)); }
    }
  }
  if (s !== t && from[t] < 0) return null;
  const pts: P[] = [b];
  for (let i = from[t]; i >= 0 && i !== s; i = from[i]) pts.push([(i % w) + 0.5, Math.floor(i / w) + 0.5]);
  pts.push(a); pts.reverse();
  // 보이는 구간끼리 줄인다(앞에서부터 — 안 보이는 첫 점의 바로 앞 점을 꺾는 점으로)
  const out: P[] = [a], shut = (i: number) => !open(i);
  for (let at = 0, k = 2; k < pts.length; k++) if (walk(w, h, pts[at], pts[k], shut, true)) { out.push(pts[k - 1]); at = k - 1; }
  out.push(b);
  return out;
}

/** 구역 칸을 못 받았을 때만 쓰는 점-안 검사(지도 좌표, 변 위 포함은 아님) */
export function inPolygon(pg: [number, number][], x: number, y: number) {
  let hit = false;
  for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) {
    const [xi, yi] = pg[i], [xj, yj] = pg[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

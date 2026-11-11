// 구역 지키기(브라우저·Node 같이 씀, RB-ZONE-SIM 11-12): 서버가 계산한 구역 칸(zone-grid)을 받아 시뮬 지도 칸으로 옮긴다.
// 판정은 zone-grid 한 곳만 쓴다(다각형은 다시 계산하지 않음). 칸 약속(apps/server/ZONES.md): index = row*width + col, 0행 = 위쪽,
// 칸 가운데 = 원점 yaw 로 돌리기 전 ((col+.5)*res, (height-row-.5)*res) + 원점 XY. 구역이 없는 칸은 오지 않는다. 몸체 여유는 여기서 더한다.
import { CLEARANCE } from './walk-surface.js';

// 몸체 여유(m): Go2 몸 가운데에서 가장 먼 곳(길이 0.70·폭 0.31 → 반대각 0.38)을 올림. 몸 가운데가 금지 칸에서 이 거리 안이면 «구역 안»으로 본다
export const BODY_MARGIN = 0.4;
// 길 찾기 여유(m): 몸체 여유 + 경로에서 벗어나는 폭(기존 벽 여유와 같은 0.45 = 도착 반경 0.3 + 보행 오차 0.15) — 달리는 중 몸이 구역에 닿지 않게
export const PLAN_MARGIN = BODY_MARGIN + CLEARANCE;
export const LOOK_S = 0.4;   // 다음 걸음 = 지금 속도로 이 시간(s) 뒤 자리(적어도 1.5칸)
export const ZONE_STOP = '접근 금지 구역 앞에서 멈춤';
export const ZONE_PAGE = 20000, ZONE_TIMEOUT_MS = 8000, ZONE_MAX_CELLS = 4e6;

const fail = (why) => { throw new Error(`구역 칸 형식: ${why}`); };

/** zone-grid 를 끝까지(next_cursor) 받아 { origin, res, w, h, flag(1 금지·2 감속), cap(m/s, 값 없음 NaN), count }. 실패는 throw */
export async function loadZoneGrid(id, fetchPage = globalThis.fetch, timeoutMs = ZONE_TIMEOUT_MS) {
  if (!/^[0-9a-f-]{8,64}$/i.test(id ?? '')) fail('지도 판 id');
  let grid = null, cursor = 0;
  for (let page = 0; cursor !== null; page++) {
    if (page > ZONE_MAX_CELLS / ZONE_PAGE) fail('끝나지 않는 목록');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let j;
    try {
      const response = await fetchPage(`/api/v1/map-versions/${id}/zone-grid?cursor=${cursor}&limit=${ZONE_PAGE}`,
        { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) fail(`응답 ${response.status}`);
      j = await response.json();
    } finally { clearTimeout(timer); }
    grid = addZonePage(grid, j, id);
    if (j.next_cursor !== null && !(Number.isInteger(j.next_cursor) && j.next_cursor > cursor)) fail('next_cursor');
    cursor = j.next_cursor;
  }
  return grid;
}

/** 한 쪽(page)을 격자에 더한다. 처음이면 격자를 만들고, 다음 쪽은 치수·원점이 같아야 한다 */
export function addZonePage(grid, j, id) {
  if (j?.format_version !== 1 || j.row_order !== 'TOP_TO_BOTTOM') fail('format_version·row_order');
  if (id != null && String(j.map_version_id).toLowerCase() !== String(id).toLowerCase()) fail('다른 지도 판');
  const { origin, resolution: res, width: w, height: h, cells } = j;
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite) || !(res > 0) || !Number.isFinite(res)
    || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > ZONE_MAX_CELLS || !Array.isArray(cells)) fail('치수');
  if (!grid) grid = { origin: origin.slice(), res, w, h, flag: new Uint8Array(w * h), cap: new Float32Array(w * h).fill(NaN), count: 0 };
  else if (grid.res !== res || grid.w !== w || grid.h !== h || grid.origin.some((v, i) => v !== origin[i])) fail('쪽마다 다른 치수');
  for (const c of cells) {
    if (!Number.isInteger(c?.index) || c.index < 0 || c.index >= w * h || typeof c.no_go !== 'boolean' || typeof c.slow !== 'boolean') fail('칸');
    if (c.max_speed_mps != null && !(Number.isFinite(c.max_speed_mps) && c.max_speed_mps > 0)) fail('칸 속도');
    grid.flag[c.index] = (c.no_go ? 1 : 0) | (c.slow ? 2 : 0);
    grid.cap[c.index] = c.no_go || c.max_speed_mps == null ? NaN : c.max_speed_mps;   // 금지 우선: 금지 칸에는 속도 없음
    grid.count++;
  }
  return grid;
}

/** 세계 (x, y) → 구역 격자 칸 번호(밖이면 -1) */
export function zoneIndex(grid, x, y) {
  const [ox, oy, yaw] = grid.origin, c0 = Math.cos(yaw), s0 = Math.sin(yaw), dx = x - ox, dy = y - oy;
  const col = Math.floor((c0 * dx + s0 * dy) / grid.res + 1e-9), row = grid.h - 1 - Math.floor((-s0 * dx + c0 * dy) / grid.res + 1e-9);
  return col < 0 || row < 0 || col >= grid.w || row >= grid.h ? -1 : row * grid.w + col;
}
/** 구역 격자 칸 가운데의 세계 좌표(ZONES.md 식 그대로) */
export function zoneCenter(grid, index) {
  const [ox, oy, yaw] = grid.origin, lx = (index % grid.w + .5) * grid.res, ly = (grid.h - Math.floor(index / grid.w) - .5) * grid.res;
  return { x: ox + Math.cos(yaw) * lx - Math.sin(yaw) * ly, y: oy + Math.sin(yaw) * lx + Math.cos(yaw) * ly };
}

const mapIndex = (map, x, y) => {
  const c = Math.floor((x - map.origin[0]) / map.res), r = map.h - 1 - Math.floor((y - map.origin[1]) / map.res);
  return c < 0 || r < 0 || c >= map.w || r >= map.h ? -1 : r * map.w + c;
};

/** 구역 격자 → 시뮬 지도 칸(행 0 = 위, astar.js 와 같은 칸). 구역 칸이 시뮬 칸에 조금이라도 닿으면 적용, 겹치면 금지 우선·낮은 속도.
 *  돌려주는 것: noGo·slow(0/1), cap(m/s, 제한 없음 Infinity), away(m: 금지 칸까지 칸 가운데 거리, 금지 칸 안은 −깊이, PLAN_MARGIN 밖 Infinity),
 *  plan(1 = 길 찾기 막힘: 금지 칸 + PLAN_MARGIN). 구역 칸이 하나도 없으면 null */
export function zoneLayer(map, grid) {
  if (!grid?.count) return null;
  const { w, h, res } = map, N = w * h, noGo = new Uint8Array(N), slow = new Uint8Array(N), cap = new Float32Array(N).fill(Infinity);
  // 구역 칸(돌아간 사각형)을 둘러싼 축 정렬 상자에 닿는 시뮬 칸을 모두 칠한다 — 원점·해상도·yaw 가 달라도 닿은 칸을 놓치지 않는다.
  // ponytail: 돌아간 칸은 상자가 실제보다 넓어 모서리 옆 칸까지 칠한다(넓게 잡는 쪽). 딱 맞추려면 사각형끼리 겹침 검사
  const [ox, oy, yaw] = grid.origin, c0 = Math.cos(yaw), s0 = Math.sin(yaw), e = 1e-6;   // e: 변만 맞닿은 이웃 칸은 빼기
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  for (let z = 0; z < grid.flag.length; z++) {
    const f = grid.flag[z];
    if (!f) continue;
    const lx = (z % grid.w) * grid.res, ly = (grid.h - 1 - Math.floor(z / grid.w)) * grid.res;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const px = lx + u * grid.res, py = ly + v * grid.res, x = ox + c0 * px - s0 * py, y = oy + s0 * px + c0 * py;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x1 - e < map.origin[0] || y1 - e < map.origin[1] || x0 + e >= map.origin[0] + w * res || y0 + e >= map.origin[1] + h * res) continue;   // 지도 밖
    const ca = clamp(Math.floor((x0 + e - map.origin[0]) / res), w - 1), cb = clamp(Math.floor((x1 - e - map.origin[0]) / res), w - 1);
    const ra = clamp(h - 1 - Math.floor((y1 - e - map.origin[1]) / res), h - 1), rb = clamp(h - 1 - Math.floor((y0 + e - map.origin[1]) / res), h - 1);
    for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) {
      const i = r * w + c;
      if (f & 1) noGo[i] = 1;
      if (f & 2) { slow[i] = 1; if (grid.cap[z] < cap[i]) cap[i] = grid.cap[z]; }
    }
  }
  let any = false, hasSlow = false;
  for (let i = 0; i < N; i++) {
    if (noGo[i]) { slow[i] = 0; cap[i] = Infinity; }
    any ||= !!(noGo[i] || slow[i]); hasSlow ||= !!slow[i];
  }
  if (!any) return null;
  const away = new Float32Array(N).fill(Infinity), plan = new Uint8Array(N);
  const k = Math.ceil(PLAN_MARGIN / res), disk = [];
  for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) { const m = Math.hypot(dr, dc) * res; if (m <= PLAN_MARGIN + 1e-9) disk.push([dr, dc, m]); }
  const edge = (i, r, c, inside) => (c > 0 && !!noGo[i - 1] !== inside) || (c < w - 1 && !!noGo[i + 1] !== inside) || (r > 0 && !!noGo[i - w] !== inside) || (r < h - 1 && !!noGo[i + w] !== inside);
  const queue = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c;
    if (!noGo[i]) continue;
    plan[i] = 1;
    if (!edge(i, r, c, true)) continue;   // 안쪽 칸의 원은 가장자리 칸의 원들이 덮는다
    away[i] = 0; queue.push(i);
    for (const [dr, dc, m] of disk) {
      const rr = r + dr, cc = c + dc, j = rr * w + cc;
      if (rr < 0 || cc < 0 || rr >= h || cc >= w || noGo[j]) continue;
      plan[j] = 1; if (m < away[j]) away[j] = m;
    }
  }
  // 금지 칸 안쪽 깊이(음수): 가장자리에서 한 칸씩. 구역 안에서 시작했을 때 «나가는 방향»을 가린다
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q], r = Math.floor(i / w), c = i % w;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr, cc = c + dc, j = rr * w + cc;
      if (rr < 0 || cc < 0 || rr >= h || cc >= w || !noGo[j] || away[j] !== Infinity) continue;
      away[j] = away[i] - res; queue.push(j);
    }
  }
  for (let i = 0; i < N; i++) if (noGo[i] && away[i] === Infinity) away[i] = -res;   // 가장자리가 없는(지도 전체) 구역
  return { noGo, slow, cap, away, plan, hasSlow };
}

const awayAt = (layer, map, x, y) => { const i = mapIndex(map, x, y); return i < 0 ? Infinity : layer.away[i]; };

/** (x, y) 에서 방향 angle(세계, rad)·속력 speed(m/s)로 한 걸음 가면 금지 구역(몸체 여유 포함)으로 더 들어가나.
 *  구역 밖으로·옆으로 가는 걸음과 여유 밖 걸음은 false */
export function zoneEnters(layer, map, x, y, angle, speed) {
  if (!layer) return false;
  const look = Math.max(Math.abs(speed) * LOOK_S, 1.5 * map.res);
  const next = awayAt(layer, map, x + Math.cos(angle) * look, y + Math.sin(angle) * look);
  return next < BODY_MARGIN && next < awayAt(layer, map, x, y) - 1e-6;
}

/** 손 조종 명령 [vx, vy, wz](몸 기준): 금지 구역(몸체 여유 포함)으로 들어가는 이동은 0(제자리 회전은 그대로).
 *  구역이 다음 걸음(LOOK_S) 안에 있으면 남은 거리만큼 미리 줄여 구역 바로 앞에서 0 이 된다. speed = 이동 속력(없으면 명령 크기) */
export function guardCommand(layer, map, x, y, yaw, cmd, speed = Math.hypot(cmd[0], cmd[1])) {
  if (!layer || (!cmd[0] && !cmd[1])) return { cmd, blocked: false };
  const angle = yaw + Math.atan2(cmd[1], cmd[0]), dx = Math.cos(angle), dy = Math.sin(angle), here = awayAt(layer, map, x, y);
  const min = 1.5 * map.res, want = Math.max(Math.abs(speed) * LOOK_S, min);
  let free = 0;
  for (let look = min; ; look = Math.min(look + map.res, want)) {   // 한 칸씩 늘려 끝(want)까지 — 사이 칸도 본다
    const next = awayAt(layer, map, x + dx * look, y + dy * look);
    if (next < BODY_MARGIN && next < here - 1e-6) break;
    free = look;
    if (look >= want) break;
  }
  if (!free) return { cmd: [0, 0, cmd[2]], blocked: true };
  const k = Math.min(1, free / want);
  return { cmd: k < 1 ? [cmd[0] * k, cmd[1] * k, cmd[2]] : cmd, blocked: false };
}

/** (x, y) 칸의 감속: { slow, cap(m/s, 제한 없음 Infinity) } — slow 인데 cap 이 Infinity 면 «속도 값이 없는 감속 구역» */
export function zoneSpeed(layer, map, x, y) {
  const i = layer ? mapIndex(map, x, y) : -1;
  return i < 0 ? { slow: false, cap: Infinity } : { slow: !!layer.slow[i], cap: layer.cap[i] };
}

/** 속도 명령의 이동 크기를 cap 아래로(방향 유지, 회전 그대로). 기존 한계를 넓히지 않는다 — 줄이기만 */
export function capCommand(cmd, cap) {
  const speed = Math.hypot(cmd[0], cmd[1]);
  return speed > cap ? [cmd[0] * cap / speed, cmd[1] * cap / speed, cmd[2]] : cmd;
}

/** 정책에 들어가는 «최종» 속도 명령에 거는 구역 제한: 그 칸의 감속 상한 → (guard 면) 금지 구역 진입 0.
 *  가감속(slew) 뒤에 반드시 한 번 더 건다 — slew 가 줄인 명령을 이전 값 쪽으로 되살리기 때문 */
export function zoneLimit(layer, map, x, y, yaw, cmd, guard = true) {
  if (!layer) return { cmd, blocked: false };
  const capped = capCommand(cmd, zoneSpeed(layer, map, x, y).cap);
  return guard ? guardCommand(layer, map, x, y, yaw, capped) : { cmd: capped, blocked: false };
}

/** 그리기용: 구역 칸의 사각형들 — kind 'noGo'|'slow', edge = 테두리 칸만. 돌려주는 것 [x0, y0, x1, y1, 칸 번호][] */
export function zoneQuads(layer, map, kind, edge) {
  const { w, h, res } = map, grid = layer[kind], out = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c;
    if (!grid[i]) continue;
    if (edge && c > 0 && grid[i - 1] && c < w - 1 && grid[i + 1] && r > 0 && grid[i - w] && r < h - 1 && grid[i + w]) continue;
    const x = map.origin[0] + c * res, y = map.origin[1] + (h - 1 - r) * res;
    out.push([x, y, x + res, y + res, i]);
  }
  return out;
}

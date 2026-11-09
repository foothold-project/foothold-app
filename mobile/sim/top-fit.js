import { cell } from './lidar.js';
import { CLEARANCE, fits } from './astar.js';

// Both URL starts and map picks must use exactly the same admission rules.
export async function validateStart(map, text, defaultYaw = map.spawn_xyyaw[2]) {
  const fields = text.split(',').map((v) => v.trim()), values = fields.map(Number), [x, y] = values;
  let reason = '';
  if (![2, 3].includes(fields.length) || fields.some((v) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v)) || !values.every(Number.isFinite)) reason = '좌표·방향은 유한한 숫자여야 합니다';
  else if (x < map.origin[0] || y < map.origin[1] || x >= map.origin[0] + map.w * map.res || y >= map.origin[1] + map.h * map.res) reason = '지도 밖';
  else if (cell(map, x, y) !== 254) reason = '장애물·모르는 칸';
  else if (!(await fits(map, { x, y }))) reason = `벽·물건에서 ${CLEARANCE} m 안`;
  return { reason, start: reason ? null : [x, y, values[2] ?? defaultYaw] };
}

export async function startPickUrl(map, href, x, y, yaw, floor) {
  const picked = await validateStart(map, [x, y, yaw].join(','));
  if (picked.reason) return { ...picked, url: null };
  // Check the serialized point: rounding must not move an accepted pick into a wall.
  const text = [x, y, yaw].map((v) => v.toFixed(2)).join(',');
  const result = await validateStart(map, text);
  if (result.reason) return { ...result, url: null };
  const url = new URL(href);
  url.searchParams.set('start', text);
  if (floor == null) url.searchParams.delete('floor');
  else url.searchParams.set('floor', floor);
  return { ...result, url: url.href };
}

// Orthographic whole-map framing, independent of phone orientation or spawn.
export function topFrame(map, aspect, rotation = 0, zoom = 1, center = null) {
  const w = map.w * map.res, h = map.h * map.res;
  const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation));
  const height = Math.max(c * h + s * w, (c * w + s * h) / aspect) * 1.08 * zoom;
  const width = height * aspect;
  // Keep the viewport over the map, allowing the same 8% border as whole-map fit.
  // If an axis fits entirely, keep that axis centered (also after a resize).
  const bx = Math.max(0, (w - (c * width + s * height) / 1.08) / 2);
  const by = Math.max(0, (h - (s * width + c * height) / 1.08) / 2);
  const mx = map.origin[0] + w / 2, my = map.origin[1] + h / 2;
  const clamp = (v, mid, span) => Math.max(mid - span, Math.min(mid + span, v ?? mid));
  return { cx: clamp(center?.[0], mx, bx), cy: clamp(center?.[1], my, by), width, height };
}

// Normalized CSS viewport coordinates → world point on the top-view plane.
export function topPoint(frame, rotation, u, v) {
  const x = (u - .5) * frame.width, y = (.5 - v) * frame.height;
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return [frame.cx + c * x - s * y, frame.cy + s * x + c * y];
}

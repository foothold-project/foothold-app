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

// Orthographic whole-map framing, independent of phone orientation or spawn.
export function topFrame(map, aspect, rotation = 0, zoom = 1) {
  const w = map.w * map.res, h = map.h * map.res;
  const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation));
  const height = Math.max(c * h + s * w, (c * w + s * h) / aspect) * 1.08 * zoom;
  return { cx: map.origin[0] + w / 2, cy: map.origin[1] + h / 2, width: height * aspect, height };
}

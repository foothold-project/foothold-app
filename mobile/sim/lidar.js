// RS-6 가상 라이다(브라우저·Node 같이 씀): mj_multiRay 로 수평 360° 한 줄, 창고 geom(group 1)만 맞힌다(로봇 몸 제외).
// 지도 쪽 거리: map.json(f1.png 원값, 0 = 점유) 위를 res/4 걸음으로 걸어 첫 점유 칸까지.
export const MAX_RANGE = 12;

export function makeLidar(mj, m, d, n = 360) {
  const vec = new Float64Array(n * 3), dist = new mj.DoubleBuffer(n);
  const gid = new mj.IntBuffer(n);
  const group = [0, 1, 0, 0, 0, 0];
  const out = new Float64Array(n);
  return (x, y, z, yaw) => {
    const v = vec;
    for (let i = 0; i < n; i++) { const a = yaw + (i * 2 * Math.PI) / n; v[i * 3] = Math.cos(a); v[i * 3 + 1] = Math.sin(a); v[i * 3 + 2] = 0; }
    mj.mj_multiRay(m, d, [x, y, z], vec, group, true, -1, gid, dist, null, n, MAX_RANGE);
    const r = dist.GetView();
    for (let i = 0; i < n; i++) out[i] = r[i] < 0 || r[i] > MAX_RANGE ? Infinity : r[i]; // −1 = 안 맞음
    return out;
  };
}

export function decodeMap(j) {
  const px = typeof atob === 'function' ? Uint8Array.from(atob(j.px), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(j.px, 'base64'));
  return { ...j, px };
}
// 세계 (x,y) → 칸 값(행 0 = 위쪽, metadata.json 의 pixel_to_world 와 같음). 지도 밖은 205(모름)
export function cell(map, x, y) {
  const c = Math.floor((x - map.origin[0]) / map.res), r = map.h - 1 - Math.floor((y - map.origin[1]) / map.res);
  return c < 0 || r < 0 || c >= map.w || r >= map.h ? 205 : map.px[r * map.w + c];
}
export function mapRay(map, x, y, a, max = MAX_RANGE) {
  const s = map.res / 4, dx = Math.cos(a) * s, dy = Math.sin(a) * s;
  for (let t = 0; t <= max; t += s, x += dx, y += dy) if (cell(map, x, y) === 0) return t;
  return Infinity;
}

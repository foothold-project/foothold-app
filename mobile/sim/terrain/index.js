// Browser + Node ESM. Coordinates/metres: centred floor, yaw radians, uphill +X.
// Every item is centred on its entire footprint (stairs include the 1 m landing).
export const SCHEMA = 'fh_custom_terrain/1';
export const CLEARANCE = 0.45;
const finite = Number.isFinite;
const tuple = (v, n) => Array.isArray(v) && v.length === n && Array.from(v).every(finite);
const dimensions = (o) => o.kind === 'box' ? [o.sx, o.sy]
  : o.kind === 'stairs' ? [o.steps * o.run + 1, o.width] : [o.length, o.width];
const local = (o, x, y) => { const c = Math.cos(o.yaw), s = Math.sin(o.yaw); return [c * (x - o.x) + s * (y - o.y), -s * (x - o.x) + c * (y - o.y)]; };
const world = (o, x, y) => [o.x + Math.cos(o.yaw) * x - Math.sin(o.yaw) * y, o.y + Math.sin(o.yaw) * x + Math.cos(o.yaw) * y];
const corners = (o) => { const [a, b] = dimensions(o); return [[-a/2,-b/2],[a/2,-b/2],[a/2,b/2],[-a/2,b/2]].map(([x,y]) => world(o,x,y)); };
const distance = (o, x, y) => { const [a,b] = dimensions(o), [u,v] = local(o,x,y); return Math.hypot(Math.max(0,Math.abs(u)-a/2),Math.max(0,Math.abs(v)-b/2)); };

export function validateTerrain(spec) {
  const errors = [], warnings = [];
  const error = (msg, item) => errors.push(item === undefined ? {msg} : {item,msg});
  const warn = (msg, item) => warnings.push({item,msg});
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return {errors:[{msg:'지형 JSON 객체가 필요합니다'}],warnings};
  if (spec.schema !== SCHEMA) error('지형 schema는 fh_custom_terrain/1이어야 합니다');
  if (typeof spec.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(spec.id)) error('id는 영문 소문자·숫자·- 1~32자여야 합니다');
  if (typeof spec.name !== 'string' || !spec.name.trim()) error('지형 이름이 필요합니다');
  const sizeOK = tuple(spec.size,2) && spec.size.every(v => v >= 4 && v <= 30);
  if (!sizeOK) error('바닥 가로·세로는 각각 4~30 m여야 합니다');
  const spawnOK = tuple(spec.spawn,3);
  if (!spawnOK) error('시작 위치 x·y·yaw는 유한한 숫자여야 합니다');
  else if (sizeOK && spec.spawn.slice(0,2).some((v,i) => Math.abs(v) > spec.size[i]/2 - CLEARANCE)) error('시작 위치는 바닥 안쪽 가장자리에서 0.45 m 떨어져야 합니다');
  if (!Array.isArray(spec.items) || spec.items.length > 60) error('물체 목록은 60개 이하여야 합니다');
  if (!Array.isArray(spec.items)) return {errors,warnings};
  spec.items.slice(0,61).forEach((o,item) => {
    if (!o || typeof o !== 'object' || !['box','stairs','ramp','gap'].includes(o.kind)) { error('알 수 없는 물체 종류입니다',item); return; }
    const initial = errors.length;
    if (![o.x,o.y,o.yaw].every(finite)) error('위치·방향은 유한한 숫자여야 합니다',item);
    const positive = (keys) => { if (keys.some(k => !finite(o[k]) || o[k] <= 0)) error('크기·높이는 양의 유한한 숫자여야 합니다',item); };
    if (o.kind === 'box') positive(['sx','sy','h']);
    else if (o.kind === 'stairs') {
      positive(['width','run','rise','steps']);
      if (!Number.isInteger(o.steps) || o.steps < 1) error('계단 수는 1 이상의 정수여야 합니다',item);
      if (!finite(o.rise) || o.rise < .02 || o.rise > .25) error('계단 단 높이는 0.02~0.25 m여야 합니다',item);
      if (!finite(o.run) || o.run < .15) error('계단 단 깊이는 0.15 m 이상이어야 합니다',item);
      if (o.steps * o.rise > 1) error('계단 전체 높이는 1.0 m 이하여야 합니다',item);
      if (finite(o.rise) && o.rise > .17) warn('단 높이가 0.17 m를 넘습니다 (AME-2 학습 최대 근처)',item);
    } else positive(o.kind === 'ramp' ? ['length','width','h'] : ['length','width']);
    if (['box','ramp'].includes(o.kind) && o.h > 1) error('높이는 1.0 m 이하여야 합니다',item);
    if (o.kind === 'ramp' && finite(o.h) && finite(o.length) && o.length > 0) {
      const deg = Math.atan2(o.h,o.length) * 180 / Math.PI;
      if (deg > 30 + 1e-9) error('경사는 30° 이하여야 합니다',item);
      if (deg > 20 + 1e-9) warn('경사가 20°를 넘습니다',item);
    }
    if (o.kind === 'gap' && finite(o.length) && o.length > .6) warn('틈 길이가 0.6 m를 넘습니다',item);
    if (errors.length !== initial) return;
    if (sizeOK && corners(o).some(p => p.some((v,i) => Math.abs(v) > spec.size[i]/2 + 1e-9))) error('물체 전체가 바닥 안에 있어야 합니다',item);
    if (spawnOK && distance(o,...spec.spawn) < CLEARANCE - 1e-9) error('시작 위치는 물체·틈에서 0.45 m 떨어져야 합니다',item);
  });
  return {errors,warnings};
}

// Split convex support polygons around each rotated gap. Each remaining piece
// is convex, so MuJoCo's mesh convex hull cannot silently bridge a hole.
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
function clip(poly, a, b, inside) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const d = cross(a, b, p) * inside, e = cross(a, b, q) * inside;
    if (d >= 0) out.push(p);
    if ((d > 0 && e < 0) || (d < 0 && e > 0)) {
      const t = d / (d - e);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out.filter((p, i) => {
    const previous = out[(i + out.length - 1) % out.length];
    return Math.hypot(p[0] - previous[0], p[1] - previous[1]) > 1e-9;
  });
}
const area = poly => Math.abs(poly.reduce((sum, a, i) => {
  const b = poly[(i + 1) % poly.length];
  return sum + a[0] * b[1] - a[1] * b[0];
}, 0)) / 2;
function subtract(poly, hole) {
  const pieces = [];
  let remaining = poly;
  for (let i = 0; i < 4 && remaining.length >= 3; i++) {
    const a = hole[i], b = hole[(i + 1) % 4], outside = clip(remaining, a, b, -1);
    if (outside.length >= 3 && area(outside) > 1e-10) pieces.push(outside);
    remaining = clip(remaining, a, b, 1);
  }
  return pieces;
}
function prism(poly, bottom, top) {
  const n = poly.length;
  const p = [...poly.flatMap(([x, y]) => [x, y, bottom]),
    ...poly.flatMap(([x, y]) => [x, y, typeof top === 'function' ? top(x, y) : top])];
  const i = [];
  for (let k = 1; k < n - 1; k++) i.push(0, k + 1, k, n, n + k, n + k + 1);
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    i.push(k, j, n + j, k, n + j, n + k);
  }
  return {p, i};
}
const encode = px => {
  // Chunked conversion avoids argument/stack limits on a 30 m grid.
  let s = '';
  for (let k = 0; k < px.length; k += 8192) s += String.fromCharCode(...px.subarray(k, k + 8192));
  return btoa(s);
};

export function buildTerrain(spec) {
  const validation = validateTerrain(spec);
  if (validation.errors.length) throw new Error(validation.errors.map(e =>
    `${e.item === undefined ? '지형' : `물체 ${e.item + 1}`}: ${e.msg}`).join('\n'));
  const [sx, sy] = spec.size;
  const boundary = [[-sx/2, -sy/2], [sx/2, -sy/2], [sx/2, sy/2], [-sx/2, sy/2]];
  const meshes = {}, models = [], assets = [], geoms = [];
  const add = (mesh, color, pos = [0, 0, 0], yaw = 0, boxSize = null) => {
    const name = `terrain-${models.length}`, quat = [Math.cos(yaw/2), 0, 0, Math.sin(yaw/2)];
    meshes[name] = mesh;
    models.push({name, mesh: name, pos, quat, color});
    if (!boxSize) assets.push(`<mesh name="${name}" vertex="${mesh.p.join(' ')}" face="${mesh.i.join(' ')}"/>`);
    const shape = boxSize ? `type="box" size="${boxSize.map(v => v/2).join(' ')}"` : `type="mesh" mesh="${name}"`;
    geoms.push(`<geom name="${name}" group="1" ${shape} pos="${pos.join(' ')}" quat="${quat.join(' ')}" rgba="${color.join(' ')} 1"/>`);
  };
  const box = (x, y, yaw, a, b, h, color) => add(
    prism([[-a/2, -b/2], [a/2, -b/2], [a/2, b/2], [-a/2, b/2]], -h/2, h/2),
    color, [x, y, h/2], yaw, [a, b, h]);
  const gaps = spec.items.filter(o => o.kind === 'gap');
  let support = [boundary];
  for (const o of gaps) support = support.flatMap(p => subtract(p, corners(o)));
  add(prism(boundary, -.6, -.5), [.15, .17, .20]);
  for (const p of support) add(prism(p, -.5, 0), [.32, .36, .40]);
  spec.items.forEach(o => {
    const color = o.kind === 'ramp' ? [.58, .65, .72] : [.65, .55, .38];
    if (o.kind === 'box') box(o.x, o.y, o.yaw, o.sx, o.sy, o.h, color);
    if (o.kind === 'stairs') {
      const length = o.steps * o.run + 1;
      for (let k = 0; k < o.steps; k++) {
        const [x, y] = world(o, -length/2 + (k + .5) * o.run, 0);
        box(x, y, o.yaw, o.run, o.width, (k + 1) * o.rise, color);
      }
      const [x, y] = world(o, length/2 - .5, 0);
      box(x, y, o.yaw, 1, o.width, o.steps * o.rise, color);
    }
    if (o.kind === 'ramp') {
      // A wedge with a thin buried base keeps the low edge non-degenerate.
      const a = o.length/2, b = o.width/2;
      add(prism([[-a, -b], [a, -b], [a, b], [-a, b]], -.02, x => (x + a) / o.length * o.h), color, [o.x, o.y, 0], o.yaw);
    }
  });
  const res = .05, w = Math.ceil(sx/res), h = Math.ceil(sy/res), origin = [-sx/2, -sy/2, 0];
  const px = new Uint8Array(w * h);
  // Conservative cell-square coverage: don't advertise a thin/rotated obstacle
  // as free just because its centre falls between samples.
  const pad = res * Math.SQRT2/2;
  const footprints = spec.items.map(o => {
    const [length,width] = dimensions(o);
    return {x:o.x,y:o.y,c:Math.cos(o.yaw),s:Math.sin(o.yaw),hx:length/2,hy:width/2};
  });
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const x = origin[0] + (c + .5) * res, y = origin[1] + (h - r - .5) * res;
    const blocked = footprints.some(o => {
      const dx = x - o.x, dy = y - o.y;
      const u = Math.max(0, Math.abs(o.c * dx + o.s * dy) - o.hx);
      const v = Math.max(0, Math.abs(-o.s * dx + o.c * dy) - o.hy);
      return u*u + v*v <= pad*pad;
    });
    px[r*w+c] = (x + res/2 > sx/2 + 1e-9 || y + res/2 > sy/2 + 1e-9) ? 205 : blocked ? 0 : 254;
  }
  const map = {res, origin, w, h, floor_z: 0, spawn_xyyaw: spec.spawn.slice(), spawn_z: .4, px: encode(px)};
  const bounds = [-sx/2 - .3, -sy/2 - .3, sx/2 + .3, sy/2 + .3];
  // Top image is an SVG string; callers can render it via Blob/data URL without
  // a server, DOM, canvas, external assets, or interpolated user text.
  const polygons = models.map(md => {
    const mesh = meshes[md.mesh], points = [];
    const pose = {x: md.pos[0], y: md.pos[1], yaw: 2 * Math.atan2(md.quat[3], md.quat[0])};
    for (let k = mesh.p.length/2; k < mesh.p.length; k += 3) {
      const [x, y] = world(pose, mesh.p[k], mesh.p[k + 1]);
      points.push(`${x},${-y}`);
    }
    return `<polygon points="${points.join(' ')}" fill="rgb(${md.color.map(v => Math.round(v * 255)).join(',')})"/>`;
  }).join('');
  const top = {bounds, px: [Math.round((sx + .6) * 24), Math.round((sy + .6) * 24)], map: {origin, res, w, h},
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds[0]} ${bounds[1]} ${sx + .6} ${sy + .6}">${polygons}</svg>`};
  return {xml: `<mujoco model="custom-terrain"><asset>${assets.join('')}</asset><worldbody>${geoms.join('')}</worldbody></mujoco>`,
    scene: {meshes, models}, map, top};
}

export function loadCustomTerrain(storage, id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(id)) throw new Error('만든 지형 id가 없거나 올바르지 않습니다');
  let raw;
  try { raw = storage.getItem(`fh.customTerrain.${id}`); }
  catch { throw new Error('이 브라우저의 지형 저장소를 읽을 수 없습니다'); }
  if (!raw) throw new Error('이 브라우저에 저장된 지형이 없습니다');
  let spec;
  try { spec = JSON.parse(raw); }
  catch { throw new Error('저장된 지형 JSON을 읽을 수 없습니다'); }
  if (spec?.id !== id) throw new Error('저장된 지형 id가 주소와 다릅니다');
  return buildTerrain(spec);
}

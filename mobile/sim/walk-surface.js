// Navigation uses the same collision terrain as policy height observations:
// static contact geoms (including group-4 heightfields), never the robot or
// visual/lidar-only proxies. The occupancy map still owns XY/CLEARANCE checks.
export const MAX_STEP = 0.15; // existing map generator's support + 15 cm threshold
export const MIN_UP = Math.SQRT1_2; // reject slopes steeper than 45 degrees
export const CLEARANCE = 0.45; // same obstacle margin as the existing A* and web simstart

export function makeWalkSurface(mj, m, d) {
  const hit = new mj.IntBuffer(1), normal = new mj.DoubleBuffer(3);
  const group = [1, 1, 1, 1, 1, 0], down = [0, 0, -1], up = [0, 0, 1];
  const excluded = [], fields = [], columns = new Map(), planes = [];
  const key = (x, y) => `${Math.floor(x / 2)},${Math.floor(y / 2)}`;
  const bounds = [];
  let top = 1;
  for (let g = 0; g < m.ngeom; g++) {
    if (m.geom_bodyid[g] !== 0 || !(m.geom_contype[g] || m.geom_conaffinity[g])) excluded.push([g, m.geom_group[g]]);
    else {
      top = Math.max(top, d.geom_xpos[3 * g + 2] + m.geom_rbound[g] + 1);
      // Static contact geometry only. Index its world AABB once; vertical
      // support rays then call MuJoCo's exact per-geom intersection instead
      // of scanning every geom (and rewriting excluded groups) for every cell.
      const pos = Array.from(d.geom_xpos.slice(3 * g, 3 * g + 3)), R = Array.from(d.geom_xmat.slice(9 * g, 9 * g + 9));
      const a = m.geom_aabb.slice(6 * g, 6 * g + 6), lo = [], hi = [];
      for (let j = 0; j < 3; j++) {
        const mid = pos[j] + R[3 * j] * a[0] + R[3 * j + 1] * a[1] + R[3 * j + 2] * a[2];
        const half = Math.abs(R[3 * j]) * a[3] + Math.abs(R[3 * j + 1]) * a[4] + Math.abs(R[3 * j + 2]) * a[5];
        lo[j] = mid - half; hi[j] = mid + half;
      }
      const geom = { g, pos, R, size: Array.from(m.geom_size.slice(3 * g, 3 * g + 3)), type: m.geom_type[g], lo, hi };
      bounds.push(geom);
      if (geom.type === 0) planes.push(geom);
      else for (let x = Math.floor(lo[0] / 2); x <= Math.floor(hi[0] / 2); x++) for (let y = Math.floor(lo[1] / 2); y <= Math.floor(hi[1] / 2); y++) {
        const k = `${x},${y}`;
        if (!columns.has(k)) columns.set(k, []);
        columns.get(k).push(geom);
      }
      // Upright heightfields are solid terrain, never overhead ceilings.
      // Native rays beginning inside them can meet a thin support's underside
      // first, so establish the local terrain datum with per-field rays.
      if (m.geom_type[g] === 1 && d.geom_xmat[9 * g + 6] === 0 && d.geom_xmat[9 * g + 7] === 0 && d.geom_xmat[9 * g + 8] === 1) {
        const id = m.geom_dataid[g], pos = d.geom_xpos, R = d.geom_xmat;
        fields.push({ g, x: pos[3 * g], y: pos[3 * g + 1], r00: R[9 * g], r01: R[9 * g + 1], r10: R[9 * g + 3], r11: R[9 * g + 4],
          hx: m.hfield_size[4 * id], hy: m.hfield_size[4 * id + 1], top: pos[3 * g + 2] + m.hfield_size[4 * id + 2] + 1 });
      }
    }
  }
  const verticalRay = (origin, direction) => {
    let nearest = null;
    for (const geom of [...planes, ...(columns.get(key(origin[0], origin[1])) ?? [])]) {
      const { g, type, lo, hi } = geom;
      if (m.geom_group[g] === 5 || (type !== 0 && (origin[0] < lo[0] || origin[0] > hi[0] || origin[1] < lo[1] || origin[1] > hi[1]))) continue;
      // Upright boxes have just two vertical intersections. Resolve those
      // from the same compiled pose/size without crossing the WASM boundary
      // twice for every floor/ceiling query. Other shapes use native rays.
      if (type === 6 && Math.abs(geom.R[8]) === 1) {
        const dx = origin[0] - geom.pos[0], dy = origin[1] - geom.pos[1];
        if (Math.abs(geom.R[0] * dx + geom.R[3] * dy) > geom.size[0] || Math.abs(geom.R[1] * dx + geom.R[4] * dy) > geom.size[1]) continue;
        const lower = (lo[2] - origin[2]) * direction[2], upper = (hi[2] - origin[2]) * direction[2];
        const distance = Math.min(lower >= 0 ? lower : Infinity, upper >= 0 ? upper : Infinity);
        if (Number.isFinite(distance) && (!nearest || distance < nearest.distance)) nearest = { x: origin[0], y: origin[1], z: origin[2] + direction[2] * distance,
          up: distance === lower ? -1 : 1, distance, geom: g };
        continue;
      }
      const distance = type === 1 ? mj.mj_rayHfield(m, d, g, origin, direction, normal)
        : type === 7 ? mj.mj_rayMesh(m, d, g, origin, direction, normal)
          : mj.mju_rayGeom(geom.pos, geom.R, geom.size, origin, direction, type, normal);
      if (distance >= 0 && (!nearest || distance < nearest.distance)) nearest = { x: origin[0], y: origin[1], z: origin[2] + direction[2] * distance,
        up: normal.GetView()[2], distance, geom: g };
    }
    return nearest;
  };
  const raycast = (origin, direction) => {
    // Restore groups synchronously before policy/lidar can run.
    try {
      for (const [g] of excluded) m.geom_group[g] = 5;
      const distance = mj.mj_ray(m, d, origin, direction, group, true, -1, hit, normal);
      if (!(distance >= 0) || !Number.isFinite(distance)) return null;
      return { x: origin[0] + direction[0] * distance, y: origin[1] + direction[1] * distance,
        z: origin[2] + direction[2] * distance, up: normal.GetView()[2], distance, geom: hit.GetView()[0] };
    } finally { for (const [g, original] of excluded) m.geom_group[g] = original; }
  };
  const inside = (x, y, z) => {
    const suppressed = [];
    try {
      // A nearer floor ENTRY can hide another solid's EXIT (including a
      // coplanar plane at a support box's bottom). Inspect each hit geom.
      for (let k = 0; k < m.ngeom; k++) {
        const p = verticalRay([x, y, z], down);
        if (!p) return false;
        if (p.up < 0) return true;
        suppressed.push([p.geom, m.geom_group[p.geom]]); m.geom_group[p.geom] = 5;
      }
      return false;
    } finally { for (const [g, original] of suppressed) m.geom_group[g] = original; }
  };
  const fieldHeight = (x, y, floorZ) => {
    let datum = floorZ;
    for (const field of fields) {
      const dx = x - field.x, dy = y - field.y;
      if (Math.abs(field.r00 * dx + field.r10 * dy) > field.hx || Math.abs(field.r01 * dx + field.r11 * dy) > field.hy) continue;
      const distance = mj.mj_rayHfield(m, d, field.g, [x, y, field.top], down, null);
      if (distance >= 0) datum = Math.max(datum, field.top - distance);
    }
    return datum;
  };
  const diagonal = CLEARANCE / Math.SQRT2;
  const neighbors = [[CLEARANCE, 0], [-CLEARANCE, 0], [0, CLEARANCE], [0, -CLEARANCE],
    [diagonal, diagonal], [-diagonal, diagonal], [diagonal, -diagonal], [-diagonal, -diagonal]];
  const floorAt = (x, y, ceiling = Infinity, minUp = MIN_UP, floorZ = 0) => {
    // Start at the map layer's body height. An upward EXIT means the datum
    // is buried in raised solid terrain (house/steps): climb above that floor.
    // An upward ENTRY is an overhead underside (lamp/beam/ceiling): scan down
    // below it. This keeps overhead tops out of the 2.5D navigation surface.
    let datum = fieldHeight(x, y, floorZ);
    let z = datum + .4, roof = ceiling;
    for (let k = 0; z < ceiling && k < m.ngeom; k++) {
      const p = verticalRay([x, y, z], up);
      if (!p || p.z >= ceiling) break;
      if (p.up < 0) {
        // A support slab may overlap the terrain beneath it. Its underside
        // is not overhead when the ray origin just below it is still solid.
        if (!inside(x, y, p.z - .001)) {
          // At a porch edge the thin floor can overhang the heightfield.
          // Nearby terrain inside the existing clearance footprint identifies
          // that connected support, rather than treating it as a ceiling.
          const nearby = Math.max(datum, ...neighbors.map(([dx, dy]) => fieldHeight(x + dx, y + dy, floorZ)));
          if (nearby > datum + MAX_STEP && nearby + MAX_STEP >= p.z) { datum = nearby; z = datum + .4; continue; }
          roof = Math.min(roof, p.z - .001); break;
        }
      }
      z = p.z + .4;
    }
    const p = verticalRay([x, y, Math.min(top, roof)], down);
    return p && p.up >= minUp ? p.z : NaN;
  };
  const pick = (origin, direction, map, ceiling = Infinity) => {
    const suppressed = [];
    try {
      for (let k = 0; k < m.ngeom; k++) {
        const p = raycast(origin, direction);
        if (!p) return null;
        if (Math.abs(p.up) < MIN_UP) return p; // wall/steep face: explain, don't see through walls
        const floor = floorAt(p.x, p.y, ceiling, MIN_UP, map.floor_z);
        if (p.up >= MIN_UP && Number.isFinite(floor) && Math.abs(p.z - floor) <= .05) return p;
        // Ignore overhead geometry as a whole, including its far underside.
        if (p.up < 0 || (Number.isFinite(floor) && p.z > floor + .05)) {
          suppressed.push([p.geom, m.geom_group[p.geom]]); m.geom_group[p.geom] = 5;
        } else return p;
      }
      return null;
    } finally { for (const [g, original] of suppressed) m.geom_group[g] = original; }
  };
  const attach = (map, ceiling = Infinity) => {
    // Heights are lazy: don't scan a million factory cells at page startup.
    const heights = new Float64Array(map.w * map.h), known = new Uint8Array(map.w * map.h);
    map.cellHeight = (i) => {
      if (!known[i]) {
        heights[i] = floorAt(map.origin[0] + (i % map.w + .5) * map.res, map.origin[1] + (map.h - Math.floor(i / map.w) - .5) * map.res, ceiling, MIN_UP, map.floor_z);
        known[i] = 1;
      }
      return heights[i];
    };
    map.heightAt = (x, y) => {
      const c = Math.floor((x - map.origin[0]) / map.res), r = Math.floor((y - map.origin[1]) / map.res);
      if (c < 0 || r < 0 || c >= map.w || r >= map.h) return NaN;
      return map.cellHeight((map.h - 1 - r) * map.w + c);
    };
    // Prove a flat navigation layer from contact boxes and the inflated grid.
    // A floor slab must cover every traversable cell; any possible raised
    // support keeps the height-aware path. Overhead boxes cannot be floors.
    map.prepareNavigation = (grid) => {
      if (planes.length) return false; // infinite/tilted plane bounds cannot prove coverage
      const floors = bounds.filter((b) => b.type === 6 && Math.abs(b.hi[2] - map.floor_z) < 1e-6 && Math.abs(b.R[8]) === 1);
      const covers = (b, x, y) => {
        if (x < b.lo[0] || x > b.hi[0] || y < b.lo[1] || y > b.hi[1]) return false;
        if (b.type !== 6 || Math.abs(b.R[8]) !== 1) return true; // conservative for tilted boxes/meshes/heightfields
        const dx = x - b.pos[0], dy = y - b.pos[1];
        return Math.abs(b.R[0] * dx + b.R[3] * dy) <= b.size[0] && Math.abs(b.R[1] * dx + b.R[4] * dy) <= b.size[1];
      };
      if (!floors.length) return false;
      const raised = new Set(bounds.filter((b) => b.hi[2] > map.floor_z + 1e-6 && b.lo[2] < map.floor_z + .4 && b.lo[2] < ceiling));
      for (let r = 0; r < map.h; r++) for (let c = 0; c < map.w; c++) {
        if (grid[r * map.w + c]) continue;
        const x = map.origin[0] + (c + .5) * map.res, y = map.origin[1] + (map.h - r - .5) * map.res;
        if (!floors.some((b) => covers(b, x, y)) || [...planes, ...(columns.get(key(x, y)) ?? [])].some((b) => raised.has(b) && covers(b, x, y))) return false;
      }
      return true;
    };
  };
  return { raycast, pick, floorAt, attach, dispose: () => { hit.delete(); normal.delete(); } };
}

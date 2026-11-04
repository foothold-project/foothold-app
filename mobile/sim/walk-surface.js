// Navigation uses the same collision terrain as policy height observations:
// static contact geoms (including group-4 heightfields), never the robot or
// visual/lidar-only proxies. The occupancy map still owns XY/CLEARANCE checks.
export const MAX_STEP = 0.15; // existing map generator's support + 15 cm threshold
export const MIN_UP = Math.SQRT1_2; // reject slopes steeper than 45 degrees
export const CLEARANCE = 0.45; // same obstacle margin as the existing A* and web simstart

export function makeWalkSurface(mj, m, d) {
  const hit = new mj.IntBuffer(1), normal = new mj.DoubleBuffer(3);
  const group = [1, 1, 1, 1, 1, 0], down = [0, 0, -1], up = [0, 0, 1];
  const excluded = [], fields = [];
  let top = 1;
  for (let g = 0; g < m.ngeom; g++) {
    if (m.geom_bodyid[g] !== 0 || !(m.geom_contype[g] || m.geom_conaffinity[g])) excluded.push([g, m.geom_group[g]]);
    else {
      top = Math.max(top, d.geom_xpos[3 * g + 2] + m.geom_rbound[g] + 1);
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
        const p = raycast([x, y, z], down);
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
      const p = raycast([x, y, z], up);
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
    const p = raycast([x, y, Math.min(top, roof)], down);
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
    const heights = new Map();
    map.heightAt = (x, y) => {
      const c = Math.floor((x - map.origin[0]) / map.res), r = Math.floor((y - map.origin[1]) / map.res);
      if (c < 0 || r < 0 || c >= map.w || r >= map.h) return NaN;
      const i = r * map.w + c;
      if (!heights.has(i)) heights.set(i, floorAt(map.origin[0] + (c + .5) * map.res, map.origin[1] + (r + .5) * map.res, ceiling, MIN_UP, map.floor_z));
      return heights.get(i);
    };
  };
  return { raycast, pick, floorAt, attach, dispose: () => { hit.delete(); normal.delete(); } };
}

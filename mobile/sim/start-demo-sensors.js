import { AME2_OVERHEAD_CLEARANCE } from './ame2-adapter.js';
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// RayCaster ordering='yx': y varies fastest; ONNX shape [32,16].
export const startDemoGrid = Array.from({ length: 512 }, (_, i) => [-.475 + .05*Math.floor(i/16), -.375 + .05*(i%16)]);
// Conservative world AABB vs the ray cutoff sphere, exactly as before for every
// geometry it is asked about. Returns true when the geometry cannot be hit.
function outsideCutoff(g, pos, mat, aabb, origin, cutoff, planes) {
  const a = 6*g, r = 9*g, center = [], extent = []; let distance2 = 0;
  for (let axis = 0; axis < 3; axis++) {
    const t = r+axis*3;
    center[axis] = pos[3*g+axis]+mat[t]*aabb[a]+mat[t+1]*aabb[a+1]+mat[t+2]*aabb[a+2]-origin[axis];
    extent[axis] = Math.abs(mat[t])*aabb[a+3]+Math.abs(mat[t+1])*aabb[a+4]+Math.abs(mat[t+2])*aabb[a+5];
    const delta = Math.max(0,Math.abs(center[axis])-extent[axis]-1e-9);
    distance2 += delta*delta;
  }
  // AABB wholly outside a camera half-space cannot meet any of its rays.
  return distance2 > cutoff*cutoff || planes.some((p) => p.reduce((sum,x,i) => sum+x*center[i]-Math.abs(x)*extent[i],0) > 1e-9);
}
// Ray (origin o, direction v) against an axis-aligned box padded outward:
// the entry parameter, a lower bound for any hit on the geometry inside it,
// or -1 when the ray cannot meet the box.
function entry(box, o, v) {
  let lo = 0, hi = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    if (v[axis] === 0) { if (o[axis] < box[axis] || o[axis] > box[3+axis]) return -1; continue; }
    let a = (box[axis]-o[axis])/v[axis], b = (box[3+axis]-o[axis])/v[axis];
    if (a > b) [a, b] = [b, a];
    if (a > lo) lo = a;
    if (b < hi) hi = b;
    if (lo > hi) return -1;
  }
  return lo;
}
// MuJoCo's ray_box / ray_plane for a geometry whose frame is exactly the
// world frame (xmat identity): the same double operations in the same order
// (local point = pnt - pos, local ray = vec, mjMINVAL 1e-15), so the distance
// is bit-identical to mju_rayGeom (checked by scripts/start-demo-sensor-parity-selftest.mjs).
// Each native call costs microseconds of binding overhead; most depth rays
// end on the ground box or plane.
const MINVAL = 1e-15;
export function rayBoxAligned(pos, size, p, v) {
  const l0 = p[0]-pos[0], l1 = p[1]-pos[1], l2 = p[2]-pos[2], lp = [l0, l1, l2];
  let sol = -1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(v[i]) <= MINVAL) continue;
    for (let side = -1; side <= 1; side += 2) {
      const x = (side*size[i]-lp[i])/v[i];
      if (x < 0) continue;
      const j = (i+1)%3, k = (i+2)%3;
      if (Math.abs(lp[j]+x*v[j]) <= size[j] && Math.abs(lp[k]+x*v[k]) <= size[k] && (sol < 0 || x < sol)) sol = x;
    }
  }
  return sol;
}
export function rayPlaneAligned(pos, size, p, v) {
  if (v[2] > -MINVAL) return -1;
  const x = -(p[2]-pos[2])/v[2];
  if (x < 0) return -1;
  const px = p[0]-pos[0]+x*v[0], py = p[1]-pos[1]+x*v[1];
  return (size[0] <= 0 || Math.abs(px) <= size[0]) && (size[1] <= 0 || Math.abs(py) <= size[1]) ? x : -1;
}
const IDENTITY = [1,0,0,0,1,0,0,0,1];
// Static world geometry (body 0) never moves, so its world AABB is filed once
// in a 2D grid of CELL m. A query returns every geometry whose AABB may lie
// within the cutoff (cells padded by one); all others are farther than the
// cutoff along x or y and the per-geometry test above would skip them anyway.
const CELL = 4;
function staticIndex(m, d) {
  const body = m.geom_bodyid, contype = m.geom_contype, affinity = m.geom_conaffinity, types = m.geom_type;
  const pos = d.geom_xpos, mat = d.geom_xmat, aabb = m.geom_aabb;
  const groups = m.geom_group, rgba = m.geom_rgba, size = m.geom_size;
  const always = [], cells = new Map(), geoms = new Map();
  for (let g = 0; g < m.ngeom; g++) {
    if (body[g] !== 0 || (!contype[g] && !affinity[g])) continue;
    // What mj_multiRay itself would consider (ray_eliminate): depth groups 0, 1, 4 and visible.
    const group = groups[g];
    const rayable = (group === 0 || group === 1 || group === 4) && rgba[4*g+3] !== 0;
    const box = new Float64Array(6); // world AABB min xyz, max xyz (conservative ray test)
    for (let axis = 0; axis < 3; axis++) {
      const t = 9*g+axis*3, a = 6*g;
      const c = pos[3*g+axis]+mat[t]*aabb[a]+mat[t+1]*aabb[a+1]+mat[t+2]*aabb[a+2];
      const e = Math.abs(mat[t])*aabb[a+3]+Math.abs(mat[t+1])*aabb[a+4]+Math.abs(mat[t+2])*aabb[a+5];
      box[axis] = c-e-1e-6; box[3+axis] = c+e+1e-6;
    }
    geoms.set(g, { g, type: types[g], rayable, box, pos: Float64Array.from(pos.subarray(3*g,3*g+3)),
      mat: Float64Array.from(mat.subarray(9*g,9*g+9)), size: Float64Array.from(size.subarray(3*g,3*g+3)) });
    const geom = geoms.get(g);
    geom.aligned = (geom.type === 6 || geom.type === 0) && IDENTITY.every((x, i) => Object.is(geom.mat[i], x));
    // Infinite planes and heightfields stay eligible (as in the scan below).
    if (types[g] === 0 || types[g] === 1) { always.push(g); continue; }
    const lo = [Math.floor(box[0]/CELL), Math.floor(box[1]/CELL)], hi = [Math.floor(box[3]/CELL), Math.floor(box[4]/CELL)];
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) {
      const key = `${i},${j}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(g);
    }
  }
  const seen = new Uint32Array(m.ngeom); let stamp = 0;
  const near = (origin, cutoff) => {
    if (++stamp === 0xffffffff) { seen.fill(0); stamp = 1; }
    const found = [];
    const i0 = Math.floor((origin[0]-cutoff)/CELL)-1, i1 = Math.floor((origin[0]+cutoff)/CELL)+1;
    const j0 = Math.floor((origin[1]-cutoff)/CELL)-1, j1 = Math.floor((origin[1]+cutoff)/CELL)+1;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = cells.get(`${i},${j}`);
      if (list) for (const g of list) if (seen[g] !== stamp) { seen[g] = stamp; found.push(g); }
    }
    return found;
  };
  return { always, near, geoms };
}
function terrainOnly(m, d, run, origin = null, cutoff = Infinity, planes = []) {
  // Each embind property access creates a WASM view. Acquire once per scan,
  // rather than three fresh model views for every geometry.
  const groups = m.geom_group, body = m.geom_bodyid, contype = m.geom_contype, affinity = m.geom_conaffinity, types = m.geom_type, excluded = [];
  const pos = origin ? d.geom_xpos : null, mat = origin ? d.geom_xmat : null, aabb = origin ? m.geom_aabb : null;
  for (let g = 0; g < m.ngeom; g++) {
    let skip = body[g] !== 0 || (!contype[g] && !affinity[g]);
    // Infinite planes and heightfields stay eligible (MuJoCo's heightfield
    // bounds use a different convention). Surviving rays use exact native
    // intersections.
    if (!skip && origin && aabb && types[g] !== 0 && types[g] !== 1) skip = outsideCutoff(g, pos, mat, aabb, origin, cutoff, planes);
    if (skip && groups[g] !== 5) { excluded.push([g,groups[g]]); groups[g] = 5; }
  }
  try { return run(); } finally { for (const [g, group] of excluded) groups[g] = group; }
}
export function makeStartDemoMap(mj, m, d, makeTerrainSampler, { fastVertical = true } = {}) {
  const cfg = { grid: startDemoGrid, rayOffset: 20, fastVertical, overheadClearance: AME2_OVERHEAD_CLEARANCE }, sample = makeTerrainSampler(mj,m,d,cfg);
  const heights = new Float64Array(512);
  const scan = (q, out = new Float32Array(512)) => {
    const t = performance.now();
    sample(q,heights);
    for (let i = 0; i < 512; i++) out[i] = Number.isFinite(heights[i]) ? clamp(heights[i]-q[2],-1,1) : -1;
    scan.ms = performance.now()-t;
    return out;
  };
  scan.dispose = sample.dispose;
  return scan;
}
// Depth sensor range (m): rays and the geometry cull share it.
export const START_DEPTH_RANGE = 4;
// Above this many native (non-JS) geometries in range, a scan uses mj_multiRay.
// Measured (40 random poses per scene): even one native geometry asked per ray
// from JS is slower than one mj_multiRay (plant-a 9.1 vs 2.2 ms, warehouse with
// 1~7: 10.5 vs 5.2 ms, collapsed-house 161~168: 1686 vs 112 ms), so the JS path
// is used only when every geometry in range is a world-aligned box or plane.
export const NATIVE_MAX = 0;
export function makeStartDemoDepth(mj,m,d,{ cull = true, index: useIndex = true } = {}) {
  const n = 3600, vec = new Float64Array(n*3), local = new Float64Array(n*3), axial = new Float64Array(n);
  const dist = new mj.DoubleBuffer(n), gid = new mj.IntBuffer(n), out = new Float32Array(n);
  const angle = 35*Math.PI/180, c = Math.cos(angle), s = Math.sin(angle);
  for (let v = 0; v < 60; v++) for (let u = 0; u < 60; u++) {
    const i = v*60+u, y = -(u-30)/55.9, z = -(v-30)/54.1, len = Math.hypot(1,y,z);
    // Optical forward is body +x, image right is body -y, image down is -z.
    local.set([(c+s*z)/len,y/len,(-s+c*z)/len],i*3); axial[i] = 1/len;
  }
  let index = null; // filed on the first scan, after the model's static poses exist
  const direct = new Float64Array(n);
  const scan = (q) => {
    const t = performance.now(), [qw,qx,qy,qz] = q.slice(3,7);
    if (cull && useIndex && !index) index = staticIndex(m, d);
    const R = [1-2*(qy*qy+qz*qz),2*(qx*qy-qw*qz),2*(qx*qz+qw*qy),2*(qx*qy+qw*qz),1-2*(qx*qx+qz*qz),2*(qy*qz-qw*qx),2*(qx*qz-qw*qy),2*(qy*qz+qw*qx),1-2*(qx*qx+qy*qy)];
    const origin = [q[0]+R[0]*.25+R[2]*.12,q[1]+R[3]*.25+R[5]*.12,q[2]+R[6]*.25+R[8]*.12];
    const forward = [R[0]*c-R[2]*s,R[3]*c-R[5]*s,R[6]*c-R[8]*s];
    const right = [-R[1],-R[4],-R[7]], down = [-R[0]*s-R[2]*c,-R[3]*s-R[5]*c,-R[6]*s-R[8]*c];
    const planes = [forward.map((x)=>-x)];
    for (const [axis,extent] of [[right,30/55.9],[down,30/54.1]]) for (const sign of [-1,1]) planes.push(axis.map((x,i)=>sign*x-extent*forward[i]));
    for (let i = 0; i < n*3; i+=3) {
      const x=local[i],y=local[i+1],z=local[i+2];
      vec[i]=R[0]*x+R[1]*y+R[2]*z;vec[i+1]=R[3]*x+R[4]*y+R[5]*z;vec[i+2]=R[6]*x+R[7]*y+R[8]*z;
    }
    let distances, near = null;
    if (index) {
      const pos = d.geom_xpos, mat = d.geom_xmat, aabb = m.geom_aabb;
      near = [];
      for (const g of index.always) if (index.geoms.get(g).rayable) near.push(index.geoms.get(g));
      for (const g of index.near(origin, START_DEPTH_RANGE)) {
        const geom = index.geoms.get(g);
        if (geom.rayable && !outsideCutoff(g, pos, mat, aabb, origin, START_DEPTH_RANGE, planes)) near.push(geom);
      }
      // Each native call from JS costs a few microseconds per ray. With meshes,
      // heightfields or turned boxes in range, one mj_multiRay over the culled
      // model is cheaper (same result bit for bit, see parity selftest).
      if (near.filter((geom) => !geom.aligned).length > NATIVE_MAX) near = null;
    }
    if (near) {
      // mj_multiRay walks every model geometry for every ray. Ask the same
      // per-geometry intersections only for the static geometries the cull
      // keeps, and per ray only where its AABB can meet the ray.
      distances = direct;
      const ray = new Float64Array(3), order = [];
      for (let i = 0; i < n; i++) {
        ray[0] = vec[3*i]; ray[1] = vec[3*i+1]; ray[2] = vec[3*i+2];
        // Nearest first by a lower bound; stop once no later geometry can be
        // nearer than the best exact native hit. Planes and heightfields have
        // no box here: they are always asked (bound 0).
        order.length = 0;
        for (const geom of near) {
          const t = geom.type === 0 || geom.type === 1 ? 0 : entry(geom.box, origin, ray);
          if (t >= 0) order.push([t, geom]);
        }
        order.sort((x, y) => x[0]-y[0]);
        let best = -1;
        for (const [t, geom] of order) {
          if (best >= 0 && t > best) break;
          const x = geom.aligned ? (geom.type === 6 ? rayBoxAligned : rayPlaneAligned)(geom.pos, geom.size, origin, ray)
            : geom.type === 7 ? mj.mj_rayMesh(m, d, geom.g, origin, ray, null)
            : geom.type === 1 ? mj.mj_rayHfield(m, d, geom.g, origin, ray, null)
              : mj.mju_rayGeom(geom.pos, geom.mat, geom.size, origin, ray, geom.type, null);
          if (x >= 0 && (best < 0 || x < best)) best = x;
        }
        direct[i] = best;
      }
    } else {
      terrainOnly(m,d,() => mj.mj_multiRay(m,d,origin,vec,[1,1,0,0,1,0],true,-1,gid,dist,null,n,START_DEPTH_RANGE),cull?origin:null,START_DEPTH_RANGE,planes);
      distances = dist.GetView();
    }
    for (let i = 0; i < n; i++) {
      // MuJoCo returns ray length; training uses distance to the image plane.
      const depth = distances[i]*axial[i];
      out[i] = Number.isFinite(depth) && distances[i] >= 0 ? clamp((depth-.2)/2.8,0,1) : 1;
    }
    scan.ms = performance.now()-t;
    return out;
  };
  scan.dispose = () => { dist.delete(); gid.delete(); };
  return scan;
}

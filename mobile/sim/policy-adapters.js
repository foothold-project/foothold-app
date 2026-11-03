// Policy observation/network contracts and low-level terrain sampling.
// Selection is owned by policy-modes.js; the factory avoids eager cyclic reads.
import { makeAme2Adapter } from './ame2-adapter.js';
import { MODE_COMMAND_CAPS } from './manual-settings.js';
export { getPolicyMode as getPolicyAdapter, POLICY_ADAPTERS } from './policy-modes.js';

export function createPolicyModeAdapters() {
  const legs = ['FL', 'FR', 'RL', 'RR'], parts = ['hip', 'thigh', 'calf'];
  const isaacJoints = parts.flatMap((p) => legs.map((l) => `${l}_${p}_joint`));
  const defaultPose = Float64Array.from(isaacJoints, (n) =>
    n.includes('_hip') ? (n[1] === 'L' ? 0.1 : -0.1) : n.includes('_thigh') ? (n[0] === 'F' ? 0.8 : 1.0) : -1.5);
  const clip = (v) => Math.min(Math.max(v, -1), 1);
  // Isaac Lab grid_pattern(ordering='xy'): meshgrid(x,y,indexing='xy').flatten(), x fastest.
  const grid = Array.from({ length: 187 }, (_, i) => [(i % 17 - 8) * 0.1, (Math.floor(i / 17) - 5) * 0.1]);

  const nvidiaDemoMode = {
    id: 'nvidia-demo', label: 'nvidia-demo',
    onnx: { file: 'policy_v2.onnx', sha256: 'c9f3c5c00c6b3b3a41daf96b5de46f18673af23718ffbf8ecd84c77969bf27e2',
      inputs: [{ name: 'observation', dims: [1, 235] }],
      outputs: [{ name: 'action', dims: [1, 12] }], action: 'action' },
    observations: { size: 235, bodySize: 48, order: ['linear_velocity', 'angular_velocity', 'gravity', 'command', 'joint_position_relative', 'joint_velocity', 'last_action', 'height_scan'],
      dimensions: [3, 3, 3, 3, 12, 12, 12, 187], scale: 1, bodyClip: null,
      units: ['m/s', 'rad/s', 'unit_vector', 'm/s,m/s,rad/s', 'rad', 'rad/s', 'action', 'm'],
      // Training scans only ground from +20 m. Here world geometry includes ceilings:
      // clip(base_z - hit_z - 0.5, +/-1) reaches -1 at base_z + 0.5;
      // start 1 mm above that boundary to avoid rounding away boundary hits.
      height: { grid, ordering: 'xy', resolution: 0.1, size: [1.6, 1.0], rayOffset: 0.501, offset: 0.5, missValue: 1, clip: [-1, 1], noise: 0 } },
    network: { file: 'policy_v2.f32', sha256: 'da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c',
      format: 'float32 LE, row-major weight then bias per layer', shapes: [[512, 235], [256, 512], [128, 256], [12, 128]], activation: 'ELU(1), linear output' },
    action: { size: 12, joints: isaacJoints, defaultPose, scale: 0.25, kp: 25, kd: 0.5, effort: 23.5, velocityLimit: 30 },
    timing: { physicsDt: 0.005, decimation: 4, policyDt: 0.02 },
    command: { kind: 'body_velocity', caps: MODE_COMMAND_CAPS.nvidia, axes: ['vx', 'vy', 'wz'], trainingRanges: [[0.4, 1.5], [0, 0], [-1, 1]],
      joystickScale: [1.5, 0.5, 1], inRange: (c) => (c[0] === 0 || (c[0] >= 0.4 && c[0] <= 1.5)) && c[1] === 0 && Math.abs(c[2]) <= 1 },
    stop: { input: [0, 0, 0], commandZero: 'continue policy with zero velocity input', lock: 'existing UI STOP latch; human resume required' },
    loadPolicy(buf) {
      const f = new Float32Array(buf), layers = [];
      let o = 0;
      for (const [r, c] of this.network.shapes) { layers.push([f.subarray(o, o + r * c), f.subarray(o + r * c, o + r * c + r), r, c]); o += r * c + r; }
      if (o !== f.length) throw new Error(`가중치 길이 ${f.length} ≠ ${o}`);
      const outputs = this.network.shapes.map(([r]) => new Float32Array(r));
      return (x) => {
        let h = x;
        layers.forEach(([w, b, r, c], k) => {
          const y = outputs[k];
          for (let i = 0; i < r; i++) {
            let s = b[i];
            for (let j = 0; j < c; j++) s += w[i * c + j] * h[j];
            y[i] = k < layers.length - 1 ? (s > 0 ? s : Math.expm1(s)) : s;
          }
          h = y;
        });
        return h;
      };
    },
    observeInto(obs, s, last, sampleHeight) {
      const { qpos: q, qvel: v } = s.d;
      obs.set(s.linB, 0); obs.set(s.angB, 3); obs.set(s.grav, 6); obs.set(s.cmd, 9);
      for (let i = 0; i < this.action.size; i++) { const j = s.M2I[i]; obs[12 + i] = q[7 + j] - defaultPose[i]; obs[24 + i] = v[6 + j]; }
      obs.set(last, 36);
      this.map(s, obs, sampleHeight);
    },
    makeHeightScanner(mj, m, d) {
      const cfg = this.observations.height, sample = makeTerrainSampler(mj, m, d, cfg);
      const heights = new Float64Array(cfg.grid.length);
      const scan = (q, out, offset = 0) => {
        sample(q, heights);
        for (let i = 0; i < heights.length; i++) {
          const height = q[2] - heights[i] - cfg.offset;
          out[offset + i] = Number.isFinite(height) ? clip(height) : cfg.missValue;
        }
        return out;
      };
      scan.dispose = sample.dispose;
      return scan;
    },
    map(s, obs = s.observation, sampleHeight = s.heightScanner) {
      sampleHeight(s.d.qpos, obs, this.observations.bodySize);
      return obs.subarray(this.observations.bodySize);
    },
  };
  const ame2DemoMode = makeAme2Adapter(makeTerrainSampler);
  ame2DemoMode.onnx = {
    file: 'ame2-demo.onnx', sha256: '830595df1e78072c0606b5193d1ba787720ff6777edc7cabe496b8c1a9d25de6',
    inputs: [{ name: 'prop', dims: [1, 49], type: 'float32' }, { name: 'mapping', dims: [1, 29, 13, 3], type: 'float32' }],
    outputs: [{ name: 'action', dims: [1, 12], type: 'float32' }, { name: 'gaze_r', dims: [1, 2], type: 'float32' }],
    action: 'action', state: [],
  };
  return { nvidia: nvidiaDemoMode, ame2: ame2DemoMode };
}

export function makeTerrainSampler(mj, m, d, cfg) {
  const hit = new mj.IntBuffer(1), group = [1, 1, 0, 0, 1, 0], down = [0, 0, -1];
  const normal = cfg.overheadClearance === undefined ? null : new mj.DoubleBuffer(3), up = [0, 0, 1];
  const point = new Float64Array(3), xy = Float64Array.from(cfg.grid.flat());
  const origins = new Float64Array(xy.length), distances = new Float64Array(cfg.grid.length);
  const starts = new Float64Array(cfg.grid.length), passes = normal ? [true, false] : [false];
  // World collision geometry only, including group-4 heightfields. Do not read
  // robot meshes or conservative lidar-only boxes (both contact masks zero).
  const excluded = [];
  const body = m.geom_bodyid, contype = m.geom_contype, affinity = m.geom_conaffinity, groups = m.geom_group;
  for (let g = 0; g < m.ngeom; g++) {
    if (body[g] !== 0 || (!contype[g] && !affinity[g])) excluded.push([g, groups[g]]);
  }
  // mj_multiRay has a common origin, whereas these vertical rays have distinct
  // origins. Batch the broad phase in JS, then use the SAME native per-geom
  // intersections as mj_ray. Unknown types/bindings retain the scalar path.
  const types = m.geom_type;
  const batched = typeof mj.mj_rayMesh === 'function' && typeof mj.mj_rayHfield === 'function' && typeof mj.mju_rayGeom === 'function'
    && types && types.every((type, g) => body[g] !== 0 || type >= 0 && type <= 7);
  const terrain = batched ? Array.from({ length: m.ngeom }, (_, g) => g)
    .filter((g) => body[g] === 0 && (contype[g] || affinity[g]))
    .map((g) => ({ g, pos: new Float64Array(3), mat: new Float64Array(9), size: new Float64Array(3) })) : [];
  const scan = (q, out) => {
    const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] ** 2 + q[6] ** 2));
    const c = Math.cos(yaw), s = Math.sin(yaw), z = q[2] + cfg.rayOffset;
    if (batched) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < xy.length / 2; i++) {
        const x = xy[2 * i], y = xy[2 * i + 1];
        const wx = q[0] + c * x - s * y, wy = q[1] + s * x + c * y;
        origins[2 * i] = wx; origins[2 * i + 1] = wy;
        minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
        minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
      }
      // Views are acquired afresh on each scan (wasm memory may grow).
      const pos = d.geom_xpos, mat = d.geom_xmat, size = m.geom_size, radius = m.geom_rbound, types = m.geom_type, aabb = m.geom_aabb;
      const groups = m.geom_group, rgba = m.geom_rgba, material = m.geom_matid, matRgba = m.mat_rgba;
      starts.fill(z);
      // The optional upward pass uses the same native intersections and XY
      // broad phase as the downward scan, avoiding a full-world ray per cell.
      for (const upward of passes) {
        distances.fill(Infinity); point[2] = upward ? q[2] : z;
        for (const geom of terrain) {
          const g = geom.g, type = types[g], r = radius[g] + 1e-9;
          if (!group[Math.max(0, Math.min(5, groups[g]))] || (material[g] < 0 ? rgba[4 * g + 3] : matRgba[4 * material[g] + 3]) === 0) continue;
          if (upward && type === 0 && mat[9 * g + 8] >= 0) continue;
          // An upright heightfield is a solid below a single-valued surface:
          // above its flat base, upward rays can only exit terrain, never hit
          // an overhead underside. Elevation edits do not change that base.
          if (upward && type === 1 && mat[9 * g + 6] === 0 && mat[9 * g + 7] === 0 && mat[9 * g + 8] === 1
            && pos[3 * g + 2] - m.hfield_size[4 * m.geom_dataid[g] + 3] <= q[2] + cfg.overheadClearance) continue;
          let gx = pos[3 * g], gy = pos[3 * g + 1], rx = r, ry = r, bottom = -Infinity, top = Infinity;
          // Transform the local bounding box once for the entire grid. Long,
          // thin shelves have very loose bounding spheres. Heightfields retain
          // the conservative radius (their elevation samples can be updated).
          if (type !== 0 && type !== 1 && aabb) {
            const a = 6 * g, t = 9 * g, ax = aabb[a], ay = aabb[a + 1], az = aabb[a + 2];
            gx += mat[t] * ax + mat[t + 1] * ay + mat[t + 2] * az;
            gy += mat[t + 3] * ax + mat[t + 4] * ay + mat[t + 5] * az;
            rx = Math.abs(mat[t]) * aabb[a + 3] + Math.abs(mat[t + 1]) * aabb[a + 4] + Math.abs(mat[t + 2]) * aabb[a + 5] + 1e-9;
            ry = Math.abs(mat[t + 3]) * aabb[a + 3] + Math.abs(mat[t + 4]) * aabb[a + 4] + Math.abs(mat[t + 5]) * aabb[a + 5] + 1e-9;
            const gz = pos[3 * g + 2] + mat[t + 6] * ax + mat[t + 7] * ay + mat[t + 8] * az;
            const rz = Math.abs(mat[t + 6]) * aabb[a + 3] + Math.abs(mat[t + 7]) * aabb[a + 4] + Math.abs(mat[t + 8]) * aabb[a + 5] + 1e-9;
            bottom = gz - rz; top = gz + rz;
          }
          // Bounds only reject; all accepted rays use native geometry.
          // Planes can be infinite, so they always reach the native intersection.
          if (type !== 0 && (gx + rx < minX || gx - rx > maxX || gy + ry < minY || gy - ry > maxY || bottom > z || (upward && top <= q[2] + cfg.overheadClearance))) continue;
          if ((type > 1 && type < 7) || type === 0) {
            geom.pos.set(pos.subarray(3 * g, 3 * g + 3)); geom.mat.set(mat.subarray(9 * g, 9 * g + 9)); geom.size.set(size.subarray(3 * g, 3 * g + 3));
          }
          // A horizontal box underside has the same intersection height at all
          // interior cells. Confirm it with one native upward ray, then reuse
          // that hit only inside this box; edges still use the native ray.
          const flatBox = upward && type === 6 && mat[9 * g + 6] === 0 && mat[9 * g + 7] === 0;
          if (flatBox && bottom <= q[2] + cfg.overheadClearance) continue;
          let flatDistance;
          for (let i = 0; i < distances.length; i++) {
            point[0] = origins[2 * i]; point[1] = origins[2 * i + 1];
            point[2] = upward ? q[2] : starts[i];
            if (type !== 0 && (Math.abs(point[0] - gx) > rx || Math.abs(point[1] - gy) > ry || (upward ? bottom - point[2] > distances[i] : bottom > point[2] || point[2] - top > distances[i]))) continue;
            const direction = upward ? up : down, surfaceNormal = upward ? normal : null;
            let cached = false;
            if (flatBox) {
              const dx = point[0] - geom.pos[0], dy = point[1] - geom.pos[1];
              const lx = Math.abs(geom.mat[0] * dx + geom.mat[3] * dy), ly = Math.abs(geom.mat[1] * dx + geom.mat[4] * dy);
              if (lx > geom.size[0] + 1e-10 || ly > geom.size[1] + 1e-10) continue;
              cached = flatDistance !== undefined && lx < geom.size[0] - 1e-10 && ly < geom.size[1] - 1e-10;
            }
            let distance = cached ? flatDistance : type === 7 ? mj.mj_rayMesh(m, d, g, point, direction, surfaceNormal)
              : type === 1 ? mj.mj_rayHfield(m, d, g, point, direction, surfaceNormal)
                : mj.mju_rayGeom(geom.pos, geom.mat, geom.size, point, direction, type, surfaceNormal);
            // A mesh can contain several disconnected plates. Continue past a
            // low tread or an upward-facing exit to find its higher underside.
            if (upward && type === 7) {
              for (let crossings = 0; crossings <= m.ngeom && distance >= 0 && point[2] + distance <= z; crossings++) {
                if (point[2] + distance > q[2] + cfg.overheadClearance && normal.GetView()[2] < 0) break;
                point[2] += distance + .001;
                distance = mj.mj_rayMesh(m, d, g, point, up, normal);
              }
              if (distance >= 0) distance += point[2] - q[2];
            }
            // An exit from a solid wall is upward-facing and remains terrain.
            // Low underside hits are stair plates, not overhead covers.
            if (upward && (distance <= cfg.overheadClearance || distance > cfg.rayOffset || (!cached && normal.GetView()[2] >= 0))) continue;
            if (flatBox) flatDistance = distance;
            if (distance >= 0 && distance < distances[i]) distances[i] = distance;
          }
        }
        if (upward) for (let i = 0; i < starts.length; i++) starts[i] = Number.isFinite(distances[i]) ? q[2] + distances[i] - .001 : z;
      }
      for (let i = 0; i < distances.length; i++) out[i] = Number.isFinite(distances[i]) ? starts[i] - distances[i] : NaN;
      return out;
    }
    // Restore groups before any lidar/physics call; this scan is synchronous.
    // Acquire one wasm view per scan, not one embind getter per excluded geom.
    // Reacquire after possible wasm memory growth rather than retaining a view.
    const groups = m.geom_group;
    for (const [g] of excluded) groups[g] = 5;
    try {
      // mj_multiRay accepts ONE shared origin. This grid has distinct origins;
      // keep exact vertical rays, batching setup and reusing their input buffer.
      for (let i = 0; i < xy.length / 2; i++) {
        const x = xy[2 * i], y = xy[2 * i + 1];
        point[0] = q[0] + c * x - s * y; point[1] = q[1] + s * x + c * y;
        let start = z;
        if (normal) {
          point[2] = q[2];
          for (let crossings = 0; crossings <= m.ngeom && point[2] < z; crossings++) {
            const distance = mj.mj_ray(m, d, point, up, group, true, -1, hit, normal);
            const underside = point[2] + distance;
            if (!Number.isFinite(distance) || distance < 0 || underside > z) break;
            if (normal.GetView()[2] < 0 && underside > q[2] + cfg.overheadClearance) { start = underside - .001; break; }
            point[2] = underside + .001;
          }
        }
        point[2] = start;
        const distance = mj.mj_ray(m, d, point, down, group, true, -1, hit, null);
        out[i] = distance >= 0 && Number.isFinite(distance) ? start - distance : NaN;
      }
    } finally { for (const [g, original] of excluded) groups[g] = original; }
    return out;
  };
  scan.dispose = () => { hit.delete(); normal?.delete(); };
  return scan;
}

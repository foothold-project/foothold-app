// Policy contract: observations, network, action conversion, timing and neutral input.
// START remains undefined; AME-2 is an opt-in simulation demonstration.
import { makeAme2Adapter } from './ame2-adapter.js';
const legs = ['FL', 'FR', 'RL', 'RR'], parts = ['hip', 'thigh', 'calf'];
const isaacJoints = parts.flatMap((p) => legs.map((l) => `${l}_${p}_joint`));
const defaultPose = Float64Array.from(isaacJoints, (n) =>
  n.includes('_hip') ? (n[1] === 'L' ? 0.1 : -0.1) : n.includes('_thigh') ? (n[0] === 'F' ? 0.8 : 1.0) : -1.5);
const clip = (v) => Math.min(Math.max(v, -1), 1);
// Isaac Lab grid_pattern(ordering='xy'): meshgrid(x,y,indexing='xy').flatten(), x fastest.
const grid = Array.from({ length: 187 }, (_, i) => [(i % 17 - 8) * 0.1, (Math.floor(i / 17) - 5) * 0.1]);

const footholdV2 = {
  id: 'foothold-v2',
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
  command: { kind: 'body_velocity', axes: ['vx', 'vy', 'wz'], trainingRanges: [[0.4, 1.5], [0, 0], [-1, 1]],
    joystickScale: [1, 0.5, 1], inRange: (c) => (c[0] === 0 || (c[0] >= 0.4 && c[0] <= 1.5)) && c[1] === 0 && Math.abs(c[2]) <= 1 },
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
  observe(obs, s, last, sampleHeight) {
    const { qpos: q, qvel: v } = s.d;
    obs.set(s.linB, 0); obs.set(s.angB, 3); obs.set(s.grav, 6); obs.set(s.cmd, 9);
    for (let i = 0; i < this.action.size; i++) { const j = s.M2I[i]; obs[12 + i] = q[7 + j] - defaultPose[i]; obs[24 + i] = v[6 + j]; }
    obs.set(last, 36);
    sampleHeight(q, obs, this.observations.bodySize);
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
};

export function makeTerrainSampler(mj, m, d, cfg) {
  const hit = new mj.IntBuffer(1), group = [1, 1, 0, 0, 1, 0], down = [0, 0, -1];
  // World collision geometry only, including group-4 heightfields. Do not read
  // robot meshes or conservative lidar-only boxes (both contact masks zero).
  const excluded = [];
  for (let g = 0; g < m.ngeom; g++) {
    if (m.geom_bodyid[g] !== 0 || (!m.geom_contype[g] && !m.geom_conaffinity[g])) excluded.push([g, m.geom_group[g]]);
  }
  const scan = (q, out) => {
    const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] ** 2 + q[6] ** 2));
    const c = Math.cos(yaw), s = Math.sin(yaw), z = q[2] + cfg.rayOffset;
    // Restore groups before any lidar/physics call; this scan is synchronous.
    for (const [g] of excluded) m.geom_group[g] = 5;
    try {
      for (let i = 0; i < cfg.grid.length; i++) {
        const [x, y] = cfg.grid[i];
        const distance = mj.mj_ray(m, d, [q[0] + c * x - s * y, q[1] + s * x + c * y, z], down, group, true, -1, hit, null);
        out[i] = distance >= 0 && Number.isFinite(distance) ? z - distance : NaN;
      }
    } finally { for (const [g, original] of excluded) m.geom_group[g] = original; }
    return out;
  };
  scan.dispose = () => hit.delete();
  return scan;
}

export const POLICY_ADAPTERS = Object.freeze({ 'foothold-v2': footholdV2, 'ame2-demo': makeAme2Adapter(makeTerrainSampler) });
export function getPolicyAdapter(id = 'foothold-v2') {
  const adapter = Object.hasOwn(POLICY_ADAPTERS, id) && POLICY_ADAPTERS[id];
  if (!adapter) throw new Error(`알 수 없는 정책 어댑터: ${id}`);
  return adapter;
}

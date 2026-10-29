import { loadAme2Policy } from './ame2-network.js';

// ASSUMPTION: USD articulation order is unavailable. Change this single table
// when the provider supplies robot.joint_names; never infer order from regexes.
export const AME2_JOINT_ORDER = Object.freeze([
  'FL_hip_joint', 'FR_hip_joint', 'RL_hip_joint', 'RR_hip_joint',
  'FL_thigh_joint', 'FR_thigh_joint', 'RL_thigh_joint', 'RR_thigh_joint',
  'FL_calf_joint', 'FR_calf_joint', 'RL_calf_joint', 'RR_calf_joint',
]);
const defaults = Float64Array.from(AME2_JOINT_ORDER, (n) => n.includes('_hip') ? (n[1] === 'L' ? .1 : -.1) : n.includes('_thigh') ? (n[0] === 'F' ? .8 : 1) : -1.5);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const yawOf = (q) => Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] ** 2 + q[6] ** 2));
export const ame2Grid = Array.from({ length: 377 }, (_, i) => [-.42 + .06 * Math.floor(i / 13), -.36 + .06 * (i % 13)]);
// env.yaml:166-203; go2_curve.py:8-20 (text only). Extra calf reduction.
export const AME2_MOTORS = AME2_JOINT_ORDER.map((n) => n.includes('_calf')
  ? { x1: 7.041528239202657, x2: 15.64784053156146, y1: 38.72738853503185, y2: 44.86242038216561 }
  : { x1: 13.5, x2: 30, y1: 20.2, y2: 23.4 });
export function ame2Torque(torque, velocity, index) {
  const { x1, x2, y1, y2 } = AME2_MOTORS[index];
  const limit = (torque * velocity > 0 ? y1 : y2) * clamp((x2 - Math.abs(velocity)) / (x2 - x1), 0, 1);
  return clamp(torque, -limit, limit);
}

// A: fresh nearby body-frame target each tick; heading integrates the right stick.
// Complete neutral attaches both target and heading to the current pose.
export function ame2Joystick(previousHeading, yaw, axes, dt = .02) {
  const forward = clamp(axes[0], 0, 1), lateral = clamp(axes[1], -1, 1), turn = clamp(axes[2], -1, 1);
  if (!forward && !lateral && !turn) return { heading: null, command: [0, 0, 0, 1] };
  let heading = (previousHeading ?? yaw) + turn * dt;
  const error = clamp(Math.atan2(Math.sin(heading - yaw), Math.cos(heading - yaw)), -Math.PI / 3, Math.PI / 3);
  heading = yaw + error;
  const n = Math.max(1, Math.hypot(forward, lateral));
  return { heading, command: [forward / n, lateral / n, Math.sin(error), Math.cos(error)] };
}

export function makeAme2Adapter(makeTerrainSampler) {
  return {
    id: 'ame2-demo', label: 'AME-2(시연)',
    observations: { size: 49, bodySize: 49, mappingSize: 1131, height: { grid: ame2Grid, rayOffset: .501, noise: 0, clip: [-1.5, 1.5] } },
    network: { file: 'ame2_actor.f32', manifest: 'ame2_actor.json', sha256: '28edbc05169b817044c600d90cc081bb797ae56c5b8400b8ffebf648410d26a0' },
    action: { size: 12, joints: AME2_JOINT_ORDER, defaultPose: defaults, scale: .25, kp: 25, kd: .5, targetClip: 100, torque: ame2Torque },
    timing: { physicsDt: .005, decimation: 4, policyDt: .02, delaySteps: 0 },
    command: { kind: 'nearby_goal', joystickScale: [1, 1, 1], inRange: (c) => c.length === 4 && c.every(Number.isFinite) && Math.hypot(c[0], c[1]) <= 2 },
    stop: { input: [0, 0, 0, 1], pause: true },
    loadPolicy: loadAme2Policy,
    observe(obs, s, last, sampleHeight) {
      obs.set(s.linB, 0); obs.set(s.angB, 3); obs.set(s.grav, 6);
      for (let i = 0; i < 12; i++) {
        const j = s.M2I[i];
        obs[9 + i] = s.d.qpos[7 + j] - defaults[i]; obs[21 + i] = s.d.qvel[6 + j];
        obs[33 + i] = clamp(last[i], -50, 50);
      }
      obs.set(s.cmd, 45);
      sampleHeight(s.d.qpos, s.mapping);
    },
    makeHeightScanner(mj, m, d, world) {
      const sample = makeTerrainSampler(mj, m, d, this.observations.height), heights = new Float64Array(377);
      // Training virtual_floor.py:56-83: no virtual plane on dense/app terrain;
      // void = lowest valid world height - depth, all void = floor.z.
      // Deterministic demo midpoint of env.yaml:1793-1799, relative to floorZ.
      const depth = .7, floorZ = world?.floorZ ?? 0;
      const scan = (q, out) => {
        sample(q, heights);
        let lowest = Infinity;
        for (const z of heights) if (Number.isFinite(z)) lowest = Math.min(lowest, z);
        const fallback = Number.isFinite(lowest) ? lowest - depth : floorZ - depth;
        for (let i = 0; i < 377; i++) {
          out[i * 3] = ame2Grid[i][0]; out[i * 3 + 1] = ame2Grid[i][1];
          out[i * 3 + 2] = clamp((Number.isFinite(heights[i]) ? heights[i] : fallback) - q[2] + .27, -1.5, 1.5);
        }
        return out;
      };
      scan.dispose = sample.dispose;
      return scan;
    },
    yawOf,
  };
}

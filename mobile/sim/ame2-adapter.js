import { loadAme2Policy } from './ame2-network.js';

// Confirmed: model_14999.go2_env_state.critic_contract.joint_names.
// go2_runner.py:431,554 saves the articulation order, not a regex expansion.
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

// observations.py:296-340: the 2 m threshold is strict; far-goal yaw is
// redrawn once per policy observation. Nearby joystick goals retain their yaw.
export function ame2GoalObservation(command) {
  const distance = Math.hypot(command[0], command[1]);
  if (distance <= 2) return command;
  const yaw = Math.random() * 2 * Math.PI - Math.PI;
  return [command[0] * 2 / distance, command[1] * 2 / distance, Math.sin(yaw), Math.cos(yaw)];
}

// actions.py:37-72: shift processed targets at EVERY physics substep.
// A delay of 4 retains the old target for a complete 4-substep policy tick.
export function makeAme2ActionDelay(defaultPose, fixedDelaySteps = null) {
  if (fixedDelaySteps !== null && (!Number.isInteger(fixedDelaySteps) || fixedDelaySteps < 0 || fixedDelaySteps > 4)) throw new Error('AME-2 fixed delay must be an integer in [0,4]');
  const history = Array.from({ length: 5 }, () => Float64Array.from(defaultPose));
  let steps = 0;
  return {
    get steps() { return steps; },
    reset() { steps = fixedDelaySteps ?? Math.floor(Math.random() * 5); this.clear(); },
    clear() { for (const target of history) target.set(defaultPose); },
    apply(target) {
      for (let i = 4; i > 0; i--) history[i].set(history[i - 1]);
      history[0].set(target);
      return history[steps];
    },
  };
}

// A: fresh nearby body-frame target each tick; heading integrates the right stick.
// Complete neutral attaches both target and heading to the current pose.
// 시뮬 잠금 풀기(10-31): 뒤쪽 목표(후진)도 보낸다 — 앞쪽만이라고 가정한 범위 밖이라 inRange 가 테두리 색으로만 알린다(자르지 않음)
export function ame2Joystick(previousHeading, yaw, axes, dt = .02) {
  const forward = clamp(axes[0], -1, 1), lateral = clamp(axes[1], -1, 1), turn = clamp(axes[2], -1, 1);
  if (!forward && !lateral && !turn) return { heading: null, command: [0, 0, 0, 1] };
  let heading = (previousHeading ?? yaw) + turn * dt;
  const error = clamp(Math.atan2(Math.sin(heading - yaw), Math.cos(heading - yaw)), -Math.PI / 3, Math.PI / 3);
  heading = yaw + error;
  const n = Math.max(1, Math.hypot(forward, lateral));
  return { heading, command: [forward / n, lateral / n, Math.sin(error), Math.cos(error)] };
}

// Autonomy: keep the waypoint and heading in world coordinates. Reproject at
// every policy tick; only the trained 2 m distance limit applies. Pre-clipping
// also avoids the observation's far-goal random yaw replacing the path heading.
export function ame2WorldGoal(q, point, heading) {
  const yaw = yawOf(q), dx = point.x - q[0], dy = point.y - q[1];
  let x = Math.cos(yaw) * dx + Math.sin(yaw) * dy;
  let y = -Math.sin(yaw) * dx + Math.cos(yaw) * dy;
  const distance = Math.hypot(x, y);
  if (distance > 2) {
    // Leave one rounding margin below the strict >2 observation threshold.
    const scale = (2 - Number.EPSILON * 2) / distance;
    x *= scale; y *= scale;
  }
  const error = heading - yaw;
  return [x, y, Math.sin(error), Math.cos(error)];
}

export function makeAme2Adapter(makeTerrainSampler) {
  return {
    id: 'ame2-demo', label: 'AME-2(시연)',
    // go2_env_cfg.py:78-87: terrain scan starts 20 m above the body.
    observations: { size: 49, bodySize: 49, mappingSize: 1131, height: { grid: ame2Grid, rayOffset: 20, noise: 0, clip: [-1.5, 1.5] } },
    network: { file: 'ame2_actor.f32', manifest: 'ame2_actor.json', sha256: '28edbc05169b817044c600d90cc081bb797ae56c5b8400b8ffebf648410d26a0' },
    action: { size: 12, joints: AME2_JOINT_ORDER, defaultPose: defaults, scale: .25, kp: 25, kd: .5, targetClip: 100, torque: ame2Torque },
    timing: { physicsDt: .005, decimation: 4, policyDt: .02, delayRange: [0, 4] },
    makeActionDelay: makeAme2ActionDelay,
    command: { kind: 'nearby_goal', joystickScale: [1, 1, 1], inRange: (c) => c.length === 4 && c.every(Number.isFinite) && c[0] >= 0 && Math.hypot(c[0], c[1]) <= 2 },
    stop: { input: [0, 0, 0, 1], pause: true },
    loadPolicy: loadAme2Policy,
    observe(obs, s, last, sampleHeight) {
      obs.set(s.linB, 0); obs.set(s.angB, 3); obs.set(s.grav, 6);
      for (let i = 0; i < 12; i++) {
        const j = s.M2I[i];
        obs[9 + i] = s.d.qpos[7 + j] - defaults[i]; obs[21 + i] = s.d.qvel[6 + j];
        obs[33 + i] = clamp(last[i], -50, 50);
      }
      obs.set(ame2GoalObservation(s.cmd), 45);
      sampleHeight(s.d.qpos, s.mapping);
    },
    makeHeightScanner(mj, m, d, world) {
      const heightCfg = { ...this.observations.height }, maxOffset = heightCfg.rayOffset;
      const sample = makeTerrainSampler(mj, m, d, heightCfg), heights = new Float64Array(377);
      const hit = new mj.IntBuffer(1), normal = new mj.DoubleBuffer(3);
      const point = new Float64Array(3), up = [0, 0, 1], group = [1, 1, 0, 0, 1, 0];
      const excluded = Array.from({ length: m.ngeom }, (_, g) => g)
        .filter((g) => m.geom_bodyid[g] !== 0 || (!m.geom_contype[g] && !m.geom_conaffinity[g]));
      const originalGroups = new Uint8Array(excluded.length);
      // Training virtual_floor.py:56-83: no virtual plane on dense/app terrain;
      // void = lowest valid world height - depth, all void = floor.z.
      // Deterministic demo midpoint of env.yaml:1793-1799, relative to floorZ.
      const depth = .7, floorZ = world?.floorZ ?? 0;
      const scan = (q, out) => {
        // One body-up probe identifies the space the robot occupies. Per-cell
        // upward probes would mistake the thin, elevated training stair plates
        // ahead for roofs. Cap the common downward start below the nearest
        // overhead underside, while uncovered scenes keep the full 20m scan.
        const maxZ = q[2] + maxOffset, epsilon = .001, groups = m.geom_group;
        point.set(q.slice(0, 3)); heightCfg.rayOffset = maxOffset;
        for (const [i, g] of excluded.entries()) { originalGroups[i] = groups[g]; groups[g] = 5; }
        try {
          for (let crossings = 0; crossings <= m.ngeom && point[2] < maxZ; crossings++) {
            const distance = mj.mj_ray(m, d, point, up, group, true, -1, hit, normal);
            if (!Number.isFinite(distance) || distance < 0 || point[2] + distance > maxZ) break;
            if (normal.GetView()[2] < 0) {
              heightCfg.rayOffset = point[2] + distance - q[2] - epsilon;
              break;
            }
            // An upward-facing exit means the body probe started inside a
            // solid obstacle. Its exposed top is terrain, not a ceiling.
            point[2] += distance + epsilon;
          }
        } finally { for (const [i, g] of excluded.entries()) groups[g] = originalGroups[i]; }
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
      scan.dispose = () => { sample.dispose(); hit.delete(); normal.delete(); };
      return scan;
    },
    yawOf,
  };
}

// RS-4 공통 핵심(브라우저·Node 같이 씀): MuJoCo Go2 + foothold-v2 순수 JS 추론.
// Policy contracts live in policy-adapters.js; height observations raycast actual world geometry.
// 관측·행동 계약은 exp33 src/v2_obs.py 그대로(관측 235, 행동 Isaac 순서, q* = 0.25·a + 기본자세).
import { getPolicyAdapter } from './policy-adapters.js';
const defaultAdapter = getPolicyAdapter();
const LEGS = ['FL', 'FR', 'RL', 'RR'], PARTS = ['hip', 'thigh', 'calf'];
// Legacy exports stay available to the existing measurement scripts.
export const ISAAC_J = defaultAdapter.action.joints;
export const MJ_J = LEGS.flatMap((l) => PARTS.map((k) => `${l}_${k}_joint`));
export const DEFAULT_I = defaultAdapter.action.defaultPose;
export const { physicsDt: PHYS_DT, decimation: DECIM, policyDt: POLICY_DT } = defaultAdapter.timing;
export const MENAGERIE = { damping: 2, frictionloss: 0.2, armature: 0.01, footFriction: 0.8, footSpin: true };
export const ISAAC_LIKE = { ...MENAGERIE, damping: 0, frictionloss: 0, footSpin: false };
export const loadPolicy = (buf, adapterId = 'foothold-v2') => getPolicyAdapter(adapterId).loadPolicy(buf);

// DCMotor(IsaacLab): 속도에 따라 줄어드는 토크 한도, 그 위 effort_limit 로 자름
function dcmotor(tau, dq, { effort: EFFORT, velocityLimit: VEL_LIM }) {
  const hi = Math.min(Math.max(EFFORT * (1 - dq / VEL_LIM), 0), EFFORT);
  const lo = Math.max(Math.min(EFFORT * (-1 - dq / VEL_LIM), 0), -EFFORT);
  return Math.min(Math.max(tau, lo), hi);
}

export function createSim(mj, xmlPath, phys = MENAGERIE, policy, world = { floorZ: 0, spawn: [0, 0, 0] }, adapterId = 'foothold-v2') {
  const adapter = getPolicyAdapter(adapterId);
  const { physicsDt: PHYS_DT, decimation: DECIM, policyDt: POLICY_DT } = adapter.timing;
  const { joints: ISAAC_J, defaultPose: DEFAULT_I, scale: ACTION_SCALE, kp: KP, kd: KD } = adapter.action;
  const F = world.floorZ, [SX, SY, SYAW] = world.spawn;
  const m = mj.MjModel.from_xml_path(xmlPath), d = new mj.MjData(m);
  m.opt.timestep = PHYS_DT;
  const jid = (n) => mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, n);
  const qa = MJ_J.map((n) => m.jnt_qposadr[jid(n)]), va = MJ_J.map((n) => m.jnt_dofadr[jid(n)]);
  const I2M = MJ_J.map((n) => ISAAC_J.indexOf(n)); // mj 순서 i 의 Isaac 색인
  const M2I = ISAAC_J.map((n) => MJ_J.indexOf(n)); // Isaac 순서 i 의 mj 색인
  for (const v of va) { m.dof_damping[v] = phys.damping; m.dof_frictionloss[v] = phys.frictionloss; m.dof_armature[v] = phys.armature; }
  for (const n of LEGS) {
    const g = mj.mj_name2id(m, mj.mjtObj.mjOBJ_GEOM.value, n) * 3;
    m.geom_friction[g] = phys.footFriction;
    if (!phys.footSpin) m.geom_friction[g + 1] = m.geom_friction[g + 2] = 0; // 비틀림·구름 마찰 끔(PhysX 처럼)
  }
  if (m.nu !== 12 || qa.some((a, i) => a !== 7 + i)) throw new Error('관절 배치가 예상(자유관절 뒤 FL..RR)과 다름');

  const sampleHeight = adapter.makeHeightScanner(mj, m, d);
  const obs = new Float32Array(adapter.observations.size), last = new Float32Array(adapter.action.size), tgt = new Float64Array(adapter.action.size); // tgt: mj 순서
  const s = { m, d, adapterId, t: 0, cmd: adapter.stop.input.slice(), linB: [0, 0, 0], angB: [0, 0, 0], grav: [0, 0, -1], z: 0, fell: false, policyMs: 0, physMs: 0, I2M, M2I };

  s.reset = () => {
    mj.mj_resetData(m, d);
    const q = d.qpos, v = d.qvel;
    q[0] = SX; q[1] = SY; q[2] = F + 0.4; q[3] = Math.cos(SYAW / 2); q[4] = q[5] = 0; q[6] = Math.sin(SYAW / 2); // Isaac init_state 바닥 위 0.4
    for (let i = 0; i < 12; i++) { q[7 + i] = DEFAULT_I[I2M[i]]; tgt[i] = DEFAULT_I[I2M[i]]; }
    v.fill(0); last.fill(0); s.t = 0; s.fell = false;
    mj.mj_forward(m, d);
    state();
  };

  function state() {
    const q = d.qpos, v = d.qvel;
    const [w, x, y, z] = [q[3], q[4], q[5], q[6]];
    // R(몸→월드) 의 열. R^T·u 로 월드 → 몸
    const R = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
    const tB = (a, b, c) => [R[0] * a + R[3] * b + R[6] * c, R[1] * a + R[4] * b + R[7] * c, R[2] * a + R[5] * b + R[8] * c];
    s.linB = tB(v[0], v[1], v[2]);          // 자유관절 선속도 = 월드 → 몸통 좌표
    s.angB = [v[3], v[4], v[5]];            // 자유관절 각속도 = 이미 몸통 좌표
    s.grav = tB(0, 0, -1);
    s.z = q[2] - F; // 바닥 기준 몸통 높이
    if (s.z < 0.18 || s.grav[2] > -0.5) s.fell = true; // 몸통 18 cm 아래 또는 60° 넘게 기욺
  }

  // 정책 1스텝(50 Hz): 관측 → 추론 → 물리 4스텝(스텝마다 PD·DCMotor)
  s.step = () => {
    const t0 = performance.now();
    adapter.observe(obs, s, last, sampleHeight);
    const a = policy(obs);
    last.set(a);
    for (let i = 0; i < 12; i++) tgt[i] = a[I2M[i]] * ACTION_SCALE + DEFAULT_I[I2M[i]];
    const t1 = performance.now();
    for (let k = 0; k < DECIM; k++) s.physStep();
    s.policyMs = t1 - t0; s.physMs = performance.now() - t1;
    s.t += POLICY_DT;
    state();
  };
  s.physStep = () => {
    const q = d.qpos, v = d.qvel, u = d.ctrl;
    for (let i = 0; i < 12; i++) u[i] = dcmotor(KP * (tgt[i] - q[7 + i]) - KD * v[6 + i], v[6 + i], adapter.action);
    mj.mj_step(m, d);
  };
  s.hold = (sec) => { for (let k = 0; k < Math.round(sec / PHYS_DT); k++) s.physStep(); state(); }; // 정책 없이 기본자세 PD
  s.dispose = () => { sampleHeight.dispose(); d.delete(); m.delete(); };
  s.reset();
  return s;
}

// 자동 측정 시나리오: 각 구간 10 s, 추종은 구간 마지막 6 s 평균(Gazebo L2 T1 과 같은 창)
export const SCENARIO = [
  { name: 'vx0.6', cmd: [0.6, 0, 0], sec: 10 },
  { name: 'vx0.6 wz+0.5', cmd: [0.6, 0, 0.5], sec: 10 },
  { name: 'vx0.6 wz-0.5', cmd: [0.6, 0, -0.5], sec: 10 },
  { name: 'stop', cmd: [0, 0, 0], sec: 3 },
];
export function* runScenario(s) {
  s.reset(); s.hold(0.5);
  const out = { segments: [], fell: false, fellAt: null, policyMs: [], physMs: [] };
  for (const seg of SCENARIO) {
    s.cmd = seg.cmd.slice();
    const acc = { vx: 0, wz: 0, n: 0 };
    for (let k = 0; k < Math.round(seg.sec / POLICY_DT); k++) {
      s.step();
      out.policyMs.push(s.policyMs); out.physMs.push(s.physMs);
      if (s.fell && !out.fell) { out.fell = true; out.fellAt = +s.t.toFixed(2); }
      if (k * POLICY_DT >= seg.sec - 6) { acc.vx += s.linB[0]; acc.wz += s.angB[2]; acc.n++; }
      yield seg.name;
    }
    out.segments.push({ name: seg.name, cmd: seg.cmd, vx: +(acc.vx / acc.n).toFixed(3), wz: +(acc.wz / acc.n).toFixed(3) });
  }
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return +b[b.length >> 1].toFixed(3); };
  const p95 = (a) => { const b = [...a].sort((x, y) => x - y); return +b[Math.floor(b.length * 0.95)].toFixed(3); };
  out.policyMs = { med: med(out.policyMs), p95: p95(out.policyMs) };
  out.physMs = { med: med(out.physMs), p95: p95(out.physMs) };
  // 판정(안): 30 s 낙상 0, 추종 오차 ±20%(vx 는 0.6 기준, wz 는 ±0.5 기준)
  const [a, b, c] = out.segments;
  out.pass = !out.fell && [a, b, c].every((g) => Math.abs(g.vx - 0.6) <= 0.12) && Math.abs(b.wz - 0.5) <= 0.1 && Math.abs(c.wz + 0.5) <= 0.1;
  s.result = out;
  return out;
}

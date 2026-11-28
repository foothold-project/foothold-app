import { appendFileSync } from 'node:fs';
// MuJoCo 물리 자식: 파이썬 에이전트 (foothold_agent.mujoco_bridge) 가 띄우고 stdin/stdout 한 줄 JSON 으로만 말한다.
// 계약은 README.md. 안전 판단 (조종권 · 잠금 · 재개 허가) 은 파이썬 쪽 정본 (link/session.py · safety/core.py) 이 하고,
// 여기서는 Gazebo /v2_live/{cmd_vel,stop,resume,state} 와 같은 뜻만 지킨다:
//   STOP 상태에서는 cmd 를 버리고 0, 잘못된 줄은 STOP, cmd 가 끊기면 0, 부모가 사라지면 끝.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { POLICY_DT } from '../../mobile/sim/sim.js';
import { loadWorld } from './world.mjs';
import { createVitals } from './vitals.mjs';

const { values: a } = parseArgs({ options: {
  map: { type: 'string', default: 'collapsed-house-v2' }, seed: { type: 'string', default: '0' },
  spawn: { type: 'string' }, // 'x,y,yaw' (월드 m · rad). 없으면 지도 기본 출발 자리
  'battery-start': { type: 'string', default: '100' }, // 시작 SoC % (배터리는 vitals.mjs 가 토크 · 속도로 줄인다)
  'ambient-c': { type: 'string', default: '25' }, // 관절 모터 주변 온도 °C
} });
const seed = Number(a.seed), socStart = Number(a['battery-start']), ambientC = Number(a['ambient-c']);
if (!Number.isInteger(seed) || !(socStart >= 0 && socStart <= 100) || !(ambientC > -40 && ambientC < 80)) throw new Error('--seed 정수 · --battery-start 0~100 · --ambient-c (-40, 80)');

const SCHEMA = 'v2_live/state/1', STATE_S = 0.05, CMD_TTL_S = 0.5, Z = [0, 0, 0];
const LIMIT = [1.5, 1.0, 2.0]; // |vx| m/s · |vy| m/s · |wz| rad/s 밖이면 잘못된 줄
const spawnXyYaw = a.spawn === undefined ? null : a.spawn.split(',').map(Number);
if (spawnXyYaw && (spawnXyYaw.length !== 3 || !spawnXyYaw.every(Number.isFinite))) throw new Error('--spawn x,y,yaw');
const world = await loadWorld({ simSrc: process.env.FH_SIM_SRC, mapId: a.map, seed, spawnXyYaw });
const sim = world.sim;
// 배터리 · 관절 온도: 물리 한 걸음마다 MuJoCo 가 낸 관절 힘 (qfrc_actuator, 자유관절 6 칸 뒤 12 관절) 과 속도 (qvel) 를 적분.
// 리셋 (출발 자리로) 해도 배터리 · 온도는 이어진다 (같은 몸).
const vitals = createVitals({ socStart, ambientC });
const physStep = sim.physStep, physDt = sim.m.opt.timestep;
sim.physStep = () => {
  physStep();
  vitals.add(Array.from(sim.d.qfrc_actuator.subarray(6, 18)), Array.from(sim.d.qvel.subarray(6, 18)), physDt);
};
let resetPending = false, episode = 0, stopRequested = true, resetting = false, cmd = Z, cmdAt = -Infinity, simBase = 0;

const now = () => performance.now() / 1000;
const warn = (code, detail) => process.stderr.write(JSON.stringify({ error: code, ...(detail ? { detail } : {}) }) + '\n');
const stop = () => { stopRequested = true; cmd = Z; sim.cmd = Z.slice(); };
const validCmd = (v) => Array.isArray(v) && v.length === 3 && v.every((x, i) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= LIMIT[i]);

function onLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { m = null; }
  const kind = m && typeof m === 'object' && !Array.isArray(m) ? m.t : undefined;
  if (kind === 'cmd' && validCmd(m.v)) {
    if (!stopRequested && !resetting) { cmd = m.v.slice(); cmdAt = now(); }
  } else if (kind === 'stop') stop();
  else if (kind === 'resume') { if (!resetting) { stopRequested = false; cmd = Z; cmdAt = -Infinity; } }
  else if (kind === 'reset') {
    stop(); resetting = true; emit(); // reset_in_progress 를 한 번은 내보낸다
    resetPending = true; // 비동기 step 이 끝난 뒤 루프에서 되돌린다
  } else { stop(); warn('bad_line', String(line).slice(0, 80)); }
}

function emit() {
  const q = sim.d.qpos, up = world.upright(), ttlExpired = now() - cmdAt > CMD_TTL_S;
  const t = simBase + sim.t;
  const applied = stopRequested || resetting || ttlExpired ? Z : cmd;
  const s = {
    schema: SCHEMA, episode, sim_t: +t.toFixed(4), stop_requested: stopRequested, reset_in_progress: resetting, policy_running: true,
    x: q[0], y: q[1], z: q[2], yaw: Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6])),
    vx: sim.linB[0], vy: sim.linB[1], wz: sim.angB[2], tilt_deg: Math.acos(Math.max(-1, Math.min(1, up))) * 180 / Math.PI,
    upright: up, base_height: world.baseHeight(), fallen: up < 0.5,
    body_still: Math.hypot(sim.linB[0], sim.linB[1]) < 0.05 && Math.abs(sim.angB[2]) < 0.05,
    cmd_applied: applied.slice(), cmd_age_s: Number.isFinite(cmdAt) ? +(now() - cmdAt).toFixed(3) : null, ttl_s: CMD_TTL_S, ttl_expired: ttlExpired,
    battery_soc: vitals.soc(), joint_temp_c: vitals.jointTempsC().map((c) => +c.toFixed(2)), source: 'mujoco', plugin_mode: 'REALTIME',
  };
  process.stdout.write(JSON.stringify(s) + '\n');
}

createInterface({ input: process.stdin }).on('line', onLine).on('close', () => { stop(); clearInterval(loop); world.dispose(); process.exit(0); });
process.stdout.on('error', () => { stop(); process.exit(0); }); // 부모 쪽 파이프가 닫힘

// 벽시계를 따라 정책 주기 (50 Hz) 로 진행, 상태는 20 Hz. 밀리면 최대 0.2 s 만 따라잡는다.
// ONNX 정책 step 은 비동기라 한 번에 하나만 돈다 (busy). 명령은 매 step 직전에 다시 읽는다.
// 재기 전용 (FH_SIM_STEP_STATS 가 있을 때만): 정책 한 걸음 벽시계 시간, 1 s 마다 한 줄. 판단에는 쓰지 않는다.
const stats = process.env.FH_SIM_STEP_STATS ? (() => {
  let n = 0, over = 0, max = 0, sum = 0, at = now();
  return {
    add(ms) { n++; sum += ms; if (ms > 20) over++; if (ms > max) max = ms; },
    flush() {
      if (now() - at < 1 || !n) return;
      appendFileSync(process.env.FH_SIM_STEP_STATS, JSON.stringify({ wall_s: +now().toFixed(3), sim_t: +(simBase + sim.t).toFixed(3),
        steps: n, over_20ms: over, max_ms: +max.toFixed(2), mean_ms: +(sum / n).toFixed(2) }) + '\n');
      n = over = max = sum = 0; at = now();
    },
  };
})() : null;
const start = now(); let steps = 0, nextState = 0, busy = false;
emit();
const loop = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    if (resetPending) { resetPending = false; simBase += sim.t; sim.reset(); episode++; resetting = false; }
    const due = Math.min(Math.floor((now() - start) / POLICY_DT), steps + 10);
    for (; steps < due; steps++) {
      const applied = stopRequested || resetting || now() - cmdAt > CMD_TTL_S ? Z : cmd;
      sim.cmd = applied.slice();
      const t0 = performance.now();
      await sim.step();
      if (stats) stats.add(performance.now() - t0);
    }
    if (stats) stats.flush();
    if (now() - start >= nextState) { nextState += STATE_S; emit(); }
  } catch (error) { warn('policy_failed', String(error).slice(0, 120)); process.exit(1); }
  finally { busy = false; }
}, 5);

// MuJoCo 물리 자식: 파이썬 에이전트 (foothold_agent.mujoco_bridge) 가 띄우고 stdin/stdout 한 줄 JSON 으로만 말한다.
// 계약은 README.md. 안전 판단 (조종권 · 잠금 · 재개 허가) 은 파이썬 쪽 정본 (link/session.py · safety/core.py) 이 하고,
// 여기서는 Gazebo /v2_live/{cmd_vel,stop,resume,state} 와 같은 뜻만 지킨다:
//   STOP 상태에서는 cmd 를 버리고 0, 잘못된 줄은 STOP, cmd 가 끊기면 0, 부모가 사라지면 끝.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { POLICY_DT } from '../../mobile/sim/sim.js';
import { loadWorld } from './world.mjs';

const { values: a } = parseArgs({ options: {
  map: { type: 'string', default: 'collapsed-house-v2' }, seed: { type: 'string', default: '0' },
  'battery-start': { type: 'string', default: '100' }, 'battery-drain': { type: 'string', default: '0.0139' }, // %/s (시뮬 시각) · 기본 = 2 시간에 100 %
} });
const seed = Number(a.seed), socStart = Number(a['battery-start']), drain = Number(a['battery-drain']);
if (!Number.isInteger(seed) || !(socStart >= 0 && socStart <= 100) || !(drain >= 0 && drain <= 100)) throw new Error('--seed 정수 · --battery-start 0~100 · --battery-drain 0~100');

const SCHEMA = 'v2_live/state/1', STATE_S = 0.05, CMD_TTL_S = 0.5, Z = [0, 0, 0];
const LIMIT = [1.5, 1.0, 2.0]; // |vx| m/s · |vy| m/s · |wz| rad/s 밖이면 잘못된 줄
const world = await loadWorld({ simSrc: process.env.FH_SIM_SRC, mapId: a.map, seed });
const sim = world.sim;
let episode = 0, stopRequested = true, resetting = false, cmd = Z, cmdAt = -Infinity, simBase = 0;

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
    simBase += sim.t; sim.reset(); episode++; resetting = false;
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
    battery_soc: Math.max(0, socStart - drain * t), source: 'mujoco', plugin_mode: 'REALTIME',
  };
  process.stdout.write(JSON.stringify(s) + '\n');
}

createInterface({ input: process.stdin }).on('line', onLine).on('close', () => { stop(); clearInterval(loop); world.dispose(); process.exit(0); });
process.stdout.on('error', () => { stop(); process.exit(0); }); // 부모 쪽 파이프가 닫힘

// 벽시계를 따라 정책 주기 (50 Hz) 로 진행, 상태는 20 Hz. 밀리면 최대 0.2 s 만 따라잡는다.
const start = now(); let steps = 0, nextState = 0;
emit();
const loop = setInterval(() => {
  const due = Math.min(Math.floor((now() - start) / POLICY_DT), steps + 10);
  for (; steps < due; steps++) {
    const applied = stopRequested || resetting || now() - cmdAt > CMD_TTL_S ? Z : cmd;
    sim.cmd = applied.slice();
    sim.step();
  }
  if (now() - start >= nextState) { nextState += STATE_S; emit(); }
}, 5);

// Offline waypoint overlay; commands stay inside the existing joystick limits.
import { cell } from './lidar.js';
import { boundedNumber, DEFAULT_VX, DEFAULT_WZ } from './settings.js';

export const REACH_RADIUS = 0.3, MAX_VX = DEFAULT_VX, MAX_WZ = DEFAULT_WZ, BLOCK_RANGE = 0.6;
// 이 시간 넘게 지점에 0.1 m 도 못 다가가고 방향 오차도 0.1 rad 넘게 못 줄이면 «막힘»(돌다 걸린 것도 멈춤)
export const STALL_S = 5, STALL_GAIN = 0.1, STALL_TURN = 0.1, BEHIND = 2.6;

export function validateScenarios(list, map) {
  if (!Array.isArray(list)) throw new Error('시나리오 목록 형식');
  const ids = new Set();
  for (const s of list) {
    if (!s || typeof s.id !== 'string' || !s.id || ids.has(s.id) || typeof s.name !== 'string' || !s.name ||
        !Array.isArray(s.points) || !s.points.length) throw new Error('시나리오 형식');
    ids.add(s.id);
    for (const p of s.points) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || cell(map, p.x, p.y) !== 254) throw new Error('지점이 빈 칸 밖에 있음');
    }
  }
  return list;
}

// Ray 0 points forward. Reuse the existing 10 Hz scan, with no extra raycasts.
export function frontDistance(rays) {
  let min = Infinity;
  for (let i = 0; i < rays.length; i++) {
    if (Math.min(i, rays.length - i) * 2 * Math.PI / rays.length <= Math.PI / 6) min = Math.min(min, rays[i]);
  }
  return min;
}

export function createScenarioRunner(sim, isStopped, limits = {}) {
  let maxVx = MAX_VX, maxWz = MAX_WZ;
  // goal = 찍은 곳 하나로 가기(손 조종이 끊으면 잠그지 않고 취소만). best(거리)·turn(방향 오차)·stall = 진전 없음 재기
  const runner = { active: false, index: 0, points: [], status: '대기', goal: false, best: Infinity, turn: Infinity, stall: 0 };
  runner.cancel = (reason = '중단') => {
    runner.active = false;
    runner.status = reason;
    sim.cmd = [0, 0, 0];
    return sim.cmd;
  };
  runner.start = (points, goal = false) => {
    if (isStopped() || !points?.length) return false;
    // Snapshot each run: a settings response can only affect the next start.
    // A valid organization/adapter cap can reduce an axis below the input range, even to zero.
    maxVx = Math.min(boundedNumber(limits?.vx, 0.1, 1.5, MAX_VX), boundedNumber(limits?.caps?.vx, 0, 1.5, Infinity));
    maxWz = Math.min(boundedNumber(limits?.wz, 0.1, 1, MAX_WZ), boundedNumber(limits?.caps?.wz, 0, 1, Infinity));
    runner.points = points;
    runner.goal = goal;
    runner.index = 0;
    runner.best = runner.turn = Infinity; runner.stall = runner.spin = 0;
    runner.status = '실행 중';
    runner.active = true;
    sim.cmd = [0, 0, 0];
    return true;
  };
  // dt = 이번 틱 시간(s). 0 이면 진전 없음은 재지 않는다
  runner.tick = (front = Infinity, dt = 0) => {
    if (!runner.active) return sim.cmd;
    if (isStopped()) return runner.cancel('중단');
    const q = sim.d.qpos;
    while (runner.index < runner.points.length) {
      const p = runner.points[runner.index], dx = p.x - q[0], dy = p.y - q[1], dist = Math.hypot(dx, dy);
      if (dist <= REACH_RADIUS) { runner.index++; runner.best = runner.turn = Infinity; runner.stall = runner.spin = 0; continue; }
      const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] ** 2 + q[6] ** 2));
      const a = Math.atan2(dy, dx) - yaw;
      let error = Math.atan2(Math.sin(a), Math.cos(a));
      // 거의 바로 뒤(|오차| > BEHIND)면 처음 고른 회전 방향을 지킨다 — ±π 근처에서 몸 흔들림으로 부호가 뒤집혀 제자리에 멈춰 «막힘»이 되지 않게
      if (runner.spin && Math.abs(error) > BEHIND && Math.sign(error) !== runner.spin) error = runner.spin * (2 * Math.PI - Math.abs(error));
      runner.spin = Math.abs(error) > BEHIND ? Math.sign(error) : 0;
      const vx = Math.abs(error) < 0.4 ? maxVx : 0;
      // 앞 막힘은 앞으로 갈 때만 — 벽을 보고 선 채 뒤쪽 지점으로 돌아서는 것은 막지 않는다
      if (vx && !(front > BLOCK_RANGE)) return runner.cancel('막힘');
      let gained = false;
      if (dist < runner.best - STALL_GAIN) { runner.best = dist; gained = true; }
      if (Math.abs(error) < runner.turn - STALL_TURN) { runner.turn = Math.abs(error); gained = true; }
      if (gained) runner.stall = 0; else if ((runner.stall += dt) >= STALL_S) return runner.cancel('막힘');
      sim.cmd = [vx, 0, Math.max(-maxWz, Math.min(maxWz, 1.5 * error))];
      return sim.cmd;
    }
    return runner.cancel('완료');
  };
  return runner;
}

// Human input cancels autonomy and enters the existing STOP lock. A new Run is required.
// 찍은 곳 가기(goal)만 예외: 막대·키(손 조종)는 목표를 취소하고 잠그지 않는다 — 손 조종이 바로 이어진다.
export function bindScenarioInterrupts({ runner, lock, left, right, stop, doc, win, home, reset }) {
  const interrupt = () => { if (runner.active) { runner.cancel('중단'); lock(); } };
  const hand = () => { if (runner.active && runner.goal) runner.cancel('손 조종'); else interrupt(); };
  for (const el of [left, right]) el.addEventListener('pointerdown', hand, { capture: true });
  stop.addEventListener('pointerdown', interrupt, { capture: true });
  stop.addEventListener('click', interrupt, { capture: true });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) interrupt(); });
  for (const ev of ['pagehide', 'freeze', 'blur']) win.addEventListener(ev, interrupt);
  for (const el of [home, reset]) el.addEventListener('click', interrupt, { capture: true });
  return { hand };
}

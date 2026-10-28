// Offline waypoint overlay; commands stay inside the existing joystick limits.
import { cell } from './lidar.js';

export const REACH_RADIUS = 0.3, MAX_VX = 0.4, MAX_WZ = 0.6, BLOCK_RANGE = 0.6;

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

export function createScenarioRunner(sim, isStopped) {
  const runner = { active: false, index: 0, points: [], status: '대기' };
  runner.cancel = (reason = '중단') => {
    runner.active = false;
    runner.status = reason;
    sim.cmd = [0, 0, 0];
    return sim.cmd;
  };
  runner.start = (points) => {
    if (isStopped() || sim.fell || !points?.length) return false;
    runner.points = points;
    runner.index = 0;
    runner.status = '실행 중';
    runner.active = true;
    sim.cmd = [0, 0, 0];
    return true;
  };
  runner.tick = (front = Infinity) => {
    if (!runner.active) return sim.cmd;
    if (isStopped()) return runner.cancel('중단');
    if (sim.fell) return runner.cancel('넘어짐');
    if (!(front > BLOCK_RANGE)) return runner.cancel('막힘');
    const q = sim.d.qpos;
    while (runner.index < runner.points.length) {
      const p = runner.points[runner.index], dx = p.x - q[0], dy = p.y - q[1];
      if (Math.hypot(dx, dy) <= REACH_RADIUS) { runner.index++; continue; }
      const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] ** 2 + q[6] ** 2));
      const a = Math.atan2(dy, dx) - yaw, error = Math.atan2(Math.sin(a), Math.cos(a));
      sim.cmd = [Math.abs(error) < 0.4 ? MAX_VX : 0, 0, Math.max(-MAX_WZ, Math.min(MAX_WZ, 1.5 * error))];
      return sim.cmd;
    }
    return runner.cancel('완료');
  };
  return runner;
}

// Human input cancels autonomy and enters the existing STOP lock. A new Run is required.
export function bindScenarioInterrupts({ runner, lock, left, right, stop, doc, win, home, reset }) {
  const interrupt = () => { if (runner.active) { runner.cancel('중단'); lock(); } };
  for (const el of [left, right]) el.addEventListener('pointerdown', interrupt, { capture: true });
  stop.addEventListener('pointerdown', interrupt, { capture: true });
  stop.addEventListener('click', interrupt, { capture: true });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) interrupt(); });
  for (const ev of ['pagehide', 'freeze', 'blur']) win.addEventListener(ev, interrupt);
  for (const el of [home, reset]) el.addEventListener('click', interrupt, { capture: true });
}

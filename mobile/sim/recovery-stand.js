// 넘어짐 판정 · RecoveryStand 대역 (시뮬 전용 · 팀장 11/22 02:44).
// 판정은 실기와 같은 식: 몸통 좌표 중력 방향 z (projected gravity, 서 있으면 -1) 가 -0.5 보다 크거나 (60° 넘게 누움)
// 몸 높이가 0.15 m 아래인 상태가 0.5 초 넘게 이어지면 넘어짐. 실기는 Go2 SDK SportClient.RecoveryStand() 를 쓰고,
// MuJoCo 시뮬에는 그 운동 서비스가 없어 정해진 관절 자세표를 PD 로 따라가는 대역을 둔다 (정책 아님).
// 관절 순서는 정책 (Isaac) 순서: [hip, thigh, calf] × [FL, FR, RL, RR].
export const FALL = Object.freeze({ gravZ: -0.5, height: 0.15, holdSec: 0.5 });
export const RECOVERY_GAINS = Object.freeze({ kp: 60, kd: 3 });

export function createFallDetector(dt) {
  let held = 0;
  return {
    update(gravZ, height) {
      const bad = gravZ > FALL.gravZ || height < FALL.height;
      held = bad ? held + dt : 0;
      return { bad, fallen: held >= FALL.holdSec, gravZ, height, held };
    },
    reset() { held = 0; },
  };
}

const pose = (hip, thigh, calf) => [...hip, ...thigh, ...calf];
const ext = [-0.9, -0.9, -0.9, -0.9];
// 엎드림 (Unitree 엎드림 자세에 가까운 값) · 서기 (정책 기본 자세) · 구르기 한 번 (다리를 등 쪽으로 넘겼다가
// 한쪽은 등 쪽에 두고 반대쪽을 배 쪽으로 빠르게 휘둘러 몸을 넘김). 브라우저 시뮬에서 임의로 뒤집은 8 자세 모두 섰다 (11/22).
export const RECOVERY_POSES = Object.freeze({
  fold: pose([0, 0, 0, 0], [1.2, 1.2, 1.2, 1.2], [-2.7, -2.7, -2.7, -2.7]),
  legsOver: pose([-1, 1, -1, 1], [3.4, 3.4, 3.4, 3.4], ext),
  sweepPlus: pose([1, 1, 1, 1], [3.4, -1, 3.4, -1], ext),
  sweepMinus: pose([-1, -1, -1, -1], [-1, 3.4, -1, 3.4], ext),
});
const SWEEPS_PER_ATTEMPT = 4;

// 시도 하나 = (배가 아래가 될 때까지, 몸이 기운 쪽으로) 구르기 최대 4 번 → 엎드림 → 서기 → 유지 후 확인.
export function createRecoveryStand({ dt, standPose, attempts = 3 }) {
  let plan = [], k = 0, from = null, attempt = 0, sweeps = 0, phase = 'roll', state = 'idle';
  const stand = Array.from(standPose), P = RECOVERY_POSES;
  const seg = (to, sec) => ({ to, steps: Math.max(1, Math.round(sec / dt)) });
  const next = (gravZ, gravY, upright) => {
    if (phase === 'roll' && gravZ > -0.7 && sweeps < SWEEPS_PER_ATTEMPT) {
      sweeps++;
      const sweep = gravY >= 0 ? P.sweepPlus : P.sweepMinus;
      plan = [seg(P.legsOver, 0.8), seg(sweep, 0.3), seg(sweep, 0.6), seg(P.fold, 0.6)];
    } else if (phase === 'roll' && gravZ <= -0.7) {
      phase = 'stand'; plan = [seg(P.fold, 0.6), seg(stand, 1.5), seg(stand, 0.6)];
    } else if (phase === 'stand' && upright) state = 'done';
    else if (attempt >= attempts) state = 'failed';
    else { attempt++; sweeps = 0; phase = 'roll'; plan = [seg(P.fold, 0.6)]; }
    k = 0; from = null;
  };
  return {
    get state() { return state; },
    get attempt() { return attempt; },
    get phase() { return phase; },
    attempts,
    start() { attempt = 1; sweeps = 0; phase = 'roll'; state = 'active'; plan = [seg(P.fold, 0.6)]; k = 0; from = null; },
    stop() { state = 'idle'; attempt = 0; plan = []; },
    // current: 정책 순서 관절 각 12 개. 반환: 목표 관절 각 (정책 순서) · 다음 단계를 고르는 틱이면 null.
    step(current, gravZ, gravY, upright) {
      if (state !== 'active') return null;
      if (!plan.length) { next(gravZ, gravY, upright); return null; }
      const s0 = plan[0];
      from ??= Array.from(current);
      const a = Math.min(1, ++k / s0.steps), s = a * a * (3 - 2 * a);
      const target = s0.to.map((x, i) => from[i] + (x - from[i]) * s);
      if (k >= s0.steps) { plan.shift(); k = 0; from = Array.from(s0.to); }
      return target;
    },
  };
}

// Offline waypoint overlay: velocity tracking or direct AME-2 world goals.
import { validateTree, createTreeRunner } from './bt.js';
import { ame2WorldGoal } from './ame2-adapter.js';
import { getPolicyMode } from './policy-modes.js';
import { cell } from './lidar.js';
import { boundedNumber, DEFAULT_VX, DEFAULT_WZ } from './settings.js';
import { ZONE_STOP } from './zones.js';

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
  return list.filter((s) => {
    if (!Object.hasOwn(s, 'tree')) return true;
    try { validateTree(s.tree); return true; } catch (e) { console.warn(`나무 제외: ${s.id}: ${e.message}`); return false; }
  });
}

// Ray 0 points forward. Reuse the existing 10 Hz scan, with no extra raycasts.
export function frontDistance(rays) {
  let min = Infinity;
  for (let i = 0; i < rays.length; i++) {
    if (Math.min(i, rays.length - i) * 2 * Math.PI / rays.length <= Math.PI / 6) min = Math.min(min, rays[i]);
  }
  return min;
}

// entersZone(x, y, 가는 방향, 속력) = 다음 걸음이 접근 금지 구역(몸체 여유 포함)으로 들어가나(zones.js zoneEnters). 없으면 구역 검사 없음
export function createScenarioRunner(sim, isStopped, limits = {}, entersZone = null) {
  let maxVx = MAX_VX, maxWz = MAX_WZ, origin;
  const mode = getPolicyMode(sim.adapterId);
  const directGoal = mode.command.kind === 'nearby_goal';
  const neutral = () => mode.stop.input.slice();
  // goal = 찍은 곳 하나로 가기(손 조종이 끊으면 잠그지 않고 취소만). best(거리)·turn(방향 오차)·stall = 진전 없음 재기
  const runner = { active: false, index: 0, points: [], status: '대기', goal: false, best: Infinity, turn: Infinity, stall: 0 };
  runner.cancel = (reason = '중단') => {
    runner.active = false;
    if (directGoal) sim.cancelPolicyStep?.();
    runner.status = reason;
    sim.cmd = neutral();
    return sim.cmd;
  };
  runner.start = (points, goal = false) => {
    if (mode.command.kind === 'none' || isStopped() || !points?.length) return false;
    // Snapshot each run: a settings response can only affect the next start.
    // A valid organization/adapter cap can reduce an axis below the input range, even to zero.
    const runVx = goal ? limits?.goalVx ?? limits?.vx : limits?.vx;
    maxVx = Math.min(boundedNumber(runVx, 0.1, 1.5, MAX_VX), boundedNumber(limits?.caps?.vx, 0, 1.5, Infinity));
    const turnCap = mode.command.caps.turnInPlace;
    maxWz = Math.min(boundedNumber(limits?.wz, 0.1, turnCap, MAX_WZ), boundedNumber(limits?.caps?.wz, 0, turnCap, Infinity));
    runner.points = points;
    runner.goal = goal;
    runner.index = 0;
    runner.best = runner.turn = Infinity; runner.stall = runner.spin = 0;
    runner.status = '실행 중';
    runner.active = true;
    sim.cmd = neutral();
    origin = { x: sim.d.qpos[0], y: sim.d.qpos[1] };
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
      const forward = Math.abs(error) < 0.4;
      const vx = forward ? maxVx : 0;
      // 앞 막힘은 앞으로 갈 때만 — 벽을 보고 선 채 뒤쪽 지점으로 돌아서는 것은 막지 않는다
      // Direct goals have no speed scale; a zero velocity setting must not
      // disable this obstacle guard while AME-2 still receives a position.
      if ((directGoal ? forward : vx) && !(front > BLOCK_RANGE)) return runner.cancel('막힘');
      let gained = false;
      if (dist < runner.best - STALL_GAIN) { runner.best = dist; gained = true; }
      if (Math.abs(error) < runner.turn - STALL_TURN) { runner.turn = Math.abs(error); gained = true; }
      if (gained) runner.stall = 0; else if ((runner.stall += dt) >= STALL_S) return runner.cancel('막힘');
      // 달리는 중 다음 걸음이 접근 금지 구역이면 멈춘다(제자리 회전은 걸음이 아님). 위치 목표 모델은 목표 쪽으로 걷는다고 본다(정책 속도 ≤ 1.2)
      if ((directGoal || vx) && entersZone?.(q[0], q[1], directGoal ? Math.atan2(dy, dx) : yaw, directGoal ? 1.2 : vx)) return runner.cancel(ZONE_STOP);
      if (directGoal) {
        // Explicit world yaw wins; otherwise use outgoing path direction,
        // or the incoming segment at the last point (start -> point for one).
        const next = runner.points[runner.index + 1];
        const previous = runner.points[runner.index - 1] ?? origin;
        const pathYaw = next ? Math.atan2(next.y - p.y, next.x - p.x) : Math.atan2(p.y - previous.y, p.x - previous.x);
        sim.cmd = ame2WorldGoal(q, p, Number.isFinite(p.yaw) ? p.yaw : pathYaw);
      } else {
        let wz = Math.max(-maxWz, Math.min(maxWz, 1.5 * error)), speed = vx;
        if (mode.id === 'start-demo' && speed) {
          wz = Math.max(-mode.command.caps.turnWalking, Math.min(mode.command.caps.turnWalking, wz));
          // Keep reduced organization caps, including zero; never raise a cap.
          speed = Math.abs(wz) < .2 ? speed : Math.min(maxVx, Math.max(.3, Math.min(.8, speed)));
        }
        sim.cmd = [speed, 0, wz];
      }
      return sim.cmd;
    }
    return runner.cancel('완료');
  };
  return runner;
}

// Human input cancels autonomy and enters the existing STOP lock. A new Run is required.
// 찍은 곳 가기(goal)만 예외: 막대·키(손 조종)는 목표를 취소하고 잠그지 않는다 — 손 조종이 바로 이어진다.
// embedded = PC 웹 앱 안 시뮬 칸(RB-WEBSIM-PIP): 집 = 작은 창(끝이 아님)·초점 잃음에도 화면은 보여 시뮬이 돈다 → 그 둘은 중단하지 않는다(숨김·freeze·나가기는 그대로)
export function bindScenarioInterrupts({ runner, lock, left, right, stop, doc, win, home, reset, preserveOnHide = false, mission = null, embedded = false }) {
  const interrupt = () => { if (runner.active || mission?.active) { mission?.cancel('중단'); runner.cancel('중단'); lock(); } };
  const hand = () => { if (!mission?.active && runner.active && runner.goal) runner.cancel('손 조종'); else interrupt(); };
  for (const el of [left, right]) el.addEventListener('pointerdown', hand, { capture: true });
  stop.addEventListener('pointerdown', interrupt, { capture: true });
  stop.addEventListener('click', interrupt, { capture: true });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden && (!preserveOnHide || mission?.active)) interrupt(); });
  doc.addEventListener('freeze', () => { if (!preserveOnHide || mission?.active) interrupt(); });
  for (const ev of embedded ? ['freeze'] : ['freeze', 'blur']) win.addEventListener(ev, () => { if (!preserveOnHide || mission?.active) interrupt(); });
  win.addEventListener('pagehide', interrupt);   // 실제로 페이지를 떠나면 기존 취소·잠금
  for (const el of embedded ? [reset] : [home, reset]) el.addEventListener('click', interrupt, { capture: true });
  return { hand };
}

// Browser-sim effects only. Navigation reuses the original runner, A* and caps.
// Quaternion body-up dot world-up below this cosine means a fall (60 degrees).
export const FALLEN_UP_COS = 0.5;
export function bodyFallen(qpos) { return 1 - 2 * (qpos[4] ** 2 + qpos[5] ** 2) < FALLEN_UP_COS; }
export function createPatrolRunner({ sim, runner, isStopped, lock, planRoute, getMap, getFront, home, onStart = () => {}, onMark = () => {}, onClearMarks = () => {} }) {
  let execution = null, runId = 0, scenario, pendingReview = null, failedPoint = null;
  const mock = { fallen: false, battery: false, photo: false, move: false };
  const patrol = { mock, events: [], summary: null, reviewPending: false, visited: new Set(), skipped: new Set(), minor: new Set(), danger: new Set(), marks: [],
    get active() { return !!execution?.active; }, get execution() { return execution; },
    get status() { return execution?.status ?? '대기'; }, get context() { return execution?.context; } };
  const neutral = () => { sim.cmd = getPolicyMode(sim.adapterId).stop.input.slice(); sim.cancelPolicyStep?.(); };
  const event = (message) => {
    const q = sim.d.qpos;
    patrol.events.push({ seconds: +(execution?.elapsed ?? 0).toFixed(2), message, x: +q[0].toFixed(2), y: +q[1].toFixed(2) });
  };
  const summary = (reason) => ({ visited: patrol.visited.size, skipped: patrol.skipped.size, minor: patrol.minor.size, danger: patrol.danger.size,
    reason, seconds: +(execution?.elapsed ?? 0).toFixed(2) });
  patrol.cancel = (reason = '중단') => { runId++; execution?.cancel(reason); runner.cancel('중단'); neutral(); patrol.reviewPending = false; };
  patrol.review = (level) => { if (patrol.active && patrol.reviewPending && ['clear', 'minor', 'danger'].includes(level)) pendingReview = level; };
  const instant = (effect) => { let done = false; return { tick: () => { if (!done) { neutral(); effect(); done = true; } return 'success'; }, halt: neutral }; };
  const navigate = (node, ctx, returning = false) => {
    const token = runId, point = returning ? home() : node.point === 'current' ? ctx.point : node.point;
    let alive = true, planned = false, failure = false, launched = false;
    neutral();
    if (!returning && mock.move) { mock.move = false; failedPoint = ctx.index; }
    if (!returning && failedPoint === ctx.index) { failure = true; planned = true; }
    else Promise.resolve(planRoute(getMap(), { x: sim.d.qpos[0], y: sim.d.qpos[1] }, [point])).then((points) => {
      if (!alive || token !== runId || !patrol.active || isStopped()) return;
      planned = true;
      if (!points?.length) failure = true;
      else { if (Number.isFinite(point.yaw)) points.at(-1).yaw = point.yaw; launched = runner.start(points); failure = !launched; }
    }, () => { if (alive) { planned = true; failure = true; } });
    return {
      tick(dt) {
        if (isStopped() || token !== runId) return 'abort';
        if (!planned) return 'running';
        if (failure) { event(returning ? '복귀 길 없음' : '이동 실패'); return 'failure'; }
        if (runner.active) runner.tick(getFront(), dt);
        if (runner.active) return 'running';
        if (['중단', '손 조종'].includes(runner.status)) return 'abort';
        if (runner.status !== '완료') { event(`${returning ? '복귀' : '이동'} ${runner.status}`); return 'failure'; }
        if (!returning) patrol.visited.add(ctx.index);
        event(returning ? '복귀 완료' : `지점 ${ctx.index + 1} 방문`); return 'success';
      },
      halt(reason) { alive = false; if (launched) runner.cancel(reason === '우선 갈래' ? '중단' : reason); neutral(); },
    };
  };
  patrol.start = (chosen) => {
    if (patrol.active || runner.active || isStopped() || !chosen?.tree) return false;
    validateTree(chosen.tree); runId++; scenario = chosen; pendingReview = failedPoint = null;
    patrol.events = []; patrol.summary = null; patrol.reviewPending = false; patrol.marks = []; onClearMarks();
    for (const key of ['visited', 'skipped', 'minor', 'danger']) patrol[key].clear();
    execution = createTreeRunner(chosen.tree, {
      isStopped,
      conditions: { fallen: () => mock.fallen || bodyFallen(sim.d.qpos), battery_low: () => mock.battery, review_is: (n, c) => c.review === n.level },
      onFinish: ({ result, reason }) => { neutral(); if (result === 'abort') lock(); patrol.reviewPending = false; patrol.summary = summary(reason); event(`끝: ${reason}`); },
      actions: {
        goto: (n, c) => navigate(n, c), return_home: (n, c) => navigate(n, c, true),
        photo: () => { let seconds = 0; neutral(); const fail = mock.photo; mock.photo = false;
          return { tick: (dt) => { neutral(); if ((seconds += dt) < 1) return 'running'; event(fail ? '모의 촬영 실패' : '모의 촬영 (저장 없음)'); return fail ? 'failure' : 'success'; }, halt: neutral }; },
        wait: (n) => { let seconds = 0; neutral(); return { tick: (dt) => { neutral(); return (seconds += dt) >= n.seconds ? 'success' : 'running'; }, halt: neutral }; },
        operator_review: (_n, c) => { pendingReview = null; patrol.reviewPending = true; neutral();
          return { tick: () => { neutral(); if (!pendingReview) return 'running'; c.review = pendingReview; event(`운영자 판단: ${pendingReview}`); patrol.reviewPending = false; return 'success'; },
            halt: (reason) => { neutral(); patrol.reviewPending = false; if (reason === '행동 시간 초과') { c.review = 'timeout'; event('운영자 120초 무응답 — 복귀'); } } }; },
        sensor_log: (n) => instant(() => event(n.message)),
        alert: (n) => instant(() => event(`모의 알림 (서버 전송 없음): ${n.message}`)),
        map_mark: (n, c) => instant(() => { patrol[n.level].add(c.index); const mark = { x: sim.d.qpos[0], y: sim.d.qpos[1], level: n.level }; patrol.marks.push(mark); onMark(mark); event(`이 화면 지도 표시: ${n.level}`); }),
        skip_log: (n, c) => instant(() => {
          if (n.remaining) for (let i = 0; i < scenario.points.length; i++) { if (!patrol.visited.has(i)) patrol.skipped.add(i); }
          else { patrol.skipped.add(c.index); c.skipPoint = true; failedPoint = null; }
          event(`${n.message} (${patrol.skipped.size})`);
        }),
        report: (n, c) => instant(() => { c.reason = n.message; c.finish = !!n.finish; patrol.summary = summary(c.reason); event(`모의 보고서: ${n.message}`); }),
        hold: (n, c) => ({ tick: () => { neutral(); c.reason = n.message; patrol.cancel(n.message); lock(); return 'abort'; }, halt: neutral }),
      },
    });
    const started = execution.start();
    if (started) onStart();
    return started;
  };
  patrol.tick = (dt) => execution?.tick(dt);
  return patrol;
}

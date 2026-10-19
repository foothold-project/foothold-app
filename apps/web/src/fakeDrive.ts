// 가짜 조종권 중재기(서버 호출 0). 서버 WS(05 API §9: lease.take·lease.request·lease.respond·lease.release·cmd·unlock·stop·hidden)로 바꿀 자리.
// 조종 화면은 DriveApi 만 부른다. 규칙·시간은 02 기능 F-TO-03·F-TO-04(«시간 기준»·«넘김 순서») 그대로.
import { ROBOTS, USERS, driveBlock, userName } from './fake';

export const REQUEST_S = 10, COOLDOWN_S = 30, HEARTBEAT_S = 15;

/** [전후, 회전] 각 -1..1. 회전 + = 왼쪽 */
export type Axes = [number, number];
export type Run = { name: string; step: number; total: number; paused: boolean };
export type DriveState = {
  holder: string | null;                       // 조종권자 사용자 id
  latched: boolean;                            // 정지 잠금
  neutral: boolean;                            // 잠금 해제 뒤 중립 입력을 받았나 — 받아야 움직인다(F-COM-01)
  axes: Axes;                                  // 로봇에 실제로 나가는 값
  request: { id: string; from: string; expiresAt: number } | null;   // 대기 요청은 로봇당 1건(규칙 5). 시각은 모두 now() 기준 ms
  cooldown: Record<string, number>;            // 사용자별 재요청 가능 시각
  notice: Record<string, string | undefined>;  // 사용자별 알림 한 줄
  run: Run | null;
  /** 넘김 2단계 정지 확인: 요청됨 → (확인되면 null + 잠금) | 실패. 실패는 «정지 잠금»이 아니다(확정 안 됨) */
  stopCheck: 'asked' | 'failed' | null;
};
export type TakeResult = 'TAKEN' | 'HELD' | 'RUN_ACTIVE' | 'FORBIDDEN';
export type RequestResult = 'SENT' | 'COOLDOWN' | 'BUSY' | 'FORBIDDEN';

export interface DriveApi {
  /** 판정 시계(단조, ms). 남은 초 표시도 이것으로 — 벽시계(Date.now)는 시각 표시용만 */
  now(): number;
  get(robot: string): DriveState;
  subscribe(f: () => void): () => void;
  /** 비어 있으면 받음(잠금 상태로 시작). 시나리오 실행 중이면 pauseRun 이 있어야 일시정지하고 받음(SF-10) */
  take(robot: string, user: string, pauseRun?: boolean): TakeResult;
  request(robot: string, user: string): RequestResult;
  respond(robot: string, user: string, accept: boolean): void;
  /** 조종 끝내기·화면 떠남: 0 명령 + 잠금 + 반납. 내 대기 요청도 거둔다 */
  release(robot: string, user: string): void;
  /** 화면 숨김: 조종권만 0·잠금·반납(대기 요청은 남김 — 숨긴 사이 넘겨받으면 화면이 바로 이것을 다시 부른다) */
  hidden(robot: string, user: string): void;
  unlock(robot: string, user: string): void;
  /** 50 ms 마다(0 포함). 조종권 심장 박동을 겸한다.
   *  ponytail: 0.3 s 입력 끊김 → 0 명령(데드맨)은 로봇 에이전트 몫이라 이 가짜는 흉내 내지 않는다 — 여기서는 15 s 조종권 만료만 */
  cmd(robot: string, user: string, axes: Axes): void;
  stop(robot: string, user: string): void;
  pauseRun(robot: string, user: string, paused: boolean): void;
  abortRun(robot: string, user: string): void;
}

export const FAIL_TEXT = '로봇 정지 확인 실패. 조종권은 비어 있고 로봇은 정지 요청 상태입니다. 현장을 확인한 뒤 다시 조종 시작하세요.';
export const FREE_TEXT = '조종권이 비었습니다. [조종 시작]으로 받을 수 있습니다.';

/** confirmStop: 넘김 2단계에서 로봇이 0 명령·잠금을 확인했나(가짜: 연결된 로봇이면 확인됨).
 *  now: 10 s 요청·30 s 재요청·15 s 조종권 판정 시계 — 단조 시계라 벽시계를 앞뒤로 바꿔도 흔들리지 않는다(재검토 R2-B1) */
export function createFakeDrive(seed: Record<string, Partial<DriveState>> = {}, confirmStop = (robot: string) => !!ROBOTS.find((r) => r.id === robot)?.online,
  now = () => performance.now()): DriveApi {
  const st: Record<string, DriveState> = {}, subs = new Set<() => void>(), timers = new Map<string, ReturnType<typeof setTimeout>>();
  let seq = 0;
  for (const r of ROBOTS) {
    const m = r.mission?.match(/^(.*) (\d+)\/(\d+)$/);   // ponytail: 실행 진행은 가짜 자료의 «이름 n/m» 글에서 — 계약의 run 객체가 오면 그것으로
    st[r.id] = { holder: null, latched: r.status === 'STOP_LATCHED', neutral: false, axes: [0, 0], request: null, cooldown: {}, notice: {},
      run: m ? { name: m[1], step: +m[2], total: +m[3], paused: r.status === 'PAUSED' } : null, stopCheck: null, ...seed[r.id] };
  }
  const set = (robot: string, p: Partial<DriveState>) => { st[robot] = { ...st[robot], ...p }; subs.forEach((f) => f()); };
  const later = (key: string, ms: number, f: () => void) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(f, ms)); };
  const allowed = (robot: string, user: string) => !driveBlock(USERS.find((u) => u.id === user)!, ROBOTS.find((r) => r.id === robot)!);
  const halt = { axes: [0, 0] as Axes, latched: true, neutral: false, stopCheck: null };   // 0 명령 + 잠금(확인됨)
  // 규칙 6: 마지막 입력 + 15 s 가 마감. 잠금은 아님(PRD Q7)
  const until: Record<string, number> = {};
  const beat = (robot: string) => { until[robot] = now() + HEARTBEAT_S * 1000; arm(robot); };

  /** 시간 기준(B1): 만료는 타이머가 돈 때가 아니라 마감 시각으로 판정 — 모든 처리 앞에서 먼저 확정한다 */
  function expire(robot: string) {
    const t = now(), q = st[robot].request;
    if (q && q.expiresAt <= t) close(robot, q.id, true);
    if (st[robot].holder && until[robot] <= t) vacate(robot, { axes: [0, 0], neutral: false });
    arm(robot);
  }
  /** 남은 마감마다 타이머를 건다 — 타이머가 이르게 깨도 expire 가 남은 시간으로 다시 건다 */
  function arm(robot: string) {
    const t = now(), s = st[robot];
    if (s.request) later(`rq:${robot}`, s.request.expiresAt - t, () => expire(robot));
    if (s.holder && until[robot] != null) later(`hb:${robot}`, until[robot] - t, () => expire(robot));
  }

  /** 조종권 비움 — 대기 요청은 끝내고, 기다리던 사람(대기 요청자·재요청 제한 중인 사람)에게 «비었습니다» */
  function vacate(robot: string, p: Partial<DriveState>, notice: Record<string, string | undefined> = {}) {
    const s = st[robot], t = now();
    clearTimeout(timers.get(`hb:${robot}`)); clearTimeout(timers.get(`rq:${robot}`)); delete until[robot];
    const waiting = [...(s.request ? [s.request.from] : []), ...Object.keys(s.cooldown).filter((u) => s.cooldown[u] > t)];
    set(robot, { ...p, holder: null, request: null, notice: { ...s.notice, ...Object.fromEntries(waiting.map((u) => [u, FREE_TEXT])), ...notice } });
  }
  /** 거절·자동 거절: 기존 조종 유지, 요청자는 30 s 재요청 제한(기준 = 확정된 때 — 자동 거절은 마감 시각) */
  function close(robot: string, id: string, timeout: boolean) {
    const s = st[robot];
    if (s.request?.id !== id) return;
    clearTimeout(timers.get(`rq:${robot}`));
    const { from, expiresAt } = s.request;
    set(robot, { request: null, cooldown: { ...s.cooldown, [from]: (timeout ? expiresAt : now()) + COOLDOWN_S * 1000 },
      notice: { ...s.notice, [from]: timeout ? '응답이 없어 요청이 끝났습니다.' : `${userName(s.holder!)}님이 거절했습니다.` } });
  }
  const quiet = (s: DriveState, user: string) => ({ ...s.notice, [user]: undefined });

  const api: DriveApi = {
    now,
    get: (robot) => st[robot],
    subscribe: (f) => { subs.add(f); return () => { subs.delete(f); }; },
    take(robot, user, pauseRun = false) {
      expire(robot);
      const s = st[robot];
      if (!allowed(robot, user)) return 'FORBIDDEN';
      if (s.holder === user) return 'TAKEN';
      if (s.holder) return 'HELD';
      if (s.run && !s.run.paused && !pauseRun) return 'RUN_ACTIVE';
      set(robot, { ...halt, holder: user, run: s.run && { ...s.run, paused: true }, notice: quiet(s, user) });
      beat(robot);
      return 'TAKEN';
    },
    request(robot, user) {
      expire(robot);
      const s = st[robot], t = now();
      if (!allowed(robot, user)) return 'FORBIDDEN';
      if ((s.cooldown[user] ?? 0) > t) return 'COOLDOWN';
      if (s.request || !s.holder || s.holder === user) return 'BUSY';
      const id = `q${++seq}`;
      set(robot, { request: { id, from: user, expiresAt: t + REQUEST_S * 1000 }, notice: quiet(s, user) });
      arm(robot);
      return 'SENT';
    },
    respond(robot, user, accept) {
      expire(robot);
      const s = st[robot];
      if (s.holder !== user || !s.request) return;
      if (!accept) return close(robot, s.request.id, false);
      // 넘김 순서: 1) 옛 조종권 비움 + 0 명령·입력 폐기, 정지 요청 2) 정지 확인 3) 확인되면 잠금 + 새 조종권(잠금 상태로 시작)
      // 4) 확인 실패 → 조종권 빈 채 «정지 확인 실패»(잠금 확정 아님) + 둘 다 알림
      const from = s.request.from;
      clearTimeout(timers.get(`rq:${robot}`)); clearTimeout(timers.get(`hb:${robot}`)); delete until[robot];
      set(robot, { holder: null, request: null, axes: [0, 0], neutral: false, stopCheck: 'asked' });
      if (!confirmStop(robot)) return vacate(robot, { stopCheck: 'failed' }, { [user]: FAIL_TEXT, [from]: FAIL_TEXT });
      set(robot, { ...halt, holder: from, notice: { ...s.notice, [user]: '조종권을 넘겼습니다. 보는 중입니다.', [from]: '조종권을 받았습니다. 잠금 해제 후 조종하세요.' } });
      beat(robot);
    },
    release(robot, user) {
      const s = st[robot];
      if (s.holder === user) vacate(robot, halt, { [user]: undefined });
      else if (s.request?.from === user) { clearTimeout(timers.get(`rq:${robot}`)); set(robot, { request: null }); }   // 떠난 화면에 조종권이 넘어가지 않게
    },
    hidden(robot, user) {
      if (st[robot].holder === user) vacate(robot, halt, { [user]: undefined });
    },
    unlock(robot, user) {
      expire(robot);
      const s = st[robot];
      if (s.holder === user && s.latched) set(robot, { latched: false, neutral: false, notice: quiet(s, user) });
    },
    cmd(robot, user, [fx, fw]) {
      expire(robot);   // 마감이 지난 뒤 늦게 온 입력은 조종권을 늘리지 않는다
      const s = st[robot];
      if (s.holder !== user) return;
      beat(robot);
      if (s.latched) return;                                              // 잠금 중 입력은 버림
      if (!s.neutral) { if (!fx && !fw) set(robot, { neutral: true }); return; }   // 중립을 먼저 받아야 움직임
      if (fx !== s.axes[0] || fw !== s.axes[1]) set(robot, { axes: [fx, fw] });
    },
    stop(robot) {
      const s = st[robot];
      set(robot, { ...halt, run: s.run && { ...s.run, paused: true } });
    },
    pauseRun(robot, user, paused) {
      const s = st[robot];
      if (s.run && allowed(robot, user) && (paused || !s.holder)) set(robot, { run: { ...s.run, paused } });   // 사람이 조종 중이면 다시 시작 안 됨
    },
    abortRun(robot, user) {
      if (allowed(robot, user)) set(robot, { run: null });
    },
  };
  return api;
}

// 가짜 시작 상태: Go2-7 은 박OO이 다른 창에서 조종 중(요청 흐름 시연용). 심장 박동 감시는 이 화면에서 cmd 가 오기 시작한 뒤부터.
export const SEED: Record<string, Partial<DriveState>> = { r7: { holder: 'u-park', latched: true } };
export let drive: DriveApi = createFakeDrive(SEED);
/** 시험용: 새 중재기로 갈아 끼움 */
export const resetDrive = (...a: Parameters<typeof createFakeDrive>) => { drive = createFakeDrive(...a); };

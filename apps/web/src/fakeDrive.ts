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
  request: { id: string; from: string; expiresAt: number } | null;   // 대기 요청은 로봇당 1건(규칙 5)
  cooldown: Record<string, number>;            // 사용자별 재요청 가능 시각(ms)
  notice: Record<string, string | undefined>;  // 사용자별 알림 한 줄
  run: Run | null;
};
export type TakeResult = 'TAKEN' | 'HELD' | 'RUN_ACTIVE' | 'FORBIDDEN';
export type RequestResult = 'SENT' | 'COOLDOWN' | 'BUSY' | 'FORBIDDEN';

export interface DriveApi {
  get(robot: string): DriveState;
  subscribe(f: () => void): () => void;
  /** 비어 있으면 받음(잠금 상태로 시작). 시나리오 실행 중이면 pauseRun 이 있어야 일시정지하고 받음(SF-10) */
  take(robot: string, user: string, pauseRun?: boolean): TakeResult;
  request(robot: string, user: string): RequestResult;
  respond(robot: string, user: string, accept: boolean): void;
  /** 조종 끝내기: 0 명령 + 잠금 + 반납 */
  release(robot: string, user: string): void;
  /** 화면 숨김·떠남: release 와 같음 */
  hidden(robot: string, user: string): void;
  unlock(robot: string, user: string): void;
  /** 50 ms 마다(0 포함). 조종권 심장 박동을 겸한다 */
  cmd(robot: string, user: string, axes: Axes): void;
  stop(robot: string, user: string): void;
  pauseRun(robot: string, user: string, paused: boolean): void;
  abortRun(robot: string, user: string): void;
}

export const FAIL_TEXT = '로봇 정지 확인 실패. 조종권은 비어 있고 로봇은 정지 요청 상태입니다. 현장을 확인한 뒤 다시 조종 시작하세요.';
export const FREE_TEXT = '조종권이 비었습니다. [조종 시작]으로 받을 수 있습니다.';

/** confirmStop: 넘김 2단계에서 로봇이 0 명령·잠금을 확인했나(가짜: 연결된 로봇이면 확인됨) */
export function createFakeDrive(seed: Record<string, Partial<DriveState>> = {}, confirmStop = (robot: string) => !!ROBOTS.find((r) => r.id === robot)?.online): DriveApi {
  const st: Record<string, DriveState> = {}, subs = new Set<() => void>(), timers = new Map<string, ReturnType<typeof setTimeout>>();
  let seq = 0;
  for (const r of ROBOTS) {
    const m = r.mission?.match(/^(.*) (\d+)\/(\d+)$/);   // ponytail: 실행 진행은 가짜 자료의 «이름 n/m» 글에서 — 계약의 run 객체가 오면 그것으로
    st[r.id] = { holder: null, latched: r.status === 'STOP_LATCHED', neutral: false, axes: [0, 0], request: null, cooldown: {}, notice: {},
      run: m ? { name: m[1], step: +m[2], total: +m[3], paused: r.status === 'PAUSED' } : null, ...seed[r.id] };
  }
  const set = (robot: string, p: Partial<DriveState>) => { st[robot] = { ...st[robot], ...p }; subs.forEach((f) => f()); };
  const later = (key: string, s: number, f: () => void) => { clearTimeout(timers.get(key)); timers.set(key, setTimeout(f, s * 1000)); };
  const allowed = (robot: string, user: string) => !driveBlock(USERS.find((u) => u.id === user)!, ROBOTS.find((r) => r.id === robot)!);
  const halt = { axes: [0, 0] as Axes, latched: true, neutral: false };   // 0 명령 + 잠금
  const beat = (robot: string) => later(`hb:${robot}`, HEARTBEAT_S, () => vacate(robot, { axes: [0, 0], neutral: false }));   // 규칙 6: 잠금은 아님(PRD Q7)

  /** 조종권 비움 — 대기 요청은 끝내고, 기다리던 사람(대기 요청자·재요청 제한 중인 사람)에게 «비었습니다» */
  function vacate(robot: string, p: Partial<DriveState>, notice: Record<string, string | undefined> = {}) {
    const s = st[robot], now = Date.now();
    clearTimeout(timers.get(`hb:${robot}`)); clearTimeout(timers.get(`rq:${robot}`));
    const waiting = [...(s.request ? [s.request.from] : []), ...Object.keys(s.cooldown).filter((u) => s.cooldown[u] > now)];
    set(robot, { ...p, holder: null, request: null, notice: { ...s.notice, ...Object.fromEntries(waiting.map((u) => [u, FREE_TEXT])), ...notice } });
  }
  /** 거절·자동 거절: 기존 조종 유지, 요청자는 30 s 재요청 제한(기준 = 확정된 때) */
  function close(robot: string, id: string, timeout: boolean) {
    const s = st[robot];
    if (s.request?.id !== id) return;
    clearTimeout(timers.get(`rq:${robot}`));
    const from = s.request.from;
    set(robot, { request: null, cooldown: { ...s.cooldown, [from]: Date.now() + COOLDOWN_S * 1000 },
      notice: { ...s.notice, [from]: timeout ? '응답이 없어 요청이 끝났습니다.' : `${userName(s.holder!)}님이 거절했습니다.` } });
  }
  const quiet = (s: DriveState, user: string) => ({ ...s.notice, [user]: undefined });

  const api: DriveApi = {
    get: (robot) => st[robot],
    subscribe: (f) => { subs.add(f); return () => { subs.delete(f); }; },
    take(robot, user, pauseRun = false) {
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
      const s = st[robot], now = Date.now();
      if (!allowed(robot, user)) return 'FORBIDDEN';
      if ((s.cooldown[user] ?? 0) > now) return 'COOLDOWN';
      if (s.request || !s.holder || s.holder === user) return 'BUSY';
      const id = `q${++seq}`;
      set(robot, { request: { id, from: user, expiresAt: now + REQUEST_S * 1000 }, notice: quiet(s, user) });
      later(`rq:${robot}`, REQUEST_S, () => close(robot, id, true));
      return 'SENT';
    },
    respond(robot, user, accept) {
      const s = st[robot];
      if (s.holder !== user || !s.request) return;
      if (!accept) return close(robot, s.request.id, false);
      // 넘김 순서: 1) 옛 조종권 입력 막음(0 명령·입력 폐기) 2) stop → 0·잠금 확인 3) 새 조종권자는 잠금 상태로 시작 4) 확인 실패 → 비움 + 정지 요청 상태 + 둘 다 알림
      const from = s.request.from;
      if (!confirmStop(robot)) return vacate(robot, halt, { [user]: FAIL_TEXT, [from]: FAIL_TEXT });
      clearTimeout(timers.get(`rq:${robot}`));
      set(robot, { ...halt, holder: from, request: null, notice: { ...s.notice, [user]: '조종권을 넘겼습니다. 보는 중입니다.', [from]: '조종권을 받았습니다. 잠금 해제 후 조종하세요.' } });
      beat(robot);
    },
    release(robot, user) {
      if (st[robot].holder === user) vacate(robot, halt, { [user]: undefined });
    },
    hidden: (robot, user) => api.release(robot, user),
    unlock(robot, user) {
      const s = st[robot];
      if (s.holder === user && s.latched) set(robot, { latched: false, neutral: false, notice: quiet(s, user) });
    },
    cmd(robot, user, [fx, fw]) {
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

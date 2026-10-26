// 폰 ↔ 시뮬 로봇 직결(09 ADR-002 §3·§5·§6, 05 API §13 fh-phone/1·§13.7 출입증·§13.8 카메라·§13.9 시뮬 중계).
// 띄우기·정리·출입증은 관제 서버 REST(api.ts), 조종·STOP·영상은 그 로봇 에이전트 폰 포트에 직접 WS — 서버 실시간(rt.ts) 조종 경로를 쓰지 않는다.
// 조종권·잠금·deadman 판정은 에이전트. 폰은 요청만 보내고 state 로 확인한다: 자동 취득·자동 해제·자동 재연결 없음.
import { useSyncExternalStore } from 'react';
import type { PhoneReply, PhoneState, PhoneWelcome, RunSnapshot, Scenario, SimCatalog, SimCleanupSlot, SimFailureDetail, SimRobot, SimRobotList, SimWorldFloor } from '../../contracts/ts';
import { ApiFail, api, authMark } from './api';
import { media } from './media';
import { phoneUrl } from './phoneTransport';

/** pick 고르기 · starting 띄우는 중 · unsure 시작 확인 안 됨(서버 STARTING 일 수 있음) · linking 출입증·연결 · drive 조종 화면 · ending 끝내는 중 · checking 정리 확인 안 됨 */
export type Step = 'pick' | 'starting' | 'unsure' | 'linking' | 'drive' | 'ending' | 'checking';
type Cam = 'wait' | 'frame' | 'none' | 'lost' | 'off';
export type Link = {
  at: 'connecting' | 'open' | 'closed'; welcome: PhoneWelcome | null; st: PhoneState | null; stAt: number; lease: string | null;
  /** 닫힌 이유(사람 문구)·닫기 코드 */
  why: string; code: number;
  /** 요청 실패·조종권 알림 한 줄 */
  notice: string; busy: '' | 'take' | 'unlock' | 'release' | 'run';
  /** 마지막 cmd.ack 가 잘렸는지(«명령 범위 조정») */
  clipped: boolean; rtt: number | null; cam: Cam; img: string;
  /** 다른 사람의 조종권 요청(내가 조종자일 때) */
  ask: { id: string; until: number } | null;
  /** 출입증 만료(UTC 초) */
  exp: number;
  /** 시나리오 실행(05 §13.10) — 에이전트가 알린 마지막 상태(state.run·run.update), 지점 도착 한 줄, NAV_UNAVAILABLE 로 시작을 거절받음 */
  run: RunSnapshot | null; arrived: string; navOff: boolean;
};
export type Sim = {
  step: Step; catalog: SimCatalog | null; mine: SimRobot[]; listed: boolean; err: string; robot: SimRobot | null; since: number; link: Link | null;
  /** STOP: agent = 에이전트에 직접 보냄, cleanup = 로봇에 연결 전이라 명령 없이 그 슬롯을 정리(서버 STOP 경로는 쓰지 않음 — ADR-002 §5) */
  stop: { at: number; via: 'agent' | 'cleanup'; g0?: number; conn?: number; latched?: true } | null;   // g0·conn = STOP 때 stop_gen·연결(gen), latched = 그 뒤 새 세대 잠금을 이 연결에서 받음
  /** 이 시각(단조) 전에는 다시 연결하지 않는다(1013 뒤 늘리는 간격·출입증 429 retry_after) */
  retryAt: number;
  /** 관리자 remaining_s를 받은 뒤의 단조 시계 기한(폰 UTC 시계와 무관). */
  runtimeUntil: number | null;
  /** unsure 가 SIM_SLOT_BUSY 때문(남의 로봇일 수 있어 목록으로 내 것인지 먼저 확인) · 남이 쓰는 것으로 확인한 슬롯 */
  slotBusy: boolean; busyWhy: string; taken: string[]; cleanup: SimCleanupSlot[]; managerError: SimRobotList['manager_error'];
};

export const CMD_MS = 50, PING_MS = 1000;
const now = () => performance.now();
const blank = (): Sim => ({ step: 'pick', catalog: null, mine: [], cleanup: [], managerError: null, listed: false, err: '', robot: null, since: 0, link: null, stop: null, retryAt: 0, runtimeUntil: null, slotBusy: false, busyWhy: '', taken: [] });
const runtimeUntil = (r: SimRobot) => typeof r.remaining_s === 'number' && Number.isFinite(r.remaining_s) && r.remaining_s >= 0
  ? now() + r.remaining_s * 1000 : null;
/** 05 §13.9 시작 전 확실한 거부 (status, code) 고정 목록 — 이 밖(SIM_SLOT_BUSY 포함)은 불확실 */
const REJECTED = new Set(['400 SIM_VALIDATION', '400 SIM_IDENTITY_INVALID', '400 SIM_CREDENTIAL_INVALID', '404 SIM_WORLD_NOT_FOUND', '404 SIM_SLOT_NOT_FOUND',
  '409 SIM_WORLD_BUSY', '409 SIM_OWNER_LIMIT', '409 SIM_NATIVE_SINGLE_ONLY', '409 SIM_ROBOT_LIMIT']);
// gen = 연결 세대(close 마다), epoch = 화면 세션(clear 마다), cancel = 띄우는 중 STOP(POST 답이 오면 바로 정리), me = 내 사용자 id(총괄 목록은 조직 전체라 owner 로 내 것 판정)
let S = blank(), lastEcho = '', ws: WebSocket | null = null, cam: WebSocket | null = null, timer = 0, tick = 0, seq = 0, ids = 0, backoff = 0, gen = 0, epoch = 0, cancel = false, me = '';
let axes: Axes = [0, 0];   // [전후, 회전, 옆] -1..1, 조종 화면이 넣는다
let surface: 'pc' | undefined;   // PC «시뮬» 탭이 열려 있으면 'pc' — 출입증 요청에 싣는다(ADR-003 §6.2, 폰은 보내지 않음)
const replies = new Map<string, (ok: boolean, r?: PhoneReply) => void>();
/** 실행 끝 상태 · 이 화면 id · 이 화면이 건 실행의 이어서 비밀값(05 §13.10.4 — 이 탭 메모리에만: 서버·기록·URL·저장소 0, 새로고침하면 잃는다)
 *  pausedAt = 일시정지를 본 단조 시각(자동 취소 남은 시간 어림), dismissed = «닫기»로 내린 끝난 실행 */
export const RUN_END = ['COMPLETED', 'FAILED', 'CANCELED'];
/** 에이전트가 PAUSED 를 이 초 뒤 취소(run_pause_timeout_s 기본값) */
export const PAUSE_S = 600;
let screen = '', own: { run_id: string; token: string } | null = null, pausedAt: { run_id: string; at: number } | null = null, dismissed = '';
const screenId = () => (screen ||= crypto.randomUUID());
/** 실행이 로봇을 움직이는 중(일시정지·끝 아님) — 이때 화면은 cmd 를 보내지 않고 ping 만(§13.10.2) */
export const runMoving = (r: RunSnapshot | null | undefined) => !!r && r.status !== 'PAUSED' && !RUN_END.includes(r.status);
function seeRun(r: RunSnapshot | null) {
  if (r?.status === 'PAUSED') { if (pausedAt?.run_id !== r.run_id) pausedAt = { run_id: r.run_id, at: now() }; }
  else if (r && pausedAt?.run_id === r.run_id) pausedAt = null;
  if (r && RUN_END.includes(r.status) && own?.run_id === r.run_id) own = null;
  return r;
}
const subs = new Set<() => void>();
const emit = () => { S = { ...S }; subs.forEach((f) => f()); };
const set = (p: Partial<Sim>) => { Object.assign(S, p); emit(); };
const setLink = (p: Partial<Link>) => { if (S.link) { S.link = { ...S.link, ...p }; emit(); } };

/** 설치 단위 기기 UUID(§13.2 — 탭마다 만들지 않음). 저장소를 못 쓰면 이 창에서만 */
let mem = '', loadErr = '';
export function deviceId() {
  try { const v = localStorage.getItem('fh-device'); if (v) return v; } catch { /* 저장 불가 */ }
  mem ||= crypto.randomUUID();
  try { localStorage.setItem('fh-device', mem); } catch { /* 저장 불가 */ }
  return mem;
}

const ERR: Record<string, string> = {
  LEASE_HELD: '다른 사람이 조종 중입니다.', NOT_CONTROLLER: '조종권이 없습니다.', FORBIDDEN: '보기만 출입증이라 조종할 수 없습니다.',
  UNLOCK_REJECTED: '잠금을 풀지 못했습니다. 로봇의 정지 확인을 기다렸다가 다시 누르세요.',
  STOP_CONFIRM_FAILED: '로봇 정지를 확인하지 못해 조종권을 받지 못했습니다.',
  LEASE_REQUEST_PENDING: '이미 다른 요청이 기다리는 중입니다.', LEASE_REQUEST_EXPIRED: '요청 시간이 지났습니다.',
  LEASE_REQUEST_COOLDOWN: '잠시 뒤 다시 요청하세요.', LEASE_ACQUIRE_LIMIT: '요청이 많습니다. 잠시 뒤 다시 누르세요.', REQUEST_FLOOD: '요청이 많습니다. 잠시 뒤 다시 누르세요.',
  RUN_ACTIVE: '시나리오 실행 중에는 수동 조종·새 실행이 막혀 있습니다. 먼저 «일시정지»하세요.', RUN_CONFLICT: '같은 실행 요청이 다른 내용으로 와서 거절됐습니다.',
  RUN_NOT_FOUND: '이 실행을 찾지 못했습니다. 이미 끝났을 수 있습니다.', RUN_STATE_CONFLICT: '지금 실행 상태에서는 할 수 없습니다.',
  RUN_OWNER_MISMATCH: '다른 화면에서 건 실행입니다. 일시정지·이어서·조종 전환은 그 화면에서만 할 수 있습니다.',
  RESUME_REJECTED: '아직 이어갈 수 없습니다. 로봇의 목표 취소 확인을 기다렸다가 «조종 시작» → «잠금 해제» → 손을 뗀 뒤 다시 누르세요.',
  UNSUPPORTED_OPERATION: '아직 지원하지 않는 동작입니다.', RECORDING_UNAVAILABLE: '실행 기록 장애로 시작·이어서를 막았습니다. 시뮬을 «끝내기» 한 뒤 다시 띄우면(에이전트 재시작) 새로 실행할 수 있습니다.',
  NAV_UNAVAILABLE: '이 로봇에는 자율 이동(내비게이션)이 준비되지 않아 시나리오를 실행할 수 없습니다.',
  MAP_VERSION_MISMATCH: '시나리오의 지도 판이 로봇 지도와 달라 실행하지 않았습니다.', FLOOR_TRANSITION_UNSUPPORTED: '여러 층을 지나는 시나리오는 아직 실행할 수 없습니다.',
  PLAN_UNAVAILABLE: '시나리오 자료를 받지 못해 실행하지 않았습니다.', MAP_PROOF_UNAVAILABLE: '이 지도로는 시나리오를 실행할 수 없습니다 — 지도 원본을 증명할 수 없는 판입니다(사람이 고친 판 등).',
};
const RESULT: Record<string, string> = { ACCEPTED: '조종권을 넘겼습니다.', DECLINED: '조종권 요청을 거절했습니다.', TIMEOUT: '조종권 요청이 시간이 지나 거절됐습니다.', CANCELED: '조종권 요청이 취소됐습니다.' };
/** 닫기 코드(§13.6) → 문구. 4401·4403 은 새 출입증 전 자동 재연결하지 않는다 */
export function closeText(code: number) {
  const t = code === 4401 ? '출입증이 만료됐거나 로봇이 연결을 확인하지 못했습니다.'
    : code === 4403 ? '로봇이 출입증을 거절했습니다. 다른 창·기기에서 이미 연결했거나 출입증이 이 로봇과 맞지 않습니다.'
    : code === 4406 ? '앱과 로봇의 통신 판이 맞지 않습니다.'
    : code === 1013 ? '로봇이 지금 연결을 받을 수 없습니다. 잠시 뒤 다시 연결하세요.'
    : code === 1012 || code === 1007 || code === 1003 || code === 1009 ? '로봇이 잘못된 메시지로 보고 연결을 닫았습니다.'
    : '로봇 연결이 끊겼습니다.';
  return `${t}(${code}) 로봇은 입력이 끊기면 스스로 멈춥니다.`;
}

function send(m: Record<string, unknown>, wait?: (ok: boolean, r?: PhoneReply) => void) {
  if (!ws || ws.readyState !== 1 || !S.robot) return false;
  const id = `p${++ids}`;
  if (wait) replies.set(id, wait);
  ws.send(JSON.stringify({ t: m.t, id, robot: S.robot.robot_id, ...m }));
  return true;
}
/** 연속 모드 전후·옆 조이스틱 데드존(입력 비율 — 속도 값이 아님) */
export const DEAD = 0.1;
/** 왼쪽 조이스틱 축 고정: 작은 축이 큰 축의 이 비율 미만이면 0 — 10-25 실폰 앞 밀기 옆 흔들림 |옆| ≤ 0.25(vy ≤ 0.05)·|전후| ≥ 0.5 */
export const AXIS_LOCK = 0.5;
/** 시뮬 회전 문턱: 에이전트가 wz 를 0·±wz_max 로만 받아(simulation_velocity) 이 기울기 넘으면 ±wz_max, 아니면 0 */
export const TURN_ON = 0.5;
/** 시뮬 눌린 데드존 wz: 에이전트 회전 문턱(±0.5 rad/s) 훨씬 아래라 돌지 않고, 정확한 0 이 아니라 손 뗌으로 보지 않음 */
export const NUDGE = 0.001;
/** [전후, 회전, 옆(왼쪽 +)] -1..1. 옆은 없으면 0 */
export type Axes = [number, number, number?];
/** 조이스틱(-1..1)을 로봇이 준 허용 범위로 자른다(ADR §3.3). 후진·옆은 범위가 0 이면 0(실기).
 *  연속 모드(시뮬 limits.vx_mode)는 데드존 밖 앞 기울기 t 를 vx_min_moving + (vx_max − vx_min_moving)·t 로(02 F-TO-05),
 *  뒤(vx_min < 0 일 때만)도 같은 식으로 vx_min 까지. 옆은 데드존 밖 기울기에 비례해 vy_max·vy_min 까지.
 *  옆 범위가 있을 때만 축 고정(AXIS_LOCK), 연속 모드 회전은 TURN_ON 넘으면 ±wz_max — 실기 limits 는 식 그대로 */
export function velocity([f0, t, y0 = 0]: Axes, w: PhoneWelcome) {
  const s = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v >= 0 ? v * hi : -v * lo));
  const L = w.limits, lo = L.vx_min_moving ?? L.vx_min, side = L.vy_max > 0 || L.vy_min < 0;
  const f = side && Math.abs(f0) < AXIS_LOCK * Math.abs(y0) ? 0 : f0, y = side && Math.abs(y0) < AXIS_LOCK * Math.abs(f0) ? 0 : y0;
  const turn = L.vx_mode !== 'continuous' ? s(t, L.wz_min, L.wz_max) : t >= TURN_ON ? L.wz_max : t <= -TURN_ON ? L.wz_min : 0;
  const past = (v: number) => (Math.abs(v) - DEAD) / (1 - DEAD);   // 데드존 밖 비율(데드존 밖에서만 부름)
  const ramp = (v: number, hi: number) => { const m = Math.min(lo, hi); return m + (hi - m) * past(v); };
  const vx = L.vx_mode !== 'continuous' ? s(f, L.vx_min, L.vx_max)
    : f > DEAD ? ramp(f, L.vx_max) : f < -DEAD && L.vx_min < 0 ? -ramp(f, -L.vx_min) : 0;
  const vy = y > DEAD ? L.vy_max * past(y) : y < -DEAD ? L.vy_min * past(y) : 0;
  // 제자리 회전(전후·옆 0)은 turn_in_place 허가가 있을 때만 — 없으면 wz 0 을 보낸다(안내는 화면)
  const spin = allowed(w).spin, wz = vx === 0 && vy === 0 && !spin ? 0 : turn;
  // 시뮬(제자리 회전 허가)은 스틱이 눌려 있으면 정확한 0 을 보내지 않는다 — 에이전트는 정확한 0 만 새 중립으로 받아(simulation_velocity) deadman 뒤 손 뗌 관문이 풀린다.
  // 움직이지 않는 입력은 에이전트가 0 + 이유로 자르는 작은 wz 로: 문턱 아래 단독 회전은 원래 값, 데드존은 NUDGE. 허가 없는 limits 는 wz 를 보내지 않는다(PR #88 B1, 기존대로)
  if (L.vx_mode === 'continuous' && spin && vx === 0 && vy === 0 && wz === 0 && (f0 || t || y0)) return { vx, vy, wz: s(t, L.wz_min, L.wz_max) || NUDGE };
  return { vx, vy, wz };
}
/** limits 가 허용하는 방향(화면은 이 값만 본다 — 숫자를 박지 않음). 제자리 회전은 시뮬 limits.experimental 에 turn_in_place 가 있을 때만 */
export function allowed(w: PhoneWelcome | null) {
  const L = w?.limits, exp = L?.experimental ?? [];
  return { back: !!L && L.vx_min < 0, left: !!L && L.vy_max > 0, right: !!L && L.vy_min < 0, spin: exp.includes('turn_in_place'), experimental: exp.length > 0 };
}
/** 50 ms 박자: 조종권이 있으면 cmd(중립 0 포함), 1 s 마다 ping(§13.1 — cmd 가 ping 을 대신하지 않음) */
function beat() {
  const l = S.link;
  if (!l || l.at !== 'open' || !l.welcome) return;
  if (l.lease && !runMoving(l.run)) send({ t: 'cmd', lease_id: l.lease, seq: ++seq, ...velocity(l.st?.latched === false ? axes : [0, 0], l.welcome) });
  if (tick++ % (PING_MS / CMD_MS) === 0) send({ t: 'ping', client_time_ms: Date.now() });
  if (l.ask && l.ask.until < now()) setLink({ ask: null });
}
function onHide() { if (document.visibilityState === 'hidden') sim.release(); }   // 숨기면 0 + 반납(F-TO-03, 보기 연결은 남김)

function drop(code: number) {
  clearInterval(timer); timer = 0; document.removeEventListener('visibilitychange', onHide);
  replies.forEach((f) => f(false)); replies.clear();
  const c = cam; cam = null; c?.close();
  media.reset();   // 관측 영상은 부모 연결에 묶임 — 끊기면 닫고 비운다
  const w = ws; ws = null;
  if (w && w.readyState < 2) { w.onclose = null; w.close(1000); }
  axes = [0, 0];
  const r = S.link?.run;   // 실행을 건 연결이 끊기면 에이전트가 일시정지(LINK_LOST) — 그때부터 자동 취소 시간을 센다
  if (runMoving(r) && own?.run_id === r!.run_id) pausedAt = { run_id: r!.run_id, at: now() };
  if (code === 1013) { backoff = Math.min(8000, backoff ? backoff * 2 : 1000); S.retryAt = now() + backoff; }   // 1 s 부터 늘림(§13.6)
  setLink({ at: 'closed', lease: null, busy: '', ask: null, code, why: closeText(code), cam: S.link?.cam === 'off' ? 'off' : 'lost' });
}
function onMsg(raw: string) {
  let m: { t?: string; [k: string]: unknown };
  try { m = JSON.parse(raw); } catch { return; }
  const l = S.link; if (!l) return;
  if (m.t === 'hello') {
    backoff = 0;
    setLink({ at: 'open', welcome: m as unknown as PhoneWelcome });
    set({ step: 'drive' });
    media.offer((m as { media?: unknown }).media, S.robot!.agent_address);   // 형상 검사는 media.ts — 틀리면 받지 않음
    openCamera(media.has('rgb') ? null : m.camera_token as string | null);   // RGB 를 media/1 로 받으면 옛 카메라 경로는 열지 않는다(같은 영상 두 번 0)
  } else if (m.t === 'reply') {
    const r = m as unknown as PhoneReply, f = replies.get(r.id);
    replies.delete(r.id);
    setLink({ busy: '', ...(r.lease_id ? { lease: r.lease_id } : {}), ...(r.ok ? {} : { notice: ERR[r.error?.code ?? ''] ?? `요청을 처리하지 못했습니다(${r.error?.code}).` }) });
    f?.(r.ok, r);   // 안내를 고쳐 쓸 수 있게 기본 안내 뒤에 부른다
  } else if (m.t === 'cmd.ack') {
    if (!!m.clipped !== l.clipped) setLink({ clipped: !!m.clipped });
  } else if (m.t === 'state') {
    const st = m as unknown as PhoneState, echo = st.echo, fresh = echo && echo.id !== lastEcho;   // 같은 echo 는 10 Hz 로 되풀이 — 새 짝일 때만 왕복 시간
    if (fresh) lastEcho = echo.id;
    // 반납 답 전의 옛 state 로 lease 를 되살리지 않음
    setLink({ st, stAt: now(), lease: l.busy === 'release' ? null : st.lease_id, rtt: fresh ? Date.now() - echo.client_time_ms : l.rtt,
      run: st.run === undefined ? l.run : seeRun(st.run) });   // run 이 없는 옛 에이전트면 그대로
    // 같은 연결에서 이 STOP 뒤 세대(stop_gen > g0)의 잠금을 받은 뒤 latched=false 가 와야 STOP 안내를 지운다. 옛 세대·옛 연결의 보고로는 지우지 않는다
    const p = S.stop;
    if (p?.conn === gen && st.stop_gen > p.g0!) { if (st.latched && !p.latched) set({ stop: { ...p, latched: true } }); else if (st.latched === false && p.latched) set({ stop: null }); }
  } else if (m.t === 'run.update') {
    const { t: _, ...r } = m as unknown as RunSnapshot & { t: string };
    setLink({ run: seeRun(r), ...(RUN_END.includes(r.status) ? { arrived: '' } : {}) });
  } else if (m.t === 'event' && (m.code === 'RUN_WAYPOINT_ARRIVED' || m.code === 'RUN_WAYPOINT_RECORDED')) {
    const d = m.data as { run_id?: string; idx?: number; mission_name?: string } | undefined;
    if (d && d.run_id === l.run?.run_id && typeof d.idx === 'number')
      setLink({ arrived: `지점 ${d.idx + 1} 도착 · ${d.mission_name ?? '임무'}${m.code === 'RUN_WAYPOINT_RECORDED' ? ' — 표시·기록만 했습니다(실제 작업 없음)' : ''}` });
  } else if (m.t === 'lease.requested') {
    setLink({ ask: { id: m.request_id as string, until: now() + 10_000 } });
  } else if (m.t === 'lease.result') {
    setLink({ ask: null, notice: RESULT[m.result as string] ?? '' });
  }
}
/** 영상(§13.8): 같은 포트 /phone/camera/ws, 첫 프레임 camera.hello. 끊겨도 조종·STOP 에는 영향 없음, 다시 열려면 새 연결 */
function openCamera(token: string | null) {
  if (!token || !S.robot) return setLink({ cam: 'off' });
  const url = phoneUrl(S.robot.agent_address, location, 'camera');
  if (!url) return setLink({ cam: 'lost' });
  const robot = S.robot.robot_id, c = new WebSocket(url);
  cam = c;
  c.onopen = () => c.send(JSON.stringify({ t: 'camera.hello', robot, token }));
  c.onmessage = (e: { data?: string }) => {
    if (cam !== c) return;
    try {
      const f = JSON.parse(String(e.data));
      if (f.t === 'camera.frame' && f.mime === 'image/jpeg' && typeof f.jpeg === 'string') setLink({ cam: 'frame', img: `data:image/jpeg;base64,${f.jpeg}` });
      else if (f.t === 'camera.status') setLink({ cam: 'none' });
    } catch { /* 깨진 프레임은 버린다 */ }
  };
  c.onclose = () => { if (cam === c) { cam = null; setLink({ cam: 'lost' }); } };
}
const message = (e: unknown) => (e instanceof ApiFail ? e.message : '요청을 처리하지 못했습니다.');
const notCreated = (e: ApiFail) => e.status === 503 && e.code === 'SIM_UNAVAILABLE'
  && e.detail?.reason === 'resources_low' && e.detail.start_not_created === true;
/** 서버가 증명한 시작 전 거부만 다시 띄우기 안내를 준다. */
function simulationMessage(e: unknown): string | undefined {
  if (!(e instanceof ApiFail)) return;
  if (e.code === 'SIM_DISABLED') return '시뮬 관리자 연결 설정이 없습니다. 관리자에게 설정을 요청하세요.';
  if (e.code === 'SIM_RECOVERY_UNPROVEN') return '남은 시뮬이 없는지 확인하지 못해 자리를 보존했습니다. 관리자를 다시 켠 뒤 정리하세요. 이전 관리자 기록이 없으면 관리자에게 문의하세요.';
  const reason = e.detail?.reason as SimFailureDetail['reason'] | undefined;
  if (reason === 'resources_low') return notCreated(e)
    ? 'PC 자원이 부족해 시뮬을 띄우지 않았습니다(메모리·부하). 잠시 뒤 다시 띄우세요.'
    : 'PC 자원이 부족합니다(메모리·부하). 시뮬이 떴는지 다시 확인하거나 정리하세요.';
  if (reason === 'manager_unreachable') return '시뮬 관리자가 꺼져 있습니다. 관리자를 다시 켠 뒤 정리하세요.';
  if (reason === 'slot_busy') return e.message;
}

export const sim = {
  get: () => S,
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  /** 조종 화면 조이스틱 값. 손을 떼면 [0,0] */
  axes(v: Axes) { axes = v; },
  /** PC «시뮬» 탭이 열고 닫을 때 — 다음 출입증 요청부터 surface 를 싣는다 */
  pc(on: boolean) { surface = on ? 'pc' : undefined; },
  /** 월드·내 시뮬 로봇 목록. 내 로봇 목록을 이번에 받았으면 true */
  async load() {
    const g = gen, e0 = epoch;
    const [c, r] = await Promise.allSettled([api.simWorlds(), api.simRobots()]);
    if (g !== gen || e0 !== epoch) return false;
    const completed = r.status === 'fulfilled' && S.robot && r.value.expired?.some((x) =>
      x.robot_id === S.robot!.robot_id && x.generation === S.robot!.generation && x.owner_id === S.robot!.owner_id);
    if (completed && (S.step === 'drive' || S.step === 'linking' || S.step === 'checking')) {
      sim.close();
      set({ ...blank(), catalog: c.status === 'fulfilled' ? c.value : S.catalog,
        mine: r.status === 'fulfilled' ? r.value.items : [], listed: true,
        err: '시간이 다 되어 시뮬을 끝냈습니다 — 다시 띄우기' });
      return true;
    }
    const managerError = r.status === 'fulfilled' ? r.value.manager_error ?? null : 'SIM_UNAVAILABLE';
    const e = c.status === 'rejected' ? simulationMessage(c.reason) ?? `시뮬 월드 목록을 받지 못했습니다. ${message(c.reason)}`
      : r.status === 'rejected' ? simulationMessage(r.reason) ?? `내 시뮬 로봇 목록을 받지 못했습니다. ${message(r.reason)}`
      : managerError === 'SIM_DISABLED' ? '시뮬 관리자 연결 설정이 없습니다. 관리자에게 설정을 요청하세요.'
      : managerError ? '시뮬 관리자에 연결하지 못했습니다. 관리자가 켜져 있는지와 연결을 확인한 뒤 정리하세요.' : '';
    // 목록 오류만 지운다 — 띄우기 거부·정리 확인 실패 문구는 남김
    set({ catalog: c.status === 'fulfilled' ? c.value : S.catalog, mine: r.status === 'fulfilled' ? r.value.items : S.mine, listed: r.status === 'fulfilled' || S.listed,
      cleanup: r.status === 'fulfilled' ? r.value.cleanup ?? [] : S.cleanup, managerError,
      err: e || (S.err === loadErr ? '' : S.err) });
    const current = S.robot;
    const latest = current && S.mine.find((x) => x.robot_id === current.robot_id
      && x.generation === current.generation && x.owner_id === current.owner_id);
    if (r.status === 'fulfilled' && latest && current) set({ robot: { ...current, state: latest.state,
      expires_at: latest.expires_at, remaining_s: latest.remaining_s }, runtimeUntil: runtimeUntil(latest) });
    if (current && S.runtimeUntil !== null && S.runtimeUntil <= now()
      && (S.step === 'drive' || S.step === 'linking') && S.mine.some((x) => x.robot_id === current.robot_id
        && x.generation === current.generation && x.owner_id === current.owner_id && x.state === 'ERROR')) {
      sim.close();
      set({ step: 'checking', err: '시간이 다 되었지만 정리를 확인하지 못했습니다. 다시 끝내기를 누르세요.' });
    }
    loadErr = e;
    return r.status === 'fulfilled' && !managerError;
  },
  /** 띄우기: 남이 쓰는 것으로 확인한 슬롯을 뺀 첫 슬롯 1개만(자동으로 다음 슬롯을 시도하지 않음). 요청 슬롯은 답 전에 robot 에 둔다(STOP·정리 대상).
   *  201 = ACTIVE → 바로 연결. §13.9 확실한 거부 목록 = 고르기로. SIM_SLOT_BUSY = «확인 중» + 목록으로 내 것인지(recheck).
   *  그 밖(답 없음·5xx·목록 밖 4xx) = 불확실(서버 STARTING 일 수 있음 — «확인 중», 정리는 DELETE).
   *  답 전에 화면 세션이 끝났으면(clear) 연결하지 않고, 같은 로그인 세션이면 생긴(또는 불확실한) 로봇만 DELETE 로 정리한다 */
  async start(world: string, user = me, spawn_floor_id?: 'l1' | 'l2') {
    const slots = S.catalog?.slots ?? [], slot = slots.find((x) => !S.taken.includes(x)) ?? slots[0];
    if (!slot) return set({ err: '띄울 수 있는 시뮬 슬롯이 없습니다.' });
    me = user; cancel = false;
    const e0 = epoch, mark = authMark(), placeholder = { robot_id: slot, world_id: world } as SimRobot;
    set({ step: 'starting', robot: placeholder, since: now(), err: '', stop: null, slotBusy: false });
    let r: SimRobot | null = null, fail: unknown = null;
    try { r = await api.simStart({ world_id: world, robot_id: slot, ...(spawn_floor_id && { spawn_floor_id }) }); } catch (e) { fail = e; }
    const f = fail instanceof ApiFail ? fail : null, sure = !!f && (REJECTED.has(`${f.status} ${f.code}`) || notCreated(f)), busy = f?.status === 409 && f.code === 'SIM_SLOT_BUSY';
    if (e0 !== epoch) {   // 세션이 끝난 뒤 온 답 — 연결하지 않음. 남의 것일 수 있는 SLOT_BUSY·다른 로그인 세션이면 손대지 않음
      if (!sure && !busy && mark === authMark()) api.simEnd(slot).catch(() => {});
      return;
    }
    if (sure) { set({ step: 'pick', robot: null, stop: null, err: simulationMessage(f) ?? `시뮬 로봇을 띄우지 못했습니다. ${f!.message}` }); sim.load(); return; }
    if (busy) { set({ step: 'unsure', slotBusy: true, busyWhy: f!.message, err: `${f!.message} 내 시뮬 로봇인지 목록으로 확인합니다.` }); return sim.recheck(); }
    if (r) set({ robot: r, runtimeUntil: runtimeUntil(r) });
    if (cancel) return sim.end();   // 띄우는 중 STOP — 생겼거나 불확실한 그 슬롯을 DELETE 1회
    if (!r) { set({ step: 'unsure', err: simulationMessage(fail) ?? `시뮬 로봇이 떴는지 확인하지 못했습니다. ${message(fail)}` }); sim.load(); return; }
    sim.connect(); sim.load();
  },
  /** «확인 중» 다시 확인. SLOT_BUSY 면 목록으로 내 것인지 정한다: 내 것 = 고르기(위 목록에서 연결·끝내기, STOP 뒤면 바로 정리),
   *  아니면 «사용 중»으로 표시하고 사람이 다시 고른다. 목록을 못 받으면 «확인 중» 그대로 */
  async recheck() {
    const slot = S.robot?.robot_id, ok = await sim.load();
    if (!ok || S.step !== 'unsure' || !S.slotBusy || S.robot?.robot_id !== slot || !slot) return;
    const it = S.mine.find((x) => x.robot_id === slot && (!me || x.owner_id === me));
    const cleanup = S.cleanup.find((x) => x.robot_id === slot && (!me || x.owner_id === me));
    if (it && cancel) return sim.end(it);
    if (cleanup && cancel) return sim.cleanupSlot(cleanup);
    if (cleanup) { set({ step: 'pick', robot: null, slotBusy: false, stop: null, err: '이전 시뮬이 정리되지 않았습니다 — 아래 정리를 누르세요.' }); return; }
    const taken = [...S.taken, slot], more = S.catalog?.slots.some((x) => !taken.includes(x));
    set(it ? { step: 'pick', robot: null, slotBusy: false, stop: null, err: '이 슬롯은 이미 내 시뮬 로봇입니다. 위에서 연결하거나 끝내세요.' }
      : { step: 'pick', robot: null, slotBusy: false, stop: null, taken, err: `${S.busyWhy} ${more ? '띄우기를 다시 누르면 다른 슬롯을 시도합니다.' : '사용이 끝난 뒤 다시 누르세요.'}` });
  },
  /** 이미 떠 있는 내 시뮬 로봇에 다시 붙기 */
  attach(r: SimRobot) { set({ robot: r, runtimeUntil: runtimeUntil(r), err: '', stop: null }); return sim.connect(); },
  /** 관리자가 연결 주소를 확인하지 못한 DB 슬롯에는 DELETE만 제공한다. */
  cleanupSlot(r: SimCleanupSlot) { return sim.end({ robot_id: r.robot_id } as SimRobot); },
  /** 새 출입증 → 에이전트에 직접 hello. 출입증은 hello 에만 싣고 버린다 */
  async connect() {
    const r = S.robot; if (!r || now() < S.retryAt) return;
    sim.close();
    const g = gen, url = phoneUrl(r.agent_address, location);
    set({ step: S.step === 'drive' ? 'drive' : 'linking', link: { at: 'connecting', welcome: null, st: null, stAt: 0, lease: null, why: '', code: 0, notice: '', busy: '', clipped: false, rtt: null, cam: 'wait', img: '', ask: null, exp: 0, run: null, arrived: '', navOff: false } });
    if (!url) return setLink({ at: 'closed', why: '로봇 연결 주소가 올바르지 않습니다.' });
    let pass;
    try { pass = await api.phonePass(r.robot_id, { device: deviceId(), purpose: 'control', ...(surface && { surface }) }); } catch (e) {
      if (g !== gen) return;
      const ra = e instanceof ApiFail && e.status === 429 ? Number(e.detail?.retry_after) : 0;   // 429 는 retry_after(초)보다 일찍 다시 받지 않음(§13.7 D13)
      if (ra > 0) S.retryAt = now() + ra * 1000;
      // 403 WEB_SIM_ONLY = 서버가 이 로봇에 웹 시뮬 출입증을 주지 않음(simulation 꺼짐). 서버 문구 그대로, 화면은 «다시 연결»을 내지 않는다(code 403)
      if (e instanceof ApiFail && e.status === 403 && e.code === 'WEB_SIM_ONLY') return setLink({ at: 'closed', code: 403, why: e.message });
      setLink({ at: 'closed', why: `출입증을 받지 못했습니다. ${message(e)}` });
      return;
    }
    if (g !== gen) return;
    setLink({ exp: pass.exp });
    const w = new WebSocket(url), ticket = pass.token;
    ws = w; seq = 0; tick = 0;
    w.onopen = () => {
      if (ws !== w) return;
      w.send(JSON.stringify({ t: 'hello', id: `p${++ids}`, robot: r.robot_id, proto: 'fh-phone/1', device: deviceId(), ticket }));
      timer = window.setInterval(beat, CMD_MS);
      document.addEventListener('visibilitychange', onHide);
    };
    w.onmessage = (e: { data?: string }) => { if (ws === w) onMsg(String(e.data)); };
    w.onclose = (e: { code?: number }) => { if (ws === w) drop(e.code ?? 1006); };
  },
  /** 연결만 닫음(로봇은 입력이 끊겨 스스로 0) */
  close() { gen++; if (ws || cam || timer) drop(1000); },
  take() { if (send({ t: 'lease.take' })) setLink({ busy: 'take', notice: '' }); },
  /** 명시 해제(현재 stop_gen). 성공 답은 해제 확인이 아니다 — state.latched=false 를 본다 */
  unlock() { const l = S.link; if (l?.lease && l.st && send({ t: 'unlock', lease_id: l.lease, stop_gen: l.st.stop_gen })) setLink({ busy: 'unlock', notice: '' }); },
  /** 0 + 반납(보기는 남음). 보내면서 lease 를 먼저 비운다(옛 lease 로 cmd 를 더 보내지 않음). 답을 기다릴 수 있게 Promise */
  release() {
    axes = [0, 0];
    return new Promise<boolean>((done) => { if (!S.link?.lease || !send({ t: 'lease.release' }, done)) done(false); else setLink({ busy: 'release', lease: null }); });
  },
  /** 시나리오 실행 시작(05 §13.10.2): 조종권·잠금 해제·중립 뒤. 지점은 참조만(고정 판·층·지도 판) — 에이전트가 서버에서 그 판을 받는다.
   *  성공 답의 이어서 비밀값은 이 화면 메모리에만 둔다 */
  runStart(sc: Scenario, floor: SimWorldFloor) {
    const l = S.link; if (!l?.lease) return;
    axes = [0, 0];
    const run_id = crypto.randomUUID();
    setLink({ busy: 'run', notice: '', arrived: '' });   // 답보다 먼저(답이 busy 를 비운다)
    if (!send({ t: 'run.start', lease_id: l.lease, run_id, screen_id: screenId(), scenario_id: sc.id, scenario_version: sc.version,
      floor_id: floor.floor_id, map_version_id: floor.map_version_id }, (ok, r) => {
      if (ok && r?.detail?.run_id === run_id && r.detail.resume_token) own = { run_id, token: r.detail.resume_token };
      if (!ok && r?.error?.code === 'NAV_UNAVAILABLE') setLink({ navOff: true });
    })) setLink({ busy: '' });
  },
  /** 일시정지·이어서 = 이 화면이 건 실행만(조종권·화면 id, 이어서는 비밀값 — 답의 새 비밀값으로 바꾼다).
   *  취소 = 화면 id·비밀값 없이(일시정지 중 담당자·총괄 권한은 에이전트가 출입증으로 판정) */
  runControl(op: 'pause' | 'resume' | 'abort') {
    const l = S.link, r = l?.run, mine = !!r && own?.run_id === r.run_id;
    if (!r || (op !== 'abort' && (!mine || !l.lease))) return;
    if (op === 'resume') axes = [0, 0];
    const body = op === 'abort' ? {} : { lease_id: l.lease, screen_id: screenId(), ...(op === 'resume' && { resume_token: own!.token }) };
    setLink({ busy: 'run', notice: '' });
    if (!send({ t: 'run.control', run_id: r.run_id, op, ...body }, (ok, x) => {
      if (ok && op === 'resume' && x?.detail?.resume_token && own?.run_id === r.run_id) own = { run_id: r.run_id, token: x.detail.resume_token };
      if (!ok && op === 'abort' && x?.error?.code === 'FORBIDDEN') setLink({ notice: '이 실행을 취소할 권한이 없습니다. 일시정지 중일 때 로봇 담당자·총괄만 취소할 수 있습니다.' });
    })) setLink({ busy: '' });
  },
  /** 이 화면이 건 실행인가(이어서 비밀값을 가짐) */
  runMine: (r: RunSnapshot | null | undefined) => !!r && own?.run_id === r.run_id,
  /** 자동 취소까지 남은 초(어림 — 이 화면이 일시정지를 본 때부터. 계약에 마감 필드 없음) */
  pauseLeft: (r: RunSnapshot) => (pausedAt?.run_id === r.run_id ? Math.max(0, Math.ceil(PAUSE_S - (now() - pausedAt.at) / 1000)) : null),
  /** 끝난 실행 안내 내리기 */
  dismiss(id: string) { dismissed = id; emit(); },
  dismissed: (id: string) => dismissed === id,
  respond(accept: boolean) { const a = S.link?.ask; if (a && send({ t: 'lease.respond', request_id: a.id, accept })) setLink({ ask: null }); },
  /** 지금 STOP 이 갈 시뮬 로봇 — 고르기 밖 모든 단계(띄우는 중·확인 중 포함). 있으면 머리줄 STOP 은 다른 로봇(rt)으로 가지 않는다 */
  live: () => (S.robot && S.step !== 'pick' ? S.robot : null),
  /** STOP: 직결(hello 끝남)이면 에이전트에 직접(보기 연결도 됨). 연결 전·끊김·확인 중이면 로봇에 보낼 길이 없다 —
   *  서버 STOP 대체 경로는 쓰지 않고(ADR-002 §5) 그 슬롯을 정리: 띄우는 중이면 POST 답이 오는 즉시, 그 밖은 지금 DELETE 1회(끝내는 중이면 이미 보냄) */
  stop() {
    if (!sim.live()) return;
    axes = [0, 0];
    if (S.link?.welcome && send({ t: 'stop' })) return set({ stop: { at: now(), via: 'agent', g0: S.link.st?.stop_gen ?? -1, conn: gen } });
    set({ stop: { at: now(), via: 'cleanup' } });
    if (S.step === 'starting') cancel = true;
    else if (S.slotBusy) { cancel = true; sim.recheck(); }   // 남의 로봇일 수 있어 내 것으로 확인된 뒤에만 정리
    else if (S.step !== 'ending') sim.end();
  },
  /** 끝내기: 0·반납(답 2 s 까지) → 연결 닫기 → DELETE → 204 면 IDLE. 실패·불확실은 «확인 중» + 목록 다시 */
  async end(r = S.robot) {
    if (!r || S.step === 'ending') return;
    const e0 = epoch;
    cancel = false;
    set({ step: 'ending', robot: r, err: '', slotBusy: false });
    if (S.link?.lease) await Promise.race([sim.release(), new Promise((f) => setTimeout(f, 2000))]);
    if (e0 !== epoch) return;
    sim.close();
    try {
      await api.simEnd(r.robot_id);
      if (e0 !== epoch) return;
      set({ ...blank(), catalog: S.catalog, err: '' });
      await sim.load();
      set({ err: S.mine.some((x) => x.robot_id === r.robot_id) ? '정리 요청은 끝났지만 목록에 아직 보입니다. 잠시 뒤 다시 확인하세요.' : '시뮬 로봇을 정리했습니다.' });
    } catch (e) {
      if (e0 !== epoch) return;
      set({ step: 'checking', err: simulationMessage(e) ?? `정리를 확인하지 못했습니다. ${message(e)}` });
      sim.load();
    }
  },
  /** 처음(고르기)으로 — 연결은 닫는다 */
  reset() { sim.close(); cancel = false; set({ ...blank(), catalog: S.catalog, mine: S.mine, cleanup: S.cleanup, listed: S.listed, taken: S.taken }); sim.load(); },
  /** 화면 세션 끝(로그아웃·화면 내림)·시험: 연결을 닫고 비운다. 진행 중인 띄우기·끝내기의 늦은 답은 이 상태를 건드리지 않는다 */
  clear() { epoch++; sim.close(); backoff = 0; cancel = false; screen = ''; own = pausedAt = null; dismissed = ''; S = blank(); emit(); },
};
export const useSim = () => useSyncExternalStore(sim.subscribe, sim.get);

// 폰 ↔ 시뮬 로봇 직결(09 ADR-002 §3·§5·§6, 05 API §13 fh-phone/1·§13.7 출입증·§13.8 카메라·§13.9 시뮬 중계).
// 띄우기·정리·출입증은 관제 서버 REST(api.ts), 조종·STOP·영상은 그 로봇 에이전트 폰 포트에 직접 WS — 서버 실시간(rt.ts) 조종 경로를 쓰지 않는다.
// 조종권·잠금·deadman 판정은 에이전트. 폰은 요청만 보내고 state 로 확인한다: 자동 취득·자동 해제·자동 재연결 없음.
import { useSyncExternalStore } from 'react';
import type { PhoneState, PhoneWelcome, SimCatalog, SimCleanupSlot, SimFailureDetail, SimRobot, SimRobotList } from '../../contracts/ts';
import { ApiFail, api, authMark } from './api';

/** pick 고르기 · starting 띄우는 중 · unsure 시작 확인 안 됨(서버 STARTING 일 수 있음) · linking 출입증·연결 · drive 조종 화면 · ending 끝내는 중 · checking 정리 확인 안 됨 */
export type Step = 'pick' | 'starting' | 'unsure' | 'linking' | 'drive' | 'ending' | 'checking';
type Cam = 'wait' | 'frame' | 'none' | 'lost' | 'off';
export type Link = {
  at: 'connecting' | 'open' | 'closed'; welcome: PhoneWelcome | null; st: PhoneState | null; stAt: number; lease: string | null;
  /** 닫힌 이유(사람 문구)·닫기 코드 */
  why: string; code: number;
  /** 요청 실패·조종권 알림 한 줄 */
  notice: string; busy: '' | 'take' | 'unlock' | 'release';
  /** 마지막 cmd.ack 가 잘렸는지(«명령 범위 조정») */
  clipped: boolean; rtt: number | null; cam: Cam; img: string;
  /** 다른 사람의 조종권 요청(내가 조종자일 때) */
  ask: { id: string; until: number } | null;
  /** 출입증 만료(UTC 초) */
  exp: number;
};
export type Sim = {
  step: Step; catalog: SimCatalog | null; mine: SimRobot[]; listed: boolean; err: string; robot: SimRobot | null; since: number; link: Link | null;
  /** STOP: agent = 에이전트에 직접 보냄, cleanup = 로봇에 연결 전이라 명령 없이 그 슬롯을 정리(서버 STOP 경로는 쓰지 않음 — ADR-002 §5) */
  stop: { at: number; via: 'agent' | 'cleanup' } | null;
  /** 이 시각(단조) 전에는 다시 연결하지 않는다(1013 뒤 늘리는 간격·출입증 429 retry_after) */
  retryAt: number;
  /** unsure 가 SIM_SLOT_BUSY 때문(남의 로봇일 수 있어 목록으로 내 것인지 먼저 확인) · 남이 쓰는 것으로 확인한 슬롯 */
  slotBusy: boolean; busyWhy: string; taken: string[]; cleanup: SimCleanupSlot[]; managerError: SimRobotList['manager_error'];
};

export const CMD_MS = 50, PING_MS = 1000;
const now = () => performance.now();
const blank = (): Sim => ({ step: 'pick', catalog: null, mine: [], cleanup: [], managerError: null, listed: false, err: '', robot: null, since: 0, link: null, stop: null, retryAt: 0, slotBusy: false, busyWhy: '', taken: [] });
/** 05 §13.9 시작 전 확실한 거부 (status, code) 고정 목록 — 이 밖(SIM_SLOT_BUSY 포함)은 불확실 */
const REJECTED = new Set(['400 SIM_VALIDATION', '400 SIM_IDENTITY_INVALID', '400 SIM_CREDENTIAL_INVALID', '404 SIM_WORLD_NOT_FOUND', '404 SIM_SLOT_NOT_FOUND',
  '409 SIM_WORLD_BUSY', '409 SIM_OWNER_LIMIT', '409 SIM_NATIVE_SINGLE_ONLY', '409 SIM_ROBOT_LIMIT']);
// gen = 연결 세대(close 마다), epoch = 화면 세션(clear 마다), cancel = 띄우는 중 STOP(POST 답이 오면 바로 정리), me = 내 사용자 id(총괄 목록은 조직 전체라 owner 로 내 것 판정)
let S = blank(), lastEcho = '', ws: WebSocket | null = null, cam: WebSocket | null = null, timer = 0, tick = 0, seq = 0, ids = 0, backoff = 0, gen = 0, epoch = 0, cancel = false, me = '';
let axes: [number, number] = [0, 0];   // [전후, 회전] -1..1, 조종 화면이 넣는다
const replies = new Map<string, (ok: boolean) => void>();
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

function send(m: Record<string, unknown>, wait?: (ok: boolean) => void) {
  if (!ws || ws.readyState !== 1 || !S.robot) return false;
  const id = `p${++ids}`;
  if (wait) replies.set(id, wait);
  ws.send(JSON.stringify({ t: m.t, id, robot: S.robot.robot_id, ...m }));
  return true;
}
/** 조이스틱(-1..1)을 로봇이 준 허용 범위로 자른다(ADR §3.3). 후진·옆은 범위가 0 이라 0 */
export function velocity([f, t]: [number, number], w: PhoneWelcome) {
  const s = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v >= 0 ? v * hi : -v * lo));
  return { vx: s(f, w.limits.vx_min, w.limits.vx_max), vy: 0, wz: s(t, w.limits.wz_min, w.limits.wz_max) };
}
/** 50 ms 박자: 조종권이 있으면 cmd(중립 0 포함), 1 s 마다 ping(§13.1 — cmd 가 ping 을 대신하지 않음) */
function beat() {
  const l = S.link;
  if (!l || l.at !== 'open' || !l.welcome) return;
  if (l.lease) send({ t: 'cmd', lease_id: l.lease, seq: ++seq, ...velocity(l.st?.latched === false ? axes : [0, 0], l.welcome) });
  if (tick++ % (PING_MS / CMD_MS) === 0) send({ t: 'ping', client_time_ms: Date.now() });
  if (l.ask && l.ask.until < now()) setLink({ ask: null });
}
function onHide() { if (document.visibilityState === 'hidden') sim.release(); }   // 숨기면 0 + 반납(F-TO-03, 보기 연결은 남김)

function drop(code: number) {
  clearInterval(timer); timer = 0; document.removeEventListener('visibilitychange', onHide);
  replies.forEach((f) => f(false)); replies.clear();
  const c = cam; cam = null; c?.close();
  const w = ws; ws = null;
  if (w && w.readyState < 2) { w.onclose = null; w.close(1000); }
  axes = [0, 0];
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
    openCamera(m.camera_token as string | null);
  } else if (m.t === 'reply') {
    const r = m as { id: string; ok: boolean; error: { code: string; message?: string } | null; lease_id: string | null };
    replies.get(r.id)?.(r.ok); replies.delete(r.id);
    setLink({ busy: '', ...(r.lease_id ? { lease: r.lease_id } : {}), ...(r.ok ? {} : { notice: ERR[r.error?.code ?? ''] ?? `요청을 처리하지 못했습니다(${r.error?.code}).` }) });
  } else if (m.t === 'cmd.ack') {
    if (!!m.clipped !== l.clipped) setLink({ clipped: !!m.clipped });
  } else if (m.t === 'state') {
    const st = m as unknown as PhoneState, echo = st.echo, fresh = echo && echo.id !== lastEcho;   // 같은 echo 는 10 Hz 로 되풀이 — 새 짝일 때만 왕복 시간
    if (fresh) lastEcho = echo.id;
    // 반납 답 전의 옛 state 로 lease 를 되살리지 않음
    setLink({ st, stAt: now(), lease: l.busy === 'release' ? null : st.lease_id, rtt: fresh ? Date.now() - echo.client_time_ms : l.rtt });
  } else if (m.t === 'lease.requested') {
    setLink({ ask: { id: m.request_id as string, until: now() + 10_000 } });
  } else if (m.t === 'lease.result') {
    setLink({ ask: null, notice: RESULT[m.result as string] ?? '' });
  }
}
/** 영상(§13.8): 같은 포트 /phone/camera/ws, 첫 프레임 camera.hello. 끊겨도 조종·STOP 에는 영향 없음, 다시 열려면 새 연결 */
function openCamera(token: string | null) {
  if (!token || !S.robot) return setLink({ cam: 'off' });
  const robot = S.robot.robot_id, c = new WebSocket(S.robot.agent_address.replace(/\/phone\/ws$/, '/phone/camera/ws'));
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
/** 에이전트 주소는 서버가 준 값 — ws(s)://호스트:포트/phone/ws 꼴만 받는다 */
function agentUrl(a: string) {
  try { const u = new URL(a); return (u.protocol === 'ws:' || u.protocol === 'wss:') && u.pathname === '/phone/ws' && !u.search ? u.href : null; } catch { return null; }
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
  axes(v: [number, number]) { axes = v; },
  /** 월드·내 시뮬 로봇 목록. 내 로봇 목록을 이번에 받았으면 true */
  async load() {
    const g = gen, e0 = epoch;
    const [c, r] = await Promise.allSettled([api.simWorlds(), api.simRobots()]);
    if (g !== gen || e0 !== epoch) return false;
    const managerError = r.status === 'fulfilled' ? r.value.manager_error ?? null : 'SIM_UNAVAILABLE';
    const e = c.status === 'rejected' ? simulationMessage(c.reason) ?? `시뮬 월드 목록을 받지 못했습니다. ${message(c.reason)}`
      : r.status === 'rejected' ? simulationMessage(r.reason) ?? `내 시뮬 로봇 목록을 받지 못했습니다. ${message(r.reason)}`
      : managerError === 'SIM_DISABLED' ? '시뮬 관리자 연결 설정이 없습니다. 관리자에게 설정을 요청하세요.'
      : managerError ? '시뮬 관리자에 연결하지 못했습니다. 관리자가 켜져 있는지와 연결을 확인한 뒤 정리하세요.' : '';
    // 목록 오류만 지운다 — 띄우기 거부·정리 확인 실패 문구는 남김
    set({ catalog: c.status === 'fulfilled' ? c.value : S.catalog, mine: r.status === 'fulfilled' ? r.value.items : S.mine, listed: r.status === 'fulfilled' || S.listed,
      cleanup: r.status === 'fulfilled' ? r.value.cleanup ?? [] : S.cleanup, managerError,
      err: e || (S.err === loadErr ? '' : S.err) });
    loadErr = e;
    return r.status === 'fulfilled' && !managerError;
  },
  /** 띄우기: 남이 쓰는 것으로 확인한 슬롯을 뺀 첫 슬롯 1개만(자동으로 다음 슬롯을 시도하지 않음). 요청 슬롯은 답 전에 robot 에 둔다(STOP·정리 대상).
   *  201 = ACTIVE → 바로 연결. §13.9 확실한 거부 목록 = 고르기로. SIM_SLOT_BUSY = «확인 중» + 목록으로 내 것인지(recheck).
   *  그 밖(답 없음·5xx·목록 밖 4xx) = 불확실(서버 STARTING 일 수 있음 — «확인 중», 정리는 DELETE).
   *  답 전에 화면 세션이 끝났으면(clear) 연결하지 않고, 같은 로그인 세션이면 생긴(또는 불확실한) 로봇만 DELETE 로 정리한다 */
  async start(world: string, user = me) {
    const slots = S.catalog?.slots ?? [], slot = slots.find((x) => !S.taken.includes(x)) ?? slots[0];
    if (!slot) return set({ err: '띄울 수 있는 시뮬 슬롯이 없습니다.' });
    me = user; cancel = false;
    const e0 = epoch, mark = authMark(), placeholder = { robot_id: slot, world_id: world } as SimRobot;
    set({ step: 'starting', robot: placeholder, since: now(), err: '', stop: null, slotBusy: false });
    let r: SimRobot | null = null, fail: unknown = null;
    try { r = await api.simStart({ world_id: world, robot_id: slot }); } catch (e) { fail = e; }
    const f = fail instanceof ApiFail ? fail : null, sure = !!f && (REJECTED.has(`${f.status} ${f.code}`) || notCreated(f)), busy = f?.status === 409 && f.code === 'SIM_SLOT_BUSY';
    if (e0 !== epoch) {   // 세션이 끝난 뒤 온 답 — 연결하지 않음. 남의 것일 수 있는 SLOT_BUSY·다른 로그인 세션이면 손대지 않음
      if (!sure && !busy && mark === authMark()) api.simEnd(slot).catch(() => {});
      return;
    }
    if (sure) { set({ step: 'pick', robot: null, stop: null, err: simulationMessage(f) ?? `시뮬 로봇을 띄우지 못했습니다. ${f!.message}` }); sim.load(); return; }
    if (busy) { set({ step: 'unsure', slotBusy: true, busyWhy: f!.message, err: `${f!.message} 내 시뮬 로봇인지 목록으로 확인합니다.` }); return sim.recheck(); }
    if (r) set({ robot: r });
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
    set(it ? { step: 'pick', robot: null, slotBusy: false, stop: null, err: '이 슬롯은 이미 내 시뮬 로봇입니다. 위 목록에서 직접 연결하거나 끝내세요.' }
      : { step: 'pick', robot: null, slotBusy: false, stop: null, taken, err: `${S.busyWhy} ${more ? '띄우기를 다시 누르면 다른 슬롯을 시도합니다.' : '사용이 끝난 뒤 다시 누르세요.'}` });
  },
  /** 이미 떠 있는 내 시뮬 로봇에 다시 붙기 */
  attach(r: SimRobot) { set({ robot: r, err: '', stop: null }); return sim.connect(); },
  /** 관리자가 연결 주소를 확인하지 못한 DB 슬롯에는 DELETE만 제공한다. */
  cleanupSlot(r: SimCleanupSlot) { return sim.end({ robot_id: r.robot_id } as SimRobot); },
  /** 새 출입증 → 에이전트에 직접 hello. 출입증은 hello 에만 싣고 버린다 */
  async connect() {
    const r = S.robot; if (!r || now() < S.retryAt) return;
    sim.close();
    const g = gen, url = agentUrl(r.agent_address);
    set({ step: S.step === 'drive' ? 'drive' : 'linking', link: { at: 'connecting', welcome: null, st: null, stAt: 0, lease: null, why: '', code: 0, notice: '', busy: '', clipped: false, rtt: null, cam: 'wait', img: '', ask: null, exp: 0 } });
    if (!url) return setLink({ at: 'closed', why: '로봇 연결 주소가 올바르지 않습니다.' });
    let pass;
    try { pass = await api.phonePass(r.robot_id, { device: deviceId(), purpose: 'control' }); } catch (e) {
      if (g !== gen) return;
      const ra = e instanceof ApiFail && e.status === 429 ? Number(e.detail?.retry_after) : 0;   // 429 는 retry_after(초)보다 일찍 다시 받지 않음(§13.7 D13)
      if (ra > 0) S.retryAt = now() + ra * 1000;
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
  respond(accept: boolean) { const a = S.link?.ask; if (a && send({ t: 'lease.respond', request_id: a.id, accept })) setLink({ ask: null }); },
  /** 지금 STOP 이 갈 시뮬 로봇 — 고르기 밖 모든 단계(띄우는 중·확인 중 포함). 있으면 머리줄 STOP 은 다른 로봇(rt)으로 가지 않는다 */
  live: () => (S.robot && S.step !== 'pick' ? S.robot : null),
  /** STOP: 직결(hello 끝남)이면 에이전트에 직접(보기 연결도 됨). 연결 전·끊김·확인 중이면 로봇에 보낼 길이 없다 —
   *  서버 STOP 대체 경로는 쓰지 않고(ADR-002 §5) 그 슬롯을 정리: 띄우는 중이면 POST 답이 오는 즉시, 그 밖은 지금 DELETE 1회(끝내는 중이면 이미 보냄) */
  stop() {
    if (!sim.live()) return;
    axes = [0, 0];
    if (S.link?.welcome && send({ t: 'stop' })) return set({ stop: { at: now(), via: 'agent' } });
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
  clear() { epoch++; sim.close(); backoff = 0; cancel = false; S = blank(); emit(); },
};
export const useSim = () => useSyncExternalStore(sim.subscribe, sim.get);

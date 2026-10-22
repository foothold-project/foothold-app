// 폰 ↔ 시뮬 로봇 직결(09 ADR-002 §3·§5·§6, 05 API §13 fh-phone/1·§13.7 출입증·§13.8 카메라·§13.9 시뮬 중계).
// 띄우기·정리·출입증은 관제 서버 REST(api.ts), 조종·STOP·영상은 그 로봇 에이전트 폰 포트에 직접 WS — 서버 실시간(rt.ts) 조종 경로를 쓰지 않는다.
// 조종권·잠금·deadman 판정은 에이전트. 폰은 요청만 보내고 state 로 확인한다: 자동 취득·자동 해제·자동 재연결 없음.
import { useSyncExternalStore } from 'react';
import type { PhoneState, PhoneWelcome, SimCatalog, SimRobot } from '../../contracts/ts';
import { ApiFail, api } from './api';

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
  stop: { at: number; via: 'agent' | 'server'; failed: string } | null;
  /** 이 시각(단조) 전에는 다시 연결하지 않는다(1013 뒤 늘리는 간격) */
  retryAt: number;
};

export const CMD_MS = 50, PING_MS = 1000;
const now = () => performance.now();
const blank = (): Sim => ({ step: 'pick', catalog: null, mine: [], listed: false, err: '', robot: null, since: 0, link: null, stop: null, retryAt: 0 });
let S = blank(), lastEcho = '', ws: WebSocket | null = null, cam: WebSocket | null = null, timer = 0, tick = 0, seq = 0, ids = 0, backoff = 0, gen = 0;
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
    setLink({ st, stAt: now(), lease: st.lease_id, rtt: fresh ? Date.now() - echo.client_time_ms : l.rtt });
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

export const sim = {
  get: () => S,
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  /** 조종 화면 조이스틱 값. 손을 떼면 [0,0] */
  axes(v: [number, number]) { axes = v; },
  /** 월드·내 시뮬 로봇 목록 */
  async load() {
    const g = gen;
    const [c, r] = await Promise.allSettled([api.simWorlds(), api.simRobots()]);
    if (g !== gen) return;
    const e = c.status === 'rejected' ? `시뮬 월드 목록을 받지 못했습니다. ${message(c.reason)}` : r.status === 'rejected' ? `내 시뮬 로봇 목록을 받지 못했습니다. ${message(r.reason)}` : '';
    // 목록 오류만 지운다 — 띄우기 거부·정리 확인 실패 문구는 남김
    set({ catalog: c.status === 'fulfilled' ? c.value : S.catalog, mine: r.status === 'fulfilled' ? r.value.items : S.mine, listed: r.status === 'fulfilled' || S.listed,
      err: e || (S.err === loadErr ? '' : S.err) });
    loadErr = e;
  },
  /** 띄우기: 빈 슬롯을 차례로(남이 쓰는 슬롯 SIM_SLOT_BUSY 만 다음으로). 201 = ACTIVE → 바로 연결.
   *  4xx = 시작 전 거부(고르기로), 답 없음·5xx = 불확실(서버 STARTING 일 수 있음 — «확인 중», 정리는 DELETE) */
  async start(world: string) {
    const slots = S.catalog?.slots ?? [];
    set({ step: 'starting', since: now(), err: '', stop: null });
    for (const [i, slot] of slots.entries()) {
      try {
        const r = await api.simStart({ world_id: world, robot_id: slot });
        set({ robot: r }); await sim.load(); return sim.connect();
      } catch (e) {
        if (e instanceof ApiFail && e.code === 'SIM_SLOT_BUSY' && i < slots.length - 1) continue;
        if (e instanceof ApiFail && e.status >= 400 && e.status < 500) { set({ step: 'pick', err: `시뮬 로봇을 띄우지 못했습니다. ${e.message}` }); return sim.load(); }
        set({ step: 'unsure', robot: { robot_id: slot, world_id: world } as SimRobot, err: `시뮬 로봇이 떴는지 확인하지 못했습니다. ${message(e)}` });
        return sim.load();
      }
    }
    set({ step: 'pick', err: '띄울 수 있는 시뮬 슬롯이 없습니다.' });
  },
  /** 이미 떠 있는 내 시뮬 로봇에 다시 붙기 */
  attach(r: SimRobot) { set({ robot: r, err: '', stop: null }); return sim.connect(); },
  /** 새 출입증 → 에이전트에 직접 hello. 출입증은 hello 에만 싣고 버린다 */
  async connect() {
    const r = S.robot; if (!r || now() < S.retryAt) return;
    sim.close();
    const g = gen, url = agentUrl(r.agent_address);
    set({ step: S.step === 'drive' ? 'drive' : 'linking', link: { at: 'connecting', welcome: null, st: null, stAt: 0, lease: null, why: '', code: 0, notice: '', busy: '', clipped: false, rtt: null, cam: 'wait', img: '', ask: null, exp: 0 } });
    if (!url) return setLink({ at: 'closed', why: '로봇 연결 주소가 올바르지 않습니다.' });
    let pass;
    try { pass = await api.phonePass(r.robot_id, { device: deviceId(), purpose: 'control' }); } catch (e) {
      if (g === gen) setLink({ at: 'closed', why: `출입증을 받지 못했습니다. ${message(e)}` });
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
  /** 0 + 반납(보기는 남음). 답을 기다릴 수 있게 Promise */
  release() {
    axes = [0, 0];
    return new Promise<boolean>((done) => { if (!S.link?.lease || !send({ t: 'lease.release' }, done)) done(false); else setLink({ busy: 'release' }); });
  },
  respond(accept: boolean) { const a = S.link?.ask; if (a && send({ t: 'lease.respond', request_id: a.id, accept })) setLink({ ask: null }); },
  /** 지금 STOP 이 갈 시뮬 로봇(띄우는 중·연결 중·조종 중) */
  live: () => (S.robot && (S.step === 'linking' || S.step === 'drive' || S.step === 'ending') ? S.robot : null),
  /** STOP: 에이전트에 직접(보기 연결도 됨). 직결이 없으면 서버 대체 경로(§13.7 — 접수일 뿐 정지 확인 아님) */
  stop() {
    const r = S.robot; if (!r) return;
    axes = [0, 0];
    if (S.link?.welcome && send({ t: 'stop' })) return set({ stop: { at: now(), via: 'agent', failed: '' } });
    set({ stop: { at: now(), via: 'server', failed: '' } });
    api.stop(r.robot_id, { ms: 5000 }).catch((e) => { if (S.stop?.via === 'server') set({ stop: { ...S.stop, failed: message(e) } }); });
  },
  /** 끝내기: 0·반납(답 2 s 까지) → 연결 닫기 → DELETE → 204 면 IDLE. 실패·불확실은 «확인 중» + 목록 다시 */
  async end(r = S.robot) {
    if (!r || S.step === 'ending') return;
    set({ step: 'ending', robot: r, err: '' });
    if (S.link?.lease) await Promise.race([sim.release(), new Promise((f) => setTimeout(f, 2000))]);
    sim.close();
    try {
      await api.simEnd(r.robot_id);
      set({ ...blank(), catalog: S.catalog, err: '' });
      await sim.load();
      set({ err: S.mine.some((x) => x.robot_id === r.robot_id) ? '정리 요청은 끝났지만 목록에 아직 보입니다. 잠시 뒤 다시 확인하세요.' : '시뮬 로봇을 정리했습니다.' });
    } catch (e) {
      set({ step: 'checking', err: `정리를 확인하지 못했습니다. ${message(e)}` });
      sim.load();
    }
  },
  /** 처음(고르기)으로 — 연결은 닫는다 */
  reset() { sim.close(); set({ ...blank(), catalog: S.catalog, mine: S.mine, listed: S.listed }); sim.load(); },
  /** 시험용: 모듈 상태 비우기 */
  clear() { sim.close(); backoff = 0; S = blank(); emit(); },
};
export const useSim = () => useSyncExternalStore(sim.subscribe, sim.get);

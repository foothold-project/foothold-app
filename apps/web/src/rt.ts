// 실시간 연결 하나(05 API §9, apps/server/README «실시간 연결»). 화면 ↔ 서버 WS /api/v1/ws — 쿠키 fh_s + Origin, 메시지마다 proto.
// 조종권·넘김·정지 확인 판정은 서버 중재기가 한다. 여기는 서버가 준 lease·state 를 그대로 들고,
// 화면 쪽 안전 규칙(넘김 중·잠금 중 0, 새 조종권은 새 중립부터, 숨기거나 떠나면 반납)만 더한다. 시각 판정은 단조 시계.
import { useSyncExternalStore } from 'react';
import type { ErrorBody, ScreenLeaseRequested, ScreenLeaseResult, ScreenLeaseUpdate, ScreenReply, ScreenState } from '../../contracts/ts';
import { api, expireAuth, type ApiFail } from './api';
import type { Robot, Status } from './fake';

/** 요청 응답(조직 기본값)·재요청 제한·무수신 끊김·연결 확인·입력 주기 */
export const REQUEST_S = 10, COOLDOWN_S = 30, SILENT_MS = 3000, PING_MS = 1000, CMD_MS = 50;
export const FAIL_TEXT = '로봇 정지 확인 실패. 조종권은 비어 있고 로봇은 정지 요청 상태입니다. 현장을 확인한 뒤 다시 조종 시작하세요.';
export const FREE_TEXT = '조종권이 비었습니다. [조종 시작]으로 받을 수 있습니다.';
const LINK_LOST = '서버 연결이 끊겼습니다.';

/** idle = 연결 안 함, connecting = 첫 연결 중, lost = 끊김(다시 연결 중), denied = 서버가 거부(다시 연결 안 함) */
export type Link = { at: 'idle' | 'connecting' | 'open' | 'lost' | 'denied'; why?: string; retryAt?: number };
export type Holder = { type: 'USER' | 'RUN'; id: string | null; name: string };
/** sending → sent(서버 접수) | fallback(HTTP 대체 경로 접수) | failed. 로봇이 멈췄는지는 state 로만 본다 */
export type Stop = { phase: 'sending' | 'sent' | 'fallback' | 'failed'; at: number; n: number; why?: string };   // at = 이 단계가 된 때
export type Live = {
  state: ScreenState | null;
  stateAt: number;
  holder: Holder | null;
  lease: string | null;                  // 내 연결의 lease_id(서버는 조종권자 연결에만 준다)
  rev: number;                           // 내 lease 가 바뀐 횟수 — 바뀌면 이전 입력은 버리고 새 중립부터
  neutral: boolean;
  busy: 'take' | 'give' | null;          // 넘김 중: take = 정지 확인 뒤 받는 중, give = 넘기는 중
  failed: boolean;                       // 마지막 넘김이 정지 확인 실패로 끝남(조종권 빔)
  incoming: { id: string; name: string; role: string; until: number; ms: number } | null;   // 내게 온 요청
  outgoing: { until: number } | null;    // 내가 보낸 요청
  cooldown: number;
  notice?: string;
  stop: Stop | null;
};
const EMPTY: Live = { state: null, stateAt: 0, holder: null, lease: null, rev: 0, neutral: false, busy: null, failed: false, incoming: null, outgoing: null, cooldown: 0, stop: null };

/** 서버 오류 code → 무엇이 + 어떻게(03 U8). 없으면 서버 message 그대로 */
const TEXT: Record<string, string> = {
  LEASE_HELD: '다른 사람이 조종 중이거나 조종권을 넘기는 중입니다. 잠시 뒤 다시 누르세요.',
  LEASE_REQUEST_COOLDOWN: `거절된 뒤 ${COOLDOWN_S}초 안에는 다시 요청할 수 없습니다. 잠시 뒤 다시 누르세요.`,
  LEASE_REQUEST_PENDING: '이미 처리 중인 요청이 있습니다. 잠시 뒤 다시 누르세요.',
  LEASE_REQUEST_STALE: '요청이 이미 끝났습니다. 지금 상태를 확인하세요.',
  LEASE_FREE: FREE_TEXT,
  LEASE_MISMATCH: '조종권이 바뀌었습니다. [조종 시작]부터 다시 하세요.',
  STOP_GEN_MISMATCH: '정지 상태가 바뀌었습니다. [잠금 해제]를 다시 누르세요.',
  ROBOT_OFFLINE: '로봇 연결이 끊겨 조종할 수 없습니다. 현장에서 로봇 전원과 통신을 확인하세요.',
  ROBOT_AUTH_PENDING: '서버가 로봇 연결을 확인하는 중입니다. 잠시 뒤 다시 누르세요.',
  POLICY_STALE: '서버가 권한을 확인하는 중입니다. 잠시 뒤 다시 누르세요.',
  SERVER_BUSY: '서버가 바쁩니다. 잠시 뒤 다시 누르세요.',
  FORBIDDEN: '이 로봇을 조종할 권한이 없습니다. 총괄 운영 관리자에게 문의하세요.',
  NETWORK: `${LINK_LOST} 다시 연결되면 누르세요.`,
};
const say = (e?: ErrorBody | null) => (e && (TEXT[e.code] ?? e.message)) || '요청을 처리하지 못했습니다. 잠시 뒤 다시 누르세요.';
const RESULT_ERR: Record<string, string> = {
  STOP_CONFIRM_FAILED: FAIL_TEXT,
  STOP_REF_EXHAUSTED: '로봇을 다시 연결해야 조종권을 줄 수 있습니다. 현장에서 로봇 연결을 확인하세요.',
};

export const now = () => performance.now();
const clock = () => new Date().toTimeString().slice(0, 8);   // 13:40:05 — 목록의 seenAt 과 같은 꼴
const zero = (a: number[] | null | undefined) => !!a && a.every((v) => v === 0);

let link: Link = { at: 'idle' };
const live = new Map<string, Live>();
const last = new Map<string, { status: Status | null; battery: number | null; at: string }>();   // 마지막 ONLINE 상태(끊김 문구용)
const active = new Set<string>();   // 조종 화면이 열린 로봇 — 그 밖의 로봇에 온 내 lease 는 바로 돌려준다
const gone = new Set<string>();     // 내가 돌려준 lease — 반납 전에 나간 늦은 알림이 되살리지 않게
const waiting = new Map<string, (r: ScreenReply) => void>();
const subs = new Set<() => void>();
let ver = 0, n = 0, seq = 0, tries = 0, lastRx = 0, lastPing = 0, want = false;
let sock: WebSocket | null = null, robots: string[] = [];
let retry: ReturnType<typeof setTimeout> | undefined, beat: ReturnType<typeof setInterval> | undefined;

const emit = () => { ver++; subs.forEach((f) => f()); };
const get = (id: string) => live.get(id) ?? EMPTY;
const set = (id: string, p: Partial<Live>) => { live.set(id, { ...get(id), ...p }); emit(); };
const setLink = (l: Link) => { link = l; emit(); };
const hiddenPage = () => document.visibilityState === 'hidden';

/** 보내기. 닫혀 있으면 false(답 함수에는 NETWORK) */
function send(body: Record<string, unknown>, done?: (r: ScreenReply) => void) {
  const id = String(++n);
  if (sock?.readyState !== 1) { done?.({ t: 'reply', id, ok: false, error: { code: 'NETWORK', message: LINK_LOST, detail: {} } }); return false; }
  if (done) waiting.set(id, done);
  sock.send(JSON.stringify({ ...body, id, proto: 'fh-rt/1' }));
  return true;
}

function open() {
  clearTimeout(retry);
  if (link.at !== 'lost') setLink({ at: 'connecting' });
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws`);
  sock = ws; lastRx = now();
  ws.onopen = () => {
    if (ws !== sock) return;
    lastRx = lastPing = now();
    setLink({ at: 'open' });
    send({ t: 'sub', robots, streams: ['state'] });
  };
  ws.onmessage = (e) => {
    if (ws !== sock || typeof e.data !== 'string') return;
    let m: { t?: unknown };
    try { m = JSON.parse(e.data); } catch { return; }
    lastRx = now(); tries = 0;
    receive(m);
  };
  ws.onclose = (e) => { if (ws === sock) closed(e.code); };
}

/** 연결이 끝남: 조종권·요청은 연결에 묶여 있어 모두 비운다(서버도 이 연결의 lease 를 쓰지 못하게 한다) */
function closed(code: number) {
  sock = null;
  for (const [id, l] of live) live.set(id, { ...l, state: null, holder: null, lease: null, busy: null, incoming: null, outgoing: null, neutral: false });
  const fail = [...waiting.values()]; waiting.clear();
  fail.forEach((f) => f({ t: 'reply', id: '', ok: false, error: { code: 'NETWORK', message: LINK_LOST, detail: {} } }));
  if (code === 4401) { want = false; stopBeat(); setLink({ at: 'denied', why: '로그인이 끝났습니다. 다시 로그인하세요.' }); expireAuth(); return; }
  if (code === 4403) { want = false; stopBeat(); setLink({ at: 'denied', why: '서버가 실시간 연결을 거부했습니다(권한 없음). 다시 로그인하거나 총괄 운영 관리자에게 권한을 확인하세요.' }); return; }
  if (!want) { setLink({ at: 'idle' }); return; }
  // 1013 서버 바쁨·1012 다시 연결 요청은 1 s, 그 밖은 1·2·4·8·10 s(§9.4)
  const ms = code === 1013 || code === 1012 ? 1000 : Math.min(10, 2 ** tries++) * 1000;
  setLink({ at: 'lost', why: LINK_LOST, retryAt: now() + ms });
  retry = setTimeout(open, ms);
}

/** 1 s 마다 ping(조종 중에도 — 받는 쪽 3 s 판정용), 3 s 동안 아무것도 못 받으면 끊김으로 보고 다시 연결 */
function startBeat() {
  stopBeat();
  beat = setInterval(() => {
    if (!sock) return;
    const t = now();
    if (t - lastRx >= SILENT_MS) { const ws = sock; closed(4000); ws.onclose = null; ws.close(); return; }
    if (sock.readyState === 1 && t - lastPing >= PING_MS) { lastPing = t; send({ t: 'ping' }); }
  }, 250);
}
const stopBeat = () => clearInterval(beat);

function receive(m: { t?: unknown }) {
  switch (m.t) {
    case 'reply': { const r = m as ScreenReply, f = waiting.get(r.id); if (f) { waiting.delete(r.id); f(r); } return; }
    case 'state': return onState(m as ScreenState);
    case 'lease': return onLease(m as ScreenLeaseUpdate);
    case 'lease.requested': return onRequested(m as ScreenLeaseRequested);
    case 'lease.result': return onResult(m as ScreenLeaseResult);
    // ping·event·notify·run 은 받은 것(생존)만 센다 — 사건·알림·실행 화면은 다음 작업
  }
}

function onState(s: ScreenState) {
  const l = get(s.robot);
  if (s.connection === 'ONLINE') last.set(s.robot, { status: s.status, battery: s.battery?.soc ?? null, at: clock() });
  const p = l.state;
  // 화면에 보이는 값이 바뀔 때만 다시 그림(10 Hz 그대로 그리지 않음)
  const same = p && p.connection === s.connection && p.status === s.status && p.battery?.soc === s.battery?.soc && p.latched === s.latched
    && p.stop_gen === s.stop_gen && zero(p.applied) === zero(s.applied) && (p.speed ?? 0).toFixed(1) === (s.speed ?? 0).toFixed(1)
    && !(l.stop && l.stateAt <= l.stop.at);   // STOP 뒤 첫 state 는 그려야 «로봇 보고»가 보인다
  if (same) { l.state = s; l.stateAt = now(); return; }
  set(s.robot, { state: s, stateAt: now(), neutral: s.latched === false && l.neutral });   // 잠기면 해제 뒤 새 중립부터
}

function onLease(m: ScreenLeaseUpdate) {
  const h = m.holder as { holder_type?: string; user?: { id: string; display_name: string } | null } | null;
  const holder: Holder | null = h ? { type: h.holder_type === 'RUN' ? 'RUN' : 'USER', id: h.user?.id ?? null, name: h.user?.display_name ?? '' } : null;
  const l = get(m.robot), lease = m.lease_id && !gone.has(m.lease_id) ? m.lease_id : null, p: Partial<Live> = { holder, lease };
  if (lease && lease !== l.lease) Object.assign(p, {
    rev: l.rev + 1, neutral: false, busy: null, failed: false, outgoing: null, incoming: null,
    notice: l.busy === 'take' || l.outgoing ? '조종권을 받았습니다. 잠금 해제 후 조종하세요.' : undefined,
  });
  if (!lease && l.lease) Object.assign(p, { neutral: false, incoming: null });
  // 내가 요청한 로봇의 조종권이 비면 넘김이 시작된 것 — 수락이면 곧 내 lease, 아니면 CANCELED 결과가 뒤따른다
  if (!holder && l.outgoing && !lease) Object.assign(p, { busy: 'take', outgoing: null });
  if (holder && !lease && l.busy === 'take') p.busy = null;
  set(m.robot, p);
  if (lease && (!active.has(m.robot) || hiddenPage())) leave(m.robot);   // 떠났거나 숨긴 화면은 조종권을 갖지 않는다
}

function onRequested(m: ScreenLeaseRequested) {
  const left = Date.parse(m.expires_at) - Date.now();
  // ponytail: 벽시계 차로 남은 시간을 얻는다. 시계가 크게 어긋나면(0 이하·30 s 초과) 기본 10 s — 판정은 서버가 한다
  const ms = left > 0 && left <= 30_000 ? left : REQUEST_S * 1000;
  set(m.robot, { incoming: { id: m.request_id, name: m.requester.display_name ?? '', role: m.requester.role ?? '', until: now() + ms, ms } });
}

function onResult(m: ScreenLeaseResult) {
  // 내 take 의 결과(request_id null)도 ACCEPTED 로 온다 — 지금 lease 를 쥐었다고 넘긴 쪽이 아니다
  const l = get(m.robot), giver = l.busy === 'give' || (!!l.incoming && l.incoming.id === m.request_id), asker = !!l.outgoing || l.busy === 'take';
  if (!giver && !asker) return;
  const err = m.error ? RESULT_ERR[m.error] ?? say({ code: m.error, message: '', detail: {} }) : undefined;
  if (m.result === 'ACCEPTED') return set(m.robot, giver ? { busy: null, incoming: null, notice: '조종권을 넘겼습니다. 보는 중입니다.' } : {});
  if (m.result === 'CANCELED') return set(m.robot, {
    busy: null, outgoing: null, incoming: null, failed: m.error === 'STOP_CONFIRM_FAILED',
    notice: err ?? (giver ? '요청이 취소되었습니다. 계속 조종합니다.' : get(m.robot).holder ? '요청이 취소되었습니다.' : FREE_TEXT),
  });
  if (giver) return set(m.robot, { incoming: null, notice: m.result === 'TIMEOUT' ? '응답하지 않아 요청이 끝났습니다. 계속 조종합니다.' : undefined });
  set(m.robot, { outgoing: null, cooldown: now() + COOLDOWN_S * 1000,
    notice: m.result === 'TIMEOUT' ? '응답이 없어 요청이 끝났습니다.' : `${l.holder?.name || '조종권자'}님이 거절했습니다.` });
}

/** 숨기거나 떠남: 조종권(또는 넘겨받는 중인 것)을 0·잠금·반납 */
function leave(id: string) {
  const l = get(id);
  if (!l.lease && l.busy !== 'take') return;
  send({ t: 'hidden', robot: id });
  if (l.lease) gone.add(l.lease);
  set(id, { lease: null, busy: null, neutral: false, incoming: null });
}
const onVisible = () => { if (hiddenPage()) for (const [id] of live) leave(id); };
const onPageHide = () => { for (const [id] of live) leave(id); };

export const rt = {
  now,
  get,
  link: () => link,
  /** 로그인 뒤 한 번. ids = 상태를 받을 로봇(총괄 전체, 운영 관리자는 담당 로봇만 — 남의 로봇을 구독하면 서버가 연결을 닫는다) */
  connect(ids: string[]) {
    robots = ids; want = true; tries = 0;
    document.addEventListener('visibilitychange', onVisible); addEventListener('pagehide', onPageHide);
    startBeat(); open();
  },
  /** 로그아웃·화면 내림: 쥔 조종권을 먼저 돌려주고 닫는다 */
  disconnect() {
    for (const [id] of live) leave(id);
    want = false; stopBeat(); clearTimeout(retry);
    document.removeEventListener('visibilitychange', onVisible); removeEventListener('pagehide', onPageHide);
    const ws = sock; sock = null; ws?.close(1000);
    live.clear(); last.clear(); active.clear(); gone.clear(); waiting.clear();
    link = { at: 'idle' }; emit();
  },
  /** 끊김·거부 뒤 [다시 연결] */
  reconnect() { if (!want) { want = true; startBeat(); } tries = 0; open(); },
  /** 조종 화면이 이 로봇을 연 동안. 닫으면 조종권을 돌려준다 */
  watch(id: string) { active.add(id); return () => { active.delete(id); leave(id); }; },

  take(id: string) {
    set(id, { notice: undefined, failed: false });
    send({ t: 'lease.take', robot: id }, (r) => {
      if (r.ok) { if (!get(id).lease) set(id, { busy: 'take' }); return; }
      if (r.error?.code === 'LEASE_HELD' && get(id).holder?.type === 'USER') return rt.request(id);
      set(id, { notice: say(r.error) });
    });
  },
  request(id: string) {
    send({ t: 'lease.request', robot: id }, (r) => set(id, r.ok ? { outgoing: { until: now() + REQUEST_S * 1000 }, notice: undefined } : { notice: say(r.error) }));
  },
  respond(id: string, accept: boolean) {
    const q = get(id).incoming;
    if (!q || q.until <= now()) return;   // 마감 지난 창은 누르지 않는다(판정은 서버)
    set(id, { incoming: null, busy: accept ? 'give' : null });
    send({ t: 'lease.respond', robot: id, request_id: q.id, accept }, (r) => { if (!r.ok) set(id, { busy: null, notice: say(r.error) }); });
  },
  release(id: string) {
    if (!get(id).lease) return;
    send({ t: 'lease.release', robot: id });
    gone.add(get(id).lease!);
    set(id, { lease: null, neutral: false, incoming: null });
  },
  unlock(id: string) {
    const l = get(id), gen = l.state?.stop_gen;
    if (!l.lease) return;
    if (gen == null) return set(id, { notice: '로봇 상태를 아직 받지 못했습니다. 잠시 뒤 다시 누르세요.' });
    send({ t: 'unlock', robot: id, lease_id: l.lease, stop_gen: gen }, (r) => set(id, { neutral: false, notice: r.ok ? undefined : say(r.error) }));
  },
  /** 50 ms 마다(0 포함, 조종권 심장 박동 겸). 넘기는 중·잠금 중(또는 상태 모름)은 0, 새 lease·잠금 해제 뒤에는 중립을 본 다음부터 보낸다.
   *  [전후, 회전] → 계약 axes [fx, fy, fw](옆걸음 0) */
  cmd(id: string, [fx, fw]: [number, number]) {
    const l = get(id);
    if (!l.lease) return;
    if (hiddenPage()) return leave(id);
    let axes = [fx, 0, fw];
    if (l.busy === 'give' || l.state?.latched !== false) axes = [0, 0, 0];
    else if (!l.neutral) { if (!fx && !fw) set(id, { neutral: true }); axes = [0, 0, 0]; }
    send({ t: 'cmd', robot: id, lease_id: l.lease, seq: ++seq, axes });
  },
  /** STOP — 어떤 상태에서도 바로. 실시간이 끊겼으면 HTTP 대체 경로, 그것도 안 되면 실패를 그대로 */
  stop(id: string) {
    const k = ++n, mark = (s: Pick<Stop, 'phase' | 'why'>) => { if (get(id).stop?.n === k) set(id, { stop: { ...s, at: now(), n: k } }); };
    set(id, { stop: { phase: 'sending', at: now(), n: k } });
    const http = () => api.stop(id).then(() => mark({ phase: 'fallback' }), (e: ApiFail) => mark({ phase: 'failed', why: e.message }));
    send({ t: 'stop', robot: id }, (r) => (r.ok ? mark({ phase: 'sent' }) : r.error?.code === 'NETWORK' ? http() : mark({ phase: 'failed', why: say(r.error) })));
  },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

const version = () => ver;
/** 실시간 저장소가 바뀌면 다시 그림 */
export const useRt = () => useSyncExternalStore(rt.subscribe, version);
export const useLive = (id: string) => { useRt(); return get(id); };

/** 서버 목록 값 위에 실시간 state 를 얹는다. 실시간이 끊기면 상태를 단정하지 않는다(unknown).
 *  끊긴 로봇은 마지막 ONLINE 상태 + 그 시각(02 F-COM-02) */
export function withLive(r: Robot): Robot {
  if (link.at === 'lost' || link.at === 'denied') return { ...r, online: false, unknown: true };
  const s = live.get(r.id)?.state;
  if (!s) return r;
  if (s.connection === 'ONLINE') return { ...r, online: true, status: s.status, battery: s.battery?.soc ?? null, seenAt: clock() };
  const k = last.get(r.id);
  return { ...r, online: false, status: k?.status ?? r.status, battery: k?.battery ?? r.battery, seenAt: k?.at ?? r.seenAt };
}

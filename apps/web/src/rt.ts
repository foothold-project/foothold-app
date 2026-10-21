// 실시간 연결 하나(05 API §9, apps/server/README «실시간 연결»). 화면 ↔ 서버 WS /api/v1/ws — 쿠키 fh_s + Origin, 메시지마다 proto.
// 조종권·넘김·정지 확인 판정은 서버 중재기가 한다. 여기는 서버가 준 lease·state 를 그대로 들고,
// 화면 쪽 안전 규칙(넘김 중·잠금 중 0, 새 조종권은 새 중립부터, 숨기거나 떠나면 반납)만 더한다. 시각 판정은 단조 시계.
import { useSyncExternalStore } from 'react';
import type { ErrorBody, ScreenLeaseRequested, ScreenLeaseResult, ScreenLeaseUpdate, ScreenReply, ScreenState, ScreenSubscriptionRevoked } from '../../contracts/ts';
import { api, expireAuth, type ApiFail } from './api';
import type { Holder, Robot, Status } from './fake';

/** 요청 응답(조직 기본값)·재요청 제한·무수신 끊김·연결 확인·입력 주기 */
export const REQUEST_S = 10, COOLDOWN_S = 30, SILENT_MS = 3000, PING_MS = 1000, CMD_MS = 50;
/** STOP 응답 시한: WS 답이 이만큼 없으면 HTTP 대체 경로(서버는 받는 즉시 답한다), HTTP 도 이만큼 없으면 접수 확인 못함. 재시도 간격 초기화 = 3 s 유지(§9.4) */
export const STOP_WS_MS = 2000, STOP_HTTP_MS = 5000, STEADY_MS = 3000;
export const FAIL_TEXT = '로봇 정지 확인 실패. 조종권은 비어 있고 로봇은 정지 요청 상태입니다. 현장을 확인한 뒤 다시 조종 시작하세요.';
export const FREE_TEXT = '조종권이 비었습니다. [조종 시작]으로 받을 수 있습니다.';
const LINK_LOST = '서버 연결이 끊겼습니다.';

/** idle = 연결 안 함, connecting = 첫 연결 중, lost = 끊김(다시 연결 중), denied = 서버가 거부(다시 연결 안 함) */
export type Link = { at: 'idle' | 'connecting' | 'open' | 'lost' | 'denied'; why?: string; retryAt?: number };
/** sending → sent(서버 접수) | fallback(HTTP 대체 경로 접수) | unsure(보냈지만 접수 답을 못 받음) | failed(보내지 못함). 로봇이 멈췄는지는 state 로만 본다 */
export type Stop = { phase: 'sending' | 'sent' | 'fallback' | 'unsure' | 'failed'; at: number; n: number; why?: string };   // at = 이 단계가 된 때
/** 서버가 이 화면의 구독을 거둠(담당 바뀜·로봇 지움, apps/server README). n = 몇 번째인지(화면이 한 번씩 처리) */
export type Revoked = { robot: string; reason: ScreenSubscriptionRevoked['reason']; n: number };
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
  outgoing: { until: number; canceling?: boolean } | null;    // 내가 보낸 요청(보낸 때부터 — 서버 답 전에도 취소할 수 있다)
  cooldown: number;
  notice?: string;
  stop: Stop | null;
};
const EMPTY: Live = { state: null, stateAt: 0, holder: null, lease: null, rev: 0, neutral: false, busy: null, failed: false, incoming: null, outgoing: null, cooldown: 0, stop: null };

/** 서버 오류 code → 무엇이 + 어떻게(03 U8). 없으면 서버 message 그대로 */
const TEXT: Record<string, string> = {
  LEASE_HELD: '다른 사람이 조종 중이거나 조종권을 넘기는 중입니다. 잠시 뒤 다시 누르세요.',
  LEASE_REQUEST_COOLDOWN: `요청이 거절·시간 초과·취소로 끝난 뒤 ${COOLDOWN_S}초 안에는 다시 요청할 수 없습니다. 잠시 뒤 다시 누르세요.`,
  LEASE_REQUEST_PENDING: '이미 처리 중인 요청이 있습니다. 잠시 뒤 다시 누르세요.',
  LEASE_REQUEST_STALE: '요청이 이미 끝났습니다(넘겨받는 중이거나 거절·시간 초과). 지금 조종권 상태를 확인하세요.',
  SUBSCRIPTION_REQUIRED: '이 로봇을 볼 수 있는지 다시 확인해야 합니다. 목록을 새로 받은 뒤 로봇 화면을 다시 열어 주세요.',
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
// 구독을 거둔 로봇 → 그 시각. 그 뒤에 요청한 목록이 다시 볼 수 있다고 할 때까지 sub 에 넣지 않는다(범위 밖 sub 는 서버가 4403 으로 연결 전체를 닫는다)
const revoked = new Map<string, number>();
let lastRevoked: Revoked | null = null;
// 서버가 받아 둔 구독(마지막으로 ok 받은 sub). sub 가 거절되면 서버는 이전 구독을 그대로 둔다(apps/server README «S0»)
// robots = 화면이 원하는 구독, held = 서버가 받아들인 구독, sending = 답을 기다리는 sub(한 번에 하나 — 서버도 연결당 대기 구독 1개)
let held: string[] = [], sending: string[] | null = null, subTries = 0, subRetry: ReturnType<typeof setTimeout> | undefined, missedKey = '';
/** 구독 거절(404): 목록의 로봇 중 실시간으로 볼 수 없는 것이 있음. again = 같은 목록이 또 거절됨(목록을 다시 받지 않는다) */
export type Missed = { n: number; again: boolean };
let lastMissed: Missed | null = null;
const subs = new Set<() => void>();
let ver = 0, n = 0, seq = 0, tries = 0, lastRx = 0, lastPing = 0, want = false;
let era = new AbortController();   // 이번 로그인 세션: 끊으면(disconnect) 그 세션이 시작한 STOP 타이머·HTTP 를 모두 거둔다
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

/** 지금 소켓을 버림: 처리기를 떼고 닫는다(연결 중이어도 — 나중에 열려 자원이 남지 않게) */
function drop(code?: number) {
  const ws = sock; sock = null;
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onclose = null;
  ws.close(code);
}

/** 지금 robots 를 구독. 앞 sub 의 답을 기다리는 중이면 보내지 않고, 답이 오면 그동안 바뀐 목록을 이어 보낸다(늦은 성공도 held 에 남는다).
 *  404 = 목록의 어떤 로봇을 서버가 모름 → 서버에 남은 구독(held)으로 되돌리고 목록을 한 번 다시 받게 알린다(같은 목록이 또 거절되면 다음 목록 갱신까지 기다림),
 *  503(SERVER_BUSY·POLICY_STALE 등 일시 오류) = 1·2·4·8·10 s 뒤 다시(즉시 반복 안 함). 4401/4403 은 서버가 연결을 닫는다(closed) */
function subscribe() {
  clearTimeout(subRetry);
  if (sending) return;
  const ids = sending = robots;
  send({ t: 'sub', robots: ids, streams: ['state'] }, (r) => {
    sending = null;
    const code = r.error?.code;
    if (code === 'NETWORK') return;   // 연결이 끝남 — 다시 열리면 처음부터 보낸다
    if (r.ok) { held = ids; subTries = 0; if (ids === robots) missedKey = ''; }
    else if (ids !== robots) { /* 그사이 목록이 바뀜 — 바뀐 목록을 바로 보낸다 */ }
    else if (r.error?.detail?.status === 503) { subRetry = setTimeout(subscribe, Math.min(10, 2 ** subTries++) * 1000); return; }
    else if (code === 'NOT_FOUND') {
      const again = missedKey === ids.join();
      missedKey = ids.join(); robots = held;
      lastMissed = { n: (lastMissed?.n ?? 0) + 1, again };
      emit();
      return;
    }
    if (ids !== robots) subscribe();
  });
}

function open() {
  clearTimeout(retry); clearTimeout(subRetry); drop();
  if (link.at !== 'lost') setLink({ at: 'connecting' });
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/ws`);
  let up = -1;   // 열린 시각(-1 = 수락 전)
  sock = ws; lastRx = now();
  ws.onopen = () => {
    if (ws !== sock) return;
    lastRx = lastPing = up = now();
    held = []; sending = null; subTries = 0;
    setLink({ at: 'open' });
    subscribe();
  };
  ws.onmessage = (e) => {
    if (ws !== sock || typeof e.data !== 'string') return;
    let m: { t?: unknown };
    try { m = JSON.parse(e.data); } catch { return; }
    lastRx = now();
    receive(m);
  };
  ws.onclose = (e) => { if (ws === sock) closed(e.code, up < 0 ? -1 : now() - up); };
}

const DENIED = { 401: '로그인이 끝났습니다. 다시 로그인하세요.', 403: '서버가 실시간 연결을 거부했습니다(권한 없음). 다시 로그인하거나 총괄 운영 관리자에게 권한을 확인하세요.' };
/** 영구 거부(4401/4403, 수락 전 HTTP 401/403): 다시 연결하지 않는다. 401 이면 로그인 화면 */
function deny(status: 401 | 403) {
  want = false; stopBeat(); clearTimeout(retry); drop();
  setLink({ at: 'denied', why: DENIED[status] });
  if (status === 401) expireAuth();
}

/** 수락 전에 끊김: 브라우저는 HTTP 401/403 도 503 도 1006 으로만 알린다. REST 가 401/403 이면 영구 거부로 멈추고,
 *  그 밖(REST 정상·안 닿음)은 원인을 단정하지 않고 늘려 가며 계속 다시 연결한다(10-19 조정 결정) */
function probe() {
  const s = era.signal;
  api.me(s).catch((e: ApiFail) => { if (!s.aborted && want && (e.status === 401 || e.status === 403)) deny(e.status); });
}

/** 연결이 끝남(upMs = 열려 있던 시간, -1 = 수락 전): 조종권·요청은 연결에 묶여 있어 모두 비운다(서버도 이 연결의 lease 를 쓰지 못하게 한다) */
function closed(code: number, upMs: number) {
  sock = null;
  for (const [id, l] of live) live.set(id, { ...l, state: null, holder: null, lease: null, busy: null, incoming: null, outgoing: null, neutral: false });
  const fail = [...waiting.values()]; waiting.clear();
  fail.forEach((f) => f({ t: 'reply', id: '', ok: false, error: { code: 'NETWORK', message: LINK_LOST, detail: {} } }));
  if (code === 4401 || code === 4403) return deny(code === 4401 ? 401 : 403);
  if (!want) { setLink({ at: 'idle' }); return; }
  // 1013 서버 바쁨·1012 다시 연결 요청은 1 s, 그 밖은 1·2·4·8·10 s — 3 s 넘게 유지된 연결이 끊기면 다시 1 s 부터(§9.4)
  if (upMs >= STEADY_MS) tries = 0;
  const ms = code === 1013 || code === 1012 ? 1000 : Math.min(10, 2 ** tries++) * 1000;
  setLink({ at: 'lost', why: LINK_LOST, retryAt: now() + ms });
  retry = setTimeout(open, ms);
  if (upMs < 0) probe();
}

/** 1 s 마다 ping(조종 중에도 — 받는 쪽 3 s 판정용), 3 s 동안 아무것도 못 받으면 끊김으로 보고 다시 연결 */
function startBeat() {
  stopBeat();
  beat = setInterval(() => {
    if (!sock) return;
    const t = now();
    // 열린 채 조용함 = 유지된 연결이 끊김(1 s 부터), 수락 전 3 s 넘게 매달림 = 거부가 아니라 시간 초과(REST 확인 안 함)
    if (t - lastRx >= SILENT_MS) {
      const up = sock.readyState === 1;
      // 조종 중이면 0 을 한 번 보내고 끊는다 — 그 뒤 cmd 는 없다(closed 가 조종권을 비움). 로봇은 0.3 s deadman 으로 이미 멈춘다
      if (up) for (const [id, l] of live) if (l.lease) send({ t: 'cmd', robot: id, lease_id: l.lease, seq: ++seq, axes: [0, 0, 0] });
      drop(); closed(4000, up ? STEADY_MS : 0); return;
    }
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
    case 'subscription.revoked': return onRevoked(m as ScreenSubscriptionRevoked);
    // ping·event·notify·run·모르는 t 는 받은 것(생존)만 센다 — 사건·알림·실행 화면은 다음 작업
  }
}

/** 상세 서랍에 보이는 위치(0.1 m·초)·장치 — 이것만 바뀌어도 다시 그린다 */
const shown = (s: ScreenState) => {
  const l = s.location;
  return JSON.stringify([l && [l.x?.toFixed(1), l.y?.toFixed(1), l.updated_at.slice(0, 19)], s.devices]);
};
function onState(s: ScreenState) {
  const l = get(s.robot);
  if (s.connection === 'ONLINE') last.set(s.robot, { status: s.status, battery: s.battery?.soc ?? null, at: clock() });
  const p = l.state;
  // 화면에 보이는 값이 바뀔 때만 다시 그림(10 Hz 그대로 그리지 않음)
  const same = p && p.connection === s.connection && p.status === s.status && p.battery?.soc === s.battery?.soc && p.latched === s.latched
    && shown(p) === shown(s)
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
  // 내가 요청한 로봇의 조종권이 비면 넘김이 시작된 것 — 수락이면 곧 내 lease, 아니면 CANCELED 결과가 뒤따른다.
  // 정지 확인 중(최대 2 s)에도 서버가 취소를 받으므로 요청(outgoing)은 확정(내 lease)·결과까지 남긴다
  if (!holder && l.outgoing && !lease) p.busy = 'take';
  if (holder && !lease && l.busy === 'take') Object.assign(p, { busy: null, outgoing: null });
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
  const moving = l.busy === 'give' || l.busy === 'take';   // 수락 뒤 정지 확인 중이던 넘김 — 취소되면 조종권은 이미 비었다
  if (!giver && !asker) return;
  const err = m.error ? RESULT_ERR[m.error] ?? say({ code: m.error, message: '', detail: {} }) : undefined;
  if (m.result === 'ACCEPTED') return set(m.robot, giver ? { busy: null, incoming: null, notice: '조종권을 넘겼습니다. 보는 중입니다.' } : {});
  // 요청자가 취소해도 양쪽에 같은 CANCELED 가 온다 — 요청자의 대기 표시와 조종권자의 «넘겨줄까요» 창을 둘 다 닫는다
  if (m.result === 'CANCELED') return set(m.robot, {
    busy: null, outgoing: null, incoming: null, failed: m.error === 'STOP_CONFIRM_FAILED',
    notice: err ?? (moving && giver ? `요청자가 넘김을 취소했습니다. ${FREE_TEXT}` : giver ? '요청이 취소되었습니다. 계속 조종합니다.'
      : l.outgoing?.canceling ? `요청을 취소했습니다.${moving ? ` ${FREE_TEXT}` : ''}` : get(m.robot).holder ? '요청이 취소되었습니다.' : FREE_TEXT),
  });
  if (giver) return set(m.robot, { incoming: null, notice: m.result === 'TIMEOUT' ? '응답하지 않아 요청이 끝났습니다. 계속 조종합니다.' : undefined });
  set(m.robot, { outgoing: null, cooldown: now() + COOLDOWN_S * 1000,
    notice: m.result === 'TIMEOUT' ? '응답이 없어 요청이 끝났습니다.' : `${l.holder?.name || '조종권자'}님이 거절했습니다.` });
}

/** 구독 회수: 서버가 조종권을 먼저 비우고(lease null → 정지) 보낸다. 이 로봇의 조종권·요청·상태를 버리고 구독에서 뺀다 — STOP 결과 줄만 남긴다.
 *  다른 로봇 구독과 소켓은 그대로 */
function onRevoked(m: ScreenSubscriptionRevoked) {
  if (typeof m.robot !== 'string') return;
  const l = get(m.robot);
  if (l.lease) gone.add(l.lease);
  live.set(m.robot, { ...EMPTY, stop: l.stop }); last.delete(m.robot);
  revoked.set(m.robot, now());
  robots = robots.filter((id) => id !== m.robot); held = held.filter((id) => id !== m.robot);
  lastRevoked = { robot: m.robot, reason: m.reason === 'ROBOT_DELETED' ? 'ROBOT_DELETED' : 'ACCESS_REVOKED', n: (lastRevoked?.n ?? 0) + 1 };
  emit();
}

/** 숨기거나 떠남: 조종권(또는 넘겨받는 중인 것)을 0·잠금·반납 */
function leave(id: string) {
  const l = get(id);
  if (!l.lease && l.busy !== 'take') return;
  send({ t: 'hidden', robot: id });
  if (l.lease) gone.add(l.lease);
  set(id, { lease: null, busy: null, neutral: false, incoming: null, notice: undefined });   // «계속 조종합니다» 같은 앞 안내를 남기지 않음
}
const onVisible = () => { if (hiddenPage()) for (const [id] of live) leave(id); };
const onPageHide = () => { for (const [id] of live) leave(id); };

export const rt = {
  now,
  get,
  link: () => link,
  /** 마지막 구독 회수(없으면 null) */
  revoked: () => lastRevoked,
  /** 마지막 구독 거절(404, 없으면 null) */
  missed: () => lastMissed,
  /** 로그인 뒤 한 번. ids = 상태를 받을 로봇(총괄 전체, 운영 관리자는 담당 로봇만 — 남의 로봇을 구독하면 서버가 연결을 닫는다) */
  connect(ids: string[]) {
    robots = ids; want = true; tries = 0;
    document.addEventListener('visibilitychange', onVisible); addEventListener('pagehide', onPageHide);
    startBeat(); open();
  },
  /** 로그아웃·화면 내림: 쥔 조종권을 먼저 돌려주고 닫는다 */
  disconnect() {
    for (const [id] of live) leave(id);
    want = false; robots = []; held = []; sending = null; missedKey = ''; lastMissed = null; stopBeat(); clearTimeout(retry); clearTimeout(subRetry);
    document.removeEventListener('visibilitychange', onVisible); removeEventListener('pagehide', onPageHide);
    era.abort(); era = new AbortController(); drop(1000);
    live.clear(); last.clear(); active.clear(); gone.clear(); waiting.clear(); revoked.clear(); lastRevoked = null;
    link = { at: 'idle' }; emit();
  },
  /** 상태를 받을 로봇이 바뀜(목록 갱신으로 담당이 바뀜 등): 빠진 로봇은 조종권을 돌려주고 상태를 지우며, 열려 있으면 sub 를 다시 보낸다.
   *  소켓은 그대로(쥔 조종권을 잃지 않게). at = 그 목록을 요청한 시각(now()) — 회수 뒤에 요청한 목록이어야 거둔 로봇을 다시 구독한다 */
  follow(ids: string[], at = 0) {
    for (const [id, t] of revoked) if (t < at) revoked.delete(id);
    ids = ids.filter((id) => !revoked.has(id));
    if (ids.join() === robots.join()) return;
    for (const id of robots) if (!ids.includes(id)) { leave(id); live.delete(id); last.delete(id); }
    robots = ids;
    subscribe();
    emit();
  },
  /** 끊김·거부 뒤 [다시 연결] */
  reconnect() { if (!want) { want = true; startBeat(); } tries = 0; open(); },
  /** 조종 화면이 이 로봇을 연 동안. 닫으면 조종권을 돌려준다 */
  watch(id: string) { active.add(id); return () => { active.delete(id); leave(id); }; },

  take(id: string) {
    // 받는 중은 보내기 전에 — 결과(CANCELED 등)가 응답보다 먼저 와도 내 것으로 처리한다
    set(id, { notice: undefined, failed: false, busy: 'take' });
    send({ t: 'lease.take', robot: id }, (r) => {
      if (r.ok) return;
      set(id, { busy: null });
      if (r.error?.code === 'LEASE_HELD' && get(id).holder?.type === 'USER') return rt.request(id);
      set(id, { notice: say(r.error) });
    });
  },
  request(id: string) {
    set(id, { outgoing: { until: now() + REQUEST_S * 1000 }, notice: undefined });
    send({ t: 'lease.request', robot: id }, (r) => { if (!r.ok) set(id, { outgoing: null, notice: say(r.error) }); });
  },
  /** 보낸 요청 취소(답 전에도). 닫는 것은 서버의 lease.result(CANCELED). 취소도 서버의 30 s 재요청 제한에 들어간다 — 화면이 따로 세지 않고 서버 답을 따른다 */
  cancel(id: string) {
    const o = get(id).outgoing;
    if (!o || o.canceling) return;
    set(id, { outgoing: { ...o, canceling: true } });
    send({ t: 'lease.cancel', robot: id }, (r) => {
      const left = get(id).outgoing;
      if (!r.ok && !left && get(id).lease) return set(id, { notice: '취소하기 전에 조종권을 받았습니다. 조종하지 않으려면 [조종 끝내기]를 누르세요.' });
      if (r.ok || !left) return;   // 요청이 이미 다른 결과로 끝났으면 그 안내를 둔다
      set(id, { outgoing: { until: left.until }, notice: say(r.error) });
    });
  },
  respond(id: string, accept: boolean) {
    const q = get(id).incoming;
    if (!q || q.until <= now()) return;   // 마감 지난 창은 누르지 않는다(판정은 서버)
    set(id, { incoming: null, busy: accept ? 'give' : null });
    send({ t: 'lease.respond', robot: id, request_id: q.id, accept }, (r) => { if (!r.ok) set(id, { busy: null, notice: say(r.error) }); });
  },
  /** 조종권 반납. 입력은 바로 멈추고(내 lease 를 지움) done 에 서버 판정(null = 반납됨, 글 = 못 함).
   *  done 을 주면 내 lease 가 이미 없어도 보낸다(반납을 확인 못 했을 때 다시 시도) */
  release(id: string, done?: (why: string | null) => void) {
    const lease = get(id).lease;
    if (!lease && !done) return;
    send({ t: 'lease.release', robot: id }, done && ((r) => done(r.ok ? null : say(r.error))));
    if (lease) { gone.add(lease); set(id, { lease: null, neutral: false, incoming: null }); }
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
  /** STOP — 어떤 상태에서도 바로. 실시간이 끊겼거나 STOP_WS_MS 안에 답이 없으면 HTTP 대체 경로(같은 STOP 을 한 번 더 — 정지는 겹쳐도 안전),
   *  그것도 안 되면: WS 로 보낸 적이 있거나 시한 초과면 «접수 확인 못함», 아니면 «보내지 못함».
   *  같은 STOP 의 WS 접수(ok)는 늦게 와도 반영하고 뒤의 HTTP 실패가 덮지 않는다. 대체 경로로 넘어간 뒤의 늦은 WS 거절은 버린다.
   *  타이머·HTTP 는 이 로그인 세션에 묶여 로그아웃·계정 전환 때 거둔다(다음 사람의 CSRF 로 나가지 않게) */
  stop(id: string) {
    const k = ++n, s = era.signal, mark = (p: Pick<Stop, 'phase' | 'why'>) => { if (!s.aborted && get(id).stop?.n === k) set(id, { stop: { ...p, at: now(), n: k } }); };
    set(id, { stop: { phase: 'sending', at: now(), n: k } });
    let via: 'ws' | 'http' = 'ws', acked = false, viaWs = false;   // viaWs = WS 로 실제로 보냄(닫혀 있으면 send 가 바로 답을 불러 false)
    const http = () => {
      via = 'http'; clearTimeout(late);
      api.stop(id, { ms: STOP_HTTP_MS, cancel: s }).then(() => { if (!acked) mark({ phase: 'fallback' }); }, (e: ApiFail) => {
        if (!acked && e.code !== 'CANCELED') mark({ phase: !viaWs && e.said && e.status >= 400 && e.status < 500 ? 'failed' : 'unsure', why: e.message });   // 서버의 명시적 거절(4xx + 오류 본문)만 실패 — 응답 못 받음·5xx·프록시 오류는 처리됐을 수 있음
      });
    };
    const late = setTimeout(() => { if (via === 'ws') http(); }, STOP_WS_MS);
    viaWs = send({ t: 'stop', robot: id }, (r) => {
      if (r.ok) { acked = true; clearTimeout(late); return mark({ phase: 'sent' }); }
      if (via !== 'ws') return;
      clearTimeout(late);
      if (r.error?.code === 'NETWORK') http(); else mark({ phase: 'failed', why: say(r.error) });
    });
  },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

const version = () => ver;
/** 실시간 저장소가 바뀌면 다시 그림 */
export const useRt = () => useSyncExternalStore(rt.subscribe, version);
export const useLive = (id: string) => { useRt(); return get(id); };

/** 서버 목록 값 위에 실시간 state 를 얹는다. 상태를 단정할 수 없으면 unknown(02 F-COM-02):
 *  link = 실시간이 끊김, wait = 이번 연결의 첫 state 전(소켓이 열린 것은 로봇 확인이 아니다),
 *  summary = 구독하지 않는 로봇(운영 관리자에게 남의 로봇) — 목록 요약 값뿐이고 서버의 목록 연결값은 아직 실제가 아니라 확인 안 됨.
 *  끊긴 로봇은 마지막 ONLINE 상태 + 그 시각 */
export function withLive(r: Robot): Robot {
  if (!robots.includes(r.id)) return { ...r, online: false, unknown: 'summary' };
  if (link.at === 'lost' || link.at === 'denied') return { ...r, online: false, unknown: 'link' };
  const s = live.get(r.id)?.state;
  if (!s) return { ...r, online: false, unknown: 'wait' };
  if (s.connection === 'ONLINE') return { ...r, online: true, status: s.status, battery: s.battery?.soc ?? null, seenAt: clock() };
  const k = last.get(r.id);
  return { ...r, online: false, status: k?.status ?? r.status, battery: k?.battery ?? r.battery, seenAt: k?.at ?? r.seenAt };
}

// 연결 전송층 — 하나만 고른다(시작 때 한 번). WS 연결·20 Hz 발행은 link.ts 하나뿐이고, 여기는 «어디로·무엇을 들고» 가는지만 바꾼다.
//  web    : 같은 출처 관문(쿠키) — fetch api/* · WS /ws. 원격 A·브라우저·개발 서버.
//  native : bundled B — FhGate 플러그인(계약 mobile/docs/FHGATE-CONTRACT.md v0.1, 404da91). 토큰은 네이티브만(JS 에 없음), WS 는 1회용 표 URL.
// 네이티브를 고르는 조건: 앱 출처(https://localhost · capacitor://localhost) «그리고» FhGate 플러그인이 있음. 원격 A(관문 https 주소)는 플러그인이 있어도 web.
// 세대(gen): 네이티브 결과·오류·이벤트의 gen 이 화면이 아는 현재 gen 과 다르면 버린다. 로그인 결과 채택은 화면의 로컬 의도 번호(auth.intent)와 «둘 다» 맞을 때만.
// 로컬 epoch: logout·setGate·(자기 세대) 세션 끝에서 await 전에 즉시 +1. 모든 호출은 시작 때 epoch 를 잡고, 준비 await 뒤 «네이티브 호출 전»과
//  응답 채택 때 다시 대조 — 보류된 state 응답이 늦게 풀려도 옛 계정·비밀번호로 새 문맥에 login 을 부르지 않는다. gen 은 앞으로만(옛 응답이 뒤로 덮지 않음).
import { create } from 'zustand';
import { healthOk, type Health } from './health';
export type Res = { status: number; body: string };
export type LoginResult = { ok: true; note?: string } | { ok: false; error: string };
export type LogoutResult = { ok: boolean; note?: string };
export type WsTarget = { url: string } | { why: string };   // why = 지금 열지 않는 이유(연결 표시에 그대로)
/** 세션 안내 한 줄(원본 화면의 로그아웃 자리·로그인 화면에 표시): 저장 안 됨 · 서버 종료 확인 중/못 함 */
export const useNote = create<{ note: string }>(() => ({ note: '' }));
const note = (t: string) => useNote.setState({ note: t });
export interface Transport {
  kind: 'web' | 'native';
  gated: boolean;                                   // 로그인이 있는 연결인가
  where(): Promise<string>;                         // 로그인 화면의 서버 표시
  hint(): Promise<string>;                          // 로그인 화면 첫 안내(주소 없음·잠김), 없으면 ''
  setGate?(origin: string): Promise<string | null>; // 네이티브만: 관문 주소 바꾸기(오류 글 또는 null)
  login(user: string, pw: string, label: string): Promise<LoginResult>;
  logout(): Promise<LogoutResult>;
  get(what: 'docs' | 'media'): Promise<Res>;
  postDocs(body: unknown): Promise<Res>;            // 200·400·403·404·409·500·503 은 status 로(던지지 않음)
  photo(url: string): Promise<string | null>;       // img src — 네이티브는 blob:(부른 쪽이 revoke), 없으면 null
  wsUrl(): Promise<WsTarget>;
  // 로그인 불요 관문 검사(①·⑥): 웹 GET api/health · 네이티브 FhGate.probe()(있을 때만). 로그인·조종 명령 0, 재시도 0. ms = 앱↔관문 HTTP 왕복
  health(): Promise<Health>;
  onEnded(f: () => void): void;
  // B2 파일 저장(bundled B 만): 화면 글 또는 null(버림 — 준비·창 사이 로그아웃·주소 변경·세션 끝·화면 이탈). alive = 부른 화면이 아직 그대로인가
  saveFile?(name: string, blob: Blob, alive: () => boolean): Promise<string | null>;                     // 이 세대 세션 끝(만료·401)·주소 없음·잠김 → 로그인/주소 화면(자동 take/resume 없음)
}

const web: Transport = {
  kind: 'web',
  gated: typeof location !== 'undefined' && location.protocol === 'https:',
  async where() { return `v2 시뮬 관문 · ${location.host}`; },
  async hint() { return ''; },
  async login(user, pw, label) {
    try {
      const r = await fetch('api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, pw, device: label }) });
      const d = await r.json().catch(() => ({}));
      return r.ok && d.ok ? { ok: true } : { ok: false, error: d.error || `로그인 실패(HTTP ${r.status})` };
    } catch (e) { return { ok: false, error: `서버에 닿지 않음 · ${(e as Error).message || e}` }; }
  },
  async logout() {
    try { const r = await fetch('api/logout', { method: 'POST', credentials: 'same-origin' }); note(r.ok ? '' : SRV_FAIL); }
    catch { note(SRV_FAIL); }   // 서버 세션은 만료·관문 재시작으로 끝남
    return { ok: true };
  },
  async get(what) { const r = await fetch(`api/${what}`, { cache: 'no-store', credentials: 'same-origin' }); return { status: r.status, body: await r.text() }; },
  async postDocs(body) {
    const r = await fetch('api/docs', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.text() };
  },
  async photo(url) { return url; },
  async wsUrl() { const u = new URL('ws', location.href); u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; u.hash = ''; u.search = ''; return { url: String(u) }; },
  onEnded() { /* 웹은 WS 4401 로 안다(link.ts) */ },
  async health() {   // 유한: 전체 8 s 에 중단(본문 읽기 포함) · redirect 따라가지 않음 · 본문 4 KB 넘으면 버림
    const t0 = performance.now(), ac = new AbortController(), tm = setTimeout(() => ac.abort(), HEALTH_MS);
    try {
      const r = await fetch('api/health', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: ac.signal });
      const b = await capText(r, HEALTH_MAX), ms = performance.now() - t0;
      if (b === null) return { ok: false, step: 'gate', why: '관문 판 확인 못 함(응답이 너무 큼 · 다른 서버)' };
      if (healthOk(r.status, b)) return { ok: true, ms };
      return { ok: false, step: r.status === 429 ? 'busy' : 'gate', why: r.status === 429 ? '검사 요청이 많음 — 잠시 뒤' : `관문 판 확인 못 함(HTTP ${r.status} · 옛 관문이거나 다른 서버)` };
    } catch (e) {
      // 브라우저는 네트워크 실패와 redirect 거부를 같은 TypeError 로 준다 — 둘을 가르지 않음
      return { ok: false, step: 'reach', why: ac.signal.aborted ? `관문 응답 없음(${HEALTH_MS / 1000} s)` : `관문에 닿지 않음 또는 다른 주소로 보냄(거부) · ${(e as Error).message || e}` };
    } finally { clearTimeout(tm); }
  },
};

// 웹 관문 검사 한도 + 본문 상한 읽기(넘으면 null, 나머지는 읽지 않고 끊음)
const HEALTH_MS = 8000, HEALTH_MAX = 4096;
export async function capText(r: Response, max: number): Promise<string | null> {
  if (!r.body) return '';
  const rd = r.body.getReader(), parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    n += value.byteLength; if (n > max) { rd.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n); let o = 0; for (const v of parts) { all.set(v, o); o += v.byteLength; }
  return new TextDecoder().decode(all);
}

// 네이티브 오류 코드 → 화면 글(계약 FhCode). 토큰·비밀번호는 오류에 없다(계약)
const MSG: Record<string, string> = {
  bad_input: '입력 형식이 맞지 않음', no_gate: '관문 주소를 먼저 정하세요(«바꾸기»)', no_session: '로그인 필요', bad_state: '앱 상태 이상 — 다시 시도',
  stale: '연결이 바뀜 — 옛 응답 버림', tls: '관문 인증서 확인 실패', net: '관문에 닿지 않음', unknown: '알 수 없는 오류', auth: '계정 또는 비밀번호가 틀림',
  origin: '관문이 앱 출처를 거부', busy: '처리 중 — 잠시 뒤 다시', redirect: '관문이 다른 주소로 보냄(거부)', server: '관문 오류', too_big: '응답이 너무 큼',
  bad_type: '응답 형식 이상', storage: '기기 로그아웃 저장 실패 — 다시 로그아웃', internal: '앱 내부 오류',
  cancelled: '저장 취소', io: '저장 실패 — 저장 안 됨',
};
const SAVE_MAX = 5 * 1024 * 1024;   // 계약 d4e5002: 푼 바이트 5 MB 넘으면 too_big
const b64 = async (blob: Blob) => {
  const u = new Uint8Array(await blob.arrayBuffer()); let b = '';
  for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(b);
};
export const STALE = MSG.stale;
const SRV_FAIL = '이 기기에서는 로그아웃됨 · 서버 세션 종료 확인 못 함';
const SRV_WAIT = '이 기기에서는 로그아웃됨 · 서버 세션 종료 확인 중';
const MEM_ONLY = '이 기기에 저장 안 됨 — 앱을 다시 켜면 다시 로그인';
const TO_LOGIN = new Set(['no_gate', 'no_session', 'storage']);   // 로그인·주소·폐기 재시도 화면으로

export function nativeTransport(P: any): Transport {
  let gen = -1, epoch = 0;          // gen: 화면이 아는 현재 세대(앞으로만) · epoch: 로컬 취소 번호
  const ended: (() => void)[] = [];
  const adopt = (g: number) => { if (g > gen) gen = g; };
  const end = () => { ++epoch; for (const f of ended) f(); };
  const sync = P.state().then((s: any) => { adopt(s.gen); if (s.loggedIn && s.stored === false) note(MEM_ONLY); return s; });
  P.addListener('sessionEnded', (v: { gen: number }) => { if (v.gen === gen) end(); });   // 다른 세대 이벤트는 버림
  // logoutResult 는 P.logout 의 resolve 보다 먼저 올 수 있다(네이티브 큐가 차면 failed 를 먼저 알림). 현재 gen 이 아니면 작은 상한으로 보관했다가
  // 그 logout 의 반환 gen 과 같을 때만 채택. 새 login·setGate 로 gen 이 지나가면 옛 결과는 맞을 일이 없어 버려진다.
  const srvTxt = (sv: string) => (sv === 'failed' ? SRV_FAIL : '');
  const early: { server: string; gen: number }[] = [];
  P.addListener('logoutResult', (v: { server: string; gen: number }) => {
    if (v.gen === gen) note(srvTxt(v.server));
    else if (v.gen > gen) { early.push(v); if (early.length > 4) early.shift(); }
  });
  const stale = (e: any) => e?.code === 'stale' || e?.data?.gen !== gen;
  const why = (e: any) => (stale(e) ? STALE : MSG[e?.code] || e?.message || String(e));
  const live = (ep: number) => { if (ep !== epoch) throw new Error(STALE); };
  // 공통: 시작 때 epoch → 준비 → 호출 전 대조 → 응답 epoch·gen 대조. 현재 문맥의 no_gate·no_session·storage 는 로그인 화면으로
  const call = async <R extends { gen: number }>(f: () => Promise<R>): Promise<R> => {
    const ep = epoch;
    await sync; live(ep);
    try { const r = await f(); live(ep); if (r.gen !== gen) throw new Error(STALE); return r; }
    catch (e: any) {
      if (e instanceof Error && e.message === STALE) throw e;
      if (ep !== epoch) throw new Error(STALE);
      if (!stale(e) && TO_LOGIN.has(e?.code)) end();
      throw new Error(why(e));
    }
  };
  const logoutRaw = async (): Promise<LogoutResult & { ep: number }> => {
    const ep = ++epoch;   // await 전에 즉시: 진행 중 호출·늦은 응답 무효
    await sync;
    try {
      const r = await P.logout({ reason: 'user' });
      if (ep !== epoch) return { ok: false, note: STALE, ep };   // 그 사이 더 새 logout/setGate — 옛 결과로 gen·안내를 덮지 않음
      adopt(r.gen);
      if (!r.ok) { note(MSG.storage); return { ok: false, note: MSG.storage, ep }; }
      const i = early.findIndex((v) => v.gen === r.gen), pre = i >= 0 ? early.splice(i, 1)[0] : null;
      note(pre ? srvTxt(pre.server) : r.server === 'pending' ? SRV_WAIT : ''); return { ok: true, ep };
    } catch (e) { return { ok: false, note: ep === epoch ? why(e) : STALE, ep }; }
  };
  return {
    kind: 'native', gated: true,
    async where() { const s = await P.state().catch(() => null); return s?.origin ? `관문 · ${s.origin}` : '관문 주소 없음 — «바꾸기»'; },
    async hint() {
      const s = await P.state().catch(() => null);
      return !s ? '' : !s.origin ? MSG.no_gate : s.locked ? `${MSG.storage} — «로그인»을 누르면 폐기부터 다시 시도` : '';
    },
    async setGate(origin) {
      const ep = ++epoch;
      await sync;
      try { const r = await P.setGate({ origin }); if (ep !== epoch) return STALE; adopt(r.gen); note(''); return null; }
      catch (e) { return ep === epoch ? why(e) : STALE; }
    },
    async login(user, pw, label) {
      let ep = ++epoch;   // 더 앞선 보류 응답(옛 logout 등)이 이 로그인 결과를 덮지 않게
      const s = await sync.then(() => P.state()).catch(() => null);
      if (ep !== epoch) return { ok: false, error: STALE };   // 보류된 state 뒤 logout/setGate → login 부르지 않음
      if (s) adopt(s.gen);   // 401 sessionEnded 뒤 네이티브는 이미 gen+1 — 이 호출의 오류 gen 기준을 최신 state 로
      if (s?.locked) {   // 잠김: 다시 로그아웃(디스크 폐기)부터
        const o = await logoutRaw();
        if (!o.ok) return { ok: false, error: o.note || MSG.storage };
        if (o.ep !== epoch) return { ok: false, error: STALE };
        ep = o.ep;
      }
      const g0 = gen;
      try {
        const r = await P.login({ user, pw, label });
        if (ep !== epoch || gen !== g0) return { ok: false, error: STALE };   // 그 사이 로그아웃·주소 변경·세션 끝
        adopt(r.gen);
        note(r.stored === false ? MEM_ONLY : '');
        return { ok: true, note: r.stored === false ? MEM_ONLY : undefined };
      } catch (e) { return { ok: false, error: ep === epoch ? why(e) : STALE }; }
    },
    async logout() { const { ep: _, ...r } = await logoutRaw(); return r; },
    get: (what) => call(() => P.request({ op: what === 'docs' ? 'docs.get' : 'media.list' })).then((r: any) => ({ status: r.status, body: r.body })),
    postDocs: (body) => call(() => P.request({ op: 'docs.post', body })).then((r: any) => ({ status: r.status, body: r.body })),
    async photo(url) {
      const r: any = await call(() => P.photo({ path: url }));
      if (r.status !== 200 || typeof r.base64 !== 'string') return null;
      const b = atob(r.base64), a = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
      return URL.createObjectURL(new Blob([a], { type: 'image/jpeg' }));
    },
    async wsUrl() {   // 세대·epoch 가 다르면 열지 않음. tls·net 등 원인은 숨기지 않고 연결 표시로
      try { const r: any = await call(() => P.wsTicket()); return { url: r.url }; }
      catch (e: any) { return { why: e?.message || String(e) }; }
    },
    onEnded(f) { ended.push(f); },
    async health() {   // probe 는 gen 을 바꾸지 않음 — 호출 순간 epoch·gen 과 다르면 버림. call() 을 쓰지 않음(no_gate 로 세션 끝 처리하지 않게)
      if (typeof P.probe !== 'function') return { ok: false, step: 'none', why: '이 앱 판에 검사 기능 없음 — 도달·인증서는 로그인 때 확인' };
      const ep = epoch; await sync;
      if (ep !== epoch) return { ok: false, step: 'none', why: STALE };   // 준비 중 주소 변경·로그아웃 → 옛 화면 의도로 새 관문에 probe 0
      const g = gen, t0 = performance.now();
      try {
        const r = await P.probe(), ms = performance.now() - t0;
        if (ep !== epoch || r?.gen !== g) return { ok: false, step: 'none', why: STALE };
        return r.compat === true ? { ok: true, ms } : { ok: false, step: 'gate', why: `관문 판 확인 못 함(HTTP ${r.status} · 옛 관문이거나 다른 서버)` };
      } catch (e: any) {   // 오류도 이 호출 gen 의 것만 단계에 붙임(옛 net/tls 를 새 주소 칸에 0)
        if (ep !== epoch || e?.code === 'stale' || e?.data?.gen !== g) return { ok: false, step: 'none', why: STALE };
        const step = ({ net: 'reach', tls: 'tls', redirect: 'gate', too_big: 'gate', busy: 'busy', no_gate: 'none' } as const)[e?.code as string] || 'gate';
        return { ok: false, step, why: MSG[e?.code] || e?.message || String(e) };
      }
    },
    async saveFile(name, blob, alive) {
      const ep = epoch, g = gen;   // 저장 시작 문맥
      if (blob.size > SAVE_MAX) return MSG.too_big + '(5 MB 넘음 — 저장 안 됨)';   // 바이트 읽기 전에
      const data = await b64(blob);
      if (ep !== epoch || gen !== g || !alive()) return null;   // 준비 중 로그아웃·주소 변경·이탈 → 저장 창을 열지 않음
      try {
        const r: any = await call(() => P.saveFile({ name, base64: data }));   // call: 호출 전 epoch · 응답 epoch · r.gen === 현재 gen
        if (ep !== epoch || gen !== g || !alive()) return null;
        return r?.saved === true ? `저장됨(${name})` : '저장 결과 미확인';
      } catch (e: any) {
        if (ep !== epoch || gen !== g || !alive()) return null;
        // 문맥은 그대로인데 네이티브가 stale(창 사이 화면 재생성 gen -1 · 다 쓴 뒤 응답만 버림 ③): 파일이 남았을 수도 있다(af602ba)
        return e?.message === STALE ? '저장 결과 미확인 — 파일 목록 확인 뒤 필요하면 다시 저장' : e?.message || String(e);
      }
    },
  };
}

const W: any = typeof window !== 'undefined' ? window : {};
const APP_ORIGINS = ['https://localhost', 'capacitor://localhost'];
const plugin = APP_ORIGINS.includes(W.location?.origin) ? W.Capacitor?.Plugins?.FhGate : undefined;
export const T: Transport = plugin ? nativeTransport(plugin) : web;

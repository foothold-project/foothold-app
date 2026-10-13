// 연결 전송층 — 하나만 고른다(시작 때 한 번). WS 연결·20 Hz 발행은 link.ts 하나뿐이고, 여기는 «어디로·무엇을 들고» 가는지만 바꾼다.
//  web    : 같은 출처 관문(쿠키) — fetch api/* · WS /ws. 원격 A·브라우저·개발 서버.
//  native : bundled B — FhGate 플러그인(계약 mobile/docs/FHGATE-CONTRACT.md v0.1, 404da91). 토큰은 네이티브만(JS 에 없음), WS 는 1회용 표 URL.
// 네이티브를 고르는 조건: 앱 출처(https://localhost · capacitor://localhost) «그리고» FhGate 플러그인이 있음. 원격 A(관문 https 주소)는 플러그인이 있어도 web.
// 세대(gen): 네이티브 결과·오류·이벤트의 gen 이 화면이 아는 현재 gen 과 다르면 버린다. 로그인 결과 채택은 화면의 로컬 의도 번호(auth.intent)와 «둘 다» 맞을 때만.
export type Res = { status: number; body: string };
export type LoginResult = { ok: true; note?: string } | { ok: false; error: string };
export type LogoutResult = { ok: boolean; note?: string };
export interface Transport {
  kind: 'web' | 'native';
  gated: boolean;                                   // 로그인이 있는 연결인가
  where(): Promise<string>;                         // 로그인 화면의 서버 표시
  setGate?(origin: string): Promise<string | null>; // 네이티브만: 관문 주소 바꾸기(오류 글 또는 null)
  login(user: string, pw: string, label: string): Promise<LoginResult>;
  logout(): Promise<LogoutResult>;
  get(what: 'docs' | 'media'): Promise<Res>;
  postDocs(body: unknown): Promise<Res>;            // 200·400·403·404·409·500·503 은 status 로(던지지 않음)
  photo(url: string): Promise<string | null>;       // img src — 네이티브는 blob:(부른 쪽이 revoke), 없으면 null
  wsUrl(): Promise<string | null>;                  // null = 지금 열지 않음
  onEnded(f: () => void): void;                     // 이 세대 세션이 끝남(만료·401) → 로그인 화면
}

const web: Transport = {
  kind: 'web',
  gated: typeof location !== 'undefined' && location.protocol === 'https:',
  async where() { return `v2 시뮬 관문 · ${location.host}`; },
  async login(user, pw, label) {
    try {
      const r = await fetch('api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, pw, device: label }) });
      const d = await r.json().catch(() => ({}));
      return r.ok && d.ok ? { ok: true } : { ok: false, error: d.error || `로그인 실패(HTTP ${r.status})` };
    } catch (e) { return { ok: false, error: `서버에 닿지 않음 · ${(e as Error).message || e}` }; }
  },
  async logout() { try { await fetch('api/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* 서버 세션은 만료·관문 재시작으로 끝남 */ } return { ok: true }; },
  async get(what) { const r = await fetch(`api/${what}`, { cache: 'no-store', credentials: 'same-origin' }); return { status: r.status, body: await r.text() }; },
  async postDocs(body) {
    const r = await fetch('api/docs', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.text() };
  },
  async photo(url) { return url; },
  async wsUrl() { const u = new URL('ws', location.href); u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; u.hash = ''; u.search = ''; return String(u); },
  onEnded() { /* 웹은 WS 4401 로 안다(link.ts) */ },
};

// 네이티브 오류 코드 → 화면 글(계약 FhCode). 토큰·비밀번호는 오류에 없다(계약)
const MSG: Record<string, string> = {
  bad_input: '입력 형식이 맞지 않음', no_gate: '관문 주소를 먼저 정하세요(«바꾸기»)', no_session: '로그인 필요', bad_state: '앱 상태 이상 — 다시 시도',
  stale: '연결이 바뀜 — 옛 응답 버림', tls: '관문 인증서 확인 실패', net: '관문에 닿지 않음', unknown: '알 수 없는 오류', auth: '계정 또는 비밀번호가 틀림',
  origin: '관문이 앱 출처를 거부', busy: '처리 중 — 잠시 뒤 다시', redirect: '관문이 다른 주소로 보냄(거부)', server: '관문 오류', too_big: '응답이 너무 큼',
  bad_type: '응답 형식 이상', storage: '기기 로그아웃 저장 실패 — 다시 로그아웃', internal: '앱 내부 오류',
};
export const STALE = MSG.stale;

export function nativeTransport(P: any): Transport {
  let gen: number | null = null;   // 화면이 아는 현재 세대(state·login·logout·setGate 결과로만 바뀜)
  const ended: (() => void)[] = [];
  const sync = P.state().then((s: { gen: number }) => { gen = s.gen; return s; });
  P.addListener('sessionEnded', (v: { gen: number }) => { if (v.gen === gen) for (const f of ended) f(); });   // 다른 세대 이벤트는 버림
  const why = (e: any) => (e?.code === 'stale' || e?.data?.gen !== gen ? STALE : MSG[e?.code] || e?.message || String(e));
  const cur = <T extends { gen: number }>(r: T): T => { if (r.gen !== gen) throw new Error(STALE); return r; };
  const req = async (op: string, body?: unknown): Promise<Res> => {
    await sync;
    try { const r = cur(await P.request(body === undefined ? { op } : { op, body })); return { status: r.status, body: r.body }; }
    catch (e: any) {
      if (e instanceof Error && e.message === STALE) throw e;
      if (e?.code === 'no_session' && e?.data?.gen === gen) for (const f of ended) f();
      throw new Error(why(e));
    }
  };
  const logoutRaw = async (): Promise<LogoutResult> => {
    try { const r = await P.logout({ reason: 'user' }); gen = r.gen; return r.ok ? { ok: true } : { ok: false, note: MSG.storage }; }
    catch (e) { return { ok: false, note: why(e) }; }
  };
  return {
    kind: 'native', gated: true,
    async where() { const s = await P.state().catch(() => null); return s?.origin ? `관문 · ${s.origin}` : '관문 주소 없음 — «바꾸기»'; },
    async setGate(origin) {
      await sync;
      try { const r = await P.setGate({ origin }); gen = r.gen; return null; } catch (e) { return why(e); }
    },
    async login(user, pw, label) {
      const s = await sync.then(() => P.state()).catch(() => null);
      if (s?.locked) { const o = await logoutRaw(); if (!o.ok) return { ok: false, error: o.note || MSG.storage }; }   // 잠김: 다시 로그아웃(디스크 폐기)부터
      const g0 = gen;
      try {
        const r = await P.login({ user, pw, label });
        if (gen !== g0) return { ok: false, error: STALE };   // 그 사이 로그아웃·주소 변경으로 세대가 바뀜
        gen = r.gen;
        return { ok: true, note: r.stored === false ? '이 기기에 저장 안 됨 — 앱을 다시 켜면 다시 로그인' : undefined };
      } catch (e) { return { ok: false, error: why(e) }; }
    },
    async logout() { await sync; return logoutRaw(); },
    get: (what) => req(what === 'docs' ? 'docs.get' : 'media.list'),
    postDocs: (body) => req('docs.post', body),
    async photo(url) {
      await sync;
      let r: any;
      try { r = cur(await P.photo({ path: url })); } catch (e: any) { throw e instanceof Error && e.message === STALE ? e : new Error(why(e)); }
      if (r.status !== 200 || typeof r.base64 !== 'string') return null;
      const b = atob(r.base64), a = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
      return URL.createObjectURL(new Blob([a], { type: 'image/jpeg' }));
    },
    async wsUrl() {
      await sync;
      try { const r = await P.wsTicket(); return r.gen === gen ? r.url : null; }   // 세대가 다르면 열지 않음
      catch (e: any) { if (e?.code === 'no_session' && e?.data?.gen === gen) for (const f of ended) f(); return null; }
    },
    onEnded(f) { ended.push(f); },
  };
}

const W: any = typeof window !== 'undefined' ? window : {};
const APP_ORIGINS = ['https://localhost', 'capacitor://localhost'];
const plugin = APP_ORIGINS.includes(W.location?.origin) ? W.Capacitor?.Plugins?.FhGate : undefined;
export const T: Transport = plugin ? nativeTransport(plugin) : web;

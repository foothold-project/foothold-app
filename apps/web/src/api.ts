// 서버 REST 클라이언트 하나(05 API §1·§2·§3·§8). 웹은 쿠키 fh_s(HttpOnly) + 변경 요청마다 X-FH-CSRF.
// CSRF 값은 로그인 응답 또는 새로고침 뒤 GET /auth/session 에서 받는다(apps/server/README). 타입은 계약 생성물만 쓴다.
import type { ApiError, LoginResponse, MePatch, OrgSettings, OrgSettingsPatch, PasswordChange, RobotSummary, Session, SessionInfo, User, UserCreate, UserPatch } from '../../contracts/ts';

const BASE = '/api/v1';
/** 오류 본문이 없을 때(중간 프록시 오류 등)만 쓰는 문구. 서버 message 가 있으면 그것을 그대로 보인다(§1.4) */
const FALLBACK: Record<number, string> = {
  401: '로그인이 필요합니다. 다시 로그인하세요.',
  403: '권한이 없습니다. 총괄 운영 관리자에게 문의하세요.',
  429: '요청이 많습니다. 잠시 뒤 다시 시도하세요.',
};
const NETWORK = '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.';
const SLOW = '서버가 제시간에 답하지 않았습니다.';

/** 화면에 그대로 보여도 되는 오류. status 0 = 서버에 닿지 못함, said = 서버가 계약 오류 본문(error.code)으로 답함 */
export class ApiFail extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly said = false) { super(message); }
}

let csrf: string | null = null;
let authLost = (_why?: string) => {};
/** 로그인·세션 확인 밖의 요청이 401 이면 부른다 — 화면은 로그인으로. why = 로그인 화면에 보일 이유(없으면 기본 문구) */
export const onAuthLost = (f: (why?: string) => void) => { authLost = f; };
/** 로그인이 끝났다(401·실시간 4401·비밀번호 변경) — CSRF 를 버리고 화면은 로그인으로 */
export const expireAuth = (why?: string) => { csrf = null; authLost(why); };

/** ms = 답을 기다리는 한도(넘으면 끊고 TIMEOUT), cancel = 부른 쪽이 거둠(세션이 끝남 등 — CANCELED, 401 이어도 로그인 정리 안 함) */
type Opt = { ms?: number; cancel?: AbortSignal };
async function call<T>(method: string, path: string, body?: unknown, { ms, cancel }: Opt = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-FH-CSRF'] = csrf;
  if (cancel?.aborted) throw new ApiFail(0, 'CANCELED', NETWORK);
  const stop = new AbortController(), timer = ms ? setTimeout(() => stop.abort(), ms) : undefined, off = () => stop.abort();
  cancel?.addEventListener('abort', off);
  let res: Response, data: unknown;
  try {
    try {
      res = await fetch(BASE + path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: stop.signal, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw cancel?.aborted ? new ApiFail(0, 'CANCELED', NETWORK) : stop.signal.aborted ? new ApiFail(0, 'TIMEOUT', SLOW) : new ApiFail(0, 'NETWORK', NETWORK); }
    if (res.status === 204) return undefined as T;
    data = await res.json().catch(() => null);
  } finally { clearTimeout(timer); cancel?.removeEventListener('abort', off); }
  if (cancel?.aborted) throw new ApiFail(0, 'CANCELED', NETWORK);   // 거둔 뒤 온 답(앞 세션의 401 등)은 반영하지 않는다
  if (res.ok) return data as T;
  const e = (data as Partial<ApiError> | null)?.error;
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/session') expireAuth();
  throw new ApiFail(res.status, e?.code ?? 'INTERNAL_ERROR', e?.message || (FALLBACK[res.status] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'), typeof e?.code === 'string');
}

/** 목록 쪽 넘김(§1.5)을 끝까지 */
async function pages<T>(path: string, cancel?: AbortSignal) {
  const all: T[] = [];
  for (let cursor: string | null = ''; cursor != null;) {
    const r: { items: T[]; next_cursor: string | null } = await call('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, { cancel });
    all.push(...r.items); cursor = r.next_cursor;
  }
  return all;
}

export const api = {
  async login(username: string, password: string) {
    const r = await call<LoginResponse>('POST', '/auth/login', { username, password, client: 'web', device_label: '웹 브라우저' });
    csrf = r.csrf_token;
    return r;
  },
  /** 새로고침·새 탭: 쿠키로 CSRF 다시 받기. 401 = 로그인 안 됨 */
  async session() { const r = await call<SessionInfo>('GET', '/auth/session'); csrf = r.csrf_token; return r; },
  async logout() { await call<void>('POST', '/auth/logout'); csrf = null; },
  me: (cancel?: AbortSignal) => call<User>('GET', '/me', undefined, { cancel }),
  /** 화면은 scope=all(02 §1.1) */
  robots: (scope: 'mine' | 'all', cancel?: AbortSignal) => pages<RobotSummary>(`/robots?scope=${scope}`, cancel),
  /** 내 이름(05 §2 PATCH /me) */
  saveMe: (p: MePatch) => call<User>('PATCH', '/me', p),
  /** 성공(204)하면 서버가 이 사용자의 모든 세션(지금 기기 포함)을 끝낸다 — 부른 쪽이 로그인 화면으로 */
  password: (p: PasswordChange) => call<void>('POST', '/me/password', p),
  // 계정 관리(총괄, 05 §2)
  users: () => pages<User>('/users'),
  createUser: (p: UserCreate) => call<User>('POST', '/users', p),
  saveUser: (id: string, p: UserPatch) => call<User>('PATCH', `/users/${encodeURIComponent(id)}`, p),
  deleteUser: (id: string) => call<void>('DELETE', `/users/${encodeURIComponent(id)}`),
  sessions: (id: string) => pages<Session>(`/users/${encodeURIComponent(id)}/sessions`),
  endSession: (id: string, sid: string) => call<void>('DELETE', `/users/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sid)}`),
  settings: () => call<OrgSettings>('GET', '/org/settings'),
  saveSettings: (p: OrgSettingsPatch) => call<OrgSettings>('PATCH', '/org/settings', p),
  /** STOP 대체 경로(§3, 실시간 연결이 끊겼을 때). 202 = 서버 접수일 뿐 로봇 정지 확인이 아니다 */
  stop: (robot: string, opt?: Opt) => call<unknown>('POST', `/robots/${encodeURIComponent(robot)}/stop`, undefined, opt),
};

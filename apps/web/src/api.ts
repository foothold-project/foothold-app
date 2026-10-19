// 서버 REST 클라이언트 하나(05 API §1·§2·§3·§8). 웹은 쿠키 fh_s(HttpOnly) + 변경 요청마다 X-FH-CSRF.
// CSRF 값은 로그인 응답 또는 새로고침 뒤 GET /auth/session 에서 받는다(apps/server/README). 타입은 계약 생성물만 쓴다.
import type { ApiError, LoginResponse, OrgSettings, OrgSettingsPatch, RobotList, RobotSummary, SessionInfo, User } from '../../contracts/ts';

const BASE = '/api/v1';
/** 오류 본문이 없을 때(중간 프록시 오류 등)만 쓰는 문구. 서버 message 가 있으면 그것을 그대로 보인다(§1.4) */
const FALLBACK: Record<number, string> = {
  401: '로그인이 필요합니다. 다시 로그인하세요.',
  403: '권한이 없습니다. 총괄 운영 관리자에게 문의하세요.',
  429: '요청이 많습니다. 잠시 뒤 다시 시도하세요.',
};
const NETWORK = '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.';

/** 화면에 그대로 보여도 되는 오류. status 0 = 서버에 닿지 못함 */
export class ApiFail extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

let csrf: string | null = null;
let authLost = () => {};
/** 로그인·세션 확인 밖의 요청이 401 이면 부른다 — 화면은 로그인으로 */
export const onAuthLost = (f: () => void) => { authLost = f; };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-FH-CSRF'] = csrf;
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiFail(0, 'NETWORK', NETWORK); }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return data as T;
  const e = (data as Partial<ApiError> | null)?.error;
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/session') { csrf = null; authLost(); }
  throw new ApiFail(res.status, e?.code ?? 'INTERNAL_ERROR', e?.message || (FALLBACK[res.status] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'));
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
  me: () => call<User>('GET', '/me'),
  /** 서버가 정한 범위 그대로(화면에서 거르지 않음). 쪽 넘김(§1.5)을 끝까지 */
  async robots(scope: 'mine' | 'all') {
    const all: RobotSummary[] = [];
    for (let cursor: string | null = ''; cursor != null;) {
      const r: RobotList = await call<RobotList>('GET', `/robots?scope=${scope}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      all.push(...r.items); cursor = r.next_cursor;
    }
    return all;
  },
  settings: () => call<OrgSettings>('GET', '/org/settings'),
  saveSettings: (p: OrgSettingsPatch) => call<OrgSettings>('PATCH', '/org/settings', p),
};

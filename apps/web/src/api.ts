// 서버 REST 클라이언트 하나(05 API §1·§2·§3·§8). 웹은 쿠키 fh_s(HttpOnly) + 변경 요청마다 X-FH-CSRF.
// CSRF 값은 로그인 응답 또는 새로고침 뒤 GET /auth/session 에서 받는다(apps/server/README). 타입은 계약 생성물만 쓴다.
import type { AgentTokenResponse, ApiError, Dashboard, Event, EventList, FloorCreate, FloorPatch, LoginResponse, MapBuilding, MapFloor, MapSite, MapUpload, MapVersion, MapVersionCreate, MePatch, NotificationList, NotificationsRead, OrgSettings, OrgSettingsPatch, PasswordChange, RobotCreate, RobotCreated, RobotPatch, RobotSummary, Session, SessionInfo, SiteTree, User, UserCreate, UserPatch } from '../../contracts/ts';

const BASE = '/api/v1';
/** 오류 본문이 없을 때(중간 프록시 오류 등)만 쓰는 문구. 서버 message 가 있으면 그것을 그대로 보인다(§1.4) */
const FALLBACK: Record<number, string> = {
  401: '로그인이 필요합니다. 다시 로그인하세요.',
  403: '권한이 없습니다. 총괄 운영 관리자에게 문의하세요.',
  429: '요청이 많습니다. 잠시 뒤 다시 시도하세요.',
};
const NETWORK = '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.';
const SLOW = '서버가 제시간에 답하지 않았습니다.';
/** 알림 한 번 받기 제한시간 — 다음 폴링은 이 요청이 끝난 뒤(screens/history.tsx Bell) */
export const NOTE_MS = 10_000;

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

/** ms = 답을 기다리는 한도(넘으면 끊고 TIMEOUT), cancel = 부른 쪽이 거둠(세션이 끝남 등 — CANCELED, 401 이어도 로그인 정리 안 함).
 *  file = 성공 본문을 JSON 대신 Blob 으로(CSV 내려받기 — 실패 본문은 그대로 오류 JSON). raw = 본문을 JSON 대신 이 Content-Type 의 원시 바이트로(지도 올리기) */
type Opt = { ms?: number; cancel?: AbortSignal; file?: boolean; raw?: string };
async function call<T>(method: string, path: string, body?: unknown, { ms, cancel, file, raw }: Opt = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = raw ?? 'application/json';
  if (method !== 'GET' && csrf) headers['X-FH-CSRF'] = csrf;
  if (cancel?.aborted) throw new ApiFail(0, 'CANCELED', NETWORK);
  const stop = new AbortController(), timer = ms ? setTimeout(() => stop.abort(), ms) : undefined, off = () => stop.abort();
  cancel?.addEventListener('abort', off);
  let res: Response, data: unknown;
  try {
    const lost = () => (cancel?.aborted ? new ApiFail(0, 'CANCELED', NETWORK) : stop.signal.aborted ? new ApiFail(0, 'TIMEOUT', SLOW) : new ApiFail(0, 'NETWORK', NETWORK));
    try {
      res = await fetch(BASE + path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: stop.signal, body: body === undefined ? undefined : raw ? body as Blob : JSON.stringify(body) });
    } catch { throw lost(); }
    // 파일 본문을 받다 끊기면 실패(빈 성공으로 넘기지 않음). 204 도 아래 취소 검사를 거친다(늦게 끝난 쓰기)
    if (file && res.ok) data = await res.blob().catch(() => { throw lost(); });
    else if (res.status !== 204) data = await res.json().catch(() => null);
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
  /** 한 대(05 §3). 담당 밖 운영 관리자에게는 요약만(실시간 값 null·UNKNOWN) */
  robot: (id: string, cancel?: AbortSignal) => call<RobotSummary>('GET', `/robots/${encodeURIComponent(id)}`, undefined, { cancel }),
  /** 관제 요약(05 §4) — 총괄 조직 전체, 운영 관리자는 담당 범위 */
  dashboard: (cancel?: AbortSignal) => call<Dashboard>('GET', '/dashboard', undefined, { cancel }),
  // 로봇 등록·바꾸기(총괄, 05 §3). agent_token 은 응답에서 한 번만 온다 — 부른 쪽이 보여 주고 버린다
  createRobot: (p: RobotCreate, cancel?: AbortSignal) => call<RobotCreated>('POST', '/robots', p, { cancel }),
  saveRobot: (id: string, p: RobotPatch, cancel?: AbortSignal) => call<RobotSummary>('PATCH', `/robots/${encodeURIComponent(id)}`, p, { cancel }),
  deleteRobot: (id: string, cancel?: AbortSignal) => call<void>('DELETE', `/robots/${encodeURIComponent(id)}`, undefined, { cancel }),
  robotToken: (id: string, cancel?: AbortSignal) => call<AgentTokenResponse>('POST', `/robots/${encodeURIComponent(id)}/agent-token`, undefined, { cancel }),
  // 설정 탭 요청은 cancel(로그인 세션의 취소 신호)을 받는다 — 세션이 끝난 뒤 온 답은 CANCELED 로 버려 다음 세션의 인증을 건드리지 않음
  /** 내 이름(05 §2 PATCH /me) */
  saveMe: (p: MePatch, cancel?: AbortSignal) => call<User>('PATCH', '/me', p, { cancel }),
  /** 성공(204)하면 서버가 이 사용자의 모든 세션(지금 기기 포함)을 끝낸다 — 부른 쪽이 로그인 화면으로 */
  password: (p: PasswordChange, cancel?: AbortSignal) => call<void>('POST', '/me/password', p, { cancel }),
  // 계정 관리(총괄, 05 §2)
  users: (cancel?: AbortSignal) => pages<User>('/users', cancel),
  createUser: (p: UserCreate, cancel?: AbortSignal) => call<User>('POST', '/users', p, { cancel }),
  saveUser: (id: string, p: UserPatch, cancel?: AbortSignal) => call<User>('PATCH', `/users/${encodeURIComponent(id)}`, p, { cancel }),
  deleteUser: (id: string, cancel?: AbortSignal) => call<void>('DELETE', `/users/${encodeURIComponent(id)}`, undefined, { cancel }),
  sessions: (id: string, cancel?: AbortSignal) => pages<Session>(`/users/${encodeURIComponent(id)}/sessions`, cancel),
  endSession: (id: string, sid: string, cancel?: AbortSignal) => call<void>('DELETE', `/users/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sid)}`, undefined, { cancel }),
  settings: (cancel?: AbortSignal) => call<OrgSettings>('GET', '/org/settings', undefined, { cancel }),
  saveSettings: (p: OrgSettingsPatch, cancel?: AbortSignal) => call<OrgSettings>('PATCH', '/org/settings', p, { cancel }),
  // 기록·알림(05 §8). q = 필터 매개변수(category·robot_id·from·to·cursor·limit) — 범위는 서버가 정한다(운영 관리자는 내 로봇 + 내 행동)
  events: (q: URLSearchParams, cancel?: AbortSignal) => call<EventList>('GET', `/events?${q}`, undefined, { cancel }),
  /** 알림이 가리키는 사건 하나. 범위 밖·없음 = 404 */
  event: (id: string, cancel?: AbortSignal) => call<Event>('GET', `/events/${encodeURIComponent(id)}`, undefined, { cancel }),
  /** 같은 필터 그대로 CSV(10,000행 넘으면 400 EXPORT_LIMIT — 잘린 파일은 오지 않는다) */
  exportEvents: (q: URLSearchParams, cancel?: AbortSignal) => call<Blob>('GET', `/events/export.csv?${q}`, undefined, { cancel, file: true }),
  /** 내 알림 최신 20개 + 안 읽은 수(페이지와 무관한 전체 수) */
  notifications: (cancel?: AbortSignal) => call<NotificationList>('GET', '/notifications?limit=20', undefined, { cancel, ms: NOTE_MS }),
  /** {ids} 또는 {all:true} — 204. 남의·없는 id 가 섞이면 404(하나도 읽음 처리 안 됨) */
  readNotifications: (p: NotificationsRead, cancel?: AbortSignal) => call<void>('POST', '/notifications/read', p, { cancel }),
  // 장소·층·지도 판(05 §5, S3a). 만들기·이름 바꾸기·지우기는 총괄만(운영 관리자는 서버가 403). kind = 경로 앞부분
  sites: (cancel?: AbortSignal) => call<SiteTree>('GET', '/sites', undefined, { cancel }),
  createSite: (name: string, cancel?: AbortSignal) => call<MapSite>('POST', '/sites', { name }, { cancel }),
  createBuilding: (site: string, name: string, cancel?: AbortSignal) => call<MapBuilding>('POST', `/sites/${encodeURIComponent(site)}/buildings`, { name }, { cancel }),
  createFloor: (building: string, p: FloorCreate, cancel?: AbortSignal) => call<MapFloor>('POST', `/buildings/${encodeURIComponent(building)}/floors`, p, { cancel }),
  savePlace: (kind: 'sites' | 'buildings' | 'floors', id: string, p: FloorPatch, cancel?: AbortSignal) => call<unknown>('PATCH', `/${kind}/${encodeURIComponent(id)}`, p, { cancel }),
  /** 안에 건물·층·지도 판이 있거나 로봇·연결점이 쓰는 층이면 409 RESOURCE_IN_USE */
  deletePlace: (kind: 'sites' | 'buildings' | 'floors', id: string, cancel?: AbortSignal) => call<void>('DELETE', `/${kind}/${encodeURIComponent(id)}`, undefined, { cancel }),
  /** 층의 판 목록(최신 번호 먼저, 지도 요소 포함) */
  versions: (floor: string, cancel?: AbortSignal) => pages<MapVersion>(`/floors/${encodeURIComponent(floor)}/map-versions`, cancel),
  version: (id: string, cancel?: AbortSignal) => call<MapVersion>('GET', `/map-versions/${encodeURIComponent(id)}`, undefined, { cancel }),
  /** 판 그림(png) 주소 — <image> 가 쿠키로 바로 받는다(큰 그림을 JS 메모리로 옮기지 않음) */
  imageUrl: (id: string) => `${BASE}/map-versions/${encodeURIComponent(id)}/image`,
  /** 원시 본문 올리기 두 단계: 그림(type = image/png·image/x-portable-graymap) → 그 ID 로 yaml(text/yaml). 둘째 응답 ID 가 판 저장의 image */
  upload: (body: Blob, type: string, image?: string, cancel?: AbortSignal) => call<MapUpload>('POST', `/uploads${image ? `?image=${encodeURIComponent(image)}` : ''}`, body, { cancel, raw: type }),
  /** 총괄 = 바로 승인 판. base_version_id 가 지금 승인 판과 다르면 409 STALE, 운영 관리자는 403 APPROVAL_REQUIRED(S4 전) */
  saveVersion: (floor: string, p: MapVersionCreate, cancel?: AbortSignal) => call<MapVersion>('POST', `/floors/${encodeURIComponent(floor)}/map-versions`, p, { cancel }),
  /** STOP 대체 경로(§3, 실시간 연결이 끊겼을 때). 202 = 서버 접수일 뿐 로봇 정지 확인이 아니다 */
  stop: (robot: string, opt?: Opt) => call<unknown>('POST', `/robots/${encodeURIComponent(robot)}/stop`, undefined, opt),
};

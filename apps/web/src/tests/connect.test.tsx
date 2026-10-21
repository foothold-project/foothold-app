// 화면 ↔ 서버 REST(05 API §1·§2·§3·§8) — fetch 를 가짜 서버로 바꿔 로그인·세션 복원·401·429·로봇 범위·조직 기준값을 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgSettings, RobotSummary, User } from '../../../contracts/ts';
import { api } from '../api';
import { ROBOTS as MEM_ROBOTS, USERS as MEM_USERS } from '../fake';
import { rt } from '../rt';
import { LIST_MS, Root } from '../session';
import { FakeWS, lease, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR' };
const robot = (id: string, name: string, owner: string, ownerName: string): RobotSummary => ({ id, name, model: 'unitree_go2', owner: { id: owner, display_name: ownerName },
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] });
const LIMITS: OrgSettings = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });
const NO_LOGIN = err(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');

type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown; credentials?: string };
let calls: Call[] = [], routes: Record<string, Reply | (() => Reply)> = {};
/** 가짜 서버: '<METHOD> <경로(쿼리 제외)>' → 응답 */
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path, headers: { ...(init.headers as Record<string, string>) }, body: init.body ? JSON.parse(String(init.body)) : undefined, credentials: init.credentials });
    const hit = routes[`${method} ${path.split('?')[0]}`], rep = typeof hit === 'function' ? hit() : hit ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, robots: RobotSummary[], more: typeof routes = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: robots, next_cursor: null } },
  'GET /org/settings': { status: 200, body: LIMITS },
  ...more,
});

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash = '#/fleet', phone = false) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
beforeEach(() => { calls = []; });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
async function login(id: string, pw: string) {
  type($<HTMLInputElement>('input[name="username"]')!, id);
  type($<HTMLInputElement>('input[name="password"]')!, pw);
  act(() => { $<HTMLFormElement>('form')!.requestSubmit(); });
  await flush();
}

describe('REST 클라이언트', () => {
  it('변경 요청에는 X-FH-CSRF(세션에서 받은 값), 조회에는 없음. 쿠키는 같은 출처로', async () => {
    serve(signedIn(KIM, []));
    routes['PATCH /org/settings'] = { status: 200, body: { ...LIMITS, battery_low_pct: 25 } };
    await api.session();
    await api.settings();
    await api.saveSettings({ battery_low_pct: 25 });
    const [, get, patch] = calls;
    expect(get.headers['X-FH-CSRF']).toBeUndefined();
    expect(patch.headers['X-FH-CSRF']).toBe('csrf-1');
    expect(patch.body).toEqual({ battery_low_pct: 25 });
    expect(calls.every((c) => c.credentials === 'same-origin')).toBe(true);
  });
  it('오류 본문(§1.4)의 message 를 그대로, 본문이 없으면 HTTP 숫자 없는 대체 문구', async () => {
    serve({ 'GET /me': err(403, 'FORBIDDEN', '권한이 없습니다.'), 'GET /org/settings': { status: 502 } });
    await expect(api.me()).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', message: '권한이 없습니다.' });
    await expect(api.settings()).rejects.toMatchObject({ status: 502, message: '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.' });
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fail')));
    await expect(api.me()).rejects.toMatchObject({ status: 0, message: expect.stringContaining('서버에 연결하지 못했습니다') });
  });
});

describe('로그인·세션', () => {
  it('세션 없음(401) → 로그인 화면, STOP·탭 없음', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open();
    expect($('main[aria-label="로그인"]')).not.toBeNull();
    expect($('[data-stop]')).toBeNull();
    expect($('[role="alert"]')).toBeNull();   // 첫 방문은 «끝났습니다» 안내 없음
  });
  it('로그인 → /me 역할·/robots → 관제. 로그인 응답의 CSRF 로 변경 요청', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': { status: 200, body: { ...KIM, csrf_token: 'csrf-L', access_token: null, refresh_token: null } },
      'GET /me': { status: 200, body: KIM }, 'GET /robots': { status: 200, body: { items: [robot('r-a', 'Go2-A', 'o1', '이운영')], next_cursor: null } },
      'GET /org/settings': { status: 200, body: LIMITS }, 'POST /auth/logout': { status: 204 } });
    await open();
    await login('kim', 'pw');
    expect(calls.find((c) => c.path === '/auth/login')!.body).toMatchObject({ username: 'kim', password: 'pw', client: 'web' });
    expect($('.fh-me')!.textContent).toBe('김총괄(총괄)');
    expect(calls.find((c) => c.path.startsWith('/robots'))!.path).toContain('scope=all');
    expect($('[aria-label="로봇 목록"]')!.textContent).toContain('Go2-A');
    act(() => btn('로그아웃')!.click());
    await flush();
    expect(calls[calls.length - 1]).toMatchObject({ method: 'POST', path: '/auth/logout', headers: { 'X-FH-CSRF': 'csrf-L' } });
    expect($('main[aria-label="로그인"]')).not.toBeNull();
  });
  it('새로고침: /auth/session 으로 CSRF 를 다시 받아 로그인 없이 복원, 그 값으로 변경 요청', async () => {
    serve(signedIn(KIM, [], { 'PATCH /org/settings': { status: 200, body: LIMITS }, 'POST /auth/logout': { status: 204 } }));
    await open('#/settings');
    expect(calls.map((c) => c.path).slice(0, 3)).toEqual(['/auth/session', '/me', '/robots?scope=all&limit=100']);
    expect($('main[aria-label="로그인"]')).toBeNull();
    expect($('.fh-me')!.textContent).toBe('김총괄(총괄)');
    type($<HTMLInputElement>('input[name="battery_low_pct"]')!, '25');
    act(() => btn('저장')!.click());
    await flush();
    expect(calls.find((c) => c.method === 'PATCH')!.headers['X-FH-CSRF']).toBe('csrf-1');
  });
  it('쓰는 중 401 → 로그인 화면 + «다시 로그인» 안내', async () => {
    serve(signedIn(KIM, [], { 'GET /org/settings': NO_LOGIN }));
    await open('#/settings');
    expect($('main[aria-label="로그인"]')).not.toBeNull();
    expect($('[role="alert"]')!.textContent).toBe('로그인이 끝났습니다. 다시 로그인하세요.');
    expect([MEM_USERS.length, MEM_ROBOTS.length]).toEqual([0, 0]);   // 401 뒤 메모리에도 이전 자료 0
  });
  it('B1 총괄 로그아웃 → 운영 관리자 로그인: 이전 사용자·로봇·조종 상태가 메모리·화면에 0', async () => {
    let me = KIM;
    const mine = { a1: [robot('r-k', 'Go2-K', 'a1', '김총괄')], o1: [robot('r-l', 'Go2-L', 'o1', '이운영')] };
    serve(signedIn(KIM, [], {
      'GET /me': () => ({ status: 200, body: me }),
      'GET /robots': () => ({ status: 200, body: { items: mine[me.id as 'a1' | 'o1'], next_cursor: null } }),
      'POST /auth/logout': { status: 204 },
      'POST /auth/login': () => { me = LEE; return { status: 200, body: { ...LEE, csrf_token: 'csrf-2', access_token: null, refresh_token: null } }; },
    }));
    await open();
    expect($('[aria-label="로봇 목록"]')!.textContent).toContain('Go2-K');
    act(() => btn('로그아웃')!.click());
    await flush();
    expect($('main[aria-label="로그인"]')).not.toBeNull();
    expect([MEM_USERS.length, MEM_ROBOTS.length]).toEqual([0, 0]);
    expect(rt.get('r-k').state).toBeNull();     // 실시간 저장소도 비움
    expect(box.textContent).not.toMatch(/김총괄|Go2-K/);

    const seen: string[] = [];   // 운영 관리자 로그인 동안 그려진 모든 화면에 이전 자료가 한 번도 없는지
    const watch = new MutationObserver(() => seen.push(box.textContent!));
    watch.observe(box, { childList: true, subtree: true, characterData: true });
    await login('lee', 'pw');
    watch.disconnect();
    expect($('.fh-me')!.textContent).toBe('이운영(운영 관리자)');
    expect([...box.querySelectorAll('[aria-label="로봇 목록"] b')].map((b) => b.textContent)).toEqual(['Go2-L']);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((t) => /김총괄|Go2-K/.test(t))).toEqual([]);
    expect(MEM_ROBOTS.map((r) => r.name)).toEqual(['Go2-L']);
  });
  it('틀림(401)·제한(429)은 서버 문구 그대로, 로그인 화면 유지', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': err(401, 'AUTH_REQUIRED', '계정 또는 비밀번호를 확인하세요.') });
    await open();
    await login('kim', 'bad');
    expect($('[role="alert"]')!.textContent).toBe('계정 또는 비밀번호를 확인하세요.');
    routes['POST /auth/login'] = err(429, 'RATE_LIMITED', '로그인 시도가 많습니다. 잠시 뒤 다시 시도하세요.');
    await login('kim', 'bad');
    expect($('[role="alert"]')!.textContent).toBe('로그인 시도가 많습니다. 잠시 뒤 다시 시도하세요.');
    expect($('main[aria-label="로그인"]')).not.toBeNull();
    expect(box.textContent).not.toMatch(/HTTP|429|401/);
  });
});

describe('로봇 목록 = GET /robots?scope=all(02 §1.1)', () => {
  const ROBOTS = [robot('r-b', 'Go2-B', 'o2', '박운영'), robot('r-a', 'Go2-A', 'o1', '이운영')];
  const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
  const row = (name: string) => [...box.querySelectorAll('[aria-label="로봇 목록"] button')].find((b) => b.textContent!.includes(name))!;
  it('운영 관리자도 scope=all: 내 로봇 먼저, 남의 로봇은 보기 전용 + 조종 비활성 이유, STOP 은 됨', async () => {
    serve(signedIn(LEE, ROBOTS, { 'GET /dashboard': { status: 200, body: { robots_total: 1, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } } }));
    await open();
    expect(calls.find((c) => c.path.startsWith('/robots'))!.path).toContain('scope=all');
    expect([...box.querySelectorAll('[aria-label="로봇 목록"] b')].map((b) => b.textContent)).toEqual(['Go2-A', 'Go2-B']);
    expect(row('Go2-B').textContent).toContain('박운영 · 보기 전용');   // 담당자 이름은 서버 owner 값
    expect(row('Go2-A').textContent).not.toContain('보기 전용');
    expect([...box.querySelectorAll('main div')].find((d) => d.firstElementChild?.textContent === '내 로봇')!.querySelector('b')!.textContent).toBe('1');   // 요약은 서버가 담당 범위로 센 값(목록은 전체)

    click(row('Go2-B'));
    expect($('[aria-label="로봇 상세"] .btn.pri')).toBeNull();   // 총괄 웹에는 조종 단추가 없다(ADR-002 §4 — 조종은 폰)
    act(() => FakeWS.last.open());
    expect(FakeWS.last.of('sub')).toMatchObject([{ robots: ['r-a'] }]);   // 남의 로봇은 구독하지 않음(서버가 4403 으로 닫는다)
    click($('[data-stop]')!);
    expect(FakeWS.last.of('stop')).toMatchObject([{ robot: 'r-b' }]);
    expect($('[data-band]')!.textContent).toContain('Go2-B 정지 요청됨');
    expect($('a[href="#/drive"]')).toBeNull();
  });
  it('폰: 로봇 연결은 내 로봇만, 머리줄 ⋯ 에 기록·로그아웃, 기록 화면 ⋯ 에는 로그아웃 하나', async () => {
    serve(signedIn(LEE, ROBOTS, { 'POST /auth/logout': { status: 204 } }));
    await open('#/fleet', true);
    expect([...box.querySelectorAll('.dv-card b')].map((b) => b.textContent)).toEqual(['Go2-A']);
    expect([...$('header details')!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['기록', '로그아웃']);
    click(btn('기록')!);
    expect(location.hash).toBe('#/history');
    expect($('header')!.lastElementChild).toBe($('[data-stop]'));   // STOP 은 여전히 맨 오른쪽
    const more = $('header details')!;
    expect([...more.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['로그아웃']);
    click(more.querySelector('button')!);
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/auth/logout')).toBe(true);
    expect($('main[aria-label="로그인"]')).not.toBeNull();
  });
  it('[B6] 운영 관리자: 구독 못 하는 남의 로봇의 조종권자는 목록 값으로, 목록은 주기적으로 다시 받아 갱신', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const other = robot('r-b', 'Go2-B', 'o2', '박운영');
      serve(signedIn(LEE, [robot('r-a', 'Go2-A', 'o1', '이운영'), { ...other, lease: { holder_type: 'USER', user: { id: 'o2', display_name: '박운영' }, since: '2026-10-19T00:00:00Z' } }], {
        // 상세는 지금 목록에 있는 값 그대로(조종 화면이 총괄 웹에서 빠져 조종권자는 로봇 상세에서 본다)
        'GET /robots/r-b': () => ({ status: 200, body: (routes['GET /robots'] as { body: { items: RobotSummary[] } }).body.items.find((x) => x.id === 'r-b') }),
      }));
      await open('#/fleet');
      const detail = () => $('[aria-label="로봇 상세"]')!.textContent;
      const lists = () => calls.filter((c) => c.path.split('?')[0] === '/robots').length;
      act(() => (row('Go2-B') as HTMLElement).click());
      await flush();
      expect(detail()).toContain('박운영님 조종 중(목록');
      const n = lists();
      routes['GET /robots'] = { status: 200, body: { items: [robot('r-a', 'Go2-A', 'o1', '이운영'), other], next_cursor: null } };
      act(() => { vi.advanceTimersByTime(LIST_MS); });
      await flush();
      expect(lists()).toBe(n + 1);
      act(() => (row('Go2-A') as HTMLElement).click());
      act(() => (row('Go2-B') as HTMLElement).click());
      await flush();
      expect(detail()).toContain('조종권자 확인 안 됨');   // 목록의 null 을 «없음»으로 단정하지 않음
      expect(detail()).not.toContain('조종하는 사람 없음');
    } finally { vi.useRealTimers(); }
  });
  it('[B6] 총괄은 모두 실시간 구독이라 목록을 다시 받지 않음', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      serve(signedIn(KIM, [robot('r-a', 'Go2-A', 'o1', '이운영')]));
      await open();
      const n = calls.length;
      act(() => { vi.advanceTimersByTime(LIST_MS * 3); });
      await flush();
      expect(calls.filter((c) => c.path.startsWith('/robots')).length).toBe(calls.slice(0, n).filter((c) => c.path.startsWith('/robots')).length);
    } finally { vi.useRealTimers(); }
  });
  it('[N4] 앞 사람의 늦은 목록 응답은 버림 — 로그아웃 뒤 다음 계정의 목록·화면을 덮지 않음', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const PARK: User = { ...LEE, id: 'o2', username: 'park', display_name: '박운영' };
      let me = LEE, hold: ((r: Response) => void) | null = null, signal: AbortSignal | undefined;
      serve(signedIn(LEE, [], {
        'GET /me': () => ({ status: 200, body: me }),
        'GET /robots': () => ({ status: 200, body: { items: [robot(`r-${me.id}`, `Go2-${me.display_name}`, me.id, me.display_name)], next_cursor: null } }),
        'POST /auth/logout': { status: 204 },
        'POST /auth/login': () => { me = PARK; return { status: 200, body: { ...PARK, csrf_token: 'csrf-2', access_token: null, refresh_token: null } }; },
      }));
      const base = globalThis.fetch;
      vi.stubGlobal('fetch', (u: string, init: RequestInit = {}) => {
        if (me === LEE && u.includes('/robots?') && calls.some((c) => c.path.startsWith('/robots'))) { signal = init.signal!; return new Promise<Response>((r) => { hold = r; }); }
        return base(u, init);
      });
      await open();
      act(() => { vi.advanceTimersByTime(LIST_MS); });
      await flush();
      expect(hold).not.toBeNull();
      act(() => btn('로그아웃')!.click());
      await flush();
      expect(signal?.aborted).toBe(true);
      await login('park', 'pw');
      expect([...box.querySelectorAll('[aria-label="로봇 목록"] b')].map((b) => b.textContent)).toEqual(['Go2-박운영']);
      hold!(new Response(JSON.stringify({ items: [robot('r-o1', 'Go2-이운영', 'o1', '이운영')], next_cursor: null }), { status: 200 }));
      await flush();
      expect([...box.querySelectorAll('[aria-label="로봇 목록"] b')].map((b) => b.textContent)).toEqual(['Go2-박운영']);
      expect(MEM_ROBOTS.map((r) => r.name)).toEqual(['Go2-박운영']);
      expect($('.fh-me')!.textContent).toBe('박운영(운영 관리자)');
    } finally { vi.useRealTimers(); }
  });
  it('[N5] 목록 갱신으로 내 담당이 된 로봇은 같은 소켓으로 다시 구독 → 상태를 받으면 조종 가능', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      serve(signedIn(LEE, [robot('r-c', 'Go2-C', 'o2', '박운영')]));
      await open('#/drive', true);
      const w = FakeWS.last;
      act(() => w.open());
      expect(w.of('sub')).toMatchObject([{ robots: [] }]);
      routes['GET /robots'] = { status: 200, body: { items: [robot('r-c', 'Go2-C', 'o1', '이운영')], next_cursor: null } };
      act(() => { vi.advanceTimersByTime(LIST_MS); });
      await flush();
      expect(w.of('sub')).toMatchObject([{ robots: [] }, { robots: ['r-c'] }]);
      expect(FakeWS.all).toHaveLength(1);
      act(() => w.recv(state('r-c')));
      act(() => btn('연결')!.click());
      expect(location.hash).toBe('#/drive/r-c');
      expect(btn('조종 시작')!.disabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('상태를 받은 적 없는 로봇은 «연결 전»(끊김 경보 아님) + 조종 불가 이유, 개발용 표시', async () => {
    serve(signedIn(LEE, [robot('r-a', 'Go2-A', 'o1', '이운영')]));
    await open();
    expect($('[aria-label="로봇 목록"]')!.textContent).toContain('상태 확인 중');   // 첫 state 전
    // 서버는 에이전트가 없는 로봇도 OFFLINE·상태 없음 state 를 보낸다
    act(() => { FakeWS.last.open(); FakeWS.last.recv(state('r-a', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    expect($('[aria-label="로봇 목록"]')!.textContent).toContain('연결 전');
    expect($('[data-band]')!.textContent).toBe('');
    expect($('[aria-label="로봇 상세"] [data-why]')).toBeNull();   // 조종 단추·이유는 폰 로봇 연결 화면에(아래 시험)
    expect($('[data-dev]')!.textContent).toContain('가짜');
  });
  it('폰 로봇 연결: 상태를 받은 적 없는 로봇은 «보기만» + 조종 불가 이유', async () => {
    serve(signedIn(LEE, [robot('r-a', 'Go2-A', 'o1', '이운영')]));
    await open('#/drive', true);
    act(() => { FakeWS.last.open(); FakeWS.last.recv(state('r-a', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    const card = $('.dv-card')!;
    expect(card.querySelector('button')!.textContent).toBe('보기만');
    expect(card.querySelector('[data-why]')!.textContent).toContain('아직 연결되지 않아');
  });
  it('담당 로봇 0대: 본문은 안내, 설정 탭은 열림', async () => {
    serve(signedIn(LEE, []));
    await open();
    expect($('[aria-label="로봇 없음"]')!.textContent).toContain('로봇 배정을 요청하세요');
    expect($('[data-stop]')).not.toBeNull();
    act(() => { location.hash = '#/settings'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await flush();
    expect($('[aria-label="조직 기준값"]')).not.toBeNull();
  });
});

// R2-B1: 조종 화면이 열린 채 세션이 끝나면(로그아웃·401·실시간 4401) 조종권을 돌려주고 로그인 화면으로 — 흰 화면 아님
describe('조종 화면에서 세션이 끝남(로그아웃·401·4401)', () => {
  const live = { ...robot('r-k', 'Go2-K', 'a1', '김총괄'), connection: 'ONLINE' as const, status: 'IDLE' as const };
  /** 실시간 연결을 열고 r-k 조종권을 받음 */
  function hold() {
    const w = FakeWS.last;
    w.auto = (m) => {
      w.recv({ t: 'reply', id: m.id, ok: true });
      if (m.t === 'lease.take') w.recv(lease('r-k', { id: 'a1', name: '김총괄' }, 'L1'));
    };
    act(() => { w.open(); w.recv(state('r-k')); });
    act(() => btn('조종 시작')!.click());
    expect(box.textContent).toContain('조종 중(나)');
    return w;
  }
  // 조종 화면은 폰에만 있다(ADR-002 §3) — 로그아웃은 머리줄 ⋯ 안
  const cases: [string, 'logout' | '401' | '4401'][] = [['폰 조종 화면 · ⋯ 로그아웃', 'logout'], ['폰 조종 화면 · 401', '401'], ['폰 조종 화면 · 실시간 4401', '4401']];
  for (const [name, how] of cases) it(name, async () => {
    serve(signedIn(KIM, [live], { 'POST /auth/logout': { status: 204 } }));
    const errors: unknown[] = [], onErr = (e: ErrorEvent) => errors.push(e.error);
    addEventListener('error', onErr);
    await open('#/drive/r-k', true);
    const w = hold();
    if (how === 'logout') act(() => btn('로그아웃')!.click());
    else if (how === '4401') act(() => w.drop(4401));
    else { routes['GET /me'] = NO_LOGIN; await act(async () => { await api.me().catch(() => {}); }); }
    await flush();
    removeEventListener('error', onErr);
    expect(errors).toEqual([]);
    expect($('main[aria-label="로그인"]')).not.toBeNull();   // 흰 화면이 아니라 로그인 화면
    if (how === '4401') expect($('[role="alert"]')!.textContent).toBe('로그인이 끝났습니다. 다시 로그인하세요.');
    else expect(w.of('hidden')).toMatchObject([{ robot: 'r-k' }]);   // 닫기 전에 조종권 반납(정지·잠금)
    expect(w.readyState).toBe(3);
    expect(rt.get('r-k').lease).toBeNull();
    expect(FakeWS.all).toHaveLength(1);                     // 로그인 화면에서는 다시 연결하지 않음
    expect([MEM_USERS.length, MEM_ROBOTS.length]).toEqual([0, 0]);
  });
  it('폰 조종 화면에서 조종하다 ⋯ 기록 → ⋯ 로그아웃', async () => {
    serve(signedIn(KIM, [live], { 'POST /auth/logout': { status: 204 } }));
    await open('#/drive/r-k', true);
    const w = hold();
    act(() => btn('기록')!.click());
    expect(w.of('hidden')).toHaveLength(1);                 // 조종 화면을 떠나며 반납
    act(() => btn('로그아웃')!.click());
    await flush();
    expect($('main[aria-label="로그인"]')).not.toBeNull();
    expect([MEM_USERS.length, MEM_ROBOTS.length, rt.get('r-k').lease]).toEqual([0, 0, null]);
  });
  it('저장소에 없는 로봇 ID 로 불러도 예외 없음', () => {
    expect(() => { rt.release('없는-로봇'); rt.unlock('없는-로봇'); rt.cmd('없는-로봇', [1, 0]); rt.respond('없는-로봇', true); }).not.toThrow();
  });
});

describe('조직 기준값', () => {
  it('운영 관리자: 값은 보이지만 저장 비활성 + 이유, PATCH 0', async () => {
    serve(signedIn(LEE, [robot('r-a', 'Go2-A', 'o1', '이운영')]));
    await open('#/settings');
    expect($<HTMLInputElement>('input[name="battery_low_pct"]')!.value).toBe('20');
    expect($<HTMLInputElement>('input[name="battery_low_pct"]')!.readOnly).toBe(true);
    const save = btn('저장')!;
    expect(save.disabled).toBe(true);
    expect(document.getElementById(save.getAttribute('aria-describedby')!)!.textContent).toBe('조직 기준값은 총괄 운영 관리자만 바꿀 수 있습니다.');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
  it('총괄: 바뀐 칸만 PATCH, 범위 밖이면 서버 문구 + 어느 칸의 허용 범위', async () => {
    serve(signedIn(KIM, [], { 'PATCH /org/settings': err(400, 'VALIDATION', '입력 형식을 확인하세요.') }));
    await open('#/settings');
    type($<HTMLInputElement>('input[name="battery_low_pct"]')!, '70');
    act(() => btn('저장')!.click());
    await flush();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ battery_low_pct: 70 });
    expect($('[aria-label="조직 기준값"] [role="alert"]')!.textContent).toBe('입력 형식을 확인하세요. 허용 범위: 배터리 부족 기준 5~50 %(정수)');
    routes['PATCH /org/settings'] = { status: 200, body: { ...LIMITS, battery_low_pct: 40 } };
    type($<HTMLInputElement>('input[name="battery_low_pct"]')!, '40');
    act(() => btn('저장')!.click());
    await flush();
    expect($('[aria-label="조직 기준값"] [role="status"]')!.textContent).toContain('저장했습니다');
    expect($<HTMLInputElement>('input[name="battery_low_pct"]')!.value).toBe('40');
  });
});

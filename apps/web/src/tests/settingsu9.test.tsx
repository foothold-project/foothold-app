// 설정 = 시안 u9 판(settingsu9.tsx): 서버 값 자리 · 서버 값이 없는 자리(지어내지 않음) · 쪽 넘기기 · 비밀번호 8 자 · 시안 그림 없는 묶음.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../fake';
import { NO, SettingsU9, when, type Page } from '../screens/settingsu9';
import uiCss from '../proto/ui.css?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADMIN: User = { id: 'u-lead', name: '나', role: 'ORG_ADMIN' }, OP: User = { id: 'u-a', name: '운영자 A', role: 'OPERATOR' };
const U = (id: string, username: string, display_name: string, role: string, robot_ids: string[] = []) => ({ id, username, display_name, role, locked: false, robot_ids, created_at: '2026-11-01T00:00:00Z' });
const E = (id: string, code: string, at: string, user_id = 'u-lead', message = '') => ({ id, at, robot_at: null, category: 'ACCOUNT', code, severity: 'INFO', message, robot_id: null, user_id, run_id: null, data: {} });
const S = (id: string, client: string, seen: string, revoked: string | null = null) => ({ id, client, device_label: 'x', created_at: seen, last_seen_at: seen, expires_at: '2099-01-01T00:00:00Z', revoked_at: revoked });
type Rep = { status: number; body?: unknown };
let routes: Record<string, Rep | ((url: URL, init?: RequestInit) => Rep)> = {}, calls: { method: string; url: URL; body?: unknown }[] = [];
const list = (items: unknown[]): Rep => ({ status: 200, body: { items, next_cursor: null } });
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x'), method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${url.pathname.replace('/api/v1', '')}`], rep = typeof hit === 'function' ? hit(url, init) : hit ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '찾을 수 없습니다.', detail: {} } } };
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(who: User = ADMIN, initial: Page = 'account', more: object = {}) {
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<SettingsU9 user={who} setMe={() => {}} refresh={() => {}} initial={initial} {...more} />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });
const $ = (s: string) => box.querySelector<HTMLElement>(s)!;
const pane = (l: string) => $(`[aria-label="${l}"]`);
const texts = (s: string, from: ParentNode = box) => [...from.querySelectorAll(s)].map((e) => e.textContent);
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };

describe('시각 꼴(시안 u9)', () => {
  const now = new Date(2026, 10, 26, 14, 10);
  it('오늘 HH:MM · 어제 HH:MM · 그 밖 M/D HH:MM, 최근 활동은 어제도 M/D', () => {
    expect(when(new Date(2026, 10, 26, 8, 41).toISOString(), true, now)).toBe('오늘 08:41');
    expect(when(new Date(2026, 10, 26, 8, 41).toISOString(), false, now)).toBe('08:41');
    expect(when(new Date(2026, 10, 25, 18, 2).toISOString(), false, now)).toBe('어제 18:02');
    expect(when(new Date(2026, 10, 25, 18, 2).toISOString(), true, now, false)).toBe('11/25 18:02');
    expect(when(new Date(2026, 10, 20, 10, 15).toISOString(), false, now)).toBe('11/20 10:15');
  });
});

describe('계정(u9_1)', () => {
  const T1 = new Date(Date.now() - 60000).toISOString(), T2 = new Date(Date.now() - 120000).toISOString();
  const base = () => ({
    'GET /me': { status: 200, body: U('u-lead', 'lead01', '나', 'ORG_ADMIN') },
    'GET /events': list([E('e0', 'TOKEN_REFRESHED', '2026-11-26T05:00:00Z'), E('e1', 'LOGIN', '2026-11-25T23:41:00Z'), E('e2', 'LOGOUT', '2026-11-25T09:02:00Z'),
      E('e3', 'PASSWORD_CHANGED', '2026-11-20T01:15:00Z')]),
    'GET /users': list([U('u-lead', 'lead01', '나', 'ORG_ADMIN'), U('u-a', 'op-a', '운영자 A', 'OPERATOR')]),
    'GET /users/u-lead/sessions': list([S('s1', 'web', T1)]),
    'GET /users/u-a/sessions': list([S('s2', 'app', T2), S('s3', 'web', '2026-11-20T00:00:00Z', '2026-11-21T00:00:00Z')]),
  } as typeof routes);
  it('아이디 = GET /me, 최근 활동 = 내 계정 사건(로그인 · 로그아웃 · 비밀번호)만, 비밀번호 바꾼 날 = PASSWORD_CHANGED', async () => {
    serve(base()); await open();
    const q = calls.find((c) => c.url.pathname.endsWith('/events'))!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({ user_id: 'u-lead', category: 'ACCOUNT', limit: '100' });
    expect($('[data-u9-me]').textContent).toContain('아이디 lead01');
    expect(texts('[data-u9-act]').map((t) => t!.replace(/^.*?\d\d:\d\d/, ''))).toEqual(['로그인', '로그아웃', '비밀번호 바꿈모든 기기에서 로그아웃됨']);
    expect($('[data-u9-pw-at]').textContent).toMatch(/^11\/20 에 바꿈$/);
  });
  it('서버가 값을 못 주면 지어내지 않고 「서버에 값 없음」', async () => {
    serve({ ...base(), 'GET /me': { status: 500, body: { error: { code: 'X', message: '서버 오류', detail: {} } } }, 'GET /events': list([]) }); await open();
    expect($('[data-u9-me]').textContent).toBe(`아이디 ${NO} · 마지막 로그인 ${NO}`);
    expect($('[data-u9-pw-at]').textContent).toBe(NO);
    expect(pane('최근 활동').textContent).toContain('최근 활동이 없습니다.');
  });
  it('로그인 기기(총괄만) = 모든 사용자의 살아 있는 세션, 끊기 → DELETE 후 다시 받음. 운영자에게는 칸도 요청도 없음', async () => {
    serve({ ...base(), 'DELETE /users/u-a/sessions/s2': { status: 204 } }); await open();
    expect(texts('[data-u9-dev]').map((t) => t!.replace('끊기', ''))).toEqual([`PC · 나${when(T1)}`, `폰 · 운영자 A${when(T2)}`]);   // 늦게 본 것부터, 끝난 세션은 뺌
    const n = calls.filter((c) => c.url.pathname.endsWith('/sessions')).length;
    await click([...pane('로그인 기기').querySelectorAll('button')].filter((b) => b.textContent === '끊기')[1]);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.pathname)).toEqual(['/api/v1/users/u-a/sessions/s2']);
    expect(calls.filter((c) => c.url.pathname.endsWith('/sessions')).length).toBeGreaterThan(n);
    act(() => root?.unmount()); box.remove();
    serve(base()); await open(OP);
    expect(box.querySelector('[aria-label="로그인 기기"]')).toBeNull();
    expect(calls.some((c) => c.url.pathname.includes('/users'))).toBe(false);
  });
  it('최근 활동이 여섯 줄보다 많으면 쪽을 넘긴다(스크롤 없음)', async () => {
    serve({ ...base(), 'GET /events': list(Array.from({ length: 8 }, (_, i) => E(`l${i}`, 'LOGIN', `2026-11-${10 + i}T01:00:00Z`))) }); await open();
    expect(texts('[data-u9-act]')).toHaveLength(6);
    expect($('[data-u9-pager]').textContent).toContain('1 / 2');
    await click($('[aria-label="다음 쪽"]'));
    expect(texts('[data-u9-act]')).toHaveLength(2);
  });
});

describe('비밀번호 바꾸기 창(u9_2)', () => {
  it('「8 자 이상」 시안 글을 지킨다: 7 자는 안 보냄, 두 칸 다르면 안 보냄, Escape 로 닫힘', async () => {
    serve({ 'GET /events': list([]), 'GET /me': { status: 200, body: U('u-a', 'op-a', '운영자 A', 'OPERATOR') } }); await open(OP);
    await click($('#go-pw'));
    const f = $('form[aria-label="비밀번호 바꾸기"]') as HTMLFormElement;
    const set = (n: string, v: string) => act(() => { const i = f.querySelector<HTMLInputElement>(`input[name="${n}"]`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); });
    set('current', 'old-pass'); set('next', 'abcdefg'); set('again', 'abcdefg');
    await act(async () => { f.requestSubmit(); }); await flush();
    expect($('[role="alert"]').textContent).toBe('새 비밀번호는 8 자 이상이어야 합니다.');
    set('next', 'abcdefgh'); set('again', 'abcdefgX');
    await act(async () => { f.requestSubmit(); }); await flush();
    expect($('[role="alert"]').textContent).toBe('새 비밀번호 두 칸이 서로 다릅니다.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    act(() => { f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(box.querySelector('form[aria-label="비밀번호 바꾸기"]')).toBeNull();
  });
});

describe('사용자와 권한(u9_3)', () => {
  it('표: 머리글자 · 이름 · 역할 · 아이디 · 담당 로봇 이름 · 마지막 접속(살아 있는 세션 중 가장 늦은 것), 세션 없으면 「서버에 값 없음」', async () => {
    serve({ 'GET /users': list([U('u-lead', 'lead01', '나', 'ORG_ADMIN', ['k1']), U('u-e', 'op-e', '운영자 E', 'OPERATOR')]), 'GET /robots': list([{ id: 'k1', name: 'K-01' }]),
      'GET /users/u-lead/sessions': list([S('s1', 'web', new Date(Date.now() - 30000).toISOString())]), 'GET /users/u-e/sessions': list([]), 'GET /events': list([]) });
    await open(ADMIN, 'users');
    expect(texts('tr[data-u9-user]').map((t) => t!.replace('임시 비밀번호', ''))).toEqual(['나나총괄lead01K-01지금', `E운영자 E운영자op-e없음${NO}`]);
    expect(calls.find((c) => c.url.pathname.endsWith('/robots'))!.url.searchParams.get('scope')).toBe('all');
  });
  it('임시 비밀번호 다시 만들기는 서버 기능이 없어 누르면 까닭만, 요청 없음', async () => {
    serve({ 'GET /users': list([U('u-lead', 'lead01', '나', 'ORG_ADMIN'), U('u-a', 'op-a', '운영자 A', 'OPERATOR')]), 'GET /robots': list([]), 'GET /users/u-lead/sessions': list([]), 'GET /users/u-a/sessions': list([]), 'GET /events': list([]) });
    await open(ADMIN, 'users');
    const b = [...box.querySelectorAll('button')].find((x) => x.textContent === '임시 비밀번호')!;
    expect(b.getAttribute('aria-disabled')).toBe('true');
    const before = calls.length; await click(b);
    expect(calls.length).toBe(before);
    expect(pane('사용자').querySelector('[role="alert"]')!.textContent).toContain('서버 기능이 아직 없습니다');
  });
  it('운영자에게는 메뉴 항목이 없다', async () => {
    serve({ 'GET /events': list([]), 'GET /me': { status: 200, body: U('u-a', 'op-a', '운영자 A', 'OPERATOR') } }); await open(OP);
    expect($('#nav-users').hidden).toBe(true);
  });
});

describe('서버 값이 없는 칸(u9_4 · u9_5 · u9_6 · u9_7 · u9_8): 지어낸 값 없음, 잠긴 스위치 + 까닭', () => {
  const r = () => ({ 'GET /me': { status: 200, body: U('u-lead', 'lead01', '나', 'ORG_ADMIN') }, 'GET /org/settings': { status: 200, body: { battery_low_pct: 25 } }, 'GET /events': list([]) } as typeof routes);
  it('현장 연결: 네트워크 목록 없음 · 서버 주소 = 지금 연 주소 · 서버까지 = 직접 잰 ms · 현장 확인 스위치 잠김', async () => {
    serve(r()); await open(ADMIN, 'network');
    expect(pane('현장 네트워크 목록').textContent).toContain(NO);
    expect(pane('현장 네트워크 목록').querySelectorAll('.rw')).toHaveLength(0);
    expect(pane('서버').textContent).toContain(location.host);
    expect($('[data-u9-ping]').textContent).toMatch(/^\d+ ms$/);
    expect(pane('현장 확인').querySelector('[role="switch"]')!.getAttribute('aria-disabled')).toBe('true');
    expect(pane('끊겼을 때').textContent).not.toContain('핫스팟으로 바꾸기');
  });
  it('알림: 배터리 주의 = 조직 설정 값, 관절 온도 단계는 시안 값 50 · 60 · 70 °C, 스위치 다섯 모두 잠김', async () => {
    serve(r()); await open(ADMIN, 'alerts');
    expect($('[data-u9-low]').textContent).toBe('25 %');
    expect(box.textContent).toMatch(/관절 온도.*50 °C.*60 °C.*70 °C/);
    const sw = [...box.querySelectorAll('[role="switch"]')];
    expect(sw).toHaveLength(5);
    for (const s of sw) expect(s.getAttribute('aria-disabled')).toBe('true');
  });
  it('혼잡 시간: 막대 없음, 중복 점검 기준 · 바꾼 기록 = 서버에 값 없음', async () => {
    serve(r()); await open(ADMIN, 'crowd');
    expect(box.querySelectorAll('.tl2 b')).toHaveLength(0);
    expect($('[data-u9-dup]').textContent).toBe(NO);
    expect(pane('혼잡 시간').textContent).toContain(NO);
  });
  it('표시: 화면 밝기 세 칸 중 지금 값이 on, 누르면 바뀜 · 데모 스위치 잠김(운영자는 「총괄만 바꿀 수 있습니다」)', async () => {
    serve(r()); await open(OP, 'display');
    const radios = [...box.querySelectorAll('[aria-label="화면 밝기"] [role="radio"]')];
    expect(radios.map((x) => x.getAttribute('aria-label'))).toEqual(['밝게', '어둡게', '기기 설정 따르기']);
    await click(radios[0]);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect(pane('데모 로봇 표시').textContent).toContain('총괄만 바꿀 수 있습니다');
    expect(pane('데모 로봇 표시').querySelector('[role="switch"]')!.getAttribute('aria-disabled')).toBe('true');
    await click(radios[1]);
  });
  it('조작: 조이스틱 · 음성은 앱에 없어 「앱에 아직 없음」 · 까닭, 연결됨 같은 지어낸 상태 없음', async () => {
    serve(r()); await open(ADMIN, 'controls');
    expect(pane('조이스틱').textContent).toContain('앱에 아직 없음');
    expect(pane('조이스틱').textContent).not.toContain('연결됨');
    expect(pane('음성').textContent).toContain('음성 명령 기능이 앱에 아직 없습니다.');
  });
});

describe('시안 그림이 없는 묶음', () => {
  it('로봇 · 안전 · 기록과 클립 · 시스템은 지금 앱 판 칸을 시안 칸 안에 그린다(값 고치기를 잃지 않음)', async () => {
    serve({ 'GET /org/settings': { status: 200, body: { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 } }, 'GET /robots': list([]), 'GET /events': list([]) });
    await open(ADMIN, 'robot');
    expect(box.querySelector('.u9-legacy [aria-label="조직 기준값"]')).not.toBeNull();
    expect(box.querySelector('.u9-legacy [aria-label="조종권·연결"]')).not.toBeNull();
    expect(box.querySelector('.u9-legacy [role="tablist"]')).toBeNull();
  });
});

describe('시안 공통 css 를 앱 판이 덮지 않음', () => {
  it('시안 원본 .ic 값(18 px · 선 1.9) 이 그대로', () => {
    expect(uiCss).toContain('.ic{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.9');
  });
});

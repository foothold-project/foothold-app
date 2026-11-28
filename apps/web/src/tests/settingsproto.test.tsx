// 설정 탭 시안 u9_1 ~ u9_7 (계정 · 비밀번호 창 · 사용자와 권한 · 현장 연결 · 알림 · 표시 · 조작).
// 서버 값이 있는 칸은 그 값(내 정보 · 최근 활동 = /events · 로그인 기기 = /users/{id}/sessions · 조직 기준값), 없는 칸은 「서버에 값 없음」 이나 까닭 한 줄.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event as Ev, Session, User } from '../../../contracts/ts';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r1'] };
const LIMITS = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
const later = new Date(Date.now() + 3600_000).toISOString(), past = new Date(Date.now() - 3600_000).toISOString();
const sess = (id: string, label: string): Session => ({ id, client: 'web', device_label: label, created_at: past, last_seen_at: past, expires_at: later, revoked_at: null });
const ev = (id: string, message: string, p: Partial<Ev> = {}): Ev => ({ id, at: new Date(2026, 10, 28, 8, 41).toISOString(), robot_at: null, category: 'ACCOUNT', code: 'LOGIN', severity: 'INFO',
  message, robot_id: null, user_id: 'a1', run_id: null, data: {}, ...p });

type Reply = { status: number; body?: unknown };
let calls: { method: string; path: string }[] = [], routes: Record<string, Reply> = {};
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path });
    const rep = routes[`${method} ${path.split('?')[0]}`] ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '찾을 수 없습니다.', detail: {} } } };
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, more: typeof routes = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: [], next_cursor: null } },
  'GET /org/settings': { status: 200, body: LIMITS },
  'GET /users': { status: 200, body: { items: [KIM, LEE], next_cursor: null } },
  'GET /events': { status: 200, body: { items: [ev('2', '김총괄님이 로그인했습니다.'), ev('1', '김총괄님이 로그아웃했습니다.', { code: 'LOGOUT' })], next_cursor: null } },
  'GET /users/a1/sessions': { status: 200, body: { items: [sess('s1', '웹 브라우저'), sess('s2', 'FOOTHOLD 앱 1.0')], next_cursor: null } },
  ...more,
});

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open() {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/settings';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });
const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const tabs = () => [...box.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
const panel = (name: string) => document.getElementById(tabs().find((t) => t.textContent === name)!.getAttribute('aria-controls')!)!;
const go = async (name: string) => { act(() => tabs().find((t) => t.textContent === name)!.click()); await flush(); };
const q = (path: string) => calls.filter((c) => c.method === 'GET' && c.path.split('?')[0] === path).map((c) => Object.fromEntries(new URLSearchParams(c.path.split('?')[1] ?? '')));

describe('설정 시안 틀 (u9)', () => {
  it('왼쪽 목록 항목마다 아이콘, 총괄만 항목은 「총괄만」 표, 화면마다 머리(제목 = 항목 이름 + 설명 한 줄)', async () => {
    serve(signedIn(KIM)); await open();
    expect(tabs().every((t) => t.querySelector('svg'))).toBe(true);
    expect(tabs().filter((t) => t.hasAttribute('data-only')).map((t) => t.textContent)).toEqual(['사용자와 권한', '데모 로봇 표시']);
    for (const name of ['계정', '사용자와 권한', '현장 연결', '알림', '표시', '조작']) {
      const head = panel(name).querySelector('[data-st-head]')!;
      expect(head.querySelector('h2')!.textContent).toBe(name);
      expect(head.querySelector('p')!.textContent!.length).toBeGreaterThan(5);
    }
  });
});

describe('계정 (u9_1 · u9_2)', () => {
  it('내 계정: 머리글자 · 이름 · 역할 표 · 아이디, 비밀번호 바꾼 때는 서버에 값 없음', async () => {
    serve(signedIn(LEE)); await open();
    const me = $('[aria-label="내 정보"]')!;
    expect(me.querySelector('[data-st-av]')!.textContent).toBe('이');
    expect(me.querySelector('[data-st-role]')!.textContent).toBe('운영 관리자');
    expect(me.textContent).toContain('아이디 lee');
    expect(me.querySelector('[data-st-pw-when]')!.textContent).toBe('서버에 값 없음');
    expect(me.querySelector('[data-st-logout]')!.textContent).toContain('머리줄');
  });
  it('비밀번호 바꾸기는 단추로 여는 창(dialog), 닫기 · 취소 · Esc 로 닫힘', async () => {
    serve(signedIn(LEE)); await open();
    expect($('[role="dialog"]')).toBeNull();
    expect($('form[aria-label="비밀번호 바꾸기"]')).toBeNull();
    act(() => btn('비밀번호 바꾸기', $('[aria-label="내 정보"]')!)!.click()); await flush();
    const d = $('[role="dialog"]')!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.querySelector('form[aria-label="비밀번호 바꾸기"]')).not.toBeNull();
    expect(document.activeElement).toBe(d.querySelector('input[name="current"]'));
    act(() => btn('취소', d)!.click()); await flush();
    expect($('[role="dialog"]')).toBeNull();
    act(() => btn('비밀번호 바꾸기', $('[aria-label="내 정보"]')!)!.click()); await flush();
    act(() => { $('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await flush();
    expect($('[role="dialog"]')).toBeNull();
  });
  it('최근 활동 = 내 계정 사건(/events user_id · ACCOUNT), 서버 문장 그대로', async () => {
    serve(signedIn(LEE, { 'GET /events': { status: 200, body: { items: [ev('9', '이운영님이 로그인했습니다.', { user_id: 'o1' })], next_cursor: null } } })); await open();
    expect(q('/events')).toContainEqual({ user_id: 'o1', category: 'ACCOUNT', limit: '6' });
    const recent = $('[aria-label="최근 활동"]')!;
    expect(recent.querySelectorAll('[data-st-act]')).toHaveLength(1);
    expect(recent.textContent).toContain('이운영님이 로그인했습니다.');
  });
  it('최근 활동이 없으면 한 줄, 받지 못하면 서버 문장', async () => {
    serve(signedIn(LEE, { 'GET /events': { status: 200, body: { items: [], next_cursor: null } } })); await open();
    expect($('[aria-label="최근 활동"]')!.textContent).toContain('최근 활동이 없습니다.');
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(LEE, { 'GET /events': { status: 500, body: { error: { code: 'INTERNAL', message: '서버 오류입니다.', detail: {} } } } })); await open();
    expect($('[aria-label="최근 활동"] [role="alert"]')!.textContent).toBe('서버 오류입니다.');
  });
  it('로그인 기기: 총괄만(내 세션 목록 · 「총괄만」 표), 운영자는 칸도 요청도 없음', async () => {
    serve(signedIn(KIM)); await open();
    const dev = panel('계정').querySelector('[aria-label="내 로그인 기기"]')!;
    expect(dev.textContent).toContain('총괄만');
    expect(dev.textContent).toContain('웹 브라우저');
    expect(q('/users/a1/sessions')).toHaveLength(1);
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(LEE)); await open();
    expect(panel('계정').querySelector('[aria-label="내 로그인 기기"]')).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/users'))).toBe(false);
  });
});

describe('사용자와 권한 (u9_3)', () => {
  it('사용자 줄마다 머리글자 · 이름 · 역할 표 · 아이디 · 담당 로봇 수, 없는 칸(마지막 접속 · 임시 비밀번호 다시 만들기)은 까닭 한 줄', async () => {
    serve(signedIn(KIM)); await open(); await go('사용자와 권한');
    const users = $('[aria-label="계정"]')!;
    const rows = [...users.querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('[data-st-av]')!.textContent).toBe('이');
    expect(rows[1].querySelector('[data-st-role]')!.textContent).toBe('운영 관리자');
    expect(rows[1].textContent).toContain('lee');
    expect(rows[1].textContent).toContain('로봇 1대');
    expect(users.querySelector('[data-missing="last-seen"]')!.textContent).toContain('서버');
    expect(btn('사용자 추가', users)).toBeDefined();
  });
  it('권한 표: 앱이 실제로 가르는 일만(총괄 ✓ · 운영자 ·), 바꾼 기록 = 계정 사건', async () => {
    serve(signedIn(KIM)); await open(); await go('사용자와 권한');
    const perm = $('[aria-label="권한"]')!;
    const rows = [...perm.querySelectorAll('tbody tr')].map((r) => [...r.children].map((c) => c.getAttribute('data-can') ?? c.textContent));
    expect(rows).toEqual([['정지 (어느 화면에서나)', 'yes', 'yes'], ['사용자와 권한', 'yes', 'no'], ['로그인 기기 보기 · 끊기', 'yes', 'no'], ['조직 기준값 고치기', 'yes', 'no']]);
    expect(q('/events')).toContainEqual({ category: 'ACCOUNT', limit: '5' });
    expect($('[aria-label="바꾼 기록"]')!.querySelectorAll('[data-st-act]')).toHaveLength(2);
  });
});

describe('현장 연결 · 알림 · 표시 · 조작 (u9_4 ~ u9_7)', () => {
  it('현장 연결: 네트워크 목록 · 현장 확인 · 끊겼을 때는 서버 값이 없어 항목 + 까닭(단추 · 스위치 없음), 서버 주소는 지금 연 주소', async () => {
    serve(signedIn(KIM)); await open(); await go('현장 연결');
    const p = panel('현장 연결');
    for (const l of ['현장 네트워크 목록', '현장 확인', '끊겼을 때']) {
      const c = p.querySelector(`[aria-label="${l}"]`)!;
      expect(c.querySelector('h2')!.textContent).toBe(l);
      expect(c.querySelectorAll('input, button, select, [role="switch"]')).toHaveLength(0);
      expect(c.querySelector('[data-why]')).not.toBeNull();
    }
    expect(p.querySelector('[aria-label="서버"]')!.textContent).toContain(location.host);
    expect(p.querySelector('[aria-label="서버"] [data-st-check]')!.textContent).toBe('서버에 값 없음');
  });
  it('알림: 배터리 = 조직 기준값(서버), 관절 온도 단계 · 이상 감지 · 받는 곳은 서버 값이 없어 숫자 · 스위치 없이 까닭', async () => {
    serve(signedIn(KIM)); await open(); await go('알림');
    const p = panel('알림');
    expect(p.querySelector<HTMLInputElement>('input[name="battery_low_pct"]')!.value).toBe('20');
    const temp = p.querySelector('[aria-label="관절 온도"]')!;
    expect([...temp.querySelectorAll('[data-st-band]')].map((b) => b.textContent)).toEqual(['보통', '주의', '경고', '위험']);
    expect(temp.textContent).not.toMatch(/\d+\s*°C/);
    expect(temp.textContent).toContain('서버에 값 없음');
    for (const l of ['이상 감지', '받는 곳']) {
      const c = p.querySelector(`[aria-label="${l}"]`)!;
      expect(c.querySelectorAll('input, button, [role="switch"]').length).toBe(0);
      expect(c.querySelectorAll('[data-why]').length).toBeGreaterThan(0);
    }
  });
  it('표시: 화면 밝기 세 칸(그림 + 이름), 언어 = 한국어만(English 는 항목 + 까닭), 데모 로봇 표시는 총괄만 표 + 까닭(스위치 없음)', async () => {
    serve(signedIn(KIM)); await open(); await go('표시');
    const p = panel('표시');
    expect(p.querySelectorAll('[aria-label="화면 밝기"] [data-st-prev]')).toHaveLength(3);
    const lang = p.querySelector('[aria-label="언어"]')!;
    expect(lang.querySelector('[data-st-lang="ko"]')!.textContent).toContain('한국어');
    expect(lang.querySelectorAll('input')).toHaveLength(0);
    expect(lang.querySelector('[data-why]')!.textContent).toContain('English');
    const demo = p.querySelector('[aria-label="데모 로봇 표시"]')!;
    expect(demo.textContent).toContain('총괄만');
    expect(demo.querySelectorAll('input, [role="switch"]')).toHaveLength(0);
  });
  it('조작: 키보드 칸은 키마다 키캡, 조이스틱 · 음성 칸은 스위치 없이 까닭 한 줄', async () => {
    serve(signedIn(KIM)); await open(); await go('조작');
    const p = panel('조작');
    const kb = p.querySelector('[aria-label="키보드"]')!;
    expect([...kb.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['W', 'S', '↑', '↓', 'A', 'D', '←', '→', 'Space']);
    for (const l of ['조이스틱', '음성']) {
      const c = p.querySelector(`[aria-label="${l}"]`)!;
      expect(c.querySelectorAll('input, button, [role="switch"]').length).toBe(0);
      expect(c.querySelector('[data-why]')).not.toBeNull();
    }
  });
});

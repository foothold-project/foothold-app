// 시안 로그인 (proto screens/u10_1 로그인 · u10_2 비밀번호 바꾸기 창 · u10_3 오류 한 줄 · u10_4 바뀜).
// 카드: FOOTHOLD · 「로그인」 · 「총괄 · 운영자 계정으로 로그인합니다」 · 아이디 · 비밀번호(보기 단추) · 로그인 · 비밀번호 바꾸기 · 「계정은 총괄에게 요청하세요」.
// 비밀번호 바꾸기는 로그인 전 화면에서 아이디 · 지금 비밀번호로 로그인 → POST /me/password → 로그아웃 → 「바뀜」 줄. fetch 는 가짜 서버.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../contracts/ts';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });
type Reply = { status: number; body?: unknown };
let calls: { method: string; path: string; body?: unknown }[] = [], routes: Record<string, Reply> = {};
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const rep = routes[`${method} ${path.split('?')[0]}`] ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const NO_LOGIN = err(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
const LOGIN_OK = { status: 200, body: { ...KIM, csrf_token: 'c', access_token: null, refresh_token: null } };

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open() {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('시안 로그인 카드 (u10_1)', () => {
  it('시안 글자와 칸: 제목 · 설명 · 아이디 · 비밀번호 · 로그인 · 비밀번호 바꾸기 · 계정 안내', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open();
    const card = $('main[aria-label="로그인"] .lg-card')!;
    expect(card).not.toBeNull();
    expect(card.querySelector('.lg-logo')!.textContent).toBe('FOOTHOLD');
    expect(card.querySelector('h2')!.textContent).toBe('로그인');
    expect(card.textContent).toContain('총괄 · 운영자 계정으로 로그인합니다');
    expect([...card.querySelectorAll('.lg-lab')].map((e) => e.textContent)).toEqual(['아이디', '비밀번호']);
    expect(btn('로그인')!.className).toContain('btnp');
    expect(btn('비밀번호 바꾸기')).toBeDefined();
    expect(card.textContent).toContain('계정은 총괄에게 요청하세요');
    expect($('.lg-bg')).not.toBeNull();
  });
  it('보기 단추로 비밀번호를 보이고 다시 숨긴다', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open();
    const pw = $<HTMLInputElement>('input[name="password"]')!;
    expect(pw.type).toBe('password');
    act(() => $<HTMLButtonElement>('[aria-label="비밀번호 보기"]')!.click());
    expect(pw.type).toBe('text');
    act(() => $<HTMLButtonElement>('[aria-label="비밀번호 숨기기"]')!.click());
    expect(pw.type).toBe('password');
  });
  it('틀림 (u10_3): 서버 문구를 오류 한 줄로, 비밀번호 칸은 빨간 테', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': err(401, 'BAD_CREDENTIALS', '아이디나 비밀번호가 맞지 않습니다') });
    await open();
    type($<HTMLInputElement>('input[name="username"]')!, 'kim');
    type($<HTMLInputElement>('input[name="password"]')!, 'nope');
    act(() => { $<HTMLFormElement>('form')!.requestSubmit(); });
    await flush();
    const line = $('[role="alert"]')!;
    expect(line.className).toContain('lg-err');
    expect(line.textContent).toBe('아이디나 비밀번호가 맞지 않습니다');
    expect($('input[name="password"]')!.getAttribute('aria-invalid')).toBe('true');
    expect($('main[aria-label="로그인"]')).not.toBeNull();
  });
});

describe('비밀번호 바꾸기 창 (u10_2 · u10_4)', () => {
  const openModal = async () => { act(() => btn('비밀번호 바꾸기')!.click()); await flush(); return $('[role="dialog"][aria-label="비밀번호 바꾸기"]')!; };
  const fill = (d: Element, id: string, cur: string, n1: string, n2: string) => {
    type(d.querySelector<HTMLInputElement>('input[name="cp-id"]')!, id);
    type(d.querySelector<HTMLInputElement>('input[name="cp-cur"]')!, cur);
    type(d.querySelector<HTMLInputElement>('input[name="cp-new"]')!, n1);
    type(d.querySelector<HTMLInputElement>('input[name="cp-new2"]')!, n2);
  };
  it('지금 비밀번호로 로그인 → /me/password → 로그아웃 → 「바뀜」 줄, 로그인 화면 그대로', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': LOGIN_OK, 'POST /me/password': { status: 204 }, 'POST /auth/logout': { status: 204 } });
    await open();
    const d = await openModal();
    expect(d.textContent).toContain('스페이스는 정지 키라서 쓸 수 없습니다');
    fill(d, 'kim', 'old-pass', 'new-pass-1', 'new-pass-1');
    act(() => btn('바꾸기')!.click());
    await flush();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /auth/session', 'POST /auth/login', 'POST /me/password', 'POST /auth/logout']);
    expect(calls[2].body).toEqual({ current_password: 'old-pass', new_password: 'new-pass-1' });
    expect($('[role="dialog"]')).toBeNull();
    expect($('.lg-ok')!.textContent).toContain('비밀번호를 바꿨습니다');
    expect($('main[aria-label="로그인"]')).not.toBeNull();
  });
  it('8 자 미만 · 스페이스 · 두 칸 다름은 보내지 않고 창 안에 까닭', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open();
    const d = await openModal();
    for (const [n1, n2, why] of [['short1', 'short1', '8 자 이상'], ['has space 1', 'has space 1', '스페이스'], ['new-pass-1', 'new-pass-2', '같지 않습니다']]) {
      fill(d, 'kim', 'old-pass', n1, n2);
      act(() => btn('바꾸기')!.click());
      await flush();
      expect(d.querySelector('[role="alert"]')!.textContent).toContain(why);
    }
    expect(calls.map((c) => c.path)).toEqual(['/auth/session']);
  });
  it('지금 비밀번호가 틀리면 서버 문구를 창 안에, 비밀번호는 안 바뀜', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': err(401, 'BAD_CREDENTIALS', '아이디나 비밀번호가 맞지 않습니다') });
    await open();
    const d = await openModal();
    fill(d, 'kim', 'wrong', 'new-pass-1', 'new-pass-1');
    act(() => btn('바꾸기')!.click());
    await flush();
    expect(d.querySelector('[role="alert"]')!.textContent).toBe('아이디나 비밀번호가 맞지 않습니다');
    expect(calls.some((c) => c.path === '/me/password')).toBe(false);
  });
  it('로그인은 됐는데 /me/password 가 실패(429)하면 바로 로그아웃해 세션을 남기지 않는다 (함께 쓰는 PC)', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': LOGIN_OK, 'POST /me/password': err(429, 'RATE_LIMITED', '잠시 뒤 다시 시도하세요.'), 'POST /auth/logout': { status: 204 } });
    await open();
    const d = await openModal();
    fill(d, 'kim', 'old-pass', 'new-pass-1', 'new-pass-1');
    act(() => btn('바꾸기')!.click());
    await flush();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /auth/session', 'POST /auth/login', 'POST /me/password', 'POST /auth/logout']);
    expect(d.querySelector('[role="alert"]')!.textContent).toBe('잠시 뒤 다시 시도하세요.');
    expect($('main[aria-label="로그인"]')).not.toBeNull();
  });
  it('취소 · 닫기는 아무것도 보내지 않는다', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open();
    await openModal();
    act(() => btn('취소')!.click());
    expect($('[role="dialog"]')).toBeNull();
    await openModal();
    act(() => $<HTMLButtonElement>('[aria-label="닫기"]')!.click());
    expect($('[role="dialog"]')).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(['/auth/session']);
  });
});

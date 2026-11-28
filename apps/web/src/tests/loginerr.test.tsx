// 로그인 오류 보기(u10_3 · U11-03): 오류 띠 · 틀린 칸 빨간 테(aria-invalid) · 초점 · 비밀번호 보기 단추 · 「계정은 총괄에게 요청하세요.」 한 줄.
// 서버 401 은 계정 · 비밀번호를 가르지 않는다(api.py login: 없는 계정 · 틀린 비밀번호 · 잠긴 계정 모두 같은 401 · 같은 문구).
// 그래서 서버 거절은 두 칸 모두 표시 · 초점은 계정 칸(REVIEW-PR580 G1), 글은 서버 말 그대로(계정이 틀렸다고 지어 말하지 않음). 429 · 연결 실패는 칸 표시 없음.
// 보기만 바꾼다: 로그인 요청 · 세션 처리 줄은 그대로(요청 본문도 그대로인지 본다).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../contracts/ts';
import { ACCOUNT_ASK } from '../loginform';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });
const BAD = '계정 또는 비밀번호를 확인하세요.', MANY = '로그인 시도가 많습니다. 잠시 뒤 다시 시도하세요.';
type Reply = { status: number; body?: unknown };
let calls: { method: string; path: string; body?: unknown }[] = [], routes: Record<string, Reply | (() => Reply | Promise<Reply>)> = {};
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${path.split('?')[0]}`];
    if (hit === undefined && (path.startsWith('/auth/login') || path.startsWith('/auth/session')) && routes.NET) throw new TypeError('fail');
    const rep = typeof hit === 'function' ? await hit() : hit ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash = '#/fleet') {
  location.hash = hash;
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const user = () => $<HTMLInputElement>('input[name="username"]')!, pass = () => $<HTMLInputElement>('input[name="password"]')!;
const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
async function login(id: string, pw: string) { type(user(), id); type(pass(), pw); act(() => { $<HTMLFormElement>('form')!.requestSubmit(); }); await flush(); }
const band = () => $('[data-login-err]');
const NO_LOGIN = err(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');

describe('로그인 오류 보기 (u10_3)', () => {
  it('빈 계정: 띠 · 계정 칸만 빨간 테 · 초점 계정', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open(); await login('', '');
    expect(band()!.getAttribute('role')).toBe('alert');
    expect(band()!.textContent).toBe('계정과 비밀번호를 입력하세요.');
    expect(user().getAttribute('aria-invalid')).toBe('true');
    expect(pass().hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe(user());
    expect(calls.some((c) => c.path === '/auth/login')).toBe(false);
    act(() => { pass().focus(); });
    await login('', '');   // 같은 칸이 다시 비어도 초점을 다시
    expect(document.activeElement).toBe(user());
  });

  it('빈 비밀번호: 비밀번호 칸만 · 초점 비밀번호', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open(); await login('kim', '');
    expect(pass().getAttribute('aria-invalid')).toBe('true');
    expect(user().hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe(pass());
  });

  it('서버 401: 글은 서버 말 그대로 · 두 칸 모두 빨간 테 · 초점 계정 · 요청 본문 그대로 (REVIEW-PR580 G1)', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': err(401, 'AUTH_REQUIRED', BAD) });
    await open(); await login('kim', 'bad');
    expect(band()!.textContent).toBe(BAD);
    // G1: 서버는 계정 · 비밀번호를 가르지 않으니 두 칸 모두 표시, 초점은 앞 칸(계정)부터
    expect(user().getAttribute('aria-invalid')).toBe('true');
    expect(pass().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(user());
    expect(box.textContent).not.toMatch(/계정이 (틀|없)|아이디가 (틀|없)/);
    expect(calls.find((c) => c.path === '/auth/login')!.body).toMatchObject({ username: 'kim', password: 'bad' });
    // 다시 고쳐 성공하지 않아도, 다음 제출 전에 빈 칸이면 표시가 그 칸으로 옮겨 간다
    await login('', 'x');
    expect(user().getAttribute('aria-invalid')).toBe('true');
    expect(pass().hasAttribute('aria-invalid')).toBe(false);
  });

  it('같은 칸이 다시 틀려도 초점을 다시 준다 · 다시 보내는 동안은 빨간 테 · 띠를 거둠', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': err(401, 'AUTH_REQUIRED', BAD) });
    await open(); await login('kim', 'bad');
    act(() => { pass().focus(); });
    await login('kim', 'bad2');
    expect(document.activeElement).toBe(user());
    routes['POST /auth/login'] = () => new Promise<Reply>(() => {});   // 답이 오지 않는 동안
    await login('kim', 'bad3');
    expect(box.querySelectorAll('[aria-invalid]').length).toBe(0);
    expect(band()).toBeNull();
  });

  it('429 · 연결 실패: 서버(또는 앱) 말 그대로 · 칸 표시 없음', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': err(429, 'RATE_LIMITED', MANY) });
    await open(); await login('kim', 'bad');
    expect(band()!.textContent).toBe(MANY);
    expect(box.querySelectorAll('[aria-invalid]').length).toBe(0);
    delete routes['POST /auth/login']; routes.NET = { status: 0 };
    await login('kim', 'bad');
    expect(band()!.textContent).toContain('서버에 연결하지 못했습니다');
    expect(box.querySelectorAll('[aria-invalid]').length).toBe(0);
  });

  it('안내(로그인이 끝났습니다)는 중립 띠, 제출 뒤 오류만 빨간 띠 (REVIEW-PR580 낮음)', async () => {
    serve({ 'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'c' } }, 'GET /me': { status: 200, body: KIM },
      'GET /robots': { status: 200, body: { items: [], next_cursor: null } }, 'GET /org/settings': NO_LOGIN, 'POST /auth/login': err(401, 'AUTH_REQUIRED', BAD) });
    await open('#/settings');
    const note = $('[data-login-note]')!;
    expect(note.textContent).toBe('로그인이 끝났습니다. 다시 로그인하세요.');
    expect(band()).toBeNull();
    expect(note.getAttribute('style')).not.toContain('--bad');
    expect(note.querySelector('svg')).toBeNull();
    expect(box.querySelectorAll('[aria-invalid]').length).toBe(0);
    await login('kim', 'bad');
    expect($('[data-login-note]')).toBeNull();
    expect(band()!.textContent).toBe(BAD);
    expect(band()!.getAttribute('style')).toContain('--bad');
  });

  it('처음 세션 확인이 401 이 아닌 까닭(500 · 연결 실패)으로 실패하면 빨간 오류 띠 · 칸 표시 없음 (REVIEW-PR580 §7)', async () => {
    serve({ 'GET /auth/session': err(500, 'INTERNAL', '서버 오류입니다.') });
    await open();
    expect($('main[aria-label="로그인"]')).not.toBeNull();
    expect($('[data-login-note]')).toBeNull();
    expect(band()!.textContent).toBe('서버 오류입니다.');
    expect(band()!.getAttribute('style')).toContain('--bad');
    expect(box.querySelectorAll('[aria-invalid]').length).toBe(0);
    act(() => root?.unmount()); root = null; box.remove();
    serve({ NET: { status: 0 } });
    await open();
    expect($('[data-login-note]')).toBeNull();
    expect(band()!.textContent).toContain('서버에 연결하지 못했습니다');
    expect(box.querySelectorAll('[aria-invalid]').length).toBe(0);
  });

  it('처음 세션 확인 401(세션 없음)은 띠 없음 (쓰는 중 401 의 중립 안내는 위 시험)', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open();
    expect($('[data-login-note]')).toBeNull();
    expect(band()).toBeNull();
  });

  it('비밀번호 보기 단추: 눌러도 제출 안 함 · 보기/숨기기 · aria-pressed', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open(); type(pass(), 'secret');
    const eye = $<HTMLButtonElement>('[data-pw-eye]')!;
    expect(eye.type).toBe('button');
    expect(eye.getAttribute('aria-label')).toBe('비밀번호 보기');
    expect(pass().type).toBe('password');
    act(() => { eye.click(); });
    expect(pass().type).toBe('text');
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(eye.getAttribute('aria-label')).toBe('비밀번호 숨기기');
    act(() => { eye.click(); });
    expect(pass().type).toBe('password');
    await flush();
    expect(calls.some((c) => c.path === '/auth/login')).toBe(false);
  });

  it('「계정은 총괄에게 요청하세요.」 한 줄 · 오류 없을 때 띠 없음', async () => {
    serve({ 'GET /auth/session': NO_LOGIN });
    await open();
    expect(band()).toBeNull();
    expect(ACCOUNT_ASK).toBe('계정은 총괄에게 요청하세요.');
    expect($('main[aria-label="로그인"]')!.textContent).toContain(ACCOUNT_ASK);
  });

  it('성공 로그인은 그대로 들어간다', async () => {
    serve({ 'GET /auth/session': NO_LOGIN, 'POST /auth/login': { status: 200, body: { ...KIM, csrf_token: 'c', access_token: null, refresh_token: null } },
      'GET /me': { status: 200, body: KIM }, 'GET /robots': { status: 200, body: { items: [], next_cursor: null } } });
    await open(); await login('kim', 'good');
    expect($('main[aria-label="로그인"]')).toBeNull();
  });
});

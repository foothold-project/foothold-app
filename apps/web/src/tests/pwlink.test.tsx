// 로그인 화면 「비밀번호 바꾸기」 (시안 u10_2 창 · u10_4 초록 줄).
// 서버 /me/password 는 로그인한 세션이 있어야 하므로 창은 로그인 → POST /me/password → 로그아웃 을 차례로 한다(새 API 없음).
// 8 자 이상 · 스페이스 금지는 창이 보내기 전에 막는다(서버 최소 길이 1). 막히면 요청을 보내지 않는다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_ASK, PW_DONE, PW_RULE, PW_TEMP } from '../loginform';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOGIN = { id: 'u-lee', username: 'lead01', display_name: '이OO', role: 'OPERATOR', locked: false, robot_ids: [], created_at: '', csrf_token: 'c1', access_token: null, refresh_token: null };
let calls: { method: string; path: string; body?: string }[] = [];
const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const no = (code: string, message: string, status: number) => res(status, { error: { code, message, detail: {} } });
function serve(o: { login?: number; password?: number } = {}) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^\/api\/v1/, ''), method = init.method ?? 'GET';
    calls.push({ method, path, body: typeof init.body === 'string' ? init.body : undefined });
    if (path === '/auth/login') return (o.login ?? 200) === 200 ? res(200, LOGIN) : no('AUTH_FAILED', '아이디 또는 비밀번호가 맞지 않습니다.', 401);
    if (path === '/me/password') return (o.password ?? 204) === 204 ? res(204) : no('VALIDATION', '지금 비밀번호가 맞지 않습니다.', 400);
    if (path === '/auth/logout') return res(204);
    return no('AUTH_REQUIRED', '로그인이 필요합니다.', 401);
  });
}
let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(o?: { login?: number; password?: number }) {
  serve(o);
  location.hash = '#/fleet';
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const link = () => $<HTMLButtonElement>('[data-pw-link]')!, dlg = () => $('[role="dialog"]');
const setv = (name: string, v: string) => { const i = $<HTMLInputElement>(`[role="dialog"] input[name="${name}"]`)!; i.value = v; };
const fill = (id: string, cur: string, nw: string, again = nw) => { setv('pw-id', id); setv('pw-cur', cur); setv('pw-new', nw); setv('pw-again', again); };
const send = async () => { act(() => { $<HTMLFormElement>('form[role="dialog"]')!.requestSubmit(); }); await flush(); };
const sent = () => calls.filter((c) => c.method !== 'GET').map((c) => c.path);

describe('로그인 화면 비밀번호 바꾸기 (u10_2 · u10_4)', () => {
  it('링크 → 시안 창: 제목 · 네 칸 · 규칙 두 줄 · 취소 · 바꾸기, 계정 요청 한 줄은 그대로 · X · 취소 · Esc 는 요청 없이 닫힘', async () => {
    await open();
    expect(link().textContent).toBe('비밀번호 바꾸기');
    expect(dlg()).toBeNull();
    act(() => { link().click(); });
    expect(dlg()!.querySelector('.ttl')!.textContent).toBe('비밀번호 바꾸기');
    expect([...dlg()!.querySelectorAll('.lab')].map((e) => e.textContent)).toEqual(['아이디', '지금 비밀번호', '새 비밀번호', '새 비밀번호 다시']);
    expect(dlg()!.querySelector('.lg-mnote')!.textContent).toBe(PW_RULE + PW_TEMP);
    expect([...dlg()!.querySelectorAll('.mbtn')].map((e) => e.textContent)).toEqual(['취소', '바꾸기']);
    expect(document.activeElement).toBe($('input[name="pw-id"]'));
    expect($('main[aria-label="로그인"]')!.textContent).toContain(ACCOUNT_ASK);
    act(() => { dlg()!.querySelector<HTMLButtonElement>('.mbtn.sec')!.click(); });
    expect(dlg()).toBeNull();
    act(() => { link().click(); });
    act(() => { dlg()!.querySelector<HTMLButtonElement>('[aria-label="닫기"]')!.click(); });
    expect(dlg()).toBeNull();
    act(() => { link().click(); });
    act(() => { dlg()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(dlg()).toBeNull();
    expect(sent()).toEqual([]);
  });

  it('보내기 전에 막음: 빈 칸 · 8 자 미만 · 스페이스 · 지금과 같음 · 다시 칸 다름 → 요청 없음 · 그 칸 빨간 테', async () => {
    await open();
    act(() => { link().click(); });
    const cases: [string[], string, string][] = [
      [['', 'old', 'newpass12'], 'pw-id', '아이디를 입력하세요.'],
      [['lead01', '', 'newpass12'], 'pw-cur', '지금 비밀번호를 입력하세요.'],
      [['lead01', 'old', 'short'], 'pw-new', '새 비밀번호는 8 자 이상 입력하세요.'],
      [['lead01', 'old', 'new pass12'], 'pw-new', '스페이스는 정지 키라서 비밀번호에 쓸 수 없습니다.'],
      [['lead01', 'samepass12', 'samepass12'], 'pw-new', '지금 비밀번호와 다른 값을 입력하세요.'],
    ];
    for (const [[id, cur, nw], name, text] of cases) {
      fill(id, cur, nw); await send();
      expect($('[data-pw-err]')!.textContent).toBe(text);
      expect($(`input[name="${name}"]`)!.getAttribute('aria-invalid')).toBe('true');
    }
    fill('lead01', 'old', 'newpass12', 'newpass13'); await send();
    expect($('[data-pw-err]')!.textContent).toBe('새 비밀번호가 서로 다릅니다.');
    expect($('input[name="pw-again"]')!.getAttribute('aria-invalid')).toBe('true');
    expect(sent()).toEqual([]);
  });

  it('바꿈: 로그인 → POST /me/password(지금 · 새) → 로그아웃, 창이 닫히고 카드에 시안 u10_4 초록 줄', async () => {
    await open();
    act(() => { link().click(); });
    fill('lead01', 'oldpass1', 'newpass12'); await send();
    expect(sent()).toEqual(['/auth/login', '/me/password', '/auth/logout']);
    expect(JSON.parse(calls.find((c) => c.path === '/me/password')!.body!)).toEqual({ current_password: 'oldpass1', new_password: 'newpass12' });
    expect(dlg()).toBeNull();
    expect($('[data-pw-changed]')!.textContent).toBe(PW_DONE);
    expect(PW_DONE).toBe('비밀번호를 바꿨습니다. 새 비밀번호로 로그인하세요');
    expect($('main[aria-label="로그인"] [data-login-err]')).toBeNull();
  });

  it('서버 거절: 로그인 401 = 두 칸 빨간 테 · 받은 글 · /me/password 안 보냄 / 바꾸기 실패 = 까닭 + 로그아웃은 함 · 창 그대로', async () => {
    await open({ login: 401 });
    act(() => { link().click(); });
    fill('lead01', 'wrong123', 'newpass12'); await send();
    expect(sent()).toEqual(['/auth/login']);
    expect($('[data-pw-err]')!.textContent).toBe('아이디 또는 비밀번호가 맞지 않습니다.');
    expect(['pw-id', 'pw-cur'].map((n) => $(`input[name="${n}"]`)!.getAttribute('aria-invalid'))).toEqual(['true', 'true']);
    act(() => root?.unmount()); root = null; box.remove(); vi.unstubAllGlobals();
    await open({ password: 400 });
    act(() => { link().click(); });
    fill('lead01', 'oldpass1', 'newpass12'); await send();
    expect(sent()).toEqual(['/auth/login', '/me/password', '/auth/logout']);
    expect($('[data-pw-err]')!.textContent).toBe('바꾸지 못했습니다. 지금 비밀번호가 맞지 않습니다.');
    expect(dlg()).not.toBeNull();
    expect($('[data-pw-changed]')).toBeNull();
  });
});

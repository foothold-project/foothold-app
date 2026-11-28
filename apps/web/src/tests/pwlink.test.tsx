// 로그인 화면 「비밀번호 바꾸기」 링크(u10_2 가안): 누르면 바꾸는 자리를 회색 띠로 알린다. 로그인 전 바꾸기 창(시안 그대로)은 #471 뒤.
// 서버 /me/password 는 로그인한 세션이 있어야 한다(api.py:534-535) · 웹의 유일한 입구는 PC 설정 › 내 정보(settings.tsx:327).
// 폰 틀에는 설정 탭이 없다(menu.tsx PHONE_TABS = 조종 · 기록) → 폰 폭 문구는 PC 에서 바꾼다고 사실대로.
// 서버에 없는 약속(8 자 이상 · 임시 비밀번호)은 쓰지 않는다. 보기만: 링크는 요청을 보내지 않고 로그인 칸을 건드리지 않는다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHONE_Q } from '../App';
import { ACCOUNT_ASK, PW_HINT_PC, PW_HINT_PHONE } from '../loginform';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let calls: { method: string; path: string }[] = [];
function serve() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? 'GET', path: url.replace(/^\/api\/v1/, '') });
    return new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.', detail: {} } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  });
}
let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(phone: boolean) {
  serve();
  location.hash = '#/fleet';
  window.matchMedia = ((q: string) => ({ matches: phone && q === PHONE_Q, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const link = () => $<HTMLButtonElement>('[data-pw-link]')!, hint = () => $('[data-pw-hint]');
const click = async () => { act(() => { link().click(); }); await flush(); };

describe('로그인 화면 비밀번호 바꾸기 링크 (u10_2 가안)', () => {
  it('PC: 처음엔 띠 없음 · 누르면 회색 띠 「로그인한 뒤 설정 › 내 정보에서 바꿉니다.」 · 다시 누르면 닫힘', async () => {
    await open(false);
    expect(link().textContent).toBe('비밀번호 바꾸기');
    expect(link().type).toBe('button');
    expect(link().getAttribute('aria-expanded')).toBe('false');
    expect(hint()).toBeNull();
    await click();
    expect(hint()!.textContent).toBe('로그인한 뒤 설정 › 내 정보에서 바꿉니다.');
    expect(PW_HINT_PC).toBe('로그인한 뒤 설정 › 내 정보에서 바꿉니다.');
    expect(link().getAttribute('aria-expanded')).toBe('true');
    expect(link().getAttribute('aria-controls')).toBe(hint()!.id);
    expect(hint()!.getAttribute('style')).toContain('var(--panel2)');   // 오류 빨강이 아닌 중립 띠
    expect($('[data-login-err]')).toBeNull();
    await click();
    expect(hint()).toBeNull();
    expect(link().getAttribute('aria-expanded')).toBe('false');
  });

  it('폰 폭: 설정 탭이 없으니 PC 에서 바꾼다고 사실대로', async () => {
    await open(true);
    await click();
    expect(hint()!.textContent).toBe(PW_HINT_PHONE);
    expect(PW_HINT_PHONE).toBe('폰 화면에는 설정이 없습니다. PC 에서 로그인한 뒤 설정 › 내 정보에서 바꿉니다.');
  });

  it('보기만: 요청을 보내지 않고 · 로그인 칸 표시 · 계정 요청 한 줄은 그대로', async () => {
    await open(false);
    const before = calls.length;
    await click();
    expect(calls.length).toBe(before);
    expect(box.querySelector('[aria-invalid]')).toBeNull();
    expect($('main[aria-label="로그인"]')!.textContent).toContain(ACCOUNT_ASK);
  });

  it('서버에 없는 약속은 쓰지 않음(8 자 이상 · 임시 비밀번호)', () => {
    for (const t of [PW_HINT_PC, PW_HINT_PHONE]) { expect(t).not.toMatch(/8\s*자|임시/); expect(t).not.toContain('\u2014'); }
  });
});

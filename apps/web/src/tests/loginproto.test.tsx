// 시안 로그인 카드(proto screens/u10_1 · u10_3): 유리 카드 · FOOTHOLD 글자 · 「로그인」 · 「총괄 · 운영자 계정으로 로그인합니다」 · 바탕.
// 칸 · 오류 띠 · 초점 · 보기 단추 · 비밀번호 바꾸기 안내의 동작은 loginerr · pwlink 시험이 본다(그대로 통과해야 한다).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_ASK } from '../loginform';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });

describe('시안 로그인 카드 (u10_1)', () => {
  it('카드 안에 시안 글자 · 칸 · 로그인 단추 · 비밀번호 바꾸기 · 계정 요청 한 줄, 바탕 층이 있다', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.', detail: {} } }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<Root />); });
    await flush();
    const card = box.querySelector('main[aria-label="로그인"] form.lg-card')!;
    expect(card).not.toBeNull();
    expect(box.querySelector('.fh.lg > .lg-bg')).not.toBeNull();
    expect(card.querySelector('.lg-logo')!.textContent).toBe('FOOTHOLD');
    expect(card.querySelector('h2')!.textContent).toBe('로그인');
    expect(card.querySelector('.lg-sub')!.textContent).toBe('총괄 · 운영자 계정으로 로그인합니다');
    const fields = card.querySelector('.lg-fields')!;
    expect(fields.querySelector('input[name="username"]')).not.toBeNull();
    expect(fields.querySelector('input[name="password"]')).not.toBeNull();
    expect(fields.querySelector('button[type="submit"]')!.textContent).toBe('로그인');
    expect(card.querySelector('[data-pw-link]')!.textContent).toBe('비밀번호 바꾸기');
    expect(card.querySelector('[data-account-ask]')!.textContent).toBe(ACCOUNT_ASK);
    // 순서: 제목 → 칸 → 비밀번호 바꾸기 줄 (시안 배치)
    const order = [card.querySelector('h2')!, fields, card.querySelector('[data-pw-link]')!];
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  const open = async (w: number, h: number, phone: boolean) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.', detail: {} } }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('innerWidth', w); vi.stubGlobal('innerHeight', h);
    window.matchMedia = ((q: string) => ({ matches: phone && q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<Root />); });
    await flush();
    return box.querySelector<HTMLElement>('.fh.lg')!;
  };
  it('PC = 앱 틀과 같은 무대 배율(1600 × 900 → 0.8333): 1920 × 1080 판을 창에 맞추고 스크롤 없음', async () => {
    const lg = await open(1600, 900, false);
    expect(lg.closest('[data-fit]')).not.toBeNull();
    expect([lg.dataset.scale, lg.style.width, lg.style.height]).toEqual(['0.8333', '1920px', '1080px']);
    expect(lg.style.transform).toContain('scale(0.8333');
  });
  it('폰은 무대 배율 없이 기존 흐름', async () => {
    const lg = await open(390, 844, true);
    expect([lg.dataset.scale, lg.closest('[data-fit]')]).toEqual([undefined, null]);
  });
});

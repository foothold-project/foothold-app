// 팀장 11/22 11:33: 기본 비밀번호 계정도 들어가게 하고 팝업으로 바꾸기를 권한다 (막지 않음). 「나중에」 로 닫고,
// 바꾸면 로그인 화면으로 (서버가 모든 세션을 끝냄).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { User } from '../../../contracts/ts';
import { FIRST_PW_DONE, Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIM: User = { id: 'o1', username: 'lim', display_name: '임', role: 'OPERATOR', locked: false, password_must_change: true, robot_ids: [], created_at: '2026-11-22T00:00:00Z' };
let calls: string[] = [], bodies: unknown[] = [];
let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });

it('앱은 열고 비밀번호 바꾸기를 권한다 · 나중에 · 바꾸면 로그인 화면으로', async () => {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^\/api\/v1/, '').split('?')[0];
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    const ok = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/auth/session') return ok({ client: 'web', csrf_token: 'csrf-1' });
    if (path === '/me') return ok(LIM);
    if (path === '/me/password') return ok(null, 204);
    if (path === '/dashboard') return ok({ robots_total: 0, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] });
    if (path === '/notifications') return ok({ items: [], next_cursor: null, unread_count: 0 });
    return ok({ items: [], next_cursor: null });
  });
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/fleet';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
  expect(calls.some((c) => c.includes('/robots'))).toBe(true);   // 앱은 그대로 열림
  const later = [...box.querySelectorAll('[aria-label="비밀번호 바꾸기"] button')].find((b) => b.textContent === '나중에') as HTMLButtonElement;
  act(() => later.click()); await flush();
  expect(box.querySelector('[aria-label="비밀번호 바꾸기"]')).toBeNull();
  act(() => root!.unmount()); box.remove();
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
  const form = box.querySelector('[aria-label="비밀번호 바꾸기"] form') as HTMLFormElement;
  expect(form).toBeTruthy();
  const set = (n: string, v: string) => { (form.querySelector(`[name="${n}"]`) as HTMLInputElement).value = v; };
  set('current', 'fake-temp'); set('next', 'fake-temp'); set('again', 'fake-temp');
  act(() => form.requestSubmit()); await flush();
  expect(box.textContent).toContain('지금 비밀번호와 같습니다');
  set('next', 'fake-mine'); set('again', 'fake-mine');
  act(() => form.requestSubmit()); await flush();
  expect(bodies[bodies.length - 1]).toEqual({ current_password: 'fake-temp', new_password: 'fake-mine' });
  expect(box.querySelector('[aria-label="로그인"]')).toBeTruthy();
  expect(box.textContent).toContain(FIRST_PW_DONE);
});

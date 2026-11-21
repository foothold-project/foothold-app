// 팀장 11/22: 기본 비밀번호로 만든 계정은 첫 로그인 때 비밀번호를 바꿔야 쓸 수 있다. /me 가 password_must_change 면
// 앱 대신 비밀번호 바꾸기 화면, 바꾸면 로그인 화면으로 (서버가 모든 세션을 끝냄). 로봇 목록은 부르지 않는다.
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

it('비밀번호를 바꾸기 전에는 앱을 열지 않고, 바꾸면 로그인 화면으로', async () => {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^\/api\/v1/, '').split('?')[0];
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    const ok = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/auth/session') return ok({ client: 'web', csrf_token: 'csrf-1' });
    if (path === '/me') return ok(LIM);
    if (path === '/me/password') return ok(null, 204);
    return ok({ error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '처음 로그인했습니다. 비밀번호를 바꾼 뒤 쓰세요.', detail: {} } }, 403);
  });
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
  const form = box.querySelector('[aria-label="비밀번호 바꾸기"] form') as HTMLFormElement;
  expect(form).toBeTruthy();
  expect(calls.some((c) => c.includes('/robots'))).toBe(false);
  const set = (n: string, v: string) => { (form.querySelector(`[name="${n}"]`) as HTMLInputElement).value = v; };
  set('current', 'fake-temp'); set('next', 'fake-temp'); set('again', 'fake-temp');
  act(() => form.requestSubmit()); await flush();
  expect(box.textContent).toContain('지금 비밀번호와 같습니다');
  set('next', 'fake-mine'); set('again', 'fake-mine');
  act(() => form.requestSubmit()); await flush();
  expect(bodies.at(-1)).toEqual({ current_password: 'fake-temp', new_password: 'fake-mine' });
  expect(box.querySelector('[aria-label="로그인"]')).toBeTruthy();
  expect(box.textContent).toContain(FIRST_PW_DONE);
});

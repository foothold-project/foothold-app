// 폰 화면 시안 꼴(u13_1 로그인 · u13_4 로봇 없음 · u13_5 조종권 요청 창): 시안 DOM(.proto.pv + 시안 class)이 나오고 옛 부품(lv-card · fh-empty · .btn · dv-ask)이 없는지,
// 동작(로그인 요청 본문 · 칸 표시 · 로봇 연결 입구 · 넘기기 / 계속 조종)은 그대로인지. 가짜 서버(fetch 가짜 · /api/v1 만) · FakeWS · 실기 없음.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RobotSummary, User } from '../../../contracts/ts';
import { Root } from '../session';
import { NO_ROBOT_WHY } from '../screens/norobot';
import { TakeoverAsk } from '../screens/takeover';
import { FakeWS } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR' };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name }, simulation: false, server_drive_allowed: false,
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
type Reply = { status: number; body?: unknown };
let calls: { method: string; path: string; body?: unknown }[] = [];
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });
function serve(routes: Record<string, Reply>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (!url.startsWith('/api/v1/')) throw new Error(`밖으로 나가는 요청: ${url}`);
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '').split('?')[0];
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const rep = routes[`${method} ${path}`] ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, robots: RobotSummary[]) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'c' } }, 'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: robots, next_cursor: null } }, 'GET /users': { status: 200, body: { items: [KIM, LEE], next_cursor: null } },
  'GET /dashboard': { status: 200, body: { robots_total: robots.length, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } },
  'GET /simulation/worlds': { status: 200, body: { worlds: [] } }, 'GET /simulation/robots': { status: 200, body: { items: [] } },
});
let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(phone: boolean, hash = '#/drive') {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('WebSocket', FakeWS);
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const NO_LOGIN = { 'GET /auth/session': err(401, 'AUTH_REQUIRED', '로그인이 필요합니다.') };

describe('폰 로그인 = 시안 u13_1', () => {
  it('시안 DOM(.proto.pv.u13 · .bg · .g 카드 · 아이디 / 비밀번호 .inp · .prim 로그인 · .link 비밀번호 바꾸기), 옛 로그인 틀 없음', async () => {
    serve(NO_LOGIN);
    await open(true);
    const main = $('main.proto.pv.u13[aria-label="로그인"]')!;
    expect(main).not.toBeNull();
    expect(main.querySelector('.bg')).not.toBeNull();
    expect([...main.querySelectorAll('.lab')].map((x) => x.textContent)).toEqual(['아이디', '비밀번호']);
    expect(main.querySelector('form.g button.prim[type="submit"]')!.textContent).toBe('로그인');
    expect(main.querySelector('button.link[data-pw-link]')!.textContent).toBe('비밀번호 바꾸기');
    expect(main.querySelector('[data-account-ask]')!.textContent).toBe('계정은 총괄에게 요청하세요');
    expect(box.querySelector('.fh-login, .btn, .fh-field, [data-pw-eye]')).toBeNull();
  });

  it('동작 그대로: 같은 요청 본문 · 서버 401 은 두 칸 .bad + 오류 한 줄 .msg.err · 초점 아이디', async () => {
    serve({ ...NO_LOGIN, 'POST /auth/login': err(401, 'INVALID_CREDENTIALS', '계정 또는 비밀번호를 확인하세요.') });
    await open(true);
    type($<HTMLInputElement>('input[name="username"]')!, 'op-a'); type($<HTMLInputElement>('input[name="password"]')!, 'pw');
    act(() => { $<HTMLFormElement>('form')!.requestSubmit(); }); await flush();
    expect(calls.find((c) => c.path === '/auth/login')!.body).toMatchObject({ username: 'op-a', password: 'pw' });
    expect($('.msg.err[data-login-err]')!.textContent).toBe('계정 또는 비밀번호를 확인하세요.');
    expect([...box.querySelectorAll('input.inp.bad')].map((x) => x.getAttribute('name'))).toEqual(['username', 'password']);
    expect(document.activeElement).toBe($('input[name="username"]'));
  });

  it('비밀번호 바꾸기 = 시안 u13_2 창(.veil · 두 줄 두 칸 · 취소 / 바꾸기) → 바꾸면 시안 u13_3 위 알림 .msg.ok', async () => {
    serve({ ...NO_LOGIN, 'POST /auth/login': { status: 200, body: { client: 'web', csrf_token: 'c' } }, 'POST /me/password': { status: 204 }, 'POST /auth/logout': { status: 204 } });
    await open(true);
    act(() => { $<HTMLButtonElement>('[data-pw-link]')!.click(); });
    const dlg = $('main.u13 form.g[role="dialog"][data-u13="password"]')!;
    expect(dlg).not.toBeNull();
    expect($('main.u13 > .veil')).not.toBeNull();
    expect([...dlg.querySelectorAll('.lab')].map((x) => x.textContent)).toEqual(['아이디', '현재 비밀번호', '새 비밀번호', '새 비밀번호 확인']);
    expect([...dlg.querySelectorAll('button.sec, button.prim')].map((x) => x.textContent)).toEqual(['취소', '바꾸기']);
    expect(box.querySelector('.lg-modal')).toBeNull();
    const set = (n: string, v: string) => type(dlg.querySelector<HTMLInputElement>(`input[name="${n}"]`)!, v);
    set('pw-id', 'op-a'); set('pw-cur', 'old-pass-1'); set('pw-new', 'new-pass-1'); set('pw-again', 'new-pass-1');
    act(() => { (dlg as HTMLFormElement).requestSubmit(); }); await flush();
    expect(calls.find((c) => c.path === '/me/password')!.body).toMatchObject({ current_password: 'old-pass-1', new_password: 'new-pass-1' });
    expect($('[data-u13="password"]')).toBeNull();
    expect($('main.u13 > .msg.ok[data-pw-changed]')!.textContent).toBe('바꿨습니다. 새 비밀번호로 로그인하세요');
  });

  it('PC 폭은 시안 u13 이 아님(PC 로그인 카드는 그대로)', async () => {
    serve(NO_LOGIN);
    await open(false);
    expect($('.u13')).toBeNull();
    expect($('main.fh-login')).not.toBeNull();
  });
});

describe('폰 로봇 없음 = 시안 u13_4', () => {
  it('운영자 0대: 시안 DOM · 옛 칸 없음 · «로봇 연결» = 새 로봇 추가(같은 길)', async () => {
    serve(signedIn(LEE, []));
    await open(true);
    const s = $('[data-u13="no-robot"]')!;
    expect(s.className).toBe('proto pv u13 u134');
    expect(s.querySelector('.bg')).not.toBeNull();
    expect(s.querySelector('h2')!.textContent).toBe('담당 로봇이 없습니다');
    expect(s.textContent).toContain(NO_ROBOT_WHY);
    expect(box.querySelector('.fh-main .lv-card, .fh-main .fh-empty, .fh-main .btn')).toBeNull();
    act(() => { s.querySelector<HTMLButtonElement>('button.prim[data-robot-connect]')!.click(); }); await flush();
    expect($('[aria-label="새 로봇 추가"]')).not.toBeNull();
    expect($('[data-u13="no-robot"]')).toBeNull();
  });

  it('총괄 0대: 제목 «등록된 로봇이 없습니다» · «시뮬 로봇 띄우기»는 시뮬 띄우기 칸을 연다', async () => {
    serve(signedIn(KIM, []));
    await open(true);
    expect($('[data-u13="no-robot"] h2')!.textContent).toBe('등록된 로봇이 없습니다');
    act(() => { $<HTMLButtonElement>('[data-sim-open]')!.click(); }); await flush();
    expect($('[data-u13="no-robot"]')).toBeNull();
    expect($('[aria-label="내 로봇"]')).not.toBeNull();
  });

  it('로봇이 있거나 PC 면 시안 u13_4 아님', async () => {
    serve(signedIn(LEE, [RA]));
    await open(true);
    expect($('[data-u13="no-robot"]')).toBeNull();
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(LEE, []));
    await open(false, '#/fleet');
    expect($('[data-u13="no-robot"]')).toBeNull();
  });
});

describe('조종권 요청 창 = 시안 u13_5 요청 칸', () => {
  it('제목 · 남은 초 · 막대 · 계속 조종(.sec) / 넘기기(.prim) · 가림막은 손가락을 막지 않음(겹 pointer-events 는 css)', () => {
    box = document.createElement('div'); document.body.append(box);
    const give = vi.fn(), keep = vi.fn();
    act(() => { root = createRoot(box); root.render(<TakeoverAsk id="t" title="운영자 B 님이 K-01 조종권을 요청했습니다" left={7} bar={70} give={give} keep={keep} />); });
    const d = $('[role="dialog"]')!;
    expect(d.className).toBe('proto pv u135');
    expect(d.querySelector('.veil')).not.toBeNull();
    expect($('#t')!.textContent).toBe('운영자 B 님이 K-01 조종권을 요청했습니다');
    expect($('[data-takeover-left]')!.textContent).toBe('넘겨주시겠습니까? 7 초 안에 답하지 않으면 조종권을 넘기지 않습니다');
    expect($<HTMLElement>('[data-takeover-bar] i')!.style.width).toBe('70%');
    expect([...d.querySelectorAll('button')].map((b) => `${b.className}:${b.textContent}`)).toEqual(['sec:계속 조종', 'prim:넘기기']);
    act(() => { $<HTMLButtonElement>('[data-ask="give"]')!.click(); });
    expect(give).toHaveBeenCalledTimes(1);
    expect(d.querySelector('.btn, .dv-ask')).toBeNull();
  });

  it('직결(시뮬 · 실기)은 요청에 만료 시각이 없어 남은 초 · 막대 없이 «넘겨주시겠습니까?»만', () => {
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<TakeoverAsk id="t" title="다른 사람이 이 로봇의 조종권을 요청했습니다" give={() => {}} keep={() => {}} />); });
    expect($('[data-takeover-left]')!.textContent).toBe('넘겨주시겠습니까?');
    expect($('[data-takeover-bar]')).toBeNull();
  });
});

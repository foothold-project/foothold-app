// 폰 화면 시안 꼴(u13_1 로그인 · u13_4 로봇 없음 · u13_5 조종권 요청 창): 시안 DOM(.proto.pv + 시안 class)이 나오고 옛 부품(lv-card · fh-empty · .btn · dv-ask)이 없는지,
// 동작(로그인 요청 본문 · 칸 표시 · 로봇 연결 입구 · 넘기기 / 계속 조종)은 그대로인지. 가짜 서버(fetch 가짜 · /api/v1 만) · FakeWS · 실기 없음.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event as Ev, RobotSummary, User } from '../../../contracts/ts';
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
let calls: { method: string; path: string; q: URLSearchParams; body?: unknown }[] = [];
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });
function serve(routes: Record<string, Reply | ((q: URLSearchParams) => Reply)>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (!url.startsWith('/api/v1/')) throw new Error(`밖으로 나가는 요청: ${url}`);
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    calls.push({ method, path, q, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[`${method} ${path}`], rep = (typeof r === 'function' ? r(q) : r) ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
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

describe('폰 알림 목록 = 시안 u3_3', () => {
  const AT = new Date(2026, 10, 28, 14, 20).toISOString();
  const ev = (id: string, p: Partial<Ev> = {}): Ev => ({ id, at: AT, robot_at: null, category: 'SAFETY', code: 'FALL', severity: 'ERROR',
    message: `14:20 사건 ${id} 문장`, robot_id: 'r-a', user_id: null, run_id: null, data: {}, ...p });
  const ITEMS = [ev('1'), ev('2', { category: 'ROUTE', code: 'ROUTE_LOST', severity: 'WARN', message: '길을 못 찾았습니다.' }),
    ev('3', { category: 'RUN', code: 'RUN_DONE', severity: 'INFO', run_id: 'run-1', message: '순찰을 마쳤습니다.' })];
  const page = (items: Ev[]) => ({ status: 200, body: { items, next_cursor: null } });
  const routes = () => ({ ...signedIn(LEE, [RA]), 'GET /notifications': { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } },
    'GET /events': (q: URLSearchParams) => page(q.get('severity') ? ITEMS.filter((e) => e.severity === q.get('severity')) : ITEMS),
    'GET /runs/run-1/history': { status: 200, body: { id: 'run-1', scenario_version_id: 'sv1', floor_id: 'f1', map_version_id: 'm1', scenario_name: '공정 순찰 A', floor_name: '1층',
      scenario_name_snapshot: null, floor_name_snapshot: null, status: 'COMPLETED', started_at: AT, ended_at: AT } } });
  const tiles = () => [...box.querySelectorAll<HTMLButtonElement>('.u33 .g.list button.tile')];
  const segs = () => [...box.querySelectorAll<HTMLButtonElement>('.u33 .g.seg button')];
  // 「오늘이면 시각, 아니면 날짜」(phonehistory clock) — 날짜만 고정(Date 만 가짜 · 다른 타이머는 진짜). 자정이 지나도 결과가 같게
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 28, 15, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('시각 칸 경계: 오늘 00:01 은 「00:01」 · 어제 23:59 는 「11/28」 (지금 = 11/29 00:10)', async () => {
    vi.setSystemTime(new Date(2026, 10, 29, 0, 10));
    const today = ev('a', { at: new Date(2026, 10, 29, 0, 1).toISOString(), message: '오늘 일' }), yday = ev('b', { at: new Date(2026, 10, 28, 23, 59).toISOString(), message: '어제 일' });
    serve({ ...routes(), 'GET /events': () => page([today, yday]) });
    await open(true, '#/history');
    expect(tiles().map((t) => t.querySelector('.t')!.textContent)).toEqual(['00:01', '11/28']);
  });

  it('시안 DOM(.proto.pv.u33 · .bg · .top 알림 · .seg 넷 · .list 타일 · .det), 옛 부품 없음, 첫 알림이 골라져 오른쪽 칸에', async () => {
    serve(routes());
    await open(true, '#/history');
    const s = $('[data-u33]')!;
    expect(s.className).toBe('proto pv u33');
    expect(s.querySelector(':scope > .bg')).not.toBeNull();
    expect(s.querySelector('.g.top b')!.textContent).toBe('알림');
    expect(segs().map((b) => b.textContent)).toEqual(['전체3', '위험1', '주의1', '정보1']);
    expect(segs()[0].className).toBe('on');
    expect(tiles().map((t) => t.querySelector('b')!.textContent)).toEqual(['사건 1 문장', '길을 못 찾았습니다.', '순찰을 마쳤습니다.']);
    expect(tiles()[0].querySelector('p')!.textContent).toBe('Go2-A · 안전');
    expect(tiles()[0].querySelector('.t')!.textContent).toBe('14:20');
    expect(tiles().map((t) => t.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    const det = s.querySelector('.g.det')!;
    expect(det.querySelector('.row span')!.textContent).toBe('위험');
    expect(det.querySelector('.row b')!.textContent).toBe('사건 1 문장');
    expect(det.textContent).not.toContain('지도에서 보기');   // 폰에 지도 탭이 없어 갈 곳 없음
    expect(box.querySelector('.fh-main .lv-card, .fh-main .fh-empty, .fh-main .btn, .fh-main table, .fh-main .hs-tile')).toBeNull();
  });

  it('등급 칸 = 서버 등급(severity) 거르기 · 고른 칸 .on · 타일을 누르면 오른쪽 칸이 그 알림, run_id 있으면 «실행 기록 보기»', async () => {
    serve(routes());
    await open(true, '#/history');
    act(() => { segs()[1].click(); }); await flush();
    expect(calls.filter((c) => c.path === '/events').pop()!.q.get('severity')).toBe('ERROR');
    expect(segs()[1].className).toBe('on');
    expect(tiles()).toHaveLength(1);
    act(() => { segs()[0].click(); }); await flush();
    expect(tiles()).toHaveLength(3);
    act(() => { tiles()[2].click(); }); await flush();
    expect(tiles()[2].getAttribute('aria-pressed')).toBe('true');
    const det = $('.u33 .g.det')!;
    expect(det.querySelector('.row b')!.textContent).toBe('순찰을 마쳤습니다.');
    expect(det.querySelector('.row span')!.textContent).toBe('정보');
    act(() => { det.querySelector<HTMLButtonElement>('button.act2')!.click(); }); await flush();
    expect($('[role="region"][aria-label="실행 기록"]')!.textContent).toContain('공정 순찰 A');
  });

  it('PC 기록 탭은 시안 u8 (u3_3 아님)', async () => {
    serve(routes());
    await open(false, '#/history');
    expect($('.u33')).toBeNull();
    expect($('.proto.pv.u8[data-hs-frame]')).not.toBeNull();
  });
});

describe('폰 로봇 붙이기 확인 · 완료 = 시안 u2_2 · u2_3', () => {
  const SERIAL = 'B42D-40000P61';
  const pairRoutes = () => ({ ...signedIn(LEE, []), 'GET /robots/r-a/slam': { status: 200, body: null },
    'POST /pairing/claim': { status: 200, body: { pairing_id: 'p1', robot_serial: SERIAL, expires_at: new Date(Date.now() + 9 * 60_000).toISOString() } },
    'POST /pairing/p1/confirm': { status: 200, body: { ...RA, battery: { soc: 71, updated_at: new Date().toISOString() } } } });
  const card = () => $('[aria-label="새 로봇 추가"]')!;
  async function toName(phone: boolean) {
    serve(pairRoutes());
    await open(phone, phone ? '#/drive' : '#/fleet');
    if (phone) { act(() => { $<HTMLButtonElement>('[data-robot-connect]')!.click(); }); await flush(); }
    else { act(() => { [...box.querySelectorAll('button')].find((b) => /로봇 (추가|연결하기)/.test(b.textContent ?? ''))!.click(); }); await flush(); }
    const code = $<HTMLInputElement>('[data-pair-code]')!;
    type(code, '123456');
    act(() => { code.form!.requestSubmit(); }); await flush();
  }

  it('확인(u2_2): 시안 DOM(.bgcam · .g.dk.top · .pill · 두 칸 · .kv · .field · .prim) · 받은 값만 · 옛 부품 없음', async () => {
    await toName(true);
    const s = card();
    expect(s.className).toBe('proto pv u2 u22');
    expect(s.dataset.pair).toBe('name');
    expect(s.querySelector(':scope > .bgcam')).not.toBeNull();
    expect(s.querySelector('.g.dk.top b')!.textContent).toBe('로봇 연결');
    expect(s.querySelector('[data-pair-steps]')!.textContent).toBe('2 / 3');
    expect(s.querySelector('.g.pill')!.textContent).toBe('코드를 확인했습니다');   // 앱 사실: 폰이 노트북 화면 코드를 넣음(시안 «로봇이 QR 을 읽었습니다» 아님)
    expect([...s.querySelectorAll('.h')].map((x) => x.textContent)).toEqual(['이 로봇이 맞나요?', '이름']);
    expect(s.querySelector('dl.kv [data-pair-serial]')!.textContent).toBe(SERIAL);
    expect(s.querySelector<HTMLInputElement>('input.field[name="name"]')!.value).toBe('Go2-0061');
    expect([...s.querySelectorAll('form button')].map((b) => `${b.className}:${b.textContent}`)).toEqual(['sec:처음으로', 'prim:연결하기']);
    expect(s.querySelector('.lv-card, .btn, .fh-field, .fh-msg, .pair-check')).toBeNull();
    expect(s.textContent).not.toContain('기종');   // claim 답에 없음
  });

  it('완료(u2_3): 연결하기 → 시안 DOM(.bgmap · 3/3 · data-pair-done · .scanb 지도 스캔 · .prim 내 로봇 보기 · .kv2 받은 값), 스캔 단추는 ScanStart 그대로', async () => {
    await toName(true);
    act(() => { card().querySelector('form')!.requestSubmit(); }); await flush();
    expect(calls.find((c) => c.path === '/pairing/p1/confirm')!.body).toEqual({ name: 'Go2-0061' });
    const s = card();
    expect(s.className).toBe('proto pv u2 u23');
    expect(s.dataset.pair).toBe('done');
    expect(s.querySelector(':scope > .bgmap')).not.toBeNull();
    expect(s.querySelector('[data-pair-steps]')!.textContent).toBe('3 / 3');
    expect(s.querySelector('[data-pair-done] .h')!.textContent).toBe('Go2-A 로봇을 등록했습니다.');
    expect(s.querySelector('button.scanb[data-scan-start]')!.textContent).toBe('이 현장 지도 스캔하기');
    expect(s.querySelector('button.prim')!.textContent).toBe('내 로봇 보기');
    const rows = [...s.querySelectorAll('.g.kv2 > div')].map((d) => d.querySelector('span')!.textContent);
    expect(rows).toEqual(['서버', '배터리', '담당']);
    expect(s.querySelector('.g.kv2')!.textContent).toContain('71 %');
    expect(s.querySelector('.lv-card, .btn, .fh-msg')).toBeNull();
  });
  // PC 로봇 추가는 로봇 탭 u4_6 → u2 흐름 시험이 맡음 (옛 카드 없음)
});

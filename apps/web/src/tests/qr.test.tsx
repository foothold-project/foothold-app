// 로봇 붙이기 u08(U2-01 · U2-02 · U2-08 · u14_1). 웹만으로 되는 단계 막대 · 확인 칸은 지금 시험하고,
// 폰이 QR · 6 자리를 보여 주는 방향(U2-02)과 읽음 신호 · 설정 모드 자동 풀림(U2-08)은 서버 계약 전이라 WAIT(it.fails)로만 둔다.
// 계약이 오면 요청 경로 · 자료 모양(가정: 로그인한 사람이 받는 { code, expires_at }, 읽음 상태 조회)을 맞춘 뒤 WAIT 를 it 로 바꾼다.
// /pairing/start · poll_secret 은 로봇 쪽 것이라 폰이 부르지 않는다(시험이 지킨다).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../contracts/ts';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEE: User = { id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const SERIAL = '1234-56785678';
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
type Reply = { status: number; body?: unknown };
let calls: { method: string; path: string; body?: unknown }[] = [];
function serve(more: Record<string, Reply> = {}) {
  calls = [];
  const routes: Record<string, Reply> = {
    'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
    'GET /me': { status: 200, body: LEE },
    'GET /robots': { status: 200, body: { items: [], next_cursor: null } },
    'GET /dashboard': { status: 200, body: { robots_total: 0, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } },
    'POST /pairing/claim': { status: 200, body: { pairing_id: 'p1', robot_serial: SERIAL, expires_at: inMin(9) } },
    'POST /pairing/p1/confirm': { status: 200, body: { id: 'r-new', name: 'Go2-5678' } },
    ...more,
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '').split('?')[0];
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const rep = routes[`${method} ${path}`] ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '찾을 수 없습니다.', detail: {} } } };
    return new Response(JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(phone = true) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/drive';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = document) =>   // 로봇 추가 흐름(u2)은 body 로 띄움
  from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = document) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const card = () => $('[aria-label="새 로봇 추가"]')!;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const startPair = async () => { await click($('[data-robot-connect]')); expect(card().dataset.pair).toBe('code'); };   // 로봇 0대 폰 = 시안 u13_4 «로봇 연결»
const putCode = async (c = '123456') => {
  const el = $<HTMLInputElement>('[data-pair-code]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, c); el.dispatchEvent(new Event('input', { bubbles: true })); });
  act(() => { el.form!.requestSubmit(); }); await flush();
};
const steps = () => card().querySelector('[data-pair-steps]')!;

describe('단계 막대(U2-01)', () => {
  it('폰: 코드 1/3 → 이름 2/3 → 끝 3/3, 지난 칸 · 지금 칸 표시', async () => {
    serve();
    await open(true);
    await startPair();
    const at = () => ({ text: steps().textContent, label: steps().getAttribute('aria-label'), on: [...steps().querySelectorAll('[data-on]')].length });
    expect(at()).toEqual({ text: '1 / 3', label: '3 단계 중 1 단계', on: 1 });
    await putCode();
    expect(card().dataset.pair).toBe('name');
    expect(at()).toEqual({ text: '2 / 3', label: '3 단계 중 2 단계', on: 2 });
    act(() => { $<HTMLFormElement>('[aria-label="새 로봇 추가"] form')!.requestSubmit(); }); await flush();
    expect(card().dataset.pair).toBe('done');
    expect(at()).toEqual({ text: '3 / 3', label: '3 단계 중 3 단계', on: 3 });
  });
  // PC 로봇 탭: 시안 u2 머리(.top) 의 단계 막대 · 「n / 3」 = 같은 판정
  it('PC: 코드 1/3 → 이름 2/3 → 끝 3/3 (시안 u2_1 → u2_2 → u2_3), 지난 칸 · 지금 칸 표시', async () => {
    serve();
    await open(false);
    location.hash = '#/fleet'; await flush();
    await click($('[data-u4-add]')); await click($('[data-u4-next]'));
    const at = () => { const t = $('[data-u2] .top')!; return { scr: $('[data-u2]')!.dataset.u2, text: t.lastElementChild!.textContent, on: t.querySelectorAll('.steps i.on').length }; };
    expect(at()).toEqual({ scr: 'u2_1_scan', text: '1 / 3', on: 1 });
    await putCode();
    expect(at()).toEqual({ scr: 'u2_2_confirm', text: '2 / 3', on: 2 });
    act(() => { $<HTMLFormElement>('[data-u2] form')!.requestSubmit(); }); await flush();
    expect(at()).toEqual({ scr: 'u2_3_done', text: '3 / 3', on: 3 });
  });
  it('«처음으로» 면 1/3 로 돌아감', async () => {
    serve();
    await open();
    await startPair();
    await putCode();
    await click(btn('처음으로'));
    expect(steps().textContent).toBe('1 / 3');
  });
});

describe('확인 칸(U2-01 · u2_2): 받은 값만', () => {
  it('기체번호 = claim 이 준 robot_serial, 담당 = 나(등록하는 사람). 기종은 claim 답에 없어 칸 없음', async () => {
    serve();
    await open();
    await startPair();
    await putCode();
    const rows = [...card().querySelectorAll('[data-pair-check] > div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]);
    expect(rows).toEqual([['기체번호', SERIAL], ['담당', '나 (등록하는 사람)']]);
    expect($('[data-pair-serial]')!.textContent).toBe(SERIAL);
    expect(card().textContent).not.toContain('기종');
    expect(card().textContent).toContain('노트북 화면의 기체번호와 같은지 보세요');
  });
  it('폰은 /pairing/start 를 부르지 않는다(poll_secret 은 로봇 쪽 것)', async () => {
    serve();
    await open();
    await startPair();
    await putCode();
    expect(calls.filter((c) => c.path === '/pairing/start' || /\/poll$/.test(c.path))).toEqual([]);
  });
});

/** 계약이 오기 전에는 실패해야 하는 시험. 계약과 구현이 들어오면 it 로 바꾼다 */
const WAIT = it.fails;
const OFFER = { 'POST /pairing/offer': { status: 200, body: { code: '482913', expires_at: inMin(10) } } };

describe('계약 기다림: 폰이 QR · 6 자리를 보여 줌(U2-02 · u14_1)', () => {
  WAIT('QR 표시 + 남은 시간 «m:ss 후 만료 · 1 회용»', async () => {
    serve(OFFER);
    await open();
    await startPair();
    expect($('[data-pair-qr] svg, [data-pair-qr] canvas, [data-pair-qr] img')).toBeTruthy();
    expect($('[data-pair-left]')!.textContent).toMatch(/^\d{1,2}:\d\d 후 만료 · 1 회용$/);
  });
  WAIT('만료되면 QR 을 지우고 «새 QR 받기» → 코드를 다시 받음', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(OFFER);
    await open();
    await startPair();
    await act(async () => { vi.advanceTimersByTime(10 * 60_000 + 1000); });
    expect($('[data-pair-qr]')).toBeNull();
    const before = calls.filter((c) => c.path === '/pairing/offer').length;
    await click(btn('새 QR 받기'));
    expect(calls.filter((c) => c.path === '/pairing/offer').length).toBe(before + 1);
    vi.useRealTimers();
  });
  WAIT('폰 화면에 6 자리 코드도 크게(인식이 안 되면 이 6 자리)', async () => {
    serve(OFFER);
    await open();
    await startPair();
    expect($('[data-pair-show-code]')!.textContent!.replace(/\D/g, '')).toBe('482913');
  });
  WAIT('읽음 신호 전에는 성공 표시 없이 «로봇이 읽었는지는 아직 알 수 없음 · 로봇 화면에서 확인»', async () => {
    serve(OFFER);
    await open();
    await startPair();
    expect(card().textContent).toContain('로봇이 읽었는지는 아직 알 수 없음 · 로봇 화면에서 확인');
    expect(card().textContent).not.toContain('읽었습니다');
  });
});

describe('계약 기다림: 읽음 신호 · 설정 모드 자동 풀림(U2-08)', () => {
  WAIT('로봇이 읽으면 «로봇이 QR 을 읽었습니다» → 확인 단계(2/3)로', async () => {
    serve({ ...OFFER, 'GET /pairing/offer/state': { status: 200, body: { state: 'read', pairing_id: 'p1', robot_serial: SERIAL } } });
    await open();
    await startPair();
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    await flush();
    expect(card().textContent).toContain('로봇이 QR 을 읽었습니다');
    expect(card().dataset.pair).toBe('name');
  });
  WAIT('읽고 나면 QR 은 한 번 쓰고 사라지고, 로봇 설정 모드가 풀렸다고 표시', async () => {
    serve({ ...OFFER, 'GET /pairing/offer/state': { status: 200, body: { state: 'read', pairing_id: 'p1', robot_serial: SERIAL, setup_mode: false } } });
    await open();
    await startPair();
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    await flush();
    expect($('[data-pair-qr]')).toBeNull();
    expect($('[data-pair-setup-off]')).toBeTruthy();
  });
});

// 로봇 탭 「로봇 추가」 = 시안 u4_6 → u2_1 → u2_2 → u2_3 (막힘 u2_4). 짝 맺기 API 는 기존 claim · confirm
describe('PC 로봇 추가 흐름 = 시안 u2', () => {
  const start = async () => { await open(false); location.hash = '#/fleet'; await flush(); await click($('[data-u4-add]')); await click($('[data-u4-next]')); };
  const scr = () => $('[data-u2]')?.dataset.u2;
  it('여섯째 숫자에서 claim → u2_2(기체번호 · 담당 · 이름 기본값) → 「연결하기」 = confirm → u2_3 → 「내 로봇 보기」 로 닫힘 · 옛 추가 창 0', async () => {
    serve({ 'POST /pairing/p1/confirm': { status: 200, body: { id: 'r-new', name: 'K-09', connection: 'OFFLINE', battery: null } } });
    await start();
    expect(scr()).toBe('u2_1_scan');
    await putCode('123456');
    expect(calls.filter((c) => c.path === '/pairing/claim').map((c) => c.body)).toEqual([{ code: '123456' }]);
    expect(scr()).toBe('u2_2_confirm');
    expect($('[data-pair-serial]')!.textContent).toBe(SERIAL);
    expect($('[data-pair-check]')!.textContent).toContain('나 · ');
    expect($<HTMLInputElement>('[data-u2] input[name="name"]')!.value).toBe('Go2-5678');
    act(() => { $<HTMLFormElement>('[data-u2] form')!.requestSubmit(); }); await flush();
    expect(calls.filter((c) => c.path === '/pairing/p1/confirm').map((c) => c.body)).toEqual([{ name: 'Go2-5678' }]);
    expect(scr()).toBe('u2_3_done');
    expect($('[data-pair-done]')!.textContent).toBe('K-09 을 연결했습니다');
    expect($('[data-u2-kv]')!.textContent).toContain('로봇 프로그램 연결 기다리는 중');   // 받은 값 그대로(꾸미지 않음)
    expect($('[aria-label="새 로봇 추가"]')).toBeNull();
    const before = calls.filter((c) => c.path === '/robots').length;
    await click($('[data-u2-mine]'));
    expect(scr()).toBeUndefined();
    expect(calls.filter((c) => c.path === '/robots').length).toBeGreaterThan(before);   // 목록 다시 받음
  });
  it('서버에 닿지 못하면 u2_4 「서버가 응답하지 않습니다」 · 「다시 점검」 = 같은 코드로 다시 claim', async () => {
    serve();
    await start();
    const real = globalThis.fetch;
    let down = true;
    vi.stubGlobal('fetch', (u: string, i?: RequestInit) => (down && u.includes('/pairing/claim') ? Promise.reject(new TypeError('x')) : real(u, i)));
    await putCode('654321');
    expect(scr()).toBe('u2_4_check_blocked');
    expect($('[data-u2]')!.textContent).toContain('서버가 응답하지 않습니다');
    down = false;
    await click($('[data-u2-retry]'));
    expect(scr()).toBe('u2_2_confirm');
  });
  it('틀린 · 지난 코드(404)는 u2_1 안 한 줄, 화면은 그대로', async () => {
    serve({ 'POST /pairing/claim': { status: 404, body: { error: { code: 'PAIRING_NOT_FOUND', message: 'x', detail: {} } } } });
    await start();
    await putCode('111111');
    expect(scr()).toBe('u2_1_scan');
    expect($('[data-u2] [role="alert"]')!.textContent).toContain('코드가 맞지 않거나');
  });
});

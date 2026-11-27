// 기록 탭 u07(U8-03 · U8-09 · U8-10 · U8-11). 등급 거르기는 지금 받는 자료(severity)와 서버 매개변수만으로 동작한다.
// 「지금 남기기」 · 클립 칸 · 재현 재생기는 서버 계약이 아직 없다: 아래 «계약 기다림» 묶음은 실패하는 것이 맞고(WAIT = it.fails),
// 계약이 오면 자료 모양(가정: event.data.clip = { url, duration_s })과 요청 경로를 계약에 맞춰 고친 뒤 WAIT 를 it 로 바꾼다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event as Ev, RobotSummary, User } from '../../../contracts/ts';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEE: User = { id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', locked: false, robot_ids: ['r-a'], created_at: '2026-10-19T00:00:00Z' };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name }, simulation: false, server_drive_allowed: false,
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
const NOW = new Date().toISOString();
const ev = (id: string, p: Partial<Ev> = {}): Ev => ({ id, at: NOW, robot_at: null, category: 'SAFETY', code: 'FALL', severity: 'ERROR',
  message: `사건 ${id} 문장`, robot_id: 'r-a', user_id: null, run_id: null, data: {}, ...p });
const list = (items: Ev[]) => ({ status: 200, body: { items, next_cursor: null } });

type Call = { method: string; path: string; q: URLSearchParams; body?: unknown };
let calls: Call[] = [];
function serve(more: Record<string, { status: number; body?: unknown }> = {}) {
  calls = [];
  const routes: Record<string, { status: number; body?: unknown }> = {
    'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
    'GET /me': { status: 200, body: LEE },
    'GET /robots': { status: 200, body: { items: [RA], next_cursor: null } },
    'GET /robots/r-a': { status: 200, body: RA },
    'GET /notifications': { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } },
    'GET /events': list([]),
    ...more,
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?');
    calls.push({ method, path, q: new URLSearchParams(qs), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const rep = routes[`${method} ${path}`] ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '찾을 수 없습니다.', detail: {} } } };
    return new Response(JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const lastQuery = (path = '/events') => { const all = sent('GET', path), q = new URLSearchParams(all[all.length - 1].q); q.delete('limit'); return Object.fromEntries(q); };

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash = '#/history') {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const card = (label: string) => $(`[aria-label="${label}"]`)!;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const rows = () => [...card('사건').querySelectorAll('tbody tr')];

describe('등급 거르기(U8-10 중 지금 자료로 되는 것)', () => {
  it('줄 등급 알약: ERROR = ■위험 · WARN = ▲주의 · INFO = ⓘ정보(옅은 알약), INFO 로 저장된 실패 코드는 ▲주의', async () => {
    serve({ 'GET /events': list([ev('1'), ev('2', { severity: 'WARN' }), ev('3', { severity: 'INFO', code: 'RUN_DONE' }), ev('4', { severity: 'INFO', code: 'STOP_CONFIRM_FAILED' }), ev('5', { severity: 'INFO', code: 'PHONE_LEASE_TIMEOUT' })]) });
    await open();
    const pills = rows().map((r) => r.querySelector('.hs-sev')!);
    expect(pills.map((x) => x.textContent)).toEqual(['■위험', '▲주의', 'ⓘ정보', '▲주의', '▲주의']);
    expect(pills.map((x) => x.getAttribute('data-tone'))).toEqual(['bad', 'warn', 'info', 'warn', 'warn']);
  });
  it('등급 단추 전체 · 위험 · 주의 · 정보 → severity 요청 매개변수, 분류와 함께, 전체면 뺌', async () => {
    serve({ 'GET /events': list([ev('1', { severity: 'INFO', message: '서버가 준 행' })]) });
    await open();
    const g = card('등급');
    expect([...g.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['전체', '■위험', '▲주의', 'ⓘ정보']);
    for (const [name, code] of [['■위험', 'ERROR'], ['▲주의', 'WARN'], ['ⓘ정보', 'INFO']]) {
      await click(btn(name, g));
      expect(lastQuery()).toEqual({ severity: code });
      expect(btn(name, g)!.getAttribute('aria-pressed')).toBe('true');
      expect(rows()[0].textContent).toContain('서버가 준 행');   // 화면이 따로 거르지 않음
    }
    await click(btn('안전', card('분류')));
    expect(lastQuery()).toEqual({ category: 'SAFETY', severity: 'INFO' });
    await click(btn('전체', g));
    expect(lastQuery()).toEqual({ category: 'SAFETY' });
  });
  it('등급을 고르면 빈 목록 문구는 «조건에 맞는 기록이 없습니다»', async () => {
    serve();
    await open();
    expect(box.textContent).toContain('아직 기록이 없습니다.');
    await click(btn('■위험', card('등급')));
    expect(box.textContent).toContain('조건에 맞는 기록이 없습니다.');
  });
  it('주의를 고르면 정보로 저장된 실패 기록은 정보에 있다고 알림(줄 표시 ▲와 서버 등급이 다른 경우)', async () => {
    serve();
    await open();
    expect($('[data-grade-note]')).toBeNull();
    await click(btn('▲주의', card('등급')));
    expect($('[data-grade-note]')!.textContent).toContain('정보');
    await click(btn('ⓘ정보', card('등급')));
    expect($('[data-grade-note]')).toBeNull();
  });
  it('내보내기도 지금 등급 그대로', async () => {
    serve({ 'GET /events/export.csv': { status: 200, body: 'a,b' } });
    URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await open();
    await click(btn('▲주의', card('등급')));
    await click(btn('내보내기'));
    expect(Object.fromEntries(sent('GET', '/events/export.csv')[0].q)).toEqual({ severity: 'WARN' });
  });
});

describe('기간 빠른 단추(오늘 · 7 일 · 30 일)', () => {
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const back = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
  const range = (a: string, b: string) => ({ from: new Date(`${a}T00:00:00`).toISOString(), to: new Date(`${b}T23:59:59.999`).toISOString() });
  it('누르면 오늘 포함 n 일 = 현지 0 시 ~ 오늘 끝, 날짜 칸에도 그 날짜, 눌린 단추 하나', async () => {
    serve();
    await open();
    const g = card('기간');
    expect([...g.querySelectorAll('button:not([aria-label$="달력"])')].map((b) => b.textContent)).toEqual(['오늘', '7 일', '30 일']);
    for (const [name, n] of [['오늘', 0], ['7 일', 6], ['30 일', 29]] as const) {
      await click(btn(name, g));
      expect(lastQuery()).toEqual(range(back(n), back(0)));
      expect($<HTMLInputElement>('[aria-label="기간 시작"]')!.value).toBe(back(n).replace(/-/g, '/'));
      expect($<HTMLInputElement>('[aria-label="기간 끝"]')!.value).toBe(back(0).replace(/-/g, '/'));
      expect([...g.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent)).toEqual([name]);
    }
  });
  it('날짜 칸을 직접 고치면 빠른 단추 눌림이 풀림, 분류 · 등급과 함께 요청', async () => {
    serve();
    await open();
    await click(btn('7 일', card('기간')));
    await click(btn('▲주의', card('등급')));
    expect(lastQuery()).toEqual({ severity: 'WARN', ...range(back(6), back(0)) });
    const start = $<HTMLInputElement>('[aria-label="기간 시작"]')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(start, '2026/10/01'); start.dispatchEvent(new Event('input', { bubbles: true })); });
    await flush();
    expect(card('기간').querySelector('button[aria-pressed="true"]')).toBeNull();
    expect(lastQuery()).toEqual({ severity: 'WARN', ...range('2026-10-01', back(0)) });
  });
});

/** 계약이 오기 전에는 실패해야 하는 시험. 구현과 계약이 들어오면 it 로 바꾼다 */
const WAIT = it.fails;
const CLIP = { url: '/api/v1/clips/c1.mp4', duration_s: 19.6 };

describe('계약 기다림: 「지금 남기기」(U8-11)', () => {
  WAIT('기록 탭에 「지금 남기기」 단추 → 로봇 · 메모 · 남는 범위(10 초 전 ~ 5 초 뒤) 창', async () => {
    serve();
    await open();
    await click(btn('지금 남기기'));
    const d = $('[role="dialog"][aria-label="지금 남기기"]')!;
    expect(d).toBeTruthy();
    expect(d.textContent).toContain('Go2-A');
    expect($('textarea, input[aria-label="메모"]', d)).toBeTruthy();
    expect(d.textContent).toContain('10 초 전');
    expect(d.textContent).toContain('5 초 뒤');
  });
  WAIT('남기기 → 고른 로봇 · 메모를 서버에 한 번 보냄, 취소면 안 보냄', async () => {
    serve();
    await open();
    await click(btn('지금 남기기'));
    await click(btn('취소'));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await click(btn('지금 남기기'));
    const d = $('[role="dialog"][aria-label="지금 남기기"]')!, memo = $<HTMLInputElement>('input[aria-label="메모"], textarea', d)!;
    act(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(memo), 'value')!.set!.call(memo, '밸브 주변 물 고임'); memo.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(btn('남기기', d));
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ robot_id: 'r-a', note: '밸브 주변 물 고임' });
  });
});

describe('계약 기다림: 클립 칸(U8-03 · U8-10)', () => {
  WAIT('클립 있는 사건 = 썸네일 + 길이, 없는 사건 = «기록만»', async () => {
    serve({ 'GET /events': list([ev('1', { data: { clip: CLIP } }), ev('2', { severity: 'INFO', category: 'RUN', code: 'RUN_DONE' })]) });
    await open();
    expect($('[data-clip]', rows()[0])).toBeTruthy();
    expect(rows()[0].textContent).toContain('19.6초');
    expect($('[data-clip]', rows()[1])).toBeNull();
    expect(rows()[1].textContent).toContain('기록만');
  });
  WAIT('「클립 있는 것만」 거르기', async () => {
    serve();
    await open();
    expect($('[aria-label="클립 있는 것만"]')).toBeTruthy();
  });
});

describe('계약 기다림: 재현 재생기(U8-08 · U8-09)', () => {
  const openClip = async () => {
    serve({ 'GET /events': list([ev('1', { data: { clip: CLIP } })]), 'GET /events/1': { status: 200, body: ev('1', { data: { clip: CLIP } }) } });
    await open();
    await click($('[data-clip]', rows()[0]));
    return $<HTMLVideoElement>('video')!;
  };
  WAIT('클립을 누르면 재생기: 영상 + 배속 0.25 · 0.5 · 1 · 2 + 반복', async () => {
    const v = await openClip();
    expect(v).toBeTruthy();
    expect(v.getAttribute('src')).toBe(CLIP.url);
    const speeds = card('재생 속도');
    expect([...speeds.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['0.25배', '0.5배', '1배', '2배']);
    expect(btn('1배', speeds)!.getAttribute('aria-pressed')).toBe('true');
  });
  WAIT('배속을 누르면 영상 playbackRate 가 그 값, 눌린 단추 하나', async () => {
    const v = await openClip(), speeds = card('재생 속도');
    for (const [name, rate] of [['0.25배', 0.25], ['0.5배', 0.5], ['2배', 2], ['1배', 1]] as const) {
      await click(btn(name, speeds));
      expect(v.playbackRate).toBe(rate);
      expect([...speeds.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent)).toEqual([name]);
    }
  });
  WAIT('반복 단추 = 영상 loop 켜고 끔', async () => {
    const v = await openClip(), rep = btn('반복')!;
    expect(v.loop).toBe(false);
    await click(rep);
    expect(v.loop).toBe(true);
    expect(rep.getAttribute('aria-pressed')).toBe('true');
    await click(rep);
    expect(v.loop).toBe(false);
  });
  WAIT('사건 기준 시각 막대: -10 초 ~ 사건 0 초 ~ 끝', async () => {
    await openClip();
    const bar = card('사건 기준 시각');
    expect(bar.textContent).toContain('-10');
    expect(bar.textContent).toContain('0');
  });
});

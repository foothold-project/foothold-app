// 기록 탭 u8(U8-03 · U8-09 · U8-10 · U8-11). 등급 거르기는 지금 받는 자료(severity)와 서버 매개변수만으로 동작한다.
// 「지금 장면 저장」(u8_8) · 클립 칸 · 재현 재생기(u8_2)는 기록 계약(05 §8.1)을 따른다: event.data.clip 은 «클립을 원했나» 참 · 거짓이고,
// 영상은 /robots/{id}/records/clips 의 EventClip 으로만 받는다. 서버가 아직 501(…_NOT_BUILT)이면 그 까닭을 한 줄로 보이고 받은 척하지 않는다.
// 서버 거르기가 없는 «클립 있는 것만» 은 잠근 칸 + 까닭 한 줄(data-missing), 서버가 생기면 WAIT 를 it 로.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event as Ev, RobotSummary, User } from '../../../contracts/ts';
import { Root } from '../session';
import { MarkModal } from '../screens/historyu8';
import type { HistoryCtx } from '../screens/history';
import { took } from '../screens/runreport';
import type { Robot } from '../fake';

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
const rows = () => [...card('사건').querySelectorAll<HTMLElement>('.ev')];

describe('등급 거르기(U8-10 중 지금 자료로 되는 것)', () => {
  it('줄 등급 칸: ERROR = 위험 · WARN = 주의 · INFO = 정보(옅은 칸), INFO 로 저장된 실패 코드는 주의', async () => {
    serve({ 'GET /events': list([ev('1'), ev('2', { severity: 'WARN' }), ev('3', { severity: 'INFO', code: 'RUN_DONE' }), ev('4', { severity: 'INFO', code: 'STOP_CONFIRM_FAILED' }), ev('5', { severity: 'INFO', code: 'PHONE_LEASE_TIMEOUT' })]) });
    await open();
    const pills = rows().map((r) => r.querySelector('[data-lv]')!);
    expect(pills.map((x) => x.textContent)).toEqual(['위험', '주의', '정보', '주의', '주의']);
    expect(pills.map((x) => x.getAttribute('data-lv'))).toEqual(['r', 'w', 'i', 'w', 'w']);
  });
  it('등급 단추 위험 · 주의 · 정보(u8_1 세 칸) → severity 요청 매개변수, 묶음과 함께, 고른 칸을 다시 누르면 뺌', async () => {
    serve({ 'GET /events': list([ev('1', { severity: 'INFO', message: '서버가 준 행' })]) });
    await open();
    const g = card('등급');
    expect([...g.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['위험', '주의', '정보']);
    expect([...g.querySelectorAll('button')].every((b) => b.classList.contains('on'))).toBe(true);   // 아무것도 안 고름 = 셋 다 켜짐
    for (const [name, code] of [['위험', 'ERROR'], ['주의', 'WARN'], ['정보', 'INFO']]) {
      await click(btn(name, g));
      expect(lastQuery()).toEqual({ severity: code });
      expect(btn(name, g)!.getAttribute('aria-pressed')).toBe('true');
      expect(rows()[0].textContent).toContain('서버가 준 행');   // 화면이 따로 거르지 않음
    }
    await click(btn('안전', card('묶음')));
    expect(lastQuery()).toEqual({ category: 'SAFETY', severity: 'INFO' });
    expect([...g.querySelectorAll('button')].map((b) => b.classList.contains('on'))).toEqual([false, false, true]);
    await click(btn('정보', g));
    expect(lastQuery()).toEqual({ category: 'SAFETY' });
    expect(btn('정보', g)!.getAttribute('aria-pressed')).toBe('false');
  });
  it('등급을 고르면 빈 목록 문구는 «조건에 맞는 기록이 없습니다»', async () => {
    serve({ 'GET /events': list([ev('1')]) });
    await open();
    serve();
    await click(btn('위험', card('등급')));
    expect(box.textContent).toContain('조건에 맞는 기록이 없습니다.');
    expect($('[data-empty="log"]')).toBeNull();   // 필터가 있으면 u11_8 빈 기록 그림이 아님
  });
  it('주의를 고르면 정보로 저장된 실패 기록은 정보에 있다고 알림(줄 표시 주의와 서버 등급이 다른 경우)', async () => {
    serve({ 'GET /events': list([ev('1')]) });
    await open();
    expect($('[data-grade-note]')).toBeNull();
    await click(btn('주의', card('등급')));
    expect($('[data-grade-note]')!.textContent).toContain('정보');
    await click(btn('정보', card('등급')));
    expect($('[data-grade-note]')).toBeNull();
  });
  it('내보내기 창도 지금 등급 그대로', async () => {
    serve({ 'GET /events': list([ev('1')]), 'GET /events/export.csv': { status: 200, body: 'a,b' } });
    URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await open();
    await click(btn('주의', card('등급')));
    await click($('#n-export'));
    expect([...card('내보낼 등급').querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent)).toEqual(['주의']);
    await click(btn('내보내기', card('기록 내보내기')));
    const d = new Date(), w = new Date(); w.setDate(d.getDate() - 6);   // 기간을 안 골랐으면 창이 채운 최근 7 일(시안 u8_6)
    expect(Object.fromEntries(sent('GET', '/events/export.csv')[0].q)).toEqual({ severity: 'WARN', from: new Date(`${w.toLocaleDateString('sv')}T00:00:00`).toISOString(), to: new Date(`${d.toLocaleDateString('sv')}T23:59:59.999`).toISOString() });
  });
});

describe('기간 빠른 단추(오늘 · 7 일 · 30 일)', () => {
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const back = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
  const range = (a: string, b: string) => ({ from: new Date(`${a}T00:00:00`).toISOString(), to: new Date(`${b}T23:59:59.999`).toISOString() });
  it('누르면 오늘 포함 n 일 = 현지 0 시 ~ 오늘 끝, 필터 줄에 그 기간 칩, 눌린 단추 하나', async () => {
    serve({ 'GET /events': list([ev('1')]) });
    await open();
    const g = card('기간');
    expect([...g.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['오늘', '7 일', '30 일']);
    for (const [name, n] of [['오늘', 0], ['7 일', 6], ['30 일', 29]] as const) {
      await click(btn(name, g));
      expect(lastQuery()).toEqual(range(back(n), back(0)));
      expect($(`[data-hs-sum] button[aria-label="${name} 거르기 풀기"]`)).not.toBeNull();
      expect([...g.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent)).toEqual([name]);
    }
  });
  it('등급과 함께 요청, 기간 칩을 누르면 기간만 풀림', async () => {
    serve({ 'GET /events': list([ev('1')]) });
    await open();
    await click(btn('7 일', card('기간')));
    await click(btn('주의', card('등급')));
    expect(lastQuery()).toEqual({ severity: 'WARN', ...range(back(6), back(0)) });
    await click($('[data-hs-sum] button[aria-label="7 일 거르기 풀기"]'));
    expect(card('기간').querySelector('button[aria-pressed="true"]')).toBeNull();
    expect(lastQuery()).toEqual({ severity: 'WARN' });
  });
});

describe('필터 줄(u8_3): 칩 · 모두 풀기 · 건수', () => {
  it('필터 없음 · 사건 n 건 → 고른 것마다 칩, 칩 하나 풀기 · 「필터 모두 풀기」 = 처음 요청과 같음', async () => {
    serve({ 'GET /events': { status: 200, body: { items: [ev('2'), ev('1')], next_cursor: 'c1' } } });
    await open();
    const sum = () => $('[data-hs-sum]')!;
    expect(sum().textContent).toContain('필터 없음');
    expect($('[data-count]')!.textContent).toBe('사건 2 건 이상');   // 전체 수는 서버가 주지 않음: 받은 수 + 더 있으면 «이상»
    await click(btn('안전', card('묶음')));
    await click(btn('위험', card('등급')));
    await setRobot('r-a');
    await click(btn('오늘', card('기간')));
    expect([...sum().querySelectorAll('button.chip')].map((b) => b.getAttribute('aria-label'))).toEqual(['안전 거르기 풀기', '위험 거르기 풀기', 'Go2-A 거르기 풀기', '오늘 거르기 풀기']);
    expect($('[data-count]')!.textContent).toBe('맞는 사건 2 건 이상');
    await click($('[aria-label="위험 거르기 풀기"]'));
    expect(lastQuery()).not.toHaveProperty('severity');
    expect(lastQuery()).toHaveProperty('category', 'SAFETY');
    await click($('#n-clear'));
    expect(lastQuery()).toEqual({});
    expect(sum().textContent).toContain('필터 없음');
    expect(card('기간').querySelector('[aria-pressed="true"]')).toBeNull();
    expect($<HTMLSelectElement>('select[aria-label="로봇"]')!.value).toBe('');
  });
  it('서버에 없는 거르기는 잠근 칸 + 까닭(찾기 · 실제/모의 · 클립 있는 것만 · 모드 전환 · 보관 기간)', async () => {
    serve({ 'GET /events': list([ev('1')]) });
    await open();
    expect($<HTMLInputElement>('[data-missing="search"] input')!.disabled).toBe(true);
    for (const k of ['sim-filter', 'clip-filter', 'mode']) expect($(`[data-missing="${k}"]`)!.getAttribute('aria-disabled')).toBe('true');
    expect($('[data-missing="mode"]')!.textContent).toContain('서버에 없음');
    expect($('[data-keep]')!.textContent).toContain('서버가 보관 일수를 주지 않아');
  });
});

/** 서버 거르기가 아직 없는 시험. 서버 매개변수가 생기면 it 로 바꾼다 */
const WAIT = it.fails;
const T0 = Date.parse(NOW), iso = (ms: number) => new Date(T0 + ms).toISOString();
const MARK = ev('9', { category: 'RUN', code: 'RECORD_MARKED', severity: 'WARN', user_id: LEE.id, data: { note: '밸브 주변 물 고임', clip: true } });
const clipOf = (p: Record<string, unknown> = {}) => ({ clip_id: 'c1', event_id: '1', robot_id: 'r-a', start_at: iso(-10_000), end_at: iso(5_000), status: 'READY', url: '/media/c1.mp4', reason: null, ...p });
const NOT_BUILT = (code: string, message: string) => ({ status: 501, body: { error: { code, message, detail: {} } } });
const CLIPS_501 = NOT_BUILT('CLIP_PIPELINE_NOT_BUILT', '사건 영상 만들기는 아직 서버에 없습니다.');
const JOINT_501 = NOT_BUILT('JOINT_LOG_NOT_BUILT', '관절 기록 재생은 아직 서버에 없습니다.');
const MARK_PATH = '/robots/r-a/records/mark-now';
const dialog = () => $('[role="dialog"][aria-label="지금 장면 저장"]')!;
const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
});
const setRobot = async (id: string) => { const s = $<HTMLSelectElement>('select[aria-label="로봇"]')!; act(() => { s.value = id; s.dispatchEvent(new Event('change', { bubbles: true })); }); await flush(); };
const opener = () => btn('지금 장면 저장')!;
const withRow = (more: Record<string, { status: number; body?: unknown }> = {}) => serve({ 'GET /events': list([ev('1')]), ...more });

describe('「지금 장면 저장」(u8_8 · U8-11 · 계약 RecordMarkRequest)', () => {
  it('목록 머리 단추 → 로봇 · 메모(200 자) · 남는 범위(10 초 전 ~ 5 초 뒤) 창, 서버 값(ERROR · WARN · INFO)은 안 보임', async () => {
    withRow();
    await open();
    await click(opener());
    const d = dialog();
    expect(d).toBeTruthy();
    expect([...$('[aria-label="로봇"]', d)!.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent)).toEqual([expect.stringMatching(/^Go2-A · /)]);
    expect($<HTMLInputElement>('input[aria-label="메모"]', d)!.maxLength).toBe(200);
    expect(d.textContent).toContain('10 초 전');
    expect(d.textContent).toContain('5 초 뒤');
    expect(d.textContent).not.toMatch(/ERROR|WARN|INFO/);
  });
  it('취소면 안 보냄 · 남기기 = 고른 로봇 경로로 한 번(두 번 눌러도 한 번), 몸 = 주의 · 클립 원함 · 메모', async () => {
    withRow({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: MARK, clip: clipOf({ clip_id: null, event_id: '9', status: 'NOT_BUILT', url: null, reason: 'CLIP_PIPELINE_NOT_BUILT' }) } } });
    await open();
    await click(opener());
    await click(btn('취소', dialog()));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect($('[role="dialog"]')).toBeNull();
    await click(opener());
    type($<HTMLInputElement>('input[aria-label="메모"]', dialog())!, '  밸브 주변 물 고임 ');
    const send = btn('남기기', dialog())!;
    act(() => { send.click(); send.click(); });
    await flush();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([MARK_PATH]);
    expect(sent('POST', MARK_PATH)[0].body).toEqual({ severity: 'WARN', note: '밸브 주변 물 고임', clip: true });
  });
  it('결과를 그대로: 클립 NOT_BUILT 면 까닭 한 줄(«클립 준비됨» 아님), 창은 닫히고 목록을 다시 받음', async () => {
    withRow({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: MARK, clip: clipOf({ clip_id: null, event_id: '9', status: 'NOT_BUILT', url: null, reason: 'CLIP_PIPELINE_NOT_BUILT' }) } } });
    await open();
    const before = sent('GET', '/events').length;
    await click(opener());
    await click(btn('남기기', dialog()));
    expect($('[role="dialog"]')).toBeNull();
    const out = $('[data-mark-out]')!;
    expect(out.textContent).toContain('지금 장면을 남겼습니다');
    expect(out.textContent).toContain('사건 영상 만들기는 아직 서버에 없습니다.');
    expect(out.textContent).not.toContain('클립이 준비됐습니다');
    expect(sent('GET', '/events').length).toBe(before + 1);
    await click(btn('닫기', out));
    expect($('[data-mark-out]')).toBeNull();
  });
  it('클립 null → «영상 없이 기록만», 서버 거절(400)은 서버 문장 · 창은 그대로 · 다시 누를 수 있음', async () => {
    withRow({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: { ...MARK, data: { note: null, clip: false } }, clip: null } } });
    await open();
    await click(opener());
    await click(btn('남기기', dialog()));
    expect($('[data-mark-out]')!.textContent).toContain('영상 없이 기록만 남겼습니다');
    withRow({ [`POST ${MARK_PATH}`]: { status: 400, body: { error: { code: 'VALIDATION', message: '메모가 너무 깁니다.', detail: {} } } } });
    await click(opener());
    await click(btn('남기기', dialog()));
    expect($('[role="alert"]', dialog())!.textContent).toContain('메모가 너무 깁니다.');
    expect(btn('남기기', dialog())!.disabled).toBe(false);
  });
  it('내 로봇이 없으면(로봇 0대) 단추 잠김 + 까닭', async () => {
    serve({ 'GET /robots': { status: 200, body: { items: [], next_cursor: null } }, 'GET /events': list([ev('1')]) });
    await open();
    expect(opener().disabled).toBe(true);
    expect(opener().title).toBe('남길 로봇이 없습니다');
  });
});

describe('「지금 장면 저장」 초점 · 기본 로봇(reviewer N3 · V11)', () => {
  it('열면 초점이 창 첫 칸(로봇)으로, 취소 · Esc 로 닫으면 「지금 장면 저장」 단추로 돌아옴', async () => {
    withRow();
    await open();
    act(() => opener().focus());
    await click(opener());
    expect(document.activeElement).toBe($('[aria-label="로봇"] button', dialog()));
    await click(btn('취소', dialog()));
    expect($('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener());
    await click(opener());
    act(() => { $('input[aria-label="메모"]', dialog())!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await flush();
    expect($('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener());
  });
  it('남긴 뒤 창이 닫히면 초점은 「지금 장면 저장」 단추로', async () => {
    withRow({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: MARK, clip: null } } });
    await open();
    act(() => opener().focus());
    await click(opener());
    await click(btn('남기기', dialog()));
    expect($('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener());
  });
  it('V11: 로봇 칸 기본값 = 지금 보던 로봇(내 로봇일 때), 아니면 내 로봇 첫째', async () => {
    const r = (id: string, name: string, owner = 'o1') => ({ id, name, owner, battery: null, online: true, seenAt: '', status: null }) as unknown as Robot;
    const A = r('r-a', 'Go2-A'), B = r('r-b', 'Go2-B'), X = r('r-x', 'Go2-X', 'someone');
    const me = { id: 'o1', name: '이운영', role: 'OPERATOR' } as unknown as HistoryCtx['user'];
    const pick = async (robot?: Robot) => {
      act(() => { root?.unmount(); }); box?.remove();
      box = document.createElement('div'); document.body.append(box);
      const c = { user: me, robots: [A, B, X], robot, go() {}, phone: false, cancel: new AbortController().signal, focus: null } as unknown as HistoryCtx;
      act(() => { root = createRoot(box); root.render(<div className="proto"><MarkModal c={c} close={() => {}} done={() => {}} /></div>); });
      await flush();
      return [...$('[aria-label="로봇"]', dialog())!.querySelectorAll('button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent!.split(' · ')[0]);
    };
    expect(await pick(B)).toEqual(['Go2-B']);
    expect(await pick(A)).toEqual(['Go2-A']);
    serve({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: MARK, clip: null } } });
    expect(await pick(X)).toEqual(['Go2-A']);   // 남의 로봇을 보던 중이면 내 로봇 첫째
    expect([...$('[aria-label="로봇"]', dialog())!.querySelectorAll('button')].map((b) => b.textContent!.split(' · ')[0])).toEqual(['Go2-A', 'Go2-B']);   // 남의 로봇은 칸에 없음
    await click(btn('남기기', dialog()));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([MARK_PATH]);   // 칸에 보인 로봇으로 보냄(남의 로봇 경로 아님)
    expect(await pick(undefined)).toEqual(['Go2-A']);
  });
});

describe('클립 칸(N1: data.clip 은 참 · 거짓, 영상은 EventClip 경로로)', () => {
  it('data.clip === true 만 클립 칸(재생 표시), 아니면 까닭 글(정보 단계 · 안 남김), 누르기 전에는 /records 안 부름', async () => {
    serve({ 'GET /events': list([ev('1', { data: { clip: true } }), ev('2', { severity: 'INFO', category: 'RUN', code: 'RUN_DONE' }), ev('3', { data: { clip: false } }), ev('4', { data: { clip: { url: '/x.mp4', duration_s: 19.6 } } })]) });
    await open();
    expect(rows().map((r) => r.querySelector('[data-clip-cell]')!.getAttribute('data-clip-cell'))).toEqual(['yes', 'no', 'no', 'no']);
    expect(rows().map((r) => r.querySelector('[data-clip-cell]')!.textContent)).toEqual(['', '정보 단계', '안 남김', '클립 없음']);
    expect(calls.some((c) => c.path.includes('/records/'))).toBe(false);
  });
  it('누르면 사건 자세히(u8_2): 클립 목록 · 관절 기록을 부르고, 501 이면 서버 까닭 한 줄씩 · 영상 · 재현은 없음 · 재생기 잠김', async () => {
    serve({ 'GET /events': list([ev('1', { data: { clip: true } })]), 'GET /robots/r-a/records/clips': CLIPS_501, 'GET /robots/r-a/records/events/1/joint-log': JOINT_501 });
    await open();
    await click(rows()[0]);
    expect(sent('GET', '/robots/r-a/records/clips')).toHaveLength(1);
    expect(sent('GET', '/robots/r-a/records/events/1/joint-log')).toHaveLength(1);
    expect($('[data-clip-why]')!.textContent).toContain('사건 영상 만들기는 아직 서버에 없습니다.');
    expect($('[data-joint-why]')!.textContent).toContain('관절 기록 재생은 아직 서버에 없습니다.');
    expect($('video')).toBeNull();
    expect($('[data-joint]')).toBeNull();
    expect($('[data-trp]')!.getAttribute('aria-disabled')).toBe('true');
    expect($<HTMLButtonElement>('[data-trp] .pp')!.disabled).toBe(true);
  });
  it('목록에 이 사건 클립이 없거나 NOT_BUILT · FAILED 면 영상 없이 까닭(url 이 와도 READY 가 아니면 틀지 않음)', async () => {
    for (const [items, said] of [[[], '이 사건의 클립이 아직 없습니다'], [[clipOf({ status: 'FAILED', reason: 'ENCODE_FAILED' })], '클립을 만들지 못했습니다'], [[clipOf({ clip_id: null, status: 'NOT_BUILT', url: null, reason: 'CLIP_PIPELINE_NOT_BUILT' })], '사건 영상 만들기는 아직 서버에 없습니다.']] as const) {
      serve({ 'GET /events': list([ev('1', { data: { clip: true } })]), 'GET /robots/r-a/records/clips': { status: 200, body: { items, next_cursor: null } }, 'GET /robots/r-a/records/events/1/joint-log': JOINT_501 });
      await open();
      await click(rows()[0]);
      expect($('[data-clip-why]')!.textContent).toContain(said);
      expect($('video')).toBeNull();
      act(() => root?.unmount()); root = null; box.remove();
    }
  });
  it('PENDING 이면 «만드는 중» + 다시 확인 = 그 clip_id 한 건을 다시 받음 → READY 면 영상', async () => {
    serve({ 'GET /events': list([ev('1', { data: { clip: true } })]), 'GET /robots/r-a/records/clips': { status: 200, body: { items: [clipOf({ status: 'PENDING', url: null })], next_cursor: null } },
      'GET /robots/r-a/records/clips/c1': { status: 200, body: clipOf() }, 'GET /robots/r-a/records/events/1/joint-log': JOINT_501 });
    await open();
    await click(rows()[0]);
    expect($('[data-clip-why]')!.textContent).toContain('만드는 중');
    await click(btn('다시 확인'));
    expect(sent('GET', '/robots/r-a/records/clips/c1')).toHaveLength(1);
    expect($('video')!.getAttribute('src')).toBe('/media/c1.mp4');
  });
  WAIT('「클립 있는 것만」 거르기(서버 /events 매개변수 없음)', async () => {
    serve({ 'GET /events': list([ev('1')]) });
    await open();
    expect($('[data-missing="clip-filter"]')!.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('재현 재생기(u8_2 · U8-08 · U8-09: READY 클립)', () => {
  const openClip = async (clip = clipOf(), joint: { status: number; body?: unknown } = JOINT_501) => {
    serve({ 'GET /events': list([ev('1', { data: { clip: true } })]), 'GET /robots/r-a/records/clips': { status: 200, body: { items: [clipOf({ event_id: '0', clip_id: 'c0' }), clip], next_cursor: null } },
      'GET /robots/r-a/records/events/1/joint-log': joint });
    await open();
    await click(rows()[0]);
    return $<HTMLVideoElement>('video')!;
  };
  it('영상 = 이 사건(event_id) 클립의 url + 배속 0.25 · 0.5 · 1 · 2(기본 1) + 반복(기본 켬, 시안 u8_2)', async () => {
    const v = await openClip();
    expect(v.getAttribute('src')).toBe('/media/c1.mp4');
    const speeds = card('재생 속도');
    expect([...speeds.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['0.25 배', '0.5 배', '1 배', '2 배']);
    expect(btn('1 배', speeds)!.getAttribute('aria-pressed')).toBe('true');
    expect(v.loop).toBe(true);
  });
  it('배속을 누르면 영상 playbackRate 가 그 값, 눌린 단추 하나', async () => {
    const v = await openClip(), speeds = card('재생 속도');
    for (const [name, rate] of [['0.25 배', 0.25], ['0.5 배', 0.5], ['2 배', 2], ['1 배', 1]] as const) {
      await click(btn(name, speeds));
      expect(v.playbackRate).toBe(rate);
      expect([...speeds.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent)).toEqual([name]);
    }
  });
  it('반복 단추 = 영상 loop 끄고 켬', async () => {
    const v = await openClip(), rep = btn('반복')!;
    expect(v.loop).toBe(true);
    await click(rep);
    expect(v.loop).toBe(false);
    expect(rep.getAttribute('aria-pressed')).toBe('false');
    await click(rep);
    expect(v.loop).toBe(true);
  });
  it('사건 기준 시각 막대: 5 초 눈금 −10 · −5 · 0 · +5, 넘어짐(end_at null)은 «일어설 때까지»', async () => {
    await openClip();
    expect([...$('[data-trp]')!.querySelectorAll('[data-tick]')].map((x) => x.textContent)).toEqual(['−10 초', '−5 초', '0 초', '+5 초']);
    expect($('[data-trp]')!.textContent).toContain('사건');
    act(() => root?.unmount()); root = null; box.remove();
    serve({ 'GET /events': list([ev('1', { data: { clip: true } })]), 'GET /robots/r-a/records/clips': { status: 200, body: { items: [clipOf({ end_at: null, status: 'PENDING', url: null })], next_cursor: null } }, 'GET /robots/r-a/records/events/1/joint-log': JOINT_501 });
    await open();
    await click(rows()[0]);
    expect($('[data-trp]')!.textContent).toContain('일어설 때까지');
  });
  it('관절 기록이 오면 받은 그대로(관절 수 · 프레임 · Hz), 501 이면 까닭만', async () => {
    const frame = { t: 0, q: Array(12).fill(0), base: { xyz: [0, 0, 0.3], wxyz: [1, 0, 0, 0] }, gait: null };
    await openClip(clipOf(), { status: 200, body: { event_id: '1', robot_id: 'r-a', start_at: iso(-10_000), joint_names: Array(12).fill('FR_hip_joint'), rate_hz: 50, frames: [frame, { ...frame, t: 0.02 }] } });
    expect($('[data-joint]')!.textContent).toContain('관절 12 개 · 2 프레임 · 50 Hz');
    expect($('[data-joint-why]')).toBeNull();
  });
});

describe('실행 기록 보기(u15_3 중 실제 값만 · 예상은 서버에 없음)', () => {
  const RUN = 'run-1', S0 = T0 - 31 * 60_000;
  const t = (min: number) => new Date(S0 + min * 60_000).toISOString();
  const HIST = { id: RUN, scenario_version_id: 'sv1', floor_id: 'f1', map_version_id: 'm1', scenario_name: '공정 순찰 A', floor_name: '1층', scenario_name_snapshot: null, floor_name_snapshot: null,
    status: 'COMPLETED', started_at: t(0), ended_at: t(31) };
  const wp = (id: string, code: string, min: number, data: Record<string, unknown>) => ev(id, { at: t(min), category: 'RUN', code, severity: 'INFO', run_id: RUN, message: `${code} ${id}`, data });
  const RUN_EVENTS = [
    wp('31', 'RUN_WAYPOINT_ARRIVED', 4, { idx: 0, mission_name: '펌프실 앞' }),
    wp('32', 'RUN_WAYPOINT_RECORDED', 5, { idx: 0, mission_name: '펌프실 앞', results: { mode: 'EXECUTED', steps: [{ step_idx: 0, action: 'PHOTO', status: 'SUCCEEDED', failure_code: null, failure_reason: null }] } }),
    wp('33', 'RUN_WAYPOINT_ARRIVED', 12, { idx: 1, mission_name: '압력 G-14' }),
    wp('34', 'RUN_WAYPOINT_RECORDED', 13, { idx: 1, mission_name: '압력 G-14', results: { mode: 'EXECUTED', steps: [
      { step_idx: 0, action: 'PHOTO', status: 'FAILED', failure_code: 'NO_FRESH_FRAME', failure_reason: '카메라 새 화면이 없습니다.' }, { step_idx: 1, action: 'WAIT', status: 'SUCCEEDED', failure_code: null, failure_reason: null }] } }),
    wp('35', 'RUN_WAYPOINT_ARRIVED', 20, { idx: 2, mission_name: '관제실' }),
  ].reverse();   // 서버는 새것부터
  const ROW = wp('39', 'RUN_DONE', 31, {});
  const report = () => $('[role="dialog"][aria-label="실행 기록"]');   // 시안 u15_3 임무 보고서 창(.md)
  const openRun = async (more: Record<string, { status: number; body?: unknown }> = {}) => {
    serve({ 'GET /events': list([ROW, ev('2', { severity: 'INFO', category: 'RUN', code: 'RUN_DONE' })]) });   // 기록 탭 목록은 그대로, 누른 뒤의 답만 바꿈
    await open();
    calls.length = 0;
    serve({ 'GET /events': list(RUN_EVENTS), [`GET /runs/${RUN}/history`]: { status: 200, body: HIST }, ...more });
    await click(rows()[0]);
    await click($('[data-run]'));
  };
  it('run_id 있는 사건 자세히에만 「실행 기록 보기」, 누르기 전에는 부르지 않음', async () => {
    serve({ 'GET /events': list([ROW, ev('2', { severity: 'INFO', category: 'RUN', code: 'RUN_DONE' })]) });
    await open();
    await click(rows()[1]);
    expect($('[data-run]')).toBeNull();
    await click($('[data-sev="39"]'));
    expect($('[data-run]')).not.toBeNull();
    expect(calls.some((c) => c.path.startsWith('/runs/'))).toBe(false);
  });
  it('누르면 실행 한 건 + 그 실행의 사건(run_id 거르기)을 받아 시나리오 · 층 · 상태 · 시작 ~ 끝 · 걸린 시간', async () => {
    await openRun();
    expect(sent('GET', `/runs/${RUN}/history`)).toHaveLength(1);
    expect(lastQuery()).toEqual({ run_id: RUN });
    const r = report()!;
    expect(r.textContent).toContain('공정 순찰 A');
    expect(r.textContent).toContain('1층');
    expect($('[data-run-status]', r)!.textContent).toBe('완료');
    expect($('[data-run-took]', r)!.textContent).toBe('31 분예상 서버에 값 없음');   // 실제(예상은 서버 빈칸)
    expect(r.querySelector('h2')!.textContent).toBe('임무 보고서 · 공정 순찰 A');
  });
  it('예상 칸은 수 없이 비움(「서버에 값 없음」 · 표의 예상 · 차이는 「없음」)', async () => {
    await openRun();
    expect($('[data-run-took]', report()!)!.textContent).toContain('예상 서버에 값 없음');
    const trs = [...report()!.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(trs.every((x) => x[2] === '없음' && x[4] === '없음')).toBe(true);
  });
  it('지점마다 도착 시각 순서 · 구간 걸린 시간(이전 도착 또는 시작부터) · 단계 결과(실패 까닭), 결과 기록이 없으면 그렇게', async () => {
    await openRun();
    const trs = [...report()!.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(trs.map((x) => [x[0], x[1]])).toEqual([['펌프실 앞', '지점 1'], ['압력 G-14', '지점 2'], ['관제실', '지점 3']]);   // 시안 열: 작업 · 장소 · 예상 · 실제 · 차이 · 까닭
    expect(trs.map((x) => x[3])).toEqual(['4 분 0 초', '8 분 0 초', '8 분 0 초']);
    expect(trs[0][5]).toBe('단계 1 개 마침');
    expect(trs[1][5]).toBe('단계 2 개 중 1 개 실패 · 카메라 새 화면이 없습니다.');
    expect(trs[2][5]).toBe('결과 기록 없음');
  });
  it('걸린 시간 글: 한 시간 아래 «분 초», 넘으면 «시간 분»', () => {
    expect([took(0), took(59_400), took(31 * 60_000), took(3_725_000), took(-5)]).toEqual(['0 분 0 초', '0 분 59 초', '31 분 0 초', '1 시간 2 분', '0 분 0 초']);
  });
  it('같은 지점 도착이 또 오면 먼저 온 시각 · 지점은 번호 순(늦게 온 앞 번호도 제자리), 머리 칸은 보임', async () => {
    const again = wp('36', 'RUN_WAYPOINT_ARRIVED', 6, { idx: 0, mission_name: '펌프실 앞' });
    await openRun({ 'GET /events': list([again, ...RUN_EVENTS]) });
    const first = [...report()!.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent))[0];
    expect(first[3]).toBe('4 분 0 초');
    expect($('[data-run-status]', report()!)!.closest('[hidden]')).toBeNull();
    act(() => root?.unmount()); root = null; box.remove();
    await openRun({ 'GET /events': list([wp('41', 'RUN_WAYPOINT_ARRIVED', 6, { idx: 0, mission_name: '가' }), wp('42', 'RUN_WAYPOINT_ARRIVED', 3, { idx: 1, mission_name: '나' })]) });
    expect([...report()!.querySelectorAll('tbody tr')].map((tr) => tr.children[1].textContent)).toEqual(['지점 1', '지점 2']);
  });
  it('끝나지 않은 실행은 «끝나지 않음», 걸린 시간 없음', async () => {
    await openRun({ [`GET /runs/${RUN}/history`]: { status: 200, body: { ...HIST, status: 'PAUSED', ended_at: null } } });
    expect($('[data-run-status]', report()!)!.textContent).toBe('일시정지');
    expect(report()!.textContent).toContain('끝나지 않음');
    expect($('[data-run-took]', report()!)!.textContent).toBe('끝나지 않음예상 서버에 값 없음');   // 걸린 시간 수 없음
  });
  it('실행을 못 받으면 서버 문장, 사건만 못 받으면 머리는 그대로 + 까닭 · 다시 시도', async () => {
    await openRun({ [`GET /runs/${RUN}/history`]: { status: 404, body: { error: { code: 'NOT_FOUND', message: '실행을 찾을 수 없습니다.', detail: {} } } } });
    expect(report()!.textContent).toContain('실행을 찾을 수 없습니다.');
    act(() => root?.unmount()); root = null; box.remove();
    await openRun({ 'GET /events': { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: '잠시 뒤 다시 시도하세요.', detail: {} } } } });
    expect(report()!.textContent).toContain('공정 순찰 A');
    expect($('[data-run-why]', report()!)!.textContent).toContain('잠시 뒤 다시 시도하세요.');
    serve({ 'GET /events': list(RUN_EVENTS), [`GET /runs/${RUN}/history`]: { status: 200, body: HIST } });
    await click(btn('다시 시도', report()!));
    expect(report()!.querySelectorAll('tbody tr')).toHaveLength(3);
  });
  it('내보내기 = 이 실행의 사건 CSV(run_id) · 결과 줄', async () => {
    URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await openRun({ 'GET /events/export.csv': { status: 200, body: 'id\n' } });
    await click($('[data-run-export]', report()!));
    expect(Object.fromEntries(sent('GET', '/events/export.csv')[0].q)).toEqual({ run_id: RUN });
    expect($('[data-run-export-note]', report()!)!.textContent).toMatch(/^내려받음 · foothold-기록-실행-/);
  });
  it('닫기 = 보고서 닫고 초점은 누른 「실행 기록 보기」 단추로', async () => {
    await openRun();
    await click($('#go-x', report()!));
    expect(report()).toBeNull();
    expect(document.activeElement).toBe($('[data-run]'));
  });
});

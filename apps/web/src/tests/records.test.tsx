// 기록 탭 u07(U8-03 · U8-09 · U8-10 · U8-11). 등급 거르기는 지금 받는 자료(severity)와 서버 매개변수만으로 동작한다.
// 「지금 남기기」 · 클립 칸 · 재현 재생기는 기록 계약(05 §8.1)을 따른다: event.data.clip 은 «클립을 원했나» 참 · 거짓이고,
// 영상은 /robots/{id}/records/clips 의 EventClip 으로만 받는다. 서버가 아직 501(…_NOT_BUILT)이면 그 까닭을 한 줄로 보이고 받은 척하지 않는다.
// 서버 거르기가 없는 «클립 있는 것만» 은 아직 WAIT(it.fails).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event as Ev, RobotSummary, User } from '../../../contracts/ts';
import { Root } from '../session';
import { MarkNow } from '../screens/records';
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
    expect(box.textContent).toContain('아직 기록이 없습니다');
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

/** 서버 거르기가 아직 없는 시험. 서버 매개변수가 생기면 it 로 바꾼다 */
const WAIT = it.fails;
const T0 = Date.parse(NOW), iso = (ms: number) => new Date(T0 + ms).toISOString();
const MARK = ev('9', { category: 'RUN', code: 'RECORD_MARKED', severity: 'WARN', user_id: LEE.id, data: { note: '밸브 주변 물 고임', clip: true } });
const clipOf = (p: Record<string, unknown> = {}) => ({ clip_id: 'c1', event_id: '1', robot_id: 'r-a', start_at: iso(-10_000), end_at: iso(5_000), status: 'READY', url: '/media/c1.mp4', reason: null, ...p });
const NOT_BUILT = (code: string, message: string) => ({ status: 501, body: { error: { code, message, detail: {} } } });
const CLIPS_501 = NOT_BUILT('CLIP_PIPELINE_NOT_BUILT', '사건 영상 만들기는 아직 서버에 없습니다.');
const JOINT_501 = NOT_BUILT('JOINT_LOG_NOT_BUILT', '관절 기록 재생은 아직 서버에 없습니다.');
const MARK_PATH = '/robots/r-a/records/mark-now';
const dialog = () => $('[role="dialog"][aria-label="지금 남기기"]')!;
const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
});
const clipBox = () => $<HTMLInputElement>('input[type="checkbox"][aria-label="영상 클립 남기기"]', dialog())!;

describe('「지금 남기기」(U8-11 · 계약 RecordMarkRequest)', () => {
  it('기록 탭 단추 → 로봇 · 등급 · 메모(200 자) · 남는 범위(10 초 전 ~ 5 초 뒤) 창, 기본 등급 주의', async () => {
    serve();
    await open();
    await click(btn('지금 남기기'));
    const d = dialog();
    expect(d).toBeTruthy();
    expect($<HTMLSelectElement>('select[aria-label="로봇"]', d)!.selectedOptions[0].textContent).toBe('Go2-A');
    expect($<HTMLTextAreaElement>('textarea[aria-label="메모"]', d)!.maxLength).toBe(200);
    expect(d.textContent).toContain('10 초 전');
    expect(d.textContent).toContain('5 초 뒤');
    expect([...card('남길 등급').querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent)).toEqual(['주의']);
  });
  it('취소면 안 보냄 · 남기기 = 고른 로봇 경로로 한 번(두 번 눌러도 한 번)', async () => {
    serve({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: MARK, clip: clipOf({ clip_id: null, event_id: '9', status: 'NOT_BUILT', url: null, reason: 'CLIP_PIPELINE_NOT_BUILT' }) } } });
    await open();
    await click(btn('지금 남기기'));
    await click(btn('취소', dialog()));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect($('[role="dialog"]')).toBeNull();
    await click(btn('지금 남기기'));
    type($<HTMLTextAreaElement>('textarea[aria-label="메모"]', dialog())!, '  밸브 주변 물 고임 ');
    const send = btn('남기기', dialog())!;
    act(() => { send.click(); send.click(); });
    await flush();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([MARK_PATH]);
    expect(sent('POST', MARK_PATH)[0].body).toEqual({ severity: 'WARN', note: '밸브 주변 물 고임', clip: true });
  });
  it('N2 대응표: 화면은 위험 · 주의 · 정보만, 위험 = ERROR(클립 늘 켬) · 주의 = WARN(고름) · 정보 = INFO(클립 없음)', async () => {
    const table = [['위험', 'ERROR', true, true], ['주의', 'WARN', true, false], ['정보', 'INFO', false, true]] as const;
    serve({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: MARK, clip: null } } });
    await open();
    for (const [name, code, on, locked] of table) {
      await click(btn('지금 남기기'));
      const g = card('남길 등급');
      expect([...g.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['위험', '주의', '정보']);
      await click(btn(name, g));
      expect(clipBox().checked).toBe(on);
      expect(clipBox().disabled).toBe(locked);
      expect(dialog().textContent).not.toMatch(/ERROR|WARN|INFO/);   // 서버 값은 화면에 안 보임
      await click(btn('남기기', dialog()));
      const all = sent('POST', MARK_PATH), body = all[all.length - 1].body;
      // 계약: clip 은 WARN 만 고를 수 있다. 위험 · 정보는 빼서 서버 규칙 기본값(막는 짝 400 을 만들지 않음)
      expect(body).toEqual(code === 'WARN' ? { severity: code, note: null, clip: true } : { severity: code, note: null });
      await click(btn('닫기', dialog()));
    }
    await click(btn('지금 남기기'));
    await click(btn('주의', card('남길 등급')));
    act(() => clipBox().click());
    await click(btn('남기기', dialog()));
    const last = sent('POST', MARK_PATH);
    expect(last[last.length - 1].body).toEqual({ severity: 'WARN', note: null, clip: false });
  });
  it('결과를 그대로: 클립 NOT_BUILT 면 까닭 한 줄, 클립 null 이면 «영상 없이», 남긴 뒤 목록을 다시 받음', async () => {
    serve({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: MARK, clip: clipOf({ clip_id: null, event_id: '9', status: 'NOT_BUILT', url: null, reason: 'CLIP_PIPELINE_NOT_BUILT' }) } } });
    await open();
    const before = sent('GET', '/events').length;
    await click(btn('지금 남기기'));
    await click(btn('남기기', dialog()));
    const out = $('[data-mark-out]', dialog())!;
    expect(out.textContent).toContain('기록을 남겼습니다');
    expect(out.textContent).toContain('사건 영상 만들기는 아직 서버에 없습니다.');
    expect(out.textContent).not.toContain('클립이 준비됐습니다');
    expect(sent('GET', '/events').length).toBe(before + 1);
  });
  it('정보 = 클립 null → «영상 없이 기록만», 서버 거절(400)은 서버 문장 · 창은 그대로', async () => {
    serve({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: { ...MARK, severity: 'INFO', data: { note: null, clip: false } }, clip: null } } });
    await open();
    await click(btn('지금 남기기'));
    await click(btn('정보', card('남길 등급')));
    await click(btn('남기기', dialog()));
    expect($('[data-mark-out]', dialog())!.textContent).toContain('영상 없이 기록만 남겼습니다');
    serve({ [`POST ${MARK_PATH}`]: { status: 400, body: { error: { code: 'VALIDATION', message: '메모가 너무 깁니다.', detail: {} } } } });
    await click(btn('닫기', dialog()));
    await click(btn('지금 남기기'));
    await click(btn('남기기', dialog()));
    expect($('[role="alert"]', dialog())!.textContent).toContain('메모가 너무 깁니다.');
    expect(btn('남기기', dialog())!.disabled).toBe(false);
  });
});

describe('「지금 남기기」 초점 · 기본 로봇(reviewer N3 · V11)', () => {
  const opener = () => btn('지금 남기기')!;
  it('열면 초점이 창 첫 칸(로봇)으로, 취소 · Esc 로 닫으면 「지금 남기기」 단추로 돌아옴', async () => {
    serve();
    await open();
    await click(opener());
    expect(document.activeElement).toBe($('select[aria-label="로봇"]', dialog()));
    await click(btn('취소', dialog()));
    expect($('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener());
    await click(opener());
    act(() => { $('textarea[aria-label="메모"]', dialog())!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await flush();
    expect($('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener());
  });
  it('남긴 뒤에는 초점이 「닫기」 로, 닫으면 「지금 남기기」 단추로', async () => {
    serve({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: MARK, clip: null } } });
    await open();
    await click(opener());
    await click(btn('남기기', dialog()));
    expect(document.activeElement).toBe(btn('닫기', dialog()));
    await click(btn('닫기', dialog()));
    expect(document.activeElement).toBe(opener());
  });
  it('V11: 로봇 칸 기본값 = 지금 보던 로봇(내 로봇일 때), 아니면 내 로봇 첫째', async () => {
    const r = (id: string, name: string, owner = 'o1') => ({ id, name, owner, battery: null, online: true, seenAt: '', status: null }) as unknown as Robot;
    const A = r('r-a', 'Go2-A'), B = r('r-b', 'Go2-B'), X = r('r-x', 'Go2-X', 'someone');
    const me = { id: 'o1', name: '이운영', role: 'OPERATOR' } as unknown as Parameters<typeof MarkNow>[0]['c']['user'];
    const pick = async (robot?: Robot) => {
      act(() => { root?.unmount(); }); box?.remove();
      box = document.createElement('div'); document.body.append(box);
      act(() => { root = createRoot(box); root.render(<MarkNow c={{ user: me, robots: [A, B, X], robot }} done={() => {}} />); });
      await click(btn('지금 남기기'));
      return $<HTMLSelectElement>('select[aria-label="로봇"]')!.value;
    };
    expect(await pick(B)).toBe('r-b');
    expect(await pick(A)).toBe('r-a');
    serve({ [`POST ${MARK_PATH}`]: { status: 201, body: { event: MARK, clip: null } } });
    expect(await pick(X)).toBe('r-a');   // 남의 로봇을 보던 중이면 내 로봇 첫째
    await click(btn('남기기', dialog()));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([MARK_PATH]);   // 칸에 보인 로봇으로 보냄(남의 로봇 경로 아님)
    expect(await pick(undefined)).toBe('r-a');
  });
});

describe('클립 칸(N1: data.clip 은 참 · 거짓, 영상은 EventClip 경로로)', () => {
  it('data.clip === true 만 클립 단추, false 면 «기록만», 값 없음 · 예전 가정 {url} 모양은 클립 칸 없음', async () => {
    serve({ 'GET /events': list([ev('1', { data: { clip: true } }), ev('2', { severity: 'INFO', category: 'RUN', code: 'RUN_DONE' }), ev('3', { data: { clip: false } }), ev('4', { data: { clip: { url: '/x.mp4', duration_s: 19.6 } } })]) });
    await open();
    expect(rows().map((r) => !!$('[data-clip]', r))).toEqual([true, false, false, false]);
    expect(rows().map((r) => r.textContent!.includes('기록만'))).toEqual([false, false, true, false]);
    expect(calls.some((c) => c.path.includes('/records/'))).toBe(false);   // 누르기 전에는 안 부름
  });
  it('누르면 클립 목록 · 관절 기록을 부르고, 501 이면 서버 까닭 한 줄씩 · 영상 · 재현은 없음', async () => {
    serve({ 'GET /events': list([ev('1', { data: { clip: true } })]), 'GET /robots/r-a/records/clips': CLIPS_501, 'GET /robots/r-a/records/events/1/joint-log': JOINT_501 });
    await open();
    await click($('[data-clip]', rows()[0]));
    expect(sent('GET', '/robots/r-a/records/clips')).toHaveLength(1);
    expect(sent('GET', '/robots/r-a/records/events/1/joint-log')).toHaveLength(1);
    expect($('[data-clip-why]')!.textContent).toContain('사건 영상 만들기는 아직 서버에 없습니다.');
    expect($('[data-joint-why]')!.textContent).toContain('관절 기록 재생은 아직 서버에 없습니다.');
    expect($('video')).toBeNull();
    expect($('[data-joint]')).toBeNull();
  });
  it('목록에 이 사건 클립이 없거나 NOT_BUILT · FAILED 면 영상 없이 까닭(url 이 와도 READY 가 아니면 틀지 않음)', async () => {
    for (const [items, said] of [[[], '이 사건의 클립이 아직 없습니다'], [[clipOf({ status: 'FAILED', reason: 'ENCODE_FAILED' })], '클립을 만들지 못했습니다'], [[clipOf({ clip_id: null, status: 'NOT_BUILT', url: null, reason: 'CLIP_PIPELINE_NOT_BUILT' })], '사건 영상 만들기는 아직 서버에 없습니다.']] as const) {
      serve({ 'GET /events': list([ev('1', { data: { clip: true } })]), 'GET /robots/r-a/records/clips': { status: 200, body: { items, next_cursor: null } }, 'GET /robots/r-a/records/events/1/joint-log': JOINT_501 });
      await open();
      await click($('[data-clip]', rows()[0]));
      expect($('[data-clip-why]')!.textContent).toContain(said);
      expect($('video')).toBeNull();
      act(() => root?.unmount()); root = null; box.remove();
    }
  });
  it('PENDING 이면 «만드는 중» + 다시 확인 = 그 clip_id 한 건을 다시 받음 → READY 면 영상', async () => {
    serve({ 'GET /events': list([ev('1', { data: { clip: true } })]), 'GET /robots/r-a/records/clips': { status: 200, body: { items: [clipOf({ status: 'PENDING', url: null })], next_cursor: null } },
      'GET /robots/r-a/records/clips/c1': { status: 200, body: clipOf() }, 'GET /robots/r-a/records/events/1/joint-log': JOINT_501 });
    await open();
    await click($('[data-clip]', rows()[0]));
    expect($('[data-clip-why]')!.textContent).toContain('만드는 중');
    await click(btn('다시 확인'));
    expect(sent('GET', '/robots/r-a/records/clips/c1')).toHaveLength(1);
    expect($('video')!.getAttribute('src')).toBe('/media/c1.mp4');
  });
  WAIT('「클립 있는 것만」 거르기(서버 /events 매개변수 없음)', async () => {
    serve();
    await open();
    expect($('[aria-label="클립 있는 것만"]')).toBeTruthy();
  });
});

describe('재현 재생기(U8-08 · U8-09: READY 클립)', () => {
  const openClip = async (clip = clipOf(), joint: { status: number; body?: unknown } = JOINT_501) => {
    serve({ 'GET /events': list([ev('1', { data: { clip: true } })]), 'GET /robots/r-a/records/clips': { status: 200, body: { items: [clipOf({ event_id: '0', clip_id: 'c0' }), clip], next_cursor: null } },
      'GET /robots/r-a/records/events/1/joint-log': joint });
    await open();
    await click($('[data-clip]', rows()[0]));
    return $<HTMLVideoElement>('video')!;
  };
  it('영상 = 이 사건(event_id) 클립의 url + 배속 0.25 · 0.5 · 1 · 2(기본 1) + 반복', async () => {
    const v = await openClip();
    expect(v.getAttribute('src')).toBe('/media/c1.mp4');
    const speeds = card('재생 속도');
    expect([...speeds.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['0.25배', '0.5배', '1배', '2배']);
    expect(btn('1배', speeds)!.getAttribute('aria-pressed')).toBe('true');
  });
  it('배속을 누르면 영상 playbackRate 가 그 값, 눌린 단추 하나', async () => {
    const v = await openClip(), speeds = card('재생 속도');
    for (const [name, rate] of [['0.25배', 0.25], ['0.5배', 0.5], ['2배', 2], ['1배', 1]] as const) {
      await click(btn(name, speeds));
      expect(v.playbackRate).toBe(rate);
      expect([...speeds.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent)).toEqual([name]);
    }
  });
  it('반복 단추 = 영상 loop 켜고 끔', async () => {
    const v = await openClip(), rep = btn('반복')!;
    expect(v.loop).toBe(false);
    await click(rep);
    expect(v.loop).toBe(true);
    expect(rep.getAttribute('aria-pressed')).toBe('true');
    await click(rep);
    expect(v.loop).toBe(false);
  });
  it('사건 기준 시각 막대: -10 초 · 0 초 · +5 초, 넘어짐(end_at null)은 «일어설 때까지»', async () => {
    await openClip();
    expect([...card('사건 기준 시각').querySelectorAll('[data-tick]')].map((x) => x.textContent)).toEqual(['-10 초', '0 초 사건', '+5 초']);
    act(() => root?.unmount()); root = null; box.remove();
    await openClip(clipOf({ end_at: null }));
    expect([...card('사건 기준 시각').querySelectorAll('[data-tick]')].map((x) => x.textContent)).toEqual(['-10 초', '0 초 사건', '일어설 때까지']);
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
  const report = () => $('[role="region"][aria-label="실행 기록"]');
  const openRun = async (more: Record<string, { status: number; body?: unknown }> = {}) => {
    serve({ 'GET /events': list([ROW, ev('2', { severity: 'INFO', category: 'RUN', code: 'RUN_DONE' })]) });   // 기록 탭 목록은 그대로, 누른 뒤의 답만 바꿈
    await open();
    calls.length = 0;
    serve({ 'GET /events': list(RUN_EVENTS), [`GET /runs/${RUN}/history`]: { status: 200, body: HIST }, ...more });
    await click(btn('실행 기록 보기', rows()[0]));
  };
  it('run_id 있는 사건 줄에만 「실행 기록 보기」, 누르기 전에는 부르지 않음', async () => {
    serve({ 'GET /events': list([ROW, ev('2', { severity: 'INFO', category: 'RUN', code: 'RUN_DONE' })]) });
    await open();
    expect(rows().map((r) => !!btn('실행 기록 보기', r))).toEqual([true, false]);
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
    expect($('[data-run-took]', r)!.textContent).toBe('31 분 0 초');
  });
  it('예상 칸은 수 없이 «예상 값은 서버에 아직 없음» 한 줄', async () => {
    await openRun();
    expect($('[data-run-expect]', report()!)!.textContent).toBe('예상 값은 서버에 아직 없음');
    expect(report()!.querySelector('th')?.textContent).not.toContain('예상');
  });
  it('지점마다 도착 시각 순서 · 구간 걸린 시간(이전 도착 또는 시작부터) · 단계 결과(실패 까닭), 결과 기록이 없으면 그렇게', async () => {
    await openRun();
    const trs = [...report()!.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(trs.map((x) => x[0])).toEqual(['1 · 펌프실 앞', '2 · 압력 G-14', '3 · 관제실']);
    expect(trs.map((x) => x[2])).toEqual(['4 분 0 초', '8 분 0 초', '8 분 0 초']);
    expect(trs[0][3]).toBe('단계 1 개 마침');
    expect(trs[1][3]).toBe('단계 2 개 중 1 개 실패 · 카메라 새 화면이 없습니다.');
    expect(trs[2][3]).toBe('결과 기록 없음');
  });
  it('걸린 시간 글: 한 시간 아래 «분 초», 넘으면 «시간 분»', () => {
    expect([took(0), took(59_400), took(31 * 60_000), took(3_725_000), took(-5)]).toEqual(['0 분 0 초', '0 분 59 초', '31 분 0 초', '1 시간 2 분', '0 분 0 초']);
  });
  it('같은 지점 도착이 또 오면 먼저 온 시각 · 지점은 번호 순(늦게 온 앞 번호도 제자리), 머리 칸은 보임', async () => {
    const again = wp('36', 'RUN_WAYPOINT_ARRIVED', 6, { idx: 0, mission_name: '펌프실 앞' });
    await openRun({ 'GET /events': list([again, ...RUN_EVENTS]) });
    const first = [...report()!.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent))[0];
    expect(first[2]).toBe('4 분 0 초');
    expect($('[data-run-status]', report()!)!.closest('[hidden]')).toBeNull();
    act(() => root?.unmount()); root = null; box.remove();
    await openRun({ 'GET /events': list([wp('41', 'RUN_WAYPOINT_ARRIVED', 6, { idx: 0, mission_name: '가' }), wp('42', 'RUN_WAYPOINT_ARRIVED', 3, { idx: 1, mission_name: '나' })]) });
    expect([...report()!.querySelectorAll('tbody tr')].map((tr) => tr.children[0].textContent)).toEqual(['1 · 가', '2 · 나']);
  });
  it('끝나지 않은 실행은 «끝나지 않음», 걸린 시간 없음', async () => {
    await openRun({ [`GET /runs/${RUN}/history`]: { status: 200, body: { ...HIST, status: 'PAUSED', ended_at: null } } });
    expect($('[data-run-status]', report()!)!.textContent).toBe('일시정지');
    expect(report()!.textContent).toContain('끝나지 않음');
    expect($('[data-run-took]', report()!)).toBeNull();
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
  it('닫기 = 보고서 닫고 초점은 누른 「실행 기록 보기」 단추로', async () => {
    await openRun();
    await click(btn('닫기', report()!));
    expect(report()).toBeNull();
    expect(document.activeElement).toBe(btn('실행 기록 보기', rows()[0]));
  });
});

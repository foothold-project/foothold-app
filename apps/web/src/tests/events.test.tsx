// W3 기록·알림 화면(01 LG-01·02·04·05, 02 F-LG·F-COM-03, 03 §5.5, 05 §8 — S2 /events·/notifications).
// fetch 는 가짜 서버, WebSocket 은 FakeWS. 화면은 서버가 준 목록·문장만 그리고 필터는 요청 매개변수로만 넘긴다.
// 401·403·404·400 EXPORT_LIMIT·네트워크 실패, cursor 더 보기, 늦은 답 버림, 알림 읽음·모두 읽음, 어긋난 응답·실패에도 STOP 이 그대로인지 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event as Ev, Notification, RobotSummary, User } from '../../../contracts/ts';
import { Root } from '../session';
import { tabFromHash } from '../menu';
import { NOTE_MS } from '../api';
import { BELL_MS, stamp } from '../screens/history';
import { FakeWS } from './fakeWs';
import { adminNoStop } from './adminStop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const PARK: User = { ...KIM, id: 'o2', username: 'park', display_name: '박운영', role: 'OPERATOR', robot_ids: ['r-b'] };
const robot = (id: string, name: string, owner: User): RobotSummary => ({ id, name, model: 'unitree_go2', owner: { id: owner.id, display_name: owner.display_name },
  simulation: false,
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] });
const RA = robot('r-a', 'Go2-A', LEE), RB = robot('r-b', 'Go2-B', PARK);
const NOW = new Date().toISOString();
const ev = (id: string, p: Partial<Ev> = {}): Ev => ({ id, at: NOW, robot_at: null, category: 'ROUTE', code: 'ROUTE_DEVIATION', severity: 'WARN',
  message: `사건 ${id} 문장`, robot_id: 'r-a', user_id: null, run_id: null, data: {}, ...p });
const note = (id: string, p: Partial<Notification> = {}): Notification => ({ id, event_id: id, kind: 'LINK_LOST', title: '연결 끊김', body: `알림 ${id} 본문`,
  link: `#/history?event_id=${id}`, read_at: null, created_at: NOW, ...p });
const list = (items: Ev[], next_cursor: string | null = null) => ({ status: 200, body: { items, next_cursor } });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Route = Reply | ((q: URLSearchParams, body?: unknown) => Reply | Promise<Reply>);
type Call = { method: string; path: string; q: URLSearchParams; body?: unknown; signal?: AbortSignal };
let calls: Call[] = [], routes: Record<string, Route> = {};
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, q, body, signal: init.signal ?? undefined });
    const hit = routes[`${method} ${path}`];
    // 진짜 fetch 처럼 거두면(abort) 기다리던 요청도 실패한다
    const rep = typeof hit === 'function' ? await Promise.race([hit(q, body), new Promise<never>((_, no) => init.signal?.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))))])
      : hit ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : typeof rep.body === 'string' ? rep.body : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, more: typeof routes = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: [RA, RB], next_cursor: null } },
  'GET /dashboard': { status: 200, body: { robots_total: 2, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } },
  'GET /robots/r-a': { status: 200, body: RA }, 'GET /robots/r-b': { status: 200, body: RB },
  'GET /notifications': { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } },
  'GET /events': list([]),
  ...more,
});
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
/** 마지막 목록 요청의 매개변수(limit 빼고) */
const lastQuery = (path = '/events') => { const all = sent('GET', path), q = new URLSearchParams(all[all.length - 1].q); q.delete('limit'); return Object.fromEntries(q); };

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string, phone = false) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
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
const setVal = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
  await flush();
};
const rows = () => [...card('사건').querySelectorAll('tbody tr')].map((l) => l.textContent);
const alertText = () => [...box.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ');
/** STOP 이 머리줄 맨 끝에 있고 누를 수 있다 */
const stopOk = () => {
  if (adminNoStop(box)) return true;
  const s = $<HTMLButtonElement>('[data-stop]');
  expect(s).toBeTruthy();
  expect(s!.disabled).toBe(false);
  expect($('header')!.lastElementChild).toBe(s);
};
/** STOP 을 실제로 눌러 정지 요청이 실시간 연결로 나가는지까지(R2). PC 기록 탭처럼 대상이 없으면 «정지할 로봇 고르기»에서 로봇을 골라 정지 */
const stopSends = async () => {
  if (stopOk()) return;
  act(() => FakeWS.last.open());
  await click($('[data-stop]'));
  const pick = $<HTMLSelectElement>('[aria-label="정지할 로봇"]');
  if (pick) { await setVal(pick, pick.options[pick.options.length - 1].value); await click(btn('정지', $('[aria-label="정지할 로봇 고르기"]')!)); }
  expect(FakeWS.last.of('stop')).toHaveLength(1);
};
/** 지금까지 예약된 setTimeout 중 ms 인 것의 콜백(마지막 것) */
const timerOf = (spy: { mock: { calls: unknown[][] } }, ms: number) => { const c = spy.mock.calls.filter((a) => a[1] === ms); return c.length ? (c[c.length - 1][0] as () => void) : undefined; };

describe('기록 탭 — 서버 목록 그대로', () => {
  it('최신순 목록·서버 문장 그대로·분류 이름과 심각도 모양, 처음 요청은 필터 없이 limit=50', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('9', { category: 'LINK', severity: 'ERROR', message: 'Go2-A과 연결이 끊겼습니다. 마지막 확인 상태: 정지 잠금. 이후 상태는 확인되지 않았습니다.' }),
      ev('8', { category: 'ACCOUNT', severity: 'INFO', message: '김총괄님이 계정을 만들었습니다.', robot_id: null })]) }));
    await open('#/history');
    expect(Object.fromEntries(sent('GET', '/events')[0].q)).toEqual({ limit: '50' });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain('Go2-A과 연결이 끊겼습니다. 마지막 확인 상태: 정지 잠금. 이후 상태는 확인되지 않았습니다.');
    expect(rows()[0]).toContain('연결');
    expect(rows()[1]).toContain('계정');
    expect(card('사건').querySelector('tbody tr [data-tone]')!.getAttribute('data-tone')).toBe('bad');
    expect(rows()[0]).toMatch(/^\d{1,2}\/\d{1,2} \d\d:\d\d/);   // 현지 날짜·시각
    stopOk();
  });
  it('표: 시각·종류·상태·내용·로봇·사람 열, 분류 배지와 심각도(모양+글)는 따로', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('2', { category: 'SAFETY', severity: 'WARN', user_id: 'a1' }), ev('1', { category: 'ACCOUNT', severity: 'INFO', robot_id: null })]) }));
    await open('#/history');
    expect([...card('사건').querySelectorAll('th')].map((t) => t.textContent)).toEqual(['시각', '종류', '상태', '내용', '로봇·사람']);
    const [a, b] = [...card('사건').querySelectorAll('tbody tr')].map((r) => [...r.children].map((td) => td.textContent));
    expect(a.slice(1)).toEqual(['안전', '▲주의', '사건 2 문장', 'Go2-A · 김총괄']);
    expect(b.slice(1)).toEqual(['계정', '○알림', '사건 1 문장', '—']);
    expect(card('사건').querySelector('[data-kind="SAFETY"]')!.textContent).toBe('안전');
  });
  it('INFO 는 «정상»이라 단정하지 않음 — 서버가 INFO 로 저장한 실패 코드(정지 확인 실패 등)는 ▲주의', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('2', { category: 'SAFETY', code: 'STOP_CONFIRM_FAILED', severity: 'INFO', message: 'Go2-A 정지 확인에 실패했습니다.' }),
      ev('1', { category: 'RUN', code: 'NAV_GOAL_REJECTED', severity: 'INFO' })]) }));
    await open('#/history');
    const [a, b] = [...card('사건').querySelectorAll('tbody tr')].map((r) => r.children[2].textContent);
    expect([a, b]).toEqual(['▲주의', '▲주의']);
    expect(card('사건').textContent).not.toContain('정상');
  });
  it('cursor 로 «더 보기» — 다음 쪽을 이어 붙이고 끝이면 단추가 없어짐', async () => {
    serve(signedIn(KIM, { 'GET /events': (q) => (q.get('cursor') === 'c1' ? list([ev('1')]) : list([ev('3'), ev('2')], 'c1')) }));
    await open('#/history');
    expect(rows()).toHaveLength(2);
    await click(btn('더 보기'));
    expect(lastQuery()).toEqual({ cursor: 'c1' });
    expect(rows().map((r) => r!.match(/사건 (\d)/)![1])).toEqual(['3', '2', '1']);
    expect(btn('더 보기')).toBeUndefined();
  });
  it('분류 7종·로봇·기간 → 요청 매개변수(화면이 따로 거르지 않음)', async () => {
    // 서버가 무엇을 돌려주든 그대로 그린다 — 필터와 다른 분류·로봇의 행도 화면이 지우지 않는다
    serve(signedIn(KIM, { 'GET /events': list([ev('5', { category: 'ACCOUNT', robot_id: 'r-b', message: '서버가 준 행' })]) }));
    await open('#/history');
    const kinds = [...card('분류').querySelectorAll('button')].map((b) => b.textContent);
    expect(kinds).toEqual(['전체', '임무', '이탈', '연결', '조종권', '결재', '안전', '계정']);
    for (const [name, code] of [['임무', 'RUN'], ['이탈', 'ROUTE'], ['연결', 'LINK'], ['조종권', 'LEASE'], ['결재', 'APPROVAL'], ['안전', 'SAFETY'], ['계정', 'ACCOUNT']]) {
      await click(btn(name));
      expect(lastQuery()).toEqual({ category: code });
      expect(btn(name)!.getAttribute('aria-pressed')).toBe('true');
      expect(rows()[0]).toContain('서버가 준 행');
    }
    await click(btn('이탈'));
    await setVal($<HTMLSelectElement>('[aria-label="기록"] select')!, 'r-a');
    expect(lastQuery()).toEqual({ category: 'ROUTE', robot_id: 'r-a' });
    await setVal($<HTMLInputElement>('[aria-label="기간 시작"]')!, '2026-10-01');
    await setVal($<HTMLInputElement>('[aria-label="기간 끝"]')!, '2026-10-02');
    expect(lastQuery()).toEqual({ category: 'ROUTE', robot_id: 'r-a', from: new Date('2026-10-01T00:00:00').toISOString(), to: new Date('2026-10-02T23:59:59.999').toISOString() });
    expect(rows()).toEqual([expect.stringContaining('서버가 준 행')]);
    await click(btn('전체'));
    expect(lastQuery()).toEqual({ robot_id: 'r-a', from: new Date('2026-10-01T00:00:00').toISOString(), to: new Date('2026-10-02T23:59:59.999').toISOString() });
  });
  it('필터를 바꾸면 앞 요청의 늦은 답은 버린다', async () => {
    const wait: ((r: Reply) => void)[] = [];
    serve(signedIn(KIM, { 'GET /events': (q) => (q.get('category') ? list([ev('2', { message: '새 필터 결과' })]) : new Promise<Reply>((r) => wait.push(r))) }));
    await open('#/history');
    await click(btn('안전'));
    expect(rows()).toEqual([expect.stringContaining('새 필터 결과')]);
    wait[0](list([ev('1', { message: '옛 필터 결과' })])); await flush();
    expect(rows()).toEqual([expect.stringContaining('새 필터 결과')]);
  });
  it('빈 목록 문구: 필터 없음 / 필터 있음', async () => {
    serve(signedIn(KIM));
    await open('#/history');
    expect(card('기록').textContent).toContain('아직 기록이 없습니다.');
    await click(btn('결재'));
    expect(card('기록').textContent).toContain('조건에 맞는 기록이 없습니다.');
  });
});

// 10-20 조정 결정 B: 서버 문장 맨 앞 «HH:MM » 접두만 떼고 at 의 현지 날짜·시각을 따로 보인다. 접두가 없으면 그대로, CSV 는 서버 문장 그대로
describe('기록 탭 — 끝낸 시뮬 슬롯 거르기(#99 R2)', () => {
  // 끝낸(IDLE) 슬롯 = 시뮬 + 담당 비움. 관제·조종 목록에서는 빠지지만 지난 시뮬 기록은 로봇별로 거를 수 있어야 한다
  const IDLE: RobotSummary = { ...robot('r-s', '시뮬 슬롯', KIM), simulation: true, owner: null };
  const names = () => [...$<HTMLSelectElement>('[aria-label="기록"] select')!.options].map((o) => o.value);
  for (const [me, want] of [[KIM, ['', 'r-a', 'r-b', 'r-s']], [LEE, ['', 'r-a', 'r-s']]] as const) {
    it(`${me.display_name}: 로봇 거르기에 끝낸 시뮬 슬롯 포함 → robot_id 요청`, async () => {
      serve(signedIn(me, { 'GET /robots': { status: 200, body: { items: [RA, RB, IDLE], next_cursor: null } } }));
      await open('#/history');
      expect(names()).toEqual(want);
      await setVal($<HTMLSelectElement>('[aria-label="기록"] select')!, 'r-s');
      expect(lastQuery()).toEqual({ robot_id: 'r-s' });
    });
  }
});

describe('시각 접두', () => {
  const AT = '2026-10-19T23:47:00Z', d = new Date(AT), local = `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`;
  it('UTC 접두·KST 접두·접두 없음 — 사건 목록', async () => {
    serve(signedIn(KIM, { 'GET /events': list([
      ev('3', { at: AT, message: '23:47 김총괄님이 로그인했습니다.' }),          // 지금 서버(UTC 접두)
      ev('2', { at: AT, message: '08:47 박운영님이 로그인했습니다.' }),          // 고친 서버(조직 시간대 접두)
      ev('1', { at: AT, message: 'Go2-7이 12:30 에 연결되었습니다.' }),          // 접두 없음 — 문장 가운데 시각은 그대로
    ]) }));
    await open('#/history');
    const sentences = [...card('사건').querySelectorAll('tbody tr')].map((l) => l.querySelector('.fh-wide')!.textContent);
    expect(sentences).toEqual(['김총괄님이 로그인했습니다.', '박운영님이 로그인했습니다.', 'Go2-7이 12:30 에 연결되었습니다.']);
    for (const li of card('사건').querySelectorAll('tbody tr')) expect(li.firstElementChild!.textContent).toBe(local);
  });
  // 10-20 조정 결정 A: 표시 시각은 서버 접두와 같은 규칙(event_messages.py — timedelta(0) <= at - robot_at <= 24h 이면 robot_at, 아니면 at)
  it('표시 시각 규칙 — robot_at 없음·범위 안·미래·24시간 넘음, 경계(같은 시각·정확히 24시간·1µs 넘김)', () => {
    const at = '2026-10-20T00:00:00.000500Z';
    expect(stamp({ at, robot_at: null })).toBe(at);                                              // 없음 → at
    expect(stamp({ at, robot_at: '2026-10-19T23:00:00Z' })).toBe('2026-10-19T23:00:00Z');        // 1시간 전 → 로봇 시각
    expect(stamp({ at, robot_at: '2026-10-20T00:01:00Z' })).toBe(at);                            // 미래 → at
    expect(stamp({ at, robot_at: '2026-10-18T23:59:59Z' })).toBe(at);                            // 24시간 넘음 → at
    expect(stamp({ at, robot_at: '2026-10-20T09:00:00.000500+09:00' })).toBe('2026-10-20T09:00:00.000500+09:00');   // 같은 순간(0, 표기만 다름) → robot_at
    expect(stamp({ at, robot_at: '2026-10-20T00:00:00.000501Z' })).toBe(at);                     // 1µs 미래 → at
    expect(stamp({ at, robot_at: '2026-10-19T00:00:00.000500Z' })).toBe('2026-10-19T00:00:00.000500Z');   // 정확히 24시간 → robot_at(양 끝 포함)
    expect(stamp({ at, robot_at: '2026-10-19T00:00:00.000499Z' })).toBe(at);                     // 24시간 + 1µs → at
    expect(stamp({ at: '2026-10-20T09:00:00+09:00', robot_at: '2026-10-19T23:30:00Z' })).toBe('2026-10-19T23:30:00Z');   // 시간대 표기 달라도
  });
  it('목록·알림에서 연 기록의 시각 = 그 규칙(늦게 온 로봇 사건은 로봇 발생 시각)', async () => {
    const show = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`; };
    const late = ev('2', { at: '2026-10-20T05:00:00Z', robot_at: '2026-10-20T01:15:00Z', message: '10:15 Go2-7이 경로를 벗어났습니다.' });
    const skewed = ev('1', { at: '2026-10-20T05:00:00Z', robot_at: '2026-10-21T05:00:00Z', message: '14:00 Go2-7 시계가 앞선 사건' });
    serve(signedIn(KIM, { 'GET /events': list([late, skewed]), 'GET /events/2': { status: 200, body: late } }));
    await open('#/history?event_id=2');
    const times = [...card('사건').querySelectorAll('tbody tr')].map((l) => l.firstElementChild!.textContent);
    expect(times).toEqual([show('2026-10-20T01:15:00Z'), show('2026-10-20T05:00:00Z')]);
    expect(card('알림에서 연 기록').querySelector('tbody tr')!.firstElementChild!.textContent).toBe(show('2026-10-20T01:15:00Z'));
  });
  it('알림 본문도 같은 규칙, 서랍 «최근 사건»도', async () => {
    serve(signedIn(KIM, {
      'GET /notifications': { status: 200, body: { items: [note('1', { body: '23:47 Go2-7과 연결이 끊겼습니다.', created_at: AT }), note('2', { body: 'Go2-7 배터리가 낮습니다.', created_at: AT })], next_cursor: null, unread_count: 2 } },
      'GET /events': list([ev('1', { at: AT, message: '08:47 Go2-7이 연결되었습니다.' })]),
    }));
    await open('#/fleet');
    const notes = [...card('알림 목록').querySelectorAll('li')].map((l) => l.textContent);
    expect(notes[0]).toBe(`●새 알림연결 끊김 Go2-7과 연결이 끊겼습니다.${local}`);
    expect(notes[1]).toBe(`●새 알림연결 끊김 Go2-7 배터리가 낮습니다.${local}`);
    expect(card('최근 사건').textContent).toContain(`${local}`);
    expect(card('최근 사건').textContent).not.toContain('08:47 Go2-7');
  });
});

describe('기록 탭 — 오류', () => {
  it('401 → 로그인 화면', async () => {
    serve(signedIn(KIM, { 'GET /events': err(401, 'AUTH_REQUIRED', '로그인이 필요합니다.') }));
    await open('#/history');
    expect($('form')).toBeTruthy();
    expect(box.textContent).toContain('로그인이 끝났습니다');
  });
  it('403 → 서버 문장, STOP 그대로', async () => {
    serve(signedIn(LEE, { 'GET /events': err(403, 'FORBIDDEN', '권한이 없습니다.') }));
    await open('#/history');
    expect(alertText()).toContain('기록을 받지 못했습니다. 권한이 없습니다.');
    await stopSends();
  });
  it('404(범위 밖) → 무엇이 + 어떻게', async () => {
    serve(signedIn(LEE, { 'GET /events': (q) => (q.get('robot_id') ? err(404, 'NOT_FOUND', '기록을 찾을 수 없습니다.') : list([ev('1')])) }));
    await open('#/history');
    await setVal($<HTMLSelectElement>('[aria-label="기록"] select')!, 'r-a');
    expect(alertText()).toContain('기록을 찾을 수 없습니다. 로봇 담당이 바뀌었거나 지워졌을 수 있습니다. 필터를 바꿔 다시 보세요.');
    expect(rows()).toEqual([]);   // 앞 필터의 목록을 남기지 않음
    expect(alertText()).not.toMatch(/404|HTTP/);
  });
  it('네트워크 실패 → 문구 + 다시 시도', async () => {
    let down = true;
    serve(signedIn(KIM, { 'GET /events': () => { if (down) throw new TypeError('Failed to fetch'); return list([ev('1')]); } }));
    await open('#/history');
    expect(alertText()).toContain('서버에 연결하지 못했습니다');
    stopOk();
    down = false;
    await click(btn('다시 시도'));
    expect(rows()).toHaveLength(1);
    expect(alertText()).toBe('');
  });
  it('더 보기 실패 → 받은 목록 그대로, 다시 시도하면 같은 cursor', async () => {
    let down = false;
    serve(signedIn(KIM, { 'GET /events': (q) => { if (q.get('cursor') && down) throw new TypeError('x'); return q.get('cursor') ? list([ev('1')]) : list([ev('2')], 'c1'); } }));
    await open('#/history');
    down = true;
    await click(btn('더 보기'));
    expect(rows()).toHaveLength(1);
    expect(alertText()).toContain('서버에 연결하지 못했습니다');
    down = false;
    await click(btn('다시 시도'));
    expect(lastQuery()).toEqual({ cursor: 'c1' });
    expect(rows()).toHaveLength(2);
  });
  it('어긋난 응답(목록 아님·문장 아님)도 화면을 깨지 않음 — 오류 한 줄 + STOP 그대로', async () => {
    for (const body of [{ csrf_token: 'x' }, { items: [{ id: '1', at: NOW, message: { x: 1 } }], next_cursor: null }]) {
      serve(signedIn(KIM, { 'GET /events': { status: 200, body }, 'GET /notifications': { status: 200, body: { items: 'x' } } }));
      await open('#/history');
      expect(alertText()).toContain('받은 기록 형식이 맞지 않습니다');
      await stopSends();
      act(() => root?.unmount()); root = null; box.remove();
    }
  });
  it('기록·알림 요청이 끝까지 답하지 않아도 STOP 은 보이고 눌림', async () => {
    serve(signedIn(KIM, { 'GET /events': () => new Promise<Reply>(() => {}), 'GET /notifications': () => new Promise<Reply>(() => {}) }));
    await open('#/history');
    expect(card('기록').textContent).toContain('기록을 불러오는 중');
    await stopSends();
  });
});

describe('화면 일부가 깨져도 STOP 은 남음(검토 P1)', () => {
  it('날짜 칸이 받는 다섯 자리 연도 → 요청하지 않고 칸 안 안내, STOP 실제로 눌러 정지 요청', async () => {
    serve(signedIn(KIM));
    await open('#/history');
    const before = sent('GET', '/events').length;
    await setVal($<HTMLInputElement>('[aria-label="기간 시작"]')!, '10000-01-01');
    expect(alertText()).toContain('기간 날짜를 읽을 수 없습니다. 연도 네 자리 날짜(예: 2026-10-20)로 다시 고르세요.');
    expect(sent('GET', '/events')).toHaveLength(before);   // 서버가 못 읽는 값은 보내지 않음
    expect(btn('다시 시도')).toBeUndefined();               // 같은 값으로 다시 시도해도 소용없음
    await click(btn('내보내기'));
    expect(alertText()).toContain('내보내지 못했습니다. 기간 날짜를 읽을 수 없습니다');
    expect(sent('GET', '/events/export.csv')).toEqual([]);
    await setVal($<HTMLInputElement>('[aria-label="기간 시작"]')!, '2026-10-01');   // 고치면 다시 받음
    expect(lastQuery()).toEqual({ from: new Date('2026-10-01T00:00:00').toISOString() });
    expect(alertText()).not.toContain('기간 날짜');
    await setVal($<HTMLInputElement>('[aria-label="기간 끝"]')!, '10000-12-31');
    expect(alertText()).toContain('기간 날짜를 읽을 수 없습니다');
    await stopSends();
  });
  it('본문 렌더 예외는 본문 칸 안에서 멈춤 — 머리줄·STOP 그대로, 다른 탭으로 가면 다시 그림', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('1')]) }));
    await open('#/fleet');
    const boom = vi.spyOn(Date.prototype, 'toTimeString').mockImplementation(() => { throw new RangeError('Invalid time value'); });   // 사건 행 시각에서 터짐
    vi.spyOn(console, 'error').mockImplementation(() => {});   // React 가 잡은 예외를 찍는 줄
    await click($('nav a[href="#/history"]'));
    expect(card('화면 오류').textContent).toContain('이 화면을 그리지 못했습니다');
    expect($('h1')!.textContent).toBe('기록');
    await stopSends();
    boom.mockRestore();
    await click($('nav a[href="#/fleet"]'));
    expect($('[aria-label="화면 오류"]')).toBeNull();
    expect(card('로봇 상세')).toBeTruthy();
  });
});

describe('로봇 0대 — 기록은 열림(검토 P2)', () => {
  const none = { 'GET /robots': { status: 200, body: { items: [], next_cursor: null } } };
  it('PC: 계정 사건 목록과 알림에서 연 기록', async () => {
    serve(signedIn(KIM, { ...none,
      'GET /events': list([ev('1', { category: 'ACCOUNT', robot_id: null, message: '김총괄님이 로그인했습니다.' })]),
      'GET /events/1': { status: 200, body: ev('1', { category: 'ACCOUNT', robot_id: null, message: '알림이 가리킨 계정 사건' }) },
    }));
    await open('#/history?event_id=1');
    expect(Object.fromEntries(sent('GET', '/events')[0].q)).toEqual({ limit: '50' });
    expect(rows()).toEqual([expect.stringContaining('김총괄님이 로그인했습니다.')]);
    expect(card('알림에서 연 기록').textContent).toContain('알림이 가리킨 계정 사건');
    expect([...$('[aria-label="기록"] select')!.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['전체']);
    expect($('[aria-label="로봇 없음"]')).toBeNull();
    stopOk();
  });
  it('폰: 담당 로봇 0대면 로봇 필터 없이 서버가 주는 내 기록, 알림 링크도', async () => {
    serve(signedIn(PARK, { ...none,
      'GET /events': list([]),
      'GET /events/3': { status: 200, body: ev('3', { category: 'ACCOUNT', robot_id: null, message: '박운영님이 비밀번호를 바꿨습니다.' }) },
    }));
    await open('#/history?event_id=3', true);
    expect(lastQuery()).toEqual({});
    expect(card('기록').textContent).toContain('아직 기록이 없습니다.');
    expect(card('기록').textContent).not.toContain('이 로봇의');
    expect(card('알림에서 연 기록').textContent).toContain('박운영님이 비밀번호를 바꿨습니다.');
    stopOk();
  });
});

describe('CSV 내보내기', () => {
  let saved: { href: string; download: string }[] = [];
  beforeEach(() => {
    saved = [];
    URL.createObjectURL = vi.fn(() => 'blob:csv');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push({ href: this.href, download: this.download }); });
  });
  it('지금 필터 그대로(cursor·limit 없이) 받아 파일로 저장', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('2')], 'c1'), 'GET /events/export.csv': { status: 200, body: '\ufeffid,at\n2,x\n' } }));
    await open('#/history');
    await click(btn('계정'));
    await setVal($<HTMLSelectElement>('[aria-label="기록"] select')!, 'r-b');
    await click(btn('내보내기'));
    expect(Object.fromEntries(sent('GET', '/events/export.csv')[0].q)).toEqual({ category: 'ACCOUNT', robot_id: 'r-b' });
    expect(saved).toEqual([{ href: 'blob:csv', download: expect.stringMatching(/^기록-\d{4}-\d\d-\d\d\.csv$/) }]);
    expect(await ((URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob).text()).toContain('id,at\n2,x');   // 서버 본문 그대로
    expect(card('기록').textContent).toContain('CSV 파일로 내려받았습니다');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv');   // 만든 URL 정리(R1)
  });
  it('Android 앱(UA FootholdApp/) → 받지 않고 «앱에선 내려받기 안 됨» 안내, 파일 없음', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; wv) Chrome/140 Mobile Safari/537.36 FootholdApp/1.1.0-dev');
    serve(signedIn(KIM, { 'GET /events/export.csv': { status: 200, body: 'id,at\n' } }));
    await open('#/history');
    await click(btn('내보내기'));
    expect(alertText()).toContain('앱에서는 파일을 내려받을 수 없습니다');
    expect(sent('GET', '/events/export.csv')).toHaveLength(0);
    expect(saved).toEqual([]);
  });
  it('429 RATE_LIMITED(다른 내보내기 진행 중) → 기다렸다 다시 하라는 안내, 파일 없음, 단추 되살림', async () => {
    serve(signedIn(KIM, { 'GET /events/export.csv': err(429, 'RATE_LIMITED', '다른 기록을 내보내는 중입니다. 잠시 뒤 다시 시도하세요.') }));
    await open('#/history');
    await click(btn('내보내기'));
    expect(alertText()).toContain('다른 기록 내보내기가 아직 끝나지 않았습니다. 잠시 뒤 다시 내보내세요.');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(btn('내보내기')!.disabled).toBe(false);
  });
  it('본문 받다 끊김(200 뒤 blob 실패) → 실패 안내, 파일 없음, 다시 누를 수 있음(검토 P2)', async () => {
    serve(signedIn(KIM, { 'GET /events/export.csv': { status: 200, body: 'id,at\n' } }));
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, i?: RequestInit) => {
      const r = await real(u, i);
      if (u.includes('export.csv')) r.blob = async () => { throw new TypeError('body stream interrupted'); };
      return r;
    });
    await open('#/history');
    await click(btn('내보내기'));
    expect(alertText()).toContain('내보내지 못했습니다. 서버에 연결하지 못했습니다');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(btn('내보내기')!.disabled).toBe(false);
    stopOk();
  });
  it('파일 만들기 실패(createObjectURL 예외) → 안내 + 단추 되살림, 만든 URL 은 정리', async () => {
    serve(signedIn(KIM, { 'GET /events/export.csv': { status: 200, body: 'id,at\n' } }));
    await open('#/history');
    URL.createObjectURL = vi.fn(() => { throw new TypeError('no blob'); });
    await click(btn('내보내기'));
    expect(alertText()).toContain('내보내지 못했습니다. 파일을 만들지 못했습니다. 다시 시도하세요.');
    expect(btn('내보내기')!.disabled).toBe(false);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();   // 만든 것이 없으면 정리할 것도 없음
    URL.createObjectURL = vi.fn(() => 'blob:csv2');
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => { throw new Error('download blocked'); });
    await click(btn('내보내기'));
    expect(alertText()).toContain('파일을 만들지 못했습니다');
    expect(btn('내보내기')!.disabled).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv2');
  });
  it('400 EXPORT_LIMIT → 기간을 줄이라는 쉬운 안내, 파일 없음', async () => {
    serve(signedIn(KIM, { 'GET /events/export.csv': err(400, 'EXPORT_LIMIT', '기록이 10,000개를 넘습니다. 기간이나 필터를 좁혀 주세요.') }));
    await open('#/history');
    await click(btn('내보내기'));
    expect(alertText()).toContain('기간을 줄이거나 분류·로봇을 골라 다시 내보내세요');
    expect(saved).toEqual([]);
    expect(btn('내보내기')!.disabled).toBe(false);
  });
  it('네트워크 실패·403 → 무엇이 + 서버 문장', async () => {
    serve(signedIn(KIM, { 'GET /events/export.csv': () => { throw new TypeError('x'); } }));
    await open('#/history');
    await click(btn('내보내기'));
    expect(alertText()).toContain('내보내지 못했습니다. 서버에 연결하지 못했습니다');
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(LEE, { 'GET /events/export.csv': err(403, 'FORBIDDEN', '권한이 없습니다.') }));
    await open('#/history');
    await click(btn('내보내기'));
    expect(alertText()).toContain('내보내지 못했습니다. 권한이 없습니다.');
    expect(saved).toEqual([]);
  });
});

describe('운영 관리자 — 서버가 준 것만', () => {
  it('목록은 서버 응답 그대로(남의 로봇에 한 내 행동 포함), 로봇 고르기는 내 로봇만', async () => {
    serve(signedIn(LEE, { 'GET /events': list([ev('2', { robot_id: 'r-a', message: 'Go2-A 내 로봇 사건' }), ev('1', { category: 'SAFETY', robot_id: 'r-b', user_id: 'o1', message: '이운영님이 Go2-B STOP 을 눌렀습니다.' })]) }));
    await open('#/history');
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toContain('이운영님이 Go2-B STOP 을 눌렀습니다.');
    expect([...$('[aria-label="기록"] select')!.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['전체', 'Go2-A']);
  });
});

describe('사건 문구 다듬기(10-22 QA R3·R4·R9·R10)', () => {
  // 시뮬 로봇 두 대(서버 기본 이름 «시뮬 <id 앞 8자리>»)와 사람이 이름 붙인 시뮬 한 대
  const S1 = { ...robot('628962ca-0000-4000-8000-000000000001', '시뮬 628962ca', LEE), simulation: true };
  const S2 = { ...robot('1a2b3c4d-0000-4000-8000-000000000002', '시뮬 1a2b3c4d', LEE), simulation: true };
  const S3 = { ...robot('ffff0000-0000-4000-8000-000000000003', '내 연습 시뮬', LEE), simulation: true };
  const withSims = (more: Record<string, Route> = {}) => signedIn(KIM, { 'GET /robots': { status: 200, body: { items: [RA, S1, S2, S3], next_cursor: null } }, ...more });
  it('서버가 모르는 로봇 사건 코드 = 한국어 문구(표 밖은 «기타 사건»), 코드 원문은 접힌 상세에만', async () => {
    serve(withSims({ 'GET /events': list([
      ev('2', { category: 'LINK', code: 'PHONE_LEASE_RELEASED', severity: 'INFO', message: '15:03 Go2-A에서 사건 PHONE_LEASE_RELEASED이(가) 기록되었습니다.' }),
      ev('1', { category: 'LINK', code: 'SOMETHING_NEW', severity: 'INFO', message: 'Go2-A에서 사건 SOMETHING_NEW이(가) 기록되었습니다.' })]) }));
    await open('#/history');
    const [a, b] = [...card('사건').querySelectorAll('tbody tr')];
    expect(a.querySelector('.fh-wide')!.textContent).toBe('Go2-A: 폰 조종권을 반납했습니다.');
    expect(b.querySelector('.fh-wide')!.textContent).toBe('Go2-A: 기타 사건');
    expect(a.querySelector('details')!.open).toBe(false);
    expect(a.querySelector('details')!.textContent).toBe('상세PHONE_LEASE_RELEASED');
    expect(b.querySelector('details')!.textContent).toBe('상세SOMETHING_NEW');
  });
  it('시뮬 로봇 16진 id 는 «시뮬 로봇 N»(목록·문장 같은 번호), 사람이 붙인 이름은 그대로, 빈 이유는 «이유 없음»', async () => {
    serve(withSims({ 'GET /events': list([
      ev('2', { message: '김총괄님이 시뮬 628962ca에 시나리오 순찰 1판을 배정했습니다. 이유: 확인되지 않음.' }),
      ev('1', { message: '시뮬 1a2b3c4d 배터리가 부족합니다.' })]) }));
    await open('#/history');
    expect(rows()[0]).toContain('김총괄님이 시뮬 로봇 2에 시나리오 순찰 1판을 배정했습니다. 이유 없음.');
    expect(rows()[1]).toContain('시뮬 로봇 1 배터리가 부족합니다.');
    expect(card('사건').textContent).not.toMatch(/628962ca|1a2b3c4d/);
    await click($('a[href="#/fleet"]'));
    const names = [...card('로봇 목록').querySelectorAll('b')].map((x) => x.textContent);
    expect(names).toEqual(['Go2-A', '시뮬 로봇 2', '시뮬 로봇 1', '내 연습 시뮬']);
  });
  it('폰에서 남의 로봇 주소 = 로봇 연결로 돌아가며 «담당 로봇이 아닙니다» 한 줄(닫기)', async () => {
    serve(signedIn(LEE));
    await open('#/drive/r-b', true);
    expect(location.hash).toBe('#/drive');
    expect($('[data-foreign]')!.textContent).toContain('담당 로봇이 아닙니다.');
    await click(btn('닫기', $('[data-foreign]')!));
    expect($('[data-foreign]')).toBeNull();
    stopOk();
  });
  it('폰에서 내 로봇 주소는 그대로 열리고 알림 없음', async () => {
    serve(signedIn(LEE));
    await open('#/drive/r-a', true);
    expect(location.hash).toBe('#/drive/r-a');
    expect($('[data-foreign]')).toBeNull();
  });
});

describe('폰 기록', () => {
  it('머리줄에서 고른 내 로봇의 서버 기록, 분류·내보내기 없음', async () => {
    serve(signedIn(PARK, { 'GET /events': list([ev('1', { robot_id: 'r-b', message: 'Go2-B 사건' })]) }));
    await open('#/history', true);
    expect(lastQuery()).toEqual({ robot_id: 'r-b' });
    expect(rows()).toEqual([expect.stringContaining('Go2-B 사건')]);
    expect($('[aria-label="분류"]')).toBeNull();
    expect(btn('내보내기')).toBeUndefined();
    expect($('[data-bell]')).toBeNull();   // 폰 머리줄: 로봇·연결 점·STOP 만(03 §3.2)
    stopOk();
  });
  it('빈 목록·네트워크 실패 문구', async () => {
    serve(signedIn(PARK));
    await open('#/history', true);
    expect(card('기록').textContent).toContain('이 로봇의 기록이 아직 없습니다.');
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(PARK, { 'GET /events': () => { throw new TypeError('x'); } }));
    await open('#/history', true);
    expect(alertText()).toContain('서버에 연결하지 못했습니다');
    stopOk();
  });
});

describe('서랍 «최근 사건»', () => {
  it('그 로봇의 최근 5개(robot_id·limit=5)', async () => {
    serve(signedIn(KIM, { 'GET /events': (q) => (q.get('robot_id') === 'r-a' ? list([ev('2', { message: 'Go2-A 최근 사건' })]) : list([])) }));
    await open('#/fleet');
    const call = sent('GET', '/events').find((c) => c.q.get('robot_id') === 'r-a')!;
    expect(Object.fromEntries(call.q)).toEqual({ robot_id: 'r-a', limit: '5' });
    expect(card('로봇 상세').textContent).toContain('Go2-A 최근 사건');
    expect(card('로봇 상세').textContent).not.toContain('최근 사건 자리');
  });
  it('정지 확인 실패(서버 INFO)는 서랍에서도 «정상»이 아닌 ▲주의', async () => {
    serve(signedIn(KIM, { 'GET /events': (q) => (q.get('robot_id') === 'r-a' ? list([ev('2', { category: 'SAFETY', code: 'STOP_CONFIRM_FAILED', severity: 'INFO', message: 'Go2-A 정지 확인 실패' })]) : list([])) }));
    await open('#/fleet');
    const li = $('[aria-label="최근 사건"] li')!;
    expect(li.textContent).toContain('▲주의');
    expect(li.textContent).not.toContain('정상');
  });
  it('없으면·범위 밖(404)이면 칸을 숨김(가짜 없음), 다른 실패는 한 줄', async () => {
    serve(signedIn(KIM));
    await open('#/fleet');
    expect($('[aria-label="최근 사건"]')).toBeNull();
    expect(card('로봇 상세').textContent).not.toContain('최근 사건');
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(KIM, { 'GET /events': err(404, 'NOT_FOUND', '기록을 찾을 수 없습니다.') }));
    await open('#/fleet');
    expect(card('로봇 상세').textContent).not.toContain('최근 사건');
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(KIM, { 'GET /events': () => { throw new TypeError('x'); } }));
    await open('#/fleet');
    expect(card('로봇 상세').textContent).toContain('최근 사건을 받지 못했습니다. 서버에 연결하지 못했습니다');
    stopOk();
  });
  it('운영 관리자가 남의 로봇을 고르면 요청하지 않음(요약만 보는 범위)', async () => {
    serve(signedIn(PARK));
    await open('#/fleet');
    await click([...card('로봇 목록').querySelectorAll('button')].find((b) => b.textContent!.includes('Go2-A')));
    expect(sent('GET', '/events').filter((c) => c.q.get('robot_id') === 'r-a')).toEqual([]);
    expect(sent('GET', '/events').filter((c) => c.q.get('robot_id') === 'r-b')).toHaveLength(1);   // 내 로봇은 요청함
  });
});

describe('알림 종', () => {
  it('안 읽은 수 배지 → 펼쳐 누르면 그 알림 읽음({ids}) + 그 기록으로 이동', async () => {
    let unread = new Set(['7', '6']);
    serve(signedIn(KIM, {
      'GET /notifications': () => ({ status: 200, body: { items: [note('7', { read_at: unread.has('7') ? null : NOW }), note('6', { read_at: unread.has('6') ? null : NOW })], next_cursor: null, unread_count: unread.size } }),
      'POST /notifications/read': (_q, b) => { for (const id of (b as { ids: string[] }).ids) unread.delete(id); return { status: 204 }; },
      'GET /events/7': { status: 200, body: ev('7', { message: '알림이 가리킨 사건' }) },
    }));
    await open('#/fleet');
    const bell = $('[data-bell]')!;
    expect(bell.querySelector('summary')!.getAttribute('aria-label')).toBe('알림 안 읽음 2건');
    expect(bell.querySelector('.fh-badge')!.textContent).toBe('2');
    act(() => { (bell as HTMLDetailsElement).open = true; });
    expect(card('알림 목록').textContent).toContain('알림 7 본문');
    await click([...card('알림 목록').querySelectorAll('li button')][0]);
    expect(sent('POST', '/notifications/read').map((c) => c.body)).toEqual([{ ids: ['7'] }]);
    expect(location.hash).toBe('#/history?event_id=7');
    expect($('h1')!.textContent).toBe('기록');
    expect(card('알림에서 연 기록').textContent).toContain('알림이 가리킨 사건');
    expect(bell.querySelector('.fh-badge')!.textContent).toBe('1');
    expect((bell as HTMLDetailsElement).open).toBe(false);
    stopOk();
  });
  it('모두 읽음 → {all:true}, 배지 사라짐. 읽은 알림만이면 모두 읽음 비활성', async () => {
    let unread = 3;
    serve(signedIn(KIM, {
      'GET /notifications': () => ({ status: 200, body: { items: [note('1', { read_at: unread ? null : NOW })], next_cursor: null, unread_count: unread } }),
      'POST /notifications/read': () => { unread = 0; return { status: 204 }; },
    }));
    await open('#/fleet');
    await click(btn('모두 읽음'));
    expect(sent('POST', '/notifications/read').map((c) => c.body)).toEqual([{ all: true }]);
    expect($('[data-bell] .fh-badge')).toBeNull();
    expect($('[data-bell] summary')!.getAttribute('aria-label')).toBe('알림 안 읽음 0건');
    expect(btn('모두 읽음')!.disabled).toBe(true);
  });
  it('읽음 실패(404 섞임·네트워크) → 펼친 칸 안에 한 줄, 배지 그대로', async () => {
    serve(signedIn(KIM, {
      'GET /notifications': { status: 200, body: { items: [note('1')], next_cursor: null, unread_count: 1 } },
      'POST /notifications/read': err(404, 'NOT_FOUND', '알림을 찾을 수 없습니다.'),
    }));
    await open('#/fleet');
    await click(btn('모두 읽음'));
    expect(card('알림 목록').textContent).toContain('읽음으로 바꾸지 못했습니다. 알림을 찾을 수 없습니다.');
    expect($('[data-bell] .fh-badge')!.textContent).toBe('1');
    stopOk();
  });
  it('알림을 못 받으면 칸 안에만 이유 — 머리줄·STOP 그대로', async () => {
    serve(signedIn(KIM, { 'GET /notifications': () => { throw new TypeError('x'); } }));
    await open('#/fleet');
    expect($('[data-bell] summary')!.getAttribute('aria-label')).toBe('알림');
    expect(card('알림 목록').textContent).toContain('알림을 받지 못했습니다. 서버에 연결하지 못했습니다');
    stopOk();
  });
  it('알림이 가리킨 기록이 범위 밖(404) → 볼 수 없다고 씀', async () => {
    serve(signedIn(LEE, { 'GET /events/5': err(404, 'NOT_FOUND', '기록을 찾을 수 없습니다.') }));
    await open('#/history?event_id=5');
    expect(location.hash).toBe('#/history?event_id=5');
    expect(card('알림에서 연 기록').textContent).toContain('이 기록을 볼 수 없습니다.');
    await click(btn('닫기', card('알림에서 연 기록')));
    expect(location.hash).toBe('#/history');
    expect($('[aria-label="알림에서 연 기록"]')).toBeNull();
  });
  it('폴링은 한 번에 하나 — 앞 요청이 끝나기 전엔 다음을 예약하지 않고, 15초 넘게 걸린 답도 반영(검토 P2)', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout'), waits: ((r: Reply) => void)[] = [];
    serve(signedIn(KIM, { 'GET /notifications': () => new Promise<Reply>((r) => waits.push(r)) }));
    await open('#/history');
    expect(sent('GET', '/notifications')).toHaveLength(1);
    expect(timerOf(timers, BELL_MS)).toBeUndefined();   // 진행 중엔 다음 폴링 없음
    waits[0]({ status: 200, body: { items: [note('7')], next_cursor: null, unread_count: 1 } }); await flush();
    expect($('[data-bell] summary')!.getAttribute('aria-label')).toBe('알림 안 읽음 1건');
    act(() => timerOf(timers, BELL_MS)!()); await flush();   // 끝난 뒤에야 15초 뒤 다음
    expect(sent('GET', '/notifications')).toHaveLength(2);
    await stopSends();
  });
  it('제한시간(NOTE_MS)이 지나면 그 요청을 거두고 칸 안 안내, 그 뒤 다음 폴링 예약', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    serve(signedIn(KIM, { 'GET /notifications': () => new Promise<Reply>(() => {}) }));
    await open('#/history');
    act(() => timerOf(timers, NOTE_MS)!()); await flush();
    expect(sent('GET', '/notifications')[0].signal!.aborted).toBe(true);
    expect(card('알림 목록').textContent).toContain('알림을 받지 못했습니다. 서버가 제시간에 답하지 않았습니다.');
    expect(timerOf(timers, BELL_MS)).toBeDefined();
    stopOk();
  });
  it('읽음이 진행 중 폴링과 겹치면 그 요청이 끝난 뒤 한 번 더 받음, 화면을 떠나면 진행 중 요청을 거둠', async () => {
    const waits: ((r: Reply) => void)[] = [];
    let unread = 1;
    serve(signedIn(KIM, {
      'GET /notifications': () => (waits.length ? new Promise<Reply>((r) => waits.push(r)) : (waits.push(() => {}), { status: 200, body: { items: [note('1', { read_at: unread ? null : NOW })], next_cursor: null, unread_count: unread } })),
      'POST /notifications/read': () => { unread = 0; return { status: 204 }; },
    }));
    await open('#/fleet');
    expect($('[data-bell] .fh-badge')!.textContent).toBe('1');
    await click(btn('모두 읽음'));
    expect(sent('GET', '/notifications')).toHaveLength(2);       // 읽음 뒤 받기 시작
    await click(btn('모두 읽음'));                                 // 진행 중에 또 읽음 → 지금 요청 뒤 한 번 더
    expect(sent('GET', '/notifications')).toHaveLength(2);       // 겹쳐 보내지 않음
    waits[1]({ status: 200, body: { items: [note('1', { read_at: NOW })], next_cursor: null, unread_count: 0 } }); await flush();
    expect(sent('GET', '/notifications')).toHaveLength(3);
    const pending = sent('GET', '/notifications')[2].signal!;
    act(() => root?.unmount()); root = null;
    expect(pending.aborted).toBe(true);
  });
  it('알림 링크 주소도 기록 탭', () => {
    expect(tabFromHash('#/history?event_id=12', false)).toBe('history');
    expect(tabFromHash('#/history?event_id=12', true)).toBe('history');
  });
});

describe('사진 사건(VQ-F1)', () => {
  const PID = '7f1c2d3e-0000-4000-8000-000000000001';
  const stored = ev('p1', { category: 'RUN', code: 'PHOTO_STORED', severity: 'INFO', message: 'Go2-A 사진을 저장했습니다.', run_id: 'run-1',
    data: { photo_id: PID, run_id: 'run-1', waypoint_idx: 0, step_idx: 0, source: 'rgb', url: `/api/v1/photos/${PID}`, thumbnail_url: `/api/v1/photos/${PID}/thumbnail` } });
  const failed = ev('p2', { category: 'RUN', code: 'PHOTO_STORE_FAILED', severity: 'ERROR', message: 'Go2-A 사진 저장에 실패했습니다. 이유: 저장 공간 부족.', run_id: 'run-1',
    data: { run_id: 'run-1', waypoint_idx: 1, step_idx: 0, source: 'rgb', reason: '저장 공간 부족' } });
  it('PHOTO_STORED = 썸네일(사용자 세션 /photos/{id}/thumbnail), 누르면 원본 · 못 받으면 «사진을 불러오지 못함», PHOTO_STORE_FAILED = 실패(사진 없음)', async () => {
    serve(signedIn(KIM, { 'GET /events': list([stored, failed, ev('3')]) }));
    await open('#/history');
    const [a, b, c] = [...card('사건').querySelectorAll('tbody tr')];
    const img = a.querySelector<HTMLImageElement>('img')!;
    expect(img.getAttribute('src')).toBe(`/api/v1/photos/${PID}/thumbnail`);   // 같은 출처 쿠키 — 공개 주소·토큰을 주소에 싣지 않음
    await click(a.querySelector('button[aria-label="사진 원본 보기"]'));
    expect(a.querySelector('img')!.getAttribute('src')).toBe(`/api/v1/photos/${PID}`);
    expect(a.querySelector('[data-photo="big"]')).toBeTruthy();
    act(() => { a.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(a.querySelector('img')).toBeNull();
    expect(a.textContent).toContain('사진을 불러오지 못함');
    // 실패 행: 사진 없음 + ●오류(성공처럼 보이지 않음)
    expect(b.querySelector('img')).toBeNull();
    expect(b.querySelector('[data-photo="failed"]')!.textContent).toBe('사진 저장 실패 — 사진 없음');
    expect(b.querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('bad');
    expect(c.querySelector('[data-photo]')).toBeNull();   // 다른 사건엔 사진 칸 없음
    stopOk();
  });
  it('photo_id 가 없는 PHOTO_STORED 는 그림을 요청하지 않고 «사진을 불러오지 못함», 폰 기록 표도 같은 썸네일', async () => {
    serve(signedIn(PARK, { 'GET /events': list([{ ...stored, robot_id: 'r-b', data: {} }, { ...stored, id: 'p3', robot_id: 'r-b' }]) }));
    await open('#/history', true);
    const [a, b] = [...card('사건').querySelectorAll('tbody tr')];
    expect(a.querySelector('img')).toBeNull();
    expect(a.textContent).toContain('사진을 불러오지 못함');
    expect(b.querySelector('img')!.getAttribute('src')).toBe(`/api/v1/photos/${PID}/thumbnail`);
    stopOk();
  });
});

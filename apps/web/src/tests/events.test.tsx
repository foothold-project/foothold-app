// W3 기록·알림 화면(01 LG-01·02·04·05, 02 F-LG·F-COM-03, 03 §5.5, 05 §8 — S2 /events·/notifications).
// fetch 는 가짜 서버, WebSocket 은 FakeWS. 화면은 서버가 준 목록·문장만 그리고 필터는 요청 매개변수로만 넘긴다.
// 401·403·404·400 EXPORT_LIMIT·네트워크 실패, cursor 더 보기, 늦은 답 버림, 알림 읽음·모두 읽음, 어긋난 응답·실패에도 STOP 이 그대로인지 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pcBoard } from '../pcboard';
import type { Event as Ev, Notification, RobotSummary, User } from '../../../contracts/ts';
import { Root } from '../session';
import { tabFromHash } from '../menu';
import { NOTE_MS } from '../api';
import { BELL_MS, stamp, when } from '../screens/history';
import { FakeWS } from './fakeWs';
import { fleetRow } from './fleetRow';
// 옛 PC 관제 부품(관제 요약 · 상세 서랍 · 연결 상태 · 조종 준비) 시험: PC 로봇 탭은 시안 u4 라 부품을 앱 맥락 안에 직접 그린다 → W1 u5
beforeEach(() => { pcBoard.on = true; });
afterEach(() => { pcBoard.on = false; });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const PARK: User = { ...KIM, id: 'o2', username: 'park', display_name: '박운영', role: 'OPERATOR', robot_ids: ['r-b'] };
const robot = (id: string, name: string, owner: User): RobotSummary => ({ id, name, model: 'unitree_go2', owner: { id: owner.id, display_name: owner.display_name },
  simulation: false, server_drive_allowed: false,
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
/** 총괄 서랍 열기 — 고른 행을 다시 누름 */
const drawer = () => click(card('로봇 목록').querySelector('button[aria-pressed="true"]'));
/** 기록 줄(u8_1 .ev) · 그 글 · 줄의 사건 문장(.t2 의 첫 글, 아래 small 빼고) */
const evs = () => [...card('사건').querySelectorAll<HTMLElement>('.ev')];
const rows = () => evs().map((l) => l.textContent);
const said = (r: Element) => r.querySelector('.t2')!.firstChild!.textContent;
const alertText = () => [...box.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ');
/** STOP 이 머리줄 맨 끝에 있고 누를 수 있다 */
const stopOk = () => {
  const s = $<HTMLButtonElement>('[data-stop]');
  expect(s).toBeTruthy();
  expect(s!.disabled).toBe(false);
  expect($('header, .bar .rt')!.lastElementChild).toBe(s);
};
/** STOP 을 실제로 눌러 정지 요청이 실시간 연결로 나가는지까지(R2). PC 기록 탭처럼 대상이 없으면 «정지할 로봇 고르기»에서 로봇을 골라 정지 */
const stopSends = async () => {
  stopOk();
  act(() => FakeWS.last.open());
  await click($('[data-stop]'));
  const pick = $<HTMLSelectElement>('[aria-label="정지할 로봇"]');
  if (pick) { await setVal(pick, pick.options[pick.options.length - 1].value); await click(btn('정지', $('[aria-label="정지할 로봇 고르기"]')!)); }
  expect(FakeWS.last.of('stop')).toHaveLength(1);
};
/** 지금까지 예약된 setTimeout 중 ms 인 것의 콜백(마지막 것) */
const timerOf = (spy: { mock: { calls: unknown[][] } }, ms: number) => { const c = spy.mock.calls.filter((a) => a[1] === ms); return c.length ? (c[c.length - 1][0] as () => void) : undefined; };

/** 내보내기 창 기본 기간(최근 7 일, 현지) · 날짜 칸 값과 보내는 질의 */
const WEEK = (() => { const d = new Date(), a = new Date(); a.setDate(d.getDate() - 6); return { from: a.toLocaleDateString('sv'), to: d.toLocaleDateString('sv') }; })();
const WEEK_Q = () => ({ from: new Date(`${WEEK.from}T00:00:00`).toISOString(), to: new Date(`${WEEK.to}T23:59:59.999`).toISOString() });

describe('기록 탭 — 서버 목록 그대로', () => {
  it('최신순 목록·서버 문장 그대로·분류 이름과 심각도 모양, 처음 요청은 필터 없이 limit=50', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('9', { category: 'LINK', severity: 'ERROR', message: 'Go2-A과 연결이 끊겼습니다. 마지막 확인 상태: 정지 잠금. 이후 상태는 확인되지 않았습니다.' }),
      ev('8', { category: 'ACCOUNT', severity: 'INFO', message: '김총괄님이 계정을 만들었습니다.', robot_id: null })]) }));
    await open('#/history');
    expect(Object.fromEntries(sent('GET', '/events')[0].q)).toEqual({ limit: '50' });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain('Go2-A과 연결이 끊겼습니다. 마지막 확인 상태: 정지 잠금. 이후 상태는 확인되지 않았습니다.');
    expect(rows()[0]).toContain('연결 · 시스템');
    expect(rows()[1]).toContain('사용자 작업');
    expect(card('사건').querySelector('.ev [data-lv]')!.getAttribute('data-lv')).toBe('r');
    // 현지 날짜는 날짜 묶음 머리(.day data-day), 줄에는 시각(u8_1)
    expect(card('사건').querySelector('.day')!.getAttribute('data-day')).toMatch(/\d{1,2}월 \d{1,2}일$/);
    expect(card('사건').querySelector('.ev .tm')!.textContent).toMatch(/^\d\d:\d\d:\d\d$/);
    stopOk();
  });
  it('표(u8_1): 등급·클립·사건·묶음·로봇·시각·클립 길이 열, 분류 배지와 심각도(모양+글)는 따로', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('2', { category: 'SAFETY', severity: 'WARN', user_id: 'a1' }), ev('1', { category: 'ACCOUNT', severity: 'INFO', robot_id: null })]) }));
    await open('#/history');
    expect([...$('[data-hs-main] .thd')!.children].map((t) => t.textContent)).toEqual(['등급', '클립', '사건', '묶음', '로봇', '시각', '클립 길이']);
    const [a, b] = evs().map((r) => [...r.children].map((td) => td.textContent));
    expect([a[0], a[2], a[3], a[4]]).toEqual(['주의', '사건 2 문장김총괄', '안전', 'Go2-A실제']);
    expect([b[0], b[2], b[3], b[4]]).toEqual(['정보', '사건 1 문장', '사용자 작업', '없음']);   // INFO = 옅은 정보 칸(.lv.i)
    expect(evs().map((r) => r.querySelector('[data-lv]')!.getAttribute('data-lv'))).toEqual(['w', 'i']);
  });
  it('로봇·사람 칸: id 가 있는데 이름을 모르면 「이름 모름」, 둘 다 없으면 「없음」 (t19)', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('3', { robot_id: 'r-gone' }), ev('2', { robot_id: null, user_id: 'u-gone' }), ev('1', { robot_id: null, user_id: null })]) }));
    await open('#/history');
    expect(evs().map((r) => r.children[4].textContent)).toEqual(['이름 모름', '없음', '없음']);   // 로봇 칸
    expect(evs().map((r) => r.querySelector('[data-who]')?.textContent ?? null)).toEqual([null, '이름 모름', null]);   // 사람 = 사건 칸 아래 줄
  });
  it('INFO 는 «정상»이라 단정하지 않음 · 서버가 INFO 로 저장한 실패 코드(정지 확인 실패 등)는 주의', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('2', { category: 'SAFETY', code: 'STOP_CONFIRM_FAILED', severity: 'INFO', message: 'Go2-A 정지 확인에 실패했습니다.' }),
      ev('1', { category: 'RUN', code: 'NAV_GOAL_REJECTED', severity: 'INFO' })]) }));
    await open('#/history');
    expect(evs().map((r) => r.children[0].textContent)).toEqual(['주의', '주의']);
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
  it('묶음(서버 분류)·로봇·기간 → 요청 매개변수(화면이 따로 거르지 않음)', async () => {
    // 서버가 무엇을 돌려주든 그대로 그린다 — 필터와 다른 분류·로봇의 행도 화면이 지우지 않는다
    serve(signedIn(KIM, { 'GET /events': list([ev('5', { category: 'ACCOUNT', robot_id: 'r-b', message: '서버가 준 행' })]) }));
    await open('#/history');
    const kinds = [...card('묶음').querySelectorAll('button')].map((b) => b.textContent);
    expect(kinds).toEqual(['전체', '안전', '임무', '연결 · 시스템', '지도', '사용자 작업', '조종권', '결재']);
    for (const [name, code] of [['임무', 'RUN'], ['지도', 'ROUTE'], ['연결 · 시스템', 'LINK'], ['조종권', 'LEASE'], ['결재', 'APPROVAL'], ['안전', 'SAFETY'], ['사용자 작업', 'ACCOUNT']]) {
      await click(btn(name, card('묶음')));
      expect(lastQuery()).toEqual({ category: code });
      expect(btn(name, card('묶음'))!.getAttribute('aria-pressed')).toBe('true');
      expect(rows()[0]).toContain('서버가 준 행');
    }
    await click(btn('지도', card('묶음')));
    await setVal($<HTMLSelectElement>('[aria-label="기록"] select')!, 'r-a');
    expect(lastQuery()).toEqual({ category: 'ROUTE', robot_id: 'r-a' });
    await click(btn('7 일', card('기간')));
    const from = new Date(); from.setDate(from.getDate() - 6);
    expect(lastQuery()).toEqual({ category: 'ROUTE', robot_id: 'r-a', from: new Date(`${from.toLocaleDateString('sv')}T00:00:00`).toISOString(), to: new Date(`${new Date().toLocaleDateString('sv')}T23:59:59.999`).toISOString() });
    expect(rows()).toEqual([expect.stringContaining('서버가 준 행')]);
    await click(btn('전체', card('묶음')));
    expect(Object.keys(lastQuery())).toEqual(['robot_id', 'from', 'to']);
  });
  it('필터를 바꾸면 앞 요청의 늦은 답은 버린다', async () => {
    const wait: ((r: Reply) => void)[] = [];
    serve(signedIn(KIM, { 'GET /events': (q) => (q.get('category') ? list([ev('2', { message: '새 필터 결과' })]) : new Promise<Reply>((r) => wait.push(r))) }));
    await open('#/history');
    await click(btn('안전', card('묶음')));
    expect(rows()).toEqual([expect.stringContaining('새 필터 결과')]);
    wait[0](list([ev('1', { message: '옛 필터 결과' })])); await flush();
    expect(rows()).toEqual([expect.stringContaining('새 필터 결과')]);
  });
  it('빈 목록 문구: 필터 없이 0 건 = u11_8 빈 기록 / 필터 있음 = 한 줄', async () => {
    serve(signedIn(KIM));
    await open('#/history');
    expect(card('기록').textContent).toContain('아직 기록이 없습니다');
    expect($('[data-empty="log"]')).not.toBeNull();
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(KIM, { 'GET /events': (q) => (q.get('category') ? list([]) : list([ev('1')])) }));
    await open('#/history');
    await click(btn('결재', card('묶음')));
    expect(card('기록').textContent).toContain('조건에 맞는 기록이 없습니다.');
    expect($('[data-empty="log"]')).toBeNull();
  });
});

// 기간: 목록은 시안 u8_1 오늘 · 7 일 · 30 일, 직접 고르는 기간은 내보내기 창(u8_6) 기간 칸(날짜 칸 yyyy-mm-dd)
describe('기록 탭 · 기간', () => {
  it('오늘 · 7 일 · 30 일 = 오늘 포함 n 일(현지 0 시 ~ 오늘 끝), 다시 누르면 기간 없음', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('1')]) }));
    await open('#/history');
    const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return new Date(`${d.toLocaleDateString('sv')}T00:00:00`).toISOString(); };
    const end = new Date(`${new Date().toLocaleDateString('sv')}T23:59:59.999`).toISOString();
    for (const [name, n] of [['오늘', 0], ['7 일', 6], ['30 일', 29]] as const) {
      await click(btn(name, card('기간')));
      expect(lastQuery()).toEqual({ from: day(n), to: end });
      expect([...card('기간').querySelectorAll('button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent)).toEqual([name]);
    }
    await click(btn('30 일', card('기간')));
    expect(lastQuery()).toEqual({});
    await stopSends();
  });
  it('내보내기 창 기간 칸: 시작 > 끝이면 오류 · 내보내기 잠김, 고치면 그 기간 그대로 CSV(그날 0 시 ~ 끝, 현지)', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:csv'); URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    serve(signedIn(KIM, { 'GET /events': list([ev('1')]), 'GET /events/export.csv': { status: 200, body: 'id,at\n' } }));
    await open('#/history');
    await click($('#n-export'));
    const dlg = card('기록 내보내기'), from = $<HTMLInputElement>('[aria-label="내보낼 기간 시작"]', dlg)!, to = $<HTMLInputElement>('[aria-label="내보낼 기간 끝"]', dlg)!;
    // 시안 꼴 YYYY-MM-DD 글 칸(브라우저 언어 날짜 고르개 아님) · 필터에 기간이 없으면 최근 7 일을 채워 둠
    expect([from.type, to.type, from.placeholder]).toEqual(['text', 'text', 'YYYY-MM-DD']);
    expect([from.value, to.value]).toEqual([WEEK.from, WEEK.to]); expect(dlg.textContent).toContain('· 7 일');
    await setVal(from, '2026-10-05'); await setVal(to, '2026-10-01');
    expect(btn('내보내기', dlg)!.disabled).toBe(true);
    expect(dlg.querySelector('.inp')!.getAttribute('aria-invalid')).toBe('true');
    await setVal(from, '2026-09-30');
    expect(dlg.textContent).toContain('· 2 일');
    await click(btn('내보내기', dlg));
    expect(Object.fromEntries(sent('GET', '/events/export.csv')[0].q)).toEqual({ from: new Date('2026-09-30T00:00:00').toISOString(), to: new Date('2026-10-01T23:59:59.999').toISOString() });
    await stopSends();
  });
});

describe('기록 탭 — 끝낸 시뮬 슬롯 거르기(#99 R2)', () => {
  // 끝낸(IDLE) 슬롯 = 시뮬 + 담당 비움. 관제·조종 목록에서는 빠지지만 지난 시뮬 기록은 로봇별로 거를 수 있어야 한다
  const IDLE: RobotSummary = { ...robot('r-s', '시뮬 슬롯', KIM), simulation: true, owner: null };
  const names = () => [...$<HTMLSelectElement>('[aria-label="기록"] select')!.options].map((o) => o.value);
  for (const [me, want] of [[KIM, ['', 'r-a', 'r-b', 'r-s']], [LEE, ['', 'r-a', 'r-s']]] as const) {
    it(`${me.display_name}: 로봇 거르기에 끝낸 시뮬 슬롯 포함 → robot_id 요청`, async () => {
      serve(signedIn(me, { 'GET /robots': { status: 200, body: { items: [RA, RB, IDLE], next_cursor: null } }, 'GET /events': list([ev('1')]) }));
      await open('#/history');
      expect(names()).toEqual(want);
      await setVal($<HTMLSelectElement>('[aria-label="기록"] select')!, 'r-s');
      expect(lastQuery()).toEqual({ robot_id: 'r-s' });
    });
  }
});

describe('시각 접두', () => {
  const AT = '2026-10-19T23:47:00Z', d = new Date(AT), local = `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`, clk = d.toTimeString().slice(0, 8), day = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  it('UTC 접두·KST 접두·접두 없음 — 사건 목록', async () => {
    serve(signedIn(KIM, { 'GET /events': list([
      ev('3', { at: AT, message: '23:47 김총괄님이 로그인했습니다.' }),          // 지금 서버(UTC 접두)
      ev('2', { at: AT, message: '08:47 박운영님이 로그인했습니다.' }),          // 고친 서버(조직 시간대 접두)
      ev('1', { at: AT, message: 'Go2-7이 12:30 에 연결되었습니다.' }),          // 접두 없음 — 문장 가운데 시각은 그대로
    ]) }));
    await open('#/history');
    expect(evs().map(said)).toEqual(['김총괄님이 로그인했습니다.', '박운영님이 로그인했습니다.', 'Go2-7이 12:30 에 연결되었습니다.']);
    for (const li of evs()) expect(li.querySelector('.tm')!.textContent).toBe(clk);
    expect(card('사건').querySelector('.day')!.getAttribute('data-day')).toContain(day);
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
    const show = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}월 ${d.getDate()}일 ${d.toTimeString().slice(0, 8)}`; };
    const dayOfRow = (r: Element) => { let x = r.previousElementSibling; while (x && !x.classList.contains('day')) x = x.previousElementSibling; return x!.getAttribute('data-day')!.replace(/^.* · /, ''); };
    const at = (r: Element) => `${dayOfRow(r)} ${r.querySelector('.tm')!.textContent}`;
    const late = ev('2', { at: '2026-10-20T05:00:00Z', robot_at: '2026-10-20T01:15:00Z', message: '10:15 Go2-7이 경로를 벗어났습니다.' });
    const skewed = ev('1', { at: '2026-10-20T05:00:00Z', robot_at: '2026-10-21T05:00:00Z', message: '14:00 Go2-7 시계가 앞선 사건' });
    serve(signedIn(KIM, { 'GET /events': list([late, skewed]), 'GET /events/2': { status: 200, body: late } }));
    await open('#/history?event_id=2');
    // 알림에서 연 기록 = 그 사건 자세히(u8_4): 위 칩의 시각 · 날짜, 왼쪽 목록의 시각도 같은 규칙
    const chip = [...card('알림에서 연 기록').querySelectorAll('.st')].find((s) => /\d\d:\d\d:\d\d/.test(s.textContent!))!;
    expect(chip.textContent).toBe(`${new Date('2026-10-20T01:15:00Z').toTimeString().slice(0, 8)}${show('2026-10-20T01:15:00Z').split(' ').slice(0, 2).join(' ')}`);
    expect([...card('사건 목록').querySelectorAll('.sev small')].map((s) => s.textContent!.split(' · ').pop()))
      .toEqual([new Date('2026-10-20T01:15:00Z').toTimeString().slice(0, 5), new Date('2026-10-20T05:00:00Z').toTimeString().slice(0, 5)]);
    await click($('#n-back'));   // 목록으로
    expect(location.hash).toBe('#/history');
    expect(evs().map(at)).toEqual([show('2026-10-20T01:15:00Z'), show('2026-10-20T05:00:00Z')]);
  });
  it('알림 본문도 같은 규칙, 서랍 «최근 사건»도', async () => {
    serve(signedIn(KIM, {
      'GET /notifications': { status: 200, body: { items: [note('1', { body: '23:47 Go2-7과 연결이 끊겼습니다.', created_at: AT }), note('2', { body: 'Go2-7 배터리가 낮습니다.', created_at: AT })], next_cursor: null, unread_count: 2 } },
      'GET /events': list([ev('1', { at: AT, message: '08:47 Go2-7이 연결되었습니다.' })]),
    }));
    await open('#/fleet');
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
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
  it('본문 렌더 예외는 본문 칸 안에서 멈춤 — 머리줄·STOP 그대로, 다른 탭으로 가면 다시 그림', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('1')]) }));
    await open('#/fleet');
    const boom = vi.spyOn(Date.prototype, 'toTimeString').mockImplementation(() => { throw new RangeError('Invalid time value'); });   // 사건 행 시각에서 터짐
    vi.spyOn(console, 'error').mockImplementation(() => {});   // React 가 잡은 예외를 찍는 줄
    await click($('[aria-label="주 메뉴"] [data-href="#/history"]'));
    expect(card('화면 오류').textContent).toContain('이 화면을 그리지 못했습니다');
    expect($('h1')!.textContent).toBe('기록');
    await stopSends();
    boom.mockRestore();
    await click($('[aria-label="주 메뉴"] [data-href="#/fleet"]'));
    expect($('[aria-label="화면 오류"]')).toBeNull();
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
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
    expect(card('알림에서 연 기록').textContent).toContain('알림이 가리킨 계정 사건');
    await click($('#n-back'));
    expect(rows()).toEqual([expect.stringContaining('김총괄님이 로그인했습니다.')]);
    expect([...$('[aria-label="기록"] select')!.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['모든 로봇']);
    expect($('[aria-label="로봇 없음"]')).toBeNull();
    expect($('[data-stop]')).toBeNull();   // 예외는 정지할 로봇이 없을 때만(로봇 0대). 총괄도 로봇이 있으면 STOP
  });
  it('폰: 담당 로봇 0대면 로봇 필터 없이 서버가 주는 내 기록, 알림 링크도', async () => {
    serve(signedIn(PARK, { ...none,
      'GET /events': list([]),
      'GET /events/3': { status: 200, body: ev('3', { category: 'ACCOUNT', robot_id: null, message: '박운영님이 비밀번호를 바꿨습니다.' }) },
    }));
    await open('#/history?event_id=3', true);
    expect(lastQuery()).toEqual({});
    expect(card('기록').textContent).toContain('아직 기록이 없습니다');
    expect(card('기록').textContent).not.toContain('이 로봇의');
    expect(card('알림에서 연 기록').textContent).toContain('박운영님이 비밀번호를 바꿨습니다.');
    stopOk();
  });
});

describe('CSV 내보내기(u8_6 창 → u8_7 줄)', () => {
  let saved: { href: string; download: string }[] = [];
  beforeEach(() => {
    saved = [];
    URL.createObjectURL = vi.fn(() => 'blob:csv');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push({ href: this.href, download: this.download }); });
  });
  const dlg = () => card('기록 내보내기');
  /** 목록 머리 「내보내기」 → 창 → 창 안 「내보내기」 */
  const exportNow = async () => { if (!$('[role="dialog"]')) await click($('#n-export')); await click(btn('내보내기', dlg())); };
  const withRows = (more: Record<string, Route> = {}) => ({ 'GET /events': list([ev('1')]), ...more });
  it('지금 필터 그대로(cursor·limit 없이) 받아 파일로 저장 · 목록 머리에 내려받은 줄(이름 · 크기)', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('2')], 'c1'), 'GET /events/export.csv': { status: 200, body: '﻿id,at\n2,x\n' } }));
    await open('#/history');
    await click(btn('사용자 작업', card('묶음')));
    await setVal($<HTMLSelectElement>('[aria-label="기록"] select')!, 'r-b');
    await exportNow();
    expect(Object.fromEntries(sent('GET', '/events/export.csv')[0].q)).toEqual({ category: 'ACCOUNT', robot_id: 'r-b', ...WEEK_Q() });   // 기간을 안 골랐으면 창이 채운 최근 7 일
    expect(saved).toEqual([{ href: 'blob:csv', download: expect.stringMatching(/^foothold-기록-\d{4}-\d{4}\.csv$/) }]);   // 기간 파일 이름(시작 mmdd-끝 mmdd)
    expect(await ((URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob).text()).toContain('id,at\n2,x');   // 서버 본문 그대로
    expect($('[role="dialog"]')).toBeNull();
    expect($('[data-got]')!.textContent).toMatch(/^내려받음 · foothold-기록-\d{4}-\d{4}\.csv · \d+ B$/);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv');   // 만든 URL 정리(R1)
    await click(btn('닫기', $('[data-hs-main] .tool')!));
    expect($('[data-got]')).toBeNull();
    expect($('#n-export')).not.toBeNull();
  });
  it('Android 앱(UA FootholdApp/) → 받지 않고 «앱에선 내려받기 안 됨» 안내, 파일 없음', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; wv) Chrome/140 Mobile Safari/537.36 FootholdApp/1.1.0-dev');
    serve(signedIn(KIM, withRows({ 'GET /events/export.csv': { status: 200, body: 'id,at\n' } })));
    await open('#/history');
    await exportNow();
    expect(alertText()).toContain('앱에서는 파일을 내려받을 수 없습니다');
    expect(sent('GET', '/events/export.csv')).toHaveLength(0);
    expect(saved).toEqual([]);
  });
  it('429 RATE_LIMITED(다른 내보내기 진행 중) → 기다렸다 다시 하라는 안내, 파일 없음, 단추 되살림', async () => {
    serve(signedIn(KIM, withRows({ 'GET /events/export.csv': err(429, 'RATE_LIMITED', '다른 기록을 내보내는 중입니다. 잠시 뒤 다시 시도하세요.') })));
    await open('#/history');
    await exportNow();
    expect(alertText()).toContain('다른 기록 내보내기가 아직 끝나지 않았습니다. 잠시 뒤 다시 내보내세요.');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(btn('내보내기', dlg())!.disabled).toBe(false);
  });
  it('본문 받다 끊김(200 뒤 blob 실패) → 실패 안내, 파일 없음, 다시 누를 수 있음(검토 P2)', async () => {
    serve(signedIn(KIM, withRows({ 'GET /events/export.csv': { status: 200, body: 'id,at\n' } })));
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, i?: RequestInit) => {
      const r = await real(u, i);
      if (u.includes('export.csv')) r.blob = async () => { throw new TypeError('body stream interrupted'); };
      return r;
    });
    await open('#/history');
    await exportNow();
    expect(alertText()).toContain('내보내지 못했습니다. 서버에 연결하지 못했습니다');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(btn('내보내기', dlg())!.disabled).toBe(false);
    stopOk();
  });
  it('파일 만들기 실패(createObjectURL 예외) → 안내 + 단추 되살림, 만든 URL 은 정리', async () => {
    serve(signedIn(KIM, withRows({ 'GET /events/export.csv': { status: 200, body: 'id,at\n' } })));
    await open('#/history');
    URL.createObjectURL = vi.fn(() => { throw new TypeError('no blob'); });
    await exportNow();
    expect(alertText()).toContain('내보내지 못했습니다. 파일을 만들지 못했습니다. 다시 시도하세요.');
    expect(btn('내보내기', dlg())!.disabled).toBe(false);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();   // 만든 것이 없으면 정리할 것도 없음
    URL.createObjectURL = vi.fn(() => 'blob:csv2');
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => { throw new Error('download blocked'); });
    await exportNow();
    expect(alertText()).toContain('파일을 만들지 못했습니다');
    expect(btn('내보내기', dlg())!.disabled).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:csv2');
  });
  it('400 EXPORT_LIMIT → 기간을 줄이라는 쉬운 안내, 파일 없음', async () => {
    serve(signedIn(KIM, withRows({ 'GET /events/export.csv': err(400, 'EXPORT_LIMIT', '기록이 10,000개를 넘습니다. 기간이나 필터를 좁혀 주세요.') })));
    await open('#/history');
    await exportNow();
    expect(alertText()).toContain('기간을 줄이거나 묶음 · 등급을 골라 다시 내보내세요');
    expect(saved).toEqual([]);
    expect(btn('내보내기', dlg())!.disabled).toBe(false);
  });
  it('네트워크 실패·403 → 무엇이 + 서버 문장', async () => {
    serve(signedIn(KIM, withRows({ 'GET /events/export.csv': () => { throw new TypeError('x'); } })));
    await open('#/history');
    await exportNow();
    expect(alertText()).toContain('내보내지 못했습니다. 서버에 연결하지 못했습니다');
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(LEE, withRows({ 'GET /events/export.csv': err(403, 'FORBIDDEN', '권한이 없습니다.') })));
    await open('#/history');
    await exportNow();
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
    expect([...$('[aria-label="기록"] select')!.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['모든 로봇', 'Go2-A']);
  });
});

describe('사건 문구 다듬기(10-22 QA R3·R4·R9·R10)', () => {
  // 시뮬 로봇 두 대(서버 기본 이름 «시뮬 <id 앞 8자리>»)와 사람이 이름 붙인 시뮬 한 대
  const S1 = { ...robot('628962ca-0000-4000-8000-000000000001', '시뮬 628962ca', LEE), simulation: true };
  const S2 = { ...robot('1a2b3c4d-0000-4000-8000-000000000002', '시뮬 1a2b3c4d', LEE), simulation: true };
  const S3 = { ...robot('ffff0000-0000-4000-8000-000000000003', '내 연습 시뮬', LEE), simulation: true };
  const withSims = (more: Record<string, Route> = {}) => signedIn(KIM, { 'GET /robots': { status: 200, body: { items: [RA, S1, S2, S3], next_cursor: null } }, ...more });
  it('서버가 모르는 로봇 사건 코드 = 한국어 문구(표 밖은 «기타 사건»), 코드 원문은 사건 자세히에만', async () => {
    serve(withSims({ 'GET /events': list([
      ev('2', { category: 'LINK', code: 'PHONE_LEASE_RELEASED', severity: 'INFO', message: '15:03 Go2-A에서 사건 PHONE_LEASE_RELEASED이(가) 기록되었습니다.' }),
      ev('1', { category: 'LINK', code: 'SOMETHING_NEW', severity: 'INFO', message: 'Go2-A에서 사건 SOMETHING_NEW이(가) 기록되었습니다.' })]) }));
    await open('#/history');
    const [a, b] = evs();
    expect(said(a)).toBe('Go2-A: 폰 조종권을 반납했습니다.');
    expect(said(b)).toBe('Go2-A: 기타 사건');
    expect(card('사건').textContent).not.toMatch(/PHONE_LEASE_RELEASED|SOMETHING_NEW/);
    await click(a);
    expect($('[data-code]')!.textContent).toBe('기록 코드 PHONE_LEASE_RELEASED');
    expect($('[data-said]')!.textContent).toBe('Go2-A: 폰 조종권을 반납했습니다.');
  });
  it('시뮬 로봇 16진 id 는 «시뮬 로봇 N»(목록·문장 같은 번호), 사람이 붙인 이름은 그대로, 빈 이유는 «이유 없음»', async () => {
    serve(withSims({ 'GET /events': list([
      ev('2', { message: '김총괄님이 시뮬 628962ca에 시나리오 순찰 1판을 배정했습니다. 이유: 확인되지 않음.' }),
      ev('1', { message: '시뮬 1a2b3c4d 배터리가 부족합니다.' })]) }));
    await open('#/history');
    expect(rows()[0]).toContain('김총괄님이 시뮬 로봇 2에 시나리오 순찰 1판을 배정했습니다. 이유 없음.');
    expect(rows()[1]).toContain('시뮬 로봇 1 배터리가 부족합니다.');
    expect(card('사건').textContent).not.toMatch(/628962ca|1a2b3c4d/);
    expect([...card('기록').querySelectorAll('option')].map((x) => x.textContent).filter((t) => /시뮬/.test(t!))).toEqual(['시뮬 로봇 2', '시뮬 로봇 1', '내 연습 시뮬']);
    await click($('[aria-label="주 메뉴"] [data-href="#/fleet"]'));
    expect([...card('로봇 목록').querySelectorAll('b')].map((x) => x.textContent)).toEqual(['Go2-A']);   // TAB-SPLIT: 로봇 탭은 실기만
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
    expect([...card('사건').querySelectorAll('[data-tile]')].map((l) => l.textContent)).toEqual([expect.stringContaining('Go2-B 사건')]);   // 폰은 타일(U3-04)
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
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    const call = sent('GET', '/events').find((c) => c.q.get('robot_id') === 'r-a')!;
    expect(Object.fromEntries(call.q)).toEqual({ robot_id: 'r-a', limit: '5' });
    expect(card('로봇 상세').textContent).toContain('Go2-A 최근 사건');
    expect(card('로봇 상세').textContent).not.toContain('최근 사건 자리');
  });
  it('정지 확인 실패(서버 INFO)는 서랍에서도 «정상»이 아닌 ▲주의', async () => {
    serve(signedIn(KIM, { 'GET /events': (q) => (q.get('robot_id') === 'r-a' ? list([ev('2', { category: 'SAFETY', code: 'STOP_CONFIRM_FAILED', severity: 'INFO', message: 'Go2-A 정지 확인 실패' })]) : list([])) }));
    await open('#/fleet');
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    const li = $('[aria-label="최근 사건"] li')!;
    expect(li.textContent).toContain('▲주의');
    expect(li.textContent).not.toContain('정상');
    expect(li.closest('details')).not.toBeNull();   // 사건 5개 전체는 접고
    expect($('[data-recent-trouble]')!.closest('details')).toBeNull();   // 문제 사건은 접힌 밖에 늘
    expect($('[data-recent-trouble]')!.textContent).toContain('Go2-A 정지 확인 실패');
  });
  it('잇단 같은 문제는 «최근 문제» 한 줄(시각 범위·N번), 낱낱은 접힌 «최근 사건»에 그대로', async () => {
    const f = (id: string, at: string) => ev(id, { category: 'SAFETY', code: 'STOP_CONFIRM_FAILED', severity: 'INFO', message: 'Go2-A 정지 확인 실패', at });
    serve(signedIn(KIM, { 'GET /events': (q) => (q.get('robot_id') === 'r-a' ? list([f('4', '2026-10-30T08:30:00Z'), f('3', '2026-10-30T08:29:00Z'), f('2', '2026-10-30T08:28:00Z'), f('1', '2026-10-30T08:27:00Z')]) : list([])) }));
    await open('#/fleet');
    await drawer();
    const hot = [...$('[data-recent-trouble]')!.querySelectorAll('li')];
    expect(hot).toHaveLength(1);
    expect(hot[0].querySelector('[data-repeat]')!.textContent).toBe(' · 4번');
    expect(hot[0].textContent).toContain(`${when('2026-10-30T08:27:00Z')}~${when('2026-10-30T08:30:00Z').split(' ')[1]}`);
    expect($('[aria-label="최근 사건"]')!.querySelectorAll('li')).toHaveLength(4);
  });
  it('늦게 온 사건이 섞여도 묶음 범위는 이른~늦은 표시 시각(#327 검토 P2 회귀)', async () => {
    const f = (id: string, at: string, robot_at: string | null) => ev(id, { category: 'SAFETY', code: 'STOP_CONFIRM_FAILED', severity: 'INFO', message: 'Go2-A 정지 확인 실패', at, robot_at });
    // 서버가 받은 순서(at 역순): 첫 줄은 하루 가까이 늦게 온 사건이라 표시 시각이 더 이르다
    serve(signedIn(KIM, { 'GET /events': (q) => (q.get('robot_id') === 'r-a' ? list([f('2', '2026-10-31T08:20:00Z', '2026-10-30T08:29:00Z'), f('1', '2026-10-30T08:40:00Z', null)]) : list([])) }));
    await open('#/fleet');
    await drawer();
    const li = $('[data-recent-trouble] li')!;
    expect(li.textContent).toContain(`${when('2026-10-30T08:29:00Z')}~${when('2026-10-30T08:40:00Z').split(' ')[1]}`);
  });
  it('없으면·범위 밖(404)이면 칸을 숨김(가짜 없음), 다른 실패는 한 줄', async () => {
    serve(signedIn(KIM));
    await open('#/fleet');
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    expect($('[aria-label="최근 사건"]')).toBeNull();
    expect(card('로봇 상세').textContent).not.toContain('최근 사건');
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(KIM, { 'GET /events': err(404, 'NOT_FOUND', '기록을 찾을 수 없습니다.') }));
    await open('#/fleet');
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    expect(card('로봇 상세').textContent).not.toContain('최근 사건');
    act(() => root?.unmount()); root = null; box.remove();
    serve(signedIn(KIM, { 'GET /events': () => { throw new TypeError('x'); } }));
    await open('#/fleet');
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    expect(card('로봇 상세').textContent).toContain('최근 사건을 받지 못했습니다. 서버에 연결하지 못했습니다');
    stopOk();
  });
  it('운영 관리자가 남의 로봇을 고르면 요청하지 않음(요약만 보는 범위)', async () => {
    serve(signedIn(PARK));
    await open('#/fleet');
    await click(fleetRow(box, 'Go2-A'));
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
    expect(bell.querySelector('.badge')!.textContent).toBe('2');
    act(() => { (bell as HTMLDetailsElement).open = true; });
    expect(card('알림 목록').textContent).toContain('알림 7 본문');
    await click([...card('알림 목록').querySelectorAll('li button')][0]);
    expect(sent('POST', '/notifications/read').map((c) => c.body)).toEqual([{ ids: ['7'] }]);
    expect(location.hash).toBe('#/history?event_id=7');
    expect($('h1')!.textContent).toBe('기록');
    expect(card('알림에서 연 기록').textContent).toContain('알림이 가리킨 사건');
    expect(bell.querySelector('.badge')!.textContent).toBe('1');
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
    expect($('[data-bell] .badge')).toBeNull();
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
    expect($('[data-bell] .badge')!.textContent).toBe('1');
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
    expect($('[data-bell] .badge')!.textContent).toBe('1');
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
  it('PHOTO_STORED = 클립 칸에 썸네일(사용자 세션 /photos/{id}/thumbnail), 누르면 자세히에 원본 · 못 받으면 «사진을 불러오지 못함», PHOTO_STORE_FAILED = 실패(사진 없음)', async () => {
    serve(signedIn(KIM, { 'GET /events': list([stored, failed, ev('3')]) }));
    await open('#/history');
    const [a, b, c] = evs();
    expect(a.querySelector<HTMLElement>('[data-clip-cell="photo"]')!.style.backgroundImage).toContain(`/api/v1/photos/${PID}/thumbnail`);   // 같은 출처 쿠키 · 공개 주소·토큰을 주소에 싣지 않음
    expect(b.querySelector('[data-clip-cell]')!.textContent).toBe('사진 저장 실패');
    expect(b.querySelector('[data-lv]')!.getAttribute('data-lv')).toBe('r');   // 실패 = 위험(성공처럼 보이지 않음)
    expect(c.querySelector('[data-clip-cell="photo"]')).toBeNull();   // 다른 사건엔 사진 없음
    await click(a);
    const img = $<HTMLImageElement>('[data-info-pane] img')!;
    expect(img.getAttribute('src')).toBe(`/api/v1/photos/${PID}`);
    act(() => { img.dispatchEvent(new Event('error')); });
    expect($('[data-info-pane] img')).toBeNull();
    expect($('[data-info-pane]')!.textContent).toContain('사진을 불러오지 못함');
    await click($(`[data-sev="p2"]`));
    expect($('[data-info-pane] [data-photo="failed"]')!.textContent).toBe('사진 저장 실패 · 사진 없음');
    expect($('[data-info-pane] img')).toBeNull();
    stopOk();
  });
  it('photo_id 가 없는 PHOTO_STORED 는 그림을 요청하지 않고 «사진을 불러오지 못함», 폰은 고른 알림 칸(시안 u3_3 .clip)에 같은 썸네일', async () => {
    serve(signedIn(PARK, { 'GET /events': list([{ ...stored, robot_id: 'r-b', data: {} }, { ...stored, id: 'p3', robot_id: 'r-b' }]) }));
    await open('#/history', true);
    const [, b] = [...card('사건').querySelectorAll<HTMLElement>('[data-tile]')], det = () => $('.u33 .g.det')!;
    expect(det().querySelector('img')).toBeNull();
    expect(det().textContent).toContain('사진을 불러오지 못함');
    await click(b);
    expect(det().querySelector('[data-photo="thumb"] img')!.getAttribute('src')).toBe(`/api/v1/photos/${PID}/thumbnail`);
    stopOk();
  });
});

// u8_4 사건 자세히(기록만 남은 사건): 시안의 칸 중 서버 /events 응답에 있는 것만(시각 둘 · 등급 · 묶음 · 로봇 · 사람 · 코드). 진행 순서 · 당시 모드는 서버에 값 없음
describe('사건 자세히(u8_4)', () => {
  const AT = '2026-11-26T04:58:12Z', RAT = '2026-11-26T04:58:10Z';
  const two = () => serve(signedIn(KIM, { 'GET /events': list([
    ev('2', { category: 'LEASE', code: 'MODE_CHANGED', severity: 'INFO', at: AT, robot_at: RAT, user_id: 'a1' }),
    ev('1', { category: 'ACCOUNT', code: 'USER_LOGIN', severity: 'INFO', robot_id: null, user_id: 'zz', run_id: 'run-1' })]) }));
  const fact = (k: string) => $(`[data-info-pane] [data-fact="${k}"]`)!.textContent;
  const full = (iso: string) => { const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${d.toTimeString().slice(0, 8)}`; };
  /** 키를 보내고 기본 동작(Space 스크롤 · Enter)을 막았는지 확인 */
  const key = async (el: HTMLElement, k: string) => { let went = true; act(() => { went = el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }); await flush(); expect(went).toBe(false); };
  it('줄을 누르면 그 사건 자세히 · 서버 칸만 · 목록으로 돌아옴', async () => {
    two(); await open('#/history');
    await click(evs()[0].children[3]);   // 줄 어디를 눌러도
    expect($('[data-u8]')!.getAttribute('data-u8')).toBe('event');
    expect([fact('who'), fact('robot-at'), fact('at')]).toEqual(['김총괄', full(RAT), full(AT)]);
    expect([...card('사건').querySelectorAll('.st')].map((s) => s.textContent)).toEqual(['Go2-A실제', `${new Date(RAT).toTimeString().slice(0, 8)}11월 26일`, '모드서버에 값 없음', '조종권묶음']);
    expect(card('사건').querySelector('.lv')!.textContent).toBe('정보');
    expect($('[data-missing="steps"]')!.textContent).toContain('진행 순서는 서버에 값 없음');
    expect($('[data-code]')!.textContent).toBe('기록 코드 MODE_CHANGED');
    expect($('[data-sev="2"]')!.getAttribute('aria-current')).toBe('true');
    await click($('#n-back'));
    expect($('[data-u8]')!.getAttribute('data-u8')).toBe('list');
    expect(rows()).toHaveLength(2);
  });
  it('로봇 시각 없음 · 로봇 없음 · 이름 모르는 사람 · 로봇 보기 없음', async () => {
    two(); await open('#/history');
    await click(evs()[1]);
    expect([fact('robot-at'), fact('who')]).toEqual(['서버에 값 없음', '이름 모름']);
    expect($('#n-robot')).toBeNull();
    expect([...card('사건').querySelectorAll('.st')].map((s) => s.textContent)).not.toContain('Go2-A실제');
  });
  it('줄은 role=button · tabIndex 0, Enter · Space 로 연다 · 왼쪽 목록에서 다른 사건으로', async () => {
    two(); await open('#/history');
    expect([evs()[0].getAttribute('role'), evs()[0].getAttribute('tabindex')]).toEqual(['button', '0']);
    await key(evs()[1], 'Enter');
    expect(fact('who')).toBe('이름 모름');
    await click($('[data-sev="2"]'));
    expect(fact('who')).toBe('김총괄');
    await click($('#n-back'));
    await key(evs()[0], ' ');
    expect(fact('who')).toBe('김총괄');
  });
  it('「로봇 보기」 = 로봇 탭이 그 로봇을 고른 채(U5-07 과 같은 길), 같은 시간대 = 그 로봇의 그날 사건(robot_id · 그날 0 시 ~ 끝)', async () => {
    serve(signedIn(KIM, { 'GET /events': list([ev('2', { robot_id: 'r-b', at: AT })]) }));
    await open('#/history');
    await click(evs()[0]);
    const day = new Date(AT).toLocaleDateString('sv');
    const q = sent('GET', '/events').map((c) => Object.fromEntries(c.q)).find((x) => x.limit === '20')!;
    expect(q).toEqual({ robot_id: 'r-b', from: new Date(`${day}T00:00:00`).toISOString(), to: new Date(`${day}T23:59:59.999`).toISOString(), limit: '20' });
    expect(card('사건').textContent).toContain('Go2-B 로봇 보기');
    await click($('#n-robot'));
    expect(location.hash).toBe('#/fleet');
    expect(card('로봇 목록').querySelector('button[aria-pressed="true"]')!.textContent).toContain('Go2-B');
  });
  it('run_id 있는 사건만 「실행 기록 보기」, 누르면 실행 기록 창', async () => {
    two();
    routes['GET /runs/run-1/history'] = { status: 404, body: { error: { code: 'NOT_FOUND', message: '없음', detail: {} } } };
    await open('#/history');
    await click(evs()[0]);
    expect($('[data-run]')).toBeNull();
    await click($('[data-sev="1"]'));
    await click($('[data-run]'));
    expect($('[role="dialog"][aria-label="실행 기록"]')).not.toBeNull();
    expect(sent('GET', '/runs/run-1/history')).toHaveLength(1);
  });
  it('폰(시안 u3_3)은 펼치지 않고 고른 타일이 오른쪽 칸: 처음은 첫 알림, 누르면 그 알림 · 고른 타일만 aria-pressed', async () => {
    serve(signedIn(LEE, { 'GET /events': list([ev('2', { robot_at: RAT, message: '둘째 사건' }), ev('1', { message: '첫째 사건' })]) }));
    await open('#/history', true);
    const tiles = () => [...card('사건').querySelectorAll<HTMLElement>('[data-tile]')], det = () => $('.u33 .g.det')!;
    expect(card('사건').querySelectorAll('[data-detail]')).toHaveLength(0);
    expect(det().querySelector('.row b')!.textContent).toBe('둘째 사건');
    await click(tiles()[1].querySelector('[data-tile-title]'));
    expect(tiles().map((t) => t.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(det().querySelector('.row b')!.textContent).toBe('첫째 사건');
  });
});

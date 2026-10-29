// W6b 시나리오 배정(01 MS-04, 02 F-MS-05, 05 §6.4 — S5b /assignments). fetch 는 상태를 가진 가짜 서버(배정·Idempotency-Key 재생·권한·409·보관 흉내), WebSocket 은 FakeWS.
// 누구나 바로 ACTIVE(10-27 결재 없음 — 옛 PENDING 줄은 그대로), 남의 로봇 회색 + 이유(403·404 도 같은 문구), 409·보관 문구, 응답 불확실 → «확인 중» + 목록 재조회 판정·같은 키 재전송,
// 해제(PENDING → 결재 취소됨)·해제 불확실, 로봇별 보기, 폰 시나리오 카드(실행 «준비 중» 비활성), 배정 중에도 STOP 이 보이고 눌리는지 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Assignment, AssignmentCreate, RobotSummary, Scenario, User } from '../../../contracts/ts';
import { Root } from '../session';
import { clearPlans } from '../screens/missions';
import { IDLE_SLOT, OUT } from '../screens/assign';
import { FakeWS } from './fakeWs';
import { adminNoStop } from './adminStop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const robot = (id: string, name: string, owner: User): RobotSummary => ({ id, name, model: 'unitree_go2', owner: { id: owner.id, display_name: owner.display_name }, simulation: false,
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] });
const RA = robot('r-a', 'Go2-A', LEE), RB = robot('r-b', 'Go2-B', { ...LEE, id: 'o2', display_name: '박운영' });
/** 끝낸(IDLE) 시뮬 슬롯 — 서버는 담당을 비운 채 /robots 에 남긴다. extra 에 넣은 시험에서만 목록에 */
const IDLE: RobotSummary = { ...robot('r-s', '시뮬 슬롯', LEE), simulation: true, owner: null };
let extra: RobotSummary[] = [];
const scen = (id: string, name: string, p: Partial<Scenario> = {}): Scenario => ({ id, name, waypoints: [], finish: { mode: 'STAY', target: null }, notes: '', number: 1, latest_version: 1, version: 1,
  floor_ids: [], map_version_ids: [], required_devices: [], est_distance_m: 0, created_by: KIM.id, created_at: '2026-10-20T00:00:00Z', version_created_by: KIM.id, version_created_at: '2026-10-20T00:00:00Z', archived_at: null, ...p });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string; q: URLSearchParams; body?: unknown; key?: string };
let calls: Call[] = [], asg: Assignment[] = [], scenarios: Scenario[] = [], n = 0, aps: Record<string, string> = {};
const mk = (p: Partial<Assignment> & Pick<Assignment, 'robot_id' | 'status'>): Assignment => ({ id: `as${++n}`, scenario_id: 's1', scenario_version: 1, memo: '', scenario_name: '1층 순찰',
  robot_name: p.robot_id === 'r-a' ? 'Go2-A' : 'Go2-B', approval_id: p.status === 'PENDING' ? `ap${n}` : null, created_by: KIM.id, created_at: '2026-10-20T01:00:00Z', removed_at: null, ...p });

/** 가짜 서버. over = 경로별 덮어쓰기(앞에서부터 하나씩 — 함수면 real() 로 진짜 처리를 부를 수 있고, 던지면 끊김) */
function serve(me: User, o: { over?: Record<string, (((real: () => Reply) => Reply | Promise<Reply>) | Reply)[]> } = {}) {
  calls = [];
  const receipts = new Map<string, Reply>();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    const body = init.body ? JSON.parse(String(init.body)) : undefined, key = (init.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
    calls.push({ method, path, q, body, key });
    const real = () => route(method, path, q, body, key), queued = o.over?.[`${method} ${path}`]?.shift();
    return json(queued ? (typeof queued === 'function' ? await queued(real) : queued) : real());
  });
  const json = (r: Reply) => new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  const can = (rid: string) => me.role === 'ORG_ADMIN' || [RA, RB].find((r) => r.id === rid)?.owner?.id === me.id;
  function route(method: string, path: string, q: URLSearchParams, body?: AssignmentCreate, key?: string): Reply {
    if (path === '/auth/session') return { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } };
    if (path === '/me') return { status: 200, body: me };
    if (path === '/robots') return { status: 200, body: { items: [RA, RB, ...extra], next_cursor: null } };
    if (path.startsWith('/robots/')) return { status: 200, body: path.endsWith('r-a') ? RA : RB };
    if (path === '/dashboard') return { status: 200, body: { robots_total: 2, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } };
    if (path === '/notifications') return { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } };
    if (path === '/sites') return { status: 200, body: { items: [], next_cursor: null } };
    if (path === '/missions') return { status: 200, body: { items: [], next_cursor: null } };
    if (path === '/scenarios') return { status: 200, body: { items: scenarios.filter((s) => q.get('archived') === 'true' || !s.archived_at), next_cursor: null } };
    let m = path.match(/^\/scenarios\/([^/]+)$/);
    if (m) { const s = scenarios.find((x) => x.id === m![1]); return s ? { status: 200, body: s } : err(404, 'NOT_FOUND', '없음'); }
    if (path === '/assignments' && method === 'GET') return { status: 200, body: { items: asg.filter((a) => !q.get('robot_id') || a.robot_id === q.get('robot_id')), next_cursor: null } };
    if (path === '/assignments' && method === 'POST') {
      if (key && receipts.has(key)) return receipts.get(key)!;   // 같은 키 = 첫 성공 결과 재생
      const s = scenarios.find((x) => x.id === body!.scenario_id)!;
      if (s.archived_at) return err(422, 'SCENARIO_ARCHIVED', '보관된 시나리오는 배정할 수 없습니다.');
      if (!can(body!.robot_id)) return err(403, 'FORBIDDEN', '담당 로봇만 배정하거나 해제할 수 있습니다.');
      if (asg.some((a) => a.robot_id === body!.robot_id && a.scenario_version === body!.scenario_version && a.scenario_id === body!.scenario_id && (a.status === 'ACTIVE' || a.status === 'PENDING')))
        return err(409, 'ASSIGNMENT_EXISTS', '이미 배정되었거나 결재를 기다리는 시나리오 판입니다.');
      const a = mk({ ...body!, scenario_name: s.name, robot_id: body!.robot_id, status: 'ACTIVE', created_by: me.id });
      asg.push(a);
      const r = { status: 201, body: a };
      if (key) receipts.set(key, r);
      return r;
    }
    if ((m = path.match(/^\/approvals\/([^/]+)$/))) return { status: 200, body: { id: m[1], kind: 'SCENARIO_ASSIGNMENT', status: aps[m[1]] ?? 'PENDING' } };
    if ((m = path.match(/^\/assignments\/([^/]+)$/)) && method === 'DELETE') {
      const a = asg.find((x) => x.id === m![1]);
      if (!a) return err(404, 'NOT_FOUND', '배정을 찾을 수 없습니다.');
      if (!can(a.robot_id)) return err(403, 'FORBIDDEN', '담당 로봇만 배정하거나 해제할 수 있습니다.');
      if (a.status === 'PENDING' && a.approval_id) aps[a.approval_id] = 'CANCELED';   // 서버: PENDING 해제 = 결재 CANCELED
      Object.assign(a, { status: 'REMOVED', removed_at: '2026-10-20T02:00:00Z' });
      return { status: 204 };
    }
    return err(404, 'NOT_FOUND', '찾을 수 없습니다.');
  }
}
const posts = () => calls.filter((c) => c.method === 'POST' && c.path === '/assignments');
const lost = () => { throw new TypeError('network'); };

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string, phone = false) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); clearPlans(); asg = []; n = 0; aps = {}; extra = []; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const setVal = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  act(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
  await flush();
};
const panel = () => $('[data-assign]')!;
const text = () => panel().textContent!;
const rowOf = (id: string) => $(`[data-assignment="${id}"]`)!;
/** 임무 탭 시나리오 s1 을 열고 배정 창까지 */
async function openAssign(me: User, o?: Parameters<typeof serve>[1]) {
  serve(me, o);
  await open('#/mission');
  await click($('[data-plan="s1"]'));
  expect(panel()).toBeTruthy();
  await click(btn('로봇에 배정', panel()));
}
const pickRobot = (id: string) => click($(`[data-robot="${id}"]`, panel()));
const memo = () => [...panel().querySelectorAll('label')].find((l) => l.textContent!.startsWith('메모'))!.querySelector('input')!;
const stopOk = async () => {
  if (adminNoStop(box)) return;
  const s = $<HTMLButtonElement>('[data-stop]')!;
  expect(s.disabled).toBe(false);
  act(() => FakeWS.last.open());
  await click(s);
  const sel = $<HTMLSelectElement>('[aria-label="정지할 로봇"]');
  if (sel) { await setVal(sel, 'r-a'); await click(btn('정지', $('[aria-label="정지할 로봇 고르기"]')!)); }
  expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['r-a']);
};

describe('배정 창', () => {
  it('저장 안 한 편집이 있으면 «저장된 판 N 이 배정됩니다», 저장된 대로면 안내 없음', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    await openAssign(KIM);
    expect($('[data-unsaved-assign]')).toBeNull();
    const name = $<HTMLInputElement>('[aria-label="시나리오 편집 칸"] input')!;
    await setVal(name, '1층 순찰 고침');
    expect($('[data-unsaved-assign]')!.textContent).toContain('배정하면 저장된 판 1이 배정됩니다');
    await setVal(name, '1층 순찰');
    expect($('[data-unsaved-assign]')).toBeNull();
  });
  it('총괄: 로봇 고르기·메모 → POST /assignments(Idempotency-Key) → ACTIVE «배정됨», 바로 적용 안내', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    await openAssign(KIM);
    expect(text()).toContain('바로 적용됩니다');
    await pickRobot('r-a');
    await setVal(memo(), ' 아침 순찰 ');
    await click(btn('배정', panel()));
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ scenario_id: 's1', scenario_version: 1, robot_id: 'r-a', memo: '아침 순찰' });
    expect(posts()[0].key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(text()).toContain('Go2-A에 «1층 순찰» 판 1을 배정했습니다. 바로 적용됩니다.');
    expect(rowOf(asg[0].id).textContent).toContain('배정됨');
    expect(rowOf(asg[0].id).textContent).toContain('아침 순찰');
    await stopOk();
  });
  it('운영 관리자: 남의 로봇은 회색 + 이유, 내 로봇 → «배정» 하나로 바로 ACTIVE(결재 요청 단추·«내 요청 보기» 없음)', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    await openAssign(LEE);
    expect(text()).toContain('바로 적용됩니다');
    expect(text()).not.toContain('결재');
    expect(btn('결재 요청', panel())).toBeUndefined();
    const other = $<HTMLButtonElement>('[data-robot="r-b"]', panel())!;
    expect(other.disabled).toBe(true);
    expect($(`#${other.getAttribute('aria-describedby')}`)!.textContent).toBe(OUT);
    await pickRobot('r-a');
    await click(btn('배정', panel()));
    expect(asg[0].status).toBe('ACTIVE');
    expect(text()).toContain('Go2-A에 «1층 순찰» 판 1을 배정했습니다. 바로 적용됩니다.');
    expect(btn('내 요청 보기', panel())).toBeUndefined();
    expect(rowOf(asg[0].id).textContent).toContain('배정됨');
    // 이미 배정된 판 → 그 로봇도 회색 + 이유
    await click(btn('로봇에 배정', panel()));
    expect($<HTMLButtonElement>('[data-robot="r-a"]', panel())!.disabled).toBe(true);
    expect(text()).toContain('이 판이 이미 배정되어 있습니다.');
  });
  it('서버 403·404 = 회색 단추와 같은 문구, 409 = 이미 배정 문구, 보관 422 = 보관 문구', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    await openAssign(KIM, { over: { 'POST /assignments': [err(403, 'FORBIDDEN', '담당 로봇만'), err(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.'),
      err(409, 'ASSIGNMENT_EXISTS', '이미 배정되었거나 결재를 기다리는 시나리오 판입니다.'), err(422, 'SCENARIO_ARCHIVED', '보관된 시나리오는 배정할 수 없습니다.')] } });
    await pickRobot('r-b');
    await click(btn('배정', panel()));
    expect(text()).toContain(OUT);
    await click(btn('로봇에 배정', panel())); await pickRobot('r-b'); await click(btn('배정', panel()));
    expect(text()).toContain(OUT);
    await click(btn('로봇에 배정', panel())); await pickRobot('r-b'); await click(btn('배정', panel()));
    expect(text()).toContain('이 로봇에는 이미 같은 시나리오 판이 배정되어 있거나 결재를 기다리고 있습니다.');
    await click(btn('로봇에 배정', panel())); await pickRobot('r-b'); await click(btn('배정', panel()));
    expect(text()).toContain('보관된 시나리오는 배정할 수 없습니다. 보관되지 않은 시나리오를 고르세요.');
    expect(new Set(posts().map((p) => p.key)).size).toBe(4);   // 시도마다 새 키
    expect(asg).toHaveLength(0);
  });
  it('보관된 시나리오: «로봇에 배정» 회색 + 이유', async () => {
    scenarios = [scen('s1', '1층 순찰', { archived_at: '2026-10-20T03:00:00Z' })];
    serve(KIM);
    await open('#/mission');
    await click($('label input[type="checkbox"]'));   // 보관된 것도 보기
    await click($('[data-plan="s1"]'));
    const b = btn('로봇에 배정', panel())!;
    expect(b.disabled).toBe(true);
    expect($(`#${b.getAttribute('aria-describedby')}`)!.textContent).toBe('보관된 시나리오는 배정할 수 없습니다.');
  });
});

describe('응답 불확실 → 확인 중 → 목록 재조회로 판정', () => {
  /** 시나리오 목록의 «배정된 로봇» 열이 먼저 받는 조직 전체 배정 목록(진짜 처리) — 아래 순서는 배정 창 것부터 */
  const LIST = (real: () => Reply) => real();
  it('처리된 뒤 답이 끊김: «확인 중» → 목록에 새 내 배정 → 성공으로(다시 보내지 않음)', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    await openAssign(KIM, { over: { 'POST /assignments': [(real) => { real(); throw new TypeError('lost'); }], 'GET /assignments': [LIST, { status: 200, body: { items: [], next_cursor: null } }, { status: 200, body: { items: [], next_cursor: null } },
      async (real) => { await gate; return real(); }] } });
    await pickRobot('r-a');
    await click(btn('배정', panel()));
    expect(text()).toContain('확인 중');
    expect($('[data-checking]', panel())).toBeTruthy();
    expect(text()).not.toContain('배정했습니다');   // 추측하지 않음
    await stopOk();   // 확인 중에도 STOP
    release(); await flush();
    expect(text()).toContain('Go2-A에 «1층 순찰» 판 1을 배정했습니다.');
    expect(posts()).toHaveLength(1);
  });
  it('처리 안 된 채 끊김(5xx): 목록에 없음 → 확정 안 함 → «같은 요청 다시 보내기» = 같은 키', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    await openAssign(LEE, { over: { 'POST /assignments': [{ status: 502, body: null }] } });
    await pickRobot('r-a');
    await click(btn('배정', panel()));
    expect(asg).toHaveLength(0);
    expect(text()).toContain('배정이 아직 목록에 없습니다.');
    expect(text()).not.toContain('결재 대기 —');
    await click(btn('같은 요청 다시 보내기', panel()));
    expect(posts()).toHaveLength(2);
    expect(posts()[1].key).toBe(posts()[0].key);
    expect(posts()[1].body).toEqual(posts()[0].body);
    expect(text()).toContain('Go2-A에 «1층 순찰» 판 1을 배정했습니다.');
    // 같은 키를 또 보내도 서버는 첫 결과를 돌려준다(두 번 배정 안 됨)
    expect(asg).toHaveLength(1);
  });
  it('끊김 뒤 처리됐는데 같은 키로 다시 보냄 → 서버 재생, 배정 하나', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    // 확인 목록 조회가 처리 전 상태를 보여 확정 못 함 → 같은 키 재전송 → 재생
    await openAssign(KIM, { over: { 'POST /assignments': [(real) => { real(); throw new TypeError('lost'); }],
      'GET /assignments': [LIST, { status: 200, body: { items: [], next_cursor: null } }, { status: 200, body: { items: [], next_cursor: null } }, { status: 200, body: { items: [], next_cursor: null } }] } });
    await pickRobot('r-a');
    await click(btn('배정', panel()));
    expect(text()).toContain('배정이 아직 목록에 없습니다.');
    await click(btn('같은 요청 다시 보내기', panel()));
    expect(posts().map((p) => p.key)).toEqual([posts()[0].key, posts()[0].key]);
    expect(asg).toHaveLength(1);
    expect(text()).toContain('배정했습니다');
  });
  // PR #50 검토: 멱등 재전송 응답은 «최초» 결과의 재생 — 그새 반려·STALE·해제됐으면 목록의 지금 상태로 안내(PENDING/ACTIVE 단정 0)
  const lostThenEmpty = (): Parameters<typeof serve>[1] => ({ over: { 'POST /assignments': [(real) => { real(); throw new TypeError('lost'); }],
    'GET /assignments': [LIST, (real) => real(), (real) => real(), { status: 200, body: { items: [], next_cursor: null } }] } });
  it('처리된 뒤 끊김 → 확인 전 반려(STALE 도 REJECTED) → 같은 키 재전송 = 재생 PENDING 이어도 «반려됨»으로', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    await openAssign(LEE, lostThenEmpty());
    await pickRobot('r-a');
    await click(btn('배정', panel()));
    expect(text()).toContain('배정이 아직 목록에 없습니다.');
    asg[0].status = 'REJECTED';   // 그새 총괄이 반려(또는 STALE → 서버가 REJECTED 로 정리)
    await click(btn('같은 요청 다시 보내기', panel()));
    expect(posts().map((p) => p.key)).toEqual([posts()[0].key, posts()[0].key]);
    expect(text()).toContain('배정 요청은 처리됐지만 지금은 반려됐습니다');
    expect(text()).not.toContain('결재 대기 —');
    expect(rowOf(asg[0].id).textContent).toContain('반려됨');
  });
  it('처리된 뒤 끊김 → 확인 전 다른 화면에서 해제 → 재전송 = 재생 ACTIVE 이어도 «해제됨»으로', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    await openAssign(KIM, lostThenEmpty());
    await pickRobot('r-a');
    await click(btn('배정', panel()));
    asg[0].status = 'REMOVED';
    await click(btn('같은 요청 다시 보내기', panel()));
    expect(text()).toContain('배정은 처리됐지만 지금은 해제됨 상태입니다');
    expect(text()).not.toContain('바로 적용됩니다');
    expect(rowOf(asg[0].id).textContent).toContain('해제됨');
  });
  it('«다시 확인»도 REJECTED 줄을 내 시도의 결과로 인정', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    await openAssign(LEE, lostThenEmpty());
    await pickRobot('r-a');
    await click(btn('배정', panel()));
    asg[0].status = 'REJECTED';
    await click(btn('다시 확인', panel()));
    expect(text()).toContain('지금은 반려됐습니다');
    expect(posts()).toHaveLength(1);
  });
  it('재전송 응답 뒤 목록 재조회 실패 → 확정 안 함(«확인 중» 유지, PENDING 단정 0)', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    const o = lostThenEmpty()!;
    o.over!['GET /assignments'].push(lost);
    await openAssign(LEE, o);
    await pickRobot('r-a');
    await click(btn('배정', panel()));
    await click(btn('같은 요청 다시 보내기', panel()));
    expect(text()).toContain('배정됐는지 확인하지 못했습니다.');
    expect(text()).not.toContain('결재 대기 —');
    expect(btn('다시 확인', panel())).toBeTruthy();
  });
});

describe('배정 목록·해제', () => {
  it('PENDING 해제 → DELETE → «결재 요청도 취소됐습니다» + 줄에 «결재 취소됨»', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    asg = [mk({ robot_id: 'r-a', status: 'PENDING', created_by: LEE.id, memo: '요청 메모' })];
    serve(LEE);
    await open('#/mission');
    await click($('[data-plan="s1"]'));
    expect(rowOf('as1').textContent).toContain('결재 대기');
    await click(btn('해제', rowOf('as1')));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/assignments/as1']);
    expect(text()).toContain('Go2-A의 «1층 순찰» 배정 요청을 해제했습니다. 결재 요청도 취소됐습니다.');
    expect(rowOf('as1').textContent).toContain('해제됨');
    expect($('[data-canceled]', rowOf('as1'))!.textContent).toBe('결재 취소됨');
    await stopOk();
  });
  it('PENDING 으로 보였지만 그새 승인됨 → 해제 뒤 결재 재조회 = APPROVED → «결재 취소됨» 표시 0', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    asg = [mk({ robot_id: 'r-a', status: 'PENDING', created_by: LEE.id })];
    serve(LEE);
    await open('#/mission'); await click($('[data-plan="s1"]'));
    Object.assign(asg[0], { status: 'ACTIVE' }); aps.ap1 = 'APPROVED';
    await click(btn('해제', rowOf('as1')));
    expect(calls.some((c) => c.path === '/approvals/ap1')).toBe(true);
    expect(text()).toContain('결재는 취소되지 않았습니다(그새 승인됨)');
    expect($('[data-canceled]', panel())).toBeNull();
  });
  it('PENDING 해제 뒤 결재 재조회 실패 → «결재 취소됨» 단정 0', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    asg = [mk({ robot_id: 'r-a', status: 'PENDING', created_by: LEE.id })];
    serve(LEE, { over: { 'GET /approvals/ap1': [lost] } });
    await open('#/mission'); await click($('[data-plan="s1"]'));
    await click(btn('해제', rowOf('as1')));
    expect(text()).toContain('결재 요청이 취소됐는지 확인하지 못했습니다.');
    expect($('[data-canceled]', panel())).toBeNull();
  });
  it('남의 로봇 배정은 해제 회색 + 같은 이유, REMOVED·REJECTED 는 «해제·반려된 것도 보기»에서만', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    asg = [mk({ robot_id: 'r-b', status: 'ACTIVE' }), mk({ robot_id: 'r-a', status: 'REMOVED' }), mk({ robot_id: 'r-a', status: 'REJECTED', scenario_version: 1 })];
    serve(LEE);
    await open('#/mission');
    await click($('[data-plan="s1"]'));
    const b = btn('해제', rowOf('as1'))!;
    expect(b.disabled).toBe(true);
    expect($(`#${b.getAttribute('aria-describedby')}`)!.textContent).toBe(OUT);
    expect($('[data-assignment="as2"]')).toBeNull();
    await click([...panel().querySelectorAll('input[type="checkbox"]')][0]);
    expect(rowOf('as2').textContent).toContain('해제됨');
    expect(rowOf('as3').textContent).toContain('반려됨');
  });
  it('끝낸 시뮬 슬롯에 남은 배정(#99 R1): 총괄은 해제 가능(DELETE), 새 배정 고르기에는 슬롯 없음', async () => {
    scenarios = [scen('s1', '1층 순찰')]; extra = [IDLE];
    asg = [mk({ robot_id: 'r-s', status: 'ACTIVE', robot_name: '시뮬 슬롯' })];
    serve(KIM);
    await open('#/mission');
    await click($('[data-plan="s1"]'));
    const b = btn('해제', rowOf('as1'))!;
    expect(b.disabled).toBe(false);
    expect(b.getAttribute('aria-describedby')).toBeNull();
    await click(btn('로봇에 배정', panel()));
    expect($('[data-robot="r-s"]', panel())).toBeNull();
    expect($('[data-robot="r-a"]', panel())).toBeTruthy();
    await click(btn('해제', rowOf('as1')));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/assignments/as1']);
  });
  it('끝낸 시뮬 슬롯에 남은 배정: 운영 관리자는 회색 + «총괄만» 이유(남의 로봇 문구 아님)', async () => {
    scenarios = [scen('s1', '1층 순찰')]; extra = [IDLE];
    asg = [mk({ robot_id: 'r-s', status: 'ACTIVE', robot_name: '시뮬 슬롯' })];
    serve(LEE);
    await open('#/mission');
    await click($('[data-plan="s1"]'));
    const b = btn('해제', rowOf('as1'))!;
    expect(b.disabled).toBe(true);
    expect($(`#${b.getAttribute('aria-describedby')}`)!.textContent).toBe(IDLE_SLOT);
  });
  it('해제 응답 끊김 → «확인 중» → 목록에서 REMOVED 면 해제로', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    asg = [mk({ robot_id: 'r-a', status: 'ACTIVE' })];
    await (async () => { serve(KIM, { over: { 'DELETE /assignments/as1': [(real) => { real(); throw new TypeError('lost'); }] } }); await open('#/mission'); await click($('[data-plan="s1"]')); })();
    await click(btn('해제', rowOf('as1')));
    expect(text()).toContain('Go2-A에서 «1층 순찰» 판 1 배정을 해제했습니다.');
  });
  it('해제 응답 끊김인데 목록이 아직 ACTIVE → 확정 안 함 + 다시 누르라는 안내', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    asg = [mk({ robot_id: 'r-a', status: 'ACTIVE' })];
    serve(KIM, { over: { 'DELETE /assignments/as1': [lost] } });
    await open('#/mission'); await click($('[data-plan="s1"]'));
    await click(btn('해제', rowOf('as1')));
    expect(text()).toContain('해제가 확인되지 않았습니다(지금 배정됨).');
    expect(asg[0].status).toBe('ACTIVE');
  });
  it('로봇별 보기 = GET /assignments?robot_id=', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    asg = [mk({ robot_id: 'r-a', status: 'ACTIVE' }), mk({ robot_id: 'r-a', status: 'ACTIVE', scenario_id: 's9', scenario_name: '2층 점검' }), mk({ robot_id: 'r-b', status: 'ACTIVE' })];
    serve(KIM);
    await open('#/mission'); await click($('[data-plan="s1"]'));
    expect([...panel().querySelectorAll('[data-assignment]')].map((x) => x.getAttribute('data-assignment'))).toEqual(['as1', 'as3']);
    await setVal($<HTMLSelectElement>('[aria-label="배정 보기"]')!, 'r-a');
    expect(calls.filter((c) => c.path === '/assignments').slice(-1)[0].q.get('robot_id')).toBe('r-a');
    expect(text()).toContain('2층 점검 · 판 1');
    expect($('[data-assignment="as3"]')).toBeNull();
  });
});

describe('관제 서랍 [배정]', () => {
  it('로봇 상세 [배정] → 임무 탭 시나리오 고르면 같은 배정 창이 그 로봇을 고른 채 열림, 남의 로봇은 회색 + 이유', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    serve(LEE);
    await open('#/fleet');
    await click([...$('[aria-label="로봇 목록"]')!.querySelectorAll('button')].find((b) => b.textContent!.includes('Go2-B')));
    const other = $<HTMLButtonElement>('[data-assign-robot]')!;
    expect(other.disabled).toBe(true);
    expect($(`#${other.getAttribute('aria-describedby')}`)!.textContent).toBe(OUT);
    await click([...$('[aria-label="로봇 목록"]')!.querySelectorAll('button')].find((b) => b.textContent!.includes('Go2-A')));
    await click($('[data-assign-robot]'));
    expect(location.hash).toBe('#/mission');
    expect(box.textContent).toContain('Go2-A에 배정할 시나리오를 고르세요');
    await click($('[data-plan="s1"]'));
    expect($('[aria-label="배정 창"]', panel())).toBeTruthy();
    expect($('[data-robot="r-a"]', panel())!.getAttribute('aria-pressed')).toBe('true');
    await click(btn('배정', panel()));
    expect(posts()[0].body).toMatchObject({ scenario_id: 's1', robot_id: 'r-a' });
    expect(text()).toContain('Go2-A에 «1층 순찰» 판 1을 배정했습니다.');
  });
});

describe('폰 시나리오 카드', () => {
  it('내 로봇에 배정된 시나리오(ACTIVE·결재 대기)만 카드, 실행은 «준비 중» 비활성, STOP 그대로', async () => {
    scenarios = [scen('s1', '1층 순찰')];
    asg = [mk({ robot_id: 'r-a', status: 'ACTIVE' }), mk({ robot_id: 'r-a', status: 'PENDING', scenario_id: 's2', scenario_name: '2층 점검', scenario_version: 3 }), mk({ robot_id: 'r-a', status: 'REMOVED', scenario_name: '옛 순찰' })];
    serve(LEE);
    await open('#/drive/r-a', true);
    await click([...$('[aria-label="조종 메뉴"]')!.querySelectorAll('button')].find((b) => b.textContent === '시나리오'));
    const sheet = $('[data-sheet]')!;
    expect(sheet.textContent).toContain('배정된 시나리오');
    expect(calls.filter((c) => c.path === '/assignments').slice(-1)[0].q.get('robot_id')).toBe('r-a');
    const cards = [...sheet.querySelectorAll('[data-card]')];
    expect(cards.map((c) => c.querySelector('h2')!.textContent)).toEqual(['1층 순찰', '2층 점검']);
    expect(cards[1].textContent).toContain('결재 대기');
    expect(cards[1].textContent).toContain('판 3');
    for (const c of cards) { const b = c.querySelector('button')!; expect(b.disabled).toBe(true); expect(b.textContent).toContain('준비 중'); }
    expect(sheet.textContent).not.toContain('옛 순찰');
    await stopOk();
  });
  it('배정 0 = 없다는 안내', async () => {
    serve(LEE);
    await open('#/drive/r-a', true);
    await click([...$('[aria-label="조종 메뉴"]')!.querySelectorAll('button')].find((b) => b.textContent === '시나리오'));
    expect($('[data-sheet]')!.textContent).toContain('이 로봇에 배정된 시나리오가 없습니다.');
  });
});

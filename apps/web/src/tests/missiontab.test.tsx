// 임무 탭(W2 · U6-01 · U6-03 · U6-05): 탭 열림 · 옛 주소 → 임무 탭에서 그 임무 고름 · 계약 없는 칸은 «준비 중»(숫자 없음) · 금지 구역 겹침 · 미리 확인 · 편집(목록 ↔ 노드) · 편집 중 떠날 때 확인
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Estimate, MapVersion, Mission, RobotAvailability, Scenario, ScheduleSlot } from '../../../contracts/ts';
import { App } from '../App';
import { leaving, oldScenario, tabFromHash } from '../menu';
import { clearPlans } from '../screens/missions';
import { keptMission } from '../screens/missiontab';
import u6AppCss from '../screens/missionsu6.app.css?raw';
import { ticks } from '../screens/missionsu6run';
import { USERS, type Robot } from './fixtures';
import { FakeWS, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 지도 100×80 칸, 0.05 m, origin (-1, -2) → x -1~4 m, y -2~2 m. 접근 금지 x 2~3
const V1: MapVersion = { upload_id: 'up-v1', id: 'v1', floor_id: 'f1', number: 1, base_version_id: null, copied_from_id: null, status: 'APPROVED', image_sha256: 'ab'.repeat(32),
  width: 100, height: 80, resolution: 0.05, origin: [-1, -2, 0], reason: '처음', source: 'IMPORT', created_by: 'u-kim', created_at: '2026-11-28T00:00:00Z',
  features: { zones: [{ id: 'z1', type: 'NO_GO', name: '탱크', polygon: [[2, -2], [3, -2], [3, 2], [2, 2]] }], waypoints: [], connectors: [], edits: [] } } as MapVersion;
const head = { number: 1, latest_version: 1, version: 1, created_by: 'u-kim', created_at: '2026-11-28T00:00:00Z', version_created_by: 'u-kim', version_created_at: '2026-11-28T00:00:00Z', archived_at: null };
const M1: Mission = { ...head, id: 'm1', name: '게이지 읽기', steps: [{ action: 'PHOTO', params: { camera: 'rgb' } }], required_devices: ['CAMERA_RGB'] };
const wp = (x: number, y: number, name?: string) => ({ floor_id: 'f1', map_version_id: 'v1', x, y, mission_id: 'm1', mission_version: 1, name: name ?? null });
const scen = (id: string, name: string, waypoints: ReturnType<typeof wp>[], extra: Partial<Scenario> = {}): Scenario => ({ ...head, id, name, waypoints, finish: { mode: 'RETURN_TO_START', target: null }, notes: '',
  floor_ids: ['f1'], map_version_ids: ['v1'], required_devices: [], est_distance_m: 1280, ...extra });
// s1 = 1→2 구간이 금지 구역(x 2~3)을 지남, s2 = 금지 구역 밖, s3 = 휴지통(목록 밖 · 옛 주소로만)
const S1 = scen('s1', '공정 순찰 A', [wp(0, 0, '펌프'), wp(3.5, 0, '게이지')]);
const S2 = scen('s2', '가스 점검', [wp(0, 1), wp(1, 1)], { finish: { mode: 'STAY', target: null }, est_distance_m: 30 });
const S3 = scen('s3', '지난 임무', [wp(0, 0)], { archived_at: '2026-11-27T00:00:00Z' });
const ALL = [S1, S2, S3];

let calls: { method: string; path: string; q: URLSearchParams; body?: Record<string, unknown>; key?: string | null }[] = [];
/** POST /assignments 답(시험이 바꿈). 기본 = 그 로봇 ACTIVE */
let assignReply: (b: Record<string, unknown>) => Promise<Response> = async (b) => new Response(JSON.stringify({ id: `new-${b.robot_id}`, robot_id: b.robot_id, scenario_id: b.scenario_id, scenario_version: b.scenario_version, status: 'ACTIVE' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
/** 오늘 로컬 h:m 의 ISO */
const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const slot = (id: string, robot_id: string, kind: ScheduleSlot['kind'], h0: number, m0: number, h1: number, m1: number, scenario_id: string | null = 's2'): ScheduleSlot =>
  ({ id, robot_id, scenario_id, scenario_version: scenario_id ? 1 : null, gait: null, start: at(h0, m0), end: at(h1, m1), kind, assignment_id: null, memo: '', created_by: 'u-kim', created_at: at(0), run_state: null, run_id: null, run_code: null, confirmed_by: null });
const AV = (robot_id: string, robot_name: string, state: RobotAvailability['state'], battery_pct: number | null, x: Partial<RobotAvailability> = {}): RobotAvailability =>
  ({ robot_id, robot_name, state, busy_until: null, busy_slot_id: null, busy_label: null, battery_pct, demo: false, sim: false, location_label: null, ...x });
const EST: Estimate = { length_m: 1280, walk_s: 1260, task_s: 360, eta: at(14, 27), margin_s: 180, end_battery_pct: 54.4, estimate_source: 'TABLE_UNMEASURED' };
let srv: { slots: ScheduleSlot[]; avail: RobotAvailability[]; est: Estimate | null; conflict: string[] | null };   // est null = 예상 오류(503)
const fresh = () => { srv = { slots: [slot('sl1', 'r1', 'CONFIRMED', 9, 0, 10, 0), slot('sl2', 'r2', 'DRAFT', 13, 0, 13, 30), slot('sl3', 'r1', 'BATTERY_SWAP', 15, 0, 15, 20, null)],
  avail: [AV('r1', 'K-01', 'FREE', 86), AV('r2', '시뮬 Go2', 'FREE', null, { sim: true })], est: EST, conflict: null }; };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
function serve() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, q: new URLSearchParams(qs), body, key: new Headers(init.headers).get('Idempotency-Key') });
    if (method === 'POST' && path === '/assignments') return assignReply(body!);
    const fail = (status: number, code: string, detail = {}) => new Response(JSON.stringify({ error: { code, message: code === 'SCHEDULE_CONFLICT' ? '같은 로봇의 다른 일정과 겹칩니다.' : '오류', detail } }), { status });
    if (path === '/schedule') return ok({ day: new URLSearchParams(qs).get('day'), tz: new URLSearchParams(qs).get('tz'), slots: srv.slots });
    if (path === '/robots/availability') return ok({ items: srv.avail });
    if (method === 'POST' && path === '/estimates') return srv.est ? ok(srv.est) : fail(503, 'UNAVAILABLE');
    if (method === 'POST' && path === '/schedule/slots') {
      if (srv.conflict) return fail(409, 'SCHEDULE_CONFLICT', { slot_ids: srv.conflict });
      const x = { ...body, id: 'new1', scenario_version: body.scenario_version ?? null, assignment_id: null, memo: '', created_by: 'u-kim', created_at: at(0), run_state: null, run_id: null, run_code: null, confirmed_by: null } as ScheduleSlot;
      srv.slots = [...srv.slots, x]; return new Response(JSON.stringify(x), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/sites') return ok({ items: [{ id: 'st', name: '공장', purpose: 'REAL', buildings: [{ id: 'b1', site_id: 'st', name: '본동', floors: [{ id: 'f1', building_id: 'b1', name: '1층', level: 1, approved_version_id: 'v1', pending_count: 0 }] }] }], next_cursor: null });
    if (path === '/map-versions/v1') return ok(V1);
    if (path === '/map-versions/v1/zone-grid') {
      const cells = [];
      for (let r = 0; r < 80; r++) for (let c = 0; c < 100; c++) { const x = -1 + (c + 0.5) * 0.05; if (x >= 2 && x <= 3) cells.push({ index: r * 100 + c, no_go: true, slow: false, max_speed_mps: null }); }
      return ok({ format_version: 1, map_version_id: 'v1', origin: V1.origin, resolution: 0.05, width: 100, height: 80, row_order: 'TOP_TO_BOTTOM', cursor: 0, cells, next_cursor: null });
    }
    if (path === '/scenarios') return ok({ items: ALL, next_cursor: null });
    if (path === '/missions') return ok({ items: [M1], next_cursor: null });
    const m = path.match(/^\/scenarios\/(s\d)$/);
    if (m && method === 'PUT') { const x = ALL.find((s) => s.id === m[1])!; return ok({ ...x, ...body, version: x.version + 1 }); }
    if (m) { const x = ALL.find((s) => s.id === m[1]); return x ? ok(x) : new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: 404 }); }
    if (method === 'POST' && path === '/scenarios/preview') return ok({ reachable: true, points: [], segments: [], floor_ids: ['f1'], map_version_ids: ['v1'], required_devices: [], est_distance_m: 3, distance_note: '' });
    if (path === '/actions') return ok([]);
    if (path === '/assignments') { const rid = new URLSearchParams(qs).get('robot_id');   // 서버처럼 robot_id 로 거른다
      return ok({ items: [{ id: 'as1', robot_id: 'r2', scenario_id: 's1', scenario_version: 1, status: 'ACTIVE' }, { id: 'as2', robot_id: 'r1', scenario_id: 's1', scenario_version: 1, status: 'REMOVED' },
      { id: 'as3', robot_id: 'r1', scenario_id: 's2', scenario_version: 1, status: 'ACTIVE' }].filter((x) => !rid || x.robot_id === rid), next_cursor: null }); }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: 404 });
  });
}

const ROBOTS: Robot[] = [
  { id: 'r1', name: 'K-01', owner: 'u-lee', ownerName: '이OO', battery: 86, online: true, seenAt: '14:00:00', status: 'IDLE' },
  { id: 'r2', name: '시뮬 Go2', owner: 'u-lee', ownerName: '이OO', battery: null, online: true, seenAt: '14:00:00', status: 'IDLE', sim: true },
  { id: 'r3', name: 'K-03', owner: 'u-lee', ownerName: '이OO', battery: null, online: false, seenAt: '', status: null },   // 한 번도 연결된 적 없음
];
let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function mount(hash: string, who = 'u-kim', robots = ROBOTS) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  if (!srv) fresh();
  serve();
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === who)} robots={robots} />); });
  await flush(); await flush();
}
afterEach(() => { assignReply = async (b) => new Response(JSON.stringify({ id: `new-${b.robot_id}`, robot_id: b.robot_id, scenario_id: b.scenario_id, scenario_version: b.scenario_version, status: 'ACTIVE' }), { status: 201, headers: { 'Content-Type': 'application/json' } }); act(() => root?.unmount()); root = null; box?.remove(); clearPlans(); keptMission.sel = ''; fresh(); leaving.ask = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const last = <T,>(l: T[]) => l[l.length - 1];
/** 시작 · 마감 칸에 HH:MM 넣기 */
const setTime = async (k: 'start' | 'end', v: string) => { const inp = $<HTMLInputElement>(`[data-${k}]`)!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inp, v); inp.dispatchEvent(new Event('input', { bubbles: true })); }); await flush(); };
const picked = () => $$('[data-mission][aria-pressed="true"]').map((b) => b.dataset.mission);
const click = async (e: Element | null) => { expect(e).toBeTruthy(); act(() => (e as HTMLElement).click()); await flush(); };

describe('임무 탭(W2)', () => {
  // 시계: 오늘 08:05(지난 시각 · 처음 값 판정이 돌리는 때에 따라 바뀌지 않게). 타이머는 진짜 그대로
  beforeEach(() => { const d = new Date(); d.setHours(8, 5, 0, 0); vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: d }); });
  afterEach(() => { vi.useRealTimers(); });
  it('주소 · 메뉴: #/missions 와 옛 #/mission 은 임무 탭, oldScenario 는 고를 id', () => {
    expect(tabFromHash('#/missions', false)).toBe('missions');
    expect(tabFromHash('#/mission', false)).toBe('missions');
    expect(tabFromHash('#/mission/s2', false)).toBe('missions');
    expect(oldScenario('#/mission/s2')).toBe('s2');
    expect(oldScenario('#/mission?scenario_id=s2')).toBe('s2');
    expect(oldScenario('#/map')).toBeNull();
  });

  // 시안 u15_2: 배정 · 실행은 오늘 일정 칸을 눌러 «실제 로봇 시작 전 점검» 창에서. 로봇은 그 칸의 로봇(sl2 = 시뮬 r2 · s2 배정 없음, sl1 = 실기 r1 · s2 ACTIVE)
  const preflight = async (slotId: string) => { await click($(`[data-slot="${slotId}"]`)); await click($('[data-preflight]')); expect($('[data-preflight-box]')).toBeTruthy(); };
  it('u6_8: 오늘 일정 칸을 누르면 오른쪽에 그 칸의 시각 · 로봇을 읽기로 보이고 「새로 넣기 ›」 로 돌아감', async () => {
    await mount('#/missions');
    await click($('[data-slot="sl1"]'));
    expect($('[data-slot-time="start"]')!.textContent).toBe('09:00'); expect($('[data-slot-time="end"]')!.textContent).toBe('10:00');
    const r1 = $<HTMLButtonElement>('[data-robot="r1"]');
    if (r1) { expect(r1.getAttribute('aria-pressed')).toBe('true'); expect(r1.disabled).toBe(true); }
    expect($('[data-preflight]')).toBeTruthy();
    await click($('[data-unpick]'));
    expect($('[data-slot-time="start"]')).toBeNull(); expect($('[data-schedule-add]')).toBeTruthy();
  });
  it('로봇에 배정(u15_2 점검 창): 이미 배정된 로봇은 배정 단추 없음 · POST /assignments(멱등 key) · 답 전엔 넘어가지 않음 · 답 뒤 다음 관문(조종권 잡기)', async () => {
    let done!: () => void;
    assignReply = (b) => new Promise((ok) => { done = () => ok(new Response(JSON.stringify({ id: 'as9', robot_id: b.robot_id, scenario_id: b.scenario_id, scenario_version: b.scenario_version, status: 'ACTIVE' }), { status: 201, headers: { 'Content-Type': 'application/json' } })); });
    await mount('#/missions');
    await preflight('sl1');   // r1 은 s2 에 이미 ACTIVE(as3) → 배정 단추 없음, 실기라 실행 못 함 까닭
    expect($('[data-preflight-act]')).toBeNull();
    expect($('[data-preflight-why]')!.textContent).toContain('실기는 아직 화면에서 임무를 실행할 수 없습니다');
    expect($<HTMLButtonElement>('[data-preflight-go]')!.disabled).toBe(true);
    await click($('[data-preflight-cancel]'));
    await preflight('sl2');   // r2(시뮬) · s2 배정 없음
    expect($('[data-preflight-act]')!.textContent).toContain('이 로봇에 배정');
    await click($('[data-preflight-act]'));
    const post = calls.filter((c) => c.method === 'POST' && c.path === '/assignments');
    expect(post).toHaveLength(1);
    expect(post[0].body).toEqual({ scenario_id: 's2', scenario_version: 1, robot_id: 'r2' });
    expect(post[0].key).toMatch(/^[0-9a-f-]{36}$/);
    expect($('[data-preflight-why]')!.textContent).toContain('배정이 없습니다');   // 답 전엔 그대로
    await act(async () => { done(); }); await flush();
    expect($('[data-preflight-act]')!.textContent).toContain('조종권 잡기');   // 배정 뒤 다음 관문
    expect($<HTMLButtonElement>('[data-preflight-go]')!.disabled).toBe(true);
  });
  it('로봇에 배정: 서버 거절(409 ASSIGNMENT_EXISTS)은 문구 한 줄 · 다음 관문으로 넘어가지 않음 · 답 못 받으면 다시 보낼 때 같은 key', async () => {
    let n = 0;
    assignReply = async () => (++n === 1 ? Promise.reject(new TypeError('network')) : new Response(JSON.stringify({ error: { code: 'ASSIGNMENT_EXISTS', message: '이미 배정되었거나 결재를 기다리는 시나리오 판입니다.', detail: {} } }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    await mount('#/missions');
    await preflight('sl2');
    await click($('[data-preflight-act]'));
    await click($('[data-preflight-act]'));
    const post = calls.filter((c) => c.method === 'POST' && c.path === '/assignments');
    expect(post).toHaveLength(2);
    expect(post[1].key).toBe(post[0].key);   // 같은 시도의 다시 보내기
    expect($('[data-preflight-why]')!.textContent).toContain('이미 배정되었거나 결재를 기다리는 시나리오 판입니다.');
    expect($('[data-preflight-act]')!.textContent).toContain('이 로봇에 배정');
  });
  it('로봇에 배정: 담당 로봇이 아닌 운영 관리자는 배정 단추 대신 까닭 한 줄 · 보내지 않음', async () => {
    await mount('#/missions', 'u-park');
    await preflight('sl2');
    expect($('[data-preflight-act]')).toBeNull();
    expect($('[data-preflight-why]')!.textContent).toContain('배정은 담당 로봇에만 할 수 있습니다');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/assignments')).toBe(false);
  });
  it('지금 실행(u15_2): 점검 줄 넷(연결 · 조종권 · 로봇 상태 · 시작 자리) · 조종권 없으면 «조종권 잡기»로 이음 · 취소 = 창 닫힘(u6_8)', async () => {
    fresh(); srv.slots = [...srv.slots, slot('sl9', 'r2', 'CONFIRMED', 11, 0, 11, 30, 's1')];   // r2 · s1 ACTIVE(as1)
    await mount('#/missions');
    await preflight('sl9');
    expect($$('[data-ck]').map((e) => e.dataset.ck)).toEqual(['link', 'lease', 'state', 'start']);
    expect($('[data-ck="lease"]')!.dataset.ok).toBe('false');
    expect($('[data-preflight-act]')!.textContent).toContain('조종권 잡기');
    expect($<HTMLButtonElement>('[data-preflight-go]')!.disabled).toBe(true);
    await click($('[data-preflight-cancel]'));
    expect($('[data-preflight-box]')).toBeNull();
    expect($('[data-slot="sl9"]')!.className).toContain('u6-made');   // 누른 칸 그대로(u6_8)
  });
  it('탭 열림: 세 칸(목록 · 지도 · 일정 칸) + 오늘 일정, 첫 임무를 펼쳐 할 일 번호와 끝 동작', async () => {
    await mount('#/missions');
    expect($('h1')!.textContent).toBe('임무');
    expect($('[aria-label="주 메뉴"] [aria-current="page"]')!.getAttribute('data-href')).toBe('#/missions');
    expect($('[aria-label="임무 목록"]')).toBeTruthy(); expect($('[aria-label="임무 지도"]')).toBeTruthy();
    expect($('[aria-label="일정에 추가"]')).toBeTruthy(); expect($('[aria-label="오늘 일정"]')).toBeTruthy();
    expect($$('[data-mission]').map((b) => b.dataset.mission)).toEqual(['s1', 's2']);   // 휴지통 것은 목록 밖
    expect(picked()).toEqual(['s1']);
    expect($$('[data-step-no]').map((l) => l.textContent)).toEqual(['1게이지 읽기펌프', '2게이지 읽기게이지']);
    expect($('[data-finish-mode]')!.textContent).toBe('시작 지점으로 복귀');
    // 임무 이름은 왼쪽 목록과 오른쪽 칸 제목 두 곳만
    expect($('[data-side-name]')!.textContent).toBe('공정 순찰 A');
    expect(box.textContent!.split('공정 순찰 A').length - 1).toBe(2);
    // 로봇 목록 · 배터리 · 실기/시뮬 = 지금 자료
    const rb = $$('[data-robot]');
    expect(rb.map((b) => b.dataset.robot)).toEqual(['r1', 'r2']);
    expect(rb[0].textContent).toContain('실제'); expect(rb[0].textContent).toContain('86 %');   // 시안 글 «실제 · … 86 %»
    expect(rb[1].textContent).toContain('시뮬');
    await click($('[data-mission="s2"]'));
    expect(picked()).toEqual(['s2']); expect($('[data-side-name]')!.textContent).toBe('가스 점검');
  });

  it.each(['#/mission/s2', '#/mission?scenario_id=s2', '#/missions/s2'])('옛 주소 %s → 임무 탭에서 그 임무를 고름', async (h) => {
    await mount(h);
    expect($('h1')!.textContent).toBe('임무');
    expect(location.hash).toBe('#/missions');
    expect(picked()).toEqual(['s2']);
  });

  it('옛 주소가 휴지통 임무를 가리키면 목록 맨 위에 «휴지통»으로 따로 보이고, 없는 id 면 한 줄 알림', async () => {
    await mount('#/mission/s3');
    expect(picked()).toEqual(['s3']);
    expect($('[data-mission="s3"] [data-trash]')).toBeTruthy();
    act(() => root?.unmount()); root = null; box.remove();
    await mount('#/mission/s404');
    expect($('[data-lost]')!.textContent).toContain('찾을 수 없습니다');
  });

  it('탭이 열린 채 옛 주소로 바뀌어도 그 임무를 고른다(hashchange)', async () => {
    await mount('#/missions');
    expect(picked()).toEqual(['s1']);
    act(() => { location.hash = '#/mission/s2'; window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: 'http://x/#/missions', newURL: 'http://x/#/mission/s2' })); });
    await flush(); await flush();
    expect(picked()).toEqual(['s2']);
  });

  it('가용(GET /robots/availability · 고른 시작~마감): 서버 상태 그대로 · 바쁨은 까닭 + 못 고름 · 연결 전/끊김은 관제와 같은 판정 · 충전 중도 그림', async () => {
    fresh();
    srv.avail = [AV('r1', 'K-01', 'FREE', 86), AV('r2', '시뮬 Go2', 'BUSY', 74, { sim: true, busy_label: '가스 점검', busy_until: at(14, 30) }),
      AV('r3', 'K-03', 'OFFLINE', null), AV('r4', 'K-04', 'CHARGING', 40)];
    await mount('#/missions');
    // 실시간 첫 값: r3 = 한 번도 연결된 적 없음(관제 탭과 같은 들어옴)
    act(() => { FakeWS.last.open(); FakeWS.last.recv(state('r1')); FakeWS.last.recv(state('r3', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    await flush();
    const q = last(calls.filter((c) => c.path === '/robots/availability'))!.q;
    expect(new Date(q.get('end')!).getTime() - new Date(q.get('start')!).getTime()).toBeGreaterThan(0);
    const row = (id: string) => $<HTMLButtonElement>(`[data-robot="${id}"]`)!;
    expect($$('[data-robot]').map((b) => b.dataset.robot)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(row('r1').disabled).toBe(false); expect(row('r1').textContent).toContain('비어 있음'); expect(row('r1').textContent).toContain('86 %');
    expect(row('r2').disabled).toBe(true); expect(row('r2').textContent).toContain('가스 점검'); expect(row('r2').textContent).toContain('14:30까지');
    expect(row('r3').disabled).toBe(true); expect(row('r3').textContent).toContain('연결 전');   // 한 번도 연결된 적 없는 로봇(관제 칩과 같은 robotStatus)
    expect(row('r4').disabled).toBe(false); expect(row('r4').textContent).toContain('충전 중');
    // 시각을 바꾸면 그 시각으로 다시 묻는다
    await setTime('end', '23:50'); await setTime('start', '09:30');
    expect(new Date(last(calls.filter((c) => c.path === '/robots/availability'))!.q.get('start')!).getTime()).toBe(new Date(at(9, 30)).getTime());
  });

  it('예상(POST /estimates): 로봇 · 걷기 모드를 고르기 전엔 숫자 없음 · 고르면 예상 끝 · 여유 · 끝 배터리 · 걷기 + 할 일, 표 값이면 «추정», 여유 null = «다음 일정 없음»', async () => {
    await mount('#/missions');
    for (const e of $$('[data-est]')) expect(e.textContent).toBe('없음');
    expect(calls.filter((c) => c.path === '/estimates')).toEqual([]);
    expect($('[data-est-why]')!.textContent).toContain('로봇과 걷기 모드를 고르면');
    await click($('[data-robot="r1"]'));
    expect(calls.filter((c) => c.path === '/estimates')).toEqual([]);   // 걷기 모드도 골라야
    await click($('[data-mode="START"]'));
    const b = last(calls.filter((c) => c.path === '/estimates'))!.body!;
    expect(b).toMatchObject({ scenario_id: 's1', scenario_version: 1, robot_id: 'r1', gait: 'start' });
    expect(typeof b.start).toBe('string');
    const hm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
    expect($('[data-est="eta"]')!.textContent).toBe(hm(EST.eta));
    expect($('[data-est="margin"]')!.textContent).toBe('3 분');
    expect($('[data-est="battery"]')!.textContent).toBe('54 %');
    expect($$('[data-guess]').length).toBeGreaterThan(0);
    expect($('[data-walk-task]')!.textContent).toBe('21 + 6 분추정');
    expect($('[data-mission="s1"] [data-dur]')!.textContent).toBe('27 분');
    // 여유 = 같은 로봇의 다음 일정 시작 - 예상 끝(#531 margin_s). null = 다음 일정 없음 · 잰 값(MEASURED)은 «추정» 없음
    srv.est = { ...EST, margin_s: null, estimate_source: 'MEASURED' };
    await click($('[data-mode="Sport"]'));
    expect($('[data-est="margin"]')!.textContent).toBe('다음 일정 없음');
    expect($('[data-est="margin"]')!.closest('div')!.querySelector('.lab')!.getAttribute('title')).toBe('다음 일정까지 여유');   // 무엇과 비교한 값인지(마감과 비교하는 «마감 넘음» 과 헷갈리지 않게)
    expect($$('[data-guess]')).toEqual([]);
    // 여유가 음수 = 다음 일정과 겹침 · 크기는 쓰지 않는다(겹친 길이가 아님)
    srv.est = { ...EST, margin_s: -300 };
    await click($('[data-mode="Classic"]'));
    expect($('[data-est="margin"]')!.textContent).toBe('겹침');
    expect($('[data-est="margin"]')!.className).toContain('mt-bad');
    // 걷기 모드는 예상 · 일정 본문에만 · 로봇 명령은 보내지 않는다
    expect(calls.filter((c) => c.method !== 'GET' && !['/scenarios/preview', '/estimates'].includes(c.path))).toEqual([]);
  });

  it('일정에 추가(POST /schedule/slots): 본문 · 성공이면 오늘 일정에 막대, 409 SCHEDULE_CONFLICT 면 겹치는 막대 표시 + 한 줄 까닭 · 넣은 뒤 «실제 로봇 시작 전 점검»', async () => {
    await mount('#/missions');
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(true);   // 로봇 · 걷기 모드 전
    expect($<HTMLButtonElement>('[data-rehearse]')!.disabled).toBe(false);   // 모의 실행 = 시뮬 로봇(r2)으로 run.start
    await setTime('end', '11:00'); await setTime('start', '10:30');
    srv.est = { ...EST, eta: at(10, 57) };
    await click($('[data-robot="r1"]')); await click($('[data-mode="START"]'));
    srv.conflict = ['sl1'];
    await click($('[data-schedule-add]'));
    expect($('[data-slot="sl1"]')!.dataset.conflict).toBe('true');
    expect($('[data-slot="sl2"]')!.dataset.conflict).toBeUndefined();
    expect($('[data-add-msg]')!.textContent).toContain('겹칩니다');
    srv.conflict = null;
    await click($('[data-schedule-add]'));
    const b = last(calls.filter((c) => c.method === 'POST' && c.path === '/schedule/slots'))!.body!;
    expect(b).toMatchObject({ robot_id: 'r1', scenario_id: 's1', scenario_version: 1, gait: 'start', kind: 'CONFIRMED' });
    expect(new Date(String(b.end)).getTime()).toBeGreaterThan(new Date(String(b.start)).getTime());
    expect($('[data-slot="new1"]')).toBeTruthy();
    expect($('[data-slot="sl1"]')!.dataset.conflict).toBeUndefined();
    expect($('[data-add-msg]')!.textContent).toContain('일정에 넣었습니다');
    // 넣은 뒤 예상을 다시 받는다 · 방금 넣은 칸은 빼고(자기 칸과 겹침으로 나오지 않게)
    expect(last(calls.filter((c) => c.path === '/estimates'))!.body).toMatchObject({ robot_id: 'r1', gait: 'start', exclude_slot_id: 'new1' });
    // 시안 u6_8: 방금 넣은 칸에 고리 · 단추는 «실제 로봇 시작 전 점검»(배정 · 실행 칸으로)
    expect($('[data-slot="new1"]')!.className).toContain('u6-made');
    expect($('[data-schedule-add]')).toBeNull();
    await click($('[data-preflight]'));
    expect($('[data-preflight-box]')!.textContent).toContain('K-01 실제 로봇으로 시작');   // u15_2 점검 창
  });

  it('시안 u6_6 모의 실행: 위 띠에 배속 · 배속 칸 고른 값과 같음 · 아래 진행 칸에 일정 시작 ~ 끝 시간 눈금 넷', async () => {
    await mount('#/missions');
    await setTime('end', '11:00'); await setTime('start', '10:30');
    await click($('[data-rehearse]')); await flush();
    expect($('[data-band]')!.textContent).toContain('모의 실행 · 시뮬 · 1 배');
    expect($('[data-locked] .on')!.textContent).toBe('1 배');
    expect($$('[data-ticks] span span').map((e) => e.textContent)).toEqual(['10:30', '10:40', '10:50', '11:00']);
    expect(calls.filter((c) => c.method !== 'GET' && !['/scenarios/preview', '/estimates'].includes(c.path))).toEqual([]);   // 화면만 열고 보내지 않음
  });
  it('모의 실행 시간 눈금: 셋으로 나눈 네 눈금 · 자정 넘김 · 모양이 틀리면 비움', () => {
    expect(ticks('15:00', '15:30')).toEqual(['15:00', '15:10', '15:20', '15:30']);
    expect(ticks('23:30', '00:30')).toEqual(['23:30', '23:50', '00:10', '00:30']);
    expect(ticks('', '15:30')).toEqual([]);
  });
  it('모의 실행: 시뮬 로봇이 없으면 회색 + 까닭(title) · 보내지 않음', async () => {
    await mount('#/missions', 'u-kim', ROBOTS.filter((r) => !r.sim));
    const b = $<HTMLButtonElement>('[data-rehearse]')!;
    expect(b.disabled).toBe(true);
    expect(b.title).toContain('시뮬 로봇이 없습니다');
  });

  it('마감 넘음: 예상 끝이 고른 마감보다 늦으면 빨간 한 줄 «마감 넘음 · 예상 끝 HH:MM» + 일정에 추가 막음, 안이면 풀림', async () => {
    await mount('#/missions');
    await setTime('end', '10:30'); await setTime('start', '10:00');
    srv.est = { ...EST, eta: at(10, 50), margin_s: null };
    await click($('[data-robot="r1"]')); await click($('[data-mode="START"]'));
    expect($('[data-late]')!.textContent).toBe('마감 넘음 · 예상 끝 10:50');
    expect($('[data-late]')!.className).toContain('mt-bad');
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(true);
    srv.est = { ...EST, eta: at(10, 25), margin_s: null };
    await click($('[data-mode="Classic"]'));
    expect($('[data-late]')).toBeNull();
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(false);
  });

  it('지난 시각: 처음 값은 다음 30분 칸, 지금보다 이른 시작은 한 줄 + 일정에 추가 막음', async () => {
    await mount('#/missions');
    expect($<HTMLInputElement>('[data-start]')!.value).toBe('08:30');
    expect($<HTMLInputElement>('[data-end]')!.value).toBe('09:00');
    await setTime('start', '07:00');
    srv.est = { ...EST, eta: at(7, 27) };
    await click($('[data-robot="r1"]')); await click($('[data-mode="START"]'));
    expect($('[data-past]')!.textContent).toContain('지난 시각');
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(true);
    await setTime('start', '08:30');
    expect($('[data-past]')).toBeNull();
  });

  it('예상이 없으면(오기 전 · 오류) 마감 넘음을 볼 수 없어 넣지 않는다 · 까닭 한 줄', async () => {
    await mount('#/missions');
    srv.est = null;
    await click($('[data-robot="r1"]')); await click($('[data-mode="START"]'));
    expect($('[data-est-why]')!.textContent).toContain('예상을 받지 못했습니다');
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(true);
    expect($('[data-add-why]')!.textContent).toContain('예상');
    srv.est = { ...EST, eta: at(8, 50) };
    await click($('[data-mode="Classic"]'));
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(false);
  });

  it('폼을 열어 둔 채 시각이 지나면(분마다 다시 잼) 그 시작은 «지난 시각»으로 막힌다', async () => {
    await mount('#/missions');
    await setTime('start', '08:10'); await setTime('end', '09:00');
    srv.est = { ...EST, eta: at(8, 37) };
    await click($('[data-robot="r1"]')); await click($('[data-mode="START"]'));
    expect($('[data-past]')).toBeNull();
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(false);
    act(() => { vi.advanceTimersByTime(6 * 60_000); });   // 08:11
    await flush();
    expect($('[data-past]')).toBeTruthy();
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(true);
  });

  it('AME-2 는 확정 일정에 못 넣어(서버 GAIT_NOT_READY) 흐리게 «준비 중», 고를 수 없음', async () => {
    await mount('#/missions');
    const b = $<HTMLButtonElement>('[data-mode="AME-2"]')!;
    expect(b.disabled).toBe(true);
    expect(b.textContent).toContain('준비 중');
    for (const t of ['Classic', 'Sport', 'START']) expect($<HTMLButtonElement>(`[data-mode="${t}"]`)!.disabled).toBe(false);
  });

  it('오늘 일정(GET /schedule?day=&tz=): 로봇 줄마다 막대 · kind 별 모양 · 범례 한 줄 · 막대 이름은 임무 이름(배터리 교체는 그 말)', async () => {
    await mount('#/missions');
    const q = calls.find((c) => c.path === '/schedule')!.q;
    const d = new Date();
    expect(q.get('day')).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    expect(q.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const bar = (id: string) => $(`[data-slot="${id}"]`)!;
    expect(bar('sl1').closest('[data-day-robot]')!.getAttribute('data-day-robot')).toBe('r1');
    expect(bar('sl2').closest('[data-day-robot]')!.getAttribute('data-day-robot')).toBe('r2');
    expect([bar('sl1').dataset.kind, bar('sl2').dataset.kind, bar('sl3').dataset.kind]).toEqual(['CONFIRMED', 'DRAFT', 'BATTERY_SWAP']);
    expect(bar('sl1').textContent).toBe('가스 점검'); expect(bar('sl3').textContent).toBe(''); expect(bar('sl3').getAttribute('aria-label')).toBe('배터리 교체');   // 시안: 배터리 교체 칸은 빗금만 · 이름은 aria-label
    expect(Number(bar('sl1').dataset.x) * 100).toBeCloseTo((1 / 12) * 100, 1);   // 09:00 = 08~20 눈금의 1/12
    expect($('[data-legend]')!.textContent).toBe('끝남진행 중예정작성 중배터리 교체');   // 시안 범례(확정은 지금 시각으로 끝남 · 진행 중 · 예정)
    // 확정 칸 모양은 지금 시각(08:05) 기준: 09:00~10:00 = 예정 · 작성 중 = k2 · 배터리 교체 = k3
    expect([bar('sl1').className, bar('sl2').className, bar('sl3').className]).toEqual(['bk kp', 'bk k2', 'bk k3']);
  });

  it('오늘 일정 칸 밖: 08~20 밖 일정이 있으면 눈금을 그 일정까지 넓혀 «일정 N건» 과 그린 막대 수가 같다', async () => {
    fresh();
    srv.slots = [...srv.slots, slot('late', 'r1', 'CONFIRMED', 21, 0, 21, 40), slot('early', 'r2', 'DRAFT', 6, 30, 7, 0)];
    await mount('#/missions');
    expect($('[data-day-count]')!.textContent).toBe('임무 5 건');
    expect($$('[data-slot]').length).toBe(5);
    for (const b of $$('[data-slot]')) { const l = Number(b.dataset.x) * 100, w = Number(b.dataset.w) * 100; expect(l).toBeGreaterThanOrEqual(0); expect(l + w).toBeLessThanOrEqual(100.001); }
    const ticks = $$('.u6-hour').map((x) => x.textContent);
    expect(ticks[0]).toBe('06'); expect(last(ticks)).toBe('22');
  });

  it('지도: 경로 · 지점 번호 · 금지 구역 겹침(같은 구역 칸 판정) · 길이 · 미리 확인 한 줄, 지도 위 글자 둘까지', async () => {
    await mount('#/missions');
    expect($$('[data-pt]').map((g) => g.dataset.pt)).toEqual(['1', '2']);
    expect($('[data-seg="0"]')!.dataset.hit).toBe('true');
    expect($('[data-pt="2"]')!.dataset.hit).toBeUndefined();   // 3.5 m 지점 자체는 구역 밖, 가는 길만 겹침
    expect($('[data-overlap]')!.textContent).toContain('접근 금지 구역과 겹침');
    expect($$('.u6-tags > *').length).toBeLessThanOrEqual(2);
    expect($('[data-length]')!.textContent).toBe('1.28 km');
    expect($('[data-check]')!.textContent).toBe(' 모두 갈 수 있음');   // 시안: 초록 ✓ 그림 + 글
    expect($('[data-check] svg')).toBeTruthy();
    await click($('[data-mission="s2"]'));
    expect($('[data-overlap]')).toBeNull();
    expect($$('[data-seg][data-hit]')).toEqual([]);
    expect($('[data-length]')!.textContent).toBe('30 m');
  });

  it('짜기: «편집» = 그 임무를 탭 안 편집 칸(이름 · 목록 ↔ 노드)으로, «‹ 임무 목록»으로 돌아옴 · «새 임무» = 빈 편집 칸', async () => {
    await mount('#/missions');
    await click($('[data-edit-mission]'));
    expect($('h1')!.textContent).toBe('임무');
    expect($('[aria-label="임무 편집"]')).toBeTruthy();
    await flush();   // 편집기 본문(시나리오 받기) 뒤 이름 칸
    expect($<HTMLInputElement>('[data-name]')!.value).toBe('공정 순찰 A');
    await click($('[data-back-list]'));
    expect(picked()).toEqual(['s1']);
    await click($('[data-new-mission]'));   // 시안 u6_2: 새 임무 = 지도 · 로봇 · 걷기 모드 고르기 → «임무 만들기» = 빈 편집 칸
    await click($('[data-setup-make]')); await flush();
    expect($('[aria-label="임무 편집"]')).toBeTruthy();
    expect($<HTMLInputElement>('[data-name]')!.value).toBe('');
  });

  it('시안 u6_3 편집기: 할 일 순서 줄(이동 · 할 일 · 끝) · 고른 줄 자세히(머무는 시간 · 순서 · 지우기) · 접근 금지 구역을 지나면 저장 막음 · 고친 뒤 PUT 본문', async () => {
    await mount('#/missions');
    await click($('[data-edit-mission]')); await flush();
    expect($$('[data-plan] [data-row]').map((e) => e.dataset.row)).toEqual(['move', 'task', 'move', 'task', 'end']);
    expect($('[data-row="task"][data-row-i="1"]')!.textContent).toContain('게이지 읽기');
    expect($('[data-row="task"][data-row-i="1"]')!.textContent).toContain('게이지');
    await click($('[data-row="task"][data-row-i="0"]'));
    expect($('[data-step-detail="0"]')!.textContent).toContain('사진 찍기');   // 남길 것 = 임무 단계
    // 할 일 칸은 긴 임무 이름에도 왼쪽 칸 안에 머문다(넓이 = 칸 넓이 · 줄 열은 minmax(0, 1fr))
    const jobSel = $<HTMLSelectElement>('[data-step-job]')!;
    expect(jobSel.style.width).toBe('100%'); expect(jobSel.style.minWidth).toBe('0');
    expect((jobSel.parentElement as HTMLElement).style.gridTemplateColumns).toBe('96px minmax(0, 1fr)');
    await act(async () => { const i = $<HTMLInputElement>('[data-step-wait]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(i, '45'); i.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); }); await flush();
    // 펌프(0,0) -> 게이지(3.5,0) 는 x 2~3 m 접근 금지 칸을 지난다 -> 저장 막음 · 까닭 한 줄
    expect($<HTMLButtonElement>('[data-save]')!.disabled).toBe(true);
    expect($('[data-block]')!.textContent).toContain('접근 금지 구역');
    await click($('[data-row="task"][data-row-i="1"]')); await click($('[data-step-drop]'));
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); }); await flush();
    expect($$('[data-plan] [data-row]').map((e) => e.dataset.row)).toEqual(['move', 'task', 'end']);
    expect($('[data-block]')).toBeNull();
    await click($('[data-save]')); await flush();
    const put = last(calls.filter((c) => c.method === 'PUT' && c.path === '/scenarios/s1'))!;
    expect((put.body!.waypoints as { wait_s?: number; x: number }[]).map((w) => [w.x, w.wait_s])).toEqual([[0, 45]]);
  });
  it('시안 u6_4 노드 · u6_5 지도: 같은 초안 · 노드 고르기 = 지도 보기에서 «○○ 고르는 중»', async () => {
    await mount('#/missions');
    await click($('[data-edit-mission]')); await flush();
    await click($('[data-look="node"]'));
    expect($$('[data-node]').map((e) => e.dataset.node)).toEqual(['start', '1', '2', 'end']);
    // 시안 u6_4 작은 지도: 그림만 (확대 · 보기 · 축척 단추가 작은 칸에 겹치지 않게)
    const mini = $('[aria-label="작은 지도"]')!;
    expect(mini.querySelector('[data-mission-map]')).toBeTruthy();
    expect(mini.querySelectorAll('button').length).toBe(0);
    expect(mini.querySelector('[data-scale]')).toBeNull();
    // 노드 카드 자리 글도 밝은 판에서 보이게 판별 칸(.u6-at)으로
    expect($('[data-node="1"] .u6-at')!.style.color).toBe('');
    await click($('[data-node-job="m1"]'));
    expect($('[data-look="map"]')!.getAttribute('aria-pressed')).toBe('true');
    expect($('[data-pending]')!.textContent).toContain('게이지 읽기 고르는 중');
    expect($('[data-map-steps]')!.textContent).toContain('펌프');
    // 밝은 판 대비: 자리 글 · 고르는 중 줄은 흰 글을 박지 않고 판별 칸(.u6-at · .u6-pend)으로 칠한다
    const at = $('[data-map-steps] .u6-at')!;
    expect(at.style.color).toBe('');
    expect($('[data-pending]')!.classList.contains('u6-pend')).toBe(true);
    expect($('[data-pending]')!.style.color).toBe('');
  });
  it('밝은 판 대비: 배속 고른 칸 · 지도 위 자리 글은 밝은 판에서 어두운 글 (기존 밝은 판 값)', () => {
    const rules = u6AppCss.replace(/\s+/g, ' ');
    expect(rules).toMatch(/\.proto\.light\.u6 \.mseg span\.on\{[^}]*color:#1F2421/);
    expect(rules).toMatch(/\.proto\.light\.u6 \.u6-at\{color:#5E6662\}/);
    expect(rules).toMatch(/\.proto\.light\.u6 \.u6-pend\{color:#1F2421/);
    expect(rules).toMatch(/\.u6 \.mseg\[data-locked\]\{opacity:1\}/);   // 잠긴 배속 칸도 고른 값은 흐리지 않음
  });
  it('편집 중 탭 떠날 때 확인창 그대로: 저장 안 한 지도 편집이 있으면 임무 탭 · 옛 주소로 가기 전에 묻는다', async () => {
    await mount('#/map');
    const ask = vi.fn();
    leaving.ask = ask;
    for (const h of ['#/missions', '#/mission/s2']) {
      act(() => { location.hash = h; window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: 'http://x/#/map', newURL: `http://x/${h}` })); });
      await flush();
      expect(location.hash).toBe('#/map');
    }
    expect(ask).toHaveBeenCalledTimes(2);
    expect($('h1')!.textContent).toBe('지도');
  });

  // 지도 탭이 시안 u7 로 바뀜: 고르기(u7_1)에는 안내 글이 없고, 임무로 가는 길은 층 화면(u7_3) «이 지도로 모의 실행» = 임무 탭
  it('지도 탭 링크: 지도 고르기(u7_1)는 «시뮬» 탭으로 보내지 않고, 층 화면 «이 지도로 모의 실행»은 임무 탭으로', async () => {
    await mount('#/map');
    expect($('[aria-label="지도 고르기"]')!.textContent).not.toContain('«시뮬» 탭');
    expect($('[aria-label="지도 고르기"] a[href="#/sim"]')).toBeNull();
    act(() => { location.hash = '#/missions'; window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: 'http://x/#/map', newURL: 'http://x/#/missions' })); });
    await flush(); await flush();
    expect($('h1')!.textContent).toBe('임무');
  });
});

// 임무 탭(W2 · U6-01 · U6-03 · U6-05): 탭 열림 · 옛 주소 → 임무 탭에서 그 임무 고름 · 계약 없는 칸은 «준비 중»(숫자 없음) · 금지 구역 겹침 · 미리 확인 · 편집(목록 ↔ 노드) · 편집 중 떠날 때 확인
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Estimate, MapVersion, Mission, RobotAvailability, Scenario, ScheduleSlot } from '../../../contracts/ts';
import { App } from '../App';
import { leaving, oldScenario, tabFromHash } from '../menu';
import { clearPlans } from '../screens/missions';
import { keptMission } from '../screens/missiontab';
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

let calls: { method: string; path: string; q: URLSearchParams; body?: Record<string, unknown> }[] = [];
/** 오늘 로컬 h:m 의 ISO */
const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const slot = (id: string, robot_id: string, kind: ScheduleSlot['kind'], h0: number, m0: number, h1: number, m1: number, scenario_id: string | null = 's2'): ScheduleSlot =>
  ({ id, robot_id, scenario_id, scenario_version: scenario_id ? 1 : null, gait: null, start: at(h0, m0), end: at(h1, m1), kind, assignment_id: null, memo: '', created_by: 'u-kim', created_at: at(0) });
const AV = (robot_id: string, robot_name: string, state: RobotAvailability['state'], battery_pct: number | null, x: Partial<RobotAvailability> = {}): RobotAvailability =>
  ({ robot_id, robot_name, state, busy_until: null, busy_slot_id: null, busy_label: null, battery_pct, demo: false, sim: false, location_label: null, ...x });
const EST: Estimate = { length_m: 1280, walk_s: 1260, task_s: 360, eta: at(14, 27), margin_s: 180, end_battery_pct: 54.4, estimate_source: 'TABLE_UNMEASURED' };
let srv: { slots: ScheduleSlot[]; avail: RobotAvailability[]; est: Estimate; conflict: string[] | null };
const fresh = () => { srv = { slots: [slot('sl1', 'r1', 'CONFIRMED', 9, 0, 10, 0), slot('sl2', 'r2', 'DRAFT', 13, 0, 13, 30), slot('sl3', 'r1', 'BATTERY_SWAP', 15, 0, 15, 20, null)],
  avail: [AV('r1', 'K-01', 'FREE', 86), AV('r2', '시뮬 Go2', 'FREE', null, { sim: true })], est: EST, conflict: null }; };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
function serve() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, q: new URLSearchParams(qs), body });
    const fail = (status: number, code: string, detail = {}) => new Response(JSON.stringify({ error: { code, message: code === 'SCHEDULE_CONFLICT' ? '같은 로봇의 다른 일정과 겹칩니다.' : '오류', detail } }), { status });
    if (path === '/schedule') return ok({ day: new URLSearchParams(qs).get('day'), tz: new URLSearchParams(qs).get('tz'), slots: srv.slots });
    if (path === '/robots/availability') return ok({ items: srv.avail });
    if (method === 'POST' && path === '/estimates') return ok(srv.est);
    if (method === 'POST' && path === '/schedule/slots') {
      if (srv.conflict) return fail(409, 'SCHEDULE_CONFLICT', { slot_ids: srv.conflict });
      const x = { ...body, id: 'new1', scenario_version: body.scenario_version ?? null, assignment_id: null, memo: '', created_by: 'u-kim', created_at: at(0) } as ScheduleSlot;
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
    if (m) { const x = ALL.find((s) => s.id === m[1]); return x ? ok(x) : new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: 404 }); }
    if (method === 'POST' && path === '/scenarios/preview') return ok({ reachable: true, points: [], segments: [], floor_ids: ['f1'], map_version_ids: ['v1'], required_devices: [], est_distance_m: 3, distance_note: '' });
    if (path === '/actions') return ok([]);
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
async function mount(hash: string) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  if (!srv) fresh();
  serve();
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-kim')} robots={ROBOTS} />); });
  await flush(); await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); clearPlans(); keptMission.sel = ''; fresh(); leaving.ask = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
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
  beforeEach(() => { const d = new Date(); d.setHours(8, 5, 0, 0); vi.useFakeTimers({ toFake: ['Date'], now: d }); });
  afterEach(() => { vi.useRealTimers(); });
  it('주소 · 메뉴: #/missions 와 옛 #/mission 은 임무 탭, oldScenario 는 고를 id', () => {
    expect(tabFromHash('#/missions', false)).toBe('missions');
    expect(tabFromHash('#/mission', false)).toBe('missions');
    expect(tabFromHash('#/mission/s2', false)).toBe('missions');
    expect(oldScenario('#/mission/s2')).toBe('s2');
    expect(oldScenario('#/mission?scenario_id=s2')).toBe('s2');
    expect(oldScenario('#/map')).toBeNull();
  });

  it('탭 열림: 세 칸(목록 · 지도 · 일정 칸) + 오늘 일정, 첫 임무를 펼쳐 할 일 번호와 끝 동작', async () => {
    await mount('#/missions');
    expect($('h1')!.textContent).toBe('임무');
    expect($('nav a[aria-current="page"]')!.getAttribute('href')).toBe('#/missions');
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
    expect(rb[0].textContent).toContain('실기'); expect(rb[0].textContent).toContain('86%');
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
    expect(row('r1').disabled).toBe(false); expect(row('r1').textContent).toContain('비어 있음'); expect(row('r1').textContent).toContain('86%');
    expect(row('r2').disabled).toBe(true); expect(row('r2').textContent).toContain('가스 점검'); expect(row('r2').textContent).toContain('14:30까지');
    expect(row('r3').disabled).toBe(true); expect(row('r3').textContent).toContain('연결 전');   // 한 번도 연결된 적 없는 로봇(관제 칩과 같은 robotStatus)
    expect(row('r4').disabled).toBe(false); expect(row('r4').textContent).toContain('충전 중');
    // 시각을 바꾸면 그 시각으로 다시 묻는다
    await setTime('end', '23:50'); await setTime('start', '09:30');
    expect(new Date(last(calls.filter((c) => c.path === '/robots/availability'))!.q.get('start')!).getTime()).toBe(new Date(at(9, 30)).getTime());
  });

  it('예상(POST /estimates): 로봇 · 걷기 모드를 고르기 전엔 숫자 없음 · 고르면 예상 끝 · 여유 · 끝 배터리 · 걷기 + 할 일, 표 값이면 «추정», 여유 null = «마감 없음»', async () => {
    await mount('#/missions');
    for (const e of $$('[data-est]')) expect(e.textContent).toBe('—');
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
    expect($('[data-est="margin"]')!.textContent).toBe('3분');
    expect($('[data-est="battery"]')!.textContent).toBe('54%');
    expect($$('[data-guess]').length).toBeGreaterThan(0);
    expect($('[data-walk-task]')!.textContent).toBe('21 + 6분추정');
    expect($('[data-mission="s1"] [data-dur]')!.textContent).toBe('27분');
    // 여유 null = 마감 없음 · 잰 값(MEASURED)은 «추정» 없음
    srv.est = { ...EST, margin_s: null, estimate_source: 'MEASURED' };
    await click($('[data-mode="Sport"]'));
    expect($('[data-est="margin"]')!.textContent).toBe('마감 없음');
    expect($$('[data-guess]')).toEqual([]);
    // 여유가 음수 = 다음 일정과 겹침 · 크기는 쓰지 않는다(겹친 길이가 아님)
    srv.est = { ...EST, margin_s: -300 };
    await click($('[data-mode="Classic"]'));
    expect($('[data-est="margin"]')!.textContent).toBe('겹침');
    expect($('[data-est="margin"]')!.className).toContain('mt-bad');
    // 걷기 모드는 예상 · 일정 본문에만 · 로봇 명령은 보내지 않는다
    expect(calls.filter((c) => c.method !== 'GET' && !['/scenarios/preview', '/estimates'].includes(c.path))).toEqual([]);
  });

  it('일정에 추가(POST /schedule/slots): 본문 · 성공이면 오늘 일정에 막대, 409 SCHEDULE_CONFLICT 면 겹치는 막대 표시 + 한 줄 까닭 · 모의 실행은 회색', async () => {
    await mount('#/missions');
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(true);   // 로봇 · 걷기 모드 전
    expect($<HTMLButtonElement>('[data-rehearse]')!.disabled).toBe(true);
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
    expect(bar('sl1').textContent).toBe('가스 점검'); expect(bar('sl3').textContent).toBe('배터리 교체');
    expect(parseFloat(bar('sl1').style.left)).toBeCloseTo((1 / 12) * 100, 1);   // 09:00 = 08~20 눈금의 1/12
    expect($('[data-legend]')!.textContent).toBe('확정작성 중배터리 교체');
  });

  it('오늘 일정 칸 밖: 08~20 밖 일정이 있으면 눈금을 그 일정까지 넓혀 «일정 N건» 과 그린 막대 수가 같다', async () => {
    fresh();
    srv.slots = [...srv.slots, slot('late', 'r1', 'CONFIRMED', 21, 0, 21, 40), slot('early', 'r2', 'DRAFT', 6, 30, 7, 0)];
    await mount('#/missions');
    expect($('[data-day-count]')!.textContent).toBe('일정 5건');
    expect($$('[data-slot]').length).toBe(5);
    for (const b of $$('[data-slot]')) { const l = parseFloat(b.style.left), w = parseFloat(b.style.width); expect(l).toBeGreaterThanOrEqual(0); expect(l + w).toBeLessThanOrEqual(100.001); }
    const ticks = $$('.mt-axis .mt-track span').map((x) => x.textContent);
    expect(ticks[0]).toBe('06'); expect(last(ticks)).toBe('22');
  });

  it('지도: 경로 · 지점 번호 · 금지 구역 겹침(같은 구역 칸 판정) · 길이 · 미리 확인 한 줄, 지도 위 글자 둘까지', async () => {
    await mount('#/missions');
    expect($$('[data-pt]').map((g) => g.dataset.pt)).toEqual(['1', '2']);
    expect($('[data-seg="0"]')!.dataset.hit).toBe('true');
    expect($('[data-pt="2"]')!.dataset.hit).toBeUndefined();   // 3.5 m 지점 자체는 구역 밖, 가는 길만 겹침
    expect($('[data-overlap]')!.textContent).toContain('접근 금지 구역과 겹침');
    expect($$('.mt-tags > *').length).toBeLessThanOrEqual(2);
    expect($('[data-length]')!.textContent).toBe('1.28km');
    expect($('[data-check]')!.textContent).toBe('✓ 모두 갈 수 있음');
    await click($('[data-mission="s2"]'));
    expect($('[data-overlap]')).toBeNull();
    expect($$('[data-seg][data-hit]')).toEqual([]);
    expect($('[data-length]')!.textContent).toBe('30m');
  });

  it('짜기: «편집» = 그 임무를 탭 안 편집 칸(이름 · 목록 ↔ 노드)으로, «‹ 임무 목록»으로 돌아옴 · «새 임무» = 빈 편집 칸', async () => {
    await mount('#/missions');
    await click($('[data-edit-mission]'));
    expect($('h1')!.textContent).toBe('임무');
    expect($('[aria-label="임무 편집"]')).toBeTruthy();
    expect($<HTMLInputElement>('[data-name]')!.value).toBe('공정 순찰 A');
    await click($('[data-back-list]'));
    expect(picked()).toEqual(['s1']);
    await click($('[data-new-mission]'));
    expect($<HTMLInputElement>('[data-name]')!.value).toBe('');
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

  it('지도 탭 링크: 지도 고르기 화면의 시나리오 안내는 임무 탭으로 가는 링크 한 줄(«시뮬» 탭으로 보내지 않음)', async () => {
    await mount('#/map');
    const a = $<HTMLAnchorElement>('[aria-label="지도 고르기"] a[data-mission-link]')!;
    expect(a.getAttribute('href')).toBe('#/missions');
    expect(a.textContent).toContain('임무');
    expect($('[aria-label="지도 고르기"]')!.textContent).not.toContain('«시뮬» 탭에서 만들고 고칩니다');
    act(() => { location.hash = '#/missions'; window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: 'http://x/#/map', newURL: 'http://x/#/missions' })); });
    await flush(); await flush();
    expect($('h1')!.textContent).toBe('임무');
  });
});

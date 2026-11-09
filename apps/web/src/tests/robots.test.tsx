// W2 로봇 화면(05 §3·§4·§9) — 관제 요약(GET /dashboard)·상세(GET /robots/{id})·설정 › 로봇(등록·바꾸기·지우기·토큰)·subscription.revoked.
// fetch 는 가짜 서버, WebSocket 은 FakeWS. 401·403·404·409·503·네트워크 실패, 두 revoke 이유, 모르는 t, null 표시, STOP 상시 표시를 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard, RobotSummary, User } from '../../../contracts/ts';
import { now, rt } from '../rt';
import { Root } from '../session';
import { ROBOT_BUSY, ROBOT_GONE } from '../screens/settings';
import { FakeWS, fail, lease, state, type Msg } from './fakeWs';
import { fleetNames, fleetRow } from './fleetRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const PARK: User = { ...KIM, id: 'o2', username: 'park', display_name: '박운영', role: 'OPERATOR', robot_ids: ['r-b'] };
const CHOI: User = { ...KIM, id: 'o3', username: 'choi', display_name: '최운영', role: 'OPERATOR', locked: true };
const LIMITS = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
const AT = '2026-10-20T05:06:07Z';
const robot = (id: string, name: string, owner: User | null, p: Partial<RobotSummary> = {}): RobotSummary => ({ id, name, model: 'unitree_go2',
  simulation: false, server_drive_allowed: false,
  owner: owner && { id: owner.id, display_name: owner.display_name }, connection: 'OFFLINE', status: null, battery: null, location: null, lease: null,
  current_run: null, devices: [], attention: [], ...p });
const RA = robot('r-a', 'Go2-A', LEE, { connection: 'ONLINE', status: 'IDLE', battery: { soc: 64, updated_at: AT },
  location: { floor_id: null, map_version_id: null, x: 1.25, y: -3, yaw: 0, confidence: null, updated_at: AT },
  devices: [{ key: 'cam', kind: 'CAMERA_RGB', label: '앞 카메라', state: 'OK' }, { key: 'lidar', kind: 'LIDAR', label: '라이다', state: 'MISSING' }] });
// 남의 로봇(운영 관리자 시점): 서버가 UNKNOWN + 값 감춤
const RB_HIDDEN = robot('r-b', 'Go2-B', PARK, { connection: 'UNKNOWN' });
const RB = robot('r-b', 'Go2-B', PARK);
const DASH: Dashboard = { robots_total: 2, robots_online: 1, robots_attention: 1, robots_running: 0, approvals_pending: 0,
  operators: [{ user_id: 'o1', display_name: '이운영', robot_count: 1 }, { user_id: 'o2', display_name: '박운영', robot_count: 1 }] };
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [], routes: Record<string, Reply | (() => Reply)> = {};
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${path.split('?')[0]}`], rep = typeof hit === 'function' ? hit() : hit ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, robots: RobotSummary[], more: typeof routes = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: robots, next_cursor: null } },
  'GET /org/settings': { status: 200, body: LIMITS },
  'GET /users': { status: 200, body: { items: [KIM, LEE, PARK, CHOI], next_cursor: null } },
  'GET /dashboard': { status: 200, body: DASH },
  ...Object.fromEntries(robots.map((r) => [`GET /robots/${r.id}`, { status: 200, body: r }])),
  ...more,
});
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const lists = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/robots?')).length;

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string, phone = false) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const card = (label: string) => $(`[aria-label="${label}"]`)!;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const setVal = (el: HTMLInputElement | HTMLSelectElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
const submit = async (form: Element) => { act(() => { (form as HTMLFormElement).requestSubmit(); }); await flush(); };
const kpi = () => Object.fromEntries([...card('요약').querySelectorAll('div')].map((d) => [d.firstElementChild!.textContent, d.querySelector('b')!.textContent]));
const line = (k: string) => [...card('로봇 상세').querySelectorAll('.fh-row')].find((d) => d.firstElementChild?.textContent === k)!.lastElementChild!.textContent;
/** 총괄 서랍 열기 — 고른 행을 다시 누름 */
const drawer = () => click(card('로봇 목록').querySelector('button[aria-pressed="true"]'));
const row = (name: string) => fleetRow(box, name);
const subs = (w: FakeWS) => w.of('sub').map((m) => m.robots);
const stopOk = () => { const s = $<HTMLButtonElement>('[data-stop]')!; expect(s).not.toBeNull(); expect(s.disabled).toBe(false); expect(s.hidden).toBe(false); };

/** 실시간 서버: 열고, 받은 sub 에 state 를 보내고, lease.take 에 조종권을 준다 */
function live(me: User) {
  const w = FakeWS.last;
  w.auto = (m: Msg) => {
    if (m.t === 'lease.take') { setTimeout(() => { w.recv(lease(m.robot!, { id: me.id, name: me.display_name }, 'L1')); w.recv({ t: 'lease.result', robot: m.robot, request_id: null, result: 'ACCEPTED' }); }); }
    return { ok: true };
  };
  act(() => { w.open(); });
  for (const id of (subs(w).pop() as string[]) ?? []) act(() => w.recv(state(id)));
  return w;
}

it('keeps relay battery and devices separate from direct status in list and detail', async () => {
  const relay = { source: 'PHONE' as const, age_s: .1, valid_for_s: 2.9,
    battery: { soc: 75, updated_at: AT }, speed: .5,
    devices: [{ key: 'relay-lidar', kind: 'LIDAR' as const, label: '폰이 전한 라이다', state: 'OK' as const }] };
  serve(signedIn(LEE, [{ ...RA, phone_relay: relay }]));
  await open('#/fleet');
  const w = FakeWS.last;
  act(() => { w.open(); w.recv(state('r-a', { battery: { soc: 64, updated_at: AT }, phone_relay: relay })); });
  expect(line('배터리')).toBe('64%');
  expect(card('로봇 상세').querySelector('[aria-label="폰 경유 상태"]')!.textContent).toContain('75%');
  expect(row('Go2-A').textContent).toContain('폰 경유 · 0초 전');
  act(() => w.recv(state('r-a', { connection: 'OFFLINE', status: null, battery: null,
    devices: [], latched: null, stop_gen: null, applied: null, phone_relay: relay })));
  expect(row('Go2-A').textContent).toContain('끊김');
  expect(line('배터리')).toBe('64%');
  expect(card('로봇 상세').querySelector('[aria-label="폰 경유 상태"]')!.textContent).toContain('폰이 전한 라이다');
  expect(rt.get('r-a').state?.devices).toEqual([]);
});

it('실기 robot_info: 상세 배터리 옆 자세·상태 번호·넘어짐 추정, 목록은 의심일 때만 Chip, 끊기면 폰 경유 → 모름(끊김)', async () => {
  const ri = { source: 'GO2_DDS' as const, attitude: { roll: 0.0175, pitch: -0.5236 }, error_code: 100, fallen: true, fallen_source: 'imu_tilt_estimate' as const };
  serve(signedIn(LEE, [RA, { ...RB, robot_info: ri }]));
  await open('#/fleet');
  const w = FakeWS.last;
  act(() => { w.open(); w.recv(state('r-a', { robot_info: { ...ri, fallen: false } })); });
  expect(line('자세')).toBe('roll +1.0° · pitch -30.0°');
  expect(line('상태 번호')).toBe('100');
  expect(line('넘어짐 추정')).toBe('아님');
  expect(row('Go2-A').querySelector('[data-fall-chip]')).toBeNull();
  // 남의 로봇(요약만)은 서버 값이 있어도 «확인 안 됨» — 목록 Chip 도 없음
  expect($('[aria-label="다른 로봇"] [data-fall-chip]')).toBeNull();
  act(() => w.recv(state('r-a', { robot_info: ri })));
  expect(card('로봇 상세').querySelector('[data-robot-fallen] [data-tone="warn"]')!.textContent).toBe('▲의심(기울기 추정)');
  // 끊김 + 폰 경유 robot_info → 폰 경유 라벨
  const relay = { source: 'PHONE' as const, age_s: .1, valid_for_s: 2.9, battery: null, speed: null, devices: [], robot_info: { ...ri, error_code: 0, fallen: false } };
  act(() => w.recv(state('r-a', { connection: 'OFFLINE', status: null, battery: null, devices: [], latched: null, stop_gen: null, applied: null, robot_info: null, phone_relay: relay })));
  expect(line('자세')).toBe('폰 경유');
  expect(card('로봇 상세').querySelector('[data-robot-info]')!.getAttribute('data-robot-info')).toBe('phone');
  expect(line('상태 번호')).toBe('0(정상 범위)');
  act(() => w.recv(state('r-a', { connection: 'OFFLINE', status: null, battery: null, devices: [], latched: null, stop_gen: null, applied: null, robot_info: null, phone_relay: null })));
  expect(line('상태 번호')).toBe('모름(끊김)');
});

describe('관제 요약 = GET /dashboard(05 §4)', () => {
  it('총괄: 서버 수치 그대로, 주의 필요는 강조, 운영 관리자 표', async () => {
    serve(signedIn(KIM, [RA, RB]));
    await open('#/fleet');
    expect(kpi()).toEqual({ 전체: '2', 연결: '1', '임무 중': '0', '주의 필요': '1', '결재 대기': '0' });
    expect(card('요약').querySelector('.bad')!.textContent).toContain('주의 필요');
    expect(card('운영 관리자').textContent).toBe('운영 관리자 2명이운영로봇 1대박운영로봇 1대');
    expect($('[data-stop]')).toBeNull();   // 총괄·실기만 — 실기 STOP 없음(10-25)
  });
  // TAB-SPLIT(11-10): 로봇 탭은 실기만 — 서버 요약(시뮬까지 셈)에서 받은 목록의 시뮬 몫을 뺀다(결재 대기는 그대로)
  it('총괄: 목록에 시뮬이 있으면 요약·운영 관리자 표에서 그 몫을 빼고, 목록·경보에도 시뮬 없음', async () => {
    const SIM = robot('s-1', '창고 시뮬', LEE, { simulation: true, attention: ['OFFLINE'] });
    serve(signedIn(KIM, [RA, RB, SIM], { 'GET /dashboard': { status: 200, body: { ...DASH, robots_total: 3, robots_attention: 2, approvals_pending: 4,
      operators: [{ user_id: LEE.id, display_name: '이운영', robot_count: 2 }, { user_id: PARK.id, display_name: '박운영', robot_count: 1 }] } } }));
    await open('#/fleet');
    expect(kpi()).toEqual({ 전체: '2', 연결: '1', '임무 중': '0', '주의 필요': '1', '결재 대기': '4' });
    expect(card('운영 관리자').textContent).toBe('운영 관리자 2명이운영로봇 1대박운영로봇 1대');
    expect(card('로봇 목록').textContent).not.toContain('창고 시뮬');
    expect(card('경보').textContent).not.toContain('창고 시뮬');
  });
  it('운영 관리자: 요약 수치·운영 관리자 표 없이 내 로봇 한 대 집중, 남의 로봇은 «다른 로봇» 접기(ROBOT-TAB 11-02)', async () => {
    serve(signedIn(LEE, [RA, RB_HIDDEN], { 'GET /dashboard': { status: 200, body: { ...DASH, robots_total: 1, robots_attention: 0, operators: [] } } }));
    await open('#/fleet');
    expect($('[aria-label="요약"]')).toBeNull();
    expect(card('다른 로봇').querySelector('summary')!.textContent).toContain('다른 로봇 1대');
    expect($('[aria-label="운영 관리자"]')).toBeNull();
    expect(row('Go2-B').textContent).toContain('박운영 · 보는 중');
  });
  it('요약 실패(403·500·네트워크·형식 틀림) → 숫자를 지어내지 않고 «—» + 이유', async () => {
    for (const [rep, says] of [[err(403, 'FORBIDDEN', '권한이 없습니다.'), '권한이 없습니다.'], [err(500, 'INTERNAL', '서버 오류'), ''],
      [() => { throw new TypeError('Failed to fetch'); }, '서버에 연결하지 못했습니다'], [{ status: 200, body: {} }, '요약 형식이 맞지 않습니다'],
      [{ status: 200, body: { ...DASH, robots_total: '2' } }, '요약 형식이 맞지 않습니다'], [{ status: 200, body: { ...DASH, robots_online: null } }, '요약 형식이 맞지 않습니다']] as const) {
      serve(signedIn(KIM, [RA], { 'GET /dashboard': rep as Reply }));
      await open('#/fleet');
      expect(Object.values(kpi())).toEqual(['—', '—', '—', '—', '—']);
      expect(card('요약').querySelector('[role="alert"]')!.textContent).toContain(`요약을 받지 못했습니다. ${says}`);
      act(() => root!.unmount()); box.remove();
    }
  });
  it('로봇 0대: 선택 로봇 없이도 GET /dashboard·요약·운영 관리자 표, «로봇 없음»', async () => {
    serve(signedIn(KIM, [], { 'GET /dashboard': { status: 200, body: { ...DASH, robots_total: 0, robots_online: 0, robots_attention: 0 } } }));
    await open('#/fleet');
    expect(sent('GET', '/dashboard')).toHaveLength(1);
    expect(kpi()).toEqual({ 전체: '0', 연결: '0', '임무 중': '0', '주의 필요': '0', '결재 대기': '0' });
    expect(card('운영 관리자').textContent).toContain('운영 관리자 2명');
    expect(card('로봇 없음').textContent).toContain('로봇이 없습니다');
    act(() => root!.unmount()); box.remove();
    serve(signedIn(LEE, [], { 'GET /dashboard': { status: 200, body: { ...DASH, robots_total: 0, robots_online: 0, robots_attention: 0, operators: [] } } }));
    await open('#/fleet');
    expect($('[aria-label="요약"]')).toBeNull();
    expect(card('로봇 없음').textContent).toContain('담당 로봇이 없습니다');
    expect($('[aria-label="운영 관리자"]')).toBeNull();
  });
  it('요약을 10 s 마다 다시 받는다(화면 WS 에 요약 없음)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serve(signedIn(KIM, [RA]));
    await open('#/fleet');
    const n = sent('GET', '/dashboard').length;
    routes['GET /dashboard'] = { status: 200, body: { ...DASH, robots_online: 2 } };
    act(() => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(sent('GET', '/dashboard').length).toBe(n + 1);
    expect(kpi()['연결']).toBe('2');
  });
});

describe('상세 서랍 = GET /robots/{id}', () => {
  it('총괄: 담당·배터리·위치·장치(이름·종류·상태), 층·임무는 지어내지 않음', async () => {
    serve(signedIn(KIM, [RA, RB]));
    await open('#/fleet');
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    expect(sent('GET', '/robots/r-a')).toHaveLength(1);
    expect(line('담당')).toBe('이운영');
    expect(line('배터리')).toBe('64%');
    expect(line('위치')).toMatch(/^x 1\.3 m · y -3\.0 m \(\d\d:\d\d:\d\d\)$/);
    expect([...card('장치').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['앞 카메라카메라●정상', '라이다라이다▲연결 끊겨 확인 안 됨']);
    expect(card('로봇 상세').textContent).not.toMatch(/임무|층/);
    // 장치·위치는 접혀 있어도 장치 문제는 접힌 밖에 늘 보인다(ROBOT-TAB-TIDY)
    expect($('[data-detail-more]')!.hasAttribute('open')).toBe(false);
    expect($('[data-detail-alert]')!.closest('details')).toBeNull();
    expect($('[data-detail-alert]')!.textContent).toBe('▲ 장치 문제: 라이다 연결 끊겨 확인 안 됨');
    expect($('[data-detail-links]')!.textContent).toMatch(/^서버.+로봇.+잠금/);   // 서버·로봇 연결·잠금을 한 줄에 따로
  });
  it('null 은 null 대로: 배터리 «측정 안 됨», 위치 «위치 없음», 장치 «장치 정보 없음», 담당 없음', async () => {
    const bare = robot('r-n', 'Go2-N', null, { connection: 'ONLINE' });
    serve(signedIn(KIM, [bare]));
    await open('#/fleet');
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    live(KIM);
    act(() => FakeWS.last.recv(state('r-n', { battery: null, location: null, devices: [] })));
    expect([line('담당'), line('배터리'), line('위치'), line('장치')]).toEqual(['담당 없음', '측정 안 됨', '위치 없음', '장치 정보 없음']);
    expect(row('Go2-N').textContent).toContain('—');   // 목록 배터리도 «—», 0% 아님
  });
  it('운영 관리자가 남의 로봇(UNKNOWN): 상태·배터리·위치·장치 «확인 안 됨», 조종 단추 없음 + STOP 은 됨', async () => {
    serve(signedIn(LEE, [RA, RB_HIDDEN]));
    await open('#/fleet');
    await click(row('Go2-B'));
    expect(sent('GET', '/robots/r-b')).toHaveLength(1);
    expect([line('배터리'), line('위치'), line('장치')]).toEqual(['확인 안 됨', '확인 안 됨', '확인 안 됨']);
    expect(card('로봇 상세').querySelector('h2 + *')!.textContent).toBe('○확인 안 됨');
    expect(btn('조종하기', card('로봇 상세'))).toBeUndefined();   // 총괄 웹에는 조종 단추 없음(ADR-002 §4)
    stopOk();
  });
  it('위치·장치만 바뀐 state 도 상세를 다시 그린다', async () => {
    serve(signedIn(KIM, [RA]));
    await open('#/fleet');
    const w = live(KIM);
    act(() => w.recv(state('r-a', { location: RA.location, devices: RA.devices })));
    await click(row('Go2-A'));
    act(() => w.recv(state('r-a', { location: { ...RA.location!, x: 9 }, devices: [{ ...RA.devices[0], state: 'ERROR' }] })));
    expect(line('위치')).toContain('x 9.0 m');
    expect(line('장치')).toContain('오류');
  });
  it('장치 상태 코드(contracts DeviceStatusCode): ACCEPTED 는 허용 표시, ERROR·모르는 level 은 오류로 원시 코드, OK 는 숨김', async () => {
    serve(signedIn(KIM, [RA]));
    await open('#/fleet');
    const w = live(KIM);
    await click(row('Go2-A'));
    act(() => w.recv(state('r-a', { devices: [
      { key: 'body', kind: 'OTHER', label: '기체', state: 'OK', status_code: { raw: 100, level: 'ACCEPTED', reason: 'EXPLICIT_SERVER_ALLOWLIST' } },
      { key: 'cam', kind: 'CAMERA_RGB', label: '앞 카메라', state: 'ERROR', status_code: { raw: 7, level: 'ERROR', reason: null } },
      { key: 'x', kind: 'OTHER', label: '새 장치', state: 'ERROR', status_code: { raw: 9, level: 'WEIRD' as never, reason: null } },
      { key: 'lidar', kind: 'LIDAR', label: '라이다', state: 'OK', status_code: { raw: 0, level: 'OK', reason: null } },
    ] })));
    const codes = [...card('로봇 상세').querySelectorAll('[data-status-code]')].map((e) => `${e.getAttribute('data-status-code')}:${e.textContent}`);
    expect(codes).toEqual(['ACCEPTED:허용된 상태 코드 100(서버 명시 허용)', 'ERROR:상태 코드 7', 'ERROR:상태 코드 9']);
  });
  it('열린 상세의 담당이 바뀌면 다시 받아 갱신, 옛 요청의 늦은 답은 버린다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serve(signedIn(LEE, [RA, RB_HIDDEN]));
    const served = globalThis.fetch;
    let late!: () => void, held = false;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (held || !url.endsWith('/robots/r-b')) return served(url, init);
      held = true;
      return new Promise<Response>((ok) => { late = () => ok(served(url, init) as unknown as Response); });
    });
    await open('#/fleet');
    const w = live(LEE);
    await click(row('Go2-B'));
    expect(line('담당')).toBe('박운영');
    const mine = { ...RB, owner: RA.owner, connection: 'ONLINE' as const };
    routes['GET /robots'] = { status: 200, body: { items: [RA, mine], next_cursor: null } };
    routes['GET /robots/r-b'] = { status: 200, body: mine };
    act(() => { vi.advanceTimersByTime(10_000); });
    await flush();
    act(() => w.recv(state('r-b')));
    routes['GET /robots/r-b'] = { status: 200, body: RB_HIDDEN };
    await act(async () => late());
    await flush();
    expect(sent('GET', '/robots/r-b')).toHaveLength(2);
    expect(line('담당')).toBe('이운영');
  });
  it('상세 404 → «찾을 수 없음» + 목록 다시 받기, 그 밖 실패는 이유', async () => {
    serve(signedIn(KIM, [RA], { 'GET /robots/r-a': err(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.') }));
    await open('#/fleet');
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    expect(card('로봇 상세').querySelector('[role="alert"]')!.textContent).toContain('찾을 수 없습니다');
    expect(lists()).toBe(2);
    act(() => root!.unmount()); box.remove();
    serve(signedIn(KIM, [RA], { 'GET /robots/r-a': () => { throw new TypeError('Failed to fetch'); } }));
    await open('#/fleet');
    await drawer();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    expect(card('로봇 상세').querySelector('[role="alert"]')!.textContent).toContain('상세를 받지 못했습니다. 서버에 연결하지 못했습니다');
    expect(lists()).toBe(1);
  });
});

describe('설정 › 로봇(총괄 — 시뮬 이름만, ROBOT-PAIRING: 실기 등록·토큰 없음)', () => {
  const SIM = robot('s-1', '시뮬 실험', KIM, { simulation: true });
  const pickRobot = (name: string) => click([...card('로봇').querySelectorAll('li button')].find((b) => b.textContent!.includes(name)));
  it('운영 관리자에게는 없음(권한 없는 기능 숨김)', async () => {
    serve(signedIn(LEE, [RA]));
    await open('#/settings');
    expect($('[aria-label="로봇"]')).toBeNull();
  });
  it('총괄: 시뮬 로봇만 목록, 실기 등록·토큰·지우기·담당 단추 없음 + 실기는 운영 관리자가 연결한다는 안내', async () => {
    serve(signedIn(KIM, [RA, SIM]));
    await open('#/settings');
    expect(card('로봇').textContent).toContain('시뮬 로봇 (1)');
    expect(card('로봇').textContent).not.toContain('Go2-A');
    expect($('[data-real-note]')!.textContent).toContain('새 로봇 추가');
    expect(btn('로봇 등록')).toBeUndefined();
    await pickRobot('시뮬 실험');
    const edit = card('로봇 설정');
    expect(['토큰 다시 받기', '로봇 지우기'].map((t) => btn(t, edit))).toEqual([undefined, undefined]);
    expect(edit.querySelector('select')).toBeNull();
    expect(calls.some((c) => c.method === 'POST' && (c.path === '/robots' || c.path.endsWith('/agent-token')))).toBe(false);
  });
  it('시뮬 이름 바꾸기: PATCH {name} 만, 바뀐 값 없음은 안 보냄, 503 은 다시, 404 는 이미 지워짐', async () => {
    let rep: Reply = err(503, 'SERVER_BUSY', 'busy');
    serve(signedIn(KIM, [SIM], { 'PATCH /robots/s-1': () => rep }));
    await open('#/settings');
    await pickRobot('시뮬 실험');
    const edit = card('로봇 설정'), form = edit.querySelector('form')!;
    await submit(form);
    expect(edit.querySelector('[role="status"]')!.textContent).toBe('바뀐 값이 없습니다.');
    setVal(form.querySelector('input[name="name"]')!, ' 시뮬 둘 ');
    await submit(form);
    expect(sent('PATCH', '/robots/s-1')[0].body).toEqual({ name: '시뮬 둘' });
    expect(edit.querySelector('[role="alert"]')!.textContent).toBe(ROBOT_BUSY);
    rep = { status: 200, body: { ...SIM, name: '시뮬 둘' } };
    await submit(form);
    expect(edit.querySelector('[role="status"]')!.textContent).toBe('저장했습니다.');
    rep = err(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.');
    setVal(form.querySelector('input[name="name"]')!, '시뮬 셋');
    await submit(form);
    expect($('[aria-label="로봇 설정"]')).toBeNull();
    expect(card('로봇').textContent).toContain(ROBOT_GONE);
  });
});

describe('subscription.revoked(05 §9)', () => {
  async function driving() {
    serve(signedIn(LEE, [RA, RB_HIDDEN]));
    await open('#/drive/r-a', true);   // 조종 화면은 폰에만(ADR-002 §3)
    const w = live(LEE);
    expect(subs(w).pop()).toEqual(['r-a']);
    await click(btn('조종 시작'));
    await flush();
    expect(rt.get('r-a').lease).toBe('L1');
    expect(location.hash).toBe('#/drive/r-a');
    return w;
  }
  it('ACCESS_REVOKED: 조종 화면을 닫고 이유, 조종 중 표시 즉시 사라짐, 목록 다시 받기, STOP 은 그대로', async () => {
    const w = await driving();
    const n = lists(), k = subs(w).length;
    routes['GET /robots'] = { status: 200, body: { items: [{ ...RA, owner: { id: 'o2', display_name: '박운영' }, connection: 'UNKNOWN' }, RB_HIDDEN], next_cursor: null } };
    act(() => { w.recv(lease('r-a', null)); w.recv({ t: 'subscription.revoked', robot: 'r-a', reason: 'ACCESS_REVOKED' }); });
    await flush();
    expect(rt.get('r-a').lease).toBeNull();
    expect(location.hash).toBe('#/drive');
    expect($('[data-revoked]')!.textContent).toContain('Go2-A 로봇의 담당이 바뀌어 이제 조종할 수 없습니다. 조종 화면을 닫았습니다.');
    expect(box.textContent).not.toContain('조종 중(나)');
    expect(lists()).toBe(n + 1);
    stopOk();
    // 새 목록에서 r-a 는 남의 로봇 → 다시 구독하지 않음(서버 4403 방지)
    expect(subs(w)).toHaveLength(k);
  });
  it('ROBOT_DELETED: 지워졌다는 문구, 닫기 단추로 띠에서 내림', async () => {
    const w = await driving();
    routes['GET /robots'] = { status: 200, body: { items: [RB_HIDDEN], next_cursor: null } };
    act(() => { w.recv({ t: 'subscription.revoked', robot: 'r-a', reason: 'ROBOT_DELETED' }); });
    await flush();
    expect($('[data-revoked]')!.textContent).toContain('Go2-A 로봇이 지워져 목록에서 뺍니다. 조종 화면을 닫았습니다.');
    stopOk();
    await click(btn('닫기', $('[data-revoked]')!));
    expect($('[data-revoked]')).toBeNull();
  });
  it('revoke 전에 요청한 목록이 늦게 와도 그 로봇을 다시 구독하지 않음, 뒤에 요청한 목록이 담당이면 다시 구독', async () => {
    const w = await driving();
    const before = now(), k = subs(w).length;
    routes['GET /robots'] = { status: 200, body: { items: [RA, RB_HIDDEN], next_cursor: null } };   // 다시 이운영에게 배정된 것처럼
    act(() => { w.recv({ t: 'subscription.revoked', robot: 'r-a', reason: 'ACCESS_REVOKED' }); });
    act(() => rt.follow(['r-a'], before));   // revoke 전에 요청한 목록
    expect(subs(w)).toHaveLength(k);
    await flush();   // revoke 뒤 App 이 다시 받은 목록은 따른다
    expect(subs(w).slice(k)).toEqual([['r-a']]);
  });
  it('모르는 t·형식 틀린 revoke 는 무시(상태·조종권 그대로)', async () => {
    const w = await driving();
    const n = lists();
    act(() => { w.recv({ t: 'robot.teleported', robot: 'r-a' }); w.recv({ t: 'subscription.revoked', robot: 7, reason: 'ACCESS_REVOKED' }); });
    await flush();
    expect(rt.get('r-a').lease).toBe('L1');
    expect(location.hash).toBe('#/drive/r-a');
    expect($('[data-revoked]')).toBeNull();
    expect(lists()).toBe(n);
  });
  it('폰 320 폭: revoke 뒤에도 STOP 은 머리줄 맨 오른쪽', async () => {
    serve(signedIn(LEE, [RA, RB_HIDDEN]));
    await open('#/drive', true);
    const w = live(LEE);
    act(() => { w.recv({ t: 'subscription.revoked', robot: 'r-a', reason: 'ROBOT_DELETED' }); });
    await flush();
    expect($('header')!.lastElementChild).toBe($('[data-stop]'));
    stopOk();
  });
});

describe('sub 404(apps/server README «S0» — 등록·담당 변경 직후 서버가 정책을 한 번 더 확인)', () => {
  it('목록의 새 로봇을 서버가 모르면 그 sub 만 거절: 이전 구독·state 유지, 새 로봇은 «확인 안 됨», 목록은 한 번만 다시 받음', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serve(signedIn(LEE, [RA]));
    await open('#/fleet');
    const w = FakeWS.last;
    w.auto = (m: Msg) => ((m.robots as string[] | undefined)?.includes('r-b') ? fail('NOT_FOUND', '로봇을 찾을 수 없습니다.') : { ok: true });
    act(() => { w.open(); w.recv(state('r-a')); });
    const mineB = { ...RB, owner: RA.owner };
    routes['GET /robots'] = { status: 200, body: { items: [RA, mineB], next_cursor: null } };
    routes['GET /robots/r-b'] = { status: 200, body: mineB };
    const n = lists();
    act(() => { vi.advanceTimersByTime(10_000); });        // 운영 관리자 목록 주기 갱신 → r-b 가 내 담당
    await flush();
    expect(subs(w)).toEqual([['r-a'], ['r-a', 'r-b'], ['r-a', 'r-b']]);   // 거절 → 목록 한 번 다시 받고 다시 sub → 또 거절이면 멈춤
    expect(lists()).toBe(n + 2);
    expect(card('로봇 상태').textContent).toContain('Go2-A');
    expect($('[aria-label="로봇 없음"]')).toBeNull();
    expect($('[data-missed]')!.textContent).toContain('실시간 상태를 받을 수 없는 로봇이 있습니다');
    expect($('[data-missed]')!.textContent).toContain('다음 목록 갱신 때 다시 확인합니다.');
    expect($('header [data-link]')).toBeNull();            // 연결은 그대로
    act(() => w.recv(state('r-a', { battery: { soc: 33, updated_at: AT } })));
    expect(line('배터리')).toBe('33%');                     // 고른 내 로봇(Go2-A) 상세
    expect(row('Go2-B').textContent).toContain('확인 안 됨');
    w.auto = () => ({ ok: true });                         // 서버 정책이 따라잡음 → 다음 목록 갱신에 다시 구독
    act(() => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(subs(w).pop()).toEqual(['r-a', 'r-b']);
    act(() => w.recv(state('r-b')));
    expect(row('Go2-B').textContent).not.toContain('확인 안 됨');
    stopOk();
  });
});

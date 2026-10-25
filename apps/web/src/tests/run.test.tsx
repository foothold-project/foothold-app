// 시나리오 실행 화면(05 §13.10 «웹/폰 화면» 행) — fetch = 가짜 서버, WebSocket = 가짜 에이전트(FakeWS). 실제 시뮬·Nav2 기동 0.
// 통과 기준: 능력 알림 있을 때만 실행, 상태별 쉬운 말, 일시정지/이어서/취소, 이어서 비밀값은 이 화면 메모리에만, 다른 화면 이어서 없음,
// 실행 중 수동 조종 0(cmd 송신 0)·STOP/시뮬 정지 늘 보이고 눌림, 총괄 화면 실기 STOP 0.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, SimCatalog, SimRobot } from '../../../contracts/ts';
import { App } from '../App';
import { sim } from '../phone';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111', S2 = '22222222-2222-4222-8222-222222222222', LEASE = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'resume-secret-AAAA', TOKEN2 = 'resume-secret-BBBB', OTHER = '44444444-4444-4444-8444-444444444444';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CATALOG: SimCatalog = { worlds: [{ id: 'empty', name: '빈 연습장', description: '', map_id: 'b-1',
  floors: [{ floor_id: 'f-1', name: '1층', floor_z: 0, map_version_id: 'v-1' }] }], slots: [S1, S2], max_robots: 2, launcher: 'native-single', manager_instance_id: null };
const simRobot = (owner: string): SimRobot => ({ generation: 1, robot_id: S1, owner_id: owner, world_id: 'empty', simulation: true, state: 'RUNNING',
  agent_address: 'ws://127.0.0.1:9481/phone/ws', namespace: '/sim1', tf_prefix: 'sim1/', command_topic: '/sim1/cmd', launcher: 'native-single', expires_at: null, remaining_s: null });
const scn = (id: string, name: string, p: Partial<Scenario> = {}) => ({ id, name, version: 3, floor_ids: ['f-1'], map_version_ids: ['v-1'], archived_at: null, ...p }) as unknown as Scenario;
const SCENARIOS = [scn('s-a', '1층 순찰'), scn('s-b', '두 층 순찰', { floor_ids: ['f-1', 'f-2'], map_version_ids: ['v-1', 'v-2'] }), scn('s-c', '옛 지도', { map_version_ids: ['v-0'] })];
const welcome = (cap = true) => ({ t: 'hello', id: 'p1', robot: S1, proto: 'fh-phone/1', simulation: true, camera_token: null, ...(cap && { capabilities: { run_contract: 'scenario/1' } }),
  limits: { vx_min: 0, vx_max: 0.6, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [] }, policy: { name: 'go2-flat', version: 'v1' }, ping_interval_ms: 1000, link_timeout_ms: 3000, lease_timeout_ms: 15000 });
const phoneState = (p: Record<string, unknown> = {}) => ({ t: 'state', robot: S1, pose: null, speed: 0, battery: { soc: 77 }, latched: true, stop_gen: 1, stop_ref: 0,
  applied: [0, 0, 0], mode: 'IDLE', controller: null, controller_device: null, controller_connected: false, lease_id: null, stop_requested: false,
  posture: { z: null, tilt_deg: null, fallen: null, body_still: null }, velocity: [0, 0, 0], echo: null, wall_time_ms: Date.now(), sim_time_s: 1, sim_wall_delta_s: 0, simulation: true, run: null, ...p });
const held = { lease_id: LEASE, controller: 'u', controller_connected: true };
const runOf = (run_id: string, p: Record<string, unknown> = {}) => ({ run_id, status: 'MOVING', step: 0, progress: { done: 0, total: 3 }, wait_reason: null, fail_code: null, ...p });

type Reply = { status: number; body?: unknown };
let calls: { method: string; path: string; body?: string }[] = [], mine: SimRobot[] = [];
function serve(owner: string) {
  calls = []; mine = [];
  const routes: Record<string, () => Reply> = {
    'GET /simulation/worlds': () => ({ status: 200, body: CATALOG }),
    'GET /simulation/robots': () => ({ status: 200, body: { items: mine } }),
    'POST /simulation/robots': () => { mine = [simRobot(owner)]; return { status: 201, body: mine[0] }; },
    [`POST /robots/${S1}/phone-pass`]: () => ({ status: 200, body: { token: 'pass', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' } }),
    'GET /scenarios': () => ({ status: 200, body: { items: SCENARIOS, next_cursor: null } }),
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path: url, body: init.body ? String(init.body) : undefined });
    const rep = routes[`${method} ${path.split('?')[0]}`]?.() ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '', detail: {} } } };
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}

let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); sim.clear(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); await flush(); };
const agents = () => FakeWS.all.filter((w) => w.url === 'ws://127.0.0.1:9481/phone/ws');
const recv = async (w: FakeWS, m: object) => { act(() => w.recv(m)); await flush(); };
/** 사람에게 보이는 글(개발자 정보 접힘 칸 뺌) */
const visible = () => { const c = box.cloneNode(true) as HTMLElement; c.querySelectorAll('details').forEach((d) => d.remove()); return c.textContent ?? ''; };
/** 에이전트 흉내: 조종권 → lease, run.start → 이어서 비밀값, resume → 새 비밀값, 그 밖 → ok. hello·cmd·ping·stop 은 답 없음 */
const auto = ((m: Msg) => m.t === 'lease.take' ? { lease_id: LEASE }
  : m.t === 'run.start' ? { detail: { run_id: m.run_id, screen_id: m.screen_id, resume_token: TOKEN } }
  : m.t === 'run.control' && m.op === 'resume' ? { detail: { run_id: m.run_id, screen_id: m.screen_id, resume_token: TOKEN2 } }
  : ['hello', 'cmd', 'ping', 'stop'].includes(m.t) ? undefined : {}) as FakeWS['auto'];

/** phone = 운영 관리자 폰 조종 화면, pc = PC «시뮬» 탭 */
async function launch(frame: 'phone' | 'pc', uid = frame === 'phone' ? 'u-lee' : 'u-kim', cap = true) {
  serve(uid);
  window.matchMedia = ((q: string) => ({ matches: frame === 'phone', media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = frame === 'phone' ? '#/drive' : '#/sim';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === uid)} robots={ROBOTS} refresh={() => {}} />); });
  await flush();
  await click(btn('띄우기'));
  const a = agents()[agents().length - 1]; a.auto = auto;
  act(() => a.open()); await flush();
  await recv(a, welcome(cap));
  return a;
}
async function connectAgain() {
  await click(btn('다시 연결'));
  const a = agents()[agents().length - 1]; a.auto = auto;
  act(() => a.open()); await flush();
  await recv(a, welcome());
  return a;
}
/** 조종 시작 → 잠금 해제(state latched=false) */
async function ready(a: FakeWS, run: object | null = null) {
  await recv(a, phoneState({ run }));
  await click(btn('조종 시작'));
  await recv(a, phoneState({ ...held, run }));
  await click(btn('잠금 해제'));
  await recv(a, phoneState({ ...held, latched: false, run }));
}
/** 폰: 시나리오 띠 → 고르기 */
async function pickPhone(name = '1층 순찰') {
  await click($('[data-sim-scn-btn]'));
  await click([...box.querySelectorAll('[data-sim-scn] li button')].find((b) => b.textContent?.startsWith(name)));
}
async function startPhone(a: FakeWS) {
  await ready(a);
  await pickPhone();
  await click(btn('실행'));
  return a.of('run.start')[0];
}

describe('시나리오 실행 — 시작(능력 알림·조건)', () => {
  it('능력 알림 + 조종권 + 잠금 해제일 때만 실행, 시작은 참조만(고정 판·층·지도 판) — 지점·배정 0, 띠 닫힘', async () => {
    const a = await launch('phone');
    await recv(a, phoneState());
    await pickPhone();
    expect(btn('실행')!.disabled).toBe(true);
    expect($('[data-sim-scn]')!.textContent).toContain('먼저 «조종 시작»을 누르세요.');
    await click($('[data-sim-scn-btn]'));
    await ready(a);
    await pickPhone('두 층 순찰');
    expect(btn('실행')!.disabled).toBe(true);
    expect($('[data-sim-scn]')!.textContent).toContain('한 층 시나리오만 실행할 수 있습니다.');
    await click([...box.querySelectorAll('[data-sim-scn] li button')].find((b) => b.textContent?.startsWith('옛 지도')));
    expect($('[data-sim-scn]')!.textContent).toContain('지도 판이 이 월드 지도와 달라');
    await click([...box.querySelectorAll('[data-sim-scn] li button')].find((b) => b.textContent?.startsWith('1층 순찰')));
    expect(btn('실행')!.disabled).toBe(false);
    await click(btn('실행'));
    const s = a.of('run.start');
    expect(s).toHaveLength(1);
    const { id: _, run_id, screen_id, ...rest } = s[0];
    expect(run_id).toMatch(UUID); expect(screen_id).toMatch(UUID);
    expect(rest).toEqual({ t: 'run.start', robot: S1, lease_id: LEASE, scenario_id: 's-a', scenario_version: 3, floor_id: 'f-1', map_version_id: 'v-1' });
    expect($('[data-sim-scn]')).toBeNull();
    expect(calls.some((c) => c.method !== 'GET' && c.path.includes('run'))).toBe(false);   // 서버로 실행 요청 0(화면 → 에이전트 직결)
  });

  it('능력 알림 없는 옛 에이전트: 실행 단추 막힘 + 이유, 실행 프레임 0', async () => {
    const a = await launch('phone', 'u-lee', false);
    await ready(a);
    await pickPhone();
    expect(btn('실행')!.disabled).toBe(true);
    expect($('[data-sim-scn]')!.textContent).toContain('이 로봇은 시나리오 실행을 지원하지 않습니다.');
    act(() => btn('실행')!.click()); await flush();
    expect(a.of('run.start')).toHaveLength(0);
  });

  it('NAV_UNAVAILABLE 거절: 쉬운 이유 표시, 그 뒤 실행 단추 꺼짐', async () => {
    const a = await launch('phone');
    a.auto = ((m: Msg) => (m.t === 'run.start' ? { ok: false, error: { code: 'NAV_UNAVAILABLE', message: '', detail: {} } } : auto!(m))) as FakeWS['auto'];
    await ready(a);
    await pickPhone();
    await click(btn('실행'));
    expect(visible()).toContain('자율 이동(내비게이션)이 준비되지 않아');
    expect(visible()).not.toContain('NAV_UNAVAILABLE');
    await pickPhone();
    expect(btn('실행')!.disabled).toBe(true);
    expect($('[data-sim-scn]')!.textContent).toContain('내비게이션');
  });
});

describe('시나리오 실행 — 진행 표시·단추', () => {
  it('상태별 쉬운 말: 이동·도착·작업·완료·실패·취소, 이유 코드 → 한국어, 원문은 개발자 정보에만', async () => {
    const a = await launch('phone');
    const { run_id } = await startPhone(a) as unknown as { run_id: string };
    const upd = (p: Record<string, unknown>) => recv(a, { t: 'run.update', ...runOf(run_id, p) });
    await upd({ status: 'PREPARING', progress: { done: 0, total: 0 } });
    expect(visible()).toContain('시나리오 준비 중');
    await upd({ status: 'MOVING', step: 1, progress: { done: 1, total: 3 } });
    expect(visible()).toContain('시나리오 이동 중 · 지점 2/3');
    await recv(a, { t: 'event', code: 'RUN_WAYPOINT_ARRIVED', data: { run_id, idx: 1, mission_name: '사진 찍기' } });
    await upd({ status: 'AT_WAYPOINT', step: 1, progress: { done: 1, total: 3 } });
    expect(visible()).toContain('시나리오 지점 도착 · 지점 2/3');
    expect(visible()).toContain('지점 2 도착 · 사진 찍기');
    await upd({ status: 'PERFORMING', step: 1, progress: { done: 1, total: 3 } });
    expect(visible()).toContain('시나리오 작업 중');
    await recv(a, { t: 'event', code: 'RUN_WAYPOINT_ARRIVED', data: { run_id: OTHER, idx: 2, mission_name: '남의 실행' } });
    expect(visible()).not.toContain('남의 실행');
    for (const [p, t] of [
      [{ status: 'FAILED', fail_code: 'NAV_TIMEOUT' }, '시나리오 실패 — 정해진 시간 안에 지점에 닿지 못했습니다.'],
      [{ status: 'FAILED', fail_code: 'SOMETHING_NEW' }, '시나리오 실패 — 실행을 마치지 못했습니다.'],
      [{ status: 'CANCELED', fail_code: 'PAUSE_TIMEOUT' }, '시나리오 취소됨 — 일시정지가 10분을 넘어 자동으로 취소됐습니다.'],
      [{ status: 'CANCELED', fail_code: 'OPERATOR_ABORT' }, '시나리오 취소됨 — 사람이 취소했습니다.'],
      [{ status: 'COMPLETED', progress: { done: 3, total: 3 } }, '시나리오를 마쳤습니다 — 지점 3/3'],
    ] as const) {
      await upd(p);
      expect(visible()).toContain(t);
    }
    expect(visible()).not.toMatch(/NAV_TIMEOUT|PAUSE_TIMEOUT|OPERATOR_ABORT|SOMETHING_NEW/);
    expect(visible()).not.toContain(run_id);
    await click($('[data-sim-menu]'));
    await click([...box.querySelectorAll('.dv-menu button')].find((b) => b.textContent === '정보'));
    expect($('[data-run-dev]')!.textContent).toContain(run_id);   // 원문은 접힌 개발자 정보에만
    await click(btn('닫기'));   // 정보 시트 닫기
    await click($('[data-run-act="close"]'));
    expect(visible()).not.toContain('시나리오를 마쳤습니다');
  });

  it('실행 중: 조이스틱 막힘·cmd 송신 0(ping 은 계속)·수동 전환 안내, STOP 은 보이고 눌림 → STOP 이 실행보다 먼저', async () => {
    const a = await launch('phone');
    const { run_id } = await startPhone(a) as unknown as { run_id: string };
    await recv(a, phoneState({ ...held, latched: false, run: runOf(run_id) }));
    const cmds = a.of('cmd').length, pings = a.of('ping').length;
    const stick = $('[aria-label="전후 조이스틱"]')!;
    stick.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    act(() => { stick.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 50, clientY: 0, button: 0 })); });
    await wait(1100);
    expect(a.of('cmd').length).toBe(cmds);              // 실행 중 화면 cmd 0(비영·0 모두)
    expect(a.of('ping').length).toBeGreaterThan(pings);  // 감시 ping 은 계속
    expect(stick.getAttribute('aria-disabled')).toBe('true');
    expect(visible()).toContain('실행 중에는 수동 조종이 막혀 있습니다');
    expect(btn('일시정지')).toBeTruthy(); expect(btn('취소')).toBeTruthy();
    const stop = $<HTMLButtonElement>('[data-stop]')!;
    expect(stop.disabled).toBe(false);
    await click(stop);
    expect(a.of('stop')).toHaveLength(1);
    expect(a.of('run.control')).toHaveLength(0);
  });

  it('일시정지 → STOPPED_BY_USER·남은 자동 취소 시간 → 조종 시작·잠금 해제 → «이어서»(같은 화면 비밀값, 새 비밀값으로 바뀜)', async () => {
    const a = await launch('phone');
    const { run_id, screen_id } = await startPhone(a) as unknown as { run_id: string; screen_id: string };
    await recv(a, phoneState({ ...held, latched: false, run: runOf(run_id) }));
    expect(box.querySelector('.dv-video span')).toBeNull();   // 실행 안내가 있으면 영상 자리 글을 숨김(QA R1 — 겹침)
    await click(btn('일시정지'));
    expect(a.of('run.control')[0]).toMatchObject({ run_id, op: 'pause', lease_id: LEASE, screen_id });
    expect(a.of('run.control')[0].resume_token).toBeUndefined();
    const paused = runOf(run_id, { status: 'PAUSED', wait_reason: 'STOPPED_BY_USER', step: 1, progress: { done: 1, total: 3 } });
    await recv(a, { t: 'run.update', ...paused });
    await recv(a, phoneState({ run: paused }));   // 일시정지 = 0·잠금·조종권 비움(에이전트)
    expect(visible()).toContain('STOP 으로 멈췄습니다');
    expect(visible()).toContain('약 10분 00초 뒤 자동으로 취소됩니다.');
    expect(visible()).toContain('이어가려면 «조종 시작»을 누르세요.');   // 지금 할 한 단계만(QA R2)
    expect(visible()).not.toContain('«잠금 해제»를 누르세요');
    expect(btn('이어서')).toBeUndefined();
    expect(btn('취소')).toBeTruthy();
    await ready(a, paused);
    await click(btn('이어서'));
    const r1 = a.of('run.control').find((m) => m.op === 'resume')!;
    expect(r1).toMatchObject({ run_id, lease_id: LEASE, screen_id, resume_token: TOKEN });
    await click(btn('이어서'));   // 같은 PAUSED 가 아직 보이면 다시 눌러도 새 비밀값으로
    expect(a.of('run.control').filter((m) => m.op === 'resume')[1].resume_token).toBe(TOKEN2);
  });

  it('연결 끊김 → 일시정지 안내 → 같은 화면 다시 연결이면 이어서 가능(메모리), 화면 세션이 끝나면(clear) 비밀값 없음', async () => {
    const a = await launch('phone');
    const { run_id } = await startPhone(a) as unknown as { run_id: string };
    await recv(a, phoneState({ ...held, latched: false, run: runOf(run_id) }));
    act(() => a.drop(1006)); await flush();
    expect(visible()).toContain('화면 연결이 끊겼습니다 — 로봇은 스스로 멈추고 실행은 일시정지됩니다. 다시 연결한 뒤 이 화면에서 이어갈 수 있습니다.');
    const b = await connectAgain();
    const lost = runOf(run_id, { status: 'PAUSED', wait_reason: 'LINK_LOST' });
    await ready(b, lost);
    expect(visible()).toContain('화면 연결이 끊겨 멈췄습니다');
    expect(visible()).toMatch(/약 \d+분 \d\d초 뒤 자동으로 취소됩니다/);
    await click(btn('이어서'));
    expect(b.of('run.control').find((m) => m.op === 'resume')!.resume_token).toBe(TOKEN);
  });

  it('출입증 만료 임박 + 실행 중: 만료되면 일시정지·같은 화면 이어서 안내', async () => {
    const a = await launch('phone');
    const { run_id } = await startPhone(a) as unknown as { run_id: string };
    act(() => { sim.get().link!.exp = Math.floor(Date.now() / 1000) + 30; });
    await recv(a, phoneState({ ...held, latched: false, run: runOf(run_id) }));
    expect(visible()).toMatch(/출입증 \d+초 남음 — 만료되면 실행이 일시정지됩니다\. 다시 연결한 뒤 이 화면에서 «이어서»를 누르세요\./);
    expect(btn('새 출입증으로 다시 연결(실행 일시정지)')).toBeTruthy();   // 누르면 연결을 닫아 일시정지(QA R7)
  });
});

describe('시나리오 실행 — 비밀값 위치·다른 화면', () => {
  it('이어서 비밀값은 이 화면 메모리에만: 저장소·주소·화면 글·서버 요청 0, 취소 프레임에도 0', async () => {
    const a = await launch('phone');
    const { run_id } = await startPhone(a) as unknown as { run_id: string };
    const paused = runOf(run_id, { status: 'PAUSED', wait_reason: null });
    await recv(a, phoneState({ run: paused }));
    await click(btn('취소'));
    const abort = a.of('run.control').find((m) => m.op === 'abort')!;
    expect(abort).toMatchObject({ run_id, op: 'abort' });
    expect(abort.resume_token).toBeUndefined(); expect(abort.screen_id).toBeUndefined(); expect(abort.lease_id).toBeUndefined();
    const stored = [...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i)!))
      .concat([...Array(sessionStorage.length)].map((_, i) => sessionStorage.getItem(sessionStorage.key(i)!))).join('\n');
    expect(stored).not.toContain(TOKEN);
    expect(location.href).not.toContain(TOKEN);
    expect(box.innerHTML).not.toContain(TOKEN);
    expect(document.cookie).not.toContain(TOKEN);
    expect(calls.some((c) => c.path.includes(TOKEN) || c.body?.includes(TOKEN))).toBe(false);
    expect(a.sent.filter((m) => JSON.stringify(m).includes(TOKEN))).toEqual([]);
  });

  it('다른 화면이 건 실행: 이어서 단추 없음·이유, 일시정지만 취소 가능(권한 거절이면 이유), 일시정지·이어서 프레임 0', async () => {
    const a = await launch('phone');
    await ready(a, runOf(OTHER));
    expect(visible()).toContain('다른 화면에서 실행 중입니다 — 멈추려면 STOP.');
    expect(btn('일시정지')).toBeUndefined(); expect(btn('취소')).toBeUndefined();
    const paused = runOf(OTHER, { status: 'PAUSED', wait_reason: 'LINK_LOST' });
    await ready(a, paused);
    expect(visible()).toContain('다른 화면에서 건 실행입니다 — 이어서는 그 화면에서만 할 수 있습니다.');
    expect(btn('이어서')).toBeUndefined();
    a.auto = ((m: Msg) => (m.t === 'run.control' ? { ok: false, error: { code: 'FORBIDDEN', message: '', detail: {} } } : auto!(m))) as FakeWS['auto'];
    await click(btn('취소'));
    expect(a.of('run.control').map((m) => m.op)).toEqual(['abort']);
    expect(visible()).toContain('이 실행을 취소할 권한이 없습니다');
    // 새 실행도 막힘(로봇당 실행 하나)
    await pickPhone();
    expect(btn('실행')!.disabled).toBe(true);
  });
});

describe('시나리오 실행 — PC 총괄 시뮬', () => {
  it('고르기 → 실행 → 실행 중 키보드 0·시뮬 정지 늘 보이고 눌림, 머리줄 STOP 은 시뮬로만(실기·서버 STOP 0)', async () => {
    const a = await launch('pc');
    await ready(a);
    const sel = $<HTMLSelectElement>('[data-sim-scn] select')!;
    act(() => { sel.value = 's-a'; sel.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    await click(btn('실행'));
    const { run_id } = a.of('run.start')[0] as unknown as { run_id: string };
    expect(a.of('run.start')[0]).toMatchObject({ scenario_id: 's-a', scenario_version: 3, floor_id: 'f-1', map_version_id: 'v-1', lease_id: LEASE });
    await recv(a, phoneState({ ...held, latched: false, run: runOf(run_id) }));
    const cmds = a.of('cmd').length;
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true })); });
    await wait(200);
    expect(a.of('cmd').length).toBe(cmds);
    act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true })); });
    expect(visible()).toContain('시나리오 이동 중 · 지점 1/3');
    expect($('[data-run-acts]')!.textContent).toBe('일시정지취소');
    // 실행 칸 하나(QA R3): 상태·진행 막대·단추·시나리오 고르기가 같은 칸, 조종권 단추는 칸 밖
    const runBox = $('[data-run-box]')!;
    expect(runBox.querySelector('[data-run-bar]')).toBeTruthy();
    expect(runBox.querySelector('[data-run-acts]')).toBeTruthy();
    expect(runBox.querySelector('[data-sim-scn]')).toBeTruthy();
    expect([...runBox.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('조종권 반납');
    // 실행 중 키 안내(QA R4): 막힘 + 움직이는 키 4개 줄긋기, Space(STOP)는 그대로
    expect($('[data-sim-keys]')!.textContent).toContain('실행 중 — 키 조종 막힘');
    expect(box.querySelectorAll('[data-sim-keys] [data-key-off]')).toHaveLength(4);
    expect($('[data-sim-keys]')!.textContent).toContain('Space 정지');
    expect($('[data-sim-stop-same]')!.textContent).toBe('머리줄 STOP 도 이 시뮬을 멈춥니다');   // 총괄(QA R5)
    const simStop = $<HTMLButtonElement>('[data-sim-stop-btn]')!;
    expect(simStop.disabled).toBe(false);
    await click(simStop);
    expect(a.of('stop')).toHaveLength(1);
    const head = $<HTMLButtonElement>('[data-stop]');
    if (head) { expect(head.disabled).toBe(false); await click(head); expect(a.of('stop')).toHaveLength(2); }
    const others = FakeWS.all.filter((w) => !agents().includes(w));
    expect(others.flatMap((w) => w.sent).filter((m) => m.t === 'stop')).toEqual([]);   // 서버(실기) STOP 경로 0
    expect(calls.some((c) => c.method === 'POST' && /stop/i.test(c.path))).toBe(false);
  });

  it('PC: 다른 화면 실행 안내는 «시뮬 정지»로(QA R5), 단추 0', async () => {
    const a = await launch('pc');
    await ready(a, runOf(OTHER));
    expect(visible()).toContain('다른 화면에서 실행 중입니다 — 멈추려면 «시뮬 정지».');
    expect($('[data-run-acts]')).toBeNull();
    expect($<HTMLButtonElement>('[data-sim-stop-btn]')!.disabled).toBe(false);
  });

  it('총괄: 일시정지된 남의 실행은 취소만(이어서 0), 원문 코드 노출 0', async () => {
    const a = await launch('pc');
    await recv(a, phoneState({ run: runOf(OTHER, { status: 'PAUSED', wait_reason: 'RECORDING_UNAVAILABLE' }) }));
    expect(visible()).toContain('실행 기록을 저장하지 못해 멈췄습니다');
    expect($('[data-run-acts]')!.textContent).toBe('취소');
    await click(btn('취소'));
    expect(a.of('run.control')[0]).toEqual(expect.objectContaining({ op: 'abort', run_id: OTHER }));
    expect(visible()).not.toMatch(/RECORDING_UNAVAILABLE|PAUSED/);
  });
});

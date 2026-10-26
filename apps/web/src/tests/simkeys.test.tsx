// PC «시뮬» 탭 키보드 조종·«시뮬 정지»(10 ADR-003 §6.2·§7 ④) — fetch = 가짜 서버, WebSocket = 가짜 에이전트(FakeWS). 실제 시뮬 기동 0.
// 통과 기준: 키 떼면 0, 입력 끊김(초점 잃음·숨김·연결 끊김) → 0 ≤ 0.4 s, 시뮬 정지 뒤 재개 없음, 출입증 surface: 'pc', 서버 WEB_SIM_ONLY 는 문구만·재시도 0.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimCatalog, SimRobot } from '../../../contracts/ts';
import { App } from '../App';
import { sim } from '../phone';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';
import frameCss from '../frame.css?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111', LEASE = 'L1';
const CATALOG: SimCatalog = { worlds: [{ id: 'empty', name: '빈 연습장', description: '', spawn_floor_ids: ['l1'], floors: [] }], slots: [S1], max_robots: 1, launcher: 'native-single', manager_instance_id: null };
const simRobot = (): SimRobot => ({ generation: 1, robot_id: S1, owner_id: 'u-lee', world_id: 'empty', simulation: true, state: 'RUNNING',
  agent_address: 'ws://127.0.0.1:9481/phone/ws', namespace: '/sim1', tf_prefix: 'sim1/', command_topic: '/sim1/cmd', launcher: 'native-single', expires_at: null, remaining_s: null });
// 시뮬 연속 구간(02 F-TO-05) — 후진·제자리 회전 허용, 옆걸음 없음
const LIMITS = { vx_mode: 'continuous', vx_min: -0.3, vx_min_moving: 0.2, vx_max: 1.0, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [], experimental: ['reverse', 'turn_in_place'] };
const welcome = (p: Record<string, unknown> = {}) => ({ t: 'hello', id: 'p1', robot: S1, proto: 'fh-phone/1', simulation: true, camera_token: null,
  limits: LIMITS, policy: { name: 'go2-flat', version: 'v1' }, ping_interval_ms: 1000, link_timeout_ms: 3000, lease_timeout_ms: 15000, ...p });
const phoneState = (p: Record<string, unknown> = {}) => ({ t: 'state', robot: S1, pose: null, speed: 0, battery: null, latched: true, stop_gen: 1, stop_ref: 0, applied: [0, 0, 0],
  mode: 'IDLE', robot_id: S1, controller: null, controller_device: null, controller_connected: false, lease_id: null, stop_requested: false, posture: 'STAND',
  velocity: [0, 0, 0], echo: null, wall_time_ms: Date.now(), sim_time_s: 1, sim_wall_delta_s: 0, simulation: true, ...p });
/** 에이전트 흉내: lease.take → lease_id, 그 밖 요청 → ok. hello·cmd·ping·stop 은 답 없음(state 로 확인) */
const agentAuto = ((m: Msg) => (m.t === 'lease.take' ? { lease_id: LEASE } : ['hello', 'cmd', 'ping', 'stop'].includes(m.t) ? undefined : {})) as FakeWS['auto'];

type Reply = { status: number; body?: unknown };
let calls: { method: string; path: string; body?: unknown }[] = [], routes: Record<string, Reply | (() => Reply)> = {};
function serve(more: typeof routes = {}) {
  calls = [];
  let mine: SimRobot[] = [];
  routes = {
    'GET /simulation/worlds': { status: 200, body: CATALOG },
    'GET /simulation/robots': () => ({ status: 200, body: { items: mine } }),
    'POST /simulation/robots': () => { mine = [simRobot()]; return { status: 201, body: mine[0] }; },
    [`POST /robots/${S1}/phone-pass`]: { status: 200, body: { token: 'pass', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' } },
    [`DELETE /simulation/robots/${S1}`]: () => { mine = []; return { status: 204 }; },
    ...more,
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${path.split('?')[0]}`], rep = (typeof hit === 'function' ? hit() : hit) ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '없음', detail: {} } } };
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}

let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function mount(hash = '#/sim') {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;   // PC 틀
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={ROBOTS} />); });
  await flush();
}
afterEach(() => {
  act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); sim.clear();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.querySelectorAll('input').forEach((i) => i.remove());
});

const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); await flush(); };
const agent = () => FakeWS.all.find((w) => w.url === 'ws://127.0.0.1:9481/phone/ws' && w.readyState === 1)!;
const recv = async (w: FakeWS, m: object) => { act(() => w.recv(m)); await flush(); };
const key = async (type: 'keydown' | 'keyup', code: string, o: KeyboardEventInit & { target?: EventTarget } = {}) => {
  act(() => { (o.target ?? window).dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...o })); }); await flush();
};
/** 마지막 cmd(50 ms 박자) — 다음 박자까지 기다린 뒤 */
const lastCmd = async () => { await sleep(60); const c = agent().of('cmd'); return c[c.length - 1]; };

/** 띄우기 → 직결 → 조종 시작 → 잠금 해제 → 움직일 수 있음 */
async function ready(w = welcome()) {
  serve(); await mount();
  await click(btn('띄우기'));
  const a = FakeWS.all.find((x) => x.url === 'ws://127.0.0.1:9481/phone/ws')!; a.auto = agentAuto;
  act(() => a.open()); await flush();
  await recv(a, w);
  await recv(a, phoneState());
  if (!w.simulation) return a;
  await click(btn('조종 시작'));
  await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true }));
  await click(btn('잠금 해제'));
  expect(a.of('unlock')[0]).toMatchObject({ lease_id: LEASE, stop_gen: 1 });
  await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: false }));
  return a;
}

describe('PC «시뮬» 탭 키보드 조종(ADR-003 §7 ④)', () => {
  it('출입증 요청에 surface: "pc"', async () => {
    serve(); await mount();
    await click(btn('띄우기'));
    expect(calls.find((c) => c.path === `/robots/${S1}/phone-pass`)!.body).toEqual({ device: expect.any(String), purpose: 'control', surface: 'pc' });
  });

  it('403 WEB_SIM_ONLY → 서버 문구만, «다시 연결» 없음, 출입증 재요청 0', async () => {
    serve({ [`POST /robots/${S1}/phone-pass`]: { status: 403, body: { error: { code: 'WEB_SIM_ONLY', message: '웹 시뮬은 시뮬 로봇에만 연결합니다.', detail: {} } } } });
    await mount();
    await click(btn('띄우기'));
    await sleep(100);
    expect(box.textContent).toContain('웹 시뮬은 시뮬 로봇에만 연결합니다.');
    expect(btn('다시 연결')).toBeUndefined();
    expect(calls.filter((c) => c.path === `/robots/${S1}/phone-pass`)).toHaveLength(1);
    expect(FakeWS.all.some((w) => w.url.includes(':9481'))).toBe(false);
  });

  it('키를 누르는 동안만: W = 전진 0.6 m/s, 떼면 바로 0 · A 회전 · S 후진 · 막힌 Q(옆걸음) 안내', async () => {
    const a = await ready();
    expect($('[data-sim-keys]')!.textContent).toContain('키를 누르는 동안만 움직입니다');
    expect((await lastCmd())).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    await key('keydown', 'KeyW');
    const c = await lastCmd();
    expect(c.lease_id).toBe(LEASE);
    expect(c.vx).toBeCloseTo(0.6, 5);
    expect($('[data-sim-vx]')!.textContent).toBe('0.60 m/s');
    await key('keydown', 'KeyA');
    expect(await lastCmd()).toMatchObject({ wz: 0.5 });
    await key('keyup', 'KeyW'); await key('keyup', 'KeyA');
    expect(await lastCmd()).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    await key('keydown', 'ArrowDown');
    expect((await lastCmd()).vx).toBeCloseTo(-0.3, 5);
    await key('keyup', 'ArrowDown');
    await key('keydown', 'KeyQ');
    expect(await lastCmd()).toMatchObject({ vx: 0, vy: 0 });
    expect(box.textContent).toContain('옆걸음은 아직 지원하지 않습니다');
    expect($('[data-key-off]')!.textContent).toContain('옆걸음');
    await key('keyup', 'KeyQ');
    // Ctrl 같이 누름(브라우저 단축키)은 조종 아님
    await key('keydown', 'KeyW', { ctrlKey: true });
    expect(await lastCmd()).toMatchObject({ vx: 0 });
    expect(a.of('stop')).toHaveLength(0);
  });

  for (const how of ['창 초점 잃음', '탭 숨김'] as const) it(`${how} → 0 ≤ 0.4 s, 같은 키를 계속 눌러도(반복) 재개 없음`, async () => {
    const a = await ready();
    await key('keydown', 'KeyW');
    expect((await lastCmd()).vx).toBeCloseTo(0.6, 5);
    const n = a.of('cmd').length, t0 = performance.now();
    act(() => {
      if (how === '탭 숨김') { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }
      else window.dispatchEvent(new Event('blur'));
    });
    await sleep(100);
    // 끊긴 뒤 처음 나간 cmd 부터 0(숨김은 phone.ts 가 0 + 반납 — 반납 뒤 cmd 없음)
    expect(a.of('cmd').slice(n).every((m) => m.vx === 0 && m.wz === 0)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(400);
    await key('keydown', 'KeyW', { repeat: true });
    expect(a.of('cmd').slice(n).every((m) => m.vx === 0)).toBe(true);
    if (how === '탭 숨김') expect(a.of('lease.release')).toHaveLength(1);
  });

  it('연결 끊김 → cmd 멈춤(로봇 deadman), 키 무시, «다시 연결»', async () => {
    const a = await ready();
    await key('keydown', 'KeyW');
    act(() => a.drop(1006)); await flush();
    const n = a.of('cmd').length;
    await sleep(120);
    expect(a.of('cmd')).toHaveLength(n);
    expect(btn('다시 연결')).toBeTruthy();
    expect($('[data-sim-vx]')!.textContent).toBe('0.00 m/s');
  });

  it('글 입력칸 초점이면 조종 키 무시', async () => {
    const a = await ready();
    const input = document.createElement('input'); document.body.append(input); input.focus();
    await key('keydown', 'KeyW', { target: input });
    const c = await lastCmd();
    expect(c.vx).toBe(0);
    expect(a.of('cmd').every((m) => m.vx === 0)).toBe(true);
  });

  it('«시뮬 정지»: STOP 과 다른 이름·모양, 에이전트에 직접 stop → 키 무시, 잠금 해제 뒤에도 누른 키로 재개 없음', async () => {
    const a = await ready();
    const b = $('[data-sim-stop-btn]')!;
    expect(b.textContent).toBe('시뮬 정지');
    expect(b.className).not.toContain('fh-stop');
    await key('keydown', 'KeyW');
    await click(b);
    expect(a.of('stop')).toHaveLength(1);
    expect(calls.some((c) => c.path.endsWith('/stop') || c.method === 'DELETE')).toBe(false);   // 서버 STOP·정리 경로 아님
    const n = a.of('cmd').length;
    await key('keydown', 'KeyD');   // 정지 뒤, 에이전트 잠금 알림 전(옛 latched=false) — 막힘
    await sleep(60);
    expect(a.of('cmd').slice(n).every((m) => m.vx === 0 && m.wz === 0)).toBe(true);
    await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: true, stop_gen: 2 }));
    expect(btn('잠금 해제')).toBeTruthy();
    await click(btn('잠금 해제'));
    await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: false, stop_gen: 2 }));
    await key('keydown', 'KeyW', { repeat: true });   // 정지 전부터 누르던 W — 다시 눌러야 움직임
    expect(await lastCmd()).toMatchObject({ vx: 0, wz: 0 });
    await key('keyup', 'KeyW'); await key('keydown', 'KeyW');
    expect((await lastCmd()).vx).toBeCloseTo(0.6, 5);
  });

  it('«시뮬 정지»는 연결 중에도 하나', async () => {
    serve(); await mount();
    await click(btn('띄우기'));
    expect(sim.get().step).toBe('linking');
    expect(box.querySelectorAll('[data-sim-stop-btn]')).toHaveLength(1);
  });

  it('«시뮬 정지»는 끝내기 반납 대기(ending) 중에도 하나 — 누르면 stop 1회', async () => {
    const a = await ready();
    a.auto = null;   // 반납 응답 보류
    await click(btn('끝내기'));
    expect(sim.get().step).toBe('ending');
    expect(box.querySelectorAll('[data-sim-stop-btn]')).toHaveLength(1);
    await click($('[data-sim-stop-btn]'));
    expect(a.of('stop')).toHaveLength(1);
  });

  it('키를 누른 채 Cmd/Ctrl/Alt 를 누르면 0(macOS 는 Cmd 뒤 keyup 이 안 올 수 있음)', async () => {
    await ready();
    await key('keydown', 'KeyW');
    expect((await lastCmd()).vx).toBeCloseTo(0.6, 5);
    await key('keydown', 'MetaLeft', { key: 'Meta', metaKey: true });
    expect(await lastCmd()).toMatchObject({ vx: 0, wz: 0 });
  });

  it('Space 는 PR #94·#96 그대로 STOP — 시뮬 탭이면 이 시뮬 로봇에 직접 stop', async () => {
    const a = await ready();
    await key('keydown', 'Space');
    expect(a.of('stop')).toHaveLength(1);
    expect(box.querySelector('[aria-label="정지할 로봇 고르기"]')).toBeNull();
  });

  it('에이전트가 simulation 이 아니라고 알리면 키보드 조종·조종 시작 없음', async () => {
    const a = await ready(welcome({ simulation: false }));
    expect($('[data-sim-keys]')).toBeNull();
    expect(btn('조종 시작')).toBeUndefined();
    await key('keydown', 'KeyW');
    await sleep(60);
    expect(a.of('lease.take')).toHaveLength(0);
    expect(a.of('cmd')).toHaveLength(0);
    expect($('[data-sim-stop-btn]')).toBeTruthy();   // 시뮬 정지는 늘 보임
  });

  it('실기 로봇 화면(로봇 탭)에는 키보드 조종 없음 — 키를 눌러도 아무 연결로 보내지 않음', async () => {
    serve(); await mount('#/fleet');
    act(() => FakeWS.last.open()); await flush();   // 서버 실시간 연결(rt)
    await key('keydown', 'KeyW'); await key('keydown', 'ArrowUp');
    await sleep(60);
    expect(FakeWS.all.flatMap((w) => w.sent.map((m) => m.t)).filter((t) => ['cmd', 'lease.take', 'unlock'].includes(t))).toEqual([]);
    expect($('[data-sim-keys]')).toBeNull();
  });
});

// 10-26: PC 시나리오 고르기 = 네이티브 select(키보드 ↑↓·Enter·Esc, combobox/listbox 는 브라우저 기본) + 토큰 모양(.fh-user .fh-sel, frame.css base-select)
describe('PC 시나리오 고르기 모양', () => {
  it('목록 칸은 select.fh-user.fh-sel(고르기 + 이 지도 시나리오), 고르면 안내가 바뀜 — 펼친 목록 CSS 는 토큰 변수만', async () => {
    const MAPPED: SimCatalog = { ...CATALOG, worlds: [{ ...CATALOG.worlds[0], map_id: 'b-1', floors: [{ floor_id: 'f-1', name: '1층', floor_z: 0, map_version_id: 'v-1' }] }] };
    serve({ 'GET /simulation/worlds': { status: 200, body: MAPPED }, 'GET /scenarios': { status: 200, body: { items: [{ id: 's-a', name: '1층 순찰', floor_ids: ['f-1'], archived_at: null }], next_cursor: null } } });
    await mount();
    await click(btn('띄우기'));
    const a = FakeWS.all.find((x) => x.url === 'ws://127.0.0.1:9481/phone/ws')!; a.auto = agentAuto;
    act(() => a.open()); await flush();
    await recv(a, welcome()); await recv(a, phoneState()); await flush();
    const sel = box.querySelector<HTMLSelectElement>('[data-sim-scn] select')!;
    expect(sel.className).toBe('fh-user fh-sel');
    expect([...sel.options].map((o) => o.textContent)).toEqual(['고르기', '1층 순찰']);
    expect($('#sim-scn-why')!.textContent).toBe('실행할 시나리오를 고르세요.');
    act(() => { sel.value = 's-a'; sel.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect($('#sim-scn-why')!.textContent).not.toBe('실행할 시나리오를 고르세요.');
    const css = frameCss.split('\n').filter((l) => l.startsWith('.fh-sel') || l.startsWith('.fh:not(.light) .fh-sel')).join('\n');
    expect(css).toContain('appearance:base-select');
    expect(css.replace(/rgba\(0,0,0,\.4\)/g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgb/i);   // 색은 var(--…) 토큰만(그림자 값은 .dv-ask 그대로)
  });
});

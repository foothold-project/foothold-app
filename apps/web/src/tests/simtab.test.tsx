// PC 웹 «시뮬» 탭(10 ADR-003 §7 ③) — fetch = 가짜 서버, WebSocket = 가짜 에이전트(FakeWS). 실제 시뮬 기동 0.
// 통과 기준: 띄우기 → 위치·카메라·«시뮬» 표시 → 끝내기 → 목록에서 로봇 빠짐. 조종권 자동 취득 0(키보드 조종은 simkeys.test), 한 사람 한 대·SIM_SLOT_BUSY 는 폰과 같음, STOP 은 PR #94 규칙 그대로.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimCatalog, SimRobot } from '../../../contracts/ts';
import { App } from '../App';
import { sim } from '../phone';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111', S2 = '22222222-2222-4222-8222-222222222222';
const CATALOG: SimCatalog = { worlds: [{ id: 'empty', name: '빈 연습장', description: '장애물이 없는 연습 공간',
  spawn_floor_ids: ['l1', 'l2'], floors: [{ floor_id: 'f-1', name: '1층', floor_z: 0, map_version_id: 'v-1', ros_floor_id: 'l1' }, { floor_id: 'f-2', name: '2층', floor_z: 3, map_version_id: 'v-2', ros_floor_id: 'l2' }] }],
  slots: [S1, S2], max_robots: 2, launcher: 'native-single', manager_instance_id: null };
const simRobot = (id = S1, owner = 'u-lee'): SimRobot => ({ generation: 1, robot_id: id, owner_id: owner, world_id: 'empty', simulation: true, state: 'RUNNING',
  agent_address: `ws://127.0.0.1:${id === S1 ? 9481 : 9482}/phone/ws`, namespace: '/sim1', tf_prefix: 'sim1/', command_topic: '/sim1/cmd', launcher: 'native-single', expires_at: null, remaining_s: null });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });
const welcome = { t: 'hello', id: 'p1', robot: S1, proto: 'fh-phone/1', simulation: true, camera_token: 'cam-1',
  limits: { vx_min: 0, vx_max: 0.6, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [] }, policy: { name: 'go2-flat', version: 'v1' }, ping_interval_ms: 1000, link_timeout_ms: 3000, lease_timeout_ms: 15000 };
const phoneState = (p: Record<string, unknown> = {}) => ({ t: 'state', robot: S1, pose: { floor_context: null, map_version_id: null, floor_id: null, confidence: 1, x: 2.5, y: -1.25, yaw: 0 },
  speed: 0, battery: { soc: 77 }, latched: true, stop_gen: 1, stop_ref: 0, applied: [0, 0, 0], mode: 'IDLE', robot_id: S1, controller: null, controller_device: null, controller_connected: false,
  lease_id: null, stop_requested: false, posture: 'STAND', velocity: [0, 0, 0], echo: null, wall_time_ms: Date.now(), sim_time_s: 1, sim_wall_delta_s: 0.2, simulation: true, ...p });

type Reply = { status: number; body?: unknown };
let calls: { method: string; path: string; body?: unknown }[] = [], routes: Record<string, Reply | (() => Reply | Promise<Reply>)> = {}, mine: SimRobot[] = [];
function serve(more: typeof routes = {}) {
  calls = []; mine = [];
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
    const hit = routes[`${method} ${path.split('?')[0]}`], rep = (typeof hit === 'function' ? await hit() : hit) ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}

let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
const refresh = vi.fn();
/** engine = 기억된 계산 방식(null = 기억 없음). 기존 시험은 Gazebo(서버 계산) 띄우기 흐름 */
async function mount(uid = 'u-lee', robots = ROBOTS, hash = '#/sim', engine: string | null = 'gazebo') {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;   // PC 틀
  location.hash = hash;
  if (engine === null) localStorage.removeItem('fh.simEngine'); else localStorage.setItem('fh.simEngine', engine);
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === uid)} robots={robots} refresh={refresh} />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); refresh.mockReset(); sim.clear(); });

const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); await flush(); };
const agent = () => FakeWS.all.find((w) => w.url === 'ws://127.0.0.1:9481/phone/ws')!;
const cam = () => FakeWS.all.find((w) => w.url.endsWith('/phone/camera/ws'))!;
const recv = async (w: FakeWS, m: object) => { act(() => w.recv(m)); await flush(); };

describe('PC «시뮬» 고르기(10-29 — MuJoCo / Gazebo)', () => {
  const engines = () => [...box.querySelectorAll<HTMLInputElement>('input[name="sim-engine"]')].map((i) => [i.value, i.checked, i.disabled]);
  const remount = async (engine: string | null) => { act(() => root?.unmount()); root = null; box.remove(); sim.clear(); await mount('u-lee', ROBOTS, '#/sim', engine); };

  it('두 칸 이름·설명, 기억 없으면 MuJoCo → «시뮬 열기» = 같은 출처 /sim/ ?from=web + 고른 지도, 띄우기·월드 목록 없음', async () => {
    serve(); await mount('u-lee', ROBOTS, '#/sim', null);
    expect([...$('[data-sim-engine]')!.querySelectorAll('label')].map((l) => l.textContent)).toEqual(['MuJoCo이 기기에서 계산', 'Gazebo서버에서 계산']);
    expect(engines()).toEqual([['mujoco', true, false], ['gazebo', false, false]]);
    expect(btn('띄우기')).toBeUndefined();
    expect($('[aria-label="월드 목록"]')).toBeNull();
    const sel = $('[data-sim-map]') as HTMLSelectElement;
    act(() => { sel.value = 'element-course'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    expect($('[data-sim-app]')!.getAttribute('href')).toBe('/sim/index.html?from=web&map=element-course');
    expect(box.textContent).not.toMatch(/브라우저 시뮬|three\.js|폰 안에서/i);
  });

  it('Gazebo 고르면 월드·띄우기(정리할 자리가 있으면 막힘), 고른 값 기억 — 깨진 값·저장 실패면 MuJoCo', async () => {
    serve({ 'GET /simulation/robots': () => ({ status: 200, body: { items: [], cleanup: [{ robot_id: S1, owner_id: 'u-lee', generation: 1, can_recover: true }] } }) });
    await mount('u-lee', ROBOTS, '#/sim', null);
    await click(box.querySelector('input[value="gazebo"]'));
    expect(localStorage.getItem('fh.simEngine')).toBe('gazebo');
    expect($('[aria-label="월드 목록"]')).toBeTruthy();
    expect($('[data-sim-app]')).toBeNull();
    expect(btn('띄우기')!.disabled).toBe(true);   // 정리할 내 시뮬 자리 먼저
    await remount('gazebo');
    expect(engines()).toEqual([['mujoco', false, false], ['gazebo', true, false]]);
    await remount('nope');
    expect(engines()[0]).toEqual(['mujoco', true, false]);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('막힘'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('막힘'); });
    await remount(null);
    expect(engines()[0]).toEqual(['mujoco', true, false]);
    await click(box.querySelector('input[value="gazebo"]'));
    expect(btn('띄우기')).toBeTruthy();   // 기억만 못 하고 고르기는 됨
    vi.restoreAllMocks();
  });

  for (const [how, worlds] of [['목록 못 받음', err(503, 'SIMMGR_UNAVAILABLE', '시뮬 관리자에 닿지 못했습니다.')], ['빈 목록', { status: 200, body: { ...CATALOG, worlds: [] } }]] as const)
    it(`서버 월드 ${how} → Gazebo «준비 중»·누를 수 없음, 기억이 Gazebo 여도 지금은 MuJoCo(기억은 그대로)`, async () => {
      serve({ 'GET /simulation/worlds': worlds }); await mount();
      expect(engines()).toEqual([['mujoco', true, false], ['gazebo', false, true]]);
      expect($('[data-sim-engine]')!.textContent).toContain('서버에서 계산 · 준비 중');
      expect(btn('띄우기')).toBeUndefined();
      expect($('[data-sim-app]')).toBeTruthy();
      expect(localStorage.getItem('fh.simEngine')).toBe('gazebo');
    });
});

describe('PC «시뮬» 탭', () => {
  it('두 역할 모두 왼쪽 메뉴에 «시뮬» 탭, 폰 틀에는 없음(#/sim → 조종)', async () => {
    for (const uid of ['u-lee', 'u-kim']) {
      serve(); await mount(uid);
      expect([...box.querySelectorAll('.fh-nav a')].map((a) => a.textContent)).toContain('시뮬');
      expect($('h1')!.textContent).toBe('시뮬');
      act(() => root?.unmount()); root = null; box.remove(); sim.clear();
    }
  });

  it('통과 기준: 시작 층 골라 띄우기 → «시뮬»·상태·좌표·영상 → 끝내기 → 목록에서 빠짐, 조종권 자동 취득 0', async () => {
    serve(); await mount();
    await click([...box.querySelectorAll<HTMLInputElement>('input[name="sim-spawn"]')].find((i) => i.value === 'l2'));
    await click(btn('띄우기'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/simulation/robots')!.body).toEqual({ world_id: 'empty', robot_id: S1, spawn_floor_id: 'l2' });
    const a = agent(); a.auto = ((m: Msg) => (['hello', 'ping'].includes(m.t) ? undefined : {})) as FakeWS['auto'];
    act(() => a.open()); await flush();
    await recv(a, welcome);
    expect($('[data-sim-view]')).toBeTruthy();
    expect($('[data-sim-state]')!.textContent).toBe('실행 중');
    expect($('[data-sim-view] .lv-chip')!.textContent).toContain('시뮬');
    expect($('[aria-label="RGB 영상"]')!.textContent).toBe('영상 기다리는 중');
    await recv(a, phoneState());
    expect($('[data-sim-pos]')!.textContent).toBe('x 2.50 m · y -1.25 m');
    act(() => cam().open()); await flush();
    expect(cam().sent[0]).toMatchObject({ t: 'camera.hello', robot: S1, token: 'cam-1' });
    await recv(cam(), { t: 'camera.frame', seq: 1, mime: 'image/jpeg', width: 2, height: 2, jpeg: 'AAAA' });
    expect(box.querySelector<HTMLImageElement>('img[alt="RGB 영상"]')!.src).toBe('data:image/jpeg;base64,AAAA');
    // 조이스틱 없음(PC 는 키보드 — ④), 조종 시작을 누르기 전에는 에이전트로 조종권·명령을 보내지 않음
    expect(box.querySelector('[aria-label$="조이스틱"]')).toBeNull();
    expect(btn('조종 시작')).toBeTruthy();
    expect(btn('잠금 해제')).toBeUndefined();
    expect(a.sent.map((m) => m.t).filter((t) => t !== 'hello' && t !== 'ping')).toEqual([]);
    expect($('[data-stop]')).toBeTruthy();   // 운영 관리자 STOP 그대로
    expect(refresh).toHaveBeenCalled();      // 띄운 로봇이 목록·STOP 후보에 바로 보이게
    refresh.mockClear();
    await click(btn('끝내기'));
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/simulation/robots/${S1}`)).toBe(true);
    expect($('[data-sim-view]')).toBeNull();
    expect($('[data-sim-msg]')!.textContent).toBe('시뮬 로봇을 정리했습니다.');
    expect(box.querySelector('[aria-label="내 시뮬 로봇"]')).toBeNull();
    expect(btn('띄우기')!.disabled).toBe(false);
    expect(refresh).toHaveBeenCalled();
  });

  it('보기 4칸(10-26): RGB·외부·지도·L1 점군 — media/1 로 받고, 못 받는 칸은 이유만, 전체화면 안에도 «시뮬 정지»', async () => {
    serve(); await mount();
    await click(btn('띄우기'));
    const a = agent(); act(() => a.open()); await flush();
    const tok = (c: string) => c.repeat(43);
    await recv(a, { ...welcome, media: { version: 'media/1', path: '/phone/media/ws', robot: S1, epoch: 2, episode_id: S2,
      rgb: { available: true, reason: 'Ready', token: tok('r') }, external: { available: false, reason: 'External camera source is not connected', token: null },
      lidar: { available: true, reason: 'Ready', token: tok('l') } } });
    expect([...box.querySelectorAll('[data-tile]')].map((t) => t.getAttribute('data-tile'))).toEqual(['rgb', 'external', 'map', 'lidar']);
    expect(FakeWS.all.some((w) => w.url.endsWith('/phone/camera/ws'))).toBe(false);   // media rgb 가 있으면 옛 카메라 경로는 열지 않음(같은 영상 두 번 0)
    const socks = FakeWS.all.filter((w) => w.url === 'ws://127.0.0.1:9481/phone/media/ws');
    expect(socks).toHaveLength(2);
    act(() => socks.forEach((w) => { w.auto = null; w.open(); })); await flush();
    expect(socks.map((w) => w.sent[0].channel)).toEqual(['rgb', 'lidar']);
    expect($('[aria-label="외부 카메라 영상"]')!.textContent).toBe('외부 카메라 연결 전 — 시뮬 외부 카메라 소스가 아직 연결되지 않았습니다 (External camera source is not connected)');
    const bind = { version: 'media/1', robot: S1, epoch: 2, episode_id: S2 };
    await recv(socks[0], { t: 'media.video', ...bind, channel: 'rgb', source: 'gazebo_rgb', seq: 1, captured_at: '', frame: 'camera', mime: 'image/jpeg', width: 2, height: 2, jpeg: 'AAAA' });
    expect(box.querySelector<HTMLImageElement>('img[alt="RGB 영상"]')!.src).toBe('data:image/jpeg;base64,AAAA');
    await recv(socks[1], { t: 'media.points', ...bind, channel: 'lidar', source: 'l1', seq: 1, captured_at: '', frame: 'lidar_link', map_version_id: null, pose: null, count: 1, truncated: false, encoding: 'xyz_f32le', byte_length: 12 });
    act(() => (socks[1].onmessage as (e: { data: unknown }) => void)({ data: new Float32Array([1, 2, 0]).buffer })); await flush();
    expect($('[data-cloud]')!.getAttribute('data-cloud')).toBe('1');
    expect($('[data-tile="lidar"]')!.textContent).toContain('L1 센서 기준 1스캔');
    // 크게 → 전체화면: 머리줄은 가려지므로 묶음 안에 «시뮬 정지» — 누르면 sim.stop
    await click($('[data-tile="lidar"] .qh'));
    expect($('[data-tile="lidar"]')!.className).toContain('on');
    expect($('[data-sim-stop-btn]')).toBeTruthy();
    expect($('[data-qfs-stop]')).toBeNull();
    const qd = $('.qd')!;
    qd.requestFullscreen = async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => qd }); document.dispatchEvent(new Event('fullscreenchange')); };
    document.exitFullscreen = async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null }); document.dispatchEvent(new Event('fullscreenchange')); };
    await click(btn('전체화면'));
    const inner = $('[data-qfs-stop] [data-sim-stop-btn]');
    expect(inner && qd.contains(inner)).toBe(true);
    const stop = vi.spyOn(sim, 'stop').mockImplementation(() => {});
    await click(inner);
    expect(stop).toHaveBeenCalledTimes(1);
    await click(btn('전체화면 끝'));
    expect($('[data-qfs-stop]')).toBeNull();
    // 보기 닫기 = 부모 끊김 → 관측 연결도 모두 닫고 그림 비움
    await click(btn('보기 닫기'));
    expect(socks.every((w) => w.readyState === 3)).toBe(true);
    stop.mockRestore();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
  });

  it('보기 닫기 = 연결만 닫고 시뮬은 켠 채 → «보기 화면 띄우기»로 다시', async () => {
    serve(); await mount();
    await click(btn('띄우기'));
    act(() => agent().open()); await flush();
    await recv(agent(), welcome);
    await click(btn('보기 닫기'));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(agent().readyState).toBe(3);
    expect(btn('보기 화면 띄우기')).toBeTruthy();
  });

  it('한 사람 한 대: 내 시뮬이 있으면 띄우기 막고 안내, «보기»·«끝내기»', async () => {
    serve(); mine = [{ ...simRobot(), state: 'STARTING' }]; await mount();
    expect(btn('띄우기')!.disabled).toBe(true);
    expect($('#sim-one')!.textContent).toContain('한 사람에 한 대');
    expect(box.querySelector('[aria-label="내 시뮬 로봇"]')!.textContent).toContain('띄우는 중');
    expect(btn('보기')).toBeTruthy();
    expect(btn('끝내기')).toBeTruthy();
  });

  it('SIM_SLOT_BUSY → 남의 것이면 «사용 중» 안내, 정리·연결 0', async () => {
    serve({ 'POST /simulation/robots': err(409, 'SIM_SLOT_BUSY', '사용 중인 슬롯입니다.') }); await mount();
    await click(btn('띄우기'));
    expect($('[data-sim-msg]')!.textContent).toContain('사용 중인 슬롯입니다.');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(FakeWS.all.some((w) => w.url.includes(':948'))).toBe(false);
  });

  it('총괄 STOP(PR #94): 실기만 있으면 없음, 시뮬 로봇이 목록에 있으면 보임', async () => {
    serve(); await mount('u-kim');
    expect($('[data-stop]')).toBeNull();
    act(() => root?.unmount()); root = null; box.remove(); sim.clear();
    serve(); await mount('u-kim', [...ROBOTS, { ...ROBOTS[0], id: S2, name: '시뮬-2', owner: 'u-kim', sim: true }]);
    expect($('[data-stop]')).toBeTruthy();
  });

  // 10-25 f894b77 실관측: 시뮬 슬롯은 고정 로봇 행이라 IDLE(서버가 담당을 비움)이어도 /robots 에 남는다 — 총괄 STOP·Space 는 내가 띄운 시뮬만
  for (const [how, owner] of [['IDLE 슬롯(담당 없음)', ''], ['남이 띄운 시뮬', 'u-lee']] as const) it(`총괄 + ${how}만 목록 → 머리줄 STOP·Space 없음`, async () => {
    serve(); await mount('u-kim', [ROBOTS[1], { ...ROBOTS[0], id: S2, name: '시뮬-2', owner, sim: true }]);
    expect($('[data-stop]')).toBeNull();
    act(() => { dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })); }); await flush();
    expect(box.querySelector('[aria-label="정지할 로봇 고르기"]')).toBeNull();
  });

  // PR #99(ADR-003 §7 ③ «끝내기 → 로봇 빠짐»): 끝낸 시뮬 슬롯은 담당을 비운 채 /robots 에 남는다 — 로봇 목록에서 뺀다. 내 시뮬·담당 없는 실기는 그대로
  it('총괄 로봇 탭: IDLE 시뮬 슬롯(담당 없음)은 목록에 없음, 내 시뮬·담당 없는 실기는 보임', async () => {
    serve();
    await mount('u-kim', [ROBOTS[1], { ...ROBOTS[1], id: 'r9', name: 'Go2-9', owner: '', ownerName: undefined },
      { ...ROBOTS[0], id: S2, name: '시뮬-2', owner: '', sim: true }, { ...ROBOTS[0], id: S1, name: '시뮬-1', owner: 'u-kim', sim: true }], '#/fleet');
    expect([...box.querySelectorAll('.fh-list.robots b')].map((b) => b.textContent)).toEqual(['Go2-7', 'Go2-9', '시뮬-1']);
  });

  // PR #96 P1: 총괄·시뮬 0대 → 띄우는 중(POST 답 전)에도 그 시뮬이 STOP 대상 — 누름·Space 모두 답이 오면 DELETE 1회, 연결 0
  for (const how of ['누름', 'Space'] as const) it(`총괄 첫 시뮬 띄우는 중 STOP(${how}) → 답 오면 정리`, async () => {
    let answer = () => {};
    serve({ 'POST /simulation/robots': () => new Promise<Reply>((f) => { answer = () => { mine = [simRobot(S1, 'u-kim')]; f({ status: 201, body: mine[0] }); }; }) });
    await mount('u-kim');
    expect($('[data-stop]')).toBeNull();
    await click(btn('띄우기'));
    expect(sim.get().step).toBe('starting');
    expect($('[data-stop]')).toBeTruthy();
    if (how === '누름') await click($('[data-stop]'));
    else { act(() => { dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })); }); await flush(); }
    expect(box.querySelector('[aria-label="정지할 로봇 고르기"]')).toBeNull();
    await act(async () => answer()); await flush();
    expect(calls.filter((c) => c.method === 'DELETE' && c.path === `/simulation/robots/${S1}`)).toHaveLength(1);
    expect(FakeWS.all.some((w) => w.url.includes(':948'))).toBe(false);
    expect(sim.get().step).not.toBe('drive');
  });

  // PR #96 P2: 총괄·실기만 → 띄우기 → 보기 → 끝내기. blank()(listed=false) 뒤 load()(listed=true)로 목록이 확정되면 로봇 목록을 다시 받아 STOP 0
  it('총괄 마지막 시뮬 끝내기 → DELETE 뒤 목록 다시 받기, 머리줄 STOP 0', async () => {
    serve(); await mount('u-kim');
    // Root 처럼: refresh = 서버 시뮬 목록을 로봇 목록에 넣어 다시 그림
    const rerender = () => act(() => root!.render(<App user={USERS.find((u) => u.id === 'u-kim')} robots={[...ROBOTS, ...mine.map((r) => ({ ...ROBOTS[0], id: r.robot_id, name: '시뮬', owner: 'u-kim', sim: true }))]} refresh={refresh} />));
    refresh.mockImplementation(rerender);
    await click(btn('띄우기'));
    act(() => agent().open()); await flush();
    await recv(agent(), welcome);
    expect($('[data-sim-view]')).toBeTruthy();
    expect($('[data-stop]')).toBeTruthy();
    // 실제 망처럼 DELETE 뒤 GET 목록 답을 늦춰 blank()(listed=false)가 따로 그려지게
    let list = () => {};
    routes[`DELETE /simulation/robots/${S1}`] = () => {
      mine = []; refresh.mockClear();
      routes['GET /simulation/robots'] = () => new Promise<Reply>((f) => { list = () => f({ status: 200, body: { items: mine } }); });
      return { status: 204 };
    };
    await click(btn('끝내기'));
    expect(sim.get()).toMatchObject({ mine: [], listed: false });
    await act(async () => list()); await flush();
    expect(sim.get()).toMatchObject({ step: 'pick', mine: [], listed: true });
    expect(refresh).toHaveBeenCalled();
    expect($('[data-stop]')).toBeNull();
  });

  it('운영자 STOP 그대로: 시뮬 없으면 «로봇 고르기», 로봇 탭에서 고른 로봇이 있으면 시뮬이 떠 있어도 그 로봇', async () => {
    serve(); await mount();
    await click($('[data-stop]'));
    expect(box.querySelector('[aria-label="정지할 로봇 고르기"]')).toBeTruthy();
    await click(btn('닫기'));
    await click(btn('띄우기'));
    act(() => agent().open()); await flush();
    await recv(agent(), welcome);
    act(() => { location.hash = '#/fleet'; }); await flush();
    await click($('[data-stop]'));
    expect($('[data-stop-band]')).toBeTruthy();
    expect(agent().sent.some((m) => m.t === 'stop')).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

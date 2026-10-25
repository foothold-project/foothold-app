// PC 웹 «시뮬» 탭(10 ADR-003 §7 ③) — fetch = 가짜 서버, WebSocket = 가짜 에이전트(FakeWS). 실제 시뮬 기동 0.
// 통과 기준: 띄우기 → 위치·카메라·«시뮬» 표시 → 끝내기 → 목록에서 로봇 빠짐. 조종 입력 0, 한 사람 한 대·SIM_SLOT_BUSY 는 폰과 같음, STOP 은 PR #94 규칙 그대로.
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
async function mount(uid = 'u-lee', robots = ROBOTS) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;   // PC 틀
  location.hash = '#/sim';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === uid)} robots={robots} refresh={refresh} />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); refresh.mockClear(); sim.clear(); });

const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); await flush(); };
const agent = () => FakeWS.all.find((w) => w.url === 'ws://127.0.0.1:9481/phone/ws')!;
const cam = () => FakeWS.all.find((w) => w.url.endsWith('/phone/camera/ws'))!;
const recv = async (w: FakeWS, m: object) => { act(() => w.recv(m)); await flush(); };

describe('PC «시뮬» 탭', () => {
  it('두 역할 모두 왼쪽 메뉴에 «시뮬» 탭, 폰 틀에는 없음(#/sim → 조종)', async () => {
    for (const uid of ['u-lee', 'u-kim']) {
      serve(); await mount(uid);
      expect([...box.querySelectorAll('.fh-nav a')].map((a) => a.textContent)).toContain('시뮬');
      expect($('h1')!.textContent).toBe('시뮬');
      act(() => root?.unmount()); root = null; box.remove(); sim.clear();
    }
  });

  it('통과 기준: 시작 층 골라 띄우기 → «시뮬»·상태·좌표·영상 → 끝내기 → 목록에서 빠짐, 조종 입력 0', async () => {
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
    // 보기만: 조이스틱·조종 시작·잠금 해제 없음, 에이전트로 조종권·명령을 보내지 않음
    expect(box.querySelector('[aria-label$="조이스틱"]')).toBeNull();
    expect(btn('조종 시작')).toBeUndefined();
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

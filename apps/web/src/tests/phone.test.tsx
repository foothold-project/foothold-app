// 폰 ↔ 시뮬 로봇 직결(09 ADR-002 §3·§6, 05 API §13·§13.9) — fetch = 가짜 서버, WebSocket = 가짜 에이전트(FakeWS).
// 띄우기 → 월드 고르기 → 출입증·hello → 조종권·잠금 해제 → 조이스틱 cmd → STOP → 끝내기 + 실패(START 거부, 503, WS 끊김, 출입증 거절, 정리 실패).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimCatalog, SimRobot } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';
import { DEAD, sim, velocity } from '../phone';
import { remainingTime, timeNotice } from '../simdrive';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111', S2 = '22222222-2222-4222-8222-222222222222', LEASE = '33333333-3333-4333-8333-333333333333';
const AGENT = 'ws://127.0.0.1:9481/phone/ws';
const CATALOG: SimCatalog = { worlds: [{ id: 'empty', name: '빈 연습장', description: '장애물이 없는 연습 공간' }], slots: [S1, S2], max_robots: 2, launcher: 'native-single', manager_instance_id: null };
const simRobot = (id = S1): SimRobot => ({ generation: 1, robot_id: id, owner_id: 'u-lee', world_id: 'empty', simulation: true, state: 'RUNNING',
  agent_address: AGENT.replace('9481', id === S1 ? '9481' : '9482'), namespace: '/sim1', tf_prefix: 'sim1/', command_topic: '/sim1/cmd', launcher: 'native-single', expires_at: null, remaining_s: null });
const err = (status: number, code: string, message: string, detail: Record<string, unknown> = {}) => ({ status, body: { error: { code, message, detail } } });
const welcome = (robot = S1) => ({ t: 'hello', id: 'p1', robot, proto: 'fh-phone/1', simulation: true, camera_token: 'cam-1',
  limits: { vx_min: 0, vx_max: 0.6, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [[0, 0, 0], [0.6, 0, 0], [0.6, 0, -0.5], [0.6, 0, 0.5]] },
  policy: { name: 'go2-flat', version: 'v1' }, ping_interval_ms: 1000, link_timeout_ms: 3000, lease_timeout_ms: 15000 });
const phoneState = (p: Record<string, unknown> = {}) => ({ t: 'state', robot: S1, pose: null, speed: 0, battery: { soc: 77 }, latched: true, stop_gen: 1, stop_ref: 0,
  applied: [0, 0, 0], mode: 'IDLE', robot_id: S1, controller: null, controller_device: null, controller_connected: false, lease_id: null, stop_requested: false,
  posture: 'STAND', velocity: [0, 0, 0], echo: null, wall_time_ms: Date.now(), sim_time_s: 1, sim_wall_delta_s: 0.2, simulation: true, ...p });

type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [], routes: Record<string, Reply | (() => Reply | Promise<Reply>)> = {}, mine: SimRobot[] = [];
/** 가짜 서버 기본: 월드 1개, 내 시뮬 로봇 = mine, POST 201(→ mine), 출입증, DELETE 204(→ 비움) */
function serve(more: typeof routes = {}) {
  calls = []; mine = [];
  routes = {
    'GET /simulation/worlds': { status: 200, body: CATALOG },
    'GET /simulation/robots': () => ({ status: 200, body: { items: mine } }),
    'POST /simulation/robots': () => { mine = [simRobot()]; return { status: 201, body: mine[0] }; },
    [`POST /robots/${S1}/phone-pass`]: { status: 200, body: { token: 'pass-secret', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' } },
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
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function mount() {
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/drive';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={ROBOTS} />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); await flush(); };
const agents = () => FakeWS.all.filter((w) => /\/phone\/ws$/.test(w.url) && w.url.startsWith('ws://127.0.0.1:948'));
const cams = () => FakeWS.all.filter((w) => w.url.endsWith('/phone/camera/ws'));
const recv = async (w: FakeWS, m: object) => { act(() => w.recv(m)); await flush(); };
/** 에이전트 흉내: lease.take → lease_id, 그 밖 요청 → ok. hello·cmd·ping·stop 은 답 없음(state 로 확인) */
const agentAuto = ((m: Msg) => (m.t === 'lease.take' ? { lease_id: LEASE } : ['hello', 'cmd', 'ping', 'stop'].includes(m.t) ? undefined : {})) as FakeWS['auto'];
const last = <T,>(xs: T[]) => xs[xs.length - 1];

/** 띄우기 → 출입증 → hello → welcome 까지 */
async function launch(hello = welcome()) {
  serve(); await mount();
  await click(btn('띄우기'));
  const a = agents()[0]; a.auto = agentAuto;
  act(() => a.open()); await flush();
  await recv(a, hello);
  return a;
}
/** 조종 시작 → 잠금 해제 → state latched=false */
async function drive(a: FakeWS) {
  await recv(a, phoneState());
  await click(btn('조종 시작'));
  await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true }));
  await click(btn('잠금 해제'));
  await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: false, stop_gen: 1 }));
}
const stick = (label: string) => {
  const el = $(`[aria-label="${label} 조이스틱"]`)!;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return el;
};
const ptr = (el: Element, type: string, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })); });

const CONT = { vx_mode: 'continuous' as const, vx_min: 0, vx_min_moving: 0.2, vx_max: 1.0, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [] };
const hello = (limits: object) => ({ ...welcome(), limits }) as unknown as Parameters<typeof velocity>[1];

describe('시뮬 연속 앞 속도(02 F-TO-05)', () => {
  it('데드존 안 0, 살짝 → 0.2, 끝 → 1.0, 후진 0, 회전은 기존 규칙', () => {
    const w = hello(CONT), vx = (f: number) => velocity([f, 0], w).vx;
    expect([vx(0), vx(DEAD), vx(-1), vx(-0.3)]).toEqual([0, 0, 0, 0]);
    expect(vx(DEAD + 1e-6)).toBeGreaterThanOrEqual(0.2);
    expect(vx(DEAD + 1e-6)).toBeCloseTo(0.2, 5);
    expect(vx(1)).toBe(1);
    expect(vx(0.55)).toBeCloseTo(0.6, 9);
    expect(velocity([1, -1], w)).toEqual({ vx: 1, vy: 0, wz: -0.5 });
    expect(velocity([1, 1], w)).toEqual({ vx: 1, vy: 0, wz: 0.5 });
  });
  it('limits 값이 바뀌면 따라간다(화면에 숫자 없음)', () => {
    const w = hello({ ...CONT, vx_min_moving: 0.3, vx_max: 0.8 });
    expect(velocity([1, 0], w).vx).toBe(0.8);
    expect(velocity([DEAD + 1e-6, 0], w).vx).toBeCloseTo(0.3, 5);
  });
  it('이산 모드(vx_mode 없음)는 기존 식 그대로', () => {
    const w = hello(welcome().limits), old = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v >= 0 ? v * hi : -v * lo));
    for (let f = -1; f <= 1; f += 0.05) for (const t of [-1, -0.3, 0, 0.4, 1])
      expect(velocity([f, t], w)).toEqual({ vx: old(f, 0, 0.6), vy: 0, wz: old(t, -0.5, 0.5) });
  });
  it('연속 모드: 3단 숨김·상태 줄 값·놓으면 즉시 0·STOP 늘 보임', async () => {
    const a = await launch({ ...welcome(), limits: CONT }); await drive(a);
    expect($('[aria-label="속도 단계"]')).toBeNull();
    expect(box.textContent).not.toContain('보통 · 0.6 m/s');
    expect(box.textContent).toContain('시뮬 전용 · 멈출 때 가끔 넘어질 수 있음(측정 34회 중 3회)');
    expect(box.textContent).toContain('후진·제자리 회전은 아직 지원하지 않습니다');
    expect($('[data-sim-vx]')!.textContent).toBe('앞 0.00 m/s');
    expect($('[data-stop]')).toBeTruthy();
    const fwd = stick('전후');
    ptr(fwd, 'pointerdown', 50, 0); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 1, vy: 0, wz: 0 });
    expect($('[data-sim-vx]')!.textContent).toBe('앞 1.00 m/s');
    ptr(fwd, 'pointermove', 50, 44); await wait(80);
    expect(last(a.of('cmd')).vx).toBeCloseTo(0.2 + 0.8 * 0.02 / 0.9, 9);
    ptr(fwd, 'pointermove', 50, 46); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0 });
    ptr(fwd, 'pointermove', 50, 25); await wait(80);
    expect($('[data-sim-vx]')!.textContent).toBe('앞 0.56 m/s');
    ptr(fwd, 'pointerup', 50, 25);
    const n = a.of('cmd').length; await wait(60);
    expect(a.of('cmd').slice(n).every((m) => m.vx === 0 && m.wz === 0)).toBe(true);
    expect(a.of('cmd').length).toBeGreaterThan(n);
    expect($('[data-sim-vx]')!.textContent).toBe('앞 0.00 m/s');
    ptr(fwd, 'pointerdown', 50, 100); await wait(80);
    expect(box.textContent).toContain('후진은 아직 지원하지 않습니다');
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    ptr(fwd, 'pointerup', 50, 100);
    await recv(a, { t: 'cmd.ack', clipped: true });
    expect(box.textContent).toContain('명령 범위 조정');
    expect($('[data-stop]')).toBeTruthy();
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
  });
});

describe('시뮬 로봇 직결 흐름', () => {
  it('검증된 보통만 사용 가능, 후진·제자리 회전은 미확인 안내, STOP 유지', async () => {
    const a = await launch(); await drive(a);
    const speeds = $('[aria-label="속도 단계"]')!;
    const buttons = [...speeds.querySelectorAll('button')];
    expect(buttons.map((b) => [b.textContent, b.disabled, b.getAttribute('aria-pressed')])).toEqual([
      ['느림', true, 'false'], ['보통 · 0.6 m/s', false, 'true'], ['빠름', true, 'false'],
    ]);
    expect(box.textContent).toContain('느림·빠름·후진·제자리 회전: 시뮬에서 아직 확인 안 됨');
    await click(buttons[0]); await click(buttons[2]);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    const fwd = stick('전후');
    await recv(a, { t: 'cmd.ack', clipped: true });
    expect(box.textContent).toContain('명령 범위 조정');
    ptr(fwd, 'pointerdown', 50, 100); await wait(80);
    expect(box.textContent).toContain('후진은 아직 지원하지 않습니다');
    expect(box.textContent).not.toContain('명령 범위 조정');
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    ptr(fwd, 'pointerup', 50, 100);
    const turn = stick('회전');
    ptr(turn, 'pointerdown', 100, 50); await wait(80);
    expect(box.textContent).toContain('제자리 회전 — 시뮬에서 아직 확인 안 됨');
    expect(box.textContent).not.toContain('끝까지 밀어야 움직입니다');
    // Existing wire request remains subject to agent projection; no new allowed command.
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: -0.5 });
    expect($('[data-stop]')).toBeTruthy();
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
    ptr(turn, 'pointerup', 100, 50);
    expect(box.textContent).toContain('명령 범위 조정');
  });

  it('월드 이름·설명을 표시하고(월드 내부 id 는 숨김, U5) 선택한 id로 띄운다', async () => {
    serve({ 'GET /simulation/worlds': { status: 200, body: { ...CATALOG, worlds: [
      ...CATALOG.worlds, { id: 'corridor', name: '복도 연습장', description: '' },
    ] } } });
    await mount();
    const list = $('[aria-label="월드 목록"]')!;
    expect(list.querySelector('b')!.textContent).toBe('빈 연습장');
    expect([...list.querySelectorAll('small')].map((el) => el.textContent)).toEqual(['장애물이 없는 연습 공간']);
    expect(list.textContent).not.toMatch(/empty|corridor/);
    await click(list.querySelector('input[value="corridor"]'));
    await click(btn('띄우기'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/simulation/robots')!.body).toEqual({ world_id: 'corridor', robot_id: S1 });
  });

  it('띄우기 → 월드 고르기 → 직결 → 조종권·잠금 해제 → 조이스틱 → STOP → 끝내기(반납 → DELETE → 목록)', async () => {
    serve(); await mount();
    // 월드 목록은 계약의 이름·설명(월드 내부 id 는 본문에 쓰지 않음)
    const list = $('[aria-label="월드 목록"]')!;
    expect(list.textContent).not.toContain('empty');
    expect(list.textContent).toContain('장애물이 없는 연습 공간');
    expect($<HTMLInputElement>('input[name="sim-world"]')!.checked).toBe(true);
    await click(btn('띄우기'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/simulation/robots')!.body).toEqual({ world_id: 'empty', robot_id: S1 });
    const pass = calls.find((c) => c.path === `/robots/${S1}/phone-pass`)!;
    expect(pass.body).toMatchObject({ purpose: 'control' });
    expect($('[data-sim="linking"]')).toBeTruthy();
    // 서버 중계 없이 에이전트 주소로 직접, 출입증은 URL 에 없고 hello 에만
    const [a] = agents(); a.auto = agentAuto;
    expect(a.url).toBe(AGENT);
    expect(FakeWS.all.every((w) => !w.url.includes('pass-secret'))).toBe(true);
    act(() => a.open()); await flush();
    expect(a.sent[0]).toMatchObject({ t: 'hello', robot: S1, proto: 'fh-phone/1', ticket: 'pass-secret', device: pass.body && (pass.body as { device: string }).device });
    expect(a.sent.slice(1).every((m) => !JSON.stringify(m).includes('pass-secret'))).toBe(true);
    await recv(a, welcome());
    expect($('[data-sim-drive]')).toBeTruthy();
    expect($('[data-sim-drive]')!.textContent).toContain('시뮬');
    // 영상: 같은 포트 /phone/camera/ws, 첫 프레임 camera.hello
    const [c] = cams();
    expect(c.url).toBe('ws://127.0.0.1:9481/phone/camera/ws');
    act(() => c.open());
    expect(c.sent[0]).toMatchObject({ t: 'camera.hello', robot: S1, token: 'cam-1' });
    await recv(c, { t: 'camera.frame', seq: 1, mime: 'image/jpeg', width: 2, height: 2, jpeg: 'AAAA' });
    expect($<HTMLImageElement>('img.dv-video')!.src).toBe('data:image/jpeg;base64,AAAA');

    await drive(a);
    expect(a.of('lease.take')).toHaveLength(1);
    expect(a.of('unlock')[0]).toMatchObject({ lease_id: LEASE, stop_gen: 1 });
    expect($('[data-sim-drive]')!.textContent).toContain('움직일 수 있음');
    // 조종권을 쥐면 50 ms 마다 cmd(중립 0 포함), seq 는 엄격히 증가
    await wait(160);
    const before = a.of('cmd');
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(before.every((m) => m.lease_id === LEASE && m.vx === 0 && m.vy === 0 && m.wz === 0)).toBe(true);
    // 전후 조이스틱 끝까지 위 → vx 0.6
    const fwd = stick('전후');
    ptr(fwd, 'pointerdown', 50, 0);
    await wait(120);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0.6, vy: 0, wz: 0 });
    // STOP(머리줄): 에이전트에 직접 stop, 서버 STOP 은 부르지 않음
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
    expect(calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
    await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: true, stop_gen: 2 }));
    await wait(120);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, wz: 0 });
    const seqs = a.of('cmd').map((m) => m.seq as number);
    expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1])).toBe(true);
    ptr(fwd, 'pointerup', 50, 0);

    // 끝내기: 반납 → 연결 닫기 → DELETE → 목록 다시 → IDLE
    await click(btn('끝내기'));
    expect(a.of('lease.release')).toHaveLength(1);
    expect(a.readyState).toBe(3);
    expect(c.readyState).toBe(3);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/simulation/robots/${S1}`]);
    expect(last(calls)!.path).toBe('/simulation/robots');
    expect($('[data-sim-drive]')).toBeNull();
    expect($('[data-sim-msg]')!.textContent).toBe('시뮬 로봇을 정리했습니다.');
    const sent = a.sent.length;
    await wait(120);
    expect(a.sent.length).toBe(sent);   // 닫은 뒤 cmd 0
  });

  it('SIM_SLOT_BUSY(불확실) → 다음 슬롯 자동 시도 0, 목록으로 확인 → 남의 것이면 «사용 중», 사람이 다시 띄우면 다른 슬롯', async () => {
    let n = 0;
    serve({ 'POST /simulation/robots': () => (n++ === 0 ? err(409, 'SIM_SLOT_BUSY', '사용 중인 슬롯입니다.') : { status: 201, body: simRobot(S2) }),
      [`POST /robots/${S2}/phone-pass`]: { status: 200, body: { token: 't2', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' } } });
    await mount();
    const lists = calls.filter((c) => c.path === '/simulation/robots' && c.method === 'GET').length;
    await click(btn('띄우기'));
    const posts = () => calls.filter((c) => c.method === 'POST' && c.path === '/simulation/robots').map((c) => (c.body as { robot_id: string }).robot_id);
    expect(posts()).toEqual([S1]);
    expect(calls.filter((c) => c.path === '/simulation/robots' && c.method === 'GET').length).toBeGreaterThan(lists);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(agents()).toHaveLength(0);
    expect($('[data-sim-msg]')!.textContent).toContain('사용 중인 슬롯입니다.');
    await click(btn('띄우기'));
    expect(posts()).toEqual([S1, S2]);
    expect(agents()[0].url).toBe('ws://127.0.0.1:9482/phone/ws');
  });

  it('SIM_SLOT_BUSY 인데 목록에 내 로봇 → 고르기에서 연결·끝내기 안내, 정리 자동 0', async () => {
    serve({ 'POST /simulation/robots': () => { mine = [simRobot()]; return err(409, 'SIM_SLOT_BUSY', '사용 중인 슬롯입니다.'); } });
    await mount();
    await click(btn('띄우기'));
    expect($('[data-sim-msg]')!.textContent).toContain('이미 내 시뮬 로봇입니다');
    expect(btn('직접 연결')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('SIM_SLOT_BUSY 인데 목록을 못 받음 → «확인 중» 그대로(정리 단추 없음), 다시 확인', async () => {
    serve({ 'POST /simulation/robots': err(409, 'SIM_SLOT_BUSY', '사용 중인 슬롯입니다.') });
    await mount();
    routes['GET /simulation/robots'] = err(503, 'SIMMGR_UNAVAILABLE', '시뮬 관리자에 닿지 못했습니다.');
    await click(btn('띄우기'));
    expect($('[data-sim="unsure"]')!.textContent).toContain('내 것으로 확인되기 전에는 정리하지 않습니다');
    expect(btn('정리')).toBeUndefined();
    routes['GET /simulation/robots'] = () => ({ status: 200, body: { items: [] } });
    await click(btn('다시 확인'));
    expect($('[data-sim-msg]')!.textContent).toContain('사용 중인 슬롯입니다.');
  });

  it('이미 떠 있는 내 시뮬 로봇: 1인 1대라 띄우기 막힘, «직접 연결»로 다시 붙는다', async () => {
    serve(); mine = [simRobot()];
    await mount();
    expect(btn('띄우기')!.disabled).toBe(true);
    expect($('#sim-one')).toBeTruthy();
    await click(btn('직접 연결'));
    expect(calls.some((c) => c.path === `/robots/${S1}/phone-pass`)).toBe(true);
    expect(agents()).toHaveLength(1);
  });
});

describe('시뮬 직결 실패', () => {
  it('증명된 시작 전 자원 거부는 고르기로 돌아가 같은 관리자에 다시 띄운다', async () => {
    serve({ 'POST /simulation/robots': err(503, 'SIM_UNAVAILABLE', '시뮬 요청을 처리하지 못했습니다.',
      { reason: 'resources_low', start_not_created: true }) });
    await mount(); await click(btn('띄우기'));
    expect($('[data-sim-msg]')!.textContent).toBe('PC 자원이 부족해 시뮬을 띄우지 않았습니다(메모리·부하). 잠시 뒤 다시 띄우세요.');
    expect($('[data-sim="unsure"]')).toBeNull();
    expect(btn('띄우기')!.disabled).toBe(false);
    expect($<HTMLButtonElement>('[data-stop]')!.disabled).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    routes['POST /simulation/robots'] = () => ({ status: 201, body: simRobot() });
    await click(btn('띄우기'));
    expect(agents()).toHaveLength(1);
  });

  it('증명 없는 자원 실패는 확인 중·정리·STOP을 유지한다', async () => {
    serve({ 'POST /simulation/robots': err(503, 'SIM_UNAVAILABLE', '시뮬 요청을 처리하지 못했습니다.', { reason: 'resources_low' }) });
    await mount(); await click(btn('띄우기'));
    expect($('[data-sim="unsure"]')!.textContent).toContain('시뮬이 떴는지 다시 확인하거나 정리하세요.');
    expect(btn('정리')!.disabled).toBe(false);
    expect($<HTMLButtonElement>('[data-stop]')!.disabled).toBe(false);
    await click(btn('정리'));
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it.each(['SIM_UNAVAILABLE', 'SIM_DISABLED'])('관리자 %s: 꺼짐과 설정 누락을 구별하고 STOP 유지', async (code) => {
    const off = err(503, code, '시뮬 요청을 처리하지 못했습니다.', { reason: 'manager_unreachable' });
    serve({ 'GET /simulation/worlds': off, 'GET /simulation/robots': off });
    await mount();
    expect($('[data-sim-msg]')!.textContent).toBe(code === 'SIM_DISABLED'
      ? '시뮬 관리자 연결 설정이 없습니다. 관리자에게 설정을 요청하세요.'
      : '시뮬 관리자가 꺼져 있습니다. 관리자를 다시 켠 뒤 정리하세요.');
    expect($<HTMLButtonElement>('[data-stop]')!.disabled).toBe(false);
  });

  it('시작이 불확실한 관리자 꺼짐에는 다시 켠 뒤 정리를 안내한다', async () => {
    serve({ 'POST /simulation/robots': err(503, 'SIM_UNAVAILABLE', '실패', { reason: 'manager_unreachable' }) });
    await mount(); await click(btn('띄우기'));
    expect($('[data-sim="unsure"]')!.textContent).toContain('관리자를 다시 켠 뒤 정리하세요.');
    expect(btn('정리')!.disabled).toBe(false);
  });

  it.each([true, false])('관리자가 모르는 내 슬롯은 정리 대상으로 남고 직접 연결하지 않는다(기록=%s)', async (bound) => {
    let cleanup = [{ robot_id: S1, owner_id: 'u-lee', generation: 1, can_recover: bound }];
    serve({ 'GET /simulation/robots': () => ({ status: 200, body: { items: [], cleanup } }),
      [`DELETE /simulation/robots/${S1}`]: () => { cleanup = []; return { status: 204 }; } });
    await mount();
    expect(box.textContent).toContain('이전 시뮬이 정리되지 않았습니다.');
    expect(box.textContent).not.toContain('— 정리정리');
    expect(box.textContent!.includes('자동 정리할 수 없습니다')).toBe(!bound);
    expect(btn('직접 연결')).toBeUndefined();
    expect(btn('띄우기')!.disabled).toBe(true);
    expect(btn('정리')!.disabled).toBe(false);
    expect($<HTMLButtonElement>('[data-stop]')!.disabled).toBe(false);
    await click(btn('정리'));
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    expect(btn('띄우기')!.disabled).toBe(false);
    expect(agents()).toHaveLength(0);
  });

  it.each(['SIM_DISABLED', 'SIM_UNAVAILABLE'])('목록의 관리자 조회 실패는 잔여로 단정하지 않고 연결 안내를 보인다: %s', async (manager_error) => {
    serve({ 'GET /simulation/robots': { status: 200, body: { items: [], manager_error,
      cleanup: [{ robot_id: S1, owner_id: 'u-lee', generation: 1, can_recover: true }] } } });
    await mount();
    expect(box.textContent).not.toContain('이전 시뮬이 정리되지 않았습니다');
    expect(box.textContent).toContain('관리자가 내 시뮬 자리를 확인하지 못했습니다.');
    expect(box.textContent).toContain(manager_error === 'SIM_DISABLED' ? '연결 설정이 없습니다' : '관리자가 켜져 있는지와 연결을 확인');
    expect(btn('정리')!.disabled).toBe(false);
    expect($<HTMLButtonElement>('[data-stop]')!.disabled).toBe(false);
    expect(calls.some((c) => c.path.endsWith('/phone-pass'))).toBe(false);
  });

  it.each(['이 시뮬 슬롯은 다른 사람이 사용 중입니다.', '시뮬 슬롯의 전환이 끝나지 않았습니다.'])('슬롯 사용 중은 서버 문구 그대로: %s', async (why) => {
    serve({ 'POST /simulation/robots': err(409, 'SIM_SLOT_BUSY', why, { reason: 'slot_busy' }) });
    await mount(); await click(btn('띄우기'));
    const text = $('[data-sim-msg]')!.textContent!;
    expect(text).toContain(why);
    expect(text.split(why)).toHaveLength(2);
    expect(text).not.toContain('답을 받았습니다(');
  });

  it('슬롯 1개 사용 중이면 다른 슬롯 안내 없음, 자동 재시도·정리 0', async () => {
    serve({ 'GET /simulation/worlds': { status: 200, body: { ...CATALOG, slots: [S1], max_robots: 1 } },
      'POST /simulation/robots': err(409, 'SIM_SLOT_BUSY', '시뮬 요청을 처리하지 못했습니다.', { reason: 'slot_busy' }) });
    await mount();
    await click(btn('띄우기'));
    expect($('[data-sim-msg]')!.textContent).toContain('사용이 끝난 뒤 다시 누르세요.');
    expect($('[data-sim-msg]')!.textContent).not.toContain('다른 슬롯');
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/simulation/robots')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it.each([{}, { reason: 'unknown' }, { reason: 'future' }])('이유 없는 옛 응답·모르는 이유 %j 는 기존 문구', async (detail) => {
    serve({ 'POST /simulation/robots': err(503, 'SIM_UNAVAILABLE', '시뮬 요청을 처리하지 못했습니다.', detail) });
    await mount();
    await click(btn('띄우기'));
    expect($('[data-sim="unsure"]')!.textContent).toContain('확인 중 — 시뮬 로봇이 떴는지 확인하지 못했습니다. 시뮬 요청을 처리하지 못했습니다.');
    expect(btn('정리')!.disabled).toBe(false);
  });

  it('START 거부(4xx) → 고르기로 돌아가 이유 표시, 연결 없음', async () => {
    serve({ 'POST /simulation/robots': err(409, 'SIM_ROBOT_LIMIT', '시뮬 로봇 수가 다 찼습니다.') });
    await mount();
    await click(btn('띄우기'));
    expect($('[data-sim-msg]')!.textContent).toContain('시뮬 로봇 수가 다 찼습니다.');
    expect(btn('띄우기')).toBeTruthy();
    expect(agents()).toHaveLength(0);
  });

  it('START 503 → «확인 중»(서버 STARTING 일 수 있음) + 목록 다시, 정리는 DELETE', async () => {
    serve({ 'POST /simulation/robots': err(503, 'SIMMGR_UNAVAILABLE', '시뮬 관리자에 닿지 못했습니다.') });
    await mount();
    const lists = calls.filter((c) => c.path === '/simulation/robots' && c.method === 'GET').length;
    await click(btn('띄우기'));
    expect($('[data-sim="unsure"]')!.textContent).toContain('확인 중 — 시뮬 로봇이 떴는지 확인하지 못했습니다. 시뮬 관리자에 닿지 못했습니다.');
    expect(calls.filter((c) => c.path === '/simulation/robots' && c.method === 'GET').length).toBeGreaterThan(lists);
    expect(agents()).toHaveLength(0);
    await click(btn('정리'));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/simulation/robots/${S1}`]);
    expect($('[data-sim-msg]')!.textContent).toBe('시뮬 로봇을 정리했습니다.');
  });

  it('WS 끊김 → 문구, 조종권 비움, cmd 멈춤, 자동 재연결 없음(다시 연결 버튼)', async () => {
    const a = await launch();
    await drive(a);
    await wait(80);
    act(() => a.drop(1006)); await flush();
    const text = $('[data-sim-drive]')!.textContent!;
    expect(text).toContain('로봇 연결이 끊겼습니다.(1006)');
    expect(text).toContain('연결 끊김');
    expect(text).not.toContain('조종 중(나)');   // 끊긴 뒤 지난 state 로 조종자라 쓰지 않음
    expect(btn('조종 시작')).toBeUndefined();
    expect($('[aria-label="전후 조이스틱"]')).toBeNull();
    const n = a.sent.length, count = FakeWS.all.length;
    await wait(120);
    expect(a.sent.length).toBe(n);
    expect(FakeWS.all.length).toBe(count);
    expect(btn('다시 연결')).toBeTruthy();
    // 끊긴 뒤 STOP: 서버 STOP 대체 경로 0 — 로봇에 보낼 길이 없으니 그 슬롯 정리(DELETE 1회)
    await click($('[data-stop]'));
    expect(calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/simulation/robots/${S1}`]);
  });

  it('띄우는 중 STOP → 서버 stop 0·다른 로봇(rt) stop 0, 문구 «연결 전 — 명령 없음», 201 이 오면 바로 DELETE 1·연결 0', async () => {
    let answer!: (r: Reply) => void;
    serve({ 'POST /simulation/robots': () => new Promise<Reply>((f) => { answer = f; }) });
    await mount();
    await click(btn('띄우기'));
    expect($('[data-sim="starting"]')).toBeTruthy();
    const before = FakeWS.all.map((w) => w.sent.length);
    await click($('[data-stop]'));
    expect($('[data-sim-stop]')!.textContent).toContain('로봇에 연결 전 — 명령 없음, 정리 중');
    expect(FakeWS.all.every((w, i) => w.sent.length === (before[i] ?? 0))).toBe(true);   // rt 등 다른 연결로 stop 0
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);   // 답 전에는 지울 대상이 확정되지 않음
    mine = [simRobot()];
    answer({ status: 201, body: mine[0] }); await flush();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/simulation/robots/${S1}`]);
    expect(calls.some((c) => c.path.endsWith('/stop') || c.path.endsWith('/phone-pass'))).toBe(false);
    expect(agents()).toHaveLength(0);
    expect($('[data-sim-msg]')!.textContent).toBe('시뮬 로봇을 정리했습니다.');
  });

  it('불확실(503) 확인 중 STOP → DELETE 1, 서버 stop 0', async () => {
    serve({ 'POST /simulation/robots': err(503, 'SIMMGR_UNAVAILABLE', '시뮬 관리자에 닿지 못했습니다.') });
    await mount();
    await click(btn('띄우기'));
    expect($('[data-sim="unsure"]')).toBeTruthy();
    await click($('[data-stop]'));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/simulation/robots/${S1}`]);
    expect(calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
  });

  it('세션 종료(화면 내림) 뒤 늦은 201 → 연결 0·출입증 0, 그 로봇만 DELETE 1', async () => {
    let answer!: (r: Reply) => void;
    serve({ 'POST /simulation/robots': () => new Promise<Reply>((f) => { answer = f; }) });
    await mount();
    await click(btn('띄우기'));
    act(() => root?.unmount()); root = null;
    answer({ status: 201, body: simRobot() }); await flush();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/simulation/robots/${S1}`]);
    expect(calls.some((c) => c.path.endsWith('/phone-pass'))).toBe(false);
    expect(agents()).toHaveLength(0);
    // 다시 그린 화면은 고르기부터(늦은 답이 새 세션 상태를 덮지 않음)
    await mount();
    expect(btn('띄우기')).toBeTruthy();
    expect($('[data-sim-drive]')).toBeNull();
  });

  it('세션 종료 뒤 늦은 SIM_SLOT_BUSY → 남의 것일 수 있어 DELETE 0', async () => {
    let answer!: (r: Reply) => void;
    serve({ 'POST /simulation/robots': () => new Promise<Reply>((f) => { answer = f; }) });
    await mount();
    await click(btn('띄우기'));
    act(() => root?.unmount()); root = null;
    answer(err(409, 'SIM_SLOT_BUSY', '사용 중인 슬롯입니다.')); await flush();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('출입증 429 → retry_after 동안 다시 연결 단추 막힘', async () => {
    serve({ [`POST /robots/${S1}/phone-pass`]: { status: 429, body: { error: { code: 'PASS_RATE_LIMIT', message: '요청이 많습니다.', detail: { retry_after: 30 } } } } });
    await mount();
    await click(btn('띄우기'));
    const again = [...box.querySelectorAll('button')].find((b) => b.textContent?.startsWith('다시 연결'))!;
    expect(again.disabled).toBe(true);
    expect(again.textContent).toMatch(/다시 연결\((29|30)초 뒤\)/);
  });

  it('#/drive/<시뮬 로봇 id> 직접 주소 → 옛 서버 경유 조종 화면을 열지 않음', async () => {
    serve();
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    location.hash = `#/drive/${S1}`;
    box = document.createElement('div'); document.body.append(box);
    const robots = [...ROBOTS, { ...ROBOTS[0], id: S1, name: 'sim1', sim: true }];
    act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={robots} />); });
    await flush();
    expect($('h1')!.textContent).toBe('로봇 연결');
    expect($('[data-sim-card]')).toBeTruthy();
  });

  it('출입증 거절(409) → 연결하지 않고 이유 표시', async () => {
    serve({ [`POST /robots/${S1}/phone-pass`]: err(409, 'PASS_OTHER_ROBOT', '이 기기는 다른 로봇에 연결돼 있습니다.') });
    await mount();
    await click(btn('띄우기'));
    expect($('[data-sim="link-fail"]')!.textContent).toContain('출입증을 받지 못했습니다. 이 기기는 다른 로봇에 연결돼 있습니다.');
    expect(agents()).toHaveLength(0);
    expect(btn('다시 연결')).toBeTruthy();
    expect(btn('끝내기')).toBeTruthy();
  });

  it('에이전트가 출입증 거절(4403) → 문구, 자동 재연결 없음', async () => {
    serve(); await mount();
    await click(btn('띄우기'));
    const [a] = agents();
    act(() => a.open()); await flush();
    act(() => a.drop(4403)); await flush();
    expect($('[data-sim="link-fail"]')!.textContent).toContain('로봇이 출입증을 거절했습니다');
    await wait(120);
    expect(agents()).toHaveLength(1);
    expect(calls.filter((c) => c.path === `/robots/${S1}/phone-pass`)).toHaveLength(1);
  });

  it('정리 실패(503) → «확인 중» + 목록 다시, 다시 끝내기 가능', async () => {
    const a = await launch();
    routes[`DELETE /simulation/robots/${S1}`] = err(503, 'SIMMGR_UNAVAILABLE', '시뮬 관리자에 닿지 못했습니다.');
    const lists = calls.filter((c) => c.path === '/simulation/robots' && c.method === 'GET').length;
    await click(btn('끝내기'));
    expect(a.readyState).toBe(3);
    expect($('[data-sim="checking"]')!.textContent).toContain('정리를 확인하지 못했습니다');
    expect(calls.filter((c) => c.path === '/simulation/robots' && c.method === 'GET').length).toBeGreaterThan(lists);
    routes[`DELETE /simulation/robots/${S1}`] = () => { mine = []; return { status: 204 }; };
    await click(btn('다시 끝내기'));
    expect($('[data-sim-msg]')!.textContent).toBe('시뮬 로봇을 정리했습니다.');
  });
});

it.each(['STARTING', 'STOPPING'] as const)('목록의 %s를 전환 안내로 표시하고 STOP·끝내기 유지', async (state) => {
  await launch();
  mine = mine.map((r) => ({ ...r, state }));
  await act(() => sim.load());
  expect(box.textContent).toContain(state === 'STARTING' ? '시뮬을 띄우는 중…' : '시뮬을 정리하는 중…');
  expect(box.textContent).not.toContain('관리자에 연결하지 못했습니다');
  expect($('[data-stop]')).toBeTruthy();
  expect(btn('끝내기')).toBeTruthy();
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
});

it('남은 시간은 단조 시계 기한에서 계산하며 5분·1분 경계를 안내한다', () => {
  const end = 2000_000, at = end;
  expect(remainingTime(end, at - 1800_000)).toBe(1800);
  expect(remainingTime(end, at - 1001)).toBe(2);
  expect(remainingTime(end, at + 1)).toBe(0);
  expect(remainingTime(null, at)).toBeNull();
  expect(timeNotice(301)).toBe('');
  expect(timeNotice(300)).toBe('5분 안에 시뮬을 끝냅니다.');
  expect(timeNotice(61)).toBe('5분 안에 시뮬을 끝냅니다.');
  expect(timeNotice(60)).toBe('1분 안에 시뮬을 끝냅니다.');
  expect(timeNotice(0)).toContain('정리를 확인');
});

it('폰 시계 오차와 무관하게 remaining_s로 세고 증명된 만료 뒤 다시 띄우기·STOP 유지', async () => {
  serve();
  const at = Date.now(), end = new Date(at + 1800_000).toISOString();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 86400_000);
  const mono = vi.spyOn(performance, 'now').mockReturnValue(1000);
  routes['POST /simulation/robots'] = () => {
    mine = [{ ...simRobot(), expires_at: end, remaining_s: 1800 }]; return { status: 201, body: mine[0] };
  };
  try {
    await mount(); await click(btn('띄우기'));
    const a = agents()[0]; act(() => a.open()); await flush(); await recv(a, welcome());
    expect($('[aria-label="상태"]')!.textContent).toContain('남은 시간 30:00');
    clock.mockReturnValue(at - 86400_000);
    mono.mockReturnValue(1501_000);
    mine = mine.map((r) => ({ ...r, remaining_s: 300 }));
    await act(() => sim.load());
    expect(box.textContent).toContain('남은 시간 05:00');
    expect(box.textContent).toContain('5분 안에 시뮬을 끝냅니다.');
    mono.mockReturnValue(1741_000);
    mine = mine.map((r) => ({ ...r, remaining_s: 60 }));
    await act(() => sim.load());
    expect(box.textContent).toContain('남은 시간 01:00');
    expect(box.textContent).toContain('1분 안에 시뮬을 끝냅니다.');
    expect(btn('끝내기')).toBeTruthy();
    expect($('[data-stop]')).toBeTruthy();
    // An old generation is never sufficient to close the current connection.
    routes['GET /simulation/robots'] = { status: 200, body: { items: mine, expired: [
      { robot_id: S1, owner_id: 'u-lee', generation: 99, reason: 'time_limit' },
    ] } };
    await act(() => sim.load()); expect($('[data-sim-drive]')).toBeTruthy();
    // Empty listing alone is also insufficient evidence.
    routes['GET /simulation/robots'] = { status: 200, body: { items: [], expired: [] } };
    mono.mockReturnValue(1801_000); await act(() => sim.load()); await wait(1100);
    expect($('[data-sim-drive]')).toBeTruthy();
    expect(box.textContent).toContain('정리를 확인하고 있습니다');
    routes['GET /simulation/robots'] = { status: 200, body: { items: [], expired: [
      { robot_id: S1, owner_id: 'u-lee', generation: 1, reason: 'time_limit' },
    ] } };
    await act(() => sim.load()); await flush();
    expect(a.readyState).toBe(3);
    expect($('[data-sim-drive]')).toBeNull();
    expect(box.textContent).toContain('시간이 다 되어 시뮬을 끝냈습니다 — 다시 띄우기');
    expect(btn('띄우기')!.disabled).toBe(false);
    expect($('[data-stop]')).toBeTruthy();
  } finally { clock.mockRestore(); mono.mockRestore(); }
});

it('기한 정리 실패 ERROR는 확인 중·STOP·다시 끝내기를 남기며 자동 DELETE 없음', async () => {
  serve();
  routes['POST /simulation/robots'] = () => {
    mine = [{ ...simRobot(), expires_at: new Date(Date.now() + 86400_000).toISOString(), remaining_s: 0 }];
    return { status: 201, body: mine[0] };
  };
  await mount(); await click(btn('띄우기'));
  const a = agents()[0]; act(() => a.open()); await flush(); await recv(a, welcome());
  mine = mine.map((r) => ({ ...r, state: 'ERROR' }));
  await act(() => sim.load()); await flush();
  expect($('[data-sim="checking"]')!.textContent).toContain('시간이 다 되었지만 정리를 확인하지 못했습니다');
  expect(btn('다시 끝내기')).toBeTruthy();
  expect($('[data-stop]')).toBeTruthy();
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  expect(a.readyState).toBe(3);
});

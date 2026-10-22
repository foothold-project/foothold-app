// 폰 ↔ 시뮬 로봇 직결(09 ADR-002 §3·§6, 05 API §13·§13.9) — fetch = 가짜 서버, WebSocket = 가짜 에이전트(FakeWS).
// 띄우기 → 월드 고르기 → 출입증·hello → 조종권·잠금 해제 → 조이스틱 cmd → STOP → 끝내기 + 실패(START 거부, 503, WS 끊김, 출입증 거절, 정리 실패).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimCatalog, SimRobot } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111', S2 = '22222222-2222-4222-8222-222222222222', LEASE = '33333333-3333-4333-8333-333333333333';
const AGENT = 'ws://127.0.0.1:9481/phone/ws';
const CATALOG: SimCatalog = { worlds: [{ id: 'empty', name: '빈 연습장', description: '장애물이 없는 연습 공간' }], slots: [S1, S2], max_robots: 2, launcher: 'native-single' };
const simRobot = (id = S1): SimRobot => ({ generation: 1, robot_id: id, owner_id: 'u-lee', world_id: 'empty', simulation: true, state: 'RUNNING',
  agent_address: AGENT.replace('9481', id === S1 ? '9481' : '9482'), namespace: '/sim1', tf_prefix: 'sim1/', command_topic: '/sim1/cmd', launcher: 'native-single' });
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
async function launch() {
  serve(); await mount();
  await click(btn('띄우기'));
  const a = agents()[0]; a.auto = agentAuto;
  act(() => a.open()); await flush();
  await recv(a, welcome());
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

describe('시뮬 로봇 직결 흐름', () => {
  it('월드 이름·설명·보조 id를 표시하고 선택한 id로 띄운다', async () => {
    serve({ 'GET /simulation/worlds': { status: 200, body: { ...CATALOG, worlds: [
      ...CATALOG.worlds, { id: 'corridor', name: '복도 연습장', description: '' },
    ] } } });
    await mount();
    const list = $('[aria-label="월드 목록"]')!;
    expect(list.querySelector('b')!.textContent).toBe('빈 연습장');
    expect([...list.querySelectorAll('small')].map((el) => el.textContent)).toEqual(['장애물이 없는 연습 공간', 'empty', 'corridor']);
    await click(list.querySelector('input[value="corridor"]'));
    await click(btn('띄우기'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/simulation/robots')!.body).toEqual({ world_id: 'corridor', robot_id: S1 });
  });

  it('띄우기 → 월드 고르기 → 직결 → 조종권·잠금 해제 → 조이스틱 → STOP → 끝내기(반납 → DELETE → 목록)', async () => {
    serve(); await mount();
    // 월드 목록은 계약의 이름·설명과 보조 id
    const list = $('[aria-label="월드 목록"]')!;
    expect(list.textContent).toContain('empty');
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
    expect($('[data-sim-msg]')!.textContent).toContain('다른 사람이 쓰고 있습니다');
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
    expect($('[data-sim-msg]')!.textContent).toContain('다른 사람이 쓰고 있습니다');
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
  it.each([true, false])('자원 부족: 시작 전 증명=%s, 503 확인·정리·STOP 흐름 유지', async (proof) => {
    serve({ 'POST /simulation/robots': err(503, 'SIM_UNAVAILABLE', '시뮬 요청을 처리하지 못했습니다.',
      { reason: 'resources_low', ...(proof ? { start_not_created: true } : {}) }) });
    await mount();
    await click(btn('띄우기'));
    const text = $('[data-sim="unsure"]')!.textContent!;
    expect(text).toContain(proof ? 'PC 자원이 부족해 시뮬을 띄우지 않았습니다(메모리·부하). «정리»를 누른 뒤, 시뮬 관리자를 다시 켜야 다시 띄울 수 있습니다.'
      : 'PC 자원이 부족합니다(메모리·부하). 시뮬이 떴는지 다시 확인하거나 정리하세요.');
    if (!proof) expect(text).not.toContain('띄우지 않았습니다');
    expect(text).not.toMatch(/SIM_UNAVAILABLE|resources_low/);
    expect(btn('정리')!.disabled).toBe(false);
    expect($<HTMLButtonElement>('[data-stop]')!.disabled).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await click(proof ? $('[data-stop]') : btn('정리'));
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('관리자 꺼짐: 목록 실패에 미리보기 다시 켜기 안내, STOP 유지', async () => {
    const off = err(503, 'SIM_UNAVAILABLE', '시뮬 요청을 처리하지 못했습니다.', { reason: 'manager_unreachable' });
    serve({ 'GET /simulation/worlds': off, 'GET /simulation/robots': off });
    await mount();
    expect($('[data-sim-msg]')!.textContent).toBe('시뮬 관리자가 꺼져 있습니다. 미리보기를 다시 켜야 합니다.');
    expect($<HTMLButtonElement>('[data-stop]')!.disabled).toBe(false);
    expect(box.textContent).not.toMatch(/SIM_UNAVAILABLE|manager_unreachable/);
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

// 폰 홈(로봇 연결) 머리의 STOP(10-28 사용자): 멈출 것이 하나도 없다고 확인될 때만 숨긴다. 모르면(실시간 끊김·첫 상태 전·시뮬 목록 실패) 보인다.
// fetch = 가짜 서버(시뮬 목록), WebSocket = 가짜 서버 중재기(FakeWS). 조종 화면·PC 의 STOP 은 이 규칙 밖.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RobotSummary, SimRobot, User as ApiUser } from '../../../contracts/ts';
import { App } from '../App';
import { sim } from '../phone';
import { LIST_MS, Root as Session } from '../session';
import { USERS, type Robot } from './fixtures';
import { FakeWS, lease, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S1 = '11111111-1111-4111-8111-111111111111';
const R1: Robot = { id: 'r1', name: 'Go2-1', owner: 'u-lee', ownerName: '이OO', battery: null, online: false, seenAt: '13:40:05', status: 'IDLE' };
const simRobot = (state: SimRobot['state']): SimRobot => ({ generation: 1, robot_id: S1, owner_id: 'u-lee', world_id: 'empty', simulation: true, state,
  agent_address: 'ws://127.0.0.1:9481/phone/ws', namespace: '/sim1', tf_prefix: 'sim1/', command_topic: '/sim1/cmd', launcher: 'native-single', expires_at: null, remaining_s: null });
type Reply = { status: number; body?: unknown };
let list: () => Reply | Promise<Reply>, more: Record<string, () => Reply> = {};   // more = '<METHOD> <경로>' → 응답(로그인·로봇 목록·띄우기)
const ok = (items: SimRobot[] = [], extra: object = {}) => () => ({ status: 200, body: { items, ...extra } });
const fail = (status: number, code: string) => () => ({ status, body: { error: { code, message: '', detail: {} } } });
function serve() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/^\/api\/v1/, '').split('?')[0], hit = more[`${init.method ?? 'GET'} ${path}`];
    const rep = hit ? hit() : path === '/simulation/robots' ? await list() : path === '/simulation/worlds' ? { status: 200, body: { worlds: [], slots: [S1], max_robots: 1, launcher: 'native-single', manager_instance_id: null } }
      : fail(404, 'NOT_FOUND')();
    return new Response(JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}

let root: Root | null = null, box: HTMLDivElement, w: FakeWS;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function mount(robots: Robot[] = [R1], hash = '#/drive') {
  serve();
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;   // 폰 틀
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS[1]} robots={robots} />); });
  w = FakeWS.last;
  await flush();
}
const open = () => act(() => { w.open(); });
const recv = (m: object) => act(() => { w.recv(m); });
const stopShown = () => !!box.querySelector('.fh-head [data-stop]');
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); sim.clear(); more = {}; });

describe('폰 홈 머리 STOP — 멈출 것이 없을 때만 숨김', () => {
  it('멈출 것 0(내 로봇 끊김·조종권·실행·시뮬 0, 실시간·시뮬 목록 확인) → 숨김', async () => {
    list = ok();
    await mount();
    open(); recv(state('r1', { connection: 'OFFLINE' }));
    expect(stopShown()).toBe(false);
  });
  it('상태 모름 → 보임: 실시간 연결 전·첫 상태 전, 끊김', async () => {
    list = ok();
    await mount();
    expect(stopShown()).toBe(true);   // 소켓 열리기 전
    open();
    expect(stopShown()).toBe(true);   // 첫 state 전
    recv(state('r1', { connection: 'OFFLINE' }));
    expect(stopShown()).toBe(false);
    act(() => { w.close(1006); });
    expect(stopShown()).toBe(true);   // 실시간 끊김
  });
  it('시뮬 목록 실패·관리자 오류 → 보임', async () => {
    list = () => ({ status: 503, body: { error: { code: 'SIM_UNAVAILABLE', message: '', detail: {} } } });
    await mount();
    open(); recv(state('r1', { connection: 'OFFLINE' }));
    expect(stopShown()).toBe(true);
    list = ok([], { manager_error: 'SIM_UNAVAILABLE' });
    await act(async () => { await sim.load(); });
    expect(stopShown()).toBe(true);
    list = ok([], { manager_error: 'SIM_DISABLED' });   // 시뮬 설정 없음 = 시뮬이 없음
    await act(async () => { await sim.load(); });
    expect(stopShown()).toBe(false);
  });
  it('상태가 생기는 순간 다시 보임: 로봇 연결 · 내 조종권 · 끝나지 않은 실행 · 떠 있는/정리할 내 시뮬', async () => {
    list = ok();
    await mount([R1, { ...R1, id: 'r2', name: 'Go2-2', mission: '순찰' }]);
    open(); recv(state('r1', { connection: 'OFFLINE' })); recv(state('r2', { connection: 'OFFLINE' }));
    expect(stopShown()).toBe(true);   // r2 실행이 끝나지 않음
    await act(async () => { root!.render(<App user={USERS[1]} robots={[R1]} />); });
    expect(stopShown()).toBe(false);
    recv(state('r1'));   // ONLINE
    expect(stopShown()).toBe(true);
    recv(state('r1', { connection: 'OFFLINE' }));
    expect(stopShown()).toBe(false);
    recv(lease('r1', { id: 'u-lee', name: '이OO' }, 'L1'));
    expect(stopShown()).toBe(true);
    recv(lease('r1', null));
    expect(stopShown()).toBe(false);
    for (const s of ['STARTING', 'RUNNING', 'STOPPING', 'ERROR'] as const) {
      list = ok([simRobot(s)]);
      await act(async () => { await sim.load(); });
      expect(stopShown(), s).toBe(true);
    }
    list = ok([], { cleanup: [{ robot_id: S1, owner_id: 'u-lee', can_recover: true }] });
    await act(async () => { await sim.load(); });
    expect(stopShown()).toBe(true);
    list = ok();
    await act(async () => { await sim.load(); });
    expect(stopShown()).toBe(false);
  });
  it('로봇 목록 다시 받기 실패(5xx·네트워크) → 보임, 다시 받기에 성공한 뒤에만 숨김', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const LEE: ApiUser = { id: 'u-lee', username: 'lee', display_name: '이OO', role: 'OPERATOR', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
    const R: RobotSummary = { id: 'r1', name: 'Go2-1', model: 'unitree_go2', owner: { id: 'u-lee', display_name: '이OO' }, simulation: false,
      connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
    const robots = () => ({ status: 200, body: { items: [R], next_cursor: null } });
    list = ok();
    more = { 'GET /auth/session': () => ({ status: 200, body: { client: 'web', csrf_token: 'c' } }), 'GET /me': () => ({ status: 200, body: LEE }), 'GET /robots': robots };
    serve();
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    location.hash = '#/drive';
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<Session />); });
    await flush();
    w = FakeWS.last;
    open(); recv(state('r1', { connection: 'OFFLINE' }));
    expect(stopShown()).toBe(false);
    const tick = async () => { act(() => { vi.advanceTimersByTime(LIST_MS); }); await flush(); };
    more['GET /robots'] = fail(503, 'UNAVAILABLE');
    await tick();
    expect(stopShown()).toBe(true);   // 새 담당 로봇·실행이 생겼는지 모름
    more['GET /robots'] = () => { throw new TypeError('network'); };
    await tick();
    expect(stopShown()).toBe(true);
    more['GET /robots'] = robots;
    await tick();
    expect(stopShown()).toBe(false);
  });
  it('불확실한 띄우기 뒤 «처음으로» → 새 시뮬 목록이 없다고 확인할 때까지 보임(예전 빈 목록으로 숨기지 않음)', async () => {
    list = ok();
    await mount();
    open(); recv(state('r1', { connection: 'OFFLINE' }));
    expect(stopShown()).toBe(false);   // 빈 시뮬 목록 확인
    more['POST /simulation/robots'] = fail(500, 'INTERNAL');   // 떴는지 모름
    list = fail(503, 'SIM_UNAVAILABLE');
    await act(async () => { await sim.start('empty', 'u-lee'); });
    await flush();
    expect(sim.get().step).toBe('unsure');
    expect(stopShown()).toBe(true);
    let answer!: (r: Reply) => void;
    list = () => new Promise((r) => { answer = r; });   // «처음으로» 뒤 목록 답이 늦음
    act(() => { sim.reset(); });
    await flush();
    expect(stopShown()).toBe(true);
    await act(async () => { answer(ok([simRobot('STARTING')])()); });
    await flush();
    expect(stopShown()).toBe(true);   // 실제로 떠 있었음
    list = ok();
    await act(async () => { await sim.load(); });
    expect(stopShown()).toBe(false);   // 새 목록이 없다고 확인
  });
  it('숨김은 폰 홈만 — 기록 화면은 그대로 보임', async () => {
    list = ok();
    await mount([R1], '#/history');
    open(); recv(state('r1', { connection: 'OFFLINE' }));
    await act(async () => { await sim.load(); });
    expect(stopShown()).toBe(true);
  });
  it('멈출 후보 0(내 로봇 0대) 인데 상태 모름 → STOP 은 보이고, 누르면 빈 고르기 대신 «멈출 로봇 없음» 안내', async () => {
    list = ok();
    await mount([]);   // 소켓 열리기 전 = 모름 → 보임
    expect(stopShown()).toBe(true);
    act(() => { box.querySelector<HTMLElement>('.fh-head [data-stop]')!.click(); });
    expect(box.querySelector('[data-no-stop]')?.textContent).toContain('이 앱으로 멈출 로봇이 없습니다 — 현장에서 로봇을 직접 멈추세요');
    expect(box.querySelector('[aria-label="정지할 로봇"]')).toBeNull();
    expect(stopShown()).toBe(true);   // 안내 뒤에도 STOP 은 그대로
  });
});

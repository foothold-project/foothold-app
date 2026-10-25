// 폰 ↔ 시뮬 로봇 직결(09 ADR-002 §3·§6, 05 API §13·§13.9) — fetch = 가짜 서버, WebSocket = 가짜 에이전트(FakeWS).
// 띄우기 → 월드 고르기 → 출입증·hello → 조종권·잠금 해제 → 조이스틱 cmd → STOP → 끝내기 + 실패(START 거부, 503, WS 끊김, 출입증 거절, 정리 실패).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FloorContext, Scenario, SimCatalog, SimRobot } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';
import { DEAD, NUDGE, TURN_ON, allowed, sim, velocity, type Axes } from '../phone';
import { STALLED, remainingTime, timeNotice } from '../simdrive';
import { newer } from '../simmap';

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
/** 오른쪽 위 설정 메뉴 → «설정»·«정보»(나가기는 왼쪽 위 «<») */
const menuItem = async (t: string) => { await click($('[data-sim-menu]')); await click([...box.querySelectorAll('.dv-menu button')].find((b) => b.textContent === t)); };

/** 띄우기 → 출입증 → hello → welcome 까지 */
async function launch(hello = welcome(), more: typeof routes = {}) {
  serve(more); await mount();
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
  it('이산 모드(vx_mode 없음)는 기존 식 그대로(제자리 회전만 0)', () => {
    const w = hello(welcome().limits), old = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v >= 0 ? v * hi : -v * lo));
    for (let f = -1; f <= 1; f += 0.05) for (const t of [-1, -0.3, 0, 0.4, 1]) {
      const vx = old(f, 0, 0.6);
      expect(velocity([f, t], w)).toEqual({ vx, vy: 0, wz: vx === 0 ? 0 : old(t, -0.5, 0.5) });
    }
  });
  it('연속 모드: 3단 숨김·상태 줄 값·놓으면 즉시 0·STOP 늘 보임', async () => {
    const a = await launch({ ...welcome(), limits: CONT }); await drive(a);
    await menuItem('설정');
    expect($('[aria-label="속도 단계"]')).toBeNull();
    expect(box.textContent).not.toContain('보통 · 0.6 m/s');
    expect(box.textContent).toContain('시뮬 전용 · 멈출 때 가끔 넘어질 수 있음(측정 34회 중 3회)');
    expect(box.textContent).toContain('후진·옆걸음·제자리 회전은 아직 지원하지 않습니다');
    expect($('[data-sim-exp]')).toBeNull();
    await click(btn('닫기'));
    expect($('[data-sim-vx]')!.textContent).toBe('0.00 m/s');
    expect($('[data-stop]')).toBeTruthy();
    const fwd = stick('전후');
    ptr(fwd, 'pointerdown', 50, 0); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 1, vy: 0, wz: 0 });
    expect($('[data-sim-vx]')!.textContent).toBe('1.00 m/s');
    ptr(fwd, 'pointermove', 50, 44); await wait(80);
    expect(last(a.of('cmd')).vx).toBeCloseTo(0.2 + 0.8 * 0.02 / 0.9, 9);
    ptr(fwd, 'pointermove', 50, 46); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0 });
    ptr(fwd, 'pointermove', 50, 25); await wait(80);
    expect($('[data-sim-vx]')!.textContent).toBe('0.56 m/s');
    ptr(fwd, 'pointerup', 50, 25);
    const n = a.of('cmd').length; await wait(60);
    expect(a.of('cmd').slice(n).every((m) => m.vx === 0 && m.wz === 0)).toBe(true);
    expect(a.of('cmd').length).toBeGreaterThan(n);
    expect($('[data-sim-vx]')!.textContent).toBe('0.00 m/s');
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

const OMNI = { ...CONT, vx_min: -0.3, vy_min: -0.3, vy_max: 0.3 }, EXP = { ...OMNI, experimental: ['reverse', 'lateral', 'turn_in_place'] };
const arrows = (label: string) => [...stick(label).querySelectorAll('[data-arrow]')].map((p) => `${p.getAttribute('data-arrow')}${p.hasAttribute('data-off') ? '-' : '+'}`).join(' ');
describe('시뮬 상하좌우·회전 조이스틱(10-25)', () => {
  it('실기 limits: 옆·뒤는 늘 0, 막힌 방향 없음 판정', () => {
    for (const L of [welcome().limits, CONT]) {
      const w = hello(L);
      for (let f = -1; f <= 1; f += 0.05) for (const y of [-1, -0.5, 0, 0.5, 1]) {
        const v = velocity([f, 0.3, y], w);
        expect(v.vy).toBe(0); expect(v.vx).toBeGreaterThanOrEqual(0);
      }
      expect(allowed(w)).toEqual({ back: false, left: false, right: false, spin: false, experimental: false });
    }
  });
  it('시뮬 limits: 4방향 — 뒤 vx_min_moving~|vx_min|, 옆 데드존 밖 비례', () => {
    const w = hello(OMNI);
    expect(velocity([-1, 0, 0], w)).toEqual({ vx: expect.closeTo(-0.3, 9), vy: 0, wz: 0 });
    expect(velocity([-DEAD - 1e-6, 0, 0], w).vx).toBeCloseTo(-0.2, 5);
    expect(velocity([0, 0, 1], w)).toEqual({ vx: 0, vy: 0.3, wz: 0 });
    expect(velocity([0, 0, -1], w)).toEqual({ vx: 0, vy: -0.3, wz: 0 });
    expect(velocity([0, 0, DEAD], w).vy).toBe(0);
    expect(velocity([1, 1, 0.55], w)).toEqual({ vx: 1, vy: expect.closeTo(0.15, 9), wz: 0.5 });
    expect(allowed(w)).toMatchObject({ back: true, left: true, right: true, spin: false, experimental: false });
    expect(allowed(hello({ ...OMNI, experimental: ['turn_in_place'] })).spin).toBe(true);
  });
  it('축 고정·시뮬 회전 ±max: 정상 조작은 에이전트 양자화(|vy|≥0.05·|fw|≥1)에 안 잘림, 실기 식 불변', () => {
    const w = hello(EXP);
    // 앞 + 작은 옆 흔들림 → vy 0, 옆 + 작은 앞 흔들림 → vx 0(0.2 로 튀지 않음)
    for (const y of [-0.25, -0.12, 0.12, 0.25]) expect(velocity([0.6, 0, y], w).vy).toBe(0);
    expect(velocity([1, 0, 0.3], w)).toEqual({ vx: 1, vy: 0, wz: 0 });
    expect(velocity([0.2, 0, 1], w)).toEqual({ vx: 0, vy: 0.3, wz: 0 });
    // 대각선(둘 다 큼)은 그대로
    const d = velocity([0.8, 0, -0.6], w);
    expect(d.vx).toBeCloseTo(0.2 + 0.8 * 0.7 / 0.9, 9); expect(d.vy).toBeCloseTo(-0.3 * 0.5 / 0.9, 9); expect(Math.abs(d.vy)).toBeGreaterThanOrEqual(0.05);
    // 회전: 문턱 아래 0, 넘으면 ±wz_max 두 값만(부분 회전 wz 없음)
    for (const t of [0.1, 0.3, 0.49, -0.49]) expect(velocity([1, t], w).wz).toBe(0);
    for (const t of [0.5, 0.7, 1]) { expect(velocity([1, t], w).wz).toBe(0.5); expect(velocity([1, -t], w).wz).toBe(-0.5); }
    expect(velocity([0, 0.8], w).wz).toBe(0.5);   // 제자리 회전 허가(turn_in_place)
    expect(velocity([0, 0.8], hello(OMNI)).wz).toBe(0);   // 허가 없으면 그대로 0
    // 실기 limits: 축 고정·회전 문턱 없이 기존 식(옆 범위 0)
    const r = hello(welcome().limits), old = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v >= 0 ? v * hi : -v * lo));
    for (let f = -1; f <= 1; f += 0.05) for (const t of [-1, -0.3, 0, 0.4, 1]) for (const y of [-1, -0.1, 0, 0.3, 1]) {
      const vx = old(f, 0, 0.6);
      expect(velocity([f, t, y], r)).toEqual({ vx, vy: 0, wz: vx === 0 ? 0 : old(t, -0.5, 0.5) });
    }
  });
  it('시뮬(EXP): 스틱이 눌려 있으면 정확한 0 을 보내지 않음(deadman 뒤 손 뗌 관문 — PR #92 Codex), 손 뗌만 0', () => {
    for (const L of [EXP, { ...CONT, experimental: ['turn_in_place'] }]) {
      const w = hello(L);
      expect(velocity([0, 0, 0], w)).toEqual({ vx: 0, vy: 0, wz: 0 });
      expect(velocity([0, 0], w)).toEqual({ vx: 0, vy: 0, wz: 0 });
      for (let f = -20; f <= 20; f++) for (let t = -20; t <= 20; t++) for (let y = -10; y <= 10; y++) {
        if (!f && !t && !y) continue;
        const a: Axes = [f / 20, t / 20, y / 10], v = velocity(a, w);
        if (v.vx === 0 && v.vy === 0 && v.wz === 0) throw new Error(`${a} → 정확한 0`);
        // 움직이지 않는 표시값 wz 는 에이전트 회전 문턱(wz_max) 아래 — 일부러 돌릴 때(±wz_max)만 문턱
        if (v.vx === 0 && v.vy === 0) expect(Math.abs(v.wz) === L.wz_max || Math.abs(v.wz) < L.wz_max * TURN_ON).toBe(true);
      }
    }
    // Codex 재현: 단독 회전 t=0.3 은 부모와 같은 작은 wz(에이전트가 잘라 sentinel), 문턱 위는 ±wz_max, 데드존은 NUDGE
    const w = hello(EXP);
    expect(velocity([0, 0.3], w)).toEqual({ vx: 0, vy: 0, wz: 0.15 });
    expect(velocity([0, -0.49], w)).toEqual({ vx: 0, vy: 0, wz: expect.closeTo(-0.245, 9) });
    expect(velocity([0, 0.6], w)).toEqual({ vx: 0, vy: 0, wz: 0.5 });
    expect(velocity([DEAD, 0, 0.05], w)).toEqual({ vx: 0, vy: 0, wz: NUDGE });
    expect(velocity([1, 0.3], w)).toEqual({ vx: 1, vy: 0, wz: 0 });   // 움직이는 중 문턱 아래 회전은 그대로 0
  });
  it('experimental 있음: 시험용 띠, 뒤·옆·제자리 회전 보냄, 화살표 모두 켬, STOP 보임', async () => {
    const a = await launch({ ...welcome(), limits: EXP }); await drive(a);
    const exp = $('[data-sim-exp]')!, full = '시뮬 시험용 — 후진·옆걸음·제자리 회전은 넘어질 수 있습니다';
    expect(exp.textContent).toBe('시험용 · 넘어질 수 있음');   // 10-25: 영상 위 큰 띠 대신 작은 표시, 긴 문장은 aria·설정 시트
    expect(exp.getAttribute('aria-label')).toBe(full);
    expect(exp.closest('.dv-act')).toBeNull();
    expect(arrows('전후')).toBe('up+ down+ left+ right+');
    expect(arrows('회전')).toBe('left+ right+');
    const left = stick('전후'), turn = stick('회전');
    ptr(left, 'pointerdown', 50, 100); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: expect.closeTo(-0.3, 9), vy: 0, wz: 0 });
    ptr(left, 'pointermove', 0, 50); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0.3, wz: 0 });
    expect(box.textContent).not.toContain('지원하지 않습니다');
    ptr(left, 'pointerup', 0, 50);
    ptr(turn, 'pointerdown', 0, 50); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: 0.5 });
    ptr(turn, 'pointermove', 100, 50); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: -0.5 });
    expect(box.textContent).not.toContain('제자리 회전 — 시뮬에서 아직 확인 안 됨');
    ptr(turn, 'pointerup', 0, 50); await wait(60);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    expect($('[data-stop]')).toBeTruthy();
  });
  it('experimental 없음: 띠 없음, 회전만 밀면 제자리 막힘 안내(명령 범위 조정과 같은 말)', async () => {
    const a = await launch({ ...welcome(), limits: OMNI }); await drive(a);
    expect($('[data-sim-exp]')).toBeNull();
    const turn = stick('회전');
    ptr(turn, 'pointerdown', 100, 50); await wait(80);
    expect(box.textContent).toContain('제자리 회전 — 시뮬에서 아직 확인 안 됨. 앞으로 밀면서 돌리세요.');
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: 0 });   // PR #88 B1: 허가 없으면 제자리 wz 를 보내지 않음
    ptr(turn, 'pointermove', 0, 50); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    const left = stick('전후');
    ptr(left, 'pointerdown', 50, 0); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 1, vy: 0, wz: 0.5 });   // 앞+회전은 그대로
    ptr(left, 'pointerup', 50, 0);
    ptr(turn, 'pointerup', 0, 50);
    await recv(a, { t: 'cmd.ack', clipped: true });
    expect(box.textContent).toContain('명령 범위 조정 — 허용 범위로 잘랐습니다.');   // 10-25: 영상 위는 짧은 한 줄, 범위 숫자는 설정 시트
    expect(box.textContent).not.toContain('끝까지 밀어야');
    await menuItem('설정');
    expect($('[data-sim-range]')!.textContent).toBe('로봇 허용 범위(앞 1.00 m/s, 뒤 0.30 m/s, 옆 ±0.3 m/s, 회전 ±0.5 rad/s) 밖은 잘라 보냅니다. 제자리 회전은 앞으로 밀면서 돌리세요.');
  });
  it('명령 범위 조정은 새로 잘릴 때만 잠깐(3 s) — 계속 잘려도 영상 위에 남지 않고, 다시 잘리면 다시 뜸', async () => {
    const a = await launch({ ...welcome(), limits: OMNI }); await drive(a);
    const clipNote = () => [...box.querySelectorAll('.dv-act .dv-note')].some((p) => p.textContent?.startsWith('명령 범위 조정'));
    await recv(a, { t: 'cmd.ack', clipped: true });
    expect(clipNote()).toBe(true);
    await wait(4200);
    await recv(a, { t: 'cmd.ack', clipped: true });
    expect(clipNote()).toBe(false);
    await recv(a, { t: 'cmd.ack', clipped: false });
    await recv(a, { t: 'cmd.ack', clipped: true });
    expect(clipNote()).toBe(true);
    expect($('[data-stop]')).toBeTruthy();
  }, 10000);
  it('조종 화면: 길게 누르기 메뉴 막음, 영상 그림 끌기 없음', async () => {
    const a = await launch(); await drive(a);
    const c = cams()[0];
    act(() => c.open());
    await recv(c, { t: 'camera.frame', seq: 1, mime: 'image/jpeg', width: 2, height: 2, jpeg: 'AAAA' });
    expect($<HTMLImageElement>('img.dv-video')!.draggable).toBe(false);
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => { stick('전후').dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(true);
  });
  it('실기 limits 화면: 아래·옆 화살표 흐림, 옆으로 밀면 0 + 이유, 띠 없음', async () => {
    const a = await launch(); await drive(a);
    expect($('[data-sim-exp]')).toBeNull();
    expect(arrows('전후')).toBe('up+ down- left- right-');
    const left = stick('전후');
    ptr(left, 'pointerdown', 0, 50); await wait(80);
    expect(box.textContent).toContain('옆걸음은 아직 지원하지 않습니다 — 시뮬에서 아직 확인 안 됨');
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    ptr(left, 'pointermove', 100, 50); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vy: 0 });
    ptr(left, 'pointerup', 100, 50);
    expect($('[data-stop]')).toBeTruthy();
  });
});

describe('시뮬 로봇 직결 흐름', () => {
  it('검증된 보통만 사용 가능, 후진·제자리 회전은 미확인 안내, STOP 유지', async () => {
    const a = await launch(); await drive(a);
    await menuItem('설정');
    const speeds = $('[aria-label="속도 단계"]')!;
    const buttons = [...speeds.querySelectorAll('button')];
    expect(buttons.map((b) => [b.textContent, b.disabled, b.getAttribute('aria-pressed')])).toEqual([
      ['느림', true, 'false'], ['보통 · 0.6 m/s', false, 'true'], ['빠름', true, 'false'],
    ]);
    expect(box.textContent).toContain('느림·빠름·후진·옆걸음·제자리 회전: 시뮬에서 아직 확인 안 됨');
    await click(buttons[0]); await click(buttons[2]);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    await click(btn('닫기'));
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
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, vy: 0, wz: 0 });   // 실기 limits: 제자리 wz 안 보냄(PR #88 B1)
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
    expect($('.dv-top')!.textContent).not.toContain('움직일 수 있음');   // 정상이면 영상 위에 잠금 표시 없음 — 정보에
    await menuItem('정보');
    expect($('[data-sim-info]')!.textContent).toContain('움직일 수 있음');
    await click(btn('닫기'));
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
    await click(btn('시뮬 끝내기'));
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
    expect(btn('조종 화면 띄우기')).toBeTruthy();
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

  it('이미 떠 있는 내 시뮬 로봇: 1인 1대라 띄우기 막힘, «조종 화면 띄우기»로 다시 붙는다', async () => {
    serve(); mine = [simRobot()];
    await mount();
    expect(btn('띄우기')!.disabled).toBe(true);
    expect($('#sim-one')).toBeTruthy();
    expect(btn('직접 연결')).toBeUndefined();   // 같은 로봇 단추는 맨 위 한 개
    await click(btn('조종 화면 띄우기'));
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
    await click(btn('시뮬 끝내기'));
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
  expect(btn('시뮬 끝내기')).toBeTruthy();
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
    await menuItem('정보');
    expect($('[data-sim-info]')!.textContent).toContain('남은 시간 30:00');
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
    expect(btn('시뮬 끝내기')).toBeTruthy();
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

describe('시뮬 조종 화면 덮개(10-23 — 다시 들어가기·설정 메뉴·속도 표시)', () => {
  it('새로고침 뒤 내 RUNNING 시뮬 로봇 → 카드 맨 위 «조종 화면 띄우기» 한 개, 자동 연결·자동 조종권 0', async () => {
    serve(); mine = [simRobot(), { ...simRobot(S2), owner_id: 'u-kim' }];   // 새로고침 = 빈 상태에서 목록만 받음
    await mount();
    expect(calls.some((c) => c.method === 'GET' && c.path === '/simulation/robots')).toBe(true);
    const card = $('[aria-label="시뮬 로봇 띄우기"]')!;
    expect(card.children[1]).toBe($('[data-sim-resume]'));
    expect(box.querySelectorAll('[data-sim-resume]')).toHaveLength(1);
    expect(agents()).toHaveLength(0);
    expect(calls.some((c) => c.path.endsWith('/phone-pass'))).toBe(false);
    await click(btn('조종 화면 띄우기'));
    const [a] = agents(); a.auto = agentAuto;
    expect(a.url).toBe(AGENT);
    act(() => a.open()); await flush(); await recv(a, welcome()); await recv(a, phoneState());
    expect($('[data-sim-drive]')).toBeTruthy();
    expect(btn('조종 시작')).toBeTruthy();
    await wait(120);
    expect(a.of('lease.take')).toHaveLength(0);
    expect(a.of('unlock')).toHaveLength(0);
    expect(a.of('cmd')).toHaveLength(0);
  });

  it('남의 로봇·아직 띄우는 중인 내 로봇에는 «조종 화면 띄우기» 없음', async () => {
    serve(); mine = [{ ...simRobot(), state: 'STARTING' }, { ...simRobot(S2), owner_id: 'u-kim' }];
    await mount();
    expect($('[data-sim-resume]')).toBeNull();
    expect(btn('직접 연결')).toBeTruthy();
  });

  it('기본 화면: 상태 줄·정책·지연은 숨기고 위 가운데 알약 «시뮬 · 실행 중 · 0.40 m/s»만, 정보 메뉴에서 보임', async () => {
    const a = await launch({ ...welcome(), limits: CONT }); await drive(a);
    const top = $('.dv-top')!;
    expect(top.textContent).toBe('시뮬 · 실행 중 · 0.00 m/s');   // 시뮬 표시 + 상태 + 속도뿐(정상이면 잠금 표시 없음)
    expect(box.textContent).not.toContain('정책 go2-flat');
    expect(box.textContent).not.toContain('시뮬 시계 차');
    const fwd = stick('전후');
    ptr(fwd, 'pointerdown', 50, 33.75); await wait(80);
    expect($('[data-sim-vx]')!.textContent).toBe('0.40 m/s');
    expect($('[data-sim-vx]')!.textContent).toMatch(/^\d+\.\d{2} m\/s$/);
    ptr(fwd, 'pointerup', 50, 33.75);
    await menuItem('정보');
    const info = $('[data-sim-info]')!.textContent!;
    expect(info).toContain('정책 go2-flat v1');
    expect(info).toContain('시뮬 시계 차 0.2 s');
    expect(info).toContain('조종 중(나)');
  });

  it('메뉴·설정 시트가 열려 있어도 STOP 은 보이고 눌림(에이전트에 stop 1회)', async () => {
    const a = await launch(); await drive(a);
    await click($('[data-sim-menu]'));
    expect($('[data-sim-menu]')!.getAttribute('aria-expanded')).toBe('true');
    expect(box.querySelector('.dv-stage [data-stop]')).toBeNull();   // STOP 은 영상 칸(메뉴·시트) 밖 머리줄
    let s = $<HTMLButtonElement>('[data-stop]')!;
    expect(s.disabled).toBe(false);
    await click(s);
    expect(a.of('stop')).toHaveLength(1);
    await click([...box.querySelectorAll('.dv-menu button')].find((b) => b.textContent === '설정'));
    expect($('[data-sheet]')).toBeTruthy();
    s = $<HTMLButtonElement>('[data-stop]')!;
    expect(s.disabled).toBe(false);
    await click(s);
    expect(a.of('stop')).toHaveLength(2);
    expect(calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
  });

  it('메뉴가 열리면 누르고 있던 입력도 0, 조이스틱 막힘 → 나가기 = 반납 후 카드로(시뮬 그대로, DELETE 0), 다시 들어가도 자동 재개 0', async () => {
    const a = await launch(); await drive(a);
    const fwd = stick('전후');
    ptr(fwd, 'pointerdown', 50, 0); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0.6 });
    await click($('[data-sim-menu]'));
    const n = a.of('cmd').length; await wait(120);
    expect(a.of('cmd').length).toBeGreaterThan(n);
    expect(a.of('cmd').slice(n).every((m) => m.vx === 0 && m.wz === 0)).toBe(true);
    expect(stick('전후').getAttribute('aria-disabled')).toBe('true');
    ptr(stick('전후'), 'pointerdown', 50, 0); ptr(stick('회전'), 'pointerdown', 0, 50); await wait(80);   // 막힌 조이스틱은 새로 눌러도 0
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, wz: 0 });
    expect($('[data-sim-vx]')!.textContent).toBe('0.00 m/s');
    // 나가기(왼쪽 위 «<»)
    await click($('[data-sim-leave]'));
    expect(a.of('lease.release')).toHaveLength(1);
    const cmds = a.of('cmd');
    expect(cmds.every((m, i) => i < n || (m.vx === 0 && m.wz === 0))).toBe(true);
    expect(a.readyState).toBe(3);
    const sent = a.sent.length; await wait(120);
    expect(a.sent.length).toBe(sent);   // 나간 뒤 명령 0
    expect($('[data-sim-drive]')).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(btn('조종 화면 띄우기')).toBeTruthy();
    expect($('[data-stop]')).toBeTruthy();
    // 다시 들어가기: 새 연결, 조종권·잠금 해제는 처음부터
    await click(btn('조종 화면 띄우기'));
    const b = last(agents()); b.auto = agentAuto;
    expect(b).not.toBe(a);
    act(() => b.open()); await flush(); await recv(b, welcome()); await recv(b, phoneState());
    expect(btn('조종 시작')).toBeTruthy();
    await wait(120);
    expect(b.of('lease.take')).toHaveLength(0);
    expect(b.of('cmd')).toHaveLength(0);
  });

  it('나가기 반납 거절: 조종 화면에 남아 «확인하지 못했습니다»·다시 반납·STOP, 입력 0 → 다시 반납 확인되면 카드로', async () => {
    const a = await launch(); await drive(a);
    a.auto = ((m: Msg) => m.t === 'lease.release' ? undefined : agentAuto!(m)) as FakeWS['auto'];
    await click($('[data-sim-leave]'));
    expect(a.of('lease.release')).toHaveLength(1);
    await recv(a, { t: 'reply', id: a.of('lease.release')[0].id, ok: false, lease_id: null, error: { code: 'STOP_CONFIRM_FAILED', message: 'failed' } });   // 실제 WS 처럼 답은 보낸 뒤에
    expect($('[data-sim-drive]')).toBeTruthy();
    expect(box.textContent).toContain('조종권 반납을 확인하지 못했습니다');
    expect(a.readyState).toBe(1);   // 연결·대상 보존
    await wait(120);
    expect(a.of('cmd').every((m) => m.vx === 0 && m.wz === 0)).toBe(true);
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
    // 서버가 아직 내 조종권이라고 알림 → 다시 반납이 확인되면 카드로
    await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: true, stop_gen: 2 }));
    a.auto = agentAuto;
    await click(btn('다시 반납'));
    expect(a.of('lease.release')).toHaveLength(2);
    expect($('[data-sim-drive]')).toBeNull();
    expect(btn('조종 화면 띄우기')).toBeTruthy();
  });

  it('나가기 반납 무응답 2초: 조종 화면에 남아 실패 표시·STOP 대상 보존, 입력 0', async () => {
    const a = await launch(); await drive(a);
    a.auto = ((m: Msg) => m.t === 'lease.release' ? undefined : agentAuto!(m)) as FakeWS['auto'];
    await click($('[data-sim-leave]'));
    const n = a.of('cmd').length;
    await wait(2100);
    expect($('[data-sim-drive]')).toBeTruthy();
    expect(box.textContent).toContain('조종권 반납을 확인하지 못했습니다');
    expect(btn('다시 반납')).toBeTruthy();
    expect(a.readyState).toBe(1);
    expect(a.of('cmd').slice(n).every((m) => m.vx === 0 && m.wz === 0)).toBe(true);
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('시뮬 조종 화면 구도·시나리오 띠(10-23 — 아래 단추 하나)', () => {
  const F1 = 'f-1', F2 = 'f-2';
  const MAPPED: SimCatalog = { ...CATALOG, worlds: [{ ...CATALOG.worlds[0], map_id: 'b-1', floors: [{ floor_id: F1, name: '1층', floor_z: 0, map_version_id: 'v-1' }] }] };
  const scn = (id: string, name: string, floor: string, archived_at: string | null = null) => ({ id, name, floor_ids: [floor], archived_at }) as unknown as Scenario;
  const scenarios = (items: Scenario[]) => ({ 'GET /simulation/worlds': { status: 200, body: MAPPED }, 'GET /scenarios': { status: 200, body: { items, next_cursor: null } } });
  const items = () => [...box.querySelectorAll('[data-sim-scn] li button')].map((b) => b.textContent);

  it('구도: 왼쪽 위 «<»·위 가운데 알약(잠금 반영)·오른쪽 위 설정(설정·정보), 시나리오 단추 하나', async () => {
    const a = await launch();
    await recv(a, phoneState());
    expect($('[data-sim-pill]')!.textContent).toBe('시뮬 · 정지 잠금 · 0.00 m/s');
    await recv(a, phoneState({ latched: false, controller: 'u-kim', controller_connected: true }));
    expect($('[data-sim-pill]')!.textContent).toBe('시뮬 · 보는 중 · 0.00 m/s');
    expect($('[data-sim-leave]')!.getAttribute('aria-label')).toBe('나가기');
    await click($('[data-sim-menu]'));
    expect([...box.querySelectorAll('.dv-menu button')].map((b) => b.textContent)).toEqual(['설정', '정보']);
    expect(box.querySelectorAll('[aria-label="시나리오"]')).toHaveLength(1);
    await drive(a);
    expect($('[data-sim-pill]')!.textContent).toBe('시뮬 · 실행 중 · 0.00 m/s');
    await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: true, stop_gen: 2 }));
    expect($('[data-sim-pill]')!.textContent).toBe('시뮬 · 정지 잠금 · 0.00 m/s');
  });

  it('잠금 사유 OUTPUT_STALLED 면 출력 지연 안내, 사유 없음·해제면 기존 그대로(잠금 해제 단추·STOP 그대로)', async () => {
    const a = await launch();
    await drive(a);
    const notes = () => [...box.querySelectorAll('.dv-act .dv-note')].map((p) => p.textContent);
    const cam = () => !!box.querySelector('.dv-stage > .dv-video > span');   // OUTPUT_STALLED 안내가 뜨면 영상 문구는 숨겨 겹치지 않음
    const held = { lease_id: LEASE, controller: 'u-lee', controller_connected: true, stop_gen: 2 };
    await recv(a, phoneState({ ...held, safety_reason: 'OUTPUT_STALLED' }));
    expect(notes()).toContain(STALLED);
    expect(cam()).toBe(false);
    expect($('[data-sim-pill]')!.textContent).toBe('시뮬 · 정지 잠금 · 0.00 m/s');
    expect(btn('잠금 해제')).toBeTruthy();
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.includes('STOP'))).toBe(true);
    await recv(a, phoneState({ ...held, safety_reason: null }));
    expect(notes()).not.toContain(STALLED);
    expect(btn('잠금 해제')).toBeTruthy();
    await recv(a, phoneState({ ...held, latched: false, safety_reason: 'OUTPUT_STALLED' }));   // 잠금이 풀렸으면 사유가 남아도 안내 0
    expect(notes()).not.toContain(STALLED);
    expect(cam()).toBe(true);
  });

  it('STOP → 잠금 알림 → 해제 → 주행이면 STOP 안내 0, 잠금을 아직 못 받았으면 «아직 잠금 안 됨» 유지', async () => {
    const a = await launch();
    await drive(a);
    const held = { lease_id: LEASE, controller: 'u-lee', controller_connected: true };
    const warn = '로봇이 아직 잠금을 알리지 않았습니다';
    await click($('[data-stop]'));
    await recv(a, phoneState({ ...held, latched: false, stop_gen: 1 }));   // STOP 뒤 첫 state 가 아직 안 잠김
    expect(box.textContent).toContain(warn);
    await recv(a, phoneState({ ...held, latched: false, stop_gen: 1 }));
    expect(box.textContent).toContain(warn);                              // 잠금을 못 받았으면 계속 경고
    await recv(a, phoneState({ ...held, latched: true, stop_gen: 2 }));
    expect(box.textContent).toContain('정지 잠금 — 로봇이 잠금과 멈춤 출력을 알렸습니다');
    await click(btn('잠금 해제'));
    await recv(a, phoneState({ ...held, latched: false, stop_gen: 2, applied: [0.6, 0, 0] }));
    expect(sim.get().stop).toBeNull();
    expect(box.textContent).not.toContain(warn);
    expect(box.textContent).not.toContain('정지 요청');
  });

  it('실제 영상 장애는 다른 안내(명령 범위 조정)가 떠도 그대로, OUTPUT_STALLED 때는 안내 줄 아래로 옮겨 보임', async () => {
    const a = await launch();
    await drive(a);
    const c = cams()[0];
    act(() => c.open());
    await recv(c, { t: 'camera.frame', seq: 1, mime: 'image/jpeg', width: 2, height: 2, jpeg: 'AAAA' });
    act(() => c.drop(1006)); await flush();
    const lost = '영상 연결이 끊겼습니다. 조종·STOP 에는 영향이 없습니다';
    const place = () => $('.dv-stage > .dv-video > span')?.textContent;
    const notes = () => [...box.querySelectorAll('.dv-act .dv-note')].map((p) => p.textContent);
    expect(place()).toBe(lost);
    await recv(a, { t: 'cmd.ack', clipped: true });
    expect(sim.get().link!.cam).toBe('lost');
    expect(sim.get().link!.st!.latched).toBe(false);
    expect(notes().some((t) => t?.startsWith('명령 범위 조정'))).toBe(true);
    expect(place()).toBe(lost);
    await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, stop_gen: 2, safety_reason: 'OUTPUT_STALLED' }));
    expect(place()).toBeUndefined();
    expect(notes()).toEqual(expect.arrayContaining([STALLED, lost]));
  });

  it('띠가 열리면 누르고 있던 입력도 0·조이스틱 막힘, 메뉴는 닫힘, STOP 은 영상 칸 밖에서 보이고 눌림 → 닫으면 다시 움직임', async () => {
    const a = await launch(welcome(), scenarios([]));
    await drive(a);
    await click($('[data-sim-menu]'));
    await click($('[data-sim-scn-btn]'));
    expect($('.dv-menu')).toBeNull();   // 둘 중 하나만
    await click($('[data-sim-scn-btn]'));
    await click($('[data-sim-scn-btn]'));
    ptr(stick('전후'), 'pointerdown', 50, 0); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0, wz: 0 });
    expect(stick('전후').getAttribute('aria-disabled')).toBe('true');
    expect($('[data-sim-scn-btn]')!.getAttribute('aria-expanded')).toBe('true');
    expect(box.querySelector('.dv-stage [data-stop]')).toBeNull();
    const s = $<HTMLButtonElement>('[data-stop]')!;
    expect(s.disabled).toBe(false);
    await click(s);
    expect(a.of('stop')).toHaveLength(1);
    // 닫으면 입력이 다시 산다(잠금 해제된 상태로 되돌림)
    await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: false, stop_gen: 2 }));
    await click($('[data-sim-scn-btn]'));
    expect($('[data-sim-scn]')).toBeNull();
    ptr(stick('전후'), 'pointerdown', 50, 0); await wait(80);
    expect(last(a.of('cmd'))).toMatchObject({ vx: 0.6 });
  });

  it('이 월드 지도(층)를 지나는 보관 안 된 시나리오만, 고르면 «고름»·실행 막힘·«준비 중» — 실행 요청 0', async () => {
    const a = await launch(welcome(), scenarios([scn('s-a', '1층 순찰', F1), scn('s-b', '남의 지도', F2), scn('s-c', '보관됨', F1, '2026-10-01T00:00:00Z')]));
    await drive(a);
    await click($('[data-sim-scn-btn]'));
    expect(calls.some((c) => c.method === 'GET' && c.path.startsWith('/scenarios'))).toBe(true);
    expect(items()).toEqual(['1층 순찰']);
    expect(btn('실행')).toBeUndefined();
    await click([...box.querySelectorAll('[data-sim-scn] li button')][0]);
    expect(items()).toEqual(['1층 순찰고름']);
    const run = btn('실행')!;
    expect(run.disabled).toBe(true);
    expect($('[data-sim-scn]')!.textContent).toContain('시나리오 실행은 아직 준비 중입니다.');
    const n = calls.length, sent = a.sent.filter((m) => m.t !== 'cmd' && m.t !== 'ping').length;
    act(() => run.click()); await flush();
    expect(calls.length).toBe(n);
    expect(a.sent.filter((m) => m.t !== 'cmd' && m.t !== 'ping')).toHaveLength(sent);
  });

  it('시나리오 0개면 «이 지도에 시나리오가 없습니다»', async () => {
    await launch(welcome(), scenarios([scn('s-b', '남의 지도', F2)]));
    await click($('[data-sim-scn-btn]'));
    expect($('[data-sim-scn]')!.textContent).toBe('이 지도에 시나리오가 없습니다.');
    expect(btn('실행')).toBeUndefined();
  });

  it('지도에 묶이지 않은 월드는 목록을 부르지 않고 안내만', async () => {
    await launch();
    await click($('[data-sim-scn-btn]'));
    expect($('[data-sim-scn]')!.textContent).toBe('이 월드에 묶인 지도가 없어 시나리오가 없습니다.');
    expect(calls.some((c) => c.path.startsWith('/scenarios'))).toBe(false);
  });

  it('목록 실패는 «받지 못했습니다»·다시', async () => {
    await launch(welcome(), { ...scenarios([]), 'GET /scenarios': err(503, 'INTERNAL_ERROR', 'x') });
    await click($('[data-sim-scn-btn]'));
    expect($('[data-sim-scn]')!.textContent).toContain('시나리오 목록을 받지 못했습니다.');
    routes['GET /scenarios'] = { status: 200, body: { items: [scn('s-a', '1층 순찰', F1)], next_cursor: null } };
    await click(btn('다시'));
    expect(items()).toEqual(['1층 순찰']);
  });
});

describe('시뮬 층 자동 전환 작은 지도(floor-auto 1B)', () => {
  const V1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', V2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const V5 = { id: 'v5_building', name: '연결 건물', description: '', map_id: 'b-1', spawn_floor_ids: ['l1', 'l2'] as ('l1' | 'l2')[],
    floors: [{ floor_id: 'f-1', name: '1층', floor_z: 0, map_version_id: V1, ros_floor_id: 'l1' }, { floor_id: 'f-2', name: '2층', floor_z: 3, map_version_id: V2, ros_floor_id: 'l2' }] };
  const ver = (id: string, sha: string) => ({ status: 200, body: { id, number: 1, floor_id: 'f', status: 'APPROVED', image_sha256: sha, width: 200, height: 100, resolution: 0.05,
    origin: [0, 0, 0], features: { zones: [], waypoints: [], connectors: [], edits: [] } } });
  const fc = (p: Record<string, unknown>) => ({ robot_id: S1, generation: 1, run_id: 'run-1', epoch: 1, floor_rev: 1, world_id: 'v5_building', building_id: 'b-1', spawn_floor_id: 'l1',
    current_floor_id: 'l1', floor_id: 'f-1', map_version_id: V1, sha256: 'a1', source_pgm_sha256: 'p1', source: 'gt_geometry', floor_state: 'on_floor', reason: 'confirmed', confirmed_sim_t: 1, ...p });
  const L1 = {}, TRANSIT = { floor_rev: 2, current_floor_id: null, floor_id: null, map_version_id: null, sha256: null, floor_state: 'transit', reason: 'connector_ramp' };
  const L2 = { floor_rev: 3, current_floor_id: 'l2', floor_id: 'f-2', map_version_id: V2, sha256: 'b2' };
  const at = (c: Record<string, unknown>, xy = { x: 2, y: 1, yaw: 0.5 }) => phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: false,
    pose: { floor_context: fc(c), map_version_id: c.map_version_id === undefined ? V1 : c.map_version_id, floor_id: null, confidence: 1,
      ...(c.floor_state === 'transit' ? { x: null, y: null, yaw: null } : xy) } });
  const routesV5 = {
    'GET /simulation/worlds': { status: 200, body: { ...CATALOG, worlds: [V5] } },
    'POST /simulation/robots': () => { mine = [{ ...simRobot(), world_id: 'v5_building', spawn_floor_id: 'l1' }]; return { status: 201, body: mine[0] }; },
    [`GET /map-versions/${V1}`]: ver(V1, 'a1'), [`GET /map-versions/${V2}`]: ver(V2, 'b2'),
  };
  const shown = () => $('[data-sim-map]')?.getAttribute('data-sim-map');
  const load = async () => { act(() => { $('[data-sim-map] image')!.dispatchEvent(new Event('load')); }); await flush(); };

  it('창고 f1 승인 문맥은 확인 중을 벗어나 지도와 위치를 표시하고 만료 때 위치를 숨긴다', async () => {
    const warehouse = { ...V5, id: 'warehouse/f1', name: '작은 창고', spawn_floor_ids: [],
      floors: [{ ...V5.floors[0], name: 'f1', ros_floor_id: 'f1' }] };   // 서버가 floor_name 없이 넣은 창고 층 — 이름이 ID 그대로
    const a = await launch(welcome(), { ...routesV5,
      'GET /simulation/worlds': { status: 200, body: { ...CATALOG, worlds: [warehouse] } },
      'POST /simulation/robots': () => { mine = [{ ...simRobot(), world_id: 'warehouse/f1' }]; return { status: 201, body: mine[0] }; },
    });
    await drive(a);
    await recv(a, at({ world_id: 'warehouse', spawn_floor_id: 'f1', current_floor_id: 'f1', floor_state: 'on_floor', confirmed_sim_t: 0 }));
    expect(shown()).toBe(V1);
    await load();
    expect($('[data-sim-floor]')!.textContent).toBe('1층');
    expect($('[data-sim-dot]')).toBeTruthy();
    await recv(a, phoneState({ pose: { floor_context: null, map_version_id: null, floor_id: null, confidence: null, x: null, y: null, yaw: null } }));
    expect($('[data-sim-floor]')!.textContent).toBe('층을 확인하는 중');
    expect($('[data-sim-dot]')).toBeNull();
  });

  it('두 층 월드는 «시작 층»을 고르고 spawn_floor_id 를 보낸다, 한 층 월드는 표시·전송 0', async () => {
    serve({ 'GET /simulation/worlds': { status: 200, body: { ...CATALOG, worlds: [...CATALOG.worlds, V5] } } });
    await mount();
    expect($('[data-sim-spawn]')).toBeNull();   // 기본(빈 연습장) = 시작 층 없음
    await click($('[aria-label="월드 목록"] input[value="v5_building"]'));
    const spawn = $('[data-sim-spawn]')!;
    expect(spawn.textContent).toBe('시작 층1층2층');
    expect(spawn.querySelector<HTMLInputElement>('input[value="l1"]')!.checked).toBe(true);
    await click(spawn.querySelector('input[value="l2"]'));
    await click(btn('띄우기'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/simulation/robots')!.body).toEqual({ world_id: 'v5_building', robot_id: S1, spawn_floor_id: 'l2' });
  });

  it('1층 판 + 위치 → 층 이동 중(점 숨김·흐림) → 2층 판 자동 교체·안내, 옛 rev·다른 세대 무시, 큰 지도에서도 조이스틱·STOP 그대로', async () => {
    const a = await launch(welcome(), routesV5); await drive(a);
    expect($('[data-sim-mini]')!.getAttribute('aria-label')).toBe('지도 크게');
    expect($('[data-sim-floor]')!.textContent).toBe('층을 확인하는 중');   // 문맥 전 — 판·점 없음
    expect($('[data-sim-map]')).toBeNull();
    await recv(a, at(L1));
    expect(shown()).toBe(V1);
    expect($('[data-sim-dot]')).toBeNull();   // 그림을 받기 전에는 점 없음
    await load();
    expect($('[data-sim-dot]')).toBeTruthy();
    expect($('[data-sim-floor]')!.textContent).toBe('1층');
    expect(box.textContent).not.toContain('지도로 바꿨습니다');   // 첫 판은 안내 없음

    await recv(a, at(TRANSIT));
    expect($('[data-sim-dot]')).toBeNull();
    expect($('[data-sim-map]')!.hasAttribute('data-dim')).toBe(true);
    expect($('[data-sim-floor]')!.textContent).toBe('층 이동 중');

    await recv(a, at(L2));
    expect(calls.some((c) => c.path === `/map-versions/${V2}`)).toBe(true);
    expect(shown()).toBe(V2);
    await load();
    expect($('[data-sim-dot]')).toBeTruthy();
    expect($('[data-sim-floor]')!.textContent).toBe('2층');
    expect(box.textContent).toContain('2층 지도로 바꿨습니다');
    await recv(a, at({ ...TRANSIT, floor_rev: 3.5 }));   // 안내 중 다시 이동 — 안내는 남지 않는다
    expect(box.textContent).not.toContain('지도로 바꿨습니다');
    await recv(a, at({ ...L2, floor_rev: 3.6 })); await load();

    await recv(a, at(L1));   // 옛 floor_rev(1) — 무시
    expect(shown()).toBe(V2);
    expect($('[data-sim-floor]')!.textContent).toBe('2층');
    await recv(a, at({ ...L1, floor_rev: 9, generation: 2 }));   // 다른 세대 — 무시
    expect(shown()).toBe(V2);
    await recv(a, at({ ...L2, floor_rev: 4, floor_state: 'unknown', current_floor_id: null, map_version_id: null }));
    expect($('[data-sim-dot]')).toBeNull();
    expect($('[data-sim-floor]')!.textContent).toBe('층을 확인하는 중');

    // 지도 크게: 영상이 작은 칸으로, 조이스틱·STOP 은 그대로
    await click($('[data-sim-mini]'));
    expect($('[data-sim-mini]')!.getAttribute('aria-label')).toBe('영상 크게');
    expect($('.dv-stage > [data-sim-map]')).toBeTruthy();
    expect(stick('전후').getAttribute('aria-disabled')).toBe('false');
    expect(box.querySelector('.dv-stage [data-stop]')).toBeNull();
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
  });

  it('1층 판을 그린 뒤 문맥이 null(RESET·만료)이면 마지막 문맥을 현재로 쓰지 않는다 — 확인 중·흐림·점 숨김', async () => {
    const a = await launch(welcome(), routesV5); await drive(a);
    await recv(a, at(L1)); await load();
    expect($('[data-sim-dot]')).toBeTruthy();
    await recv(a, phoneState({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: false,
      pose: { floor_context: null, map_version_id: V1, floor_id: null, confidence: 1, x: 2, y: 1, yaw: 0.5 } }));
    expect($('[data-sim-floor]')!.textContent).toBe('층을 확인하는 중');
    expect($('[data-sim-map]')!.hasAttribute('data-dim')).toBe(true);
    expect($('[data-sim-dot]')).toBeNull();
    await recv(a, at(L1));   // 문맥이 돌아오면 다시 1층·점
    expect($('[data-sim-floor]')!.textContent).toBe('1층');
    expect($('[data-sim-dot]')).toBeTruthy();
  });

  it('newer: 같은 세대 안에서 run_id 결속, epoch·floor_rev 각각 단조', () => {
    const r = { robot_id: S1, generation: 1 }, c = (p: Record<string, unknown>) => fc(p) as unknown as FloorContext;
    const last = c({ run_id: 'run1', epoch: 1, floor_rev: 6 });
    expect(newer(c({ run_id: 'run1', epoch: 2, floor_rev: 1 }), last, r)).toBe(false);   // epoch 만 늘고 floor_rev 역행
    expect(newer(c({ run_id: 'other', epoch: 2, floor_rev: 7 }), last, r)).toBe(false);   // 다른 실행
    expect(newer(c({ run_id: 'run1', epoch: 2, floor_rev: 7 }), last, r)).toBe(true);
    expect(newer(c({ run_id: 'run1', epoch: 1, floor_rev: 6 }), last, r)).toBe(true);
    expect(newer(c({ run_id: 'other', generation: 2, floor_rev: 1 }), last, { ...r, generation: 2 })).toBe(true);   // 새 세대는 처음부터
  });

  it('판 응답이 오기 전에 문맥이 바뀌면 그 판은 그리지 않는다, 판 SHA 가 다르면 위치 숨김', async () => {
    let answer: (r: Reply) => void = () => {};
    const a = await launch(welcome(), { ...routesV5, [`GET /map-versions/${V1}`]: () => new Promise<Reply>((f) => { answer = f; }), [`GET /map-versions/${V2}`]: ver(V2, 'other') });
    await drive(a);
    await recv(a, at(L1));
    await recv(a, at(TRANSIT));
    answer(ver(V1, 'a1')); await flush();
    expect($('[data-sim-map]')).toBeNull();
    expect($('[data-sim-floor]')!.textContent).toBe('층 이동 중');
    await recv(a, at(L2));
    expect($('[data-sim-dot]')).toBeNull();
    expect($('[data-sim-floor]')!.textContent).toBe('지도 판이 맞지 않습니다');
  });
});

// 폰 조종 화면 떠 있는 글 줄이기(11-28 팀장 «말풍선이 너무 많아서 정신 없어» · PHONE-CLUTTER 1 절).
// 확인 2 초 · 힌트는 처음 한 번 3 초 · 상태 낱말은 칩에만 · 로봇 이름은 칩에만. 정지 줄(STOP 결과)은 수명 없이 남는다.
// 알림 한 칸(0~1)·조종·연결 4 초 접기·창이 뜨면 숨김은 안전 글을 늘 다 보이는 결정(RV-449 ①·PR117)과 부딪혀 결정 뒤에 넣는다.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimCatalog, SimRobot } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';
import { sim } from '../phone';
import type { Found } from '../nearby';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lidar3d', async (orig) => ({ ...(await orig<object>()), Lidar3D: () => <div data-lidar3d="stub" /> }));

const RID = 'r1', HOST = '192.168.123.18', LEASE = '33333333-3333-4333-8333-333333333333';
const found: Found = { key: 'mdns:go2', via: 'mdns', name: 'GO2-friday', host: HOST, port: 8765, rid: RID, agent: `ws://${HOST}:8765/phone/ws` };
const LIMITS = { vx_min: 0, vx_max: 1.5, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [[0, 0, 0], [0.5, 0, 0]] };
const welcome = { t: 'hello', id: 'p1', robot: RID, proto: 'fh-phone/1', simulation: false, camera_token: null, limits: LIMITS,
  policy: { name: 'go2-sport', version: 'v1' }, ping_interval_ms: 1000, link_timeout_ms: 3000, lease_timeout_ms: 15000 };
const st = (p: Record<string, unknown> = {}) => ({ t: 'state', robot: RID, robot_id: RID, pose: null, speed: 0, battery: { soc: 70 }, latched: true, stop_gen: 1, stop_ref: 0,
  applied: [0, 0, 0], mode: 'IDLE', controller: null, controller_device: null, controller_connected: false, lease_id: null, stop_requested: false,
  posture: 'STAND', velocity: [0, 0, 0], echo: null, wall_time_ms: Date.now(), simulation: false, ...p });
const MINE = { lease_id: LEASE, controller: 'u-lee', controller_connected: true };

let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1); else await new Promise((r) => setTimeout(r, 0)); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); await flush(); };
/** 지나는 시간(가짜 시계) */
const pass = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await flush(); };
/** 알림 칸에 보이는 글(정지 줄 포함) */
const slot = (sel: string) => [...box.querySelectorAll(`${sel} [role="status"]`)].map((p) => p.textContent ?? '');
const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); sim.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function phone() {
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; wv) FootholdApp/1.2.5-dev');
  location.hash = '#/drive';
  box = document.createElement('div'); document.body.append(box);
}

/** 실기 직결 조종 화면(realdrive.test.tsx 와 같은 길). exp = 출입증 남은 초 */
async function real({ exp = 600 } = {}) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace(/^\/api\/v1/, '').split('?')[0]}`;
    const body = key === `POST /robots/${RID}/phone-pass` ? { token: 'pass-secret', exp: Math.floor(Date.now() / 1000) + exp, kid: 'k1' } : { items: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  phone();
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={ROBOTS} />); });
  await flush();
  await click(btn('+ 로봇 연결하기'));
  await click(btn('주변 로봇 찾기'));
  const seq = $('[data-nearby-scan]')!.getAttribute('data-nearby-scan');
  act(() => { window.dispatchEvent(new CustomEvent('fh-nearby', { detail: { seq, scanning: false, items: [found], problems: [] } })); });
  await flush();
  await click([...box.querySelectorAll('.dv-card button')].find((b) => b.textContent?.includes('GO2-friday')));
  await click($('[data-real-connect]'));
  const l = (window as { fhGo2Link?: { seq: string } }).fhGo2Link!;
  act(() => { window.dispatchEvent(new CustomEvent('fh-go2-link', { detail: { seq: l.seq, port: 40123, nonce: '0123456789abcdef0123456789abcdef' } })); });
  await flush();
  const a = FakeWS.all.find((w) => w.url.startsWith('ws://127.0.0.1:40123/') && !w.url.includes('media'))!;
  a.auto = ((m: Msg) => (m.t === 'lease.take' ? { lease_id: LEASE } : ['hello', 'cmd', 'ping', 'stop'].includes(m.t) ? undefined : {})) as FakeWS['auto'];
  act(() => a.open()); await flush();
  act(() => a.recv(welcome)); await flush();
  act(() => a.recv(st())); await flush();
  return a;
}
async function driving(a: FakeWS) {
  await click(btn('조종 시작'));
  act(() => a.recv(st(MINE))); await flush();
  await click(btn('잠금 해제'));
  act(() => a.recv(st({ ...MINE, latched: false }))); await flush();
}

describe('실기 직결 조종 화면 · 알림 수명', () => {
  it('정지 줄은 수명이 없다(10 초 뒤에도 그대로)', async () => {
    const a = await real();
    await driving(a);
    await click($('[data-stop]'));
    fake();
    for (let i = 0; i < 20; i++) { await pass(500); act(() => a.recv(st({ ...MINE, latched: false }))); }
    expect(slot('[data-real-card]')[0]).toMatch(/^■ 정지 요청/);
  });

  it('확인(조종권 요청 취소됨)은 2 초 뒤 사라진다', async () => {
    const a = await real();
    await driving(a);
    fake();
    act(() => a.recv({ t: 'lease.result', request_id: 'q1', result: 'CANCELED' })); await flush();
    expect(slot('[data-real-card]')).toEqual(['조종권 요청이 취소됐습니다.']);
    await pass(1900);
    expect(slot('[data-real-card]')).toEqual(['조종권 요청이 취소됐습니다.']);
    await pass(200);
    expect(slot('[data-real-card]')).toEqual([]);
  });

  it('안전 글(정지 · 출입증)은 겹쳐도 모두 맨 위에 보이고 접지 않는다', async () => {
    const a = await real({ exp: 30 });
    await driving(a);
    await click($('[data-stop]'));
    const shown = slot('[data-real-card]');
    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatch(/^■ 정지 요청/);
    expect(shown[1]).toContain('출입증');
    expect($('[data-notes-more]')).toBeNull();
  });

  it('로봇 이름은 칩에만(로봇 한 대 · 화면에 이름표 없음)', async () => {
    await real();
    const drive = $('[data-real-drive]')!;
    expect(drive.textContent!.split('GO2-friday').length - 1).toBe(1);
    expect($('[data-real-pill]')!.textContent).toContain('GO2-friday');
  });
});

// ---- 시뮬 조종 화면(phone.test.tsx 와 같은 가짜 서버·에이전트) ----
const S1 = '11111111-1111-4111-8111-111111111111';
const AGENT = 'ws://127.0.0.1:9481/phone/ws';
const CATALOG: SimCatalog = { worlds: [{ id: 'empty', name: '빈 연습장', description: '장애물이 없는 연습 공간' }], slots: [S1], max_robots: 1, launcher: 'native-single', manager_instance_id: null };
const simRobot = (state: SimRobot['state'] = 'RUNNING'): SimRobot => ({ generation: 1, robot_id: S1, owner_id: 'u-lee', world_id: 'empty', simulation: true, state,
  agent_address: AGENT, namespace: '/sim1', tf_prefix: 'sim1/', command_topic: '/sim1/cmd', launcher: 'native-single', expires_at: null, remaining_s: null });
const simWelcome = (media?: unknown) => ({ t: 'hello', id: 'p1', robot: S1, proto: 'fh-phone/1', simulation: true, camera_token: 'cam-1', media,
  limits: { vx_min: 0, vx_max: 0.6, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [[0, 0, 0], [0.6, 0, 0]] },
  policy: { name: 'go2-flat', version: 'v1' }, ping_interval_ms: 1000, link_timeout_ms: 3000, lease_timeout_ms: 15000 });
let mine: SimRobot[] = [];
async function simDrive(media?: unknown) {
  mine = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace(/^\/api\/v1/, '').split('?')[0]}`;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (key === 'GET /simulation/worlds') return json(CATALOG);
    if (key === 'GET /simulation/robots') return json({ items: mine });
    if (key === 'POST /simulation/robots') { mine = [simRobot()]; return json(mine[0], 201); }
    if (key === `POST /robots/${S1}/phone-pass`) return json({ token: 'pass-secret', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' });
    return json({ error: { code: 'NOT_FOUND', message: '없음', detail: {} } }, 404);
  });
  phone();
  localStorage.setItem('fh.simEngine', 'gazebo');
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={ROBOTS} />); });
  await flush();
  act(() => { void sim.start(sim.get().catalog!.worlds[0].id, 'u-lee'); }); await flush();
  const a = FakeWS.all.filter((w) => w.url === AGENT).pop()!;
  a.auto = ((m: Msg) => (m.t === 'lease.take' ? { lease_id: LEASE } : ['hello', 'cmd', 'ping', 'stop'].includes(m.t) ? undefined : {})) as FakeWS['auto'];
  act(() => a.open()); await flush();
  act(() => a.recv(simWelcome(media))); await flush();
  return a;
}

describe('시뮬 조종 화면 · 한 사실은 한 곳 · 힌트', () => {
  it.each(['STARTING', 'STOPPING'] as const)('%s: 상태 낱말은 칩에만 · 알림 칸에 되풀이하지 않음', async (state) => {
    await simDrive();
    mine = mine.map((r) => ({ ...r, state }));
    await act(() => sim.load());
    const word = state === 'STARTING' ? '띄우는 중' : '정리 중';
    expect($('[data-sim-pill]')!.textContent).toContain(word);
    expect(slot('[data-sim-card]').join(' ')).not.toMatch(/띄우는 중|정리하는 중/);
  });

  it('임무 · 확인 · 힌트(등급 3~5)는 한 칸, 나머지는 «+N» 뒤 · 펼치면 모두', async () => {
    const a = await simDrive();
    act(() => a.recv({ t: 'run.update', run_id: 'r-1', status: 'FAILED', step: 0, progress: { done: 0, total: 3 }, wait_reason: null, fail_code: 'LOCALIZATION_LOST' })); await flush();
    expect(slot('[data-sim-card]')).toEqual(['시나리오 실패 — 로봇이 지도 위 자기 위치를 잃었습니다.']);
    const more = $('[data-notes-more]')!;
    expect(more.textContent).toBe('+1');
    await click(more);
    expect(slot('[data-sim-card]')).toHaveLength(2);
    await click($('[data-notes-more]'));
    expect(slot('[data-sim-card]')).toHaveLength(1);
  });

  it('안전 글(정지 줄)이 있으면 그 아래 등급 3~5 한 칸', async () => {
    const a = await simDrive();
    act(() => a.recv({ t: 'state', robot: S1, pose: null, speed: 0, battery: { soc: 77 }, latched: true, stop_gen: 1, stop_ref: 0, applied: [0, 0, 0], mode: 'IDLE', robot_id: S1,
      controller: null, controller_device: null, controller_connected: false, lease_id: null, stop_requested: false, posture: 'STAND', velocity: [0, 0, 0], echo: null, wall_time_ms: Date.now(), simulation: true })); await flush();
    await click($('[data-stop]'));
    act(() => a.recv({ t: 'run.update', run_id: 'r-1', status: 'FAILED', step: 0, progress: { done: 0, total: 3 }, wait_reason: null, fail_code: 'LOCALIZATION_LOST' })); await flush();
    const shown = slot('[data-sim-card]');
    expect(shown).toHaveLength(2);
    expect(shown[0]).toMatch(/^■ /);
    expect(shown[1]).toBe('시나리오 실패 — 로봇이 지도 위 자기 위치를 잃었습니다.');
    expect($('[data-notes-more]')!.textContent).toBe('+1');
  });

  it('영상 자리 글에 내부 규약 이름(media/1)이 보이지 않는다(실기와 같은 거르기)', async () => {
    await simDrive();
    const stage = $('[data-sim-drive] .dv-stage')!.textContent!;
    expect(stage).toContain('이 로봇은 관측 영상을 알리지 않습니다');
    expect(stage).not.toContain('media/1');
  });

  it('힌트(외부 카메라 시점)는 처음 한 번 3 초', async () => {
    const tok = (c: string) => c.repeat(43);
    fake();
    await simDrive({ version: 'media/1', path: '/phone/media/ws', robot: S1, epoch: 3, episode_id: LEASE,
      rgb: { available: true, reason: 'Ready', token: tok('r') }, external: { available: false, reason: 'External camera source is not connected', token: null },
      lidar: { available: true, reason: 'Ready', token: tok('l') } });
    expect($('[data-orbit-why]')!.textContent).toBe('외부 카메라를 받는 중일 때만 시점을 옮길 수 있습니다');
    await pass(3100);
    expect($('[data-orbit-why]')).toBeNull();
    await click($('[data-cam-pick="rgb"]'));
    await click($('[data-cam-pick="external"]'));
    expect($('[data-orbit-why]')).toBeNull();   // 다시 띄우지 않음
  });
});

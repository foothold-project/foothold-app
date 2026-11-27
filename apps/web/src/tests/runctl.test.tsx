// 임무 실행 단추(W1 · 팀장 05:09 «시작 · 일시정지 · 이어 가기 모든 기기», 05 §6.5 서버 실시간 길 run.start · run.control, #537).
// 판정(관문 · 배정 · 멈춤 확인)은 서버 몫. 여기는 화면이 무엇을 보내는지(sent), 조종권이 없으면 보내지 않는지, 결과 전에 성공이라 하지 않는지, 거절 코드를 보이는지를 본다.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assignment, RunSnapshot, Scenario, SimRobot } from '../../../contracts/ts';
import { api } from '../api';
import { sim } from '../phone';
import { rt } from '../rt';
import { RunCtl } from '../screens/missionrun';
import type { Robot } from '../fake';
import { FakeWS, fail, lease, state, type Msg } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const R: Robot = { id: 'r1', name: 'K-01', owner: 'u-lee', ownerName: '이OO', battery: 80, online: true, seenAt: '14:05:20', status: 'IDLE' };
const SC = { id: 'sc1', name: '1층 순찰', version: 3, latest_version: 3, floor_ids: ['f1'], map_version_ids: ['mv1'], waypoints: [] } as unknown as Scenario;
const AS = { id: 'as1', robot_id: 'r1', scenario_id: 'sc1', scenario_version: 3, status: 'ACTIVE' } as unknown as Assignment;
const LEASE = 'L-1';
const run = (status: RunSnapshot['status'], run_id = 'run-x'): RunSnapshot => ({ run_id, status, step: 1, progress: { done: 0, total: 3 } as RunSnapshot['progress'], wait_reason: null, fail_code: null });

let root: Root | null = null, box: HTMLDivElement;
beforeEach(() => { FakeWS.all = []; vi.stubGlobal('WebSocket', FakeWS); });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); sim.clear(); rt.disconnect(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** 화면 하나 + 연결 열기. own = 내 조종권(lease) 받음, latched = 잠김 */
function mount(p: { own?: boolean; latched?: boolean; assign?: Assignment | null; r?: RunSnapshot | null; holder?: { id: string; name: string } | null } = {}) {
  rt.connect(['r1']);
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<RunCtl robot={R} scen={SC} assign={p.assign === undefined ? AS : p.assign} watch />); });
  const w = FakeWS.last;
  act(() => { w.open(); w.recv(state('r1', { latched: p.latched ?? false, run: p.r ?? null })); });
  if (p.own) act(() => { w.recv(lease('r1', { id: 'u-lee', name: '이OO' }, LEASE)); });
  else if (p.holder) act(() => { w.recv(lease('r1', p.holder!)); });
  return w;
}
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btns = () => [...box.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent);
const btn = (t: string) => [...box.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === t);
const click = (t: string) => { const b = btn(t); expect(b, t).toBeTruthy(); act(() => b!.click()); };
const said = () => $('[data-run-say]')?.textContent ?? '';
const runMsgs = (w: FakeWS) => w.sent.filter((m) => m.t === 'run.start' || m.t === 'run.control');

describe('임무 실행 단추', () => {
  it('조종권이 없으면 실행 단추를 회색으로 두지 않고 «조종권 잡기»로 잇는다 · 실행 명령은 보내지 않는다', () => {
    const w = mount();
    expect(btns()).toContain('조종권 잡기');
    expect(btn('실행')).toBeUndefined();
    click('조종권 잡기');
    expect(w.of('lease.take').map((m) => m.robot)).toEqual(['r1']);
    expect(runMsgs(w)).toEqual([]);
  });
  it('다른 사람이 조종 중이면 까닭 한 줄 + «조종권 요청»', () => {
    const w = mount({ holder: { id: 'u-park', name: '박OO' } });
    expect($('[data-run-gate]')!.textContent).toContain('박OO 님이 조종 중입니다');
    click('조종권 요청');
    expect(w.of('lease.request')).toHaveLength(1);
    expect(runMsgs(w)).toEqual([]);
  });
  it('조종권은 있는데 잠겨 있으면 «잠금 해제»가 먼저', () => {
    const w = mount({ own: true, latched: true });
    expect(btn('실행')).toBeUndefined();
    click('잠금 해제');
    expect(w.of('unlock')).toHaveLength(1);
    expect(runMsgs(w)).toEqual([]);
  });
  it('대기 → «실행»: run.start 본문(배정 · 판 · 층 · 지도 판 · lease · 화면 id) · 결과 전엔 «보내는 중», 성공 문구는 state.run 이 실제로 바뀐 뒤에만', () => {
    const w = mount({ own: true });
    expect(btns().filter((t) => ['실행', '일시정지', '이어 가기'].includes(t!))).toEqual(['실행']);
    click('실행');
    const m = w.of('run.start')[0];
    expect(m).toMatchObject({ robot: 'r1', lease_id: LEASE, assignment_id: 'as1', scenario_id: 'sc1', scenario_version: 3, floor_id: 'f1', map_version_id: 'mv1' });
    expect(m.run_id).toMatch(/^[0-9a-f-]{36}$/); expect(m.screen_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(said()).toContain('보내는 중');
    expect(btn('실행')!.disabled).toBe(true);   // 두 번 보내지 않음
    // 로봇 결과 SUCCEEDED 가 와도 state.run 이 그 실행이 아니면 아직 성공이라 하지 않는다
    act(() => { w.recv(state('r1', { latched: false, run_result: { request_id: m.id, op: 'start', run_id: m.run_id as string, status: 'SUCCEEDED', code: 'OK' } })); });
    expect(said()).not.toContain('시작했습니다');
    act(() => { w.recv(state('r1', { latched: false, run: run('MOVING', m.run_id as string), run_result: { request_id: m.id, op: 'start', run_id: m.run_id as string, status: 'SUCCEEDED', code: 'OK' } })); });
    expect(said()).toContain('임무를 시작했습니다');
  });
  it('실행 중 → 주 단추는 «일시정지» 하나 · run.control pause(run_id · lease · 화면 id)', () => {
    const w = mount({ own: true, r: run('MOVING') });
    expect(btns().filter((t) => ['실행', '일시정지', '이어 가기'].includes(t!))).toEqual(['일시정지']);
    click('일시정지');
    expect(w.of('run.control')[0]).toMatchObject({ robot: 'r1', op: 'pause', run_id: 'run-x', lease_id: LEASE });
    expect(w.of('run.control')[0].screen_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('일시정지 → «이어 가기» · run.control resume', () => {
    const w = mount({ own: true, r: run('PAUSED') });
    expect(btns().filter((t) => ['실행', '일시정지', '이어 가기'].includes(t!))).toEqual(['이어 가기']);
    click('이어 가기');
    expect(w.of('run.control')[0]).toMatchObject({ op: 'resume', run_id: 'run-x', lease_id: LEASE });
  });
  it('취소는 확인 한 번: 첫 누름은 묻기만, «취소 확정»에서 abort', () => {
    const w = mount({ own: true, r: run('PAUSED') });
    click('취소');
    expect(runMsgs(w)).toEqual([]);
    expect($('[data-run-confirm]')!.textContent).toContain('임무를 취소할까요');
    click('아니오');
    expect($('[data-run-confirm]')).toBeNull();
    click('취소'); click('취소 확정');
    expect(w.of('run.control').map((m) => m.op)).toEqual(['abort']);
  });
  it('서버 답 거절(RUN_MOVING)은 서버 문구 틀 그대로 한 줄', () => {
    const w = mount({ own: true });
    w.auto = (m: Msg) => (m.t === 'run.start' ? fail('RUN_MOVING') : { ok: true });
    click('실행');
    expect(said()).toBe('K-01 정지가 확인되지 않아 임무 시작 · 이어 가기 요청을 거절했습니다.');
    expect(btn('실행')!.disabled).toBe(false);
  });
  it('서버 답 거절 RUN_STOPPED(#537 e45b6b5c: 배정 확인 중 STOP)도 서버 문구 틀 그대로', () => {
    const w = mount({ own: true });
    w.auto = (m: Msg) => (m.t === 'run.start' ? fail('RUN_STOPPED') : { ok: true });
    click('실행');
    expect(said()).toBe('K-01 배정 확인 중 정지가 눌려 임무 시작 요청을 거절했습니다.');
  });
  it('로봇 결과 REJECTED(state.run_result) 도 코드 문구 · 모르는 코드는 코드 그대로 + 한 줄', () => {
    const w = mount({ own: true });
    click('실행');
    const m = w.of('run.start')[0];
    act(() => { w.recv(state('r1', { latched: false, run_result: { request_id: m.id, op: 'start', run_id: m.run_id as string, status: 'REJECTED', code: 'RUN_ASSIGNMENT_INVALID' } })); });
    expect(said()).toBe('K-01 승인된 배정이 아니어서 임무 시작 요청을 거절했습니다.');
    click('실행');
    const m2 = w.of('run.start')[1];
    act(() => { w.recv(state('r1', { latched: false, run_result: { request_id: m2.id, op: 'start', run_id: m2.run_id as string, status: 'REJECTED', code: 'NAV_UNAVAILABLE' } })); });
    expect(said()).toContain('(NAV_UNAVAILABLE)');
  });
  it('다른 요청의 run_result 는 내 결과로 보지 않는다', () => {
    const w = mount({ own: true });
    click('실행');
    act(() => { w.recv(state('r1', { latched: false, run_result: { request_id: 'someone-else', op: 'start', run_id: 'z', status: 'REJECTED', code: 'RUN_MOVING' } })); });
    expect(said()).toContain('보내는 중');
  });
  it('rt.run 자체도 조종권(lease) 없으면 보내지 않는다(화면 관문을 지나쳐도)', () => {
    const w = mount();
    let sent = true;
    act(() => { sent = rt.run('r1', 'pause', { run_id: 'run-x' }); });
    expect(sent).toBe(false);
    expect(runMsgs(w)).toEqual([]);
    expect(rt.get('r1').runReq).toBeNull();
  });
  it('이 로봇에 이 임무의 ACTIVE 배정이 없으면 까닭 한 줄 · 실행 단추 없음', () => {
    const w = mount({ own: true, assign: null });
    expect(btn('실행')).toBeUndefined();
    expect($('[data-run-gate]')!.textContent).toContain('이 로봇에 이 임무의 배정이 없습니다. PC 임무 탭에서 로봇에 배정하세요.');
    expect(runMsgs(w)).toEqual([]);
  });
  it('조종권을 잃으면(다른 사람에게 넘어감) 보내지 않고 «조종권 요청»으로', () => {
    const w = mount({ own: true, r: run('MOVING') });
    act(() => { w.recv(lease('r1', { id: 'u-park', name: '박OO' })); });
    expect(btn('일시정지')).toBeUndefined();
    expect(btns()).toContain('조종권 요청');
    expect(runMsgs(w)).toEqual([]);
  });
});

describe('시뮬 탭과 lease 충돌 (#537: 서버 길이 데모 Hub 조종자)', () => {
  it('재현: 서버 lease 의 중계가 Hub 를 잡고 있으면 시뮬 탭 «조종 시작»은 LEASE_HELD · 지금은 «다른 사람이 조종 중입니다.» 한 줄뿐(넘겨받기 길 없음)', async () => {
    vi.spyOn(api, 'phonePass').mockResolvedValue({ token: 'fake', exp: 9999999999, kid: 'fake' });
    await sim.attach({ robot_id: 'r7', generation: 1, agent_address: 'ws://127.0.0.1:9481/phone/ws', remaining_s: null } as SimRobot);
    const a = FakeWS.last;
    a.auto = null;   // 답은 아래에서 따로(실제처럼 보낸 뒤에)
    act(() => { a.open(); a.recv({ t: 'hello', robot: 'r7', camera_token: null }); a.recv({ t: 'state', robot: 'r7', latched: true, stop_gen: 1, applied: [0, 0, 0], lease_id: null }); });
    act(() => { sim.take(); });
    expect(a.of('lease.take')).toHaveLength(1);
    act(() => { a.recv({ t: 'reply', id: a.of('lease.take')[0].id, ...fail('LEASE_HELD') }); });   // Hub: 주인 = 서버 중계(hub.py lease.take → LEASE_HELD)
    expect(sim.get().link!.lease).toBeNull();
    expect(sim.get().link!.notice).toBe('다른 사람이 조종 중입니다.');
    expect('request' in sim).toBe(false);   // 시뮬 탭에는 넘겨받기(lease.request) 길이 없다 — 동작을 바꿀지는 결정 대기
  });
});

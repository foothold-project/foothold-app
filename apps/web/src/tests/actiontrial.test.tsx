import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Live } from '../rt';
import { ActionTrial, ACTION_NAMES, DANGEROUS, LOWLEVEL, LOWLEVEL_QUERY, actionResultText } from '../screens/actiontrial';
import { ROBOTS } from './fixtures';
import { state } from './fakeWs';

const mock = vi.hoisted(() => ({ live: {} as Live, link: 'open', action: vi.fn(), now: 1000 }));
vi.mock('../rt', () => ({ useLive: () => mock.live, rt: { now: () => mock.now, link: () => ({ at: mock.link }), action: mock.action } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, box: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); mock.link = 'open'; mock.now = 1000; mock.action.mockReset();
  mock.live = { lease: 'lease', stateAt: 1000, state: state('r7', { posture: { state: 'STANDING', mode: 1 } }) } as Live;
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
});
afterEach(() => { act(() => root.unmount()); box.remove(); vi.useRealTimers(); });
const render = (allowed = true, sim = false) => act(() => root.render(<ActionTrial robot={{ ...ROBOTS[1], sim }} allowed={allowed} />));
const grey = (b: HTMLButtonElement) => b.disabled || b.getAttribute('aria-disabled') === 'true';
const button = (api: string) => box.querySelector<HTMLButtonElement>(`[data-go2-action="${api}"]`)!;
const click = (el: HTMLElement) => act(() => el.click());

it('offers every closed-list API, excludes Move/ReleaseMode/lowcmd and hides all controls on simulation', () => {
  render();
  expect(box.querySelectorAll('[data-go2-action]').length).toBe(Object.keys(ACTION_NAMES).length);
  expect(box.querySelector('details')?.open).toBe(false);
  for (const name of ['Move', 'ReleaseMode', 'lowcmd']) expect(button(name)).toBeNull();
  expect(button('SelectMode').disabled).toBe(true);
  render(true, true); expect(box.innerHTML).toBe('');
});

it.each(['not_allowed', 'no_lease', 'offline', 'stale'])('locks buttons with a reason: %s', (why) => {
  if (why === 'no_lease') mock.live.lease = null;
  if (why === 'offline') mock.link = 'lost';
  if (why === 'stale') mock.now = 2100;
  render(why !== 'not_allowed');
  expect(button('Sit').disabled).toBe(true);
  expect(box.querySelector('.fh-why')?.textContent).not.toBe('');
  click(button('Sit')); expect(mock.action).not.toHaveBeenCalled();
});

it('danger requires an inline second click and sends exactly one confirmed request', () => {
  render(); click(button('FrontFlip'));
  expect(mock.action).not.toHaveBeenCalled();
  const confirm = [...box.querySelectorAll('button')].find((b) => b.textContent === '위험을 확인했고 실행')!;
  click(confirm);
  expect(mock.action).toHaveBeenCalledTimes(1);
  expect(mock.action.mock.calls[0].slice(0, 4)).toEqual(['r7', 'FrontFlip', {}, true]);
  expect(button('Sit').disabled).toBe(true);
  act(() => { mock.now += 5100; vi.advanceTimersByTime(5100); });
  expect(mock.action).toHaveBeenCalledTimes(1);
  expect(box.textContent).toContain('자동 재전송하지 않습니다');
});

it('all dangerous buttons require standing and stationary evidence', () => {
  mock.live.state = state('r7', { posture: { state: 'LYING', mode: 5 } }); render();
  for (const name of DANGEROUS) expect(button(name).disabled).toBe(true);
  expect(button('RecoveryStand').disabled).toBe(false);
  mock.live.state = state('r7', { posture: { state: 'STANDING', mode: 1 }, speed: .1 }); render();
  for (const name of DANGEROUS) expect(button(name).disabled).toBe(true);
});

it('empty or missing applied is not zero output evidence: dangerous buttons and the inline confirm stay closed', () => {
  const stand = (applied: number[] | null) => state('r7', { posture: { state: 'STANDING', mode: 1 }, applied });
  mock.live.state = stand([0, 0, 0]); render();
  for (const name of DANGEROUS) expect(button(name).disabled).toBe(false);   // 비지 않은 0 = 열림
  click(button('FrontFlip'));
  const confirm = () => [...box.querySelectorAll('button')].find((b) => b.textContent === '위험을 확인했고 실행')!;
  expect(confirm().disabled).toBe(false);
  for (const applied of [[], null, [0, .3, 0]]) {   // 현장 승인이 닫힌 에이전트는 applied [] (출력 없음) · 출력이 남은 경우도 닫힘
    mock.live.state = stand(applied); render();
    for (const name of DANGEROUS) expect(button(name).disabled).toBe(true);
    expect(confirm().disabled).toBe(true);
    click(confirm()); expect(mock.action).not.toHaveBeenCalled();
  }
});

it('cancels inline confirmation across a STOP generation or lease change', () => {
  render(); click(button('Damp'));
  expect(box.querySelector('[aria-label="위험 동작 확인"]')).not.toBeNull();
  mock.live.state = { ...mock.live.state!, stop_gen: 2 }; render();
  expect(box.querySelector('[aria-label="위험 동작 확인"]')).toBeNull();
  expect(mock.action).not.toHaveBeenCalled();
});

it('shows SDK result only for this request and preserves numeric rejection and read-only data', () => {
  mock.action.mockImplementation((_id, _action, _params, _confirmed, done) => done(null, 'request'));
  render(); click(button('Sit'));
  mock.live.state = { ...mock.live.state!, action_result: { request_id: 'other', action: 'Sit', status: 'SUCCEEDED', code: 'SDK_ACCEPTED', sdk_code: 0, mode: null, enabled: null } }; render();
  expect(box.querySelector('[data-action-result]')?.textContent).toContain('기다리고');
  mock.live.state = { ...mock.live.state!, action_result: { ...mock.live.state!.action_result!, request_id: 'request', status: 'FAILED', code: 'SDK_REJECTED', sdk_code: 73 } }; render();
  expect(box.querySelector('[data-action-result]')?.textContent).toContain('SDK 73');
  expect(box.querySelector('[data-action-result]')?.textContent).toContain('실패');
  expect(actionResultText({ request_id: 'a', action: 'CheckMode', status: 'SUCCEEDED', code: 'SDK_ACCEPTED', sdk_code: 0, mode: 'normal', enabled: null })).toContain('현재 모드: normal');
});

it('submits Euler defaults and no confirmation for an ordinary one-shot action', () => {
  render(); click(button('Euler'));
  expect(mock.action.mock.calls[0].slice(0, 4)).toEqual(['r7', 'Euler', { roll: 0, pitch: 0, yaw: 0 }, false]);
});

it('저수준 (START) 중에는 동작표 「저수준」 켬 일곱 개만 켜고 나머지는 꺼서 눌러도 보내지 않음 · 순정은 전부', () => {
  expect([...LOWLEVEL].sort()).toEqual(['Damp', 'Greet', 'Heart', 'Hello', 'RiseSit', 'Sit', 'StandDown', 'Stretch']);
  expect([ACTION_NAMES.Hello, ACTION_NAMES.Greet]).toEqual(['악수', '인사']);
  // 저수준 중 순정 자세 보고는 없을 수 있다: 서 있음 판정 없이도 비상 힘 빼기 (Damp) 는 켬
  mock.live.state = state('r7', { posture: { state: 'UNKNOWN', mode: null }, control: 'LOWLEVEL' }); render();
  expect(box.querySelector('[data-lowlevel]')).not.toBeNull();
  for (const name of Object.keys(ACTION_NAMES) as (keyof typeof ACTION_NAMES)[]) expect(grey(button(name))).toBe(!LOWLEVEL.has(name) && !LOWLEVEL_QUERY.has(name));
  expect([...LOWLEVEL_QUERY].sort()).toEqual(['AutoRecoveryGet', 'CheckMode']);
  for (const name of ['Scrape', 'FrontFlip', 'RecoveryStand', 'StandUp', 'SpeedLevel']) click(button(name));
  expect(mock.action).not.toHaveBeenCalled();
  expect(box.querySelector('[data-off-why]')?.textContent).toContain('저수준 제어 중에는 쓸 수 없음');
  click(button('Stretch'));
  expect(mock.action.mock.calls.map((c) => c[1])).toEqual(['Stretch']);
  mock.action.mockReset(); act(() => { mock.now += 6000; vi.advanceTimersByTime(6000); }); mock.live.stateAt = mock.now;
  render(); click(button('Damp'));
  click([...box.querySelectorAll('button')].find((b) => b.textContent === '위험을 확인했고 실행')!);
  expect(mock.action.mock.calls.map((c) => c.slice(1, 4))).toEqual([['Damp', {}, true]]);
  expect(actionResultText({ request_id: 'a', action: 'Scrape', status: 'REJECTED', code: 'LOWLEVEL_UNSUPPORTED', sdk_code: null, mode: null, enabled: null })).toContain('저수준 제어 중에는');
  expect(actionResultText({ request_id: 'a', action: 'Sit', status: 'REJECTED', code: 'RUNNER_NOT_CONNECTED', sdk_code: null, mode: null, enabled: null })).toContain('연결되지 않았습니다');
  act(() => { mock.now += 6000; vi.advanceTimersByTime(6000); }); mock.live.stateAt = mock.now;
  mock.live.state = state('r7', { posture: { state: 'STANDING', mode: 1 }, control: 'FACTORY' }); render();
  expect(box.querySelector('[data-lowlevel]')).toBeNull();
  // 순정: 인사 (Greet) 는 SDK 번호가 없어 회색 · 눌러도 안 감
  for (const name of Object.keys(ACTION_NAMES) as (keyof typeof ACTION_NAMES)[]) expect(grey(button(name))).toBe(name === 'SelectMode' || name === 'Greet');
  mock.action.mockReset(); click(button('Greet')); expect(mock.action).not.toHaveBeenCalled();
  expect(box.querySelector('[data-off-why]')?.textContent).toContain('순정 번호 확인 전'); expect(box.querySelector('[data-factory-off]')).not.toBeNull();
});

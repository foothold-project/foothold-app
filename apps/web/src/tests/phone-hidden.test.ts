import { afterEach, expect, it, vi } from 'vitest';
import type { SimRobot } from '../../../contracts/ts';
import { sim } from '../phone';
import { FakeWS } from './fakeWs';

const R = '11111111-1111-4111-8111-111111111111', L = 'lease';
const run = { run_id: 'run', status: 'MOVING', step: null, progress: { done: 0, total: 2 }, wait_reason: null, fail_code: null };
const limits = { vx_min: 0, vx_max: .6, vy_min: 0, vy_max: 0, wz_min: -.5, wz_max: .5, commands: [] };
async function connect(simulation: boolean | undefined) {
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ token: 'test', exp: 2000000000, kid: 'k' }), { status: 200 }));
  // Even if REST says simulation, only the agent hello can opt out of real safety.
  await sim.attach({ robot_id: R, simulation: true, agent_address: 'ws://127.0.0.1:9433/phone/ws' } as SimRobot);
  const ws = FakeWS.last; ws.auto = null; ws.open();
  ws.recv({ t: 'hello', robot: R, simulation, limits });
  ws.recv({ t: 'state', robot: R, lease_id: L, latched: false, stop_gen: 1, run });
  return ws;
}
function hidden() {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
}
afterEach(() => { sim.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([10, 60, 310])('시뮬 숨김 %s초: 타이머 없이 state 수신만으로 ping·조종권·임무 유지', async (seconds) => {
  const ws = await connect(true);
  hidden();
  // Browser timer callbacks stop entirely; agent state network events still arrive at 10 Hz.
  vi.clearAllTimers();
  for (let i = 0; i < seconds * 10; i++) {
    vi.advanceTimersByTime(100);
    ws.recv({ t: 'state', robot: R, lease_id: L, latched: false, stop_gen: 1, run });
  }
  expect(ws.of('ping')).toHaveLength(seconds + 1);
  expect(ws.of('lease.release')).toHaveLength(0);
  expect(ws.of('cmd')).toHaveLength(0);
  expect(ws.readyState).toBe(1);
  expect(sim.get().link).toMatchObject({ at: 'open', lease: L, run });
  // Explicit release and closing still work after returning.
  void sim.release();
  expect(ws.of('lease.release')).toHaveLength(1);
  sim.close(); expect(ws.readyState).toBe(3);
});

it.each([false, undefined])('실기·미확인 hello(%s): 숨기면 기존대로 즉시 반납, state는 ping을 대신하지 않음', async (simulation) => {
  const ws = await connect(simulation);
  hidden();
  expect(ws.of('lease.release')).toHaveLength(1);
  expect(sim.get().link?.lease).toBeNull();
  vi.clearAllTimers();
  for (let i = 0; i < 60; i++) {
    vi.advanceTimersByTime(1000);
    ws.recv({ t: 'state', robot: R, lease_id: null, stop_gen: 1, run: null });
  }
  expect(ws.of('ping')).toHaveLength(0);
});

it('시뮬 숨김 중 수동 입력은 0, timer·state가 겹쳐도 ping은 1초에 한 번', async () => {
  const ws = await connect(true);
  ws.recv({ t: 'state', robot: R, lease_id: L, latched: false, stop_gen: 1, run: null });
  sim.axes([1, 0]);
  hidden();
  vi.advanceTimersByTime(2000);
  ws.recv({ t: 'state', robot: R, lease_id: L, latched: false, stop_gen: 1, run: null });
  expect(ws.of('ping')).toHaveLength(3);
  expect(ws.of('cmd').length).toBeGreaterThan(0);
  expect(ws.of('cmd').every(m => m.vx === 0 && m.vy === 0 && m.wz === 0)).toBe(true);
});

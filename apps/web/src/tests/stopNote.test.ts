// PR #90 Codex 검토 경계(B1 옛 stop_gen·B2 재연결·B3 OFFLINE/null): STOP 안내는 이 연결·이 STOP 세대의 잠금→해제로만 지운다
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { sim } from '../phone';
import { rt } from '../rt';
import { FakeWS, state } from './fakeWs';
import type { SimRobot } from '../../../contracts/ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  FakeWS.all = []; vi.stubGlobal('WebSocket', FakeWS);
});
afterEach(() => { sim.clear(); rt.disconnect(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const advance = () => vi.advanceTimersByTime(10);
function fleet() {
  rt.connect(['r7']); const w = FakeWS.last; w.open();
  w.recv(state('r7', { latched: false, stop_gen: 1 })); advance();
  rt.stop('r7'); advance();
  w.recv(state('r7', { latched: true, stop_gen: 2 })); advance();
  expect(rt.get('r7').stop).not.toBeNull();
  return w;
}
async function phone() {
  vi.spyOn(api, 'phonePass').mockResolvedValue({ token: 'fake', exp: 9999999999, kid: 'fake' });
  await sim.attach({ robot_id: 'r7', generation: 1, agent_address: 'ws://127.0.0.1:9481/phone/ws', remaining_s: null } as SimRobot);
  const w = FakeWS.last; w.auto = null; w.open();
  w.recv({ t: 'hello', robot: 'r7', camera_token: null });
  w.recv({ t: 'state', robot: 'r7', latched: false, stop_gen: 1, applied: [0,0,0], lease_id: null }); advance();
  sim.stop(); advance();
  w.recv({ t: 'state', robot: 'r7', latched: true, stop_gen: 2, applied: [0,0,0], lease_id: null }); advance();
  expect(sim.get().stop).not.toBeNull();
  return w;
}
it('fleet: OFFLINE/null does not prove unlock', () => {
  const w = fleet();
  w.recv(state('r7', { connection: 'OFFLINE', latched: null, stop_gen: null, applied: null }));
  expect(rt.get('r7').stop).not.toBeNull();
});
it('fleet: reconnect cannot use previous socket latch to clear STOP', () => {
  const w = fleet(); w.drop(1006); vi.advanceTimersByTime(1000);
  const next = FakeWS.last; expect(next).not.toBe(w); next.open(); advance();
  next.recv(state('r7', { latched: false, stop_gen: 0 }));
  expect(rt.get('r7').stop).not.toBeNull();
});
it('phone: reconnect cannot use previous socket latch to clear STOP', async () => {
  const w = await phone(); w.drop(1006); await sim.connect();
  const next = FakeWS.last; expect(next).not.toBe(w); next.open();
  next.recv({ t: 'hello', robot: 'r7', camera_token: null }); advance();
  next.recv({ t: 'state', robot: 'r7', latched: false, stop_gen: 0, applied: [0,0,0], lease_id: null });
  expect(sim.get().stop).not.toBeNull();
});
it('fleet: repeated STOP cannot be acknowledged by previous STOP generation', () => {
  const w = fleet(); rt.stop('r7'); advance();
  expect(rt.get('r7').stop?.latched).toBeUndefined();
  w.recv(state('r7', { latched: true, stop_gen: 2 })); advance();
  w.recv(state('r7', { latched: false, stop_gen: 2 }));
  expect(rt.get('r7').stop).not.toBeNull();
});
it('phone: repeated STOP cannot be acknowledged by previous STOP generation', async () => {
  const w = await phone(); sim.stop(); advance();
  expect(sim.get().stop?.latched).toBeUndefined();
  w.recv({ t: 'state', robot: 'r7', latched: true, stop_gen: 2, applied: [0,0,0], lease_id: null }); advance();
  w.recv({ t: 'state', robot: 'r7', latched: false, stop_gen: 2, applied: [0,0,0], lease_id: null });
  expect(sim.get().stop).not.toBeNull();
});

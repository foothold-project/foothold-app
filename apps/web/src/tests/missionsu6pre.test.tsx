// 시안 u15_2 «실제 로봇 시작 전 점검» 창(missionsu6pre Preflight · useRunGate). 모의 실행(u6_6)도 같은 관문을 쓴다.
// 로봇이 다른 실행을 돌리는 중이면 그 실행을 «내 실행»으로 보지 않는다: 실행 단추는 막고 «시작함»이라 하지 않는다. 이 창이 보낸 run_id 가 state.run 에 올 때만 시작했다고 적는다.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assignment, RunSnapshot, Scenario } from '../../../contracts/ts';
import { api } from '../api';
import { rt } from '../rt';
import type { Robot, User } from '../fake';
import { Preflight } from '../screens/missionsu6pre';
import { FakeWS, lease, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const R: Robot = { id: 'r1', name: 'K-01', owner: 'u-lee', ownerName: '이OO', battery: 80, online: true, seenAt: '14:05:20', status: 'IDLE', sim: true };
const ME = { id: 'u-lee', name: '이OO', role: 'OPERATOR' } as unknown as User;
const SC = { id: 'sc1', name: '1층 순찰', version: 3, latest_version: 3, floor_ids: ['f1'], map_version_ids: ['mv1'], waypoints: [{ floor_id: 'f1', map_version_id: 'mv1', x: 0, y: 0, mission_id: 'm1', mission_version: 1, name: null }] } as unknown as Scenario;
const AS = { id: 'as1', robot_id: 'r1', scenario_id: 'sc1', scenario_version: 3, status: 'ACTIVE' } as unknown as Assignment;
const run = (status: RunSnapshot['status'], run_id: string): RunSnapshot => ({ run_id, status, step: 1, progress: { done: 0, total: 3 } as RunSnapshot['progress'], wait_reason: null, fail_code: null });

let root: Root | null = null, box: HTMLDivElement;
beforeEach(() => { FakeWS.all = []; vi.stubGlobal('WebSocket', FakeWS); vi.spyOn(api, 'assignments').mockResolvedValue([AS]); });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); rt.disconnect(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(r: RunSnapshot | null) {
  rt.connect(['r1']);
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Preflight robot={R} scen={SC} sub="15:00 ~ 15:30" user={ME} close={() => {}} />); });
  const w = FakeWS.last;
  act(() => { w.open(); w.recv(state('r1', { latched: false, run: r })); w.recv(lease('r1', { id: 'u-lee', name: '이OO' }, 'L-1')); });
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  return w;
}
const $ = (s: string) => box.querySelector<HTMLElement>(s);

describe('u15_2 점검 창 · 내 실행만', () => {
  it('로봇이 다른 실행 중이면 실행 막음 · 까닭 한 줄 · «시작함» 아님 · run 명령 0', async () => {
    const w = await mount(run('MOVING', 'run-other'));
    const go = $('[data-preflight-go]') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(go.textContent).toBe('실행');
    expect($('[data-preflight-why]')!.textContent).toContain('이미 임무를 실행 중');
    expect(w.sent.filter((m) => m.t.startsWith('run.'))).toEqual([]);
  });
  it('«실행» = run.start(새 run_id) · 그 run_id 가 state.run 에 와야 «시작함» · 다른 run_id 면 아님', async () => {
    const w = await mount(null);
    expect($('[data-ck="lease"]')!.dataset.ok).toBe('true');
    act(() => { ($('[data-preflight-go]') as HTMLButtonElement).click(); });
    const m = w.of('run.start')[0];
    expect(m).toMatchObject({ robot: 'r1', lease_id: 'L-1', assignment_id: 'as1', scenario_id: 'sc1', scenario_version: 3 });
    expect($('[data-preflight-go]')!.textContent).not.toBe('시작함');
    act(() => { w.recv(state('r1', { latched: false, run: run('MOVING', 'run-other') })); });
    expect($('[data-preflight-go]')!.textContent).not.toBe('시작함');
    act(() => { w.recv(state('r1', { latched: false, run: run('MOVING', m.run_id as string) })); });
    expect($('[data-preflight-go]')!.textContent).toBe('시작함');
    expect($('[data-preflight-why]')!.textContent).toContain('K-01 임무를 시작했습니다');
  });
});

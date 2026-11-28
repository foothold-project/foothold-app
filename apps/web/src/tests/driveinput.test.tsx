// 조종 화면 위 「에이전트 조종 막힘 까닭」 한 줄(u11_4 · U11-05). 에이전트가 장치 줄 key 'go2-drive-input' 의 label 로 보내는 글을
// 그대로 한 줄로 보인다(link/session.py _devices · go2_direct/sink.py movement_reason). 웹은 글을 짓거나 STOP 약속을 덧붙이지 않는다.
// label 이 비거나 줄이 없으면 안 띄운다. 붙는 자리: 서버 경유 PC 패널(serverdrive.tsx) · 폰 조종 화면(drive.tsx).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device, ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { api } from '../api';
import { DRIVE_INPUT_KEY, DriveInputNote } from '../driveinput';
import { ServerDrive } from '../serverdrive';
import { simTune } from '../phone';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { fleetRow } from './fleetRow';
import { FakeWS, lease, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REMOTE = '리모컨 동작 중이라 화면 조종은 멈춰 있습니다';
const OTHER = '조종 막대에서 손을 한 번 뗀 뒤 다시 조종해 주세요';
const dev = (label: string, key = DRIVE_INPUT_KEY): Device => ({ key, kind: 'OTHER', label, state: 'OK' } as Device);
const CAM = dev('카메라', 'cam-front');

let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); });
const draw = (devices: Device[] | null | undefined) => {
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<DriveInputNote devices={devices} />); });
  return box.querySelector<HTMLElement>('[data-drive-input]');
};

describe('DriveInputNote (가짜 장치 줄)', () => {
  it('리모컨 문장: label 그대로 한 줄 · 덧붙인 글 없음', () => {
    const p = draw([CAM, dev(REMOTE)])!;
    expect(p.textContent).toBe(REMOTE);
    expect(p.getAttribute('role')).toBe('status');
  });
  it('다른 까닭도 label 그대로', () => { expect(draw([dev(OTHER)])!.textContent).toBe(OTHER); });
  it('빈 label · 공백 label 은 안 띄움', () => {
    expect(draw([dev('')])).toBeNull();
    act(() => root!.unmount()); box.remove();
    expect(draw([dev('   ')])).toBeNull();
  });
  it('줄 없음 · 장치 목록 없음은 안 띄움', () => {
    expect(draw([CAM])).toBeNull();
    act(() => root!.unmount()); box.remove();
    expect(draw(null)).toBeNull();
  });
});

// 화면에 붙었는지: 가짜 서버가 보내는 state.devices 로 본다(serverdrive.test · drive.test 와 같은 흉내)
describe('조종 화면에 붙음', () => {
  const ORG = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
  let w: FakeWS, st: Record<string, ScreenState> = {}, mock: { mockRestore: () => void };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    mock = vi.spyOn(api, 'settings').mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
  });
  afterEach(() => { act(() => root?.unmount()); root = null; mock.mockRestore(); simTune(null); vi.useRealTimers(); });
  const push = (r: string, p: Partial<ScreenState> = {}) => act(() => { st[r] = { ...(st[r] ?? state(r)), ...p }; w.recv(st[r]); });
  const serve = (sock: FakeWS, ...ids: string[]) => {
    w = sock; st = {};
    w.auto = (m) => { w.recv({ t: 'reply', id: m.id, ok: true }); if (m.t === 'lease.release' || m.t === 'hidden') w.recv(lease(m.robot as string, null)); };
    act(() => { w.open(); }); ids.forEach((id) => push(id));
  };
  const mq = (phone: boolean) => { window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia; };
  const line = () => box.querySelector<HTMLElement>('[data-drive-input]');

  it('서버 경유 PC 패널(serverdrive): 받은 label 한 줄 · 줄이 빠지면 사라짐 · 오래된 상태면 안 띄움', () => {
    mq(false); location.hash = '#/fleet';
    const on: Robot[] = ROBOTS.map((r) => (r.id === 'r7' ? { ...r, serverDrive: true } : r));
    const u = USERS.find((x) => x.id === 'u-park')!, side = on.find((x) => x.id === 'r7')!;
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<><App user={u} robots={on.map((x) => ({ ...x, serverDrive: false }))} /><ServerDrive c={{ user: u }} r={side} /></>); });
    serve(FakeWS.all.filter((x) => x.url.endsWith('/api/v1/ws')).pop()!, 'r7');
    act(() => { (fleetRow(box, 'Go2-7') as HTMLElement).click(); });
    expect(line()).toBeNull();
    push('r7', { devices: [CAM, dev(REMOTE)] });
    expect(box.querySelector('[data-server-drive]')!.querySelector('[data-drive-input]')!.textContent).toBe(REMOTE);
    act(() => { vi.advanceTimersByTime(3500); });   // 새 상태 없이 3 초 넘음 = 오래된 글
    expect(line()).toBeNull();
    push('r7', { devices: [CAM, dev(OTHER)] });
    expect(line()!.textContent).toBe(OTHER);
    push('r7', { devices: [CAM] });
    expect(line()).toBeNull();
  });

  it('폰 조종 화면(drive.tsx): 받은 label 한 줄 · 오래된 상태 · 빈 label 은 안 띄움', () => {
    mq(true); location.hash = '#/drive/r7';
    const u = USERS.find((x) => x.id === 'u-park')!;
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<App user={u} robots={ROBOTS.map((r) => ({ ...r, serverDrive: true }))} />); });
    serve(FakeWS.last, 'r7');
    push('r7', { devices: [dev(REMOTE)] });
    expect(box.querySelector('.u1d .u1-says [data-drive-input].ban.amb')!.textContent).toBe(REMOTE);
    act(() => { vi.advanceTimersByTime(3500); });   // 새 상태 없이 3 초 넘음
    expect(line()).toBeNull();
    push('r7', { devices: [dev(REMOTE)] });   // 같은 상태가 다시 오면 rt 는 다시 그리지 않고 시각만 고친다(rt.ts same) · 다음 화면 틱에 다시 보임
    act(() => { vi.advanceTimersByTime(1000); });
    expect(line()!.textContent).toBe(REMOTE);
    push('r7', { devices: [dev('')] });
    expect(line()).toBeNull();
  });
});

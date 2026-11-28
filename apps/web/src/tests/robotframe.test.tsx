// 로봇 탭 u4_1 틀(11/28): 왼쪽 로봇 목록 · 가운데 고른 로봇 3D(지금 동작) · 오른쪽 지도 · 조종 칸.
// 옛 화면(수 띠 · 큰 지도 · 경보 · 아래 표)의 기능(요약 수, 담당 · 상태 거르기, 경보, 층 고르기, 조종 들어가기, 운영 관리자 표)이 새 자리에 다 있는지,
// 고른 로봇이 바뀌면 가운데 · 오른쪽이 따라 바뀌는지, 목록이 비면 무엇을 보이는지 본다. 조종 · STOP 경로는 그대로(자리만).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { fleetRow } from './fleetRow';
import { FakeWS, lease, state, type Msg } from './fakeWs';
import { simTune } from '../phone';
import { api } from '../api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement, w: FakeWS, st: Record<string, ScreenState> = {};
const KIM = USERS[0], LEE = USERS[1];
const ORG = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.spyOn(api, 'settings').mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
  vi.spyOn(api, 'robot').mockImplementation(() => new Promise(() => {}));
  vi.spyOn(api, 'users').mockImplementation(() => new Promise(() => {}));
});
afterEach(() => { act(() => root?.unmount()); vi.restoreAllMocks(); simTune(null); root = null; box?.remove(); vi.useRealTimers(); });

/** Go2-A = 총괄(김OO) 담당 실기 · 서버 경유 허용 */
const MINE: Robot = { id: 'ra', name: 'Go2-A', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'IDLE', serverDrive: true };
function mount(user: typeof KIM, robots: Robot[]) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/fleet';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={user} robots={robots} />); });
  w = FakeWS.all.filter((x) => x.url.endsWith('/api/v1/ws')).pop()!; st = {};
  w.auto = (m: Msg) => {
    w.recv({ t: 'reply', id: m.id, ok: true });
    if (m.t === 'lease.take') { w.recv(lease(m.robot as string, { id: user.id, name: user.name }, `L${m.id}`)); w.recv({ t: 'lease.result', robot: m.robot, request_id: null, result: 'ACCEPTED' }); }
  };
  act(() => { w.open(); });
  robots.forEach((r) => { if (r.online) { st[r.id] = state(r.id); act(() => { w.recv(st[r.id]); }); } });
}
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const click = (el: Element | null) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); };
const frame = () => $('[data-robot-frame]')!;
const rail = () => frame().querySelector<HTMLElement>('[data-robot-rail]')!;
const head = () => frame().querySelector('[data-robot-head] h2')?.textContent;
const pick = (v: string) => act(() => {
  const el = rail().querySelector<HTMLSelectElement>('[data-filter="state"]')!;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('change', { bubbles: true }));
});

describe('총괄: 틀 세 칸 + 옛 기능의 새 자리', () => {
  it('왼쪽 목록 안에 요약 수 · 거르기 둘 · 경보 · 로봇 행, 가운데 3D, 오른쪽 지도(층 고르기 칸), 아래 운영 관리자 표. 옛 큰 지도 · 아래 표 틀 없음', () => {
    mount(KIM, [ROBOTS[0], ROBOTS[1], ROBOTS[2], MINE]);
    expect(frame()).not.toBeNull();
    expect(rail().getAttribute('aria-label')).toBe('로봇 목록');
    expect(rail().querySelector('[aria-label="요약"]')).not.toBeNull();
    expect(rail().querySelector('[data-filter="owner"]')).not.toBeNull();
    expect(rail().querySelector('[data-filter="state"]')).not.toBeNull();
    expect(rail().querySelector('[aria-label="경보"]')).not.toBeNull();
    expect([...rail().querySelectorAll<HTMLElement>('[data-robot-row]')].map((b) => b.dataset.robotRow)).toEqual(['r3', 'r7', 'r1', 'ra']);
    expect(frame().querySelector('[data-robot-3d]')).not.toBeNull();
    expect(frame().querySelector('[data-robot-side] [aria-label="지도"]')).not.toBeNull();
    expect($('[aria-label="운영 관리자"]')).not.toBeNull();
    expect($('.fh-fleet')).toBeNull();
  });
  it('행을 누르면 고른 로봇이 바뀐다: 머리 이름 · 3D 대상 · 눌림 표시 · 오른쪽 상세가 함께', () => {
    mount(KIM, [ROBOTS[0], ROBOTS[1], MINE]);
    click(fleetRow(box, 'Go2-7'));
    expect(head()).toBe('Go2-7');
    expect(frame().querySelector<HTMLElement>('[data-robot-3d]')!.getAttribute('data-robot-3d')).toBe('r7');
    expect(rail().querySelector('[aria-pressed="true"]')!.textContent).toContain('Go2-7');
    click(frame().querySelector('[data-seg="check"]'));
    expect(frame().querySelector('[data-robot-side] [aria-label="로봇 상세"]')).not.toBeNull();
    click(fleetRow(box, 'Go2-3'));
    expect(head()).toBe('Go2-3');
    expect(frame().querySelector<HTMLElement>('[data-robot-3d]')!.getAttribute('data-robot-3d')).toBe('r3');
  });
  it('머리 칸: 연결 · 자세 · 배터리 · 온도 · 조종자', () => {
    mount(KIM, [ROBOTS[0], MINE]);
    click(fleetRow(box, 'Go2-3'));
    const cells = [...frame().querySelectorAll<HTMLElement>('[data-robot-head] [data-cell]')].map((x) => x.dataset.cell);
    expect(cells).toEqual(['link', 'posture', 'battery', 'temp', 'holder']);
    expect(frame().querySelector('[data-cell="battery"]')!.textContent).toContain('80%');   // 받은 state 값(fakeWs 기본)
  });
  it('조종 들어가기: 서버가 허용한 실기 → 오른쪽 «조종 화면» → 목록은 왼쪽에 남고 조종 화면(STOP 포함)이 틀 안에', () => {
    mount(KIM, [ROBOTS[0], MINE]);
    click(fleetRow(box, 'Go2-A'));
    click(frame().querySelector('[data-robot-side] [data-admin-drive]'));
    expect(frame().querySelector('[data-pc-drive]')).not.toBeNull();
    expect(rail()).not.toBeNull();
    click(fleetRow(box, 'Go2-3'));
    expect(frame().querySelector('[data-pc-drive]')).toBeNull();
    expect(head()).toBe('Go2-3');
  });
  it('빈 목록: 거른 조건에 맞는 로봇이 없으면 목록 자리에 한 줄, 틀 · 거르기는 그대로', () => {
    mount(KIM, [ROBOTS[0], MINE]);
    pick('off');
    expect(rail().querySelectorAll('[data-robot-row]')).toHaveLength(0);
    expect(rail().textContent).toContain('거른 조건에 맞는 로봇이 없습니다.');
    expect(rail().querySelector('[data-filter="state"]')).not.toBeNull();
  });
});

describe('운영 관리자: 같은 틀', () => {
  it('내 로봇 · 남의 로봇이 왼쪽 목록 한 곳에(남의 로봇은 «다른 로봇» 묶음), 오른쪽에 상태 한 줄 · 관측 지도 · 조종 준비 · 상세', () => {
    mount(LEE, [ROBOTS[0], ROBOTS[1], ROBOTS[2]]);
    expect(rail().querySelector('[aria-label="다른 로봇"]')!.textContent).toContain('Go2-7');
    expect([...rail().querySelectorAll<HTMLElement>('[data-robot-row]')].map((b) => b.dataset.robotRow)).toEqual(['r3', 'r1', 'r7']);
    expect(frame().querySelector('[data-robot-side] [aria-label="로봇 보기"] [data-view="map"]')).not.toBeNull();
    click(frame().querySelector('[data-seg="check"]'));
    const side = frame().querySelector('[data-robot-side]')!;
    for (const l of ['로봇 연결 상태', '로봇 관측', '조종 준비', '로봇 상세']) expect(side.querySelector(`[aria-label="${l}"]`)).not.toBeNull();
    expect(frame().querySelector('[data-robot-3d]')).not.toBeNull();
    expect($('[aria-label="요약"]')).toBeNull();
    click(fleetRow(box, 'Go2-1'));
    expect(head()).toBe('Go2-1');
  });
  it('담당 로봇이 없으면 목록에 안내 한 줄, 남의 로봇은 그대로 «다른 로봇»', () => {
    mount(LEE, [ROBOTS[1]]);
    expect(rail().textContent).toContain('담당 로봇이 없습니다');
    expect(rail().querySelector('[aria-label="다른 로봇"]')!.textContent).toContain('Go2-7');
  });
  it('허용된 내 실기는 바로 조종 화면 — 왼쪽 목록은 남는다', () => {
    mount(LEE, [{ ...ROBOTS[0], serverDrive: true }, ROBOTS[2]]);
    expect(frame().querySelector('[data-pc-drive]')).not.toBeNull();
    expect(rail().querySelectorAll('[data-robot-row]')).toHaveLength(2);
  });
});

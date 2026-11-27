// 총괄 = 모든 권한(팀장 11/28 · 서버 #544 1 차): 총괄도 실기 조종 · STOP · 조종권 · 자세 · 로봇 붙이기.
// 남는 관문(서버 조종 스위치 PHONE_DIRECT_REQUIRED · 연결 확인 FIELD_APPROVAL_REQUIRED · 조종권 하나 · 정지 잠김)은 화면이 우회하지 않고 서버 문구 한 줄.
// 2 차(남 담당 실기의 이름 · 지우기 · 끊기 · 키 재발급 · 담당 바꾸기)는 아직 열지 않고 까닭 한 줄. 운영 관리자 판정은 그대로
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { fleetRow } from './fleetRow';
import { FakeWS, fail, lease, state, type Msg } from './fakeWs';
import { simTune } from '../phone';
import { ADMIN_LATER, driveBlock } from '../fake';
import { canDrive } from '../serverdrive';
import { api } from '../api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement, w: FakeWS, st: Record<string, ScreenState> = {};
const KIM = USERS[0], LEE = USERS[1], PARK = USERS[2];
const ORG = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
let settingsMock: { mockRestore: () => void };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  settingsMock = vi.spyOn(api, 'settings').mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
  vi.spyOn(api, 'robot').mockImplementation(() => new Promise(() => {}));   // 서랍 상세는 목록 값으로(답 없음)
  vi.spyOn(api, 'users').mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  act(() => root?.unmount()); settingsMock.mockRestore(); vi.restoreAllMocks(); simTune(null); root = null; box?.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

/** Go2-7 = 박OO 담당 · 서버 경유 허용, Go2-A = 총괄(김OO) 담당 실기 */
const MINE: Robot = { id: 'ra', name: 'Go2-A', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'IDLE', serverDrive: true };
const LIST = [ROBOTS[0], { ...ROBOTS[1], serverDrive: true }, MINE];
function mount(phone: boolean, user: typeof KIM, hash: string, robots: Robot[] = LIST) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={user} robots={robots} />); });
}
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t);
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const push = (r: string, p: Partial<ScreenState> = {}) => { st[r] = { ...(st[r] ?? state(r)), ...p }; act(() => { w.recv(st[r]); }); };
/** 서버 흉내. take = lease.take 에 서버가 주는 답(기본 받아 줌) */
let take: ((m: Msg) => object | null) = () => null;
function serve(me: { id: string; name: string }, ...ids: string[]) {
  w = FakeWS.all.filter((x) => x.url.endsWith('/api/v1/ws')).pop()!; st = {};
  w.auto = (m: Msg) => {
    const r = m.robot as string;
    if (m.t === 'lease.take') { const no = take(m); if (no) { w.recv({ t: 'reply', id: m.id, ...no }); return; } }
    w.recv({ t: 'reply', id: m.id, ok: true });
    if (m.t === 'lease.take') { w.recv(lease(r, me, `L${m.id}`)); w.recv({ t: 'lease.result', robot: r, request_id: null, result: 'ACCEPTED' }); }
    if (m.t === 'unlock') { st[r] = { ...st[r], latched: false }; w.recv(st[r]); }
    if (m.t === 'stop' && st[r]) { st[r] = { ...st[r], latched: true, stop_gen: st[r].stop_gen! + 1 }; w.recv(st[r]); }
    if (m.t === 'lease.release' || m.t === 'hidden') w.recv(lease(r, null));
  };
  act(() => { w.open(); }); ids.forEach((id) => push(id));
}
beforeEach(() => { take = () => null; });
const space = () => act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true })); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true, cancelable: true })); });

describe('총괄 = 모든 권한: 조종 판정', () => {
  it('총괄은 남 담당 실기도 조종 이유 없음 · 운영 관리자는 남의 로봇이면 그대로 막힘', () => {
    expect(driveBlock(KIM, LIST[1])).toBeNull();
    expect(driveBlock(KIM, MINE)).toBeNull();
    expect(driveBlock(LEE, LIST[1])).toContain('내 로봇만 조종할 수 있습니다');
  });
  it('PC 서버 경유 조종: 총괄은 서버가 허용한 실기면 담당이 아니어도 · 서버가 허용하지 않은 실기 · 남의 로봇 운영자는 그대로 없음', () => {
    expect(canDrive({ user: KIM, phone: false }, LIST[1])).toBe(true);
    expect(canDrive({ user: KIM, phone: false }, { ...LIST[1], serverDrive: false })).toBe(false);   // 서버 조종 스위치 · 연결 확인 관문(목록 server_drive_allowed)
    expect(canDrive({ user: LEE, phone: false }, LIST[1])).toBe(false);
    expect(canDrive({ user: PARK, phone: false }, LIST[1])).toBe(true);
  });
});

describe('총괄 = 모든 권한: PC', () => {
  it('로봇 탭: 실기를 고르면 머리줄 STOP · Space 가 그 실기로 간다', () => {
    mount(false, KIM, '#/fleet'); serve(KIM, 'r3', 'r7', 'ra');
    click(fleetRow(box, 'Go2-7'));
    const stop = $('[data-stop]')!;
    expect(stop).not.toBeNull();
    click(stop);
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7']);
    space();
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7', 'r7']);
  });
  it('서랍에서 «조종 화면» → 조종 시작이 조종권 요청을 보내고, 성공은 서버 lease 뒤에만 «조종 중»', () => {
    mount(false, KIM, '#/fleet'); serve(KIM, 'r3', 'r7', 'ra');
    click(fleetRow(box, 'Go2-7'));
    click($('[data-admin-drive]')!);
    click(btn('조종 시작')!);
    expect(w.of('lease.take').map((m) => m.robot)).toEqual(['r7']);
    expect($('[data-server-drive]')!.textContent).not.toContain('보는 중');
  });
  it('서버가 거절(서버 조종 스위치 PHONE_DIRECT_REQUIRED · 연결 확인 FIELD_APPROVAL_REQUIRED): 서버 문구 한 줄, 조종 중이 아님', () => {
    for (const [code, text] of [['PHONE_DIRECT_REQUIRED', '실기 조종·STOP은 현장 폰에서 직접 하세요.'], ['FIELD_APPROVAL_REQUIRED', '로봇 연결과 담당 정보를 확인하고 있습니다.']]) {
      act(() => root?.unmount()); box?.remove();
      take = () => fail(code, text);
      mount(false, KIM, '#/fleet'); serve(KIM, 'r3', 'r7', 'ra');
      click(fleetRow(box, 'Go2-7')); click($('[data-admin-drive]')!); click(btn('조종 시작')!);
      tick(100);
      expect(box.textContent).toContain(text);
      expect(btn('조종 끝내기')).toBeUndefined();
      expect(btn('조종 시작')).not.toBeUndefined();
    }
  });
  it('서버가 허용하지 않은 실기(server_drive_allowed 없음)는 «조종 화면» 없이 까닭 한 줄', () => {
    mount(false, KIM, '#/fleet', [ROBOTS[0], ROBOTS[1]]); serve(KIM, 'r3', 'r7');
    click(fleetRow(box, 'Go2-7'));
    expect($('[data-admin-drive]')).toBeNull();
    expect($('[data-admin-nodrive]')!.textContent).toContain('서버 경유 조종');
  });
  it('2 차 몫: 남 담당 실기는 이름 · 지우기 · 끊기 · 담당 바꾸기를 열지 않고 까닭 한 줄 · 내가 담당인 실기는 관리', () => {
    mount(false, KIM, '#/fleet'); serve(KIM, 'r3', 'r7', 'ra');
    click(fleetRow(box, 'Go2-7'));
    expect($('[data-manage]')).toBeNull();
    expect(btn('로봇 지우기')).toBeUndefined(); expect(btn('연결 끊기')).toBeUndefined();
    expect($('[data-admin-later]')!.textContent).toBe(ADMIN_LATER);
    click(fleetRow(box, 'Go2-A'));
    expect($('[data-manage]')).not.toBeNull();
    expect($('[data-admin-later]')).toBeNull();
  });
  it('«+ 새 로봇 추가» 가 총괄에게도', () => {
    mount(false, KIM, '#/fleet'); serve(KIM, 'r3', 'r7', 'ra');
    expect($('[data-pair-start]')).not.toBeNull();
  });
});

describe('총괄 = 모든 권한: 폰', () => {
  it('로봇 연결: 남 담당 실기 카드도 «연결» · 조종 화면에서 조종 시작 → 조종권 요청 · 남의 실기 관리는 2 차라 까닭 한 줄', () => {
    mount(true, KIM, '#/drive'); serve(KIM, 'r3', 'r7', 'ra');
    expect([...box.querySelectorAll('.dv-card b')].map((b) => b.textContent)).toEqual(['Go2-3', 'Go2-7', 'Go2-A']);
    const card = [...box.querySelectorAll('.dv-card')].find((x) => x.textContent!.includes('Go2-7'))!;
    expect(card.querySelector('[data-why]')).toBeNull();
    expect(card.querySelector('details')).toBeNull();   // 관리(이름 · 끊기 · 지우기)는 2 차
    expect(card.querySelector('[data-admin-later]')!.textContent).toBe(ADMIN_LATER);
    const mine = [...box.querySelectorAll('.dv-card')].find((x) => x.textContent!.includes('Go2-A'))!;
    expect(mine.querySelector('details')).not.toBeNull();
    click([...card.querySelectorAll('button')].find((b) => b.textContent === '연결')!);
    expect(location.hash).toBe('#/drive/r7');
    click(btn('조종 시작')!);
    expect(w.of('lease.take').map((m) => m.robot)).toEqual(['r7']);
    expect(box.textContent).toContain('조종 중(나)');
  });
  it('로봇 연결하기: 총괄도 «새 로봇 추가»', () => {
    mount(true, KIM, '#/drive'); serve(KIM, 'r3', 'r7', 'ra');
    expect($('[data-robot-connect]')).not.toBeNull();
  });
  it('STOP: 실기만 있어도 총괄 폰에 STOP, 누르면 그 실기 정지', () => {
    mount(true, KIM, '#/drive/r7'); serve(KIM, 'r3', 'r7', 'ra');
    expect($('[data-stop]')).not.toBeNull();
    click($('[data-stop]')!);
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7']);
  });
});

describe('운영 관리자는 그대로', () => {
  it('남의 실기에는 조종 · 관리 없음, 새 로봇 추가는 그대로', () => {
    mount(true, LEE, '#/drive', LIST); serve(LEE, 'r3');
    expect([...box.querySelectorAll('.dv-card b')].map((b) => b.textContent)).toEqual(['Go2-3']);
    expect($('[data-admin-later]')).toBeNull();
    expect($('[data-robot-connect]')).not.toBeNull();
  });
});

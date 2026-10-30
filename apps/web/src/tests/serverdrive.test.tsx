// 실기 서버 경유 시험 조종(serverdrive.tsx, 10-30 SERVER-DRIVE-WEB): 서버가 켠 로봇만 패널, 누르는 동안만·떼면 0,
// 초점 잃음·가려짐·끊김 → 0, STOP 우선, 명령 넷 밖 없음. 가짜 WebSocket 이 서버 중재기(drive.test 와 같은 흉내).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { FakeWS, lease, state } from './fakeWs';
import { SD_NOTE, TRIAL } from '../serverdrive';
import { toRobot } from '../fake';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement, w: FakeWS, st: Record<string, ScreenState> = {};
const PARK = { id: 'u-park', name: '박OO' };
const ON = ROBOTS.map((r) => (r.id === 'r7' ? { ...r, serverDrive: true } : r));
function mount(user: string, robots: Robot[] = ON) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/fleet';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === user)} robots={robots} />); });
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => {
  act(() => root?.unmount()); root = null; box?.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  delete (document as { visibilityState?: string }).visibilityState;
});

const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t)!;
const row = (name: string) => [...box.querySelectorAll('[aria-label="로봇 목록"] button')].find((b) => b.textContent!.includes(name))!;
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const key = (type: 'keydown' | 'keyup', code: string) => act(() => { window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true })); });
const ptr = (el: Element, type: string) => act(() => { el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true }), { pointerId: 1 })); });
const push = (r: string, p: Partial<ScreenState> = {}) => { st[r] = { ...(st[r] ?? state(r)), ...p }; w.recv(st[r]); };
function serve(...ids: string[]) {
  w = FakeWS.last; st = {};
  w.auto = (m) => {
    w.recv({ t: 'reply', id: m.id, ok: true });
    const r = m.robot as string;
    if (m.t === 'lease.take') { w.recv(lease(r, PARK, `L${m.id}`)); w.recv({ t: 'lease.result', robot: r, request_id: null, result: 'ACCEPTED' }); }
    if (m.t === 'unlock') push(r, { latched: false });
    if (m.t === 'stop' && st[r]) push(r, { latched: true, stop_gen: st[r].stop_gen! + 1 });
    if (m.t === 'lease.release' || m.t === 'hidden') w.recv(lease(r, null));
  };
  act(() => { w.open(); ids.forEach((id) => push(id)); });
}
const axes = () => w.of('cmd').map((m) => (m.axes as number[]).join());
const lastAxes = () => axes()[axes().length - 1];
const ALLOWED = new Set(['0,0,0', '1,0,0', '1,0,1', '1,0,-1']);
/** 박OO 가 Go2-7(서버 허용) 을 골라 조종 시작 → 잠금 해제 → 중립까지 */
function ready() {
  mount('u-park'); serve('r7');
  click(row('Go2-7'));
  click(btn('조종 시작'));
  click(btn('② 잠금 해제'));
  tick(100);
  expect($('[data-server-drive]')!.textContent).toContain('움직일 수 있음');
}

describe('서버 경유 시험 조종 패널', () => {
  it('서버가 server_drive=true 로 준 실기 로봇에만, 담당 운영자 PC 에만 보인다', () => {
    expect(toRobot({ id: 'x', simulation: false, server_drive: true } as never).serverDrive).toBe(true);
    expect(toRobot({ id: 'x', simulation: false } as never).serverDrive).toBe(false);
    mount('u-park'); serve('r7'); click(row('Go2-7'));
    expect($('[data-server-drive]')!.textContent).toContain(TRIAL);
    expect($('[data-sd-stop]')).not.toBeNull();
    act(() => root!.unmount()); root = null; box.remove();
    mount('u-park', ROBOTS); serve('r7'); click(row('Go2-7'));   // 서버가 켜지 않음 → 보기만
    expect($('[data-server-drive]')).toBeNull();
    act(() => root!.unmount()); root = null; box.remove();
    mount('u-kim'); serve('r3', 'r7', 'r1'); click(row('Go2-7'));   // 총괄 → 보기만
    expect($('[data-server-drive]')).toBeNull();
  });

  it('누르는 동안만 보내고 떼면 바로 0, W/A/D 셋과 0 밖은 보내지 않는다', () => {
    ready();
    const fwd = $('[data-sd-move="fwd"]')!;
    ptr(fwd, 'pointerdown'); tick(100);
    expect(lastAxes()).toBe('1,0,0');
    const n = axes().length;
    ptr(fwd, 'pointerup');
    expect(axes().length).toBe(n + 1); expect(lastAxes()).toBe('0,0,0');   // 뗀 그 자리에서 0 한 번
    tick(200); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'KeyA'); tick(60); expect(lastAxes()).toBe('1,0,1');
    key('keyup', 'KeyA'); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'KeyD'); tick(60); expect(lastAxes()).toBe('1,0,-1');
    key('keyup', 'KeyD');
    for (const c of ['KeyS', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'KeyQ', 'KeyE']) { key('keydown', c); tick(60); expect(lastAxes()).toBe('0,0,0'); key('keyup', c); }
    expect(axes().every((a) => ALLOWED.has(a))).toBe(true);
  });

  it('초점 잃음·가려짐·연결 끊김 → 바로 0 + 안내, 자동 재개 없음', () => {
    ready();
    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toBe('1,0,0');
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(lastAxes()).toBe('0,0,0'); expect($('[data-sd-why]')!.textContent).toBe(SD_NOTE.blur);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', repeat: true, bubbles: true })); });   // 누르고 있던 키의 반복은 되살리지 않는다
    tick(200); expect(lastAxes()).toBe('0,0,0');
    key('keyup', 'KeyW');

    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toBe('1,0,0');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(w.of('hidden').length).toBe(1);   // 조종권 반납(rt) — 그 뒤 cmd 없음
    const n = axes().length; tick(300); expect(axes().length).toBe(n);
    expect($('[data-sd-why]')!.textContent).toBe(SD_NOTE.hidden);
    expect(btn('조종 시작')).toBeTruthy();
  });

  it('연결이 끊기면 0 + 안내, 다시 연결돼도 조종권 없이 시작 단추부터', () => {
    ready();
    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toBe('1,0,0');
    const old = w;
    act(() => { old.drop(1006); });
    expect($('[data-sd-why]')!.textContent).toBe(SD_NOTE.link);
    tick(1000);   // 다시 연결
    serve('r7');
    tick(200);
    expect(w.of('cmd').length).toBe(0);   // 새 연결에서 저절로 보내지 않는다
    expect(btn('조종 시작')).toBeTruthy();
  });

  it('STOP 은 패널에서 가장 크고, 누르면 입력 0 을 먼저 보내고 정지 — 그 뒤 키를 누르고 있어도 0', () => {
    ready();
    const stop = $('[data-sd-stop]')!, fwd = $('[data-sd-move="fwd"]')!;
    expect(parseInt(stop.style.minHeight)).toBeGreaterThan(parseInt(fwd.style.minHeight));
    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toBe('1,0,0');
    click(stop);
    const i = w.sent.findIndex((m) => m.t === 'stop');
    expect(i).toBeGreaterThan(-1);
    expect((w.sent.slice(0, i).filter((m) => m.t === 'cmd').pop()!.axes as number[]).join()).toBe('0,0,0');
    tick(300);
    expect(w.sent.slice(i).filter((m) => m.t === 'cmd').every((m) => (m.axes as number[]).join() === '0,0,0')).toBe(true);
    expect($('[data-sd-lock]')).not.toBeNull();   // 잠금 → «정지 확인 → 해제» 단계
    expect(fwd.hasAttribute('disabled')).toBe(true);
    key('keyup', 'KeyW');
  });

  it('Space(머리줄 STOP)도 입력을 바로 0 으로', () => {
    ready();
    const auto = w.auto!;
    w.auto = (m) => (m.t === 'stop' ? { ok: true } : auto(m));   // 서버 잠금 보고 전에도 화면이 먼저 0
    key('keydown', 'KeyW'); tick(60);
    key('keydown', 'Space');
    expect(w.of('stop').length).toBe(1);
    tick(200);
    expect(lastAxes()).toBe('0,0,0');
  });
});

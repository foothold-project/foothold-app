// 걷기 모드 넷(Classic · Sport · START · AME-2) 칸 + Shift+1~4 (u03 · #525 계약 ScreenGait · GaitState · GaitResult).
// 지금 서버는 gait 를 GAIT_UNSUPPORTED(501)로 거절 · 화면은 받은 척하지 않고 까닭 한 줄. 결과 SUCCEEDED 에서만 «바꿨습니다».
// 움직이는 중 · 입력칸 초점 · 조종권 없음이면 보내지 않음. STOP 은 언제나 먼저. 가짜 WebSocket 은 serverdrive.test · drive.test 와 같은 흉내
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { fleetRow } from './fleetRow';
import { FakeWS, fail, lease, state, type Msg } from './fakeWs';
import { simTune } from '../phone';
import { ServerDrive } from '../serverdrive';
import { GAITS, GAIT_WAIT_MS, gaitWhy } from '../gait';
import { api } from '../api';
import { rt } from '../rt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement, w: FakeWS, st: Record<string, ScreenState> = {};
const PARK = { id: 'u-park', name: '박OO' };
const ON = ROBOTS.map((r) => (r.id === 'r7' ? { ...r, serverDrive: true, approvalUntil: new Date(Date.now() + 30 * 60_000).toISOString() } : r));
const ORG = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
let settingsMock: { mockRestore: () => void };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  settingsMock = vi.spyOn(api, 'settings').mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
});
afterEach(() => {
  act(() => root?.unmount()); settingsMock.mockRestore(); vi.restoreAllMocks(); simTune(null); root = null; box?.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

/** PC: 로봇 탭 + 서버 경유 작은 패널(serverdrive.test 와 같은 붙임) */
function mountPc() {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/fleet';
  box = document.createElement('div'); document.body.append(box);
  const u = USERS.find((x) => x.id === 'u-park')!, side = ON.find((x) => x.id === 'r7')!;
  act(() => { root = createRoot(box); root.render(<><App user={u} robots={ON.map((x) => ({ ...x, serverDrive: false }))} />{<ServerDrive c={{ user: u }} r={side} />}</>); });
}
/** 폰: 조종 화면(서버 경유 실기) */
function mountPhone() {
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/drive/r7';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((x) => x.id === 'u-park')!} robots={ROBOTS.map((r) => ({ ...r, serverDrive: true })) as Robot[]} />); });
}

const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t)!;
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const key = (type: 'keydown' | 'keyup', code: string, shiftKey = false, at: EventTarget = window) =>
  act(() => { at.dispatchEvent(new KeyboardEvent(type, { code, shiftKey, bubbles: true, cancelable: true })); });
const shift = (n: 1 | 2 | 3 | 4, at: EventTarget = window) => { key('keydown', `Digit${n}`, true, at); key('keyup', `Digit${n}`, true, at); };
const push = (r: string, p: Partial<ScreenState> = {}) => { st[r] = { ...(st[r] ?? state(r)), ...p }; act(() => { w.recv(st[r]); }); };
/** 서버 흉내. gait = 'unsupported'(지금 서버: 501 거절) | 'ok'(접수만, 결과는 시험이 state 로) */
let gaitMode: 'unsupported' | 'ok' = 'unsupported';
function serve(sock: FakeWS) {
  w = sock; st = {};
  w.auto = (m: Msg) => {
    const r = m.robot as string;
    if (m.t === 'gait' && gaitMode === 'unsupported') { w.recv({ t: 'reply', id: m.id, ...fail('GAIT_UNSUPPORTED', '걷기 모드 바꾸기는 아직 준비 중입니다.') }); return; }
    w.recv({ t: 'reply', id: m.id, ok: true });
    if (m.t === 'lease.take') { w.recv(lease(r, PARK, `L${m.id}`)); w.recv({ t: 'lease.result', robot: r, request_id: null, result: 'ACCEPTED' }); }
    if (m.t === 'unlock') { st[r] = { ...st[r], latched: false }; w.recv(st[r]); }
    if (m.t === 'stop' && st[r]) { st[r] = { ...st[r], latched: true, stop_gen: st[r].stop_gen! + 1 }; w.recv(st[r]); }
    if (m.t === 'lease.release' || m.t === 'hidden') w.recv(lease(r, null));
  };
  act(() => { w.open(); }); push('r7');
}
const rtSock = () => FakeWS.all.filter((x) => x.url.endsWith('/api/v1/ws')).pop()!;
const AVAIL = { gait: 'classic' as const, available: ['classic', 'start'] as ('classic' | 'start')[] };
/** PC: 박OO 가 Go2-7 조종 시작 → 잠금 해제 → 중립, 모드 보고(지금 Classic · 쓸 수 있음 Classic · START) */
function readyPc(gait: ScreenState['gait'] = AVAIL) {
  mountPc(); serve(rtSock());
  click(fleetRow(box, 'Go2-7'));
  click(btn('조종 시작')); click(btn('② 잠금 해제')); tick(100);
  push('r7', { gait });
  expect($('[data-server-drive]')!.textContent).toContain('움직일 수 있음');
}
const gb = (g: string) => $(`[data-gait="${g}"]`) as HTMLButtonElement;
const msg = () => $('[data-gait-msg]')?.textContent ?? '';
const sent = () => w.of('gait');
const result = (n: string, gait: 'classic' | 'sport' | 'start' | 'ame2', status: 'RUNNING' | 'SUCCEEDED' | 'REJECTED' | 'FAILED', code = '') =>
  push('r7', { gait_result: { request_id: n, gait, status, code, sdk_code: null } });

describe('걷기 모드 칸 (PC 서버 경유 조종)', () => {
  it('조종 중일 때 넷 · 지금 모드 표시 · 못 쓰는 모드는 까닭 한 줄(회색만 아님) · 키 안내에 Shift+1~4', () => {
    mountPc(); serve(rtSock()); click(fleetRow(box, 'Go2-7'));
    expect($('[data-gait-row]')).toBeNull();   // 조종 시작 전
    click(btn('조종 시작')); click(btn('② 잠금 해제')); tick(100); push('r7', { gait: AVAIL });
    expect(GAITS.map((x) => gb(x.g).textContent)).toEqual(['ClassicShift+1', 'SportShift+2', 'STARTShift+3', 'AME-2Shift+4']);
    expect(gb('classic').getAttribute('aria-pressed')).toBe('true');
    expect(gb('start').getAttribute('aria-pressed')).toBe('false');
    expect([gb('sport'), gb('ame2')].map((b) => b.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
    expect($('[data-gait-off]')!.textContent).toContain('Sport · AME-2');
    expect($('[data-gait-off]')!.textContent).toContain('쓸 수 없');
    expect($('[data-gait-row]')!.textContent).toContain('지금 Classic');
    click(gb('sport'));   // 못 쓰는 모드를 눌러도 보내지 않고 까닭
    expect(sent()).toHaveLength(0);
    expect(msg()).toContain('Sport');
    expect(box.textContent).toContain('Shift+1~4');
  });

  it('지금 서버(GAIT_UNSUPPORTED 501): 보냈지만 받은 척하지 않음 · 까닭 한 줄 · 모드 그대로', () => {
    gaitMode = 'unsupported'; readyPc();
    shift(3);
    expect(sent().map((m) => [m.robot, m.gait, typeof m.lease_id])).toEqual([['r7', 'start', 'string']]);
    expect(msg()).toBe(gaitWhy('GAIT_UNSUPPORTED'));
    expect(msg()).not.toContain('바꿨');
    expect(gb('classic').getAttribute('aria-pressed')).toBe('true');
    expect(gb('start').getAttribute('aria-pressed')).toBe('false');
  });

  it('보낸 뒤 결과 전엔 «바꾸는 중», SUCCEEDED 에서만 «바꿨습니다» · 거절은 코드의 다음 할 일 · 모르는 코드도 깨지지 않음', () => {
    gaitMode = 'ok'; readyPc();
    click(gb('start'));
    expect(sent()).toHaveLength(1);
    expect(msg()).toContain('바꾸는 중');
    expect(gb('classic').getAttribute('aria-pressed')).toBe('true');   // 결과 전 바뀜 표시 없음
    const id1 = String(sent()[0].id);
    result('other', 'start', 'SUCCEEDED', 'CONFIRMED');   // 같은 모드 이름이라도 다른 요청의 결과는 내 결과가 아님
    expect(msg()).toContain('바꾸는 중');
    result(id1, 'start', 'RUNNING', 'STARTED');
    expect(msg()).toContain('바꾸는 중'); expect(msg()).not.toContain('바꿨');
    shift(3); expect(sent()).toHaveLength(1);   // 바꾸는 중에는 또 보내지 않음
    push('r7', { gait: { gait: 'start', available: ['classic', 'start'] } }); result(id1, 'start', 'SUCCEEDED', 'CONFIRMED');
    expect(msg()).toBe('START 모드로 바꿨습니다.');
    expect(gb('start').getAttribute('aria-pressed')).toBe('true');
    click(gb('classic'));
    result(String(sent()[1].id), 'classic', 'REJECTED', 'GAIT_MOVING');
    expect(msg()).toBe(gaitWhy('GAIT_MOVING'));
    expect(msg()).toContain('멈춘 뒤');
    expect(gb('start').getAttribute('aria-pressed')).toBe('true');
    click(gb('classic'));
    result(String(sent()[2].id), 'classic', 'FAILED', 'GAIT_SOMETHING_NEW');
    expect(msg()).toContain('GAIT_SOMETHING_NEW');
  });

  it('결과가 20 초 안에 안 오면 «결과를 받지 못함» 으로 풀림', () => {
    gaitMode = 'ok'; readyPc();
    shift(3); expect(msg()).toContain('바꾸는 중');
    tick(GAIT_WAIT_MS);
    expect(msg()).toContain('결과를 받지 못했습니다');
    shift(3); expect(sent()).toHaveLength(2);
  });

  it('움직이는 중(입력 0 아님)에는 보내지 않고 까닭 한 줄 · 떼면 보냄', () => {
    gaitMode = 'ok'; readyPc();
    key('keydown', 'ArrowUp'); tick(60);
    shift(3);
    expect(sent()).toHaveLength(0);
    expect(msg()).toBe(gaitWhy('GAIT_MOVING'));
    key('keyup', 'ArrowUp'); tick(60);
    shift(3);
    expect(sent().map((m) => m.gait)).toEqual(['start']);
  });

  it('입력칸 초점이면 Shift+1~4 무시(#533 규칙과 같게)', () => {
    gaitMode = 'ok'; readyPc();
    const inp = document.createElement('input'); box.append(inp); inp.focus();
    shift(3, inp);
    expect(sent()).toHaveLength(0);
    expect(msg()).toBe('');
  });

  it('Shift 없는 숫자 키 · Ctrl+Shift 는 모드 키가 아님', () => {
    gaitMode = 'ok'; readyPc();
    key('keydown', 'Digit3'); key('keyup', 'Digit3');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(sent()).toHaveLength(0);
  });

  // 검토 3: STOP 을 보낸 뒤 로봇의 잠금 보고(state latched · 새 stop_gen)가 오기 전 틈에도 모드 키는 나가지 않는다
  it('STOP 직후 잠금 보고 전에 Shift+2 를 눌러도 보내지 않음 · 잠금 해제 뒤에는 다시 보냄', () => {
    gaitMode = 'ok'; readyPc({ gait: 'classic', available: ['classic', 'sport', 'start'] });
    const prev = w.auto!;
    w.auto = (m: Msg) => { if (m.t === 'stop') { w.recv({ t: 'reply', id: m.id, ok: true }); return; } prev(m); };   // 서버는 받았지만 로봇 잠금 보고는 아직
    key('keydown', 'Space'); key('keyup', 'Space');
    expect(w.of('stop')).toHaveLength(1);
    shift(2);
    expect(sent()).toHaveLength(0);
    expect(msg()).toContain('정지');
    push('r7', { latched: true, stop_gen: st.r7.stop_gen! + 1 });   // 로봇 잠금 보고
    shift(2); expect(sent()).toHaveLength(0);
    w.auto = prev;
    click(btn('② 잠금 해제')); tick(100);
    shift(2);
    expect(sent().map((m) => m.gait)).toEqual(['sport']);
  });

  // reviewer G1: 잠금 중 · 서버 끊김 검사가 각각 따로 지켜지는지
  it('정지 잠금 중(latched)이면 보내지 않고 까닭 한 줄', () => {
    gaitMode = 'ok'; readyPc();
    push('r7', { latched: true });
    shift(3);
    expect(sent()).toHaveLength(0);
    expect(msg()).toBe(gaitWhy('GAIT_LATCHED'));
  });
  // 실제로 소켓이 닫히면 rt 가 조종권부터 비워 «조종 시작 뒤» 가 먼저 나온다. 이 검사는 조종권이 남은 채 link 가 open 이 아닌 틈을 막는 두 번째 겹 · rt.link 를 바꿔 따로 본다
  it('서버 연결이 open 이 아니면(link · 조종권은 남음) 보내지 않고 까닭 한 줄', () => {
    gaitMode = 'ok'; readyPc();
    vi.spyOn(rt, 'link').mockReturnValue({ at: 'lost' });
    push('r7', { latency_ms: 41 });   // 다른 값으로 다시 그림(같은 state 는 rt 가 거른다)
    shift(3);
    expect(sent()).toHaveLength(0);
    expect(msg()).toBe('서버 연결이 끊겨 바꿀 수 없습니다.');
  });
  // reviewer G2: 키를 누르고 있어 생긴 반복(e.repeat)은 새 누름이 아님
  it('PC: 키 반복(e.repeat) Shift+3 은 보내지 않음', () => {
    gaitMode = 'ok'; readyPc();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', shiftKey: true, repeat: true, bubbles: true, cancelable: true })); });
    expect(sent()).toHaveLength(0);
  });

  it('조종권 없이는 보내지 않음(rt.gait 도)', () => {
    gaitMode = 'ok'; mountPc(); serve(rtSock()); click(fleetRow(box, 'Go2-7')); push('r7', { gait: AVAIL });
    shift(3);
    expect(sent()).toHaveLength(0);
    const why: (string | null)[] = [];
    act(() => rt.gait('r7', 'start', (bad) => why.push(bad)));
    expect(sent()).toHaveLength(0);
    expect(why).toHaveLength(1); expect(why[0]).toBeTruthy();
  });

  it('STOP 은 언제나 먼저: 바꾸는 중에도 Space · STOP 단추가 정지를 보낸다', () => {
    gaitMode = 'ok'; readyPc();
    shift(3); expect(msg()).toContain('바꾸는 중');
    const stop = $('[data-sd-stop="panel"]') as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    key('keydown', 'Space'); key('keyup', 'Space');
    expect(w.of('stop').length).toBeGreaterThanOrEqual(1);
    expect(msg()).not.toContain('바꾸는 중');
  });
});

describe('걷기 모드 칸 (폰 조종)', () => {
  it('«정책» 시트에 넷 · Shift+1~4 로 보냄 · 입력칸 초점이면 무시', () => {
    gaitMode = 'ok'; mountPhone(); serve(FakeWS.last);
    click(btn('조종')); click(btn('다시 시작')); click(document.querySelector('[data-restart-ask] button.dpri')!); tick(100);
    push('r7', { gait: AVAIL });
    click(btn('정책'));
    expect(GAITS.map((x) => !!gb(x.g))).toEqual([true, true, true, true]);
    const inp = document.createElement('input'); box.append(inp); inp.focus();
    shift(3, inp); expect(sent()).toHaveLength(0);   // START 는 쓸 수 있는 모드 · 막힌 까닭은 초점뿐
    inp.remove();
    shift(3);
    expect(sent().map((m) => m.gait)).toEqual(['start']);
    expect(msg()).toContain('바꾸는 중');
  });
  it('키 반복(e.repeat) Shift+3 은 보내지 않음 · 새로 누르면 보냄 (reviewer G2)', () => {
    gaitMode = 'ok'; mountPhone(); serve(FakeWS.last);
    click(btn('조종')); click(btn('다시 시작')); click(document.querySelector('[data-restart-ask] button.dpri')!); tick(100);
    push('r7', { gait: AVAIL });
    click(btn('정책'));
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', shiftKey: true, repeat: true, bubbles: true, cancelable: true })); });
    expect(sent()).toHaveLength(0);
    shift(3);
    expect(sent().map((m) => m.gait)).toEqual(['start']);
  });
});

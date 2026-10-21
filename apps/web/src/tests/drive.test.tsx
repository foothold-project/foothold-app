// 조종 탭(02 F-TO-01~05)·STOP(F-COM-01)·실시간 연결(05 §9) — 가짜 WebSocket(fakeWs.ts)이 서버 중재기 역할.
// 판정(조종권·넘김·정지 확인)은 서버 몫이라, 여기서는 화면이 보내는 것(sent)과 서버 값을 그대로 보이는지를 본다. 시간은 가짜 시계.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App, PHONE_Q } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { tabFromHash } from '../menu';
import { api, onAuthLost as setAuthLost } from '../api';
import { COOLDOWN_S, FAIL_TEXT, FREE_TEXT, REQUEST_S, STOP_HTTP_MS, STOP_WS_MS, rt } from '../rt';
import { FakeWS, fail, lease, state } from './fakeWs';
import driveCss from '../drive.css?raw';
import frameCss from '../frame.css?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
/** robots = 서버 /robots 응답(기본 = 가짜 3대 전부). 붙이면 rt.connect → 가짜 WebSocket 하나(아직 안 열림) */
function mount(phone: boolean, user: string, hash: string, robots: Robot[] = ROBOTS) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === user)} robots={robots} />); });
}
// 판정은 단조 시계(performance.now): advanceTimersByTime 은 그것도 움직이고, setSystemTime(벽시계)은 움직이지 않는다
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => {
  act(() => root?.unmount()); root = null; box?.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  delete (document as { visibilityState?: string }).visibilityState;
});

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t)!;
const text = () => box.textContent!;
const band = () => $('[data-band]').textContent!;
/** 폰 로봇 연결의 로봇 카드, PC 로봇 탭 목록의 행 */
const card = (name: string) => [...box.querySelectorAll('.dv-card')].find((li) => li.textContent!.includes(name))!;
const row = (name: string) => [...box.querySelectorAll('[aria-label="로봇 목록"] button')].find((b) => b.textContent!.includes(name))!;
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const key = (type: 'keydown' | 'keyup', code: string, at: EventTarget = window, ctrlKey = false) =>
  act(() => { at.dispatchEvent(new KeyboardEvent(type, { code, ctrlKey, bubbles: true, cancelable: true })); });
/** detail 0 = 키보드로 생긴 click, 1 = 마우스·터치 */
const clickWith = (el: Element, detail: number) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); });
const hide = () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};

const PARK = { id: 'u-park', name: '박OO' }, KIM = { id: 'u-kim', name: '김OO' }, LEE = { id: 'u-lee', name: '이OO' };
let w: FakeWS, st: Record<string, ScreenState> = {};
/** 서버가 robot 상태를 보냄(앞 값 위에 덮음) */
const push = (r: string, p: Partial<ScreenState> = {}) => { st[r] = { ...(st[r] ?? state(r)), ...p }; w.recv(st[r]); };
const recv = (m: object) => act(() => { w.recv(m); });
/** 서버 흉내: 연결을 열고 ids 상태를 보낸다. 모든 요청에 ok, take → 내 lease + 결과 ACCEPTED(정지 확인은 끝난 것으로), unlock → 풀림,
 *  stop → 잠금·stop_gen+1, release·hidden → 빔 */
function serve(me: { id: string; name: string }, ...ids: string[]) {
  w = FakeWS.last; st = {};
  w.auto = (m) => {
    w.recv({ t: 'reply', id: m.id, ok: true });
    const r = m.robot as string;
    if (m.t === 'lease.take') { w.recv(lease(r, me, `L${m.id}`)); w.recv({ t: 'lease.result', robot: r, request_id: null, result: 'ACCEPTED' }); }
    if (m.t === 'unlock') push(r, { latched: false });
    if (m.t === 'stop' && st[r]) push(r, { latched: true, stop_gen: st[r].stop_gen! + 1 });
    if (m.t === 'lease.release' || m.t === 'hidden') w.recv(lease(r, null));
  };
  act(() => { w.open(); ids.forEach((id) => push(id)); });
}
const cmds = () => w.of('cmd');
const end = <T,>(a: T[]) => a[a.length - 1];
const lastAxes = () => end(cmds())?.axes;
const ask = (from = KIM, role = 'ORG_ADMIN') => ({ t: 'lease.requested', robot: 'r7', request_id: 'q1', requester: { display_name: from.name, role }, expires_at: new Date(Date.now() + REQUEST_S * 1000).toISOString() });
/** 조종권 받고 잠금 해제·중립까지(움직일 수 있음) */
function ready() {
  click(btn('조종 시작'));
  click(btn('잠금 해제'));
  tick(100);
  expect(text()).toContain('움직일 수 있음');
}

describe('조종 화면', () => {
  it('주소 #/drive/<로봇> 은 폰 조종, PC 에는 조종 탭이 없어 로봇 탭', () => {
    expect(tabFromHash('#/drive/r7', true)).toBe('drive');
    expect(tabFromHash('#/drive/r7', false)).toBe('fleet');
  });

  it('폰 누름 수: 로봇 연결 → [연결] → 조종 시작 = 조종권(2), + 잠금 해제 = 움직일 수 있음(3). 입력은 lease_id·늘어나는 seq·50 ms', () => {
    mount(true, 'u-kim', '#/drive');
    serve(KIM, 'r3', 'r7', 'r1');
    click(card('Go2-7').querySelector('button')!);
    expect(location.hash).toBe('#/drive/r7');
    click(btn('조종 시작'));
    expect(w.of('lease.take')).toMatchObject([{ robot: 'r7', proto: 'fh-rt/1' }]);
    expect(text()).toContain('조종 중(나)');
    expect(text()).toContain('정지 잠금');
    expect(text()).toContain('조종권을 받았습니다');   // 내 take 의 ACCEPTED 를 «넘겼습니다»로 읽지 않음
    expect(text()).not.toContain('넘겼습니다');
    tick(200);
    expect(cmds().length).toBeGreaterThan(0);
    expect(cmds().every((m) => String(m.axes) === '0,0,0')).toBe(true);   // 잠금 중은 0
    click(btn('잠금 해제'));
    expect(w.of('unlock')).toMatchObject([{ robot: 'r7', lease_id: cmds()[0].lease_id, stop_gen: 1 }]);
    tick(100);
    expect(text()).toContain('움직일 수 있음');
    key('keydown', 'KeyW'); key('keydown', 'KeyA');   // 동시 입력 두 곳
    const n = cmds().length;
    tick(1000);
    expect(cmds().length - n).toBe(1000 / 50);
    expect(lastAxes()).toEqual([1, 0, 1]);
    const seq = cmds().map((m) => m.seq as number);
    expect(seq.every((s, i) => i === 0 || s > seq[i - 1])).toBe(true);
    act(() => push('r7', { speed: 0.6 }));
    expect(text()).toContain('0.6 m/s');                   // 속도는 서버 state 값
    key('keyup', 'KeyW'); key('keyup', 'KeyA'); tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);
    click(btn('조종 끝내기'));
    expect(w.of('lease.release')).toHaveLength(1);
    expect(text()).toContain('조종하는 사람 없음');
  });

  it('폰 #/drive = 로봇 연결: 로봇 카드(상태·배터리·조종권자) → [연결]', () => {
    mount(true, 'u-kim', '#/drive');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    expect($('main').getAttribute('aria-label')).toBe('로봇 연결');
    expect(text()).toContain('박OO님 조종 중');
    click(btn('연결'));
    expect(location.hash).toBe('#/drive/r3');
  });

  it('잠금 해제 전 입력은 0, 키를 누른 채 해제하면 떼야(중립) 움직임, 후진은 막음', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종 시작'));
    key('keydown', 'ArrowUp'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    click(btn('잠금 해제')); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'ArrowUp'); tick(100);
    expect(text()).toContain('움직일 수 있음');
    key('keydown', 'ArrowUp'); tick(100);
    expect(lastAxes()).toEqual([1, 0, 0]);
    key('keyup', 'ArrowUp'); key('keydown', 'KeyS'); tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).toContain('후진은 아직 지원하지 않습니다');
  });

  it('lease 가 바뀌면 이전 입력은 버리고 새 중립부터(누른 채여도 0)', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    key('keydown', 'KeyW'); tick(100);
    const old = end(cmds())!;
    expect(old.axes).toEqual([1, 0, 0]);
    recv(lease('r7', PARK, 'L-new'));                      // 서버가 새 조종권을 줌(다른 lease)
    const n = cmds().length;
    tick(300);
    expect(cmds().length).toBeGreaterThan(n);
    expect(cmds().slice(n).every((m) => m.lease_id === 'L-new' && String(m.axes) === '0,0,0')).toBe(true);
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'KeyW'); tick(100); key('keydown', 'KeyW'); tick(100);
    expect(end(cmds())).toMatchObject({ lease_id: 'L-new', axes: [1, 0, 0] });
    expect((end(cmds())!.seq as number) > (old.seq as number)).toBe(true);
  });

  it('Space 는 바로 STOP(조종 중에도), 띠는 서버 접수 → 로봇 보고(잠금·출력 0) 순서로만', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    w.auto = () => ({ ok: true });                         // 이번엔 정지 뒤 state 를 손으로 보낸다
    key('keydown', 'Space');
    expect(w.of('stop')).toMatchObject([{ robot: 'r7' }]);   // 타이머 없이 바로
    expect(band()).toContain('Go2-7 정지 요청됨 — 서버가 받았습니다. 로봇 확인을 기다립니다.');
    tick(100);
    act(() => push('r7', { latched: true, stop_gen: 2, applied: [0.4, 0, 0] }));
    expect(band()).toContain('정지 잠금 — 출력이 아직 멈추지 않았습니다');
    act(() => push('r7', { applied: [0, 0, 0] }));
    expect(band()).toContain('Go2-7 정지 잠금 — 로봇이 잠금과 멈춤 출력을 알렸습니다.');
    const n = cmds().length;
    key('keydown', 'KeyW'); tick(200);
    expect(cmds().slice(n).every((m) => String(m.axes) === '0,0,0')).toBe(true);   // 잠긴 뒤 입력은 0
  });

  it('STOP 답이 거부면 «보내지 못함», 성공처럼 보이지 않는다', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    w.auto = (m) => (m.t === 'stop' ? fail('ROBOT_OFFLINE') : { ok: true });
    click($('[data-stop]'));
    expect(band()).toContain('Go2-7 정지 요청을 보내지 못했습니다.');
    expect(band()).not.toContain('정지 요청됨');
  });

  it('화면을 숨기면 hidden(정지·잠금·반납) 후 입력 0건, 탭을 떠나도 반납', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1, 0, 0]);
    hide();
    expect(w.of('hidden')).toMatchObject([{ robot: 'r7' }]);
    const n = cmds().length;
    tick(500);
    expect(cmds().length).toBe(n);
    delete (document as { visibilityState?: string }).visibilityState;
    key('keyup', 'KeyW');
    click(btn('조종 시작'));
    expect(text()).toContain('조종 중(나)');
    click(btn('기록'));                                    // ⋯ 기록 — 조종 화면을 떠남
    expect(location.hash).toBe('#/history');
    expect(w.of('hidden')).toHaveLength(2);
  });

  it('요청이 시간 초과로 끝난 뒤(«계속 조종합니다») 화면을 숨겨 반납하면 그 안내를 지운다', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    recv(ask());
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'TIMEOUT' });
    expect(text()).toContain('계속 조종합니다');
    hide();
    expect(w.of('hidden')).toHaveLength(1);
    expect(text()).not.toContain('계속 조종합니다');
    expect(btn('조종 시작')).toBeTruthy();
  });

  it('요청 창: Enter·Space·키보드 click 은 넘기기를 누르지 않고, Space 는 STOP, 방향키는 조종 — 마우스로만 넘김', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    recv(ask());
    expect($('[role="dialog"]').textContent).toContain('총괄 김OO님이 Go2-7 조종권을 요청했습니다. 넘겨주시겠습니까?');
    const give = $('[data-ask="give"]');
    give.focus();
    key('keydown', 'ArrowUp', give); tick(100);
    expect(lastAxes()).toEqual([1, 0, 0]);                 // 방향키는 계속 조종
    key('keyup', 'ArrowUp', give);
    key('keydown', 'Enter', give); key('keyup', 'Enter', give);
    clickWith(give, 0);                                     // Enter 가 만든 click
    expect(w.of('lease.respond')).toHaveLength(0);
    key('keydown', 'Space', give); key('keyup', 'Space', give);
    expect([w.of('stop').length, w.of('lease.respond').length]).toEqual([1, 0]);   // STOP 만, 넘기지 않음
    clickWith(give, 1);
    expect(w.of('lease.respond')).toMatchObject([{ robot: 'r7', request_id: 'q1', accept: true }]);
  });

  it('넘기는 중 입력 0(키를 누르고 있어도) → 서버가 넘기면 «넘겼습니다·보는 중»', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1, 0, 0]);
    recv(ask());
    clickWith($('[data-ask="give"]'), 1);
    const n = cmds().length;
    tick(300);
    expect(cmds().length).toBeGreaterThan(n);
    expect(cmds().slice(n).every((m) => String(m.axes) === '0,0,0')).toBe(true);
    expect($('.lv-chip').textContent).toContain('정지 확인 중');
    recv(lease('r7', null));                               // 서버: 옛 조종권 회수 → 정지 확인 → 새 조종권자
    expect(text()).toContain('조종권 넘기는 중');
    recv(lease('r7', KIM));
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'ACCEPTED' });
    expect(text()).toContain('조종권을 넘겼습니다. 보는 중입니다.');
    expect(text()).toContain('김OO님 조종 중');
    const m = cmds().length;
    tick(300);
    expect(cmds().length).toBe(m);
  });

  it(`내게 온 요청 창은 ${REQUEST_S} s 에 닫힘(벽시계를 돌려도 경과 시간으로), 거절은 respond false`, () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종 시작'));
    recv(ask());
    vi.setSystemTime(Date.now() + 60_000);                 // 벽시계 점프 — 창은 그대로
    tick(REQUEST_S * 1000 - 200);
    expect(box.querySelector('[role="dialog"]')).not.toBeNull();
    tick(200);
    expect(box.querySelector('[role="dialog"]')).toBeNull();
    recv(ask());
    clickWith($('[data-ask="keep"]'), 1);
    expect(w.of('lease.respond')).toMatchObject([{ request_id: 'q1', accept: false }]);
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'DECLINED' });
    expect(text()).toContain('조종 중(나)');
  });

  it(`요청자: 남은 ${REQUEST_S}초 → 자동 거절 → ${COOLDOWN_S}초 재요청 제한 → 다시 가능, 서버 제한 오류는 문구로`, () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    click(btn('조종 시작'));
    expect(w.of('lease.request')).toMatchObject([{ robot: 'r7' }]);   // 남이 조종 중이면 요청
    expect(w.of('lease.take')).toHaveLength(0);
    expect(text()).toContain('박OO님에게 요청했습니다. (10초)');
    expect(btn('조종 시작').disabled).toBe(true);
    tick(3000);
    expect(text()).toContain('(7초)');
    tick(7000);
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'TIMEOUT' });
    expect(text()).toContain('응답이 없어 요청이 끝났습니다.');
    expect(text()).toContain('30초 뒤 다시 요청할 수 있습니다.');
    tick(29_000);
    expect(btn('조종 시작').disabled).toBe(true);
    tick(1000);
    expect(btn('조종 시작').disabled).toBe(false);
    w.auto = (m) => (m.t === 'lease.request' ? fail('LEASE_REQUEST_COOLDOWN', 'cooldown') : { ok: true });
    click(btn('조종 시작'));
    expect(text()).toContain('요청이 거절·시간 초과·취소로 끝난 뒤 30초 안에는 다시 요청할 수 없습니다. 잠시 뒤 다시 누르세요.');
    expect(text()).not.toContain('cooldown');
  });

  it('요청자: 수락 → «정지 확인 뒤 받습니다» → 내 lease 는 잠금 상태로 시작', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    act(() => push('r7', { latched: false }));
    recv(lease('r7', PARK));
    click(btn('조종 시작'));
    recv(lease('r7', null));
    expect(text()).toContain('로봇 정지를 확인한 뒤 조종권을 받습니다.');
    act(() => push('r7', { latched: true, stop_gen: 2 }));
    recv(lease('r7', KIM, 'L-kim'));
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'ACCEPTED' });
    expect(text()).toContain('조종권을 받았습니다. 잠금 해제 후 조종하세요.');
    expect($('.lv-chip').textContent).toContain('정지 잠금');
    click(btn('잠금 해제'));
    expect(w.of('unlock')).toMatchObject([{ lease_id: 'L-kim', stop_gen: 2 }]);
  });

  it('넘김 실패(정지 확인 실패): «정지 잠금»이 아니라 «정지 확인 실패» + 할 일', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    act(() => push('r7', { latched: false }));
    recv(lease('r7', PARK));
    click(btn('조종 시작'));
    recv(lease('r7', null));
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'CANCELED', error: 'STOP_CONFIRM_FAILED' });
    expect($('.lv-chip').textContent).toContain('정지 확인 실패');
    expect(text()).toContain(FAIL_TEXT);
    expect(btn('조종 시작').disabled).toBe(false);
  });

  it('조종권 비워짐 알림이 요청자 화면에', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    click(btn('조종 시작'));
    recv(lease('r7', null));
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'CANCELED' });
    expect(text()).toContain(FREE_TEXT);
    expect(btn('조종 시작').disabled).toBe(false);
  });

  it('운영 관리자가 PC 로봇 탭에서 남의 로봇: 구독 안 함 + 조종 단추 없음(실시간 조종은 폰만), STOP 은 서버로 간다', () => {
    mount(false, 'u-lee', '#/fleet');
    serve(LEE, 'r3', 'r1');
    expect(w.of('sub')).toMatchObject([{ robots: ['r3', 'r1'], streams: ['state'] }]);   // 남의 로봇을 구독하면 서버가 연결을 닫는다(4403)
    click(row('Go2-7'));
    expect([...box.querySelectorAll('button')].filter((b) => /조종/.test(b.textContent!))).toEqual([]);
    expect($('[aria-label="조종"]')).toBeNull();
    click($('[data-stop]'));
    expect(w.of('stop')).toMatchObject([{ robot: 'r7' }]);
    expect(band()).toContain('Go2-7 정지 요청됨');
    expect(w.of('lease.take')).toHaveLength(0);
  });

  it('시나리오 실행 중 조종 시작 → «일시정지됩니다» 확인 → 받기', () => {
    mount(true, 'u-lee', '#/drive/r3');
    serve(LEE, 'r3', 'r1');
    recv(lease('r3', { id: null, name: '', type: 'RUN' }));
    expect(text()).toContain('시나리오 실행 중');
    expect(text()).toContain('시나리오: 2층 순찰 3/5');
    click(btn('조종 시작'));
    expect(w.of('lease.take')).toHaveLength(0);
    expect($('[role="dialog"]').textContent).toContain('시나리오가 일시정지됩니다');
    click(btn('일시정지하고 조종'));
    expect(w.of('lease.take')).toMatchObject([{ robot: 'r3' }]);
  });

  it('폰 조종 화면: 왼쪽 전후·오른쪽 회전 조이스틱, STOP 64px 머리줄 오른쪽 끝', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    expect($('header').lastElementChild).toBe($('[data-stop]'));
    expect(parseInt($('[data-stop]').style.minHeight)).toBeGreaterThanOrEqual(64);
    ready();
    const fwd = $('[aria-label="전후 조이스틱"]'), turn = $('[aria-label="회전 조이스틱"]');
    expect([fwd.className, turn.className]).toEqual(['dv-stick v', 'dv-stick h']);
    for (const el of [fwd, turn]) el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    act(() => { fwd.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 30 })); });
    act(() => { turn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 60 })); });
    tick(100);
    expect(lastAxes()).toEqual([0.5, 0, 1]);               // 위로 반 = 전진 0.5, 왼쪽 끝 = 왼쪽 회전
    act(() => { fwd.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); turn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); });
    tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);
  });
});

// [B3] PC 로봇 목록 «마지막 수신» = 상태를 받은 시각(다시 그린 시각 아님)
describe('마지막 수신 시각', () => {
  const seen = (name: string) => row(name).querySelector('[data-seen]')!.textContent;
  it('누르기·시간 흐름만으로는 안 바뀌고 새 상태가 와야 바뀜, 상태 없는 로봇은 목록 받은 시각', () => {
    vi.setSystemTime(new Date(2026, 9, 21, 13, 40, 5));
    mount(false, 'u-kim', '#/fleet', ROBOTS.map((r) => ({ ...r, listedAt: '13:40:05' })));   // 서버 목록을 받은 시각(toRobot 이 붙임)
    tick(2000);                                            // 2 s 뒤 연결
    serve(KIM, 'r7');
    expect(seen('Go2-7')).toBe('마지막 수신 13:40:07');
    expect(seen('Go2-3')).toBe('마지막 수신 13:40:05');      // 실시간 상태를 아직 못 받음 → 목록 받은 시각
    tick(5000);
    click(row('Go2-3'));                                   // 다시 그리기만
    expect(seen('Go2-7')).toBe('마지막 수신 13:40:07');
    act(() => push('r7', { speed: 0.3 }));
    expect(seen('Go2-7')).toBe('마지막 수신 13:40:12');
    tick(3000);
    click(row('Go2-7'));
    expect(seen('Go2-7')).toBe('마지막 수신 13:40:12');
  });
});

describe('실시간 연결(05 §9)', () => {
  it('3 s 동안 아무것도 못 받으면 «연결 끊김» + 로봇 상태 모름 + 조종 불가, 1 s 마다 ping', () => {
    mount(true, 'u-kim', '#/drive');
    serve(KIM, 'r3', 'r7', 'r1');
    w.auto = null;                                         // 서버가 말이 없어짐
    tick(2750);
    expect($('header [data-link]')).toBeNull();
    expect(w.of('ping').length).toBe(2);
    tick(250);
    expect($('header [data-link]').textContent).toContain('연결 끊김');
    expect(band()).toContain('서버 연결이 끊겼습니다. 로봇 상태를 알 수 없습니다.');
    expect($('[aria-label="내 로봇"]').textContent).toContain('상태 모름');
    expect(card('Go2-3').querySelector('button')!.textContent).toBe('보기만');
    expect(card('Go2-3').querySelector('[data-why]')!.textContent).toContain('서버 연결이 끊겨 조종할 수 없습니다');
    tick(1000);
    expect(FakeWS.all).toHaveLength(2);                    // 다시 연결 시도
  });

  it('4403: 다시 연결하지 않고 이유를 보임, [다시 연결]은 사람이 누를 때만', () => {
    mount(false, 'u-kim', '#/fleet');
    serve(KIM, 'r3', 'r7', 'r1');
    act(() => w.drop(4403));
    expect($('header [data-link]').textContent).toContain('연결 거부');
    expect(band()).toContain('서버가 실시간 연결을 거부했습니다(권한 없음)');
    tick(60_000);
    expect(FakeWS.all).toHaveLength(1);
    click(btn('다시 연결'));
    expect(FakeWS.all).toHaveLength(2);
  });

  for (const code of [1013, 1012]) it(`${code}: 끊김이 이어져도(늘림 없이) 1 s 뒤 다시 연결, 열리면 다시 구독`, () => {
    mount(false, 'u-kim', '#/fleet');
    serve(KIM, 'r3', 'r7', 'r1');
    act(() => w.drop(1006));
    tick(1000);
    act(() => FakeWS.last.drop(code));                     // 열리기 전에 또 끊김 — 1006 이면 2 s 지만 1013·1012 는 1 s
    expect($('header [data-link]').textContent).toContain('연결 끊김');
    tick(999);
    expect(FakeWS.all).toHaveLength(2);
    tick(1);
    expect(FakeWS.all).toHaveLength(3);
    serve(KIM, 'r3', 'r7', 'r1');
    expect(w.of('sub')).toHaveLength(1);
    expect($('header [data-link]')).toBeNull();
  });

  it('그 밖의 끊김은 1·2 s… 늘려 다시 연결', () => {
    mount(false, 'u-kim', '#/fleet');
    serve(KIM, 'r3', 'r7', 'r1');
    act(() => w.drop(1006));
    tick(1000);
    expect(FakeWS.all).toHaveLength(2);
    act(() => FakeWS.last.drop(1006));
    tick(1999);
    expect(FakeWS.all).toHaveLength(2);
    tick(1);
    expect(FakeWS.all).toHaveLength(3);
  });

  it('끊기면 쥔 조종권·입력도 끝(연결에 묶임)', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    key('keydown', 'KeyW'); tick(100);
    act(() => w.drop(1006));
    expect(text()).not.toContain('조종 중(나)');
    expect(btn('조종 시작').disabled).toBe(true);
    const n = cmds().length;
    tick(500);
    expect(cmds().length).toBe(n);
  });

  describe('STOP 은 끊김 중에도 거짓 성공을 보이지 않는다', () => {
    const down = () => { mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); act(() => w.drop(1006)); };
    const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    it('[F1] 대체 경로(HTTP)의 응답을 못 받음(처리 뒤 연결만 끊겼을 수 있음) → «접수 확인 못함·현장에서 직접», 보내지 못했다고 단정 안 함', async () => {
      down();
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
      click($('[data-stop]'));
      expect(band()).toContain('Go2-7 정지 요청을 보내는 중입니다.');
      await settle();
      expect(band()).toContain('Go2-7 정지 요청을 보냈지만 서버 접수를 확인하지 못했습니다.');
      expect(band()).toContain('현장에서 로봇을 직접 멈추세요');
      expect(band()).not.toContain('보내지 못했습니다');
      expect(band()).not.toMatch(/정지 요청됨|정지 잠금/);
      expect(w.of('stop')).toHaveLength(0);
    });
    it('[F1] 서버가 대체 경로 STOP 을 명시적으로 거절(4xx) → «보내지 못했습니다»와 서버 문구', async () => {
      down();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: '이 로봇의 권한이 없습니다.', detail: {} } }), { status: 403 })));
      click($('[data-stop]'));
      await settle();
      expect(band()).toContain('Go2-7 정지 요청을 보내지 못했습니다. 이 로봇의 권한이 없습니다.');
      expect(band()).toContain('현장에서 로봇을 직접 멈추세요');
    });
    const notOurs: [string, number, string | null][] = [
      ['프록시 502(HTML)', 502, '<html>Bad Gateway</html>'], ['게이트웨이 504(본문 없음)', 504, null], ['503(본문 없음)', 503, null],
      ['500(서버 오류 본문이어도 처리 여부 모름)', 500, JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '서버 오류', detail: {} } })],
      ['400 본문 없음', 400, null], ['409 형식 다른 본문', 409, JSON.stringify({ detail: 'conflict' })],
    ];
    for (const [name, status, body] of notOurs) it(`[G1] 대체 경로 ${name} → 명시적 거절 아님 «접수 확인 못함·현장에서 직접»`, async () => {
      down();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
      click($('[data-stop]'));
      await settle();
      expect(band()).toContain('Go2-7 정지 요청을 보냈지만 서버 접수를 확인하지 못했습니다.');
      expect(band()).toContain('현장에서 로봇을 직접 멈추세요');
      expect(band()).not.toContain('보내지 못했습니다');
    });
    it('대체 경로 접수(202) → «정지 요청됨(대체 경로)·확인은 보이지 않음», 정지 잠금이라 하지 않음', async () => {
      down();
      const f = vi.fn(async () => new Response(null, { status: 202 }));
      vi.stubGlobal('fetch', f);
      click($('[data-stop]'));
      await settle();
      expect(f).toHaveBeenCalledWith('/api/v1/robots/r7/stop', expect.objectContaining({ method: 'POST' }));
      expect(band()).toContain('Go2-7 정지 요청됨(대체 경로) — 실시간 연결이 끊겨 로봇 확인은 보이지 않습니다.');
      expect(band()).not.toContain('정지 잠금');
    });
  });
});

// ── PR #7 검토 B 재현·조정 결정 R2 중 화면 쪽 규칙(판정 규칙은 서버 중재기 시험이 맡는다)
describe('화면 안전 규칙', () => {
  it('[B3] 요청자 화면이 숨겨진 뒤 넘겨받은 조종권은 바로 반납', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    click(btn('조종 시작'));
    hide();
    recv(lease('r7', null));
    recv(lease('r7', KIM, 'L-late'));
    expect(w.of('hidden')).toMatchObject([{ robot: 'r7' }]);
    tick(200);
    expect(cmds()).toHaveLength(0);
  });
  it('떠난 화면(탭 이동)에 늦게 온 조종권도 바로 반납', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    click(btn('조종 시작'));
    click(btn('끝내기'));
    expect(location.hash).toBe('#/drive');
    recv(lease('r7', KIM, 'L-late'));
    expect(w.of('hidden')).toMatchObject([{ robot: 'r7' }]);
    tick(200);
    expect(cmds()).toHaveLength(0);
  });
  it('[B6] 폰에도 뎁스 보기', () => {
    mount(true, 'u-park', '#/drive/r7');
    expect([...box.querySelectorAll('button')].some((b) => b.textContent === '뎁스')).toBe(true);
  });
  it('[B4] 관제에서 Space 는 고른 로봇을 STOP, 수정키가 눌려 있어도', () => {
    mount(false, 'u-kim', '#/fleet');
    serve(KIM, 'r3', 'r7', 'r1');
    key('keydown', 'Space');
    key('keydown', 'Space', window, true);
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r3', 'r3']);
  });
  it('[B5] 대상 없는 화면: STOP 은 아무것도 멈추지 않고 로봇 고르기 → 고른 뒤 Space = 그 로봇만', () => {
    mount(false, 'u-kim', '#/mission');
    serve(KIM, 'r3', 'r7', 'r1');
    click($('[data-stop]'));
    expect(w.of('stop')).toHaveLength(0);
    const pick = $<HTMLSelectElement>('select[aria-label="정지할 로봇"]');
    expect(pick.value).toBe('');
    expect(btn('정지').disabled).toBe(true);
    key('keydown', 'Space');
    expect(w.of('stop')).toHaveLength(0);
    act(() => { pick.value = 'r7'; pick.dispatchEvent(new Event('change', { bubbles: true })); });
    key('keydown', 'Space');
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7']);
    expect(box.querySelector('[aria-label="정지할 로봇 고르기"]')).toBeNull();
    expect(band()).toContain('Go2-7 정지 요청됨');
  });
});

// ── PR #12 Codex 1차 검토 B1~B6·C1·C2 재현(고치기 전에는 실패)
describe('PR #12 검토 1차', () => {
  const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  /** 끝까지 답하지 않는 fetch(시한이 끊으면 AbortError) */
  const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, no) => init.signal!.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError')))));
  const me = (status: number) => vi.fn(async () => new Response(JSON.stringify(status === 200 ? { id: 'u-kim' } : { error: { code: 'X', message: '', detail: {} } }), { status }));

  it('[B1] STOP 답이 안 오면(ping 은 오는데) 시한 뒤 HTTP 대체 경로, 늦게 온 WS 답은 무시', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    const f = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', f);
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    click($('[data-stop]'));
    tick(STOP_WS_MS - 1);
    expect(f).not.toHaveBeenCalled();
    expect(band()).toContain('정지 요청을 보내는 중');
    tick(1); await settle();
    expect(f).toHaveBeenCalledWith('/api/v1/robots/r7/stop', expect.objectContaining({ method: 'POST' }));
    expect(band()).toContain('Go2-7 정지 요청됨(대체 경로)');
    recv({ t: 'reply', id: w.of('stop')[0].id, ok: false, error: { code: 'SERVER_BUSY', message: '', detail: {} } });
    expect(band()).toContain('정지 요청됨(대체 경로)');
  });
  it('[B1·N2] WS·HTTP 모두 답이 없으면 «보냈지만 접수 확인 못함·현장에서 직접»(보내지 못했다고 단정 안 함)', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    vi.stubGlobal('fetch', hang);
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    click($('[data-stop]'));
    tick(STOP_WS_MS); await settle();
    tick(STOP_HTTP_MS - 1); await settle();
    expect(band()).toContain('정지 요청을 보내는 중');
    tick(1); await settle();
    expect(band()).toContain('Go2-7 정지 요청을 보냈지만 서버 접수를 확인하지 못했습니다. 서버가 제시간에 답하지 않았습니다.');
    expect(band()).toContain('현장에서 로봇을 직접 멈추세요');
    expect(band()).not.toContain('보내지 못했습니다');
  });
  it('[N2] HTTP 대체 경로 중에 같은 STOP 의 WS 접수가 오면 성공 — 뒤의 HTTP 시한 초과가 거짓 실패로 덮지 않음', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    vi.stubGlobal('fetch', hang);
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    click($('[data-stop]'));
    tick(STOP_WS_MS); await settle();
    tick(500);
    recv({ t: 'reply', id: w.of('stop')[0].id, ok: true });
    tick(STOP_HTTP_MS); await settle();
    expect(band()).toContain('Go2-7 정지 요청됨 — 서버가 받았습니다.');
    expect(band()).not.toMatch(/보내지 못했습니다|확인하지 못했습니다/);
  });
  it('[N2] 대체 경로로 넘어간 뒤 늦게 온 WS 거절은 무시(HTTP 결과를 따름)', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    click($('[data-stop]'));
    tick(STOP_WS_MS); await settle();
    recv({ t: 'reply', id: w.of('stop')[0].id, ok: false, error: { code: 'SERVER_BUSY', message: '', detail: {} } });
    expect(band()).toContain('정지 요청됨(대체 경로)');
  });
  it('[N3] 로그아웃하면 앞 세션 STOP 의 대체 경로 타이머·HTTP 를 거둠 — 다음 계정의 CSRF 로 앞 로봇에 보내지 않음', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => { calls.push([u, init]); return new Response(JSON.stringify({ csrf_token: 'B-csrf', requested: true }), { status: 200 }); }));
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    w.auto = null;
    click($('[data-stop]'));
    act(() => root?.unmount()); root = null;                // 로그아웃 = App 이 내려가며 rt.disconnect
    await api.login('next', 'pw');
    tick(STOP_WS_MS * 5); await settle();
    expect(calls.map(([u]) => u).filter((u) => !u.includes('/notifications') && !u.includes('/dashboard'))).toEqual(['/api/v1/auth/login']);   // 알림 종·결재 배지(GET, 띄울 때 한 번)의 요청 말고
  });
  it('[N3] 이미 나간 대체 경로 HTTP 도 로그아웃 때 끊고, 그 결과(401 포함)는 다음 세션에 반영하지 않음', async () => {
    const lost = vi.fn(); setAuthLost(lost);
    let signal: AbortSignal | undefined, answer = (_: Response) => {};
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => { signal = init.signal!; return new Promise<Response>((r) => { answer = r; }); }));
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    click($('[data-stop]'));
    tick(STOP_WS_MS); await settle();
    expect(signal?.aborted).toBe(false);
    act(() => root?.unmount()); root = null;
    expect(signal?.aborted).toBe(true);
    answer(new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '', detail: {} } }), { status: 401 }));   // 끊김을 무시하고 늦게 온 401
    await settle();
    expect(lost).not.toHaveBeenCalled();
    setAuthLost(() => {});
  });

  it('[B2] 수락 전 끊김(1006) + REST 401 → 로그인 화면, 다시 연결 안 함', async () => {
    const lost = vi.fn(); setAuthLost(lost);
    vi.stubGlobal('fetch', me(401));
    mount(false, 'u-kim', '#/fleet');
    act(() => FakeWS.last.drop(1006));                     // 열리기 전에 닫힘 = 브라우저가 HTTP 401/403 을 알리는 방식
    await settle();
    expect(lost).toHaveBeenCalled();
    expect($('header [data-link]').textContent).toContain('연결 거부');
    tick(60_000);
    expect(FakeWS.all).toHaveLength(1);
    setAuthLost(() => {});
  });
  it('[N1] REST 로그인 정상 + 수락 전 끊김(1006)이 몇 번이든 거부로 단정하지 않고 늘려 가며 «연결 재시도 중»', async () => {
    vi.stubGlobal('fetch', me(200));
    mount(false, 'u-kim', '#/fleet');
    for (let i = 0; i < 6; i++) { act(() => FakeWS.last.drop(1006)); await settle(); tick(Math.min(10, 2 ** i) * 1000); }
    expect(FakeWS.all).toHaveLength(7);
    expect($('header [data-link]').textContent).toContain('연결 끊김');
    expect(band()).toContain('연결 재시도 중입니다');
    expect(band()).not.toContain('거부');
  });
  it('[N1] REST 403 이면 영구 거부(다시 연결 안 함)', async () => {
    vi.stubGlobal('fetch', me(403));
    mount(false, 'u-kim', '#/fleet');
    act(() => FakeWS.last.drop(1006)); await settle();
    expect($('header [data-link]').textContent).toContain('연결 거부');
    tick(60_000);
    expect(FakeWS.all).toHaveLength(1);
  });
  it('[B2] 수락 전 3 s 매달림(시간 초과)은 거부로 세지 않음 — REST 확인 없이 다시 연결', () => {
    const f = me(200); vi.stubGlobal('fetch', f);
    mount(false, 'u-kim', '#/fleet');
    tick(60_000);
    expect((f.mock.calls as unknown as [string][]).filter(([u]) => !/\/(dashboard|robots\/|notifications|events|sites)/.test(String(u)))).toEqual([]);   // 관제 요약·상세·알림·최근 사건·지도 칸 층 목록 말고 인증 확인(REST)은 0
    expect($('header [data-link]').textContent).toContain('연결 끊김');
    expect(FakeWS.all.length).toBeGreaterThan(3);
  });
  it('[B2] 수락 전 끊김이라도 REST 도 안 닿으면(서버·네트워크) 계속 다시 연결, 열린 뒤 끊김은 REST 확인 안 함', async () => {
    const f = vi.fn(async () => { throw new TypeError('offline'); });
    vi.stubGlobal('fetch', f);
    mount(false, 'u-kim', '#/fleet');
    for (let i = 0; i < 4; i++) { act(() => FakeWS.last.drop(1006)); await settle(); tick(2 ** i * 1000); }
    expect(FakeWS.all).toHaveLength(5);
    serve(KIM, 'r3');
    f.mockClear();
    act(() => w.drop(1006)); await settle();
    expect(f).not.toHaveBeenCalled();
  });

  it('[B3] 연결 중에 [다시 연결]·자동 재시도가 겹쳐도 이전 소켓은 닫고, 내리면 모두 닫힘', () => {
    mount(false, 'u-kim', '#/fleet');
    act(() => FakeWS.last.drop(1006));
    tick(1000);
    click(btn('다시 연결'));
    click(btn('다시 연결'));
    const [, a, b, c] = FakeWS.all;
    expect([a.readyState, b.readyState, c.readyState]).toEqual([3, 3, 0]);
    expect(a.onopen ?? b.onmessage ?? b.onclose).toBeNull();
    act(() => { a.open(); b.open(); });
    expect($('header [data-link]').textContent).toContain('연결 끊김');   // 버린 소켓이 열려도 연결로 치지 않음
    act(() => root?.unmount()); root = null;
    expect(FakeWS.all.every((x) => x.readyState === 3)).toBe(true);
  });

  it('[B4] HTTP 대체 경로 뒤 다시 연결되어 새 state 가 오면 로봇 보고로 띠를 바꿈', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    act(() => w.drop(1006));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
    click($('[data-stop]')); await settle();
    tick(1000);
    serve(PARK);                                           // 열렸지만 아직 state 없음
    expect(band()).toContain('정지 요청됨(대체 경로)');
    act(() => push('r7', { latched: true, applied: [0, 0, 0] }));
    expect(band()).toContain('Go2-7 정지 잠금 — 로봇이 잠금과 멈춤 출력을 알렸습니다.');
    expect(band()).not.toContain('실시간 연결이 끊겨');
  });

  it('[B5] 다시 연결 직후 첫 state 전에는 옛 목록 값을 지금처럼 보이지 않음(상태 확인 중·조종 불가)', () => {
    mount(true, 'u-kim', '#/drive');
    serve(KIM, 'r3', 'r7', 'r1');
    act(() => w.drop(1006));
    tick(1000);
    serve(KIM);
    const list = $('[aria-label="내 로봇"]').textContent!;
    expect(list).toContain('상태 확인 중');
    expect(list).not.toContain('순찰 중');
    expect(card('Go2-3').querySelector('button')!.textContent).toBe('보기만');
    act(() => push('r3', { status: 'RUNNING' }));
    expect(card('Go2-3').querySelector('button')!.textContent).toBe('연결');
  });

  it('[B6] 운영 관리자의 남의 로봇: 목록의 조종권자 + 받은 시각, 연결값은 «확인 안 됨»(끊김 경보 아님)', () => {
    const r7 = { ...ROBOTS[1], online: false, holder: { type: 'USER' as const, id: 'u-park', name: '박OO' }, listedAt: '14:05:20' };
    mount(false, 'u-lee', '#/fleet', [ROBOTS[0], r7, ROBOTS[2]]);
    serve(LEE, 'r3', 'r1');
    click(row('Go2-7'));
    expect(text()).toContain('박OO님 조종 중(목록 14:05:20)');
    expect(text()).toContain('확인 안 됨');
    expect(band()).not.toContain('Go2-7 연결이 끊겼습니다');
    click($('[data-stop]'));
    expect(w.of('stop')).toMatchObject([{ robot: 'r7' }]);
  });
  it('[B6] 목록에 조종권 값이 없거나 null 이면 «없음»으로 단정하지 않음', () => {
    mount(false, 'u-lee', '#/fleet', [ROBOTS[0], { ...ROBOTS[1], holder: null, listedAt: '14:05:20' }, ROBOTS[2]]);
    serve(LEE, 'r3', 'r1');
    click(row('Go2-7'));
    expect(text()).toContain('조종권자 확인 안 됨');
    expect(text()).not.toContain('조종하는 사람 없음');
  });

  it('[F2] 폰: 조종 중에 목록 앞쪽에 새 담당 로봇이 들어와도 고른 로봇·조종권 유지', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    const shown = () => $('[aria-label="조종"] h2')?.textContent;
    expect(shown()).toBe('Go2-7');
    act(() => root!.render(<App user={USERS.find((u) => u.id === 'u-park')} robots={[{ ...ROBOTS[2], owner: 'u-park' }, ...ROBOTS.slice(0, 2)]} />));
    expect(shown()).toBe('Go2-7');
    expect(w.of('hidden')).toHaveLength(0);
    expect(text()).toContain('움직일 수 있음');
    act(() => root!.render(<App user={USERS.find((u) => u.id === 'u-park')} robots={[{ ...ROBOTS[2], owner: 'u-park' }, ROBOTS[0]]} />));   // r7 이 범위에서 빠지면 조종 화면을 닫고 로봇 연결로
    expect(location.hash).toBe('#/drive');
    expect($('[aria-label="조종"]')).toBeNull();
    expect(w.of('hidden')).toMatchObject([{ robot: 'r7' }]);
  });
  it('[F3] 앞 세션의 수락 전 확인(/me)이 늦게 401 이어도 다음 사용자의 로그인을 끝내지 않음', async () => {
    const lost = vi.fn(), answers: ((r: Response) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => u.endsWith('/me') ? new Promise<Response>((r) => answers.push(r)) : Promise.resolve(new Response(JSON.stringify({ csrf_token: 'B-csrf' }), { status: 200 }))));
    rt.connect(['r7']);
    act(() => FakeWS.last.drop(1006)); await settle();
    expect(answers).toHaveLength(1);
    rt.disconnect();
    await api.login('next', 'pw');
    setAuthLost(lost);
    rt.connect(['r1']); act(() => FakeWS.last.open());
    answers[0](new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '', detail: {} } }), { status: 401 }));
    await settle();
    expect(lost).not.toHaveBeenCalled();
    expect(rt.link().at).not.toBe('denied');
    rt.disconnect(); setAuthLost(() => {});
  });
  it('[G2] 남이 조종 중인 걸 보다가 4403 으로 관측이 끊기면 조종권자 «확인 안 됨»(없음이라 하지 않음)', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    recv(lease('r7', { id: 'u-kim', name: '김OO' }));
    expect(text()).toContain('김OO님 조종 중');
    act(() => FakeWS.last.drop(4403));
    expect(text()).toContain('조종권자 확인 안 됨');
    expect(text()).not.toContain('조종하는 사람 없음');
  });
  it('[G2] 1006 재시도 중·다시 연결 뒤 첫 값 전에도 «확인 안 됨», 서버가 알린 조종권자는 보이고 빈 조종권을 알리면 그때 «없음»', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    recv(lease('r7', { id: 'u-kim', name: '김OO' }));
    act(() => FakeWS.last.drop(1006));
    expect(text()).toContain('조종권자 확인 안 됨');
    tick(1000);
    act(() => FakeWS.last.open());
    expect(text()).toContain('조종권자 확인 안 됨');
    act(() => FakeWS.last.recv(lease('r7', { id: 'u-kim', name: '김OO' })));   // 첫 state 전이라도 서버가 알린 조종권자는 보인다
    expect(text()).toContain('김OO님 조종 중');
    act(() => { FakeWS.last.recv(state('r7')); FakeWS.last.recv(lease('r7', null)); });
    expect(text()).toContain('조종하는 사람 없음');
  });
  it('[N5] 담당 로봇이 바뀌면(목록 갱신) 같은 소켓으로 sub 를 다시 보내고, 빠진 로봇은 조종권을 돌려줌', () => {
    const mine = [ROBOTS[0], { ...ROBOTS[1], owner: 'u-lee' }, ROBOTS[2]];   // r7 이 이운영 담당이 됨
    mount(true, 'u-lee', '#/drive');
    serve(LEE, 'r3', 'r1');
    expect(text()).not.toContain('Go2-7');                 // 폰은 내 로봇만
    act(() => root!.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={mine} />));
    expect(FakeWS.all).toHaveLength(1);
    expect(end(w.of('sub'))).toMatchObject({ robots: ['r3', 'r7', 'r1'] });
    expect(card('Go2-7').textContent).toContain('로봇 상태를 확인하는 중입니다');
    act(() => push('r7'));
    click(card('Go2-7').querySelector('button')!);
    expect(btn('조종 시작').disabled).toBe(false);
    click(btn('조종 시작'));
    expect(text()).toContain('조종 중(나)');
    act(() => root!.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={ROBOTS} />));   // 다시 남의 로봇
    expect(end(w.of('sub'))).toMatchObject({ robots: ['r3', 'r1'] });
    expect(w.of('hidden')).toMatchObject([{ robot: 'r7' }]);
    expect(location.hash).toBe('#/drive');                 // 조종 화면을 닫고 로봇 연결로
    expect(FakeWS.all).toHaveLength(1);
  });

  it('[C1] 3 s 를 못 버틴 연결이 끊기면 재시도 간격을 늘리고, 3 s 넘게 유지된 뒤 끊기면 1 s 부터', () => {
    mount(false, 'u-kim', '#/fleet');
    serve(KIM, 'r3');
    act(() => w.drop(1006));
    tick(1000);
    serve(KIM, 'r3');                                      // 열리고 state 도 받았지만 곧 끊김
    act(() => w.drop(1006));
    tick(1999);
    expect(FakeWS.all).toHaveLength(2);
    tick(1);
    expect(FakeWS.all).toHaveLength(3);
    serve(KIM, 'r3');
    for (let i = 0; i < 12; i++) { tick(250); act(() => push('r3')); }
    act(() => w.drop(1006));
    tick(1000);
    expect(FakeWS.all).toHaveLength(4);
  });

  it('[C2] take 의 CANCELED 결과가 응답보다 먼저 와도 «받는 중»에 갇히지 않음', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    w.auto = (m) => {
      if (m.t === 'lease.take') w.recv({ t: 'lease.result', robot: 'r7', request_id: null, result: 'CANCELED', error: 'STOP_REF_EXHAUSTED' });
      return { ok: true };
    };
    click(btn('조종 시작'));
    expect(text()).toContain('로봇을 다시 연결해야 조종권을 줄 수 있습니다');
    expect(text()).not.toContain('조종권 넘기는 중');
    expect(btn('조종 시작').disabled).toBe(false);
  });
});

describe('S0 서버 후속(apps/server README «S0»)', () => {
  const stopOn = () => { const s = $<HTMLButtonElement>('[data-stop]'); expect(s.disabled).toBe(false); expect(s.hidden).toBe(false); };

  it('요청자: 서버 답 전에도 [요청 취소] → lease.cancel, CANCELED 로 대기 표시가 닫힘. 화면이 30 s 를 따로 세지 않고 서버 제한 응답을 안내', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    w.auto = (m) => (m.t === 'lease.request' ? undefined : { ok: true });   // 요청의 답이 아직 안 옴
    click(btn('조종 시작'));
    expect(text()).toContain('박OO님에게 요청했습니다.');
    click(btn('요청 취소'));
    expect(w.of('lease.cancel')).toMatchObject([{ robot: 'r7' }]);
    expect(text()).toContain('요청을 취소하는 중입니다.');
    expect(btn('요청 취소').disabled).toBe(true);
    stopOn();
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'CANCELED' });
    expect(btn('요청 취소')).toBeUndefined();
    expect(text()).toContain('요청을 취소했습니다.');
    expect(text()).not.toContain('초 뒤 다시 요청할 수 있습니다');
    expect(btn('조종 시작').disabled).toBe(false);
    w.auto = (m) => (m.t === 'lease.request' ? fail('LEASE_REQUEST_COOLDOWN', '30초 뒤 다시 요청하세요.') : { ok: true });
    click(btn('조종 시작'));
    expect(text()).toContain('요청이 거절·시간 초과·취소로 끝난 뒤 30초 안에는 다시 요청할 수 없습니다.');
    expect(btn('요청 취소')).toBeUndefined();
    stopOn();
  });

  it('조종권자: 요청자가 취소한 CANCELED 로 «넘겨주시겠습니까» 창이 닫히고 계속 조종', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    recv(ask());
    expect($('[role="dialog"]')).not.toBeNull();
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'CANCELED' });
    expect(box.querySelector('[role="dialog"]')).toBeNull();
    expect(text()).toContain('요청이 취소되었습니다. 계속 조종합니다.');
    expect(text()).toContain('움직일 수 있음');
    stopOn();
  });

  it('취소가 늦음(LEASE_REQUEST_STALE) → 쉬운 문구, 서버 문장·코드는 그대로 안 보임', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    w.auto = (m) => (m.t === 'lease.cancel' ? fail('LEASE_REQUEST_STALE', '현재 연결의 요청이 끝났습니다.') : { ok: true });
    click(btn('조종 시작'));
    click(btn('요청 취소'));
    expect(text()).toContain('요청이 이미 끝났습니다(넘겨받는 중이거나 거절·시간 초과). 지금 조종권 상태를 확인하세요.');
    expect(text()).not.toContain('LEASE_REQUEST_STALE');
    expect(btn('요청 취소').disabled).toBe(false);
    stopOn();
  });

  it('조종 중 3 s 무수신 → 0 한 번 보내고 cmd 멈춤, «연결 끊김», STOP 은 그대로', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    ready();
    key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1, 0, 0]);
    w.auto = null;                                         // 서버가 말이 없어짐(ping·state 없음)
    let waited = 0;
    while (!box.querySelector('header [data-link]') && waited < 4000) { tick(50); waited += 50; }
    expect(waited).toBeGreaterThanOrEqual(2900);           // 3 s(0.25 s 간격 확인) 전에는 끊김으로 보지 않음
    expect(waited).toBeLessThanOrEqual(3300);
    expect(cmds().slice(-2).map((m) => String(m.axes))).toEqual(['1,0,0', '0,0,0']);   // 끊김 직전까지 조종, 끊으며 0
    const n = cmds().length;
    tick(2000);
    expect(cmds().length).toBe(n);                         // 그 뒤 cmd 0건(새 소켓에도)
    expect(FakeWS.all.slice(1).every((s) => s.of('cmd').length === 0)).toBe(true);
    expect($('header [data-link]').textContent).toContain('연결 끊김');
    stopOn();
  });

  it('서버 ping 만 와도(다른 답·state 없음) 연결 유지 — 화면이 ping 에 답할 의무는 없다', () => {
    mount(false, 'u-kim', '#/fleet');
    serve(KIM, 'r3', 'r7', 'r1');
    w.auto = null;
    for (let i = 0; i < 10; i++) { tick(1000); recv({ t: 'ping', t_server: new Date().toISOString() }); }
    expect(box.querySelector('header [data-link]')).toBeNull();
    expect(FakeWS.all).toHaveLength(1);
  });

  it('sub 503(SERVER_BUSY·POLICY_STALE — 서버 detail.status 503) → 1·2 s 늘려 다시(즉시 반복 없음), 받아들여지면 멈춤', () => {
    mount(false, 'u-kim', '#/fleet');
    w = FakeWS.last;
    const busy = ['SERVER_BUSY', 'POLICY_STALE'];
    w.auto = (m) => (m.t === 'sub' && busy.length ? { ok: false, error: { code: busy.shift()!, message: '', detail: { status: 503 } } } : { ok: true });
    act(() => { w.open(); });
    expect(w.of('sub')).toHaveLength(1);
    tick(999); expect(w.of('sub')).toHaveLength(1);
    tick(1); expect(w.of('sub')).toHaveLength(2);
    tick(1999); expect(w.of('sub')).toHaveLength(2);
    tick(1); expect(w.of('sub')).toHaveLength(3);
    tick(20_000); expect(w.of('sub')).toHaveLength(3);
    expect(w.of('sub').map((m) => m.robots)).toEqual([['r3', 'r7', 'r1'], ['r3', 'r7', 'r1'], ['r3', 'r7', 'r1']]);
    stopOn();
  });

  it('sub 는 한 번에 하나: 답 전에 바뀐 목록은 답 뒤 이어 보냄, 늦은 성공도 받아들인 구독으로 남아 다음 404 가 그 로봇까지 되돌리지 않음', () => {
    mount(false, 'u-kim', '#/fleet');
    w = FakeWS.last;
    w.auto = (m) => (m.t === 'sub' ? undefined : { ok: true });   // sub 답은 손으로
    const answer = (i: number, r: object = { ok: true }) => recv({ t: 'reply', id: w.of('sub')[i].id, ...r });
    act(() => { w.open(); });
    answer(0);
    act(() => rt.follow(['r3']));
    answer(1);
    act(() => rt.follow(['r3', 'r7']));
    act(() => rt.follow(['r3', 'r7', 'r1']));             // 앞 sub([r3,r7]) 답 전 — 보내지 않음
    expect(w.of('sub').map((m) => m.robots)).toEqual([['r3', 'r7', 'r1'], ['r3'], ['r3', 'r7']]);
    answer(2);                                             // 늦은 성공 → 바뀐 목록을 이어 보냄
    expect(w.of('sub').map((m) => m.robots).pop()).toEqual(['r3', 'r7', 'r1']);
    answer(3, fail('NOT_FOUND', '로봇을 찾을 수 없습니다.'));
    act(() => { push('r3'); push('r7'); });
    const rows = $('[aria-label="로봇 목록"]');
    const rowOf = (name: string) => [...rows.querySelectorAll('li')].find((li) => li.textContent!.includes(name))!.textContent!;
    expect(rowOf('Go2-7')).not.toContain('확인 안 됨');     // 서버가 받아들인 [r3,r7] 은 그대로
    expect(rowOf('Go2-1')).toContain('확인 안 됨');
    stopOn();
  });

  it('요청자: 수락 뒤 정지 확인 중(lease null)에도 [요청 취소] → CANCELED 로 닫히고 «조종권이 비었습니다»', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    click(btn('조종 시작'));
    recv(lease('r7', null));                               // 조종권자가 넘기기 → 정지 확인 중
    expect(text()).toContain('로봇 정지를 확인한 뒤 조종권을 받습니다.');
    expect(btn('요청 취소').disabled).toBe(false);
    click(btn('요청 취소'));
    expect(w.of('lease.cancel')).toMatchObject([{ robot: 'r7' }]);
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'CANCELED' });
    expect(btn('요청 취소')).toBeUndefined();
    expect(text()).toContain(`요청을 취소했습니다. ${FREE_TEXT}`);
    expect(text()).not.toContain('정지를 확인한 뒤');
    stopOn();
  });

  it('조종권자: 넘기는 중 요청자가 취소하면 «계속 조종» 이 아니라 조종권이 비었다고 안내', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    recv(ask());
    clickWith($('[data-ask="give"]'), 1);
    recv(lease('r7', null));
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'CANCELED' });
    expect(text()).toContain(`요청자가 넘김을 취소했습니다. ${FREE_TEXT}`);
    expect(text()).not.toContain('계속 조종합니다');
    expect(btn('조종 시작').disabled).toBe(false);
    stopOn();
  });

  it('취소가 확정보다 늦음: 내 lease 를 받은 뒤 STALE → «이미 받았습니다·조종 끝내기» 안내, 취소 단추 없음', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    click(btn('조종 시작'));
    recv(lease('r7', null));
    w.auto = (m) => (m.t === 'lease.cancel' ? undefined : { ok: true });
    click(btn('요청 취소'));
    recv(lease('r7', KIM, 'L-kim'));
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'ACCEPTED' });
    recv({ t: 'reply', id: w.of('lease.cancel')[0].id, ok: false, error: { code: 'LEASE_REQUEST_STALE', message: '현재 연결의 요청이 끝났습니다.', detail: { status: 409 } } });
    expect(text()).toContain('취소하기 전에 조종권을 받았습니다. 조종하지 않으려면 [조종 끝내기]를 누르세요.');
    expect(btn('요청 취소')).toBeUndefined();
    expect(btn('조종 끝내기')).toBeDefined();
    stopOn();
  });

  it('take 409 SUBSCRIPTION_REQUIRED → 다시 열라는 안내(서버 코드 안 보임)', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    w.auto = (m) => (m.t === 'lease.take' ? fail('SUBSCRIPTION_REQUIRED', '로봇 화면을 다시 열어 주세요.') : { ok: true });
    click(btn('조종 시작'));
    expect(text()).toContain('목록을 새로 받은 뒤 로봇 화면을 다시 열어 주세요.');
    expect(text()).not.toContain('SUBSCRIPTION_REQUIRED');
    stopOn();
  });
});

// 10-20 사용자 결정: 글 입력칸에 초점이 있을 때만 Space 를 STOP 으로 쓰지 않음(띄어쓰기). 화면 STOP 단추는 늘 그대로
describe('Space 와 글 입력칸', () => {
  /** box 안에 html 을 넣고 그 요소에서 Space 를 누름 → [보낸 stop 수, keydown·keyup 기본 동작 막힘] */
  const space = (html: string) => {
    const host = document.createElement('div'); host.innerHTML = html; box.append(host);
    const el = host.firstElementChild as HTMLElement; el.focus();
    const n = w.of('stop').length;
    const d = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    const u = new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    act(() => { el.dispatchEvent(d); el.dispatchEvent(u); });
    host.remove();
    return [w.of('stop').length - n, d.defaultPrevented, u.defaultPrevented];
  };
  const fleet = () => { mount(false, 'u-kim', '#/fleet'); serve(KIM, 'r3', 'r7', 'r1'); };

  it.each(['<input>', '<input type="text">', '<input type="search">', '<input type="password">', '<input type="email">',
    '<input type="url">', '<input type="tel">', '<input type="number">', '<textarea></textarea>',
    '<div contenteditable="true" tabindex="0"></div>', '<div contenteditable="" tabindex="0"></div>', '<p contenteditable="plaintext-only"></p>',
    '<div contenteditable="TRUE" tabindex="0"></div>', '<div contenteditable="PlainText-Only" tabindex="0"></div>'])(
    '글 입력칸 %s: STOP 안 보내고 띄어쓰기를 막지 않음', (h) => {
      fleet();
      expect(space(h)).toEqual([0, false, false]);
    });

  it.each(['<input readonly>', '<input disabled>', '<textarea readonly></textarea>', '<textarea disabled></textarea>',
    '<input type="checkbox">', '<input type="radio">', '<input type="range">', '<input type="button" value="b">',
    '<button type="button">b</button>', '<select><option>a</option></select>', '<div contenteditable="false" tabindex="0"></div>',
    '<div contenteditable="FALSE" tabindex="0"></div>', '<div contenteditable="invalid" tabindex="0"></div>',
    '<div tabindex="0"></div>'])(
    '글 입력칸 아님 %s: Space = STOP, 기본 동작 막음', (h) => {
      fleet();
      expect(space(h)).toEqual([1, true, true]);
    });

  it('빈 곳(body)·키 반복: Space = STOP 한 번, 반복은 막기만', () => {
    fleet();
    (document.activeElement as HTMLElement | null)?.blur();
    key('keydown', 'Space', document.body);
    const r = new KeyboardEvent('keydown', { code: 'Space', repeat: true, bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(r); });
    expect([w.of('stop').length, r.defaultPrevented]).toEqual([1, true]);
  });

  // 중첩: 잘못된 값·속성 없음은 상위를 따르고, false(대소문자 무시)는 끊는다 → [보낸 stop 수]
  it.each([
    ['<div contenteditable="true"><b contenteditable="false">x</b></div>', 1],
    ['<div contenteditable="true"><b contenteditable="False">x</b></div>', 1],
    ['<div contenteditable="true"><b contenteditable="invalid">x</b></div>', 0],
    ['<div contenteditable="false"><b contenteditable="invalid">x</b></div>', 1],
    ['<div contenteditable="FALSE"><i contenteditable="true"><b>x</b></i></div>', 0],
    ['<div contenteditable=""><i><b>x</b></i></div>', 0],
  ])('중첩 contenteditable %s 안의 조각: stop %i', (h, n) => {
    fleet();
    const host = document.createElement('div'); host.innerHTML = h; box.append(host);
    act(() => { host.querySelector('b')!.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true })); });
    expect(w.of('stop')).toHaveLength(n);
  });

  it('입력칸에 초점이 있어도 화면 STOP 단추는 보이고 누르면 바로 STOP', () => {
    fleet();
    const host = document.createElement('div'); host.innerHTML = '<input>'; box.append(host);
    host.querySelector('input')!.focus();
    const s = $<HTMLButtonElement>('[data-stop]');
    expect(s.disabled).toBe(false);
    click(s);
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r3']);
  });

  it('조종권 요청 창·확인창·로봇 고르기 창의 단추 초점에서도 Space = STOP', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    recv(ask());
    const give = $('[data-ask="give"]'); give.focus();
    key('keydown', 'Space', give);
    expect(w.of('stop')).toHaveLength(1);
    act(() => root?.unmount()); box.remove();

    mount(true, 'u-lee', '#/drive/r3');
    serve(LEE, 'r3', 'r1');
    recv(lease('r3', { id: null, name: '', type: 'RUN' }));
    click(btn('조종 시작'));
    const go = btn('일시정지하고 조종'); go.focus();
    key('keydown', 'Space', go);
    expect([w.of('stop').length, w.of('lease.take').length]).toEqual([1, 0]);   // 확인창 단추는 눌리지 않음
    act(() => root?.unmount()); box.remove();

    mount(false, 'u-kim', '#/mission');
    serve(KIM, 'r3', 'r7', 'r1');
    click($('[data-stop]'));
    const pick = $<HTMLSelectElement>('select[aria-label="정지할 로봇"]');
    act(() => { pick.value = 'r7'; pick.dispatchEvent(new Event('change', { bubbles: true })); });
    pick.focus();
    key('keydown', 'Space', pick);
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7']);
  });
});

// ADR-002 §3 폰 조종 앱 틀(시안 A): 로봇 연결 → 조종 → 시트 → 끝내기. STOP 은 어느 화면·시트에서도 머리줄 맨 오른쪽
describe('폰 조종 앱 틀', () => {
  const SHEETS = ['자세', '시나리오', '지도·목표', '정책'];
  const stopBtn = () => $<HTMLButtonElement>('[data-stop]');
  /** STOP: 머리줄 맨 끝, 시트 밖, 누를 수 있음, 64 px 이상 */
  const stopReachable = () => {
    expect(stopBtn().parentElement!.tagName).toBe('HEADER');
    expect($('header').lastElementChild).toBe(stopBtn());
    expect(stopBtn().closest('[data-sheet]')).toBeNull();
    expect(stopBtn().disabled).toBe(false);
    expect(parseInt(stopBtn().style.minHeight)).toBeGreaterThanOrEqual(64);
  };

  it('연결 → 조종 → 끝내기: 조종권 반납 한 번(가림 아님) → 로봇 연결, 그 뒤 입력 0', () => {
    mount(true, 'u-kim', '#/drive');
    serve(KIM, 'r3', 'r7', 'r1');
    expect($('main').getAttribute('aria-label')).toBe('로봇 연결');
    click(card('Go2-7').querySelector('button')!);
    expect($('main').getAttribute('aria-label')).toBe('조종');
    ready();
    key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1, 0, 0]);
    click(btn('끝내기'));
    expect(w.of('lease.release')).toMatchObject([{ robot: 'r7' }]);
    expect(w.of('hidden')).toHaveLength(0);
    expect(location.hash).toBe('#/drive');
    expect($('main').getAttribute('aria-label')).toBe('로봇 연결');
    expect(rt.get('r7').lease).toBeNull();
    const n = cmds().length;
    tick(500);
    expect(cmds()).toHaveLength(n);
  });

  /** 진짜 PointerEvent 대신 pointerId 를 단 MouseEvent(jsdom) */
  const pe = (type: string, el: Element, x: number, y: number, id = 1) => act(() => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: id });
    el.dispatchEvent(e);
  });
  /** 전후 조이스틱(120 px 상자): 위 6.6 px = 전진 0.89. 포인터 잡기·놓기를 기록한다 */
  const grip = () => {
    const el = $('[aria-label="전후 조이스틱"]'), held = new Set<number>();
    el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    Object.assign(el, { setPointerCapture: (i: number) => held.add(i), hasPointerCapture: (i: number) => held.has(i), releasePointerCapture: (i: number) => held.delete(i) });
    return { el, held };
  };
  const FWD = 0.89;
  // [B1] 시트·⋯ 가 조이스틱을 가리는 네 경우: 열기·전환·닫기·⋯ 열기
  for (const [name, before, act_] of [
    ['시트 열기', () => {}, () => click(btn('자세'))],
    ['시트 전환', () => click(btn('자세')), () => click(btn('시나리오'))],
    ['시트 닫기', () => click(btn('자세')), () => click(btn('닫기'))],
    ['⋯ 열기', () => {}, () => { click($('summary[aria-label="더 보기"]')); tick(0); }],
  ] as const) it(`조이스틱·키를 누른 채 ${name} → 바로 입력 0 보냄 + 포인터 놓음, 새로 누르기 전까지 옛 포인터·키는 되살지 않음`, () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    ready();
    before();
    const { el, held } = grip();
    pe('pointerdown', el, 60, 6.6);
    key('keydown', 'KeyA');
    tick(100);
    expect((lastAxes() as number[])[0]).toBeCloseTo(FWD, 2);
    expect((lastAxes() as number[])[2]).toBe(1);
    expect(held.has(1)).toBe(true);
    const n = cmds().length;
    act_();
    expect(cmds().length).toBe(n + 1);                     // 50 ms 를 기다리지 않고 바로
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect(held.has(1)).toBe(false);
    pe('pointermove', el, 60, 0);                           // 옛 포인터가 계속 움직여도
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', repeat: true, bubbles: true, cancelable: true })); });   // 누른 키의 자동 반복도
    tick(200);
    expect(cmds().slice(n).every((m) => (m.axes as number[]).every((v) => v === 0))).toBe(true);
    expect(rt.get('r7').lease).not.toBeNull();             // 조종권은 그대로
    pe('pointerdown', el, 60, 6.6, 2);                      // 새로 누르면 다시 조종
    tick(100);
    expect((lastAxes() as number[])[0]).toBeCloseTo(FWD, 2);
    pe('pointerup', el, 60, 6.6, 2);
    key('keyup', 'KeyA'); key('keydown', 'KeyA');           // 키도 새로 누르면
    tick(100);
    expect(lastAxes()).toEqual([0, 0, 1]);
  });

  // [B2] 끝내기 = 입력 0 → 반납 중 → 서버가 반납을 확인해야 로봇 연결로
  /** lease.release 에 대한 서버 답을 바꿈: reject = 거절, none = 답 없음(뒤에 answer() 로 늦게 성공) */
  function releaseReply(mode: 'reject' | 'none') {
    const base = w.auto!, pending: string[] = [];
    w.auto = (m) => {
      if (m.t !== 'lease.release') return base(m);
      if (mode === 'reject') w.recv({ t: 'reply', id: m.id, ...fail('NOT_HOLDER', '조종권을 가진 사람이 아닙니다.') });
      else pending.push(m.id);
    };
    return { answer: () => act(() => { for (const id of pending.splice(0)) { w.recv({ t: 'reply', id, ok: true }); w.recv(lease('r7', null)); } }) };
  }
  const endBtn = () => $<HTMLButtonElement>('header .btn');
  function holding() {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    ready();
    key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1, 0, 0]);
    expect(endBtn().textContent).toBe('끝내기');
  }
  const zeroThenRelease = () => {
    const i = w.sent.findIndex((m) => m.t === 'lease.release');
    expect(w.sent.slice(0, i).filter((m) => m.t === 'cmd').pop()!.axes).toEqual([0, 0, 0]);
  };
  const stays = () => { expect(location.hash).toBe('#/drive/r7'); expect($('main').getAttribute('aria-label')).toBe('조종'); stopReachable(); };

  it('끝내기 — 서버가 거절: 이 화면에 머물러 «확인 못함» + [다시 시도]·[연결 화면], 다시 시도가 성공하면 로봇 연결', () => {
    holding();
    releaseReply('reject');
    click(endBtn());
    zeroThenRelease();
    stays();
    const failBox = $('[data-end-fail]');
    expect(failBox.textContent).toContain('조종권 반납을 확인하지 못했습니다.');
    expect(failBox.textContent).toContain('조종권을 가진 사람이 아닙니다.');
    expect(endBtn().disabled).toBe(true);
    click(endBtn());                                        // 막힌 끝내기는 또 보내지 않음
    expect(w.of('lease.release')).toHaveLength(1);
    w.auto = (m) => { w.recv({ t: 'reply', id: m.id, ok: true }); };
    click(btn('다시 시도'));
    expect(w.of('lease.release')).toHaveLength(2);
    expect(location.hash).toBe('#/drive');
    expect($('main').getAttribute('aria-label')).toBe('로봇 연결');
    expect(box.querySelector('[data-end-fail]')).toBeNull();
  });

  it('끝내기 — 답 없음: «반납 중»(끝내기 막힘, 두 번 눌러도 한 번) → 3 s 뒤 «서버가 답하지 않습니다», [연결 화면]은 사람이 고를 때만', () => {
    holding();
    releaseReply('none');
    click(endBtn());
    zeroThenRelease();
    stays();
    expect($('[data-ending]').textContent).toContain('조종권을 반납하는 중입니다');
    expect(endBtn().disabled).toBe(true);
    click(endBtn());
    expect(w.of('lease.release')).toHaveLength(1);
    stays();
    const n = cmds().length;
    tick(2999);
    expect(cmds()).toHaveLength(n);                          // 반납을 보낸 뒤 입력은 더 안 나감
    expect(box.querySelector('[data-end-fail]')).toBeNull();
    tick(1);
    expect($('[data-end-fail]').textContent).toContain('서버가 답하지 않습니다.');
    stays();
    tick(10_000);
    stays();
    click(btn('연결 화면'));
    expect(location.hash).toBe('#/drive');
    expect($('main').getAttribute('aria-label')).toBe('로봇 연결');
  });

  it('끝내기 — 다시 그리기 전에 두 번 눌러도(같은 틀) 반납 한 번, 확인 전에는 이동하지 않음', () => {
    holding();
    releaseReply('none');
    act(() => { endBtn().click(); endBtn().click(); });
    expect(w.of('lease.release')).toHaveLength(1);
    stays();
    expect($('[data-ending]')).not.toBeNull();
  });

  it('끝내기 — 늦은 성공: «확인 못함» 뒤에 서버 확인이 오면 로봇 연결로', () => {
    holding();
    const srv = releaseReply('none');
    click(endBtn());
    tick(3000);
    expect($('[data-end-fail]')).not.toBeNull();
    stays();
    srv.answer();
    expect(location.hash).toBe('#/drive');
    expect($('main').getAttribute('aria-label')).toBe('로봇 연결');
    expect(rt.get('r7').lease).toBeNull();
  });

  it('시트가 열려 있어도 STOP 은 보이고 눌리며, Space 도 STOP. 시트는 영상 칸 안, 열고 닫아도 조종권 그대로', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    ready();
    for (const s of SHEETS) {
      click(btn(s));
      const sheet = $('[data-sheet]');
      expect(sheet.getAttribute('aria-label')).toBe(s);
      expect(sheet.parentElement!.classList.contains('dv-stage')).toBe(true);
      expect(btn(s).getAttribute('aria-expanded')).toBe('true');
      if (s === '시나리오') expect(sheet.textContent).toContain('이 로봇에 배정된 시나리오가 없습니다.');   // 예전 폰 시나리오 탭 내용(r7 은 배정 0)
      else expect(sheet.textContent).toContain('준비 중');
      stopReachable();
    }
    expect(w.of('lease.release')).toHaveLength(0);
    expect(w.of('hidden')).toHaveLength(0);
    click(stopBtn());
    expect(w.of('stop')).toMatchObject([{ robot: 'r7' }]);
    click(btn('닫기'));
    expect(box.querySelector('[data-sheet]')).toBeNull();
    click(btn('정책'));
    key('keydown', 'Space');
    expect(w.of('stop')).toHaveLength(2);
  });

  it('배치(시안 A): 시트·조이스틱은 영상 칸 안 절대 위치, 왼쪽 = 전후·오른쪽 = 회전, 머리줄은 위에 붙고 시트보다 위', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    click(btn('조종 시작'));
    const stage = $('.dv-stage');
    expect(stage.querySelector('.dv-stick.v')!.getAttribute('aria-label')).toBe('전후 조이스틱');
    expect(stage.querySelector('.dv-stick.h')!.getAttribute('aria-label')).toBe('회전 조이스틱');
    expect(stage.querySelector('.dv-hud')).not.toBeNull();
    expect(stage.querySelector('.dv-sheets')!.querySelectorAll('button')).toHaveLength(4);
    const rule = (css: string, sel: string) => css.match(new RegExp(`(?:^|[}\\n])${sel.replace(/[.()]/g, '\\$&')}\\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule(driveCss, '.dv-stage')).toMatch(/position:relative;.*overflow:hidden/);
    expect(rule(driveCss, '.fh-sheet')).toMatch(/^position:absolute;/);
    expect(driveCss).not.toMatch(/position:\s*fixed/);
    expect(rule(driveCss, '.dv-stick.v')).toBe('left:12px');
    expect(rule(driveCss, '.dv-stick.h')).toBe('right:12px');
    expect(rule(driveCss, '.dv-hud')).toMatch(/^position:absolute;top:8px;left:8px/);
    const head = rule(frameCss, '.fh-head');
    expect(head).toMatch(/position:sticky;top:0;z-index:10/);
    expect(Number(rule(driveCss, '.fh-sheet').match(/z-index:(\d+)/)![1])).toBeLessThan(10);
    expect(frameCss).toMatch(/\.fh\.phone \.fh-head>\.btn\{flex:0 1 auto;min-width:44px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);   // 320 폭: 왼쪽 단추는 줄되 꺾이지 않음(실제 폭은 Chrome 으로 확인)
  });

  // 폰 판별 식(PHONE_Q)을 화면 크기로 계산하는 matchMedia — 320·390 세로, 844×390 가로, PC 1280
  function mountAt(width: number, height: number, coarse: boolean, hash: string) {
    const feat = (f: string) => {
      const [k, v] = f.replace(/[()]/g, '').split(':').map((x) => x.trim());
      return k === 'max-width' ? width <= parseFloat(v) : k === 'max-height' ? height <= parseFloat(v)
        : k === 'pointer' ? (v === 'coarse') === coarse : k === 'orientation' ? (v === 'landscape') === width > height : false;
    };
    const matches = (q: string) => q.split(',').some((p) => p.split(' and ').every(feat));
    mount(true, 'u-kim', hash);
    act(() => root!.unmount()); box.remove();
    window.matchMedia = ((q: string) => ({ matches: matches(q), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-kim')} robots={ROBOTS} />); });
  }
  for (const [wd, ht, coarse] of [[320, 568, true], [390, 844, true], [844, 390, true]] as const) it(`${wd}×${ht}: 폰 틀 — 연결·조종·시트 어디서나 STOP 64 px 머리줄 끝`, () => {
    mountAt(wd, ht, coarse, '#/drive');
    expect(matchMedia(PHONE_Q).matches).toBe(true);
    expect(box.querySelector('.fh.phone')).not.toBeNull();
    expect(box.querySelector('nav')).toBeNull();
    serve(KIM, 'r3', 'r7', 'r1');
    stopReachable();
    click(card('Go2-7').querySelector('button')!);
    stopReachable();
    for (const s of SHEETS) { click(btn(s)); stopReachable(); }
  });
  // [B4] 320 폭에서 연결 글(연결 중·끊김·거부)이 STOP 을 밀어내지 않게: 좁은 폰은 점만(글은 화면 읽기용), 왼쪽 단추·제목은 줄고 STOP 은 안 줄어듦.
  // jsdom 은 배치를 계산하지 않아 규칙·구조를 보고, 실제 상자(STOP 오른쪽 끝 ≤ 320)는 Chrome 실측(PR 본문)
  for (const hash of ['#/drive/r7', '#/history']) for (const link of ['연결 중', '연결 끊김', '연결 거부'] as const) it(`320×568 ${hash} «${link}»: 연결은 점만, STOP 은 머리줄 끝·안 줄어듦`, () => {
    mountAt(320, 568, true, hash);
    if (link !== '연결 중') {
      serve(KIM, 'r3', 'r7', 'r1');
      if (link === '연결 끊김') { w.auto = null; tick(3000); } else act(() => w.drop(4403));
    }
    const dot = $('header .fh-dot');
    expect(dot.querySelector('i')!.getAttribute('aria-hidden')).toBe('true');
    expect(dot.querySelector('.fh-dot-t')!.textContent).toBe(link);   // 화면 읽기는 그대로 «연결 끊김»
    expect(dot.title).toBe(link);
    stopReachable();
    const media = frameCss.match(/@media \(max-width:400px\)\{([^}]*)\{([^}]*)\}\}/)!;
    expect(media[1]).toBe('.fh.phone .fh-dot-t');
    expect(media[2]).toMatch(/position:absolute;width:1px;height:1px;overflow:hidden/);
    expect(frameCss).toMatch(/(^|\n)\.fh-stop\{flex:none;/);
    expect(frameCss).toMatch(/@media \(max-width:360px\)\{\.fh\.phone \.fh-head:has\(>\.btn\) h1\{position:absolute/);
  });

  it('1280×800 PC: 폰 틀 아님, 조종 화면 대신 로봇 탭', () => {
    mountAt(1280, 800, false, '#/drive/r7');
    expect(matchMedia(PHONE_Q).matches).toBe(false);
    expect(box.querySelector('.fh.phone')).toBeNull();
    expect($('main').getAttribute('aria-label')).toBe('로봇');
    expect(box.querySelector('.dv-stick')).toBeNull();
  });
});

// 조종 탭(02 F-TO-01~05) — 가짜 중재기 규칙 + 화면 흐름. 시간은 가짜 시계(vi.useFakeTimers)로 돌린다.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { COOLDOWN_S, FAIL_TEXT, FREE_TEXT, HEARTBEAT_S, REQUEST_S, createFakeDrive, drive, resetDrive } from '../fakeDrive';
import { tabFromHash } from '../menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
function mount(phone: boolean, user: string, hash: string) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App initialUser={user} />); });
}
// 판정은 단조 시계(performance.now): advanceTimersByTime 은 그것도 움직이고, setSystemTime(벽시계)은 움직이지 않는다
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); resetDrive(); });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.useRealTimers(); });

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t)!;
const text = () => box.textContent!;
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const key = (type: 'keydown' | 'keyup', code: string, at: EventTarget = window) => act(() => { at.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true })); });
/** detail 0 = 키보드로 생긴 click, 1 = 마우스·터치 */
const clickWith = (el: Element, detail: number) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); });
const r7 = () => drive.get('r7');
/** 손으로 돌리는 판정 시계: «시간은 지났는데 타이머 콜백은 아직 안 돎»(늦은 콜백·절전 복귀)을 만든다 */
let t = 0;
const clock = () => t;
beforeEach(() => { t = 100000; });

describe('가짜 중재기 — 조종 시작~끝 (F-TO-03)', () => {
  it('받기 → 잠금 상태로 시작 → 잠금 해제 → 중립 확인 → 움직임 → 끝내기(0 + 잠금 + 반납)', () => {
    const d = createFakeDrive(), s = () => d.get('r7');
    expect(d.take('r7', 'u-park')).toBe('TAKEN');
    expect([s().holder, s().latched, s().neutral]).toEqual(['u-park', true, false]);
    d.cmd('r7', 'u-park', [0, 0]); d.cmd('r7', 'u-park', [1, 0]);
    expect([s().neutral, s().axes]).toEqual([false, [0, 0]]);   // 잠금 해제 전 입력 무시(중립도 안 받음)
    d.unlock('r7', 'u-park');
    d.cmd('r7', 'u-park', [1, 0]);
    expect([s().latched, s().neutral, s().axes]).toEqual([false, false, [0, 0]]);   // 중립 전 입력 무시
    d.cmd('r7', 'u-park', [0, 0]);
    d.cmd('r7', 'u-park', [1, 0.5]);
    expect(s().axes).toEqual([1, 0.5]);
    d.cmd('r7', 'u-kim', [0, 1]);                          // 조종권자가 아니면 무시
    expect(s().axes).toEqual([1, 0.5]);
    d.stop('r7', 'u-lee');                                 // STOP 은 누구나 — 다시 잠금 해제 + 중립부터
    expect([s().holder, s().latched, s().axes]).toEqual(['u-park', true, [0, 0]]);
    d.release('r7', 'u-park');
    expect([s().holder, s().latched, s().axes]).toEqual([null, true, [0, 0]]);
  });
  it('운영자는 남의 로봇 받기·요청 불가', () => {
    const d = createFakeDrive();
    expect(d.take('r7', 'u-lee')).toBe('FORBIDDEN');
    expect(d.request('r7', 'u-lee')).toBe('FORBIDDEN');
    expect(d.take('r7', 'u-kim')).toBe('TAKEN');          // 총괄은 됨
  });
  it('시나리오 실행 중이면 일시정지를 받아야 받는다(SF-10)', () => {
    const d = createFakeDrive();
    expect(d.take('r3', 'u-lee')).toBe('RUN_ACTIVE');
    expect(d.take('r3', 'u-lee', true)).toBe('TAKEN');
    expect(d.get('r3').run).toMatchObject({ name: '2층 순찰', step: 3, total: 5, paused: true });
  });
});

describe('가짜 중재기 — 조종권 요청 (F-TO-04)', () => {
  const held = (confirm?: (r: string) => boolean) => createFakeDrive({ r7: { holder: 'u-park', latched: false, neutral: true } }, confirm);
  it('넘기기: 0·잠금 확인 뒤 새 조종권자는 잠금 상태로 시작, 둘 다 알림', () => {
    const d = held();
    d.cmd('r7', 'u-park', [1, 0]);
    expect(d.request('r7', 'u-kim')).toBe('SENT');
    d.respond('r7', 'u-kim', true);                        // 조종권자가 아니면 무시
    expect(d.get('r7').holder).toBe('u-park');
    d.respond('r7', 'u-park', true);
    const s = d.get('r7');
    expect([s.holder, s.latched, s.neutral, s.axes, s.request]).toEqual(['u-kim', true, false, [0, 0], null]);
    expect(s.notice['u-kim']).toContain('조종권을 받았습니다');
    expect(s.notice['u-park']).toContain('조종권을 넘겼습니다');
  });
  it('넘김 실패(정지 확인 실패): 조종권 비움 + 정지 요청 상태 + 둘 다 «정지 확인 실패»', () => {
    const d = held(() => false);
    d.request('r7', 'u-kim');
    d.respond('r7', 'u-park', true);
    const s = d.get('r7');
    expect([s.holder, s.stopCheck, s.latched, s.axes]).toEqual([null, 'failed', false, [0, 0]]);   // 잠금 확정 아님(확인 안 됨)
    expect([s.notice['u-park'], s.notice['u-kim']]).toEqual([FAIL_TEXT, FAIL_TEXT]);
    expect(d.take('r7', 'u-kim')).toBe('TAKEN');   // 다시 받으면 잠금 상태로 시작
    expect([d.get('r7').stopCheck, d.get('r7').latched]).toEqual([null, true]);
  });
  it(`${REQUEST_S} s 응답 없으면 자동 거절 — 기존 조종 유지`, () => {
    const d = held();
    d.request('r7', 'u-kim');
    vi.advanceTimersByTime(REQUEST_S * 1000 - 1);
    expect(d.get('r7').request).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(d.get('r7')).toMatchObject({ holder: 'u-park', latched: false, request: null });
    expect(d.get('r7').notice['u-kim']).toBe('응답이 없어 요청이 끝났습니다.');
  });
  it(`거절·자동 거절 확정 때부터 ${COOLDOWN_S} s 재요청 제한, 대기 요청은 로봇당 1건`, () => {
    const d = held();
    d.request('r7', 'u-kim');
    vi.advanceTimersByTime(4000);
    d.respond('r7', 'u-park', false);
    expect(d.get('r7').notice['u-kim']).toBe('박OO님이 거절했습니다.');
    vi.advanceTimersByTime(COOLDOWN_S * 1000 - 1);
    expect(d.request('r7', 'u-kim')).toBe('COOLDOWN');
    vi.advanceTimersByTime(1);
    expect(d.request('r7', 'u-kim')).toBe('SENT');
    vi.advanceTimersByTime(REQUEST_S * 1000);             // 자동 거절도 제한 시작
    expect(d.request('r7', 'u-kim')).toBe('COOLDOWN');
    const two = held();
    two.request('r7', 'u-kim');
    expect(two.request('r7', 'u-park')).toBe('BUSY');
  });
  it(`조종권자 신호가 ${HEARTBEAT_S} s 끊기면 조종권 비움 + 기다리던 사람에게 «비었습니다»`, () => {
    const d = createFakeDrive();
    d.take('r7', 'u-park');
    d.request('r7', 'u-kim');
    vi.advanceTimersByTime(REQUEST_S * 1000);             // 자동 거절 → 김OO 재요청 제한 중(= 기다리는 사람)
    vi.advanceTimersByTime((HEARTBEAT_S - REQUEST_S) * 1000 - 1);
    expect(d.get('r7').holder).toBe('u-park');
    vi.advanceTimersByTime(1);
    expect(d.get('r7').holder).toBeNull();
    expect(d.get('r7').notice['u-kim']).toBe(FREE_TEXT);
  });
});

describe('조종 화면', () => {
  it('주소 #/drive/<로봇> 은 조종 탭', () => expect(tabFromHash('#/drive/r7', false)).toBe('drive'));

  it('PC 누름 수: 행 → 조종하기 → 조종 시작 = 조종권(3), + 잠금 해제 = 움직일 수 있음(4)', () => {
    mount(false, 'u-kim', '#/fleet');
    click([...box.querySelectorAll('[aria-label="로봇 목록"] button')].find((b) => b.textContent!.includes('Go2-7'))!);
    click(btn('조종하기'));
    expect(location.hash).toBe('#/drive/r7');
    click(btn('조종 시작'));
    expect(r7()).toMatchObject({ holder: 'u-kim', latched: true });
    expect(text()).toContain('조종 중(나)');
    expect(text()).toContain('정지 잠금');
    click(btn('잠금 해제'));
    tick(100);
    expect(text()).toContain('움직일 수 있음');
    key('keydown', 'KeyW'); key('keydown', 'KeyA'); tick(100);   // 동시 입력 두 곳
    expect(r7().axes).toEqual([1, 1]);
    expect(text()).toContain('0.6 m/s');
    key('keyup', 'KeyW'); key('keyup', 'KeyA'); tick(100);
    expect(r7().axes).toEqual([0, 0]);
    click(btn('조종 끝내기'));
    expect(r7()).toMatchObject({ holder: null, latched: true });
  });

  it('PC 탭에 그냥 들어오면 로봇 카드(상태·배터리·조종권자) → [직접 조종]', () => {
    resetDrive({ r7: { holder: 'u-park' } });
    mount(false, 'u-kim', '#/drive');
    expect(text()).toContain('조종할 로봇');
    expect(text()).toContain('박OO님 조종 중');
    click(btn('직접 조종'));
    expect(location.hash).toBe('#/drive/r3');
  });

  it('잠금 해제 전 입력은 무시, 키를 누른 채 해제하면 떼야(중립) 움직임, 후진은 막음', () => {
    mount(false, 'u-park', '#/drive/r7');
    click(btn('조종 시작'));
    key('keydown', 'ArrowUp'); tick(200);
    expect(r7().axes).toEqual([0, 0]);
    click(btn('잠금 해제')); tick(200);
    expect(r7()).toMatchObject({ neutral: false, axes: [0, 0] });
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'ArrowUp'); tick(100);
    expect(text()).toContain('움직일 수 있음');
    key('keydown', 'KeyS'); tick(100);
    expect(r7().axes).toEqual([0, 0]);
    expect(text()).toContain('후진은 아직 지원하지 않습니다');
  });

  it('Space 는 STOP(잠금), 머리줄 STOP 도 같은 로봇', () => {
    mount(false, 'u-park', '#/drive/r7');
    click(btn('조종 시작')); click(btn('잠금 해제')); tick(100);
    key('keydown', 'Space');
    expect(r7()).toMatchObject({ holder: 'u-park', latched: true });
    expect($('[data-band]').textContent).toContain('Go2-7 정지 요청됨');
  });

  it('화면을 숨기면 정지·잠금·반납, 탭을 떠나도 반납', () => {
    mount(false, 'u-park', '#/drive/r7');
    click(btn('조종 시작')); click(btn('잠금 해제')); tick(100);
    key('keydown', 'KeyW'); tick(100);
    expect(r7().axes).toEqual([1, 0]);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    delete (document as { visibilityState?: string }).visibilityState;
    expect(r7()).toMatchObject({ holder: null, latched: true, axes: [0, 0] });
    key('keyup', 'KeyW');
    click(btn('조종 시작'));
    expect(r7().holder).toBe('u-park');
    click($('nav a[href="#/fleet"]'));
    expect(r7()).toMatchObject({ holder: null, latched: true });
  });

  it('요청 창: Enter·Space·키보드 click 은 넘기기를 누르지 않고, Space 는 STOP, 방향키는 조종 — 마우스로만 넘김', () => {
    resetDrive({ r7: { holder: 'u-park', latched: true } });
    mount(false, 'u-park', '#/drive/r7');
    click(btn('잠금 해제')); tick(100);
    act(() => { drive.request('r7', 'u-kim'); });
    expect($('[role="dialog"]').textContent).toContain('총괄 김OO님이 Go2-7 조종권을 요청했습니다. 넘겨주시겠습니까?');
    const give = $('[data-ask="give"]');
    give.focus();
    key('keydown', 'ArrowUp', give); tick(100);
    expect(r7().axes).toEqual([1, 0]);                     // 방향키는 계속 조종
    key('keyup', 'ArrowUp', give);
    key('keydown', 'Enter', give); key('keyup', 'Enter', give);
    clickWith(give, 0);                                     // Enter 가 만든 click
    expect(r7()).toMatchObject({ holder: 'u-park', request: { from: 'u-kim' } });
    key('keydown', 'Space', give); key('keyup', 'Space', give);
    expect(r7()).toMatchObject({ holder: 'u-park', latched: true, request: { from: 'u-kim' } });   // STOP 만, 넘기지 않음
    clickWith(give, 1);
    expect(r7()).toMatchObject({ holder: 'u-kim', latched: true });
    expect(text()).toContain('조종권을 넘겼습니다. 보는 중입니다.');
  });

  it(`요청자: 남은 ${REQUEST_S}초 → 자동 거절 → ${COOLDOWN_S}초 재요청 제한 표시 → 다시 가능`, () => {
    resetDrive({ r7: { holder: 'u-park', latched: true } });
    mount(false, 'u-kim', '#/drive/r7');
    click(btn('조종 시작'));
    expect(text()).toContain('박OO님에게 요청했습니다. (10초)');
    expect(btn('조종 시작').disabled).toBe(true);
    tick(3000);
    expect(text()).toContain('(7초)');
    tick(7000);
    expect(r7().holder).toBe('u-park');
    expect(text()).toContain('응답이 없어 요청이 끝났습니다.');
    expect(text()).toContain('30초 뒤 다시 요청할 수 있습니다.');
    tick(29_000);
    expect(btn('조종 시작').disabled).toBe(true);
    tick(1000);
    expect(btn('조종 시작').disabled).toBe(false);
  });

  it('조종권 비워짐 알림이 요청자 화면에', () => {
    mount(false, 'u-kim', '#/drive/r7');
    act(() => { drive.take('r7', 'u-park'); });
    click(btn('조종 시작'));
    act(() => { drive.release('r7', 'u-park'); });
    expect(text()).toContain(FREE_TEXT);
    expect(btn('조종 시작').disabled).toBe(false);
  });

  it('운영자가 남의 로봇: 조종 시작 비활성 + 이유, STOP·Space 는 된다', () => {
    mount(false, 'u-lee', '#/drive/r7');
    expect(btn('조종 시작').disabled).toBe(true);
    expect($('[aria-label="조종"] [data-why]').textContent).toContain('박OO님의 로봇입니다');
    expect(btn('일시정지')).toBeUndefined();               // 실행 중 시나리오 없음
    click($('[data-stop]'));
    expect(r7().latched).toBe(true);
  });

  it('시나리오 실행 중 조종 시작 → «일시정지됩니다» 확인 → 일시정지 + 조종권', () => {
    mount(false, 'u-lee', '#/drive/r3');
    expect(text()).toContain('시나리오 실행 중: 2층 순찰 3/5');
    click(btn('조종 시작'));
    expect(drive.get('r3').holder).toBeNull();
    expect($('[role="dialog"]').textContent).toContain('시나리오가 일시정지됩니다');
    click(btn('일시정지하고 조종'));
    expect(drive.get('r3')).toMatchObject({ holder: 'u-lee', run: { paused: true } });
    expect(btn('다시 시작').disabled).toBe(true);           // 사람이 조종 중이면 다시 시작 못 함
  });

  it('폰: 조종 탭 바로 조종 화면, 왼쪽 전후·오른쪽 회전 조이스틱, STOP 64px 머리줄 오른쪽 끝', () => {
    mount(true, 'u-park', '#/drive');
    expect($('header').lastElementChild).toBe($('[data-stop]'));
    expect(parseInt($('[data-stop]').style.minHeight)).toBeGreaterThanOrEqual(64);
    click(btn('조종 시작')); click(btn('잠금 해제')); tick(100);
    const fwd = $('[aria-label="전후 조이스틱"]'), turn = $('[aria-label="회전 조이스틱"]');
    expect([fwd.className, turn.className]).toEqual(['dv-stick v', 'dv-stick h']);
    for (const el of [fwd, turn]) el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    act(() => { fwd.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 30 })); });
    act(() => { turn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 60 })); });
    tick(100);
    expect(r7().axes).toEqual([0.5, 1]);                   // 위로 반 = 전진 0.5, 왼쪽 끝 = 왼쪽 회전
    act(() => { fwd.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); turn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); });
    tick(100);
    expect(r7().axes).toEqual([0, 0]);
  });
});

// ── PR #7 검토(Codex) 막는 것 B1~B6 재현 7개 — 검토자 runs/review-pr7.test.tsx 를 같은 조건으로 옮김
describe('PR #7 검토 재현', () => {
  beforeEach(() => { vi.setSystemTime(100000); });
  afterEach(() => { delete (document as { visibilityState?: string }).visibilityState; });
  // 재검토 R2-B1 뒤 판정 시계가 단조 시계라, 검토자의 setSystemTime(111000) 대신 판정 시계를 11 s 진행(타이머는 안 돎 — 같은 조건)
  it('[B1] 타이머 콜백이 늦어도 10 s 지난 요청은 넘기지 않는다', () => {
    const d = createFakeDrive({ r7: { holder: 'u-park', latched: false, neutral: true } }, undefined, clock);
    d.request('r7', 'u-kim'); t = 111000; d.respond('r7', 'u-park', true);
    expect(d.get('r7').holder).toBe('u-park');
  });
  it('[B2] 정지 확인 전에 옛 조종권·입력이 먼저 비워진다', () => {
    let observed: unknown;
    const d = createFakeDrive({ r7: { holder: 'u-park', latched: false, neutral: true, axes: [1, 0] } }, () => {
      observed = { holder: d.get('r7').holder, axes: d.get('r7').axes }; return true;
    });
    d.request('r7', 'u-kim'); d.respond('r7', 'u-park', true);
    expect(observed).toEqual({ holder: null, axes: [0, 0] });
  });
  it('[B2] 정지 확인 실패를 «정지 잠금»으로 보이지 않는다', () => {
    resetDrive({ r7: { holder: 'u-park', latched: false, neutral: true } }, () => false);
    mount(false, 'u-kim', '#/drive/r7');
    act(() => { drive.request('r7', 'u-kim'); drive.respond('r7', 'u-park', true); });
    expect(box.querySelector('.lv-chip')?.textContent).not.toContain('정지 잠금');
  });
  it('[B4] 관제에서 Space 는 고른 로봇을 STOP', () => {
    mount(false, 'u-kim', '#/fleet');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true })); });
    expect(drive.get('r3').latched).toBe(true);
  });
  it('[B3] 요청자 화면이 숨겨진 뒤 넘겨받은 조종권은 바로 반납', () => {
    resetDrive({ r7: { holder: 'u-park', latched: false, neutral: true } });
    mount(false, 'u-kim', '#/drive/r7');
    act(() => { drive.request('r7', 'u-kim'); });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { drive.respond('r7', 'u-park', true); });
    tick(100);
    expect(drive.get('r7').holder).toBeNull();
  });
  it('[B6] 폰에도 뎁스 보기', () => {
    mount(true, 'u-park', '#/drive');
    expect([...box.querySelectorAll('button')].some((b) => b.textContent === '뎁스')).toBe(true);
  });
  it('[B5] 로봇이 정해지지 않은 화면의 STOP 은 첫 로봇을 멈추지 않는다', () => {
    mount(false, 'u-kim', '#/drive');
    act(() => { box.querySelector<HTMLButtonElement>('[data-stop]')!.click(); });
    expect(drive.get('r3').latched).toBe(false);
  });
});

// ── 조정 결정 R2: 지연 콜백·시각 변경·숨김 중 배정·정지 확인 전 입력 차단, B4·B5 보강
describe('시간 기준·넘김 순서 (R2)', () => {
  beforeEach(() => { vi.setSystemTime(100000); });
  afterEach(() => { delete (document as { visibilityState?: string }).visibilityState; });
  const held = (confirm?: (r: string) => boolean) => createFakeDrive({ r7: { holder: 'u-park', latched: false, neutral: true } }, confirm, clock);
  it('지연 콜백: 타이머 없이 마감이 지나면 다음 처리에서 자동 거절 확정, 재요청 제한은 마감 시각부터', () => {
    const d = held();
    d.request('r7', 'u-kim');
    t = 100000 + REQUEST_S * 1000 + 5000;   // 타이머는 아직 안 돎
    expect(d.request('r7', 'u-kim')).toBe('COOLDOWN');
    expect([d.get('r7').request, d.get('r7').notice['u-kim']]).toEqual([null, '응답이 없어 요청이 끝났습니다.']);
    expect(d.get('r7').cooldown['u-kim']).toBe(100000 + (REQUEST_S + COOLDOWN_S) * 1000);
    t = 100000 + (REQUEST_S + COOLDOWN_S) * 1000;
    expect(d.request('r7', 'u-kim')).toBe('SENT');
  });
  it(`지연 콜백: ${HEARTBEAT_S} s 마감이 지난 뒤 늦게 온 입력은 조종권을 늘리지 않는다`, () => {
    const d = createFakeDrive({}, undefined, clock);
    d.take('r7', 'u-park'); d.unlock('r7', 'u-park'); d.cmd('r7', 'u-park', [0, 0]);
    t = 100000 + HEARTBEAT_S * 1000;
    d.cmd('r7', 'u-park', [1, 0]);
    expect([d.get('r7').holder, d.get('r7').axes]).toEqual([null, [0, 0]]);
  });
  it('절전 복귀(20 s 지났고 타이머는 아직): 타이머보다 먼저 넘기기를 눌러도 마감 지난 요청은 넘기지 않는다', () => {
    resetDrive({ r7: { holder: 'u-park', latched: false, neutral: true } }, undefined, clock);
    mount(false, 'u-park', '#/drive/r7');
    act(() => { drive.request('r7', 'u-kim'); });
    t += 20000;
    clickWith($('[data-ask="give"]'), 1);
    expect(r7().holder).not.toBe('u-kim');
    expect(r7().request).toBeNull();
  });
  it('숨김 중 배정 — 반대 순서: 떠난 화면(탭 이동)의 대기 요청은 거둬져 넘김이 일어나지 않는다', () => {
    resetDrive({ r7: { holder: 'u-park', latched: false, neutral: true } });
    mount(false, 'u-kim', '#/drive/r7');
    click(btn('조종 시작'));
    expect(r7().request?.from).toBe('u-kim');
    click($('a[href="#/fleet"]'));
    expect(r7().request).toBeNull();
    act(() => { drive.respond('r7', 'u-park', true); });
    expect(r7().holder).toBe('u-park');
  });
  it('정지 확인 전 입력 차단: 확인 중에 옛·새 조종권자 입력이 모두 버려진다', () => {
    let seen: unknown;
    const d = held(() => { d.cmd('r7', 'u-park', [1, 0]); d.cmd('r7', 'u-kim', [1, 0]); seen = [d.get('r7').stopCheck, d.get('r7').axes]; return true; });
    d.cmd('r7', 'u-park', [1, 0]);
    d.request('r7', 'u-kim'); d.respond('r7', 'u-park', true);
    expect(seen).toEqual(['asked', [0, 0]]);
    expect([d.get('r7').holder, d.get('r7').latched, d.get('r7').stopCheck]).toEqual(['u-kim', true, null]);
  });
  it('정지 확인 중·실패 칩은 «정지 요청됨»·«정지 확인 실패»', () => {
    resetDrive({ r7: { holder: null, latched: false, stopCheck: 'asked' } });
    mount(false, 'u-kim', '#/drive/r7');
    expect($('.lv-chip').textContent).toContain('정지 요청됨');
    act(() => { root?.unmount(); }); box.remove();
    resetDrive({ r7: { holder: 'u-park', latched: false, neutral: true } }, () => false);
    mount(false, 'u-kim', '#/drive/r7');
    act(() => { drive.request('r7', 'u-kim'); drive.respond('r7', 'u-park', true); });
    expect($('.lv-chip').textContent).toContain('정지 확인 실패');
  });
  it('Space STOP 은 수정키가 눌려 있어도 동작(수정키 거름보다 먼저)', () => {
    mount(false, 'u-kim', '#/fleet');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(drive.get('r3').latched).toBe(true);
  });
  it('대상 없는 화면: STOP → 로봇 고르기(내 조종권 로봇이 기본) → 다시 STOP 또는 [정지] = 그 로봇만', () => {
    resetDrive({ r7: { holder: 'u-park', latched: false, neutral: true } });
    mount(false, 'u-park', '#/drive');
    act(() => { $('[data-stop]').click(); });
    expect($<HTMLSelectElement>('select[aria-label="정지할 로봇"]').value).toBe('r7');
    expect([drive.get('r3').latched, r7().latched]).toEqual([false, false]);   // 펼치기만, 아직 아무것도 안 멈춤
    key('keydown', 'Space');
    expect([drive.get('r3').latched, r7().latched]).toEqual([false, true]);
    expect(box.querySelector('[aria-label="정지할 로봇 고르기"]')).toBeNull();
    expect(text()).toContain('Go2-7 정지 요청됨');
  });
  it('대상 없는 화면에서 조종권이 없으면 기본 없음 — 고르기 전에는 [정지]가 눌리지 않는다', () => {
    mount(false, 'u-kim', '#/drive');
    key('keydown', 'Space');
    expect($<HTMLSelectElement>('select[aria-label="정지할 로봇"]').value).toBe('');
    expect(btn('정지').disabled).toBe(true);
    key('keydown', 'Space');
    expect([drive.get('r3').latched, r7().latched]).toEqual([false, false]);
  });
});

// ── 재검토 R2-B1: 만료 판정은 단조 시계 — 벽시계를 바꿔도 15 s 조종권 만료·10 s 요청 마감이 그대로
describe('단조 시계 (R2-B1)', () => {
  beforeEach(() => { vi.setSystemTime(100000); });
  it('시계를 뒤로 돌린 뒤 입력이 오래 없으면 15 s 에 조종권이 빈다(타이머가 사라지지 않음)', () => {
    const d = createFakeDrive();
    d.take('r7', 'u-park'); d.unlock('r7', 'u-park'); d.cmd('r7', 'u-park', [0, 0]); d.cmd('r7', 'u-park', [1, 0]);
    vi.setSystemTime(40000);   // 벽시계 60 s 역보정
    vi.advanceTimersByTime(HEARTBEAT_S * 1000);
    expect([d.get('r7').holder, d.get('r7').axes]).toEqual([null, [0, 0]]);
    vi.advanceTimersByTime(120000);   // 장시간 무입력 뒤에도 비어 있음
    expect(d.get('r7').holder).toBeNull();
  });
  it('시계를 앞으로 돌려도 10 s 요청은 경과 시간으로 판정 — 벽시계 점프로 일찍 끝나지 않는다', () => {
    const d = createFakeDrive({ r7: { holder: 'u-park', latched: false, neutral: true } });
    d.request('r7', 'u-kim');
    vi.setSystemTime(100000 + 60000);
    expect(d.request('r7', 'u-lee')).not.toBe('SENT');
    expect(d.get('r7').request?.from).toBe('u-kim');
    vi.advanceTimersByTime(REQUEST_S * 1000);
    expect(d.get('r7').request).toBeNull();
  });
  it('타이머가 판정 시계보다 이르게 깨면 남은 시간으로 다시 걸어, 마감에 정확히 비운다', () => {
    const d = createFakeDrive({}, undefined, clock);
    d.take('r7', 'u-park');
    vi.advanceTimersByTime(HEARTBEAT_S * 1000);   // 타이머는 돌았지만 판정 시계는 그대로(이른 깸)
    expect(d.get('r7').holder).toBe('u-park');
    t += HEARTBEAT_S * 1000;
    vi.advanceTimersByTime(HEARTBEAT_S * 1000);
    expect(d.get('r7').holder).toBeNull();
  });
});

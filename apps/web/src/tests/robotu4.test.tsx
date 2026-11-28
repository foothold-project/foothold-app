// 로봇 탭(PC) = 시안 u4_1 DOM 그대로(robotu4.tsx). 시안 글 · 칸 순서 · 키 배치 · STOP 늘 보임 · 값 없으면 틀 그대로 「—」.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { FakeWS, lease, state } from './fakeWs';
import { simTune } from '../phone';
import { api } from '../api';
import u4css from '../screens/u4/u4.css?raw';

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
const ORG = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
let settingsMock: { mockRestore(): void };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  settingsMock = vi.spyOn(api, 'settings').mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
});
afterEach(() => { act(() => root?.unmount()); settingsMock.mockRestore(); simTune(null); root = null; box?.remove(); vi.useRealTimers(); });

const $ = (s: string) => box.querySelector<HTMLElement>(s);
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const key = (type: 'keydown' | 'keyup', code: string) => act(() => { window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true })); });
const push = (r: string, p: Partial<ScreenState> = {}) => { st[r] = { ...(st[r] ?? state(r)), ...p }; w.recv(st[r]); };
const rtSock = () => FakeWS.all.filter((x) => x.url.endsWith('/api/v1/ws')).pop()!;
function serve(...ids: string[]) {
  w = rtSock(); st = {};
  w.auto = (m) => {
    w.recv({ t: 'reply', id: m.id, ok: true });
    const r = m.robot as string;
    if (m.t === 'lease.take') { w.recv(lease(r, PARK, `L${m.id}`)); w.recv({ t: 'lease.result', robot: r, request_id: null, result: 'ACCEPTED' }); }
    if (m.t === 'stop' && st[r]) push(r, { latched: true, stop_gen: st[r].stop_gen! + 1 });
    if (m.t === 'lease.release') w.recv(lease(r, null));
  };
  act(() => { w.open(); ids.forEach((id) => push(id)); });
}
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const lastAxes = () => { const a = w.of('cmd'); return (a[a.length - 1]?.axes as number[] | undefined)?.join(); };
/** 조종 시작 → 잠금 풀린 서 있는 로봇 */
function drive() {
  click($('[data-u4-drive="take"]')!);
  act(() => { push('r7', { latched: false }); });
  tick(100);
}

describe('로봇 탭 PC = 시안 u4_1', () => {
  it('시안 틀: 최상위 .pv.u4 · 머리줄 .bar 없음 · 왼쪽 목록 = 「로봇」 제목 + 「로봇 추가」 + 줄(이름 · 작은 글 · 배터리)뿐', () => {
    mount('u-park'); serve('r7');
    const top = $('[data-u4]')!;
    expect(top.className).toBe('pv u4');
    expect(top.querySelector('.bar')).toBeNull();
    const rail = $('.pane.rail')!;
    expect(text(rail.querySelector('.ttl'))).toBe('로봇');
    expect(text(rail.querySelector('.btns.addbtn'))).toBe('로봇 추가');
    const rows = $$('.rail .rcard');
    expect(rows.map((r) => r.getAttribute('data-r'))).toEqual(['Go2-7']);
    expect(rows[0].className).toBe('rcard on');
    expect(text(rows[0].querySelector('small'))).toBe('실제 · 대기');
    expect(text(rows[0].querySelector('.mu2'))).toBe('80 %');
    // 옛 집계 칸 · 담당/상태 고르기 · 경보 묶음은 없다
    expect(rail.querySelector('select')).toBeNull();
    expect(rail.querySelectorAll('.rcard').length + 2).toBe(rail.querySelectorAll('.ttl, .addbtn, .rcard').length);
  });

  it('머리: 이름 · 칩 다섯(연결 · 모드 · 배터리 · 온도 · 조종자) 순서 · 오른쪽 탭 조종 · 점검 · 로봇 설정', () => {
    mount('u-park'); serve('r7');
    const hdr = $('.hdr')!;
    expect(text(hdr.querySelector('.ttl'))).toBe('Go2-7');
    expect($$('.hdr .st').map((s) => s.getAttribute('data-cell'))).toEqual(['link', 'mode', 'battery', 'temp', 'holder']);
    expect($$('.hdr .st small').map(text)).toEqual(['—', 'Shift + 1 ~ 4', '—', '최고 관절 온도', '조종자']);
    expect(text($('[data-cell="mode"]'))).toMatch(/^Sport/);
    expect(text($('[data-cell="battery"]'))).toMatch(/^80 %/);
    expect(text($('[data-cell="holder"]'))).toMatch(/^—/);
    expect($$('.hdr .seg2 span').map(text)).toEqual(['조종', '점검', '로봇 설정']);
    act(() => { push('r7', { control: 'LOWLEVEL' } as Partial<ScreenState>); });
    expect(text($('[data-cell="mode"]'))).toMatch(/^START/);
  });

  it('가운데 3D · 아래 알약 · 오른쪽 보기(지도 · 카메라 · 라이다 · 깊이) · 작은 칸 · 정지 Space · 키 줄 · 동작 일곱 · 글은 시안 그대로', () => {
    mount('u-park'); serve('r7');
    expect($('.stage3d canvas#go2')).not.toBeNull();
    expect(text($('.stage3d .hint'))).toBe('끌어서 돌려 보기');
    expect(text($('.stage3d .foot .mu2'))).toBe('실제 관절값으로 제자리에서 움직임 · 바닥 점이 뒤로 흐르면 앞으로 걷는 중');
    expect(text($('[data-u4-walk]'))).toBe('서 있음');
    expect($$('.views .vsel span').map(text)).toEqual(['지도', '카메라', '라이다', '깊이']);
    expect(text($('.views .small .cl'))).toBe('앞 카메라');
    expect(text($('.views .vstop'))).toBe('정지Space');
    expect(text($('.ctl .keys'))).toBe('↑앞으로 ←→돌기 ↓뒤로는 막힘 Space정지 Shift1~4모드'.replace(/ /g, ''));
    expect($$('.deck .stick').length).toBe(2);
    expect($$('.deck .act > div').map((d) => d.childNodes[1].textContent)).toEqual(['앉기', '일어서기', '엎드리기', '기지개', '악수', '하트', '인사']);
    expect($$('.deck .act > div em').map(text)).toEqual(['R1+B', 'L2+A', 'L2+A', 'R2+A', 'R2+B', 'R2+Y', '순정 확인 전']);
    click($$('.views .vsel span')[1]);
    expect($('[data-u4-big="rgb"]')).not.toBeNull();
    expect(text($('.views .small .cl'))).toBe('지도');
  });

  it('STOP 은 늘 보인다: 조종 전 · 조종 중 · 정지 잠금 · 연결 끊김. 누르면 이 로봇 정지 요청', () => {
    mount('u-park'); serve('r7');
    expect($('.views .vstop')).not.toBeNull();
    drive();
    expect($('.views .vstop')).not.toBeNull();
    act(() => { $('.views .vstop')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 } as PointerEventInit)); });
    expect(w.of('stop').some((m) => m.robot === 'r7')).toBe(true);
    expect($('.views .vstop')).not.toBeNull();
    act(() => { push('r7', { connection: 'OFFLINE' }); });
    expect($('.views .vstop')).not.toBeNull();
  });

  it('키는 시안 글대로: ↑ · W 앞으로 · ← → · A D 돌기 · ↓ · S 는 보내지 않고 까닭', () => {
    mount('u-park'); serve('r7'); drive();
    expect(text($('[data-u4-drive]'))).toBe('조종 중');
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0');
    key('keyup', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('0,0');
    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toBe('1.5,0'); key('keyup', 'KeyW'); tick(60);
    key('keydown', 'ArrowLeft'); tick(60); expect(Number(lastAxes()!.split(',')[1])).toBeGreaterThan(0); key('keyup', 'ArrowLeft'); tick(60);
    key('keydown', 'KeyD'); tick(60); expect(Number(lastAxes()!.split(',')[1])).toBeLessThan(0); key('keyup', 'KeyD'); tick(60);
    key('keydown', 'ArrowDown'); tick(60); expect(lastAxes()).toBe('0,0');
    expect(text($('[data-u4-why]'))).toBe('후진은 아직 지원하지 않습니다');
    key('keyup', 'ArrowDown');
    key('keydown', 'KeyS'); tick(60); expect(lastAxes()).toBe('0,0'); key('keyup', 'KeyS');
  });

  it('동작 단추: 조종 전이면 까닭만 · 조종 중이면 서버로 그 동작 하나 · START 중 일어서기는 시안 까닭', () => {
    mount('u-park'); serve('r7');
    click($('[data-u4-act="Sit"]')!);
    expect(text($('[data-u4-why]'))).toBe('조종 시작 후 사용할 수 있습니다.');
    expect(w.of('action').length).toBe(0);
    drive();
    click($('[data-u4-act="Sit"]')!);
    expect(w.of('action').map((m) => m.action)).toEqual(['Sit']);
    act(() => { push('r7', { control: 'LOWLEVEL' } as Partial<ScreenState>); });
    expect($('[data-u4-act="StandUp"]')!.className).toBe('no');
    click($('[data-u4-act="StandUp"]')!);
    expect(text($('[data-u4-why]'))).toBe('START 에서는 일어서기를 보낼 수 없습니다 · 앉은 뒤 「앉기」 를 다시 누르면 일어납니다');
    expect(w.of('action').map((m) => m.action)).toEqual(['Sit']);
  });

  it('로봇 0대: 시안 틀(목록 제목 · 추가 · 머리 칩 다섯 · 칸)은 그대로, 값만 「—」', () => {
    mount('u-park', []);
    expect($('[data-u4]')).not.toBeNull();
    expect(text($('.rail .ttl'))).toBe('로봇');
    expect(text($('.hdr .ttl'))).toBe('—');
    expect($$('.hdr .st').length).toBe(5);
    expect($('.stage3d')).not.toBeNull(); expect($('.views')).not.toBeNull();
  });

  it('화면 css 는 시안 u4 <style> 값 그대로에 .u4 한 겹', () => {
    expect(u4css).toContain('.u4 .rail{left:24px;top:88px;width:250px;bottom:24px;padding:16px 10px}');
    expect(u4css).toContain('.u4 .views{position:absolute;left:0;right:0;top:0;height:600px;');
    expect(u4css).toContain('.u4 .deck{position:absolute;left:0;right:0;bottom:0;top:682px;');
  });
});

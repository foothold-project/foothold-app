// 로봇 탭(PC) = 시안 u4_1 DOM 그대로(robotu4.tsx). 시안 글 · 칸 순서 · 키 배치 · STOP 늘 보임 · 값 없으면 틀 그대로 글을 비우거나 「없음」.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { FakeWS, lease, state } from './fakeWs';
import { simTune } from '../phone';
import { SIDE_BLOCK, axesOf, canDrive, tokStick } from '../serverdrive';
import { deadzone, keyStick, stickVelocity, teleopCaps } from '../../../contracts/teleop';
import { keyAxes } from '../simdrive';
import { barChipText, checkShort, driveLabel, hotBub, jointTip, railOrder } from '../screens/u4/robotu4';
import { rt } from '../rt';
import { api } from '../api';
import u4css from '../screens/u4/u4.css?raw';
import u4src from '../screens/u4/robotu4.tsx?raw';
import { WALK_MIN_SPEED } from '../proto/u5';

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
    expect(top.className).toBe('proto u4');
    expect(top.querySelector('.bar')).toBeNull();
    const rail = $('.pane.rail')!;
    expect(text(rail.querySelector('.ttl'))).toBe('로봇');
    expect(text(rail.querySelector('.btns.addbtn'))).toBe('로봇 추가');
    const rows = $$('.rail .rcard');
    expect(rows.map((r) => r.getAttribute('data-r'))).toEqual(['Go2-7', 'Go2-3', 'Go2-1']);
    expect(rows.map((r) => r.className)).toEqual(['rcard on', 'rcard ', 'rcard ']);
    expect(rows.map((r) => text(r.querySelector('small')))).toEqual(['실제 · 대기', '실제 · 2층 순찰 3/5 중', '실제 · 정지 잠금']);
    expect(rows.map((r) => text(r.querySelector('.mu2')))).toEqual(['80 %', '82 %', '없음']);
    click(rows[1]); expect($('.rail .rcard.on')!.getAttribute('data-r')).toBe('Go2-3');
    // 옛 집계 칸 · 담당/상태 고르기 · 경보 묶음은 없다
    expect(rail.querySelector('select')).toBeNull();
    expect(rail.querySelectorAll('.rcard').length + 2).toBe(rail.querySelectorAll('.ttl, .addbtn, .rcard').length);
  });

  it('머리: 이름 · 칩 다섯(연결 · 모드 · 배터리 · 온도 · 조종자) 순서 · 오른쪽 탭 조종 · 점검 · 로봇 설정', () => {
    mount('u-park'); serve('r7');
    const hdr = $('.hdr')!;
    expect(text(hdr.querySelector('.ttl'))).toBe('Go2-7');
    expect($$('.hdr .st').map((s) => s.getAttribute('data-cell'))).toEqual(['link', 'mode', 'battery', 'temp', 'holder']);
    expect($$('.hdr .st small').map(text)).toEqual(['', 'Shift + 1 ~ 4', '', '최고 관절 온도', '조종자']);   // 왕복 ms · 남은 시간은 서버 값이 없어 비움
    expect(text($('[data-cell="mode"]'))).toMatch(/^없음/);   // 걷기 모드 보고(state.gait) 전 = 모름
    act(() => { push('r7', { gait: { gait: 'sport', available: ['classic', 'sport', 'start', 'ame2'] } } as Partial<ScreenState>); });
    expect(text($('[data-cell="mode"]'))).toMatch(/^Sport/);
    expect(text($('[data-cell="battery"]'))).toMatch(/^80 %/);
    expect(text($('[data-cell="holder"]'))).toMatch(/^없음/);
    expect($$('.hdr .seg2 span').map(text)).toEqual(['조종', '점검', '로봇 설정']);
    act(() => { push('r7', { gait: { gait: 'start', available: ['classic', 'sport', 'start', 'ame2'] } } as Partial<ScreenState>); });
    expect(text($('[data-cell="mode"]'))).toMatch(/^START/);
  });

  it('관절값 없는 로봇: speed ≥ WALK_MIN_SPEED(관제 타일과 같은 문턱)면 다리를 걷기 꼴로, 0 이면 선 자세 · 관절값 · 엎드림이 이김', () => {
    mount('u-park'); serve('r7');
    const legs = () => $('.stage3d')!.getAttribute('data-u4-legs'), note = () => $('[data-u4-jointnote]')!;
    act(() => { push('r7', { speed: 0.3, posture: { state: 'STANDING' } } as unknown as Partial<ScreenState>); });
    expect(legs()).toBe('walk');
    expect([note().getAttribute('data-u4-jointnote'), text(note())]).toEqual(['walk', '관절값이 없어 걷는 속도로 걷기 꼴을 그림']);
    expect(text($('[data-u4-walk]'))).toContain('걷는 중 · 0.3 m/s');
    act(() => { push('r7', { speed: WALK_MIN_SPEED - 0.01 }); }); expect(legs()).toBe('stand');
    act(() => { push('r7', { speed: WALK_MIN_SPEED }); }); expect(legs()).toBe('walk');
    act(() => { push('r7', { speed: 0 }); });
    expect(legs()).toBe('stand'); expect(text($('[data-u4-walk]'))).toBe('서 있음');
    act(() => { push('r7', { speed: 0.3, posture: { state: 'LYING' } } as unknown as Partial<ScreenState>); }); expect(legs()).toBe('down');
    const N = ['FR', 'FL', 'RR', 'RL'].flatMap((l) => ['hip', 'thigh', 'calf'].map((p) => `${l}_${p}_joint`));
    act(() => { push('r7', { robot_info: { joints: { names: N, positions: N.map(() => 0.5), age_s: 0 } } } as unknown as Partial<ScreenState>); });
    expect(legs()).toBe('q');
    expect(u4src).not.toMatch(/sp < 0\.05/);   // 로봇 탭 안의 따로 둔 문턱은 없음
  });

  it('고른 시뮬 카드도 파랑: .rcard.on.rehearse 가 고른 칸 초록을 덮음(어둠 #4C9BFF · 밝음 #2F6FE0)', () => {
    const flat = u4css.replace(/\s+/g, ' ');
    expect(flat).toContain('.proto .u4 .rcard.on.rehearse{background:rgba(76,155,255,.10);border:1px dashed #4C9BFF}');
    expect(flat).toContain('.proto .u4 .rcard.on.rehearse .av{background:#4C9BFF;color:#fff}');
    expect(flat).toContain('.proto.light .u4 .rcard.on.rehearse .av{background:#2F6FE0;color:#FFFFFF}');
  });

  it('가운데 3D · 아래 알약 · 오른쪽 보기(지도 · 카메라 · 라이다 · 깊이) · 작은 칸 · 정지 Space · 키 줄 · 동작 일곱 · 글은 시안 그대로', () => {
    mount('u-park'); serve('r7');
    expect($('.stage3d canvas#go2')).not.toBeNull();
    expect(text($('.stage3d .hint'))).toBe('끌어서 돌려 보기');
    // 3D 칸 아래 안내는 받은 값 그대로(팀장 11-28 19:17): 관절값 없음 → 서기 · posture LYING → 자세 값 · 관절값 → 실제 관절값
    const note = () => $('[data-u4-jointnote]')!;
    expect([note().getAttribute('data-u4-jointnote'), text(note())]).toEqual(['none', '관절값을 받지 않아 서 있는 모양 그대로']);
    act(() => { push('r7', { posture: { state: 'LYING' } } as unknown as Partial<ScreenState>); });
    expect([note().getAttribute('data-u4-jointnote'), text(note())]).toEqual(['posture', '관절값이 없어 자세 값(엎드림)으로 그림']);
    const N = ['FR', 'FL', 'RR', 'RL'].flatMap((l) => ['hip', 'thigh', 'calf'].map((p) => `${l}_${p}_joint`));
    act(() => { push('r7', { robot_info: { joints: { names: N, positions: N.map(() => 0.5), age_s: 0 } } } as unknown as Partial<ScreenState>); });
    expect([note().getAttribute('data-u4-jointnote'), text(note())]).toEqual(['q', '실제 관절값으로 제자리에서 움직임 · 바닥 점이 뒤로 흐르면 앞으로 걷는 중']);
    act(() => { push('r7', { posture: { state: 'STANDING' }, robot_info: {} } as unknown as Partial<ScreenState>); });
    expect(text($('[data-u4-walk]'))).toBe('서 있음');
    expect($$('.views .vsel span').map(text)).toEqual(['지도', '카메라', '라이다', '깊이']);
    expect(text($('.views .small .cl'))).toBe('앞 카메라');
    expect(text($('.views .vstop'))).toBe('정지Space');
    expect($('.ctl .keys')!.textContent).toBe('↑앞↓뒤←→옆AD돌기↑AD돌며 앞Space정지1~4화면⇧1~4모드');   // 한 줄에 맞게 짧은 말 · 긴 뜻은 title(조정 20:07)
    expect($$('.ctl .keys > span').map((x) => x.title)).toEqual(['앞으로 걷기', '뒤로 걷기', '옆걸음', '제자리 돌기', '↑ 와 A 또는 D 를 같이 누르면 앞으로 가며 돕니다', '정지', '보기 칸 바꾸기', 'Shift + 1 ~ 4 걷기 모드']);   // 팀장 11-28 17:25 키 배치(시안 Q E 줄은 바뀜)
    expect($$('.ctl .keys kbd').map(text)).toEqual(['↑', '↓', '←', '→', 'A', 'D', '↑', 'A', 'D', 'Space', '1', '4', '⇧', '1', '4']);
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
    click($('.views .vstop')!);
    expect(w.of('stop').filter((m) => m.robot === 'r7').length).toBe(1);
    // 시안 u4_9 정지됨: 정지 칸 자리에 「다시 시작」 · 「Damping」, 조종 줄 · 손잡이 흐림, 위에 「정지됨」. Space 정지는 그대로 나간다
    expect($('.views .vstop')).toBeNull();
    expect(text($('[data-u4-restart]'))).toBe('다시 시작Damping엎드려 힘 빼기');
    expect(text($('[data-u4-stopped]'))).toBe('정지됨 · 한 번 더 누르면 엎드려 힘을 뺍니다');
    expect($('.ctl')!.className).toBe('ctl dim'); expect($('.deck')!.className).toBe('deck joybig dim');
    key('keydown', 'Space'); key('keyup', 'Space');
    expect(w.of('stop').filter((m) => m.robot === 'r7').length).toBe(2);
    // 다시 시작 = 잠금 해제 요청 → 해제 대기 → 풀리면 정지 칸이 다시
    click($('[data-u4-unlock]')!); click($('[data-u4-restart-go]')!);   // 시안 u4_10 확인 창 뒤
    expect(w.of('unlock').map((m) => m.robot)).toEqual(['r7']);
    expect(text($('[data-u4-stopped]'))).toBe('해제 대기 · 로봇이 정지를 확인하면 풀립니다.');
    tick(3000);
    expect(text($('[data-u4-stopped]'))).toMatch(/^미확인 · 로봇이 정지 확인을 못 해 잠금이 그대로입니다/);
    act(() => { push('r7', { latched: false }); });
    expect($('.views .vstop')).not.toBeNull(); expect($('[data-u4-stopped]')).toBeNull();
    act(() => { push('r7', { connection: 'OFFLINE' }); });
    expect($('.views .vstop')).not.toBeNull();
  });

  it('조종권을 쥔 동안은 입력이 없어도 명령(0)을 끊김 없이 보낸다 · 서버 15 초 heartbeat 안쪽', () => {
    mount('u-park'); serve('r7'); drive();
    const n0 = w.of('cmd').length;
    tick(15000);
    expect(w.of('cmd').length - n0).toBeGreaterThanOrEqual(15000 / 50 - 2);
    expect(lastAxes()).toBe('0,0,0');
  });

  // 키 배치(팀장 11-28 17:25): ↑ · W 앞 · ↓ · S 뒤 · ← → 옆걸음 · A D 돌기 · Q E 는 아무 동작 없음. 떼면 0 · 창 흐림에 0
  it('키 뜻: ↑ · W 앞으로 · ↓ · S 뒤로 · ← → 옆걸음 · A D 돌기 · Q E 없음 · 창 흐림이면 0', () => {
    mount('u-park'); serve('r7'); drive();
    expect(text($('[data-u4-drive]'))).toBe('조종 중');
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    key('keyup', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toBe('1.5,0,0'); key('keyup', 'KeyW'); tick(60);
    key('keydown', 'KeyA'); tick(60); expect(Number(lastAxes()!.split(',')[2])).toBeGreaterThan(0); expect(lastAxes()!.split(',').slice(0, 2)).toEqual(['0', '0']); key('keyup', 'KeyA'); tick(60); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'KeyD'); tick(60); expect(Number(lastAxes()!.split(',')[2])).toBeLessThan(0); key('keyup', 'KeyD'); tick(60); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'ArrowDown'); tick(60); expect(lastAxes()).toBe('-1.5,0,0'); key('keyup', 'ArrowDown'); tick(60);
    key('keydown', 'KeyS'); tick(60); expect(lastAxes()).toBe('-1.5,0,0'); key('keyup', 'KeyS'); tick(60);
    key('keydown', 'ArrowLeft'); tick(60); expect(Number(lastAxes()!.split(',')[1])).toBeGreaterThan(0); expect(lastAxes()!.split(',')[2]).toBe('0'); key('keyup', 'ArrowLeft'); tick(60); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'ArrowRight'); tick(60); expect(Number(lastAxes()!.split(',')[1])).toBeLessThan(0); expect(lastAxes()!.split(',')[2]).toBe('0'); key('keyup', 'ArrowRight'); tick(60); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'ArrowUp'); key('keydown', 'KeyA'); tick(60); { const [x, y, z] = lastAxes()!.split(',').map(Number); expect([x, y]).toEqual([1.5, 0]); expect(z).toBeGreaterThan(0); }   // ↑+A = 앞으로 가며 돌기(키 줄 안내와 같음)
    key('keyup', 'KeyA'); key('keyup', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'KeyQ'); tick(60); expect(lastAxes()).toBe('0,0,0'); key('keyup', 'KeyQ'); tick(60);   // Q · E 는 뺌
    key('keydown', 'KeyE'); tick(60); expect(lastAxes()).toBe('0,0,0'); key('keyup', 'KeyE'); tick(60);
    key('keydown', 'ArrowRight'); tick(60); expect(Number(lastAxes()!.split(',')[1])).toBeLessThan(0);
    act(() => { window.dispatchEvent(new Event('blur')); }); tick(60); expect(lastAxes()).toBe('0,0,0');   // 창 흐림 = 0
    key('keyup', 'ArrowRight'); tick(60);
    expect(lastAxes()).toBe('0,0,0');
  });

  it('Damping 두 번 누르기: 페이지 연 직후(시계 3 초 안) 한 번 누름은 Damp 를 보내지 않고 안내만 · 3 초 안 두 번째에 하나', () => {
    mount('u-park'); serve('r7'); drive();
    click($('.views .vstop')!);
    expect(performance.now()).toBeLessThan(3000);   // 페이지 시계가 막 시작된 때(옛 처음 값 0 이면 여기서 바로 Damp)
    click($('[data-u4-damp]')!);
    expect(w.of('action').filter((m) => m.action === 'Damp')).toHaveLength(0);
    expect(text($('[data-u4-why]'))).toBe('한 번 더 누르면 엎드려 힘을 뺍니다');
    tick(500);
    click($('[data-u4-damp]')!);
    expect(w.of('action').filter((m) => m.action === 'Damp')).toHaveLength(1);
  });

  it('Damping: 한 번 누른 뒤 단추가 사라졌다가(정지 풀림) 3 초 안에 다시 나타나면 첫 누름은 안내만 (검토 00:41)', () => {
    mount('u-park'); serve('r7'); drive();
    click($('.views .vstop')!);
    tick(4000);
    click($('[data-u4-damp]')!);
    expect(w.of('action').filter((m) => m.action === 'Damp')).toHaveLength(0);
    act(() => { push('r7', { latched: false }); });
    expect($('[data-u4-damp]')).toBeNull();
    act(() => { push('r7', { latched: true }); });
    tick(500);
    click($('[data-u4-damp]')!);
    expect(w.of('action').filter((m) => m.action === 'Damp')).toHaveLength(0);
    click($('[data-u4-damp]')!);
    expect(w.of('action').filter((m) => m.action === 'Damp')).toHaveLength(1);
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

  it('로봇 0대: 시안 틀(목록 제목 · 추가 · 머리 칩 다섯 · 칸)은 그대로, 값만 「없음」', () => {
    mount('u-park', []);
    expect($('[data-u4]')).not.toBeNull();
    expect(text($('.rail .ttl'))).toBe('로봇');
    expect(text($('.hdr .ttl'))).toBe('로봇 없음');
    expect($$('.hdr .st').map(text)).toEqual(['없음연결', '없음모드', '없음배터리', '없음최고 관절 온도', '없음조종자']);
    expect($$('.hdr .st').length).toBe(5);
    expect($('.stage3d')).not.toBeNull(); expect($('.views')).not.toBeNull();
  });

  it('화면 css 는 시안 u4 <style> 값 그대로에 .u4 한 겹', () => {
    expect(u4css).toContain('.u4 .rail{left:24px;top:88px;width:250px;bottom:24px;padding:16px 10px}');
    expect(u4css).toContain('.u4 .views{position:absolute;left:0;right:0;top:0;height:600px;');
    expect(u4css).toContain('.u4 .deck{position:absolute;left:0;right:0;bottom:0;top:682px;');
  });

  it('5195 사진에서 찾은 두 가지(11/28 20:1x): 밝은 판 보기 고르기 글자(흰 글자라 안 보였음) · 라이다 높이 범례는 정지 단추 뒤가 아니라 왼쪽 위', () => {
    expect(u4css).toContain('.proto.light .u4 .views .vsel span{color:#5E6662}');
    expect(u4css).toContain('.proto.light .u4 .views .vsel span.on{background:#1F2421;color:#FFFFFF}');   // 고른 칸 = 시안 밝은 판 seg2 고른 칸(light.pv.css)과 같음
    expect(u4css).toContain('.u4 .mapv[data-u4-big="lidar"] [data-height-legend]{right:auto;bottom:auto;left:16px;top:96px}');
  });
});

describe('점검 탭 값 = 시안 u4_4 짧은 꼴', () => {
  it('받은 값만 짧게(연결됨 · 켜짐 · 서버 값 없음 · 배터리 % · 최고 관절 온도) · 긴 까닭은 줄이지 않고 title 로', () => {
    const r = { battery: 71.6024, robotInfo: { temperature: { joints: Array.from({ length: 12 }, (_, i) => (i === 0 ? 48.4 : 30)), age_s: 0 } } } as unknown as Robot;
    expect(checkShort('server', 'ok', '이 화면이 관제 서버와 연결되어 있습니다.', r)).toBe('연결됨');
    expect(checkShort('agent', 'ok', '로봇 상태를 받고 있습니다.', r)).toBe('켜짐 · 상태 받는 중');
    expect(checkShort('wifi', 'none', '에이전트가 붙은 Wi-Fi 이름은 서버가 아직 보내지 않습니다.', r)).toBe('서버 값 없음');
    expect(checkShort('sensors', 'none', '카메라 · 라이다 목록을 받지 못했습니다.', r)).toBe('목록 없음');
    expect(checkShort('body', 'none', '로봇이 연결되어 있지 않아 지금 값이 없습니다.', r)).toBe('지금 값 없음');
    expect(checkShort('power', 'none', '배터리 72 % · 관절 값 없음 · …', r)).toBe('72 % · 최고 관절 온도 48 °C');
  });
});

describe('로봇 탭 보기 칸 · 지도 경로 · 시뮬 시점(서버 값만)', () => {
  const V = { id: 'v1', floor_id: 'f1', number: 3, upload_id: 'u', base_version_id: null, copied_from_id: null, status: 'APPROVED', image_sha256: 'x',
    width: 3200, height: 2000, resolution: 1 / 3.5, origin: [-25 / 3.5, -1980 / 3.5, 0], features: { zones: [], waypoints: [], connectors: [], edits: [] },
    reason: '', source: 'IMPORT', created_by: 'u', created_at: '2026-11-25T09:00:00Z' };
  const WP = (x: number, y: number, name: string, vid = 'v1') => ({ floor_id: 'f1', map_version_id: vid, x, y, mission_id: 'm', mission_version: 1, name });
  const RUN = { id: 'run1', status: 'MOVING' as const, scenario_name: '공정 순찰 A', progress: { done: 1, total: 4 } };
  const ASG = (id: string) => ({ id, status: 'ACTIVE', scenario_id: 's1', scenario_version: 2, effective_scenario_version: 2, scenario_name: '공정 순찰 A', robot_id: 'r7' });
  const spies: { mockRestore(): void }[] = [];
  const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  function board(asg: object[], wps: object[]) {
    spies.push(vi.spyOn(api, 'version').mockResolvedValue(V as never), vi.spyOn(api, 'assignments').mockResolvedValue(asg as never),
      vi.spyOn(api, 'plan').mockResolvedValue({ waypoints: wps } as never));
  }
  afterEach(() => { spies.splice(0).forEach((x) => x.mockRestore()); });
  const LOC = { floor_id: 'f1', map_version_id: 'v1', x: 30, y: -60, yaw: 0, confidence: 1, updated_at: '2026-11-28T00:00:00Z' };
  const withRun = () => ON.map((r) => (r.id === 'r7' ? { ...r, run: RUN } : r));

  it('기본 화면 글 · 읽어 주는 이름에 em dash 없음', () => {
    mount('u-park'); serve('r7');
    const top = $('[data-u4]')!;
    expect(top.textContent).not.toContain('—');
    expect([...top.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join()).not.toContain('—');
  });

  it('보기만 하는 로봇: 카메라 작은 칸 · 라이다 · 깊이 = 「… 신호 없음 · 까닭」, 시뮬 시점 표지 없음', () => {
    mount('u-park'); serve('r7', 'r3');
    click($$('.rail .rcard').find((x) => x.getAttribute('data-r') === 'Go2-3')!);
    expect(text($('.views .small [data-sd-cam]'))).toBe('카메라 신호 없음 · 보기만 하는 로봇이라 영상을 받지 않습니다');
    expect($('[data-u4-simtag]')).toBeNull();
    click($('[data-view="lidar"]')!);
    expect(text($('[data-u4-big="lidar"]'))).toContain('라이다 신호 없음 · 보기만 하는 로봇이라 영상을 받지 않습니다');
    click($('[data-view="depth"]')!);
    expect(text($('[data-u4-big="depth"] [data-sd-depth]'))).toBe('뎁스 카메라 신호 없음 · 보기만 하는 로봇이라 영상을 받지 않습니다');
  });

  it('라이다 · 깊이 보기(11/28): 라이다 칸 왼쪽 위 「3D · 상자 · 위에서」 단추 없음(.vsel 뒤에 가려졌던 것) · 깊이는 drive-media/depth 를 받아 그림 + 범례', () => {
    mount('u-park'); serve('r7');
    const sock = (ch: string) => FakeWS.all.filter((x) => x.url.endsWith(`/api/v1/robots/r7/drive-media/${ch}`)).pop();
    click($('[data-view="lidar"]')!);
    expect(sock('lidar')).toBeTruthy();
    expect($('[data-u4-big="lidar"] [data-lidar-map]')).not.toBeNull();
    expect($('[data-u4-big="lidar"] [data-lm-view]')).toBeNull();
    click($('[data-view="depth"]')!);
    const d = sock('depth')!;
    expect(d).toBeTruthy(); expect(sock('lidar')!.readyState).toBe(3);   // 라이다는 닫힘 · 보이는 칸만 받음
    act(() => { d.open(); d.recv({ t: 'media.video', version: 'media/1', channel: 'depth', robot: 'r7', epoch: 1, episode_id: null, seq: 1, source: 'go2_depth', mime: 'image/jpeg', jpeg: 'BBBB', width: 160, height: 90, depth_min_m: 0.2, depth_max_m: 5 }); });
    const pic = $('[data-u4-big="depth"] [data-sd-depth]')!;
    expect(pic.tagName).toBe('IMG'); expect(pic.getAttribute('src')).toBe('data:image/jpeg;base64,BBBB');
    expect(text($('[data-u4-big="depth"] [data-sd-depth-legend]'))).toContain('멀리 5.0 m');
    expect(d.sent.length).toBe(0);   // 받기만
  });

  it('임무 없음 · 위치 없음: 임무 칸 「임무 없음」 + 빈 줄 · 막대 0 · 지도 이름 「지도 없음」 · 경로 없음', () => {
    mount('u-park'); serve('r7');
    expect(text($('[data-u4-job] b'))).toBe('임무 없음'); expect(text($('[data-u4-job] span'))).toBe('');
    expect($('[data-u4-job] em')!.style.width).toBe('0%');
    expect(text($('[data-u4-mapname]'))).toBe('지도 없음');
    expect($$('[data-u4-wp]').length).toBe(0);
  });

  it('배정 하나 = 경로: 끝낸 길 · 남은 길 · 지점 번호 · 다음 지점 · 남은 직선 거리 · 지도 판 날 · 시뮬 시점 표지', async () => {
    board([ASG('a1')], [WP(10, -60, '밸브 확인'), WP(60, -60, '게이지 읽기'), WP(60, -100, '탱크'), WP(90, -100, '출구')]);
    mount('u-park', withRun()); serve('r7');
    act(() => { push('r7', { location: LOC } as Partial<ScreenState>); });
    await flush();
    expect($$('[data-u4-wp]').map((g) => `${g.getAttribute('data-u4-wp')}${g.hasAttribute('data-done') ? '+' : ''}`)).toEqual(['1+', '2', '3', '4']);
    expect($('[data-u4-route="done"]')).not.toBeNull(); expect($('[data-u4-route="left"]')).not.toBeNull();
    expect(text($('[data-u4-job] b'))).toBe('공정 순찰 A');
    expect(text($('[data-u4-job] span'))).toBe('할 일 2 / 4 · 게이지 읽기로 가는 중 · 남은 직선 약 100 m');   // 30 → 60 (30) + 40 + 30
    expect($('[data-u4-job] em')!.style.width).toBe('25%');
    expect(text($('[data-u4-mapname]'))).toBe('지도 2026-11-25');
    expect(vi.mocked(api.assignments).mock.calls.map((x) => x[0])).toEqual(['r7']);
    expect(vi.mocked(api.plan).mock.calls.map((x) => x.slice(0, 3))).toEqual([['scenarios', 's1', 2]]);
    // 앞 카메라 작은 칸: 영상이 없고 서버 위치 · 공장 좌표계 판이 있으니 시뮬 시점(시험 브라우저에는 WebGL 이 없어 까닭만) · 표지는 늘
    expect(text($('[data-u4-simtag]'))).toBe('시뮬 시점');
    expect(text($('.views .small [data-sd-cam]'))).toBe('카메라 신호 없음 · 이 브라우저는 3D 를 그리지 못합니다');
  });

  it('큰 무대(팀장 23:48) = 늘 정면 · 임무 중에도 현장 꼴 없음 · 바닥 표시는 가용 판정(충전 · 점검) 그대로', async () => {
    board([ASG('a1')], [WP(10, -60, '밸브 확인')]);
    vi.spyOn(api, 'availability').mockResolvedValue({ items: [{ robot_id: 'r7', state: 'CHARGING', demo: false, location_label: null, busy_label: null, busy_slot_id: null }] } as never);
    mount('u-park', withRun()); serve('r7');
    act(() => { push('r7', { location: LOC, run: { ...RUN, status: 'MOVING' } } as unknown as Partial<ScreenState>); });
    await flush();
    const st = $('.stage3d')!;
    expect(st.hasAttribute('data-u4-stage')).toBe(false); expect(st.getAttribute('data-u4-pad')).toBe('charge');
    expect(st.getAttribute('data-u4-legs')).toBe('down');   // 충전 = 엎드림(관절값 없을 때)
  });

  it('같은 이름 배정이 둘이면 경로를 고르지 않는다(지어내지 않음): 지점 0 · 진행과 상태만', async () => {
    board([ASG('a1'), ASG('a2')], [WP(10, -60, '밸브 확인')]);
    mount('u-park', withRun()); serve('r7');
    act(() => { push('r7', { location: LOC } as Partial<ScreenState>); });
    await flush();
    expect($$('[data-u4-wp]').length).toBe(0);
    expect(api.plan).not.toHaveBeenCalled();
    expect(text($('[data-u4-job] span'))).toBe('할 일 2 / 4 · 이동 중');
  });
});

describe('머리 연결 칸 = 시안 u11_5', () => {
  for (const [code, at] of [[1006, 'lost'], [4403, 'denied']] as const) it(`실시간 ${at}(${code}) → 「서버 연결 안 됨」 · 덧말 비움(현장 Wi-Fi 값 없음), 열려 있을 땐 「연결」`, () => {
    mount('u-park'); serve('r7');
    expect(text($('[data-cell="link"]'))).toMatch(/^연결/);
    act(() => { w.drop(code); });
    expect(rt.link().at).toBe(at);
    expect(text($('[data-cell="link"]'))).toBe('서버 연결 안 됨');
    expect($('[data-cell="link"] small')!.textContent).toBe('');
  });
});

describe('시뮬 로봇 = 시안 u4_8', () => {
  it('머리 칩: 연결 칸 「시뮬 · 서버 계산」, 배터리 작은 글 「시뮬」 · 아래 알약은 파란 「시뮬 · 현장」 + 「시뮬 로봇」, 걷기 · 위치 추정 알약 없음', () => {
    const SIM = { id: 's9', name: 'K-02', owner: 'u-park', ownerName: '박OO', battery: null, online: true, seenAt: '14:05:20', status: 'IDLE', sim: true } as Robot;
    mount('u-park', [...ON, SIM]); serve('r7', 's9');
    click($$('.rail .rcard').find((x) => x.getAttribute('data-r') === 'K-02')!);
    expect($$('.rail .rcard.on.rehearse').length).toBe(1);
    expect(text($('[data-cell="link"]'))).toBe('시뮬서버 계산');
    expect(text($('[data-cell="battery"]'))).toMatch(/시뮬$/);
    expect(text($('[data-u4-simplace]'))).toBe('시뮬 · 현장 모름');
    expect(text($('[data-u4-simfoot] .mu2'))).toBe('시뮬 로봇');
    expect($('[data-u4-walk]')).toBeNull(); expect($('[data-u4-loc]')).toBeNull();
    click($$('.rail .rcard').find((x) => x.getAttribute('data-r') === 'Go2-7')!);
    expect(text($('[data-cell="link"]'))).toMatch(/^연결/);
    expect($('[data-u4-walk]')).not.toBeNull();
  });
});

describe('데모 = 실기 꼴 · 서버 값(11-28)', () => {
  const SIM = { id: 's9', name: 'K-02', owner: 'u-park', ownerName: '박OO', battery: 70, online: true, seenAt: '14:05:20', status: 'IDLE', sim: true } as Robot;
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const avail = (demo: boolean) => vi.spyOn(api, 'availability').mockResolvedValue({ items: [{ robot_id: 's9', robot_name: 'K-02', state: 'FREE', busy_until: null, busy_slot_id: null, busy_label: null,
    battery_pct: 70, demo, sim: true, location_label: null }] });
  const pickSim = () => click($$('.rail .rcard').find((x) => x.getAttribute('data-r') === 'K-02')!);
  const again = () => { act(() => root?.unmount()); root = null; box.parentNode?.removeChild(box); };

  it('가용 demo = true 인 시뮬 로봇은 시뮬 꼴(점선 · 시뮬 칩 · 파란 알약) 없이 실기와 같고 「데모」 칩만 더함 · demo 가 아니면 시뮬 꼴 그대로', async () => {
    const a = avail(true);
    mount('u-park', [...ON, SIM]); serve('r7', 's9'); await flush();
    pickSim();
    expect($$('.rail .rcard.rehearse').length).toBe(0);
    expect($('.rail [data-demo]')).toBeNull();   // 목록 줄은 작은 글 「데모 · …」 한 줄(칩을 겹쳐 얹지 않음)
    expect(text($('.rail .rcard.on small'))).toMatch(/^데모 · /);
    expect(text($('[data-robot-head] .ttl [data-demo]'))).toBe('데모');
    expect(text($('[data-cell="link"]'))).toMatch(/^연결/);
    expect(text($('[data-cell="battery"]'))).not.toMatch(/시뮬/);
    expect($('[data-u4-simfoot]')).toBeNull(); expect($('[data-u4-walk]')).not.toBeNull();
    a.mockRestore(); again();
    const b = avail(false);
    mount('u-park', [...ON, SIM]); serve('r7', 's9'); await flush();
    pickSim();
    expect($$('.rail .rcard.on.rehearse').length).toBe(1); expect($('[data-demo]')).toBeNull(); expect($('[data-u4-simfoot]')).not.toBeNull();
    b.mockRestore();
  });

  it('배터리 작은 글 = battery.minutes_left 「약 N 분」, null · 범위 밖이면 비움(지어내지 않음)', () => {
    mount('u-park'); serve('r7');
    act(() => { push('r7', { battery: { soc: 66, minutes_left: 47 } } as unknown as Partial<ScreenState>); });
    expect(text($('[data-cell="battery"] small'))).toBe('약 47 분');
    act(() => { push('r7', { battery: { soc: 66, minutes_left: null } } as unknown as Partial<ScreenState>); });
    expect(text($('[data-cell="battery"] small'))).toBe('');
    act(() => { push('r7', { battery: { soc: 66, minutes_left: 2000 } } as unknown as Partial<ScreenState>); });
    expect(text($('[data-cell="battery"] small'))).toBe('');
  });

  it('gait.available 이 빈 목록이면 모드 칸은 꺼지고 까닭 · Shift+3 도 보내지 않고 까닭', () => {
    mount('u-park'); serve('r7');
    act(() => { push('r7', { gait: { gait: 'start', available: [] } } as Partial<ScreenState>); });
    const cell = $('[data-cell="mode"]')!;
    expect(cell.getAttribute('aria-disabled')).toBe('true');
    expect(text(cell.querySelector('small'))).toBe('바꿀 수 있는 모드 없음');
    drive();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(w.of('gait')).toHaveLength(0);
    expect(box.textContent).toContain('이 로봇은 걷기 모드를 바꿀 수 없습니다');
  });

  it('시뮬도 서버 robot_info 가 오면 상세에 자세 · 넘어짐은 서버 fallen 그대로(각도로 판단하지 않음)', () => {
    const info = (fallen: boolean) => ({ attitude: { roll: 0.9, pitch: 0 }, error_code: 0, fallen, fallen_source: 'imu_tilt_estimate' });
    mount('u-park', [...ON, SIM]); serve('r7', 's9');
    act(() => { push('s9', { robot_info: info(false) } as unknown as Partial<ScreenState>); });
    pickSim();
    click($('[data-seg="점검"]')!); click($('[data-u4-sub="detail"]')!);
    expect(text($('[data-robot-info]'))).toContain('roll');
    expect($('[data-robot-info]')!.textContent).not.toContain('넘어짐 의심');   // roll 0.9 rad 이어도 서버 fallen false
    again();
    mount('u-park', [...ON, SIM]); serve('r7', 's9');
    act(() => { push('s9', { robot_info: info(true) } as unknown as Partial<ScreenState>); });
    pickSim();
    click($('[data-seg="점검"]')!); click($('[data-u4-sub="detail"]')!);
    expect($('[data-robot-info]')!.textContent).toContain('넘어짐 의심');
  });

  it('데모가 늦게 와 시뮬 꼴 → 실기 꼴로 바뀌면 3D 는 새 캔버스(지난 렌더러가 맥락을 놓은 캔버스에 다시 붙이지 않음)', async () => {
    const a = avail(true);
    mount('u-park', [...ON, SIM]); serve('r7', 's9');
    pickSim();
    const before = $('[data-robot-3d]');
    await flush();
    expect($('[data-robot-3d]')).not.toBe(before);
    expect(before!.isConnected).toBe(false);
    a.mockRestore();
  });

  it('지도 칸: 데모 현장(sites demo) 층의 승인 판이면 시안 공장 그림 위에 시안 변환(25 + 3.5 x, 20 − 3.5 y) · 아니면 서버 판 그림', async () => {
    const V = { id: 'v1', floor_id: 'f1', number: 1, upload_id: 'u', base_version_id: null, copied_from_id: null, status: 'APPROVED', image_sha256: 'x',
      width: 1800, height: 1120, resolution: 0.5, origin: [0, -560, 0], features: { zones: [], waypoints: [], connectors: [], edits: [] },
      reason: '', source: 'IMPORT', created_by: 'u', created_at: '2026-11-28T09:00:00Z' };
    const tree = (demo: boolean) => ({ items: [{ id: 's1', name: '공장 터', purpose: 'SIM', demo, buildings: [{ id: 'b1', site_id: 's1', name: '초안 마당', floors: [
      { id: 'f1', building_id: 'b1', name: '1층', level: 1, approved_version_id: 'v1', pending_count: 0 }] }] }], next_cursor: null });
    const LOC = { floor_id: 'f1', map_version_id: 'v1', x: 100, y: -200, yaw: 0, confidence: 1, updated_at: '2026-11-28T00:00:00Z' };
    for (const demo of [true, false]) {
      const s = [vi.spyOn(api, 'version').mockResolvedValue(V as never), vi.spyOn(api, 'sites').mockResolvedValue(tree(demo) as never)];
      mount('u-park'); serve('r7');
      act(() => { push('r7', { location: LOC } as Partial<ScreenState>); });
      await flush(); await flush();
      const im = $('[data-u4-mapimg]')!;
      if (demo) {
        expect(im.getAttribute('data-u4-mapimg')).toBe('factory'); expect(im.getAttribute('src')).toBe('/proto-assets/assets/maps_v2/factory_kr/top_dark.png');   // 공장 질감판 위에서 본 그림(어둠 판)
        expect($('#me')!.getAttribute('transform')).toMatch(/^translate\(375\.0,720\.0\)/);
      } else {
        expect(im.getAttribute('data-u4-mapimg')).toBe('server'); expect(im.getAttribute('src')).toBe('/api/v1/map-versions/v1/image');
      }
      s.forEach((x) => x.mockRestore()); again();
    }
  });
});

describe('화면 맞춤 scale 아래 조이스틱', () => {
  /** 무대가 k 배로 줄었을 때(창 1920k × 1080k · stage.ts 배율 k): css 크기 150 px 손잡이 판이 화면에는 150k px 로 보인다 */
  const win = (w: number, h: number) => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: w }); Object.defineProperty(window, 'innerHeight', { configurable: true, value: h }); };
  const W0 = innerWidth, H0 = innerHeight;
  afterEach(() => win(W0, H0));
  function shrink(el: HTMLElement, k: number) {
    el.getBoundingClientRect = () => ({ left: 100, top: 100, width: 150 * k, height: 150 * k, right: 100 + 150 * k, bottom: 100 + 150 * k, x: 100, y: 100, toJSON() {} }) as DOMRect;
  }
  const ptr = (el: Element, type: string, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })); });
  for (const k of [1, 0.5]) it(`scale ${k}: 손가락을 보이는 판 반지름 끝까지 밀면 손잡이는 css 로 끝까지(45 px) · 앞으로 명령`, () => {
    win(1920 * k, 1080 * k);
    mount('u-park'); serve('r7'); drive();
    expect($('[data-scale]')!.getAttribute('data-scale')).toBe(k.toFixed(4));
    const L = $('[data-u4-stick="L"]')!; shrink(L, k);
    const c = 100 + 75 * k;
    ptr(L, 'pointerdown', c, c - 45 * k);
    expect((L.querySelector('i') as HTMLElement).style.transform).toBe('translate(0px,-45px)');
    tick(60); expect(Number(lastAxes()!.split(',')[0])).toBeGreaterThan(0);
    ptr(L, 'pointerup', c, c - 45 * k);
    expect((L.querySelector('i') as HTMLElement).style.transform).toBe('translate(0px,0px)');
    tick(60); expect(lastAxes()).toBe('0,0,0');
    const R = $('[data-u4-stick="R"]')!; shrink(R, k);
    ptr(R, 'pointerdown', c + 20 * k, c);   // 반지름의 20/45 ≈ 0.44 > 0.3 → 오른쪽 돌기
    expect((R.querySelector('i') as HTMLElement).style.transform).toBe('translate(20px,0px)');
    tick(60); expect(Number(lastAxes()!.split(',')[2])).toBeLessThan(0);
    ptr(R, 'pointerup', c, c);
  });

  it('손잡이 문턱 0.3: 반지름의 0.29 는 안 나가고 0.31 은 나감(왼쪽 앞 · 오른쪽 돌기) (검토 L4)', () => {
    mount('u-park'); serve('r7'); drive();
    const L = $('[data-u4-stick="L"]')!; shrink(L, 1); const R = $('[data-u4-stick="R"]')!; shrink(R, 1);
    const c = 175, r = 150 * 0.3;   // 판 폭 150 → 반지름 45 px
    const at = (el: Element, dx: number, dy: number) => { ptr(el, 'pointerdown', c + dx, c + dy); tick(60); const a2 = lastAxes(); ptr(el, 'pointerup', c + dx, c + dy); tick(60); return a2; };
    expect(['0,0,0', undefined]).toContain(at(L, 0, -0.29 * r));
    expect(at(L, 0, -0.31 * r)).toBe('1.5,0,0');
    expect(['0,0,0', undefined]).toContain(at(R, 0.29 * r, 0));
    expect(Number(at(R, 0.31 * r, 0)!.split(',')[2])).toBeLessThan(0);
  });

  // 팀장 11-28 17:33: 손잡이도 키보드와 같게. 왼쪽 = 이동(위 · 아래 · 왼 · 오른 · 옆걸음 포함), 오른쪽 = 돌기. 대각은 큰 축 하나만. 후진 막음 글 없음
  it('왼쪽 손잡이 = 이동 네 방향(대각은 큰 축 하나) · 오른쪽 = 돌기 · 떼기 · 취소 · 창 흐림이면 0 · 후진 막음 글 없음', () => {
    mount('u-park'); serve('r7'); drive();
    const L = $('[data-u4-stick="L"]')!; shrink(L, 1); const R = $('[data-u4-stick="R"]')!; shrink(R, 1);
    const c = 175, at = (el: Element, dx: number, dy: number) => { ptr(el, 'pointerdown', c + dx, c + dy); tick(60); const a = lastAxes()!; ptr(el, 'pointerup', c + dx, c + dy); tick(60); expect(lastAxes()).toBe('0,0,0'); return a; };
    expect(at(L, 0, -40)).toBe('1.5,0,0');     // 위 = 앞
    expect(at(L, 0, 40)).toBe('-1.5,0,0');     // 아래 = 뒤
    expect(at(L, -40, 0)).toBe('0,1,0');       // 왼 = 왼쪽 옆걸음
    expect(at(L, 40, 0)).toBe('0,-1,0');       // 오른 = 오른쪽 옆걸음
    expect(at(L, 15, -40)).toBe('1.5,0,0');    // 대각 · 위가 크면 앞만
    expect(at(L, -40, 15)).toBe('0,1,0');      // 대각 · 왼이 크면 옆만
    expect(at(L, 5, -5)).toBe('0,0,0');        // 문턱 안
    expect(text($('[data-u4-why]'))).not.toContain('후진');
    expect(Number(at(R, -40, 0).split(',')[2])).toBeGreaterThan(0);   // 오른쪽 손잡이 왼 = 왼쪽 돌기
    expect(Number(at(R, 40, 0).split(',')[2])).toBeLessThan(0);
    expect(at(R, 0, -40)).toBe('0,0,0');       // 오른쪽 손잡이 위아래는 없음
    ptr(L, 'pointerdown', c, c + 40); tick(60); expect(lastAxes()).toBe('-1.5,0,0');
    ptr(L, 'pointercancel', c, c + 40); tick(60); expect(lastAxes()).toBe('0,0,0');   // 취소 = 0
    ptr(L, 'pointerdown', c - 40, c); tick(60); expect(lastAxes()).toBe('0,1,0');
    act(() => { window.dispatchEvent(new Event('blur')); }); tick(60); expect(lastAxes()).toBe('0,0,0');   // 창 흐림 = 0
    ptr(L, 'pointerup', c - 40, c); tick(60);
    act(() => simTune({ ...ORG, real_max_vy: 0 }));   // 옆 상한 0 이면 옆걸음 0 + 까닭
    ptr(L, 'pointerdown', c - 40, c); tick(60); expect(lastAxes()).toBe('0,0,0');
    expect(document.body.textContent).toContain(SIDE_BLOCK);
    ptr(L, 'pointerup', c - 40, c); tick(60);
  });
});

describe('1 · 2 · 3 · 4 키 = 메인 칸 지도 · 카메라 · 라이다 · 깊이', () => {
  it('수정 키 없을 때만 · Shift+1~4 는 모드 · 입력 칸에서는 무시 · 키 줄에 「1~4 화면」', () => {
    mount('u-park'); serve('r7');
    const big = () => $('.vsel [data-view].on')!.getAttribute('data-view');
    expect(big()).toBe('map');
    key('keydown', 'Digit2'); key('keyup', 'Digit2'); expect(big()).toBe('rgb');
    key('keydown', 'Digit3'); key('keyup', 'Digit3'); expect(big()).toBe('lidar');
    key('keydown', 'Digit4'); key('keyup', 'Digit4'); expect(big()).toBe('depth');
    key('keydown', 'Digit1'); key('keyup', 'Digit1'); expect(big()).toBe('map');
    for (const m of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', [m]: true, bubbles: true, cancelable: true })); });
      expect(big()).toBe('map');
    }
    const input = document.createElement('input'); document.body.append(input); input.focus();
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', bubbles: true, cancelable: true })); });
    expect(big()).toBe('map'); input.remove();
    expect(text($('.ctl .keys'))).toContain('1~4화면');
  });
});

describe('메인 칸 더블클릭 = 무대 안 확대(시안 밖 · 새로 그림)', () => {
  const dbl = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  it('더블클릭 · Esc · 「돌아가기」 · 다시 더블클릭으로 나감 · 확대 중에도 정지 · 손잡이 · 키 줄 · 1~4 · 조종 그대로', () => {
    mount('u-park'); serve('r7'); drive();
    const views = () => $('.right .views')!, on = () => $('.right')!.hasAttribute('data-u4-zoom');
    expect(on()).toBe(false); expect($('[data-u4-zback]')).toBeNull();
    dbl(views()); expect(on()).toBe(true);
    expect($('[data-u4-zback]')!.textContent).toContain('돌아가기');
    expect($('.right .vstop[data-sd-stop="u4"]')).not.toBeNull();
    expect($$('.right [data-u4-stick]').length).toBe(2);
    expect(text($('.right .keys'))).toContain('Space정지');
    key('keydown', 'Digit2'); key('keyup', 'Digit2'); expect($('.vsel [data-view].on')!.getAttribute('data-view')).toBe('rgb');
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0'); key('keyup', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'Escape'); expect(on()).toBe(false);
    dbl(views()); expect(on()).toBe(true);
    click($('[data-u4-zback]')!); expect(on()).toBe(false);
    dbl(views()); dbl(views()); expect(on()).toBe(false);
    dbl($('.vsel [data-view]')!); expect(on()).toBe(false);   // 단추 위 더블클릭은 확대 아님
  });
});

describe('확대 중 창 · 탭 (검토 L1 · L2)', () => {
  const dbl = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  const on = () => $('.right')!.hasAttribute('data-u4-zoom');
  it('L1: 확대 중 걷기 모드 창의 막 · 창은 확대 화면 뒤 형제(css 로 z 8 · 9) · 막을 누르면 창만 닫히고 확대 그대로 · 막 더블클릭은 확대를 바꾸지 않음', () => {
    mount('u-park'); serve('r7'); drive();
    act(() => { push('r7', { gait: { gait: 'classic', available: ['classic', 'sport'] } } as Partial<ScreenState>); });
    dbl($('.right .views')!); expect(on()).toBe(true);
    click($('[data-cell="mode"]')!);
    expect($('.right[data-u4-zoom] ~ .veil')).not.toBeNull(); expect($('.right[data-u4-zoom] ~ [data-u4-mode]')).not.toBeNull();
    const flat = u4css.replace(/\s+/g, ' ');
    expect(flat).toContain('.u4 .right[data-u4-zoom] ~ .veil{z-index:8}');
    expect(flat).toContain('.u4 .right[data-u4-zoom] ~ .modal{z-index:9}');
    dbl($('.right[data-u4-zoom] ~ .veil')!); expect(on()).toBe(true);
    click($('.right[data-u4-zoom] ~ .veil')!);
    expect($('[data-u4-mode]')).toBeNull(); expect(on()).toBe(true);
  });
  it('L2: 확대 중 점검 탭으로 바꾸면 확대가 꺼지고, 조종 탭으로 돌아와도 꺼진 채', () => {
    mount('u-park'); serve('r7'); drive();
    dbl($('.right .views')!); expect(on()).toBe(true);
    click($('[data-seg="점검"]')!); expect(on()).toBe(false);
    click($('[data-seg="조종"]')!);
    expect(on()).toBe(false); expect($('[data-u4-zback]')).toBeNull();
  });
});

describe('로봇 목록 줄 순서 = 공용 fleetOrder(긴급 → 실기 → 데모 → 사용자 시뮬 → 받은 순서)', () => {
  it('시뮬 · 실기 섞인 목록: 실기가 위, 시뮬이 아래 · 정지 잠금(경고) 실기는 맨 위', () => {
    const sim = { ...ON.find((r) => r.id === 'r7')!, id: 's9', name: 'S-9', sim: true };
    mount('u-park', [sim, ...ON]); serve('r7');
    const rows = () => $$('.rail [data-robot-row]').map((e) => e.getAttribute('data-robot-row'));
    const got = rows();
    expect(got[got.length - 1]).toBe('s9');   // 사용자 시뮬은 맨 아래
    expect(new Set(got)).toEqual(new Set(['s9', ...ON.map((r) => r.id)]));
  });
});

describe('railOrder', () => {
  it('뜨거운 관절(경고) 시뮬도 맨 위 · 그다음 실기 · 데모 · 사용자 시뮬', () => {
    const base = ON.find((r) => r.id === 'r7')!, temp = (t: number) => ({ temperature: { joints: Array.from({ length: 12 }, (_, i) => (i === 0 ? t : 30)) } });
    const real = { ...base, id: 'a', sim: false, online: true, unknown: undefined, robotInfo: { ...base.robotInfo, ...temp(30) } } as Robot;
    const demo = { ...real, id: 'b', sim: true }, user = { ...real, id: 'c', sim: true }, hot = { ...user, id: 'd', robotInfo: { ...real.robotInfo, ...temp(65) } } as Robot;
    expect(railOrder([user, demo, hot, real], new Set(['b'])).map((x) => x.id)).toEqual(['d', 'a', 'b', 'c']);
  });
});

describe('걷기 모드 창(시안 u4_7)', () => {
  it('조종권 없이 모드 칸을 누르면 창을 열지 않고 까닭 한 줄 · gait 0 (검토 21:25)', () => {
    mount('u-park'); serve('r7');
    act(() => { push('r7', { gait: { gait: 'classic', available: ['classic', 'sport'] } } as Partial<ScreenState>); });
    click($('[data-cell="mode"]')!);
    expect($('[data-u4-mode]')).toBeNull();
    expect(text($('[data-u4-why]'))).toBe('조종을 시작해야 걷기 모드를 바꿀 수 있습니다.');
    expect(w.of('gait')).toEqual([]);
  });

  it('모드 칸 Enter 키: 누름과 같음(조종권 없음 → 까닭 줄 · 창 없음, 조종 중 → 창) · gait 0', () => {
    const enter = (el: Element) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); });
    mount('u-park'); serve('r7');
    act(() => { push('r7', { gait: { gait: 'classic', available: ['classic', 'sport'] } } as Partial<ScreenState>); });
    enter($('[data-cell="mode"]')!);
    expect($('[data-u4-mode]')).toBeNull(); expect(text($('[data-u4-why]'))).toBe('조종을 시작해야 걷기 모드를 바꿀 수 있습니다.');
    drive();
    enter($('[data-cell="mode"]')!);
    expect($('[data-u4-mode] .ttl')!.textContent).toBe('걷기 모드를 Classic 로 바꿀까요?');
    expect(w.of('gait')).toEqual([]);
  });

  it('시안 u4_7: Shift+2 는 창 없이 보내지 않고 Sport 를 고른 확인 창 · 바꾸기를 눌러야 gait 하나 · 못 쓰는 모드 · 조종권 없음은 원래 까닭', () => {
    const key = (code: string) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code, shiftKey: true, bubbles: true, cancelable: true })); });
    mount('u-park'); serve('r7');
    act(() => { push('r7', { gait: { gait: 'classic', available: ['classic', 'sport'] } } as Partial<ScreenState>); });
    key('Digit2');
    expect($('[data-u4-mode]')).toBeNull(); expect(w.of('gait')).toEqual([]);
    drive();
    const n0 = w.of('gait').length;
    key('Digit2');
    expect($('[data-u4-mode] .ttl')!.textContent).toBe('걷기 모드를 Sport 로 바꿀까요?');
    expect(w.of('gait').length).toBe(n0);
    click($('[data-u4-mode-go]')!);
    expect(w.of('gait').length).toBe(n0 + 1);
    key('Digit3');
    expect($('[data-u4-mode]')).toBeNull();
  });

  it('연 뒤 조종권을 잃으면 창이 닫히고 gait 0 (검토 21:25)', () => {
    mount('u-park'); serve('r7'); drive();
    act(() => { push('r7', { gait: { gait: 'classic', available: ['classic', 'sport'] } } as Partial<ScreenState>); });
    const n0 = w.of('gait').length;
    click($('[data-cell="mode"]')!); click($('[data-u4-gait="sport"]')!);
    act(() => { w.recv(lease('r7', null)); });
    expect($('[data-u4-mode]')).toBeNull(); expect(w.of('gait').length).toBe(n0);
  });

  it('L3: 못 쓰는 모드는 눌러도 고르지 않고 보내지 않음', () => {
    mount('u-park'); serve('r7'); drive();
    act(() => { push('r7', { gait: { gait: 'classic', available: ['classic', 'sport'] } } as Partial<ScreenState>); });
    click($('[data-cell="mode"]')!);
    const n0 = w.of('gait').length;
    click($('[data-u4-gait="start"]')!);
    expect($('[data-u4-mode] .ttl')!.textContent).toBe('걷기 모드를 Classic 로 바꿀까요?');   // 못 쓰는 모드는 고르지 않음
    click($('[data-u4-gait="sport"]')!); click($('[data-u4-gait="start"]')!);
    expect($('[data-u4-mode] .ttl')!.textContent).toBe('걷기 모드를 Sport 로 바꿀까요?');
    click($('[data-u4-mode-go]')!);
    const sent = w.of('gait'); expect(sent.length).toBe(n0 + 1); expect(sent[sent.length - 1].gait).toBe('sport');
    expect(sent.some((m) => m.gait === 'start')).toBe(false);
  });

  it('창은 연 때의 stop_gen · 조종권에 묶임(다시 시작 창과 같은 useRestartAsk): stop_gen 이 바뀌거나 조종권을 잃으면 닫히고 아무것도 안 보냄', () => {
    mount('u-park'); serve('r7'); drive();
    act(() => { push('r7', { gait: { gait: 'classic', available: ['classic', 'sport'] } } as Partial<ScreenState>); });
    const n0 = w.of('gait').length;
    click($('[data-cell="mode"]')!); expect($('[data-u4-mode]')).not.toBeNull();
    act(() => { push('r7', { stop_gen: (st.r7.stop_gen ?? 0) + 1 }); });
    expect($('[data-u4-mode]')).toBeNull();
    click($('[data-cell="mode"]')!); expect($('[data-u4-mode]')).not.toBeNull();
    act(() => { w.recv(lease('r7', null)); });
    expect($('[data-u4-mode]')).toBeNull();
    expect(w.of('gait').length).toBe(n0);
  });

  it('모드 칸을 누르면 창 · 고른 모드로 바꾸기는 서버 gait 하나 · 취소는 아무것도 안 보냄 · 쓸 수 있는 모드가 빈 목록이면 창 대신 까닭', () => {
    mount('u-park'); serve('r7'); drive();
    act(() => { push('r7', { gait: { gait: 'classic', available: ['classic', 'sport', 'start', 'ame2'] } } as Partial<ScreenState>); });
    click($('[data-cell="mode"]')!);
    expect($('[data-u4-mode] .ttl')!.textContent).toBe('걷기 모드를 Classic 로 바꿀까요?');
    click($('[data-u4-gait="start"]')!);
    expect($('[data-u4-mode] .ttl')!.textContent).toBe('걷기 모드를 START 로 바꿀까요?');
    expect($('[data-u4-mode-go]')!.textContent).toBe('START 로 바꾸기');
    const n0 = w.of('gait').length;
    click($('[data-u4-mode-cancel]')!); expect($('[data-u4-mode]')).toBeNull(); expect(w.of('gait').length).toBe(n0);
    click($('[data-cell="mode"]')!); click($('[data-u4-gait="sport"]')!); click($('[data-u4-mode-go]')!);
    expect($('[data-u4-mode]')).toBeNull();
    const sent = w.of('gait'); expect(sent.length).toBe(n0 + 1); expect(sent[sent.length - 1].gait).toBe('sport');
    act(() => { push('r7', { gait: { gait: 'classic', available: [] } } as Partial<ScreenState>); });
    expect($('[data-gait-none]')).not.toBeNull(); click($('[data-cell="mode"]')!); expect($('[data-u4-mode]')).toBeNull();
  });
});

// 시뮬 · 데모 로봇(팀장 11-28 · 서버는 시뮬이면 server_drive_allowed 를 늘 거짓으로 줌): 웹 조종은 「주인 === 나 && 연결됨」 으로 연다. 실기 규칙은 그대로
describe('로봇 탭 · 시뮬 로봇 조종 열림', () => {
  const SIM = ROBOTS.map((r) => (r.id === 'r7' ? { ...r, sim: true, serverDrive: false } : r));
  it('canDrive: 실기는 서버 허용이 있어야만 · 시뮬은 내 것 · 연결됨일 때만 · 총괄도 남의 시뮬은 막힘', () => {
    const [kim, lee, park] = USERS, r7 = ROBOTS.find((r) => r.id === 'r7')!, sim = { ...r7, sim: true, serverDrive: false };
    expect(canDrive({ user: park, phone: false }, { ...r7, serverDrive: false })).toBe(false);   // 실기 Go2 X · 서버 허용 없음 = 그대로 막힘
    expect(canDrive({ user: kim, phone: false }, { ...r7, serverDrive: false })).toBe(false);
    expect(canDrive({ user: park, phone: false }, { ...r7, serverDrive: true })).toBe(true);
    expect(canDrive({ user: kim, phone: false }, { ...r7, serverDrive: true })).toBe(true);    // 총괄 · 실기 규칙 그대로
    expect(canDrive({ user: park, phone: false }, sim)).toBe(true);
    expect(canDrive({ user: park, phone: false }, { ...sim, online: false })).toBe(false);
    expect(canDrive({ user: park, phone: true }, sim)).toBe(false);
    expect(canDrive({ user: lee, phone: false }, sim)).toBe(false);
    expect(canDrive({ user: kim, phone: false }, sim)).toBe(false);
    expect(canDrive({ user: park, phone: false }, { ...sim, sim: false })).toBe(false);   // sim 값이 없으면 실기로 본다
  });
  it('내 시뮬 로봇: 조종 시작 → 조종권 → 키 · 손잡이 명령 · STOP 이 먼저', () => {
    mount('u-park', SIM); serve('r7');
    expect($('[data-u4-drive]')!.getAttribute('aria-disabled')).toBeNull();
    drive();
    expect(w.of('lease.take').map((m) => m.robot)).toEqual(['r7']);
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    click($('.views .vstop')!);
    expect(w.of('stop').filter((m) => m.robot === 'r7').length).toBe(1);
    tick(60); expect(lastAxes()).toBe('0,0,0');
    key('keyup', 'ArrowUp');
  });
  it('남의 시뮬 로봇: 조종 시작이 꺼지고 까닭 한 줄 · 조종권 요청 없음', () => {
    mount('u-lee', SIM); serve('r7');
    click($('[data-robot-row="r7"]')!);
    expect($('.rail .rcard.on')!.getAttribute('data-robot-row')).toBe('r7');
    const b = $('[data-u4-drive]')!;
    expect(b.getAttribute('aria-disabled')).toBe('true'); click(b); expect(text($('[data-u4-why]'))).toBe('내 담당 시뮬 로봇만 조종할 수 있습니다.');
    expect(w.of('lease.take')).toEqual([]);
  });
  it('실기 Go2 X(서버 허용 없음): 내 것이어도 조종 시작이 꺼짐', () => {
    mount('u-park', ROBOTS); serve('r7');
    expect($('[data-u4-drive]')!.getAttribute('aria-disabled')).toBe('true');
    click($('[data-u4-drive]')!);
    expect(text($('[data-u4-why]'))).toBe('서버가 이 로봇의 웹 조종을 허용하지 않았습니다.');
    expect(w.of('lease.take')).toEqual([]);
  });
});

// 시안 u4_10: 「다시 시작」 은 확인 창 뒤에만 잠금 풀기를 보낸다. 취소 = 아무것도 안 보냄
describe('로봇 탭 · 다시 시작 확인 창', () => {
  it('다시 시작 → 「K 을 일으킬까요?」 · 취소는 보내지 않음 · 일어서기만 unlock 1 회', () => {
    mount('u-park'); serve('r7'); drive();
    click($('.views .vstop')!);
    click($('[data-u4-unlock]')!);
    expect(w.of('unlock')).toEqual([]);
    expect(text($('[data-u4-restart-ask] .ttl'))).toBe('Go2-7 을 일으킬까요?');
    expect(text($('[data-u4-restart-ask] p'))).toBe('그 자리에서 일어선 뒤 조종과 동작이 다시 켜집니다. 주변에 사람이 없는지 보세요.');
    click($('[data-u4-restart-cancel]')!);
    expect($('[data-u4-restart-ask]')).toBeNull(); expect(w.of('unlock')).toEqual([]);
    click($('[data-u4-unlock]')!);
    click($('[data-u4-restart-go]')!);
    expect($('[data-u4-restart-ask]')).toBeNull();
    expect(w.of('unlock').map((m) => m.robot)).toEqual(['r7']);
  });

  // 검토 H1(11/28 20:25): 연 창은 그때의 STOP(stop_gen) 하나에만. 잠금이 다른 곳에서 풀리거나 세대가 바뀌면 창 자체를 닫는다
  it('창을 연 뒤 다른 곳에서 풀림 → 새 STOP(stop_gen +1) 이 와도 창이 저절로 다시 뜨지 않고 unlock 0', () => {
    mount('u-park'); serve('r7'); drive();
    click($('.views .vstop')!);
    click($('[data-u4-unlock]')!);
    expect($('[data-u4-restart-ask]')).not.toBeNull();
    const g = st.r7.stop_gen ?? 0;
    act(() => push('r7', { latched: false }));   // 다른 화면에서 풀림
    expect($('[data-u4-restart-ask]')).toBeNull();
    act(() => push('r7', { latched: true, stop_gen: g + 1 }));   // 누군가의 새 STOP
    expect($('[data-u4-restart-ask]')).toBeNull();
    expect($('[data-u4-restart-go]')).toBeNull();
    expect(w.of('unlock')).toEqual([]);
  });

  it('창이 열린 채 잠금은 그대로인데 세대만 바뀌면(새 STOP) 창을 닫음 · 다시 열어 누르면 새 세대로 1 회', () => {
    mount('u-park'); serve('r7'); drive();
    click($('.views .vstop')!);
    click($('[data-u4-unlock]')!);
    const g = st.r7.stop_gen ?? 0;
    act(() => push('r7', { latched: true, stop_gen: g + 1 }));
    expect($('[data-u4-restart-ask]')).toBeNull(); expect(w.of('unlock')).toEqual([]);
    click($('[data-u4-unlock]')!); click($('[data-u4-restart-go]')!);
    expect(w.of('unlock').map((m) => [m.robot, m.stop_gen])).toEqual([['r7', g + 1]]);
  });

  it('정지됨 칸 「다시 시작」 · Damping 도 진짜 <button type="button"> (검토 L3) · 모양은 css 초기화 한 줄로 그대로', () => {
    mount('u-park'); serve('r7'); drive();
    click($('.views .vstop')!);
    for (const k of ['[data-u4-unlock]', '[data-u4-damp]']) { expect($(k)!.tagName).toBe('BUTTON'); expect($(k)!.getAttribute('type')).toBe('button'); }
    expect(u4css).toContain(':where(.u4 .vslot) button{border:0;padding:0;font-family:inherit;cursor:pointer}');
  });

  it('확인 창 단추는 진짜 <button> (키보드 Enter 로 누를 수 있음)', () => {
    mount('u-park'); serve('r7'); drive();
    click($('.views .vstop')!);
    click($('[data-u4-unlock]')!);
    expect($('[data-u4-restart-cancel]')!.tagName).toBe('BUTTON');
    expect($('[data-u4-restart-go]')!.tagName).toBe('BUTTON');
    expect($('[data-u4-restart-go]')!.getAttribute('type')).toBe('button');
  });
});

// 3D 칸 말풍선 안 안내(조종권 받음 · 잠금 해제 후 등)는 폰 조종 화면의 어두운 칸(.dv-note) 이 아니라 말풍선 글자 그대로(5195 사진에서 어두운 칸 위 어두운 글자)
it('로봇 탭 말풍선 안 dv-note 는 바탕 없이 말풍선 글자색', () => {
  expect(u4css).toMatch(/\.u4 \.bub \.dv-note\{[^}]*background:none[^}]*color:inherit/);
});

describe('조종권 단추 · 머리 칩 글 (시안 u11_2 ~ u11_4)', () => {
  it('단추: 내 조종 = 조종 중 · 요청 대기 = 요청 보냄 · 남이 가짐 = 조종권 요청 · 그 밖 = 조종 시작', () => {
    expect(driveLabel({ mine: true, asking: false, otherHolds: false })).toBe('조종 중');
    expect(driveLabel({ mine: false, asking: true, otherHolds: true })).toBe('요청 보냄');
    expect(driveLabel({ mine: false, asking: false, otherHolds: true })).toBe('조종권 요청');
    expect(driveLabel({ mine: false, asking: false, otherHolds: false })).toBe('조종 시작');
  });
  it('칩: 리모컨 우선 · 보기 전용 · 요청 중이면 지금 조종자 · 그 밖은 내 조종 로봇', () => {
    expect(barChipText({ at: 'remote', name: 'K-01', holder: null, driving: ['K-01'] })).toBe('K-01 리모컨 우선');
    expect(barChipText({ at: 'handed', name: 'K-01', holder: '운영자 A', driving: [] })).toBe('K-01 보기 전용');
    expect(barChipText({ at: 'ask', name: 'K-01', holder: '운영자 A', driving: [] })).toBe('운영자 A 조종 중');
    expect(barChipText({ at: 'ask', name: 'K-01', holder: null, driving: [] })).toBeNull();
    expect(barChipText({ at: null, name: '', holder: null, driving: ['K-01', 'K-03'] })).toBe('K-01 외 1 대 조종 중');
    expect(barChipText({ at: 'link', name: 'K-01', holder: null, driving: [] })).toBeNull();
  });
  it('리모컨 우선 덧말 둘은 시안 자리 · 모드 덧말은 걷는 동안만', () => {
    expect(u4src).toContain("line?.at === 'remote' && moving && <div className=\"whyb\" style={{ left: '495px', top: '140px' }}");
    expect(u4src).toContain("right: '60px', top: '846px'");
    expect(u4css).toMatch(/\.u4 \.whyb\{position:absolute;z-index:3;height:30px/);
  });
});

describe('관절 경고 말풍선 · 마우스 온도 (시안 u4_2 · u4_4)', () => {
  it('말풍선 첫 줄 조사는 받침대로 · 둘째 줄은 시안 글', () => {
    expect(hotBub('앞 오른 고관절', 61.6)).toBe('앞 오른 고관절이 온도가 높습니다 · 62 °C');
    expect(hotBub('앞 왼 종아리', 60)).toBe('앞 왼 종아리가 온도가 높습니다 · 60 °C');
    expect(u4src).toContain('<small>경고 60 °C 넘음 · 걷기는 계속합니다 · 쉬게 하려면 「앉아」</small>');
  });
  it('마우스 꼬리표: 관절 이름 + 온도 · 값 없으면 보고 없음', () => {
    expect(jointTip('FR_calf', 48.2)).toBe('앞 오른 종아리 48 °C');
    expect(jointTip('RL_hip', null)).toBe('뒤 왼 고관절 온도 보고 없음');
    expect(u4src).toContain("temps={tab === 'check' ? temps?.joints ?? null : null}");
  });
});

describe('어두운 판 지도 (리드 사진 00:30)', () => {
  it('서버 판 그림은 어두운 판에서 밝기를 --paper ~ 벽 회색으로 옮김 · 공장 그림은 그대로 · 칸 바탕 --paper', () => {
    expect(u4src).toContain("const dark = !light() && !!src && src !== fac;");
    expect(u4src).toContain('tableValues="0.2745 0.0706"');   // R: 벽 0x46 → 바탕 0x12
    expect(u4src).toContain("filter: dark ? 'url(#u4-plan-d)' : undefined");
    expect(u4css).toContain('.u4.proto:not(.light) .mapv{background:#12161d}');
  });
});

describe('조종 한 식 (contracts teleop · 팀장 11-28 23:08)', () => {
  const ORG = { sim_max_vx: 1.0, sim_max_vy: 0.4, sim_max_wz: 1.0, sim_key_vx: 0.6, stick_deadzone: 0.1 } as never;
  it('서버 경유 시뮬: 키 = keyStick 자리 → stickVelocity · 실기는 고정 명령표 그대로', () => {
    const caps = teleopCaps(ORG, true), want = (k: Parameters<typeof keyStick>[0]) => stickVelocity(keyStick(k, caps, 0.6), caps, deadzone(ORG)).map((v) => Math.round(v * 1e6) / 1e6 || 0);
    expect(axesOf(['up'], ORG, true)).toEqual(want(['forward']));
    expect(axesOf(['up'], ORG, true)[0]).toBeCloseTo(0.6, 6);   // 앞 키 = sim_key_vx
    expect(axesOf(['down'], ORG, true)[0]).toBeCloseTo(-0.6, 6);
    expect(axesOf(['left'], ORG, true)).toEqual([0, 0.4, 0]);
    expect(axesOf(['rotr', 'up'], ORG, true)).toEqual(want(['forward', 'turn_right']));
    expect(axesOf(['up', 'down'], ORG, true)).toEqual([0, 0, 0]);   // 표에 없는 조합 = 0
    expect(axesOf(['up'], ORG, false)).toEqual([1.5, 0, 0]);   // 실기 = 표 값
    // 화면 손잡이 기울기(비례): 민 축은 그 기울기 · 키보드와 같은 식
    expect(axesOf(['up'], ORG, true, [0.5, 0, 0])[0]).toBeCloseTo(0.25, 6);
    expect(tokStick(['up', 'rotl'], ORG, true)).toEqual(keyStick(['forward', 'turn_left'], caps, 0.6));
    expect(tokStick(['up', 'rotl'], ORG, false)).toEqual([1, 0, 1]);
  });
  it('직결 시뮬(simdrive · PC 시뮬 탭) 키 = 같은 keyStick 자리 · 실기 직결은 끝까지', () => {
    const L = { vx_mode: 'continuous', vx_min: -0.5, vx_max: 1.0, vy_min: -0.3, vy_max: 0.3, wz_min: -0.5, wz_max: 0.5, commands: [], experimental: [] };
    const w = { simulation: true, limits: L, policy: { name: 'x' } } as never;
    const [f, t, y] = keyAxes(['forward', 'turn_left', 'left'], w);
    expect(f).toBeCloseTo(Math.sqrt(0.6 / 1.0), 9); expect(t).toBe(1); expect(y).toBe(1);
    expect(keyAxes(['forward'], { ...(w as object), simulation: false } as never)[0]).toBe(1);
  });
  it('키를 누르면 로봇 탭 화면 손잡이도 그 자리로 (보내는 식과 같은 자리)', () => {
    expect(u4src).toContain("keyPos = tokStick(d.on ? (d.on.split('+') as Tok[]) : [], tune, !!d.sim)");
    expect(u4src).toContain('<Stick side="L" put={d.stick} show={[-keyPos[1], -keyPos[0]]} /><Stick side="R" put={d.stick} show={[-keyPos[2], 0]} />');
  });
});


// 로봇 탭(PC) = 시안 u4_1 DOM 그대로(robotu4.tsx). 시안 글 · 칸 순서 · 키 배치 · STOP 늘 보임 · 값 없으면 틀 그대로 글을 비우거나 「없음」.
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

  it('가운데 3D · 아래 알약 · 오른쪽 보기(지도 · 카메라 · 라이다 · 깊이) · 작은 칸 · 정지 Space · 키 줄 · 동작 일곱 · 글은 시안 그대로', () => {
    mount('u-park'); serve('r7');
    expect($('.stage3d canvas#go2')).not.toBeNull();
    expect(text($('.stage3d .hint'))).toBe('끌어서 돌려 보기');
    expect(text($('.stage3d .foot .mu2'))).toBe('실제 관절값으로 제자리에서 움직임 · 바닥 점이 뒤로 흐르면 앞으로 걷는 중');
    expect(text($('[data-u4-walk]'))).toBe('서 있음');
    expect($$('.views .vsel span').map(text)).toEqual(['지도', '카메라', '라이다', '깊이']);
    expect(text($('.views .small .cl'))).toBe('앞 카메라');
    expect(text($('.views .vstop'))).toBe('정지Space');
    expect($('.ctl .keys')!.textContent).toBe('↑앞으로←→돌기↓뒤로QE옆걸음Space정지Shift1~4모드');
    expect($$('.ctl .keys kbd').map(text)).toEqual(['↑', '←', '→', '↓', 'Q', 'E', 'Space', 'Shift', '1', '4']);
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
    click($('[data-u4-unlock]')!);
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

  // 키 줄 글은 시안 그대로(↓ 뒤로는 막힘), 실제 키 뜻은 공통 KEYS(W·↑ 앞 · S·↓ 뒤 · A·← / D·→ 돌기 · Q / E 옆걸음) — 시안과 다른 점은 차이 목록에
  it('키 뜻은 공통 KEYS: ↑ · W 앞으로 · ← → · A D 돌기 · ↓ · S 뒤로 · Q E 옆걸음', () => {
    mount('u-park'); serve('r7'); drive();
    expect(text($('[data-u4-drive]'))).toBe('조종 중');
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    key('keyup', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('0,0,0');
    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toBe('1.5,0,0'); key('keyup', 'KeyW'); tick(60);
    key('keydown', 'ArrowLeft'); tick(60); expect(Number(lastAxes()!.split(',')[2])).toBeGreaterThan(0); key('keyup', 'ArrowLeft'); tick(60);
    key('keydown', 'KeyD'); tick(60); expect(Number(lastAxes()!.split(',')[2])).toBeLessThan(0); key('keyup', 'KeyD'); tick(60);
    key('keydown', 'ArrowDown'); tick(60); expect(lastAxes()).toBe('-1.5,0,0'); key('keyup', 'ArrowDown'); tick(60);
    key('keydown', 'KeyS'); tick(60); expect(lastAxes()).toBe('-1.5,0,0'); key('keyup', 'KeyS'); tick(60);
    key('keydown', 'KeyQ'); tick(60); expect(Number(lastAxes()!.split(',')[1])).toBeGreaterThan(0); key('keyup', 'KeyQ'); tick(60);
    key('keydown', 'KeyE'); tick(60); expect(Number(lastAxes()!.split(',')[1])).toBeLessThan(0); key('keyup', 'KeyE'); tick(60);
    expect(lastAxes()).toBe('0,0,0');
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
    expect(text($('.rail .rcard.on [data-demo]'))).toBe('데모');
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
});

describe('화면 맞춤 scale 아래 조이스틱', () => {
  /** 무대가 k 배로 줄었을 때: css 크기 150 px 손잡이 판이 화면에는 150k px 로 보인다 */
  function shrink(el: HTMLElement, k: number) {
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 150 });
    el.getBoundingClientRect = () => ({ left: 100, top: 100, width: 150 * k, height: 150 * k, right: 100 + 150 * k, bottom: 100 + 150 * k, x: 100, y: 100, toJSON() {} }) as DOMRect;
  }
  const ptr = (el: Element, type: string, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })); });
  for (const k of [1, 0.5]) it(`scale ${k}: 손가락을 보이는 판 반지름 끝까지 밀면 손잡이는 css 로 끝까지(45 px) · 앞으로 명령`, () => {
    mount('u-park'); serve('r7'); drive();
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
});

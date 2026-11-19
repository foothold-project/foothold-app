// RB-PC-DRIVE-3COL(11-19) PC 로봇 탭 «바로 조종» 세 칸 화면: 허용 로봇 = 본문이 곧 조종 화면(모달 없음), 허용 안 됨 = 읽기 전용,
// STOP 늘 보임, 가운데 4칸(큰 1 + 작은 3 ↔ 4분할), 보고 없음 = Go2 그림 흐림, 키 조종 초점 잃음 = 0. 가짜 WebSocket 은 serverdrive.test 와 같은 흉내.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { FakeWS, lease, state } from './fakeWs';
import { simTune } from '../phone';
import { SD_NOTE } from '../serverdrive';
import { REPORT_STALE_MS, go2Pose } from '../pcdrive';

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
afterEach(() => { act(() => root?.unmount()); simTune(null); root = null; box?.remove(); vi.useRealTimers(); });

const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t)!;
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
    if (m.t === 'unlock') push(r, { latched: false });
    if (m.t === 'stop' && st[r]) push(r, { latched: true, stop_gen: st[r].stop_gen! + 1 });
    if (m.t === 'lease.release' || m.t === 'hidden') w.recv(lease(r, null));
  };
  act(() => { w.open(); ids.forEach((id) => push(id)); });
}
const axes = () => w.of('cmd').map((m) => (m.axes as number[]).join());
const lastAxes = () => axes()[axes().length - 1];
const NAMES = ['FR', 'FL', 'RR', 'RL'].flatMap((l) => ['hip', 'thigh', 'calf'].map((p) => `${l}_${p}_joint`));
const info = (age = 0.05) => ({ source: 'GO2_DDS', attitude: { roll: 0, pitch: 0 }, error_code: 0, fallen: false, fallen_source: 'imu_tilt_estimate',
  joints: { received_at: '2026-11-19T00:00:00Z', age_s: age, names: NAMES, positions: NAMES.map(() => 0.2) },
  quaternion: { received_at: '2026-11-19T00:00:00Z', age_s: age, wxyz: [1, 0, 0, 0] } }) as unknown as ScreenState['robot_info'];

describe('PC 로봇 탭 세 칸 조종 화면', () => {
  it('허용 로봇을 고르면 본문이 곧 세 칸 조종 화면 — 모달·«조종 화면 열기» 없음, «← 목록»으로 돌아가고 «조종 화면 열기»로 다시', () => {
    mount('u-park'); serve('r7');
    expect($('[data-pc-drive]')).not.toBeNull();
    expect($('[data-pd-left]')).not.toBeNull(); expect($('[aria-label="조종 보기 4칸"]')).not.toBeNull(); expect($('[data-pd-make]')).not.toBeNull();
    expect($('[data-sd-open]')).toBeNull(); expect($('[data-sd-full]')).toBeNull(); expect($('[role="dialog"][aria-modal="true"]')).toBeNull();
    for (const sec of ['지도 만들기', '속도', '시나리오', '목표']) expect($(`.pd-right [aria-label="${sec}"]`)).not.toBeNull();
    expect(box.textContent).not.toMatch(/SLAM|lease|epoch|odom/i);
    click($('[data-pd-back]')!);
    expect($('[data-pc-drive]')).toBeNull(); expect($('[aria-label="조종 준비"]')).not.toBeNull();
    click($('[data-open-drive]')!);
    expect($('[data-pc-drive]')).not.toBeNull();
  });

  it('허용 안 된 로봇은 지금처럼 읽기 전용 — 세 칸 화면·조종 단추 없음, 총괄도 없음', () => {
    mount('u-park', ROBOTS); serve('r7');
    expect($('[data-pc-drive]')).toBeNull(); expect($('[data-server-drive]')).toBeNull();
    expect(($('[data-open-drive]') as HTMLButtonElement).disabled).toBe(true);
    act(() => root!.unmount()); box.remove();
    mount('u-kim'); serve('r3', 'r7', 'r1');
    expect($('[data-pc-drive]')).toBeNull();
  });

  it('STOP 은 맨 위 줄에 늘 보이고 가장 크다 — 조종 전·조종 중·잠김 모두, 누르면 입력 0 먼저 + 정지', () => {
    mount('u-park'); serve('r7');
    const top = () => $('[data-pd-top] [data-sd-stop="full"]')!;
    expect(top()).not.toBeNull(); expect(top().style.minHeight).toBe('120px');
    click(btn('조종 시작'));
    expect(top()).not.toBeNull();
    click(btn('② 잠금 해제')); tick(100);
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    click(top());
    expect(lastAxes()).toBe('0,0,0'); expect(w.of('stop').length).toBe(1);
    expect(top()).not.toBeNull();
    tick(200); expect(lastAxes()).toBe('0,0,0');   // 키를 누르고 있어도
    key('keyup', 'ArrowUp');
  });

  it('가운데 4칸: 처음 큰 1(지도) + 작은 3, 작은 칸을 누르면 그것이 큰 칸, «4분할»로 2×2, 다시 큰 화면', () => {
    mount('u-park'); serve('r7');
    const quad = () => $('[aria-label="조종 보기 4칸"]')!, on = () => quad().querySelector('.qt.on')?.getAttribute('data-tile');
    expect(quad().classList.contains('f')).toBe(true); expect(on()).toBe('map');
    expect(quad().querySelectorAll('.qt.pip').length).toBe(3);
    click(quad().querySelector('[data-tile="rgb"] .qh')!);
    expect(on()).toBe('rgb'); expect(quad().querySelector('[data-tile="map"]')!.classList.contains('pip')).toBe(true);
    expect(quad().querySelector('[data-tile="rgb"]')!.textContent).toContain('카메라 신호 없음');   // 받을 수 없는 칸은 «…신호 없음»
    click($('[data-q-grid]')!);
    expect(quad().classList.contains('f')).toBe(false); expect(quad().querySelectorAll('.qt.pip').length).toBe(0);
    click($('[data-q-grid]')!);
    expect(on()).toBe('map');
  });

  it('로봇 보고(관절)가 없거나 오래되면 Go2 그림을 흐리게 + «로봇 보고 없음», 새 보고가 오면 또렷이', () => {
    mount('u-park'); serve('r7');
    const left = () => $('[data-pd-left]')!;
    expect(left().hasAttribute('data-stale')).toBe(true); expect($('[data-pd-noreport]')!.textContent).toBe('로봇 보고 없음');
    act(() => push('r7', { robot_info: info() }));
    expect(left().hasAttribute('data-stale')).toBe(false); expect($('[data-pd-noreport]')).toBeNull();
    expect(left().querySelector('[data-pd="posture"]')!.textContent).toContain('자세');
    tick(REPORT_STALE_MS + 300);   // 새 state 없음
    expect(left().hasAttribute('data-stale')).toBe(true);
    act(() => push('r7', { robot_info: info(2) }));   // 로봇 쪽에서 이미 늙은 관절 값
    expect(left().hasAttribute('data-stale')).toBe(true);
    act(() => push('r7', { robot_info: info(), connection: 'OFFLINE' }));
    expect(left().hasAttribute('data-stale')).toBe(true);
  });

  it('왼쪽 글자: 자세·움직일 수·배터리·보내는 속도·조종하는 사람·잠긴 까닭·마지막 보고, 자세 단추는 조종 중에만', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { posture: { state: 'STANDING', mode: 1 }, battery: { soc: 64, updated_at: '2026-11-19T00:00:00Z' }, applied: [1.5, 0, 0.5] }));
    const f = (k: string) => $(`[data-pd-left] [data-pd="${k}"]`)!.textContent;
    expect(f('posture')).toContain('서 있음'); expect(f('battery')).toContain('64%');
    expect(f('speed')).toContain('앞뒤 1.5'); expect(f('speed')).toContain('회전 0.5');
    expect(f('why')).toContain('잠');   // 잠김(fixture latched=true)
    expect(f('ago')).toContain('초 전');
    expect($('[data-pd-left] [data-sd-posture]')).toBeNull();
    click(btn('조종 시작'));
    expect(f('holder')).toContain('나');
    expect($('[data-pd-left] [data-sd-pose="up"]')).not.toBeNull();
  });

  it('키 조종은 이 화면이 보이는 동안 그대로, 창 초점 잃음 = 바로 0 + 안내, 자동 재개 없음', () => {
    mount('u-park'); serve('r7');
    click(btn('조종 시작')); click(btn('② 잠금 해제')); tick(100);
    key('keydown', 'KeyA'); tick(60); expect(lastAxes()).toBe('0,0,0.5');
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(lastAxes()).toBe('0,0,0');
    expect($('[data-sd-why]')!.textContent).toBe(SD_NOTE.blur);
    tick(200); expect(lastAxes()).toBe('0,0,0');
    key('keyup', 'KeyA');
    click($('[data-pd-back]')!);   // 목록으로 = 화면 내림 → 키는 더 보내지 않음
    const n = w.of('cmd').length; key('keydown', 'ArrowUp'); tick(200);
    expect(w.of('cmd').slice(n).every((m) => (m.axes as number[]).every((v) => v === 0))).toBe(true);
    key('keyup', 'ArrowUp');
  });

  it('go2Pose: 관절 12개·연결·새것일 때만, 이름 순서대로 다시 맞춤', () => {
    const s = state('r7', { robot_info: info() });
    expect(go2Pose(s, true)!.q).toHaveLength(12);
    expect(go2Pose(s, false)).toBeNull();
    expect(go2Pose({ ...s, connection: 'OFFLINE' }, true)).toBeNull();
    const bad = info(); bad!.joints!.positions = bad!.joints!.positions.slice(1);
    expect(go2Pose(state('r7', { robot_info: bad }), true)).toBeNull();
    const rev = info(); rev!.joints!.names = [...NAMES].reverse() as never; rev!.joints!.positions = NAMES.map((_, i) => 11 - i);
    expect(go2Pose(state('r7', { robot_info: rev }), true)!.q).toEqual(NAMES.map((_, i) => i));
  });
});

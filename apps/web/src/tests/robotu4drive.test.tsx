// 옛 pcdrive.test.tsx(세 칸 조종 화면)의 조종 논리 · 보기 단언을 시안 u4 로봇 탭(robotu4.tsx) 위로 옮긴 것.
// 같은 단언(조종권 · 끊김 · 늦은 승인 · 로그인별 유지 · STOP · 초점 잃음 0 · 라이다/카메라/깊이 epoch · 기체 오류 · 온도 나이 · go2Pose/go2Temps)을 그대로 둔다.
// 자리만 바뀜: «조종 시작» = .ctl 조종 단추, «② 잠금 해제» = 정지됨 칸 「다시 시작」, 맨 위 STOP = 보기 칸 .vstop, 4칸 = 보기 고르기(지도 · 카메라 · 라이다 · 깊이).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { FakeWS, lease, state } from './fakeWs';
import { simTune } from '../phone';
import { api } from '../api';
import { SD_NOTE } from '../serverdrive';
import { BODY_CHECK, BODY_FAULT, IDENTITY_FAULT_LABEL, NO_SIGNAL } from '../drivemedia';
import { REPORT_STALE_MS, TEMP_STALE_S, go2Pose, go2Temps } from '../go2model';

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

/** 이 화면의 자리: 조종 시작 단추 · 다시 시작(잠금 해제) · STOP · 조종 붙음 표시 · 끊김 안내 */
const begin = () => $('[data-u4-drive]')!;
const unlock = () => click($('[data-u4-unlock]')!);
const stop = () => $('.views .vstop');
const can = () => $('[data-u4-can]');
const offline = () => $('[data-u4-offline]');
const view = (v: 'map' | 'rgb' | 'lidar' | 'depth') => click($(`.views .vsel [data-view="${v}"]`)!);
const disabled = (el: Element) => el.getAttribute('aria-disabled') === 'true';

describe('로봇 탭(시안 u4) 조종 논리 · 옛 세 칸 화면 시험 옮김', () => {
  it('허용 로봇을 고르면 이 화면에 조종이 붙는다 — 모달 · «조종 화면 열기» 없음', () => {
    mount('u-park'); serve('r7');
    expect(can()).not.toBeNull();
    expect($('[data-sd-open]')).toBeNull(); expect($('[data-sd-full]')).toBeNull(); expect($('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(box.textContent).not.toMatch(/SLAM|lease|epoch|odom/i);
  });

  it('허용 안 된 로봇은 읽기 전용 — 조종 시작이 꺼져 있고 눌러도 조종권 요청 없음, 총괄도 없음', () => {
    mount('u-park', ROBOTS); serve('r7');
    expect(can()).toBeNull(); expect(disabled(begin())).toBe(true);
    click(begin()); expect(w.of('lease.take').length).toBe(0);
    expect($('[data-u4-why]')!.textContent).toBe('서버가 이 로봇의 웹 조종을 허용하지 않았습니다.');
    act(() => root!.unmount()); box.remove();
    mount('u-kim'); serve('r3', 'r7', 'r1');
    expect(can()).toBeNull(); click(begin()); expect(w.of('lease.take').length).toBe(0);
  });

  const drop = (rs: Robot[], blocked: NonNullable<Robot['serverDriveBlocked']>) => rs.map((r) => (r.id === 'r7' ? { ...r, serverDrive: false, serverDriveBlocked: blocked } : r));
  const relist = (robots: Robot[]) => act(() => { root!.render(<App user={USERS.find((u) => u.id === 'u-park')} robots={robots} />); });
  it('로봇 연결이 끊겨도 화면 유지 — 조종 시작 · 키 꺼짐 · 명령 0, 쉬운 말 안내, STOP 은 그대로 · 다시 연결돼도 자동 조종 없음', () => {
    mount('u-park'); serve('r7');
    click(begin()); unlock(); tick(100);
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    act(() => { push('r7', { connection: 'OFFLINE', latched: null, robot_info: null }); });
    expect(can()).not.toBeNull(); expect(lastAxes()).toBe('0,0,0');
    expect(offline()!.textContent).toBe('로봇 연결이 끊겼습니다 · 다시 연결되면 «조종 시작»을 다시 누르세요');
    act(() => { w.recv(lease('r7', null)); }); relist(drop(ON, ['AGENT_OFFLINE']));
    key('keyup', 'ArrowUp');
    expect(can()).not.toBeNull(); expect($('.stage3d')!.hasAttribute('data-stale')).toBe(true);
    expect(offline()).not.toBeNull(); expect($('.right')!.textContent).not.toMatch(/충전|전원/);
    expect(disabled(begin())).toBe(true);
    const n = w.of('cmd').length, takes = w.of('lease.take').length;
    click(begin()); key('keydown', 'ArrowUp'); tick(300); key('keyup', 'ArrowUp');
    expect(w.of('cmd').length).toBe(n); expect(w.of('lease.take').length).toBe(takes);
    click(stop()!); expect(w.of('stop').length).toBe(1);
    relist(ON); act(() => { push('r7', { connection: 'ONLINE', latched: true }); }); tick(300);
    expect(can()).not.toBeNull(); expect(offline()).toBeNull();
    expect(w.of('cmd').length).toBe(n); expect(w.of('lease.take').length).toBe(takes);
    expect(disabled(begin())).toBe(false);
    click(begin()); expect(w.of('lease.take').length).toBe(takes + 1);
  });

  it('목록 끊김이 먼저 와도 끊김 동안 · 복구 뒤 0 이 아닌 명령 없음, «조종 시작» 다시 누르고 새로 눌러야만 이동 · STOP 은 그대로', () => {
    mount('u-park'); serve('r7');
    click(begin()); unlock(); tick(100);
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    const n = axes().length, moving = () => axes().slice(n).filter((a) => a !== '0,0,0');
    relist(drop(ON, ['AGENT_OFFLINE']));
    tick(150);
    expect(moving()).toEqual([]); expect(w.of('lease.release').length).toBe(1);
    expect(offline()).not.toBeNull(); expect(stop()).not.toBeNull();
    relist(ON); tick(300);
    expect(moving()).toEqual([]); expect(offline()).toBeNull();
    key('keydown', 'ArrowUp'); tick(100); expect(moving()).toEqual([]);
    click(begin()); tick(100);
    expect(moving()).toEqual([]);
    key('keyup', 'ArrowUp'); key('keydown', 'ArrowUp'); tick(60);
    expect(lastAxes()).toBe('1.5,0,0');
    key('keyup', 'ArrowUp'); click(stop()!); expect(w.of('stop').length).toBe(1);
  });

  it('요청 보류 중 끊김 → 복구 뒤 늦은 승인은 바로 반납 — 잠금 해제 · ↑ 해도 0 이 아닌 명령 없음, «조종 시작» 다시 누르면 이동', () => {
    mount('u-park'); serve('r7');
    const auto = w.auto!; let held: string | null = null;
    w.auto = (m) => (m.t === 'lease.take' && !held ? void (held = m.id as string) : auto(m));
    click(begin()); expect(w.of('lease.take').length).toBe(1);
    relist(drop(ON, ['AGENT_OFFLINE'])); tick(100);
    relist(ON); tick(100);
    act(() => { w.recv({ t: 'reply', id: held, ok: true }); w.recv(lease('r7', PARK, 'Llate')); w.recv({ t: 'lease.result', robot: 'r7', request_id: null, result: 'ACCEPTED' }); });
    tick(100);
    expect(w.of('lease.release').length).toBe(1);
    if ($('[data-u4-unlock]')) unlock();
    key('keydown', 'ArrowUp'); tick(300); key('keyup', 'ArrowUp');
    expect(axes().filter((a) => a !== '0,0,0')).toEqual([]);
    expect(w.of('lease.take').length).toBe(1);
    click(begin()); tick(100); expect(w.of('lease.take').length).toBe(2);
    unlock(); tick(100);
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0'); key('keyup', 'ArrowUp');
    expect(w.of('lease.release').length).toBe(1);
  });

  it('끊김 유지 기록은 로그인별 — 사용자가 바뀌거나 다시 로그인하면 지워져 읽기 전용', () => {
    const g1 = new AbortController(), as = (user: string, robots: Robot[], cancel?: AbortSignal, k = user) =>
      act(() => { root!.render(<App key={k} user={USERS.find((u) => u.id === user)} robots={robots} cancel={cancel} />); });
    mount('u-park'); serve('r7');
    as('u-park', ON, g1.signal, 'park-1'); expect(can()).not.toBeNull();
    as('u-park', drop(ON, ['AGENT_OFFLINE']), g1.signal, 'park-1'); expect(can()).not.toBeNull();
    const toLee = drop(ON.map((r) => (r.id === 'r7' ? { ...r, owner: 'u-lee', ownerName: '이OO' } : r)), ['AGENT_OFFLINE']);
    g1.abort(); as('u-lee', toLee, new AbortController().signal); serve('r7');
    expect(can()).toBeNull();
    const g2 = new AbortController();
    as('u-park', ON, g2.signal, 'park-2'); expect(can()).not.toBeNull();
    g2.abort(); as('u-park', drop(ON, ['AGENT_OFFLINE']), new AbortController().signal, 'park-3');
    expect(can()).toBeNull();
  });

  it('끊김 유지는 한 번 허용됐던 로봇만, 까닭이 «로봇 연결 없음» 하나일 때만 — 처음부터 끊긴 로봇 · 스위치 꺼짐은 읽기 전용', () => {
    const X = (rs: Robot[]) => rs.map((r) => (r.id === 'r7' ? { ...r, id: 'r7x' } : r)), drop = (rs: Robot[], blocked: NonNullable<Robot['serverDriveBlocked']>) => X(rs).map((r) => (r.id === 'r7x' ? { ...r, serverDrive: false, serverDriveBlocked: blocked } : r));
    mount('u-park', drop(ROBOTS, ['AGENT_OFFLINE'])); serve('r7x');
    expect(can()).toBeNull();
    relist(X(ON)); expect(can()).not.toBeNull();
    relist(drop(ON, ['SWITCH_OFF'])); expect(can()).toBeNull();
    relist(drop(ON, ['AGENT_OFFLINE'])); expect(can()).not.toBeNull();
    relist(drop(ON.map((r) => (r.id === 'r7' ? { ...r, owner: 'u-lee' } : r)), ['AGENT_OFFLINE'])); expect(can()).toBeNull();
  });

  it('STOP 은 보기 칸에 늘 보인다(시안 정지 · Space) — 조종 전 · 조종 중, 누르면 입력 0 먼저 + 정지, 누르고 있어도 0', () => {
    mount('u-park'); serve('r7');
    expect(stop()!.className).toBe('vstop stop');
    click(begin());
    expect($('[data-u4-restart]')).not.toBeNull();   // 잠긴 채 조종권을 받으면 시안 u4_9 정지됨 칸(다시 시작 · Damping)
    unlock(); tick(100);
    expect(stop()).not.toBeNull();
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    click(stop()!);
    expect(lastAxes()).toBe('0,0,0'); expect(w.of('stop').length).toBe(1);
    tick(200); expect(lastAxes()).toBe('0,0,0');
    key('keyup', 'ArrowUp');
  });

  it('STOP 이 거절되면 3D 칸 위에 «정지 요청 실패 — 현장 확인»', () => {
    mount('u-park'); serve('r7');
    const auto = w.auto!; w.auto = (m) => (m.t === 'stop' ? w.recv({ t: 'reply', id: m.id, ok: false, error: { code: 'ROBOT_OFFLINE', message: '거절', detail: {} } }) : auto(m));
    click(begin()); unlock(); tick(100);
    click(stop()!); tick(100);
    expect(w.of('stop').length).toBe(1);
    expect($('.stage3d [data-sd-stop-phase]')!.textContent).toContain('정지 요청 실패 — 현장 확인');
  });

  it('로봇 보고(관절)가 없거나 오래되면 3D 칸 data-stale · 걷기 알약 「서 있음」은 보고 기준, 새 보고가 오면 또렷이', () => {
    mount('u-park'); serve('r7');
    const stale = () => $('.stage3d')!.hasAttribute('data-stale');
    expect(stale()).toBe(true);
    act(() => push('r7', { robot_info: info() }));
    expect(stale()).toBe(false);
    tick(REPORT_STALE_MS + 300);
    expect(stale()).toBe(true);
    act(() => push('r7', { robot_info: info(2) }));
    expect(stale()).toBe(true);
    act(() => push('r7', { robot_info: info(), connection: 'OFFLINE' }));
    expect(stale()).toBe(true); expect($('[data-u4-walk]')!.textContent).toBe('걷기 보고 없음');
  });

  it('조종하는 사람 칩 = 나 · 동작 단추는 조종 중에만 보냄(그 전엔 까닭)', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { posture: { state: 'STANDING', mode: 1 }, battery: { soc: 64, updated_at: '2026-11-19T00:00:00Z' }, applied: [1.5, 0, 0.5] }));
    expect($('[data-cell="battery"]')!.textContent).toMatch(/^64 %/);
    click($('[data-u4-act="StandDown"]')!); expect(w.of('action').length).toBe(0);
    click(begin());
    expect($('[data-cell="holder"]')!.textContent).toMatch(/^나/);
  });

  it('키 조종은 이 화면이 보이는 동안 그대로, 창 초점 잃음 = 바로 0 + 안내, 자동 재개 없음 · 다른 로봇을 고르면 키는 더 보내지 않음', () => {
    mount('u-park'); serve('r7');
    click(begin()); unlock(); tick(100);
    key('keydown', 'KeyA'); tick(60); expect(lastAxes()).toBe('0,0,2.5');
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(lastAxes()).toBe('0,0,0');
    expect($('[data-sd-why]')!.textContent).toBe(SD_NOTE.blur);
    tick(200); expect(lastAxes()).toBe('0,0,0');
    key('keyup', 'KeyA');
    click($('.rail .rcard[data-r="Go2-3"]')!);   // 다른 로봇 = 이 로봇 조종 화면 내림
    const n = w.of('cmd').length; key('keydown', 'ArrowUp'); tick(200);
    expect(w.of('cmd').slice(n).every((m) => (m.axes as number[]).every((v) => v === 0))).toBe(true);
    key('keyup', 'ArrowUp');
  });

  // 보기 칸(지도 · 카메라 · 라이다 · 깊이): 큰 칸 하나 + 작은 칸 하나. 보이는 칸만 그 채널을 받는다
  const occScan = (lid: FakeWS, seq: number, pts: number[], p: object = {}, body = true) => act(() => {
    lid.recv({ t: 'media.points', version: 'media/1', channel: 'lidar', robot: 'r7', epoch: 71, episode_id: null, seq, source: 'l1', encoding: 'xyz_f32le', frame: 'odom', map_version_id: null,
      pose: { x: 0, y: 0, z: 0.3, yaw: 0 }, count: pts.length / 3, byte_length: pts.length * 4, truncated: false, ...p });
    if (body) lid.onmessage?.({ data: new Float32Array(pts).buffer } as never);
  });
  const P1 = [0.025, 2.025, 0.3], P2 = [-2.025, 0.025, 0.3, 0.025, -2.025, 0.3], P3 = [...P2, 1, 1, 0.3];
  const lidarN = () => $('[data-u4-big="lidar"] [data-lidar-map]')?.getAttribute('data-lidar-map');
  const lidSock = () => FakeWS.all.filter((x) => x.url.endsWith('/drive-media/lidar') && x.readyState !== 3).pop()!;

  it('지도 칸은 층 지도(라이다와 무관 · 걸으며 만드는 지도 없음), 라이다 칸은 받은 한 판만', () => {
    mount('u-park'); serve('r7');
    view('lidar');
    const lid = lidSock();
    act(() => { lid.open(); });
    occScan(lid, 1, [2.025, 0.025, 0.3, 1.025, 1.025, 0], { epoch: 1 }); occScan(lid, 2, [3, 0, 0.3], { epoch: 1 });
    expect(lidarN()).toBe('1');
    expect(box.querySelector('[data-lm-wipe], [data-occ-wipe]')).toBeNull();
    view('map');
    expect($('.views .mapv [data-occ-map]')).toBeNull(); expect($('.views')!.textContent).not.toContain('걸으며');
  });

  it('epoch 가 바뀐 뒤 늦게 온 옛 epoch 판은 지금 라이다 그림을 덮지 않는다(RV-443 ④)', () => {
    mount('u-park'); serve('r7'); view('lidar');
    const lid = lidSock();
    act(() => { lid.open(); });
    occScan(lid, 5, P3);
    occScan(lid, 1, P1, { epoch: 14 });
    expect(lidarN()).toBe('1');
    occScan(lid, 6, P2);
    act(() => { lid.recv({ t: 'media.status', version: 'media/1', channel: 'lidar', robot: 'r7', epoch: 71, episode_id: null, reason: 'No fresh source sample within 1 second' }); });
    expect(lidarN()).toBe('1');
    expect($('[data-u4-big="lidar"]')!.textContent).not.toContain(NO_SIGNAL.lidar);
    occScan(lid, 2, P3, { epoch: 14 });
    expect(lidarN()).toBe('3');
    expect(lid.readyState).not.toBe(3);
  });

  it('라이다 칸을 숨겼다 다시 열어도 지난 epoch 기록은 이어진다 — 늦은 71 판이 14 그림을 덮지 않음(RV-450 ②)', () => {
    mount('u-park'); serve('r7'); view('lidar');
    let lid = lidSock();
    act(() => { lid.open(); });
    occScan(lid, 5, P1);
    occScan(lid, 1, P1, { epoch: 14 });
    view('map');   // 라이다 칸 숨김 = 라이다 소켓 닫음
    view('lidar');
    lid = lidSock();
    act(() => { lid.open(); });
    const ns: (string | null | undefined)[] = [];
    occScan(lid, 2, P1, { epoch: 14 }); ns.push(lidarN());
    occScan(lid, 6, P2); ns.push(lidarN());
    occScan(lid, 3, P3, { epoch: 14 }); ns.push(lidarN());
    expect(ns).toEqual(['1', '1', '3']);
    expect(lid.readyState).not.toBe(3);
  });

  it('카메라 · 깊이 칸을 숨겼다 다시 열어도 지난 epoch 기록은 이어진다 — 늦은 71 영상이 14 영상을 덮지 않음(RV-452)', () => {
    mount('u-park'); serve('r7');
    const sock = (ch: string) => FakeWS.all.filter((x) => x.url.endsWith(`/drive-media/${ch}`) && x.readyState !== 3).pop()!;
    const vid = (ch: string, epoch: number, seq: number, jpeg: string) => ({ t: 'media.video', version: 'media/1', channel: ch, robot: 'r7', epoch, episode_id: null, seq, mime: 'image/jpeg', jpeg,
      ...(ch === 'depth' ? { source: 'go2_depth', depth_min_m: 0.2, depth_max_m: 5 } : {}) });
    const img = (ch: string) => (ch === 'rgb' ? $('.views .small img') : $('[data-u4-big="depth"] img'))?.getAttribute('src')?.split(',')[1];
    // 카메라 = 지도 보기의 작은 칸, 깊이 = 큰 칸
    { const s = sock('rgb'); act(() => { s.open(); s.recv(vid('rgb', 71, 5, 'A71')); s.recv(vid('rgb', 14, 1, 'A14')); }); }
    view('depth'); { const s = sock('depth'); act(() => { s.open(); s.recv(vid('depth', 71, 5, 'A71')); s.recv(vid('depth', 14, 1, 'A14')); }); }
    view('lidar');   // 둘 다 숨김(작은 칸 = 지도)
    expect(img('rgb')).toBeUndefined(); expect(img('depth')).toBeUndefined();
    for (const ch of ['rgb', 'depth']) {
      view(ch === 'rgb' ? 'map' : 'depth');
      const s = sock(ch), seen: (string | undefined)[] = [];
      act(() => { s.open(); });
      act(() => { s.recv(vid(ch, 14, 2, 'B14')); }); seen.push(img(ch));
      act(() => { s.recv(vid(ch, 71, 6, 'L71')); }); seen.push(img(ch));
      act(() => { s.recv(vid(ch, 14, 3, 'C14')); }); seen.push(img(ch));
      expect([ch, ...seen]).toEqual([ch, 'B14', 'B14', 'C14']);
      expect(s.readyState).not.toBe(3);
    }
  });

  it('라이다 칸이 안 보이면 라이다 소켓을 닫고, 다시 보이면 연다', () => {
    mount('u-park'); serve('r7');
    const open = () => FakeWS.all.filter((x) => x.url.endsWith('/drive-media/lidar') && x.readyState !== 3).length;
    expect(open()).toBe(0);   // 처음 = 지도 + 작은 카메라
    view('lidar'); expect(open()).toBe(1);
    view('rgb'); expect(open()).toBe(0);
    view('lidar'); expect(open()).toBe(1);
  });

  it('라이다 칸의 «마지막 그림 · N초 전»은 칸 안에, 로봇 지도 고르기 · 자료 연결은 없다', () => {
    mount('u-park'); serve('r7'); view('lidar');
    const lid = lidSock();
    act(() => lid.open());
    act(() => { lid.recv({ t: 'media.points', version: 'media/1', channel: 'lidar', robot: 'r7', epoch: 1, episode_id: null, seq: 1, source: 'l1', encoding: 'xyz_f32le', frame: 'odom', map_version_id: null,
      pose: { x: 0, y: 0, z: 0, yaw: 0 }, count: 2, byte_length: 24, truncated: false }); lid.onmessage?.({ data: new Float32Array([1, 2, 0.5, -1, 0, 0]).buffer } as never); });
    tick(2100);
    expect($('[data-u4-big="lidar"] [data-feed-held]')!.textContent).toContain('마지막 그림 · 2초 전');
    expect($('.views .mapv [data-feed-held]')?.closest('[data-u4-map]')).toBeFalsy();
    expect(FakeWS.all.some((s) => /drive-media\/slam/.test(s.url))).toBe(false);
  });

  const FAULT = { devices: [{ key: 'go2-identity', kind: 'OTHER', label: IDENTITY_FAULT_LABEL, state: 'ERROR' }] } as Partial<ScreenState>;
  const OK = { devices: [{ key: 'go2-identity', kind: 'OTHER', label: '로봇 확인', state: 'OK' }] } as Partial<ScreenState>;
  const media = () => FakeWS.all.filter((x) => x.url.includes('/robots/r7/drive-media/'));
  const chans = () => new Set(media().filter((x) => x.readyState !== 3).map((x) => x.url.split('/').pop()));

  it('기체 확인 영구 오류면 카메라 · 라이다 구독을 놓고 라이다 그림을 지운다', () => {
    mount('u-park'); serve('r7'); view('lidar');
    const lid = lidSock();
    act(() => lid.open());
    occScan(lid, 1, [1, 2, 0.5, -1, 0, 0], { epoch: 1 });
    expect(lidarN()).toBe('2');
    act(() => push('r7', FAULT));
    expect(lid.readyState).toBe(3); expect(lidarN()).not.toBe('2');
    expect($('[data-u4-big="lidar"]')!.textContent).toContain(`${NO_SIGNAL.lidar} · ${BODY_FAULT}`);
    view('rgb');
    expect(chans().size).toBe(0);
    expect($('[data-u4-big="rgb"]')!.textContent).toContain(`${NO_SIGNAL.rgb} · ${BODY_FAULT}`);
  });

  it('새로고침 직후 그 로봇의 장치 표를 받기 전엔 채널을 열지 않고, 영구 오류 표면 계속 닫아 둔다(RV-442 ①)', () => {
    mount('u-park'); serve();
    expect(can()).not.toBeNull();
    tick(10_000);
    expect(media().length).toBe(0); expect($('.views .small')!.textContent).toContain(`${NO_SIGNAL.rgb} · ${BODY_CHECK}`);
    act(() => push('r7', FAULT));
    tick(10_000);
    expect(media().length).toBe(0); expect($('.views .small')!.textContent).toContain(`${NO_SIGNAL.rgb} · ${BODY_FAULT}`);
    act(() => push('r7', OK));
    expect(chans()).toEqual(new Set(['rgb']));   // 지도 보기 = 작은 카메라 칸 하나
  });

  it('다른 로봇을 보는 동안 받은 영구 오류 — 상태 소켓이 다시 붙은 뒤 표를 받기 전엔 열지 않고 옛 그림도 없다(RV-442 ②)', () => {
    mount('u-park'); serve('r7');
    const rgb = media().find((x) => x.url.endsWith('/rgb'))!;
    act(() => { rgb.open(); rgb.recv({ t: 'media.video', version: 'media/1', channel: 'rgb', robot: 'r7', epoch: 1, episode_id: null, seq: 1, mime: 'image/jpeg', jpeg: 'AAAA' }); });
    expect($('.views .small img')).not.toBeNull();
    click($('.rail .rcard[data-r="Go2-3"]')!);
    expect(chans().size).toBe(0);
    act(() => push('r7', FAULT));
    act(() => { w.drop(1006); }); tick(1000); serve();
    const n = media().length;
    click($('.rail .rcard[data-r="Go2-7"]')!);
    tick(10_000);
    expect(media().length).toBe(n); expect($('.views .small img')).toBeNull();
    act(() => push('r7', FAULT));
    tick(10_000);
    expect(media().length).toBe(n); expect($('.views .small')!.textContent).toContain(`${NO_SIGNAL.rgb} · ${BODY_FAULT}`);
    act(() => push('r7', OK));
    expect(chans()).toEqual(new Set(['rgb']));
  });

  // 온도(RB-TEMP-WEB): 머리 칩 = 관절 최고 온도. 60 °C 넘으면 시안 u4_2(칩 bad · 그 관절 이름 · 3D 칸 경고 표지)
  const JT = [30, 31, 32, 33, 34, 41, 35, 36, 37, 38, 39, 40];
  const warm = (age = 0.5, t: Record<string, unknown> = {}) => ({ ...info(), temperature: { joints: JT, battery: [28, 30, null, 29], imu: 36, body: [38, null], age_s: age, ...t } }) as unknown as ScreenState['robot_info'];
  const temp = () => $('[data-cell="temp"]')!;
  it('온도 칩: 관절 최고 41 °C · 「최고 관절 온도」, 60 °C 넘으면 그 관절 이름 + 경고 칸 · 3D 칸 표지', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { robot_info: warm() }));
    expect(temp().textContent).toBe('41 °C최고 관절 온도'); expect(temp().className).toBe('g dk st');
    // 새 표본(수신 시각이 바뀐 관절 보고)과 함께 온 온도 — rt 는 같은 표본이면 다시 그리지 않는다
    const hot = warm(0.5, { joints: JT.map((v, i) => (i === 0 ? 62 : v)) })!; hot.joints!.received_at = '2026-11-19T00:00:01Z';
    act(() => push('r7', { robot_info: hot }));
    expect(temp().textContent).toBe('62 °C앞 오른 엉덩이'); expect(temp().className).toBe('g dk st bad warncell');
    expect($('[data-u4-hot]')!.textContent).toBe('앞 오른 엉덩이 62 °C · 경고');
  });

  it('온도가 없거나 오래되면(3초 넘음) 칩 「없음」 · 3D 칸 흐림과 따로', () => {
    mount('u-park'); serve('r7');
    for (const ri of [info(), warm(TEMP_STALE_S + 0.5), { ...info(), temperature: null }, warm(0.5, { joints: JT.map(() => null), battery: [null, null, null, null], imu: null, body: [null, null] })]) {
      act(() => push('r7', { robot_info: ri as ScreenState['robot_info'] }));
      expect(temp().textContent).toBe('없음최고 관절 온도');
      expect($('.stage3d')!.hasAttribute('data-stale')).toBe(false);
    }
  });

  it('RV-409 3 관절각 · 온도 age_s 1.5: 3D 칸은 흐려도 칩 41 °C 는 같은 기준(3초)으로 남는다', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { robot_info: { ...info(1.5), temperature: { joints: JT, battery: [28, 30, null, 29], imu: 36, body: [38, null], age_s: 1.5 } } as unknown as ScreenState['robot_info'] }));
    expect($('.stage3d')!.hasAttribute('data-stale')).toBe(true);
    expect(temp().textContent).toMatch(/^41 °C/);
  });

  it('RV-409 4 온도 age_s 2.8 뒤 다음 보고가 없으면 화면 시계로 나이를 늘려 3초 넘을 때 「없음」', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { robot_info: warm(2.8) }));
    expect(temp().textContent).toMatch(/^41 °C/);
    tick(500);
    expect(temp().textContent).toMatch(/^없음/);
  });

  it('go2Temps: 연결 · 새 보고일 때만, 관절 12개 아니면 관절만 비움, 숫자 아닌 값은 버림', () => {
    const s = state('r7', { robot_info: warm() });
    expect(go2Temps(s, true)).toEqual({ joints: JT, hot: 5, battery: 30, inside: 38 });
    expect(go2Temps(s, false)).toBeNull(); expect(go2Temps({ ...s, connection: 'OFFLINE' }, true)).toBeNull();
    expect(go2Temps(state('r7', { robot_info: warm(0.5, { age_s: undefined }) }), true)).toBeNull();
    expect(go2Temps(state('r7', { robot_info: warm(0.5, { joints: JT.slice(1), imu: 'x', body: [NaN, 37] }) }), true)).toEqual({ joints: JT.map(() => null), hot: -1, battery: 30, inside: 37 });
  });

  it('go2Pose: 관절 12개 · 연결 · 새것일 때만, 이름 순서대로 다시 맞춤', () => {
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

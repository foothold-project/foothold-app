// RB-PC-DRIVE-3COL(11-19) PC 로봇 탭 «바로 조종» 세 칸 화면: 허용 로봇 = 본문이 곧 조종 화면(모달 없음), 허용 안 됨 = 읽기 전용,
// STOP 늘 보임, 가운데 4칸(큰 1 + 작은 3 ↔ 4분할), 보고 없음 = Go2 그림 흐림, 키 조종 초점 잃음 = 0. 가짜 WebSocket 은 serverdrive.test 와 같은 흉내.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenState } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { FakeWS, fail, lease, state } from './fakeWs';
import { simTune } from '../phone';
import { api } from '../api';
import { SD_NOTE } from '../serverdrive';
import { REPORT_STALE_MS, TEMP_STALE_S, go2Pose, go2Temps } from '../pcdrive';
import { TEMP_MAX, TEMP_MIN, tempColor } from '../go2model';
import quadCss from '../quad.css?raw';
import pcCss from '../pcdrive.css?raw';

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
/** 조직 설정은 바로 빈 설정으로 — 받기 전에는 0 이라(RB-DRIVE-NEUTRAL-FIX) */
const spySettings = () => vi.spyOn(api, 'settings');
/** 계약 OrgSettings 필수 칸(서버 기본값) — 전체 스키마 검증을 통과하는 가장 작은 조직 설정(RV-426 ①) */
const ORG = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
let settingsMock: ReturnType<typeof spySettings>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  settingsMock = spySettings().mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
});
afterEach(() => { act(() => root?.unmount()); settingsMock.mockRestore(); simTune(null); root = null; box?.remove(); vi.useRealTimers(); });

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

  // RB-PC-DRIVE-OFFLINE(11-19): 한 번 허용된 로봇이 끊겨도(서버 목록 = 허용 꺼짐 + 까닭 «로봇 연결 없음»뿐) 세 칸 화면 그대로, 조종만 꺼짐
  const drop = (rs: Robot[], blocked: NonNullable<Robot['serverDriveBlocked']>) => rs.map((r) => (r.id === 'r7' ? { ...r, serverDrive: false, serverDriveBlocked: blocked } : r));
  const relist = (robots: Robot[]) => act(() => { root!.render(<App user={USERS.find((u) => u.id === 'u-park')} robots={robots} />); });
  it('로봇 연결이 끊겨도 세 칸 유지 — 조종 시작·단추·키 꺼짐·명령 0, 쉬운 말 안내, STOP 은 그대로 · 다시 연결돼도 자동 조종 없음', () => {
    mount('u-park'); serve('r7');
    click(btn('조종 시작')); click(btn('② 잠금 해제')); tick(100);
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    act(() => { push('r7', { connection: 'OFFLINE', latched: null, robot_info: null }); });   // 목록 갱신 전에도 state 로 끊김
    expect($('[data-pc-drive]')).not.toBeNull(); expect(lastAxes()).toBe('0,0,0');
    expect($('[data-pd-offline]')!.textContent).toBe('로봇 연결이 끊겼습니다 · 다시 연결되면 «조종 시작»을 다시 누르세요');
    act(() => { w.recv(lease('r7', null)); }); relist(drop(ON, ['AGENT_OFFLINE']));
    key('keyup', 'ArrowUp');
    expect($('[data-pc-drive]')).not.toBeNull(); expect($('[data-pd-left]')).not.toBeNull(); expect($('[aria-label="조종 보기 4칸"]')).not.toBeNull(); expect($('[data-pd-make]')).not.toBeNull();
    expect($('[data-pd-noreport]')).not.toBeNull(); expect($('[data-pd-left]')!.hasAttribute('data-stale')).toBe(true);
    expect($('[data-pd-offline]')).not.toBeNull(); expect($('[data-pc-drive]')!.textContent).not.toMatch(/충전|전원/);   // 세 칸 화면 안은 까닭 추측 없음
    expect((btn('조종 시작') as HTMLButtonElement).disabled).toBe(true);
    const n = w.of('cmd').length, takes = w.of('lease.take').length;
    click(btn('조종 시작')); key('keydown', 'ArrowUp'); tick(300); key('keyup', 'ArrowUp');
    expect(w.of('cmd').length).toBe(n); expect(w.of('lease.take').length).toBe(takes);   // 명령도 조종권 요청도 나가지 않음
    const stop = $('[data-pd-top] [data-sd-stop="full"]') as HTMLButtonElement;
    expect(stop.disabled).toBe(false); click(stop); expect(w.of('stop').length).toBe(1);
    // 다시 연결: 같은 화면, 안내 사라짐, 조종 시작은 다시 눌러야(자동 조종권·명령 없음)
    relist(ON); act(() => { push('r7', { connection: 'ONLINE', latched: true }); }); tick(300);
    expect($('[data-pc-drive]')).not.toBeNull(); expect($('[data-pd-offline]')).toBeNull();
    expect(w.of('cmd').length).toBe(n); expect(w.of('lease.take').length).toBe(takes);
    expect((btn('조종 시작') as HTMLButtonElement).disabled).toBe(false);
    click(btn('조종 시작')); expect(w.of('lease.take').length).toBe(takes + 1);
  });

  // RV-412 1: 서버 목록의 끊김(AGENT_OFFLINE)이 WS state·조종권 회수보다 먼저 와도 누른 것을 버리고 0 만 — 복구 뒤에도 «조종 시작» 다시 + 새로 눌러야 이동
  it('목록 끊김이 먼저 와도 끊김 동안·복구 뒤 0 이 아닌 명령 없음, «조종 시작» 다시 누르고 새로 눌러야만 이동 · STOP 은 그대로', () => {
    mount('u-park'); serve('r7');
    click(btn('조종 시작')); click(btn('② 잠금 해제')); tick(100);
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
    const n = axes().length, moving = () => axes().slice(n).filter((a) => a !== '0,0,0');
    relist(drop(ON, ['AGENT_OFFLINE']));   // state 는 아직 ONLINE, 조종권도 아직 내 것 — 목록만 먼저
    tick(150);
    expect(moving()).toEqual([]); expect(w.of('lease.release').length).toBe(1);
    expect($('[data-pd-offline]')).not.toBeNull();
    const stop = $('[data-pd-top] [data-sd-stop="full"]') as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    relist(ON); tick(300);   // 목록 복구 — 키는 계속 누른 채
    expect(moving()).toEqual([]); expect($('[data-pd-offline]')).toBeNull();
    key('keydown', 'ArrowUp'); tick(100); expect(moving()).toEqual([]);   // 조종권 없이 눌러도 없음
    click(btn('조종 시작')); tick(100);
    expect(moving()).toEqual([]);   // 시작만으로는 움직이지 않음(누른 채였던 키는 버려짐)
    key('keyup', 'ArrowUp'); key('keydown', 'ArrowUp'); tick(60);
    expect(lastAxes()).toBe('1.5,0,0');
    key('keyup', 'ArrowUp'); click(stop); expect(w.of('stop').length).toBe(1);
  });

  // RV-413: «조종 시작» 답을 기다리는 사이 목록이 끊김→복구되고 그 뒤 앞 요청이 승인돼도 무효 — 바로 반납, 0 이 아닌 명령 없음
  it('요청 보류 중 끊김→복구 뒤 늦은 승인은 바로 반납 — 잠금 해제·↑ 해도 0 이 아닌 명령 없음, «조종 시작» 다시 누르면 이동', () => {
    mount('u-park'); serve('r7');
    const auto = w.auto!; let held: string | null = null;
    w.auto = (m) => (m.t === 'lease.take' && !held ? void (held = m.id as string) : auto(m));   // 첫 요청은 답 보류
    click(btn('조종 시작')); expect(w.of('lease.take').length).toBe(1);
    relist(drop(ON, ['AGENT_OFFLINE'])); tick(100);
    relist(ON); tick(100);
    act(() => { w.recv({ t: 'reply', id: held, ok: true }); w.recv(lease('r7', PARK, 'Llate')); w.recv({ t: 'lease.result', robot: 'r7', request_id: null, result: 'ACCEPTED' }); });
    tick(100);
    expect(w.of('lease.release').length).toBe(1);
    const unlock = [...box.querySelectorAll('button')].find((b) => b.textContent?.startsWith('② 잠금 해제'));
    if (unlock) click(unlock);
    key('keydown', 'ArrowUp'); tick(300); key('keyup', 'ArrowUp');
    expect(axes().filter((a) => a !== '0,0,0')).toEqual([]);
    expect(w.of('lease.take').length).toBe(1);
    click(btn('조종 시작')); tick(100); expect(w.of('lease.take').length).toBe(2);   // 끊긴 뒤 새로 누른 것만 유효
    click(btn('② 잠금 해제')); tick(100);
    key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0'); key('keyup', 'ArrowUp');
    expect(w.of('lease.release').length).toBe(1);
  });

  // RV-412 2: 끊김 유지 기록은 로그인(사용자·세션)별 — A 가 허용받았던 로봇을 끊긴 채 B 에게 배정하고 같은 탭에서 B 로 로그인하면 옛 화면
  it('끊김 유지 기록은 로그인별 — 사용자가 바뀌거나 다시 로그인하면 지워져 옛 화면', () => {
    const g1 = new AbortController(), as = (user: string, robots: Robot[], cancel?: AbortSignal, k = user) =>
      act(() => { root!.render(<App key={k} user={USERS.find((u) => u.id === user)} robots={robots} cancel={cancel} />); });
    mount('u-park'); serve('r7');
    as('u-park', ON, g1.signal, 'park-1'); expect($('[data-pc-drive]')).not.toBeNull();
    as('u-park', drop(ON, ['AGENT_OFFLINE']), g1.signal, 'park-1'); expect($('[data-pc-drive]')).not.toBeNull();   // 같은 로그인 — 유지
    const toLee = drop(ON.map((r) => (r.id === 'r7' ? { ...r, owner: 'u-lee', ownerName: '이OO' } : r)), ['AGENT_OFFLINE']);
    g1.abort(); as('u-lee', toLee, new AbortController().signal); serve('r7');
    expect($('[data-pc-drive]')).toBeNull();
    // 같은 사람도 로그아웃 뒤 다시 로그인(새 세션)하면 지워짐
    const g2 = new AbortController();
    as('u-park', ON, g2.signal, 'park-2'); expect($('[data-pc-drive]')).not.toBeNull();
    g2.abort(); as('u-park', drop(ON, ['AGENT_OFFLINE']), new AbortController().signal, 'park-3');
    expect($('[data-pc-drive]')).toBeNull();
  });

  it('끊김 유지는 한 번 허용됐던 로봇만, 까닭이 «로봇 연결 없음» 하나일 때만 — 처음부터 끊긴 로봇·스위치 꺼짐은 지금처럼 옛 화면', () => {
    // 다른 시험이 r7 을 이미 허용 로봇으로 기억했으므로(새로 고침 전까지) 이 시험은 처음 보는 id
    const X = (rs: Robot[]) => rs.map((r) => (r.id === 'r7' ? { ...r, id: 'r7x' } : r)), drop = (rs: Robot[], blocked: NonNullable<Robot['serverDriveBlocked']>) => X(rs).map((r) => (r.id === 'r7x' ? { ...r, serverDrive: false, serverDriveBlocked: blocked } : r));
    mount('u-park', drop(ROBOTS, ['AGENT_OFFLINE'])); serve('r7x');
    expect($('[data-pc-drive]')).toBeNull(); expect($('[aria-label="조종 준비"]')).not.toBeNull();
    relist(X(ON)); expect($('[data-pc-drive]')).not.toBeNull();
    relist(drop(ON, ['SWITCH_OFF'])); expect($('[data-pc-drive]')).toBeNull();
    relist(drop(ON, ['AGENT_OFFLINE'])); expect($('[data-pc-drive]')).not.toBeNull();
    relist(drop(ON.map((r) => (r.id === 'r7' ? { ...r, owner: 'u-lee' } : r)), ['AGENT_OFFLINE'])); expect($('[data-pc-drive]')).toBeNull();
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
    expect(pcCss).toMatch(/\.pd-noreport\{[^}]*pointer-events:none/);   // 안내가 아래 온도 점의 마우스 올림·누름을 막지 않음(RV-410)
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

  it('상태 글자는 그림 위 별도 영역(그림 칸 밖·겹쳐 놓지 않음), 그림 칸엔 Go2·관절 값 12개만 — «관절 값» 단추로 끄고 켬', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { robot_info: info() }));
    const facts = $('[data-pd-facts]')!, stage = $('[data-pd-stage]')!;
    expect(stage.contains(facts)).toBe(false); expect(facts.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const k of ['posture', 'move', 'battery', 'speed', 'hspeed', 'holder', 'why', 'ago']) {
      expect(facts.querySelector(`[data-pd="${k}"]`)).not.toBeNull(); expect(stage.querySelector(`[data-pd="${k}"]`)).toBeNull();
    }
    expect(pcCss).not.toMatch(/\.pd-facts\{[^}]*position:absolute/);
    expect(stage.querySelectorAll('[data-go2-joint]')).toHaveLength(12);
    click($('[data-pd-tags]')!);
    expect($('[data-pd-tags]')!.getAttribute('aria-pressed')).toBe('false'); expect(stage.querySelectorAll('[data-go2-joint]')).toHaveLength(0);
    click($('[data-pd-tags]')!);
    expect(stage.querySelectorAll('[data-go2-joint]')).toHaveLength(12);
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
    key('keydown', 'KeyA'); tick(60); expect(lastAxes()).toBe('0,0,2.5');
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

  // RV-397 막는 것 1~4: 가운데 4칸 전체화면(이 묶음만 Fullscreen API) — jsdom 에는 없으므로 흉내(바로 fullscreenchange)
  const fullscreen = () => {
    const qd = $('[aria-label="조종 보기 4칸"]')!;
    let el: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });
    qd.requestFullscreen = async () => { el = qd; document.dispatchEvent(new Event('fullscreenchange')); };
    document.exitFullscreen = async () => { el = null; document.dispatchEvent(new Event('fullscreenchange')); };
    return qd;
  };
  const driving = () => { click(btn('조종 시작')); click(btn('② 잠금 해제')); tick(100); key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0'); };
  afterEach(() => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null }); });

  it('전체화면을 «4분할»·«전체화면 끝»·브라우저(Esc)로 벗어나면 그 순간 0 — 키를 누르고 있어도 재개 없음', async () => {
    mount('u-park'); serve('r7');
    fullscreen(); driving();
    for (const leave of [() => click($('[data-q-grid]')!), () => click(btn('전체화면 끝')), () => act(async () => { await document.exitFullscreen(); })]) {
      if (!$('.qd.f')) click($('[data-q-grid]')!);
      await act(async () => { btn('전체화면').click(); });
      expect($('[data-qfs-stop]')).not.toBeNull();
      key('keydown', 'ArrowUp'); tick(60); expect(lastAxes()).toBe('1.5,0,0');
      await leave();
      expect($('[data-qfs-stop]')).toBeNull();
      expect(lastAxes()).toBe('0,0,0');
      tick(220); expect(lastAxes()).toBe('0,0,0');
      key('keyup', 'ArrowUp');
    }
  });

  it('전체화면 STOP 이 거절되면 전체화면 안 STOP 옆에 «정지 요청 실패 — 현장 확인»', async () => {
    mount('u-park'); serve('r7');
    const auto = w.auto!; w.auto = (m) => (m.t === 'stop' ? fail('ROBOT_OFFLINE', '거절') : auto(m));
    const qd = fullscreen();
    await act(async () => { btn('전체화면').click(); });
    click($('[data-qfs-stop] [data-sd-stop]')!); tick(100);
    expect(w.of('stop').length).toBe(1);
    const inner = $('[data-qfs-stop] [data-sd-stop-phase]');
    expect(inner && qd.contains(inner)).toBe(true);
    expect(inner!.textContent).toContain('정지 요청 실패 — 현장 확인');
    // RV-398: 좁은 전체화면(768×400·800×600)에서 긴 실패 사유가 STOP 뒤로 넘쳐 가려지지 않게 칩이 줄바꿈 — 좌표는 headless(runs 사진)로
    expect(inner!.firstElementChild!.classList.contains('lv-chip')).toBe(true);
    expect(quadCss.replace(/\s+/g, '')).toMatch(/\.qd:fullscreen\.qfs-bar>\[data-sd-stop-phase\]>\.lv-chip\{[^}]*white-space:normal/);
  });

  it('전체화면의 «전체화면 끝»은 STOP 과 같은 줄에 따로(겹쳐 놓지 않음) — 눌러도 stop 0건', async () => {
    mount('u-park'); serve('r7');
    fullscreen();
    await act(async () => { btn('전체화면').click(); });
    const bar = $('[data-qfs-stop]')!, end = btn('전체화면 끝');
    expect(bar.contains(end) && bar.contains($('[data-qfs-stop] [data-sd-stop]'))).toBe(true);   // 한 flex 줄 = 서로 자리를 비킴(실제 좌표는 headless 로)
    await act(async () => { end.click(); });
    expect(w.of('stop').length).toBe(0);
  });

  it('지도·라이다 칸이 모두 안 보이면 라이다 소켓을 닫고, 다시 보이면 연다', () => {
    mount('u-park'); serve('r7');
    const open = () => FakeWS.all.filter((x) => x.url.endsWith('/drive-media/lidar') && x.readyState !== 3).length;
    expect(open()).toBe(1);
    click($('[aria-label="조종 보기 4칸"] [data-tile="rgb"] .qh')!);   // 카메라 크게
    expect(open()).toBe(1);   // 지도·라이다는 작은 칸으로 보임
    click($('.qpip')!);   // 작은 칸 숨김 = 카메라만
    expect(open()).toBe(0);
    click($('.qpip')!);
    expect(open()).toBe(1);
  });

  // RB-TEMP-WEB(11-19): robot_info.temperature — 관절 12개(JOINTS 순서)·배터리 4·자세 센서·본체 2·age_s
  const JT = [30, 31, 32, 33, 34, 41, 35, 36, 37, 38, 39, 40];
  const warm = (age = 0.5, t: Record<string, unknown> = {}) => ({ ...info(), temperature: { joints: JT, battery: [28, 30, null, 29], imu: 36, body: [38, null], age_s: age, ...t } }) as unknown as ScreenState['robot_info'];
  const paint = (c: string) => { const d = document.createElement('i'); d.style.background = c; return d.style.background; };
  const dots = () => [...$('[data-pd-stage]')!.querySelectorAll<HTMLElement>('[data-go2-temp]')];
  it('온도: 관절 자리 점 12개를 온도 색으로(한 색상 눈금·범례 20~80°C), 라벨엔 각도만, 위쪽 카드 3개(관절 최고·배터리·몸 안)', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { robot_info: warm() }));
    const stage = $('[data-pd-stage]')!;
    expect(dots().map((d) => d.getAttribute('data-go2-temp'))).toEqual(NAMES);
    dots().forEach((d, i) => expect(d.style.background).toBe(paint(tempColor(JT[i]))));
    expect(new Set(dots().map((d) => d.style.background)).size).toBe(12);   // 온도마다 다른 색
    const tags = [...stage.querySelectorAll('[data-go2-joint]')];
    expect(tags).toHaveLength(12); tags.forEach((t) => expect(t.textContent).not.toContain('°C'));
    expect($('[data-go2-legend]')!.textContent).toBe(`${TEMP_MIN}°C${TEMP_MAX}°C`);
    const f = (k: string) => $(`[data-pd-left] [data-pd="${k}"]`)!.textContent;
    expect(f('temp-joint')).toContain('41°C (앞 왼 종아리)'); expect(f('temp-battery')).toContain('30°C'); expect(f('temp-inside')).toContain('38°C');
    click($('[data-pd-tags]')!);   // «관절 값» 끄면 각도 글자만 숨김, 온도 점은 그대로
    expect(stage.querySelectorAll('[data-go2-joint]')).toHaveLength(0); expect(dots()).toHaveLength(12);
  });
  it('관절 점에 마우스·키보드 초점·누름 = «이름 온도 · 각도» 설명, 떠나면 사라짐', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { robot_info: warm() }));
    const hot = () => dots().find((d) => d.getAttribute('data-go2-temp') === 'FL_calf_joint')!, tip = () => $('[data-go2-tip]');
    expect(tip()).toBeNull(); expect(hot().getAttribute('aria-label')).toBe('앞 왼 종아리 41°C · 11°');
    act(() => { hot().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(tip()!.textContent).toBe('앞 왼 종아리 41°C · 11°'); expect(tip()!.getAttribute('role')).toBe('tooltip');
    act(() => { hot().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    expect(tip()).toBeNull();
    act(() => dots()[0].focus());
    expect(tip()!.textContent).toBe('앞 오른 엉덩이 30°C · 11°');
    act(() => dots()[0].blur()); expect(tip()).toBeNull();
    click(hot()); expect(tip()!.textContent).toContain('41°C');   // 터치(누름)
  });
  it('온도가 없거나 오래되면(3초 넘음) 관절 점은 회색·설명 «온도 모름», 위쪽 온도 카드 «—» — 각도·그림은 그대로', () => {
    mount('u-park'); serve('r7');
    const f = (k: string) => $(`[data-pd-left] [data-pd="${k}"] b`)!.textContent;
    for (const ri of [info(), warm(TEMP_STALE_S + 0.5), { ...info(), temperature: null }, warm(0.5, { joints: JT.map(() => null), battery: [null, null, null, null], imu: null, body: [null, null] })]) {
      act(() => push('r7', { robot_info: ri as ScreenState['robot_info'] }));
      expect(['temp-joint', 'temp-battery', 'temp-inside'].map(f)).toEqual(['—', '—', '—']);
      expect($('[data-pd-left]')!.hasAttribute('data-stale')).toBe(false);
      expect(dots()).toHaveLength(12); dots().forEach((d) => expect(d.style.background).toBe(paint(tempColor(null))));
      expect(dots()[0].getAttribute('aria-label')).toBe('앞 오른 엉덩이 온도 모름 · 11°');
      expect($('[data-pd-stage]')!.querySelectorAll('[data-go2-joint]')).toHaveLength(12);
    }
  });
  it('RV-409 3 관절각·온도 age_s 1.5: 그림은 흐려도 카드 41°C 와 같은 기준(3초)으로 온도 점 12개·범례·설명이 남는다', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { robot_info: { ...info(1.5), temperature: { joints: JT, battery: [28, 30, null, 29], imu: 36, body: [38, null], age_s: 1.5 } } as unknown as ScreenState['robot_info'] }));
    expect($('[data-pd-left]')!.hasAttribute('data-stale')).toBe(true);
    expect($('[data-pd-left] [data-pd="temp-joint"]')!.textContent).toContain('41°C');
    expect(dots()).toHaveLength(12); dots().forEach((d, i) => expect(d.style.background).toBe(paint(tempColor(JT[i]))));
    expect($('[data-go2-legend]')).not.toBeNull();
    const hot = dots().find((d) => d.getAttribute('data-go2-temp') === 'FL_calf_joint')!;
    act(() => { hot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect($('[data-go2-tip]')!.textContent).toBe('앞 왼 종아리 41°C');
    expect(pcCss).not.toMatch(/\[data-stale\] \.pd-go2\{/);   // 흐림은 그림만 — 온도 점·범례 색은 그대로
  });
  it('RV-409 4 온도 age_s 2.8 뒤 다음 보고가 없으면 화면 시계로 나이를 늘려 3초 넘을 때 «—»', () => {
    mount('u-park'); serve('r7');
    const f = (k: string) => $(`[data-pd-left] [data-pd="${k}"] b`)!.textContent;
    act(() => push('r7', { robot_info: warm(2.8) }));
    expect(f('temp-battery')).toBe('30°C');
    tick(500);   // 실제 3.3초 — 다음 보고 없음
    expect(['temp-joint', 'temp-battery', 'temp-inside'].map(f)).toEqual(['—', '—', '—']);
    dots().forEach((d) => expect(d.style.background).toBe(paint(tempColor(null))));
  });
  it('RV-409 말풍선이 뜨면 그 관절 각도 글자는 숨는다(말풍선에 각도가 있음) — 말풍선이 위', () => {
    mount('u-park'); serve('r7');
    act(() => push('r7', { robot_info: warm() }));
    const tag = () => $('[data-pd-stage] .pd-go2-view [data-go2-joint="FL_calf_joint"]');
    expect(tag()).not.toBeNull();
    const hot = dots().find((d) => d.getAttribute('data-go2-temp') === 'FL_calf_joint')!;
    act(() => { hot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect($('[data-go2-tip]')!.textContent).toBe('앞 왼 종아리 41°C · 11°'); expect(tag()).toBeNull();
    act(() => { hot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    expect(tag()).not.toBeNull();
  });
  it('go2Temps: 연결·새 보고일 때만, 관절 12개 아니면 관절만 비움, 숫자 아닌 값은 버림', () => {
    const s = state('r7', { robot_info: warm() });
    expect(go2Temps(s, true)).toEqual({ joints: JT, hot: 5, battery: 30, inside: 38 });
    expect(go2Temps(s, false)).toBeNull(); expect(go2Temps({ ...s, connection: 'OFFLINE' }, true)).toBeNull();
    expect(go2Temps(state('r7', { robot_info: warm(0.5, { age_s: undefined }) }), true)).toBeNull();
    expect(go2Temps(state('r7', { robot_info: warm(0.5, { joints: JT.slice(1), imu: 'x', body: [NaN, 37] }) }), true)).toEqual({ joints: JT.map(() => null), hot: -1, battery: 30, inside: 37 });
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

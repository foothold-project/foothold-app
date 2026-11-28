// 조종 탭(02 F-TO-01~05)·STOP(F-COM-01)·실시간 연결(05 §9) — 가짜 WebSocket(fakeWs.ts)이 서버 중재기 역할.
// 판정(조종권·넘김·정지 확인)은 서버 몫이라, 여기서는 화면이 보내는 것(sent)과 서버 값을 그대로 보이는지를 본다. 시간은 가짜 시계.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { pcBoard } from '../pcboard';
import type { ScreenState } from '../../../contracts/ts';
import { App, PHONE_Q } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { fleetNames, fleetRow } from './fleetRow';
import { tabFromHash } from '../menu';
import { api, onAuthLost as setAuthLost } from '../api';
import { COOLDOWN_S, FAIL_TEXT, FREE_TEXT, REQUEST_S, STOP_HTTP_MS, STOP_WS_MS, rt } from '../rt';
import { FakeWS, fail, lease, state } from './fakeWs';
import { STALLED } from '../simdrive';
import { driveBlock } from '../fake';
import { COMBO_BLOCK, MAX_TURN_RATE, SIDE_BLOCK, stopLine } from '../serverdrive';
import { simTune } from '../phone';
import { CAP_BLOCK, DEMO_RULE, REAL_STICK, REAL_WAIT, REAL_WAIT_PILL, demoCaps } from '../drive';
import { shape } from '../robotact';
import { ACTS, STANDUP_WHY, actWhy } from '../robotact';
import driveCss from '../drive.css?raw';
import frameCss from '../frame.css?raw';
import u1AppCss from '../screens/u1.app.css?raw';
import u1dCss from '../screens/u1d.css?raw';
import u135Css from '../screens/u135.css?raw';
import u135AppCss from '../screens/u135.app.css?raw';
import u142Css from '../screens/u142.css?raw';
import u142AppCss from '../screens/u142.app.css?raw';
// 옛 PC 관제 부품(관제 요약 · 상세 서랍 · 연결 상태 · 조종 준비) 시험: PC 로봇 탭은 시안 u4 라 부품을 앱 맥락 안에 직접 그린다 → W1 u5
beforeEach(() => { pcBoard.on = true; });
afterEach(() => { pcBoard.on = false; });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
/** 예전 «총괄 김OO가 아무 로봇이나 조종» 시험은 세 로봇을 모두 맡은 운영 관리자 김OO 로 그대로 본다(이름·id 같음, 10-25 때 나눔 · 11/28 총괄도 실기 조종).
 *  진짜 총괄은 ADMIN */
const ADMIN = 'admin';
const as = (user: string, robots: Robot[] = ROBOTS) => {
  const kim = user === 'u-kim', me = user === ADMIN ? USERS[0] : kim ? { ...USERS[0], role: 'OPERATOR' as const } : USERS.find((u) => u.id === user);
  return { user: me, robots: kim ? robots.map((r) => ({ ...r, owner: 'u-kim', ownerName: '김OO' })) : robots };
};
/** robots = 서버 /robots 응답(기본 = 가짜 3대 전부). 붙이면 rt.connect → 가짜 WebSocket 하나(아직 안 열림) */
/** 폰 기본 = 서버 경유 실기(목록 server_drive 허용) — 폰 조종 화면의 비례 입력은 시뮬로 확인된 로봇만(RB-PHONE-REAL-TABLE-FIX), 실기는 표 값 */
const SD_ROBOTS = ROBOTS.map((r) => ({ ...r, serverDrive: true }));
function mount(phone: boolean, user: string, hash: string, robots: Robot[] = phone ? SD_ROBOTS : ROBOTS) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App {...as(user, robots)} />); });
}
// 판정은 단조 시계(performance.now): advanceTimersByTime 은 그것도 움직이고, setSystemTime(벽시계)은 움직이지 않는다
/** 조직 설정 응답: 기본은 바로(같은 틀에) 빈 설정. 늦은 응답을 볼 시험은 settingsLater() */
const spySettings = () => vi.spyOn(api, 'settings');
/** 계약 OrgSettings 필수 칸(서버 기본값) — 전체 스키마 검증을 통과하는 가장 작은 조직 설정(RV-426 ①) */
const ORG = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
let settingsMock: ReturnType<typeof spySettings>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  settingsMock = spySettings().mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
});
afterEach(() => {
  act(() => root?.unmount()); root = null; box?.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  settingsMock.mockRestore(); simTune(null);
  delete (document as { visibilityState?: string }).visibilityState;
});

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t)!;
const text = () => box.textContent!;
const band = () => $('[data-band]').textContent!;
/** 폰 로봇 연결의 로봇 카드, PC 로봇 탭 목록의 행 */
const card = (name: string) => [...box.querySelectorAll('.dv-card')].find((li) => li.textContent!.includes(name))!;
const row = (name: string) => fleetRow(box, name);
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
/** 「다시 시작」(시안 u1_3 자리 · 잠금 해제) → 확인 창(u4_10 과 같은 글) 「일어서기」 = unlock 한 번 */
function unlock() {
  click(btn('다시 시작'));
  const go = $('[data-restart-ask] button.dpri');
  expect(go.textContent).toBe('일어서기');
  click(go);
}
function ready() {
  click(btn('조종'));
  unlock();
  tick(100);
  expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
}

describe('폰 실기 조종 화면 영상 (시안 u1_2 · PC 와 같은 drive-media)', () => {
  const media = (ch: string) => FakeWS.all.filter((x) => x.url.endsWith(`/api/v1/robots/r7/drive-media/${ch}`) && x.readyState !== 3).pop();
  const video = (p: object = {}) => ({ t: 'media.video', version: 'media/1', channel: 'rgb', robot: 'r7', epoch: 1, episode_id: null, seq: 1, mime: 'image/jpeg', jpeg: 'AAAA', ...p });
  it('서버 경유 실기는 카메라 · 라이다를 받아 그리고, 뎁스는 고른 동안만 연다. 보내는 것 0', () => {
    mount(true, 'u-kim', '#/drive');
    serve(KIM, 'r3', 'r7', 'r1');
    click(card('Go2-7').querySelector('button')!);
    const rgb = media('rgb')!, lid = media('lidar')!;
    expect(rgb.url).toBe(`ws://${location.host}/api/v1/robots/r7/drive-media/rgb`);
    expect(lid).toBeTruthy();
    expect(media('depth')).toBeUndefined();
    act(() => { rgb.open(); rgb.recv(video()); });
    expect($('.dv-stage img[data-sd-cam]').getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    click(btn('지도'));   // 큰 칸 = 라이다(위에서 본 그림) · 작은 칸 = 같은 카메라
    expect($('.dv-stage > [data-lidar-map]')).toBeTruthy();
    expect($('.dv-mini img[data-sd-cam]').getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    click(btn('뎁스'));
    expect(media('depth')).toBeTruthy();
    expect($('[data-sd-depth]').textContent).toContain('뎁스 카메라 신호 없음');
    click(btn('RGB'));
    expect(media('depth')).toBeUndefined();
    expect(rgb.sent.length + lid.sent.length).toBe(0);
  });
  it('서버 경유가 아닌 로봇은 영상 연결을 열지 않는다', () => {
    mount(true, 'u-kim', '#/drive', ROBOTS);
    serve(KIM, 'r3', 'r7', 'r1');
    click(card('Go2-7').querySelector('button')!);
    expect(FakeWS.all.some((x) => x.url.includes('/drive-media/'))).toBe(false);
  });
});

describe('폰 칩 · 펼침 칸 · 관절 온도 띠 (시안 u1_7 · u1_9 · u1_10 · u3_2)', () => {
  const chipText = () => $('.u1-chip .u1-st').textContent;
  const temps = (hot: number, at = 5) => ({ temperature: { joints: Array.from({ length: 12 }, (_, i) => (i === at ? hot : 40)), battery: [], imu: null, body: [], age_s: 0 } });
  const info = (hot: number, at?: number) => ({ source: 'GO2_DDS', attitude: { roll: 0, pitch: 0, yaw: 0 }, error_code: null, fallen: false, fallen_source: 'imu_tilt_estimate', ...temps(hot, at) }) as never;
  it('u1_7: 정지 뒤 잠금 보고 전이면 칩 「안 멈춤」, 잠기면 「정지됨」 · 조종 입력 판정(ready)은 그대로', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    w.auto = () => ({ ok: true });
    click($('[data-stop]'));
    tick(100);
    act(() => push('r7', { speed: 0.6 }));
    expect(chipText()).toBe('안 멈춤');
    expect($('.u1-chip .u1-st').classList.contains('bad')).toBe(true);
    act(() => push('r7', { latched: true, stop_gen: 2, applied: [0, 0, 0], speed: 0 }));
    expect(chipText()).toBe('정지됨');
  });
  it('u1_9: 에이전트가 리모컨 쪽 까닭을 보내면 칩 「리모컨 조종」 · 까닭이 사라지면 돌아감', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    act(() => push('r7', { devices: [{ key: 'go2-drive-input', kind: 'OTHER', label: '리모컨으로 조종 중이라 화면 조종은 멈춰 있습니다', state: 'OK' }] }));
    expect(chipText()).toBe('리모컨 조종');
    act(() => push('r7', { devices: [{ key: 'go2-drive-input', kind: 'OTHER', label: '조종 막대에서 손을 한 번 뗀 뒤 다시 조종해 주세요', state: 'OK' }] }));
    expect(chipText()).toBe('조종 중');
  });
  it('u1_10: 펼침 칸 머리 = 실제 · 기체번호, 관절 줄 = 최고 온도 · 단계. 값이 없으면 줄을 그리지 않음', () => {
    mount(true, 'u-park', '#/drive/r7', SD_ROBOTS.map((r) => (r.id === 'r7' ? { ...r, serial: 'B42D40000P61' } : r)));
    serve(PARK, 'r7');
    click($('.u1-chip'));
    expect($('[data-pane-id]').textContent).toBe('실제B42D40000P61');
    expect($('[data-pane-temp]')).toBeNull();
    act(() => push('r7', { robot_info: info(48) }));
    expect($('[data-pane-temp]').textContent).toBe('관절최고 48 °C정상');
    act(() => push('r7', { robot_info: info(55) }));
    expect($('[data-pane-temp]').textContent).toBe('관절최고 55 °C주의');
  });
  it('u3_2: 관절이 60 °C 를 넘으면 띠 「관절 온도 N °C · 경고/위험」 + 관절 이름, 70 °C 부터 칩 「과열」. 닫으면 단계가 오를 때까지 숨김', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();   // 정지 잠금이면 칩은 「정지됨」 이 먼저(안전 표시) · 조종 중일 때 「과열」
    act(() => push('r7', { robot_info: info(58) }));
    expect($('[data-temp-band]')).toBeNull();
    act(() => push('r7', { robot_info: info(62) }));
    expect($('[data-temp-band] b').textContent).toBe('관절 온도 62 °C · 경고');
    expect($('[data-temp-band] p').textContent).toBe('왼쪽 앞다리 무릎 · 걷기는 계속됩니다');
    expect(chipText()).not.toBe('과열');
    click(btn('닫기'));
    expect($('[data-temp-band]')).toBeNull();
    act(() => push('r7', { robot_info: info(64) }));
    expect($('[data-temp-band]')).toBeNull();   // 같은 단계는 다시 띄우지 않음
    act(() => push('r7', { robot_info: info(71) }));
    expect($('[data-temp-band] b').textContent).toBe('관절 온도 71 °C · 위험');
    expect(chipText()).toBe('과열');
  });
  it('css: 온도 띠 꼴은 시안 u3_2 .al (340 폭 · 둥근 16)', () => {
    expect(u1AppCss).toMatch(/\.u1d \.u1-says \.al\{[^}]*width:340px;[^}]*border-radius:16px/);
  });
});

describe('폰 「말하기」 (시안 u1_2 · 정지 위 · PC 로봇 탭 말하기와 같은 길)', () => {
  it('조종 중 정지 위에 말하기 · 누르면 PC 와 같은 「준비 중」 글 · 보냄 0', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    const talk = $<HTMLButtonElement>('[data-u1-talk]');
    expect(talk.textContent).toBe('말하기');
    expect(talk.style.right).toBe('24px'); expect(talk.style.top).toBe('252px');
    const n = w.sent.length;
    click(talk);
    expect($('[data-act-msg]').textContent).toBe('말하기는 아직 서버에 없습니다');
    expect(w.sent.length).toBe(n);
  });
  it('정지 잠금(「다시 시작」 자리)이면 말하기 숨김 · 조종 전에도 보임', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    expect($('[data-u1-talk]')).not.toBeNull();
    click(btn('조종'));
    expect($('[data-u1-talk]')).toBeNull();
  });
});

describe('폰 정지됨 Damping 두 번 누르기 (시안 u1_3 · PC 로봇 탭 u4_9 와 같은 길)', () => {
  const damp = () => $<HTMLButtonElement>('[data-u1-damp]');
  it('내 조종 · 정지 잠금이면 「Damping 힘 빼기」. 한 번 = 안내만(보냄 0), 3 초 안에 한 번 더 = Damp(확인됨) 한 번', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    expect(damp()).toBeNull();   // 조종권 없음
    click(btn('조종'));
    expect(damp().textContent).toBe('Damping힘 빼기');
    click(damp());
    expect(w.of('action')).toHaveLength(0);
    expect($('[data-act-msg]').textContent).toBe('한 번 더 누르면 엎드려 힘을 뺍니다');
    tick(3100);
    click(damp());   // 3 초가 지나면 다시 처음 누름
    expect(w.of('action')).toHaveLength(0);
    tick(1000);
    click(damp());
    expect(w.of('action')).toMatchObject([{ robot: 'r7', action: 'Damp', params: {}, confirmed: true }]);
  });
  it('한 번 누른 뒤 단추가 사라졌다 3 초 안에 다시 나타나면 처음부터(한 번 = 안내만)', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종'));
    click(damp());
    act(() => push('r7', { posture: { state: 'LYING' } as never }));
    act(() => push('r7', { posture: { state: 'STANDING' } as never }));
    tick(500);
    click(damp());
    expect(w.of('action')).toHaveLength(0);
    expect($('[data-act-msg]').textContent).toBe('한 번 더 누르면 엎드려 힘을 뺍니다');
  });
  it('Damp 를 보내기 바로 전에 입력 0 을 한 번 보냄(neutral · PC d.zero 와 같음)', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종'));
    click(damp());
    const n = w.sent.length;
    click(damp());
    const after = w.sent.slice(n).map((m) => m.t);
    expect(after.indexOf('cmd')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('cmd')).toBeLessThan(after.indexOf('action'));
    expect(w.sent.slice(n).find((m) => m.t === 'cmd')).toMatchObject({ axes: [0, 0, 0] });
  });
  it('엎드림(LYING)이거나 잠금이 풀리면 Damping 단추 없음', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종'));
    act(() => push('r7', { posture: { state: 'LYING' } as never }));
    expect(damp()).toBeNull();
    act(() => push('r7', { posture: { state: 'STANDING' } as never }));
    expect(damp()).not.toBeNull();
    unlock(); tick(100);
    expect(damp()).toBeNull();
  });
});

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
    // 실기 RGB: 서버 drive-media 를 받기 전이면 «카메라 신호 없음»(가짜 그림 0) · 폰 직결 영상 연결 시도 0
    expect($('[data-sd-cam]').textContent).toBe('카메라 신호 없음');
    expect(FakeWS.all.some((x) => /\/phone\/(media|camera)\/ws/.test(x.url))).toBe(false);
    // 지도·라이다 자료가 없으면 그리지 않는다(critique 11-10: 고정 벽·계산한 점이 실제 센서로 읽힘) — 작은 칸·큰 칸 모두 «신호 없음»
    expect($('.dv-mini [data-lidar-map]')!.textContent).toContain('라이다 신호 없음');
    click(btn('지도'));
    expect($('.dv-stage > [data-lidar-map]')!.textContent).toContain('라이다 신호 없음');
    expect([...box.querySelectorAll('.dv-stage circle')].filter((x) => !x.closest('svg.ic'))).toHaveLength(0);   // 단추 그림(svg.ic) 말고는 원(라이다 점) 없음
    click(btn('RGB'));
    click(btn('조종'));
    expect(w.of('lease.take')).toMatchObject([{ robot: 'r7', proto: 'fh-rt/1' }]);
    expect(text()).toContain('조종 중(나)');
    expect($('.u1-chip .u1-st')!.textContent).toBe('정지됨');   // 로봇이 잠금을 알림 = 시안 u1_3 「정지됨」
    expect(text()).toContain('조종권을 받았습니다');   // 내 take 의 ACCEPTED 를 «넘겼습니다»로 읽지 않음
    expect(text()).not.toContain('넘겼습니다');
    tick(200);
    expect(cmds().length).toBeGreaterThan(0);
    expect(cmds().every((m) => String(m.axes) === '0,0,0')).toBe(true);   // 잠금 중은 0
    unlock();
    expect(w.of('unlock')).toMatchObject([{ robot: 'r7', lease_id: cmds()[0].lease_id, stop_gen: 1 }]);
    tick(100);
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
    key('keydown', 'KeyW'); key('keydown', 'KeyA');   // 동시 입력 두 곳
    const n = cmds().length;
    tick(1000);
    expect(cmds().length - n).toBe(1000 / 50);
    expect(lastAxes()).toEqual([1.5, 0, MAX_TURN_RATE]);
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

  it('잠금 사유 OUTPUT_STALLED 면 출력 지연 안내(사유만 바뀌어도 다시 그림), 사유 없음·해제면 기존 그대로(잠금 해제·STOP 그대로)', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    click(btn('조종'));
    act(() => push('r7', { safety_reason: 'OUTPUT_STALLED' }));   // 잠금(latched)은 그대로, 사유만 옴
    expect(text()).toContain(STALLED);
    expect(text()).toContain('조종권을 받았습니다');   // 기존 안내도 그대로
    expect(btn('다시 시작')).toBeTruthy();
    expect($('[data-stop]')).toBeTruthy();
    act(() => push('r7', { safety_reason: null }));
    expect(text()).not.toContain(STALLED);
    act(() => push('r7', { safety_reason: 'OUTPUT_STALLED' }));
    unlock();
    expect(w.of('unlock')).toMatchObject([{ robot: 'r7', stop_gen: 1 }]);
    tick(100);
    expect(text()).not.toContain(STALLED);   // 풀리면 사유가 남아도 안내 0
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
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

  it('잠금 해제 전 입력은 0, 키를 누른 채 해제하면 떼야(중립) 움직임, 후진은 조직 뒤 상한 안에서 표 값(11-28 17:33 「다 지원」)', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종'));
    key('keydown', 'ArrowUp'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    unlock(); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'ArrowUp'); tick(100);
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
    key('keydown', 'ArrowUp'); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    key('keyup', 'ArrowUp'); key('keydown', 'KeyS'); tick(100);
    expect(lastAxes()).toEqual([-1.5, 0, 0]);
    expect(text()).not.toContain('후진은 아직 지원하지 않습니다');
  });

  it('조이스틱(Pad 키)도 같은 길: 잠금 해제 전 0 · 해제 뒤 떼고 밀면 전진 · 뒤는 상한 안에서 뒤로', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종'));
    key('keydown', 'PadUp'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    unlock(); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    key('keyup', 'PadUp'); tick(100);
    key('keydown', 'PadUp'); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    key('keyup', 'PadUp'); key('keydown', 'PadDown'); tick(100);
    expect(lastAxes()).toEqual([-1.5, 0, 0]);
  });

  it('lease 가 바뀌면 이전 입력은 버리고 새 중립부터(누른 채여도 0)', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    key('keydown', 'KeyW'); tick(100);
    const old = end(cmds())!;
    expect(old.axes).toEqual([1.5, 0, 0]);
    recv(lease('r7', PARK, 'L-new'));                      // 서버가 새 조종권을 줌(다른 lease)
    const n = cmds().length;
    tick(300);
    expect(cmds().length).toBeGreaterThan(n);
    expect(cmds().slice(n).every((m) => m.lease_id === 'L-new' && String(m.axes) === '0,0,0')).toBe(true);
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'KeyW'); tick(100); key('keydown', 'KeyW'); tick(100);
    expect(end(cmds())).toMatchObject({ lease_id: 'L-new', axes: [1.5, 0, 0] });
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
    expect(band()).toContain('정지 잠금 · 출력이 아직 멈추지 않았습니다');
    act(() => push('r7', { applied: [0, 0, 0] }));
    expect(band()).toContain('Go2-7 정지 잠금 · 로봇이 잠금과 멈춤 출력을 알렸습니다.');
    const n = cmds().length;
    key('keydown', 'KeyW'); tick(200);
    expect(cmds().slice(n).every((m) => String(m.axes) === '0,0,0')).toBe(true);   // 잠긴 뒤 입력은 0
  });

  it('STOP 뒤 잠금 보고의 applied: [] = 멈춤 출력 확인 안 됨(현장 승인 닫힘) · [0,0,0] = 알렸습니다 · [0,1,0] = 안 멈춤', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7'); ready();
    w.auto = () => ({ ok: true });
    key('keydown', 'Space'); tick(100);
    act(() => push('r7', { latched: true, stop_gen: 2, applied: [] }));
    expect(band()).toContain('▲ Go2-7 정지 잠금 · 멈춤 출력은 확인되지 않았습니다 (현장 승인이 닫혀 있을 수 있음). 리모컨이나 현장에서 멈추세요.');
    expect(band()).not.toContain('알렸습니다');
    act(() => push('r7', { applied: [0, 0, 0] }));
    expect(band()).toContain('■ Go2-7 정지 잠금 · 로봇이 잠금과 멈춤 출력을 알렸습니다.');
    act(() => push('r7', { applied: [0, 1, 0] }));
    expect(band()).toContain('▲ Go2-7 정지 잠금 · 출력이 아직 멈추지 않았습니다. 현장을 확인하세요.');
  });
  it('relay-only status cannot claim direct robot STOP confirmation in the App banner', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7'); ready();
    w.auto = () => ({ ok: true });
    key('keydown', 'Space'); tick(100);
    act(() => push('r7', { connection: 'OFFLINE', latched: null, applied: null, stop_gen: null,
      phone_relay: { source: 'PHONE', battery: null, speed: 0, devices: [], age_s: .1, valid_for_s: 2.9 } }));
    expect(band()).toContain('폰 경유 자료는 받았지만 직접 로봇 보고로 정지를 확인하지 못했습니다');
    expect(band()).not.toContain('로봇이 잠금과 멈춤 출력을 알렸습니다');
    act(() => push('r7', { connection: 'ONLINE', latched: true, stop_gen: 2, applied: [0, 0, 0] }));
    expect(band()).toContain('로봇이 잠금과 멈춤 출력을 알렸습니다');
  });

  it('STOP 뒤 잠금 보고 전에는 «아직 잠금 안 됨» 유지, 잠금 → 해제되면 STOP 띠를 지움', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    w.auto = () => ({ ok: true });
    click($('[data-stop]'));
    tick(100);
    act(() => push('r7', { speed: 0.6 }));   // STOP 뒤 첫 state 가 아직 안 잠김
    expect(band()).toContain('▲ 명령이 닿지 않았습니다 · 0 초 지남');   // 폰 실기 조종 = 시안 u1_7 글(PC 는 «정지 요청됨 — 로봇이 아직 잠금을…» 그대로)
    act(() => push('r7', { latched: true, stop_gen: 2, applied: [0, 0, 0], speed: 0 }));
    expect(band()).toContain('Go2-7 정지 잠금 · 로봇이 잠금과 멈춤 출력을 알렸습니다.');
    unlock();
    act(() => push('r7', { latched: false, applied: [0.6, 0, 0], speed: 0.6 }));
    expect(rt.get('r7').stop).toBeNull();
    expect(band()).not.toContain('정지');
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
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    hide();
    expect(w.of('hidden')).toMatchObject([{ robot: 'r7' }]);
    const n = cmds().length;
    tick(500);
    expect(cmds().length).toBe(n);
    delete (document as { visibilityState?: string }).visibilityState;
    key('keyup', 'KeyW');
    click(btn('조종'));
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
    expect(btn('조종')).toBeTruthy();
  });

  it('요청 창: Enter·Space·키보드 click 은 넘기기를 누르지 않고, Space 는 STOP, 방향키는 조종 — 마우스로만 넘김', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    recv(ask());
    // 시안 u13_5 글: 제목 「역할 이름 님이 로봇 조종권을 요청했습니다」 + 「넘겨주시겠습니까? N 초 안에 …」(N = 서버 expires_at 으로 센 남은 초)
    expect($('#dv-ask-t').textContent).toBe('총괄 김OO 님이 Go2-7 조종권을 요청했습니다');
    expect($('[role="dialog"]').className).toBe('proto pv u135');   // 시안 u13_5 요청 칸 · 옛 .dv-ask 창 아님
    expect($('[data-takeover-left]').textContent).toBe(`넘겨주시겠습니까? ${REQUEST_S} 초 안에 답하지 않으면 조종권을 넘기지 않습니다`);
    const give = $('[data-ask="give"]');
    give.focus();
    key('keydown', 'ArrowUp', give); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);                 // 방향키는 계속 조종
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
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    recv(ask());
    clickWith($('[data-ask="give"]'), 1);
    const n = cmds().length;
    tick(300);
    expect(cmds().length).toBeGreaterThan(n);
    expect(cmds().slice(n).every((m) => String(m.axes) === '0,0,0')).toBe(true);
    expect($('.u1d .u1-chip .u1-st').textContent).toContain('정지 확인 중');
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
    click(btn('조종'));
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
    click(btn('조종'));
    expect(w.of('lease.request')).toMatchObject([{ robot: 'r7' }]);   // 남이 조종 중이면 요청
    expect(w.of('lease.take')).toHaveLength(0);
    expect(text()).toContain('박OO님에게 요청했습니다. (10초)');
    expect(btn('조종').disabled).toBe(true);
    tick(3000);
    expect(text()).toContain('(7초)');
    tick(7000);
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'TIMEOUT' });
    expect(text()).toContain('응답이 없어 요청이 끝났습니다.');
    expect(text()).toContain('30초 뒤 다시 요청할 수 있습니다.');
    tick(29_000);
    expect(btn('조종').disabled).toBe(true);
    tick(1000);
    expect(btn('조종').disabled).toBe(false);
    w.auto = (m) => (m.t === 'lease.request' ? fail('LEASE_REQUEST_COOLDOWN', 'cooldown') : { ok: true });
    click(btn('조종'));
    expect(text()).toContain('요청이 거절·시간 초과·취소로 끝난 뒤 30초 안에는 다시 요청할 수 없습니다. 잠시 뒤 다시 누르세요.');
    expect(text()).not.toContain('cooldown');
  });

  it('요청자: 수락 → «정지 확인 뒤 받습니다» → 내 lease 는 잠금 상태로 시작', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    act(() => push('r7', { latched: false }));
    recv(lease('r7', PARK));
    click(btn('조종'));
    recv(lease('r7', null));
    expect(text()).toContain('로봇 정지를 확인한 뒤 조종권을 받습니다.');
    act(() => push('r7', { latched: true, stop_gen: 2 }));
    recv(lease('r7', KIM, 'L-kim'));
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'ACCEPTED' });
    expect(text()).toContain('조종권을 받았습니다. 잠금 해제 후 조종하세요.');
    expect($('.u1d .u1-chip .u1-st').textContent).toBe('정지됨');
    unlock();
    expect(w.of('unlock')).toMatchObject([{ lease_id: 'L-kim', stop_gen: 2 }]);
  });

  it('넘김 실패(정지 확인 실패): «정지 잠금»이 아니라 «정지 확인 실패» + 할 일', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    act(() => push('r7', { latched: false }));
    recv(lease('r7', PARK));
    click(btn('조종'));
    recv(lease('r7', null));
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'CANCELED', error: 'STOP_CONFIRM_FAILED' });
    expect($('.u1d .u1-chip .u1-st').textContent).toContain('정지 확인 실패');
    expect(text()).toContain(FAIL_TEXT);
    expect(btn('조종').disabled).toBe(false);
  });

  it('조종권 비워짐 알림이 요청자 화면에', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    click(btn('조종'));
    recv(lease('r7', null));
    recv({ t: 'lease.result', robot: 'r7', request_id: 'q1', result: 'CANCELED' });
    expect(text()).toContain(FREE_TEXT);
    expect(btn('조종').disabled).toBe(false);
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
    expect($('.dv-run [data-run-stop]')!.textContent).toBe('멈추려면 STOP');   // 누를 수 없는 일시정지·중단 단추 대신 멈추는 길만(critique 11-10)
    expect($('.dv-run button')).toBeNull();
    click(btn('조종'));
    expect(w.of('lease.take')).toHaveLength(0);
    expect($('[role="dialog"]').textContent).toContain('시나리오가 일시정지됩니다');
    click(btn('일시정지하고 조종'));
    expect(w.of('lease.take')).toMatchObject([{ robot: 'r3' }]);
  });

  it('폰 조종 화면: 왼쪽 전후·오른쪽 회전 조이스틱, STOP 64px 머리줄 오른쪽 끝', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    expect($('header, .bar .rt').lastElementChild).toBe($('[data-stop]'));
    expect(parseInt($('[data-stop]').style.minHeight)).toBeGreaterThanOrEqual(64);
    ready();
    const fwd = $('[aria-label="이동 조이스틱"]'), turn = $('[aria-label="회전 조이스틱"]');
    expect([fwd.className, turn.className]).toEqual(['dv-stick v stick', 'dv-stick h stick']);   // 시안 u1 .stick 꼴
    for (const el of [fwd, turn]) el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    act(() => { fwd.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 20 })); });
    act(() => { turn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 60 })); });
    tick(100);
    expect(lastAxes()).toEqual([1.5, 0, MAX_TURN_RATE]);   // 위로 반 넘게 = 전진, 왼쪽 끝 = 왼쪽 회전(실기 표 값)
    act(() => { fwd.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); turn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); });
    tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);
  });
});

// [B3] PC 로봇 목록(총괄 표) «마지막 수신» = 상태를 받은 시각(다시 그린 시각 아님)
describe('마지막 수신 시각', () => {
  const seen = (name: string) => row(name).querySelector('[data-seen]')!.textContent;
  it('누르기·시간 흐름만으로는 안 바뀌고 새 상태가 와야 바뀜, 상태 없는 로봇은 목록 받은 시각', () => {
    vi.setSystemTime(new Date(2026, 9, 21, 13, 40, 5));
    mount(false, ADMIN, '#/fleet', ROBOTS.map((r) => ({ ...r, listedAt: '13:40:05' })));   // 서버 목록을 받은 시각(toRobot 이 붙임)
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
  it('[r2 Y2] 같은 값의 상태가 다시 와도(rt 가 다시 그리지 않음) 받은 시각 표시는 1 s 안에 바뀜', () => {
    vi.setSystemTime(new Date(2026, 9, 21, 13, 40, 5));
    mount(false, ADMIN, '#/fleet', ROBOTS.map((r) => ({ ...r, listedAt: '13:40:05' })));
    serve(KIM, 'r7');
    expect(seen('Go2-7')).toBe('마지막 수신 13:40:05');
    tick(2000);
    act(() => push('r7'));                                 // 같은 값
    tick(1000);
    expect(seen('Go2-7')).toBe('마지막 수신 13:40:07');
    tick(3000);                                            // 새 상태가 없으면 그대로
    expect(seen('Go2-7')).toBe('마지막 수신 13:40:07');
  });
});

describe('실시간 연결(05 §9)', () => {
  it('3 s 동안 아무것도 못 받으면 «연결 끊김» + 로봇 상태 모름 + 조종 불가, 1 s 마다 ping', () => {
    mount(true, 'u-kim', '#/drive');
    serve(KIM, 'r3', 'r7', 'r1');
    w.auto = null;                                         // 서버가 말이 없어짐
    tick(2750);
    expect($('header [data-link], .bar [data-link]')).toBeNull();
    expect(w.of('ping').length).toBe(2);
    tick(250);
    expect($('header [data-link], .bar [data-link]').textContent).toContain('연결 끊김');
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
    expect($('header [data-link], .bar [data-link]').textContent).toContain('연결 거부');
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
    expect($('header [data-link], .bar [data-link]').textContent).toContain('연결 끊김');
    tick(999);
    expect(FakeWS.all).toHaveLength(2);
    tick(1);
    expect(FakeWS.all).toHaveLength(3);
    serve(KIM, 'r3', 'r7', 'r1');
    expect(w.of('sub')).toHaveLength(1);
    expect($('header [data-link], .bar [data-link]')).toBeNull();
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
    expect(btn('조종').disabled).toBe(true);
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
    click(btn('조종'));
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
    click(btn('조종'));
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

describe('RV-457 1: 정지 단추의 «같은 누름 click 넘김»은 그 누름에만', () => {
  it('고르기 창 «정지»를 마우스로 눌러(창이 닫혀 click·뗌 없음) 멈춘 뒤, 창을 다시 열어 누른 클릭(pointerdown 없음)도 정지', () => {
    mount(false, 'u-kim', '#/mission');
    serve(KIM, 'r3', 'r7', 'r1');
    const choose = (id: string) => { click($('[data-stop]')); const pick = $<HTMLSelectElement>('select[aria-label="정지할 로봇"]');
      act(() => { pick.value = id; pick.dispatchEvent(new Event('change', { bubbles: true })); }); };
    choose('r7');
    act(() => { btn('정지').dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }), { pointerId: 1 })); });
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7']);
    expect(box.querySelector('[aria-label="정지할 로봇 고르기"]')).toBeNull();
    choose('r3');
    clickWith(btn('정지'), 1);   // 다른 마우스 단추를 쥔 채 왼쪽 클릭 = pointerdown 없는 click
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7', 'r3']);   // 고치기 전: ['r7'](묵은 표시가 click 을 넘김)
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
  // Codex #536 M1 (11-28): 서버가 delivered=false(붙은 에이전트에 넣지 못함)를 돌려주면 «접수»와 같게 보이지 않는다. delivered 칸이 없는 옛 답은 그대로
  const NO_WAY = '지금 로봇으로 보낼 길이 없습니다. 리모컨이나 현장에서 멈추세요.';
  const NOT_SENT = '연결이 끊겨 정지를 보내지 못했습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.';
  it('[M1] WS 접수 delivered=false · 로봇 ONLINE → «보낼 길 없음» 한 줄, 접수 문구 없음', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    click($('[data-stop]'));
    recv({ t: 'reply', id: w.of('stop')[0].id, ok: true, delivered: false });
    await settle();
    expect(band()).toContain(`▲ Go2-7 ${NO_WAY}`);
    expect(band()).not.toContain('서버가 받았습니다');
  });
  it('[M1] WS 접수 delivered=false · 에이전트 끊김(OFFLINE) → 정한 «보내지 못했습니다» 문구', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    recv(state('r7', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null }));
    click($('[data-stop]'));
    recv({ t: 'reply', id: w.of('stop')[0].id, ok: true, delivered: false });
    await settle();
    expect(band()).toContain(`▲ Go2-7 ${NOT_SENT}`);
  });
  it('[M1] HTTP 대체 경로 202 본문 delivered=false → 같은 «보낼 길 없음», delivered=true 는 지금 그대로(대체 경로)', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ requested: true, delivered: false }), { status: 202 })));
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    click($('[data-stop]'));
    tick(STOP_WS_MS); await settle();
    expect(band()).toContain(`▲ Go2-7 ${NO_WAY}`);
    expect(band()).not.toContain('정지 요청됨(대체 경로)');
  });
  it('[M1] delivered=false 뒤 이 STOP 뒤 세대의 잠금을 로봇이 알리면 «보낼 길 없음» 을 내리고 로봇 보고를 따른다', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    click($('[data-stop]'));
    recv({ t: 'reply', id: w.of('stop')[0].id, ok: true, delivered: false });
    await settle();
    expect(band()).toContain(NO_WAY);
    tick(100);
    recv(state('r7', { latched: true, stop_gen: 9, applied: [0, 0, 0] }));
    await settle();
    expect(band()).not.toContain(NO_WAY);
    expect(band()).toContain('Go2-7 정지 잠금');
  });
  it('[M1] HTTP 대체 경로 delivered=true 는 지금 문구 그대로', async () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ requested: true, delivered: true }), { status: 202 })));
    w.auto = (m) => (m.t === 'ping' ? { ok: true } : undefined);
    click($('[data-stop]'));
    tick(STOP_WS_MS); await settle();
    expect(band()).toContain('정지 요청됨(대체 경로)');
    expect(band()).not.toContain(NO_WAY);
  });
  it('[M1] 조종 패널 stopLine: delivered=false 면 «보낼 길 없음»(끊김이면 정한 문구), 없으면 지금 그대로', () => {
    const base = { phase: 'sent' as const, at: 1, n: 1, g0: 1, conn: 1, rev: 0 };
    const on = state('r7', {}) as ScreenState, off = state('r7', { connection: 'OFFLINE', latched: null, stop_gen: null, applied: null }) as ScreenState;
    expect(stopLine({ stop: { ...base, delivered: false }, state: on })).toEqual({ tone: 'bad', text: NO_WAY });
    expect(stopLine({ stop: { ...base, delivered: false }, state: off })).toEqual({ tone: 'bad', text: NOT_SENT });
    expect(stopLine({ stop: { ...base, phase: 'fallback', delivered: false }, state: on })).toEqual({ tone: 'bad', text: NO_WAY });
    expect(stopLine({ stop: base, state: on })!.text).toContain('정지 요청 접수');
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
    expect($('header [data-link], .bar [data-link]').textContent).toContain('연결 거부');
    tick(60_000);
    expect(FakeWS.all).toHaveLength(1);
    setAuthLost(() => {});
  });
  it('[N1] REST 로그인 정상 + 수락 전 끊김(1006)이 몇 번이든 거부로 단정하지 않고 늘려 가며 «연결 재시도 중»', async () => {
    vi.stubGlobal('fetch', me(200));
    mount(false, 'u-kim', '#/fleet');
    for (let i = 0; i < 6; i++) { act(() => FakeWS.last.drop(1006)); await settle(); tick(Math.min(10, 2 ** i) * 1000); }
    expect(FakeWS.all).toHaveLength(7);
    expect($('header [data-link], .bar [data-link]').textContent).toContain('연결 끊김');
    expect(band()).toContain('연결 재시도 중입니다');
    expect(band()).not.toContain('거부');
  });
  it('[N1] REST 403 이면 영구 거부(다시 연결 안 함)', async () => {
    vi.stubGlobal('fetch', me(403));
    mount(false, 'u-kim', '#/fleet');
    act(() => FakeWS.last.drop(1006)); await settle();
    expect($('header [data-link], .bar [data-link]').textContent).toContain('연결 거부');
    tick(60_000);
    expect(FakeWS.all).toHaveLength(1);
  });
  it('[B2] 수락 전 3 s 매달림(시간 초과)은 거부로 세지 않음 — REST 확인 없이 다시 연결', () => {
    const f = me(200); vi.stubGlobal('fetch', f);
    mount(false, 'u-kim', '#/fleet');
    tick(60_000);
    expect((f.mock.calls as unknown as [string][]).filter(([u]) => !/\/(dashboard|robots\/|notifications|events|sites)/.test(String(u)))).toEqual([]);   // 관제 요약·상세·알림·최근 사건·지도 칸 층 목록 말고 인증 확인(REST)은 0
    expect($('header [data-link], .bar [data-link]').textContent).toContain('연결 끊김');
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
    expect($('header [data-link], .bar [data-link]').textContent).toContain('연결 끊김');   // 버린 소켓이 열려도 연결로 치지 않음
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
    expect(band()).toContain('Go2-7 정지 잠금 · 로봇이 잠금과 멈춤 출력을 알렸습니다.');
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
    const shown = () => $('[aria-label="조종"] .u1-chip .chipnum')?.textContent;
    expect(shown()).toBe('Go2-7');
    act(() => root!.render(<App user={USERS.find((u) => u.id === 'u-park')} robots={[{ ...ROBOTS[2], owner: 'u-park' }, ...ROBOTS.slice(0, 2)]} />));
    expect(shown()).toBe('Go2-7');
    expect(w.of('hidden')).toHaveLength(0);
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
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
    expect(btn('조종').disabled).toBe(false);
    click(btn('조종'));
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
    click(btn('조종'));
    expect(text()).toContain('로봇을 다시 연결해야 조종권을 줄 수 있습니다');
    expect(text()).not.toContain('조종권 넘기는 중');
    expect(btn('조종').disabled).toBe(false);
  });
});

describe('S0 서버 후속(apps/server README «S0»)', () => {
  const stopOn = () => { const s = $<HTMLButtonElement>('[data-stop]'); expect(s.disabled).toBe(false); expect(s.hidden).toBe(false); };

  it('요청자: 서버 답 전에도 [요청 취소] → lease.cancel, CANCELED 로 대기 표시가 닫힘. 화면이 30 s 를 따로 세지 않고 서버 제한 응답을 안내', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    w.auto = (m) => (m.t === 'lease.request' ? undefined : { ok: true });   // 요청의 답이 아직 안 옴
    click(btn('조종'));
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
    expect(btn('조종').disabled).toBe(false);
    w.auto = (m) => (m.t === 'lease.request' ? fail('LEASE_REQUEST_COOLDOWN', '30초 뒤 다시 요청하세요.') : { ok: true });
    click(btn('조종'));
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
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
    stopOn();
  });

  it('취소가 늦음(LEASE_REQUEST_STALE) → 쉬운 문구, 서버 문장·코드는 그대로 안 보임', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    w.auto = (m) => (m.t === 'lease.cancel' ? fail('LEASE_REQUEST_STALE', '현재 연결의 요청이 끝났습니다.') : { ok: true });
    click(btn('조종'));
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
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    w.auto = null;                                         // 서버가 말이 없어짐(ping·state 없음)
    let waited = 0;
    while (!box.querySelector('header [data-link], .bar [data-link]') && waited < 4000) { tick(50); waited += 50; }
    expect(waited).toBeGreaterThanOrEqual(2900);           // 3 s(0.25 s 간격 확인) 전에는 끊김으로 보지 않음
    expect(waited).toBeLessThanOrEqual(3300);
    expect(cmds().slice(-2).map((m) => String(m.axes))).toEqual(['1.5,0,0', '0,0,0']);   // 끊김 직전까지 조종, 끊으며 0
    const n = cmds().length;
    tick(2000);
    expect(cmds().length).toBe(n);                         // 그 뒤 cmd 0건(새 소켓에도)
    expect(FakeWS.all.slice(1).every((s) => s.of('cmd').length === 0)).toBe(true);
    expect($('header [data-link], .bar [data-link]').textContent).toContain('연결 끊김');
    stopOn();
  });

  it('서버 ping 만 와도(다른 답·state 없음) 연결 유지 — 화면이 ping 에 답할 의무는 없다', () => {
    mount(false, 'u-kim', '#/fleet');
    serve(KIM, 'r3', 'r7', 'r1');
    w.auto = null;
    for (let i = 0; i < 10; i++) { tick(1000); recv({ t: 'ping', t_server: new Date().toISOString() }); }
    expect(box.querySelector('header [data-link], .bar [data-link]')).toBeNull();
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
    const rowOf = (name: string) => row(name).textContent!;   // 운영 관리자 «내 로봇 고르기» 단추(상태 칩)
    expect(rowOf('Go2-7')).not.toContain('확인 안 됨');     // 서버가 받아들인 [r3,r7] 은 그대로
    expect(rowOf('Go2-1')).toContain('확인 안 됨');
    stopOn();
  });

  it('요청자: 수락 뒤 정지 확인 중(lease null)에도 [요청 취소] → CANCELED 로 닫히고 «조종권이 비었습니다»', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    click(btn('조종'));
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
    expect(btn('조종').disabled).toBe(false);
    stopOn();
  });

  it('취소가 확정보다 늦음: 내 lease 를 받은 뒤 STALE → «이미 받았습니다·조종 끝내기» 안내, 취소 단추 없음', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', PARK));
    click(btn('조종'));
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
    click(btn('조종'));
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
    click(btn('조종'));
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
  const SHEETS = ['시나리오', '지도·목표', '정책'];   // 「자세」 시트는 아래 동작 일곱(시안 u1 .act)이 대신함
  const stopBtn = () => $<HTMLButtonElement>('[data-stop]');
  /** STOP: 머리줄 맨 끝, 시트 밖, 누를 수 있음, 64 px 이상 */
  const stopReachable = () => {
    expect(stopBtn().parentElement!.tagName).toBe('HEADER');
    expect($('header, .bar .rt').lastElementChild).toBe(stopBtn());
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
    expect(lastAxes()).toEqual([1.5, 0, 0]);
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
  /** 전후 조이스틱(120 px 상자): 위 6.6 px = 스틱 0.89(실기 표 값 1.5). 포인터 잡기·놓기를 기록한다 */
  const grip = () => {
    const el = $('[aria-label="이동 조이스틱"]'), held = new Set<number>();
    el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    Object.assign(el, { setPointerCapture: (i: number) => held.add(i), hasPointerCapture: (i: number) => held.has(i), releasePointerCapture: (i: number) => held.delete(i) });
    return { el, held };
  };
  const FWD = 1.5;   // 0.89 는 문턱(0.5) 위 → 실기 표 값 1.5
  // [B1] 시트·⋯ 가 조이스틱을 가리는 네 경우: 열기·전환·닫기·⋯ 열기
  for (const [name, before, act_] of [
    ['시트 열기', () => {}, () => click(btn('지도·목표'))],
    ['시트 전환', () => click(btn('지도·목표')), () => click(btn('시나리오'))],
    ['시트 닫기', () => click(btn('지도·목표')), () => click(btn('닫기'))],
    ['⋯ 열기', () => {}, () => { click($('details.fh-more summary')); tick(0); }],
  ] as const) it(`조이스틱·키를 누른 채 ${name} → 바로 입력 0, 옛 포인터·키를 모두 떼고 새로 누르기 전까지 0(RB-DRIVE-FRESH-PRESS)`, () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    ready();
    before();
    const { el, held } = grip();
    pe('pointerdown', el, 60, 6.6);
    key('keydown', 'KeyA');
    tick(100);
    expect((lastAxes() as number[])[0]).toBeCloseTo(FWD, 2);
    expect((lastAxes() as number[])[2]).toBe(MAX_TURN_RATE);
    expect(held.has(1)).toBe(true);
    const n = cmds().length;
    act_();
    expect(cmds().length).toBe(n + 1);                     // 50 ms 를 기다리지 않고 바로
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect(held.has(1)).toBe(true);                         // 옛 손가락은 뗄 때까지 지켜본다(놓아 버리면 뗐는지 모름)
    pe('pointermove', el, 60, 0);                           // 옛 포인터가 계속 움직여도
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', repeat: true, bubbles: true, cancelable: true })); });   // 누른 키의 자동 반복도
    pe('pointerdown', el, 60, 6.6, 2);                      // 옛 것이 눌린 채 새 손가락을 대도
    tick(200);
    expect(cmds().slice(n).every((m) => (m.axes as number[]).every((v) => v === 0))).toBe(true);
    expect(rt.get('r7').lease).not.toBeNull();             // 조종권은 그대로
    pe('pointerup', el, 60, 6.6, 1); key('keyup', 'KeyA'); pe('pointerup', el, 60, 6.6, 2);   // 모두 뗌
    tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);
    pe('pointerdown', el, 60, 6.6, 3);                      // 새로 누르면 다시 조종
    tick(100);
    expect((lastAxes() as number[])[0]).toBeCloseTo(FWD, 2);
    pe('pointerup', el, 60, 6.6, 3);
    key('keydown', 'KeyA');                                 // 키도 새로 누르면
    tick(100);
    expect(lastAxes()).toEqual([0, 0, MAX_TURN_RATE]);
  });

  // [r2 Y3] 시트를 연 같은 틀(다시 그리기·effect 전)에 옛 포인터가 움직여도 입력은 0
  for (const [name, open] of [
    ['시트 열기', () => btn('지도·목표').click()],
    ['⋯ 열기', () => { const d = $<HTMLDetailsElement>('details.fh-more'); d.open = true; d.dispatchEvent(new Event('toggle')); }],
  ] as const) it(`${name}와 같은 틀에 옛 포인터 move → 다음 입력도 0`, () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    ready();
    const { el } = grip();
    pe('pointerdown', el, 60, 6.6);
    tick(100);
    expect((lastAxes() as number[])[0]).toBeCloseTo(FWD, 2);
    const n = cmds().length;
    act(() => {
      open();
      const e = new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 60, clientY: 0 });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      el.dispatchEvent(e);
    });
    tick(100);
    expect(cmds().length).toBeGreaterThan(n + 1);
    expect(cmds().slice(n).every((m) => (m.axes as number[]).every((v) => v === 0))).toBe(true);
  });

  // [B2] 끝내기 = 입력 0 → 반납 중 → 서버가 반납을 확인해야 로봇 연결로
  /** lease.release 에 대한 서버 답을 바꿈: reject = 거절, none = 답 없음(뒤에 answer() 로 늦게 성공) */
  function releaseReply(mode: 'reject' | 'none') {
    const base = w.auto!, pending: string[] = [];
    w.auto = (m) => {
      if (m.t !== 'lease.release') return base(m);
      if (mode === 'reject') w.recv({ t: 'reply', id: m.id, ...fail('SERVER_BUSY') });
      else pending.push(m.id);
    };
    return { answer: () => act(() => { for (const id of pending.splice(0)) { w.recv({ t: 'reply', id, ok: true }); w.recv(lease('r7', null)); } }) };
  }
  const endBtn = () => $<HTMLButtonElement>('header .fh-more .btn');
  function holding() {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    ready();
    key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
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
    expect(failBox.textContent).toContain('서버가 바쁩니다.');
    expect(failBox.textContent).not.toContain('남아 있을 수');
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
    expect(box.querySelector('.dv-mini')).toBeNull();        // [r4 R13] 반납 중 작은 지도 숨김(보기 단추와 겹침)
    expect(btn('지도')).toBeTruthy();
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

  // [r2 Y1] 반납 미확인은 로봇별로 남아 [연결 화면]으로 가도 카드에 보이고, 그동안 조종 시작은 요청을 보내지 않는다
  const toConnect = () => { click(btn('연결 화면')); expect(location.hash).toBe('#/drive'); expect($('main').getAttribute('aria-label')).toBe('로봇 연결'); };
  it('반납 확인 못함 → [연결 화면]: 카드에 «이 창 — 반납 확인 중»·[다시 시도], STOP 그대로, 다시 들어가도 조종 시작은 요청을 안 보냄, 늦은 확인 뒤 풀림', () => {
    holding();
    const srv = releaseReply('none');
    click(endBtn());
    tick(3000);
    toConnect();
    const c = () => card('Go2-7');
    expect(c().textContent).toContain('이 창 — 반납 확인 중');
    expect(c().textContent).not.toContain('다른 창에서 조종 중(나)');
    expect(c().querySelector('[data-releasing]')!.textContent).toContain('서버가 답하지 않습니다.');
    stopReachable();
    expect(w.of('hidden')).toHaveLength(0);
    click(c().querySelector('button.pri')!);                // [연결] → 조종 화면
    expect($('main').getAttribute('aria-label')).toBe('조종');
    expect($('[data-end-fail]')).not.toBeNull();            // 조종 화면에서도 경고가 이어짐
    expect(btn('조종').disabled).toBe(true);
    expect($('[data-why]').textContent).toBe('반납 확인 못함 — [다시 시도]');   // [r3 R11] 머리줄과 같은 말, 짧게
    const took = w.of('lease.take').length;
    click(btn('조종'));
    expect(w.of('lease.request')).toHaveLength(0);
    expect(w.of('lease.take')).toHaveLength(took);
    toConnect();
    expect(w.of('lease.release')).toHaveLength(1);
    srv.answer();                                           // 늦은 서버 확인(연결 화면에 있으면 그대로 머문다)
    expect(location.hash).toBe('#/drive');
    expect(c().querySelector('[data-releasing]')).toBeNull();
    expect(c().textContent).toContain('조종하는 사람 없음');
    click(c().querySelector('button.pri')!);
    click(btn('조종'));
    expect(w.of('lease.take')).toHaveLength(took + 1);
  });

  it('반납 거절 → [연결 화면] → 카드 [다시 시도]가 성공하면 풀림(연결 화면에 머묾), STOP 은 반납 중인 로봇을 고른다', () => {
    holding();
    releaseReply('reject');
    click(endBtn());
    toConnect();
    expect(card('Go2-7').querySelector('[data-releasing]')!.textContent).toContain('서버가 바쁩니다.');
    click(stopBtn());
    const pick = $<HTMLSelectElement>('select[aria-label="정지할 로봇"]');   // 여러 대 → 고르기, 반납 중인 로봇이 기본
    expect(pick.value).toBe('r7');
    expect(pick.selectedOptions[0].textContent).toContain('(반납 확인 중)');
    click(btn('닫기'));
    w.auto = (m) => { w.recv({ t: 'reply', id: m.id, ok: true }); };
    click([...card('Go2-7').querySelectorAll('button')].find((b) => b.textContent === '다시 시도')!);
    expect(w.of('lease.release')).toHaveLength(2);
    expect(card('Go2-7').querySelector('[data-releasing]')).toBeNull();
    expect(location.hash).toBe('#/drive');
  });

  // [r2 Y4] 확인 못함 중에 서버가 반납된 것을 알리면 반납 완료로 보고 로봇 연결로
  for (const [name, done] of [
    ['서버 만료(조종권 빔)', () => recv(lease('r7', null))],
    ['다른 사람이 조종권을 받음', () => recv(lease('r7', LEE, null))],
    ['[다시 시도]에 «내 조종권 아님» 답', () => { w.auto = (m) => { if (m.t === 'lease.release') w.recv({ t: 'reply', id: m.id, ...fail('LEASE_MISMATCH', '현재 연결의 조종권이 아닙니다.') }); }; click(btn('다시 시도')); }],
  ] as const) it(`반납 확인 못함 중 ${name} → 반납 완료, 로봇 연결로`, () => {
    holding();
    releaseReply('none');
    click(endBtn());
    tick(3000);
    expect($('[data-end-fail]')).not.toBeNull();
    done();
    expect(location.hash).toBe('#/drive');
    expect($('main').getAttribute('aria-label')).toBe('로봇 연결');
    expect(card('Go2-7').querySelector('[data-releasing]')).toBeNull();
    expect(rt.get('r7').releasing).toBeNull();
  });

  it('반납 확인 못함 중 내 lease 가 아직 나에게 있다는 알림(조종권자 빔이어도)·같은 사람의 다른 창 조종권자·잠금 보고(옛 stop_gen 포함)는 반납 완료가 아님', () => {
    holding();
    const mine = rt.get('r7').lease!;
    releaseReply('none');
    click(endBtn());
    tick(3000);
    recv(lease('r7', KIM, mine));
    recv(lease('r7', null, mine));                         // 조종권자는 비었다는데 내 lease_id 가 함께 옴 — 모순, 아직 모름
    recv(lease('r7', KIM, null));
    recv({ ...st.r7, latched: true, stop_gen: st.r7.stop_gen! - 1 });
    recv({ ...st.r7, latched: true, stop_gen: st.r7.stop_gen! + 1 });
    stays();
    expect($('[data-end-fail]')).not.toBeNull();
    expect(rt.get('r7').lease).toBeNull();
  });

  // [r3 U2] 반납 확인 못함 중 STOP 의 잠금은 반납 확인이 아니다(내가 누른 STOP 과 반납 잠금을 구별할 수 없음)
  it('반납 확인 못함 중 STOP·연결 화면 Space → 정지는 보내고 경고·조종 시작 막힘은 그대로, 요청 0', () => {
    holding();
    const srv = releaseReply('none');
    click(endBtn());
    tick(3000);
    click(stopBtn());
    expect(w.of('stop')).toMatchObject([{ robot: 'r7' }]);
    expect(st.r7.latched).toBe(true);                       // 로봇이 잠금을 보고함
    stays();
    expect($('[data-end-fail]')).not.toBeNull();
    expect(rt.get('r7').releasing).not.toBeNull();
    click(btn('연결 화면'));
    expect(location.hash).toBe('#/drive');
    key('keydown', 'Space'); key('keyup', 'Space');        // 여러 대 → 고르기(반납 중인 로봇이 기본)
    key('keydown', 'Space'); key('keyup', 'Space');        // 그 로봇 정지
    expect(w.of('stop')).toHaveLength(2);
    expect(card('Go2-7').querySelector('[data-releasing]')).not.toBeNull();
    expect(card('Go2-7').textContent).toContain('이 창 — 반납 확인 중');
    click([...card('Go2-7').querySelectorAll('button')].pop()!);
    expect(btn('조종').disabled).toBe(true);
    const took = w.of('lease.take').length;
    click(btn('조종'));
    expect(w.of('lease.request')).toHaveLength(0);
    expect(w.of('lease.take')).toHaveLength(took);
    srv.answer();                                           // 서버가 반납을 확인하면 그때 풀림
    expect(location.hash).toBe('#/drive');
    expect(rt.get('r7').releasing).toBeNull();
  });

  // [r3 U1] 앞 lease 반납의 늦은 답은 새 lease 의 반납을 확인하지 않는다
  it('lease A 반납이 만료로 끝난 뒤 lease B 반납 중에 A 의 늦은 ok → B 경고·조종 시작 막힘 유지, B 확인 뒤에만 풀림', () => {
    holding();
    const base = w.auto!, pending: string[] = [];
    w.auto = (m) => { if (m.t === 'lease.release') pending.push(m.id); else base(m); };
    const la = rt.get('r7').lease;
    click(endBtn());
    const a = pending[0];
    tick(3000);
    recv(lease('r7', null));                                // A: 서버 만료 → 반납 완료
    expect(location.hash).toBe('#/drive');
    click([...card('Go2-7').querySelectorAll('button')].pop()!);
    click(btn('조종'));                                  // 같은 로봇의 새 lease B(잠금은 이미 풀려 있음)
    const b = rt.get('r7').lease!;
    expect(b).toBeTruthy();
    expect(b).not.toBe(la);
    click(endBtn());
    expect(pending).toHaveLength(2);
    recv({ t: 'reply', id: a, ok: true });                  // A 의 늦은 성공
    stays();
    expect(rt.get('r7').releasing?.lease).toBe(b);
    expect($('[data-ending]')).not.toBeNull();
    tick(3000);
    recv({ t: 'reply', id: a, ok: true });
    expect($('[data-end-fail]')).not.toBeNull();
    expect(btn('조종').disabled).toBe(true);
    recv({ t: 'reply', id: pending[1], ok: true });         // B 확인
    expect(location.hash).toBe('#/drive');
    expect(rt.get('r7').releasing).toBeNull();
  });

  // [r4 R1] 앞 lease 의 늦은 «내 조종권 아님» 답도 새 lease 의 반납을 확인하지 않는다
  it('lease A 반납이 만료로 끝난 뒤 lease B 반납 중에 A 의 늦은 «내 조종권 아님» → B 경고·조종 시작 막힘 유지, B 확인 뒤에만 풀림', () => {
    holding();
    const base = w.auto!, pending: string[] = [];
    w.auto = (m) => { if (m.t === 'lease.release') pending.push(m.id); else base(m); };
    click(endBtn());
    const a = pending[0];
    tick(3000);
    recv(lease('r7', null));                                // A: 서버 만료 → 반납 완료
    click([...card('Go2-7').querySelectorAll('button')].pop()!);
    click(btn('조종'));                                  // 새 lease B
    const b = rt.get('r7').lease!;
    click(endBtn());
    const mismatch = { t: 'reply', id: a, ...fail('LEASE_MISMATCH', '현재 연결의 조종권이 아닙니다.') };
    recv(mismatch);                                         // A 의 늦은 «내 조종권 아님»
    stays();
    expect(rt.get('r7').releasing).toMatchObject({ lease: b, why: null });
    expect($('[data-ending]')).not.toBeNull();
    tick(3000);
    recv(mismatch);
    expect($('[data-end-fail]')).not.toBeNull();
    expect(btn('조종').disabled).toBe(true);
    recv({ t: 'reply', id: pending[1], ok: true });         // B 확인
    expect(location.hash).toBe('#/drive');
    expect(rt.get('r7').releasing).toBeNull();
  });

  // [r4 R1] 같은 lease 의 다시 시도: 앞 시도의 늦은 거절은 지금 시도를 실패로 덮지 않고, 앞 시도의 늦은 성공은 반납 확인
  it('같은 lease 다시 시도 중 앞 시도의 늦은 거절 → 지금 시도는 «반납 중» 그대로, 앞 시도의 늦은 성공 → 반납 완료', () => {
    holding();
    const base = w.auto!, pending: string[] = [];
    w.auto = (m) => { if (m.t === 'lease.release') pending.push(m.id); else base(m); };
    const mine = rt.get('r7').lease;
    click(endBtn());
    tick(3000);
    click(btn('다시 시도'));                                  // 2번째 시도(같은 lease)
    expect(pending).toHaveLength(2);
    expect(rt.get('r7').releasing).toMatchObject({ lease: mine, why: null });
    recv({ t: 'reply', id: pending[0], ...fail('SERVER_BUSY') });   // 1번째 시도의 늦은 거절
    stays();
    expect($('[data-ending]')).not.toBeNull();
    expect($('[data-end-fail]')).toBeNull();
    tick(3000);                                             // 2번째 시도도 답 없음
    click(btn('다시 시도'));                                  // 3번째 시도
    expect(pending).toHaveLength(3);
    recv({ t: 'reply', id: pending[1], ok: true });         // 2번째 시도의 늦은 성공 = 같은 반납 확인
    expect(location.hash).toBe('#/drive');
    expect(rt.get('r7').releasing).toBeNull();
    recv({ t: 'reply', id: pending[2], ok: true });         // 3번째 시도의 답은 아무것도 바꾸지 않음
    expect(location.hash).toBe('#/drive');
    expect(rt.get('r7').releasing).toBeNull();
  });

  // [r2 Y5] 조종 판의 «조종 끝내기»도 머리줄 [끝내기]와 같은 길
  it('조이스틱을 누른 채 «조종 끝내기» → 입력 0 먼저, 반납 중·확인 못함·[다시 시도] 같은 길', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    ready();
    const { el } = grip();
    pe('pointerdown', el, 60, 6.6);
    tick(100);
    expect((lastAxes() as number[])[0]).toBeCloseTo(FWD, 2);
    const srv = releaseReply('none');
    click(btn('조종 끝내기'));
    zeroThenRelease();
    stays();
    expect($('[data-ending]')).not.toBeNull();
    expect(endBtn().disabled).toBe(true);
    tick(3000);
    expect($('[data-end-fail]')).not.toBeNull();
    expect(w.of('lease.release')).toHaveLength(1);
    srv.answer();
    expect(location.hash).toBe('#/drive');
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
      if (s === '시나리오') expect(sheet.textContent).toContain('시나리오 고르기');   // 이 층 시나리오 고르기(screens/missions ScenarioPick — 목록·실행 비활성은 scenpick.test)
      else if (s === '정책') expect(sheet.querySelectorAll('[data-gait]')).toHaveLength(4);   // 걷기 모드 칸(u03 · gait.test)
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
    click(btn('조종'));
    const stage = $('.dv-stage');
    expect(stage.querySelector('.dv-stick.v')!.getAttribute('aria-label')).toBe('이동 조이스틱');
    expect(stage.querySelector('.dv-stick.h')!.getAttribute('aria-label')).toBe('회전 조이스틱');
    expect(stage.querySelector('.proto.u1d')).not.toBeNull();   // 폰 실기 조종 화면 상태 판 = 시안 u1 겹(옛 .dv-hud 대신)
    expect(stage.querySelector('.dv-stick.v')!.closest('.u1d')).not.toBeNull();
    expect([...stage.querySelector('.dv-sheets')!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['시나리오', '지도·목표', '정책']);   // 「자세」 는 아래 동작 일곱이 대신
    expect(stage.querySelectorAll('.u1d .act button')).toHaveLength(7);
    const rule = (css: string, sel: string) => css.match(new RegExp(`(?:^|[}\\n])${sel.replace(/[.()]/g, '\\$&')}\\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule(driveCss, '.dv-stage')).toMatch(/position:relative;.*overflow:hidden/);
    expect(rule(driveCss, '.fh-sheet')).toMatch(/^position:absolute;/);
    expect(driveCss).not.toMatch(/position:\s*fixed/);
    expect(rule(driveCss, '.dv-stick.v')).toBe('left:12px');
    expect(driveCss).toMatch(/@media \(max-height:480px\)\{[^@]*\.dv\.ph \.dv-mini\{display:none\}\}/);   // [r4 R9] 가로 낮은 폰은 작은 지도 없음
    expect(rule(driveCss, '.dv-stick.h')).toBe('right:12px');
    expect(rule(driveCss, '.dv-hud')).toMatch(/^position:absolute;top:8px;left:8px/);
    const head = rule(frameCss, '.fh-head');
    expect(head).toMatch(/position:sticky;top:0;z-index:10/);
    expect(Number(rule(driveCss, '.fh-sheet').match(/z-index:(\d+)/)![1])).toBeLessThan(10);
    expect(frameCss).toMatch(/\.fh\.phone \.fh-head>\.btn\{flex:0 1 auto;min-width:44px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);   // 320 폭: 왼쪽 단추는 줄되 꺾이지 않음(실제 폭은 Chrome 으로 확인)
  });

  it('10-22 QA R1·R2·R12: PC 는 창 높이 틀(메뉴·본문 따로 스크롤 — «설정»이 첫 화면 안), 좁은 칸 긴 글은 줄 통째로, 체크 칸 20px', () => {
    expect(frameCss).toMatch(/(^|\n)\.fh\[data-layout="pc"\]\{height:100vh\}/);
    expect(frameCss).toContain('.fh-row>.btn:not(.pri,.bad)[aria-pressed="true"]{border-color:var(--accent);background:var(--acc-bg)}');   // 고른 로봇·층이 보임(critique 11-10)
    expect(frameCss).toContain('.btn.bad{border-color:var(--bad);color:var(--bad);background:var(--bad-bg)}');               // 되돌릴 수 없는 확인은 저장 청록과 다르게
    expect(frameCss).toMatch(/\.fh\[data-layout="pc"\] \.fh-nav,\.fh\[data-layout="pc"\] \.fh-main\{overflow-y:auto\}/);
    expect(frameCss).toMatch(/\n\.fh-wide\{flex:1 1 12em;min-width:0;overflow-wrap:anywhere\}/);
    expect(frameCss).toMatch(/\.fh input:is\(\[type="checkbox"\],\[type="radio"\]\)\{width:20px;height:20px;margin:0;accent-color:var\(--accent\)\}/);   // 10-23 체크·라디오 = 브랜드 강조색
    expect(frameCss).toMatch(/\.fh:not\(\.light\) input:is\(\[type="checkbox"\],\[type="radio"\]\)\{color-scheme:dark\}/);   // 어두운 틀의 빈 칸도 어둡게
    expect(frameCss).toMatch(/\.fh input:is\(\[type="checkbox"\],\[type="radio"\]\):focus-visible\{outline:2px solid var\(--accent\);outline-offset:2px\}/);
    expect(frameCss).not.toMatch(/(input\[type="(checkbox|radio)"\]|input:is\([^)]*\))[^{]*\{[^}]*outline:(none|0)/);   // 포커스 링을 끄지 않음
    expect(frameCss).toMatch(/\n\.fh-head\{position:sticky;top:0;z-index:10/);   // 머리줄(STOP) 규칙은 그대로
  });

  it('10-22 아이폰 Safari: 조종 화면은 보이는 높이(100dvh, .fh 100vh 가 이기지 않음), 폰 틀은 safe-area 만큼 안쪽·가로 넘침 자름, 글자 자동 확대 끔', () => {
    expect(driveCss).toMatch(/\n\.fh:has\(\.dv\.ph\)\{height:100dvh;min-height:0\}/);
    expect(frameCss).toMatch(/\n\.fh\.phone\{box-sizing:border-box;padding:0 env\(safe-area-inset-right,0px\) env\(safe-area-inset-bottom,0px\) env\(safe-area-inset-left,0px\);overflow-x:clip;touch-action:manipulation\}/);
    expect(frameCss).toMatch(/\nhtml\{-webkit-text-size-adjust:100%;text-size-adjust:100%\}/);
    // PR #114 r1: 위쪽 safe-area 는 sticky 머리줄 안쪽 여백으로 — 전체화면·홈 화면 앱(노치 59px)에서도 STOP 이 노치 아래(측정은 PR 코멘트)
    expect(frameCss).toMatch(/\n\.fh\.phone \.fh-head\{padding:calc\(6px \+ env\(safe-area-inset-top,0px\)\) 8px 6px;gap:8px\}/);
    expect(driveCss).toMatch(/@media \(max-height:480px\)\{\.dv-hud\{[^}]*max-height:calc\(100% - 112px\);overflow-y:auto\}/);   // 가로: 상태 판이 조이스틱을 덮지 않음
  });

  it('10-25 아이폰 Safari: 조종 화면 길게 누르기 = 글자 선택·돋보기·메뉴·끌기 없음(입력란만 예외), 가로 시뮬 작은 지도는 오른쪽 조이스틱 안쪽', () => {
    expect(driveCss).toMatch(/\n\.fh:has\(\.dv\.ph\)\{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none\}/);
    expect(driveCss).toMatch(/\n\.fh:has\(\.dv\.ph\) :is\(input,textarea\)\{-webkit-user-select:text;user-select:text\}/);
    expect(driveCss).toMatch(/\n\.fh:has\(\.dv\.ph\) :is\(img,svg\)\{-webkit-user-drag:none\}/);
    expect(driveCss).toMatch(/\.dv-stick\{[^}]*touch-action:none/);
    // 오른쪽 조이스틱 12 + 90(테두리 포함) = 102 < 112: 가로로 겹치지 않음(높이와 무관)
    expect(driveCss).toMatch(/@media \(max-height:480px\)\{\[data-sim-drive\]\.dv\.ph \.dv-mini\{top:8px;right:112px;width:100px;height:70px\}/);
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
    act(() => { root = createRoot(box); root.render(<App {...as('u-kim')} />); });
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
    expect(dot.querySelector('i, svg')!.getAttribute('aria-hidden')).toBe('true');
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

// 11/28 결정(팀장 · 서버 #544 1 차): 총괄 = 모든 권한. 실기도 조종·STOP 한다(예전 10-25 «총괄은 실기 조종·STOP 없음»을 대체). 시뮬 판정(내가 띄운 시뮬만)은 그대로.
// 서버 관문(PHONE_DIRECT_REQUIRED · 연결 확인 · 조종권 하나 · 잠금)은 화면이 우회하지 않는다 · 서버 문구 그대로(tests/admin.test.tsx)
describe('총괄 · 실기도 조종·STOP(11/28), 시뮬은 그대로', () => {
  // 떠 있는 시뮬 = 서버가 담당을 띄운 사람(총괄 김OO)으로 둔다. 담당 없는 IDLE 슬롯은 PC STOP 후보가 아니다(simtab.test)
  const SIM: Robot = { id: 's1', name: '시뮬 로봇 1', owner: 'u-kim', battery: 90, online: true, seenAt: '14:05:20', status: 'IDLE', sim: true };
  const MIX = [ROBOTS[1], SIM];
  const NO = '실기 조종·STOP은 현장 폰에서 직접 하세요.';   // 서버 PHONE_DIRECT_REQUIRED 문구(화면이 바꾸지 않고 그대로 보임)
  const space = () => { key('keydown', 'Space', document.body); key('keyup', 'Space', document.body); };
  const again = (phone: boolean, hash: string, robots: Robot[]) => { act(() => root?.unmount()); box.remove(); mount(phone, ADMIN, hash, robots); serve(KIM, ...robots.map((r) => r.id)); };

  it('조종 이유: 총괄 + 실기 = 조종 가능, 총괄 + 시뮬 = 조종 가능, 운영 관리자는 그대로', () => {
    expect(driveBlock(USERS[0], ROBOTS[1])).toBeNull();
    expect(driveBlock(USERS[0], SIM)).toBeNull();
    expect(driveBlock(USERS[2], ROBOTS[1])).toBeNull();   // 박OO 의 Go2-7
    expect(driveBlock(USERS[1], ROBOTS[1])).not.toBeNull();   // 이OO 는 남의 로봇
  });

  // TAB-SPLIT(11-10): 로봇 탭 = 실기만 · 시뮬 행 없음. 11/28: 실기를 고르면 머리줄 STOP·Space = 그 실기
  it('PC 로봇 탭: 실기를 고르면 STOP·Space = 그 실기, 대시보드 값은 그대로. 시뮬 행은 없음, 서버가 허용하지 않은 실기는 조종 시작 없음', () => {
    mount(false, ADMIN, '#/fleet', MIX);
    serve(KIM, 'r7', 's1');
    expect(row('Go2-7').getAttribute('aria-pressed')).toBe('true');
    expect(row('Go2-7').textContent).toContain('80%');   // 실시간 상태(배터리)는 그대로
    expect($('[aria-label="로봇 상세"]')).toBeNull();   // 총괄: 상세는 행을 누르면 여는 서랍(03 §5.1)
    click(row('Go2-7'));
    expect($('[aria-label="로봇 상세"]').textContent).toContain('박OO');
    click($('[data-stop]'));
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7']);
    expect(btn('조종')).toBeUndefined();   // serverDrive 없음 = 서버가 아직 허용하지 않음
    space();
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7', 'r7']);
    expect(row('시뮬 로봇 1')).toBeUndefined();
    expect(w.of('lease.take')).toHaveLength(0);
  });

  // REVIEW-315 1(P1): 로봇 탭은 실기만 보여도 총괄이 고른 자기 시뮬(직결 없음 — sim.live() 아님)은 고른 채로 둔다 — 머리줄 STOP·Space = 그 시뮬(ed3af3e 와 같은 대상)
  it('PC 총괄 + 실기 + 자기 시뮬(직결 없음): 시뮬을 고른 채 기록 → 로봇 탭이면 STOP·Space = 그 시뮬, 실기 행을 누르면 STOP = 그 실기', () => {
    mount(false, ADMIN, '#/history', [SIM, ROBOTS[1]]);   // 첫 로봇 = 시뮬 → App 의 고른 로봇
    serve(KIM, 's1', 'r7');
    act(() => { location.hash = '#/fleet'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect($('main').getAttribute('aria-label')).toBe('로봇');
    expect(row('시뮬 로봇 1')).toBeUndefined();   // 목록은 실기만
    expect(row('Go2-7').getAttribute('aria-pressed')).toBe('false');   // 고른 로봇(시뮬)을 실기로 바꾸지 않음
    click($('[data-stop]'));
    expect(w.of('stop').map((m) => m.robot)).toEqual(['s1']);
    space();
    expect(w.of('stop').map((m) => m.robot)).toEqual(['s1', 's1']);
    click(row('Go2-7'));   // 11/28: 실기를 고르면 총괄도 STOP = 그 실기
    space();
    expect(w.of('stop').map((m) => m.robot)).toEqual(['s1', 's1', 'r7']);
    expect(w.of('lease.take')).toHaveLength(0);
  });

  // #547 검토 5: 실기와 남이 띄운 시뮬이 함께 있으면 실기만 후보(남의 시뮬은 빠짐) · PC · 폰 같음
  for (const phone of [false, true]) it(`${phone ? '폰' : 'PC'} 총괄 + 실기 둘 + 남이 띄운 시뮬: STOP 고르기는 실기만, 남의 시뮬로 정지 안 보냄`, () => {
    const OTHER: Robot = { ...SIM, id: 's9', name: '남의 시뮬', owner: 'u-lee', demo: false };   // 사용자 시뮬(데모 아님 · 22:04)
    mount(phone, ADMIN, phone ? '#/drive' : '#/mission', [ROBOTS[0], ROBOTS[1], OTHER]);
    serve(KIM, 'r3', 'r7', 's9');
    click($('[data-stop]'));
    const pick = $<HTMLSelectElement>('select[aria-label="정지할 로봇"]');
    expect([...pick.options].map((o) => o.value)).toEqual(['', 'r3', 'r7']);
    expect(w.of('stop').map((m) => m.robot)).not.toContain('s9');
  });

  it('PC 다른 탭: STOP 고르기는 실기 + 내 시뮬, 실기만 있어도 STOP', () => {
    mount(false, ADMIN, '#/mission', MIX);
    serve(KIM, 'r7', 's1');
    click($('[data-stop]'));
    const pick = $<HTMLSelectElement>('select[aria-label="정지할 로봇"]');
    expect([...pick.options].map((o) => o.value)).toEqual(['', 'r7', 's1']);
    again(false, '#/mission', [ROBOTS[0], ROBOTS[1]]);
    expect(box.querySelector('[data-stop]')).not.toBeNull();
  });

  // PR #94 B1: 고르기를 연 채 고른 시뮬이 목록에서 빠지면 그 시뮬로 정지를 보내지 않는다. 11/28: 남은 실기는 총괄도 STOP 후보
  it('[PR #94 B1] PC 고르기에서 시뮬을 고른 채 그 시뮬이 지워짐 → 그 시뮬로 정지 안 보냄, 남은 실기는 정지', () => {
    mount(false, ADMIN, '#/mission', MIX);
    serve(KIM, 'r7', 's1');
    click($('[data-stop]'));
    const pick = () => $<HTMLSelectElement>('select[aria-label="정지할 로봇"]');
    act(() => { pick().value = 's1'; pick().dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => root!.render(<App {...as(ADMIN, [ROBOTS[1]])} />));
    space();
    expect(w.of('stop')).toHaveLength(0);   // 고른 시뮬이 없어져 고르기 전으로(운영 관리자와 같음)
    expect([pick().value, ...[...pick().options].map((o) => o.value)]).toEqual(['', '', 'r7']);
    act(() => { pick().value = 'r7'; pick().dispatchEvent(new Event('change', { bubbles: true })); });
    click(btn('정지'));
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7']);
  });

  it('[PR #94 B1] 운영 관리자는 같은 상황에서 STOP 그대로: 분류가 바뀌어도 고른 로봇 정지, 고른 로봇이 지워지면 고르기 전으로·다른 로봇 정지', () => {
    mount(false, 'u-kim', '#/mission', [...ROBOTS, SIM]);
    serve(KIM, 'r3', 'r7', 'r1', 's1');
    click($('[data-stop]'));
    const pick = () => $<HTMLSelectElement>('select[aria-label="정지할 로봇"]');
    act(() => { pick().value = 's1'; pick().dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => root!.render(<App {...as('u-kim', [...ROBOTS, { ...SIM, sim: false }])} />));
    expect(pick().value).toBe('s1');
    click(btn('정지'));
    expect(w.of('stop').map((m) => m.robot)).toEqual(['s1']);
    click($('[data-stop]'));
    act(() => { pick().value = 'r7'; pick().dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => root!.render(<App {...as('u-kim', [ROBOTS[0], ROBOTS[2]])} />));
    expect(box.querySelector('[data-stop]')).not.toBeNull();
    expect([pick().value, ...[...pick().options].map((o) => o.value)]).toEqual(['', '', 'r3', 'r1']);
    act(() => { pick().value = 'r3'; pick().dispatchEvent(new Event('change', { bubbles: true })); });
    click(btn('정지'));
    expect(w.of('stop').map((m) => m.robot)).toEqual(['s1', 'r3']);
  });

  it('폰 로봇 연결: 실기 카드도 «연결», 실기 조종 화면에서 조종 시작 = 조종권 요청(서버 답 전에는 조종 중 아님)', () => {
    mount(true, ADMIN, '#/drive', MIX);
    serve(KIM, 'r7', 's1');
    expect([...box.querySelectorAll('.dv-card b')].map((b) => b.textContent)).toEqual(['Go2-7', '시뮬 로봇 1']);
    expect(box.querySelector('[data-stop]')).not.toBeNull();
    again(true, '#/drive/r7', MIX);
    expect(location.hash).toBe('#/drive/r7');
    w.auto = () => {};   // 서버 답 없음
    click(btn('조종'));
    expect(w.of('lease.take').map((m) => m.robot)).toEqual(['r7']);
    expect(text()).not.toContain('조종 중(나)');
    again(true, '#/drive', [ROBOTS[1]]);
    expect(box.querySelector('[data-stop]')).not.toBeNull();
    space();
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7']);
  });

  // PR #99: 폰 총괄도 PC 와 같은 판정 · 담당 없는 IDLE 슬롯·남이 띄운 시뮬은 STOP 후보가 아니다. 11/28: 실기가 있으면 총괄도 STOP(시뮬 판정만 보려고 실기 없이)
  it('폰 총괄 + IDLE 시뮬 슬롯만 → STOP·Space 없음, 내가 띄운 시뮬이면 STOP, 운영자는 늘 STOP', () => {
    const IDLE = { ...SIM, owner: '' };
    mount(true, ADMIN, '#/drive', MIX);
    for (const robots of [[IDLE], [IDLE, { ...IDLE, id: 's2', name: '시뮬 로봇 2', owner: 'u-lee', demo: false }]]) {
      again(true, '#/drive', robots);
      expect(box.querySelector('[data-stop]')).toBeNull();
      space();
      expect(w.of('stop')).toHaveLength(0);
    }
    again(true, '#/drive', MIX);   // SIM 담당 = 나(김OO)
    expect(box.querySelector('[data-stop]')).not.toBeNull();
    act(() => root?.unmount()); box.remove();
    mount(true, 'u-park', '#/drive', [ROBOTS[1], IDLE]); serve(PARK, 'r7');
    expect(box.querySelector('[data-stop]')).not.toBeNull();
    space();
    expect(w.of('stop').map((m) => m.robot)).toEqual(['r7']);
  });

  // PR #99: 폰 «내 로봇»도 같은 판정 · 끝낸 시뮬 슬롯(담당 없음)은 빼고 내가 띄운 시뮬은 보인다. 11/28: 실기도 보인다
  it('폰 총괄 «내 로봇»: IDLE 시뮬 슬롯은 없음, 실기와 내가 띄운 시뮬은 보임', () => {
    mount(true, ADMIN, '#/drive', [ROBOTS[1], { ...SIM, id: 's2', name: '시뮬 로봇 2', owner: '' }, SIM]);
    expect([...box.querySelectorAll('.dv-card b')].map((b) => b.textContent)).toEqual(['Go2-7', '시뮬 로봇 1']);
  });

  it('서버 403 PHONE_DIRECT_REQUIRED: STOP(실시간) 은 서버 문구로 «보내지 못함», 대체 경로로 다시 보내지 않음. 조종권도 한 번만', () => {
    const f = vi.fn((_u: RequestInfo | URL) => new Promise<Response>(() => {})); vi.stubGlobal('fetch', f);   // 답 없음 — 대체 경로로 STOP 을 보내는지만 셈
    mount(false, ADMIN, '#/fleet', [SIM]);
    serve(KIM, 's1');
    w.auto = (m) => (m.t === 'stop' || m.t === 'lease.take' ? fail('PHONE_DIRECT_REQUIRED', NO) : { ok: true });
    click($('[data-stop]'));
    tick(STOP_WS_MS + STOP_HTTP_MS);
    expect(band()).toContain(`시뮬 로봇 1 정지 요청을 보내지 못했습니다. ${NO}`);
    expect([w.of('stop').length, f.mock.calls.filter(([u]) => String(u).includes('/stop')).length]).toEqual([1, 0]);
    act(() => rt.take('s1'));
    tick(5000);
    expect(rt.get('s1').notice).toBe(NO);
    expect(w.of('lease.take')).toHaveLength(1);
  });

  it('서버 403 PHONE_DIRECT_REQUIRED(대체 경로 HTTP): 서버 문구로 «보내지 못함», 다시 보내지 않음', async () => {
    const f = vi.fn(async (_u: RequestInfo | URL) => new Response(JSON.stringify({ error: { code: 'PHONE_DIRECT_REQUIRED', message: NO, detail: {} } }), { status: 403 }));
    vi.stubGlobal('fetch', f);
    mount(false, ADMIN, '#/fleet', [SIM]);
    serve(KIM, 's1');
    act(() => w.drop(1006));
    click($('[data-stop]'));
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(band()).toContain(`시뮬 로봇 1 정지 요청을 보내지 못했습니다. ${NO}`);
    tick(STOP_WS_MS + STOP_HTTP_MS);
    expect(f.mock.calls.filter((c) => String(c[0]).includes('/stop'))).toHaveLength(1);
  });
});

// 10-26 실폰: 전체화면은 화면 전환일 뿐 — 조종권·입력(cmd 50 ms)·STOP 경로는 그대로. 아이폰(요소 전체화면 막힘)은 단추 대신 «홈 화면에 추가» 안내
describe('전체화면(⋯ 메뉴)', () => {
  let fsEl: Element | null = null;
  afterEach(() => {
    fsEl = null;
    for (const k of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen']) delete (document as unknown as Record<string, unknown>)[k];
    delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  });
  const fsApi = () => {
    const req = vi.fn(async () => { fsEl = document.documentElement; document.dispatchEvent(new Event('fullscreenchange')); });
    const exit = vi.fn(async () => { fsEl = null; document.dispatchEvent(new Event('fullscreenchange')); });
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: req });
    return { req, exit };
  };

  it('되는 브라우저: «전체화면» 켜기/끄기 — 누르는 키 입력·조종권·cmd 박자 그대로, 반납·hidden 0, STOP 은 보이고 눌림', async () => {
    const { req, exit } = fsApi();
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    expect($('[data-full-tip]')).toBeNull();
    key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    const lid = end(cmds()).lease_id;
    await act(async () => { $('[data-full]').click(); });
    expect(req).toHaveBeenCalledTimes(1);
    expect($('[data-full]').textContent).toBe('전체화면 끄기');
    const n = cmds().length;
    tick(500);
    expect(cmds().length - n).toBe(500 / 50);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    expect(end(cmds()).lease_id).toBe(lid);
    await act(async () => { $('[data-full]').click(); });
    expect(exit).toHaveBeenCalledTimes(1);
    expect($('[data-full]').textContent).toBe('전체화면');
    tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    expect([w.of('lease.release'), w.of('hidden'), w.of('stop')].map((a) => a.length)).toEqual([0, 0, 0]);
    expect($('header, .bar .rt').lastElementChild).toBe($('[data-stop]'));
    click($('[data-stop]'));
    expect(w.of('stop')).toHaveLength(1);
  });

  it('Android 앱(UA FootholdApp/): 껍데기가 늘 전체화면 — 단추·안내 둘 다 없음, 조종 화면 표시(data-drive)만, STOP 그대로', () => {
    fsApi();   // 브라우저였다면 단추가 보일 조건
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; wv) Chrome/140 Mobile Safari/537.36 FootholdApp/1.1.0-dev');
    onTestFinished(() => ua.mockRestore());
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    expect($('[data-full]')).toBeNull();
    delete (document as unknown as Record<string, unknown>).fullscreenEnabled;   // 브라우저였다면 «홈 화면에 추가» 안내가 보일 조건
    window.matchMedia = ((q: string) => ({ matches: q === PHONE_Q, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    act(() => push('r7', { speed: 0.1 }));
    expect($('[data-full-tip]')).toBeNull();
    expect($('[data-layout]').hasAttribute('data-drive')).toBe(true);
    expect($('header, .bar .rt').lastElementChild).toBe($('[data-stop]'));
  });

  it('아이폰(요소 전체화면 없음): 단추 없이 «홈 화면에 추가» 안내, 홈 화면 앱으로 열렸으면 안내도 없음 — STOP 그대로', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    expect($('[data-full]')).toBeNull();
    expect($('[data-full-tip]')).toBeNull();   // mount 의 matchMedia 는 모든 질의에 true = display-mode standalone(홈 화면 앱)
    window.matchMedia = ((q: string) => ({ matches: q === PHONE_Q, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    act(() => push('r7', { speed: 0.1 }));
    expect($('[data-full]')).toBeNull();
    expect($('[data-full-tip]').textContent).toContain('홈 화면에 추가');
    expect($('header, .bar .rt').lastElementChild).toBe($('[data-stop]'));
  });

  it('좁은 창(768 미만): 마우스 쓰는 총괄은 PC 틀(지도 탭 그대로), 손가락 입력 총괄·운영자는 폰 틀 (11-11 현민님)', () => {
    const show = (user: string, coarse: boolean) => {
      if (root) { act(() => root!.unmount()); box.remove(); }
      window.matchMedia = ((q: string) => ({ matches: q === PHONE_Q || (coarse && q === '(pointer: coarse)'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
      location.hash = '#/map';
      box = document.createElement('div'); document.body.append(box);
      act(() => { root = createRoot(box); root.render(<App {...as(user, ROBOTS)} />); });
      return `${$('[data-layout]').getAttribute('data-layout')} ${location.hash}`;
    };
    expect(show(ADMIN, false)).toBe('pc #/map');
    expect(show(ADMIN, true)).toMatch(/^phone #\/drive/);
    expect(show('u-park', false)).toMatch(/^phone #\/drive/);
  });
});

// RB-PHONE-REAL-TABLE 11-19: 서버 경유 실기(serverDrive)는 서버가 명령표 값만 받는다 — 폰 스틱도 표 값(켜짐/꺼짐)으로. 허용이 확인 안 되면 0(-FIX)
describe('폰 실기 조종 = 서버 명령표', () => {
  afterEach(() => { act(() => simTune(null)); });
  const SD = ROBOTS.map((r) => (r.id === 'r7' ? { ...r, serverDrive: true } : r));
  const sticks = () => {
    const fwd = $('[aria-label="이동 조이스틱"]'), turn = $('[aria-label="회전 조이스틱"]');
    for (const el of [fwd, turn]) el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    return { fwd, turn };
  };
  const ptr = (el: Element, type: string, x = 60, y = 60) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })); });
  /** 이동 손잡이 위치(x 오른쪽 + · y 위 +, -1..1) · 회전 손잡이 x(-1..1, 왼쪽 +) */
  const moveTo = (el: Element, x: number, y: number, type = 'pointermove') => ptr(el, type, 60 + x * 60, 60 - y * 60);
  const fwdAt = (el: Element, y: number) => moveTo(el, 0, y, 'pointerdown');
  const turnAt = (el: Element, x: number) => ptr(el, 'pointerdown', 60 - x * 60, 60);
  const open = (robots = SD) => { mount(true, 'u-park', '#/drive/r7', robots); serve(PARK, 'r7'); ready(); return sticks(); };

  it('손잡이(팀장 11-28 17:33 · PC 로봇 탭과 같은 stickTok): 왼쪽 = 앞 · 뒤 · 옆, 오른쪽 = 돌기, 큰 축 하나 · 문턱 0.3, 표 값만', () => {
    const { fwd, turn } = open();
    expect(text()).toContain(REAL_STICK);
    fwdAt(fwd, 0.6); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    moveTo(fwd, 0, 1); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    moveTo(fwd, 0, 0.2); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);          // 문턱 0.3 아래 = 0
    moveTo(fwd, 0, 0.4); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    moveTo(fwd, 0, -1); tick(100); expect(lastAxes()).toEqual([-1.5, 0, 0]);        // 뒤(조직 뒤 상한 안)
    expect(text()).not.toContain('후진은 아직 지원하지 않습니다');
    moveTo(fwd, -1, 0); tick(100); expect(lastAxes()).toEqual([0, 1, 0]);          // 왼쪽 옆걸음
    moveTo(fwd, 1, 0); tick(100); expect(lastAxes()).toEqual([0, -1, 0]);
    moveTo(fwd, -0.5, 0.8); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);    // 대각 = 큰 축 하나
    moveTo(fwd, -0.8, 0.5); tick(100); expect(lastAxes()).toEqual([0, 1, 0]);
    ptr(fwd, 'pointerup'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    turnAt(turn, 1); tick(100); expect(lastAxes()).toEqual([0, 0, MAX_TURN_RATE]);
    ptr(turn, 'pointermove', 120, 60); tick(100); expect(lastAxes()).toEqual([0, 0, -MAX_TURN_RATE]);
    ptr(turn, 'pointermove', 60, 0); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);   // 오른쪽은 가로만
    ptr(turn, 'pointermove', 0, 60);
    fwdAt(fwd, 1); tick(100); expect(lastAxes()).toEqual([1.5, 0, MAX_TURN_RATE]);   // 앞 + 돌기 = 표 조합
    moveTo(fwd, -1, 0); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);         // 옆 + 돌기 = 표 밖 → 0 + 까닭
    expect(text()).toContain(COMBO_BLOCK);
    ptr(fwd, 'pointerup'); ptr(turn, 'pointerup'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).not.toContain(COMBO_BLOCK);
    act(() => simTune({ ...ORG, real_max_vy: 0 }));
    moveTo(fwd, -1, 0, 'pointerdown'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).toContain(SIDE_BLOCK);
    ptr(fwd, 'pointerup'); tick(100); expect(text()).not.toContain(SIDE_BLOCK);
    act(() => simTune({ ...ORG, real_max_vx_back: 0 }));
    moveTo(fwd, 0, -1, 'pointerdown'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).toContain(CAP_BLOCK);
    ptr(fwd, 'pointerup'); tick(100); expect(text()).not.toContain(CAP_BLOCK);
    key('keydown', 'KeyS'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);   // 키 S · ↓ 도 같은 규칙: 뒤 상한 0 이면 0 + 까닭
    expect(text()).toContain(CAP_BLOCK);
    key('keyup', 'KeyS'); tick(100); expect(text()).not.toContain(CAP_BLOCK);
    act(() => simTune(ORG));
    key('keydown', 'ArrowDown'); tick(100); expect(lastAxes()).toEqual([-1.5, 0, 0]);   // 상한 안이면 뒤로(팀장 11-28 17:33 「다 지원」)
    expect(text()).not.toContain(CAP_BLOCK);
    key('keyup', 'ArrowDown');
    key('keydown', 'KeyW'); key('keydown', 'KeyD'); tick(100); expect(lastAxes()).toEqual([1.5, 0, -MAX_TURN_RATE]);   // 키도 같은 표
    key('keyup', 'KeyW'); key('keyup', 'KeyD'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
  });

  it('키(11-28 17:25): A / D = 회전, ← / → = 옆걸음 표 값 ±1(조직 옆 상한이 허락할 때), Q · E 없음, ←+→·창 밖 = 0, 옆 상한 0 이면 0 + 까닭', () => {
    open();
    key('keydown', 'KeyA'); tick(100); expect(lastAxes()).toEqual([0, 0, MAX_TURN_RATE]);
    key('keyup', 'KeyA'); key('keydown', 'KeyD'); tick(100); expect(lastAxes()).toEqual([0, 0, -MAX_TURN_RATE]);
    key('keyup', 'KeyD'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    key('keydown', 'KeyQ'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]); key('keyup', 'KeyQ');   // Q · E 는 뺌
    key('keydown', 'KeyE'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]); key('keyup', 'KeyE');
    key('keydown', 'ArrowLeft'); tick(100); expect(lastAxes()).toEqual([0, 1, 0]);
    key('keyup', 'ArrowLeft'); key('keydown', 'ArrowRight'); tick(100); expect(lastAxes()).toEqual([0, -1, 0]);
    key('keydown', 'ArrowLeft'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);   // 함께 누름 = 0
    key('keyup', 'ArrowLeft'); key('keyup', 'ArrowRight'); key('keydown', 'ArrowLeft'); tick(100); expect(lastAxes()).toEqual([0, 1, 0]);
    act(() => { window.dispatchEvent(new Event('blur')); }); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    key('keyup', 'ArrowLeft');
    act(() => simTune({ ...ORG, real_max_vy: 0 }));
    key('keydown', 'ArrowLeft'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).toContain(SIDE_BLOCK);
    key('keyup', 'ArrowLeft'); tick(100); expect(text()).not.toContain(SIDE_BLOCK);
  });

  it('글 입력칸에 초점이면 조종 키(←·W)는 명령 0 · 글자는 막지 않음, 입력칸에서 누른 키는 뗄 때까지 0', () => {
    open();
    const input = document.createElement('input'); input.setAttribute('data-go2-ip', ''); document.body.append(input); input.focus();
    for (const c of ['ArrowLeft', 'KeyW']) {
      const e = new KeyboardEvent('keydown', { code: c, bubbles: true, cancelable: true });
      act(() => { input.dispatchEvent(e); }); tick(100);
      expect(e.defaultPrevented).toBe(false);
      expect(lastAxes()).toEqual([0, 0, 0]);
    }
    key('keydown', 'KeyD'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);   // 입력칸에서 누른 ←·W 가 남아 있는 동안 0
    key('keyup', 'ArrowLeft', input); key('keyup', 'KeyW', input); key('keyup', 'KeyD'); input.remove();
    key('keydown', 'KeyD'); tick(100); expect(lastAxes()).toEqual([0, 0, -MAX_TURN_RATE]);
    key('keyup', 'KeyD');
  });
  it('표에 없는 키 조합(W+← · A+← · A+D)은 0 + 까닭 한 줄, 떼면 사라짐', () => {
    open();
    for (const [a, b] of [['KeyW', 'ArrowLeft'], ['KeyA', 'ArrowLeft'], ['KeyA', 'KeyD']]) {
      key('keydown', a); key('keydown', b); tick(100);
      expect(lastAxes()).toEqual([0, 0, 0]);
      expect(text()).toContain(COMBO_BLOCK);
      key('keyup', b); key('keyup', a); tick(100);
      expect(text()).not.toContain(COMBO_BLOCK);
    }
    key('keydown', 'KeyW'); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]); expect(text()).not.toContain(COMBO_BLOCK);
    key('keyup', 'KeyW');
  });

  it('조직 상한·빠른 조종 끔이면 0, 표 값 밖 비례 값은 보내지 않음', () => {
    const { fwd, turn } = open();
    act(() => simTune({ ...ORG, real_no_fast_server_drive: true }));
    fwdAt(fwd, 1); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    turnAt(turn, 1); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);           // 앞+회전 조합도 막힘
    ptr(fwd, 'pointerup'); tick(100); expect(lastAxes()).toEqual([0, 0, MAX_TURN_RATE]);   // 제자리 회전은 상한 안
    act(() => simTune({ ...ORG, real_max_wz: 1 })); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    ptr(turn, 'pointerup');
    act(() => simTune({ ...ORG, real_max_vx: 1 })); fwdAt(fwd, 1); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    const ok = new Set(['0,0,0', '1.5,0,0', `0,0,${MAX_TURN_RATE}`, `0,0,${-MAX_TURN_RATE}`, `1.5,0,${MAX_TURN_RATE}`, `1.5,0,${-MAX_TURN_RATE}`]);
    expect(cmds().every((m) => ok.has(String(m.axes)))).toBe(true);
  });

  it('잠금 해제 뒤 새 중립 전에는 0, 시트를 열면 0 이고 다시 눌러야 움직임', () => {
    mount(true, 'u-park', '#/drive/r7', SD); serve(PARK, 'r7');
    click(btn('조종'));
    key('keydown', 'KeyW'); tick(200); expect(lastAxes()).toEqual([0, 0, 0]);
    unlock(); tick(200); expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'KeyW'); tick(100); expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
    const { fwd } = sticks();
    fwdAt(fwd, 1); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    click($('.dv-sheets button')); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    expect(lastAxes()).toEqual([0, 0, 0]);
    click(btn('닫기')); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);   // 시트를 닫아도 쥐던 포인터는 되살리지 않음
    ptr(fwd, 'pointerup'); fwdAt(fwd, 1); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);     // 떼고 새로 누르면 움직임
  });

  // 시뮬 로봇은 이 화면이 열리지 않는다(App — simdrive 직결). 서버 경유 허용이 확인 안 된 로봇은 비례 대신 0
  it('서버 경유 허용이 확인 안 된 로봇은 0 + 안내', () => {
    const { fwd, turn } = open(ROBOTS);
    expect(text()).not.toContain(REAL_STICK);
    expect(text()).not.toContain(REAL_WAIT);                // 평소 숨김(시안 u1 에 없는 띠)
    fwdAt(fwd, 0.5); turnAt(turn, 1); tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect($('[data-real-wait-pill]')!.textContent).toBe(REAL_WAIT_PILL);   // 입력이 0 이 되는 순간만 작은 알약
  });
});

// 임무 부품을 u1 조종 화면에(시안 u1_1 · u1_15 자리 · app-lead 11-28 22:58): 보이기만. 임무(state.run · 끝나지 않음)이고 내 조종이 아닐 때 바탕 지도 · 왼쪽 아래 카드 · 칩 글
describe('폰 u1 임무 화면(보이기만)', () => {
  const RUN = { run_id: 'run-2', status: 'MOVING' as const, step: 1, progress: { done: 1, total: 4 }, wait_reason: null, fail_code: null };
  const at = (min: number) => new Date(Date.now() + min * 60000).toISOString();
  const SLOT = { id: 's2', robot_id: 'r7', scenario_id: 'sc-a', scenario_version: 3, gait: null, start: at(-10), end: at(20), kind: 'CONFIRMED', assignment_id: null, memo: '', created_by: 'u', created_at: at(-60), run_state: 'STARTED', run_id: 'run-2', run_code: null, confirmed_by: null };
  const wp = (name: string, x: number, y: number) => ({ floor_id: 'f1', map_version_id: 'mv-x', x, y, mission_id: 'm', mission_version: 1, name });
  const SC = { id: 'sc-a', name: '공정 순찰 A', version: 3, map_version_ids: ['mv-x'], waypoints: [wp('입구', 1, 1), wp('게이지 읽기', 2, 1), wp('밸브', 2, 3), wp('복귀', 1, 3)] };
  const MV = { id: 'mv-x', width: 200, height: 100, resolution: 0.1, origin: [0, 0, 0] };
  const apis = (mv: object | null = MV) => {
    vi.spyOn(api, 'schedule').mockImplementation(() => Promise.resolve({ slots: [SLOT] }) as never);
    vi.spyOn(api, 'plan').mockImplementation(() => Promise.resolve(SC) as never);
    vi.spyOn(api, 'version').mockImplementation(() => (mv ? Promise.resolve(mv) : Promise.reject(new Error('x'))) as never);
  };
  const open = async (run: object | null, mv: object | null = MV) => {
    apis(mv);
    mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7');
    if (run) { recv(lease('r7', { id: null, name: '', type: 'RUN' })); act(() => push('r7', { run, latched: false } as never)); }   // 임무가 도는 로봇 = 정지 잠금 풀림(잠김은 안전 표시 시험이 따로)
    await act(async () => {});
    await act(async () => {});
  };

  it('임무가 있을 때: 바탕 지도 · 카드 「오늘 1 / 1 공정 순찰 A」 · 칩 「순찰 중」 · 작은 지도 칸 없음', async () => {
    await open(RUN);
    expect($('.u1d')!.hasAttribute('data-mission')).toBe(true);
    expect($('.u1d svg.u1-mmap')).not.toBeNull();
    expect($('.u1d .u1-mission .mn')!.textContent).toBe('오늘 1 / 1');
    expect($('.u1d .u1-mission b')!.textContent).toBe('공정 순찰 A');
    expect($('.u1-chip .u1-st')!.textContent).toBe('순찰 중');
    expect($('.u1d .dv-mini')).toBeNull();
    expect(u1AppCss).toMatch(/\.u1d\[data-mission\] \.act\{display:none\}/);   // 시안 u1_1 에는 동작 줄이 없다
  });

  it('안전 표시: 정지 잠금이면 임무가 남아 있어도 칩 · 카드에 잠금 글이 먼저(잠김 + run PAUSED → 「정지 잠금」 · 「정지됨」)', async () => {
    const P = { ...RUN, status: 'PAUSED' as const };
    await open(P);
    act(() => push('r7', { latched: null, run: P } as never));
    expect($('.u1-chip .u1-st')!.textContent).toBe('정지 잠금');
    expect($('.u1-chip .u1-st')!.className).toContain('bad');
    expect($('.u1d .u1-mission .ml')!.textContent).toBe('정지 잠금');
    act(() => push('r7', { latched: true, run: P } as never));
    expect($('.u1-chip .u1-st')!.textContent).toBe('정지됨');
    expect($('.u1d .u1-mission .ml')!.textContent).toBe('정지됨');
    expect($('.u1d .u1-mission b')!.textContent).toBe('공정 순찰 A');   // 카드는 남는다 · 줄 글만 잠금
    act(() => push('r7', { latched: false, run: P } as never));
    expect($('.u1-chip .u1-st')!.textContent).toBe('일시정지됨');   // 잠금이 풀리면 임무 글로
  });

  it('위 띠: 임무 화면이면 「시나리오 실행 중」 u1-who 띠는 숨김(칩 · 카드가 대신) · dv-run 「멈추려면 STOP」 은 그대로 · 잠기면 칩에 잠금 글', async () => {
    apis();
    mount(true, 'u-park', '#/drive/r7', ROBOTS.map((r) => (r.id === 'r7' ? { ...r, mission: '공정 순찰 A' } : r))); serve(PARK, 'r7');
    recv(lease('r7', { id: null, name: '', type: 'RUN' })); act(() => push('r7', { run: RUN, latched: false } as never));
    await act(async () => {}); await act(async () => {});
    expect($('.u1d')!.hasAttribute('data-mission')).toBe(true);
    expect($('.u1d .u1-who')).toBeNull();
    expect([...document.querySelectorAll('.u1d .ban')].map((b) => b.textContent).join()).not.toContain('시나리오 실행 중');   // 칩 펼침(닫힌 .pane)의 조종 줄은 그대로
    expect($('.u1d .dv-run [data-run-stop]')!.textContent).toBe('멈추려면 STOP');
    act(() => push('r7', { latched: null, run: RUN } as never));
    expect($('.u1-chip .u1-st')!.textContent).toBe('정지 잠금');
    expect($('.u1d .dv-run')).not.toBeNull();
  });

  it('시안 u1_1 「일시정지」 = 이미 있는 「일시정지하고 조종」 창(조종권 받기 · 서버가 임무를 멈춤). 창 전에는 보냄 0', async () => {
    await open(RUN);
    const pause = $<HTMLButtonElement>('[data-u1-pause]');
    expect(pause.textContent).toBe('일시정지');
    const n = w.sent.length;
    click(pause);
    expect($('.dv-ask[role="dialog"]')!.textContent).toContain('일시정지하고 조종');
    expect(w.sent.length).toBe(n);
    click(btn('일시정지하고 조종'));
    expect(w.of('lease.take')).toHaveLength(1);
    expect(w.of('run.control')).toHaveLength(0);   // 조종권 없는 run.control 길은 쓰지 않음
  });
  it('시안 u1_11 일시정지된 임무(조종권 쥔 사람 없음) 「이어 가기」 = 조종권 받기부터(조종과 같은 길) · run.control 은 아직 0', async () => {
    await open({ ...RUN, status: 'PAUSED' });
    recv(lease('r7', null));
    expect($('[data-u1-pause]')).toBeNull();
    click($('[data-u1-resume-take]'));
    expect(w.of('lease.take')).toHaveLength(1);
    expect(w.of('run.control')).toHaveLength(0);
  });
  it('내 조종권 · 내 임무가 일시정지 · 잠금 풀림 · 시뮬(데모)이면 띠 「이어 가기」 = run.control resume 한 번 (PC RunCtl 과 같은 조건)', async () => {
    apis();
    mount(true, 'u-park', '#/drive/r7', SD_ROBOTS.map((r) => (r.id === 'r7' ? { ...r, sim: true, demo: true } : r))); serve(PARK, 'r7');
    click(btn('조종'));
    act(() => push('r7', { run: { ...RUN, status: 'PAUSED' } } as never));
    expect($('[data-u1-runctl]')!.textContent).toContain('「다시 시작」 뒤');   // 잠겨 있으면 단추 대신 까닭
    expect($('[data-u1-runctl] button')).toBeNull();
    unlock(); tick(100);
    click($('[data-u1-runctl] button')!);
    expect(w.of('run.control')).toMatchObject([{ op: 'resume', run_id: 'run-2', robot: 'r7' }]);
    act(() => push('r7', { run: RUN } as never));
    expect($('[data-u1-runctl] button')!.textContent).toBe('일시정지');
  });
  it('실기는 내 조종권이어도 띠에 단추 없이 까닭(RunCtl 과 같음)', async () => {
    apis();
    mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7');
    click(btn('조종')); unlock(); tick(100);
    act(() => push('r7', { run: { ...RUN, status: 'PAUSED' } } as never));
    expect($('[data-u1-runctl]')!.textContent).toContain('실기는 아직 화면에서 임무를 이어 갈 수 없습니다');
    expect($('[data-u1-runctl] button')).toBeNull();
  });

  it('위 띠: 다른 사람이 쥐면(임무 아님) u1-who 띠는 그대로', async () => {
    await open(null);
    recv(lease('r7', LEE, null));
    expect($('.u1d .u1-who')!.textContent).toContain('이OO');
  });

  it('임무가 없을 때: 시안 빈 상태 그대로(지도 · 카드 없음 · 작은 지도 칸 · 일정 받지 않음)', async () => {
    await open(null);
    expect($('.u1d')!.hasAttribute('data-mission')).toBe(false);
    expect($('.u1d svg.u1-mmap')).toBeNull();
    expect($('.u1d .u1-mission')).toBeNull();
    expect($('.u1d .dv-mini')).not.toBeNull();
    expect(api.schedule).not.toHaveBeenCalled();
  });

  it('왼쪽 보기 고르개(시안 u1_1 로봇 · 평면 · 3D): 로봇 = 로봇 둘레 · 평면 = 판 전체 · 3D 는 꺼 둠(「3D 지도 준비 중」) · 임무 없으면 없음', async () => {
    await open(RUN);
    act(() => push('r7', { location: { floor_id: 'f1', map_version_id: 'mv-x', x: 5, y: 5, yaw: 0, confidence: 1, updated_at: new Date().toISOString() } } as never));
    const col = $('.u1d .u1-vcol')!;
    expect([...col.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['로봇', '평면', '3D']);
    expect(btn('로봇').getAttribute('aria-pressed')).toBe('true');
    expect($('.u1d svg.u1-mmap')!.getAttribute('viewBox')).toBe('0 25 100 50');   // 로봇(50, 50 px) 둘레 판의 반
    click(btn('평면'));
    expect(btn('평면').getAttribute('aria-pressed')).toBe('true');
    expect($('.u1d svg.u1-mmap')!.getAttribute('viewBox')).toBe('0 0 200 100');
    const d3 = btn('3D');
    expect(d3.getAttribute('aria-disabled')).toBe('true');
    click(d3);
    expect(text()).toContain('3D 지도 준비 중');
    expect($('.u1-vnote')!.classList.contains('g')).toBe(true);   // 어두운 판 대비: 시안 유리 알약 .g · 글 --ink
    expect(u1AppCss).toMatch(/\.u1-vnote\{[^}]*color:var\(--ink\)\}/);
    expect($('.u1d svg.u1-mmap')!.getAttribute('viewBox')).toBe('0 0 200 100');
    expect(u1AppCss).toMatch(/\.u1d \.u1-vcol\{position:absolute;left:12px;top:118px;width:46px;padding:5px;display:flex;flex-direction:column;gap:4px;border-radius:16px/);
    // 밝은 판: 폰 틀 .fh.light .dv-hud .btn 규칙(drive.css)이 덮지 않게 — 고른 칸 = 시안 #1f2421 채움 · 흰 글자, 안 고른 칸 = 바탕 없음
    expect(u1AppCss).toContain('.u1d .u1-vcol .btn[aria-pressed="true"]{background:#1f2421!important;color:#fff!important}');
    expect(u1AppCss).toContain('.u1d .u1-vcol .btn{height:44px;border-radius:12px;color:var(--ink)!important;padding:0;min-width:0;background:none!important;border:0!important}');
  });

  it('임무가 없으면 보기 고르개 없음', async () => {
    await open(null);
    expect($('.u1d .u1-vcol')).toBeNull();
  });

  it('판을 못 받을 때: 지도 없음 · 카드는 그대로', async () => {
    await open(RUN, null);
    expect($('.u1d svg.u1-mmap')).toBeNull();
    expect($('.u1d .u1-mission b')!.textContent).toBe('공정 순찰 A');
  });
});

// 폰 데모 로봇(목록 sim · demo true · app-lead 11-28 22:40 · reviewer 코드 전 판정 22:47): 데모 = 실기 → 서버 경유 u1 조종 화면.
// 내 시뮬 슬롯(demo false)과 모름(undefined)은 지금처럼 simdrive 직결 길. 속도는 웹 상한(OrgSettings sim_* · 서버는 시뮬 cmd 상한을 검사하지 않는다)
describe('폰 데모 로봇 = 서버 경유 u1 조종 화면', () => {
  const R7 = ROBOTS.find((r) => r.id === 'r7')!;
  const robots = (demo: boolean | undefined) => ROBOTS.map((r) => (r.id === 'r7' ? { ...R7, sim: true, demo, serverDrive: false } : r));
  const open = (demo: boolean | undefined, org: object = ORG) => {
    settingsMock.mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(org); } }) as never);
    mount(true, 'u-park', '#/drive/r7', robots(demo)); serve(PARK, 'r7');
  };
  const press = (code: string) => { key('keydown', code); tick(200); const a = lastAxes(); key('keyup', code); tick(100); return a; };

  it('demo true 면 #/drive/r7 이 u1 조종 화면 · 「시뮬」 꼬리표 없음', () => {
    open(true);
    expect($('.u1d')).not.toBeNull();
    expect(location.hash).toBe('#/drive/r7');
    expect($('.u1-chip .tag')).toBeNull();
  });

  it('demo false(내 시뮬) · undefined(모름)는 지금처럼 조종 화면을 열지 않음 · 카드는 직결 안내', () => {
    for (const d of [false, undefined]) {
      open(d);
      expect($('.u1d')).toBeNull();
      expect($('[data-sim-card]')).not.toBeNull();
      act(() => root!.unmount()); root = null; box.remove();
    }
  });

  it('로봇 연결 카드: 데모는 「연결」 단추 · 「시뮬」 칩 없음', () => {
    settingsMock.mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
    mount(true, 'u-park', '#/drive', robots(true)); serve(PARK, 'r7');
    const card = [...box.querySelectorAll('.dv-card')].find((c) => c.textContent!.includes('Go2-7'))!;
    expect(card.querySelector('[data-sim-card]')).toBeNull();
    expect([...card.querySelectorAll('button')].some((b) => b.textContent === '연결')).toBe(true);
    expect(card.textContent).not.toContain('시뮬');
  });

  // 웹 상한(app-lx 11-28 22:59): 축마다 min(조직 sim_* , 시뮬 에이전트 한계 vx -0.3~1.5 · vy ±0.3 · wz ±0.5). 서버는 시뮬 cmd 상한을 검사하지 않는다
  const sticks = () => {
    const fwd = $('[aria-label="이동 조이스틱"]'), turn = $('[aria-label="회전 조이스틱"]');
    for (const el of [fwd, turn]) el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    return { fwd, turn };
  };
  const ptr = (el: Element, type: string, x = 60, y = 60) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })); });
  /** 이동 손잡이: f = 앞 +(위), s = 왼쪽 + · 회전 손잡이: t = 왼쪽 + */
  const lstick = (el: Element, f: number, s = 0) => { ptr(el, 'pointerdown', 60 - s * 60, 60 - f * 60); tick(200); const a = lastAxes() as number[]; ptr(el, 'pointerup'); tick(100); return a; };
  const rstick = (el: Element, t: number) => { ptr(el, 'pointerdown', 60 - t * 60, 60); tick(200); const a = lastAxes() as number[]; ptr(el, 'pointerup'); tick(100); return a; };

  it('웹 상한 축마다 min(조직 · 로봇 한계): 키 앞 1.5 · 돌기 0.5 · 옆 0.3 · 뒤 -0.3 — 실기 상한(real_*)은 쓰지 않음', () => {
    open(true, { ...ORG, real_max_vx: 0.5, real_max_wz: 0.3, real_max_vy: 0 });
    ready();
    expect(press('KeyW')).toEqual([1.5, 0, 0]);
    expect(press('KeyA')).toEqual([0, 0, 0.5]);
    expect(press('KeyD')).toEqual([0, 0, -0.5]);
    expect(press('ArrowLeft')).toEqual([0, 0.3, 0]);
    expect(press('KeyS')).toEqual([-0.3, 0, 0]);
  });

  it('웹 상한: 조직 값이 로봇 한계보다 작으면 조직 값(sim_max_vx · sim_max_wz · sim_max_vy) · 키는 손잡이 끝까지와 같은 입력(sim_key_vx 안 씀)', () => {
    open(true, { ...ORG, sim_max_vx: 1.0, sim_key_vx: 0.8, sim_max_wz: 0.3, sim_max_vy: 0.2 });
    ready();
    expect(press('KeyW')).toEqual([1.0, 0, 0]);
    expect(lstick(sticks().fwd, 1)).toEqual([1.0, 0, 0]);
    expect(press('KeyA')).toEqual([0, 0, 0.3]);
    expect(press('ArrowRight')).toEqual([0, -0.2, 0]);
    act(() => root!.unmount()); root = null; box.remove();
    open(true, { ...ORG, sim_max_vx: 0.6 });
    ready();
    expect(press('KeyW')).toEqual([0.6, 0, 0]);
  });

  it('웹 상한 · 손잡이 비례: 앞은 [0.2, 상한] · 0 < vx < 0.2 는 나가지 않음 · 뒤는 [-0.3, -0.2] · 문턱 0.1', () => {
    open(true);
    ready();
    const { fwd, turn } = sticks();
    expect(lstick(fwd, 0.05)).toEqual([0, 0, 0]);                      // 문턱 0.1 안
    const a = lstick(fwd, 0.12)!;
    expect(a[0]).toBeGreaterThanOrEqual(0.2); expect(a[0]).toBeLessThan(0.3);
    expect(lstick(fwd, 1)).toEqual([1.5, 0, 0]);
    const mid = lstick(fwd, 0.55)!;
    expect(mid[0]).toBeCloseTo(0.2 + (0.45 / 0.9) * 1.3, 5);
    for (const f of [0.02, 0.05, 0.09, 0.11, 0.2, 0.4, 0.7]) { const v = lstick(fwd, f)![0]; expect(v === 0 || v >= 0.2).toBe(true); }
    const b = lstick(fwd, -0.12)!;
    expect(b[0]).toBeLessThanOrEqual(-0.2); expect(b[0]).toBeGreaterThanOrEqual(-0.3);
    expect(lstick(fwd, -1)).toEqual([-0.3, 0, 0]);
    expect(cmds().every((m) => (m.axes as number[])[0] >= -0.3)).toBe(true);
    expect(lstick(fwd, 0, 1)).toEqual([0, 0.3, 0]);
    expect(rstick(turn, -1)).toEqual([0, 0, -0.5]);
  });

  it('웹 상한 · 문턱은 조직 stick_deadzone(없으면 0.1)', () => {
    open(true, { ...ORG, stick_deadzone: 0.2 });
    ready();
    const { fwd } = sticks();
    expect(lstick(fwd, 0.15)).toEqual([0, 0, 0]);
    expect(lstick(fwd, 0.25)![0]).toBeGreaterThanOrEqual(0.2);
  });

  it('후진 · 옆걸음은 「시험 기능」 표시', () => {
    open(true);
    ready();
    key('keydown', 'KeyS'); tick(200);
    expect($('[data-demo-exp]')!.textContent).toContain('시험 기능');
    key('keyup', 'KeyS'); tick(200);
    expect($('[data-demo-exp]')).toBeNull();
    key('keydown', 'ArrowLeft'); tick(200);
    expect($('[data-demo-exp]')).not.toBeNull();
    key('keyup', 'ArrowLeft');
  });

  it('실기 값은 그대로(같은 문턱 · 최소값 함수): 손잡이 0.25 는 0 · 0.35 는 표 1.5 · 키는 표 값', () => {
    settingsMock.mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
    mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); ready();
    const { fwd, turn } = sticks();
    expect(lstick(fwd, 0.25)).toEqual([0, 0, 0]);
    expect(lstick(fwd, 0.35)).toEqual([1.5, 0, 0]);
    expect(lstick(fwd, 1)).toEqual([1.5, 0, 0]);
    expect(rstick(turn, 0.5)).toEqual([0, 0, MAX_TURN_RATE]);
    expect(press('KeyW')).toEqual([1.5, 0, 0]);
  });

  it('웹 상한 · 0.2 아래 앞 입력은 0: 손잡이 앞은 0 아니면 0.2 이상', () => {
    open(true);
    ready();
    const { fwd } = sticks();
    for (const f of [0.101, 0.105, 0.11, 0.15]) { const v = lstick(fwd, f)[0]; expect(v === 0 || v >= 0.2).toBe(true); }
    expect(cmds().every((m) => { const v = (m.axes as number[])[0]; return v <= 0 || v >= 0.2; })).toBe(true);
  });

  it('웹 상한 · 후진 -0.3 은 로봇 한계로 잘림 — 조직 설정에는 시뮬 뒤 상한 칸이 없고 실기 real_max_vx_back 은 데모에 쓰지 않음', () => {
    open(true, { ...ORG, real_max_vx_back: 0.1, sim_max_vx: 1.5 });
    ready();
    expect(press('KeyS')).toEqual([-0.3, 0, 0]);
    const { fwd } = sticks();
    expect(lstick(fwd, -1)).toEqual([-0.3, 0, 0]);
    expect(cmds().every((m) => (m.axes as number[])[0] >= -0.3)).toBe(true);
  });

  it('웹 상한 합친 뒤에도 실기는 real_* 로 잡힘: real_max_vx 1 · real_max_wz 1 · real_max_vx_back 0 이면 표 값이 막혀 0', () => {
    settingsMock.mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok({ ...ORG, real_max_vx: 1, real_max_wz: 1, real_max_vx_back: 0 }); } }) as never);
    mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); ready();
    const { fwd, turn } = sticks();
    expect(lstick(fwd, 1)).toEqual([0, 0, 0]);
    expect(rstick(turn, 1)).toEqual([0, 0, 0]);
    expect(press('KeyW')).toEqual([0, 0, 0]);
    expect(press('KeyS')).toEqual([0, 0, 0]);
    expect(press('KeyA')).toEqual([0, 0, 0]);
  });

  it('데모만 있는 조직: 「연결 없음」 으로 보지 않음(+ 로봇 연결하기 가 목록 아래 · 주 단추 아님)', () => {
    settingsMock.mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
    const only = robots(true).filter((r) => r.id === 'r7').map((r) => ({ ...r, online: true }));
    mount(true, 'u-park', '#/drive', only); serve(PARK, 'r7');
    const add = $('[data-robot-connect]')!;
    expect(add.classList.contains('pri')).toBe(false);
    expect(add.compareDocumentPosition($('.dv-cards')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('키를 누르면 화면 손잡이도 같은 자리로 움직임(보이기만) · 떼면 가운데', () => {
    open(true);
    ready();
    const knob = (label: string) => ($(`[aria-label="${label} 조이스틱"] i`) as HTMLElement).style.transform;
    key('keydown', 'KeyW'); tick(100);
    expect(knob('이동')).toBe('translate(0px, -36px)');
    key('keydown', 'KeyA'); tick(100);
    expect(knob('회전')).toBe('translate(-36px, 0px)');
    key('keyup', 'KeyW'); key('keyup', 'KeyA'); tick(100);
    expect(knob('이동')).toBe('translate(0px, 0px)');
    expect(knob('회전')).toBe('translate(0px, 0px)');
  });

  it('상한 표 출처 · 「시험 기능」 은 상수 한 곳(DEMO_RULE)에서 바뀜: 기본 = min(조직, 로봇 한계) · 후진 -0.3 · 표시 / org = 조직 값만 · 후진도 sim_max_vx', () => {
    expect(DEMO_RULE).toEqual({ caps: 'min', mark: true });
    expect(demoCaps(ORG as never)).toMatchObject({ fwd: 1.5, back: 0.3, side: 0.3, turn: 0.5 });
    expect(demoCaps({ ...ORG, sim_max_vx: 1.2 } as never, { caps: 'org', mark: false })).toMatchObject({ fwd: 1.2, back: 1.2, side: 0.5, turn: 1.2 });
  });

  it('곡선은 인자: 같은 문턱 · 최소값에 곡선만 바꿔 끼움(기본 직선)', () => {
    expect(shape(0.55, 0.1, 0.2, 1.5)).toBeCloseTo(0.2 + 0.5 * 1.3, 6);
    expect(shape(0.55, 0.1, 0.2, 1.5, (a) => a * a)).toBeCloseTo(0.2 + 0.25 * 1.3, 6);
    expect(shape(0.05, 0.1, 0.2, 1.5, (a) => a * a)).toBe(0);
  });

  it('데모 STOP 은 서버로(noServerStop 은 데모를 서버 정지 대상으로 봄)', () => {
    open(true);
    ready();
    const n = w.of('stop').length;
    click($('.fh-head .fh-stop')!);
    expect(w.of('stop').length).toBe(n + 1);
  });
});

// 설정 확인 알약(app-lead 11-28 22:26 · 시안 밖 · 새로 그림): 평소 숨김 · 입력이 0 이 되는 순간만 동작 줄 위 가운데 · 10 초 넘게 모르면 위 띠
describe('설정 확인 중 알약', () => {
  const fwdEl = () => {
    const fwd = $('[aria-label="이동 조이스틱"]');
    fwd.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    return fwd;
  };
  const press = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 0 })); });
  const lift = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); });
  const later = () => settingsMock.mockImplementation(() => new Promise(() => {}) as never);
  const pill = () => $('[data-real-wait-pill]');

  it('설정을 모르는 동안 평소엔 위 띠도 알약도 없음 · 누르면 알약(시안 밖 표시) · 떼면 사라짐', () => {
    later(); mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); ready();
    expect($('[data-real-wait]')).toBeNull();
    expect(pill()).toBeNull();
    const fwd = fwdEl(); press(fwd); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect(pill()!.textContent).toBe('설정 확인 중 · 입력 0');
    expect(pill()!.getAttribute('data-off-proto')).toBe('settings-pill');
    expect($('[data-real-wait]')).toBeNull();
    lift(fwd); tick(200);
    expect(pill()).toBeNull();
  });

  it('키 W 로도 알약 · 10 초 넘게 모르면 알약 대신 위 띠(REAL_WAIT)', () => {
    later(); mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); ready();
    key('keydown', 'KeyW'); tick(200);
    expect(pill()).not.toBeNull();
    tick(9500); expect($('[data-real-wait]')).toBeNull();
    tick(600);
    expect($('[data-real-wait]')!.textContent).toBe(REAL_WAIT);
    expect(pill()).toBeNull();
    key('keyup', 'KeyW');
  });

  it('설정을 받으면 알약 없음 · 표 값', () => {
    mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); ready();
    const fwd = fwdEl(); press(fwd); tick(200);
    expect(pill()).toBeNull();
    expect(lastAxes()).toEqual([1.5, 0, 0]);
  });

  it('알약 자리: 동작 줄 위 가운데 · 11.5px 한 줄', () => {
    expect(u1AppCss).toMatch(/\.u1d \.u1-pill\{position:absolute;left:50%;bottom:84px;transform:translateX\(-50%\);[^}]*font-size:11\.5px;[^}]*white-space:nowrap/);
  });
});

// RV-420 막는 것 3건(RB-PHONE-REAL-TABLE-FIX) — 가짜 WS 순서 그대로
describe('RV-420: 실기인지·설정·중립을 모를 때 0', () => {
  const sticks = () => {
    const fwd = $('[aria-label="이동 조이스틱"]');
    fwd.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    return fwd;
  };
  const fwdAt = (el: Element, y: number) => act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 60, clientY: 60 - y * 60 })); });
  const tableOnly = () => cmds().every((m) => (m.axes as number[]).every((v) => v === 0 || Math.abs(v) === 1.5 || Math.abs(v) === MAX_TURN_RATE));

  it('[1] 오프라인 때 받은 목록(server_drive 거짓)인 채 재연결 ONLINE·조종권이 목록 갱신보다 먼저 와도 비례 0.6 을 보내지 않음 → 갱신 뒤 표 값', () => {
    const off = ROBOTS.map((r) => (r.id === 'r7' ? { ...r, sim: false, serverDrive: false, serverDriveBlocked: ['AGENT_OFFLINE' as const] } : r));
    mount(true, 'u-park', '#/drive/r7', off);
    serve(PARK, 'r7');                                      // 실시간: 로봇 ONLINE(목록은 아직 옛 값)
    ready();
    const fwd = sticks();
    fwdAt(fwd, 0.6); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect(cmds().some((m) => (m.axes as number[]).some((v) => v !== 0))).toBe(false);
    expect($('[data-real-wait-pill]')!.textContent).toBe(REAL_WAIT_PILL);
    act(() => root!.render(<App user={USERS.find((u) => u.id === 'u-park')} robots={off.map((r) => (r.id === 'r7' ? { ...r, serverDrive: true, serverDriveBlocked: [] } : r))} />));   // 목록 갱신
    tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 설정을 받아 입력 세대가 바뀜 — 갱신 전에 누른 손가락은 떼고 다시
    act(() => { fwd.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); });
    fwdAt(fwd, 0.6); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    expect(tableOnly()).toBe(true);
  });

  it('[2] 조직 설정(빠른 조종 끔) 응답이 늦으면 받기 전에는 0 — 앞 화면이 남긴 설정 값도 믿지 않음', async () => {
    let answer!: (o: object) => void;
    settingsMock.mockImplementation(() => new Promise((ok) => { answer = ok; }) as never);
    act(() => simTune(ORG));                                 // 앞 화면이 받아 둔 옛 값(빠른 조종 켬)
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    const fwd = sticks();
    fwdAt(fwd, 1); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect($('[data-real-wait-pill]')!.textContent).toBe(REAL_WAIT_PILL);
    await act(async () => { answer({ ...ORG, real_no_fast_server_drive: true }); });
    tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 빠른 조종 끔: 전진은 상한 밖
    expect(cmds().some((m) => (m.axes as number[])[0] !== 0)).toBe(false);
    expect(text()).toContain(REAL_STICK);
  });

  it('[3] 빠른 조종 끔에서 W+A 를 누른 채 잠금 해제 → 상한이 만든 0 은 새 중립이 아님, W 만 떼도 A 회전 안 나감', () => {
    settingsMock.mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok({ ...ORG, real_no_fast_server_drive: true }); } }) as never);
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종'));
    key('keydown', 'KeyW'); key('keydown', 'KeyA'); tick(200);
    unlock(); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'KeyW'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [0, 0, 2.5]
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'KeyA'); tick(100);
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');              // 실제로 손을 뗀 뒤에만 새 중립
    key('keydown', 'KeyA'); tick(100);
    expect(lastAxes()).toEqual([0, 0, MAX_TURN_RATE]);
  });

  it('[4] RV-423: A+D 를 누른 채 잠금 해제 → 서로 상쇄된 0 도 새 중립이 아님, D 만 떼도 회전 안 나감', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종'));
    key('keydown', 'KeyA'); key('keydown', 'KeyD'); tick(200);
    unlock(); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'KeyD'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [0, 0, 2.5]
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'KeyA'); tick(100);
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
  });

  it('[5] RV-424: W+↑ 를 누른 채 잠금 해제 → ↑ 만 떼도 W 가 남아 새 중립이 아님, A 회전 안 나감', () => {
    settingsMock.mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok({ ...ORG, real_no_fast_server_drive: true }); } }) as never);
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    click(btn('조종'));
    key('keydown', 'KeyW'); key('keydown', 'ArrowUp'); tick(200);
    unlock(); tick(200);
    expect(text()).toContain('중립 확인 중');
    key('keyup', 'ArrowUp'); tick(200);
    expect(text()).toContain('중립 확인 중');                // 고치기 전: 움직일 수 있음
    key('keydown', 'KeyA'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [0, 0, 2.5]
    key('keyup', 'KeyA'); key('keyup', 'KeyW'); tick(100);
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
  });

  it('[6] RV-424: 조직 설정이 본문 없는 200·객체 아님이면 받음이 아님 — 0 + 안내', async () => {
    for (const bad of [undefined, null, 'ok', [], 1]) {
      settingsMock.mockImplementation(() => Promise.resolve(bad) as never);
      mount(true, 'u-park', '#/drive/r7');
      serve(PARK, 'r7');
      ready();
      await act(async () => {});
      key('keydown', 'ArrowUp'); tick(200);
      expect(lastAxes()).toEqual([0, 0, 0]);                // 고치기 전: [1.5, 0, 0]
      expect($('[data-real-wait-pill]')!.textContent).toBe(REAL_WAIT_PILL);   // 22:26 부터 위 띠 대신 알약(10 초 넘으면 위 띠)
      key('keyup', 'ArrowUp');
      act(() => root!.unmount()); root = null; box.remove();
    }
  });
});

// RV-425(RB-DRIVE-FRESH-PRESS): «잠금 해제 뒤 새로 누른 입력만» — 입력 세대. 가짜 WS 순서 그대로, 고치기 전 값은 주석
describe('RV-425: 앞 세대에 누른 키·손가락은 떼고 다시 눌러야', () => {
  const stick = () => {
    const el = $('[aria-label="이동 조이스틱"]');
    el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    return el;
  };
  /** pointerId 를 단 MouseEvent(jsdom). y = 스틱 값(위 +) */
  const pe = (type: string, el: Element, y: number, id = 1) => act(() => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 60, clientY: 60 - y * 60 });
    Object.defineProperty(e, 'pointerId', { value: id });
    el.dispatchEvent(e);
  });
  /** 서버가 잠금(stop_gen +1)을 보내고 → 잠금 해제 */
  const relock = () => { act(() => push('r7', { latched: true, stop_gen: st.r7.stop_gen! + 1 })); tick(100); unlock(); tick(100); };
  const go = (settings: object = ORG) => {
    settingsMock.mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(settings); } }) as never);
    mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); ready();
  };

  it('[1] W 유지 중 시트·⋯ 뒤 Ctrl+↑ 로 시작 → A 회전 안 나감', () => {   // blur 는 RV-426 ⑦(적은 키를 지움) — 아래 시험
    go();
    key('keydown', 'KeyW'); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    click(btn('지도·목표')); click(btn('닫기'));
    key('keydown', 'ArrowUp', window, true); key('keydown', 'KeyA'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [0, 0, 2.5]
    key('keyup', 'KeyW'); key('keyup', 'ArrowUp'); key('keyup', 'KeyA'); tick(100);
    key('keydown', 'ArrowUp', window, true); tick(100);    // 새로 누른 Ctrl+↑ 도 같은 누름
    expect(lastAxes()).toEqual([1.5, 0, 0]);
  });

  it('[2] 스틱 중앙에 손가락을 둔 채 잠금·해제 → 같은 손가락 이동은 0 / 잠긴 동안 비중앙을 누른 채 해제 → 중립 아님', () => {
    go();
    const el = stick();
    pe('pointerdown', el, 0); tick(100);
    relock();
    pe('pointermove', el, 0.9); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
    pe('pointerup', el, 0.9); tick(100);
    act(() => push('r7', { latched: true, stop_gen: st.r7.stop_gen! + 1 })); tick(100);
    pe('pointerdown', el, 0.9, 2);                          // 잠긴 동안 비중앙
    unlock(); tick(200);
    expect(text()).toContain('중립 확인 중');                // 고치기 전: 움직일 수 있음
    pe('pointermove', el, 0.9, 2); tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);
    pe('pointerup', el, 0.9, 2); tick(100);
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
    pe('pointerdown', el, 0.9, 3); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);               // 새로 누르면 표 값
  });

  it('[3] 같은 스틱에 두 손가락 → 하나만 떼도 남은 손가락이 앞 세대면 0', () => {
    go();
    const el = stick();
    pe('pointerdown', el, 0, 1); pe('pointerdown', el, 0, 2);
    pe('pointerup', el, 0, 2); tick(100);
    relock();
    key('keydown', 'KeyA'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [0, 0, 2.5]
    expect(text()).toContain('중립 확인 중');
    pe('pointerup', el, 0, 1); key('keyup', 'KeyA'); tick(100);
    key('keydown', 'KeyA'); tick(100);
    expect(lastAxes()).toEqual([0, 0, MAX_TURN_RATE]);
  });

  it('[6] W 유지 중 잠김 보고 없이 stop_gen 만 오른 해제 상태 → 0', () => {
    go();
    key('keydown', 'KeyW'); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    act(() => push('r7', { latched: false, stop_gen: st.r7.stop_gen! + 1 })); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
    expect(rt.get('r7').neutral).toBe(false);
    key('keyup', 'KeyW'); tick(100); key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
  });

  it('[7] 명령 틱 350 ms 공백 뒤 A+D 상쇄 → D 만 떼도 새로 누르기 전 0', () => {
    go();
    key('keydown', 'KeyA'); key('keydown', 'KeyD'); tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);
    const real = performance.now.bind(performance);
    const gap = vi.spyOn(performance, 'now').mockImplementation(() => real() + 350);   // 틱이 350 ms 멈춘 것과 같음(에이전트 Core 는 0.3 s 끊김 → 새 중립 요구)
    tick(100);
    key('keyup', 'KeyD'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [0, 0, 2.5]
    key('keyup', 'KeyA'); tick(100); key('keydown', 'KeyA'); tick(100);
    expect(lastAxes()).toEqual([0, 0, MAX_TURN_RATE]);
    gap.mockRestore();
  });

  it('[10] RV-430 ① W 전진 중 마지막 cmd 190 ms 뒤 A(송신 없음) → 380 ms 뒤 첫 cmd 도 공백 → 0. 공백 없으면 W+A 그대로', () => {
    go();
    key('keydown', 'KeyW'); tick(100); key('keydown', 'KeyA'); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, MAX_TURN_RATE]);   // 정상: 틱이 이어지면 새로 누른 A 도 합산
    key('keyup', 'KeyA'); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    const real = performance.now.bind(performance); let skip = 0;
    const gap = vi.spyOn(performance, 'now').mockImplementation(() => real() + skip);   // 틱 타이머가 멈춘 것과 같음
    skip = 190; key('keydown', 'KeyA');                    // 누름만 — 송신 없음, 공백 기준도 그대로
    skip = 330; tick(50);                                  // 마지막 cmd 뒤 380 ms 에 첫 cmd
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 2.5]
    key('keyup', 'KeyW'); key('keyup', 'KeyA'); tick(100); key('keydown', 'KeyA'); tick(100);
    expect(lastAxes()).toEqual([0, 0, MAX_TURN_RATE]);
    gap.mockRestore();
  });

  it('[8] 조직 설정 타입이 틀리면(real_max_vx: "0") 받음 아님 → 0 + 안내', () => {
    go({ ...ORG, real_max_vx: '0' });
    key('keydown', 'ArrowUp'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
    expect($('[data-real-wait-pill]')!.textContent).toBe(REAL_WAIT_PILL);
  });

  it('[9] 빠른 조종 금지 확인 뒤 공용 설정이 simTune(null) 로 비면 받음도 풀림 → 0', () => {
    go({ ...ORG, real_no_fast_server_drive: true });
    key('keydown', 'KeyW'); tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    key('keyup', 'KeyW');
    act(() => simTune(null)); tick(100);
    key('keydown', 'KeyW'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
    expect($('[data-real-wait-pill]')!.textContent).toBe(REAL_WAIT_PILL);
  });
});

// RV-426(RB-DRIVE-FRESH-PRESS2): 폰 — 가짜 WS 순서 그대로, 고치기 전 값은 주석
describe('RV-426: 폰 입력 세대 마무리', () => {
  const stick = (label = '이동') => {
    const el = $(`[aria-label="${label} 조이스틱"]`);
    el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 120 }) as DOMRect;
    return el;
  };
  const pe = (type: string, el: Element, y: number, id = 1) => act(() => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 60, clientY: 60 - y * 60 });
    Object.defineProperty(e, 'pointerId', { value: id });
    el.dispatchEvent(e);
  });
  const go = () => {
    settingsMock.mockImplementation(() => ({ then: (ok: (o: object) => void) => { ok(ORG); } }) as never);
    mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); ready();
  };

  it('② STOP 뒤 잠김·해제 보고가 오기 전에는 새로 누른 키도 0 → 보고·해제 뒤 새로 누르면 표 값', () => {
    go();
    const auto = w.auto!; w.auto = (m) => (m.t === 'stop' ? w.recv({ t: 'reply', id: m.id, ok: true }) : auto(m));   // 접수만, 상태 보고 늦음
    key('keydown', 'KeyW'); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    click($('[data-stop]'));
    key('keyup', 'KeyW'); key('keydown', 'KeyW'); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
    act(() => push('r7', { latched: true, stop_gen: st.r7.stop_gen! + 1 })); tick(100);
    expect(lastAxes()).toEqual([0, 0, 0]);
    unlock(); tick(100);
    key('keyup', 'KeyW'); key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
  });

  it('⑤ 스틱을 민 채 조종권을 잃고 다시 받음 → 부모 축 값도 0, 손가락 없이 대기·이동 없음 → 새 키는 표 값', () => {
    go();
    const el = stick();
    pe('pointerdown', el, 0.9); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    recv(lease('r7', null)); tick(100);                    // 조종권 잃음(스틱이 사라짐, 손가락은 그대로)
    click(btn('조종')); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');              // 고치기 전: 중립 확인 중(부모 축 0.9 가 남아 계속 대기)
    key('keydown', 'KeyW'); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);               // 고치기 전: [0, 0, 0]
  });

  it('⑦ W 를 누른 채 창 밖에서 뗌(keyup 못 받음) → 복귀 뒤 새로 누른 A 는 표 값', () => {
    go();
    key('keydown', 'KeyW'); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    act(() => { window.dispatchEvent(new Event('blur')); });
    tick(100); expect(lastAxes()).toEqual([0, 0, 0]);
    key('keydown', 'KeyA'); tick(100);
    expect(lastAxes()).toEqual([0, 0, MAX_TURN_RATE]);     // 고치기 전: [0, 0, 0](W 가 앞 세대로 남아 계속 0)
  });

  it('⑧ 해제 직후 첫 중립 틱 전에 새로 누른 W → 바로 표 값(계속 대기 아님)', () => {
    go();
    act(() => push('r7', { latched: true, stop_gen: st.r7.stop_gen! + 1 })); tick(100);
    unlock();                                 // 서버가 바로 latched=false — 틱 전에
    key('keydown', 'KeyW'); tick(200);
    expect(lastAxes()).toEqual([1.5, 0, 0]);               // 고치기 전: [0, 0, 0](중립 확인 중 그대로)
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
  });

  it('⑨ 키 뗌·스틱 놓음·blur 는 다음 틱이 아니라 그 자리에서 0 을 한 번 보냄', () => {
    go();
    key('keydown', 'KeyW'); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    key('keyup', 'KeyW');
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0](다음 틱까지)
    const el = stick();
    pe('pointerdown', el, 0.9); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    pe('pointerup', el, 0.9);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
    pe('pointerdown', el, 0.9, 2); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
  });

  it('⑩ 같은 스틱 두 손가락: 처음 잡은 손가락만 — 그 손가락을 떼면 남은 손가락으로는 다시 전진하지 않음', () => {
    go();
    const el = stick();
    pe('pointerdown', el, 0.9, 1); pe('pointerdown', el, 0.9, 2); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);
    pe('pointermove', el, 0, 2); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);               // 둘째 손가락 이동은 무시
    pe('pointerup', el, 0.9, 1); pe('pointermove', el, 0.9, 2); tick(200);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
    pe('pointerup', el, 0.9, 2); pe('pointerdown', el, 0.9, 3); tick(100);
    expect(lastAxes()).toEqual([1.5, 0, 0]);               // 새로 잡으면 표 값
  });

  it('정상: 해제 뒤 새로 누르면 표 값 바로, 놓으면 바로 0, STOP 은 바로 나감', () => {
    go();
    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toEqual([1.5, 0, 0]);
    key('keyup', 'KeyW'); expect(lastAxes()).toEqual([0, 0, 0]);
    key('keydown', 'KeyW'); tick(60);
    const n = w.sent.length;
    click($('[data-stop]'));
    expect(w.sent.slice(n).some((m) => m.t === 'stop')).toBe(true);
    tick(200); expect(lastAxes()).toEqual([0, 0, 0]);
    key('keyup', 'KeyW');
  });

  // RV-429 ③: 맥은 Cmd 누른 동안 다른 키의 keyup 을 주지 않는다
  const mk = (type: 'keydown' | 'keyup', code: string, o: KeyboardEventInit = {}) => act(() => { window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...o })); });
  it('RV-429 ③ Cmd+W 뒤 Cmd 뗌(W keyup 없음) → 0, W 를 누른 채 Cmd → 0 — 새로 누르면 표 값', () => {
    go();
    mk('keydown', 'MetaLeft', { key: 'Meta', metaKey: true });
    mk('keydown', 'KeyW', { metaKey: true }); tick(60);
    mk('keyup', 'MetaLeft', { key: 'Meta' }); tick(200);   // W keyup 은 오지 않음(맥)
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toEqual([1.5, 0, 0]);
    mk('keydown', 'MetaLeft', { key: 'Meta', metaKey: true }); tick(60);
    expect(lastAxes()).toEqual([0, 0, 0]);                  // 고치기 전: [1.5, 0, 0]
    mk('keyup', 'MetaLeft', { key: 'Meta' }); tick(200); expect(lastAxes()).toEqual([0, 0, 0]);
    key('keydown', 'KeyW'); tick(60); expect(lastAxes()).toEqual([1.5, 0, 0]);
    key('keyup', 'KeyW'); expect(lastAxes()).toEqual([0, 0, 0]);
  });
});

// 시안 u1: 폰 실기 조종 화면은 머리줄 없이 정지가 화면 오른쪽 아래(.stop · 92 × 68). 같은 Stop 부품(같은 onStop · 누름 처리 · Space · 결과 띠)을 자리만 옮긴다.
// 어느 상태(조종권 요청 창 · 스캔 겹 · 시나리오 시작 확인 · 끊김 · 반납 중)에서도 보이고 · 맨 위(z)이고 · 눌린다. jsdom 은 배치를 계산하지 않아 구조 · css 규칙을 보고, 실제 자리는 Chrome 사진
describe('폰 실기 조종 화면 정지 자리 (시안 u1)', () => {
  const stopBtn = () => $<HTMLButtonElement>('[data-stop]');
  const head = () => $('header.fh-head');
  /** 화면 안 정지: 머리줄 겹(data-u1) 안 마지막 · 조종 판(.dv-stage) · 시트 · 창 밖 · 누를 수 있음 · 글 「정지」 */
  const inScreen = () => {
    expect(head().hasAttribute('data-u1')).toBe(true);
    expect(stopBtn().parentElement).toBe(head());
    expect(head().lastElementChild).toBe(stopBtn());
    expect(stopBtn().closest('.dv-stage, [data-sheet], [role="dialog"]')).toBeNull();
    expect(stopBtn().disabled).toBe(false);
    expect(stopBtn().dataset.place).toBe('screen');
    expect(stopBtn().textContent).toBe('정지');
    expect(stopBtn().getAttribute('aria-label')).toBe('비상 정지');
  };
  const press = (robot: string) => { const n = w.of('stop').length; click(stopBtn()); expect(w.of('stop').slice(n).map((m) => m.robot)).toEqual([robot]); };

  it('css: 머리줄 겹은 화면 전체 · 손가락은 제 칸만 · z 는 조종 판 안 모든 층(작은 지도 펼침 60 · 창 · 스캔 겹)보다 위, 정지는 오른쪽 아래 92 × 68', () => {
    const headRule = /\.fh\.phone \.fh-head\[data-u1\]\{[^}]*\}/;
    const z = Number(u1AppCss.match(headRule)![0].match(/z-index:(\d+)/)![1]);
    expect(z).toBeGreaterThanOrEqual(80);
    // 조종 판 안에 깔리는 모든 겹(조종 판 · 시안 u1 겹 · 정지 결과 띠 · 고르기 79 · 조종권 요청 창 u13_5 · 스캔 겹 u14_2 · 작은 지도 펼침 60)의 z 보다 위
    const zs = [driveCss, u1AppCss.replace(headRule, ''), u1dCss, u135Css, u135AppCss, u142Css, u142AppCss].flatMap((c) => [...c.matchAll(/z-index:(\d+)/g)].map((m) => Number(m[1])));
    expect(zs.length).toBeGreaterThan(10);
    expect(zs).toContain(79);
    expect(z).toBeGreaterThan(Math.max(...zs));
    expect(u1AppCss).toMatch(/\.fh\.phone \.fh-head\[data-u1\]\{[^}]*position:absolute;inset:0;[^}]*pointer-events:none/);
    // 화면 전체를 덮는 머리줄이 shell.css 폰 머리줄의 backdrop-filter(blur 20px)를 받으면 조종 판 전체가 흐려진다(미리보기 5195 사진)
    expect(u1AppCss).toMatch(/\.fh\.phone \.fh-head\[data-u1\]\{[^}]*backdrop-filter:none;-webkit-backdrop-filter:none/);
    expect(u1AppCss).toMatch(/\.u1d \.pane \.u1-sheets\{position:static;transform:none;/);   // 칩 펼침 시트 줄이 drive.css .dv-sheets 절대 위치로 「걷기」 줄을 덮지 않게(사진)
    // 정지 칸: 오른쪽 아래 92 × 68 · 오른쪽 위 줄처럼 safe-area 만큼 안쪽(가로 노치 · 홈 막대)
    expect(u1AppCss).toMatch(/\.fh-head\[data-u1\] \.fh-stop\{[^}]*pointer-events:auto;[^}]*right:calc\(12px \+ env\(safe-area-inset-right,0px\)\);bottom:calc\(12px \+ env\(safe-area-inset-bottom,0px\)\);width:92px;height:68px/);
    expect(u1AppCss).toMatch(/\.fh-head\[data-u1\] \.u1-top\{[^}]*right:calc\(12px \+ env\(safe-area-inset-right,0px\)\)/);
  });

  it('조종 전 · 조종 중 · 시트 · 시나리오 시작 확인 · 조종권 요청 창: 정지는 화면 안 그 자리 · 누르면 이 로봇 정지', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    inScreen();
    ready();
    inScreen();
    click(btn('지도·목표')); inScreen(); click(btn('지도·목표'));
    recv(ask());
    expect($('[data-takeover]')).toBeTruthy();
    inScreen();
    press('r7');
  });

  it('시나리오가 쥔 로봇 «조종 시작» 확인 창 위에서도', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    recv(lease('r7', { id: null, name: '', type: 'RUN' }));
    click(btn('조종'));
    expect($('.dv-ask[role="dialog"]')).toBeTruthy();
    inScreen();
    press('r7');
  });

  it('⋯ 지도 스캔 겹 위에서도', () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    click(btn('지도 스캔'));
    expect($('.dv-stage [data-scan-panel].u142-over')).toBeTruthy();
    inScreen();
    press('r7');
  });

  it('시안 u1_7: 정지 뒤 잠금 보고 전이면 가운데 띠 「명령이 닿지 않았습니다 · N 초 지남」 + 정지 「다시 누르기」, 잠기면 둘 다 돌아감', () => {
    mount(true, 'u-park', '#/drive/r7');
    serve(PARK, 'r7');
    ready();
    w.auto = () => ({ ok: true });
    click(stopBtn());
    tick(100);
    act(() => push('r7', { speed: 0.6 }));   // 정지 뒤 첫 state 가 아직 안 잠김
    expect(band()).toContain('▲ 명령이 닿지 않았습니다 · 0 초 지남');
    expect(band()).not.toContain('정지 요청됨');
    expect(stopBtn().textContent).toBe('정지다시 누르기');
    expect(stopBtn().dataset.again).toBe('');
    tick(2000);
    expect(band()).toContain('▲ 명령이 닿지 않았습니다 · 2 초 지남');
    act(() => push('r7', { latched: true, stop_gen: 2, applied: [0, 0, 0], speed: 0 }));
    expect(band()).not.toContain('명령이 닿지 않았습니다');
    expect(stopBtn().textContent).toBe('정지');
    expect(stopBtn().dataset.again).toBeUndefined();
  });

  it('PC 는 u1_7 글로 바꾸지 않음: «정지 요청됨 — 로봇이 아직 잠금을 알리지 않았습니다.» · 정지 단추 글 그대로', () => {
    mount(false, 'u-lee', '#/fleet');
    serve(LEE, 'r3', 'r1');
    click(row('Go2-7'));
    w.auto = () => ({ ok: true });
    click($('[data-stop]'));
    tick(100);
    act(() => push('r7', { speed: 0.6, latched: false }));
    expect(band()).toContain('Go2-7 정지 요청됨 — 로봇이 아직 잠금을 알리지 않았습니다.');
    expect(band()).not.toContain('명령이 닿지 않았습니다');
    expect($('[data-stop]').hasAttribute('data-again')).toBe(false);
  });

  it('css: 정지 결과 띠는 상태 칩(왼쪽 위 ~272)과 오른쪽 위 줄을 덮지 않게 가운데 · 글 폭만큼 (시안 u1_7 · 사진에서 칩을 가림)', () => {
    expect(u1AppCss).toMatch(/\.fh\.phone:has\(\.fh-head\[data-u1\]\) \.fh-band\{left:50%;right:auto;transform:translateX\(-50%\);width:max-content;max-width:calc\(100% - 560px\)/);
  });

  it('서버 끊김 · 조종권 반납 중에도 그 자리(누름은 기존 길 그대로)', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    ready();
    w.auto = (m) => (m.t === 'lease.release' ? undefined : { ok: true });
    click(btn('끝내기'));
    expect($('[data-ending]')).toBeTruthy();
    inScreen();
    act(() => w.drop(1006));
    inScreen();
  });

  it('반납 중 누름 = 실시간 stop(이 로봇) · 끊김(1006) 뒤 누름 = 대체 경로 HTTP POST(이 로봇), 실시간 stop 은 안 나감 (지금 동작 고정)', async () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    ready();
    w.auto = (m) => (m.t === 'lease.release' ? undefined : { ok: true });
    click(btn('끝내기'));
    expect($('[data-ending]')).toBeTruthy();
    inScreen();
    press('r7');
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', f);
    act(() => w.drop(1006));
    inScreen();
    const n = w.of('stop').length;
    click(stopBtn());
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(w.of('stop').length).toBe(n);
    expect(f).toHaveBeenCalledWith('/api/v1/robots/r7/stop', expect.objectContaining({ method: 'POST' }));
    expect(f.mock.calls.filter(([u]) => /\/stop$/.test(String(u)))).toHaveLength(1);
  });

  it('조종 판 「조종 끝내기」 는 반납 확인 중 눌리지 않음(⋯ 끝내기와 같은 규칙) · 정지는 그대로', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    ready();
    w.auto = (m) => (m.t === 'lease.release' ? undefined : { ok: true });
    expect(btn('조종 끝내기').disabled).toBe(false);
    click(btn('조종 끝내기'));
    expect(w.of('lease.release')).toHaveLength(1);
    expect($('[data-ending]')).toBeTruthy();
    // 반납을 보내면 이 화면 조종권은 놓은 것으로 그린다: 조종 판 「조종 끝내기」 는 없고(있어도 disabled), 「조종 시작」 은 반납 확인 전엔 막힘
    const end = btn('조종 끝내기');
    if (end) expect(end.disabled).toBe(true);
    expect(btn('조종').disabled).toBe(true);
    expect($(`#why-r7`).textContent).toBe('반납 확인 중');
    click(btn('조종'));
    expect(w.of('lease.release')).toHaveLength(1);
    expect(btn('끝내기').disabled).toBe(true);
    inScreen();
    press('r7');
  });

  it('조종 화면 밖(로봇 연결 · 기록)은 머리줄 STOP 그대로', () => {
    mount(true, 'u-kim', '#/drive');
    serve(KIM, 'r3', 'r7', 'r1');
    expect(head().hasAttribute('data-u1')).toBe(false);
    expect(stopBtn().textContent).toBe('STOP');
  });
});

// 19:57 결정: 시안 u1 동작 7 · 「다시 시작」 확인 창 = PC 로봇 탭(robotu4)과 같은 규칙 · 같은 서버 길(rt.action · rt.unlock)
describe('폰 실기 조종 동작 일곱 · 다시 시작 (시안 u1 · PC 로봇 탭과 같은 규칙)', () => {
  const acts = () => [...box.querySelectorAll<HTMLButtonElement>('.u1d .act button')];
  const actBtn = (t: string) => acts().find((b) => b.dataset.act === t)!;
  const says = () => $('.u1d [data-act-msg]')?.textContent ?? '';

  it('아래 줄 = 시안 순서 일곱(앉기 … 인사) · 「순정 확인 전」 은 흐리게(na) 표지 · 시트 단추 줄은 칩 펼침 안', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    expect(acts().map((b) => b.textContent)).toEqual(ACTS.map(([n, t]) => t + (actWhy(n, false) ? '순정 확인 전' : '')));
    expect(acts().map((b) => b.dataset.act)).toEqual(ACTS.map(([n]) => n));
    expect(actBtn('Greet').classList.contains('na')).toBe(true);
    expect(actBtn('Sit').classList.contains('na')).toBe(false);
  });

  it('조종권 없으면 보내지 않고 까닭 · 조종 중이면 rt.action 한 번(confirmed false) · 입력 0 · 결과는 로봇 보고로', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    click(actBtn('Sit'));
    expect(w.of('action')).toHaveLength(0);
    expect(says()).toBe('조종 시작 후 사용할 수 있습니다.');
    ready();
    key('keydown', 'KeyW'); tick(100); expect(lastAxes()).toEqual([1.5, 0, 0]);
    click(actBtn('Sit'));
    expect(w.of('action')).toMatchObject([{ robot: 'r7', action: 'Sit', params: {}, confirmed: false }]);
    tick(100); expect(lastAxes()).toEqual([0, 0, 0]);                    // 누르던 키는 떼고 다시 눌러야
    expect(says()).toBe('서버 접수 · 로봇의 결과를 기다리고 있습니다.');
    key('keyup', 'KeyW');
  });

  it('「순정 확인 전」(Greet) · 저수준 중 일어서기는 보내지 않고 PC 와 같은 까닭', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    ready();
    click(actBtn('Greet'));
    expect(w.of('action')).toHaveLength(0);
    expect(says()).toBe(actWhy('Greet', false));
    act(() => push('r7', { control: 'LOWLEVEL' } as Partial<ScreenState>));
    expect(actBtn('StandUp').classList.contains('na')).toBe(true);
    click(actBtn('StandUp'));
    expect(w.of('action')).toHaveLength(0);
    expect(says()).toBe(STANDUP_WHY);
    click(actBtn('Greet'));                                              // 저수준 표에는 있음
    expect(w.of('action')).toMatchObject([{ action: 'Greet' }]);
  });

  it('로봇 연결이 끊기면 보내지 않음', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    ready();
    act(() => push('r7', { connection: 'OFFLINE' } as Partial<ScreenState>));
    click(actBtn('Sit'));
    expect(w.of('action')).toHaveLength(0);
    expect(says()).toBe('로봇과 서버 연결을 확인하세요.');
  });

  it('「다시 시작」 은 확인 창을 거쳐야 잠금 해제 · 취소면 아무것도 안 보냄 · 정지는 창 위에서도 그 자리', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    click(btn('조종'));
    click(btn('다시 시작'));
    expect(w.of('unlock')).toHaveLength(0);
    const ask = $('.u1d [data-restart-ask]');
    expect(ask.getAttribute('role')).toBe('dialog');
    expect(ask.textContent).toContain('Go2-7 을 일으킬까요?');
    expect(ask.textContent).toContain('주변에 사람이 없는지 보세요');
    expect($('[data-stop]').closest('.u1d')).toBeNull();
    click(btn('취소'));
    expect($('.u1d [data-restart-ask]')).toBeNull();
    expect(w.of('unlock')).toHaveLength(0);
    click(btn('다시 시작'));
    click($('[data-restart-ask] button.dpri'));
    expect(w.of('unlock')).toHaveLength(1);
    expect($('.u1d [data-restart-ask]')).toBeNull();
    expect(btn('다시 시작')).toBeUndefined();                            // 풀린 뒤 단추 없음
  });

  // reviewer H1 (REVIEW-web-u4-simdrive-restart): 창 열림 상태는 연 때의 stop_gen 에 묶인다. 잠금 풀림 · stop_gen 바뀜 · 조종권 잃음이면 열림 자체를 닫음
  it('[H1] 창을 연 뒤 다른 곳에서 풀림 → 새 STOP(stop_gen 2→3): 누르지 않았는데 창이 다시 뜨지 않고 unlock 0', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    click(btn('조종'));
    act(() => push('r7', { latched: true, stop_gen: 2 }));
    click(btn('다시 시작'));
    expect($('.u1d [data-restart-ask]')).not.toBeNull();
    act(() => push('r7', { latched: false }));                          // 다른 곳(PC · 다른 창)에서 풀림
    expect($('.u1d [data-restart-ask]')).toBeNull();
    act(() => push('r7', { latched: true, stop_gen: 3 }));              // 새 STOP
    expect($('.u1d [data-restart-ask]')).toBeNull();
    expect(w.of('unlock')).toHaveLength(0);
  });

  it('[H1] 창이 열린 채 잠금이 그대로여도 stop_gen 이 바뀌면 창을 닫음 · 조종권을 잃었다 다시 받아도 창은 닫힌 채', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    click(btn('조종'));
    click(btn('다시 시작'));
    act(() => push('r7', { latched: true, stop_gen: 5 }));
    expect($('.u1d [data-restart-ask]')).toBeNull();
    expect(w.of('unlock')).toHaveLength(0);
    click(btn('다시 시작'));
    recv(lease('r7', null));                                            // 조종권 잃음
    recv(lease('r7', KIM, 'L9'));                                       // 다시 받음
    expect($('.u1d [data-restart-ask]')).toBeNull();
    expect(w.of('unlock')).toHaveLength(0);
    click(btn('다시 시작'));
    click($('[data-restart-ask] button.dpri'));
    expect(w.of('unlock')).toMatchObject([{ robot: 'r7', stop_gen: 5 }]);   // 연 때와 같은 세대일 때만 한 번
  });

  it('[H1 · L1] 같은 계정이 다른 기기에서 조종권을 가져가 lease id 만 바뀜(L→L10, 빈 조종권을 거치지 않음): 창이 닫히고 unlock 0', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r7');
    click(btn('조종'));
    click(btn('다시 시작'));
    expect($('.u1d [data-restart-ask]')).not.toBeNull();
    recv(lease('r7', KIM, 'L10'));
    expect($('.u1d [data-restart-ask]')).toBeNull();
    expect(w.of('unlock')).toHaveLength(0);
  });
});

describe('시안 u1_2 조종 중 글 · 꼴 (21:48 결정 2)', () => {
  it('상태 칩은 「조종 중」, 걷기 칸 둘째 줄은 지금 걷기 모드 설명(START = 험지 기본 · 모르면 「걷기 모드」)', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    ready();
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
    expect($('.u1-mode')!.textContent).toBe('모름걷기 모드');
    act(() => push('r7', { gait: { gait: 'start', available: ['classic', 'start'] } }));
    expect($('.u1-mode')!.textContent).toBe('START험지 기본');
    act(() => push('r7', { gait: { gait: 'classic', available: ['classic', 'start'] } }));
    expect($('.u1-mode')!.textContent).toBe('Classic평지 기본');
  });

  it('지금 하는 동작(로봇 보고 action_result RUNNING)만 초록 테(.run) · 끝나면 지움', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    ready();
    const run = () => [...box.querySelectorAll('.act button.run')].map((b) => (b as HTMLElement).dataset.act);
    expect(run()).toEqual([]);
    const res = (status: 'RUNNING' | 'SUCCEEDED') => ({ action_result: { request_id: 'q1', action: 'Stretch' as const, status, code: 'OK', sdk_code: null, mode: null, enabled: null } });
    act(() => push('r7', res('RUNNING')));
    expect(run()).toEqual(['Stretch']);
    act(() => push('r7', res('SUCCEEDED')));
    expect(run()).toEqual([]);
  });

  it('css: 정지 글은 시안 .stop 14px · 작은 글 9.5px, 동작 줄 까닭 글(em)은 줄 높이에 안 들어가게(시안보다 12px 올라가던 것)', () => {
    expect(u1AppCss).toMatch(/\.fh-head\[data-u1\] \.fh-stop-t>span\{font-size:14px;letter-spacing:normal\}/);
    expect(u1AppCss).toMatch(/\.fh-head\[data-u1\] \.fh-stop\[data-again\] small\{[^}]*font-size:9\.5px/);
    expect(u1AppCss).toMatch(/\.u1d \.act button\{[^}]*position:relative/);
    expect(u1AppCss).toMatch(/\.u1d \.act em\{position:absolute;top:100%/);
  });
});

describe('시안 u1_3 정지됨 (21:48 결정 3 · Damping 은 따로)', () => {
  it('로봇이 잠금을 알리면 상태 칩 「정지됨」 · 조이스틱 · 동작 줄 숨김 · 키 · 손가락 · 동작으로 0 아닌 명령이 나가지 않음', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    ready();
    expect($('[data-u1d]')!.hasAttribute('data-stop-held')).toBe(false);
    act(() => push('r7', { latched: true, stop_gen: 2 }));
    expect($('.u1-chip .u1-st')!.textContent).toBe('정지됨');
    // 숨김은 css(visibility) · 부품은 붙어 있음(누른 손가락 세대 판정 RV-425 그대로)
    expect($('[data-u1d]')!.hasAttribute('data-stop-held')).toBe(true);
    expect(u1AppCss).toMatch(/\.u1d\[data-stop-held\] :is\(\.stick,\.act\)\{visibility:hidden\}/);
    const moves = () => w.of('cmd').filter((m) => (m.axes as number[]).some((v) => v !== 0)).length;
    const n = moves(), acts = w.of('action').length;
    key('keydown', 'KeyW'); tick(300); key('keyup', 'KeyW'); tick(100);
    expect(moves()).toBe(n);
    expect(w.of('action').length).toBe(acts);
  });

  it('잠금을 모르면(latched null) 「정지됨」 이라 쓰지 않음(확인 안 된 정지됨 금지) · 「정지 잠금」', () => {
    mount(true, 'u-kim', '#/drive/r7');
    serve(KIM, 'r3', 'r7', 'r1');
    ready();
    act(() => push('r7', { latched: null }));
    expect($('.u1-chip .u1-st')!.textContent).toBe('정지 잠금');
  });
});

describe('시안 u1_2 오른쪽 위: 알림 종 · Wi-Fi · 구름 · 설정 줄 (PC 머리줄과 같은 출처)', () => {
  it('종은 PC 와 같은 알림 부품(안 읽은 수 · GET /notifications) · 시안 자리 오른쪽 118 · 줄은 로봇 연결 · 서버 연결 · 설정(⋯ 메뉴)', async () => {
    vi.spyOn(api, 'notifications').mockImplementation(() => Promise.resolve({ items: [], unread_count: 2, next_cursor: null }) as never);
    mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); ready();
    await act(async () => {});
    const bell = $('.fh-head[data-u1] .u1-bell');
    expect(bell.querySelector('[data-bell] summary')!.getAttribute('aria-label')).toBe('알림 안 읽음 2건');
    expect(bell.querySelector('.badge')!.textContent).toBe('2');
    expect(u1AppCss).toMatch(/\.fh-head\[data-u1\] \.u1-bell\{[^}]*right:calc\(118px \+ env\(safe-area-inset-right,0px\)\)/);
    const top = $('.u1-top');
    expect(top.querySelector('[data-u1-robot-link]')!.getAttribute('title')).toBe('로봇 연결');
    expect(top.querySelector('[data-u1-cloud]')).not.toBeNull();
    expect(top.querySelector('.fh-dot .fh-dot-t')!.textContent).toBe('연결');
    const more = top.querySelector('.fh-more summary')!;
    expect(more.getAttribute('aria-label')).toBe('설정 · 더 보기');
    expect(more.textContent).not.toContain('⋯');
  });
  it('로봇이 끊기면 Wi-Fi 칸이 빗금 · 글 「로봇 연결 끊김」', async () => {
    mount(true, 'u-park', '#/drive/r7'); serve(PARK, 'r7'); ready();
    act(() => push('r7', { connection: 'OFFLINE' }));
    expect($('.u1-top [data-u1-robot-link]')!.getAttribute('title')).toBe('로봇 연결 끊김');
    expect($('.u1-top [data-u1-robot-link]')!.className).toContain('bad');
  });
});

describe('시안 u1_8 서버 끊김 (21:48 결정 4)', () => {
  const down = () => { mount(true, 'u-kim', '#/drive/r7'); serve(KIM, 'r3', 'r7', 'r1'); ready(); act(() => w.drop(1006)); tick(100); };
  it('상태 칩 「리모컨만」 · 띠는 「서버 연결 안 됨 · 다시 연결」 하나 · 연결 점 자리 구름 빗금 · App 띠 연결 줄 없음 · 정지는 그대로 빨강', () => {
    down();
    expect($('.u1-chip .u1-st')!.textContent).toBe('리모컨만');
    const bans = [...box.querySelectorAll('.u1-says .ban')];
    expect(bans.map((b) => b.textContent)).toEqual(['서버 연결 안 됨 다시 연결']);   // 시안 「서버 연결 안 됨 [점검]」 꼴
    expect($('.u1-says')!.textContent).not.toMatch(/조종권자 확인 안 됨|로봇 상태를 확인하는 중/);
    expect($('[data-band] [data-link-band]')).toBeNull();
    expect($('.u1-top [data-cloud-off]')).toBeTruthy();
    const s = $<HTMLButtonElement>('[data-stop]')!;
    expect(s.disabled).toBe(false);
    expect(s.dataset.place).toBe('screen');
  });

  it('「다시 연결」(시안 「점검」 · 망 점검 화면이 없어 시안 밖 · 새로 그림) = 실시간 다시 열기', () => {
    down();
    const b = $<HTMLButtonElement>('.u1-says [data-off-proto="reconnect"]')!;
    expect(b.textContent).toBe('다시 연결');
    const n = FakeWS.all.length;
    click(b);
    expect(FakeWS.all.length).toBe(n + 1);
  });

  it('연결이 열려 있으면 그대로(리모컨만 · 구름 빗금 없음)', () => {
    mount(true, 'u-kim', '#/drive/r7'); serve(KIM, 'r3', 'r7', 'r1'); ready();
    expect($('.u1-chip .u1-st')!.textContent).toBe('조종 중');
    expect($('.u1-top [data-cloud-off]')).toBeNull();
  });
});

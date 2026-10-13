import { afterAll, beforeAll, expect, test, vi } from 'vitest';
// 묶음 3 조종 경계(link.ts): 형식 검사·보기 전용·STOP 뒤 cmd 없음·생명주기 숨김 — 가짜 WebSocket/문서/Capacitor 로 node 에서 시험
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {} }));
const sent: any[] = [], evs: Record<string, ((...a: any[]) => void)[]> = {}, cap: Record<string, ((...a: any[]) => void)[]> = {};
let sock: any;
class FakeWS { readyState = 0; binaryType = ''; onopen: any; onmessage: any; onclose: any; constructor() { sock = this; } send(t: string) { sent.push(JSON.parse(t)); } }
const on = (k: string, f: any) => { (evs[k] ||= []).push(f); };
(globalThis as any).window = globalThis;
Object.assign(globalThis, {
  WebSocket: FakeWS, location: { href: 'http://127.0.0.1:5181/', protocol: 'http:' }, addEventListener: on,
  document: { hidden: false, addEventListener: on }, screen: { orientation: { addEventListener: on } },
  Capacitor: { Plugins: { App: { addListener: (k: string, f: any) => { (cap[k] ||= []).push(f); } } } },
});
const ST = (o: any = {}) => ({ op: 'status', ver: 'v1', role: 'control', latch: false, resume_pending: false, reset_pending: false, sim_block: '', episode: 1, state_age: 0.1, cam_age: null,
  docs_rev: 1, applied: [0, 0, 0], events: [], reason: '', me: 'pc', holder: null, sim_start: { ok: true, why: '', busy: false, session: null }, sim: { x: 0, y: 0, yaw: 0, vx: 0, vy: 0, tilt_deg: 0, fallen: false, body_still: true }, ...o });
let L: typeof import('../../src/data/link');
const msg = (o: any) => sock.onmessage({ data: JSON.stringify(o) });
const last = (a: any[]) => a[a.length - 1];
const cmds = () => sent.filter((m) => m.op === 'cmd');
const step = (ms: number) => { vi.advanceTimersByTime(ms); };
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'performance'] });
  vi.advanceTimersByTime(10);   // 가짜 performance.now 가 0 이면 «아직 메시지 없음»과 같아짐
  L = await import('../../src/data/link'); L.startLink(); sock.readyState = 1; sock.onopen();
});
afterAll(() => { vi.useRealTimers(); });

test('형식 검사: 명령 관문 칸·유한수치·배열', () => {
  expect(L.checkStatus(ST())).toBeNull();
  expect(L.checkStatus(ST({ role: 'admin' }))).toBe('role');
  expect(L.checkStatus(ST({ latch: 'false' }))).toBe('latch');
  expect(L.checkStatus(ST({ applied: [0, '1', 0] }))).toBe('applied');
  expect(L.checkStatus(ST({ applied: [0, 0] }))).toBe('applied');
  expect(L.checkStatus(ST({ episode: '1' }))).toBe('episode/age/docs_rev');
  expect(L.checkStatus(ST({ sim: { ...ST().sim, x: '0' } }))).toBe('sim.x');
  expect(L.checkStatus(ST({ ver: '' }))).toBe('ver');
  expect(L.checkStatus(null)).toBe('op');
  // 계약 대조(앱 Codex 10-13): 음수 나이·정수 아닌 episode/docs_rev·화면이 읽는 이유/사건/시뮬 시작 형
  expect(L.checkStatus(ST({ state_age: -0.1 }))).toBe('episode/age/docs_rev');
  expect(L.checkStatus(ST({ cam_age: -1 }))).toBe('episode/age/docs_rev');
  expect(L.checkStatus(ST({ episode: 1.5 }))).toBe('episode/age/docs_rev');
  expect(L.checkStatus(ST({ docs_rev: 2.5 }))).toBe('episode/age/docs_rev');
  expect(L.checkStatus(ST({ reason: null }))).toBe('reason/me/holder');
  expect(L.checkStatus(ST({ holder: 3 }))).toBe('reason/me/holder');
  expect(L.checkStatus(ST({ events: [{ t: '1', st: 'red', text: 'x' }] }))).toBe('events');
  expect(L.checkStatus(ST({ events: [null] }))).toBe('events');
  expect(L.checkStatus(ST({ sim_start: { ok: 'yes', why: '' } }))).toBe('sim_start');
  expect(L.checkStatus(ST({ events: [{ t: '10:00:00', st: 'ok', text: 'a' }], episode: null }))).toBeNull();
});

test('처음·재연결은 보기 전용: 서버 role=control 이어도 take 전엔 cmd 0건', () => {
  msg(ST()); expect(L.press('a', 1, { fx: 1, fy: 0, fw: 0 })).toBe(false); step(200); expect(cmds()).toHaveLength(0);
  expect(L.driveBlock()).toMatch('보기 전용');
});

test('take 뒤 20 Hz 발행·값 [-1,1] 자르기, 손 떼면 0', () => {
  L.sendOp('take'); msg(ST());
  expect(L.press('a', 1, { fx: 2, fy: 0, fw: -0.5 })).toBe(true); step(100);
  expect(last(cmds())).toEqual({ op: 'cmd', fx: 1, fy: 0, fw: -0.5 });
  expect(cmds().length).toBe(2);
  L.lift('a', 1); step(50); expect(last(cmds())).toEqual({ op: 'cmd', fx: 0, fy: 0, fw: 0 });
  expect(L.press('b', 1, { fx: NaN, fy: 0, fw: 0 })).toBe(false);
});

test('STOP: 누름 폐기·발행 멈춤 먼저 → latch=true 확인 전에도 cmd(0 포함) 섞이지 않음', () => {
  L.press('a', 1, { fx: 1, fy: 0, fw: 0 }); const n0 = sent.length;
  L.sendStop(); expect(last(sent)).toEqual({ op: 'stop' });
  msg(ST()); step(200); expect(sent.slice(n0).map((m) => m.op)).toEqual(['stop']);   // 서버가 아직 latch=false 여도
  msg(ST({ latch: true })); step(100); expect(sent.slice(n0).map((m) => m.op)).toEqual(['stop']);
  const c = cmds().length; step(100); expect(cmds().length).toBe(c);                    // 잠금 중 0건
  L.sendOp('resume'); msg(ST()); expect(L.press('a', 1, { fx: 0.5, fy: 0, fw: 0 })).toBe(true); step(50); expect(last(cmds())?.fx).toBe(0.5);
});

test('형식 실패 → st=null·누름 폐기·조종 안 함, 판 바뀜·리셋 대기도 막음', () => {
  msg(ST({ applied: [0, 0, 'x'] })); const c = cmds().length; step(100);
  expect(cmds().length).toBe(c); expect(L.useLink.getState().st).toBeNull(); expect(L.driveBlock()).toMatch('상태 미확인');
  msg(ST()); expect(L.driveBlock()).toBeNull();
  msg(ST({ ver: 'v2' })); expect(L.driveBlock()).toMatch('새 판'); msg(ST());
  msg(ST({ reset_pending: true })); expect(L.driveBlock()).toMatch('대기'); msg(ST());
});

test('손가락 규칙: 같은 곳 두 번째·세 번째 손가락 → 모두 폐기, 다른 손가락 lift 무시, 취소 → 폐기', () => {
  expect(L.press('a', 1, { fx: 1, fy: 0, fw: 0 })).toBe(true); expect(L.press('a', 2, { fx: 1, fy: 0, fw: 0 })).toBe(false); expect(L.pressed('a')).toBe(false);
  L.press('a', 1, { fx: 0.2, fy: 0, fw: 0 }); L.press('b', 2, { fx: 0.2, fy: 0, fw: 0 }); expect(L.press('c', 3, { fx: 1, fy: 0, fw: 0 })).toBe(false); expect(L.pressed('a') || L.pressed('b')).toBe(false);
  L.press('a', 1, { fx: 0.3, fy: 0, fw: 0 }); L.lift('a', 9); expect(L.pressed('a')).toBe(true); expect(L.move('a', 1, { fx: NaN, fy: 0, fw: 0 })).toBe(false); expect(L.pressed('a')).toBe(false);
  L.press('a', 1, { fx: 0.3, fy: 0, fw: 0 }); L.press('b', 2, { fx: 0.3, fy: 0, fw: 0 }); L.cancel('b', 2); expect(L.pressed('a')).toBe(false);
});

test('소유: 누른 손가락만 owns · 폐기(STOP·전체화면) 뒤 낡은 손가락은 owns false → 손잡이·명령 못 바꿈', () => {
  L.sendOp('take'); msg(ST());
  L.press('a', 1, { fx: 0.5, fy: 0, fw: 0 }); expect(L.owns('a', 1)).toBe(true); expect(L.owns('a', 2)).toBe(false); expect(L.owns('b', 1)).toBe(false);
  L.lift('a', 2); expect(L.owns('a', 1)).toBe(true);   // 다른 손가락 up 은 정리 못 함
  evs.fullscreenchange[0](); expect(L.owns('a', 1)).toBe(false); expect(L.move('a', 1, { fx: 1, fy: 0, fw: 0 })).toBe(false);
  L.press('a', 1, { fx: 0.5, fy: 0, fw: 0 }); L.sendStop(); expect(L.owns('a', 1)).toBe(false);
  const n = cmds().length; expect(L.move('a', 1, { fx: 1, fy: 0, fw: 0 })).toBe(false); step(200); expect(cmds().length).toBe(n);
  msg(ST({ latch: true })); L.sendOp('resume'); msg(ST());   // 잠금 확인 → 재개(다음 시험용)
});

test('화면 떠남(hide): 누름 폐기 + hidden + 보기 전용, 0 아닌 cmd 없음', () => {
  L.sendOp('take'); msg(ST()); L.press('a', 1, { fx: 1, fy: 0, fw: 0 }); step(50);
  const n = cmds().length; L.hide(); expect(last(sent)).toEqual({ op: 'hidden' }); expect(L.useLink.getState().viewOnly).toBe(true);
  step(200); expect(cmds().slice(n).every((m) => !m.fx && !m.fy && !m.fw)).toBe(true); expect(L.driveBlock()).toMatch('보기 전용');
  L.sendOp('take'); msg(ST());   // 다음 시험을 위해 조종 상태로 되돌림
});

test('상태 변화(에피소드) → 낡은 누름 폐기(다시 눌러야 함)', () => {
  L.press('a', 1, { fx: 1, fy: 0, fw: 0 }); step(50); expect(last(cmds())?.fx).toBe(1);
  msg(ST({ episode: 2 })); step(50); expect(last(cmds())?.fx).toBe(0);
});

test('생명주기: 앱 pause·문서 숨김 → hidden+보기 전용, resume → 보기 전용(재take 필요), 등록 한 번', () => {
  expect(Object.keys(cap).sort()).toEqual(['appStateChange', 'pause', 'resume']);
  expect(cap.pause.length + cap.resume.length + cap.appStateChange.length).toBe(3);
  cap.pause[0](); expect(last(sent)).toEqual({ op: 'hidden' }); expect(L.useLink.getState().viewOnly).toBe(true);
  L.sendOp('take'); msg(ST()); cap.resume[0](); expect(L.driveBlock()).toMatch('보기 전용');
  L.sendOp('take'); (globalThis as any).document.hidden = true; evs.visibilitychange[0](); expect(last(sent)).toEqual({ op: 'hidden' }); (globalThis as any).document.hidden = false;
  L.sendOp('take'); evs.blur[0](); expect(L.useLink.getState().viewOnly).toBe(true);
  const h = sent.filter((m) => m.op === 'hidden').length; L.sendOp('take'); msg(ST());
  cap.pause[0](); cap.appStateChange[0]({ isActive: false }); evs.blur[0](); msg(ST({ role: 'view' }));
  (globalThis as any).document.hidden = true; evs.visibilitychange[0](); (globalThis as any).document.hidden = false;
  expect(sent.filter((m) => m.op === 'hidden').length - h).toBe(1);   // 배경 한 번 → hidden 한 번
});

test('WS close → 즉시 끊김·보기 전용, 4401 은 다시 잇지 않음', () => {
  L.sendOp('take'); msg(ST()); sock.onclose({ code: 1006 });
  expect(L.useLink.getState().open).toBe(false); expect(L.linkView(L.useLink.getState()).linkOk).toBe(false); expect(L.driveBlock()).toMatch('링크');
});

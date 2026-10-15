import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
// N1(10-15) «조종 시작» = 확인 1회(페이지 안) → take → resume(stop_gen) 1회. 가짜 WS + 서버 Core 축약 모델(sim/v2_link.py Core.take/resume/stop/drop/_lock 과 같은 규칙)로
// 중간 실패·STOP 경합(CAS)·늦은 응답·세대·episode·리셋·형식·신선도 변화·확인창 중 입력·겹친 시작·옛 서버를 시험한다. 실제 link 시험은 runs/ux-fix-20261015 (격리 포트) 원물.
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {} }));
const sent: any[] = [], evs: Record<string, ((...a: any[]) => void)[]> = {};
let sock: any;
class FakeWS { readyState = 0; binaryType = ''; onopen: any; onmessage: any; onclose: any; constructor() { sock = this; } send(t: string) { sent.push(JSON.parse(t)); } }
const on = (k: string, f: any) => { (evs[k] ||= []).push(f); };
(globalThis as any).window = globalThis;
Object.assign(globalThis, {
  WebSocket: FakeWS, location: { href: 'http://127.0.0.1:5181/', protocol: 'http:' }, addEventListener: on,
  document: { hidden: false, addEventListener: on, querySelectorAll: () => [] }, screen: { orientation: { addEventListener: on } },
});
let L: typeof import('../../src/data/link');

// ---- 서버 Core 축약(v2_link.py Core 와 같은 규칙: 잠그는 모든 일 = _lock = 세대 +1, resume 은 gen 대조) ----
const S = { ctl: null as null | 'me' | 'other', latch: true, pend: false, reset: false, simStop: true, block: '', gen: 0, ep: 1, noGen: false };
const lock = () => { S.latch = true; S.pend = false; S.gen++; };
let seen = 0;
function pump() {   // 아직 처리 안 한 보낸 op 를 순서대로 처리
  for (; seen < sent.length; seen++) {
    const m = sent[seen], op = m.op;
    if (op === 'take') { if (S.ctl === null && !S.block) S.ctl = 'me'; }
    else if (op === 'resume') { if (S.ctl === 'me' && S.latch && !S.pend && !S.reset && !S.block && S.simStop && (m.stop_gen === undefined || m.stop_gen === S.gen)) S.pend = true; }
    else if (op === 'stop') lock();
    else if (op === 'reset') { if (S.ctl === 'me') { S.reset = true; lock(); } }
    else if (op === 'release' || op === 'hidden') { if (S.ctl === 'me') { S.ctl = null; lock(); } }
  }
}
const simConfirm = () => { if (S.pend) { S.pend = false; S.latch = false; } };   // 시뮬이 stop_requested=false 를 보냄
const msg = (x: object = {}) => ({ op: 'status', ver: 'v1', role: S.ctl === 'me' ? 'control' : S.ctl ? 'view_other' : 'view', latch: S.latch, resume_pending: S.pend, reset_pending: S.reset,
  sim_block: S.block, episode: S.ep, state_age: 0.1, cam_age: null, docs_rev: 1, applied: [0, 0, 0], events: [], reason: '', me: 'pc', holder: S.ctl === 'other' ? 'B · 폰' : null,
  sim_start: { ok: true, why: '', busy: false, session: null }, sim: { x: 0, y: 0, yaw: 0, vx: 0, vy: 0, tilt_deg: 0, fallen: false, body_still: true }, ...(S.noGen ? {} : { stop_gen: S.gen }), ...x });
const emit = (x?: object) => { vi.advanceTimersByTime(5); sock.onmessage({ data: JSON.stringify(msg(x)) }); };
const srv = () => { pump(); emit(); };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const wait = async (ms: number) => { for (let t = 0; t < ms; t += 100) { vi.advanceTimersByTime(95); emit(); await flush(); } };   // 신선한 status 를 받으며 시간 경과
const ops = () => sent.slice(base).map((m) => m.op).filter((o) => o !== 'cmd');
const yes = () => true;
let base = 0;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'performance'] });
  vi.advanceTimersByTime(10);
  L = await import('../../src/data/link'); L.startLink();
  for (let i = 0; i < 10 && !sock; i++) await Promise.resolve();
  sock.readyState = 1; sock.onopen();
});
afterAll(() => { vi.useRealTimers(); });
beforeEach(async () => {   // 매 시험: 서버 = 아무도 조종 안 함·STOP 잠금·시뮬 STOP 확인됨, 화면 = 보기 전용
  L.cancelStart(); await flush(); pump(); Object.assign(S, { ctl: null, latch: true, pend: false, reset: false, simStop: true, block: '', ep: 1, noGen: false });
  L.useLink.setState({ viewOnly: true }); emit(); base = sent.length;
});

test('정상(페이지 안 확인창): 확인 1회 → take → resume(stop_gen) → 조종 가능, 시퀀스 중 누름은 폐기', async () => {
  const p = L.startDrive();
  expect(L.useAsk.getState().text).toBe(L.START_ASK); expect(L.useLink.getState().starting).toBe('확인 대기');
  for (let i = 0; i < 5; i++) emit();        // 확인창 동안에도 상태를 계속 받음(비차단)
  L.answerAsk(true); await flush();
  expect(L.useLink.getState().starting).toBe('조종권 확인 중');
  srv(); await flush();
  expect(L.useLink.getState().starting).toBe('STOP 해제 확인 중');
  L.press('stick', 1, { fx: 1, fy: 0, fw: 0 });
  srv(); simConfirm(); emit();
  L.press('stick2', 2, { fx: 1, fy: 0, fw: 0 });
  expect(await p).toBe('조종 가능 — 손 떼고 새로 누르면 움직임');
  expect(ops()).toEqual(['take', 'resume']);
  expect(sent.filter((m) => m.op === 'resume').slice(-1)[0].stop_gen).toBe(S.gen);   // 확인창을 연 순간의 세대
  expect(L.pressed('stick')).toBe(false); expect(L.pressed('stick2')).toBe(false);
  expect(L.driveBlock()).toBeNull(); expect(L.useLink.getState().starting).toBeNull(); expect(L.useAsk.getState().text).toBeNull();
  expect(L.startBlock()).toBe('이미 조종 가능');
});

test('확인창 취소: 보낸 것 0', async () => {
  const p = L.startDrive(); L.answerAsk(false);
  expect(await p).toBeNull(); srv(); expect(ops()).toEqual([]); expect(L.useLink.getState().viewOnly).toBe(true);
});

test('확인창 중 이 기기 STOP·숨김·반납·리셋 요청: 창이 바로 닫히고 take 0', async () => {
  for (const f of [() => L.sendStop(), () => L.hide(), () => L.sendOp('release'), () => L.sendOp('reset')]) {
    base = sent.length; srv();
    const p = L.startDrive(); expect(L.useAsk.getState().text).not.toBeNull();
    f(); expect(L.useAsk.getState().text).toBeNull();
    expect(await p).toBe(L.START_CANCEL);
    expect(ops().filter((o) => o === 'take' || o === 'resume')).toEqual([]);
    srv();
  }
});

test('확인창 중 다른 기기 STOP(이미 잠김): 세대 +1 → 창 닫힘·중단, take·resume 0', async () => {
  const p = L.startDrive();
  lock(); emit();   // 다른 기기 STOP — latch 는 원래 true, 세대만 바뀜
  expect(L.useAsk.getState().text).toBeNull();
  expect(await p).toContain('새 STOP·잠금'); expect(ops()).toEqual([]);
});

test('CAS: 화면이 보기 전 서버에서 다른 STOP → resume(옛 세대) 서버 거부, 재시도 0, 잠금 유지', async () => {
  const p = L.startDrive(yes);
  await flush(); srv(); await flush();          // take OK → resume(g) 보냄(아직 서버 처리 전)
  lock();                                       // 다른 기기 STOP 이 먼저 처리됨
  pump(); expect(S.pend).toBe(false);           // 서버: 세대 다름 → 거부
  emit(); await flush();
  expect(await p).toContain('새 STOP·잠금');
  expect(ops().filter((o) => o === 'resume')).toHaveLength(1); expect(S.latch).toBe(true);
});

test('확인창 중 다른 기기 점유: 중단·take 0', async () => {
  const p = L.startDrive(); S.ctl = 'other'; emit();
  expect(await p).toContain('다른 기기가 조종 중'); expect(ops()).toEqual([]);
});

test('take 경합: 서버가 다른 기기를 먼저 받음 → 보기 전용, resume 0', async () => {
  const p = L.startDrive(yes); await flush();
  S.ctl = 'other'; srv(); await flush();
  expect(await p).toContain('다른 기기가 조종 중');
  expect(ops()).toEqual(['take']); expect(L.useLink.getState().viewOnly).toBe(true); expect(L.driveBlock()).not.toBeNull();
});

test('take 응답 없음(신선한 status 는 계속): 시간 초과 → resume 0, 보기 전용', async () => {
  const p = L.startDrive(yes); await flush();
  await wait(3200);   // 서버가 take 를 처리하지 않은 status(role view)만
  expect(await p).toContain('조종권 확인 못 함');
  expect(ops()).toEqual(['take']); expect(L.driveBlock()).not.toBeNull();
});

test('신선도: take 대기 중 1 s 넘게 status 없음 → 중단, 그 뒤 control ACK 가 와도 resume 0', async () => {
  const p = L.startDrive(yes); await flush();
  vi.advanceTimersByTime(1200); pump(); emit(); await flush();
  expect(await p).toContain('중단'); expect(ops()).toEqual(['take']);
});

test('늦은 ack: take 뒤 숨김 → 그 뒤 control status 가 와도 resume 0', async () => {
  const p = L.startDrive(yes); await flush();
  L.hide(); srv(); await flush();
  expect(await p).toBe(L.START_CANCEL);
  expect(ops()).toEqual(['take', 'hidden']); expect(S.ctl).toBe(null); expect(S.latch).toBe(true);
});

test('take 대기 중 리셋 완료 + episode 변경 → control ACK 이어도 resume 0', async () => {
  const p = L.startDrive(yes); await flush();
  pump(); S.ep = 2; lock(); emit(); await flush();   // 같은 status 에 control + 새 episode
  expect(await p).toContain('중단'); expect(ops()).toEqual(['take']);
});

test('episode 만 바뀜(세대 그대로 — 서버는 같이 올리지만 화면도 따로 결속): resume 0', async () => {
  const p = L.startDrive(yes); await flush();
  pump(); emit({ episode: 2 }); await flush();
  expect(await p).toContain('episode'); expect(ops()).toEqual(['take']);
});

test('리셋 깜빡임(sticky): take 대기 중 reset_pending true→false 가 지나간 뒤 ACK → resume 0', async () => {
  const p = L.startDrive(yes); await flush();
  emit({ reset_pending: true }); emit(); pump(); emit(); await flush();
  expect(await p).toContain('시뮬 리셋 처리 중'); expect(ops()).toEqual(['take']);
});

test('형식 오류 뒤 회복: bad status 1개 → 정상 control 이 와도 자동 속행 0', async () => {
  const p = L.startDrive(yes); await flush();
  emit({ latch: 1 }); pump(); emit(); await flush();
  expect(await p).toContain('상태 형식 오류'); expect(ops()).toEqual(['take']);
});

test('세대 변화(재연결·대상 전환): take 뒤 gen+1 → 중단, resume 0', async () => {
  const p = L.startDrive(yes); await flush();
  L.useLink.setState((s) => ({ gen: s.gen + 1 }));
  srv(); await flush();
  expect(await p).toContain('연결·대상 바뀜'); expect(ops()).toEqual(['take']);
  L.useLink.setState((s) => ({ gen: s.gen - 1 }));
});

test('STOP 경합(이 기기): 해제 확인 대기 중 STOP → 중단, resume 재전송 0, 잠금', async () => {
  const p = L.startDrive(yes); await flush();
  srv(); await flush(); srv(); expect(S.pend).toBe(true);
  L.sendStop(); srv(); simConfirm(); emit(); await flush();
  expect(await p).toBe(L.START_CANCEL);
  expect(ops()).toEqual(['take', 'resume', 'stop']); expect(S.latch).toBe(true); expect(L.driveBlock()).toBe('STOP 잠금');
});

test('STOP 경합(다른 기기): 해제 대기 중 다른 STOP → 중단, resume 1회뿐', async () => {
  const p = L.startDrive(yes); await flush();
  srv(); await flush(); srv();
  lock(); emit(); await flush();
  expect(await p).toContain('새 STOP·잠금');
  expect(ops().filter((o) => o === 'resume')).toHaveLength(1); expect(S.latch).toBe(true); expect(L.driveBlock()).toBe('STOP 잠금');
});

test('resume 거부(시뮬 STOP 확인 전): 조종권은 이 기기·잠금 유지, resume 재시도 0', async () => {
  S.simStop = false;
  const p = L.startDrive(yes); await flush();
  srv(); await flush(); srv();
  await wait(1700);
  expect(await p).toContain('STOP 해제 거부');
  expect(ops()).toEqual(['take', 'resume']); emit(); expect(S.ctl).toBe('me'); expect(L.driveBlock()).toBe('STOP 잠금');
});

test('이미 조종권 + STOP 잠금(STOP 뒤): take 없이 resume 1회', async () => {
  L.sendOp('take'); srv(); simConfirm(); L.sendStop(); srv();
  base = sent.length;
  const p = L.startDrive(yes); await flush();
  srv(); await flush(); simConfirm(); emit();
  expect(await p).toBe('조종 가능 — 손 떼고 새로 누르면 움직임'); expect(ops()).toEqual(['resume']);
});

test('옛 서버(status 에 stop_gen 없음): 확인창도 안 띄우고 이유, 조용한 resume 0', async () => {
  S.noGen = true; emit();
  let asked = 0;
  expect(await L.startDrive(() => { asked++; return true; })).toContain('옛 서버');
  expect(asked).toBe(0); expect(ops()).toEqual([]);
  emit({ stop_gen: -1 }); expect(L.useLink.getState().bad).toBe('stop_gen');   // 있는데 형식 틀림 = 형식 오류
  S.noGen = false; emit();
});

test('막힘: 리셋·시뮬 이상·실기 대상·겹친 시작은 확인창도 안 띄움', async () => {
  let asked = 0; const ask = () => { asked++; return true; };
  S.reset = true; emit();
  expect(await L.startDrive(ask)).toContain('시뮬 리셋 처리 중');
  S.reset = false; S.block = '시뮬 상태 끊김'; emit();
  expect(await L.startDrive(ask)).toContain('시뮬 상태 끊김');
  S.block = ''; emit();
  L.useLink.setState({ provider: 'go2_direct' });
  expect(await L.startDrive(ask)).toContain('실기 모드');
  L.useLink.setState({ provider: 'simulation_gate' }); emit();
  expect(asked).toBe(0); expect(ops()).toEqual([]);
  const p = L.startDrive();   // 첫 시작 확인창 열림
  expect(await L.startDrive(ask)).toBe('조종 시작 안 됨 · 확인 대기');
  expect(asked).toBe(0);
  L.answerAsk(true); await flush(); srv(); await flush(); srv(); simConfirm(); emit();
  expect(await p).toBe('조종 가능 — 손 떼고 새로 누르면 움직임');
});

test('P2-B 앵커(배치만): startDrive(undefined, 단추) → 창 앵커 · r0 = 여는 순간 사각형 사본 · 무인자/분리 요소 = 앵커 없음 · STOP 으로 닫히면 버림', async () => {
  let r = { left: 10, top: 20, right: 110, bottom: 64 };
  const el = { isConnected: true, getBoundingClientRect: () => r } as unknown as Element;
  const p = L.startDrive(undefined, el), s1 = L.useAsk.getState();
  expect(s1.text).toBe(L.START_ASK); expect(s1.anchor?.el).toBe(el); expect(s1.anchor?.r0).toEqual({ left: 10, top: 20, right: 110, bottom: 64 });
  r = { left: 0, top: 500, right: 100, bottom: 544 }; expect(L.useAsk.getState().anchor?.r0.top).toBe(20);   // 단추가 움직여도 r0 는 여는 순간 값(현재 자리는 StartAsk 가 매 프레임 따로)
  L.cancelStart(); await p; expect(L.useAsk.getState()).toMatchObject({ text: null, anchor: null }); expect(ops()).toEqual([]);
  const q = L.startDrive(); expect(L.useAsk.getState().text).toBe(L.START_ASK); expect(L.useAsk.getState().anchor).toBeNull(); L.cancelStart(); await q;   // 무인자(패드 누름 경로) = STOP 만
  const d = L.startDrive(undefined, { isConnected: false, getBoundingClientRect: () => r } as unknown as Element); expect(L.useAsk.getState().anchor).toBeNull(); L.cancelStart(); await d;
  const n = L.startDrive(async () => false, el); expect(L.useAsk.getState().text).toBeNull(); await n;   // 주입 ask(시험) 는 그대로 — 앵커·페이지 창 0
});

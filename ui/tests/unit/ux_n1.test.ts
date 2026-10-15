import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
// N1(10-15) «조종 시작» = 확인 1회 → take → resume 1회. 가짜 WS + 서버 Core 축약 모델(sim/v2_link.py Core.take/resume/stop/drop 과 같은 규칙)로
// 중간 실패·STOP 경합·늦은 응답·세대 변화·확인창 중 입력·겹친 시작을 시험한다. 실제 link 시험은 runs/ux-fix-20261015 (격리 포트) 원물.
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

// ---- 서버 Core 축약(v2_link.py 150~210행과 같은 규칙) ----
const S = { ctl: null as null | 'me' | 'other', latch: true, pend: false, reset: false, simStop: true, block: '' };
let seen = 0;
function pump() {   // 아직 처리 안 한 보낸 op 를 순서대로 처리
  for (; seen < sent.length; seen++) {
    const op = sent[seen].op;
    if (op === 'take') { if (S.ctl === null && !S.block) S.ctl = 'me'; }
    else if (op === 'resume') { if (S.ctl === 'me' && S.latch && !S.pend && !S.reset && !S.block && S.simStop) S.pend = true; }
    else if (op === 'stop') { S.latch = true; S.pend = false; }
    else if (op === 'release' || op === 'hidden') { if (S.ctl === 'me') { S.ctl = null; S.latch = true; S.pend = false; } }
  }
}
const simConfirm = () => { if (S.pend) { S.pend = false; S.latch = false; } };   // 시뮬이 stop_requested=false 를 보냄
const emit = () => { vi.advanceTimersByTime(5); sock.onmessage({ data: JSON.stringify({ op: 'status', ver: 'v1', role: S.ctl === 'me' ? 'control' : S.ctl ? 'view_other' : 'view', latch: S.latch, resume_pending: S.pend, reset_pending: S.reset,
  sim_block: S.block, episode: 1, state_age: 0.1, cam_age: null, docs_rev: 1, applied: [0, 0, 0], events: [], reason: '', me: 'pc', holder: S.ctl === 'other' ? 'B · 폰' : null,
  sim_start: { ok: true, why: '', busy: false, session: null }, sim: { x: 0, y: 0, yaw: 0, vx: 0, vy: 0, tilt_deg: 0, fallen: false, body_still: true } }) }); };
const srv = () => { pump(); emit(); };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const ops = () => sent.slice(base).map((m) => m.op).filter((o) => o !== 'cmd');
let base = 0;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'performance'] });
  vi.advanceTimersByTime(10);
  L = await import('../../src/data/link'); L.startLink();
  for (let i = 0; i < 10 && !sock; i++) await Promise.resolve();
  sock.readyState = 1; sock.onopen();
});
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => {   // 매 시험: 서버 = 아무도 조종 안 함·STOP 잠금·시뮬 STOP 확인됨, 화면 = 보기 전용
  L.cancelStart(); pump(); Object.assign(S, { ctl: null, latch: true, pend: false, reset: false, simStop: true, block: '' });
  L.useLink.setState({ viewOnly: true }); emit(); base = sent.length;
});

test('정상: 확인 1회 → take → resume → 조종 가능, 보낸 op 는 take·resume 각 1, 시퀀스 중 누름은 폐기(새 누름 필요)', async () => {
  let asked = 0;
  const p = L.startDrive(() => { asked++; return true; });
  expect(asked).toBe(1); expect(L.useLink.getState().starting).toBe('조종권 확인 중');
  srv(); await flush();
  expect(L.useLink.getState().starting).toBe('STOP 해제 확인 중');
  L.press('stick', 1, { fx: 1, fy: 0, fw: 0 });   // 확인 뒤·잠금 해제 전 누른 손가락
  srv(); simConfirm(); emit();
  L.press('stick2', 2, { fx: 1, fy: 0, fw: 0 });   // 잠금 해제 status 뒤·결과 전에 누른 손가락(상태 서명 폐기 뒤)
  expect(await p).toBe('조종 가능 — 손 떼고 새로 누르면 움직임');
  expect(ops()).toEqual(['take', 'resume']);
  expect(L.pressed('stick')).toBe(false); expect(L.pressed('stick2')).toBe(false);   // 성공해도 이전 누름 폐기
  expect(L.driveBlock()).toBeNull(); expect(L.useLink.getState().starting).toBeNull();
  expect(L.startBlock()).toBe('이미 조종 가능');
});

test('확인창 취소: 보낸 것 0, 상태 그대로', async () => {
  expect(await L.startDrive(() => false)).toBeNull();
  srv(); expect(ops()).toEqual([]); expect(L.useLink.getState().viewOnly).toBe(true);
});

test('확인창 중 STOP·숨김·반납: 확인해도 take 0', async () => {
  for (const f of [() => L.sendStop(), () => L.hide(), () => L.sendOp('release')]) {
    base = sent.length;
    expect(await L.startDrive(() => { f(); return true; })).toBe(L.START_CANCEL);
    expect(ops().filter((o) => o === 'take' || o === 'resume')).toEqual([]);
    srv();
  }
});

test('확인창 중 다른 기기가 점유: 확인 뒤 재검사로 take 0', async () => {
  const r = await L.startDrive(() => { S.ctl = 'other'; emit(); return true; });
  expect(r).toContain('다른 기기가 조종 중');
  expect(ops()).toEqual([]);
});

test('take 경합: 서버가 다른 기기를 먼저 받음 → 보기 전용, resume 0', async () => {
  const p = L.startDrive(() => true);
  S.ctl = 'other'; srv(); await flush();
  expect(await p).toContain('다른 기기가 조종 중');
  expect(ops()).toEqual(['take']); expect(L.useLink.getState().viewOnly).toBe(true);
  expect(L.driveBlock()).not.toBeNull();
});

test('take 응답 없음(시간 초과): resume 0, 보기 전용', async () => {
  const p = L.startDrive(() => true);
  for (let i = 0; i < 40; i++) emit();   // 서버가 take 를 처리하지 않은 status 만 계속(role view)
  vi.advanceTimersByTime(3100); await flush();
  expect(await p).toContain('조종권 확인 못 함');
  expect(ops()).toEqual(['take']); expect(L.driveBlock()).not.toBeNull();
});

test('늦은 ack: take 뒤 숨김으로 중단 → 그 뒤 control status 가 와도 resume 0', async () => {
  const p = L.startDrive(() => true);
  L.hide();                // 화면 이탈(take 응답 전)
  srv(); await flush();    // 서버는 take → hidden 순서로 처리
  expect(await p).toBe(L.START_CANCEL);
  expect(ops()).toEqual(['take', 'hidden']);
  expect(S.ctl).toBe(null); expect(S.latch).toBe(true);
});

test('세대 변화(재연결·대상 전환): take 뒤 gen+1 → 중단, resume 0', async () => {
  const p = L.startDrive(() => true);
  L.useLink.setState((s) => ({ gen: s.gen + 1 }));
  srv(); await flush();
  expect(await p).toBe(L.START_CANCEL);
  expect(ops()).toEqual(['take']);
  L.useLink.setState((s) => ({ gen: s.gen - 1 }));
});

test('STOP 경합(이 기기): 해제 확인 대기 중 STOP → 중단, resume 재전송 0, 잠금', async () => {
  const p = L.startDrive(() => true);
  srv(); await flush(); srv();          // take OK → resume 대기
  expect(S.pend).toBe(true);
  L.sendStop(); srv(); simConfirm(); emit(); await flush();
  expect(await p).toBe(L.START_CANCEL);
  expect(ops()).toEqual(['take', 'resume', 'stop']);
  expect(S.latch).toBe(true); expect(L.driveBlock()).toBe('STOP 잠금');
});

test('STOP 경합(다른 기기): 해제 대기 중 다른 STOP → 실패 글, resume 1회뿐(남의 STOP 을 풀지 않음)', async () => {
  const p = L.startDrive(() => true);
  srv(); await flush(); srv();
  S.latch = true; S.pend = false; emit(); await flush();   // 다른 기기 STOP(Core.stop)
  for (let i = 0; i < 10; i++) emit();
  vi.advanceTimersByTime(5000); await flush();
  expect(await p).toContain('STOP 해제 확인 안 됨');
  expect(ops().filter((o) => o === 'resume')).toHaveLength(1);
  emit(); expect(S.latch).toBe(true); expect(L.driveBlock()).toBe('STOP 잠금');
});

test('resume 거부(시뮬 STOP 확인 전): 조종권은 이 기기·잠금 유지, resume 재시도 0', async () => {
  S.simStop = false;
  const p = L.startDrive(() => true);
  srv(); await flush(); srv();
  for (let i = 0; i < 10; i++) emit();
  vi.advanceTimersByTime(1600); await flush();
  expect(await p).toContain('STOP 해제 거부');
  expect(ops()).toEqual(['take', 'resume']);
  emit(); expect(S.ctl).toBe('me'); expect(L.driveBlock()).toBe('STOP 잠금');
});

test('이미 조종권 + STOP 잠금(STOP 뒤): take 없이 resume 1회', async () => {
  L.sendOp('take'); srv(); simConfirm(); L.sendStop(); srv();
  base = sent.length;
  const p = L.startDrive(() => true);
  srv(); await flush(); simConfirm(); emit();
  expect(await p).toBe('조종 가능 — 손 떼고 새로 누르면 움직임');
  expect(ops()).toEqual(['resume']);
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
  const p = L.startDrive(ask);   // 첫 시작 진행 중
  expect(await L.startDrive(ask)).toBe('조종 시작 안 됨 · 조종권 확인 중');
  expect(asked).toBe(1);
  srv(); await flush(); srv(); simConfirm(); emit();
  expect(await p).toBe('조종 가능 — 손 떼고 새로 누르면 움직임');
});

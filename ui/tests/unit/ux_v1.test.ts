import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
// 10-15 ② 영상 끊김 수정 반례: camShow 는 받은 순간 신원(연결 세대·대상·회차·도착 시각)을 들고 해독(Image.decode)을 기다리고,
// 화면에 넣기 직전 지금과 대조한다. RESET·새 연결·대상 전환·늦은 해독(>1 s)·대기 Blob 이 옛 신원으로 버려지는지, latest-only·이전 URL 수명을 본다.
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {} }));
const evs: Record<string, ((...a: any[]) => void)[]> = {};
let sock: any;
class FakeWS { readyState = 0; binaryType = ''; onopen: any; onmessage: any; onclose: any; constructor() { sock = this; } send() {} }
const on = (k: string, f: any) => { (evs[k] ||= []).push(f); };
// 해독을 손으로 끝내는 가짜 Image · URL 수명 기록 · 화면 img 1개
const decs: { src: string; ok: () => void; no: () => void }[] = [];
class FakeImage { src = ''; decode() { return new Promise<void>((ok, no) => decs.push({ src: this.src, ok, no: () => no(new Error('bad')) })); } }
let nURL = 0; const live = new Set<string>();
const scr = { src: '', removeAttribute(k: string) { if (k === 'src') this.src = ''; } };
(globalThis as any).window = globalThis;
Object.assign(globalThis, {
  WebSocket: FakeWS, Image: FakeImage, location: { href: 'http://127.0.0.1:5181/', protocol: 'http:' }, addEventListener: on,
  document: { hidden: false, addEventListener: on, querySelectorAll: (q: string) => (q.includes('data-live-cam') ? [scr] : []) }, screen: { orientation: { addEventListener: on } },
});
URL.createObjectURL = () => { const u = `blob:${++nURL}`; live.add(u); return u; };
URL.revokeObjectURL = (u: string) => { live.delete(u); };
let L: typeof import('../../src/data/link');

let ep = 1, rp = false;
const msg = () => ({ op: 'status', ver: 'v1', role: 'view', latch: true, resume_pending: false, reset_pending: rp, sim_block: '', episode: ep, state_age: 0.1, cam_age: 0.1, docs_rev: 1,
  applied: [0, 0, 0], events: [], reason: '', me: 'pc', holder: null, sim_start: { ok: true, why: '', busy: false, session: null },
  sim: { x: 0, y: 0, yaw: 0, vx: 0, vy: 0, tilt_deg: 0, fallen: false, body_still: true }, stop_gen: 1 });
const emit = () => sock.onmessage({ data: JSON.stringify(msg()) });
const frame = () => sock.onmessage({ data: new Blob(['jpg']) });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const snap = () => ({ ...L.CAM });
const connect = async () => { sock = null; for (let i = 0; i < 40 && !sock; i++) { vi.advanceTimersByTime(250); await flush(); } sock.readyState = 1; sock.onopen(); emit(); };
const drain = async () => { while (decs.length) { decs.shift()!.ok(); await flush(); } };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'performance'] });
  vi.advanceTimersByTime(10);
  L = await import('../../src/data/link'); L.startLink();
  for (let i = 0; i < 10 && !sock; i++) await Promise.resolve();
  sock.readyState = 1; sock.onopen(); emit();
});
afterAll(() => { vi.useRealTimers(); });
beforeEach(async () => { await drain(); ep = 1; rp = false; L.setProvider('simulation_gate'); emit(); await drain(); });

test('정상: 해독 끝난 프레임만 화면에, 넣은 뒤 이전 URL 해제(살아 있는 URL = 화면 것 1개)', async () => {
  const c = snap();
  const before = scr.src; frame(); expect(decs.length).toBe(1); expect(scr.src).toBe(before);   // 해독 전엔 화면 그대로
  decs.shift()!.ok(); await flush();
  expect(L.CAM.shown - c.shown).toBe(1); expect(scr.src).toBe(L.camURL); expect([...live]).toEqual([L.camURL]);
  frame(); decs.shift()!.ok(); await flush();
  expect(L.CAM.shown - c.shown).toBe(2); expect([...live]).toEqual([L.camURL]);   // 옛 URL 은 새 것을 넣은 «뒤» 해제
});

test('latest-only: 해독 중 3장 오면 마지막 1장만 대기(건너뜀 1), 쌓기 0', async () => {
  const c = snap();
  frame(); frame(); frame(); frame();
  expect(decs.length).toBe(1); expect(L.CAM.skip - c.skip).toBe(2);
  await drain();
  expect(L.CAM.shown - c.shown).toBe(2); expect(L.CAM.recv - c.recv).toBe(4); expect([...live]).toEqual([L.camURL]);
});

test('늦은 해독(도착 뒤 >1 s) → 버림(old), 화면은 이전 프레임 유지', async () => {
  frame(); await drain(); const keep = scr.src, c = snap();
  frame(); vi.advanceTimersByTime(1100); emit(); decs.shift()!.ok(); await flush();
  expect(L.CAM.old - c.old).toBe(1); expect(scr.src).toBe(keep); expect([...live]).toEqual([keep]);
});

test('RESET 시작: 해독 중 프레임 버림 + 화면 영상 비움(옛 회차 재사용 0)', async () => {
  frame(); await drain(); const c = snap();
  frame(); rp = true; emit();                      // 리셋 시작 = 경계 → camClear
  expect(scr.src).toBe(''); expect(L.camURL).toBe(null);
  decs.shift()!.ok(); await flush();
  expect(L.CAM.old - c.old).toBe(1); expect(scr.src).toBe(''); expect(live.size).toBe(0);
});

test('회차(episode) 변경: 해독 중 옛 회차 프레임과 대기 Blob 모두 옛 신원으로 버림, 새 회차 프레임은 표시', async () => {
  frame(); await drain(); const c = snap();
  frame(); frame();                                // 1장 해독 중 + 1장 대기(둘 다 ep 1 신원)
  ep = 2; emit();                                  // 경계: 대기분 비움 + 화면 비움
  decs.shift()!.ok(); await flush();
  expect(decs.length).toBe(0);                     // 대기분은 camClear 로 사라짐 — 새 신원을 붙여 해독하지 않음
  expect(L.CAM.old - c.old).toBe(1); expect(scr.src).toBe('');
  frame(); await drain(); expect(L.CAM.shown - c.shown).toBe(1); expect(scr.src).toBe(L.camURL);
});

test('대기 Blob 이 경계 «뒤» 에 처리돼도 받을 때 신원으로 판정(새 신원 붙이기 0)', async () => {
  frame(); await drain(); const c = snap();
  frame(); frame();                                // A 해독 중, B 대기(ep 1)
  // 경계 없이 회차만 바뀐 status 가 아직 안 온 상태에서 A 끝 → B 해독 시작(신원 ep 1) → 그 다음 회차 변경
  decs.shift()!.ok(); await flush(); expect(decs.length).toBe(1);
  ep = 3; emit(); decs.shift()!.ok(); await flush();
  expect(L.CAM.shown - c.shown).toBe(1); expect(L.CAM.old - c.old).toBe(1); expect(scr.src).toBe('');
});

test('새 연결(onclose → 재연결 gen+1): 옛 연결 해독 프레임 버림, 화면 비움', async () => {
  frame(); await drain(); const c = snap();
  frame(); sock.onclose({ code: 1006 });
  expect(scr.src).toBe(''); expect(L.camURL).toBe(null);
  await connect();
  decs.shift()!.ok(); await flush();
  expect(L.CAM.old - c.old).toBe(1); expect(scr.src).toBe('');
  frame(); await drain(); expect(L.CAM.shown - c.shown).toBe(1);
});

test('대상 전환(실기): 해독 중 프레임 버림, 실기 대상에서 받은 프레임은 해독도 안 함', async () => {
  frame(); await drain(); const c = snap();
  frame(); L.setProvider('go2_direct' as any);
  expect(scr.src).toBe('');
  decs.shift()!.ok(); await flush();
  expect(L.CAM.old - c.old).toBe(1);
  frame(); expect(decs.length).toBe(0); expect(L.CAM.recv - c.recv).toBe(1);
});

test('해독 실패: fail 세고 URL 해제, 다음 프레임은 정상', async () => {
  frame(); await drain(); const keep = scr.src, c = snap();
  frame(); decs.shift()!.no(); await flush();
  expect(L.CAM.fail - c.fail).toBe(1); expect(scr.src).toBe(keep); expect([...live]).toEqual([keep]);
});

test('대기 Blob 은 받은 시각 그대로: 앞 해독이 1 s 넘게 걸리면 대기분도 늦음으로 버림(꺼낼 때 새 시각 붙이기 0)', async () => {
  frame(); await drain(); const keep = scr.src, c = snap();
  frame(); frame(); vi.advanceTimersByTime(1100); emit();   // A 해독 중 + B 대기, 둘 다 1.1 s 전 도착
  decs.shift()!.ok(); await flush(); decs.shift()!.ok(); await flush();
  expect(L.CAM.old - c.old).toBe(2); expect(L.CAM.shown - c.shown).toBe(0); expect(scr.src).toBe(keep);
});

test('영상 경계 번호: 같은 회차로 리셋 true→false 가 끝난 뒤 옛 해독이 끝나도 표시 0, 그 뒤 새 프레임만 표시', async () => {
  frame(); await drain(); const c = snap();
  frame();                                         // 해독 중(경계 전 신원)
  rp = true; emit(); rp = false; emit();           // 리셋 시작(camClear) → 같은 episode 로 끝남: gen·ep·시각은 다시 맞음
  decs.shift()!.ok(); await flush();
  expect(L.CAM.old - c.old).toBe(1); expect(L.CAM.shown - c.shown).toBe(0); expect(scr.src).toBe(''); expect(live.size).toBe(0);
  frame(); await drain(); expect(L.CAM.shown - c.shown).toBe(1); expect(scr.src).toBe(L.camURL);
});

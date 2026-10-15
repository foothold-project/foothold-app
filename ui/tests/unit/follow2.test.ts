import { afterAll, beforeAll, expect, test, vi } from 'vitest';
// follow /2(RL FOLLOW-CONTRACT-v2 0b663d6c): 3인칭은 층·지도와 분리 — 결속 = run_id·epoch·world·building·mode.
// ① 순수 viewKey/followOf 반례 ② usePull 3인칭: 요청→검증→해독→표시 전 구간 in-flight 1개, 표시 직전 결속·seq/stamp 단조 재확인(지연 해독·RESET·역행)
let snap: any = {};
const asks: { ok: (v: any) => void }[] = [], decs: { ok: () => void; no: () => void }[] = [];
vi.mock('../../src/data/link', () => ({
  useLink: { getState: () => ({ ...snap, lastMsg: performance.now() }) },
  ask: () => new Promise((ok) => asks.push({ ok })),
}));
// usePull 을 DOM 없이 돌림: useEffect 즉시 실행, useState 의 setter 호출만 기록
const sets: any[] = [], top = () => sets[sets.length - 1];
vi.mock('react', () => ({ useState: (v: any) => [v, (x: any) => sets.push(x)], useEffect: (f: () => void) => { f(); } }));
(globalThis as any).createImageBitmap = () => new Promise((ok, no) => decs.push({ ok: () => ok({ close() {} }), no: () => no(new Error('bad')) }));
let V: typeof import('../../src/data/views');

const R = '0123456789abcdef'.repeat(2), RUN = { run_id: R, epoch: 1, world_id: 'v5_building', building_id: 'v5', mode: 'slam' };
const LM_TRANSIT = { st: 'wait', bound: false, world_id: 'v5_building', building_id: 'v5', floor_id: null, mode: 'slam', epoch: 1 };   // 층 이동 중: 지도 결속 닫힘
const S = (f: any = {}, st: any = {}, o: any = {}) => ({ provider: 'simulation_gate', open: true, lastMsg: 1000, gen: 7, ...o,
  st: { reset_pending: false, live_map: LM_TRANSIT, views: { points: null, follow: { st: 'ok', why: '', seq: 2, age_s: 0.2, run: RUN, ...f } }, ...st } }) as any;
const J = (o: any = {}) => ({ ...RUN, seq: 2, stamp_sim: 4, width: 320, height: 240, jpeg: '/9j/AAAA', ...o });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeAll(async () => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'performance'] }); V = await import('../../src/data/views'); });
afterAll(() => { vi.useRealTimers(); });

test('viewKey /2: 층 이동 중(지도 결속 닫힘)에도 실행 결속이면 유지, 형식·리셋·run null 이면 빈 결속', () => {
  const ok = V.viewKey(S(), 'follow', 1500);
  expect(ok.startsWith('2|')).toBe(true); expect(ok).toContain('#7');
  expect(V.viewKey(S(), 'points', 1500)).toBe('');                                   // 점군은 그대로 지도 결속(닫힘)
  for (const [f, st] of [[{ run: null }, {}], [{}, { reset_pending: true }], [{}, { reset_pending: undefined }], [{ run: { ...RUN, run_id: R.toUpperCase() } }, {}],
    [{ run: { ...RUN, run_id: R.slice(1) } }, {}], [{ run: { ...RUN, run_id: R + '\n' } }, {}], [{ run: { ...RUN, run_id: R + '\r\n' } }, {}], [{ run: { ...RUN, run_id: null } }, {}], [{ run: { ...RUN, epoch: true } }, {}], [{ run: { ...RUN, epoch: 0 } }, {}],
    [{ run: { ...RUN, mode: 'x' } }, {}], [{ st: 'stale' }, {}], [{ age_s: 3.5 }, {}], [{ seq: null }, {}]] as any[])
    expect(V.viewKey(S(f, st), 'follow', 1500)).toBe('');
  expect(V.viewKey(S({ run: null }, { live_map: { ...LM_TRANSIT, st: 'ok', bound: true, floor_id: 'l1' } }), 'follow', 1500)).toBe('');   // /2 결속 없음은 지도 결속이 살아 있어도 0(/1 로 떨어지지 않음)
  expect(V.viewKey(S({ run: { ...RUN, epoch: 2 } }), 'follow', 1500)).not.toBe(ok);   // 다른 회차·실행·세대 = 다른 결속
  expect(V.viewKey(S({ run: { ...RUN, run_id: 'f'.repeat(32) } }), 'follow', 1500)).not.toBe(ok);
  expect(V.viewKey(S({}, {}, { gen: 8 }), 'follow', 1500)).not.toBe(ok);
  const f1 = { st: 'ok', why: '', seq: 2, age_s: 0.2 };                               // run 칸 없음 = /1: 지도 결속 그대로(층 이동 중 닫힘)
  expect(V.viewKey(S(undefined, { views: { follow: f1 } }), 'follow', 1500)).toBe('');
});

test('followOf /2: 결속 키 5개가 같아야, 층 태그는 판단에 안 씀', () => {
  const b = V.viewKey(S(), 'follow', 1500);
  expect(V.followOf(J(), b, 2)?.seq).toBe(2);
  expect(V.followOf(J({ floor_state: 'transit', floor_id: null }), b, 2)?.seq).toBe(2);
  for (const bad of [J({ run_id: 'f'.repeat(32) }), J({ epoch: 2 }), J({ mode: 'static' }), J({ world_id: 'rooms_a' }), J({ seq: 1 }), J({ stamp_sim: '4' }), J({ jpeg: 'iVBOR' })])
    expect(V.followOf(bad, b, 2)).toBe(null);
});

test('usePull 3인칭: 해독 중엔 다음 요청 0(in-flight 1개), 표시 뒤 새 seq 만 요청', async () => {
  snap = S(); sets.length = 0;
  V.usePull('follow', true); expect(sets).toEqual([null]);
  vi.advanceTimersByTime(200); await flush(); expect(asks.length).toBe(1);
  asks.shift()!.ok({ ok: true, view: J() }); await flush(); expect(decs.length).toBe(1);
  vi.advanceTimersByTime(1000); await flush(); expect(asks.length).toBe(0);           // 해독 끝날 때까지 새 요청 0
  decs.shift()!.ok(); await flush(); expect(top()?.seq).toBe(2);
  vi.advanceTimersByTime(400); await flush(); expect(asks.length).toBe(0);            // 같은 seq 면 안 끌어옴
  snap = S({ seq: 3 }); vi.advanceTimersByTime(200); await flush(); expect(asks.length).toBe(1);
  asks.shift()!.ok({ ok: true, view: J({ seq: 3, stamp_sim: 5 }) }); await flush(); decs.shift()!.ok(); await flush();
  expect(top()?.seq).toBe(3);
});

test('usePull 반례: 지연 해독 중 RESET → 옛 그림 0 · stamp 역행/중복 → 안 넣음 · 해독 실패 → 안 넣음 · 새 회차는 seq 되감김 허용', async () => {
  // 지연 해독 + RESET
  snap = S({ seq: 4 }); vi.advanceTimersByTime(200); await flush();
  asks.shift()!.ok({ ok: true, view: J({ seq: 4, stamp_sim: 6 }) }); await flush();
  snap = S({ seq: 4 }, { reset_pending: true }); const n = sets.length;
  decs.shift()!.ok(); await flush(); expect(sets.length).toBe(n);                    // 결속 바뀜 → 표시 0
  vi.advanceTimersByTime(200); await flush(); expect(top()).toBe(null);         // 결속 없음 → 비움
  // 같은 결속 안 stamp 역행
  snap = S({ seq: 5 }); vi.advanceTimersByTime(200); await flush();
  asks.shift()!.ok({ ok: true, view: J({ seq: 5, stamp_sim: 7 }) }); await flush(); decs.shift()!.ok(); await flush(); expect(top()?.seq).toBe(5);
  snap = S({ seq: 6 }); vi.advanceTimersByTime(200); await flush();
  asks.shift()!.ok({ ok: true, view: J({ seq: 6, stamp_sim: 7 }) }); await flush(); decs.shift()!.ok(); await flush(); expect(top()?.seq).toBe(5);   // stamp 같음 → 안 넣음
  // 해독 실패
  snap = S({ seq: 7 }); vi.advanceTimersByTime(200); await flush();
  asks.shift()!.ok({ ok: true, view: J({ seq: 7, stamp_sim: 8 }) }); await flush(); decs.shift()!.no(); await flush(); expect(top()?.seq).toBe(5);
  // 응답이 요청보다 옛 seq
  snap = S({ seq: 8 }); vi.advanceTimersByTime(200); await flush();
  asks.shift()!.ok({ ok: true, view: J({ seq: 7, stamp_sim: 9 }) }); await flush(); expect(decs.length).toBe(0); expect(top()?.seq).toBe(5);
  // 새 회차: seq·stamp 1 부터 다시
  const R2 = { ...RUN, epoch: 2 }; snap = S({ seq: 1, run: R2 }); vi.advanceTimersByTime(200); await flush();
  asks.shift()!.ok({ ok: true, view: J({ ...R2, seq: 1, stamp_sim: 0.5 }) }); await flush(); decs.shift()!.ok(); await flush();
  expect(top()?.seq).toBe(1); expect(top()?.bind.startsWith('2|')).toBe(true);
  // 요청 중 다른 실행으로 바뀜 → 응답 버림
  snap = S({ seq: 2, run: R2 }); vi.advanceTimersByTime(200); await flush();
  snap = S({ seq: 1, run: { ...RUN, run_id: 'f'.repeat(32) } });
  asks.shift()!.ok({ ok: true, view: J({ ...R2, seq: 2, stamp_sim: 1 }) }); await flush(); expect(decs.length).toBe(0); expect(top()?.seq).toBe(1);
});

test('viewWhy /2: 지도 시뮬 실행 중이면 층·지도 상태와 무관하게 리셋·생산자 이유·받는 쪽 검사 순 · 원장 모름이면 먼저 «미확인»', () => {
  const run = { map_start: { session: { result: 'running', runner: 'live_map' } } };
  const W = (f: any, o: any = {}) => V.viewWhy({ ...S(f, o).st, ...run, ...o }, 'follow');
  expect(W({ why: '3인칭이 지금 실행·회차(run_id·epoch·world·모드)와 다름' })).toBe('받는 쪽 검사: 3인칭이 지금 실행·회차(run_id·epoch·world·모드)와 다름');
  expect(W({ run: null, why: '' })).toBe('받은 것 없음');                                       // 층 이동(지도 결속 닫힘)이어도 «지도 상태 기다림» 아님
  expect(W({}, { reset_pending: true })).toBe('리셋 중');
  expect(W({ prod: { reason: 'reset', n_pub: 3, enabled: true } })).not.toMatch(/받는 쪽|지도 상태/);
  expect(W({ prod: { reason: 'ok', n_pub: 3, enabled: false } })).toContain('외부카메라 끔');
  expect(V.viewWhy(S({ why: 'x' }).st, 'follow')).toBe('시뮬 실행 상태 미확인 — 메뉴의 상태 원값 확인');   // 격리 QA(원장 없음)에서 보인 문구
});

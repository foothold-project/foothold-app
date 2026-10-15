import { afterAll, beforeAll, expect, test, vi } from 'vitest';
// raw 라이다(RL POINTS-LIDAR-CONTRACT 652cf577): 센서 좌표 1 scan — 결속 = follow /2 와 같은 실행 키, 2 s 신선도, 부분 표시 0, 누적 0
let snap: any = {};
const asks: { ok: (v: any) => void }[] = [];
vi.mock('../../src/data/link', () => ({
  useLink: { getState: () => ({ ...snap, lastMsg: performance.now() }) },
  ask: () => new Promise((ok) => asks.push({ ok })),
}));
const sets: any[] = [], top = () => sets[sets.length - 1];
vi.mock('react', () => ({ useState: (v: any) => [v, (x: any) => sets.push(x)], useEffect: (f: () => void) => { f(); } }));
let V: typeof import('../../src/data/views');

const R = '0123456789abcdef'.repeat(2), RUN = { run_id: R, epoch: 1, world_id: 'v5_building', building_id: 'v5', mode: 'slam' };
const S = (l: any = {}, st: any = {}) => ({ provider: 'simulation_gate', open: true, lastMsg: 1000, gen: 3,
  st: { reset_pending: false, live_map: { st: 'wait', bound: false }, views: { points: null, follow: null, lidar: { st: 'ok', why: '', seq: 2, age_s: 0.3, run: RUN, ...l } }, ...st } }) as any;
const b64 = (a: number[]) => { const u = new Uint8Array(new Float32Array(a).buffer); let s = ''; u.forEach((c) => { s += String.fromCharCode(c); }); return btoa(s); };
const P = [1, 0.5, -0.2, 3, -1, 0.4];
// 서버 Views.lidar_why 응답 모양 그대로(고정칸 6 + 실행 키 + 값)
const J = (o: any = {}, pts = P) => ({ schema: 'v2_map/points_lidar/1', frame: 'lidar_link', source: 'gazebo_gpu_lidar', axes: 'x_forward_y_left_z_up', origin: 'lidar_sensor',
  encoding: 'xyz_f32le_b64', ...RUN, seq: 2, stamp_sim: 4, n: pts.length / 3, n_raw: pts.length / 3 + 5, truncated: false, voxel_m: 0.1, xyz: b64(pts), ...o });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeAll(async () => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'performance'] }); V = await import('../../src/data/views'); });
afterAll(() => { vi.useRealTimers(); });

test('viewKey lidar: 실행 결속만(지도 결속 닫혀도), 2 s 신선도, run null·리셋·형식 틀림·칸 없음 → 빈 결속', () => {
  const k = V.viewKey(S(), 'lidar', 1500); expect(k.startsWith('2|')).toBe(true);
  for (const [l, st] of [[{ run: null }, {}], [{}, { reset_pending: true }], [{ age_s: 2.1 }, {}], [{ st: 'stale' }, {}], [{ seq: null }, {}],
    [{ run: { ...RUN, run_id: R + '\n' } }, {}], [{ run: { ...RUN, epoch: true } }, {}], [{ run: { ...RUN, mode: 'x' } }, {}]] as any[])
    expect(V.viewKey(S(l, st), 'lidar', 1500)).toBe('');
  expect(V.viewKey(S(undefined, { views: { points: null, follow: null, lidar: null } }), 'lidar', 1500)).toBe('');   // 이전 서버(칸 없음)
  expect(V.viewKey(S({ run: { ...RUN, epoch: 2 } }), 'lidar', 1500)).not.toBe(k);
});

test('lidarOf: 서버 응답 양성 · 고정칸·정수(bool)·n_raw<n·voxel·stamp·xyz 유한/길이·다른 실행 반례는 프레임 통째 거부', () => {
  const b = V.viewKey(S(), 'lidar', 1500), ok = V.lidarOf(J(), b, 2)!;
  expect(ok.n).toBe(2); expect(Array.from(ok.xyz).map((v) => Math.round(v * 10) / 10)).toEqual(P); expect(ok.nRaw).toBe(7);
  for (const bad of [J({ frame: 'map' }), J({ source: 'x' }), J({ axes: 'x' }), J({ origin: 'robot' }), J({ encoding: 'x' }), J({ schema: 'v2_map/points_view/1' }), J({ frame: undefined }),
    J({ seq: true }), J({ seq: 1 }), J({ n: 3 }), J({ n: true }), J({ n_raw: 1 }), J({ truncated: 0 }), J({ voxel_m: 0 }), J({ voxel_m: '0.1' }), J({ stamp_sim: '4' }),
    J({ stamp_sim: NaN }), J({}, [1, NaN, 0]), J({}, [1, 5000, 0]), J({ xyz: 'AAAA' }), J({ xyz: '!'.repeat(32) }),
    J({ run_id: 'f'.repeat(32) }), J({ epoch: 2 }), J({ mode: 'static' }), J({ world_id: 'rooms_a' })])
    expect(V.lidarOf(bad, b, 2)).toBe(null);
});

test('usePull lidar: 2 Hz·요청 1개·새 seq 만, 1 scan 교체(누적 0), 역행·중복 안 넣음, 리셋 → 비움, 새 회차 되감김', async () => {
  snap = S(); sets.length = 0;
  V.usePull('lidar', true); expect(sets).toEqual([null]);
  vi.advanceTimersByTime(500); await flush(); expect(asks.length).toBe(1);
  vi.advanceTimersByTime(1500); await flush(); expect(asks.length).toBe(1);            // 응답 전 다음 요청 0
  asks.shift()!.ok({ ok: true, view: J() }); await flush(); expect(top().seq).toBe(2); expect(top().n).toBe(2);
  vi.advanceTimersByTime(500); await flush(); expect(asks.length).toBe(0);              // 같은 seq 면 안 끌어옴
  snap = S({ seq: 3 }); vi.advanceTimersByTime(500); await flush();
  asks.shift()!.ok({ ok: true, view: J({ seq: 3, stamp_sim: 4 }) }); await flush(); expect(top().seq).toBe(2);   // stamp 같음 → 안 넣음
  snap = S({ seq: 4 }); vi.advanceTimersByTime(500); await flush();
  asks.shift()!.ok({ ok: true, view: J({ seq: 4, stamp_sim: 5 }, [2, 2, 0]) }); await flush(); expect(top().seq).toBe(4); expect(top().n).toBe(1);   // 교체(앞 scan 점 안 남음)
  snap = S({ seq: 5 }); vi.advanceTimersByTime(500); await flush();
  snap = S({ seq: 5 }, { reset_pending: true });
  asks.shift()!.ok({ ok: true, view: J({ seq: 5, stamp_sim: 6 }) }); await flush(); expect(top().seq).toBe(4);   // 요청 중 리셋 → 응답 버림
  vi.advanceTimersByTime(500); await flush(); expect(top()).toBe(null);                // 결속 없음 → 비움
  const R2 = { ...RUN, epoch: 2 }; snap = S({ seq: 1, run: R2 }); vi.advanceTimersByTime(500); await flush();
  asks.shift()!.ok({ ok: true, view: J({ ...R2, seq: 1, stamp_sim: 0.5 }) }); await flush(); expect(top().seq).toBe(1);
});

test('viewWhy lidar: 지도 상태와 무관 — 리셋·생산자 이유·받는 쪽 검사, 칸 없는 이전 서버는 그 사실', () => {
  const run = { map_start: { session: { result: 'running', runner: 'live_map' } } };
  const W = (l: any, o: any = {}) => V.viewWhy({ ...S(l, o).st, ...run, ...o }, 'lidar');
  expect(W({ st: 'bad', why: '라이다가 지금 실행·회차(run_id·epoch·world·모드)와 다름' })).toBe('받는 쪽 검사: 라이다가 지금 실행·회차(run_id·epoch·world·모드)와 다름');
  expect(W({}, { reset_pending: true })).toBe('리셋 중');
  expect(W({ prod: { reason: 'wrong_frame', n_pub: 2, enabled: null } })).toBe('좌표계(frame) 틀림 — 기록 확인');
  expect(W({ prod: { reason: 'zzz', n_pub: 0, enabled: null } })).toBe('발행 쪽 이유 코드 모름 — 기록 확인 (이번 기동 발행 0)');
  expect(W(undefined, { views: { points: null, follow: null, lidar: null } })).toBe('이 서버 판은 라이다 원자료(센서 기준)를 안 줌');
});

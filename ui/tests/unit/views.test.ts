import { beforeEach, expect, test, vi } from 'vitest';
// 보조 관제 뷰(views.ts): 결속(viewKey)·점군 누적 거부/비움·3인칭 응답 검사 — 순수 함수만(link 는 가짜)
vi.mock('../../src/data/link', () => ({ useLink: { getState: () => ({}) }, ask: async () => ({ ok: false }) }));
const V = await import('../../src/data/views');

const K = { world_id: 'rooms_a', building_id: 'rooms_a', floor_id: 'f1', mode: 'slam', map_source: 'slam', map_version: null, epoch: 3 };
const snap = (o: any = {}, st: any = {}) => ({ provider: 'simulation_gate', open: true, lastMsg: 1000, gen: 7, ...o,
  st: { live_map: { st: 'ok', ...K }, views: { points: { st: 'ok', why: '', seq: 5, age_s: 0.4 }, follow: { st: 'ok', why: '', seq: 2, age_s: 0.2 } }, ...st } }) as any;
const b64 = (f: number[]) => btoa(String.fromCharCode(...new Uint8Array(new Float32Array(f).buffer)));
const pv = (o: any = {}) => ({ ...K, seq: 5, stamp_sim: 10, n: 2, xyz: b64([0, 0, 0, 1, 1, 1]), base_pose_map: { x: 0, y: 0, z: 0.3, yaw: 0.1 }, ...o });

beforeEach(() => V.clearCloud());

test('viewKey: 대상·열림·1 s 신선도·live_map ok·뷰 ok/age/seq 하나라도 아니면 빈 결속', () => {
  const ok = V.viewKey(snap(), 'points', 1500);
  expect(ok).toContain('#7');
  for (const [o, st, now] of [[{ provider: 'go2_direct' }, {}, 1500], [{ open: false }, {}, 1500], [{}, {}, 2001], [{ lastMsg: 0 }, {}, 1500],
    [{}, { live_map: { st: 'wait', ...K } }, 1500], [{}, { views: { points: { st: 'stale', seq: 5, age_s: 4 } } }, 1500],
    [{}, { views: { points: { st: 'ok', seq: 5, age_s: 3.5 } } }, 1500], [{}, { views: { points: { st: 'ok', seq: null, age_s: 0 } } }, 1500], [{}, { views: null }, 1500],
    [{}, { views: { points: { st: 'ok', seq: 5, age_s: -0.1 } } }, 1500], [{}, { views: { points: { st: 'ok', seq: 5, age_s: NaN } } }, 1500],
    [{}, { views: { points: { st: 'ok', seq: 0, age_s: 0.1 } } }, 1500], [{}, { views: { points: { st: 'ok', seq: 5, age_s: '0.1' } } }, 1500]] as any[])
    expect(V.viewKey(snap(o, st), 'points', now)).toBe('');
  expect(V.viewKey(snap({ gen: 8 }), 'points', 1500)).not.toBe(ok);   // 세대가 바뀌면 다른 결속
});

test('addCloud: 정상 누적·같은 칸 중복 0·키/세대 바뀜 비움', () => {
  const b = V.viewKey(snap(), 'points', 1500);
  expect(V.addCloud(pv(), b)).toBe(true); expect(V.CLOUD.n).toBe(2); expect(V.CLOUD.pose?.yaw).toBe(0.1);
  expect(V.addCloud(pv({ seq: 6, stamp_sim: 11, xyz: b64([0.01, 0.02, 0.03, 5, 5, 5]) }), b)).toBe(true); expect(V.CLOUD.n).toBe(3);   // 0.0,0,0 칸 중복
  expect(V.addCloud(pv({ seq: 7, stamp_sim: 12 }), V.viewKey(snap({ gen: 8 }), 'points', 1500))).toBe(true); expect(V.CLOUD.n).toBe(2);   // 새 세대 = 비우고 새로
  expect(V.addCloud(pv({ seq: 8, stamp_sim: 13, epoch: 4 }), V.viewKey(snap({ gen: 8 }), 'points', 1500))).toBe(false);                 // 응답 epoch ≠ 결속
  expect(V.CLOUD.n).toBe(0); expect(V.CLOUD.pose).toBe(null);
});

test('addCloud 반례: 옛 seq·stamp 역행·길이·비유한·범위 밖 큰 좌표·자세 → 거부(누적 그대로)', () => {
  const b = V.viewKey(snap(), 'points', 1500);
  V.addCloud(pv(), b); const n0 = V.CLOUD.n, ver = V.CLOUD.ver;
  for (const bad of [pv({ seq: 5 }), pv({ seq: 6, stamp_sim: 9 }), pv({ seq: 6, stamp_sim: 11, n: 3 }), pv({ seq: 6, stamp_sim: 11, xyz: b64([0, 0, 0, NaN, 0, 0]) }),
    pv({ seq: 6, stamp_sim: 11, xyz: b64([0, 0, 0, 1e20, 0, 0]) }), pv({ seq: 6, stamp_sim: 11, xyz: b64([0, 0, 0, 3001, 0, 0]) }),
    pv({ seq: 6, stamp_sim: 11, n: 4001 }), pv({ seq: 6, stamp_sim: 11, xyz: 'not base64!!!!!!!!!!!!!!!!!!!!!' }),
    pv({ seq: 6, stamp_sim: 11, base_pose_map: { x: 0, y: 0, z: 0, yaw: '0' } }), pv({ seq: 6, stamp_sim: 11, base_pose_map: { x: 1e9, y: 0, z: 0, yaw: 0 } }),
    pv({ seq: 6.5, stamp_sim: 11 })])
    expect(V.addCloud(bad, b)).toBe(false);
  expect(V.CLOUD.n).toBe(n0); expect(V.CLOUD.ver).toBe(ver);
  expect(V.addCloud(pv({ seq: 6, stamp_sim: 11, xyz: b64([2999, -2999, 0, 1, 1, 1]) }), b)).toBe(true);   // 범위 끝은 받음
});

test('followOf: 결속 키·seq ≥ 요청·JPEG base64 머리만 채택', () => {
  const b = V.viewKey(snap(), 'follow', 1500), J = { ...K, seq: 2, stamp_sim: 4, jpeg: '/9j/AAAA' };
  expect(V.followOf(J, b, 2)?.url).toBe('data:image/jpeg;base64,/9j/AAAA');
  for (const bad of [{ ...J, epoch: 2 }, { ...J, seq: 1 }, { ...J, jpeg: 'iVBORw0K' }, { ...J, seq: '2' }, { ...J, jpeg: 5 }, { ...J, stamp_sim: NaN }, { ...J, stamp_sim: undefined }, null])
    expect(V.followOf(bad, b, 2)).toBe(null);
  expect(V.followOf(J, '', 2)).toBe(null);
});

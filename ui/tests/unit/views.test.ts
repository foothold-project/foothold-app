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
  expect(V.viewKey(snap({}, { live_map: { st: 'ok', ...K, floor_rev: 2 } }), 'points', 1500)).not.toBe(ok);   // 연결 건물 층 세대가 바뀌면 다른 결속
  // 10-15: 결속은 live_map.bound(상태 수준) — 격자만 기다림(st wait·bound true)이면 점군·3인칭 유지, bound false 면 st ok 여도 끊음. 옛 서버(bound 없음)는 st ok
  expect(V.viewKey(snap({}, { live_map: { st: 'wait', bound: true, ...K } }), 'points', 1500)).toBe(ok);
  for (const lm of [{ st: 'ok', bound: false, ...K }, { st: 'wait', ...K }, { st: 'ok', bound: 'yes', ...K }, { st: 'reset', bound: false, ...K }])
    expect(V.viewKey(snap({}, { live_map: lm }), 'points', 1500)).toBe('');
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

test('viewWhy: 분기마다 반례 1개(미확인·꺼짐·평지·종류 미확인·시작 중·외부카메라 끔·지도 기다림·저장 SLAM·발행 이유·link 이유) — 고장·출력 보장 단정 0', () => {
  const S = (result: any, runner: any, o: any = {}) => ({ map_start: { session: result === undefined ? null : { result, runner } }, live_map: { st: 'ok', ...K }, ...o });
  const vw = (k: string, prod: any, why = '받은 것 없음') => ({ views: { [k]: { st: 'off', why, seq: null, age_s: null, prod } } });
  const out: string[] = [];
  const W = (st: any, k: 'points' | 'follow') => { const x = V.viewWhy(st, k); out.push(x); return x; };
  expect(W(S(undefined, null), 'points')).toMatch(/^시뮬 실행 상태 미확인/);                    // 세션 없음 → 꺼짐/평지 단정 0
  expect(W(S('unknown', 'live_map'), 'follow')).toMatch(/^시뮬 실행 상태 미확인/);
  expect(W(S('idle', 'live_map'), 'follow')).toBe('시뮬 꺼짐 — «지도 열기»에서 지도 시뮬(라이다 포함) 선택 · «외부카메라» 체크');   // 지난 런 runner 가 남아도 지금 꺼짐
  expect(W(S('running', 'ux_flat'), 'points')).toMatch(/^평지 시뮬에는/);
  expect(W(S('running', 'unknown'), 'points')).toMatch(/^실행 중인 시뮬 종류 미확인/);
  expect(W(S('starting', 'live_map'), 'follow')).toBe('지도 시뮬 시작 중');
  expect(W(S('running', 'live_map', vw('follow', { reason: 'no_frame', n_pub: 0, enabled: false })), 'follow')).toMatch(/외부카메라 끔/);
  expect(W(S('running', 'live_map', { live_map: { st: 'wait', why: '이번 epoch 지도 기다림' } }), 'points')).toBe('지도 상태 기다림 — 이번 epoch 지도 기다림');
  const saved = { live_map: { st: 'ok', ...K, mode: 'static', map_source: 'slam', map_version: '20261014-173008-e1' } };
  expect(W(S('running', 'live_map', { ...saved, ...vw('points', { reason: 'not_localized', n_pub: 0, enabled: null }) }), 'points')).toBe('저장 SLAM 지도는 위치추정 미연결 — 점군 위치 표시 불가');
  expect(W(S('running', 'live_map', vw('points', { reason: 'not_localized', n_pub: 0, enabled: null })), 'points')).toBe('위치 결속 미확인 — 기록 확인 (이번 기동 발행 0)');
  expect(W(S('running', 'live_map', vw('follow', { reason: 'sim_t_unknown', n_pub: 0, enabled: true })), 'follow')).toBe('발행 쪽이 시뮬 시각을 못 읽음 — 계속되면 기록 확인 (이번 기동 발행 0)');
  expect(W(S('running', 'live_map', vw('points', { reason: 'zzz', n_pub: null, enabled: null })), 'points')).toMatch(/코드 모름/);
  expect(W(S('running', 'live_map', vw('points', { reason: 'ok', n_pub: 5, enabled: null }, '점군이 지금 지도(world·층·모드·epoch)와 다름')), 'points')).toMatch(/^받는 쪽 검사: 점군이/);
  expect(W(S('running', 'live_map', vw('points', null)), 'points')).toBe('받는 쪽 검사: 받은 것 없음');   // 이전 서버(prod 없음)
  for (const x of out) expect(x).not.toMatch(/고장|움직이면|나옴/);
});

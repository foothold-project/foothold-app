// 지도 열기 문구·상태(10-14): 화면 이름·실행 중 한 줄·다음 행동·높이 화소 해석·Quad 누름 판정
import { expect, test, vi } from 'vitest';
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {} }));
import { liveLabel, place, runAt, runLine, relM } from '../../src/data/maps';
import { nextStep } from '../../src/map/MapStartBox';
import { tapOk } from '../../src/app/Quad';

test('place: 단층은 지형 이름만, 2층 건물만 층, 모르는 id 는 그대로', () => {
  expect(place('v5_single', 'f1')).toBe('1층 건물');
  expect(place('v5_building', 'l2')).toBe('2층 건물 · 2층');
  expect(place('rooms_a', 'f1')).toBe('새 매핑 공간');
  expect(place('zz', 'f9')).toBe('zz/f9');
});

test('runLine·runAt: 지금 열린 지형·층·작업, 고른 것과 별개', () => {
  const s = { runner: 'live_map', result: 'running', world_id: 'v5_building', floor_id: 'l1', map_mode: 'static', remaining_s: 600 };
  expect(runLine(s)).toBe('2층 건물 · 1층 · 저장한 지도로 실행 · 실행 중 · 남은 10분');
  expect(runAt(s)).toEqual(['v5', 'l1']);
  expect(runAt({ ...s, result: 'stopped' })).toBeNull();
  expect(runLine({ runner: 'ux_flat', result: 'running' })).toContain('평지 시뮬');
  expect(runAt({ runner: 'ux_flat', result: 'running' })).toBeNull();
  expect(runLine(null)).toContain('꺼짐');
  expect(runLine(s)).not.toMatch(/v5|l1|v2_map/);   // 기본 화면에 내부 id 0
});

test('nextStep: 이유별 다음 행동, 모르는 이유는 추측 0', () => {
  expect(nextStep('Gazebo 가 이미 켜짐 — 끈 뒤 다시')).toContain('Gazebo 끄기');
  expect(nextStep('방금 요청함 — 87 s 뒤')).toContain('120 s');
  expect(nextStep('로그인한 기기에서만(관문 경유)')).toContain('로그인');
  expect(nextStep('뭔가 새 이유')).toBe('위 서버 이유를 확인한 뒤 다시');
  expect(nextStep('')).toBe('');
});

test('relM: 0 = 모름(가짜 높이 0), (v-1)/1000 - 1', () => {
  expect(relM(0, 0)).toBeNull();
  expect(relM(0x03, 0xE9)).toBeCloseTo(0, 9);       // v=1001
  expect(relM(0x00, 0x01)).toBeCloseTo(-1, 9);
  expect(relM(0x0A, 0x8D)).toBeCloseTo(1.7, 9);      // v=2701
});

test('Quad tapOk: 누적 >6 px 면 원점 복귀해도 무효, bad·두 손가락 무효', () => {
  expect(tapOk({ max: 0, bad: false }, 0, 0, 0)).toBe(true);
  expect(tapOk({ max: 7, bad: false }, 0, 0, 0)).toBe(false);   // 끌었다 원점
  expect(tapOk({ max: 0, bad: false }, 7, 0, 0)).toBe(false);   // 떼는 순간 이동
  expect(tapOk({ max: 0, bad: true }, 0, 0, 0)).toBe(false);    // SKIP·cancel·오른쪽 버튼
  expect(tapOk({ max: 0, bad: false }, 0, 0, 1)).toBe(false);   // 다른 손가락 남음
});

import { saveVerdict } from '../../src/map/MapStartBox';
import { groupMaps, verLabel } from '../../src/data/maps';
const MI = (o: Record<string, unknown> = {}) => ({ world_id: 'v5_building', building_id: 'v5', floor_id: 'l1', map_version: '20261014-170000-e2', map_source: 'slam', epoch: 2,
  resolution: 0.05, origin: [-20, -14, 0], width: 800, height: 640, saved_sim_t: 1, ...o }) as any;

test('saveVerdict: 요청 때 출처로 대조 · epoch 바뀜/다른 층/화면 이탈 뒤 늦은 응답은 지금 지도 성공 0', () => {
  const req = { world_id: 'v5_building', building_id: 'v5', floor_id: 'l1', epoch: 2, floor_rev: null, gen: 4 }, r = { ok: true, text: '지도 저장됨 · 20261014-170000-e2' };
  const a = saveVerdict(req, r, [MI()], req, 't');
  expect(a).toMatchObject({ ok: true, key: 'v5/l1/20261014-170000-e2' });
  const b = saveVerdict(req, r, [MI()], { ...req, epoch: 3 }, 't');                       // 응답 사이 epoch 바뀜(늦은 응답)
  expect(b.ok).toBe(false); expect(b.text).toContain('요청 때 지도'); expect(b.key).toBe('v5/l1/20261014-170000-e2');
  expect(saveVerdict(req, r, [MI()], { ...req, gen: 5 }, 't').ok).toBe(false);             // 화면 이탈·재연결 뒤 도착
  { const x = saveVerdict(req, r, [MI({ floor_id: 'l2' })], req, 't'); expect(x.ok).toBe(false); expect(x.key).toBeUndefined(); }   // 같은 버전 다른 층 = hit 0
  expect(saveVerdict(req, r, '목록 실패', req, 't').ok).toBe(false);
  { const x = saveVerdict(req, { ok: false, text: '지도 저장 결과 미확인 · 10 s' }, [MI()], req, 't'); expect(x.ok).toBe(false); expect(x.key).toBeUndefined(); }
});

test('saveVerdict: 연결 건물은 서버 확인 응답 문맥(save)이 요청 문맥과 정확히 같을 때만 성공', () => {
  const req = { world_id: 'v5_building', building_id: 'v5', floor_id: 'l2', epoch: 4, floor_rev: 3, gen: 4 }, V = '20261015-010000-e4';
  const sv = { world_id: 'v5_building', building_id: 'v5', floor_id: 'l2', epoch: 4, floor_rev: 3, map_version: V }, L = [MI({ floor_id: 'l2', map_version: V, epoch: 4 })];
  expect(saveVerdict(req, { ok: true, text: `지도 저장됨 · ${V}`, save: sv }, L, req, 't')).toMatchObject({ ok: true, key: `v5/l2/${V}` });
  expect(saveVerdict(req, { ok: true, text: `지도 저장됨 · ${V}` }, L, req, 't').ok).toBe(false);                       // 문맥 없는 성공 = 미확인
  for (const o of [{ floor_id: 'l1' }, { floor_rev: 2 }, { epoch: 5 }, { map_version: null }])
    expect(saveVerdict(req, { ok: true, text: `지도 저장됨 · ${V}`, save: { ...sv, ...o } }, L, req, 't').ok, JSON.stringify(o)).toBe(false);
  expect(saveVerdict(req, { ok: true, text: `지도 저장됨 · ${V}`, save: sv }, L, { ...req, floor_rev: 4 }, 't').ok).toBe(false);   // 응답 사이 층 세대 바뀜
});

test('groupMaps: 지형 → 층 → 버전, 2층 건물만 층 표시', () => {
  const g = groupMaps([MI({ floor_id: 'l2' }), MI({ world_id: 'v5_single', building_id: 'v5_single', floor_id: 'f1', map_source: 'gt_raster', epoch: null, map_version: 'gt-20261012' }), MI()]);
  expect(g.map((x) => x.label)).toEqual(['1층 건물', '2층 건물']);
  expect(g[1].items.map((m) => m.floor_id)).toEqual(['l1', 'l2']);
  expect(verLabel(g[1].items[0])).toBe('1층 · 저장한 지도 · 20261014-170000-e2');
  expect(verLabel(g[0].items[0])).toBe('시뮬 도면 지도 · gt-20261012');
});

import { allKey, gtFloors } from '../../src/data/maps';
test('gtFloors: 2층 건물 층 나란히 보기 = 층마다 GT 1장 · 원점·크기 같을 때만 · 단층·GT 빠진 층·좌표 다름은 이유', () => {
  const G = (f: string, o: Record<string, unknown> = {}) => MI({ floor_id: f, map_source: 'gt_raster', epoch: null, map_version: 'gt-20261014', ...o });
  const r = gtFloors([MI({ floor_id: 'l2' }), G('l2'), G('l1')], 'v5_building');
  expect(Array.isArray(r) && r.map((m) => [m.floor_id, m.map_source])).toEqual([['l1', 'gt_raster'], ['l2', 'gt_raster']]);   // 아래층부터 · SLAM 저장본 제외
  expect(gtFloors([G('l1'), MI({ floor_id: 'l2' })], 'v5_building')).toBe('GT 기하 지도 없는 층: 2층');
  expect(gtFloors([G('l1'), G('l2', { origin: [-19, -14, 0] })], 'v5_building')).toContain('달라');
  expect(gtFloors([G('l1')], 'v5_single')).toContain('하나뿐');
  expect(allKey('v5_building')).toBe('all:v5_building');
  expect(allKey('v5_building').split('/').length).toBe(1);   // 저장본 키(건물/층/버전)와 안 겹침
});

test('liveShow(10-15 갱신 보유): 같은 K·세대만, 앞선 seq 는 검증 시각 + HOLD_MS 까지 held, 경계는 즉시 null', async () => {
  const { liveShow, HOLD_MS } = await import('../../src/data/maps');
  const b = { k: 'K', seq: 5, gen: 7, t: 1000 };
  expect(liveShow(b, 'K', 5, 7, true, false, 1000)).toBe('show');
  expect(liveShow(b, 'K', 5, 7, true, true, 1000)).toBe('held');                 // 서버 보유(grid.upd) → 마커 0
  expect(liveShow(b, 'K', 6, 7, true, false, 1000 + HOLD_MS)).toBe('held');      // 새 seq 해독 중 — 시한 안
  expect(liveShow(b, 'K', 6, 7, true, false, 1001 + HOLD_MS)).toBe(null);        // 시한 지남(반복 status 로 연장 0 — 시계는 b.t 하나)
  for (const [k, seq, gen, fresh] of [['K2', 6, 7, true], ['K', 6, 8, true], ['K', 6, 7, false], [null, null, 7, true], ['K', 4, 7, true]] as any[])
    expect(liveShow(b, k, seq, gen, fresh, false, 1000)).toBe(null);             // K·세대·끊김·st≠ok·seq 역행
  expect(liveShow(null, 'K', 5, 7, true, false, 1000)).toBe(null);
  expect(liveShow(b, 'K', 6, 7, true, false, 999)).toBe(null);                   // 시계 역행 = 보유 0
});

test('liveLabel(10-18): 출처는 서버 mode·map_source 둘 다 — static+저장 slam 을 «실시간 매핑»으로 쓰지 않음', () => {
  const v = { st: 'ok', why: '', world_id: 'v5_building', floor_id: 'l1' } as any;
  expect(liveLabel({ ...v, mode: 'slam', map_source: 'slam' })).toBe('현재 열린 지도 · 2층 건물 · 1층 · SLAM 실시간 매핑');
  expect(liveLabel({ ...v, mode: 'static', map_source: 'slam', map_version: '20260101-000000-e1' })).toBe('현재 열린 지도 · 2층 건물 · 1층 · 저장한 지도 보기(위치 없음) · 20260101-000000-e1');
  expect(liveLabel({ ...v, mode: 'static', map_source: 'slam', map_version: null })).toBe('현재 열린 지도 · 2층 건물 · 1층 · 저장한 지도 보기(위치 없음)');
  expect(liveLabel({ ...v, mode: 'static', map_source: 'gt_raster' })).toContain('시뮬 도면 지도');
  expect(liveLabel({ ...v, mode: null, map_source: 'slam' })).toContain('지도 출처 미확인');
});

import { staticSeen } from '../../src/data/maps';
test('staticSeen(10-18 P2-3): 저장 그림 보기 = live_map ok·static·slam·세션과 같은 world/floor 수신 때만 · 시작 중/미수신/다른 층 = 확인 전 · GT static ≠ 저장', () => {
  const ss = (o: object = {}) => ({ runner: 'live_map', result: 'running', world_id: 'v5_building', floor_id: 'l1', map_mode: 'static', ...o });
  const lv = (o: object = {}) => ({ st: 'ok' as const, why: '', world_id: 'v5_building' as const, floor_id: 'l1' as const, mode: 'static' as const, map_source: 'slam' as const, ...o });
  expect(staticSeen(ss(), lv())).toBe('saved');                                          // 양성
  expect(staticSeen(ss({ result: 'starting' }), lv())).toBe('saved');                    // 수신이 기준(세션 글자 아님)
  expect(staticSeen(ss({ result: 'starting' }), null)).toBe('wait');                     // 요청 수락·시작 중 ≠ 준비
  expect(staticSeen(ss(), lv({ st: 'wait' }))).toBe('wait');
  expect(staticSeen(ss(), lv({ map_source: undefined }))).toBe('wait');                  // 출처 미수신(옛 판은 저장 보기로 단정)
  expect(staticSeen(ss(), lv({ mode: 'slam' }))).toBe('wait');
  expect(staticSeen(ss(), lv({ floor_id: 'l2' }))).toBe('wait');                         // 세션과 다른 층
  expect(staticSeen(ss(), lv({ world_id: 'rooms_a' }))).toBe('wait');
  expect(staticSeen(ss(), lv({ map_source: 'gt_raster' }))).toBe('gt');                  // 옛 앱 static GT — SLAM 그림 한계 줄 0
  expect(staticSeen(ss({ map_mode: 'slam' }), lv({ mode: 'slam' }))).toBeNull();
  expect(staticSeen(ss({ result: 'stopped' }), lv())).toBeNull();
  expect(staticSeen(null, lv())).toBeNull();
});

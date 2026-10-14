// 지도 열기 문구·상태(10-14): 화면 이름·실행 중 한 줄·다음 행동·높이 화소 해석·Quad 누름 판정
import { expect, test, vi } from 'vitest';
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {} }));
import { place, runAt, runLine, relM } from '../../src/data/maps';
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
  expect(runLine(s)).toBe('2층 건물 · 1층 · 저장 지도로 시뮬 열기(SLAM 생성 없음) · 실행 중 · 남은 10분');
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
  const req = { world_id: 'v5_building', building_id: 'v5', floor_id: 'l1', epoch: 2, gen: 4 }, r = { ok: true, text: '지도 저장됨 · 20261014-170000-e2' };
  const a = saveVerdict(req, r, [MI()], req, 't');
  expect(a).toMatchObject({ ok: true, key: 'v5/l1/20261014-170000-e2' });
  const b = saveVerdict(req, r, [MI()], { ...req, epoch: 3 }, 't');                       // 응답 사이 epoch 바뀜(늦은 응답)
  expect(b.ok).toBe(false); expect(b.text).toContain('요청 때 지도'); expect(b.key).toBe('v5/l1/20261014-170000-e2');
  expect(saveVerdict(req, r, [MI()], { ...req, gen: 5 }, 't').ok).toBe(false);             // 화면 이탈·재연결 뒤 도착
  { const x = saveVerdict(req, r, [MI({ floor_id: 'l2' })], req, 't'); expect(x.ok).toBe(false); expect(x.key).toBeUndefined(); }   // 같은 버전 다른 층 = hit 0
  expect(saveVerdict(req, r, '목록 실패', req, 't').ok).toBe(false);
  { const x = saveVerdict(req, { ok: false, text: '지도 저장 결과 미확인 · 10 s' }, [MI()], req, 't'); expect(x.ok).toBe(false); expect(x.key).toBeUndefined(); }
});

test('groupMaps: 지형 → 층 → 버전, 2층 건물만 층 표시', () => {
  const g = groupMaps([MI({ floor_id: 'l2' }), MI({ world_id: 'v5_single', building_id: 'v5_single', floor_id: 'f1', map_source: 'gt_raster', epoch: null, map_version: 'gt-20261012' }), MI()]);
  expect(g.map((x) => x.label)).toEqual(['1층 건물', '2층 건물']);
  expect(g[1].items.map((m) => m.floor_id)).toEqual(['l1', 'l2']);
  expect(verLabel(g[1].items[0])).toBe('1층 · SLAM 저장 지도 · 20261014-170000-e2');
  expect(verLabel(g[0].items[0])).toBe('GT 기하 지도(SLAM 아님) · gt-20261012');
});

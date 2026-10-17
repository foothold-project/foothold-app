// 건물 전체 3D(GT 간략 기하, 10-14): 형식 엄격 검사·world 결속·층 강조/위층 숨김
import { expect, test, vi } from 'vitest';
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {} }));
import { geomBind, okGeom } from '../../src/data/geom';
import { shown } from '../../src/map/Geom3D';

const S1 = 'a'.repeat(64), S2 = 'b'.repeat(64);
const box = { id: 'b1', floor_id: 'l1', kind: 'floor', approximation: 'exact_box', corners: Array.from({ length: 8 }, (_, i) => [i & 4 ? 1 : 0, i & 2 ? 1 : 0, i & 1 ? 0.1 : 0]), aabb: [0, 0, 0, 1, 1, 0.1] };
const G = () => ({ schema: 'v2_building_geom/1', building_id: 'v5', world_id: 'v5_building', frame: 'world', source: 'gt_sdf', sensor: false, precision_claim: false, label: 'L',
  sdf_sha256: { l1: S1, l2: S2 }, floors: [{ floor_id: 'l1', z: 0 }, { floor_id: 'l2', z: 2.4 }], boxes: [structuredClone(box)],
  meshes: [{ id: 'ramp', floor_id: null, kind: 'ramp', approximation: 'aabb', aabb: [0, 0, 0, 2, 1, 1], fill: false }],
  connectors: [{ id: 'st', kind: 'stair', from: 'l1', to: 'l2', entry: [3, 4, 0], exit: [7.8, 4, 2.4], traversable_claim: false }] });

test('okGeom: 정상은 통과, 하나라도 어긋나면 통째로 버림', () => {
  expect(typeof okGeom(G(), 'v5')).toBe('object');
  const bad: [string, (g: any) => void][] = [
    ['schema', (g) => { g.schema = 'x'; }], ['building', (g) => { g.building_id = 'v4'; }], ['sensor', (g) => { g.sensor = true; }],
    ['sha', (g) => { g.sdf_sha256.l2 = 'zz'; }], ['corners', (g) => { g.boxes[0].corners.pop(); }], ['aabb', (g) => { g.boxes[0].aabb = [1, 0, 0, 0, 1, 1]; }],
    ['floor', (g) => { g.boxes[0].floor_id = 'l9'; }], ['nan', (g) => { g.boxes[0].corners[0][0] = NaN; }],
    ['mesh fill', (g) => { g.meshes[0].fill = true; }], ['통과 주장', (g) => { g.connectors[0].traversable_claim = true; }],
    ['상자 수', (g) => { g.boxes = Array(2001).fill(box); }],
    ['world', (g) => { g.world_id = 'v5_single'; }], ['층 중복', (g) => { g.floors.push({ floor_id: 'l1', z: 5 }); }], ['kind', (g) => { g.boxes[0].kind = 'door'; }],
    ['좌표 범위', (g) => { g.boxes[0].corners[0][0] = 501; }], ['연결 수', (g) => { g.connectors = Array(33).fill(g.connectors[0]); }], ['mesh 수', (g) => { g.meshes = Array(65).fill(g.meshes[0]); }],
    ['sha 층 더', (g) => { g.sdf_sha256.l3 = S1; }],
  ];
  for (const [n, f] of bad) { const g = G(); f(g); expect(typeof okGeom(g, 'v5'), n).toBe('string'); }
});

test('geomBind: 기동 층(spawn_floor) 원본 SDF sha 로만 결속, 같은 world 미확인·불일치는 그리지 않을 이유', () => {
  const g = okGeom(G(), 'v5') as any, F = 'c'.repeat(64), W = 'v5_building';
  const lv = (o: object = {}) => ({ st: 'ok', world_id: W, spawn_floor: 'l2', world_src_sha256: S2, geom: { sha256: F }, ...o });
  expect(geomBind(g, F, null, lv(), W)).toBe('');                       // 이 건물 런 없음 → GT 미리보기
  expect(geomBind(g, F, 'v5_single', lv(), W)).toBe('');
  expect(geomBind(g, F, W, lv(), W)).toBe('ok');
  expect(geomBind(g, F, W, lv({ geom: null }), W)).toBe('ok');          // 기하 파일 sha 는 서버가 줄 때만 대조
  expect(geomBind(g, F, W, lv({ world_src_sha256: S1 }), W)).toMatch(/다름/);
  expect(geomBind(g, F, W, lv({ geom: { sha256: 'd'.repeat(64) } }), W)).toMatch(/다름/);
  expect(geomBind(g, F, W, lv({ spawn_floor: null }), W)).toMatch(/미확인/);
  expect(geomBind(g, F, W, lv({ world_src_sha256: undefined }), W)).toMatch(/미확인/);
  expect(geomBind(g, F, W, lv({ st: 'stale' }), W)).toMatch(/미확인/);
  expect(geomBind(g, F, W, lv({ st: 'unknown' }), W)).toMatch(/미확인/);
  expect(geomBind(g, F, W, lv({ st: 'wait', floor_id: undefined, floor: { state: 'transit' } }), W)).toBe('ok');   // K 없는 층 이동 중도 신원 칸 맞으면 같은 건물 3D 유지(SLAM·로봇 0)
  expect(geomBind(g, F, W, null, W)).toMatch(/미확인/);
});

test('shown·floorCol(10-15 층 색): 전체 = 모든 층 보임·공통 구조 흐림, 층만 = 다른 층 0, 색은 floor_id 정본만(null·모르는 id = 중립)', async () => {
  const { floorCol } = await import('../../src/map/Geom3D');
  const F = [{ floor_id: 'l2', z: 2.4 }, { floor_id: 'l1', z: 0 }];   // 순서 뒤섞임 — 색은 높이순
  expect(shown('l1', 0, 'all', F)).toBeGreaterThan(shown(null, 0, 'all', F)); expect(shown('l2', 2.4, 'all', F)).toBeGreaterThan(0);
  expect(shown('l2', 2.4, 'l1', F)).toBe(0); expect(shown('l1', 0, 'l2', F)).toBe(0);
  expect(shown(null, 2.4, 'l1', F)).toBe(0); expect(shown(null, 0, 'l1', F)).toBeGreaterThan(0); expect(shown(null, 2.4, 'l2', F)).toBeGreaterThan(0);
  expect(floorCol('l1', F, 'N')).not.toBe(floorCol('l2', F, 'N')); expect(floorCol('l1', F, 'N')).toBe('#5AA9FF');
  expect(floorCol(null, F, 'N')).toBe('N'); expect(floorCol('f9', F, 'N')).toBe('N');
});


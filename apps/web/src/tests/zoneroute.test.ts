// RB-ZONE-WEB(11-12): 시나리오 편집의 접근 금지 칸·돌아가는 길(screens/zoneroute.ts)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ZoneGrid } from '../api';
import { CLEARANCE, crosses, inPolygon, loadNoGo, noGoAt, route, type Cells } from '../screens/zoneroute';

const W = 100, H = 80, RES = 0.05;
/** 금지 칸: 칸 c0~c1, 줄 r0~r1(끝 포함) */
const grid = (c0: number, c1: number, r0: number, r1: number, wall: Uint8Array | null = null): Cells => {
  const no = new Uint8Array(W * H);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) no[r * W + c] = 1;
  return { w: W, h: H, res: RES, no, wall };
};
afterEach(() => vi.restoreAllMocks());

describe('돌아가는 길', () => {
  it('곧은 길이 금지 칸을 지나면 돌아간다 — 꺾인 선은 금지 칸을 지나지 않고 몸체 여유만큼 떨어진다', () => {
    const g = grid(40, 49, 30, 49), a: [number, number] = [20.5, 40.5], b: [number, number] = [70.5, 40.5];
    expect(noGoAt(g, [45, 40])).toBe(true); expect(noGoAt(g, [20, 40])).toBe(false); expect(noGoAt(g, [-1, 0])).toBe(false);
    expect(crosses(g, a, b)).toBe(true);
    const r = route(g, a, b)!;
    expect(r[0]).toEqual(a); expect(r[r.length - 1]).toEqual(b);
    expect(r.length).toBeGreaterThan(2);
    for (let i = 1; i < r.length; i++) expect(crosses(g, r[i - 1], r[i])).toBe(false);
    // 꺾는 점은 구역 가장자리에서 몸체 여유(0.45 m = 9칸) 넘게 떨어져 있다
    const gap = ([x, y]: [number, number]) => Math.hypot(Math.max(40 - x, 0, x - 50), Math.max(30 - y, 0, y - 50)) * RES;
    for (const p of r.slice(1, -1)) expect(gap(p)).toBeGreaterThan(CLEARANCE - RES);
  });
  it('안 겹치면 곧은 길(점 2개), 금지 칸이 지도를 가로지르면 길 없음(null), 금지 칸 안 끝점도 길 없음', () => {
    const g = grid(40, 49, 30, 49);
    expect(crosses(g, [10.5, 10.5], [30.5, 10.5])).toBe(false);
    expect(route(g, [10.5, 10.5], [30.5, 10.5])).toEqual([[10.5, 10.5], [30.5, 10.5]]);
    expect(route(grid(40, 49, 0, H - 1), [20.5, 40.5], [70.5, 40.5])).toBeNull();
    expect(route(g, [20.5, 40.5], [45.5, 40.5])).toBeNull();
  });
  it('지도 그림의 막힌 칸(벽)도 못 지난다 — 구역 옆 틈을 벽이 막으면 길 없음', () => {
    const wall = new Uint8Array(W * H);
    for (let r = 0; r < 30; r++) wall[r * W + 45] = 1;                    // 구역 위쪽 틈
    for (let r = 50; r < H; r++) wall[r * W + 45] = 1;                    // 아래쪽 틈
    expect(route(grid(40, 49, 30, 49, wall), [20.5, 40.5], [70.5, 40.5])).toBeNull();
    for (let r = 50; r < H; r++) wall[r * W + 45] = 0;                    // 아래쪽을 트면 그쪽으로
    const r = route(grid(40, 49, 30, 49, wall), [20.5, 40.5], [70.5, 40.5])!;
    expect(r.some(([, y]) => y > 50)).toBe(true);
  });
  it('끝점이 구역 바로 옆(몸체 여유 띠 안)이어도 거기서 나오는 길은 찾는다', () => {
    const g = grid(40, 49, 30, 49), r = route(g, [38.5, 40.5], [70.5, 40.5]);
    expect(r).not.toBeNull();
    for (let i = 1; i < r!.length; i++) expect(crosses(g, r![i - 1], r![i])).toBe(false);
  });
});

describe('구역 칸 받기', () => {
  const page = (cells: ZoneGrid['cells'], cursor: number, next: number | null, p: Partial<ZoneGrid> = {}): ZoneGrid =>
    ({ format_version: 1, map_version_id: 'v1', origin: [0, 0, 0], resolution: RES, width: W, height: H, row_order: 'TOP_TO_BOTTOM', cursor, cells, next_cursor: next, ...p });
  it('쪽을 끝까지 넘겨 접근 금지 칸만 모은다(감속 칸은 뺌)', async () => {
    const get = vi.spyOn(api, 'zoneGrid')
      .mockResolvedValueOnce(page([{ index: 5, no_go: true, slow: false, max_speed_mps: null }, { index: 6, no_go: false, slow: true, max_speed_mps: 0.5 }], 0, 2))
      .mockResolvedValueOnce(page([{ index: W + 5, no_go: true, slow: true, max_speed_mps: 0.3 }], 2, null));
    const no = await loadNoGo({ id: 'v1', width: W, height: H });
    expect(get.mock.calls.map((c) => c[1])).toEqual([0, 2]);
    expect([...no].flatMap((x, i) => (x ? [i] : []))).toEqual([5, W + 5]);
  });
  it('판 크기와 다른 답은 실패로 본다', async () => {
    vi.spyOn(api, 'zoneGrid').mockResolvedValue(page([], 0, null, { width: W + 1 }));
    await expect(loadNoGo({ id: 'v1', width: W, height: H })).rejects.toThrow();
  });
  it('구역 칸을 못 받았을 때 쓰는 점-안 검사', () => {
    const pg: [number, number][] = [[3, -2], [4, -2], [4, 2], [3, 2]];
    expect(inPolygon(pg, 3.5, 0)).toBe(true); expect(inPolygon(pg, 2.9, 0)).toBe(false); expect(inPolygon(pg, 3.5, 2.5)).toBe(false);
  });
});

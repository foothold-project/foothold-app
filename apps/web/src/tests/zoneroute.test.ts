// RB-ZONE-WEB(11-12): 시나리오 편집의 접근 금지 칸·돌아가는 길(screens/zoneroute.ts)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ZoneGrid } from '../api';
import { CLEARANCE, crosses, inPolygon, loadNoGo, noGoAt, route, routeSoon, type Cells } from '../screens/zoneroute';

type P = [number, number];

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
    const r = route(g, a, b) as P[];
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
    const r = route(grid(40, 49, 30, 49, wall), [20.5, 40.5], [70.5, 40.5]) as P[];
    expect(r.some(([, y]) => y > 50)).toBe(true);
  });
  it('끝점이 구역 바로 옆(몸체 여유 띠 안)이어도 거기서 나오는 길은 찾는다', () => {
    const g = grid(40, 49, 30, 49), r = route(g, [38.5, 40.5], [70.5, 40.5]) as P[];
    expect(Array.isArray(r)).toBe(true);
    for (let i = 1; i < r.length; i++) expect(crosses(g, r[i - 1], r[i])).toBe(false);
  });
});

// Codex 검토(385596c) 3·4번 회귀
describe('검토 반영: 짧은 교차·탐색 상한', () => {
  it('금지 칸 모서리를 살짝 스치는 선분도 지난다고 본다(1/4칸 표본이 놓치던 것) — 길 찾기도 직선을 돌려주지 않는다', () => {
    const g = grid(40, 40, 40, 40), a: P = [39.1, 40.91], b: P = [40.9, 39.11];
    expect(crosses(g, a, b)).toBe(true);
    expect(crosses(g, b, a)).toBe(true);
    expect(crosses(g, [39.1, 39.5], [39.9, 41.5])).toBe(false);          // 옆 칸만 지남
    expect(crosses(g, [39.5, 39.5], [41.5, 41.5])).toBe(true);           // 대각선으로 한가운데
    expect(crosses(g, [39.5, 41.5], [41.5, 39.5])).toBe(true);
    const r = route(g, a, b) as P[];
    expect(r.length).toBeGreaterThan(2);
    for (let i = 1; i < r.length; i++) expect(crosses(g, r[i - 1], r[i])).toBe(false);
  });
  it('모서리 한 점만 스치는 대각선: 그 모서리에 닿은 옆 칸이 금지면 지난다고 본다', () => {
    expect(crosses(grid(40, 40, 40, 40), [39.5, 40.5], [40.5, 41.5])).toBe(true);   // 금지 칸 (40,40) 의 모서리 (40,41) 한 점을 스침
    expect(crosses(grid(40, 40, 40, 40), [37.5, 40.5], [38.5, 41.5])).toBe(false);
  });
  it('탐색 상한: 상한 안에 못 끝내면 «길 없음»(null)이 아니라 limit, 큰 지도의 막힌 구간도 상한에서 멈춘다', () => {
    const g = grid(40, 49, 30, 49);
    expect(route(g, [20.5, 40.5], [70.5, 40.5], 50)).toBe('limit');
    expect(Array.isArray(route(g, [20.5, 40.5], [70.5, 40.5]))).toBe(true);
    // 2000×2000 칸, 가운데 세로로 지도를 가르는 구역 — 끝까지 찾으면 수백만 칸(검토 재현 3.7초). 상한에서 그만둔다
    const N = 2000, no = new Uint8Array(N * N);
    for (let r = 0; r < N; r++) no[r * N + 1000] = 1;
    const big: Cells = { w: N, h: N, res: 0.05, no, wall: null }, t0 = performance.now();
    expect(route(big, [200.5, 1000.5], [1800.5, 1000.5])).toBe('limit');
    expect(performance.now() - t0).toBeLessThan(2500);
  });
  it('routeSoon: 계산 사이사이 차례를 넘긴다(다른 일이 끼어든다) — 결과는 route 와 같고, 취소하면 그만둔다', async () => {
    const g = grid(40, 49, 30, 49), a: P = [20.5, 40.5], b: P = [70.5, 40.5];
    let ticks = 0; const t = setInterval(() => { ticks++; }, 0);
    const N = 2000, no = new Uint8Array(N * N);
    for (let r = 0; r < N; r++) no[r * N + 1000] = 1;
    expect(await routeSoon({ w: N, h: N, res: 0.05, no, wall: null }, [200.5, 1000.5], [1800.5, 1000.5])).toBe('limit');
    clearInterval(t);
    expect(ticks).toBeGreaterThan(10);                                   // 긴 탐색 중에도 타이머(누름·STOP 과 같은 줄)가 돌았다
    expect(await routeSoon(g, a, b)).toEqual(route(g, a, b));
    const stop = new AbortController(); stop.abort();
    expect(await routeSoon({ w: N, h: N, res: 0.05, no, wall: null }, [200.5, 1000.5], [1800.5, 1000.5], stop.signal)).toBe('limit');
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

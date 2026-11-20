// 걸으며 만드는 2D 격자 지도(occgrid.ts, 11-20 RB-SLAM-GRID-WEB): 벽 앞 빈 곳·벽 칸·못 본 칸, 바닥 점은 벽 아님, 천장·사거리 밖 버림, 판당 점 솎기, stack 과 함께 버려짐
import { describe, expect, it } from 'vitest';
import { FLOOR_DZ, GRID_PTS, GRID_RES, L_LIM, OBST_DZ, RANGE_M, TOP_DZ, cellState, occGrid } from '../occgrid';
import { stack } from '../drivemedia';

const P = { x: 0, y: 0, z: 0.3, yaw: 0 }, WALL = P.z + FLOOR_DZ + OBST_DZ + 0.1, FLOOR = P.z + FLOOR_DZ;
const st = (g: ReturnType<typeof occGrid>, x: number, y: number) => cellState(g.L[g.at(x, y)]);
const c = (m: number) => (m + 0.5) * GRID_RES;   // 칸 가운데

describe('2D 격자 지도', () => {
  it('벽 점 하나: 로봇~벽 앞은 빈 곳, 벽 칸은 벽, 벽 뒤·옆은 모름', () => {
    const g = occGrid(200);
    g.add(new Float32Array([c(40), c(0), WALL]), P);
    expect(st(g, c(0), c(0))).toBe(0);   // 한 번 지나감(−4)만으로는 아직 모름(< −10 이어야 흰색)
    for (let i = 0; i < 2; i++) g.add(new Float32Array([c(40), c(0), WALL]), P);
    for (const m of [0, 10, 39]) expect(st(g, c(m), c(0))).toBe(1);
    expect(st(g, c(40), c(0))).toBe(2);
    expect(st(g, c(41), c(0))).toBe(0);
    expect(st(g, c(20), c(5))).toBe(0);
    expect(g.wall).toBe(1);
    expect(g.free).toBe(40);
  });
  it('바닥 점은 끝 칸까지 빈 곳(벽 아님), 장애물 높이 바로 아래도 바닥', () => {
    const g = occGrid(200);
    for (let i = 0; i < 3; i++) g.add(new Float32Array([c(30), c(0), FLOOR, c(0), c(30), FLOOR + OBST_DZ - 0.01]), P);
    expect(st(g, c(30), c(0))).toBe(1);
    expect(st(g, c(0), c(30))).toBe(1);
    expect(g.wall).toBe(0);
  });
  it('로봇보다 1 m 넘게 높은 점(천장)·사거리 밖 점은 버린다', () => {
    const g = occGrid(600);
    g.add(new Float32Array([c(20), c(0), P.z + TOP_DZ + 0.05, RANGE_M + 0.5, 0, WALL]), P);
    expect(g.free + g.wall).toBe(0);
    expect(cellState(g.L[g.at(c(10), c(0))])).toBe(0);
    expect(g.L[g.at(c(10), c(0))]).toBe(0);
  });
  it('한 판 안에서 한 칸은 한 번만, 벽이 빈 곳보다 먼저 — 값은 상하한 안', () => {
    const g = occGrid(200);
    // 같은 끝 칸에 높이만 다른 점 5개 + 그 칸을 지나가는 더 먼 점 하나
    g.add(new Float32Array([c(10), c(0), WALL, c(10), c(0), WALL + 0.1, c(10), c(0), WALL + 0.2, c(10), c(0), WALL + 0.3, c(10), c(0), WALL + 0.4, c(20), c(0), FLOOR]), P);
    expect(g.L[g.at(c(10), c(0))]).toBe(22);
    expect(g.L[g.at(c(5), c(0))]).toBe(-4);
    for (let i = 0; i < 30; i++) g.add(new Float32Array([c(10), c(0), WALL]), P);
    expect(g.L[g.at(c(10), c(0))]).toBe(L_LIM);
    expect(g.L[g.at(c(5), c(0))]).toBe(-L_LIM);
  });
  it('판당 점이 상한을 넘으면 고르게 솎는다', () => {
    const n = GRID_PTS * 2, pts = new Float32Array(n * 3);   // 점마다 다른 칸(200 × 80 칸 판) — 벽 칸 수 = 쓴 점 수
    for (let i = 0; i < n; i++) { pts[i * 3] = c((i % 200) - 100); pts[i * 3 + 1] = c(Math.floor(i / 200) + 10); pts[i * 3 + 2] = WALL; }
    const g = occGrid(400), all = occGrid(400);
    g.add(pts, P);
    all.add(pts, P, n);
    expect(g.wall).toBe(GRID_PTS);
    expect(all.wall).toBe(n);
  });
  it('격자 밖(처음 자리에서 너무 멀리)은 무시', () => {
    const g = occGrid(100);   // 5 m 정사각형
    g.add(new Float32Array([c(10), 0, WALL]), P);
    const before = g.free + g.wall;
    g.add(new Float32Array([100, 0, WALL]), { ...P, x: 99 });
    expect(g.free + g.wall).toBe(before);
    expect(g.at(100, 0)).toBe(-1);
  });
  it('stack 과 함께 생기고 같은 판으로 자란다', () => {
    const s = stack(10);
    s.add(new Float32Array([c(10), c(0), WALL]), P);
    expect(s.grid.wall).toBe(1);
    expect(stack(10).grid.wall).toBe(0);
  });
});

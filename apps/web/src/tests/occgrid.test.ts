// 걸으며 만드는 2D 격자 지도(occgrid.ts, 11-20 RB-SLAM-GRID-WEB): 벽 앞 빈 곳·벽 칸·못 본 칸, 바닥 점은 벽 아님, 천장·사거리 밖 버림, 판당 점 솎기, stack 과 함께 버려짐
import { describe, expect, it, vi } from 'vitest';
import { FLOOR_DZ, GRID_BUDGET_MS, GRID_PTS, GRID_RES, L_LIM, OBST_DZ, RANGE_M, TOP_DZ, cellState, occGrid } from '../occgrid';
import { stack } from '../drivemedia';

/** node 의 process.cpuUsage(웹 tsconfig 에 node 형이 없음) */
const cpu = (globalThis as unknown as { process: { cpuUsage(p?: object): { user: number; system: number } } }).process.cpuUsage;
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
  it('바닥보다 정확히 OBST_DZ 높은 점은 벽(경계 포함, RV-438 ③) — 점은 f32 로 오므로 pose 높이가 달라도', () => {
    for (const z of [0, 0.3, 0.27, 1.234, -0.41]) {
      const g = occGrid(200), pose = { ...P, z };
      for (let i = 0; i < 3; i++) g.add(new Float32Array([c(30), c(0), z + FLOOR_DZ + OBST_DZ]), pose);
      expect(st(g, c(30), c(0))).toBe(2);
    }
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
    g.add(pts, P, GRID_PTS, Infinity);   // 시간 예산 없이(이 PC 부하로 잘리지 않게)
    all.add(pts, P, n, Infinity);
    expect(g.wall).toBe(GRID_PTS);
    expect(all.wall).toBe(n);
  });
  it('판당 계산 시간 예산을 넘으면 거기서 멈추되 남은 광선도 고르게(한쪽만 비지 않게), 판마다 시작을 바꿈(RV-438 ④)', () => {
    let t = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (t += 0.1));   // 부를 때마다 0.1 ms
    const n = 4000, pts = new Float32Array(n * 3);   // 둥글게 점 4000개(4 m), 차례대로 = 한 바퀴
    for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; pts[i * 3] = Math.cos(a) * 4; pts[i * 3 + 1] = Math.sin(a) * 4; pts[i * 3 + 2] = WALL; }
    const g = occGrid(400), full = occGrid(400);
    full.add(pts, P, GRID_PTS, Infinity);
    g.add(pts, P);
    const once = g.wall, hits = [[4, 0], [0, 4], [-4, 0], [0, -4]].map(([x, y]) => {
      let hit = 0;
      for (let dx = -10; dx <= 10; dx++) for (let dy = -10; dy <= 10; dy++) if (st(g, x + dx * GRID_RES, y + dy * GRID_RES) === 2) hit++;
      return hit;
    });
    g.add(pts, P);
    now.mockRestore();
    expect(once).toBeGreaterThan(0);
    expect(once).toBeLessThan(full.wall * 0.6);   // 예산(GRID_BUDGET_MS)에서 잘림
    for (const h of hits) expect(h).toBeGreaterThan(0);   // 네 방향 모두 벽이 생김(앞쪽 점만 쓴 게 아님)
    expect(g.wall).toBeGreaterThan(once);   // 다음 판은 다른 광선부터
    expect(GRID_BUDGET_MS).toBeLessThanOrEqual(8);
  });
  // 이 프로세스 CPU 시간으로 잰다(벽시계는 남의 부하로 늘어남). 한가할 때 벽시계 p95 = 6~9 ms(11-20, 이 PC). 전체 시험을 함께 돌리면 JIT 가 늦게 데워져 첫 회가 넘칠 수 있어 다시 2번(데워진 뒤 값)
  it('주 스레드 판당 p95 ≤ 10 ms(5만 점·10 m — 처음 5판은 JIT 데우기라 빼고 20판)', () => {
    let s = 7;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647, g = occGrid(), ms: number[] = [];
    for (let k = 0; k < 25; k++) {
      const pts = new Float32Array(50_000 * 3);
      for (let i = 0; i < 50_000; i++) { const a = r() * 2 * Math.PI, d = 0.5 + r() * 9.4; pts[i * 3] = Math.cos(a) * d; pts[i * 3 + 1] = Math.sin(a) * d; pts[i * 3 + 2] = r() * 1.2 - 0.3; }
      const t = cpu();
      g.add(pts, { ...P, x: k * 0.1 });
      const d = cpu(t);
      if (k >= 5) ms.push((d.user + d.system) / 1000);
    }
    ms.sort((a, b) => a - b);
    expect(ms[Math.floor(ms.length * 0.95)]).toBeLessThanOrEqual(10);
    expect(g.wall).toBeGreaterThan(0);
  }, { retry: 2 });
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

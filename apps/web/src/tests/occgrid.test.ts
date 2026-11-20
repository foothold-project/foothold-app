// 걸으며 만드는 2D 격자 지도(occgrid.ts, 11-20 RB-SLAM-GRID-WEB): 벽 앞 빈 곳·벽 칸·못 본 칸, 바닥 점은 벽 아님, 천장·사거리 밖 버림, 판당 점 솎기, stack 과 함께 버려짐
import { describe, expect, it, vi } from 'vitest';
import { FLOOR_DZ, GRID_BUDGET_MS, GRID_PTS, GRID_RES, L_LIM, OBST_DZ, RANGE_M, TOP_DZ, cellState, occGrid } from '../occgrid';
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
  /** 벽이 있는 1도 부채꼴 수(로봇 둘레 r±0.3 m) */
  const arcs = (g: ReturnType<typeof occGrid>, r: number) => {
    const on = new Set<number>();
    for (let dx = -Math.ceil((r + 0.3) / GRID_RES); dx * GRID_RES <= r + 0.3; dx++) for (let dy = -Math.ceil((r + 0.3) / GRID_RES); dy * GRID_RES <= r + 0.3; dy++) {
      const x = c(dx), y = c(dy);
      if (Math.abs(Math.hypot(x, y) - r) < 0.3 && st(g, x, y) === 2) on.add(Math.floor(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360));
    }
    return on.size;
  };
  it('예산에 잘리면 다음 판은 잘린 광선 바로 다음부터 — 같은 원형 벽을 거듭 넣으면 360도 빠짐없이(RV-443 ②)', () => {
    let t = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (t += 0.1));   // 부를 때마다 0.1 ms — 판당 광선 ≈ 320개(앞 판의 첫 pass 8000/16 = 500 보다 적게 잘림)
    const n = 8000, pts = new Float32Array(n * 3);   // 9 m 원형 벽 8000점(차례대로 = 한 바퀴)
    for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; pts[i * 3] = Math.cos(a) * 9; pts[i * 3 + 1] = Math.sin(a) * 9; pts[i * 3 + 2] = WALL; }
    const g = occGrid(400);
    g.add(pts, P);
    const once = arcs(g, 9);
    for (let k = 1; k < 32; k++) g.add(pts, P);
    now.mockRestore();
    expect(once).toBeLessThan(360);   // 한 판은 예산에서 잘림
    expect(arcs(g, 9)).toBe(360);   // 32판이면 남은 광선을 모두 쏨(앞 판: 판마다 같은 pass 처음으로 되돌아가 1판 = 32판)
  });
  it('빈 판·한 점 판이 끼어도 잘린 자리를 지우지 않는다 — 원형 벽 32판이면 360도(RV-450 ①)', () => {
    let t = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (t += 0.1));
    const n = 8000, pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; pts[i * 3] = Math.cos(a) * 9; pts[i * 3 + 1] = Math.sin(a) * 9; pts[i * 3 + 2] = WALL; }
    const g = occGrid(400);
    for (let k = 0; k < 32; k++) { g.add(pts, P); g.add(new Float32Array(0), P); g.add(new Float32Array([c(20), c(0), WALL]), P); }
    now.mockRestore();
    expect(arcs(g, 9)).toBe(360);
  });
  it('판이 바뀌면 옛 판 나머지는 버리고 새 판의 다음 차례부터(옛 점이 새 판에 섞이지 않음)', () => {
    let t = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (t += 0.1));
    const ring = (r: number) => { const n = 8000, p = new Float32Array(n * 3); for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; p[i * 3] = Math.cos(a) * r; p[i * 3 + 1] = Math.sin(a) * r; p[i * 3 + 2] = WALL; } return p; };
    const g = occGrid(400);
    g.add(ring(4), P);
    const a = g.wall;
    g.add(new Float32Array(0), P);   // 빈 판 — 잘린 자리만 남고 아무것도 안 함
    g.add(ring(6), P);
    now.mockRestore();
    expect(g.wall).toBeGreaterThan(a);
    let in4 = 0;
    for (let dx = -90; dx <= 90; dx++) for (let dy = -90; dy <= 90; dy++) { const x = dx * GRID_RES, y = dy * GRID_RES, d = Math.hypot(x, y); if (d > 4.5 && d < 5.5 && st(g, x, y) === 2) in4++; }
    expect(in4).toBe(0);   // 4 m~6 m 사이엔 벽 없음
  });
  // RV-443 ①: Codex 재현 그대로 — 새 격자에 2Hz 판을 데우기 없이 20판씩(4천·5천·5만 점), 판당 p95 ≤ 8 ms(20판 nearest-rank = 19번째). 주 스레드 벽시계
  // (예산도 벽시계 — process.cpuUsage 는 JIT·GC 보조 스레드까지 세어 데우기 전 판이 부풂). 앞 판: 광선 예산 뒤 칸 반영 루프가 따로 돌고(10~18 ms)
  // 새 격자·새 점 수마다 JIT 가 광선 루프를 버리고 주 스레드에서 다시 OSR 컴파일(Node 18, 20~67 ms). 남은 것: 프로세스에서 처음 최적화하는 한 판(14~25 ms)
  // — 20판 중 한 판이라 p95 안. 기계가 몹시 바쁘면(부하 20/12코어 실측) 벽시계가 늘어 다시 2번
  it('새 격자 첫 판부터 판당 p95 ≤ 8 ms(4천·5천·5만 점·10 m, 각 20판)', () => {
    let s = 7;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (const N of [4000, 5000, 50_000]) {
      const g = occGrid(), ms: number[] = [], all = Array.from({ length: 20 }, () => {   // 판은 미리 만들어 둠(시험 쪽 할당이 부른 GC 가 재는 동안 끼지 않게)
        const pts = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) { const a = r() * 2 * Math.PI, d = 0.5 + r() * 9.4; pts[i * 3] = Math.cos(a) * d; pts[i * 3 + 1] = Math.sin(a) * d; pts[i * 3 + 2] = r() * 1.2 - 0.3; }
        return pts;
      });
      for (let k = 0; k < 20; k++) {
        const t = performance.now();
        g.add(all[k], { ...P, x: k * 0.1 });
        ms.push(performance.now() - t);
      }
      ms.sort((a, b) => a - b);
      expect(ms[Math.ceil(ms.length * 0.95) - 1], `${N}점 p95 (${ms.map((v) => v.toFixed(0)).join(' ')})`).toBeLessThanOrEqual(8);
      expect(g.wall).toBeGreaterThan(0);
    }
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

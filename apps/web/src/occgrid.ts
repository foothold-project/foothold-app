// 걸으며 만드는 2D 격자 지도(11-20 RB-SLAM-GRID-WEB): 쌓는 라이다 판(odom 기준 xyz + 그때 pose)마다 웹에서만 계산 — 로봇·서버 설치 없음, 고리 닫기 보정 없음.
// pose 에서 각 점까지 2D 선(Bresenham): 빛이 지나간 칸 = 빈 곳, 끝 칸 = 장애물 높이면 벽(바닥 점은 끝까지 빈 곳). 한 판 안에서 한 칸은 한 번만(벽이 빈 곳보다 먼저).
// 값 = 로그오즈 ×10 정수(Int8) — 지나감 −4, 닿음 +22, 상하한 ±40, 표시 < −10 빈 바닥 · > 15 벽 · 그 사이 모름. 순수 계산 — 그림·명령 없음.

/** 칸(m) · 한 변 칸 수(2000 = 100 m, 처음 pose 가 가운데 — 밖은 무시) · 사거리(m) · 판당 점 상한(넘으면 고르게 솎음) */
export const GRID_RES = 0.05, GRID_N = 2000, RANGE_M = 10, GRID_PTS = 8000;
/** 바닥 = 로봇 높이 + FLOOR_DZ(lidar3d.tsx FLOOR_DZ 와 같은 값), 장애물 = 바닥보다 OBST_DZ 넘게 높고 로봇보다 TOP_DZ 이하(그보다 높은 점=천장은 버림) */
export const FLOOR_DZ = -0.3, OBST_DZ = 0.15, TOP_DZ = 1.0;
export const L_FREE = -4, L_OCC = 22, L_LIM = 40, SHOW_FREE = -10, SHOW_OCC = 15;
/** 칸 상태: 0 모름 · 1 빈 바닥 · 2 벽 */
export const cellState = (v: number) => (v < SHOW_FREE ? 1 : v > SHOW_OCC ? 2 : 0);

export type OccGrid = ReturnType<typeof occGrid>;
type P = { x: number; y: number; z: number };

export function occGrid(size = GRID_N) {
  const L = new Int8Array(size * size), mark = new Uint8Array(size * size), touched: number[] = [];
  let c0 = 0, r0 = 0, ready = false;   // 칸 (0,0) 의 세계 칸 번호 — 처음 pose 둘레로 정함
  const g = {
    L, size, free: 0, wall: 0,
    /** 세계 (x,y) → 칸 번호, 밖이면 −1 */
    at(x: number, y: number) {
      const c = Math.floor(x / GRID_RES) - c0, r = Math.floor(y / GRID_RES) - r0;
      return ready && c >= 0 && r >= 0 && c < size && r < size ? r * size + c : -1;
    },
    /** 격자 (0,0) 칸의 세계 칸 번호(그림용: 열 = floor(x/GRID_RES) − c0) */
    get c0() { return c0; }, get r0() { return r0; },
    add(pts: Float32Array, pose: P, cap = GRID_PTS) {
      if (!ready) { c0 = Math.floor(pose.x / GRID_RES) - (size >> 1); r0 = Math.floor(pose.y / GRID_RES) - (size >> 1); ready = true; }
      const sc = Math.floor(pose.x / GRID_RES) - c0, sr = Math.floor(pose.y / GRID_RES) - r0;
      if (sc < 0 || sr < 0 || sc >= size || sr >= size) return;
      const n = Math.floor(pts.length / 3), step = Math.max(1, Math.ceil(n / cap)), floor = pose.z + FLOOR_DZ;
      const put = (i: number, m: number) => { if (!mark[i]) touched.push(i); if (m > mark[i]) mark[i] = m; };
      for (let p = 0; p < n; p += step) {
        const x = pts[p * 3], y = pts[p * 3 + 1], z = pts[p * 3 + 2];
        if (z > pose.z + TOP_DZ || Math.hypot(x - pose.x, y - pose.y) > RANGE_M) continue;
        const ec = Math.floor(x / GRID_RES) - c0, er = Math.floor(y / GRID_RES) - r0, hit = z > floor + OBST_DZ ? 2 : 1;
        // Bresenham: 시작 칸부터 끝 칸 앞까지 빈 곳, 끝 칸은 hit. 격자는 볼록이라 밖으로 나가면 다시 들어오지 않음
        let c = sc, r = sr;
        const dc = Math.abs(ec - sc), dr = -Math.abs(er - sr), ic = sc < ec ? 1 : -1, ir = sr < er ? 1 : -1;
        let e = dc + dr;
        for (;;) {
          if (c < 0 || r < 0 || c >= size || r >= size) break;
          const last = c === ec && r === er;
          put(r * size + c, last ? hit : 1);
          if (last) break;
          const e2 = 2 * e;
          if (e2 >= dr) { e += dr; c += ic; }
          if (e2 <= dc) { e += dc; r += ir; }
        }
      }
      for (const i of touched) {
        const was = cellState(L[i]), v = Math.max(-L_LIM, Math.min(L_LIM, L[i] + (mark[i] === 2 ? L_OCC : L_FREE)));
        L[i] = v; mark[i] = 0;
        const now = cellState(v);
        if (now !== was) { if (was === 1) g.free--; else if (was === 2) g.wall--; if (now === 1) g.free++; else if (now === 2) g.wall++; }
      }
      touched.length = 0;
    },
  };
  return g;
}

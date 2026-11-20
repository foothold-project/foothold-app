// 걸으며 만드는 2D 격자 지도(11-20 RB-SLAM-GRID-WEB): 쌓는 라이다 판(odom 기준 xyz + 그때 pose)마다 웹에서만 계산 — 로봇·서버 설치 없음, 고리 닫기 보정 없음.
// pose 에서 각 점까지 2D 선(Bresenham): 빛이 지나간 칸 = 빈 곳, 끝 칸 = 장애물 높이면 벽(바닥 점은 끝까지 빈 곳). 한 판 안에서 한 칸은 한 번만(벽이 빈 곳보다 먼저).
// 값 = 로그오즈 ×10 정수(Int8) — 지나감 −4, 닿음 +22, 상하한 ±40, 표시 < −10 빈 바닥 · > 15 벽 · 그 사이 모름. 순수 계산 — 그림·명령 없음.

/** 칸(m) · 한 변 칸 수(2000 = 100 m, 처음 pose 가 가운데 — 밖은 무시) · 사거리(m) · 판당 점 상한(넘으면 고르게 솎음) */
export const GRID_RES = 0.05, GRID_N = 2000, RANGE_M = 10, GRID_PTS = 8000;
/** 판당 계산 시간 예산(ms, RV-443 ① 주 스레드 판당 p95 ≤ 8 ms — 칸 반영까지 이 안) · 광선을 RAY_CHUNK 개씩 고르게 흩은 pass 로 나눠 쏨(잘려도 모든 방향이 고르게).
 *  잘리면 다음 판은 잘린 광선 바로 다음 차례부터(RV-443 ② — 옛 판 나머지는 버림, 같은 차례 번호로 새 판을 이어 쏨).
 *  ponytail: 느린 PC 는 판당 광선이 줄어 지도가 늦게 참 — 부족하면 Web Worker 로 옮김 */
export const GRID_BUDGET_MS = 4, RAY_CHUNK = 64;
/** 바닥 = 로봇 높이 + FLOOR_DZ(lidar3d.tsx FLOOR_DZ 와 같은 값), 장애물 = 바닥보다 OBST_DZ 이상 높고 로봇보다 TOP_DZ 이하(그보다 높은 점=천장은 버림) */
export const FLOOR_DZ = -0.3, OBST_DZ = 0.15, TOP_DZ = 1.0;
export const L_FREE = -4, L_OCC = 22, L_LIM = 40, SHOW_FREE = -10, SHOW_OCC = 15;
/** 칸 상태: 0 모름 · 1 빈 바닥 · 2 벽 */
export const cellState = (v: number) => (v < SHOW_FREE ? 1 : v > SHOW_OCC ? 2 : 0);

type P = { x: number; y: number; z: number };

// 칸 반영(set·put)은 모듈 함수 하나, 격자는 class 하나(add 는 프로토타입에 하나) — 최적화된 add 는 모든 격자가 함께 쓰므로 격자마다 닫힘이 다르면
// 새 격자(«처음부터 다시»·epoch)마다 «다른 함수» 로 보고 add 를 버린 뒤 다시 컴파일하며 주 스레드가 수십 ms 멈춤. 칸 수도 갈래 없이 셈(늦게 처음 타는 갈래도 같은 멈춤)
// (RV-443 ①, Node 18 실측 20~67 ms)
function set(L: Int8Array, cnt: Int32Array, i: number, v: number) { cnt[cellState(L[i])]--; cnt[cellState(L[i] = Math.max(-L_LIM, Math.min(L_LIM, v)))]++; }
/** 칸마다 이 판에 한 번만(벽이 빈 곳보다 먼저) — 바로 반영해 판 끝에 따로 도는 루프가 없음. 닿은 칸 수(nt)를 돌려줌 */
function put(L: Int8Array, mark: Uint8Array, touched: Int32Array, cnt: Int32Array, nt: number, i: number, hit: number) {
  const k = mark[i];
  if (!k) { touched[nt++] = i; mark[i] = 2 + (L[i] + L_LIM) * 2 + hit - 1; set(L, cnt, i, L[i] + (hit === 2 ? L_OCC : L_FREE)); return nt; }
  const up = (hit - 1) & ~k & 1, v = (k >> 1) - 1 - L_LIM + L_OCC;   // up = 이 판에 빈 곳으로 셌는데 지금 벽 → 판 전 값 + L_OCC. 다시 닿을 때마다 늘 계산(드문 갈래 없음)
  mark[i] = k | up;
  set(L, cnt, i, up ? v : L[i]);
  return nt;
}

export class OccGrid {
  /** 로그오즈 값(행 우선, 한 변 size 칸) */
  readonly L: Int8Array;
  // mark = 이 판에 닿은 칸: 0 아직 · 2 + (판 전 값 + L_LIM)×2 + (벽?1:0) — 빈 곳으로 먼저 반영한 칸이 같은 판에서 벽이 되면 판 전 값에서 다시 셈(벽 우선, 상하한에 눌려도 정확).
  // touched = 이 판에 닿은 칸 번호(판 끝에 mark 만 되돌림) — 한 판은 pose 둘레 사거리 네모 안이라 그 크기로 미리 잡음(자라며 생기는 쓰레기·GC 없음)
  private readonly mark: Uint8Array;
  private readonly touched: Int32Array;
  private readonly cnt = new Int32Array(3);   // 상태별 칸 수(0 모름 · 1 빈 바닥 · 2 벽)
  /** 격자 (0,0) 칸의 세계 칸 번호(그림용: 열 = floor(x/GRID_RES) − c0) — 처음 pose 둘레로 정함 */
  c0 = 0; r0 = 0;
  private ready = false;
  private from = 0;   // 다음 판이 쏠 점 차례
  constructor(readonly size = GRID_N) {
    this.L = new Int8Array(size * size); this.mark = new Uint8Array(size * size);
    this.touched = new Int32Array(Math.min(size * size, (2 * Math.ceil(RANGE_M / GRID_RES) + 3) ** 2));
  }
  get free() { return this.cnt[1]; }
  get wall() { return this.cnt[2]; }
  /** 세계 (x,y) → 칸 번호, 밖이면 −1 */
  at(x: number, y: number) {
    const c = Math.floor(x / GRID_RES) - this.c0, r = Math.floor(y / GRID_RES) - this.r0, n = this.size;
    return this.ready && c >= 0 && r >= 0 && c < n && r < n ? r * n + c : -1;
  }
  add(pts: Float32Array, pose: P, cap = GRID_PTS, budget = GRID_BUDGET_MS) {
    const size = this.size;
    if (!this.ready) { this.c0 = Math.floor(pose.x / GRID_RES) - (size >> 1); this.r0 = Math.floor(pose.y / GRID_RES) - (size >> 1); this.ready = true; }
    const sc = Math.floor(pose.x / GRID_RES) - this.c0, sr = Math.floor(pose.y / GRID_RES) - this.r0;
    if (sc < 0 || sr < 0 || sc >= size || sr >= size) return;
    const n = Math.floor(pts.length / 3), step = Math.max(1, Math.ceil(n / cap));
    // 점은 f32 — 경계도 f32 로 맞춰 «정확히 OBST_DZ 높은 점» = 벽(RV-438 ③)
    this.from = cast(this.L, this.mark, this.touched, this.cnt, size, pts, pose.x, pose.y, pose.z + TOP_DZ, Math.fround(pose.z + FLOOR_DZ + OBST_DZ),
      sc, sr, this.c0, this.r0, step, Math.ceil(n / step), this.from, budget, performance.now());
  }
}

// 광선 루프는 숫자·배열만 받는 모듈 함수 — 바깥(새 격자 첫 판에만 타는 갈래·this 모양)이 처음 겪는 일로 버려져도 이 루프는 그대로 남음
// (루프 안에서 버려지면 Node 18 은 다시 OSR 을 주 스레드에서 동기 컴파일 — 20~25 ms). 돌려주는 값 = 다음 판이 쏠 점 차례
function cast(L: Int8Array, mark: Uint8Array, touched: Int32Array, cnt: Int32Array, size: number, pts: Float32Array, px: number, py: number, top: number,
  hitZ: number, sc: number, sr: number, c0: number, r0: number, step: number, m: number, from: number, budget: number, t0: number) {
  // 차례: pass ps = 점 ps, ps+P, ps+2P …(P = pass 수, 한 pass ≈ RAY_CHUNK 개) → 다음 pass … 한 바퀴 m 개. from 부터 쏘고 멈춘 자리를 돌려줌.
  // 루프 하나로 편다 — 겹 루프면 바깥 갈래가 데운 뒤에야 처음 타서 같은 멈춤
  const P = Math.ceil(m / RAY_CHUNK);
  let q = m ? from % m : 0, ps = P ? q % P : 0, nt = 0;
  for (let j = 0; j < m; j++) {
    if ((j & 7) === 7 && performance.now() - t0 > budget) break;
    const p = q * step;
    q += P; if (q >= m) { ps = ps + 1 < P ? ps + 1 : 0; q = ps; }
    const x = pts[p * 3], y = pts[p * 3 + 1], z = pts[p * 3 + 2], dx = x - px, dy = y - py;
    if (z > top || dx * dx + dy * dy > RANGE_M * RANGE_M) continue;
    const ec = Math.floor(x / GRID_RES) - c0, er = Math.floor(y / GRID_RES) - r0, hit = z >= hitZ ? 2 : 1;
    // Bresenham: 시작 칸부터 끝 칸 앞까지 빈 곳, 끝 칸은 hit. 격자는 볼록이라 밖으로 나가면 다시 들어오지 않음. dr 은 −|er−sr| 이되 −0 이 안 나오게(−0 도 같은 멈춤)
    let c = sc, r = sr;
    const dc = Math.abs(ec - sc), dr = Math.min(er - sr, sr - er), ic = sc < ec ? 1 : -1, ir = sr < er ? 1 : -1;
    let e = dc + dr;
    for (;;) {
      if (c < 0 || r < 0 || c >= size || r >= size) break;
      const last = c === ec && r === er;
      nt = put(L, mark, touched, cnt, nt, r * size + c, last ? hit : 1);
      if (last) break;
      const e2 = 2 * e;
      if (e2 >= dr) { e += dr; c += ic; }
      if (e2 <= dc) { e += dc; r += ir; }
    }
  }
  for (let k = 0; k < nt; k++) mark[touched[k]] = 0;
  return q;
}
export const occGrid = (size = GRID_N) => new OccGrid(size);

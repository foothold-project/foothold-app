// Usage: node occgrid_reference.cjs slam_room.json
// 웹 apps/web/src/occgrid.ts(조종 화면 «걸으며 만드는 지도», RB-SLAM-WEB3 11-25 에서 웹에서 지움)의 마지막 판을 tsc(ES2020·commonjs)로 옮겨 그대로 둔 대조 기준.
// agent mapping/grid.py 가 같은 Int8 격자를 내는지 test_slam_mapping.py 가 이것으로 비교한다 — 고치지 말 것(바꾸면 slam_room_golden.json 도 다시 만들어야 함).
Object.defineProperty(exports, "__esModule", { value: true });
exports.occGrid = exports.OccGrid = exports.cellState = exports.SHOW_OCC = exports.SHOW_FREE = exports.L_LIM = exports.L_OCC = exports.L_FREE = exports.TOP_DZ = exports.OBST_DZ = exports.FLOOR_DZ = exports.RAY_CHUNK = exports.GRID_BUDGET_MS = exports.GRID_PTS = exports.RANGE_M = exports.GRID_N = exports.GRID_RES = void 0;
/** 칸(m) · 한 변 칸 수(2000 = 100 m, 처음 pose 가 가운데 — 밖은 무시) · 사거리(m) · 판당 점 상한(넘으면 고르게 솎음) */
exports.GRID_RES = 0.05, exports.GRID_N = 2000, exports.RANGE_M = 10, exports.GRID_PTS = 8000;
/** 판당 계산 시간 예산(ms, RV-443 ① 주 스레드 판당 p95 ≤ 8 ms — 칸 반영까지 이 안) · 광선을 RAY_CHUNK 개씩 고르게 흩은 pass 로 나눠 쏨(잘려도 모든 방향이 고르게).
 *  잘리면 다음 판은 잘린 광선 바로 다음 차례부터(RV-443 ② — 옛 판 나머지는 버림, 같은 차례 번호로 새 판을 이어 쏨).
 *  ponytail: 느린 PC 는 판당 광선이 줄어 지도가 늦게 참 — 부족하면 Web Worker 로 옮김 */
exports.GRID_BUDGET_MS = 4, exports.RAY_CHUNK = 64;
/** 바닥 = 로봇 높이 + FLOOR_DZ(lidar3d.tsx FLOOR_DZ 와 같은 값), 장애물 = 바닥보다 OBST_DZ 이상 높고 로봇보다 TOP_DZ 이하(그보다 높은 점=천장은 버림) */
exports.FLOOR_DZ = -0.3, exports.OBST_DZ = 0.15, exports.TOP_DZ = 1.0;
exports.L_FREE = -4, exports.L_OCC = 22, exports.L_LIM = 40, exports.SHOW_FREE = -10, exports.SHOW_OCC = 15;
/** 칸 상태: 0 모름 · 1 빈 바닥 · 2 벽 */
const cellState = (v) => (v < exports.SHOW_FREE ? 1 : v > exports.SHOW_OCC ? 2 : 0);
exports.cellState = cellState;
// 칸 반영(set·put)은 모듈 함수 하나, 격자는 class 하나(add 는 프로토타입에 하나) — 최적화된 add 는 모든 격자가 함께 쓰므로 격자마다 닫힘이 다르면
// 새 격자(«처음부터 다시»·epoch)마다 «다른 함수» 로 보고 add 를 버린 뒤 다시 컴파일하며 주 스레드가 수십 ms 멈춤. 칸 수도 갈래 없이 셈(늦게 처음 타는 갈래도 같은 멈춤)
// (RV-443 ①, Node 18 실측 20~67 ms)
function set(L, cnt, i, v) { cnt[(0, exports.cellState)(L[i])]--; cnt[(0, exports.cellState)(L[i] = Math.max(-exports.L_LIM, Math.min(exports.L_LIM, v)))]++; }
/** 칸마다 이 판에 한 번만(벽이 빈 곳보다 먼저) — 바로 반영해 판 끝에 따로 도는 루프가 없음. 닿은 칸 수(nt)를 돌려줌 */
function put(L, mark, touched, cnt, nt, i, hit) {
    const k = mark[i];
    if (!k) {
        touched[nt++] = i;
        mark[i] = 2 + (L[i] + exports.L_LIM) * 2 + hit - 1;
        set(L, cnt, i, L[i] + (hit === 2 ? exports.L_OCC : exports.L_FREE));
        return nt;
    }
    const up = (hit - 1) & ~k & 1, v = (k >> 1) - 1 - exports.L_LIM + exports.L_OCC; // up = 이 판에 빈 곳으로 셌는데 지금 벽 → 판 전 값 + L_OCC. 다시 닿을 때마다 늘 계산(드문 갈래 없음)
    mark[i] = k | up;
    set(L, cnt, i, up ? v : L[i]);
    return nt;
}
class OccGrid {
    constructor(size = exports.GRID_N) {
        this.size = size;
        this.cnt = new Int32Array(3); // 상태별 칸 수(0 모름 · 1 빈 바닥 · 2 벽)
        /** 격자 (0,0) 칸의 세계 칸 번호(그림용: 열 = floor(x/GRID_RES) − c0) — 처음 pose 둘레로 정함 */
        this.c0 = 0;
        this.r0 = 0;
        this.ready = false;
        this.from = 0; // 다음 판이 쏠 점 차례
        this.L = new Int8Array(size * size);
        this.mark = new Uint8Array(size * size);
        this.touched = new Int32Array(Math.min(size * size, (2 * Math.ceil(exports.RANGE_M / exports.GRID_RES) + 3) ** 2));
    }
    get free() { return this.cnt[1]; }
    get wall() { return this.cnt[2]; }
    /** 세계 (x,y) → 칸 번호, 밖이면 −1 */
    at(x, y) {
        const c = Math.floor(x / exports.GRID_RES) - this.c0, r = Math.floor(y / exports.GRID_RES) - this.r0, n = this.size;
        return this.ready && c >= 0 && r >= 0 && c < n && r < n ? r * n + c : -1;
    }
    add(pts, pose, cap = exports.GRID_PTS, budget = exports.GRID_BUDGET_MS) {
        const size = this.size;
        if (!this.ready) {
            this.c0 = Math.floor(pose.x / exports.GRID_RES) - (size >> 1);
            this.r0 = Math.floor(pose.y / exports.GRID_RES) - (size >> 1);
            this.ready = true;
        }
        const sc = Math.floor(pose.x / exports.GRID_RES) - this.c0, sr = Math.floor(pose.y / exports.GRID_RES) - this.r0;
        if (sc < 0 || sr < 0 || sc >= size || sr >= size)
            return;
        const n = Math.floor(pts.length / 3), step = Math.max(1, Math.ceil(n / cap));
        // 점은 f32 — 경계도 f32 로 맞춰 «정확히 OBST_DZ 높은 점» = 벽(RV-438 ③)
        this.from = cast(this.L, this.mark, this.touched, this.cnt, size, pts, pose.x, pose.y, pose.z + exports.TOP_DZ, Math.fround(pose.z + exports.FLOOR_DZ + exports.OBST_DZ), sc, sr, this.c0, this.r0, step, Math.ceil(n / step), this.from, budget, performance.now());
    }
}
exports.OccGrid = OccGrid;
// 광선 루프는 숫자·배열만 받는 모듈 함수 — 바깥(새 격자 첫 판에만 타는 갈래·this 모양)이 처음 겪는 일로 버려져도 이 루프는 그대로 남음
// (루프 안에서 버려지면 Node 18 은 다시 OSR 을 주 스레드에서 동기 컴파일 — 20~25 ms). 돌려주는 값 = 다음 판이 쏠 점 차례
function cast(L, mark, touched, cnt, size, pts, px, py, top, hitZ, sc, sr, c0, r0, step, m, from, budget, t0) {
    // 차례: pass ps = 점 ps, ps+P, ps+2P …(P = pass 수, 한 pass ≈ RAY_CHUNK 개) → 다음 pass … 한 바퀴 m 개. from 부터 쏘고 멈춘 자리를 돌려줌.
    // 루프 하나로 편다 — 겹 루프면 바깥 갈래가 데운 뒤에야 처음 타서 같은 멈춤
    const P = Math.ceil(m / exports.RAY_CHUNK);
    let q = m ? from % m : 0, ps = P ? q % P : 0, nt = 0, j = 0;
    for (; j < m; j++) {
        if ((j & 7) === 7 && performance.now() - t0 > budget)
            break;
        const p = q * step;
        q += P;
        if (q >= m) {
            ps = ps + 1 < P ? ps + 1 : 0;
            q = ps;
        }
        const x = pts[p * 3], y = pts[p * 3 + 1], z = pts[p * 3 + 2], dx = x - px, dy = y - py;
        if (z > top || dx * dx + dy * dy > exports.RANGE_M * exports.RANGE_M)
            continue;
        const ec = Math.floor(x / exports.GRID_RES) - c0, er = Math.floor(y / exports.GRID_RES) - r0, hit = z >= hitZ ? 2 : 1;
        // Bresenham: 시작 칸부터 끝 칸 앞까지 빈 곳, 끝 칸은 hit. 격자는 볼록이라 밖으로 나가면 다시 들어오지 않음. dr 은 −|er−sr| 이되 −0 이 안 나오게(−0 도 같은 멈춤)
        let c = sc, r = sr;
        const dc = Math.abs(ec - sc), dr = Math.min(er - sr, sr - er), ic = sc < ec ? 1 : -1, ir = sr < er ? 1 : -1;
        let e = dc + dr;
        for (;;) {
            if (c < 0 || r < 0 || c >= size || r >= size)
                break;
            const last = c === ec && r === er;
            nt = put(L, mark, touched, cnt, nt, r * size + c, last ? hit : 1);
            if (last)
                break;
            const e2 = 2 * e;
            if (e2 >= dr) {
                e += dr;
                c += ic;
            }
            if (e2 <= dc) {
                e += dc;
                r += ir;
            }
        }
    }
    for (let k = 0; k < nt; k++)
        mark[touched[k]] = 0;
    return j < m ? q : from; // 다 쏜 판(빈 판·작은 판 포함)은 잘린 자리를 그대로 둠 — 사이에 낀 작은 판이 이어 쏘기를 0 으로 돌리지 않게(RV-450 ①)
}
const occGrid = (size = exports.GRID_N) => new OccGrid(size);
exports.occGrid = occGrid;

const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const grid = new OccGrid(fixture.size);
for (const {points, pose} of fixture.frames) {
  grid.add(new Float32Array(points.flat()), {x:pose[0], y:pose[1], z:pose[2]}, 8000, Infinity);
}
process.stdout.write(JSON.stringify({c0:grid.c0, r0:grid.r0, L:Buffer.from(grid.L.buffer).toString('base64')}));

// 쌓는 라이다 지도 판당 시간(11-20 RB-STACK-PERF): 5 cm 칸 중복 제거가 큰 수 Set 이라 5만 점 판에 100 ms 넘던 것 — 고친 판과 옛 판(아래 refStack)이 같은 점을 남기는지 + 판당 시간
import { describe, expect, it } from 'vitest';
import { CEIL_M, CELL_M, stack, type Pose } from '../drivemedia';

/** 고치기 전 dedupe(Set<number>, 키 = 53비트 수) 그대로 — 격자(grid)·길(path)은 뺌 */
function refStack(cap: number) {
  const xyz = new Float32Array(cap * 3), keys = new Float64Array(cap), seen = new Set<number>();
  let total = 0;
  return {
    xyz, get n() { return Math.min(total, cap); },
    add(pts: Float32Array, pose: Pose) {
      for (let i = 0; i + 2 < pts.length; i += 3) {
        const x = pts[i], y = pts[i + 1], z = pts[i + 2], iz = Math.floor(z / CELL_M) + 1024;
        if (z > pose.z + CEIL_M || iz < 0 || iz > 2047) continue;
        const k = ((Math.floor(x / CELL_M) + 2 ** 20) * 2 ** 21 + Math.floor(y / CELL_M) + 2 ** 20) * 2048 + iz;
        if (seen.has(k)) continue;
        const w = total++ % cap;
        if (total > cap) seen.delete(keys[w]);
        seen.add(k); keys[w] = k; xyz[w * 3] = x; xyz[w * 3 + 1] = y; xyz[w * 3 + 2] = z;
      }
    },
  };
}
/** 결정적 난수(mulberry32) — 실패가 다시 나게 */
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
/** 로봇 둘레 반경 r(m) 상자 안 n 점, z 는 −60 m ~ +3 m(범위 밖·천장도 섞임) */
const frame = (rand: () => number, n: number, pose: Pose, r: number) => {
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = pose.x + (rand() * 2 - 1) * r; a[i * 3 + 1] = pose.y + (rand() * 2 - 1) * r; a[i * 3 + 2] = rand() < 0.02 ? -60 + rand() * 10 : -0.5 + rand() * 3.5; }
  return a;
};
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

describe('쌓는 라이다 지도 — 빠른 중복 제거', () => {
  it('무작위 판 여러 개: 옛 Set 판과 남은 점(자리·값)이 같다 — 덮어쓰기·다시 받기·천장·z 범위 포함', () => {
    for (const [seed, cap, n, r, frames] of [[1, 50, 40, 0.3, 60], [2, 1000, 700, 1, 40], [3, 5000, 3000, 4, 30], [4, 7, 5, 0.1, 200]]) {
      const rand = rng(seed), a = stack(cap), b = refStack(cap);
      for (let f = 0; f < frames; f++) {
        const pose = { x: (rand() - 0.5) * 2, y: (rand() - 0.5) * 2, z: rand() * 0.5, yaw: 0 }, pts = frame(rand, n, pose, r);
        a.add(pts, pose); b.add(pts, pose);
        expect(a.n).toBe(b.n);
        let diff = -1;
        for (let i = 0; i < a.n * 3 && diff < 0; i++) if (a.xyz[i] !== b.xyz[i]) diff = i;
        expect(diff).toBe(-1);
      }
    }
  });
  it('5만 점 판을 이어 넣어도(0 → 20만 넘어 덮어쓰기) 판당 시간이 느슨한 상한 안 · 옛 Set 판보다 빠름', () => {
    const rand = rng(7), frames = Array.from({ length: 30 }, (_, f) => { const pose = { x: f * 0.3, y: 0, z: 0.3, yaw: 0 }; return { pose, pts: frame(rand, 50_000, pose, 20) }; });
    const time = (s: { add: (p: Float32Array, q: Pose) => void }) => frames.map(({ pts, pose }) => { const t0 = performance.now(); s.add(pts, pose); return performance.now() - t0; });
    const s = stack(), ms = time(s).slice(5), old = time(refStack(200_000)).slice(5), fmt = (a: number[]) => `p50 ${q(a, 0.5).toFixed(1)} · p95 ${q(a, 0.95).toFixed(1)} ms`;   // 처음 5판은 JIT 데우기라 뺌(occgrid 시험과 같음)
    console.log(`5만 점 판 ${ms.length}개: 새 stack.add(격자 포함) ${fmt(ms)} · 옛 Set 중복 제거만 ${fmt(old)}`);
    expect(s.n).toBe(200_000);
    expect(q(ms, 0.95)).toBeLessThan(60);   // 시험 기계(jsdom·CI·부하)는 크게 흔들려 느슨하게. 옛 판은 100 ms 넘던 것
    expect(q(ms, 0.5)).toBeLessThan(q(old, 0.5));   // 기계 빠르기와 무관한 비교: 격자까지 더해도 옛 중복 제거 하나보다 빠름
  });
});

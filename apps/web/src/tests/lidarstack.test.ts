// 쌓는 라이다 지도(drivemedia.ts stack, 11-13 RB-MAP-VIEW-WEB): 5 cm 칸 중복 제거 · 상한을 넘으면 오래된 점부터 버림 · 천장 버림 · 지나온 길
import { describe, expect, it } from 'vitest';
import { CEIL_M, PATH_MAX, STACK_MAX, stack } from '../drivemedia';

const P = { x: 0, y: 0, z: 0, yaw: 0 };
const pts = (s: ReturnType<typeof stack>) => Array.from({ length: s.n }, (_, i) => Math.round(s.xyz[i * 3] * 100) / 100);

describe('쌓는 라이다 지도', () => {
  it('같은 5 cm 칸(x·y·z)의 점은 한 번만, 다른 칸·다른 높이는 따로', () => {
    const s = stack();
    s.add(new Float32Array([1, 1, 0, 1.01, 1.01, 0.01, 1.06, 1, 0, 1, 1, 0.3]), P);
    s.add(new Float32Array([1.02, 1.02, 0.02, -1, -1, 0]), P);
    expect(s.n).toBe(4);
    expect(STACK_MAX).toBe(200_000);
  });
  it('상한을 넘으면 가장 오래된 점부터 버리고, 버린 칸은 다시 받을 수 있다', () => {
    const s = stack(3);
    s.add(new Float32Array([1, 0, 0, 2, 0, 0, 3, 0, 0]), P);
    s.add(new Float32Array([4, 0, 0]), P);
    expect(s.n).toBe(3);
    expect(pts(s).sort()).toEqual([2, 3, 4]);
    s.add(new Float32Array([1, 0, 0, 4, 0, 0]), P);   // 1 은 버려졌으니 다시 들어가고(2 를 밀어냄), 4 는 아직 있어 중복
    expect(pts(s).sort()).toEqual([1, 3, 4]);
  });
  it('로봇보다 훨씬 높은 점(천장)은 쌓지 않는다 — 로봇 높이 기준', () => {
    const s = stack();
    s.add(new Float32Array([0, 0, CEIL_M + 0.1, 1, 0, CEIL_M - 0.1]), P);
    expect(s.n).toBe(1);
    s.add(new Float32Array([0, 0, CEIL_M + 0.1]), { ...P, z: 0.5 });
    expect(s.n).toBe(2);
  });
  it('지나온 길: 5 cm 넘게 움직였을 때만 잇고, 상한을 넘으면 앞에서 버린다', () => {
    const s = stack(10), none = new Float32Array(0);
    s.add(none, P); s.add(none, { ...P, x: 0.01 }); s.add(none, { ...P, x: 0.2 });
    expect(s.path).toEqual([0, 0, 0.2, 0]);
    for (let i = 1; i <= PATH_MAX + 5; i++) s.add(none, { ...P, x: i });
    expect(s.path.length).toBe(PATH_MAX * 2);
    expect(s.path[s.path.length - 2]).toBe(PATH_MAX + 5);
  });
});

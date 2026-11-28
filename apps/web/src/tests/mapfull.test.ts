// 팀장 03:19 · 03:20 관제 「지도 보기」 전체 보기: 공장 전체가 칸을 꽉 · 멀어져도 지도는 안개에 덮이지 않음 · 컷 없이 날아감(끌면 멈춤 · 움직임 줄이기면 바로)
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { FLY_S, FULL_PAD, SITE_FOV, SITE_R, flight, fogFor, fullShot, nearShot, shotOf, type SiteShot } from '../proto/u5map';
import { K, OX, OY, SITE_PX_H, SITE_PX_W } from '../proto/site';

const AR = 1306 / 798;
const camOf = (s: SiteShot) => { const c = new THREE.PerspectiveCamera(SITE_FOV, AR, 1, 1e5), t = s.tgt;
  c.position.set(t.x + Math.sin(s.az) * Math.cos(s.el) * s.d, Math.sin(s.el) * s.d, t.z + Math.cos(s.az) * Math.cos(s.el) * s.d); c.lookAt(t); c.updateMatrixWorld(); return c; };

describe('지도 보기 전체 보기', () => {
  it('부지 네 모서리가 칸 안에 들고, 가로나 세로 한쪽은 여백 FULL_PAD 까지 꽉', () => {
    const c = camOf(fullShot(AR)), W = SITE_PX_W / K, H = SITE_PX_H / K, x0 = -OX / K, z0 = -OY / K;
    const ps = [[x0, z0], [x0 + W, z0], [x0, z0 + H], [x0 + W, z0 + H]].map(([x, z]) => new THREE.Vector3(x, 0, z).project(c));
    for (const p of ps) { expect(Math.abs(p.x)).toBeLessThanOrEqual(FULL_PAD + 1e-6); expect(Math.abs(p.y)).toBeLessThanOrEqual(FULL_PAD + 1e-6); }
    const span = Math.max(Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x)), Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y)));
    expect(span).toBeGreaterThan(2 * FULL_PAD * 0.9);
  });
  it('안개는 부지 밖에서만 시작(거리 + 부지 반 대각선) · 전체 보기 거리에서도 지도 위는 안개 0', () => {
    const d = fullShot(AR).d, f = fogFor(d);
    expect(f.near).toBeCloseTo(d + SITE_R, 6); expect(f.far).toBeGreaterThan(f.near);
  });
  it('날기: 작은 지도 날기와 같은 FLY_S · 방위는 짧은 쪽 · 날아가는 중 끌면(stop) 바로 멈춤', () => {
    const a = { ...nearShot({ x: 100, z: 100 }), az: 3.0 }, b = { ...fullShot(AR), az: -3.0 };
    const f = flight(a, b, FLY_S), mid = f.step(FLY_S / 2)!;
    expect(Math.abs(mid.az - 3.0)).toBeLessThan(0.3);   // 3.0 → -3.0 은 한 바퀴 거의 도는 길이 아니라 0.28 rad 짧은 쪽
    expect(f.done).toBe(false); f.stop(); expect(f.done).toBe(true); expect(f.step(0.1)).toBeNull();
    const g = flight(a, b, FLY_S); let last: SiteShot | null = null; for (let i = 0; i < 30; i++) last = g.step(0.05) ?? last;
    expect(g.done).toBe(true); expect(last!.d).toBeCloseTo(b.d, 6);
  });
  it('움직임 줄이기면 첫 걸음에 끝 시점', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    const a = nearShot({ x: 100, z: 100 }), b = fullShot(AR), f = flight(a, b);
    const s = f.step(0.016)!; expect(f.done).toBe(true); expect(s.d).toBeCloseTo(b.d, 6); expect(s.tgt.distanceTo(b.tgt)).toBeCloseTo(0, 6);
    vi.unstubAllGlobals();
  });
  it('지금 카메라 자리 → 시점 값 되돌리기', () => {
    const s = { tgt: new THREE.Vector3(300, 0, 200), el: 0.7, az: 0.4, d: 500 }, c = camOf(s), o = shotOf(c.position, s.tgt);
    expect(o.el).toBeCloseTo(0.7, 6); expect(o.az).toBeCloseTo(0.4, 6); expect(o.d).toBeCloseTo(500, 6);
  });
});

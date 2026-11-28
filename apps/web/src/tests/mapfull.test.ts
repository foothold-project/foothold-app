// 팀장 03:19 · 03:20 관제 「지도 보기」 전체 보기: 공장 전체가 칸을 꽉 · 멀어져도 지도는 안개에 덮이지 않음 · 컷 없이 날아감(끌면 멈춤 · 움직임 줄이기면 바로)
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { FLY_S, FULL_BOT, FULL_OVER, FULL_TOP, LIFT_MAX, SITE_FOV, SITE_R, flight, fogFor, fullShot, siteBox, nearShot, shotOf, type SiteShot } from '../proto/u5map';
import { K, OX, OY, SITE_PX_H, SITE_PX_W } from '../proto/site';

const AR = 1306 / 798;
const camOf = (s: SiteShot) => { const c = new THREE.PerspectiveCamera(SITE_FOV, AR, 1, 1e5), t = s.tgt;
  c.position.set(t.x + Math.sin(s.az) * Math.cos(s.el) * s.d, Math.sin(s.el) * s.d, t.z + Math.cos(s.az) * Math.cos(s.el) * s.d); c.lookAt(t); c.updateMatrixWorld(); return c; };

describe('지도 보기 전체 보기', () => {
  it('꽉 채움(03:42): 앞 변은 칸 폭을 조금 넘침(FULL_OVER) · 먼 변은 FULL_TOP 아래 · 좋은 예처럼 부지 가운데가 화면 가운데 조금 아래', () => {
    const c = camOf(fullShot(AR)), W = SITE_PX_W / K, H = SITE_PX_H / K, x0 = -OX / K, z0 = -OY / K;
    const p = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).project(c);
    const far = p(x0, 25, z0), nl = p(x0, 0, z0 + H), nr = p(x0 + W, 0, z0 + H);
    expect(far.y).toBeLessThanOrEqual(FULL_TOP + 1e-3); expect(far.y).toBeGreaterThan(0.45); expect(far.y).toBeLessThan(0.7);   // 좋은 예: 먼 변 +0.55 · 앞 변 -0.8
    expect(nl.x).toBeLessThan(-1); expect(Math.abs(nl.x)).toBeLessThanOrEqual(FULL_OVER + 1e-3); expect(nl.y).toBeGreaterThanOrEqual(FULL_BOT - 1e-3);
    expect(nr.x).toBeCloseTo(-nl.x, 3);
    expect(LIFT_MAX).toBeLessThanOrEqual(60);
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
  it('받은 현장 모형 둘레로 맞춤(모형이 판보다 작으면 더 가까이) · 모형 없으면 판 크기', () => {
    const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(700, 10, 450)); m.position.set(450, 5, 280); g.add(m);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(2000, 0.1, 2000)); g.add(floor);   // 납작한 바닥판은 빼고
    const b = siteBox(g)!; expect(b.W).toBeCloseTo(700, 3); expect(b.H).toBeCloseTo(450, 3); expect(siteBox(null)).toBeUndefined();
    expect(fullShot(AR, undefined, undefined, b).d).toBeLessThan(fullShot(AR).d);
  });
});

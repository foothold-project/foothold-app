// 관제 지도 보기 첫 시점 · 고른 로봇으로 다가가기(팀장 00:22): 정북 · 아래로 SITE_EL · 무리 가운데가 화면 가로 가운데 · 세로 SITE_Y · 폭 = 무리 폭 × SITE_SPAN
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { FLY_S, NEAR_D, SITE_EL, SITE_FOV, SITE_MAX_K, SITE_SPAN, SITE_Y, flyTime, nearShot, shotMix, siteShot, type SiteShot } from '../proto/u5map';
import { K, SITE_PX_H, SITE_PX_W, toWorld } from '../proto/site';

const AR = 1472 / 900;
const camOf = (s: SiteShot) => { const c = new THREE.PerspectiveCamera(SITE_FOV, AR, 5, 5000), t = s.tgt;
  c.position.set(t.x + Math.sin(s.az) * Math.cos(s.el) * s.d, Math.sin(s.el) * s.d, t.z + Math.cos(s.az) * Math.cos(s.el) * s.d); c.lookAt(t); c.updateMatrixWorld(); return c; };
const scr = (c: THREE.Camera, x: number, z: number) => { const v = new THREE.Vector3(x, 0, z).project(c); return { x: (v.x + 1) / 2, y: (1 - v.y) / 2 }; };

describe('지도 보기 첫 시점', () => {
  const R = [{ x: 300, z: 200 }, { x: 360, z: 230 }, { x: 330, z: 260 }];
  it('로봇 무리 둘레 상자 가운데 = 화면 가로 가운데 · 세로 SITE_Y · 정북(옆 틂 0) · 아래로 SITE_EL', () => {
    const s = siteShot(R, AR), c = camOf(s), m = scr(c, 330, 230);
    expect(m.x).toBeCloseTo(0.5, 3); expect(m.y).toBeCloseTo(SITE_Y, 2);
    expect(s.az).toBe(0); expect((s.el * 180) / Math.PI).toBeCloseTo(SITE_EL, 6);
    expect(c.position.z).toBeGreaterThan(230); expect(c.position.x).toBeCloseTo(330, 6);   // 남쪽에서 북쪽(-z)을 봄
  });
  it('무리 가운데 깊이에서 화면 폭 = 무리 폭 × SITE_SPAN', () => {
    const W = [{ x: 300, z: 200 }, { x: 400, z: 260 }];   // 무리 폭 100 > SITE_MIN_W / SITE_SPAN
    const c = camOf(siteShot(W, AR)), a = scr(c, 300, 230), b = scr(c, 400, 230);
    expect(b.x - a.x).toBeCloseTo(1 / SITE_SPAN, 3);
  });
  it('무리가 넓게 퍼지면 화면 폭은 현장 폭 × SITE_MAX_K 까지(공장이 가로를 채움)', () => {
    const c = camOf(siteShot([{ x: 50, z: 230 }, { x: 850, z: 230 }], AR)), a = scr(c, 400, 230), b = scr(c, 500, 230);
    expect(b.x - a.x).toBeCloseTo(100 / ((SITE_PX_W / K) * SITE_MAX_K), 3);
  });
  it('로봇이 없거나 한 대 = 현장 가운데', () => {
    const mid = toWorld(SITE_PX_W / 2, SITE_PX_H / 2);
    for (const pts of [[], [{ x: 10, z: 10 }]]) { const m = scr(camOf(siteShot(pts, AR)), mid.x, mid.z); expect(m.x).toBeCloseTo(0.5, 3); expect(m.y).toBeCloseTo(SITE_Y, 2); }
  });
});

describe('고른 로봇으로 다가가기', () => {
  it('끝 시점 = 로봇이 화면 가운데 · 가까이(NEAR_D) · 처음 → 중간 → 끝(ease-in-out)', () => {
    const a = siteShot([{ x: 300, z: 200 }, { x: 400, z: 260 }], AR), b = nearShot({ x: 400, z: 260 });
    const e = scr(camOf(b), 400, 260); expect(e.x).toBeCloseTo(0.5, 6); expect(e.y).toBeCloseTo(0.5, 6); expect(b.d).toBe(NEAR_D);
    expect(shotMix(a, b, 0).d).toBe(a.d); expect(shotMix(a, b, 1).tgt.distanceTo(b.tgt)).toBeCloseTo(0, 6);
    expect(shotMix(a, b, 0.5).d).toBeCloseTo((a.d + b.d) / 2, 6);
    expect(shotMix(a, b, 0.1).d - a.d).toBeGreaterThan((b.d - a.d) * 0.1 * 0.05);   // 천천히 시작
    expect(Math.abs(shotMix(a, b, 0.1).d - a.d)).toBeLessThan(Math.abs(b.d - a.d) * 0.1);
  });
  it('움직임 시간 FLY_S(0.8~1.2 s) · 움직임 줄이기면 0(바로 끝)', () => {
    expect(FLY_S).toBeGreaterThanOrEqual(0.8); expect(FLY_S).toBeLessThanOrEqual(1.2);
    vi.stubGlobal('matchMedia', () => ({ matches: false })); expect(flyTime()).toBe(FLY_S);
    vi.stubGlobal('matchMedia', () => ({ matches: true })); expect(flyTime()).toBe(0);
    vi.unstubAllGlobals();
  });
});

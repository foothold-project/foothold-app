// 임무 탭 3D 지도 좌표: 지도(m) → 화면(px) → 지도 왕복, 바닥 높이, 카메라 뒤 · 하늘 쪽
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAY_CAM } from '../clay3d';
import { clayCamera, fromScreen, toScreen } from '../screens/missionsu6map3d';

/** 시안 시점과 같은 결의 비스듬한 위 카메라(z 위) */
const camAt = (c: [number, number], z: number) => {
  const cam = new THREE.PerspectiveCamera(30, 1600 / 900, 0.1, 500); cam.up.set(0, 0, 1);
  cam.position.set(c[0] - 4, c[1] - 30, z + 22); cam.lookAt(c[0], c[1], z); return cam;
};

describe('임무 탭 3D 지도 좌표', () => {
  it('판 가운데는 화면 가운데 · 지도 → 화면 → 지도 왕복이 1 cm 안', () => {
    const z = 0.4, cam = camAt([12, 8], z);
    const mid = toScreen(cam, [12, 8], z, 1600, 900)!;
    expect(mid[0]).toBeCloseTo(800, 3); expect(mid[1]).toBeCloseTo(450, 3);
    for (const p of [[0, 0], [12, 8], [25.5, -3.2], [-6, 14]] as [number, number][]) {
      const s = toScreen(cam, p, z, 1600, 900)!, back = fromScreen(cam, s, z, 1600, 900)!;
      expect(Math.hypot(back[0] - p[0], back[1] - p[1])).toBeLessThan(0.01);
    }
  });
  it('북쪽(y 큼)은 화면 위 · 동쪽(x 큼)은 화면 오른쪽', () => {
    const cam = camAt([0, 0], 0), a = toScreen(cam, [0, 0], 0, 1000, 1000)!;
    expect(toScreen(cam, [0, 5], 0, 1000, 1000)![1]).toBeLessThan(a[1]);
    expect(toScreen(cam, [5, 0], 0, 1000, 1000)![0]).toBeGreaterThan(a[0]);
  });
  it('바닥 높이가 다르면 다른 바닥면에서 만남 · 하늘 쪽 누름은 null · 카메라 뒤 점은 null', () => {
    const cam = camAt([0, 0], 0);
    const s = toScreen(cam, [3, 2], 1.5, 800, 600)!;
    const on15 = fromScreen(cam, s, 1.5, 800, 600)!, on0 = fromScreen(cam, s, 0, 800, 600)!;
    expect(on15[0]).toBeCloseTo(3, 2); expect(on15[1]).toBeCloseTo(2, 2);
    expect(Math.hypot(on0[0] - 3, on0[1] - 2)).toBeGreaterThan(0.5);
    expect(fromScreen(cam, [400, -600], 0, 800, 600)).toBeNull();   // 화면 위로 한 칸 더 = 하늘 쪽
    expect(toScreen(cam, [-4, -80], 0, 800, 600)).toBeNull();   // 카메라 뒤
  });
});

describe('시안 시점 카메라(CLAY_CAM 에서만 읽음) · 원근이 강해져도 왕복', () => {
  const keep = { ...CLAY_CAM };
  afterEach(() => { Object.assign(CLAY_CAM, keep); });
  for (const cam of [{ fov: CLAY_CAM.fov, elev: CLAY_CAM.elev, azim: CLAY_CAM.azim }, { fov: 40, elev: 30, azim: -35 }, { fov: 45, elev: 25, azim: 40 }]) {
    it(`화각 ${cam.fov}° · 높이각 ${cam.elev}° · 방위 ${cam.azim}°: 판 가운데 = 화면 가운데 · 네 모서리 지도 → 화면 → 지도 1 cm 안 · 카메라 화각 = CLAY_CAM`, () => {
      Object.assign(CLAY_CAM, cam);
      const c = { x: 30, y: -12 }, z = 0.25, W = 1476, H = 692, k = clayCamera(c, 80, z, W / H);
      expect(k.fov).toBe(cam.fov);
      const mid = toScreen(k, [c.x, c.y], z, W, H)!;
      expect(mid[0]).toBeCloseTo(W / 2, 3); expect(mid[1]).toBeCloseTo(H / 2, 3);
      for (const p of [[c.x - 28, c.y - 20], [c.x + 28, c.y - 20], [c.x - 28, c.y + 20], [c.x + 28, c.y + 20]] as [number, number][]) {
        const s = toScreen(k, p, z, W, H)!, back = fromScreen(k, s, z, W, H)!;
        expect(Math.hypot(back[0] - p[0], back[1] - p[1])).toBeLessThan(0.01);
      }
    });
  }
  it('원근: 같은 4 m 가 앞(카메라 쪽)이 뒤보다 화면에서 더 길다', () => {
    Object.assign(CLAY_CAM, { fov: 40, elev: 30, azim: 0 });
    const k = clayCamera({ x: 0, y: 0 }, 60, 0, 16 / 9), len = (y: number) => { const a = toScreen(k, [-2, y], 0, 1600, 900)!, b = toScreen(k, [2, y], 0, 1600, 900)!; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
    expect(len(-20)).toBeGreaterThan(len(20) * 1.2);
  });
});

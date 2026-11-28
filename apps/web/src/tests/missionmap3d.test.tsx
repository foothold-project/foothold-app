// 임무 탭 3D 지도 좌표: 지도(m) → 화면(px) → 지도 왕복, 바닥 높이, 카메라 뒤 · 하늘 쪽
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAY, CLAY_CAM, CLAY_LIGHT, CUT_SHADE, NOGO_MODEL, clayFocus, clayLight, clayBox, clayCam, clayCoat, claySpan } from '../clay3d';
import { worldGroup } from '../screens/map3d';
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
  for (const cam of [{ fov: CLAY_CAM.fov, elev: CLAY_CAM.elev, azim: CLAY_CAM.azim }, { fov: 30, elev: 37, azim: -12 }, { fov: 45, elev: 25, azim: 40 }]) {
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

describe('지도 대표 구도 규칙(자산 hero.html RULE · 지도 다섯 장 같은 카메라)', () => {
  it('값: 세로 화각 40° · 높이각 30° · 방위 -35° · k 0.62 · 초점 상자 한 변 520 m', () => {
    expect({ ...CLAY_CAM }).toEqual({ elev: 30, azim: -35, fov: 40, k: 0.62, fsMax: 520 });
  });
  it('큰 공장(1000 × 571 m) = hero_light.json 과 같은 거리 626.3 m · 카메라는 남서 위에서 북동을 봄', () => {
    const span = claySpan({ x: 1000, y: 571.4 });
    expect(span).toBeCloseTo(Math.hypot(520, 520), 6);
    const p = clayCam({ x: 0, y: 0 }, span), d = Math.hypot(p.x, p.y, p.z);
    expect(d).toBeCloseTo(626.3, 1);   // hero_light.json D
    expect(Math.asin(p.z / d) * 180 / Math.PI).toBeCloseTo(30, 6);
    expect(p.x).toBeLessThan(0); expect(p.y).toBeLessThan(0);   // 서 · 남
    expect(Math.atan2(p.x, -p.y) * 180 / Math.PI).toBeCloseTo(-35, 6);
    expect(claySpan({ x: 40, y: 12 })).toBeCloseTo(Math.hypot(40, 12), 6);   // 작은 판은 자르지 않음
  });
  it('단면: extras cut 있는 메시만 재질을 복제해 지도 높이 h 위를 자름(양면 · 그림자도 자름) · 없는 메시는 그대로 · 천장(ceil)은 숨기고 초점 상자에서 뺌', () => {
    const mk = (y: number, h = 2) => { const m = new THREE.Mesh(new THREE.BoxGeometry(4, h, 4), new THREE.MeshStandardMaterial()); m.position.set(0, y, 0); return m; };
    const root = new THREE.Group(), wall = mk(1), cutG = new THREE.Group(), cutM = mk(1.5, 3), ceil = mk(10, 0.2);
    cutG.userData.cut = 1.2; cutG.add(cutM); ceil.userData.ceil = 1;
    root.add(wall, cutG, ceil);
    const world = worldGroup(); world.add(root); world.updateMatrixWorld(true);
    clayCoat(root);
    const wm = wall.material as THREE.Material, cm = cutM.material as THREE.Material;
    expect(wm.clippingPlanes ?? []).toEqual([]); expect(wm.side).toBe(THREE.FrontSide);
    expect(cm).not.toBe(wm); expect(cm.side).toBe(THREE.DoubleSide); expect(cm.clipShadows).toBe(true);
    const pl = cm.clippingPlanes!; expect(pl.length).toBe(1);
    // 월드(지도 z 위): z 1.1 은 남고 1.3 은 잘림(평면 음수 쪽)
    expect(pl[0].distanceToPoint(new THREE.Vector3(0, 0, 1.1))).toBeGreaterThan(0);
    expect(pl[0].distanceToPoint(new THREE.Vector3(0, 0, 1.3))).toBeLessThan(0);
    const sh = { fragmentShader: 'a\n#include <dithering_fragment>\n}' } as unknown as THREE.WebGLProgramParametersWithUniforms;
    cm.onBeforeCompile(sh, {} as THREE.WebGLRenderer);
    expect(sh.fragmentShader).toContain(`if (!gl_FrontFacing) gl_FragColor.rgb *= ${CUT_SHADE};`);
    expect(ceil.visible).toBe(false); expect(wall.visible).toBe(true);
    expect(clayBox(world).max.z).toBeCloseTo(3, 6);   // 천장(z 10) 빼고 단면 메시 위끝 3
  });
  it('모형 안 금지 구역(재질 nogo*): 붉은 반투명(바닥 0.14 · 벽 0.24) · 그림자 없음 · 나머지는 점토', () => {
    const mk = (name: string): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), Object.assign(new THREE.MeshStandardMaterial(), { name }));
    const root = new THREE.Group(), f = mk('nogo_floor'), w = mk('nogo_wall'), o = mk('fk_tank'); root.add(f, w, o);
    clayCoat(root);
    const fm = f.material as THREE.MeshBasicMaterial, wm = w.material as THREE.MeshBasicMaterial;
    expect(fm.color.getHex()).toBe(NOGO_MODEL); expect(fm.opacity).toBe(0.14); expect(wm.opacity).toBe(0.24); expect(f.castShadow).toBe(false);
    expect((o.material as THREE.MeshStandardMaterial).color.getHex()).toBe(CLAY.top); expect(o.castShadow).toBe(true);
  });
});

describe('초점 상자 extras · 판 빛 (조정 23:56 결정 1 · 2)', () => {
  const boxOf = (x0: number, x1: number, y0: number, y1: number) => new THREE.Box3(new THREE.Vector3(x0, y0, 0), new THREE.Vector3(x1, y1, 3));
  it('extras.focus {fx, fz, fs} 가 있으면 그 가운데(지도 y = −fz) · 한 변 fs 로 자름(공동구 앞 40 m)', () => {
    const root = new THREE.Group(); root.userData.focus = { fx: 26.96, fz: -11.27, fs: 40 };
    const f = clayFocus(root, boxOf(0, 210, -31, 0));
    expect(f.from).toBe('extras'); expect(f.c.x).toBeCloseTo(26.96, 6); expect(f.c.y).toBeCloseTo(11.27, 6);
    expect([f.size.x, f.size.y]).toEqual([40, 31]);   // 세로 31 m 는 40 보다 작아 그대로
  });
  it('extras 가 없거나 값이 틀리면 지금 규칙: 둘레 상자 가운데 · 한 변 520 m 상한', () => {
    for (const focus of [undefined, { fx: 1, fz: 2 }, { fx: 'a', fz: 0, fs: 40 }, { fx: 0, fz: 0, fs: 0 }]) {
      const root = new THREE.Group(); if (focus) root.userData.focus = focus;
      const f = clayFocus(root, boxOf(0, 1000, -571.4, 0));
      expect(f.from).toBe('box'); expect(f.c.x).toBeCloseTo(500, 6); expect(f.c.y).toBeCloseTo(-285.7, 6);
      expect([f.size.x, f.size.y]).toEqual([520, 520]);
    }
  });
  it('판 빛: 밝음 반구 1.15 · 해 3.2 · 노출 0.92 · 점토 색 그대로, 어둠 반구 2.6 · 해 1.2 · 노출 0.72 · 점토 × #a9b2bd · ACES · 금지 구역 재질은 그대로', () => {
    const root = new THREE.Group(), wall = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()), ng: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(), Object.assign(new THREE.MeshStandardMaterial(), { name: 'nogo_floor' }));
    const wall2 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    root.add(wall, wall2, ng); clayCoat(root);
    expect(wall2.material).toBe(wall.material);   // 점토는 재질 하나를 여러 메시가 같이 씀
    const gl = { toneMapping: THREE.NoToneMapping as THREE.ToneMapping, toneMappingExposure: 1 }, hemi = new THREE.HemisphereLight(), sun = new THREE.DirectionalLight();
    clayLight(gl, hemi, sun, root, true);
    expect([gl.toneMapping, gl.toneMappingExposure, hemi.intensity, sun.intensity]).toEqual([THREE.ACESFilmicToneMapping, 0.92, 1.15, 3.2]);
    expect((wall.material as THREE.MeshStandardMaterial).color.getHex()).toBe(CLAY.top);
    clayLight(gl, hemi, sun, root, false); clayLight(gl, hemi, sun, root, false);   // 어둠을 두 번 불러도 곱은 한 번
    expect([gl.toneMappingExposure, hemi.intensity, sun.intensity, hemi.color.getHex(), hemi.groundColor.getHex()]).toEqual([0.72, 2.6, 1.2, 0xa8b8cc, 0x161c24]);
    expect((wall.material as THREE.MeshStandardMaterial).color.getHex()).toBe(new THREE.Color(CLAY.top).multiply(new THREE.Color(0xa9b2bd)).getHex());
    expect((ng.material as THREE.MeshBasicMaterial).color.getHex()).toBe(NOGO_MODEL);
    clayLight(gl, hemi, sun, root, true);   // 다시 밝음 = 곱이 쌓이지 않음
    expect((wall.material as THREE.MeshStandardMaterial).color.getHex()).toBe(CLAY.top);
    expect(CLAY_LIGHT.dark.tone).toBe(0xa9b2bd);
  });
});

// 점토 3D 결 공용(시안 u7_1 지도 미리 보기 · u6 임무 지도): 밝은 회색 무광 점토 · 부드러운 그림자 · 금지 구역 붉은 빗금 · 시안 시점.
// 지도 탭(u7/clay.tsx ClayMap · map3d.tsx Map3D still)과 임무 탭(missionsu6map3d.tsx)이 같이 쓴다. 값은 u7/clay.tsx 에서 그대로 옮김.
import * as THREE from 'three';
import type { MapVersion } from '../../contracts/ts';

/** 점토 벽 높이(m) · 색(밝은 회색 무광) · 바닥 색 */
export const CLAY = { wall: 1.4, top: 0xdedbd5, floor: 0xcdc9c2, nogo: 0xd23c3c };
/** 시안 시점(build_scene.py 와 같은 결): 높이각 37° · 방위 -12° · 화각 30° */
export const CLAY_CAM = { elev: 37, azim: -12, fov: 30 };

/** 시안 시점 카메라 자리: 판 가운데를 보고, 판 대각선이 화면에 들어오는 거리 */
export function clayCam(c: { x: number; y: number }, span: number) {
  const e = (CLAY_CAM.elev * Math.PI) / 180, a = (CLAY_CAM.azim * Math.PI) / 180, d = (span / 2) / Math.tan(((CLAY_CAM.fov / 2) * Math.PI) / 180) * 1.05;
  return { x: c.x + Math.sin(a) * Math.cos(e) * d, y: c.y - Math.cos(a) * Math.cos(e) * d, z: Math.sin(e) * d };
}

/** 금지 구역 빗금 무늬(붉은 사선). 2D 그리기가 없으면(시험 환경) 무늬 없이 옅은 빨강 */
export function hatch(): THREE.Texture | null {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); if (!g) return null;
  g.fillStyle = 'rgba(210,60,60,.18)'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(210,60,60,.9)'; g.lineWidth = 6;
  for (let i = -64; i <= 128; i += 22) { g.beginPath(); g.moveTo(i, 64); g.lineTo(i + 64, 0); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** 모형 덮기: 모든 면을 점토 재질 하나로(원래 재질은 거둠) · 그림자 주고받기 */
export function clayCoat(root: THREE.Object3D) {
  const clay = new THREE.MeshStandardMaterial({ color: CLAY.top, roughness: 1, metalness: 0 });
  root.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()); m.material = clay; m.castShadow = m.receiveShadow = true; });
}

/** 부드러운 그림자(해 하나) · 금지 구역 붉은 빗금 + 테두리(바닥 z 바로 위) */
export function clayShade(scene: THREE.Scene, sun: THREE.DirectionalLight, size: THREE.Vector3, z: number, v: Pick<MapVersion, 'features'>) {
  const span = Math.hypot(size.x, size.y);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 4; sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, { left: -span / 2, right: span / 2, top: span / 2, bottom: -span / 2, near: 0.1, far: span * 3 + 60 });
  const tex = hatch();
  for (const zn of v.features.zones.filter((x) => x.type === 'NO_GO' && x.polygon.length >= 3)) {
    const t = tex?.clone() ?? null; if (t) { t.needsUpdate = true; t.repeat.set(0.5, 0.5); }
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(zn.polygon.map(([x, y]) => new THREE.Vector2(x, y)))), new THREE.MeshBasicMaterial(t ? { map: t, transparent: true, depthWrite: false } : { color: CLAY.nogo, transparent: true, opacity: 0.25, depthWrite: false }));
    fill.position.z = z + 0.03; fill.renderOrder = 1; scene.add(fill);
    scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(zn.polygon.map(([x, y]) => new THREE.Vector3(x, y, z + 0.05))), new THREE.LineBasicMaterial({ color: CLAY.nogo })));
  }
}

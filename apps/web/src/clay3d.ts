// 점토 3D 결 공용(시안 u7_1 지도 미리 보기 · u6 임무 지도): 밝은 회색 무광 점토 · 부드러운 그림자 · 금지 구역 붉은 빗금 · 시안 시점.
// 지도 탭(u7/clay.tsx ClayMap · map3d.tsx Map3D still)과 임무 탭(missionsu6map3d.tsx)이 같이 쓴다. 값은 u7/clay.tsx 에서 그대로 옮김.
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
// Draco 디코더 = three 패키지 안 파일(proto/site.ts 와 같은 길 · 외부 CDN 없음). 판 모형(maps_v2 · Draco + WebP)을 읽는다
import dracoJs from 'three/examples/jsm/libs/draco/draco_wasm_wrapper.js?url';
import dracoWasm from 'three/examples/jsm/libs/draco/draco_decoder.wasm?url';
import type { MapVersion } from '../../contracts/ts';

/** 점토 벽 높이(m) · 색(밝은 회색 무광) · 바닥 색 */
export const CLAY = { wall: 1.4, top: 0xdedbd5, floor: 0xcdc9c2, nogo: 0xd23c3c };
/** 지도 대표 구도(지도 다섯 장 같은 카메라 규칙 · 자산 hero.html RULE 그대로): 세로 화각 40° · 높이각 30° · 방위 -35°(남에서 서쪽으로 돈 자리, 북동을 봄)
 *  · 거리 계수 k(앞 덩어리는 화면 밖으로 조금 잘림) · 초점 상자 한 변 상한 fsMax(m) */
export const CLAY_CAM = { elev: 30, azim: -35, fov: 40, k: 0.62, fsMax: 520 };

/** 초점 상자 가로 대각선(m): 모형 둘레 상자 가로 · 세로를 각각 fsMax 로 자름 */
export const claySpan = (size: { x: number; y: number }) => Math.hypot(Math.min(size.x, CLAY_CAM.fsMax), Math.min(size.y, CLAY_CAM.fsMax));

/** 시안 시점 카메라 자리(c 에서 뺀 높이는 바닥 기준): 거리 D = k · (span / 2) / tan(화각 / 2) */
export function clayCam(c: { x: number; y: number }, span: number) {
  const e = (CLAY_CAM.elev * Math.PI) / 180, a = (CLAY_CAM.azim * Math.PI) / 180, d = (CLAY_CAM.k * (span / 2)) / Math.tan(((CLAY_CAM.fov / 2) * Math.PI) / 180);
  return { x: c.x + Math.sin(a) * Math.cos(e) * d, y: c.y - Math.cos(a) * Math.cos(e) * d, z: Math.sin(e) * d };
}

/** 초점 상자(지도 좌표): glb 장면 extras.focus {fx, fz, fs}(three 좌표 · fz = 지도 −y · 공동구처럼 긴 판의 앞쪽 상자)가 있으면 그것,
 *  없으면 모형 둘레 상자 가운데 · 한 변 fsMax 로 자름(hero.html 과 같음). 돌려주는 size = 자른 가로 · 세로(높이는 그대로) */
export function clayFocus(root: THREE.Object3D, box: THREE.Box3) {
  const sz = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  const f = root.userData?.focus as { fx?: unknown; fz?: unknown; fs?: unknown } | undefined;
  const ok = !!f && [f.fx, f.fz, f.fs].every((x) => typeof x === 'number' && Number.isFinite(x)) && (f.fs as number) > 0;
  const lim = ok ? (f!.fs as number) : CLAY_CAM.fsMax;
  return { c: ok ? new THREE.Vector3(f!.fx as number, -(f!.fz as number), mid.z) : mid, size: new THREE.Vector3(Math.min(sz.x, lim), Math.min(sz.y, lim), sz.z), from: ok ? 'extras' as const : 'box' as const };
}

/** 판 빛(hero.html LOOK 그대로): 밝음 = 반구 1.15 · 해 3.2 · 노출 0.92, 어둠 = 반구 2.6 · 해 1.2 · 노출 0.72 · 재질 색 × #a9b2bd. 톤 매핑 ACES */
export const CLAY_LIGHT = {
  light: { hemi: [0xffffff, 0xd9dcdb, 1.15] as const, sun: 3.2, exp: 0.92, tone: 0xffffff },
  dark: { hemi: [0xa8b8cc, 0x161c24, 2.6] as const, sun: 1.2, exp: 0.72, tone: 0xa9b2bd },
};
/** 판(밝음 · 어둠) 빛을 입힘. 판이 바뀌면 다시 부르고 다시 그린다 */
export function clayLight(gl: Pick<THREE.WebGLRenderer, 'toneMapping' | 'toneMappingExposure'>, hemi: THREE.HemisphereLight, sun: THREE.DirectionalLight, root: THREE.Object3D, light: boolean) {
  const k = light ? CLAY_LIGHT.light : CLAY_LIGHT.dark;
  gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = k.exp;
  hemi.color.setHex(k.hemi[0]); hemi.groundColor.setHex(k.hemi[1]); hemi.intensity = k.hemi[2];
  sun.color.setHex(0xfff6ea); sun.intensity = k.sun;
  // 같은 재질을 여러 메시가 써도 재질마다 한 번만(Set) · 늘 원래 점토 색에서 다시 계산(판을 바꿔도 곱이 쌓이지 않음)
  const mats = new Set<THREE.MeshStandardMaterial>();
  root.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if ((o as THREE.Mesh).isMesh && m?.userData?.clay) mats.add(m); });
  mats.forEach((m) => m.color.setHex(CLAY.top).multiply(new THREE.Color(k.tone)));
}

/** 모형 안 금지 구역 재질(nogo*) 색 */
export const NOGO_MODEL = 0xff4d4f;
/** 단면 자른 면 어둡기(뒷면 색 곱) */
export const CUT_SHADE = 0.62;
/** 위로 올라가며 처음 만나는 extras(userData) 값 */
const upData = (o: THREE.Object3D | null, k: string): unknown => { for (let p = o; p; p = p.parent) if (p.userData?.[k] != null) return p.userData[k]; return undefined; };

/** 천장(extras ceil=1) 숨김 · 단면(extras cut = h m): 지도 높이 h 위를 잘라 냄(높이 기준 = 모형 원점 0, hero.html 과 같음).
 *  자를 평면은 월드 좌표(지도 z 위)라 모형을 worldGroup 에 넣은 뒤 부른다. 그리는 쪽은 renderer.localClippingEnabled = true */
export function clayCut(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    if (upData(m, 'ceil')) { m.visible = false; return; }
    const h = upData(m, 'cut'); if (h == null || !Number.isFinite(Number(h))) return;
    const mt = (m.material as THREE.Material).clone();
    mt.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), Number(h))]; mt.side = THREE.DoubleSide; mt.clipShadows = true;
    mt.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>\n  if (!gl_FrontFacing) gl_FragColor.rgb *= ${CUT_SHADE};`); };
    m.material = mt;
  });
}

let draco: DRACOLoader | null = null;
/** glb 읽개에 Draco 풀개를 붙임(한 번 만든 풀개를 같이 씀) */
export const withDraco = (l: GLTFLoader) => l.setDRACOLoader(draco ??= new DRACOLoader().setDecoderPath({ js: dracoJs, wasm: dracoWasm }));

/** 금지 구역 빗금 무늬(붉은 사선). 2D 그리기가 없으면(시험 환경) 무늬 없이 옅은 빨강 */
export function hatch(): THREE.Texture | null {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); if (!g) return null;
  g.fillStyle = 'rgba(210,60,60,.18)'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(210,60,60,.9)'; g.lineWidth = 6;
  for (let i = -64; i <= 128; i += 22) { g.beginPath(); g.moveTo(i, 64); g.lineTo(i + 64, 0); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** 초점 상자 재기: 보이는 면만(숨긴 천장 빼고 · hero.html 과 같음) */
export function clayBox(root: THREE.Object3D) {
  const b = new THREE.Box3(); root.updateMatrixWorld(true);
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.visible) b.expandByObject(o); });
  return b.isEmpty() ? new THREE.Box3().setFromObject(root) : b;
}

/** 모형 덮기: 모든 면을 점토 재질 하나로(원래 재질은 거둠) · 그림자 주고받기 */
export function clayCoat(root: THREE.Object3D) {
  const clay = new THREE.MeshStandardMaterial({ color: CLAY.top, roughness: 1, metalness: 0 }); clay.userData.clay = true;
  root.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    const old = Array.isArray(m.material) ? m.material : [m.material], n = old[0]?.name ?? '';
    old.forEach((x) => x.dispose());
    // 모형 안 금지 구역(재질 이름 nogo*): 붉은 반투명 · 그림자 없음(바닥 0.14 · 벽 0.24, hero.html 과 같음)
    if (n.startsWith('nogo')) { m.material = new THREE.MeshBasicMaterial({ color: NOGO_MODEL, transparent: true, opacity: n === 'nogo_floor' ? 0.14 : 0.24, side: THREE.DoubleSide, depthWrite: false }); m.castShadow = false; m.receiveShadow = false; return; }
    m.material = clay; m.castShadow = m.receiveShadow = true;
  });
  clayCut(root);
}

/** 부드러운 그림자(해 하나) · 금지 구역 붉은 빗금 + 테두리(바닥 z 바로 위) */
export function clayShade(scene: THREE.Scene, sun: THREE.DirectionalLight, size: THREE.Vector3, z: number, v: Pick<MapVersion, 'features'>, c?: { x: number; y: number }) {
  // 해 = 초점 가운데 + (서 0.8S · 북 0.5S · 위 2.2S), 그림자 상자 = 초점 상자만(S = 0.9 · 긴 변) · hero.html 과 같음
  const S = 0.9 * Math.max(Math.min(size.x, CLAY_CAM.fsMax), Math.min(size.y, CLAY_CAM.fsMax), 1);
  if (c) { sun.position.set(c.x - 0.8 * S, c.y + 0.5 * S, z + 2.2 * S); sun.target.position.set(c.x, c.y, z); sun.target.updateMatrixWorld(); }
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 4; sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: S * 6 });
  const tex = hatch();
  for (const zn of v.features.zones.filter((x) => x.type === 'NO_GO' && x.polygon.length >= 3)) {
    const t = tex?.clone() ?? null; if (t) { t.needsUpdate = true; t.repeat.set(0.5, 0.5); }
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(zn.polygon.map(([x, y]) => new THREE.Vector2(x, y)))), new THREE.MeshBasicMaterial(t ? { map: t, transparent: true, depthWrite: false } : { color: CLAY.nogo, transparent: true, opacity: 0.25, depthWrite: false }));
    fill.position.z = z + 0.03; fill.renderOrder = 1; scene.add(fill);
    scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(zn.polygon.map(([x, y]) => new THREE.Vector3(x, y, z + 0.05))), new THREE.LineBasicMaterial({ color: CLAY.nogo })));
  }
}

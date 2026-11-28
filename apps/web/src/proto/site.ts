// 시안 3D 자산(저장소 밖 /proto-assets/)과 좌표: 시안 shared/site3d.js · go2view.js 의 값 그대로.
// 현장 = assets/maps_large/3d/factory_site.glb (factory_kr · 3200×2000 px · 3.5 px/m · 원점 (25,20)), 로봇 = shared/go2_isaac.glb, 걷기 = shared/go2_walk.json.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Location } from '../../../contracts/ts';

export const ASSET = '/proto-assets';
export const SITE_GLB = `${ASSET}/assets/maps_large/3d/factory_site.glb`, GO2_GLB = `${ASSET}/shared/go2_isaac.glb`, WALK_JSON = `${ASSET}/shared/go2_walk.json`;
/** 지도 px → 현장 m (site3d.js K · OX · OY) */
export const K = 3.5, OX = 25, OY = 20;
export const toWorld = (px: number, py: number, y = 0) => new THREE.Vector3((px - OX) / K, y, (py - OY) / K);

/** 서버 위치(m · x 오른쪽 · y 위 · yaw 반시계, 지도 원점) → 현장 좌표. 서버 지도 원점과 시안 현장 원점이 같다고 본다(미확인 · 한 곳에서만 바꾼다).
 *  three 는 y 가 위, 로봇 모형은 +z 를 본다: x = x, z = -y, 몸 돌림 = yaw + π/2 */
export function sitePose(l: Location | null | undefined): { x: number; z: number; rot: number } | null {
  if (!l || l.x == null || l.y == null || !Number.isFinite(l.x) || !Number.isFinite(l.y)) return null;
  return { x: l.x, z: -l.y, rot: (l.yaw ?? 0) + Math.PI / 2 };
}
/** 현장 좌표 → 지도 px (작은 지도 점 자리) */
export const toMapPx = (x: number, z: number): [number, number] => [x * K + OX, z * K + OY];

export const LEGS = ['FL', 'FR', 'RL', 'RR'] as const;
export type Walk = { dt: number; frames: number[][] };
const MAT: Record<string, [number, number]> = {
  road: [0x161b21, 0.95], pave: [0x12161b, 0.95], dikefloor: [0x101419, 0.95], wall: [0x1d242c, 0.8],
  steel: [0x2b343e, 0.6], pipe: [0x2a323b, 0.55], equip: [0x222a33, 0.7], building: [0x1f262e, 0.8],
  water: [0x0c161d, 0.3], tank: [0x252d36, 0.6], tankroof: [0x2a333d, 0.6],
};
const EDGE: Record<string, number> = { building: 0.55, tank: 0.35, tankroof: 0.35, wall: 0.25, equip: 0.22 };
/** 밝은 판(DESIGN.md 밝음 1): 시안 흰 점토 정사영(shared/map_large_factory_top.jpg) 결 · 바탕 #F6F7F6 · 선 #DCE0DE · 흐린 글 #5E6662 */
const MAT_L: Record<string, [number, number]> = {
  road: [0xe3e7e4, 0.95], pave: [0xeef0ee, 0.95], dikefloor: [0xe8ebe9, 0.95], wall: [0xf2f4f2, 0.85],
  steel: [0xd2d8d4, 0.6], pipe: [0xcbd2ce, 0.55], equip: [0xe4e8e5, 0.7], building: [0xfbfcfb, 0.85],
  water: [0xd5e2e2, 0.3], tank: [0xf0f2f0, 0.6], tankroof: [0xf8f9f8, 0.6],
};
const EDGE_D = 0x6f8296, EDGE_L = 0x9aa39e;
/** 지금 화면이 밝은 판인지(theme.tsx syncTheme 가 .fh.light 를 <html data-theme> 로 옮긴 값) */
export const lightNow = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';
/** 현장 모형 재질을 판에 맞춘다. 바뀔 때만 다시 칠함 */
export function toneSite(site: THREE.Object3D, light: boolean) {
  if (site.userData.light === light) return;
  site.userData.light = light;
  site.traverse((o) => {
    const kind = o.userData.kind as string | undefined;
    if (kind) { const [col, rough] = (light ? MAT_L : MAT)[kind] || (light ? [0xeef0ee, 0.8] : [0x1f262e, 0.8]); const mt = (o as THREE.Mesh).material as THREE.MeshStandardMaterial; mt.color.setHex(col); mt.roughness = rough; }
    if (o.userData.edge) ((o as THREE.LineSegments).material as THREE.LineBasicMaterial).color.setHex(light ? EDGE_L : EDGE_D);
  });
}

const loader = new GLTFLoader();
const once = new Map<string, Promise<THREE.Group | null>>();
const glb = (url: string) => {
  if (!once.has(url)) once.set(url, new Promise((res) => loader.load(url, (g) => res(g.scene), undefined, () => res(null))));
  return once.get(url)!;
};
let walkP: Promise<Walk | null> | null = null;
export const loadWalk = () => (walkP ??= fetch(WALK_JSON).then((r) => (r.ok ? r.json() : null)).catch(() => null));

/** 현장 모형(시안 dress 그대로 · 어두운 회청 재질 · 가는 테두리 선). 못 받으면 null */
export function loadSite(): Promise<THREE.Group | null> {
  return glb(SITE_GLB).then((src) => {
    if (!src) return null;
    const site = src.clone(true);
    site.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = ((m.material as THREE.Material)?.name || m.name).replace(/^fk_/, '');
      if (name.startsWith('nogo')) {
        m.material = new THREE.MeshBasicMaterial({ color: 0xff4d4f, transparent: true, opacity: name === 'nogo_floor' ? 0.07 : 0.16, side: THREE.DoubleSide, depthWrite: false });
        return;
      }
      const [col, rough] = MAT[name] || [0x1f262e, 0.8];
      m.material = new THREE.MeshStandardMaterial({ color: col, roughness: rough, metalness: 0.15 }); m.userData.kind = name;
      if (EDGE[name]) { const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 32), new THREE.LineBasicMaterial({ color: EDGE_D, transparent: true, opacity: EDGE[name] })); e.userData.edge = true; m.add(e); }
    });
    site.userData.light = false;
    return site;
  });
}

export type Body = { root: THREE.Object3D; joints: Record<string, { o: THREE.Object3D; r0: THREE.Euler }>; top: number };
/** Go2 모형 하나(시안 go2view: 길이 0.62 m 로 맞춰 바닥에 세움 · 정면 +z). scale = 현장 표시 배율(site3d S) */
export function loadGo2(scale = 1): Promise<Body | null> {
  return glb(GO2_GLB).then((src) => {
    if (!src) return null;
    const root = src.clone(true);
    let box = new THREE.Box3().setFromObject(root); const sz = box.getSize(new THREE.Vector3());
    root.scale.multiplyScalar((0.62 / Math.max(sz.x, sz.z)) * scale);
    box = new THREE.Box3().setFromObject(root); const c = box.getCenter(new THREE.Vector3());
    root.position.x -= c.x; root.position.z -= c.z; root.position.y -= box.min.y;
    const joints: Body['joints'] = {};
    root.traverse((o) => {
      if (/^(FL|FR|RL|RR)_(hip|thigh|calf)$/.test(o.name)) joints[o.name] = { o, r0: o.rotation.clone() };
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        if (m.geometry && !m.geometry.attributes.normal) m.geometry.computeVertexNormals();
        m.material = (m.material as THREE.MeshStandardMaterial).clone(); m.userData.c0 = (m.material as THREE.MeshStandardMaterial).color.clone();
      }
    });
    return { root, joints, top: box.max.y - box.min.y };
  });
}

/** 걷기 기록 t 초 자리의 관절(시안 go2view WALK 그대로) */
export function applyWalk(b: Body, w: Walk, t: number) {
  const n = w.frames.length, f = (t / w.dt) % n, i0 = Math.floor(f), i1 = (i0 + 1) % n, a = f - i0;
  LEGS.forEach((L, li) => { for (const [ji, part, ax] of [[0, 'hip', 'z'], [1, 'thigh', 'x'], [2, 'calf', 'x']] as const) {
    const j = b.joints[`${L}_${part}`]; if (!j) continue; j.o.rotation.copy(j.r0); j.o.rotation[ax] += w.frames[i0][ji * 4 + li] * (1 - a) + w.frames[i1][ji * 4 + li] * a; } });
}
/** 서 있는 기본 자세로 */
export function applyRest(b: Body) { for (const j of Object.values(b.joints)) j.o.rotation.copy(j.r0); }
/** 엎드림(시안 pose 'down': thigh +0.8 · calf -1.6) */
export function applyDown(b: Body) {
  applyRest(b);
  for (const L of LEGS) { const th = b.joints[`${L}_thigh`], ca = b.joints[`${L}_calf`]; if (th) th.o.rotation.x += 0.8; if (ca) ca.o.rotation.x += -1.6; }
}

export function ringLine(p: THREE.Vector3, rad: number, col: number, op: number) {
  const pts = Array.from({ length: 97 }, (_, i) => new THREE.Vector3(p.x + Math.cos((i / 96) * Math.PI * 2) * rad, p.y, p.z + Math.sin((i / 96) * Math.PI * 2) * rad));
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: op }));
}

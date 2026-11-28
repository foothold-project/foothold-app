// 지도 탭 층 썸네일 3D(팀장 00:14 · 공동구처럼 긴 지도는 평면도가 줄 하나로 보임): 판에 3D 모형이 있으면 hero 카메라 규칙(clay3d)으로
// 작은 정지 그림 한 장을 그려 그림 주소로 돌려준다. WebGL 문맥은 이 파일의 그리개 하나만 쓰고(썸네일이 여럿이어도), 그리기는 한 번에 하나씩 줄 세운다.
// 같은 판 · 모형 · 크기 · 판 빛이면 다시 그리지 않는다. 그리지 못하면(모형 없음 · 받기 실패 · WebGL 없음) null = 부르는 쪽이 평면도.
import * as THREE from 'three';
import type { MapVersion } from '../../../contracts/ts';
import { clayBox, clayCoat, clayFocus, clayLight, clayShade, claySpan, withDraco } from '../clay3d';
import { floorZ, modelBytes, modelOf, worldGroup } from './map3d';
import { clayCamera } from './missionsu6map3d';

let gl: THREE.WebGLRenderer | null | undefined;   // undefined = 아직 안 만듦 · null = 이 브라우저에서 못 만듦
let line: Promise<unknown> = Promise.resolve();
const shots = new Map<string, Promise<string | null>>();
/** 지금까지 만든 그리개 수(시험용 읽기 · 늘 0 또는 1) */
export const stillGl = () => (gl ? 1 : 0);
/** 다시 처음부터(시험) */
export function resetStill() { gl?.dispose(); gl = undefined; shots.clear(); line = Promise.resolve(); }

/** 썸네일 한 장(w × h px) 주소. 모형이 없으면 바로 null */
export function clayStill(v: MapVersion, w: number, h: number, light: boolean): Promise<string | null> {
  const sha = modelOf(v);
  if (!sha || w < 2 || h < 2) return Promise.resolve(null);
  const key = `${v.id}:${sha}:${Math.round(w)}x${Math.round(h)}:${light ? 'l' : 'd'}`;
  let p = shots.get(key);
  if (!p) {
    p = line.then(() => draw(v, sha, Math.round(w), Math.round(h), light)).catch(() => null);
    line = p; shots.set(key, p);
    p.then((u) => { if (!u) shots.delete(key); });   // 실패는 기억하지 않음(다음에 다시)
  }
  return p;
}

async function draw(v: MapVersion, sha: string, w: number, h: number, light: boolean) {
  const buf = await modelBytes(v.id, sha);
  if (gl === undefined) {
    try {
      gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      gl.outputColorSpace = THREE.SRGBColorSpace; gl.localClippingEnabled = true;
      if (gl.shadowMap) { gl.shadowMap.enabled = true; gl.shadowMap.type = THREE.PCFSoftShadowMap; }
    } catch { gl = null; }
  }
  if (!gl) return null;
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const g = await withDraco(new GLTFLoader()).parseAsync(buf, '');
  const scene = new THREE.Scene();
  try {
    const z = floorZ(g.scene, v), model = worldGroup(); model.add(g.scene); scene.add(model);
    clayCoat(g.scene);
    const { c, size } = clayFocus(g.scene, clayBox(model));
    const hemi = new THREE.HemisphereLight(), sun = new THREE.DirectionalLight(); scene.add(hemi, sun, sun.target);
    clayShade(scene, sun, size, z, v, c); clayLight(gl, hemi, sun, g.scene, light);
    const cam = clayCamera(c, claySpan(size), z, w / h);
    gl.setPixelRatio(1); gl.setSize(w, h, false); gl.setClearColor(0x000000, 0); gl.clear(); gl.render(scene, cam);
    return gl.domElement.toDataURL('image/png');
  } finally {
    scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mt = m.material as (THREE.Material & { map?: THREE.Texture }) | undefined; mt?.map?.dispose(); mt?.dispose?.(); });
  }
}

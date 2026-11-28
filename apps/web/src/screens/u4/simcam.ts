// 시뮬 시점(로봇 탭 앞 카메라 칸 · 「카메라」 보기): 실제 카메라 영상이 아니다. 서버 지도판의 3D 현장 안, 서버가 준 그 로봇 위치(x · y · yaw)에
// Go2 앞 카메라 높이로 놓은 카메라에서 본 그림. 칸 아래에 늘 「시뮬 시점」 표지를 붙인다(robotu4.tsx).
// 현장: 판의 3D 모형(MapVersion.model_sha256 · GET …/model, map3d.tsx 와 같은 좌표 변환)이 먼저. 모형이 없으면 그 판이 시안 공장 터와
// 같은 좌표계(factoryFrame)일 때만 시안 factory_site.glb. 둘 다 아니면 그리지 않는다(부르는 쪽이 「카메라 신호 없음」 + 까닭).
// WebGL 맥락은 렌더러 하나(브라우저 한도 약 16): 화면 밖 캔버스 하나에 칸마다 차례로 그려 각 칸의 2D 캔버스로 옮긴다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MapVersion } from '../../../../contracts/ts';
import { floorZ, modelBytes, modelOf, worldGroup } from '../map3d';
import { SITE_TOP } from '../../proto/site';

/** Go2 앞 카메라 높이(m, 바닥 위). 제조사 제원 서 있는 몸 크기 70 × 31 × 40 cm(높이 0.40 m), 앞 카메라는 머리 앞면 위쪽이라 몸 위끝보다 조금 아래 */
export const CAM_H = 0.36;
/** 세로 화각(도) · 아래로 숙임(라디안). 앞 카메라 실제 값을 받는 계약이 없어 보기용으로 정한 값(넓은 앞 카메라 느낌) */
export const CAM_FOV = 62, CAM_PITCH = 0.08;
/** 시안 공장 터 3D(저장소 밖 자산 · vite FH_ASSET_DIR → /proto-assets/) */
export const FACTORY_GLB = '/proto-assets/assets/maps_large/3d/factory_site.glb';
/** 시안 공장 터 지도 그림(3200 × 2000 px · 3.5 px/m · 그림 원점 (25, 20) px · 900 m × 560 m) */
export const FACTORY_PNG = SITE_TOP.dark;   // 공장 질감판 위 그림(어둠) · 경로는 proto/site.ts SITE_TOP 한 곳(관제 작은 지도와 같음)
/** 밝은 판 공장 그림: 시안 build_scene.py 가 같은 3200 × 2000 px 에 정사영으로 뽑은 흰 점토 결 그림(지도 탭 · 관제와 같은 파일) */
export const FACTORY_LIGHT = SITE_TOP.light;   // 같은 질감판 위 그림(밝음)
const K = 3.5, OX = 25, OY = 20, FW = 3200, FH = 2000;
/** 서버 판 m(x 동 · y 북) → 시안 공장 그림 px. 시안 design 변환 그대로(px = 25 + 3.5 x, py = 20 − 3.5 y) · 데모 현장 판에만 쓴다 */
export const factoryPx = (x: number, y: number) => [OX + K * x, OY - K * y] as const;
export const FACTORY_W = FW, FACTORY_H = FH;

/** 이 판이 시안 공장 터와 같은 좌표계인가. 시안 site3d.js: x = (px − 25) / 3.5, 남쪽 = (py − 20) / 3.5 m.
 *  서버 판(toPixel: 원점 왼쪽 아래 · y 북)으로 같으려면 3200 × 2000 px · 해상도 1/3.5 m · 원점 (−25/3.5, (20 − 2000)/3.5) · 회전 0 */
export function factoryFrame(v: Pick<MapVersion, 'width' | 'height' | 'resolution' | 'origin'>) {
  const [ox, oy, yaw] = v.origin;
  return v.width === FW && v.height === FH && Math.abs(v.resolution - 1 / K) < 1e-4
    && Math.abs(ox + OX / K) < 0.05 && Math.abs(oy - (OY - FH) / K) < 0.05 && Math.abs(yaw) < 1e-3;
}

/** 지도 world(m, x 동 · y 북 · z 위)의 카메라 자리와 바라보는 점 */
export function camPose(l: { x: number; y: number; yaw: number }, floor: number) {
  const z = floor + CAM_H, c = Math.cos(l.yaw), s = Math.sin(l.yaw);
  return { at: [l.x, l.y, z] as const, look: [l.x + c * 10, l.y + s * 10, z - Math.tan(CAM_PITCH) * 10] as const };
}

type Site = { scene: THREE.Scene; z: number };
/** 받은 현장(판 · 모형 sha 마다 하나, 최근 2개) */
const SITES = new Map<string, Promise<Site>>();
export const siteKey = (v: MapVersion) => (modelOf(v) ? `m:${v.id}:${modelOf(v)}` : factoryFrame(v) ? 'factory' : null);

function wrap(root: THREE.Object3D, z: number): Site {
  const scene = new THREE.Scene(), g = worldGroup();
  g.add(root); scene.add(g);
  scene.background = new THREE.Color(0x0e1116);
  scene.fog = new THREE.Fog(0x0e1116, 8, 70);
  scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x14181d, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(30, -20, 60); scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x161b21, roughness: 0.95 }));
  floor.position.z = z - 0.01; scene.add(floor);   // 시안 glb 는 땅판을 뺐다(site3d.js) · 모형 판도 바닥 밖은 비어 보이지 않게
  return { scene, z };
}
async function load(v: MapVersion, cancel?: AbortSignal): Promise<Site> {
  const gl = new GLTFLoader(), sha = modelOf(v);
  if (sha) {
    const buf = await modelBytes(v.id, sha, cancel), g = await gl.parseAsync(buf, '');
    const s = wrap(g.scene, 0); s.z = floorZ(g.scene, v); return s;
  }
  const g = await gl.loadAsync(FACTORY_GLB);
  return wrap(g.scene, 0);
}
export function site(v: MapVersion, cancel?: AbortSignal) {
  const k = siteKey(v);
  if (!k) return null;
  let p = SITES.get(k);
  if (!p) {
    p = load(v, cancel); SITES.set(k, p);
    p.catch(() => { if (SITES.get(k) === p) SITES.delete(k); });   // 실패는 기억하지 않음(다음에 다시)
    while (SITES.size > 2) SITES.delete(SITES.keys().next().value!);
  }
  return p;
}

/** 렌더러 하나 + 칸 목록. 칸 = 2D 캔버스 · 현장 · 지금 자리. 자리가 바뀐 칸만 다시 그린다(초당 최대 15번) */
type View = { cv: HTMLCanvasElement; s: Site | null; pose: { x: number; y: number; yaw: number } | null; drawn: string };
const VIEWS = new Set<View>();
let gl: THREE.WebGLRenderer | null | undefined, cam: THREE.PerspectiveCamera | null = null, raf = 0, last = 0;
function renderer() {
  if (gl !== undefined) return gl;
  try { gl = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, preserveDrawingBuffer: true }); gl.outputColorSpace = THREE.SRGBColorSpace; }
  catch { gl = null; }
  cam = new THREE.PerspectiveCamera(CAM_FOV, 16 / 9, 0.05, 400); cam.up.set(0, 0, 1);
  return gl;
}
function tick(t: number) {
  raf = VIEWS.size ? requestAnimationFrame(tick) : 0;
  if (t - last < 66) return;
  last = t;
  const r = renderer();
  if (!r || !cam) return;
  for (const v of VIEWS) {
    if (!v.s || !v.pose) continue;
    const w = v.cv.clientWidth, h = v.cv.clientHeight, key = `${w}x${h}:${v.pose.x.toFixed(3)},${v.pose.y.toFixed(3)},${v.pose.yaw.toFixed(3)}`;
    if (!w || !h || key === v.drawn) continue;
    const dpr = Math.min(2, devicePixelRatio || 1);
    r.setPixelRatio(dpr); r.setSize(w, h, false);
    const p = camPose(v.pose, v.s.z);
    cam.aspect = w / h; cam.updateProjectionMatrix();
    cam.position.set(...p.at); cam.lookAt(...p.look);
    r.render(v.s.scene, cam);
    if (v.cv.width !== Math.round(w * dpr)) { v.cv.width = Math.round(w * dpr); v.cv.height = Math.round(h * dpr); }
    v.cv.getContext('2d')?.drawImage(r.domElement, 0, 0, v.cv.width, v.cv.height);
    v.drawn = key;
  }
}
/** 칸 하나를 붙인다. 돌려받은 set 으로 자리 · 현장을 바꾸고 drop 으로 뗀다. WebGL 이 없으면 null */
export function attach(cv: HTMLCanvasElement) {
  if (typeof WebGLRenderingContext === 'undefined' || !renderer()) return null;
  const v: View = { cv, s: null, pose: null, drawn: '' };
  VIEWS.add(v);
  if (!raf) raf = requestAnimationFrame(tick);
  return {
    set: (s: Site | null, pose: View['pose']) => { if (s !== v.s) v.drawn = ''; v.s = s; v.pose = pose; },
    drop: () => { VIEWS.delete(v); if (!VIEWS.size && raf) { cancelAnimationFrame(raf); raf = 0; } },
  };
}

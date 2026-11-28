/** 임무 탭 지도 칸 3D(시안 u6 점토 현장): 판에 3D 모형(model_sha256)이 있으면 점토 결(clay3d.ts · 지도 탭 미리 보기와 같은 값)로 그리고,
 *  경로 · 지점 번호 · 로봇 · 둥근 메뉴는 그 위 SVG 겹(칸 px)에 얹는다. 좌표 = 지도 world(m, x 동 · y 북 · z 위).
 *  지점 · 로봇은 카메라로 투영한 화면 좌표(toScreen), 누름은 바닥면(z = 바닥 높이)과의 광선 교차로 지도 좌표(fromScreen).
 *  모형이 없거나(404) 3D 를 못 그리면 부르는 쪽이 2D 로 돌아간다(까닭 줄 없음 · 2D 가 그대로 보이므로) */
import { createContext, useContext, useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { MapVersion } from '../../../contracts/ts';
import { ApiFail } from '../api';
import { useTheme } from '../theme';
import { CLAY_CAM, clayCam, clayCoat, clayBox, clayFocus, clayLight, clayShade, claySpan, withDraco } from '../clay3d';
import { floorZ, modelBytes, modelOf, worldGroup } from './map3d';
import type { Route } from './missiontab';

type P2 = [number, number];

/** 지도 좌표(x, y) · 바닥 높이 z → 칸 안 화면 px(왼쪽 위 0). 카메라 뒤면 null */
export function toScreen(cam: THREE.Camera, [x, y]: P2, z: number, w: number, h: number): P2 | null {
  cam.updateMatrixWorld();
  const v = new THREE.Vector3(x, y, z);
  if (v.clone().applyMatrix4(cam.matrixWorldInverse).z >= 0) return null;   // 카메라는 -z 를 본다: 0 이상 = 뒤
  const p = v.project(cam);
  return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
}

/** 칸 안 화면 px → 바닥면(z) 위 지도 좌표. 바닥을 못 만나면(하늘 쪽) null */
export function fromScreen(cam: THREE.Camera, [px, py]: P2, z: number, w: number, h: number): P2 | null {
  cam.updateMatrixWorld();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, 1 - (py / h) * 2), cam);
  const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
  return hit ? [hit.x, hit.y] : null;
}

/** 시안 시점 카메라(값은 clay3d.ts CLAY_CAM · clayCam 에서만 읽음): 판 가운데(c · 바닥 z)를 보는 원근 카메라 */
export function clayCamera(c: { x: number; y: number }, span: number, z: number, aspect: number) {
  const cam = new THREE.PerspectiveCamera(CLAY_CAM.fov, aspect, 0.1, span * 6 + 100); cam.up.set(0, 0, 1);
  const p = clayCam(c, span); cam.position.set(p.x, p.y, z + p.z); cam.lookAt(c.x, c.y, z); cam.updateMatrixWorld();
  return cam;
}

/** 다 그린 3D 칸의 투영: 칸 크기(w, h) · 지도 → 화면 · 화면 → 지도 */
export type Proj = { w: number; h: number; to: (p: { x: number; y: number }) => P2; from: (s: P2) => P2 | null };

/** 3D 칸 위 겹에서 쓰는 경로(px = 화면 투영 · r = 화면 px 반지름 · 구간 다시 계산). 2D 면 받은 그대로 */
export function route3(route: Route, p: Proj): Route {
  const px = (w: { x: number; y: number }) => p.to(w);
  let n = -1;   // 2D 구간과 같은 차례(이어진 지점 쌍만) · 금지 구역 겹침(hit)은 2D 판정 그대로
  const segs = route.on.slice(1).flatMap((b, k) => { const a = route.on[k]; return b.i === a.i + 1 ? [{ a: px(a.w), b: px(b.w), hit: !!route.segs[++n]?.hit }] : []; });
  return { ...route, px, segs, r: 11 };
}

/** 지금 그리는 칸의 경로(3D 겹이면 투영된 것). 로봇 이름표 · 시뮬 점이 이 값으로 자리를 잡는다 */
export const RouteView = createContext<Route | null>(null);
export const useRouteView = (route: Route) => useContext(RouteView) ?? route;

/** 이 판을 3D 로 그릴지(모형 sha 있음) */
export const has3D = (v?: MapVersion | null) => !!modelOf(v);

/** 점토 3D 칸: 모형을 받아 시안 시점으로 한 번 그리고(칸 크기가 바뀌면 다시), 투영을 ready 로 넘긴다. 못 그리면 off */
export function MissionMap3D({ v, ready, off }: { v: MapVersion; ready: (p: Proj | null) => void; off: (why: string) => void }) {
  const host = useRef<HTMLDivElement>(null), look = useRef<((light: boolean) => void) | null>(null), [, light] = useTheme(), lightNow = useRef(light);
  lightNow.current = light;
  useEffect(() => { look.current?.(light); }, [light]);   // 판이 바뀌면 빛만 다시 입히고 다시 그림
  useEffect(() => {
    let live = true, gl: THREE.WebGLRenderer | null = null, ro: ResizeObserver | null = null;
    const stop = new AbortController(), scene = new THREE.Scene();
    ready(null);
    (async () => {
      let buf: ArrayBuffer;
      try { buf = await modelBytes(v.id, modelOf(v)!, stop.signal); } catch (e) {
        if (!live || (e instanceof ApiFail && e.code === 'CANCELED')) return;
        return off(e instanceof ApiFail ? e.message : '3D 모형을 받지 못했습니다.');
      }
      try {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const g = await withDraco(new GLTFLoader()).parseAsync(buf, '');
        if (!live) return;
        try { gl = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { return off('이 브라우저에서 3D 를 그릴 수 없습니다.'); }
        const el = host.current!;
        gl.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); gl.outputColorSpace = THREE.SRGBColorSpace;
        if (gl.shadowMap) { gl.shadowMap.enabled = true; gl.shadowMap.type = THREE.PCFSoftShadowMap; }
        el.prepend(gl.domElement);
        const z = floorZ(g.scene, v), model = worldGroup(); model.add(g.scene); scene.add(model);
        clayCoat(g.scene);
        const { c, size } = clayFocus(g.scene, clayBox(model));
        const hemi = new THREE.HemisphereLight(), sun = new THREE.DirectionalLight(); scene.add(hemi, sun, sun.target);
        if ('localClippingEnabled' in gl) gl.localClippingEnabled = true;
        clayShade(scene, sun, size, z, v, c);
        const cam = clayCamera(c, claySpan(size), z, 1);
        const draw = () => {
          const w = el.clientWidth, h = el.clientHeight; if (!gl || !w || !h || !live) return;
          gl.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); gl.render(scene, cam);
          ready({ w, h, to: (q) => toScreen(cam, [q.x, q.y], z, w, h) ?? [-9999, -9999], from: (s) => fromScreen(cam, s, z, w, h) });
        };
        const g0 = gl;
        look.current = (l) => { clayLight(g0, hemi, sun, g.scene, l); draw(); };
        clayLight(g0, hemi, sun, g.scene, lightNow.current);
        ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw); ro?.observe(el);
        draw();
      } catch { if (live) off('3D 모형을 읽지 못했습니다.'); }
    })();
    return () => {
      live = false; stop.abort(); ro?.disconnect(); look.current = null;
      scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mt = m.material as (THREE.Material & { map?: THREE.Texture }) | undefined; mt?.map?.dispose(); mt?.dispose?.(); });
      if (gl) { gl.dispose(); gl.forceContextLoss(); gl.domElement.remove(); }
    };
  }, [v.id, modelOf(v)]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} style={{ position: 'absolute', inset: 0 }} data-map3d-mission />;
}

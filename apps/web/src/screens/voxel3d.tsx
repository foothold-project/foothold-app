// 3D 지도 그리기(RB-VOXEL-VIEW, voxelmap.tsx 의 «3D 로 보기»). 동적 import 로만 불려 three 는 따로 묶인다.
// 칸 = 한 변 0.1 m 상자 하나를 InstancedMesh 로(묶음이 올 때마다 뒤에 붙임), 색 = 높이(Z) 띠. 상자 테두리는 면 무늬(가장자리 어두운 선)로.
// 좌표 = 서버 지도 좌표(x 오른쪽·y 위·z 위, 칸 중심 = origin + (index + .5) × 0.1).
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MapVersion, VoxelCells } from '../../../contracts/ts';
import { hueAt, voxelOf } from './voxelmap';

export type Props = { v: MapVersion; pages: VoxelCells['cells'][]; n: number };

/** 칸 중심 좌표(m) */
export const centerOf = (o: [number, number, number], s: number, [i, j, k]: [number, number, number]) => [o[0] + (i + 0.5) * s, o[1] + (j + 0.5) * s, o[2] + (k + 0.5) * s] as const;

/** 면 무늬: 흰 바탕 + 가장자리 어두운 선 — 칸 색을 곱해 참고 그림처럼 칸마다 테두리가 보인다 */
function edgeTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16);
  g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 2; g.strokeRect(1, 1, 14, 14);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.LinearFilter;
  return t;
}
const token = (el: Element, name: string, fb: string) => {
  const v = getComputedStyle(el).getPropertyValue(name).trim(), col = new THREE.Color(fb);
  if (/^(#[0-9a-f]{3,8}|rgba?\()/i.test(v)) col.setStyle(v);
  return col;
};

type Rig = { renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; orbit: OrbitControls; mesh: THREE.InstancedMesh; mat: THREE.MeshLambertMaterial; drawn: number; top: number; draw: () => void; view: (top: boolean) => void };

export default function Voxel3D({ v, pages, n }: Props) {
  const host = useRef<HTMLDivElement>(null), rig = useRef<Rig | null>(null);
  const [failed, setFailed] = useState(false), [top, setTop] = useState(0), [cut, setCut] = useState<number | null>(null);   // top = 받은 칸 중 가장 높은 윗면(m), cut = 이 높이 위 가리기(null = 다 보임)
  const sum = voxelOf(v), total = Math.max(1, sum?.voxel_count ?? 1), s = sum?.voxel_size ?? 0.1, o = sum?.origin ?? [v.origin[0], v.origin[1], 0];
  // 지도 범위(판 그림과 같은 XY) — 처음 시점·바닥 판
  const W = v.width * v.resolution, H = v.height * v.resolution, cx = v.origin[0] + W / 2, cy = v.origin[1] + H / 2;

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch { setFailed(true); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.localClippingEnabled = true;
    const canvas = renderer.domElement;
    el.prepend(canvas);
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    cam.up.set(0, 0, 1);
    scene.background = token(el, '--bg', '#12161d');
    scene.add(new THREE.HemisphereLight(0xffffff, 0x606060, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(-3, -5, 8); scene.add(sun);
    const line = token(el, '--line', '#2b3240'), grid = new THREE.GridHelper(Math.ceil(Math.max(W, H)) + 4, Math.ceil(Math.max(W, H)) + 4, line, line);   // 1 m 칸
    grid.rotation.x = Math.PI / 2; grid.position.set(cx, cy, o[2] - 0.001); scene.add(grid);
    const mat = new THREE.MeshLambertMaterial({ map: edgeTexture() });
    // ponytail: 숨은 칸(사방이 막힌 속)도 그린다 — 칸 상한(서버 50만)에서 느리면 겉면 칸만 고르기
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(s, s, s), mat, total);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    mesh.count = 0; mesh.frustumCulled = false;   // 묶음마다 늘어나 경계 구가 맞지 않는다
    scene.add(mesh);
    const orbit = new OrbitControls(cam, canvas);
    orbit.maxPolarAngle = Math.PI / 2 - 0.02; orbit.maxDistance = 300;
    const draw = () => renderer.render(scene, cam);
    const view = (up: boolean) => {
      const d = Math.max(W, H, 4);
      if (up) cam.position.set(cx, cy - 0.001, d * 1.15); else cam.position.set(cx - d * 0.25, cy - d * 0.75, d * 0.6);
      orbit.target.set(cx, cy, 0); orbit.update(); draw();
    };
    orbit.addEventListener('change', draw);
    rig.current = { renderer, scene, cam, orbit, mesh, mat, drawn: 0, top: 0, draw, view };
    const fit = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); draw(); };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    ro?.observe(el);
    view(false); fit();
    return () => {
      ro?.disconnect(); orbit.dispose();
      mesh.geometry.dispose(); mat.map?.dispose(); mat.dispose(); grid.dispose(); renderer.dispose(); canvas.remove();
      rig.current = null;
    };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // 새 묶음만 뒤에 붙인다(앞 칸은 그대로) — 받는 동안에도 끌어 돌릴 수 있다
  useEffect(() => {
    const r = rig.current;
    if (!r) return;
    const m = new THREE.Matrix4(), c = new THREE.Color();
    let i = r.mesh.count, hi = r.top;
    for (; r.drawn < pages.length; r.drawn++) for (const cell of pages[r.drawn]) {
      if (i >= total) break;   // 요약 수보다 많이 오면 버림(자리 없음)
      const [x, y, z] = centerOf(o, s, cell);
      m.makeTranslation(x, y, z); r.mesh.setMatrixAt(i, m);
      r.mesh.setColorAt(i, c.setHSL(hueAt(z) / 360, 1, 0.5)); i++;
      hi = Math.max(hi, z + s / 2);
    }
    r.mesh.count = i; r.top = hi;
    r.mesh.instanceMatrix.needsUpdate = true;
    if (r.mesh.instanceColor) r.mesh.instanceColor.needsUpdate = true;
    setTop(+hi.toFixed(1));
    r.draw();
  }, [n]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 위 가리기 — 천장·선반이 바닥을 가릴 때(이 높이 위 칸은 안 그림)
  useEffect(() => {
    const r = rig.current;
    if (!r) return;
    r.mat.clippingPlanes = cut == null ? [] : [new THREE.Plane(new THREE.Vector3(0, 0, -1), cut + 0.001)];
    r.mat.needsUpdate = true; r.draw();
  }, [cut]);

  const shown = cut ?? top;
  return <div ref={host} className="vx-3d" tabIndex={0} role="application" data-voxel-3d aria-label="3D 지도 — 끌어 돌리기, 오른쪽 끌기 이동, 휠 확대">
    {failed ? <p className="lv-note mx-center" role="alert" data-voxel-3d-failed>이 브라우저에서 3D 화면을 그릴 수 없습니다(WebGL 없음). «지도 보기»로 보세요.</p>
      : <div className="vx-tools" role="group" aria-label="3D 시점">
        <button type="button" className="btn" onClick={() => rig.current?.view(true)}>위에서 보기</button>
        <button type="button" className="btn" onClick={() => rig.current?.view(false)}>비스듬히</button>
        {top > 0.3 && <label className="vx-high"><span>높이 {shown.toFixed(1)} m 까지 보기</span>
          <input type="range" min={0.3} max={top} step={0.1} value={shown} aria-label="보이는 높이" onChange={(e) => { const x = Number(e.target.value); setCut(x >= top ? null : x); }} /></label>}
      </div>}
  </div>;
}

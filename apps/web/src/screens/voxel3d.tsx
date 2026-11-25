// 3D 지도 그리기(RB-VOXEL-VIEW, voxelmap.tsx 의 «3D 로 보기»). 동적 import 로만 불려 three 는 따로 묶인다.
// 칸 = 작은 점 하나(11-20 RB-UNITREE-LOOK-WEB — Unitree 앱 저장 지도 보기처럼 촘촘한 점, 묶음이 올 때마다 뒤에 붙임), 색 = 높이(Z) 띠(초록 → 노랑·주황 → 빨강·분홍), 회색 반투명 바닥면.
// 좌표 = 서버 지도 좌표(x 오른쪽·y 위·z 위, 칸 중심 = origin + (index + .5) × 0.1).
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MapVersion, VoxelCells } from '../../../contracts/ts';
import { HEX, levelOf } from '../heightcolor';
import { voxelOf } from './voxelmap';

export type Props = { v: MapVersion; pages: VoxelCells['cells'][]; n: number };

/** 칸 중심 좌표(m) */
export const centerOf = (o: [number, number, number], s: number, [i, j, k]: [number, number, number]) => [o[0] + (i + 0.5) * s, o[1] + (j + 0.5) * s, o[2] + (k + 0.5) * s] as const;

/** 점 크기(CSS px) — 확대해도 그대로(Unitree 저장 지도 보기처럼 작은 점) */
const DOT_PX = 1.5;
/** 높이 단계별 색(three 선형 RGB) — 라이다 3D 와 같은 표(heightcolor.ts) */
const LIN = HEX.map((h) => new THREE.Color(h).toArray() as [number, number, number]);
/** 어두운 고정 바탕·격자 선 = frame.css .fh 어두운 테마 --bg·--line 값 */
const DARK = { bg: '#0B0E11', line: '#26313A' };

type Rig = { renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; orbit: OrbitControls; geo: THREE.BufferGeometry; count: number; mat: THREE.PointsMaterial; drawn: number; top: number; draw: () => void; view: (top: boolean) => void };

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
    const ratio = Math.min(devicePixelRatio || 1, 2);
    renderer.setPixelRatio(ratio);
    renderer.localClippingEnabled = true;
    const canvas = renderer.domElement;
    el.prepend(canvas);
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    cam.up.set(0, 0, 1);
    scene.background = new THREE.Color(DARK.bg);   // 점이 밝은 색이라 바탕은 테마와 상관없이 어두운 고정색(Unitree 저장 지도 보기처럼)
    const line = new THREE.Color(DARK.line), grid = new THREE.GridHelper(Math.ceil(Math.max(W, H)) + 4, Math.ceil(Math.max(W, H)) + 4, line, line);   // 1 m 칸
    grid.rotation.x = Math.PI / 2; grid.position.set(cx, cy, o[2] - 0.002); scene.add(grid);
    // 회색 반투명 바닥면(지도 범위 + 둘레 1 m) — 점이 떠 보이지 않게
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W + 2, H + 2), new THREE.MeshBasicMaterial({ color: 0x8a8f98, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
    floor.position.set(cx, cy, o[2] - 0.001); scene.add(floor);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({ size: DOT_PX * ratio, sizeAttenuation: false, vertexColors: true });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;   // 묶음마다 늘어나 경계 구가 맞지 않는다
    scene.add(pts);
    const orbit = new OrbitControls(cam, canvas);
    orbit.maxPolarAngle = Math.PI / 2 - 0.02; orbit.maxDistance = 300;
    const draw = () => renderer.render(scene, cam);
    const view = (up: boolean) => {
      const d = Math.max(W, H, 4);
      if (up) cam.position.set(cx, cy - 0.001, d * 1.15); else cam.position.set(cx - d * 0.25, cy - d * 0.75, d * 0.6);
      orbit.target.set(cx, cy, 0); orbit.update(); draw();
    };
    orbit.addEventListener('change', draw);
    rig.current = { renderer, scene, cam, orbit, geo, count: 0, mat, drawn: 0, top: 0, draw, view };
    const fit = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); draw(); };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    ro?.observe(el);
    view(false); fit();
    return () => {
      ro?.disconnect(); orbit.dispose();
      geo.dispose(); mat.dispose(); floor.geometry.dispose(); floor.material.dispose(); grid.dispose(); renderer.dispose(); canvas.remove();
      rig.current = null;
    };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // 새 묶음만 뒤에 붙인다(앞 칸은 그대로) — 받는 동안에도 끌어 돌릴 수 있다
  useEffect(() => {
    const r = rig.current;
    if (!r) return;
    const pos = r.geo.attributes.position as THREE.BufferAttribute, col = r.geo.attributes.color as THREE.BufferAttribute;
    let i = r.count, hi = r.top;
    for (; r.drawn < pages.length; r.drawn++) for (const cell of pages[r.drawn]) {
      if (i >= total) break;   // 요약 수보다 많이 오면 버림(자리 없음)
      const [x, y, z] = centerOf(o, s, cell);
      pos.setXYZ(i, x, y, z); col.setXYZ(i, ...LIN[levelOf(z, 0)]); i++;   // Z=0 = 서버가 추정한 바닥(apps/server/VOXEL-MAPS.md)
      hi = Math.max(hi, z + s / 2);
    }
    r.count = i; r.top = hi;
    r.geo.setDrawRange(0, i); pos.needsUpdate = true; col.needsUpdate = true;
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
    {failed ? <p className="lv-note mx-center" role="alert" data-voxel-3d-failed>이 브라우저에서는 3D 화면을 볼 수 없습니다. «지도 보기»로 보세요.</p>
      : <div className="vx-tools" role="group" aria-label="3D 시점">
        <button type="button" className="btn" onClick={() => rig.current?.view(true)}>위에서 보기</button>
        <button type="button" className="btn" onClick={() => rig.current?.view(false)}>비스듬히</button>
        {top > 0.3 && <label className="vx-high"><span>높이 {shown.toFixed(1)} m 까지 보기</span>
          <input type="range" min={0.3} max={top} step={0.1} value={shown} aria-label="보이는 높이" onChange={(e) => { const x = Number(e.target.value); setCut(x >= top ? null : x); }} /></label>}
      </div>}
  </div>;
}

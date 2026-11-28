// 지도 탭 미리 보기 「3D 보기 · 미리 보기」(시안 u7_1 오른쪽): 서버 지도 판의 2D 그림(점유 격자 PNG)을 밝은 회색 무광 점토로 세운 비스듬한 위 시점.
// 모형(glb)을 판에 붙이는 API 가 오기 전까지는 2D 그림까지만 쓴다(조정 11/28 22:48). 로봇 · 시뮬 실시간 없음 · 금지 구역 = 붉은 빗금. 바탕 = 판(어둠 · 밝음) 칸 색.
// 점유 = 어두운 칸(ROS 지도 꼴: 검정 = 막힘, 흰 = 빈 곳, 회색 = 모름). 칸을 묶어(한 변 CELL_MAX 칸 이하) 상자 하나씩.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { MapVersion } from '../../../../contracts/ts';
import { api } from '../../api';

/** 한 변 칸 수 상한(묶음 칸). 802 × 882 px 판이면 3 px 씩 묶어 ~300 칸 */
export const CELL_MAX = 300;
import { CLAY, CLAY_CAM, clayCam, hatch } from '../../clay3d';
/** 점토 값 · 시안 시점 · 빗금은 공용(clay3d.ts) */
export { CLAY, CLAY_CAM, clayCam, hatch };

/** 점유 칸 고르기: RGBA 픽셀 → 묶음 칸(k × k px) 중 하나라도 어두우면(밝기 < 100) 막힘. 행 0 = 그림 위(지도 y 큼) */
export function occGrid(px: Uint8ClampedArray, w: number, h: number, max = CELL_MAX) {
  const k = Math.max(1, Math.ceil(Math.max(w, h) / max)), cw = Math.ceil(w / k), ch = Math.ceil(h / k), on = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, a = px[i + 3], lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (a > 0 && lum < 100) on[Math.floor(y / k) * cw + Math.floor(x / k)] = 1;
  }
  return { k, cw, ch, on };
}

/** 묶음 칸(열 cx · 행 cy) 가운데의 지도 좌표(m). 그림 행 0 = 위 = 지도 y 가 가장 큼 */
export const cellAt = (v: Pick<MapVersion, 'origin' | 'resolution' | 'height'>, k: number, cx: number, cy: number) =>
  ({ x: v.origin[0] + (cx + 0.5) * k * v.resolution, y: v.origin[1] + (v.height - (cy + 0.5) * k) * v.resolution });

const bgOf = (el: HTMLElement) => {
  for (let e: HTMLElement | null = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c)) { try { return new THREE.Color(c.replace(/rgba?\(([^)]+)\)/, (_, a) => `rgb(${a.split(',').slice(0, 3).join(',')})`)); } catch { break; } }
  }
  return new THREE.Color(0x0b0e11);
};

/** 미리 보기 칸 하나: 판이 바뀌면 다시 그림. WebGL 이 없거나 그림을 못 받으면 까닭 한 줄 */
export function ClayMap({ v, light }: { v: MapVersion; light: boolean }) {
  const host = useRef<HTMLDivElement>(null), [at, setAt] = useState<'wait' | 'ok' | 'bad' | 'nogl'>('wait');
  useEffect(() => {
    let live = true, gl: THREE.WebGLRenderer | null = null, ro: ResizeObserver | null = null;
    const scene = new THREE.Scene(), el = host.current!;
    setAt('wait');
    const img = new Image(); img.crossOrigin = 'use-credentials';
    img.onerror = () => { if (live) setAt('bad'); };
    img.onload = () => {
      if (!live) return;
      try { gl = new THREE.WebGLRenderer({ antialias: true }); } catch { setAt('nogl'); return; }
      const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const g2 = cv.getContext('2d'); if (!g2) { setAt('nogl'); return; }
      g2.drawImage(img, 0, 0);
      const { k, cw, ch, on } = occGrid(g2.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
      const r = v.resolution, W = v.width * r, H = v.height * r, c = { x: v.origin[0] + W / 2, y: v.origin[1] + H / 2 }, s = k * r;
      gl.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); gl.outputColorSpace = THREE.SRGBColorSpace;
      gl.shadowMap.enabled = true; gl.shadowMap.type = THREE.PCFSoftShadowMap;
      el.prepend(gl.domElement);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ color: CLAY.floor, roughness: 1, metalness: 0 }));
      floor.position.set(c.x, c.y, 0); floor.receiveShadow = true; scene.add(floor);
      const n = on.reduce((a, b) => a + b, 0);
      if (n) {
        const box = new THREE.InstancedMesh(new THREE.BoxGeometry(s, s, CLAY.wall), new THREE.MeshStandardMaterial({ color: CLAY.top, roughness: 1, metalness: 0 }), n);
        const m = new THREE.Matrix4(); let i = 0;
        for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) if (on[cy * cw + cx]) { const p = cellAt(v, k, cx, cy); box.setMatrixAt(i++, m.makeTranslation(p.x, p.y, CLAY.wall / 2)); }
        box.castShadow = box.receiveShadow = true; scene.add(box);
      }
      const tex = hatch();
      for (const z of v.features.zones.filter((x) => x.type === 'NO_GO' && x.polygon.length >= 3)) {
        const sh = new THREE.Shape(z.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
        const t = tex?.clone() ?? null; if (t) { t.needsUpdate = true; t.repeat.set(0.5, 0.5); }
        scene.add(Object.assign(new THREE.Mesh(new THREE.ShapeGeometry(sh), new THREE.MeshBasicMaterial(t ? { map: t, transparent: true, depthWrite: false } : { color: CLAY.nogo, transparent: true, opacity: 0.25, depthWrite: false })), { renderOrder: 1 }).translateZ(0.03));
        const ln = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(z.polygon.map(([x, y]) => new THREE.Vector3(x, y, 0.05))), new THREE.LineBasicMaterial({ color: CLAY.nogo }));
        scene.add(ln);
      }
      const hemi = new THREE.HemisphereLight(0xffffff, 0x9a958e, 1.5), sun = new THREE.DirectionalLight(0xffffff, 1.6), span = Math.hypot(W, H);
      sun.position.set(c.x - span * 0.25, c.y - span * 0.35, span * 0.6); sun.target.position.set(c.x, c.y, 0);
      sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 4; sun.shadow.bias = -0.0005;
      Object.assign(sun.shadow.camera, { left: -span / 2, right: span / 2, top: span / 2, bottom: -span / 2, near: 0.1, far: span * 2 });
      scene.add(hemi, sun, sun.target);
      const cam = new THREE.PerspectiveCamera(CLAY_CAM.fov, 1, 0.1, span * 6); cam.up.set(0, 0, 1);
      const p = clayCam(c, span); cam.position.set(p.x, p.y, p.z); cam.lookAt(c.x, c.y, 0);
      const draw = () => { const w = el.clientWidth, h = el.clientHeight; if (!gl || !w || !h) return; scene.background = bgOf(el); gl.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); gl.render(scene, cam); };
      ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw); ro?.observe(el);
      draw(); setAt('ok');
    };
    img.src = api.imageUrl(v.id);
    return () => {
      live = false; img.onload = img.onerror = null; ro?.disconnect();
      scene.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mt = m.material as THREE.Material & { map?: THREE.Texture } | undefined; mt?.map?.dispose(); mt?.dispose?.(); });
      if (gl) { gl.dispose(); gl.forceContextLoss(); gl.domElement.remove(); }
    };
  }, [v.id, light]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} style={{ position: 'absolute', inset: 0 }} data-clay={at}>
    {at === 'bad' && <p className="mu2" role="status" style={{ position: 'absolute', left: '28px', top: '90px', right: '28px', fontSize: '14px' }}>지도 그림을 받지 못했습니다.</p>}
    {at === 'nogl' && <p className="mu2" role="status" style={{ position: 'absolute', left: '28px', top: '90px', right: '28px', fontSize: '14px' }}>이 브라우저에서 3D 를 그릴 수 없습니다.</p>}
  </div>;
}

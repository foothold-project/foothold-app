// 조종 화면 라이다 칸 3D 점(11-19 RB-LIDAR-3D): drivemedia 가 준 xyz 를 그대로(frame map·odom = 그 기준 자리, lidar_link = 센서가 원점) three 로 그린다.
// 색 = 로봇 기준 높이(위에서 본 그림·범례와 같은 hue), 로봇 화살표, 옅은 바닥 격자. 끌기 = 돌리기, 휠·두 손가락 = 확대, 오른쪽 끌기·Shift+끌기 = 옮기기.
// 받은 판이 바뀔 때만 버퍼를 다시 채우고, 그리기는 바뀐 때만(끌기·판·크기). 탭이 숨었거나 칸이 화면 밖·크기 0 이면 버퍼 갱신·그리기를 멈추고, 돌아오면 최신 판으로 한 번. 그림만 — 명령 0.
// 닫을 때 WebGL 문맥을 바로 놓는다(forceContextLoss) — 3D↔위에서를 여러 번 바꿔도 문맥이 쌓여 다른 3D 그림이 꺼지지 않게.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DriveFeed, Pose } from './drivemedia';
import { hue } from './quad';

/** 점 상한(큰 칸 · 작은 칸) — 넘으면 고르게 솎는다 */
export const CAP_BIG = 200_000, CAP_SMALL = 30_000;
/** 높이 색 범위(로봇 기준 m) · 바닥 격자 높이(로봇 기준 m — 실제 바닥과 어긋나면 이 값을 고친다) */
const ZL = -1, ZH = 1, N = 64, FLOOR_DZ = -0.3;
const LUT = (() => { const c = new THREE.Color(), t = new Float32Array(N * 3); for (let i = 0; i < N; i++) { c.setHSL(hue(ZL + (i / (N - 1)) * (ZH - ZL)) / 360, 0.8, 0.6); c.toArray(t, i * 3); } return t; })();

/** 점·색 버퍼 채우기: n 개 중 cap 이하로 고르게 솎아 pos·col 앞에 채우고 채운 수를 돌려준다 */
export function fillPoints(pos: Float32Array, col: Float32Array, xyz: Float32Array, n: number, cap: number, z0: number) {
  const step = Math.max(1, Math.ceil(n / cap));
  let m = 0;
  for (let i = 0; i < n && m < cap; i += step, m++) {
    const z = xyz[i * 3 + 2], k = Math.max(0, Math.min(N - 1, Math.round(((z - z0 - ZL) / (ZH - ZL)) * (N - 1)))) * 3;
    pos[m * 3] = xyz[i * 3]; pos[m * 3 + 1] = xyz[i * 3 + 1]; pos[m * 3 + 2] = z;
    col[m * 3] = LUT[k]; col[m * 3 + 1] = LUT[k + 1]; col[m * 3 + 2] = LUT[k + 2];
  }
  return m;
}

/** 로봇 자리: pose 가 있으면 그것, lidar_link(센서 기준 한 장)면 원점, 그 밖(pose 없는 map)은 모름 */
export const robotOf = (f: DriveFeed): Pose | null => f.pose ?? (f.frame === 'lidar_link' ? { x: 0, y: 0, z: 0, yaw: 0 } : null);

export function Lidar3D({ feed, small, onFail }: { feed: DriveFeed; small: boolean; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null), cur = useRef(feed), [free, setFree] = useState(false), again = useRef(() => {});
  cur.current = feed;
  useEffect(() => {
    const el = host.current!, cap = small ? CAP_SMALL : CAP_BIG;
    let g: THREE.WebGLRenderer;
    try { g = new THREE.WebGLRenderer({ antialias: !small }); } catch { onFail(); return; }
    g.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = g.domElement;
    canvas.style.cssText = `display:block;width:100%;height:100%;touch-action:${small ? 'auto' : 'none'}`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `라이다 점 3D${small ? '' : ' — 끌어서 돌리기, 휠·두 손가락 확대, 오른쪽 끌기·Shift+끌기 옮기기'}`);
    el.prepend(canvas);
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(55, 1, 0.05, 400);
    cam.up.set(0, 0, 1);
    const pos = new Float32Array(cap * 3), col = new Float32Array(cap * 3), geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({ size: small ? 1.5 : 2, sizeAttenuation: false, vertexColors: true });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;   // 판마다 범위가 바뀐다
    const grid = new THREE.GridHelper(40, 40, 0x8a94a6, 0x8a94a6);   // 1 m 칸
    grid.rotation.x = Math.PI / 2;
    for (const m of [grid.material].flat()) { m.transparent = true; m.opacity = 0.18; m.depthWrite = false; }
    const warn = getComputedStyle(el).getPropertyValue('--warn').trim();
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1.2, /^#|^rgb/.test(warn) ? warn : '#e90', 0.45, 0.4);
    scene.add(pts, grid, arrow);
    const orbit = new OrbitControls(cam, canvas);
    orbit.enabled = !small; orbit.maxDistance = 150; orbit.screenSpacePanning = true;
    const v = { ver: -1, w: 0, h: 0, follow: true, drag: false, dirty: true, at: new THREE.Vector3() };
    let onScreen = true;
    const draw = () => {
      if (document.hidden || !onScreen || !el.clientWidth || !el.clientHeight) { v.dirty = true; return; }   // 안 보이면 미룸
      v.dirty = false; g.render(scene, cam);
    };
    const fit = () => { v.w = el.clientWidth; v.h = el.clientHeight; if (!v.w || !v.h) return; g.setSize(v.w, v.h, false); cam.aspect = v.w / v.h; cam.updateProjectionMatrix(); };
    const home = () => {   // 로봇 뒤 위에서 비스듬히
      const r = robotOf(cur.current) ?? { x: 0, y: 0, z: 0, yaw: 0 };
      orbit.target.set(r.x, r.y, r.z); cam.position.set(r.x - Math.cos(r.yaw) * 5, r.y - Math.sin(r.yaw) * 5, r.z + 3.5); orbit.update();
    };
    const load = () => {
      const c = cur.current, r = robotOf(c), z0 = r?.z ?? 0;
      v.ver = c.ver;
      geo.setDrawRange(0, fillPoints(pos, col, c.xyz, c.n, cap, z0));
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      arrow.visible = !!r;
      if (r) {
        arrow.position.set(r.x, r.y, r.z); arrow.setDirection(v.at.set(Math.cos(r.yaw), Math.sin(r.yaw), 0));
        if (v.follow && !v.drag) { v.at.set(r.x, r.y, r.z).sub(orbit.target); orbit.target.add(v.at); cam.position.add(v.at); orbit.update(); }
      }
      grid.position.set(Math.round(r?.x ?? 0), Math.round(r?.y ?? 0), z0 + FLOOR_DZ);
    };
    orbit.addEventListener('change', draw);
    orbit.addEventListener('start', () => { v.drag = true; });
    orbit.addEventListener('end', () => {   // 옮겨서 로봇에서 벗어나면 따라가기를 끈다(돌리기·확대는 그대로 따라감)
      v.drag = false;
      const r = robotOf(cur.current);
      if (v.follow && r && orbit.target.distanceTo(v.at.set(r.x, r.y, r.z)) > 0.05) { v.follow = false; setFree(true); }
    });
    again.current = () => { v.follow = true; setFree(false); home(); draw(); };
    const tick = () => {
      const size = el.clientWidth !== v.w || el.clientHeight !== v.h;
      if (size) fit();
      if (document.hidden || !onScreen || !el.clientWidth || !el.clientHeight) { v.dirty = true; return; }   // 안 보이면 버퍼도 그대로
      if (cur.current.ver !== v.ver) load();
      else if (!size && !v.dirty) return;
      draw();
    };
    const t = setInterval(tick, 500);   // 판 갱신 2 Hz
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { fit(); draw(); });
    ro?.observe(el);
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; tick(); });
    io?.observe(el);
    const vis = () => tick();
    document.addEventListener('visibilitychange', vis);
    fit(); home(); load(); draw();
    return () => {
      clearInterval(t); ro?.disconnect(); io?.disconnect(); document.removeEventListener('visibilitychange', vis); orbit.dispose();
      geo.dispose(); mat.dispose(); grid.dispose(); arrow.dispose(); g.dispose(); g.forceContextLoss(); canvas.remove();
    };
  }, [small]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} style={{ position: 'absolute', inset: 0 }} data-lidar3d={feed.n}>
    {free && !small && <button type="button" className="btn" data-l3-follow style={{ position: 'absolute', left: 8, bottom: 8 }} onClick={() => again.current()}>로봇 따라가기</button>}
  </div>;
}

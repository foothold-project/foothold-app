// 조종 화면 라이다 칸 3D(11-19 RB-LIDAR-3D · 11-20 RB-UNITREE-LOOK-WEB = Unitree 앱 조종 화면처럼): drivemedia 가 준 xyz 를 그대로(frame map·odom = 그 기준 자리, lidar_link = 센서가 원점) three 로 그린다.
// 점 하나 = 5 cm 상자(쌓는 칸 CELL_M 에 맞춤, InstancedMesh — screens/voxel3d.tsx 와 같은 방식, 면 무늬로 가장자리 선). 색 = 바닥부터 높이(청록 → 초록 → 노랑 → 주황 → 자홍 → 분홍).
// 반투명 회색 Go2(go2model.tsx 메시, 못 받으면 상자 그림)를 로봇 자리에. 기본 시점 = 로봇 뒤 위에서 따라가기(로봇이 돌면 같이 돎). 끌기·휠로 손대면 그 시점 그대로(자리만 따라감), 옮기면 따라가기도 끔 — «로봇 뒤에서 보기» 하나로 되돌림.
// 궤적 선은 그리지 않는다(Unitree 앱과 같음 — 위에서 본 그림에만). 받은 판이 바뀔 때만 버퍼를 다시 채우고, 그리기는 바뀐 때만(끌기·판·크기). 탭이 숨었거나 칸이 화면 밖·크기 0 이면 멈추고, 돌아오면 최신 판으로 한 번. 그림만 — 명령 0.
// 닫을 때 WebGL 문맥을 바로 놓는다(forceContextLoss) — 3D↔위에서를 여러 번 바꿔도 문맥이 쌓여 다른 3D 그림이 꺼지지 않게.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CELL_M, type DriveFeed, type Pose } from './drivemedia';
import { go2Standing, loadGo2 } from './go2model';

/** 그릴 상자 상한(작은 칸 · 폰 크기 칸 · 큰 칸) — 넘으면 고르게 솎는다. 칸의 짧은 변이 PHONE_PX 미만이면 폰 크기(runs/qa-rb-unitree-look-web 측정표) */
export const CAP_SMALL = 20_000, CAP_PHONE = 60_000, CAP_BIG = 200_000, PHONE_PX = 500;
export const capFor = (small: boolean, w: number, h: number) => (small ? CAP_SMALL : Math.min(w, h) < PHONE_PX ? CAP_PHONE : CAP_BIG);
/** 바닥 = 로봇 z + FLOOR_DZ(m — 실제 바닥과 어긋나면 이 값을 고친다). 색 = 바닥부터 0 ~ TOP_M, 넘으면 끝 색(분홍).
 *  ponytail: TOP_M·색 경계는 Unitree 영상에서 m 로 역산 못 함(범례·척도 없음) — 실기에서 같은 벽을 나란히 보고 조정 */
export const FLOOR_DZ = -0.3, TOP_M = 2.0;
/** 색표 = Unitree 조종 화면(영상 A) 순서: 바닥 청록 → 초록 → 노랑 → 주황 → 보라·자홍 → 진한 분홍 */
export const STOPS = ['#19e3c8', '#3fe065', '#e9ee2e', '#f7a21f', '#c43be3', '#ff2d8c'];
const N = 64;
/** 높이 단계별 색(three 선형 RGB) */
const LUT = (() => {
  const t = new Float32Array(N * 3), cs = STOPS.map((s) => new THREE.Color(s)), c = new THREE.Color();
  for (let i = 0; i < N; i++) { const u = (i / (N - 1)) * (cs.length - 1), a = Math.min(cs.length - 2, Math.floor(u)); c.lerpColors(cs[a], cs[a + 1], u - a).toArray(t, i * 3); }
  return t;
})();
/** 바닥(floor)부터 높이 z → 색 단계 0..N-1 */
export const levelOf = (z: number, floor: number) => Math.max(0, Math.min(N - 1, Math.round(((z - floor) / TOP_M) * (N - 1))));
/** 그 단계 색(sRGB 0..255) — 위에서 본 그림(2D 화소)용 */
export const rgbOf = (k: number) => { const c = new THREE.Color().fromArray(LUT, k * 3).convertLinearToSRGB(); return [c.r, c.g, c.b].map((v) => Math.round(v * 255)); };

/** 상자 버퍼 채우기: n 개 중 cap 이하로 고르게 솎아 5 cm 칸 가운데 자리(off — 상자 하나당 16칸 행렬의 이동 자리 12·13·14)와 색(col)을 앞에서부터, 채운 수를 돌려준다 */
export function fillBoxes(mat: Float32Array, col: Float32Array, xyz: Float32Array, n: number, cap: number, floor: number) {
  const step = Math.max(1, Math.ceil(n / cap)), s = CELL_M;
  let m = 0;
  for (let i = 0; i < n && m < cap; i += step, m++) {
    const z = xyz[i * 3 + 2], k = levelOf(z, floor) * 3, o = m * 16;
    mat[o + 12] = (Math.floor(xyz[i * 3] / s) + 0.5) * s; mat[o + 13] = (Math.floor(xyz[i * 3 + 1] / s) + 0.5) * s; mat[o + 14] = (Math.floor(z / s) + 0.5) * s;
    col[m * 3] = LUT[k]; col[m * 3 + 1] = LUT[k + 1]; col[m * 3 + 2] = LUT[k + 2];
  }
  return m;
}

/** 면 무늬: 흰 바탕 + 가장자리 어두운 선 — 상자 색을 곱해 상자마다 테두리가 보인다(screens/voxel3d.tsx 도 씀) */
export function edgeTexture(line = 'rgba(0,0,0,0.55)') {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16);
  g.strokeStyle = line; g.lineWidth = 2; g.strokeRect(1, 1, 14, 14);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.LinearFilter;
  return t;
}

/** 로봇 자리: pose 가 있으면 그것, lidar_link(센서 기준 한 장)면 원점, 그 밖(pose 없는 map)은 모름 */
export const robotOf = (f: DriveFeed): Pose | null => f.pose ?? (f.frame === 'lidar_link' ? { x: 0, y: 0, z: 0, yaw: 0 } : null);
/** 3인칭 시점: 로봇 뒤 BACK m · 위 UP m 에서 로봇 앞 AHEAD m 를 본다 */
const BACK = 2.6, UP = 1.6, AHEAD = 1.5;

/** 색 범례(작게) — «바닥 → 높음» */
export const HeightLegend = ({ style }: { style?: CSSProperties }) => <div className="qd-legend" aria-label="높이 색 범례" data-height-legend style={style}>
  <div style={{ height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${STOPS.join(',')})` }} />
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>바닥</span><span>높음</span></div>
</div>;

type Mode = 'chase' | 'follow' | 'free';
/** ratio = 그리는 픽셀 비율 상한(기본 2 — 그대로). 실기 직결 조종은 1: 큰 화면 교환 때 다시 그리는 비용이 조종 명령 주기를 막지 않게(RV-455 1).
 *  legend = 칸 안 색 범례(작은 칸이 아니면 기본으로) */
export function Lidar3D({ feed, small, onFail, ratio = 2, legend = !small }: { feed: DriveFeed; small: boolean; onFail: () => void; ratio?: number; legend?: boolean }) {
  const host = useRef<HTMLDivElement>(null), cur = useRef(feed), [mode, setMode] = useState<Mode>('chase'), again = useRef(() => {});
  cur.current = feed;
  useEffect(() => {
    const el = host.current!, cap = capFor(small, el.clientWidth, el.clientHeight);   // ponytail: 상한은 처음 칸 크기로 — 칸이 폰↔PC 크기로 바뀌어도 그대로(다시 열면 맞음)
    let g: THREE.WebGLRenderer;
    try { g = new THREE.WebGLRenderer({ antialias: !small }); } catch { onFail(); return; }
    g.setPixelRatio(Math.min(window.devicePixelRatio || 1, ratio));
    const canvas = g.domElement;
    canvas.style.cssText = `display:block;width:100%;height:100%;touch-action:${small ? 'auto' : 'none'}`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `라이다 3D — 높이별 색 상자${small ? '' : ' · 끌어서 돌리기, 휠·두 손가락 확대, 오른쪽 끌기·Shift+끌기 옮기기'}`);
    el.prepend(canvas);
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(55, 1, 0.05, 400);
    cam.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(-2, -3, 8); scene.add(sun);
    // 상자: 행렬은 InstancedMesh 가 단위 행렬로 깔아 두고, 판마다 이동 자리만 채운다
    const mat = new THREE.MeshLambertMaterial({ map: edgeTexture('rgba(0,0,0,0.35)') });
    const box = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL_M, CELL_M, CELL_M), mat, cap), tm = box.instanceMatrix.array as Float32Array;
    box.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    box.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    box.count = 0; box.frustumCulled = false;   // 판마다 범위가 바뀐다
    const grid = new THREE.GridHelper(40, 40, 0x8a94a6, 0x8a94a6);   // 1 m 칸
    grid.rotation.x = Math.PI / 2;
    for (const m of [grid.material].flat()) { m.transparent = true; m.opacity = 0.18; m.depthWrite = false; }
    // 로봇: 반투명 회색(나중에 받은 메시로 바꿔 끼움 — 바꿔 끼울 때 옛 모양을 해제)
    const skin = new THREE.MeshLambertMaterial({ color: 0xb4bac4, transparent: true, opacity: 0.7, depthWrite: false });
    const bot = new THREE.Group();
    const dress = (m: Parameters<typeof go2Standing>[0]) => { bot.children.slice().forEach((c) => { bot.remove(c); c.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); }); bot.add(go2Standing(m, skin)); };
    dress(null);
    let live = true;
    loadGo2().then((m) => { if (live && m) { dress(m); draw(); } });
    scene.add(box, grid, bot);
    const orbit = new OrbitControls(cam, canvas);
    orbit.enabled = !small; orbit.maxDistance = 150; orbit.screenSpacePanning = true;
    const v = { ver: -1, w: 0, h: 0, mode: 'chase' as Mode, drag: false, dirty: true, at: new THREE.Vector3(), last: null as THREE.Vector3 | null, t0: new THREE.Vector3() };
    const go = (m: Mode) => { v.mode = m; setMode(m); };
    let onScreen = true;
    const draw = () => {
      if (document.hidden || !onScreen || !el.clientWidth || !el.clientHeight) { v.dirty = true; return; }   // 안 보이면 미룸
      v.dirty = false; g.render(scene, cam);
    };
    const fit = () => { v.w = el.clientWidth; v.h = el.clientHeight; if (!v.w || !v.h) return; g.setSize(v.w, v.h, false); cam.aspect = v.w / v.h; cam.updateProjectionMatrix(); };
    const chase = (r: Pose) => {   // 로봇 뒤 위에서 앞을 본다
      const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
      orbit.target.set(r.x + c * AHEAD, r.y + s * AHEAD, r.z); cam.position.set(r.x - c * BACK, r.y - s * BACK, r.z + UP); orbit.update();
    };
    const load = () => {
      const c = cur.current, r = robotOf(c), z0 = r?.z ?? 0;
      v.ver = c.ver;
      box.count = fillBoxes(tm, box.instanceColor!.array as Float32Array, c.xyz, c.n, cap, z0 + FLOOR_DZ);
      box.instanceMatrix.needsUpdate = true; box.instanceColor!.needsUpdate = true;
      bot.visible = !!r;
      if (r) {
        bot.position.set(r.x, r.y, r.z); bot.rotation.z = r.yaw;
        if (!v.drag && v.mode === 'chase') chase(r);
        else if (!v.drag && v.mode === 'follow' && v.last) { v.at.set(r.x, r.y, r.z).sub(v.last); orbit.target.add(v.at); cam.position.add(v.at); orbit.update(); }
        (v.last ??= new THREE.Vector3()).set(r.x, r.y, r.z);
      }
      grid.position.set(Math.round(r?.x ?? 0), Math.round(r?.y ?? 0), z0 + FLOOR_DZ);
    };
    orbit.addEventListener('change', draw);
    orbit.addEventListener('start', () => { v.drag = true; v.t0.copy(orbit.target); });
    orbit.addEventListener('end', () => {   // 손대면 그 시점 그대로 자리만 따라감, 옮겨서 보는 곳이 바뀌면 따라가기도 끔
      v.drag = false;
      if (v.mode !== 'free' && orbit.target.distanceTo(v.t0) > 0.05) go('free');
      else if (v.mode === 'chase') go('follow');
    });
    again.current = () => { go('chase'); const r = robotOf(cur.current); if (r) chase(r); else { orbit.target.set(AHEAD, 0, 0); cam.position.set(-BACK, 0, UP); orbit.update(); } draw(); };
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
    fit(); again.current(); load(); draw();
    return () => {
      live = false; clearInterval(t); ro?.disconnect(); io?.disconnect(); document.removeEventListener('visibilitychange', vis); orbit.dispose();
      box.geometry.dispose(); box.dispose(); mat.map?.dispose(); mat.dispose(); skin.dispose(); bot.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      grid.dispose(); g.dispose(); g.forceContextLoss(); canvas.remove();
    };
  }, [small]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={host} style={{ position: 'absolute', inset: 0 }} data-lidar3d={feed.n} data-l3-view={mode}>
    {legend && <HeightLegend />}
    {mode !== 'chase' && !small && <button type="button" className="btn" data-l3-follow style={{ position: 'absolute', left: 8, bottom: 8 }} onClick={() => again.current()}>로봇 뒤에서 보기</button>}
  </div>;
}

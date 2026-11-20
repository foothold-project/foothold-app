// 조종 화면 라이다 칸 3D(11-19 RB-LIDAR-3D · 11-20 RB-UNITREE-LOOK-WEB = Unitree 앱 조종 화면처럼): drivemedia 가 준 xyz 를 그대로(frame map·odom = 그 기준 자리, lidar_link = 센서가 원점) three 로 그린다.
// look = 'points'(라이다 — 작은 점 그대로, 11-20 RB-UNITREE-LOOK-FIX 로 되돌림) · 'boxes'(«상자» 보기 — 점 하나 = 5 cm 상자, 쌓는 칸 CELL_M 에 맞춤, InstancedMesh, 면 무늬로 가장자리 선).
// 색 = 둘 다 바닥부터 높이(청록 → 초록 → 노랑 → 주황 → 자홍 → 분홍). look 이 바뀌어도 WebGL 은 그대로(묶음만 바꿈).
// 반투명 회색 Go2(go2model.tsx 메시, 못 받으면 상자 그림)를 로봇 자리에 — go2 = 받은 관절각·기울기(go2Pose, 2 Hz 판마다 따라 움직임), 없으면 선 자세 + «자세 정보 없음». 기본 시점 = 로봇 뒤 위에서 따라가기(로봇이 돌면 같이 돎). 끌기·휠로 손대면 그 시점 그대로(자리만 따라감), 옮기면 따라가기도 끔 — «로봇 뒤에서 보기» 하나로 되돌림.
// 궤적 선은 그리지 않는다(Unitree 앱과 같음 — 위에서 본 그림에만). 받은 판이 바뀔 때만 버퍼를 다시 채우고, 그리기는 바뀐 때만(끌기·판·크기). 탭이 숨었거나 칸이 화면 밖·크기 0 이면 멈추고, 돌아오면 최신 판으로 한 번. 그림만 — 명령 0.
// 닫을 때 WebGL 문맥을 바로 놓는다(forceContextLoss) — 3D↔위에서를 여러 번 바꿔도 문맥이 쌓여 다른 3D 그림이 꺼지지 않게.
// 11-20 RB-UNITREE-LOOK-FIX(RV-460 1·2): 상자는 BLOCK 개씩 나눈 InstancedMesh 묶음 — 채우기·GPU 올리기를 한 프레임 SLICE_MS·BLOCK_UP 묶음까지만 하고 다음 프레임으로 넘긴다
// (처음 열기·보기 전환·판 갱신·크기 바뀜 모두 같은 길). 바뀐 묶음만 다시 올린다. 셰이더는 compileAsync 로 기다린다. 상한은 칸 크기가 바뀔 때마다 다시 정한다.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CELL_M, type DriveFeed, type Pose } from './drivemedia';
import { go2Body, loadGo2, type Pose as Go2Pose } from './go2model';

/** 그릴 상자 상한(작은 칸 · 폰 크기 칸 · 큰 칸) — 넘으면 고르게 솎는다. 칸의 짧은 변이 SMALL_PX 미만이면 작은 칸(폰 직결 작은 창 포함), PHONE_PX 미만이면 폰 크기(runs/qa-rb-unitree-look-web 측정표) */
export const CAP_SMALL = 20_000, CAP_PHONE = 60_000, CAP_BIG = 200_000, SMALL_PX = 180, PHONE_PX = 500;
export const capFor = (small: boolean, w: number, h: number) => (small || Math.min(w, h) < SMALL_PX ? CAP_SMALL : Math.min(w, h) < PHONE_PX ? CAP_PHONE : CAP_BIG);
/** 나눠 그리기: 묶음 하나 = BLOCK 상자(행렬 1 MB). 한 프레임에 채우기 SLICE_MS ms · GPU 로 올리는 묶음 BLOCK_UP 개까지(runs/qa-rb-unitree-look-fix 측정표)
 *  ponytail: 고정 예산 — 느린 기기에서 한 묶음이 SLICE_MS 를 넘으면 BLOCK 을 줄인다 */
export const BLOCK = 16_384, SLICE_MS = 8, BLOCK_UP = 2;
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
/** 점(라이다 칸·위에서 본 그림) 색표 = 영상 B·저장 지도 점과 같은 hueAt(초록 → 노랑·주황 → 빨강·분홍) — 11-20 RB-UNITREE-LOOK-FIX ①. 상자는 위 LUT(영상 A).
 *  hueAt 은 screens/voxelmap.tsx hueAt 과 같은 식(가져오면 voxelmap → … → lidarmap → lidar3d 순환 import 라 옮겨 씀 — 바꿀 땐 둘 다) */
const hueAt = (z: number) => (120 - 150 * Math.max(0, Math.min(1, z / TOP_M)) + 360) % 360;
let lutB: Float32Array | null = null;
const LUT_B = () => lutB ??= (() => {
  const t = new Float32Array(N * 3), c = new THREE.Color();
  for (let i = 0; i < N; i++) c.setHSL(hueAt((i / (N - 1)) * TOP_M) / 360, 0.75, 0.5).toArray(t, i * 3);
  return t;
})();
/** 바닥(floor)부터 높이 z → 색 단계 0..N-1 */
export const levelOf = (z: number, floor: number) => Math.max(0, Math.min(N - 1, Math.round(((z - floor) / TOP_M) * (N - 1))));
/** 그 단계 색(sRGB 0..255) — 위에서 본 그림(2D 화소)용 */
export const rgbOf = (k: number) => { const c = new THREE.Color().fromArray(LUT_B(), k * 3).convertLinearToSRGB(); return [c.r, c.g, c.b].map((v) => Math.round(v * 255)); };

/** 버퍼 채우기: n 개 중 cap 이하로 고르게 솎아 솎은 순번 [from, to) 만 버퍼 앞에서부터 채운다. [채운 수, 앞 내용과 달라졌나]
 *  box = 상자(5 cm 칸 가운데 자리 — 상자 하나당 16칸 행렬의 이동 자리 12·13·14), 아니면 점(받은 자리 그대로 x·y·z) */
export function fillRange(mat: Float32Array, col: Float32Array, xyz: Float32Array, n: number, cap: number, floor: number, from: number, to: number, box = true): [number, boolean] {
  const step = Math.max(1, Math.ceil(n / cap)), s = CELL_M, end = Math.min(to, cap, Math.ceil(n / step)), w = box ? 16 : 3, at = box ? 12 : 0;
  const snap = (u: number) => (box ? Math.fround((Math.floor(u / s) + 0.5) * s) : u);   // 버퍼(f32)와 같은 값으로 비교
  let m = 0, diff = false; const L = box ? LUT : LUT_B();
  for (let j = from; j < end; j++, m++) {
    const i = j * step, z = xyz[i * 3 + 2], k = levelOf(z, floor) * 3, o = m * w + at;
    const x = snap(xyz[i * 3]), y = snap(xyz[i * 3 + 1]), h = snap(z);
    if (mat[o] !== x || mat[o + 1] !== y || mat[o + 2] !== h || col[m * 3] !== L[k] || col[m * 3 + 1] !== L[k + 1] || col[m * 3 + 2] !== L[k + 2]) diff = true;
    mat[o] = x; mat[o + 1] = y; mat[o + 2] = h;
    col[m * 3] = L[k]; col[m * 3 + 1] = L[k + 1]; col[m * 3 + 2] = L[k + 2];
  }
  return [m, diff];
}
/** 한 버퍼에 다 채우기(채운 수) */
export const fillBoxes = (mat: Float32Array, col: Float32Array, xyz: Float32Array, n: number, cap: number, floor: number) => fillRange(mat, col, xyz, n, cap, floor, 0, cap)[0];

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
export const HeightLegend = ({ style, look = 'points' }: { style?: CSSProperties; look?: Look }) => <div className="qd-legend" aria-label="높이 색 범례" data-height-legend={look} style={style}>
  <div style={{ height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${look === 'boxes' ? STOPS.join(',') : [0, 0.25, 0.5, 0.75, 1].map((t) => `hsl(${hueAt(t * TOP_M)} 75% 50%)`).join(',')})` }} />
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>바닥</span><span>높음</span></div>
</div>;

type Mode = 'chase' | 'follow' | 'free';
export type Look = 'points' | 'boxes';
/** 상자 묶음 하나 분량의 단위 행렬(한 번만 만들고 묶음마다 복사) */
let unitM: Float32Array | null = null;
const unit = () => { if (!unitM) { unitM = new Float32Array(BLOCK * 16); for (let i = 0; i < unitM.length; i += 16) unitM[i] = unitM[i + 5] = unitM[i + 10] = unitM[i + 15] = 1; } return unitM; };
/** 받은 자세가 값까지 같은가(go2Pose 는 그릴 때마다 새 객체) */
const samePose = (a: Go2Pose, b: Go2Pose) => a === b || (!!a && !!b && a.q.every((x, i) => x === b.q[i]) && a.wxyz.every((x, i) => x === b.wxyz[i]));
/** 묶음 하나(상자 InstancedMesh 또는 점 Points): pos·col = 채울 버퍼, k = 그리는 수, set = 수 바꾸고 GPU 로 다시 올림 표시 */
type Blk = { o: THREE.Object3D; pos: Float32Array; col: Float32Array; k: number; set: (k: number) => void; free: () => void };
/** ratio = 그리는 픽셀 비율 상한(기본 2 — 그대로). 실기 직결 조종은 1: 큰 화면 교환 때 다시 그리는 비용이 조종 명령 주기를 막지 않게(RV-455 1).
 *  legend = 칸 안 색 범례(작은 칸이 아니면 기본으로) */
export function Lidar3D({ feed, small, onFail, ratio = 2, legend = !small, look = 'points', go2 = null }: { feed: DriveFeed; small: boolean; onFail: () => void; ratio?: number; legend?: boolean; look?: Look; go2?: Go2Pose }) {
  const host = useRef<HTMLDivElement>(null), cur = useRef(feed), joints = useRef(go2), [mode, setMode] = useState<Mode>('chase'), again = useRef(() => {}), first = useRef(look), relook = useRef((_: Look) => {}), stance = useRef(() => {});
  cur.current = feed; joints.current = go2;
  useEffect(() => {
    const el = host.current!;
    let g: THREE.WebGLRenderer;
    try { g = new THREE.WebGLRenderer({ antialias: !small }); } catch { onFail(); return; }
    g.setPixelRatio(Math.min(window.devicePixelRatio || 1, ratio));
    const canvas = g.domElement;
    canvas.style.cssText = `display:block;width:100%;height:100%;touch-action:${small ? 'auto' : 'none'}`;
    canvas.setAttribute('role', 'img');
    const label = (k: Look) => canvas.setAttribute('aria-label', `라이다 3D — 높이별 색 ${k === 'boxes' ? '상자' : '점'}${small ? '' : ' · 끌어서 돌리기, 휠·두 손가락 확대, 오른쪽 끌기·Shift+끌기 옮기기'}`);
    let kind = first.current;
    label(kind);
    el.prepend(canvas);
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(55, 1, 0.05, 400);
    cam.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(-2, -3, 8); scene.add(sun);
    // BLOCK 개씩 묶음. 상자 행렬은 InstancedMesh 가 단위 행렬로 깔아 두고, 판마다 이동 자리만 채운다
    const mat = new THREE.MeshLambertMaterial({ map: edgeTexture('rgba(0,0,0,0.35)') }), cube = new THREE.BoxGeometry(CELL_M, CELL_M, CELL_M);
    const dot = new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true });   // 저장 지도 점(voxel3d DOT_PX)과 같은 작은 점
    const boxes = new THREE.Group(), blocks: Blk[] = [];
    const block = (): Blk => {
      let b: Blk;
      if (kind === 'boxes') {
        // 생성자는 칸마다 setMatrixAt(단위 행렬)을 돌아 한 묶음에 수십 ms — 0 칸으로 만들고 단위 행렬 틀을 복사해 끼운다(RV-460 1)
        const m = new THREE.InstancedMesh(cube, mat, 0), mc = new THREE.InstancedBufferAttribute(new Float32Array(BLOCK * 3), 3).setUsage(THREE.DynamicDrawUsage);
        m.instanceMatrix = new THREE.InstancedBufferAttribute(unit().slice(), 16).setUsage(THREE.DynamicDrawUsage); m.instanceColor = mc;
        b = { o: m, pos: m.instanceMatrix.array as Float32Array, col: mc.array as Float32Array, k: 0, set(k) { b.k = m.count = k; m.instanceMatrix.needsUpdate = true; mc.needsUpdate = true; }, free: () => m.dispose() };
      } else {
        const geo = new THREE.BufferGeometry(), pa = new THREE.BufferAttribute(new Float32Array(BLOCK * 3), 3).setUsage(THREE.DynamicDrawUsage), ca = new THREE.BufferAttribute(new Float32Array(BLOCK * 3), 3).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('position', pa); geo.setAttribute('color', ca); geo.setDrawRange(0, 0);
        b = { o: new THREE.Points(geo, dot), pos: pa.array as Float32Array, col: ca.array as Float32Array, k: 0, set(k) { b.k = k; geo.setDrawRange(0, k); pa.needsUpdate = true; ca.needsUpdate = true; }, free: () => geo.dispose() };
      }
      b.o.frustumCulled = false;   // 판마다 범위가 바뀐다
      // 경계구를 고정 — 없으면 three 가 첫 그리기(정렬)에서 칸·점마다 돌아 경계구를 계산해 주 스레드를 막는다(RV-460 1)
      const all = new THREE.Sphere(new THREE.Vector3(), Infinity);
      if (b.o instanceof THREE.InstancedMesh) b.o.boundingSphere = all; else (b.o as THREE.Points).geometry.boundingSphere = all;
      blocks.push(b); boxes.add(b.o);
      return b;
    };
    const grid = new THREE.GridHelper(40, 40, 0x8a94a6, 0x8a94a6);   // 1 m 칸
    grid.rotation.x = Math.PI / 2;
    for (const m of [grid.material].flat()) { m.transparent = true; m.opacity = 0.18; m.depthWrite = false; }
    // 로봇: 반투명 회색(나중에 받은 메시로 바꿔 끼움 — 바꿔 끼울 때 옛 모양을 해제)
    const skin = new THREE.MeshLambertMaterial({ color: 0xb4bac4, transparent: true, opacity: 0.7, depthWrite: false });
    const bot = new THREE.Group();
    let lean = (_: Go2Pose) => {};
    const dress = (m: Parameters<typeof go2Body>[0]) => {
      bot.children.slice().forEach((c) => { bot.remove(c); c.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); });
      const b = go2Body(m, skin); bot.add(b.body); lean = b.pose; lean(joints.current);
    };
    let live = true;
    loadGo2().then((m) => { if (live && m) { dress(m); draw(); } });
    scene.add(boxes, grid, bot);
    const orbit = new OrbitControls(cam, canvas);
    orbit.enabled = !small; orbit.maxDistance = 150; orbit.screenSpacePanning = true;
    const v = { go2: joints.current, ver: -1, w: 0, h: 0, mode: 'chase' as Mode, drag: false, dirty: true, at: new THREE.Vector3(), last: null as THREE.Vector3 | null, t0: new THREE.Vector3() };
    const go = (m: Mode) => { v.mode = m; setMode(m); };
    let onScreen = true, ready = false;   // 셰이더가 준비되기 전엔 그리지 않음(첫 그리기의 동기 컴파일이 주 스레드를 막지 않게)
    const off = () => document.hidden || !onScreen || !el.clientWidth || !el.clientHeight;
    const draw = () => {
      if (off() || !ready) { v.dirty = true; return; }   // 안 보이면 미룸
      v.dirty = false; g.render(scene, cam);
    };
    // 나눠 채우기: p.b = 다음에 채울 묶음, p.again = 도는 중에 판·상한이 바뀜(끝나면 처음부터 한 번 더 — 바뀐 묶음만 올라간다)
    const p = { cap: 0, b: -1, again: false, raf: 0 };
    const pump = () => {
      p.raf = 0;
      if (p.b < 0 || off() || !ready) return;   // 안 보이면 멈춤 — tick 이 다시 부른다
      const c = cur.current, r = robotOf(c), floor = (r?.z ?? 0) + FLOOR_DZ, t0 = performance.now(), need = Math.ceil(Math.min(c.n, p.cap) / BLOCK);
      let up = 0;
      while (p.b < need && up < BLOCK_UP && performance.now() - t0 < SLICE_MS) {
        const b = blocks[p.b] ?? block(), [k, diff] = fillRange(b.pos, b.col, c.xyz, c.n, p.cap, floor, p.b * BLOCK, (p.b + 1) * BLOCK, kind === 'boxes');
        if (diff || k !== b.k) { b.set(k); up++; }
        p.b++;
      }
      if (p.b >= need) {
        for (const b of blocks.splice(Math.max(1, need))) { boxes.remove(b.o); b.free(); }   // 상한·점이 줄면 남는 묶음을 놓는다
        if (!need && blocks[0].k) blocks[0].set(0);
        p.b = p.again ? 0 : -1; p.again = false;
      }
      el.dataset.l3Drawn = String(blocks.reduce((a, b) => a + b.k, 0));
      if (up || p.b < 0) draw();
      if (p.b >= 0) p.raf = requestAnimationFrame(pump);
    };
    const refill = () => { if (p.b >= 0) p.again = true; else p.b = 0; if (!p.raf) pump(); };
    const fit = () => {
      v.w = el.clientWidth; v.h = el.clientHeight; if (!v.w || !v.h) return; g.setSize(v.w, v.h, false); cam.aspect = v.w / v.h; cam.updateProjectionMatrix();
      const cap = capFor(small, v.w, v.h);   // 칸이 작은 칸↔폰↔PC 크기로 바뀌면 그 크기의 상한으로 다시
      if (cap !== p.cap) { p.cap = cap; if (v.ver >= 0) refill(); }
    };
    const chase = (r: Pose) => {   // 로봇 뒤 위에서 앞을 본다
      const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
      orbit.target.set(r.x + c * AHEAD, r.y + s * AHEAD, r.z); cam.position.set(r.x - c * BACK, r.y - s * BACK, r.z + UP); orbit.update();
    };
    const load = () => {
      const c = cur.current, r = robotOf(c), z0 = r?.z ?? 0;
      v.ver = c.ver;
      refill();
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
      if (!samePose(joints.current, v.go2)) { v.go2 = joints.current; lean(v.go2); v.dirty = true; }   // 안 보이던 동안 온 자세
      if (cur.current.ver !== v.ver) return load();
      if (p.b >= 0 && !p.raf) return pump();
      if (size || v.dirty) draw();
    };
    const t = setInterval(tick, 500);   // 판 갱신 2 Hz
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { fit(); draw(); });
    ro?.observe(el);
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; tick(); });
    io?.observe(el);
    const vis = () => tick();
    document.addEventListener('visibilitychange', vis);
    const prepare = () => {   // 셰이더 준비를 기다림(주 스레드 안 막음) — 처음과 look 바꿀 때
      if (!g.compileAsync) { ready = true; return; }
      ready = false;
      const done = () => { if (live) { ready = true; tick(); } };
      g.compileAsync(scene, cam).then(done, done);
    };
    stance.current = () => {   // 새 관절·기울기 표본(약 10 Hz)마다 다리만 옮겨 한 번 그림 — 점·상자 버퍼는 그대로(나눠 채우는 중이면 그 프레임이 그림)
      if (samePose(joints.current, v.go2)) return;
      v.go2 = joints.current; lean(v.go2);
      if (p.b >= 0) v.dirty = true; else draw();
    };
    relook.current = (k) => {   // 점↔상자: 묶음만 새 모양으로 바꿔 처음부터 나눠 채운다(WebGL 그대로)
      if (k === kind) return;
      kind = k; label(k);
      for (const b of blocks.splice(0)) { boxes.remove(b.o); b.free(); }
      block(); prepare(); refill();
    };
    // 처음 열기도 나눠서(RV-460 1): ① 위 WebGL 만들기 ② Go2·첫 묶음·크기 맞추기 ③ 셰이더 준비·첫 시점·첫 판 — 사이사이에 STOP·조종 입력이 끼어든다
    const steps = [() => { if (!bot.children.length) dress(null); if (!blocks.length) block(); fit(); }, () => { prepare(); again.current(); load(); }];
    let si = 0, st = 0;
    const next = () => { st = 0; if (!live) return; steps[si++](); if (si < steps.length) st = window.setTimeout(next, 0); };
    st = window.setTimeout(next, 0);
    return () => {
      live = false; clearTimeout(st); if (p.raf) cancelAnimationFrame(p.raf); clearInterval(t); ro?.disconnect(); io?.disconnect(); document.removeEventListener('visibilitychange', vis); orbit.dispose();
      cube.dispose(); blocks.forEach((b) => b.free()); mat.map?.dispose(); mat.dispose(); dot.dispose(); skin.dispose(); bot.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      grid.dispose(); g.dispose(); g.forceContextLoss(); canvas.remove();
    };
  }, [small]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { first.current = look; relook.current(look); }, [look]);
  useEffect(() => stance.current(), [go2]);
  return <div ref={host} style={{ position: 'absolute', inset: 0 }} data-lidar3d={feed.n} data-l3-view={mode} data-l3-look={look}>
    {legend && <HeightLegend look={look} />}
    {!small && !go2 && robotOf(feed) && <div className="qd-legend" role="status" data-l3-nopose style={{ bottom: 46 }}>자세 정보 없음 — 서 있는 모양으로 보입니다</div>}
    {mode !== 'chase' && !small && <button type="button" className="btn" data-l3-follow style={{ position: 'absolute', left: 8, bottom: 8 }} onClick={() => again.current()}>로봇 뒤에서 보기</button>}
  </div>;
}

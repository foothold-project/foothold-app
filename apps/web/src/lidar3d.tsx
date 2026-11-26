// 조종 화면 라이다 칸 3D(11-19 RB-LIDAR-3D · 11-20 RB-UNITREE-LOOK-WEB = Unitree 앱 조종 화면처럼): drivemedia 가 준 xyz 를 그대로(frame map·odom = 그 기준 자리) three 로 그린다. lidar_link(raw 센서 좌표)만 lidarmount.ts 로 몸(base_link) 좌표로 한 번 바꿔 그린다(11-26 RB-LIDAR-RAW-MOUNT).
// look = 'points'(라이다 — 작은 점 그대로, 11-20 RB-UNITREE-LOOK-FIX 로 되돌림) · 'boxes'(«상자» 보기 — 점 하나 = 5 cm 상자(CELL_M), InstancedMesh, 면 무늬로 가장자리 선).
// 색 = 둘 다 바닥부터 높이(heightcolor.ts 한 표 — 바닥 회남색, 0.1~1.2 m 촘촘히, 11-25 RB-LIDAR-COLOR). look 이 바뀌어도 WebGL 은 그대로(묶음만 바꿈).
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
import { HEX, LEGEND_BG, N, TOP_M, levelOf } from './heightcolor';
import { inBase } from './lidarmount';

/** 그릴 상자 상한(작은 칸 · 폰 크기 칸 · 큰 칸) — 넘으면 고르게 솎는다. 칸의 짧은 변이 SMALL_PX 미만이면 작은 칸(폰 직결 작은 창 포함), PHONE_PX 미만이면 폰 크기(runs/qa-rb-unitree-look-web 측정표) */
export const CAP_SMALL = 20_000, CAP_PHONE = 60_000, CAP_BIG = 200_000, SMALL_PX = 180, PHONE_PX = 500;
export const capFor = (small: boolean, w: number, h: number) => (small || Math.min(w, h) < SMALL_PX ? CAP_SMALL : Math.min(w, h) < PHONE_PX ? CAP_PHONE : CAP_BIG);
/** 나눠 그리기: 묶음 하나 = BLOCK 상자(행렬 1 MB). 한 프레임에 채우기 SLICE_MS ms · GPU 로 올리는 묶음 BLOCK_UP 개까지(runs/qa-rb-unitree-look-fix 측정표)
 *  ponytail: 고정 예산 — 느린 기기에서 한 묶음이 SLICE_MS 를 넘으면 BLOCK 을 줄인다 */
export const BLOCK = 16_384, SLICE_MS = 8, BLOCK_UP = 2;
/** 바닥 = 로봇 z + FLOOR_DZ(m). 로봇 z = frame odom 판의 pose z(agent: rt/utlidar/robot_odom, 없으면 sport position — 몸통 자리, 선 Go2 ≈ 바닥 위 0.3 m),
 *  frame lidar_link(pose 없음)면 점을 몸 좌표로 바꾼 뒤라 몸(base_link) 원점 0. agent 지도 만들기의 floor_z(첫 pose z − 0.3, SLAM-MAPPING.md)와 같은 값. 엎드리면 몸통이 내려가 바닥 색이 위로 밀린다.
 *  ponytail: 상수 하나 — 실기에서 바닥 색이 바닥 띠(heightcolor BANDS 첫 줄)에 안 들어오면 이 값을 고친다 */
export const FLOOR_DZ = -0.3;
/** 높이 단계별 색(three 선형 RGB) — 점·상자 같은 표(heightcolor.ts) */
export const LUT = (() => { const t = new Float32Array(N * 3), c = new THREE.Color(); HEX.forEach((h, i) => c.set(h).toArray(t, i * 3)); return t; })();
/** 그 단계 색(sRGB 0..255) — 위에서 본 그림(2D 화소)용 */
export const rgbOf = (k: number) => [1, 3, 5].map((i) => parseInt(HEX[k].slice(i, i + 2), 16));
/** 모서리 점(feed.edge 양수, 11-25 RB-LIDAR-EDGEWEB) — 높이 색은 그대로 두고:
 *  점·위에서 본 그림 = 큰 점(EDGE_PX, 보통 1.5)을 테두리 색(ringOf — 칸 글자색: 다크 밝음·라이트 어두움)으로 먼저 깔고 가운데에 보통 점 = 테두리 두른 점,
 *  상자 = EDGE_SCALE 배 상자를 높이 색에서 흰색 쪽으로 EDGE_LIFT 만큼 밝게(상자는 면 무늬 선이 있어 밝은 바탕에서도 보임).
 *  ponytail: 고정 값 — 실기 화면에서 모서리가 너무 굵거나 묻히면 이 셋을 고친다 */
export const EDGE_LIFT = 0.5, EDGE_PX = 4.5, EDGE_SCALE = 1.6;
export const EDGE_LUT = LUT.map((v) => v + (1 - v) * EDGE_LIFT);
/** 테두리 색 = 그 칸의 글자색(테마 따라 바뀜, 못 읽으면 흰색) */
export const ringOf = (el: Element) => new THREE.Color().setStyle(getComputedStyle(el).color || '#ffffff');
/** 5 cm 칸 가운데(버퍼 f32 와 같은 값) */
const cellOf = (u: number) => Math.fround((Math.floor(u / CELL_M) + 0.5) * CELL_M);

/** 버퍼 채우기: n 개 중 cap 이하로 고르게 솎아 솎은 순번 [from, to) 만 버퍼 앞에서부터 채운다. [채운 수, 앞 내용과 달라졌나]
 *  box = 상자(5 cm 칸 가운데 자리 — 상자 하나당 16칸 행렬의 이동 자리 12·13·14), 아니면 점(받은 자리 그대로 x·y·z) */
export function fillRange(mat: Float32Array, col: Float32Array, xyz: Float32Array, n: number, cap: number, floor: number, from: number, to: number, box = true): [number, boolean] {
  const step = Math.max(1, Math.ceil(n / cap)), end = Math.min(to, cap, Math.ceil(n / step)), w = box ? 16 : 3, at = box ? 12 : 0;
  const snap = (u: number) => (box ? cellOf(u) : u);   // 버퍼(f32)와 같은 값으로 비교
  let m = 0, diff = false;
  for (let j = from; j < end; j++, m++) {
    const i = j * step, z = xyz[i * 3 + 2], k = levelOf(z, floor) * 3, o = m * w + at;
    const x = snap(xyz[i * 3]), y = snap(xyz[i * 3 + 1]), h = snap(z);
    if (mat[o] !== x || mat[o + 1] !== y || mat[o + 2] !== h || col[m * 3] !== LUT[k] || col[m * 3 + 1] !== LUT[k + 1] || col[m * 3 + 2] !== LUT[k + 2]) diff = true;
    mat[o] = x; mat[o + 1] = y; mat[o + 2] = h;
    col[m * 3] = LUT[k]; col[m * 3 + 1] = LUT[k + 1]; col[m * 3 + 2] = LUT[k + 2];
  }
  return [m, diff];
}
/** 모서리 층 채우기: edge[i] 가 양수인 점만 앞에서부터(BLOCK 까지 — 라이다 한 판은 4000 점 이하), 자리는 fillRange 와 같고
 *  색은 ring(선형 RGB — 점의 테두리 색) 또는 없으면 EDGE_LUT(상자 — 밝힌 높이 색). 채운 수 */
export function fillEdges(mat: Float32Array, col: Float32Array, xyz: Float32Array, n: number, edge: Uint8Array, floor: number, box: boolean, ring?: ArrayLike<number>) {
  const w = box ? 16 : 3, at = box ? 12 : 0;
  let m = 0;
  for (let i = 0; i < Math.min(n, edge.length) && m < BLOCK; i++) {
    if (!edge[i]) continue;
    const o = m * w + at, k = levelOf(xyz[i * 3 + 2], floor) * 3;
    for (let a = 0; a < 3; a++) { mat[o + a] = box ? cellOf(xyz[i * 3 + a]) : xyz[i * 3 + a]; col[m * 3 + a] = ring ? ring[a] : EDGE_LUT[k + a]; }
    m++;
  }
  return m;
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

/** 로봇 자리: pose 가 있으면 그것, lidar_link(몸 좌표로 바꾼 한 장 — inBase)면 몸 원점, 그 밖(pose 없는 map)은 모름 */
export const robotOf = (f: DriveFeed): Pose | null => f.pose ?? (f.frame === 'lidar_link' ? { x: 0, y: 0, z: 0, yaw: 0 } : null);
/** 3인칭 시점: 로봇 뒤 BACK m · 위 UP m 에서 로봇 앞 AHEAD m 를 본다 */
const BACK = 2.6, UP = 1.6, AHEAD = 1.5;

/** 색 범례(작게) — «바닥 · 1 m · 2 m+», 점·상자 같은 막대. edge = 이 판에 모서리 정보가 있으면 «모서리» 한 줄(범례 바탕은 다크·라이트 모두 어두운 반투명 — quad.css) */
export const HeightLegend = ({ style, look = 'points', edge = false }: { style?: CSSProperties; look?: Look; edge?: boolean }) => <div className="qd-legend" aria-label="높이 색 범례" data-height-legend={look} style={style}>
  <div style={{ height: 8, borderRadius: 2, background: LEGEND_BG }} />
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>바닥</span><span>1 m</span><span>{TOP_M} m+</span></div>
  {edge && <div data-edge-legend style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
    <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: HEX[20], boxShadow: '0 0 0 2px currentColor' }} /><span>모서리 — 테두리·크게</span></div>}
</div>;

type Mode = 'chase' | 'follow' | 'free';
export type Look = 'points' | 'boxes';
/** three 가 만들 때(init)·무늬 첫 올리기(이방성)에 부르는 확장 — 문맥 다음 작업에서 미리 불러 둔다(RV-466 2 성능 기록) */
const EXTS = ['EXT_color_buffer_float', 'WEBGL_clip_cull_distance', 'OES_texture_float_linear', 'EXT_color_buffer_half_float', 'WEBGL_multisampled_render_to_texture', 'WEBGL_render_shared_exponent', 'EXT_texture_filter_anisotropic'];
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
  cur.current = inBase(feed); joints.current = go2;   // raw 판만 몸 좌표로(판마다 1회)
  useEffect(() => {
    // 처음 열기를 더 잘게(RV-466 2 — 성능 기록: 누른 작업 하나에 React 반영 + WebGL 문맥 + three 초기화 + Go2 입히기가 몰려 STOP 이 늦음).
    // ⓪ 누른 작업 = 칸만 ① 문맥(getContext) ② three 가 부를 확장(첫 getExtension 은 GPU 와 동기 왕복) ③ 렌더러·장면(setup) — 사이사이에 STOP·조종 입력이 끼어든다. WebGL2 자체가 없으면 곧바로 위에서 본 그림
    if (typeof WebGL2RenderingContext === 'undefined') { onFail(); return; }
    let t = window.setTimeout(() => {
      const c = document.createElement('canvas'), gl = c.getContext('webgl2', { alpha: true, depth: true, stencil: false, antialias: !small, premultipliedAlpha: true, preserveDrawingBuffer: false });   // three 기본 속성 그대로
      t = window.setTimeout(() => { EXTS.forEach((x) => gl?.getExtension(x)); t = window.setTimeout(() => { stop = setup(c, gl) ?? stop; }, 0); }, 0);
    }, 0), stop = () => {};
    return () => { clearTimeout(t); stop(); };
  }, [small]);   // eslint-disable-line react-hooks/exhaustive-deps
  /** 3D 칸 만들기(들여쓰기는 옛 useEffect 그대로) — 돌려주는 것 = 닫기. 문맥을 못 만들었으면(gl null) three 가 한 번 더 시도하고 실패하면 onFail */
  function setup(c: HTMLCanvasElement, gl: WebGL2RenderingContext | null) {
    const el = host.current!;
    let g: THREE.WebGLRenderer;
    try { g = new THREE.WebGLRenderer({ canvas: c, context: gl ?? undefined, antialias: !small }); } catch { onFail(); return; }
    g.debug.checkShaderErrors = false;   // 첫 그리기의 셰이더 로그 읽기(동기 GPU 왕복)를 뺀다 — 우리 셰이더는 three 기본 재질뿐
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
    // 모서리 층(RB-LIDAR-EDGEWEB): 같은 재질 종류로 큰 점·큰 상자 한 묶음 — 큰 점(테두리 색)을 먼저 그려 가운데는 보통 점(높이 색)이 덮는다 = 테두리 두른 점
    const bigDot = new THREE.PointsMaterial({ size: EDGE_PX, sizeAttenuation: false, vertexColors: true }), bigCube = new THREE.BoxGeometry(CELL_M * EDGE_SCALE, CELL_M * EDGE_SCALE, CELL_M * EDGE_SCALE);
    const boxes = new THREE.Group(), blocks: Blk[] = [];
    const make = (big = false): Blk => {
      let b: Blk;
      if (kind === 'boxes') {
        // 생성자는 칸마다 setMatrixAt(단위 행렬)을 돌아 한 묶음에 수십 ms — 0 칸으로 만들고 단위 행렬 틀을 복사해 끼운다(RV-460 1)
        const m = new THREE.InstancedMesh(big ? bigCube : cube, mat, 0), mc = new THREE.InstancedBufferAttribute(new Float32Array(BLOCK * 3), 3).setUsage(THREE.DynamicDrawUsage);
        m.instanceMatrix = new THREE.InstancedBufferAttribute(unit().slice(), 16).setUsage(THREE.DynamicDrawUsage); m.instanceColor = mc;
        b = { o: m, pos: m.instanceMatrix.array as Float32Array, col: mc.array as Float32Array, k: 0, set(k) { b.k = m.count = k; m.instanceMatrix.needsUpdate = true; mc.needsUpdate = true; }, free: () => m.dispose() };
      } else {
        const geo = new THREE.BufferGeometry(), pa = new THREE.BufferAttribute(new Float32Array(BLOCK * 3), 3).setUsage(THREE.DynamicDrawUsage), ca = new THREE.BufferAttribute(new Float32Array(BLOCK * 3), 3).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('position', pa); geo.setAttribute('color', ca); geo.setDrawRange(0, 0);
        b = { o: new THREE.Points(geo, big ? bigDot : dot), pos: pa.array as Float32Array, col: ca.array as Float32Array, k: 0, set(k) { b.k = k; geo.setDrawRange(0, k); pa.needsUpdate = true; ca.needsUpdate = true; }, free: () => geo.dispose() };
      }
      b.o.frustumCulled = false;   // 판마다 범위가 바뀐다
      // 경계구를 고정 — 없으면 three 가 첫 그리기(정렬)에서 칸·점마다 돌아 경계구를 계산해 주 스레드를 막는다(RV-460 1)
      const all = new THREE.Sphere(new THREE.Vector3(), Infinity);
      if (b.o instanceof THREE.InstancedMesh) b.o.boundingSphere = all; else (b.o as THREE.Points).geometry.boundingSphere = all;
      return b;
    };
    const block = () => { const b = make(); blocks.push(b); boxes.add(b.o); return b; };
    /** 모서리 층: 판·모양이 바뀔 때 한 번에 채운다(한 판 ≤ 4000 점). 모서리가 있을 때만 장면에 넣는다 */
    let rim: Blk | null = null;
    const edges = () => {
      const c = cur.current, e = c.edge, r = robotOf(c);
      if (e && !rim) { rim = make(true); rim.o.renderOrder = -1; }
      if (!rim) return;
      rim.set(e ? fillEdges(rim.pos, rim.col, c.xyz, c.n, e, (r?.z ?? 0) + FLOOR_DZ, kind === 'boxes', kind === 'boxes' ? undefined : ringOf(el).toArray()) : 0);
      if (rim.k) scene.add(rim.o); else scene.remove(rim.o);
      el.dataset.l3Edges = String(rim.k);
    };
    const unrim = () => { if (rim) { scene.remove(rim.o); rim.free(); rim = null; } delete el.dataset.l3Edges; };
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
    loadGo2().then((m) => { if (m) setTimeout(() => { if (live) { dress(m); draw(); } }, 0); });   // 받아 둔 메시면 then 이 지금 작업 끝에 돌아 붙는다 — 따로 한 작업으로
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
      edges(); refill();
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
      const done = () => { if (live) { ready = true; draw(); setTimeout(tick, 0); } };   // 첫 그리기(프로그램 첫 사용·무늬 올리기)와 첫 채우기·올리기를 다른 작업으로
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
      unrim(); block(); edges(); prepare(); refill();
    };
    // 처음 열기도 나눠서(RV-460 1): ① 위 WebGL 만들기 ② Go2·첫 묶음·크기 맞추기 ③ 셰이더 준비·첫 시점·첫 판 — 사이사이에 STOP·조종 입력이 끼어든다
    const steps = [() => { if (!bot.children.length) dress(null); if (!blocks.length) block(); fit(); }, () => { prepare(); again.current(); load(); }];
    let si = 0, st = 0;
    const next = () => { st = 0; if (!live) return; steps[si++](); if (si < steps.length) st = window.setTimeout(next, 0); };
    st = window.setTimeout(next, 0);
    return () => {
      live = false; clearTimeout(st); if (p.raf) cancelAnimationFrame(p.raf); clearInterval(t); ro?.disconnect(); io?.disconnect(); document.removeEventListener('visibilitychange', vis); orbit.dispose();
      cube.dispose(); bigCube.dispose(); blocks.forEach((b) => b.free()); unrim(); mat.map?.dispose(); mat.dispose(); dot.dispose(); bigDot.dispose(); skin.dispose(); bot.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      grid.dispose(); g.dispose(); g.forceContextLoss(); canvas.remove();
    };
  }
  useEffect(() => { first.current = look; relook.current(look); }, [look]);
  useEffect(() => stance.current(), [go2]);
  return <div ref={host} style={{ position: 'absolute', inset: 0 }} data-lidar3d={feed.n} data-l3-view={mode} data-l3-look={look}>
    {legend && <HeightLegend look={look} edge={!!feed.edge} />}
    {!small && !go2 && robotOf(feed) && <div className="qd-legend" role="status" data-l3-nopose style={{ bottom: 46 }}>자세 정보 없음 — 서 있는 모양으로 보입니다</div>}
    {mode !== 'chase' && !small && <button type="button" className="btn" data-l3-follow style={{ position: 'absolute', left: 8, bottom: 8 }} onClick={() => again.current()}>로봇 뒤에서 보기</button>}
  </div>;
}

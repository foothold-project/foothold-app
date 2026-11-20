// Go2 3D 그림(RB-GO2-REAL-RENDER 11-19): Unitree 공개 메시(public/go2/go2.glb — 출처·라이선스는 같은 폴더)를 공개 URDF 관절 원점·축대로 붙이고,
// 로봇이 보낸 관절각을 그대로 돌린다. 관절마다 각도(°), 도는 중이면 도는 방향 화살표 + 각속도(°/s), 몸이 움직이면 바닥에 방향 화살표 + m/s, 돌면 굽은 화살표 + rad/s.
// 메시를 못 받으면 상자·막대 그림, WebGL 이 없으면 같은 자세를 선 그림(SVG)으로. 그림에 자리가 없는 관절 값은 그림 아래 줄로. 그림만 — 명령 0.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Go2RobotInfo } from '../../contracts/ts';
import type { Live } from './rt';

/** Go2 관절 이름 순서(mobile/sim/go2-replay.js GO2_JOINTS 와 같음) · 서 있는 기본 자세(보고 없을 때 그림) */
export const JOINTS = ['FR', 'FL', 'RR', 'RL'].flatMap((leg) => ['hip', 'thigh', 'calf'].map((part) => `${leg}_${part}_joint`));
const STAND = JOINTS.map((n) => (n.includes('hip') ? (n[1] === 'R' ? -0.1 : 0.1) : n.includes('thigh') ? (n.startsWith('F') ? 0.8 : 1) : -1.5));
/** Go2 치수(m, 공개 URDF 값): 엉덩이 앞뒤·좌우, 허벅지 옆 간격, 허벅지·종아리 길이, 몸통 */
const G = { hx: 0.1934, hy: 0.0465, ty: 0.0955, l1: 0.213, l2: 0.213, body: [0.376, 0.094, 0.114] as const };
/** 이보다 느리면 «멈춤»(화살표 없음): 관절 rad/s · 몸 m/s · 회전 rad/s — 서 있을 때 떨림을 거른다 */
export const JOINT_MIN = 0.15, MOVE_MIN = 0.05, TURN_MIN = 0.05;
/** 메시 색(디자인 토큰 값 — 그림 바탕이 늘 어두운 고정색이라 테마와 상관없이 고정): 흰 판 = --paper-2, 회색 몸 = --ink-2(어두운 테마), 검은 관절·발 = --ink */
const TONE: Record<string, string> = { light: '#EEECE6', mid: '#ADB5C1', dark: '#161C26' };
/** 화살표 색 = --dim-ink(어두운 테마) — 어두운 그림 바탕 위, 글자(pcdrive.css .pd-tag i)와 같은 색 */
const ARROW = '#3EC7B4';
/** 카메라: 오른쪽 앞 위에서 본다(three 좌표 — y 위). FIT = 다 보여야 할 반지름(m) */
const VIEW = new THREE.Vector3(0.8, 0.9, 1).normalize(), AIM = new THREE.Vector3(0.02, -0.2, 0), FIT = 0.5;
/** 시점(RB-GO2-ORBIT 11-20): az = 위에서 본 방향(rad, 제한 없음), el = 올려 본 각(rad, EL 안 — 바닥 밑 안 감), zoom = 기본 거리 배수(ZOOM 안). HOME = 처음 보기 */
export type View = { az: number; el: number; zoom: number };
export const HOME: View = { az: Math.atan2(VIEW.x, VIEW.z), el: Math.asin(VIEW.y), zoom: 1 };
const EL = [0.05, 1.45] as const, ZOOM = [0.5, 2.5] as const, DRAG = 0.01;   // DRAG = 끈 px 당 rad
const clamp = (x: number, [a, b]: readonly [number, number]) => Math.min(Math.max(x, a), b);
/** «처음 보기» 단추 자리(그림 칸 왼쪽 위 px) — 관절 값 글자가 이 자리를 피한다 */
const RESET = { x: 6, y: 6, w: 80, h: 26 };
/** 관절 온도 색 눈금 범위(°C) — 범위 표시용일 뿐 위험 기준 아님. 밖은 끝 색 */
export const TEMP_MIN = 20, TEMP_MAX = 80;
/** 한 색상(청록) 연함→진함: --dim-soft(밝은 테마) → --brand(어두운 테마) → --dim-ink(밝은 테마). 온도 없음·오래됨 = --ink-3(어두운 테마) 회색 */
const RAMP = ['#e0f0ed', '#3ec7b4', '#0b6459'], NO_TEMP = '#7d8693';
/** 온도 → 눈금 색(#rrggbb). 모르면 회색 */
export function tempColor(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c)) return NO_TEMP;
  const f = (Math.min(Math.max((c - TEMP_MIN) / (TEMP_MAX - TEMP_MIN), 0), 1)) * (RAMP.length - 1), i = Math.min(Math.floor(f), RAMP.length - 2), k = f - i;
  const ch = (h: string, o: number) => parseInt(h.slice(1 + o, 3 + o), 16);
  return `#${[0, 2, 4].map((o) => Math.round(ch(RAMP[i], o) + (ch(RAMP[i + 1], o) - ch(RAMP[i], o)) * k).toString(16).padStart(2, '0')).join('')}`;
}
/** 그림 오른쪽 아래 범례 자리(px) — 관절 값 글자가 이 자리를 피한다 */
const LEGEND = { w: 150, h: 18, pad: 4 };
const PARTS = ['trunk', 'hip', 'thigh', 'thigh_mirror', 'calf'];

export type Pose = { q: number[]; wxyz: number[] } | null;
/** 이만큼 넘게 새 보고가 없으면 «로봇 보고 없음»(서버 state 는 0.1 s 마다) */
export const REPORT_STALE_MS = 1000;
/** state.robot_info 에서 그림에 쓸 관절 12개 + 몸 자세. 모양이 틀리거나 연결이 끊겼거나 오래되면 null(지어내지 않음) */
export function go2Pose(s: Live['state'], fresh: boolean): Pose {
  const j = s?.robot_info?.joints, w = s?.robot_info?.quaternion?.wxyz;
  if (!fresh || s?.connection !== 'ONLINE' || !j || j.positions.length !== 12 || j.names.length !== 12 || !j.positions.every(Number.isFinite) || !(j.age_s <= 1)) return null;
  const q = JOINTS.map((n) => j.positions[j.names.indexOf(n as never)]);
  if (q.some((v) => v === undefined)) return null;
  const norm = w && w.length === 4 && w.every(Number.isFinite) ? Math.hypot(...w) : 0;
  return { q, wxyz: norm > 0.9 && norm < 1.1 ? w!.map((v) => v / norm) : [1, 0, 0, 0] };
}

/** 움직임: 관절 각속도 12개(rad/s) · 몸 속도(몸 기준 앞 vx·왼쪽 vy, m/s) · 회전 wz(rad/s, 왼쪽 +). 모르면 null */
export type Motion = { dq: number[] | null; v: [number, number] | null; wz: number | null };
type Sample = { t: number; v: number[]; at?: number };   // at = 받아들인 때의 화면 시계(performance.now, ms)

/** 연속 보고 두 개(로봇이 받은 시각이 다른 것)의 차 ÷ 시간. 시간이 0 이하·1초 넘음이면 null(지어내지 않음) */
export function rate(a: Sample | undefined, b: Sample | undefined): number[] | null {
  const dt = a && b ? (b.t - a.t) / 1000 : 0;
  return a && b && dt > 0 && dt <= 1 ? b.v.map((x, i) => (x - a.v[i]) / dt) : null;
}
const yawOf = ([w, x, y, z]: number[]) => Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** 이보다 오래된 센서 보고(age_s, 초)는 만료 — 그 센서 이력을 비운다(REPORT_STALE_MS 와 같은 1초) */
const STALE_S = 1;
type At = { received_at?: string; age_s?: number } | null | undefined;
/** 보고 시계(로봇 쪽 received_at)로 본 «지금» = 센서마다 received_at + age_s 중 가장 늦은 것. 모르면 NaN */
const nowOf = (ats: At[]) => Math.max(...ats.map((a) => (a?.received_at ? Date.parse(a.received_at) + (a.age_s ?? NaN) * 1000 : NaN)).filter(Number.isFinite));
/** 센서 하나의 보고를 이력에(RV-403 1). 받아들인 마지막 보고가 now 보다, 또는 화면 시계로 1초 넘게 묵으면 먼저 비운다
 *  (RV-406 — 역순 보고만 와도 만료 · RV-409 2 — 받아들이지 않는 옛 보고만 계속 와도 만료).
 *  거꾸로 간 시각(늦게 온 옛 보고)은 버린다(RV-405 — 최신 이력을 지우지 않음). 단 새 보고(age_s ≤ 1초이고 다른 센서들의 now 와도 1초 안)인데
 *  1초 넘게 뒤로 갔으면 시계가 되감긴 것 — 새 이력 시작(RV-406 2). 센서 하나만 옛 시각이면 되감김이 아니라 옛 보고(RV-409 1).
 *  값·시각이 없거나 만료면 이력을 비워 속도·화살표를 지운다. 같은 시각(같은 보고)은 버린다 */
const push = (h: Sample[], at: At, v: number[] | undefined, now: number, clock: number) => {
  const end = h[h.length - 1];
  if (end && (now - end.t > STALE_S * 1000 || clock - end.at! > STALE_S * 1000)) h.length = 0;
  const t = at?.received_at ? Date.parse(at.received_at) : NaN, lt = h.length ? h[h.length - 1].t : -Infinity;
  const ok = (at?.age_s ?? Infinity) <= STALE_S && !(now - t > STALE_S * 1000);
  if (ok && t < lt - STALE_S * 1000) h.length = 0;
  else if (t < lt) return;
  if (!v || !Number.isFinite(t) || !ok) { h.length = 0; return; }
  if (h.length && t === h[h.length - 1].t) return;
  h.push({ t, v, at: clock }); if (h.length > 2) h.shift();
};
const NONE: Motion = { dq: null, v: null, wz: null };

/** 보고가 바뀔 때마다 앞 보고와 비교해 움직임을 낸다. pose 가 null(보고 없음·오래됨)이면 이력을 비우고 null. 센서(관절·위치·방향)마다 따로 비운다 */
export function useGo2Motion(info: Go2RobotInfo | null | undefined, pose: Pose): Motion {
  const h = useRef({ j: [] as Sample[], p: [] as Sample[], y: [] as Sample[] }).current;
  if (!pose || !info) { h.j.length = h.p.length = h.y.length = 0; return NONE; }
  const now = nowOf([info.joints, info.position, info.quaternion]), clock = performance.now();
  push(h.j, info.joints, pose.q, now, clock);
  const xyz = info.position?.xyz;
  push(h.p, info.position, xyz && xyz.length >= 2 && xyz.every(Number.isFinite) ? xyz.slice(0, 2) : undefined, now, clock);
  push(h.y, info.quaternion, info.quaternion?.wxyz ? [yawOf(pose.wxyz)] : undefined, now, clock);
  const dy = h.y.length === 2 ? { ...h.y[1], v: [h.y[0].v[0] + wrap(h.y[1].v[0] - h.y[0].v[0])] } : undefined;
  // 몸 기준 변환은 마지막으로 받아들인 yaw 만(RV-405 — 늦게 온 옛 방향 보고로 화살표가 뒤집히지 않게). yaw 이력이 없으면 몸 속도도 모름
  const w = rate(h.p[0], h.p[1]), yaw = h.y[h.y.length - 1]?.v[0], c = Math.cos(yaw ?? 0), s = Math.sin(yaw ?? 0);
  return { dq: rate(h.j[0], h.j[1]), v: w && yaw !== undefined ? [c * w[0] + s * w[1], -s * w[0] + c * w[1]] : null, wz: rate(h.y[0], dy)?.[0] ?? null };
}

/** 부품 모양의 CPU 자료(꼭짓점·법선·순서 배열). 그림마다 이것으로 제 BufferGeometry 를 만들고 떠날 때 해제한다(RV-403 4) */
export type Part = { pos: THREE.TypedArray; nrm: THREE.TypedArray; idx: THREE.TypedArray | null };
/** go2.glb → «부품-색» 이름별 CPU 자료. 이름이 모자라면 오류 */
export async function parseGo2(buf: ArrayBuffer) {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const g = await new GLTFLoader().parseAsync(buf, '');
  const m = new Map<string, Part>();
  g.scene.traverse((o) => {
    const x = o as THREE.Mesh; if (!x.isMesh) return;
    const geo = x.geometry; geo.computeVertexNormals();
    m.set(x.name, { pos: geo.attributes.position.array, nrm: geo.attributes.normal.array, idx: geo.index?.array ?? null }); geo.dispose();
  });
  if (!PARTS.every((p) => [...m.keys()].some((k) => k.startsWith(`${p}-`)))) throw new Error('go2.glb 부품 모자람');
  return m;
}
let cache: Promise<Map<string, Part> | null> | null = null;
/** 한 번만 받는다. 못 받으면 null(상자 그림). ponytail: 실패도 다시 열 때까지 기억 — 다시 시도는 필요하면 */
export function loadGo2(url = `${import.meta.env.BASE_URL}go2/go2.glb`) {
  return (cache ??= fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status))).then(parseGo2).catch(() => null));
}
export function resetGo2Cache() { cache = null; }

type Leg = { hip: THREE.Group; thigh: THREE.Group; calf: THREE.Group; foot: THREE.Object3D; v: THREE.Group[] };
function makeRig(css: CSSStyleDeclaration | null) {
  const tok = (k: string, fb: string) => new THREE.Color(css?.getPropertyValue(k).trim() || fb);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(35, 1, 0.05, 20);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2)); const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 2, 1); scene.add(sun);
  const world = new THREE.Group(); world.rotation.x = -Math.PI / 2; scene.add(world);   // 로봇 좌표(z 위) → three(y 위)
  const floor = -0.33, grid = new THREE.GridHelper(1.6, 8, tok('--line2', '#556'), tok('--line', '#334')); grid.rotation.x = Math.PI / 2; grid.position.z = floor; world.add(grid);
  const body = new THREE.Group(), trunk = new THREE.Group(); world.add(body); body.add(trunk);
  const legs: Leg[] = ['FR', 'FL', 'RR', 'RL'].map((n) => {
    const sx = n[0] === 'F' ? 1 : -1, sy = n[1] === 'L' ? 1 : -1;
    const hip = new THREE.Group(); hip.position.set(sx * G.hx, sy * G.hy, 0); body.add(hip);
    const thigh = new THREE.Group(); thigh.position.y = sy * G.ty; hip.add(thigh);
    const calf = new THREE.Group(); calf.position.z = -G.l1; thigh.add(calf);
    const foot = new THREE.Object3D(); foot.position.z = -G.l2; calf.add(foot);
    const v = [hip, thigh, calf].map((j) => { const g = new THREE.Group(); j.add(g); return g; });
    return { hip, thigh, calf, foot, v };
  });
  // 바닥 화살표(곧은 = 움직이는 방향, 굽은 = 도는 방향) — 몸 기준, +x 쪽을 가리키게 그려 두고 돌린다
  const acc = new THREE.MeshBasicMaterial({ color: ARROW, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  const shape = new THREE.Shape([[0.36, -0.022], [0.5, -0.022], [0.5, -0.055], [0.58, 0], [0.5, 0.055], [0.5, 0.022], [0.36, 0.022]].map(([x, y]) => new THREE.Vector2(x, y)));
  const move = new THREE.Group(), tip = new THREE.Object3D(); tip.position.x = 0.6; move.add(new THREE.Mesh(new THREE.ShapeGeometry(shape), acc), tip);
  const turn = new THREE.Group(), R = 0.36, A = 1.6, end = new THREE.Object3D();
  const head = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape([[-0.05, 0], [0.05, 0], [0, 0.07]].map(([x, y]) => new THREE.Vector2(x, y)))), acc);
  head.position.set(R * Math.cos(A), R * Math.sin(A), 0); head.rotation.z = A; end.position.set((R + 0.08) * Math.cos(A + 0.15), (R + 0.08) * Math.sin(A + 0.15), 0);
  turn.add(new THREE.Mesh(new THREE.RingGeometry(R - 0.018, R + 0.018, 40, 1, -0.6, A + 0.6), acc), head, end);
  move.position.z = turn.position.z = floor + 0.002; world.add(move, turn);
  const box = { skin: new THREE.MeshStandardMaterial({ color: tok('--text', '#ccd'), roughness: 0.6 }), leg: new THREE.MeshStandardMaterial({ color: tok('--muted', '#889'), roughness: 0.7 }) };
  const tone = Object.fromEntries(Object.entries(TONE).map(([k, c]) => [k, new THREE.MeshStandardMaterial({ color: c, roughness: k === 'light' ? 0.55 : 0.7, metalness: 0.1 })]));
  return { scene, cam, world, body, trunk, legs, move, tip, turn, end, box, tone, kind: '' as 'box' | 'mesh' | '' };
}
type Rig = ReturnType<typeof makeRig>;

const clear = (g: THREE.Group) => g.children.slice().forEach((c) => { g.remove(c); (c as THREE.Mesh).geometry?.dispose(); });
/** 그림이 만든 모양·재질을 모두 해제(화면을 떠날 때). 캐시는 배열만 들고 있어 건드리지 않는다 */
function free(r: Rig) {
  r.scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); ([] as THREE.Material[]).concat(m.material ?? []).forEach((x) => x.dispose()); });
  [...Object.values(r.box), ...Object.values(r.tone)].forEach((x) => x.dispose());
}
/** 메시(없으면 상자·막대)를 관절 그룹에 붙인다. URDF visual 원점: 오른쪽 엉덩이는 x 축 180°, 뒤 엉덩이는 y 축 180°, 오른쪽 허벅지는 thigh_mirror */
function dress(r: Rig, m: Map<string, Part> | null) {
  [r.trunk, ...r.legs.flatMap((l) => l.v)].forEach(clear);
  if (!m) {
    r.trunk.add(new THREE.Mesh(new THREE.BoxGeometry(...G.body), r.box.skin));
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.06), r.box.skin); head.position.x = G.body[0] / 2 + 0.02; r.trunk.add(head);
    const bar = (len: number) => { const b = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.032, len), r.box.leg); b.position.z = -len / 2; return b; };
    r.legs.forEach((l) => { l.v[1].add(bar(G.l1)); l.v[2].add(bar(G.l2)); const f = new THREE.Mesh(new THREE.SphereGeometry(0.022), r.box.leg); f.position.z = -G.l2; l.v[2].add(f); });
    r.kind = 'box'; return;
  }
  const put = (g: THREE.Group, part: string) => m.forEach((d, k) => {
    const [p, t] = k.split('-');
    if (p !== part) return;
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(d.nrm, 3));
    if (d.idx) geo.setIndex(new THREE.BufferAttribute(d.idx, 1));
    g.add(new THREE.Mesh(geo, r.tone[t] ?? r.tone.mid));
  });
  put(r.trunk, 'trunk');
  ['FR', 'FL', 'RR', 'RL'].forEach((n, i) => {
    const [hv, tv, cv] = r.legs[i].v, right = n[1] === 'R';
    put(hv, 'hip'); hv.rotation.set(right ? Math.PI : 0, n[0] === 'R' ? Math.PI : 0, 0);
    put(tv, right ? 'thigh_mirror' : 'thigh'); put(cv, 'calf');   // calf_mirror 는 핀에 없음 — calf 가 좌우 대칭(y −0.019~0.020 m)이라 그대로
  });
  r.kind = 'mesh';
}

/** 관절각 12개(JOINTS 순서)·몸 기울기를 다리·몸에 — 자세가 없으면(null) 선 자세·기울기 0. 방향(yaw)은 빼서 기울기(앞뒤·옆)만 */
function lean(legs: Leg[], body: THREE.Object3D, pose: Pose) {
  const q = pose?.q ?? STAND, [qw, qx, qy, qz] = pose?.wxyz ?? [1, 0, 0, 0];
  legs.forEach((l, i) => { l.hip.rotation.x = q[i * 3]; l.thigh.rotation.y = q[i * 3 + 1]; l.calf.rotation.y = q[i * 3 + 2]; });
  body.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -yawOf([qw, qx, qy, qz])).multiply(new THREE.Quaternion(qx, qy, qz, qw));
}

/** 라이다 3D 안에 둘 Go2(RB-UNITREE-LOOK-WEB · 11-20 RB-UNITREE-LOOK-FIX E): 로봇 좌표(z 위·x 앞), 몸통 가운데가 원점. 모든 면을 재질 하나(mat)로. 메시(m)가 없으면 상자·막대 그림.
 *  pose(p) = 받은 관절각·기울기로(Go2Figure 와 같은 lean), null 이면 선 자세. 돌려준 묶음의 모양(geometry)은 부르는 쪽이 해제한다 */
export function go2Body(m: Map<string, Part> | null, mat: THREE.Material) {
  const r = makeRig(null);
  dress(r, m);
  lean(r.legs, r.body, null);
  r.world.remove(r.body);
  free(r);   // 몸 밖(바닥 격자·화살표)과 원래 재질만 해제 — 몸 모양은 떼어 둬서 남는다
  r.body.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mat; });
  return { body: r.body, pose: (p: Pose) => lean(r.legs, r.body, p) };
}
/** 선 자세 몸(slamview.tsx 로봇 지도 3D) */
export const go2Standing = (m: Map<string, Part> | null, mat: THREE.Material) => go2Body(m, mat).body;

/** 몸 화살표 글자의 시험용 표시(data-go2-move · data-go2-turn=left|right) */
const ARROW_TAG: Record<string, [string, string]> = { move: ['data-go2-move', ''], left: ['data-go2-turn', 'left'], right: ['data-go2-turn', 'right'] };
const deg = (v: number) => Math.round((v * 180) / Math.PI);
const fix = (v: number, d: number) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
type Tag = { x: number; y: number; side: number; z: number };   // z = 화면 깊이(NDC, 작을수록 카메라에 가까움)
type Box = { x: number; y: number; w: number; h: number };
/** 글자 상자를 겹치지 않게 놓는다(앞에서부터 차례로): 관절 바깥쪽 옆 → 위아래로 14 px 씩 → 반대쪽.
 *  taken = 이미 찬 자리(범례). 칸 안에 겹치지 않는 자리가 없으면 null(그림 아래 줄로 — RV-403 3). pin(몸 화살표 글자)은 첫 자리를 칸 안으로 당겨 늘 그림 안에 */
export function spread(tags: { x: number; y: number; side: number; w: number; h: number; pin?: boolean }[], W: number, H: number, taken: Box[] = []): (Box | null)[] {
  const done: Box[] = [...taken], hit = (a: Box) => done.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
  const inside = (c: Box): Box => { const w = Math.min(c.w, W), h = Math.min(c.h, H); return { x: Math.min(Math.max(c.x, 0), W - w), y: Math.min(Math.max(c.y, 0), H - h), w, h }; };
  return tags.map((t) => {
    const at = (side: number, dy: number): Box => ({ x: side > 0 ? t.x + 5 : t.x - 5 - t.w, y: t.y - t.h / 2 + dy, w: t.w, h: t.h });
    const tries = [t.side, -t.side].flatMap((sd) => [0, -14, 14, -28, 28, -42, 42].map((dy) => at(sd || 1, dy)));
    const b = tries.find((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= W && c.y + c.h <= H && !hit(c)) ?? (t.pin ? inside(tries[0]) : null);
    if (b) done.push(b);
    return b;
  });
}
/** 그림 아래 줄의 관절 이름(앞 오른 종아리 등) */
const LEG: Record<string, string> = { FR: '앞 오른', FL: '앞 왼', RR: '뒤 오른', RL: '뒤 왼' }, PART: Record<string, string> = { hip: '엉덩이', thigh: '허벅지', calf: '종아리' };
export const jointName = (n: string) => `${LEG[n.slice(0, 2)]} ${PART[n.split('_')[1]]}`;
/** 자세를 놓고, 관절·화살표 끝을 화면 px 로. 관절 화살표 = 각속도 부호 × (돌림축이 카메라 쪽이면 +) — 오른손 법칙대로 + 는 보는 사람에게 반시계(↺) */
function place(r: Rig, pose: Pose, mo: Motion, w: number, h: number, view: View = HOME) {
  lean(r.legs, r.body, pose);   // 몸은 기울기(앞뒤·옆)만 — 방향(yaw)은 빼서 늘 같은 쪽에서 본다(회전은 굽은 화살표로)
  const v = mo.v && Math.hypot(...mo.v) >= MOVE_MIN ? mo.v : null, wz = mo.wz != null && Math.abs(mo.wz) >= TURN_MIN ? mo.wz : null;
  r.move.visible = !!v; if (v) r.move.rotation.z = Math.atan2(v[1], v[0]);
  r.turn.visible = wz != null; r.turn.scale.y = wz != null && wz < 0 ? -1 : 1;
  // 칸 모양에 맞춰 로봇·바닥 화살표(반지름 FIT)가 다 들어오는 거리 — 좁고 긴 칸이면 멀리
  const half = Math.min(17.5, (Math.atan(Math.tan((17.5 * Math.PI) / 180) * (w / h)) * 180) / Math.PI);
  const ce = Math.cos(view.el), eye0 = new THREE.Vector3(ce * Math.sin(view.az), Math.sin(view.el), ce * Math.cos(view.az));
  r.cam.aspect = w / h; r.cam.position.copy(eye0).multiplyScalar((view.zoom * FIT) / Math.sin((half * Math.PI) / 180)).add(AIM); r.cam.lookAt(AIM);
  r.cam.updateMatrixWorld(); r.cam.updateProjectionMatrix(); r.scene.updateMatrixWorld(true);   // 카메라는 장면 밖 — 직접 갱신해야 첫 그림부터 글자 자리가 맞음
  const px = (o: THREE.Object3D): Tag => {
    const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).project(r.cam);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, side: 0, z: p.z };
  };
  const mid = px(r.body).x, eye = r.cam.position, xy = (o: THREE.Object3D) => { const p = px(o); return [p.x, p.y] as const; };
  const joints = r.legs.flatMap((l) => ([[l.hip, new THREE.Vector3(1, 0, 0)], [l.thigh, new THREE.Vector3(0, 1, 0)], [l.calf, new THREE.Vector3(0, 1, 0)]] as const).map(([j, ax], k) => {
    const t = px(j), at = new THREE.Vector3().setFromMatrixPosition(j.matrixWorld);
    const toward = ax.clone().transformDirection(j.matrixWorld).dot(eye.clone().sub(at)) > 0 ? 1 : -1;
    return { ...t, side: t.x < mid ? -1 : 1, k, toward };
  }));
  // WebGL 이 없을 때 그릴 선 그림(SVG): 몸통 상자 모서리 8개 · 다리마다 엉덩이→허벅지→무릎→발 · 움직이는 방향 선
  const [bx, by, bz] = G.body.map((d) => d / 2), corner = new THREE.Vector3();
  const sketch = {
    body: [-1, 1].flatMap((sz) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const p = corner.set(sx * bx, sy * by, sz * bz).applyMatrix4(r.body.matrixWorld).project(r.cam);
      return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h] as const;
    })),
    legs: r.legs.map((l) => [l.hip, l.thigh, l.calf, l.foot].map(xy)),
    move: v ? [xy(r.move), xy(r.tip)] : null,
  };
  return { joints, sketch, move: v ? { ...px(r.tip), speed: Math.hypot(...v) } : null, turn: wz != null ? { ...px(r.end), wz } : null };
}

/** 그림 칸 — 3D(메시 또는 상자, WebGL 이 없으면 선 그림) + 관절 값·화살표 글자. 그림 안에 자리가 없는 관절 값은 그림 아래 줄. showJoints=false 면 관절 값 숨김.
 *  temps = 관절 온도 12개(JOINTS 순서, °C, 모르면 null) — 관절 자리 점을 온도 색으로(없으면 회색) + 범례. 점에 마우스·키보드 초점·누름 = «이름 온도 · 각도» 설명 */
export function Go2Figure({ pose, motion = NONE, showJoints = true, temps = null }: { pose: Pose; motion?: Motion; showJoints?: boolean; temps?: (number | null)[] | null }) {
  const box = useRef<HTMLDivElement>(null), gl = useRef<THREE.WebGLRenderer | null>(null);
  const [rig] = useState(() => { const r = makeRig(typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)); dress(r, null); return r; });
  const [tip, setTip] = useState(-1), [fail, setFail] = useState(false), [size, setSize] = useState({ w: 300, h: 260 }), [kind, setKind] = useState(rig.kind);
  const [view, setView] = useState(HOME), drag = useRef<{ x: number; y: number } | null>(null), moved = view !== HOME;
  // 탭 숨김·칸이 화면 밖이면 그리지 않는다(RV-437 2). 장면은 매 갱신 place 로 최신이라 다시 보일 때 한 번 그리면 최신
  const out = useRef(false), draw = () => { if (!out.current && !document.hidden) gl.current?.render(rig.scene, rig.cam); };
  useEffect(() => {   // 휠 = 확대/축소 — React 휠은 passive 라 페이지 스크롤을 못 막아 직접 단다
    const el = box.current!, wheel = (e: WheelEvent) => { e.preventDefault(); setView((v) => ({ ...v, zoom: clamp(v.zoom * Math.exp(e.deltaY * 0.001), ZOOM) })); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    const el = box.current!;
    let live = true;
    loadGo2().then((m) => { if (live && m) { dress(rig, m); setKind(rig.kind); } });
    const fit = () => { const w = el.clientWidth || 300, h = el.clientHeight || 260; setSize((s) => (s.w === w && s.h === h ? s : { w, h })); gl.current?.setSize(w, h, false); };
    try {
      if (typeof WebGLRenderingContext === 'undefined') throw 0;
      const g = new THREE.WebGLRenderer({ antialias: true, alpha: true }); g.setPixelRatio(window.devicePixelRatio || 1);
      el.prepend(g.domElement); g.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'; gl.current = g;
    } catch { setFail(true); }
    fit(); draw();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit); ro?.observe(el);
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((es) => { out.current = !es[es.length - 1].isIntersecting; draw(); });
    io?.observe(el); document.addEventListener('visibilitychange', draw);
    return () => {
      live = false; ro?.disconnect(); io?.disconnect(); document.removeEventListener('visibilitychange', draw);
      const g = gl.current; gl.current = null;
      free(rig); g?.dispose(); g?.forceContextLoss(); g?.domElement.remove();   // 이 그림이 만든 모양·재질·그리개를 모두 해제(RV-403 4)
    };
  }, [rig]);
  const at = useMemo(() => place(rig, pose, motion, size.w, size.h, view), [rig, pose?.q.join(), pose?.wxyz.join(), motion.dq?.join(), motion.v?.join(), motion.wz, size, kind, view]);
  useLayoutEffect(draw);
  const q = pose?.q;
  // 관절 값 글자: 각도 + 도는 중이면 방향·각속도. 글자 폭은 10px 숫자 기준 어림(겹침 피하기용) — 글자 칸은 이 폭으로 잘린다(그림 밖으로 안 나감)
  const tags = useMemo(() => {
    // 몸 화살표 글자를 먼저(화살표 끝 자리, 칸 안쪽으로), 관절 값은 그 둘을 피해서
    const arrows = [at.move && { name: 'move', text: `${fix(at.move.speed, 1)} m/s`, ...at.move },
      at.turn && { name: at.turn.wz > 0 ? 'left' : 'right', text: `${at.turn.wz > 0 ? '↺' : '↻'} ${fix(Math.abs(at.turn.wz), 2)} rad/s`, ...at.turn }]
      .filter((x) => !!x).map((x) => ({ ...x, dir: '', rate: 0, side: x.x < size.w / 2 ? 1 : -1, h: 16, w: 8 + 7 * x.text.length, pin: true }));
    const t = (showJoints && q ? at.joints : []).map((j, i) => {
      const dq = motion.dq?.[i], dir = dq != null && Math.abs(dq) >= JOINT_MIN ? (dq * j.toward > 0 ? 'ccw' : 'cw') : '';
      const text = `${deg(q![i])}°`, rate = dir ? Math.abs(deg(dq!)) : 0;
      return { name: JOINTS[i], text, dir, rate, x: j.x, y: j.y, side: j.side, h: 14, w: 6 + 6 * text.length + (dir ? 16 + 6 * `${rate}°/s`.length : 0) };
    });
    const all = [...arrows, ...t], b = spread(all, size.w, size.h, [...(q ? [{ x: size.w - LEGEND.w - LEGEND.pad, y: size.h - LEGEND.h - LEGEND.pad, w: LEGEND.w, h: LEGEND.h }] : []), ...(moved ? [RESET] : [])]);
    return all.map((x, i) => ({ ...x, b: b[i] }));
  }, [at, q?.join(), motion.dq?.join(), size, showJoints, moved]);
  const val = (t: (typeof tags)[number], b?: Box) => <span className="pd-tag" data-go2-joint={t.name} data-moving={t.dir || undefined} style={b && { left: b.x, top: b.y, width: b.w }}>
    {t.text}{t.dir && <i>{t.dir === 'ccw' ? '↺' : '↻'} {t.rate}°/s</i>}</span>;
  const spill = tags.filter((t) => !t.b);
  const cOf = (i: number) => temps?.[i], tipText = (i: number) => `${jointName(JOINTS[i])} ${cOf(i) != null ? `${Math.round(cOf(i)!)}°C` : '온도 모름'}${q ? ` · ${deg(q[i])}°` : ''}`;
  // 겹친 점은 카메라에 가까운 것이 위(그리기·마우스 판정 모두 — RV-437 1): z-index = 2 + 더 먼 점 수. 점 묶음은 z 2 한 겹(글자 1 위, «처음 보기» 3 아래 그대로), 말풍선(4)은 묶음 밖
  const near = at.joints.map((j) => 2 + at.joints.filter((o) => o.z > j.z).length);
  const tj = tip >= 0 ? at.joints[tip] : null, tipEl = useRef<HTMLSpanElement>(null), [cover, setCover] = useState<Box | null>(null);
  // 말풍선이 덮는 자리(그림 칸 기준 px) — 그 밑 관절 값 글자와 이 관절 글자(말풍선에 각도가 있음)는 숨겨 말풍선만 보이게
  useLayoutEffect(() => {
    const e = tipEl.current, v = box.current;
    if (!e || !v) { setCover(null); return; }
    const a = e.getBoundingClientRect(), o = v.getBoundingClientRect();
    setCover({ x: a.left - o.left, y: a.top - o.top, w: a.width, h: a.height });
  }, [tip, at]);
  const under = (b: Box) => !!cover && b.x < cover.x + cover.w && cover.x < b.x + b.w && b.y < cover.y + cover.h && cover.y < b.y + b.h;
  const end = () => { drag.current = null; };
  const k = at.sketch, line = (p: readonly (readonly [number, number])[]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return <div className="pd-go2" data-go2-model={kind}>
    {/* 끌기 = 돌려 보기 · 휠 = 확대 · 두 번 누름 = 처음 보기. 눌러도 초점을 옮기지 않는다(mousedown 기본 막음 — 조종 키 입력 그대로, serverdrive 11-11 과 같은 이유). 그림만 — 명령 0 */}
    <div ref={box} className="pd-go2-view" role="img" aria-label={pose ? 'Go2 — 로봇이 보낸 관절·자세 (끌어서 돌려 보기)' : 'Go2 — 기본 자세(로봇 보고 없음)'}
      data-go2-orbit={moved ? 'moved' : 'home'} style={{ touchAction: 'none', cursor: 'grab' }}
      onMouseDown={(e) => e.preventDefault()} onDoubleClick={() => setView(HOME)}
      onPointerDown={(e) => { if (e.button) return; drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => {
        const d = drag.current; if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y; d.x = e.clientX; d.y = e.clientY;
        if (dx || dy) setView((v) => ({ ...v, az: v.az - dx * DRAG, el: clamp(v.el + dy * DRAG, EL) }));
      }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {fail && <svg className="pd-go2-sketch" data-go2-sketch viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
        {[[0, 1, 2, 3, 0], [4, 5, 6, 7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].map((e, i) => <polyline key={i} points={line(e.map((n) => k.body[n]))} fill="none" stroke={TONE.mid} strokeWidth={2} />)}
        <polygon points={line([4, 5, 6, 7].map((n) => k.body[n]))} fill={TONE.light} fillOpacity={0.25} />
        {k.legs.map((l, i) => <g key={i} data-go2-leg={JOINTS[i * 3].slice(0, 2)}>
          <polyline points={line(l)} fill="none" stroke={TONE.light} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={l[3][0]} cy={l[3][1]} r={4} fill={TONE.mid} /></g>)}
        {k.move && <polyline points={line(k.move)} fill="none" stroke={ARROW} strokeWidth={4} strokeLinecap="round" />}
      </svg>}
      {tags.map((t) => !t.b || (t.name === JOINTS[tip] || under(t.b)) && !(t.name in ARROW_TAG) ? null : t.name in ARROW_TAG
        ? <span key={t.name} className="pd-tag pd-tag-move" {...{ [ARROW_TAG[t.name][0]]: ARROW_TAG[t.name][1] }} style={{ left: t.b.x, top: t.b.y, width: t.b.w }}>{t.text}</span>
        : <Fragment key={t.name}>{val(t, t.b)}</Fragment>)}
    </div>
    {moved && <button type="button" className="btn" data-go2-home onMouseDown={(e) => e.preventDefault()} onClick={() => setView(HOME)}
      style={{ position: 'absolute', zIndex: 3, left: RESET.x, top: RESET.y, width: RESET.w, height: RESET.h, minHeight: 0, padding: 0, fontSize: 12 }}>처음 보기</button>}
    {(q || temps) && <div className="pd-go2-dots" role="group" aria-label="관절 온도" style={{ width: size.w, height: size.h, zIndex: 2 }}>
      {at.joints.map((j, i) => <button key={JOINTS[i]} type="button" className="pd-dot" data-go2-temp={JOINTS[i]} aria-label={tipText(i)} aria-describedby={tip === i ? 'pd-go2-tip' : undefined}
        style={{ left: j.x, top: j.y, zIndex: near[i], background: tempColor(cOf(i)) }}
        onMouseEnter={() => setTip(i)} onMouseLeave={() => setTip(-1)} onFocus={() => setTip(i)} onBlur={() => setTip(-1)} onClick={() => setTip(i)} />)}
      <span className="pd-legend" data-go2-legend style={{ width: LEGEND.w, height: LEGEND.h, right: LEGEND.pad, bottom: LEGEND.pad }}>
        {TEMP_MIN}°C<i style={{ background: `linear-gradient(90deg, ${RAMP.join(', ')})` }} />{TEMP_MAX}°C<i className="pd-legend-none" style={{ background: NO_TEMP }} title="온도 모름" /></span>
    </div>}
    {(q || temps) && tj && <span ref={tipEl} id="pd-go2-tip" className="pd-tip" role="tooltip" data-go2-tip style={{ left: Math.min(Math.max(tj.x, 70), size.w - 70), top: tj.y - 9 }}>{tipText(tip)}</span>}
    {fail && <p className="pd-go2-fail">간단한 그림(3D 를 못 그리는 브라우저)</p>}
    {spill.length > 0 && <ul className="pd-go2-more" aria-label="그림에 다 못 넣은 관절 값" data-go2-more>
      {spill.map((t) => <li key={t.name}><b>{jointName(t.name)}</b>{val(t)}</li>)}
    </ul>}
  </div>;
}

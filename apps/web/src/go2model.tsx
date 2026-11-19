// Go2 3D 그림(RB-GO2-REAL-RENDER 11-19): Unitree 공개 메시(public/go2/go2.glb — 출처·라이선스는 같은 폴더)를 공개 URDF 관절 원점·축대로 붙이고,
// 로봇이 보낸 관절각을 그대로 돌린다. 관절마다 각도(°), 도는 중이면 도는 방향 화살표 + 각속도(°/s), 몸이 움직이면 바닥에 방향 화살표 + m/s, 돌면 굽은 화살표 + rad/s.
// 메시를 못 받으면 상자·막대 그림, WebGL 이 없으면 글로 대신. 그림만 — 명령 0.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Go2RobotInfo } from '../../contracts/ts';

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
const PARTS = ['trunk', 'hip', 'thigh', 'thigh_mirror', 'calf'];

export type Pose = { q: number[]; wxyz: number[] } | null;
/** 움직임: 관절 각속도 12개(rad/s) · 몸 속도(몸 기준 앞 vx·왼쪽 vy, m/s) · 회전 wz(rad/s, 왼쪽 +). 모르면 null */
export type Motion = { dq: number[] | null; v: [number, number] | null; wz: number | null };
type Sample = { t: number; v: number[] };

/** 연속 보고 두 개(로봇이 받은 시각이 다른 것)의 차 ÷ 시간. 시간이 0 이하·1초 넘음이면 null(지어내지 않음) */
export function rate(a: Sample | undefined, b: Sample | undefined): number[] | null {
  const dt = a && b ? (b.t - a.t) / 1000 : 0;
  return a && b && dt > 0 && dt <= 1 ? b.v.map((x, i) => (x - a.v[i]) / dt) : null;
}
const yawOf = ([w, x, y, z]: number[]) => Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const push = (h: Sample[], at: string | undefined, v: number[] | undefined) => {
  const t = at ? Date.parse(at) : NaN;
  if (v && Number.isFinite(t) && h[h.length - 1]?.t !== t) { h.push({ t, v }); if (h.length > 2) h.shift(); }
};
const NONE: Motion = { dq: null, v: null, wz: null };

/** 보고가 바뀔 때마다 앞 보고와 비교해 움직임을 낸다. pose 가 null(보고 없음·오래됨)이면 이력을 비우고 null */
export function useGo2Motion(info: Go2RobotInfo | null | undefined, pose: Pose): Motion {
  const h = useRef({ j: [] as Sample[], p: [] as Sample[], y: [] as Sample[] }).current;
  if (!pose || !info) { h.j = []; h.p = []; h.y = []; return NONE; }
  push(h.j, info.joints?.received_at, pose.q);
  const xyz = info.position?.xyz;
  push(h.p, info.position?.received_at, xyz && xyz.length >= 2 && xyz.every(Number.isFinite) ? xyz.slice(0, 2) : undefined);
  push(h.y, info.quaternion?.received_at, [yawOf(pose.wxyz)]);
  const dy = h.y.length === 2 ? { ...h.y[1], v: [h.y[0].v[0] + wrap(h.y[1].v[0] - h.y[0].v[0])] } : undefined;
  const w = rate(h.p[0], h.p[1]), yaw = yawOf(pose.wxyz), c = Math.cos(yaw), s = Math.sin(yaw);
  return { dq: rate(h.j[0], h.j[1]), v: w ? [c * w[0] + s * w[1], -s * w[0] + c * w[1]] : null, wz: rate(h.y[0], dy)?.[0] ?? null };
}

/** go2.glb → «부품-색» 이름별 모양. 이름이 모자라면 오류 */
export async function parseGo2(buf: ArrayBuffer) {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const g = await new GLTFLoader().parseAsync(buf, '');
  const m = new Map<string, THREE.BufferGeometry>();
  g.scene.traverse((o) => { const x = o as THREE.Mesh; if (x.isMesh) { x.geometry.computeVertexNormals(); m.set(x.name, x.geometry); } });
  if (!PARTS.every((p) => [...m.keys()].some((k) => k.startsWith(`${p}-`)))) throw new Error('go2.glb 부품 모자람');
  return m;
}
let cache: Promise<Map<string, THREE.BufferGeometry> | null> | null = null;
/** 한 번만 받는다. 못 받으면 null(상자 그림). ponytail: 실패도 다시 열 때까지 기억 — 다시 시도는 필요하면 */
export function loadGo2(url = `${import.meta.env.BASE_URL}go2/go2.glb`) {
  return (cache ??= fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status))).then(parseGo2).catch(() => null));
}
export function resetGo2Cache() { cache = null; }

type Leg = { hip: THREE.Group; thigh: THREE.Group; calf: THREE.Group; v: THREE.Group[] };
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
    const v = [hip, thigh, calf].map((j) => { const g = new THREE.Group(); j.add(g); return g; });
    return { hip, thigh, calf, v };
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

const clear = (g: THREE.Group) => g.children.slice().forEach((c) => { g.remove(c); if (!(c as THREE.Mesh).userData.shared) (c as THREE.Mesh).geometry?.dispose(); });
/** 메시(없으면 상자·막대)를 관절 그룹에 붙인다. URDF visual 원점: 오른쪽 엉덩이는 x 축 180°, 뒤 엉덩이는 y 축 180°, 오른쪽 허벅지는 thigh_mirror */
function dress(r: Rig, m: Map<string, THREE.BufferGeometry> | null) {
  [r.trunk, ...r.legs.flatMap((l) => l.v)].forEach(clear);
  if (!m) {
    r.trunk.add(new THREE.Mesh(new THREE.BoxGeometry(...G.body), r.box.skin));
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.06), r.box.skin); head.position.x = G.body[0] / 2 + 0.02; r.trunk.add(head);
    const bar = (len: number) => { const b = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.032, len), r.box.leg); b.position.z = -len / 2; return b; };
    r.legs.forEach((l) => { l.v[1].add(bar(G.l1)); l.v[2].add(bar(G.l2)); const f = new THREE.Mesh(new THREE.SphereGeometry(0.022), r.box.leg); f.position.z = -G.l2; l.v[2].add(f); });
    r.kind = 'box'; return;
  }
  const put = (g: THREE.Group, part: string) => m.forEach((geo, k) => {
    const [p, t] = k.split('-');
    if (p === part) { const x = new THREE.Mesh(geo, r.tone[t] ?? r.tone.mid); x.userData.shared = true; g.add(x); }
  });
  put(r.trunk, 'trunk');
  ['FR', 'FL', 'RR', 'RL'].forEach((n, i) => {
    const [hv, tv, cv] = r.legs[i].v, right = n[1] === 'R';
    put(hv, 'hip'); hv.rotation.set(right ? Math.PI : 0, n[0] === 'R' ? Math.PI : 0, 0);
    put(tv, right ? 'thigh_mirror' : 'thigh'); put(cv, 'calf');
  });
  r.kind = 'mesh';
}

/** 몸 화살표 글자의 시험용 표시(data-go2-move · data-go2-turn=left|right) */
const ARROW_TAG: Record<string, [string, string]> = { move: ['data-go2-move', ''], left: ['data-go2-turn', 'left'], right: ['data-go2-turn', 'right'] };
const deg = (v: number) => Math.round((v * 180) / Math.PI);
const fix = (v: number, d: number) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
type Tag = { x: number; y: number; side: number };
type Box = { x: number; y: number; w: number; h: number };
/** 글자 상자를 겹치지 않게 놓는다(앞에서부터 차례로): 관절 바깥쪽 옆 → 위아래로 14 px 씩 → 반대쪽. 칸 밖·모두 겹치면 첫 자리 */
export function spread(tags: { x: number; y: number; side: number; w: number; h: number }[], W: number, H: number): Box[] {
  const done: Box[] = [], hit = (a: Box) => done.some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
  return tags.map((t) => {
    const at = (side: number, dy: number): Box => ({ x: side > 0 ? t.x + 5 : t.x - 5 - t.w, y: t.y - t.h / 2 + dy, w: t.w, h: t.h });
    const tries = [t.side, -t.side].flatMap((sd) => [0, -14, 14, -28, 28, -42, 42].map((dy) => at(sd || 1, dy)));
    const b = tries.find((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= W && c.y + c.h <= H && !hit(c)) ?? tries[0];
    done.push(b); return b;
  });
}
/** 자세를 놓고, 관절·화살표 끝을 화면 px 로. 관절 화살표 = 각속도 부호 × (돌림축이 카메라 쪽이면 +) — 오른손 법칙대로 + 는 보는 사람에게 반시계(↺) */
function place(r: Rig, pose: Pose, mo: Motion, w: number, h: number) {
  const q = pose?.q ?? STAND, [qw, qx, qy, qz] = pose?.wxyz ?? [1, 0, 0, 0];
  r.legs.forEach((l, i) => { l.hip.rotation.x = q[i * 3]; l.thigh.rotation.y = q[i * 3 + 1]; l.calf.rotation.y = q[i * 3 + 2]; });
  // 몸은 기울기(앞뒤·옆)만 — 방향(yaw)은 빼서 늘 같은 쪽에서 본다(회전은 굽은 화살표로)
  const full = new THREE.Quaternion(qx, qy, qz, qw), yaw = yawOf([qw, qx, qy, qz]);
  r.body.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -yaw).multiply(full);
  const v = mo.v && Math.hypot(...mo.v) >= MOVE_MIN ? mo.v : null, wz = mo.wz != null && Math.abs(mo.wz) >= TURN_MIN ? mo.wz : null;
  r.move.visible = !!v; if (v) r.move.rotation.z = Math.atan2(v[1], v[0]);
  r.turn.visible = wz != null; r.turn.scale.y = wz != null && wz < 0 ? -1 : 1;
  // 칸 모양에 맞춰 로봇·바닥 화살표(반지름 FIT)가 다 들어오는 거리 — 좁고 긴 칸이면 멀리
  const half = Math.min(17.5, (Math.atan(Math.tan((17.5 * Math.PI) / 180) * (w / h)) * 180) / Math.PI);
  r.cam.aspect = w / h; r.cam.position.copy(VIEW).multiplyScalar(FIT / Math.sin((half * Math.PI) / 180)).add(AIM); r.cam.lookAt(AIM);
  r.cam.updateProjectionMatrix(); r.scene.updateMatrixWorld(true);
  const px = (o: THREE.Object3D): Tag => {
    const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).project(r.cam);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, side: 0 };
  };
  const mid = px(r.body).x, eye = r.cam.position;
  const joints = r.legs.flatMap((l) => ([[l.hip, new THREE.Vector3(1, 0, 0)], [l.thigh, new THREE.Vector3(0, 1, 0)], [l.calf, new THREE.Vector3(0, 1, 0)]] as const).map(([j, ax], k) => {
    const t = px(j), at = new THREE.Vector3().setFromMatrixPosition(j.matrixWorld);
    const toward = ax.clone().transformDirection(j.matrixWorld).dot(eye.clone().sub(at)) > 0 ? 1 : -1;
    return { ...t, side: t.x < mid ? -1 : 1, k, toward };
  }));
  return { joints, move: v ? { ...px(r.tip), speed: Math.hypot(...v) } : null, turn: wz != null ? { ...px(r.end), wz } : null };
}

/** 그림 칸 — 3D(메시 또는 상자) + 관절 값·화살표 글자. showJoints=false 면 관절 값 숨김 */
export function Go2Figure({ pose, motion = NONE, showJoints = true }: { pose: Pose; motion?: Motion; showJoints?: boolean }) {
  const box = useRef<HTMLDivElement>(null), gl = useRef<THREE.WebGLRenderer | null>(null);
  const [rig] = useState(() => { const r = makeRig(typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)); dress(r, null); return r; });
  const [fail, setFail] = useState(false), [size, setSize] = useState({ w: 300, h: 260 }), [kind, setKind] = useState(rig.kind);
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
    fit();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit); ro?.observe(el);
    return () => {
      live = false; ro?.disconnect(); gl.current?.dispose(); gl.current?.domElement.remove(); gl.current = null;
      rig.scene.traverse((o) => { const m = o as THREE.Mesh; if (!m.userData.shared) m.geometry?.dispose?.(); });
    };
  }, [rig]);
  const at = useMemo(() => place(rig, pose, motion, size.w, size.h), [rig, pose?.q.join(), pose?.wxyz.join(), motion.dq?.join(), motion.v?.join(), motion.wz, size, kind]);
  useLayoutEffect(() => { gl.current?.render(rig.scene, rig.cam); });
  const q = pose?.q;
  // 관절 값 글자: 각도 + 도는 중이면 방향·각속도. 글자 폭은 10px 숫자 기준 어림(겹침 피하기용)
  const tags = useMemo(() => {
    // 몸 화살표 글자를 먼저(화살표 끝 자리, 칸 안쪽으로), 관절 값은 그 둘을 피해서
    const arrows = [at.move && { name: 'move', text: `${fix(at.move.speed, 1)} m/s`, ...at.move },
      at.turn && { name: at.turn.wz > 0 ? 'left' : 'right', text: `${at.turn.wz > 0 ? '↺' : '↻'} ${fix(Math.abs(at.turn.wz), 2)} rad/s`, ...at.turn }]
      .filter((x) => !!x).map((x) => ({ ...x, dir: '', rate: 0, side: x.x < size.w / 2 ? 1 : -1, h: 16, w: 8 + 7 * x.text.length }));
    const t = (showJoints && q ? at.joints : []).map((j, i) => {
      const dq = motion.dq?.[i], dir = dq != null && Math.abs(dq) >= JOINT_MIN ? (dq * j.toward > 0 ? 'ccw' : 'cw') : '';
      const text = `${deg(q![i])}°`, rate = dir ? Math.abs(deg(dq!)) : 0;
      return { name: JOINTS[i], text, dir, rate, x: j.x, y: j.y, side: j.side, h: 14, w: 6 + 6 * text.length + (dir ? 16 + 6 * `${rate}°/s`.length : 0) };
    });
    const all = [...arrows, ...t], b = spread(all, size.w, size.h);
    return all.map((x, i) => ({ ...x, b: b[i] }));
  }, [at, q?.join(), motion.dq?.join(), size, showJoints]);
  return <div ref={box} className="pd-go2" role="img" data-go2-model={kind} aria-label={pose ? 'Go2 — 로봇이 보낸 관절·자세' : 'Go2 — 기본 자세(로봇 보고 없음)'}>
    {fail && <span className="pd-go2-fail">이 브라우저는 3D 그림을 그릴 수 없습니다</span>}
    {tags.map((t) => t.name in ARROW_TAG
      ? <span key={t.name} className="pd-tag pd-tag-move" {...{ [ARROW_TAG[t.name][0]]: ARROW_TAG[t.name][1] }} style={{ left: t.b.x, top: t.b.y }}>{t.text}</span>
      : <span key={t.name} className="pd-tag" data-go2-joint={t.name} data-moving={t.dir || undefined} style={{ left: t.b.x, top: t.b.y }}>
        {t.text}{t.dir && <i>{t.dir === 'ccw' ? '↺' : '↻'} {t.rate}°/s</i>}</span>)}
  </div>;
}

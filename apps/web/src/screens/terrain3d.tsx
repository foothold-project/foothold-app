// 지형 만들기 3D 화면(TERRAIN-3D, terrain.tsx 의 [위에서 | 3D] 중 3D). 동적 import 로만 불려 three 는 따로 묶인다.
// 상태·검사·저장은 terrain.tsx 가 그대로 갖고, 여기는 그 spec 을 그리고 끌기·돌리기·높이를 같은 setter 로 올린다.
// 좌표 = 약속 fh_custom_terrain/1 그대로(z 위, 원점 바닥 가운데, yaw 반시계). 모양 = buildTerrain 과 같은 규칙(상자·계단+1 m 층계참·쐐기 경사·바닥 구멍 틈·5 cm 턱).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CLEARANCE, type TerrainItem as Item, type TerrainSpec as Spec } from '../../../../mobile/sim/terrain/index.js';
import './terrain3d.css';

type What = number | 'spawn';
export type Props = {
  spec: Spec; sel: What | null; tool: string; state: ('bad' | 'warn' | undefined)[];
  onSel: (w: What | null) => void; onPose: (w: What, patch: Record<string, number>) => void;
  /** 빈 바닥 누름 = 2D 판 누름과 같음(놓기 도구면 놓고, 고르기면 고른 것 풀기) */
  onFloor: (x: number, y: number) => void; onKeyDown: (e: KeyboardEvent) => void;
};

const LANDING = 1;
const snap = (v: number, by = 0.05) => +(Math.round(v / by) * by).toFixed(2);
const clamp = (v: number, a: number) => Math.max(-a, Math.min(a, v));
const deg = (rad: number) => (rad * 180) / Math.PI;
const toRad = (d: number) => +((d * Math.PI) / 180).toFixed(4);
export const foot = (it: Item): [number, number] =>
  it.kind === 'box' ? [it.sx, it.sy] : it.kind === 'stairs' ? [it.steps * it.run + LANDING, it.width] : [it.length, it.width];
export const topOf = (it: Item) => (it.kind === 'box' || it.kind === 'ramp' ? it.h : it.kind === 'stairs' ? it.steps * it.rise : 0);
const poseOf = (s: Spec, w: What) => (w === 'spawn' ? { x: s.spawn[0], y: s.spawn[1], yaw: s.spawn[2] } : s.items[w]);

/** 바닥에서 끈 점 + 처음 잡은 어긋남 → 새 x·y(2D 판과 같은 5 cm 맞춤·바닥 안 가두기) */
export const dragTo = (hit: [number, number], off: [number, number], size: [number, number]) =>
  ({ x: snap(clamp(hit[0] + off[0], size[0] / 2)), y: snap(clamp(hit[1] + off[1], size[1] / 2)) });
/** 고리로 돌린 각 → yaw(2D 손잡이와 같은 5° 맞춤, −180~180°) */
export const yawOf = (rad: number) => { const d = Math.round(deg(Math.atan2(Math.sin(rad), Math.cos(rad))) / 5) * 5; return toRad(d === -180 ? 180 : d); };
/** R 키: 15° 씩(Shift = 반대) */
export const turn = (yaw: number, back = false) => yawOf(yaw + toRad(back ? -15 : 15));
/** 높이 손잡이 z → 크기 고침. 상자·경사 = h(5 cm), 계단 = 단 높이(1 cm, 끝 높이 = 단 수 × 단 높이), 틈 = 없음. 범위 밖은 validate 가 알린다 */
export function liftTo(it: Item, z: number): Record<string, number> | null {
  if (it.kind === 'box' || it.kind === 'ramp') return { h: Math.max(0.05, snap(z)) };
  if (it.kind === 'stairs' && it.steps >= 1) return { rise: Math.max(0.01, snap(z / it.steps, 0.01)) };
  return null;
}

const pos = (v: number) => Math.max(v, 0.01);   // 칸에 0·음수를 쳐도 그리기가 깨지지 않게(판정은 validate)
const boxAt = (a: number, b: number, h: number, x = 0) => new THREE.BoxGeometry(pos(a), pos(b), pos(h)).translate(x, 0, pos(h) / 2);
/** 물체 모양(몸 기준, 위치·방향은 바깥 그룹). buildTerrain 과 같은 덩어리 */
export function shapeOf(it: Item): THREE.BufferGeometry[] {
  if (it.kind === 'box') return [boxAt(it.sx, it.sy, it.h)];
  if (it.kind === 'stairs') {
    const n = Math.max(0, Math.min(Math.floor(it.steps), 200)), L = n * it.run + LANDING;
    return [...Array.from({ length: n }, (_, k) => boxAt(it.run, it.width, (k + 1) * it.rise, -L / 2 + (k + 0.5) * it.run)), boxAt(LANDING, it.width, n * it.rise, L / 2 - LANDING / 2)];
  }
  if (it.kind === 'ramp') {   // 몸 기준 +x 쪽이 높은 쐐기: xz 삼각형을 폭만큼 민다
    const a = pos(it.length) / 2, w = pos(it.width);
    return [new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-a, 0), new THREE.Vector2(a, 0), new THREE.Vector2(a, pos(it.h))]), { depth: w, bevelEnabled: false })
      .rotateX(Math.PI / 2).translate(0, w / 2, 0)];
  }
  return [new THREE.BoxGeometry(pos(it.length), pos(it.width), 0.5).translate(0, 0, -0.25)];   // 틈: 바닥 구멍 속(−0.5~0 m)을 고를 수 있게 채운 어두운 덩어리
}
const corners = (it: Item) => {
  const [L, W] = foot(it), c = Math.cos(it.yaw), s = Math.sin(it.yaw);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => new THREE.Vector2(it.x + c * u * L / 2 - s * v * W / 2, it.y + s * u * L / 2 + c * v * W / 2));
};
/** 바닥판(−0.5~0 m)에 틈 구멍. ponytail: 겹친 틈은 삼각분할이 어긋날 수 있음 — 겹침 검사가 약속에 생기면 합쳐서 뚫기 */
function floorOf([W, H]: [number, number], gaps: Item[]) {
  const s = new THREE.Shape([new THREE.Vector2(-W / 2, -H / 2), new THREE.Vector2(W / 2, -H / 2), new THREE.Vector2(W / 2, H / 2), new THREE.Vector2(-W / 2, H / 2)]);
  gaps.forEach((g) => s.holes.push(new THREE.Path(corners(g))));
  return new THREE.ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: false }).translate(0, 0, -0.5);
}

/** 색 = 화면 토큰(밝음·어두움을 따라감). 토큰이 color-mix 등 three 가 못 읽는 값이면 기본색 */
function palette(el: Element) {
  const cs = getComputedStyle(el), c = (name: string, fb: string) => {
    const v = cs.getPropertyValue(name).trim(), col = new THREE.Color(fb);
    if (/^(#[0-9a-f]{3,8}|rgba?\()/i.test(v)) col.setStyle(v);
    return col;
  };
  const panel = c('--panel', '#181d26'), accent = c('--accent', '#3ec7b4'), warn = c('--warn', '#d9a441');
  return { bg: c('--bg', '#12161d'), panel, base: c('--panel2', '#1f2530'), line: c('--line', '#2b3240'), text: c('--text', '#e9e7e1'), accent,
    bad: c('--bad', '#e56d5e'), warn, solid: accent.clone().lerp(panel, 0.45), ramp: accent.clone().lerp(panel, 0.65), hole: new THREE.Color('#0b0d10') };
}
type Pal = ReturnType<typeof palette>;

function dispose(o: THREE.Object3D) {
  o.traverse((x) => { const m = x as THREE.Mesh; m.geometry?.dispose(); (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach((t) => t.dispose()); });
}
/** 지형 전체 그림. 물체 덩어리는 userData.what 으로 고르기·끌기에 쓴다 */
function world(spec: Spec, sel: What | null, state: Props['state'], p: Pal) {
  const g = new THREE.Group(), [W, H] = spec.size;
  const lam = (color: THREE.Color, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = g, edge?: THREE.Color) => {
    const m = new THREE.Mesh(geo, mat);
    parent.add(m);
    if (edge) parent.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: edge })));
    return m;
  };
  add(new THREE.BoxGeometry(W, H, 0.1).translate(0, 0, -0.55), lam(p.base));
  add(floorOf([W, H], spec.items.filter((it, i) => it.kind === 'gap' && state[i] !== 'bad')), lam(p.panel), g, p.line);
  const grid = new THREE.GridHelper(Math.max(W, H), Math.max(W, H), p.line, p.line);   // 1 m 칸
  grid.rotation.x = Math.PI / 2; grid.position.z = 0.002;
  (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.5;
  if (W <= 30 && H <= 30) g.add(grid);
  const e = 0.05;   // buildTerrain 의 바깥 턱(5 cm × 20 cm)
  for (const [x, y, a, b] of [[0, -H / 2 + e / 2, W, e], [0, H / 2 - e / 2, W, e], [-W / 2 + e / 2, 0, e, H - 2 * e], [W / 2 - e / 2, 0, e, H - 2 * e]]) add(boxAt(a, b, 0.2).translate(x, y, 0), lam(p.line));
  spec.items.forEach((it, i) => {
    const o = new THREE.Group(), st = state[i], on = sel === i;
    o.position.set(it.x, it.y, 0); o.rotation.z = it.yaw;
    const base = it.kind === 'gap' ? p.hole : it.kind === 'ramp' ? p.ramp : p.solid;
    const color = st === 'bad' ? p.bad : st === 'warn' ? base.clone().lerp(p.warn, 0.5) : base;
    for (const geo of shapeOf(it)) add(geo, lam(color, { emissive: on ? p.accent : 0x000000, emissiveIntensity: on ? 0.35 : 0, transparent: it.kind === 'gap', opacity: 0.85 }), o, on ? p.accent : st === 'bad' ? p.bad : p.text.clone().lerp(color, 0.6)).userData.what = i;
    g.add(o);
  });
  const s = new THREE.Group(), on = sel === 'spawn';
  s.position.set(spec.spawn[0], spec.spawn[1], 0); s.rotation.z = spec.spawn[2];
  const mark = lam(p.accent, { emissive: on ? p.text : 0x000000, emissiveIntensity: on ? 0.3 : 0 });
  add(new THREE.CylinderGeometry(0.14, 0.14, 0.08, 24).rotateX(Math.PI / 2).translate(0, 0, 0.04), mark, s).userData.what = 'spawn';
  add(new THREE.BoxGeometry(0.32, 0.06, 0.04).translate(0.3, 0, 0.04), mark, s).userData.what = 'spawn';
  add(new THREE.RingGeometry(CLEARANCE - 0.02, CLEARANCE, 48).translate(0, 0, 0.006), new THREE.MeshBasicMaterial({ color: p.accent, transparent: true, opacity: 0.6 }), s);
  g.add(s);
  if (sel != null && (sel === 'spawn' || spec.items[sel])) {   // 돌림 손잡이(2D 판의 둥근 손잡이와 같음): 끌면 가운데 → 바닥 위 점 방향이 yaw
    const o = poseOf(spec, sel), len = sel === 'spawn' ? 0.75 : pos(foot(spec.items[sel])[0]) / 2 + 0.45, k = new THREE.Group(), m = new THREE.MeshBasicMaterial({ color: p.accent });
    k.position.set(o.x, o.y, 0); k.rotation.z = o.yaw;
    add(new THREE.BoxGeometry(len, 0.03, 0.03).translate(len / 2, 0, 0.15), m, k);
    add(new THREE.SphereGeometry(0.13, 20, 12).translate(len, 0, 0.15), m, k).userData = { what: sel, turn: true };
    g.add(k);
  }
  return g;
}

type Rig = {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; orbit: OrbitControls;
  lift: TransformControls; liftAt: THREE.Object3D; world: THREE.Group | null; draw: () => void; view: (top: boolean) => void;
};

export default function Terrain3D(props: Props) {
  const host = useRef<HTMLDivElement>(null), rig = useRef<Rig | null>(null), live = useRef(props);
  live.current = props;
  const [failed, setFailed] = useState(false), [theme, setTheme] = useState(0);

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch { setFailed(true); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    el.prepend(canvas);
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
    cam.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-4, -6, 10); scene.add(sun);

    // 물체 끌기 — 궤도 카메라보다 먼저 듣는다(물체를 잡은 누름은 카메라를 돌리지 않게)
    const ray = new THREE.Raycaster(), floor = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const aim = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam); };
    const onFloor = (e: PointerEvent): [number, number] | null => { aim(e); const v = ray.ray.intersectPlane(floor, new THREE.Vector3()); return v ? [v.x, v.y] : null; };
    let drag: { what: What; turn: boolean; off: [number, number]; cx: number; cy: number; live: boolean } | null = null, press: { cx: number; cy: number } | null = null;
    const down = (e: PointerEvent) => {
      press = null;
      if (e.button !== 0 || lift.axis) return;   // 높이 화살 누름은 TransformControls 몫
      const p = live.current, at = onFloor(e);
      el.focus({ preventScroll: true });
      if (p.tool !== 'select') { if (at) p.onFloor(at[0], at[1]); orbit.enabled = false; return; }   // 놓기 도구면 물체 위에도 놓는다(2D 와 같음)
      const hit = ray.intersectObjects(r.world?.children ?? [], true).find((h) => h.object.userData.what !== undefined);
      if (!hit || !at) { press = { cx: e.clientX, cy: e.clientY }; return; }
      const what = hit.object.userData.what as What, o = poseOf(p.spec, what);
      p.onSel(what);
      drag = { what, turn: !!hit.object.userData.turn, off: [o.x - at[0], o.y - at[1]], cx: e.clientX, cy: e.clientY, live: false };
      orbit.enabled = false;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* 이미 끝난 누름 — 캡처 없이도 끌린다 */ }
    };
    const move = (e: PointerEvent) => {
      if (!drag || (!drag.live && !drag.turn && Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) < 3)) return;   // 고르려는 누름에 흔들려 옮겨지지 않게
      drag.live = true;
      const at = onFloor(e), p = live.current, o = poseOf(p.spec, drag.what);
      if (at) p.onPose(drag.what, drag.turn ? { yaw: yawOf(Math.atan2(at[1] - o.y, at[0] - o.x)) } : dragTo(at, drag.off, p.spec.size));
    };
    const up = (e: PointerEvent) => {
      if (press && Math.hypot(e.clientX - press.cx, e.clientY - press.cy) < 3) { const at = onFloor(e); if (at) live.current.onFloor(at[0], at[1]); }   // 빈 곳 누름(카메라 끌기 아님) = 고른 것 풀기
      drag = null; press = null;
      if (!lift.dragging) orbit.enabled = true;
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    const orbit = new OrbitControls(cam, canvas);
    orbit.maxPolarAngle = Math.PI / 2 - 0.05;   // 바닥 밑으로 내려가지 않게
    orbit.maxDistance = 120;
    // 높이 화살 = TransformControls 위아래 한 축. (돌리기는 TransformControls 고리를 쓰지 않는다 — 위에서 볼 때 축이 시선과 겹쳐 각이 튄다)
    const lift = new TransformControls(cam, canvas), liftAt = new THREE.Object3D();
    lift.setMode('translate'); lift.setSize(0.7); lift.showX = false; lift.showY = false;
    lift.addEventListener('dragging-changed', (ev) => { orbit.enabled = !ev.value; });
    scene.add(lift.getHelper(), liftAt);
    lift.addEventListener('objectChange', () => {
      const p = live.current, it = typeof p.sel === 'number' ? p.spec.items[p.sel] : null, patch = it && liftTo(it, liftAt.position.z);
      if (patch && typeof p.sel === 'number') p.onPose(p.sel, patch);
    });
    const draw = () => renderer.render(scene, cam);
    const view = (top: boolean) => {
      const d = Math.max(...live.current.spec.size) * 1.25;
      if (top) cam.position.set(0, -0.001, d * 1.05); else cam.position.set(0, -d * 0.85, d * 0.7);
      orbit.target.set(0, 0, 0); orbit.update(); draw();
    };
    orbit.addEventListener('change', draw); lift.addEventListener('change', draw);
    const r: Rig = rig.current = { renderer, scene, cam, orbit, lift, liftAt, world: null, draw, view };
    const fit = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); draw();
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    ro?.observe(el);
    const mo = new MutationObserver(() => setTheme((n) => n + 1));   // 화면 밝기를 바꾸면 토큰 색을 다시 읽는다
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    view(false); fit();
    return () => {
      ro?.disconnect(); mo.disconnect();
      lift.detach(); lift.dispose();
      orbit.dispose();
      if (r.world) dispose(r.world);
      renderer.dispose(); canvas.remove();
      rig.current = null;
    };
  }, []);

  // spec·고른 것·검사가 바뀔 때마다 다시 그린다(물체 60개 이하 — 통째로 새로 만들어도 가볍다)
  const { spec, sel, state } = props;
  useEffect(() => {
    const r = rig.current;
    if (!r) return;
    const p = palette(host.current!);
    r.scene.background = p.bg;
    if (r.world) { r.scene.remove(r.world); dispose(r.world); }
    r.world = world(spec, sel, state, p);
    r.scene.add(r.world);
    // 높이 화살 = 윗면 높이, 몸통 밖 옆(높은 쪽 끝 +y 30 cm) — 가운데면 몸통 끌기를, +x 면 돌림 손잡이를 가로챈다.
    // 끄는 중에도 맞춘 값으로 다시 놓는다(TransformControls 는 누른 때 기준으로 계산)
    const it = typeof sel === 'number' ? spec.items[sel] : null;
    if (it && it.kind !== 'gap') {
      const [L, W] = foot(it), u = pos(L) / 2, v = pos(W) / 2 + 0.3, c = Math.cos(it.yaw), s = Math.sin(it.yaw);
      r.liftAt.position.set(it.x + c * u - s * v, it.y + s * u + c * v, topOf(it)); r.lift.attach(r.liftAt);
    } else r.lift.detach();
    r.draw();
  }, [spec, sel, state.join(), theme]);   // eslint-disable-line react-hooks/exhaustive-deps

  const key = (e: KeyboardEvent) => {
    const p = live.current;
    if ((e.key === 'r' || e.key === 'R') && p.sel != null && !e.ctrlKey && !e.metaKey) { e.preventDefault(); p.onPose(p.sel, { yaw: turn(poseOf(p.spec, p.sel).yaw, e.shiftKey) }); }
    else p.onKeyDown(e);
  };
  return <div ref={host} className="tr-3d" data-tool={props.tool} tabIndex={0} role="application" onKeyDown={key} data-terrain-3d
    aria-label={`${spec.name} 3D 보기 — 끌어 돌리기, 오른쪽 끌기 이동, 휠 확대 · 물체를 끌어 옮기고 둥근 손잡이로 돌리고 화살로 높이를 바꿉니다 · R 15° 돌리기`}>
    {failed ? <p className="lv-note tr-pad" role="alert" data-terrain-3d-failed>이 브라우저에서 3D 화면을 그릴 수 없습니다(WebGL 없음). «위에서»로 고쳐 주세요.</p>
      : <div className="tr-3d-views" role="group" aria-label="3D 시점">
        <button type="button" className="btn" data-terrain-3d-view="top" onClick={() => rig.current?.view(true)}>위에서 보기</button>
        <button type="button" className="btn" data-terrain-3d-view="tilt" onClick={() => rig.current?.view(false)}>비스듬히</button>
      </div>}
  </div>;
}

// 관제 지도 보기(시안 u5_3): 시안 shared/site3d.js mountSite 를 옮김. 현장 · 빛 · 땅 · 격자 · 카메라 · 표지 배치 값 그대로.
// 로봇은 서버 위치가 온 것만 그 자리 · 방향에 둔다(시안의 정해 둔 경로 · 겹치는 곳은 서버에 없어 그리지 않음).
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STATUS_NAME } from '../fake';
import { rt } from '../rt';
import { TEX_LOOK, K, OX, OY, SITE_PX_H, SITE_PX_W, applyRest, applyWalk, lightNow, loadGo2, loadSite, loadWalk, ringLine, sitePose, toWorld, toneSite, type Body, type Walk } from './site';
import { follow, robotLight, type Held } from './tileview';
import { IC, ic, type TileFacts } from './u5';
import { pickPress } from '../screens/control';

const ST_COL = { walk: 0x00c389, link: 0xf2b705, rest: 0x4c9bff, bad: 0xff4d4f, idle: 0xa9b8c6 } as const;
/** 지도 보기 로봇 모형 배율(시안 data-site scale 20 → 12 · 팀장 02:03 «모형이 큼» · 점 · 줄기와 어울리게). 고리 · 빛 웅덩이도 이 배율 */
export const MAP_GO2_S = 12;
const S = MAP_GO2_S, STEM = 16;
/** 이름표를 겹침 피하려 위로 밀 수 있는 최대(px). 넘으면 겹침을 받아들임 */
export const LIFT_MAX = 44;
// 시뮬 로봇은 시안 K-08 처럼 늘 파란 꼴(상자 아이콘 · 점선 이름표 · 파란 고리). 시뮬 경고는 타일 · 오른쪽 줄에 남음
const tone = (f: TileFacts): keyof typeof ST_COL => (f.sim ? 'rest' : f.level === 'bad' || f.level === 'crit' ? 'bad' : f.lostNow ? 'link' : f.walk ? 'walk' : 'idle');
const poseOf = (f: TileFacts) => sitePose((f.x.unknown === 'summary' ? null : rt.get(f.x.id).state?.location) ?? (f.x.unknown === 'summary' ? null : f.x.location));

type R = { id: string; g: THREE.Group; body: Body; ring: THREE.Line; col: number; sim: boolean; top: number; t: number; at?: Held | null };

/** 지도 보기 첫 시점(팀장 00:22 · 시안 밖): 원근 · 정북을 보고(옆 틂 0) · 아래로 SITE_EL. 로봇 무리 둘레 상자 가운데가 화면 가로 가운데 · 세로 SITE_Y,
 *  화면 폭 = 무리 폭 × SITE_SPAN(SITE_MIN_W ~ 현장 폭 × SITE_MAX_K: 무리가 넓게 퍼져도 공장이 화면 가로를 채우고 위 하늘이 좁게). 로봇이 없거나 한 대면 현장 가운데 · 화면 폭 = 현장 폭.
 *  작은 지도 더블클릭 + 고른 로봇 = 첫 시점에서 그 로봇 가운데 가까운 시점(NEAR_D)으로 FLY_S 초 ease-in-out. 움직임 줄이기면 바로 끝 시점 */
export const SITE_FOV = 32, SITE_EL = 42, SITE_Y = 0.57, SITE_SPAN = 2.5, SITE_MIN_W = 160, SITE_MAX_K = 0.65, NEAR_D = 210, FLY_S = 1.0;   // NEAR_D 150 → 210(팀장 02:03 «너무 많이 들어감 · 조금만 덜»)
export type SiteShot = { tgt: THREE.Vector3; el: number; az: number; d: number };
const SITE_C = () => toWorld(SITE_PX_W / 2, SITE_PX_H / 2), SITE_W = SITE_PX_W / K;
/** 보이는 가로 폭 viewW 와 화면 세로 자리 SITE_Y 를 맞춘 시점: 바라볼 점(tgt)을 가운데 c 에서 북쪽(-z)으로 옮겨 c 가 SITE_Y 에 오게 */
function shotAt(c: THREE.Vector3, viewW: number, aspect: number): SiteShot {
  const half = Math.tan((SITE_FOV * Math.PI) / 360), el = (SITE_EL * Math.PI) / 180, dip = el + Math.atan((SITE_Y - 0.5) * 2 * half);
  const k = Math.cos(el) - Math.sin(el) / Math.tan(dip);   // 북쪽으로 옮길 거리 ÷ d
  const d = viewW / (2 * half * aspect) / (1 - k * Math.cos(el));   // c 깊이에서 보이는 가로 폭 = viewW
  return { tgt: new THREE.Vector3(c.x, 0, c.z - k * d), el, az: 0, d };
}
export function siteShot(pts: { x: number; z: number }[], aspect: number): SiteShot {
  if (pts.length < 2) return shotAt(SITE_C(), SITE_W * SITE_MAX_K, aspect);
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z), x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  return shotAt(new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2), Math.min(SITE_W * SITE_MAX_K, Math.max(SITE_MIN_W, (x1 - x0) * SITE_SPAN)), aspect);
}
/** 고른 로봇 가까운 시점: 로봇이 화면 가운데 */
export const nearShot = (p: { x: number; z: number }): SiteShot => ({ tgt: new THREE.Vector3(p.x, 0, p.z), el: (SITE_EL * Math.PI) / 180, az: 0, d: NEAR_D });
/** 두 시점 사이(t 0~1, ease-in-out) */
export const shotMix = (a: SiteShot, b: SiteShot, t: number): SiteShot => { const e = ease(Math.min(1, Math.max(0, t)));
  return { tgt: a.tgt.clone().lerp(b.tgt, e), el: a.el + (b.el - a.el) * e, az: a.az + (b.az - a.az) * e, d: a.d + (b.d - a.d) * e }; };
/** 움직임 시간: 움직임 줄이기면 0(바로 끝) */
export const flyTime = () => (calm() ? 0 : FLY_S);
/** 「전체 보기」 시점(팀장 03:19 · 03:42 «꽉»): 정북 · 아래로 첫 시점과 같은 각(SITE_EL · 팀장 좋은 예도 이 각).
 *  가까운 변(앞 모서리 둘)이 칸 폭을 FULL_OVER(1.3 · 팀장 좋은 예처럼 양옆이 잘림) 만큼 넘치게 하는 가장 가까운 거리 · 먼 변(높이 FULL_H)은 FULL_TOP 아래 · 앞 변은 FULL_BOT 위. 거리 · 바라볼 점은 반 가르기 */
export const FULL_TOP = 0.93, FULL_OVER = 1.3, FULL_BOT = -0.97, FULL_H = 25, FULL_EL = SITE_EL, FULL_UP = -0.12;
/** box = 실제 받은 현장 모형의 바닥 둘레(x · z). 없으면 지도 판 크기(SITE_PX). 04:13 사진: 모형이 판보다 작아 판 모서리로 맞추면 공장이 칸 폭만큼만 보였음 */
export function fullShot(aspect: number, elDeg = FULL_EL, over = FULL_OVER, box?: { x0: number; z0: number; W: number; H: number }): SiteShot {
  const { W, H, x0, z0 } = box ?? { W: SITE_PX_W / K, H: SITE_PX_H / K, x0: -OX / K, z0: -OY / K }, el = (elDeg * Math.PI) / 180;
  const cam = new THREE.PerspectiveCamera(SITE_FOV, aspect, 1, 1e5), v = new THREE.Vector3(), tgt = new THREE.Vector3();
  const far = [new THREE.Vector3(x0, FULL_H, z0), new THREE.Vector3(x0 + W, FULL_H, z0)], near = [new THREE.Vector3(x0, 0, z0 + H), new THREE.Vector3(x0 + W, 0, z0 + H)];
  const put = (d: number, tz: number) => { tgt.set(x0 + W / 2, 0, tz); cam.position.set(tgt.x, Math.sin(el) * d, tz + Math.cos(el) * d); cam.lookAt(tgt); cam.updateMatrixWorld(); };
  const y = (p: THREE.Vector3) => v.copy(p).project(cam).y, x = (p: THREE.Vector3) => v.copy(p).project(cam).x;
  // 거리 d 에서 부지 위아래(먼 변 위 · 앞 변)의 가운데가 화면 가운데보다 FULL_UP 위에 오는(-0.12 = 조금 아래 · 04:17 팀장 좋은 예 사진 재기: 먼 변 화면 높이 +0.55 · 앞 변 -0.8) 바라볼 점(앞뒤) 자리
  const aimAt = (d: number) => { let lo = z0 - H, hi = z0 + 2 * H; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; put(d, m); if ((y(far[0]) + y(near[0])) / 2 > FULL_UP) hi = m; else lo = m; } return (lo + hi) / 2; };
  const ok = (d: number) => { put(d, aimAt(d)); return Math.abs(x(near[0])) <= over && Math.abs(x(near[1])) <= over && y(near[0]) >= FULL_BOT && y(far[0]) <= FULL_TOP; };
  let lo = 50, hi = 20000; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  const tz = aimAt(hi); return { tgt: new THREE.Vector3(x0 + W / 2, 0, tz), el, az: 0, d: hi };
}
/** 안개는 지도 밖 땅만: 시작 = 바라볼 점까지 거리 + 부지 반 대각선(지도 어디도 안개 앞) · 끝 = 시작 + FOG_LEN. 지도 밝기는 거리와 상관없음 */
/** 받은 현장 모형의 바닥 둘레(없거나 비면 undefined → 판 크기) */
export const siteBox = (o: THREE.Object3D | null) => {
  if (!o) return undefined;
  // 납작한 바닥판(높이 0.5 m 아래)은 빼고 서 있는 것(건물 · 탱크 · 배관)만: 바닥판이 판 크기 그대로라 둘레가 판과 같아지던 것(04:17 사진)
  o.updateMatrixWorld(true); const b = new THREE.Box3(), mb = new THREE.Box3();
  o.traverse((m) => { if (!(m as THREE.Mesh).isMesh) return; mb.setFromObject(m); if (!mb.isEmpty() && mb.max.y - mb.min.y > 0.5) b.union(mb); });
  return b.isEmpty() ? undefined : { x0: b.min.x, z0: b.min.z, W: b.max.x - b.min.x, H: b.max.z - b.min.z };
};
export const SITE_R = Math.hypot(SITE_PX_W / K, SITE_PX_H / K) / 2, FOG_LEN = 1200;
export const fogFor = (d: number) => ({ near: d + SITE_R, far: d + SITE_R + FOG_LEN });
/** 지금 카메라 자리를 시점 값으로(바라볼 점 · 높이각 · 방위 · 거리) */
export function shotOf(pos: THREE.Vector3, tgt: THREE.Vector3): SiteShot {
  const o = pos.clone().sub(tgt), d = o.length();
  return { tgt: tgt.clone(), el: Math.asin(Math.min(1, Math.max(-1, o.y / (d || 1)))), az: Math.atan2(o.x, o.z), d };
}
/** 한 시점에서 다른 시점으로 날기(작은 지도 날기와 같은 FLY_S · ease). 방위는 짧은 쪽으로. stop() = 사용자가 끌거나 휠 → 그 자리에서 멈춤(손을 넘김).
 *  dur 0(움직임 줄이기) = 첫 step 에 끝 시점 */
export function flight(a: SiteShot, b: SiteShot, dur = flyTime()) {
  let az = b.az - a.az; az = Math.atan2(Math.sin(az), Math.cos(az));
  const to = { ...b, az: a.az + az }; let t = dur <= 0 ? 1 : 0, live = true;
  return {
    get done() { return !live || t >= 1; },
    step(dt: number): SiteShot | null { if (!live) return null; t = dur <= 0 ? 1 : Math.min(1, t + dt / dur); const s = shotMix(a, to, t); if (t >= 1) live = false; return s; },
    stop() { live = false; },
  };
}
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** from = 작은 지도 칸 자리(화면 px). 있으면 그 자리에서 큰 지도 자리로 자람(320 ms). focus = 작은 지도 더블클릭 때 고른 로봇: 첫 시점에서 그 로봇으로 다가감. 움직임 줄이기면 바로 */
export function SiteView({ all, sel, open, from, focus, home, homeTick = 0 }: { all: TileFacts[]; sel: string; open: (id: string) => void; from?: DOMRect | null; focus?: string; home?: () => void; homeTick?: number }) {
  const box = useRef<HTMLDivElement>(null), fromTop = useRef(!!from && !calm());
  useLayoutEffect(() => {
    const el = box.current; if (!el || !from || !fromTop.current || typeof el.animate !== 'function') return;
    const me = el.getBoundingClientRect(); if (!me.width || !el.offsetWidth) return;
    const k = me.width / el.offsetWidth;   // 무대 배율(화면 px ÷ 무대 px)
    el.animate([{ transformOrigin: '0 0', transform: `translate(${(from.left - me.left) / k}px,${(from.top - me.top) / k}px) scale(${from.width / me.width},${from.height / me.height})`, borderRadius: '14px' },
      { transformOrigin: '0 0', transform: 'none', borderRadius: '22px' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const cv = useRef<HTMLCanvasElement>(null), marks = useRef<HTMLDivElement>(null), now = useRef(all);
  const goHome = useRef<(() => void) | null>(null);
  useEffect(() => { if (homeTick) goHome.current?.(); }, [homeTick]);
  now.current = all;
  useEffect(() => {
    const canvas = cv.current!; let r: THREE.WebGLRenderer;
    try { r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true }); } catch { return; }
    let w = canvas.clientWidth || 1472, h = canvas.clientHeight || 900;
    r.setPixelRatio(Math.min(2, devicePixelRatio || 1)); r.setSize(w, h, false);
    r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
    const BG = 0x07090b; r.setClearColor(BG, 1);
    const scene = new THREE.Scene(), over = new THREE.Scene(); scene.fog = new THREE.Fog(BG, 700, 1700);
    const cam = new THREE.PerspectiveCamera(SITE_FOV, w / h, 5, 5000);
    const aim = (s: SiteShot) => { const t = s.tgt; cam.position.set(t.x + Math.sin(s.az) * Math.cos(s.el) * s.d, Math.sin(s.el) * s.d, t.z + Math.cos(s.az) * Math.cos(s.el) * s.d); cam.lookAt(t); };
    // 첫 시점 = 로봇 무리(위치가 온 로봇) 둘레 상자 · 작은 지도 더블클릭 + 고른 로봇이면 그 로봇으로 다가감(FLY_S · 움직임 줄이기면 바로 끝)
    const pts = () => now.current.flatMap((f) => { const p = poseOf(f); return p ? [{ id: f.x.id, x: p.x, z: p.z }] : []; });
    const first = () => siteShot(pts(), w / h);
    let a0 = first(), touched = false, framed = pts().length >= 2;
    const near = () => { const p = focus ? pts().find((q) => q.id === focus) : undefined; return p ? nearShot(p) : null; };
    let end = near() ?? a0, fly = end === a0 ? 1 : 0, look = focus && fly >= 1 ? 3 : 0;   // 고른 로봇 위치가 아직 없으면 3 초까지 기다렸다 다가감
    const dur = flyTime(); if (dur === 0) fly = 1;
    let pause = fromTop.current && fly < 1 ? 0.32 : 0;   // 칸이 자라는 동안(320 ms)은 첫 시점에 머묾
    aim(fly < 1 ? a0 : end);
    const hemis: THREE.HemisphereLight[] = [], rims: THREE.DirectionalLight[] = [], suns: THREE.DirectionalLight[] = [];
    for (const sc of [scene, over]) {
      const hemi = new THREE.HemisphereLight(0xaab8c8, 0x07090b, 1.1); hemis.push(hemi); sc.add(hemi);
      const sun = new THREE.DirectionalLight(0xffffff, 2.0); suns.push(sun); sun.position.set(-300, 500, 400); sc.add(sun);
      const rim = new THREE.DirectionalLight(0x6fd6b8, 0.35); rims.push(rim); rim.position.set(300, 200, -500); sc.add(rim);
    }
    const W = SITE_PX_W / K, H = SITE_PX_H / K;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(W / 2 - OX / K, -0.05, H / 2 - OY / K); scene.add(ground);
    const gl: number[] = [];
    for (let x = 0; x <= 900; x += 50) gl.push(x, 0.02, 0, x, 0.02, 560);
    for (let z = 0; z <= 560; z += 50) gl.push(0, 0.02, z, 900, 0.02, z);
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(gl, 3));
    const gridM = new THREE.LineBasicMaterial({ color: 0x2a3440, transparent: true, opacity: 0.35 });
    scene.add(new THREE.LineSegments(gg, gridM));
    const robots = new Map<string, R>(); let proto: Body | null = null, walk: Walk | null = null, live = true;
    let site: THREE.Group | null = null, light: boolean | null = null;
    loadSite().then((s) => { if (live && s) { site = s; scene.add(s); light = null; } });
    // 밝은 판: 바탕 · 땅 · 격자 · 빛 · 현장 재질을 밝음 1 흰 점토 결로(시안 shared/map_large_factory_top.jpg). 판이 바뀌면 그때 다시 칠함
    // 지도 위 로봇(over 장면) 빛: 밝은 판은 관제 타일 · 로봇 탭과 같은 로봇 라이팅(robotLight), 어둠 판은 현장과 같은 옛 값 그대로
    const robotLit = (l: boolean) => { if (!l) return; const k = robotLight(true); hemis[1].color.setHex(k.sky); hemis[1].groundColor.setHex(k.ground); hemis[1].intensity = k.hemi; suns[1].intensity = k.key; rims[1].intensity = 0.05; };
    const shade = (l: boolean) => {
      if (site?.userData.tex) {   // 질감판: 자산 시험 화면(view.html LOOK) 의 바탕 · 하늘 빛 · 해 · 노출. 재질은 색 곱만(toneSite)
        const k = TEX_LOOK[l ? 'light' : 'dark'];
        r.setClearColor(k.bg, 1); (scene.fog as THREE.Fog).color.setHex(k.bg); r.toneMappingExposure = k.exp;
        (ground.material as THREE.MeshStandardMaterial).color.setHex(k.bg); gridM.color.setHex(l ? 0xc3cac5 : 0x2a3440);
        for (const h of hemis) { h.color.setHex(k.hemi[0]); h.groundColor.setHex(k.hemi[1]); h.intensity = k.hemi[2]; }
        for (const m of suns) m.intensity = k.sun;
        for (const m of rims) m.intensity = l ? 0.05 : 0.35;
        toneSite(site, l); robotLit(l); return;
      }
      const bg = l ? 0xf6f7f6 : BG; r.setClearColor(bg, 1); (scene.fog as THREE.Fog).color.setHex(bg);
      (ground.material as THREE.MeshStandardMaterial).color.setHex(l ? 0xeef0ee : 0x0b0e12); gridM.color.setHex(l ? 0xc3cac5 : 0x2a3440);
      for (const m of rims) m.intensity = l ? 0.05 : 0.35;
      for (const h of hemis) { h.color.setHex(l ? 0xffffff : 0xaab8c8); h.groundColor.setHex(l ? 0xc8cfcb : 0x07090b); }
      if (site) toneSite(site, l);
    };
    loadWalk().then((x) => { walk = x; });
    loadGo2(S).then((b) => { proto = b; });
    const make = (f: TileFacts): R | null => {
      if (!proto) return null;
      const g = new THREE.Group(), root = proto.root.clone(true), joints: Body['joints'] = {}, sim = f.sim;
      root.traverse((o) => {
        if (/^(FL|FR|RL|RR)_(hip|thigh|calf)$/.test(o.name)) joints[o.name] = { o, r0: o.rotation.clone() };
        const m = o as THREE.Mesh; if (!m.isMesh) return;
        if (sim) m.material = new THREE.MeshBasicMaterial({ color: 0x4c9bff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
        else { const mt = (m.material as THREE.MeshStandardMaterial).clone(); mt.color.lerp(new THREE.Color(0xb4bec9), 0.55); mt.emissive?.setHex(0x161c22); m.material = mt; }
      });
      g.add(root);
      const col = ST_COL[tone(f)], ring = ringLine(new THREE.Vector3(0, 0.3, 0), 0.62 * S * 0.75, col, 0.9); g.add(ring);
      const pool = new THREE.Mesh(new THREE.CircleGeometry(0.62 * S * 1.1, 48), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false,
        uniforms: { col: { value: new THREE.Color(col) } },
        vertexShader: 'varying vec2 u; void main(){ u=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
        fragmentShader: `varying vec2 u; uniform vec3 col; void main(){ float d=clamp(length(u)/${(0.62 * S * 1.1).toFixed(2)},0.0,1.0); gl_FragColor=vec4(col,0.30*(1.0-d)*(1.0-d)); }` }));
      pool.renderOrder = -1; pool.rotation.x = -Math.PI / 2; pool.position.y = 0.25; g.add(pool);
      over.add(g);
      return { id: f.x.id, g, body: { root, joints, top: proto.top }, ring, col, sim, top: proto.top, t: Math.random() * 2 };
    };
    const ctl = new OrbitControls(cam, canvas);
    ctl.target.copy(fly < 1 ? a0.tgt : end.tgt); ctl.enableDamping = true; ctl.dampingFactor = 0.08; ctl.screenSpacePanning = false;
    ctl.minDistance = 60; ctl.maxDistance = 1500; ctl.maxPolarAngle = 1.38; ctl.enabled = fly >= 1; if (fly >= 1) ctl.update();
    ctl.addEventListener('start', () => { touched = true; });
    let trip: ReturnType<typeof flight> | null = null;
    // 날아가는 중 사용자가 끌거나 휠을 굴리면 그 자리에서 멈추고 손을 넘김
    const grab = () => { if (!trip || trip.done) return; trip.stop(); trip = null; touched = true; ctl.enabled = true; ctl.update(); };
    canvas.addEventListener('pointerdown', grab, true); canvas.addEventListener('wheel', grab, { capture: true, passive: true });
    goHome.current = () => { fly = 1; look = 0; touched = true; trip = flight(shotOf(cam.position, ctl.target), fullShot(w / h, FULL_EL, FULL_OVER, siteBox(site))); ctl.enabled = false; };
    const v = new THREE.Vector3(), clock = new THREE.Clock(); let raf = 0;
    r.autoClear = false;
    const frame = () => {
      const raw = clock.getDelta(), dt = Math.min(0.05, raw);   // 카메라 움직임(raw)은 벽시계대로 · 걸음 · 따라가기(dt)는 한 판 0.05 s 까지
      const l = lightNow(); if (l !== light) { light = l; shade(l); }
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (cw && ch && (cw !== w || ch !== h)) { w = cw; h = ch; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
      const seen = new Set<string>(), vis: { el: HTMLElement; x: number; y: number; hw: number; bh: number }[] = [];
      for (const f of now.current) {
        const p = poseOf(f), el = marks.current?.querySelector<HTMLElement>(`[data-r3="${CSS.escape(f.x.id)}"]`);
        if (!p) { if (el) el.style.display = 'none'; continue; }   // 위치가 없으면 그리지 않음
        let R = robots.get(f.x.id);
        if (R && R.sim !== f.sim) { over.remove(R.g); robots.delete(f.x.id); R = undefined; }
        if (!R) { const m = make(f); if (!m) continue; R = m; robots.set(f.x.id, R); }
        seen.add(f.x.id); R.t += dt;
        R.at = follow(R.at ?? null, p, dt); R.g.position.set(R.at.x, 0, R.at.z); R.g.rotation.y = R.at.rot;   // 서버 자리 · 방향을 시안 곡선(dt × 6)으로 따라감
        const c = ST_COL[tone(f)]; if (c !== R.col) { (R.ring.material as THREE.LineBasicMaterial).color.setHex(c); R.col = c; }
        if (f.walk && walk) applyWalk(R.body, walk, R.t); else applyRest(R.body);
        if (!el) continue;
        v.copy(R.g.position); v.y += R.top + 2; v.project(cam);
        const on = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        el.style.display = on ? '' : 'none'; if (!on) continue;
        const hw = (el.offsetWidth || 120) / 2, bh = (el.offsetHeight || 42) - STEM;
        vis.push({ el, x: Math.min(w - hw - 10, Math.max(hw + 10, ((v.x + 1) / 2) * w)), y: ((1 - v.y) / 2) * h, hw, bh });
      }
      for (const [id, R] of robots) if (!seen.has(id)) { over.remove(R.g); robots.delete(id); }
      vis.sort((a, b) => b.y - a.y);
      const placed: { l: number; r: number; t: number; b: number }[] = [];
      for (const L of vis) {
        let lift = 0;
        for (let k = 0; k < 8; k++) {
          const top = L.y - STEM - lift - L.bh, bot = L.y - STEM - lift;
          const hit = placed.find((p) => L.x - L.hw < p.r + 4 && L.x + L.hw > p.l - 4 && top < p.b + 4 && bot > p.t - 4);
          if (!hit) break; lift = L.y - STEM - (hit.t - 4);
          if (lift > LIFT_MAX) { lift = LIFT_MAX; break; }   // 멀리 당겨 무리가 좁으면 겹침 피하기가 이름표를 높이 밀어 긴 줄이 달림(03:42) → 줄 길이 상한
        }
        placed.push({ l: L.x - L.hw, r: L.x + L.hw, t: L.y - STEM - lift - L.bh, b: L.y - STEM - lift });
        const st = L.el.querySelector('i'); if (st) (st as HTMLElement).style.height = `${STEM + lift}px`;
        L.el.style.transform = `translate(${L.x.toFixed(1)}px,${L.y.toFixed(1)}px) translate(-50%,-100%)`;
      }
      if (look > 0 && !touched) {
        look -= raw; const n = near();
        if (n) { look = 0; a0 = first(); framed = true; end = n; if (dur === 0) { aim(end); ctl.target.copy(end.tgt); ctl.update(); } else { fly = 0; ctl.enabled = false; } }
      }
      if (trip) {
        const sh = trip.step(raw); if (sh) { aim(sh); ctl.target.copy(sh.tgt); }
        if (trip.done) { trip = null; ctl.enabled = true; ctl.update(); }
      } else if (fly < 1) {
        if (pause > 0) pause -= raw; else fly = Math.min(1, fly + raw / dur);
        const s = shotMix(a0, end, fly); aim(s);
        if (fly >= 1) { ctl.target.copy(end.tgt); ctl.enabled = true; ctl.update(); }
      } else if (!touched && !framed && look <= 0 && end === a0 && pts().length >= 2) {   // 위치가 늦게 오면 손대기 전 한 번 첫 시점을 다시 잡음
        framed = true; a0 = end = first(); aim(a0); ctl.target.copy(a0.tgt); ctl.update();
      } else ctl.update();
      { const fg = scene.fog as THREE.Fog, ff = fogFor(cam.position.distanceTo(ctl.target)); fg.near = ff.near; fg.far = ff.far; }
      r.clear(); r.render(scene, cam); r.clearDepth(); r.render(over, cam);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { live = false; goHome.current = null; canvas.removeEventListener('pointerdown', grab, true); canvas.removeEventListener('wheel', grab, true); cancelAnimationFrame(raf); ctl.dispose(); r.dispose(); };
  }, []);
  const icon = (f: TileFacts): ReactNode => (f.sim ? ic(13, IC.box, '#4c9bff') : f.level === 'bad' || f.level === 'crit' ? ic(13, IC.warn, '#ff4d4f') : f.lostNow ? ic(13, IC.wifi, '#f2b705') : f.charging ? ic(13, IC.bolt, 'var(--u5-ok)') : null);   // 시안 K-04 충전 = 번개
  const sub = (f: TileFacts) => f.mission?.name ?? (f.lostNow ? '연결 끊김' : f.sim ? '시뮬 대기' : f.x.status ? STATUS_NAME[f.x.status] : '');
  return <div className="big st3" ref={box} data-from-mini={from ? '' : undefined} data-focus={focus || undefined}>
    <canvas id="site" ref={cv} aria-label="현장 3D"></canvas>
    <div className="mks" ref={marks}>{all.map((f) => { const k = tone(f); return <div key={f.x.id} className={`mk3 ${k === 'bad' ? 'r' : k === 'link' ? 'o' : k === 'rest' ? 'sim' : ''}${f.x.id === sel ? ' sel' : ''}`} data-n={f.x.name} data-r3={f.x.id} style={{ display: 'none' }}
      role="button" tabIndex={0} aria-pressed={f.x.id === sel} {...pickPress(f.x.id, f.x.id === sel, () => open(f.x.id))}><span className="lb">{icon(f)}{f.x.name}<small>{sub(f)}</small></span><i></i></div>; })}</div>
    <span className="g dk ov" style={{ left: '14px', bottom: '14px' }}>{ic(14, IC.box)}실시간 3D · 끌어서 돌리기 · 휠 확대</span>
    {home && <span className="g dk ov" style={{ right: '14px', top: '14px', cursor: 'pointer' }} role="button" tabIndex={0} data-home onClick={home} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); home(); } }}>{ic(14, IC.undo)}전체 보기</span>}
  </div>;
}

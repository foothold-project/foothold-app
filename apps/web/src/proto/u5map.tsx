// 관제 지도 보기(시안 u5_3): 시안 shared/site3d.js mountSite 를 옮김. 현장 · 빛 · 땅 · 격자 · 카메라 · 표지 배치 값 그대로.
// 로봇은 서버 위치가 온 것만 그 자리 · 방향에 둔다(시안의 정해 둔 경로 · 겹치는 곳은 서버에 없어 그리지 않음).
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STATUS_NAME } from '../fake';
import { rt } from '../rt';
import { TEX_LOOK, K, OX, OY, SITE_PX_H, SITE_PX_W, applyRest, applyWalk, lightNow, loadGo2, loadSite, loadWalk, ringLine, sitePose, toWorld, toneSite, type Body, type Walk } from './site';
import { follow, type Held } from './tileview';
import { IC, ic, type TileFacts } from './u5';
import { pickPress } from '../screens/control';

const ST_COL = { walk: 0x00c389, link: 0xf2b705, rest: 0x4c9bff, bad: 0xff4d4f, idle: 0xa9b8c6 } as const;
/** 지도 보기 로봇 모형 배율(시안 data-site scale 20 → 12 · 팀장 02:03 «모형이 큼» · 점 · 줄기와 어울리게). 고리 · 빛 웅덩이도 이 배율 */
export const MAP_GO2_S = 12;
const S = MAP_GO2_S, STEM = 16;
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
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** from = 작은 지도 칸 자리(화면 px). 있으면 그 자리에서 큰 지도 자리로 자람(320 ms). focus = 작은 지도 더블클릭 때 고른 로봇: 첫 시점에서 그 로봇으로 다가감. 움직임 줄이기면 바로 */
export function SiteView({ all, sel, open, from, focus }: { all: TileFacts[]; sel: string; open: (id: string) => void; from?: DOMRect | null; focus?: string }) {
  const box = useRef<HTMLDivElement>(null), fromTop = useRef(!!from && !calm());
  useLayoutEffect(() => {
    const el = box.current; if (!el || !from || !fromTop.current || typeof el.animate !== 'function') return;
    const me = el.getBoundingClientRect(); if (!me.width || !el.offsetWidth) return;
    const k = me.width / el.offsetWidth;   // 무대 배율(화면 px ÷ 무대 px)
    el.animate([{ transformOrigin: '0 0', transform: `translate(${(from.left - me.left) / k}px,${(from.top - me.top) / k}px) scale(${from.width / me.width},${from.height / me.height})`, borderRadius: '14px' },
      { transformOrigin: '0 0', transform: 'none', borderRadius: '22px' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const cv = useRef<HTMLCanvasElement>(null), marks = useRef<HTMLDivElement>(null), now = useRef(all);
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
    const shade = (l: boolean) => {
      if (site?.userData.tex) {   // 질감판: 자산 시험 화면(view.html LOOK) 의 바탕 · 하늘 빛 · 해 · 노출. 재질은 색 곱만(toneSite)
        const k = TEX_LOOK[l ? 'light' : 'dark'];
        r.setClearColor(k.bg, 1); (scene.fog as THREE.Fog).color.setHex(k.bg); r.toneMappingExposure = k.exp;
        (ground.material as THREE.MeshStandardMaterial).color.setHex(k.bg); gridM.color.setHex(l ? 0xc3cac5 : 0x2a3440);
        for (const h of hemis) { h.color.setHex(k.hemi[0]); h.groundColor.setHex(k.hemi[1]); h.intensity = k.hemi[2]; }
        for (const m of suns) m.intensity = k.sun;
        for (const m of rims) m.intensity = l ? 0.05 : 0.35;
        toneSite(site, l); return;
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
        }
        placed.push({ l: L.x - L.hw, r: L.x + L.hw, t: L.y - STEM - lift - L.bh, b: L.y - STEM - lift });
        const st = L.el.querySelector('i'); if (st) (st as HTMLElement).style.height = `${STEM + lift}px`;
        L.el.style.transform = `translate(${L.x.toFixed(1)}px,${L.y.toFixed(1)}px) translate(-50%,-100%)`;
      }
      if (look > 0 && !touched) {
        look -= raw; const n = near();
        if (n) { look = 0; a0 = first(); framed = true; end = n; if (dur === 0) { aim(end); ctl.target.copy(end.tgt); ctl.update(); } else { fly = 0; ctl.enabled = false; } }
      }
      if (fly < 1) {
        if (pause > 0) pause -= raw; else fly = Math.min(1, fly + raw / dur);
        const s = shotMix(a0, end, fly); aim(s);
        if (fly >= 1) { ctl.target.copy(end.tgt); ctl.enabled = true; ctl.update(); }
      } else if (!touched && !framed && look <= 0 && end === a0 && pts().length >= 2) {   // 위치가 늦게 오면 손대기 전 한 번 첫 시점을 다시 잡음
        framed = true; a0 = end = first(); aim(a0); ctl.target.copy(a0.tgt); ctl.update();
      } else ctl.update();
      r.clear(); r.render(scene, cam); r.clearDepth(); r.render(over, cam);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { live = false; cancelAnimationFrame(raf); ctl.dispose(); r.dispose(); };
  }, []);
  const icon = (f: TileFacts): ReactNode => (f.sim ? ic(13, IC.box, '#4c9bff') : f.level === 'bad' || f.level === 'crit' ? ic(13, IC.warn, '#ff4d4f') : f.lostNow ? ic(13, IC.wifi, '#f2b705') : f.charging ? ic(13, IC.bolt, 'var(--u5-ok)') : null);   // 시안 K-04 충전 = 번개
  const sub = (f: TileFacts) => f.mission?.name ?? (f.lostNow ? '연결 끊김' : f.sim ? '시뮬 대기' : f.x.status ? STATUS_NAME[f.x.status] : '');
  return <div className="big st3" ref={box} data-from-mini={from ? '' : undefined} data-focus={focus || undefined}>
    <canvas id="site" ref={cv} aria-label="현장 3D"></canvas>
    <div className="mks" ref={marks}>{all.map((f) => { const k = tone(f); return <div key={f.x.id} className={`mk3 ${k === 'bad' ? 'r' : k === 'link' ? 'o' : k === 'rest' ? 'sim' : ''}${f.x.id === sel ? ' sel' : ''}`} data-n={f.x.name} data-r3={f.x.id} style={{ display: 'none' }}
      role="button" tabIndex={0} aria-pressed={f.x.id === sel} {...pickPress(f.x.id, f.x.id === sel, () => open(f.x.id))}><span className="lb">{icon(f)}{f.x.name}<small>{sub(f)}</small></span><i></i></div>; })}</div>
    <span className="g dk ov" style={{ left: '14px', bottom: '14px' }}>{ic(14, IC.box)}실시간 3D · 끌어서 돌리기 · 휠 확대</span>
  </div>;
}

// 관제 지도 보기(시안 u5_3): 시안 shared/site3d.js mountSite 를 옮김. 현장 · 빛 · 땅 · 격자 · 카메라 · 표지 배치 값 그대로.
// 로봇은 서버 위치가 온 것만 그 자리 · 방향에 둔다(시안의 정해 둔 경로 · 겹치는 곳은 서버에 없어 그리지 않음).
import { useEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STATUS_NAME } from '../fake';
import { rt } from '../rt';
import { K, OX, OY, applyRest, applyWalk, loadGo2, loadSite, loadWalk, ringLine, sitePose, toWorld, type Body, type Walk } from './site';
import { IC, ic, type TileFacts } from './u5';

const ST_COL = { walk: 0x00c389, link: 0xf2b705, rest: 0x4c9bff, bad: 0xff4d4f, idle: 0xa9b8c6 } as const;
const S = 20, STEM = 16;   // 시안 data-site scale 20
const tone = (f: TileFacts): keyof typeof ST_COL => (f.level === 'bad' || f.level === 'crit' ? 'bad' : f.lostNow ? 'link' : f.sim ? 'rest' : f.walk ? 'walk' : 'idle');
const poseOf = (f: TileFacts) => sitePose((f.x.unknown === 'summary' ? null : rt.get(f.x.id).state?.location) ?? (f.x.unknown === 'summary' ? null : f.x.location));

type R = { id: string; g: THREE.Group; body: Body; ring: THREE.Line; col: number; sim: boolean; top: number; t: number };

export function SiteView({ all, sel, pick, open }: { all: TileFacts[]; sel: string; pick: (id: string) => void; open: (id: string) => void }) {
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
    const cam = new THREE.PerspectiveCamera(32, w / h, 5, 5000);
    const tgt = toWorld(1960, 880), el = (58 * Math.PI) / 180, az = (-6 * Math.PI) / 180, d = 760;
    cam.position.set(tgt.x + Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, tgt.z + Math.cos(az) * Math.cos(el) * d); cam.lookAt(tgt);
    for (const sc of [scene, over]) {
      sc.add(new THREE.HemisphereLight(0xaab8c8, 0x07090b, 1.1));
      const sun = new THREE.DirectionalLight(0xffffff, 2.0); sun.position.set(-300, 500, 400); sc.add(sun);
      const rim = new THREE.DirectionalLight(0x6fd6b8, 0.35); rim.position.set(300, 200, -500); sc.add(rim);
    }
    const W = 3200 / K, H = 2000 / K;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(W / 2 - OX / K, -0.05, H / 2 - OY / K); scene.add(ground);
    const gl: number[] = [];
    for (let x = 0; x <= 900; x += 50) gl.push(x, 0.02, 0, x, 0.02, 560);
    for (let z = 0; z <= 560; z += 50) gl.push(0, 0.02, z, 900, 0.02, z);
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(gl, 3));
    scene.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x2a3440, transparent: true, opacity: 0.35 })));
    const robots = new Map<string, R>(); let proto: Body | null = null, walk: Walk | null = null, live = true;
    loadSite().then((s) => { if (live && s) scene.add(s); });
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
    ctl.target.copy(tgt); ctl.enableDamping = true; ctl.dampingFactor = 0.08; ctl.screenSpacePanning = false;
    ctl.minDistance = 60; ctl.maxDistance = 1500; ctl.maxPolarAngle = 1.38; ctl.update();
    const v = new THREE.Vector3(), clock = new THREE.Clock(); let raf = 0;
    r.autoClear = false;
    const frame = () => {
      const dt = Math.min(0.05, clock.getDelta());
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
        R.g.position.set(p.x, 0, p.z); R.g.rotation.y = p.rot;
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
      ctl.update(); r.clear(); r.render(scene, cam); r.clearDepth(); r.render(over, cam);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { live = false; cancelAnimationFrame(raf); ctl.dispose(); r.dispose(); };
  }, []);
  const icon = (f: TileFacts): ReactNode => (f.level === 'bad' || f.level === 'crit' ? ic(13, IC.warn, '#ff4d4f') : f.lostNow ? ic(13, IC.wifi, '#f2b705') : f.sim ? ic(13, IC.box, '#4c9bff') : null);
  const sub = (f: TileFacts) => f.mission?.name ?? (f.lostNow ? '연결 끊김' : f.sim ? '시뮬 대기' : f.x.status ? STATUS_NAME[f.x.status] : '—');
  return <div className="big" style={{ background: '#07090b' }}>
    <canvas id="site" ref={cv} aria-label="현장 3D"></canvas>
    <div className="mks" ref={marks}>{all.map((f) => { const k = tone(f); return <div key={f.x.id} className={`mk3 ${k === 'bad' ? 'r' : k === 'link' ? 'o' : k === 'rest' ? 'sim' : ''}${f.x.id === sel ? ' sel' : ''}`} data-n={f.x.name} data-r3={f.x.id} style={{ display: 'none' }}
      onClick={() => (f.x.id === sel ? open(f.x.id) : pick(f.x.id))}><span className="lb">{icon(f)}{f.x.name}<small>{sub(f)}</small></span><i></i></div>; })}</div>
    <span className="g dk ov" style={{ left: '14px', bottom: '14px' }}>{ic(14, IC.box)}실시간 3D · 끌어서 돌리기 · 휠 확대</span>
  </div>;
}

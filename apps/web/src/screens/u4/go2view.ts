// 시안 shared/go2view.js 를 옮긴 것 (로봇 탭 가운데 3D · Isaac 자산 go2_isaac.glb). 빛 · 바닥 점 · 핀 조명 · 그림자 · 끌어서 돌려 보기 값은 시안 그대로.
// 바뀐 것: 걷기 관절은 시안의 기록 고리 대신 로봇이 보낸 실제 관절값(api.q, go2model JOINTS 순서 12개)을 쓴다. 값이 없으면 서 있는 모양 그대로(지어내지 않음).
// 바닥 점 흐름은 api.drive = {v, turn, side} (서버 state.applied [vx, vy, wz]) 로 로봇 기준으로 흐른다(flow). 늘 정면(팀장 23:48 · 현장 장면 없음).
// 멈춘 로봇 바닥 표시(충전 · 점검)는 시안 u5_1_tiles pad() 값(padMesh · 관제 타일과 같이 씀). 모형 파일은 저장소 밖 자산 폴더(/proto-assets/, FH_ASSET_DIR)에서 읽는다.
import * as THREE from 'three';
import { applyWalk, loadWalk, type Walk } from '../../proto/site';
import { feetUp, simLook } from '../../proto/tileview';

export const GO2_GLB = '/proto-assets/shared/go2_isaac.glb';
const SIM = 0x4c9bff;
const HOT: Record<string, number> = { warn: 0xf2b705, hot: 0xff4d4f, ok: 0x00c389 };
/** go2model JOINTS 순서(FR FL RR RL × hip thigh calf) → glb 마디 이름. 시안의 서 있는 자세(Isaac 기본값)와의 차만큼 돌린다 */
const ORDER = ['FR', 'FL', 'RR', 'RL'].flatMap((l) => ['hip', 'thigh', 'calf'].map((p) => `${l}_${p}`));
export const STAND = ORDER.map((n) => (n.endsWith('hip') ? (n[1] === 'R' ? -0.1 : 0.1) : n.endsWith('thigh') ? (n[0] === 'F' ? 0.8 : 1) : -1.5));

/** 관절값이 없을 때 서버 posture LYING 으로 그리는 엎드림(다리를 몸 밑으로 접음). hip 은 서기 그대로, thigh 1.36 · calf -2.72.
 *  값 출처: 조정 세션 11-28 19:39 지시(실제 Go2 엎드림 근사 · calf 는 Go2 종아리 관절 하한 -2.72 에 맞춤). 시안 pose 'down'(+0.8 · -1.6)은 하한을 넘어 종아리가 들려 쓰지 않음 */
export const DOWN = ORDER.map((n, i) => (n.endsWith('thigh') ? 1.36 : n.endsWith('calf') ? -2.72 : STAND[i]));
/** 그릴 관절: 받은 관절값이 이긴다 · 없으면 posture LYING 이면 엎드림 · 그 밖은 서기(지어내지 않음) */
export const poseQ = (q: number[] | null, down: boolean) => (q && q.length === 12 ? q : down ? DOWN : STAND);
/** 다리 꼴: 받은 관절값(q) · 엎드림(down) · 관절값 없이 걷는 속도(walk = 관제 타일과 같은 시안 걷기 기록 applyWalk) · 서기(stand) */
export const legMode = (q: number[] | null, down: boolean, walk: boolean) => (q && q.length === 12 ? 'q' : down ? 'down' : walk ? 'walk' : 'stand');
type Joints = Record<string, { o: THREE.Object3D; r0: THREE.Euler }>;
/** 받은 관절값(12개)으로 다리를 돌린 뒤 몸 · 발 가장 낮은 점을 바닥 y=0 에 붙인다(서기 · 엎드림 · 앉기 · 넘어짐 · 시뮬 · 데모 · 실기 같은 규칙).
 *  관절만 돌리고 몸 높이를 서 있을 때 그대로 두면 엎드릴 때 공중에 떠 앉는다(팀장 11-28 18:47) */
export function applyQ(root: THREE.Object3D, joints: Joints, q: number[]) {
  ORDER.forEach((n, i) => { const j = joints[n]; if (!j) return; j.o.rotation.copy(j.r0); j.o.rotation[n.endsWith('hip') ? 'z' : 'x'] += q[i] - STAND[i]; });
  ground(root);
}
/** 걷기 기록 t 초 자리로 다리를 놓고 종아리 넷의 가장 낮은 점을 y=0 에(관제 타일 tileview feetUp 과 같은 맞춤 · 엎드림 → 걷기로 바뀌어도 발이 묻히거나 뜨지 않게, 검토 L2) */
export function walkPose(root: THREE.Object3D, joints: Joints, gait: Walk, t: number) {
  const b = { root, joints, top: 0 }; applyWalk(b, gait, t); root.position.y = feetUp(b); root.updateMatrixWorld(true);
}
/** 무대 1 m = 모형 단위(모형 긴 변 0.62 ↔ Go2 몸 길이 약 0.70 m) */
export const UNIT = 0.62 / 0.7;
/** 바닥 점 판 한 칸(점 44 × 0.09) · 점은 이 길이로 되풀이(셰이더 mod) */
export const GRID_N = 44, GRID_STEP = 0.09, GRID_SPAN = GRID_N * GRID_STEP;
const wrap = (x: number) => ((((x + GRID_SPAN / 2) % GRID_SPAN) + GRID_SPAN) % GRID_SPAN) - GRID_SPAN / 2;
/** 바닥 점 흐름(로봇 기준 · 무대 좌표 앞 +z · 왼 +x · 위 +y): 로봇이 vx(앞) · vy(왼) · wz(왼쪽으로 돎) 로 dt 초 움직이면
 *  바닥은 반대로 움직인다 = 점 판을 -wz·dt 돌리고, 판 안 좌표(off)로 -v·dt 만큼 민다(돈 뒤의 판 방향으로 옮겨 앞 · 옆이 늘 로봇 기준) */
export function flow(g: { x: number; z: number; th: number }, d: { v: number; side: number; turn: number }, dt: number) {
  const th = g.th - d.turn * dt, mx = -d.side * dt * UNIT, mz = -d.v * dt * UNIT, c = Math.cos(th), s = Math.sin(th);
  return { th, x: wrap(g.x + mx * c - mz * s), z: wrap(g.z + mx * s + mz * c) };
}
/** 멈춘 로봇 바닥 표시(시안 u5_1_tiles.html pad() 값 그대로 · 가는 선): 충전 = 받침 테두리 두 겹(초록) · 점검 = 점검대 네모 두 겹(회색).
 *  밝은 판 = 밝음 1 값(충전 #18A07E · 점검 #5E6662). 관제 타일(tileview)도 이것을 씀 */
export type PadKind = 'charge' | 'maint';
export function padMesh(kind: PadKind, light = false): THREE.Group {
  const col = kind === 'charge' ? (light ? 0x18a07e : 0x00c389) : (light ? 0x5e6662 : 0xa9b8c6), g = new THREE.Group();
  g.name = `pad-${kind}`;
  const line = (pts: THREE.Vector3[], op: number) => g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: op })));
  if (kind === 'charge') {
    for (const [r, op] of [[0.34, 0.85], [0.40, 0.3]]) line(Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos(i / 96 * 6.2832) * r, 0.002, Math.sin(i / 96 * 6.2832) * r * 1.25)), op);
  } else {
    const W = 0.38, D = 0.5;
    line([[-W, -D], [W, -D], [W, D], [-W, D]].map(([x, z]) => new THREE.Vector3(x, 0.002, z)), 0.75);
    line([[-W - 0.06, -D - 0.06], [W + 0.06, -D - 0.06], [W + 0.06, D + 0.06], [-W - 0.06, D + 0.06]].map(([x, z]) => new THREE.Vector3(x, 0.002, z)), 0.22);
  }
  return g;
}
/** 모형의 가장 낮은 점(꼭짓점 기준)을 y=0 에 */
export function ground(root: THREE.Object3D) {
  root.position.y = 0; root.updateMatrixWorld(true);
  root.position.y = -new THREE.Box3().setFromObject(root, true).min.y; root.updateMatrixWorld(true);
}

function cyberMat() {
  return new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { col: { value: new THREE.Color(SIM) }, t: { value: 0 } },
    vertexShader: `varying vec3 n; varying vec3 v; varying float y; void main(){ vec4 w=modelMatrix*vec4(position,1.0); y=w.y; n=normalize(normalMatrix*normal); vec4 mv=viewMatrix*w; v=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 col; uniform float t; varying vec3 n; varying vec3 v; varying float y;
      void main(){ float f=pow(1.0-abs(dot(normalize(n),normalize(v))),2.2); float sl=0.5+0.5*step(0.5,fract(y*140.0-t*0.6));
        gl_FragColor=vec4(col*(0.18+1.25*f)*sl, 0.14+0.7*f); }` });
}

export type Go2Opt = { pin?: boolean; orbit?: boolean; glow?: boolean; cyber?: boolean; hot?: Record<string, string>; pose?: 'down'; yaw?: number; dist?: number; floor?: number; src?: string };
export type Go2Api = { q: number[] | null; /** 서버 posture LYING (q 없을 때만 씀) */ down: boolean; /** 관절값 없이 서버 speed ≥ WALK_MIN_SPEED (q · down 이 이김) */ walk: boolean;
  /** 멈춘 로봇 바닥 표시(충전 · 점검 · 없음) */ pad: PadKind | null; drive: { v: number; turn: number; side: number } | null; setHot: (m: Record<string, string>) => void;
  /** 캔버스 안 자리(px · 캔버스 왼쪽 위 기준)에 닿는 관절 이름(FR_calf 꼴) · 없으면 null (시안 u4_4 마우스 온도) */ pick: (x: number, y: number) => string | null; dispose: () => void; fallback?: boolean };

/** 맞은 물체에서 위로 올라가며 처음 만나는 관절 이름(FR_hip · FR_thigh · FR_calf) · 몸통이면 null */
export function jointOf(o: THREE.Object3D | null): string | null {
  for (let n = o; n; n = n.parent) if (/^(FL|FR|RL|RR)_(hip|thigh|calf)$/.test(n.name)) return n.name;
  return null;
}

export function mount(canvas: HTMLCanvasElement, opt: Go2Opt = {}): Go2Api {
  const w = canvas.clientWidth || 760, h = canvas.clientHeight || 900;
  let r: THREE.WebGLRenderer;
  const api: Go2Api = { q: null, down: false, walk: false, pad: null, drive: null, setHot, pick: () => null, dispose: () => {} };
  try { r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true }); }
  catch { api.fallback = true; return api; }   // WebGL 이 없는 PC: 캔버스만 빈 채로 (시안의 정면 그림은 자산이라 넣지 않음)
  r.setPixelRatio(Math.min(2, devicePixelRatio)); r.setSize(w, h, false);
  r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, w / h, 0.05, 50);
  const yaw = opt.yaw ?? 0.0, dist = opt.dist ?? 1.3;
  cam.position.set(Math.sin(yaw) * dist, 0.55, Math.cos(yaw) * dist); cam.lookAt(0, 0.17, 0);

  scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x0c0f14, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.2, 2, 1.6); scene.add(key);
  const rim = new THREE.DirectionalLight(0x00c389, 1.6); rim.position.set(-1.5, 1.2, -1.8); scene.add(rim);
  const rim2 = new THREE.DirectionalLight(0x4c9bff, 0.8); rim2.position.set(1.6, 0.6, -1.4); scene.add(rim2);

  const pools: THREE.Object3D[] = [];   // 어두운 판 바닥 빛 웅덩이(밝은 판에서는 회색 원으로 보여 끔)
  const N = GRID_N, step = GRID_STEP, pts = new Float32Array(N * N * 3);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const k = (i * N + j) * 3; pts[k] = (i - N / 2) * step; pts[k + 1] = 0; pts[k + 2] = (j - N / 2) * step; }
  const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const gm = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { off: { value: new THREE.Vector2() }, col: { value: new THREE.Color(opt.cyber ? SIM : 0x00c389) } },
    vertexShader: `uniform vec2 off; varying float a; void main(){ vec3 p=position; p.xz=mod(p.xz+off+${(N * step / 2).toFixed(3)},${(N * step).toFixed(3)})-${(N * step / 2).toFixed(3)}; a=1.0-smoothstep(0.35,1.9,length(p.xz)); gl_PointSize=2.6; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);} `,
    fragmentShader: `uniform vec3 col; varying float a; void main(){ vec2 c=gl_PointCoord-0.5; if(length(c)>0.5) discard; gl_FragColor=vec4(col,a*0.55);} ` });
  const grid = new THREE.Points(gg, gm); scene.add(grid);
  if (opt.glow) {
    gm.blending = THREE.AdditiveBlending; gm.uniforms.col.value.lerp(new THREE.Color(0xffffff), 0.4);
    const FL = (opt.floor ?? 1).toFixed(2);
    gm.fragmentShader = gm.fragmentShader.replace('a*0.55', `a*1.0*${FL}`);
    const hm = gm.clone(); hm.uniforms = { off: gm.uniforms.off, col: { value: gm.uniforms.col.value.clone() } };
    hm.vertexShader = gm.vertexShader.replace('gl_PointSize=2.6', 'gl_PointSize=10.0');
    hm.fragmentShader = `uniform vec3 col; varying float a; void main(){ float d=length(gl_PointCoord-0.5)*2.0; if(d>1.0) discard; gl_FragColor=vec4(col,a*0.5*${FL}*(1.0-d)*(1.0-d));} `;
    grid.add(new THREE.Points(gg, hm));
  }
  if (opt.pin) {
    const pin = new THREE.SpotLight(0xf4f7ff, 6.0, 0, 0.24, 0.65, 0); pin.position.set(0.25, 2.3, 1.0);
    pin.target.position.set(0, 0.2, 0); scene.add(pin, pin.target);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(0.6, 64), new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      vertexShader: `varying vec2 u; void main(){ u=position.xy/0.6; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `varying vec2 u; void main(){ float d=clamp(length(u),0.0,1.0); float a=(1.0-d)*(1.0-d); gl_FragColor=vec4(0.85,0.9,1.0,0.13*a);} ` }));
    pool.rotation.x = -Math.PI / 2; pool.position.y = 0.0005; pool.renderOrder = -1; scene.add(pool);
    pools.push(pool);
  }
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.22, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.001; shadow.scale.set(1, 1.5, 1); scene.add(shadow);

  const cm = cyberMat();   // 시뮬 로봇 재질(opt.cyber 일 때만 씀)
  const joints: Joints = {};
  let root: THREE.Object3D | null = null, posed = false, live = true, gait: Walk | null = null;
  loadWalk().then((w: Walk | null) => { if (live) gait = w; });
  import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => new GLTFLoader().load(opt.src || GO2_GLB, (g) => {
    if (!live) return;
    root = g.scene; scene.add(root);
    let box = new THREE.Box3().setFromObject(root); const sz = box.getSize(new THREE.Vector3());
    const k = 0.62 / Math.max(sz.x, sz.z); root.scale.multiplyScalar(k);
    box = new THREE.Box3().setFromObject(root); const c = box.getCenter(new THREE.Vector3());
    root.position.x -= c.x; root.position.z -= c.z; root.position.y -= box.min.y;
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry && !m.geometry.attributes.normal) m.geometry.computeVertexNormals(); });
    root.traverse((o) => {
      if (/^(FL|FR|RL|RR)_(hip|thigh|calf)$/.test(o.name)) joints[o.name] = { o, r0: o.rotation.clone() };
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.material = (m.material as THREE.MeshStandardMaterial).clone(); m.userData.c0 = (m.material as THREE.MeshStandardMaterial).color.clone(); }
    });
    if (opt.pose === 'down') {
      ['FL', 'FR', 'RL', 'RR'].forEach((L) => { const th = joints[`${L}_thigh`], ca = joints[`${L}_calf`]; if (th) th.o.rotation.x += 0.8; if (ca) ca.o.rotation.x += -1.6; });
      root.updateMatrixWorld(true); ground(root); posed = true;
    }
    if (opt.cyber) { root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = cm; }); shadow.visible = false; lit = null; }
    else setHot(hotNow);
  }, undefined, () => {})).catch(() => {});

  let hotNow: Record<string, string> = opt.hot || {};   // 모형을 받기 전에 온 값도 받은 뒤 칠함
  function setHot(map: Record<string, string>) {
    hotNow = map;
    if (!root || opt.cyber) return;
    root.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; const mt = m.material as THREE.MeshStandardMaterial; mt.color.copy(m.userData.c0); mt.emissive?.setHex(0x000000); });
    for (const [name, lvl] of Object.entries(map)) {
      const n = root.getObjectByName(name); if (!n) continue;
      n.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.parent === n || m === n || !/_(hip|thigh|calf)$/.test(m.parent?.name || ''))) {
        const mt = m.material as THREE.MeshStandardMaterial; mt.color.setHex(HOT[lvl] ?? Number(lvl)); if (mt.emissive) { mt.emissive.setHex(HOT[lvl] ?? Number(lvl)); mt.emissiveIntensity = 0.25; } } });
    }
  }

  let ctl: { update(): void; dispose(): void } | null = null;
  if (opt.orbit) import('three/examples/jsm/controls/OrbitControls.js').then(({ OrbitControls }) => {
    if (!live) return;
    const o = new OrbitControls(cam, canvas); o.target.set(0, 0.17, 0);
    o.enablePan = false; o.enableDamping = true; o.dampingFactor = 0.08;
    o.minDistance = 0.7; o.maxDistance = 2.6; o.minPolarAngle = 0.15; o.maxPolarAngle = 1.45;
    o.update(); ctl = o;
  }).catch(() => {});

  // 밝은 판(.light 틀 안): 바닥 점을 보통 섞기 · 밝음 1 민트로. 판이 바뀌면 다음 그림부터 따라감
  // 시뮬(cyber): 파란 선 로봇 · 파란 점. 밝은 판은 관제 타일 simLook 과 같은 값(보통 섞기 · 예행 색)
  const dark = { col: gm.uniforms.col.value.clone(), blend: gm.blending }, mint = new THREE.Color(0x18a07e);
  let lit: boolean | null = null, padNow: PadKind | null = null, padG: THREE.Group | null = null;
  const tone = () => {
    const l = !!canvas.closest('.light'); if (l === lit) return; lit = l;
    const sl = simLook(l);
    grid.traverse((o) => { const m = (o as THREE.Points).material as THREE.ShaderMaterial | undefined; if (!m?.uniforms?.col) return;
      m.blending = opt.cyber ? sl.blend : l ? THREE.NormalBlending : dark.blend; m.uniforms.col.value.copy(opt.cyber ? new THREE.Color(sl.col) : l ? mint : dark.col); m.needsUpdate = true; });
    if (opt.cyber) { cm.blending = sl.blend; cm.uniforms.col.value.setHex(sl.col); cm.needsUpdate = true; }
    shadow.material.opacity = l ? 0.07 : 0.35;   // 흰 바탕에서 0.18 은 큰 회색 원으로 보임
    pools.forEach((o) => { o.visible = !l; });
    padNow = null;   // 판이 바뀌면 바닥 표시 색도 다시
  };
  const clock = new THREE.Clock(); let t = 0.35, gpos = { x: 0, z: 0, th: 0 }, raf = 0, lastQ: number[] | null = null;
  function frame() {
    tone();
    const dt = Math.min(0.05, clock.getDelta()); t += dt;
    if (opt.cyber) cm.uniforms.t.value = t;
    if (api.pad !== padNow || (api.pad && !padG)) {
      if (padG) { scene.remove(padG); padG.traverse((o) => { const m = o as THREE.Line; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose(); }); padG = null; }
      padNow = api.pad; if (padNow) { padG = padMesh(padNow, !!lit); scene.add(padG); }
    }
    const d = api.drive;
    if (d) { gpos = flow(gpos, d, dt); gm.uniforms.off.value.set(gpos.x, gpos.z); grid.rotation.y = gpos.th; }
    const q = api.q;
    // 관절값이 바뀐 때만 다시 놓는다(바닥 맞춤은 꼭짓점을 훑으므로 같은 배열이면 건너뜀)
    if (root && !posed && gait && legMode(q, api.down, api.walk) === 'walk') { walkPose(root, joints, gait, t); lastQ = null; }
    else {
      const want = poseQ(q, api.down);
      if (want !== lastQ && root && !posed) { applyQ(root, joints, want); lastQ = want; }
    }
    ctl?.update();
    r.render(scene, cam);
    raf = requestAnimationFrame(frame);
  }
  frame();
  const ray = new THREE.Raycaster();
  api.pick = (x, y) => {
    const W = canvas.clientWidth, H = canvas.clientHeight; if (!root || !W || !H) return null;
    ray.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), cam);
    return jointOf(ray.intersectObject(root, true)[0]?.object ?? null);
  };
  const fit = () => { const W = canvas.clientWidth, H = canvas.clientHeight; if (!W || !H) return; r.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix(); };
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit); ro?.observe(canvas);
  api.dispose = () => {
    live = false; cancelAnimationFrame(raf); ro?.disconnect(); ctl?.dispose();
    scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); ([] as THREE.Material[]).concat(m.material ?? []).forEach((x) => x.dispose()); });
    r.dispose(); r.forceContextLoss();
  };
  return api;
}

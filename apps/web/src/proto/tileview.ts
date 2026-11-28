// 관제 타일 3D: 그리개(WebGL 문맥) 하나로 모든 타일 칸을 차례로 그려 칸마다 2D 캔버스에 옮긴다(타일이 22 대여도 문맥 1 개).
// 칸 하나 = 그 로봇 한 대: 서버 위치가 있으면 시안 3D 현장을 그 로봇 자리 · 방향에 두고 뒤 1 m(또는 정면) 시점, 없으면 시안 타일 그대로 바닥 점 위의 로봇만.
// 빛 · 바닥 점 · 핀 조명 · 그림자 · 시점 값은 시안 go2view.js 그대로. 걷기는 임무 · 조종 중일 때 시안 걷기 기록(go2_walk.json)을 튼다.
import * as THREE from 'three';
import { STAND, ground } from '../screens/u4/go2view';
import { applyDown, applyRest, applyWalk, lightNow, loadGo2, loadSite, loadWalk, toneSite, type Body, type Walk } from './site';

export type TileLook = {
  /** 현장 좌표(site.ts sitePose) · 없으면 현장 없이 */ pose: { x: number; z: number; rot: number } | null;
  /** 정면(뒤집기 · 시뮬) */ front: boolean; /** 시뮬 = 파란 테두리 빛 */ cyber: boolean; walk: boolean; down: boolean;
  /** 부위 색(시안 hot: {FL_calf: 'hot'}) */ hot: Record<string, string>;
  /** 서버 관절 12 개(go2model JOINTS 순서 · 새 값일 때만). 있으면 걷기 기록 대신 이것 */ q?: number[] | null;
  /** 시뮬 영상 칸이 있으면 이것을 먼저 그린다 */ video?: HTMLVideoElement | HTMLCanvasElement | null;
};
type Pose = { x: number; z: number; rot: number };
export type Held = Pose & { travel: number };
type View = { c: HTMLCanvasElement; look: () => TileLook; at: Held | null; ray?: { x: number; z: number; rot: number; front: boolean; k: number } };
/** 서버 위치 · yaw 를 부드럽게 따라감(시안 site3d.js 돌기 곡선: 한 프레임에 남은 차 × dt × 6 · 방향은 짧은 쪽). 5 m 넘게 뛰면(다시 잡힘) 바로 옮김.
 *  travel = 실제로 간 거리 누적(바닥 점이 이만큼 흐름 · 서 있으면 멈춤) */
export function follow(cur: Held | null, to: Pose, dt: number): Held {
  if (!cur || Math.hypot(to.x - cur.x, to.z - cur.z) > 5) return { ...to, travel: cur?.travel ?? 0 };
  const k = Math.min(1, dt * 6), x = cur.x + (to.x - cur.x) * k, z = cur.z + (to.z - cur.z) * k;
  const d = Math.atan2(Math.sin(to.rot - cur.rot), Math.cos(to.rot - cur.rot));
  return { x, z, rot: cur.rot + d * k, travel: cur.travel + Math.hypot(x - cur.x, z - cur.z) };
}
const HOT: Record<string, number> = { warn: 0xf2b705, hot: 0xff4d4f, ok: 0x00c389 }, SIM = 0x4c9bff;
/** 시뮬(cyber) 로봇 재질. 시뮬 칸도 실기 · 데모와 같은 현장 · 따라가기 카메라(팀장 20:49) · 파란 결은 로봇 · 테두리 · 이름표로만.
 *  밝은 판: 흰 땅 위에서 더하기 섞기는 보이지 않아 보통 섞기 · 예행 색 #2F6FE0(u5.css 밝음 1 «예행», .chip.sim · .tile.sim 과 같은 값) */
export const simLook = (light: boolean) => (light ? { blend: THREE.NormalBlending, col: 0x2f6fe0 } : { blend: THREE.AdditiveBlending, col: SIM });
/** 따라가기 카메라 가림(K-08 이 건물 옆이라 뒤 2.1 m 카메라가 벽 안에 들어감): 로봇 머리 → 카메라로 광선 한 번, 현장 물체에 맞으면
 *  맞은 자리 0.15 m 앞으로 당긴다(머리에서 최소 0.6 m). 투명한 것(금지 구역 빨강)은 막지 않음. 돌려주는 값 = 머리 → 카메라 선 위 비율(1 = 그대로) */
const HEAD = new THREE.Vector3(0, 0.3, 0), ray = new THREE.Raycaster();
/** 타일 카메라 거리(시안 go2view): 뒤 따라가기 2.1 m · 정면 1.25 m. 큰 무대 카메라도 이 값을 씀 */
export const REAR_DIST = 2.1, FRONT_DIST = 1.25;
/** 로봇 발밑 그림자(원 반지름 m · 앞뒤 늘림 · 진하기). 로봇 탭 무대도 같은 값 */
export const SHADOW = { r: 0.22, sy: 1.5, opacity: 0.35 };
/** 그릴 층: 현장(임무 중 · 자리 있음 · glb 받음)이면 현장만, 아니면 초록 점 바닥만(현장 바닥 위로 점이 비치지 않게 · 팀장 21:45) */
export const layers = (pose: boolean, site: boolean) => ({ world: pose && site, dots: !(pose && site) });
export function camPull(world: THREE.Object3D, cam: THREE.Vector3) {
  const to = cam.clone().sub(HEAD), len = to.length();
  ray.set(HEAD, to.clone().normalize()); ray.far = len;
  world.updateMatrixWorld(true);
  const hit = ray.intersectObject(world, true).find((h) => !((h.object as THREE.Mesh).material as THREE.Material | undefined)?.transparent);
  return hit ? Math.max(0.6, hit.distance - 0.15) / len : 1;
}
/** 발 끝(종아리 넷)의 가장 낮은 점을 y=0 에 놓는 높이. 몸 전체(7.5 만 꼭짓점) 대신 종아리(1.4 만)만 재어 칸마다 매 판 재도 가볍게 */
export function feetUp(b: Body) {
  b.root.position.y = 0; b.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const L of ['FR', 'FL', 'RR', 'RL']) { const c = b.joints[`${L}_calf`]; if (c) box.expandByObject(c.o, true); }
  return box.isEmpty() ? 0 : -box.min.y;
}
/** 칸 하나의 몸 자세 + 바닥 맞춤(팀장 20:51 «발이 바닥에 묻힌다»: 전에는 높이를 흔들림 값으로 덮어써 모형 높이가 사라졌다).
 *  서버 관절 > 걷기 기록(실제로 움직일 때만) > 엎드림 > 선 자세. 흔들림은 위로만(발이 바닥 아래로 가지 않게) */
export function poseBody(b: Body, look: Pick<TileLook, 'q' | 'walk' | 'down'>, walk: Walk | null, t: number, keep?: Map<string, number>) {
  const at = (k: string, f: () => number) => { let y = keep?.get(k); if (y === undefined) { y = f(); keep?.set(k, y); } b.root.position.y = y; };
  if (look.q && look.q.length === 12) {
    ['FR', 'FL', 'RR', 'RL'].flatMap((l) => ['hip', 'thigh', 'calf'].map((p) => `${l}_${p}`)).forEach((n, i) => { const j = b.joints[n]; if (!j) return; j.o.rotation.copy(j.r0); j.o.rotation[n.endsWith('hip') ? 'z' : 'x'] += look.q![i] - STAND[i]; });
    ground(b.root);   // 서버 자세는 엎드림 · 넘어짐일 수 있어 몸 전체 기준(로봇 탭 go2view 와 같음)
  } else if (look.walk && walk) {
    applyWalk(b, walk, t); b.root.position.y = feetUp(b) + 0.003 * (1 + Math.sin(t * 14));
  } else if (look.down) { applyDown(b); at('down', () => { ground(b.root); return b.root.position.y; }); }
  else { applyRest(b); at('rest', () => feetUp(b)); b.root.position.y += 0.0015 * (1 + Math.sin(t * 2)); }
  b.root.updateMatrixWorld(true);
}

let one: Tiles | null = null;
export const tiles = () => (one ??= new Tiles());

class Tiles {
  views = new Set<View>();
  r: THREE.WebGLRenderer | null = null;
  scene = new THREE.Scene(); cam = new THREE.PerspectiveCamera(30, 1, 0.05, 1200);
  world = new THREE.Group(); body: Body | null = null; walk: Walk | null = null; cyber: THREE.ShaderMaterial | null = null;
  grid!: THREE.Points; gm!: THREE.ShaderMaterial; shadow!: THREE.Mesh; site: THREE.Group | null = null;
  t = 0.35; last = 0; raf = 0; failed = false; hemi!: THREE.HemisphereLight; rims: [THREE.DirectionalLight, number, number][] = [];

  add(c: HTMLCanvasElement, look: () => TileLook) {
    const v: View = { c, look, at: null }; this.views.add(v); this.start();
    return () => { this.views.delete(v); if (!this.views.size) { cancelAnimationFrame(this.raf); this.raf = 0; } };
  }
  private start() {
    if (this.raf || this.failed) return;
    if (!this.r) {
      try { this.r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); }
      catch { this.failed = true; return; }   // WebGL 없음: 칸은 시안 바탕만
      this.r.outputColorSpace = THREE.SRGBColorSpace; this.r.toneMapping = THREE.ACESFilmicToneMapping; this.r.toneMappingExposure = 1.05;
      this.build();
    }
    this.last = performance.now();
    const f = (now: number) => { this.frame(now); this.raf = requestAnimationFrame(f); };
    this.raf = requestAnimationFrame(f);
  }
  private build() {
    const s = this.scene;
    this.hemi = new THREE.HemisphereLight(0xdfe8f0, 0x0c0f14, 0.9); s.add(this.hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.2, 2, 1.6); s.add(key);
    const rim = new THREE.DirectionalLight(0x00c389, 1.6); rim.position.set(-1.5, 1.2, -1.8); s.add(rim); this.rims.push([rim, 1.6, 0x00c389]);
    const rim2 = new THREE.DirectionalLight(0x4c9bff, 0.8); rim2.position.set(1.6, 0.6, -1.4); s.add(rim2); this.rims.push([rim2, 0.8, 0x4c9bff]);
    // 바닥 점(시안 glow · floor 0.5)
    const N = 44, step = 0.09, pts = new Float32Array(N * N * 3), half = (N * step / 2).toFixed(3), all = (N * step).toFixed(3);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const k = (i * N + j) * 3; pts[k] = (i - N / 2) * step; pts[k + 2] = (j - N / 2) * step; }
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const vs = (size: string) => `uniform float off; varying float a; void main(){ vec3 p=position; p.z=mod(p.z+off+${half},${all})-${half}; a=1.0-smoothstep(0.35,1.9,length(p.xz)); gl_PointSize=${size}; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);} `;
    this.gm = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { off: { value: 0 }, col: { value: new THREE.Color(0x00c389).lerp(new THREE.Color(0xffffff), 0.4) } },
      vertexShader: vs('2.6'), fragmentShader: 'uniform vec3 col; varying float a; void main(){ vec2 c=gl_PointCoord-0.5; if(length(c)>0.5) discard; gl_FragColor=vec4(col,a*1.0*0.50);} ' });
    this.grid = new THREE.Points(gg, this.gm); s.add(this.grid);
    const hm = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { off: this.gm.uniforms.off, col: { value: this.gm.uniforms.col.value.clone() } },
      vertexShader: vs('10.0'), fragmentShader: 'uniform vec3 col; varying float a; void main(){ float d=length(gl_PointCoord-0.5)*2.0; if(d>1.0) discard; gl_FragColor=vec4(col,a*0.5*0.50*(1.0-d)*(1.0-d));} ' });
    this.grid.add(new THREE.Points(gg, hm));
    // 핀 조명 + 빛 웅덩이(시안 pin)
    const pin = new THREE.SpotLight(0xf4f7ff, 6.0, 0, 0.24, 0.65, 0); pin.position.set(0.25, 2.3, 1.0); pin.target.position.set(0, 0.2, 0); s.add(pin, pin.target);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(0.6, 64), new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 u; void main(){ u=position.xy/0.6; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader: 'varying vec2 u; void main(){ float d=clamp(length(u),0.0,1.0); float a=(1.0-d)*(1.0-d); gl_FragColor=vec4(0.85,0.9,1.0,0.13*a);} ' }));
    pool.rotation.x = -Math.PI / 2; pool.position.y = 0.0005; pool.renderOrder = -1; s.add(pool);
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(SHADOW.r, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: SHADOW.opacity }));
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = 0.001; this.shadow.scale.set(1, SHADOW.sy, 1); s.add(this.shadow);
    s.add(this.world);
    this.cyber = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { col: { value: new THREE.Color(SIM) }, t: { value: 0 } },
      vertexShader: 'varying vec3 n; varying vec3 v; varying float y; void main(){ vec4 w=modelMatrix*vec4(position,1.0); y=w.y; n=normalize(normalMatrix*normal); vec4 mv=viewMatrix*w; v=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'uniform vec3 col; uniform float t; varying vec3 n; varying vec3 v; varying float y; void main(){ float f=pow(1.0-abs(dot(normalize(n),normalize(v))),2.2); float sl=0.5+0.5*step(0.5,fract(y*140.0-t*0.6)); gl_FragColor=vec4(col*(0.18+1.25*f)*sl, 0.14+0.7*f); }' });
    loadGo2().then((b) => { if (b) { this.body = b; s.add(b.root); } });
    loadWalk().then((w) => { this.walk = w; });
    loadSite().then((g) => { if (g) { this.site = g; this.world.add(g); } });
  }
  private paint(b: Body, look: TileLook) {
    b.root.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      if (look.cyber) { m.material = this.cyber!; return; }
      if (m.material === this.cyber) m.material = (m.userData.own ??= (m.userData.c0 && new THREE.MeshStandardMaterial({ color: m.userData.c0 }))) as THREE.Material;
      const mat = m.material as THREE.MeshStandardMaterial; if (!m.userData.own) m.userData.own = mat;
      mat.color.copy(m.userData.c0); mat.emissive?.setHex(0x000000);
    });
    if (look.cyber) return;
    for (const [name, lvl] of Object.entries(look.hot)) {
      const n = b.root.getObjectByName(name); if (!n) continue;
      n.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return;
        if (m.parent === n || o === n || !/_(hip|thigh|calf)$/.test(m.parent?.name || '')) { const mat = m.material as THREE.MeshStandardMaterial; mat.color.setHex(HOT[lvl] ?? 0xffffff); if (mat.emissive) { mat.emissive.setHex(HOT[lvl] ?? 0); mat.emissiveIntensity = 0.25; } } });
    }
  }
  private drawn = 0; private keep = new Map<string, number>();
  private frame(now: number) {
    if (now - this.drawn < 50) return;   // 칸이 많아도 초당 20 번까지
    this.drawn = now;
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.t += dt;
    const r = this.r!, b = this.body;
    if (this.cyber) { const k = simLook(lightNow()); this.cyber.uniforms.t.value = this.t; this.cyber.blending = k.blend; this.cyber.uniforms.col.value.setHex(k.col); }
    // 밝은 판: 현장 재질 · 땅 쪽 빛을 밝음 1 흰 점토 결로(타일 바탕은 u5.css .proto.light .cv)
    const light = lightNow(); this.hemi.groundColor.setHex(light ? 0xc8cfcb : 0x0c0f14);
    // 밝은 판: 민트 · 파랑 테두리 빛은 흰 빛으로 바꿔(벽이 물들지 않게) 카메라 쪽 면을 밝히고, 하늘 빛을 올려 흰 점토가 검게 죽지 않게
    this.hemi.intensity = light ? 2.4 : 0.9;
    for (const [l, k, c] of this.rims) { l.color.setHex(light ? 0xffffff : c); l.intensity = light ? k * 0.7 : k; } if (this.site) toneSite(this.site, light);
    for (const v of this.views) {
      const w = v.c.clientWidth, h = v.c.clientHeight;
      if (!w || !h) continue;
      const look = v.look(), dpr = Math.min(2, devicePixelRatio || 1);
      if (v.c.width !== Math.round(w * dpr)) { v.c.width = Math.round(w * dpr); v.c.height = Math.round(h * dpr); }
      const ctx = v.c.getContext('2d'); if (!ctx) continue;
      if (look.video && (('videoWidth' in look.video && look.video.videoWidth) || ('width' in look.video && !('videoWidth' in look.video) && look.video.width))) {
        ctx.drawImage(look.video, 0, 0, v.c.width, v.c.height); continue;   // 시뮬 영상이 오면 그것을 먼저
      }
      r.setPixelRatio(dpr); r.setSize(w, h, false);
      // 시점: 시안 go2view (뒤 = yaw π · 2.1 m · 높이 0.55, 정면 = yaw 0 · 1.25 m). 현장은 로봇 자리 · 방향의 반대로 옮겨 로봇이 늘 가운데
      const yaw = look.front ? 0 : Math.PI, dist = look.front ? FRONT_DIST : REAR_DIST;
      this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
      this.cam.position.set(Math.sin(yaw) * dist, 0.55, Math.cos(yaw) * dist); this.cam.lookAt(0, 0.17, 0);
      // 현장 = 그 로봇 지도 안 실제 자리 · 방향(서버 위치 · yaw 를 보간). 로봇은 늘 가운데 · 시점은 뒤쪽 위 그대로라 걷고 돌면 현장이 지나가고 돈다
      v.at = look.pose ? follow(v.at, look.pose, dt) : null;
      const p = v.at;
      const ly = layers(!!p, !!this.site); this.world.visible = ly.world; this.grid.visible = ly.dots;
      if (p) { this.world.rotation.set(0, -p.rot, 0); this.world.position.set(0, 0, 0); this.world.updateMatrix();
        const off = new THREE.Vector3(-p.x, 0, -p.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -p.rot); this.world.position.copy(off);
        // 가림 광선은 로봇이 0.2 m(또는 0.2 rad) 넘게 움직였거나 시점이 바뀌었을 때만 다시 쏜다(매 판 쏘지 않음)
        const q = v.ray;
        if (this.site && (!q || q.front !== look.front || Math.hypot(p.x - q.x, p.z - q.z) > 0.2 || Math.abs(Math.atan2(Math.sin(p.rot - q.rot), Math.cos(p.rot - q.rot))) > 0.2))
          v.ray = { x: p.x, z: p.z, rot: p.rot, front: look.front, k: camPull(this.world, this.cam.position) };
        const k = v.ray?.k ?? 1;
        if (k < 1) { this.cam.position.sub(HEAD).multiplyScalar(k).add(HEAD); this.cam.lookAt(0, 0.17, 0); }
      } else v.ray = undefined;
      this.gm.uniforms.col.value.setHex(look.cyber ? SIM : 0x00c389).lerp(new THREE.Color(0xffffff), 0.4);
      this.gm.uniforms.off.value = p ? -p.travel : look.walk ? -this.t * 0.45 : 0;   // 자리가 있으면 실제로 간 거리만큼, 없으면 시안 걷기 흐름
      this.shadow.visible = !look.cyber;
      if (b) {
        this.paint(b, look);
        poseBody(b, look, this.walk, this.t, this.keep);   // 엎드림은 로봇 탭과 같은 바닥 맞춤(go2view ground · 꼭짓점 기준 최저점 y = 0)
      }
      r.setClearColor(0x000000, 0); r.clear();
      r.render(this.scene, this.cam);
      ctx.clearRect(0, 0, v.c.width, v.c.height); ctx.drawImage(r.domElement, 0, 0, v.c.width, v.c.height);
    }
  }
}

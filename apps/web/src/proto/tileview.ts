// 관제 타일 3D: 그리개(WebGL 문맥) 하나로 모든 타일 칸을 차례로 그려 칸마다 2D 캔버스에 옮긴다(타일이 22 대여도 문맥 1 개).
// 칸 하나 = 그 로봇 한 대: 서버 위치가 있으면 시안 3D 현장을 그 로봇 자리 · 방향에 두고 뒤 1 m(또는 정면) 시점, 없으면 시안 타일 그대로 바닥 점 위의 로봇만.
// 빛 · 바닥 점 · 핀 조명 · 그림자 · 시점 값은 시안 go2view.js 그대로. 걷기는 임무 · 조종 중일 때 시안 걷기 기록(go2_walk.json)을 튼다.
import * as THREE from 'three';
import { applyDown, applyRest, applyWalk, lightNow, loadGo2, loadSite, loadWalk, toneSite, type Body, type Walk } from './site';

export type TileLook = {
  /** 현장 좌표(site.ts sitePose) · 없으면 현장 없이 */ pose: { x: number; z: number; rot: number } | null;
  /** 정면(뒤집기 · 시뮬) */ front: boolean; /** 시뮬 = 파란 테두리 빛 */ cyber: boolean; walk: boolean; down: boolean;
  /** 부위 색(시안 hot: {FL_calf: 'hot'}) */ hot: Record<string, string>;
  /** 시뮬 영상 칸이 있으면 이것을 먼저 그린다 */ video?: HTMLVideoElement | HTMLCanvasElement | null;
};
type View = { c: HTMLCanvasElement; look: () => TileLook };
const HOT: Record<string, number> = { warn: 0xf2b705, hot: 0xff4d4f, ok: 0x00c389 }, SIM = 0x4c9bff;

let one: Tiles | null = null;
export const tiles = () => (one ??= new Tiles());

class Tiles {
  views = new Set<View>();
  r: THREE.WebGLRenderer | null = null;
  scene = new THREE.Scene(); cam = new THREE.PerspectiveCamera(30, 1, 0.05, 1200);
  world = new THREE.Group(); body: Body | null = null; walk: Walk | null = null; cyber: THREE.ShaderMaterial | null = null;
  grid!: THREE.Points; gm!: THREE.ShaderMaterial; shadow!: THREE.Mesh; site: THREE.Group | null = null;
  t = 0.35; last = 0; raf = 0; failed = false; hemi!: THREE.HemisphereLight;

  add(c: HTMLCanvasElement, look: () => TileLook) {
    const v = { c, look }; this.views.add(v); this.start();
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
    const rim = new THREE.DirectionalLight(0x00c389, 1.6); rim.position.set(-1.5, 1.2, -1.8); s.add(rim);
    const rim2 = new THREE.DirectionalLight(0x4c9bff, 0.8); rim2.position.set(1.6, 0.6, -1.4); s.add(rim2);
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
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.22, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = 0.001; this.shadow.scale.set(1, 1.5, 1); s.add(this.shadow);
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
  private drawn = 0;
  private frame(now: number) {
    if (now - this.drawn < 50) return;   // 칸이 많아도 초당 20 번까지
    this.drawn = now;
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.t += dt;
    const r = this.r!, b = this.body;
    if (this.cyber) this.cyber.uniforms.t.value = this.t;
    // 밝은 판: 현장 재질 · 땅 쪽 빛을 밝음 1 흰 점토 결로(타일 바탕은 u5.css .proto.light .cv)
    const light = lightNow(); this.hemi.groundColor.setHex(light ? 0xc8cfcb : 0x0c0f14); if (this.site) toneSite(this.site, light);
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
      const yaw = look.front ? 0 : Math.PI, dist = look.front ? 1.25 : 2.1;
      this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
      this.cam.position.set(Math.sin(yaw) * dist, 0.55, Math.cos(yaw) * dist); this.cam.lookAt(0, 0.17, 0);
      const p = look.pose;
      this.world.visible = !!(p && this.site);
      if (p) { this.world.rotation.set(0, -p.rot, 0); this.world.position.set(0, 0, 0); this.world.updateMatrix();
        const off = new THREE.Vector3(-p.x, 0, -p.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -p.rot); this.world.position.copy(off); }
      this.gm.uniforms.col.value.setHex(look.cyber ? SIM : 0x00c389).lerp(new THREE.Color(0xffffff), 0.4);
      this.gm.uniforms.off.value = look.walk ? -this.t * 0.45 : 0;
      this.shadow.visible = !look.cyber;
      if (b) {
        this.paint(b, look);
        if (look.walk && this.walk) { applyWalk(b, this.walk, this.t); b.root.position.y = 0.006 * Math.sin(this.t * 14); }
        else if (look.down) {   // 시안 pose 'down': 접은 뒤 다시 바닥에 붙이고 흔들지 않음
          applyDown(b); b.root.position.y = 0; b.root.updateMatrixWorld(true);
          b.root.position.y = -new THREE.Box3().setFromObject(b.root).min.y;
        } else { applyRest(b); b.root.position.y = 0.003 * Math.sin(this.t * 2); }
      }
      r.setClearColor(0x000000, 0); r.clear();
      r.render(this.scene, this.cam);
      ctx.clearRect(0, 0, v.c.width, v.c.height); ctx.drawImage(r.domElement, 0, 0, v.c.width, v.c.height);
    }
  }
}

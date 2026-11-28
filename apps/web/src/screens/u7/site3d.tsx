// 지도 탭 데모 현장 3D (시안 u7_1 미리 보기 「3D 보기 · 미리 보기」 · u7_4 「3D 보기」).
// 모형 = 시안 공장 GLB(proto/site.ts SITE_GLB · 저장소 밖 /proto-assets 자산), 좌표 = 로봇 탭 · 관제와 같은 현장 m(x 동 · y 위 · z 남, toMapPx).
// 색 · 빛 · 카메라는 시안 그림을 구운 build_scene.py 값 그대로(흰 점토 재질 · 해 기울기 50° 방위 140° · 높이각 37° 방위 -12° · 렌즈 70/50 mm).
// 캔버스는 마운트마다 새 렌더러가 만든 것을 쓰고 거둘 때 지운다(같은 캔버스에 렌더러를 다시 붙이면 forceContextLoss 뒤라 흰 칸이 된다 · 7c07a9b7).
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET, K, OX, OY, SITE_GLB } from '../../proto/site';

/** 시안 3D 그림의 위에서 본 그림(작은 지도) */
export const FACTORY_TOP = `${ASSET}/shared/map_large_factory_top.jpg`;
/** build_scene.py MATS (재질 이름 = GLB 재질 이름, fk_ 뗌) */
export const CLAY: Record<string, string> = {
  road: '#d7cfcc', pave: '#ece4e0', dikefloor: '#e0d8d4', wall: '#f0eae7', building: '#f5f0ee', tank: '#f6f1ef', tankroof: '#ece5e1',
  equip: '#f1ece9', steel: '#d9d8d8', pipe: '#dcdcdd', water: '#d3d6d8', nogo_post: '#e0483f',
};
const GROUND = '#e6dcd8', SKY = '#d9d3d0', NOGO = '#e0483f';
const SITE_W = 3200 / K, SITE_H = 2000 / K;   // 공장 그림 전체(m)

type View = 'iso' | 'k01';
/** 시안 카메라(build_scene.py look_cam): 대상(현장 m) · 거리 · 렌즈(36 mm 가로 기준). iso 는 단지 폭(916 m)이 가로에 꽉 차게(fit_cam) */
const CAM: Record<View, { at: [number, number]; dist: number; lens: number }> = {
  iso: { at: [450, 280], dist: (458 / (18 / 70)) * 1.06, lens: 70 },
  k01: { at: [(1720 - OX) / K, (976 - OY) / K], dist: 330, lens: 50 },
};
const EL = (37 * Math.PI) / 180, AZ = (-12 * Math.PI) / 180;
/** 카메라 자리 · 대상 · 세로 시야각(three 는 세로 fov). 시험이 시안 값과 맞춰 본다 */
export function camOf(view: View, aspect: number) {
  const c = CAM[view], d = c.dist;
  const pos: [number, number, number] = [c.at[0] + Math.sin(AZ) * Math.cos(EL) * d, Math.sin(EL) * d, c.at[1] + Math.cos(AZ) * Math.cos(EL) * d];
  const fov = (2 * Math.atan(18 / c.lens / Math.max(aspect, 0.1)) * 180) / Math.PI;
  return { pos, at: [c.at[0], 0, c.at[1]] as [number, number, number], fov };
}
/** 해 방향(빛 쪽 단위 벡터): Blender 해(기울기 50° · 방위 140°)를 three 좌표(x, z_b, -y_b)로 */
const SUN = new THREE.Vector3(0.492, 0.643, -0.587).normalize();

let srcP: Promise<THREE.Group | null> | null = null;
/** 모형 원본(한 번 받음). 마운트마다 clone — 형상은 같이 쓰므로 거둘 때 형상은 지우지 않는다 */
const source = () => (srcP ??= new Promise((res) => new GLTFLoader().load(SITE_GLB, (g) => res(g.scene), undefined, () => { srcP = null; res(null); })));

/** 시안 재질 입히기. 금지 구역 = 붉은 바닥(옅게) · 울타리 · 기둥 */
export function dress(site: THREE.Object3D) {
  site.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = ((m.material as THREE.Material)?.name || m.name).replace(/^fk_/, '');
    m.userData.nogo = name.startsWith('nogo');
    m.material = name === 'nogo_floor' ? new THREE.MeshBasicMaterial({ color: NOGO, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
      : name === 'nogo_fence' ? new THREE.MeshBasicMaterial({ color: NOGO, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: CLAY[name] ?? CLAY.building, roughness: 0.85, metalness: 0 });
    m.castShadow = !name.startsWith('nogo'); m.receiveShadow = true;
  });
  return site;
}

type Rig = { draw: () => void; home: () => void; eye: () => void; nogo: (on: boolean) => void; dispose: () => void };

/** preview = 미리 보기(시안 u7_1 · 단지 전체 · 돌리기만) · 아니면 층 화면 3D(시안 u7_4 · K-01 둘레 · 작은 지도 · 안내 줄 · 로봇 눈높이) */
export function DemoSite3D({ preview, nogo = true }: { preview?: boolean; nogo?: boolean }) {
  const host = useRef<HTMLDivElement>(null), rig = useRef<Rig | null>(null);
  const [at, setAt] = useState<'wait' | 'ok' | 'bad' | 'nogl'>('wait'), [n, setN] = useState(0);
  const [box, setBox] = useState<[number, number, number, number] | null>(null);   // 작은 지도 속 보이는 땅(0~1 · 왼 · 위 · 폭 · 높이)

  useEffect(() => {
    let live = true, done: Rig | null = null;
    setAt('wait');
    source().then((src) => {
      if (!live) return;
      if (!src) { setAt('bad'); return; }
      let gl: THREE.WebGLRenderer;
      try { gl = new THREE.WebGLRenderer({ antialias: true }); } catch { setAt('nogl'); return; }
      const el = host.current!, canvas = gl.domElement;
      gl.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      gl.outputColorSpace = THREE.SRGBColorSpace;
      gl.shadowMap.enabled = true; gl.shadowMap.type = THREE.PCFSoftShadowMap;
      el.prepend(canvas);
      const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, 1, 0.3, 8000);
      scene.background = new THREE.Color(SKY);
      scene.fog = new THREE.Fog(SKY, 2200, 5200);
      const site = dress(src.clone(true));
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1 }));
      ground.rotation.x = -Math.PI / 2; ground.position.set(SITE_W / 2 - OX / K, -0.05, SITE_H / 2 - OY / K); ground.receiveShadow = true;
      const hemi = new THREE.HemisphereLight(0xffffff, 0xcfc6c2, 1.5), sun = new THREE.DirectionalLight(0xfffbf5, 2.3);
      sun.position.set(450 + SUN.x * 1500, SUN.y * 1500, 280 + SUN.z * 1500); sun.target.position.set(450, 0, 280);
      sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004;
      Object.assign(sun.shadow.camera, { left: -620, right: 620, top: 620, bottom: -620, near: 10, far: 4000 });
      scene.add(site, ground, hemi, sun, sun.target);
      const orbit = new OrbitControls(cam, canvas);
      orbit.maxPolarAngle = Math.PI / 2 - 0.01; orbit.minDistance = 1; orbit.maxDistance = 4000; orbit.enableRotate = true; orbit.enablePan = !preview; orbit.enableZoom = !preview;
      const ray = new THREE.Raycaster(), floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
      /** 화면 네 모서리 시선이 땅에 닿는 자리 → 작은 지도 칸(지평선 위 시선은 단지 끝으로) */
      const seen = () => {
        const xs: number[] = [], zs: number[] = [];
        for (const [u, w] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          ray.setFromCamera(new THREE.Vector2(u, w), cam);
          if (ray.ray.intersectPlane(floor, hit)) { xs.push(hit.x); zs.push(hit.z); } else { xs.push(u < 0 ? -OX / K : SITE_W); zs.push(-OY / K); }
        }
        const px = (x: number) => Math.min(1, Math.max(0, (x * K + OX) / 3200)), py = (z: number) => Math.min(1, Math.max(0, (z * K + OY) / 2000));
        const l = px(Math.min(...xs)), r = px(Math.max(...xs)), t = py(Math.min(...zs)), b = py(Math.max(...zs));
        setBox([l, t, r - l, b - t]);
      };
      const draw = () => { gl.render(scene, cam); if (!preview) seen(); };
      const put = (v: View) => { const w = el.clientWidth || 1, h = el.clientHeight || 1, c = camOf(v, w / h); cam.fov = c.fov; cam.position.set(...c.pos); orbit.target.set(...c.at); cam.updateProjectionMatrix(); orbit.update(); draw(); };
      const home = () => put(preview ? 'iso' : 'k01');
      const eye = () => {   // 로봇 눈높이: 지금 보는 곳(대상) 앞 6 m · 높이 0.45 m(Go2 앞 카메라 높이 쯤)에서 대상 쪽으로
        const t = orbit.target.clone(), d = cam.position.clone().sub(t).setY(0).normalize();
        t.y = 0.4; cam.position.set(t.x + d.x * 6, 0.45, t.z + d.z * 6); orbit.target.copy(t); cam.fov = 60; cam.updateProjectionMatrix(); orbit.update(); draw();
      };
      orbit.addEventListener('change', draw);
      const fit = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; gl.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); draw(); };
      const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
      ro?.observe(el);
      done = {
        draw, home, eye,
        nogo: (on) => { site.traverse((o) => { if (o.userData.nogo) o.visible = on; }); draw(); },
        dispose: () => {
          ro?.disconnect(); orbit.dispose();
          site.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) (m.material as THREE.Material).dispose(); });   // 형상은 원본과 같이 씀
          ground.geometry.dispose(); (ground.material as THREE.Material).dispose();
          gl.dispose(); gl.forceContextLoss(); canvas.remove();
        },
      };
      rig.current = done;
      fit(); home(); setAt('ok');
    });
    return () => { live = false; done?.dispose(); rig.current = null; };
  }, [n, preview]);
  useEffect(() => { if (at === 'ok') rig.current?.nogo(nogo); }, [at, nogo]);

  return <div className={`vx mp-3d${preview ? ' pre' : ''}`} data-site3d={preview ? 'preview' : 'view'}>
    <div ref={host} className="vx-3d" role={preview ? 'img' : 'application'} aria-label={preview ? '3D 미리 보기' : '3D 보기 · 끌어서 회전, 오른쪽 버튼 끌어 이동, 휠로 확대'} tabIndex={preview ? undefined : 0} />
    {!preview && at === 'ok' && <>
      <div className="mp-hint3" role="group" aria-label="3D 다루기"><span>끌어서 회전</span><span>오른쪽 버튼 끌어 이동</span><span>휠로 확대</span>
        <button type="button" data-eye onClick={() => rig.current?.eye()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.8" /></svg>로봇 눈높이</button></div>
      <div className="mp-mini3" aria-label="작은 지도 · 보이는 곳"><img src={FACTORY_TOP} alt="" />
        {box && <i data-seen style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%` }} />}</div></>}
    <div className="vx-over">
      {at === 'wait' && <p className="lv-note" role="status" data-site3d-wait>3D 모형을 불러오는 중…</p>}
      {at === 'nogl' && <p className="lv-note" role="alert">이 브라우저에서는 3D 화면을 볼 수 없습니다. «2D 보기» 로 보세요.</p>}
      {at === 'bad' && <div className="fh-row" data-site3d-bad><p className="fh-msg" role="alert">3D 모형을 불러오지 못했습니다. 다시 불러오세요.</p>
        <button type="button" className="btn" onClick={() => setN(n + 1)}>다시 불러오기</button></div>}
    </div>
  </div>;
}

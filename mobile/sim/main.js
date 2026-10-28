// 앱 안 오프라인 시뮬(RS-6 창고 브라우저 시뮬을 옮김): 창고 f1 안에서 Go2 를 두 막대로 걷게 한다. 서버·인터넷 없이 앱 번들(www/sim)만 읽는다.
// 지도 = ?map=<이름>(maps.json 목록 안, [a-z0-9-] 만 — 없거나 틀리면 warehouse) → assets/<이름>/ 의 scene.json·map.json·<이름>.xml.
// 물리 = MuJoCo wasm(창고 충돌체 + Go2), 그림 = three.js, 정책 = foothold-v2 파생(sim.js 순수 JS 추론), 라이다 = mj_multiRay 360줄 10 Hz.
// RS-6 에서 바뀐 것: 보이는 글자 0(아이콘·색만) · STOP 은 «다시 시작» 아이콘으로만 풀림(막대를 만져도 안 풀림) · 앱 숨김·화면 꺼짐 = STOP
// · 막대 밖 한 손가락 끌기 = 카메라 돌리기, 두 손가락 = 확대·축소. 정책·물리 값은 그대로(sim.js·lidar.js 는 RS-6 복사본).
import * as THREE from './vendor/three.module.js';
import load from './mujoco/mujoco.js';
import { createSim, loadPolicy, ISAAC_LIKE, POLICY_DT } from './sim.js';
import { makeLidar, decodeMap } from './lidar.js';

const $ = (id) => document.getElementById(id);
const MESHES = ['base_0', 'base_1', 'base_2', 'base_3', 'base_4', 'hip_0', 'hip_1', 'thigh_0', 'thigh_1', 'thigh_mirror_0',
  'thigh_mirror_1', 'calf_0', 'calf_1', 'calf_mirror_0', 'calf_mirror_1', 'foot'];
const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u} ${r.status}`); return r; };
const bytes = async (u) => new Uint8Array(await (await get(u)).arrayBuffer());
const json = async (u) => (await get(u)).json();
const st = (window.__sim = { ready: false, err: null });   // 시험용(headless) — 화면에는 안 보임

// ── STOP 잠금: 명령 0. «다시 시작»(#go)만 푼다. 잡고 있던 막대 손가락도 놓게 해서 풀린 뒤엔 새로 누른 손가락만 명령이 된다
let joy = [0, 0, 0], stopped = true, sim = null, ready = false;
const sticks = [];
function lock() {
  stopped = true; joy = [0, 0, 0];
  if (sim) sim.cmd = [0, 0, 0];
  sticks.forEach((s) => s.release());
  ui();
}
function ui() {
  document.body.classList.toggle('stopped', stopped);
  $('stop').setAttribute('aria-pressed', String(stopped));
  $('go').hidden = !stopped || !ready;
}
$('stop').addEventListener('pointerdown', lock);   // 누르는 순간(click 은 손을 뗄 때라 늦다)
$('stop').onclick = lock;                            // 키보드·읽어 주기
$('go').onclick = () => { if (!ready) return; sticks.forEach((s) => s.release()); stopped = false; ui(); };
document.addEventListener('visibilitychange', () => { if (document.hidden) lock(); });   // 앱 숨김·화면 꺼짐
for (const ev of ['pagehide', 'freeze', 'blur']) addEventListener(ev, lock);
// 집: 서버 화면(«시뮬 열기», ?from=server)에서 왔으면 뒤로 = 그 서버 화면(RemoteClient 가 /sim/ 에서는 고른 서버를 잊지 않음), 아니면 시작 화면
const fromServer = new URLSearchParams(location.search).get('from') === 'server' && history.length > 1;
$('home').onclick = () => { lock(); if (fromServer) history.back(); else location.href = '../index.html'; };
addEventListener('contextmenu', (e) => e.preventDefault());

// ── 막대 두 개(RS-5 배치): 왼쪽 위·아래 = vx ±1, 좌우 = vy ±0.5 / 오른쪽 좌우 = wz ±1. 학습 범위 밖은 자르지 않고 테두리 색으로만 알림
function stick(el, set) {
  const knob = el.querySelector('b');
  let id = null;
  const release = () => { if (id !== null && el.hasPointerCapture(id)) el.releasePointerCapture(id); id = null; knob.style.transform = ''; set(0, 0); };
  const move = (e) => {
    const r = el.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const n = Math.hypot(x, y);
    if (n > 1) { x /= n; y /= n; }
    knob.style.transform = `translate(${x * R * 0.7}px, ${y * R * 0.7}px)`;
    set(x, y);
  };
  el.addEventListener('pointerdown', (e) => { if (stopped || id !== null) return; id = e.pointerId; el.setPointerCapture(id); move(e); });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === id && !stopped) move(e); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, (e) => { if (e.pointerId === id) release(); });
  sticks.push({ release });
}
const r2 = (v) => +v.toFixed(2) || 0; // −0 → 0
stick($('stickL'), (x, y) => { joy[0] = r2(-y); joy[1] = r2(-x * 0.5); });
stick($('stickR'), (x) => { joy[2] = r2(-x); });
const inRange = (c) => (c[0] === 0 || (c[0] >= 0.4 && c[0] <= 1.5)) && c[1] === 0 && Math.abs(c[2]) <= 1;

try {
  await main();
} catch (e) {
  st.err = String(e?.stack || e);
  console.error(e);
  $('busy').hidden = true; $('fail').hidden = false;
}

async function main() {
  const q = new URLSearchParams(location.search).get('map') ?? '', maps = await json('maps.json');
  const id = /^[a-z0-9-]+$/.test(q) && maps.some((x) => x.id === q) ? q : 'warehouse', dir = `assets/${id}`;
  const [mj, sceneJ, mapJ, polBuf] = await Promise.all([load(), json(`${dir}/scene.json`), json(`${dir}/map.json`),
    get('policy_v2.f32').then((r) => r.arrayBuffer())]);
  const map = decodeMap(mapJ);
  mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
  await Promise.all([
    bytes('assets/unitree_go2/go2.xml').then((b) => mj.FS.writeFile('/go2/go2.xml', b)),
    bytes(`${dir}/${id}.xml`).then((b) => mj.FS.writeFile('/go2/world.xml', b)),
    ...MESHES.map(async (f) => mj.FS.writeFile(`/go2/assets/${f}.obj`, await bytes(`assets/unitree_go2/assets/${f}.obj`))),
  ]);
  mj.FS.writeFile('/go2/scene.xml', `<mujoco model="go2 ${id}"><include file="go2.xml"/><include file="world.xml"/></mujoco>`);
  sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, loadPolicy(polBuf), { floorZ: map.floor_z, spawn: map.spawn_xyyaw });
  const { m, d } = sim;
  const lidar = makeLidar(mj, m, d, 360);

  // ── three.js: Z-up
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const cv = renderer.domElement;
  document.body.prepend(cv);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171c);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 80);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-4, -6, 10);
  scene.add(sun);
  const resize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize);
  resize();

  // 창고: scene.json 의 메시를 모델 자세에 놓는다. quat 은 w,x,y,z
  const geoCache = {};
  for (const md of sceneJ.models) {
    let geo = geoCache[md.mesh];
    if (!geo) {
      const src = sceneJ.meshes[md.mesh];
      geo = geoCache[md.mesh] = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(src.p, 3));
      geo.setIndex(src.i);
      geo.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: new THREE.Color(...md.color), side: THREE.DoubleSide }));
    mesh.position.set(...md.pos);
    mesh.quaternion.set(md.quat[1], md.quat[2], md.quat[3], md.quat[0]);
    scene.add(mesh);
  }

  // 정답 지도(f1.png) 판: 점유 칸만 빨갛게, 위에서 보기 때만. DataTexture 행 0 = 아래라서 위아래를 뒤집는다
  const tex = new Uint8Array(map.w * map.h * 4);
  for (let r = 0; r < map.h; r++) for (let c = 0; c < map.w; c++) {
    const v = map.px[r * map.w + c], o = ((map.h - 1 - r) * map.w + c) * 4;
    if (v === 0) tex.set([255, 60, 60, 150], o); else if (v === 205) tex.set([120, 120, 140, 90], o);
  }
  const mapTex = new THREE.DataTexture(tex, map.w, map.h);
  mapTex.magFilter = THREE.NearestFilter; mapTex.needsUpdate = true;
  const mapPlane = new THREE.Mesh(new THREE.PlaneGeometry(map.w * map.res, map.h * map.res),
    new THREE.MeshBasicMaterial({ map: mapTex, transparent: true, depthWrite: false }));
  mapPlane.position.set(map.origin[0] + (map.w * map.res) / 2, map.origin[1] + (map.h * map.res) / 2, map.floor_z + 0.02);
  mapPlane.visible = false;
  scene.add(mapPlane);

  // Go2: 컴파일된 메시(group 2)를 geom 마다 그린다
  const geoms = [], meshGeo = new Map();
  for (let g = 0; g < m.ngeom; g++) {
    if (m.geom_group[g] !== 2 || m.geom_dataid[g] < 0) continue;
    const id = m.geom_dataid[g];
    if (!meshGeo.has(id)) {
      const va = m.mesh_vertadr[id], vn = m.mesh_vertnum[id], fa = m.mesh_faceadr[id], fn = m.mesh_facenum[id];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.mesh_vert.slice(va * 3, (va + vn) * 3), 3));
      geo.setIndex(Array.from(m.mesh_face.slice(fa * 3, (fa + fn) * 3)));
      geo.computeVertexNormals();
      meshGeo.set(id, geo);
    }
    const mat = m.geom_matid[g], c = mat >= 0 ? m.mat_rgba.slice(mat * 4, mat * 4 + 3) : m.geom_rgba.slice(g * 4, g * 4 + 3);
    const mesh = new THREE.Mesh(meshGeo.get(id), new THREE.MeshLambertMaterial({ color: new THREE.Color(c[0], c[1], c[2]).multiplyScalar(0.85).addScalar(0.08) }));
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    geoms.push([g, mesh]);
  }
  const draw = () => {
    const p = d.geom_xpos, R = d.geom_xmat;
    for (const [g, mesh] of geoms) {
      const r = g * 9, o = g * 3;
      mesh.matrix.set(R[r], R[r + 1], R[r + 2], p[o], R[r + 3], R[r + 4], R[r + 5], p[o + 1], R[r + 6], R[r + 7], R[r + 8], p[o + 2], 0, 0, 0, 1);
    }
  };

  // 라이다 점: 몸통 위 0.1 m, 몸통 yaw 기준 수평 360줄. 안 맞은 줄(12 m 밖)은 바닥 아래로 숨긴다
  const LN = 360, lidarPos = new Float32Array(LN * 3);
  const lidarPts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(lidarPos, 3)),
    new THREE.PointsMaterial({ color: 0x39ff88, size: 4, sizeAttenuation: false }));
  lidarPts.frustumCulled = false;
  scene.add(lidarPts);
  let lastScan = 0;
  const yawOf = () => 2 * Math.atan2(d.qpos[6], d.qpos[3]); // 기울기 무시한 근사(서 있을 때 충분)
  const scan = () => {
    const x = d.qpos[0], y = d.qpos[1], z = d.qpos[2] + 0.1, yaw = yawOf(), r = lidar(x, y, z, yaw);
    for (let i = 0; i < LN; i++) {
      const a = yaw + (i * 2 * Math.PI) / LN, k = Number.isFinite(r[i]) ? r[i] : 0;
      lidarPos.set(k ? [x + Math.cos(a) * k, y + Math.sin(a) * k, z] : [x, y, -100], i * 3);
    }
    lidarPts.geometry.attributes.position.needsUpdate = true;
  };

  // ── 카메라: 따라가기(로봇 뒤에서 돌기) ↔ 위에서 보기(지도판). 막대 밖(캔버스) 한 손가락 끌기 = 돌리기, 두 손가락·휠 = 확대·축소
  const view = { yaw: 0, pitch: Math.atan2(0.75, 1.7), dist: Math.hypot(0.75, 1.7), topH: 13, topRot: 0 };
  let top = false;
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const zoom = (k) => { if (top) view.topH = clamp(view.topH * k, 3, 30); else view.dist = clamp(view.dist * k, 0.8, 8); };
  const ptrs = new Map();
  let pinch = 0;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; });
  cv.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (ptrs.size === 1) {
      const dx = e.clientX - p[0], dy = e.clientY - p[1];
      if (top) view.topRot -= dx * 0.006;
      else { view.yaw -= dx * 0.006; view.pitch = clamp(view.pitch + dy * 0.006, 0.05, 1.45); }
    }
    p[0] = e.clientX; p[1] = e.clientY;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], dd = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch && dd) zoom(pinch / dd);
      pinch = dd;
    }
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) cv.addEventListener(ev, (e) => { ptrs.delete(e.pointerId); pinch = 0; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.001)); }, { passive: false });

  $('reset').onclick = () => { sim.reset(); sim.hold(0.5); acc = 0; };
  $('cam').onclick = () => {
    top = !top; mapPlane.visible = top;
    $('cam').setAttribute('aria-pressed', String(top));
    $('cam').setAttribute('aria-label', top ? '따라가기' : '위에서 보기');
    if (!top) camera.up.set(0, 0, 1);
    camera.updateProjectionMatrix();
  };
  for (const b of ['reset', 'cam']) $(b).disabled = false;
  sim.hold(0.5);
  ready = true;
  $('busy').hidden = true;
  if (stopped) sim.cmd = [0, 0, 0];
  ui();

  // ── 실행: 화면 시간에 맞춰 정책 스텝(한 프레임 최대 5스텝, 밀리면 늦게 감)
  let acc = 0, lastT = performance.now(), frames = 0, fps = 0, fpsT = lastT;
  Object.assign(st, { ready: true, sim, steps: 0, stepsBehind: 0, fps: () => fps, joy: () => joy.slice(), cmd: () => sim.cmd.slice(), stopped: () => stopped,
    top: () => top, view: () => ({ ...view }), cam: () => camera.position.toArray() });
  const camPos = new THREE.Vector3(), look = new THREE.Vector3();
  function frame(now) {
    acc += Math.min((now - lastT) / 1000, 0.25);
    lastT = now;
    let n = 0;
    while (acc >= POLICY_DT && n < 5) {
      acc -= POLICY_DT; n++;
      if (!sim.fell) { sim.cmd = stopped ? [0, 0, 0] : joy.slice(); sim.step(); }
      st.steps++;
    }
    if (acc >= POLICY_DT) { st.stepsBehind++; acc = 0; }
    if (now - lastScan >= 100) { scan(); lastScan = now; }
    draw();
    const bx = d.qpos[0], by = d.qpos[1], bz = d.qpos[2];
    if (top) {
      camPos.set(bx, by, map.floor_z + view.topH); look.set(bx, by, 0);
      camera.up.set(-Math.sin(view.topRot), Math.cos(view.topRot), 0); // 돌리기 0 = 지도처럼 +y 가 화면 위
      camera.near = Math.max(0.05, view.topH - 8); // 천장 등(바닥 + 8.5~10 m)을 잘라 로봇이 가리지 않게
    } else {
      const a = yawOf() + view.yaw, h = view.dist * Math.cos(view.pitch);
      camPos.set(bx - Math.cos(a) * h, by - Math.sin(a) * h, bz + view.dist * Math.sin(view.pitch)); look.set(bx, by, bz);
      camera.near = 0.05;
    }
    camera.updateProjectionMatrix();
    camera.position.lerp(camPos, top ? 1 : 0.25);
    camera.lookAt(look);
    renderer.render(scene, camera);
    frames++;
    if (now - fpsT > 1000) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
    $('stickL').classList.toggle('out', !inRange(sim.cmd));
    $('reset').classList.toggle('fell', sim.fell);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

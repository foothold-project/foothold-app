// 지도 탭 실내 3D (W3 · MAP3D 11-28): 층 지도판에 3D 모형(MapVersion.model_sha256)이 있으면 «3D» 로 그 층 GLB 를 돌려 본다.
// 좌표 = 지도 world 좌표(m, x 동 · y 북 · z 위). GLB 는 glTF 규약(+Y 위)이라 (x, y, z)gltf → (x, −z, y) 로 한 번 바꾼다.
// 로봇 자리(실시간 위치, 2D 와 같은 값 · 같은 색 규칙)와 점검 지점(지도 요소 waypoints)을 같은 좌표로 얹는다. 3D 파일엔 조명이 없어 환경광 + 위 방향광.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Location, MapVersion } from '../../../contracts/ts';
import { ApiFail, api, authMark, onAuthEnd } from '../api';
import { rt, useRt } from '../rt';
import { robotStatus, type Robot, type Tone } from '../fake';
import { useTheme } from '../theme';
import './voxel3d.css';

/** 판의 3D 모형 sha(계약 MapVersion.model_sha256). null = 모형 없음 · 거절됨 → 2D 만 */
export const modelOf = (v?: MapVersion | null) => v?.model_sha256 || null;

type P3 = [number, number, number];
/** glTF(+Y 위) → 지도 world(z 위) */
export const gltfToWorld = ([x, y, z]: P3): P3 => [x, -z + 0, y];
/** 지도 world → glTF */
export const worldToGltf = ([x, y, z]: P3): P3 => [x, z, -y + 0];

/** 모형을 담는 무리: X 축 +90° = (x, y, z)gltf → (x, −z, y) world. gltfToWorld 와 같은 변환(시험이 둘을 맞춰 본다) */
export const worldGroup = () => { const g = new THREE.Group(); g.rotation.x = Math.PI / 2; return g; };

/** 받은 모형 바이트: 같은 로그인 세션(authMark) · 판 · sha 마다 한 번, 최근 KEEP 개만. 세션이 바뀌면(로그아웃 · 만료 · 다른 계정) 다 버리고 서버에 다시 묻는다.
 *  받기 성공만 기억한다(실패 · 거둠은 다음에 다시 받음) */
const KEEP = 3, models = new Map<string, ArrayBuffer>();
export const resetModels = () => models.clear();
onAuthEnd(resetModels);
export async function modelBytes(id: string, sha: string, cancel?: AbortSignal) {
  const mark = authMark() ?? '', k = `${mark}\n${id}\n${sha}`;
  for (const x of [...models.keys()]) if (!x.startsWith(`${mark}\n`)) models.delete(x);
  const hit = models.get(k);
  if (hit) { models.delete(k); models.set(k, hit); return hit; }   // 최근 쓴 것을 뒤로
  const buf = await api.model(id, cancel);
  if ((authMark() ?? '') !== mark) return buf;   // 받는 사이 세션이 바뀜. 기억하지 않음
  models.set(k, buf);
  while (models.size > KEEP) models.delete(models.keys().next().value!);
  return buf;
}

/** 로봇 표식 자리(world): 바닥 위 (x, y), 방향 선 끝 = yaw 쪽 1 m(2D 지도의 방향 선과 같은 뜻). yaw 없으면 선 없음 */
export function robotMark(l: { x: number; y: number; yaw?: number | null }, floorZ: number): { at: P3; tip: P3 | null } {
  return { at: [l.x, l.y, floorZ], tip: l.yaw == null ? null : [l.x + Math.cos(l.yaw), l.y + Math.sin(l.yaw), floorZ] };
}

/** 바닥 윗면 높이(world z) = 판의 model_floor_z(계약: 그 층 바닥 world z). 없으면 모형 맨 아래.
 *  GLB 노드 이름으로 찾지 않는다(실서버 floor_id 는 UUID) */
export function floorZ(scene: THREE.Object3D, v: MapVersion) {
  if (v.model_floor_z != null) return v.model_floor_z;
  scene.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(scene).min.y;
}

/** 이 판 위에 좌표가 있는 로봇만(다른 판 · 좌표 없음은 빠짐) */
export function onBoard<R>(robots: R[], vid: string, where: (x: R) => Partial<Pick<Location, 'map_version_id' | 'x' | 'y' | 'yaw'>> | null | undefined) {
  return robots.flatMap((x) => { const l = where(x); return l && l.map_version_id === vid && l.x != null && l.y != null ? [{ x, l: { x: l.x, y: l.y, yaw: l.yaw } }] : []; });
}

/** 2D 지도의 로봇 점과 같은 색 규칙(연결 끊김 = 흐림, 그 밖 = 상태 색) */
const TONE_VAR: Record<Tone, string> = { ok: '--accent', warn: '--warn', bad: '--bad', off: '--muted' };
export const whereOf = (x: Robot) => (x.unknown === 'summary' ? null : rt.get(x.id).state?.location ?? x.location ?? null);

type Rig = { draw: () => void; marks: THREE.Group; z: number; view: (top: boolean) => void; dispose: () => void };

/** missing(까닭) = 404: 모형 없음 · 판 없음. 부르는 쪽이 2D 로 돌아가 그 까닭을 한 줄로.
 *  still = 미리 보기(시안 u7_1): 시점 단추 · 범례 없음(기본 = 있음) */
export function Map3D({ v, robots, missing, still }: { v: MapVersion; robots: Robot[]; missing: (why: string) => void; still?: boolean }) {
  const host = useRef<HTMLDivElement>(null), rig = useRef<Rig | null>(null);
  const [at, setAt] = useState<'wait' | 'ok' | 'bad' | 'nogl'>('wait'), [n, setN] = useState(0), [why, setWhy] = useState('');
  const [, light] = useTheme();
  useRt();
  const sha = modelOf(v)!;
  const css = () => getComputedStyle(host.current ?? document.documentElement);
  const color = (k: string, fb: string) => new THREE.Color(css().getPropertyValue(k).trim() || fb);

  useEffect(() => {
    let live = true, rig0: Rig | null = null;
    const stop = new AbortController();
    setAt('wait'); setWhy('');
    (async () => {
      let buf: ArrayBuffer;
      try { buf = await modelBytes(v.id, sha, stop.signal); } catch (e) {
        if (!live) return;
        const f = e instanceof ApiFail ? e : null;
        if (f?.code === 'CANCELED') return;
        if (f?.status === 404) return missing(f.message);
        setWhy(f?.message ?? ''); setAt('bad'); return;   // 401 은 call 이 로그인 정리까지
      }
      // 읽기 → 그리기. 어디서 예외가 나도 만든 것을 거두고 실패 문구(«불러오는 중» 에 멈추지 않음)
      let renderer: THREE.WebGLRenderer | null = null, canvas: HTMLCanvasElement | null = null;
      const drop = () => { if (renderer) { renderer.dispose(); renderer.forceContextLoss(); } canvas?.remove(); };
      try {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const g = await new GLTFLoader().parseAsync(buf, '');
        if (!live) return;
        try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch { setAt('nogl'); return; }
        const el = host.current!; canvas = renderer.domElement;
        const gl = renderer;
        gl.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        gl.outputColorSpace = THREE.SRGBColorSpace;
        el.prepend(canvas);
        const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
        cam.up.set(0, 0, 1);
        const z = floorZ(g.scene, v);   // 무리에 넣기 전(glTF 좌표의 y = world z)
        const model = worldGroup(); model.add(g.scene); scene.add(model);
        const box = new THREE.Box3().setFromObject(model), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
        const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8580, 1.6), sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(c.x - size.x * 0.3, c.y - size.y * 0.6, z + 30); sun.target.position.copy(c); scene.add(hemi, sun, sun.target);
        const marks = new THREE.Group(); scene.add(marks);
        const orbit = new OrbitControls(cam, canvas);
        orbit.maxPolarAngle = Math.PI / 2 - 0.05; orbit.minDistance = 2; orbit.maxDistance = Math.max(size.x, size.y) * 3;   // 바닥 아래로 못 감
        orbit.listenToKeyEvents(el);   // 칸에 초점이 있으면 화살표로 옮기기
        const draw = () => { scene.background = color('--bg', '#0B0E11'); gl.render(scene, cam); };
        const view = (top: boolean) => {
          const d = Math.max(size.x, size.y, 6);
          if (top) cam.position.set(c.x, c.y - 0.01, z + d * 1.1); else cam.position.set(c.x - d * 0.2, c.y - d * 0.8, z + d * 0.7);
          orbit.target.set(c.x, c.y, z); orbit.update(); draw();
        };
        orbit.addEventListener('change', draw);
        const fit = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; gl.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); draw(); };
        const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
        ro?.observe(el);
        rig0 = { draw, marks, z, view, dispose: () => {
          ro?.disconnect(); orbit.stopListenToKeyEvents(); orbit.dispose();
          scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => { Object.values(x).forEach((t) => (t as THREE.Texture)?.isTexture && (t as THREE.Texture).dispose()); x.dispose(); }); } });
          drop();
        } };
        rig.current = rig0;
        view(false); fit(); setAt('ok');
      } catch {
        if (rig0) rig0.dispose(); else drop();
        rig.current = null;
        if (live) { setWhy(''); setAt('bad'); }
      }
    })();
    return () => { live = false; stop.abort(); rig.current?.dispose(); rig.current = null; };
  }, [v.id, sha, n]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 얹기: 점검 지점(작은 기둥) · 로봇(둥근 표식, 2D 점과 같은 색). 위치가 바뀌거나 테마가 바뀌면 다시
  const here = onBoard(robots, v.id, whereOf);
  const key = here.map(({ x, l }) => `${x.id}:${l.x.toFixed(2)},${l.y.toFixed(2)},${l.yaw?.toFixed(2)}:${x.online ? robotStatus(x).tone : 'off'}`).join('|');
  useEffect(() => {
    const r = rig.current; if (!r || at !== 'ok') return;
    r.marks.children.slice().forEach((o) => { r.marks.remove(o); const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material)?.dispose(); });
    const wp = color('--warn', '#E0A23A');
    for (const w of v.features.waypoints) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.2, 16), new THREE.MeshBasicMaterial({ color: wp }));
      m.rotation.x = Math.PI / 2; m.position.set(w.x, w.y, r.z + 0.6); m.userData.waypoint = w.name; r.marks.add(m);
    }
    for (const { x, l } of here) {
      const tone: Tone = x.online ? robotStatus(x).tone : 'off', m = robotMark(l, r.z), tc = color(TONE_VAR[tone], '#3BB7A0');
      if (m.tip) {   // 방향 선(2D 지도의 짧은 선과 같은 뜻)
        const a = new THREE.Vector3(...m.at), b = new THREE.Vector3(...m.tip), len = a.distanceTo(b);
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, len, 10), new THREE.MeshBasicMaterial({ color: tc, depthTest: false }));
        arm.position.copy(a.clone().add(b).multiplyScalar(0.5)).setZ(r.z + 0.55); arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        arm.renderOrder = 2; r.marks.add(arm);
      }
      // 로봇은 선반·배관에 가려도 보이게(깊이 시험 끔 · 나중에 그림)
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), new THREE.MeshBasicMaterial({ color: tc, depthTest: false }));
      dot.position.set(l.x, l.y, r.z + 0.55); dot.renderOrder = 2; dot.userData.robot = x.id; r.marks.add(dot);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.88, 40), new THREE.MeshBasicMaterial({ color: color('--text', '#E6EBEF'), side: THREE.DoubleSide, depthTest: false }));
      ring.position.set(l.x, l.y, r.z + 0.02); ring.renderOrder = 1; r.marks.add(ring);
    }
    r.draw();
  }, [at, key, light, v.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="vx" data-map3d data-floor-z={at === 'ok' && rig.current ? rig.current.z : undefined}>
    <div ref={host} className="vx-3d" tabIndex={0} role="application" aria-label="3D 실내 · 끌어 돌리기, 오른쪽 끌기 이동, 휠 확대, 칸을 누른 뒤 화살표로 옮기기">
      {at === 'ok' && !still && <div className="vx-tools" role="group" aria-label="3D 시점">
        <button type="button" className="btn" onClick={() => rig.current?.view(true)}>위에서 보기</button>
        <button type="button" className="btn" onClick={() => rig.current?.view(false)}>비스듬히</button></div>}
    </div>
    <div className="vx-over">
      {at === 'wait' && <p className="lv-note" role="status" data-map3d-wait>3D 모형을 불러오는 중…</p>}
      {at === 'nogl' && <p className="lv-note" role="alert" data-map3d-nogl>이 브라우저에서는 3D 화면을 볼 수 없습니다. «2D» 로 보세요.</p>}
      {at === 'bad' && <div className="fh-row" data-map3d-bad><p className="fh-msg" role="alert">3D 모형을 불러오지 못했습니다. {why || '파일을 읽지 못했습니다.'} 다시 불러오세요.</p>
        <button type="button" className="btn" onClick={() => setN(n + 1)}>다시 불러오기</button></div>}
    </div>
    {at === 'ok' && !still && <div className="vx-legend" aria-label="3D 범례" data-map3d-legend><b>3D</b><span>로봇 = 둥근 표식(2D 와 같은 색)</span><span>점검 지점 = 기둥</span><span aria-hidden="true">· 끌어서 돌리기 · 휠로 확대</span></div>}
  </div>;
}

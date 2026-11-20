// «로봇 지도»(11-20 RB-USLAM-WEB): Unitree 앱에서 사람이 지도 만들기를 켜면 로봇이 만드는 지도 점군·위치를 서버 경유로 받아 그린다(PR #459 «웹 소비 계약»).
// 서버 WS /api/v1/robots/{id}/drive-media/slam(media.slam_points 머리 + 바로 뒤 count×12 B xyz_f32le) · /drive-media/slam_pose(media.slam_pose JSON) — 로그인 쿠키·Origin, 받기만.
// 빈 채널·2.5초 무자료는 서버가 media.status NO_SLAM — 그 채널을 비운다. 화면도 2.5초 넘게 새 판이 없으면 비운다(되는 것처럼 보이지 않게 — 남겨 두지 않음).
// 형식이 어긋난 판·남의 로봇·지난 epoch 판·되돌아간 순번은 버린다(연결은 그대로). 탭 숨김·화면 나감·로봇 바뀜이면 닫고 비움, epoch 바뀜·연결 끊김(2초 뒤 다시)도 비움.
// 그림 = 저장 지도 3D(screens/voxel3d.tsx)와 같은 작은 점 + 같은 높이 색(초록 → 분홍), 반투명 회색 Go2, 지도를 만드는 중이면 지나온 길. 관측 전용 — 조종·STOP·조종권과 무관, 명령 0.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CELL_M, PATH_MAX, RETRY_MS, STACK_MAX, bodyFault, stack, type Pose } from './drivemedia';
import { pointsBody } from './media';
import { FLOOR_DZ } from './lidar3d';
import { go2Standing, loadGo2 } from './go2model';
import { QEmpty } from './quad';
import { useLive } from './rt';
import { Z_TOP, hueAt } from './screens/voxelmap';

export const SLAM_HINT = 'Unitree 앱에서 지도 만들기를 켜면 여기에 보입니다';
/** 이보다 오래 새 판이 없으면 비운다(서버 NO_SLAM 과 같은 2.5 s) · 한 판 점 상한(에이전트 출력 4,000점) */
export const GONE_MS = 2500, SLAM_MAX = 4000;
/** false = 판마다 교체, true = 5 cm 칸으로 쌓기(STACK_MAX 상한, 오래된 점부터 덮음 — drivemedia stack).
 *  ponytail: 한 판이 지도 전체인지 새로 본 일부인지 형식 미확인 — 실기 첫 관측에서 결정 */
export const SLAM_STACK = false;
const MAKING = 'rt/uslam/frontend/odom';
type Ch = 'slam' | 'slam_pose';
type Head = { seq: number; epoch: number; count: number; byte_length: number };
/** 계약 frame·child_frame 이름(1~128자) */
const FRAME = /^[A-Za-z0-9_/-]{1,128}$/;
const named = (v: unknown) => typeof v === 'string' && FRAME.test(v);
/** 계약 seq·epoch: 0 ~ 2^53−1 정수(음수·비정수·비유한·상한 넘음은 틀린 판) */
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** pose = 로봇 위치, making = 지도를 만드는 중(저장 지도 위 위치 찾기가 아님), path = 만드는 동안 지나온 길(x,y 이어 붙임) */
export type Slam = { xyz: Float32Array; n: number; ver: number; at: number; pose: Pose | null; poseAt: number; making: boolean; path: number[] };
const blank = (): Slam => ({ xyz: new Float32Array(0), n: 0, ver: 0, at: 0, pose: null, poseAt: 0, making: false, path: [] });
export const slamUrl = (robot: string, ch: Ch) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/robots/${encodeURIComponent(robot)}/drive-media/${ch}`;

/** 점군 머리 검사(계약 SlamPointCloudHeader) — 맞으면 그 머리, 아니면 null(뒤따르는 본문도 버림) */
export function slamHeader(m: Record<string, unknown>): Head | null {
  const n = m.count;
  return m.t === 'media.slam_points' && m.source === 'rt/uslam/frontend/cloud_world_ds' && m.encoding === 'xyz_f32le' && named(m.frame)
    && typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= SLAM_MAX && m.byte_length === n * 12 && typeof m.truncated === 'boolean' && count(m.seq)
    ? m as unknown as Head : null;
}
/** 위치 검사(계약 SlamPoseFrame) — 맞으면 [위치, 만드는 중], 아니면 null */
export function slamPose(m: Record<string, unknown>): [Pose, boolean] | null {
  const p = m.pose as Pose | null;
  return m.t === 'media.slam_pose' && (m.source === MAKING || m.source === 'rt/uslam/localization/odom') && named(m.frame) && named(m.child_frame) && count(m.seq) && !!p && typeof p === 'object'
    && [p.x, p.y, p.z, p.yaw].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 10_000) ? [{ x: p.x, y: p.y, z: p.z, yaw: p.yaw }, m.source === MAKING] : null;
}

/** on 인 동안 그 로봇의 로봇 지도를 받는다. 로봇이 연결돼 있고(실시간 상태 ONLINE) 몸 확인 영구 오류가 아닐 때만 연다.
 *  ponytail: 지난 epoch 기록은 이 훅이 열려 있는 동안만 — 칸을 닫았다 열면 새로 센다(서버가 새 소켓에 주는 건 지금 epoch 의 마지막 판뿐) */
export function useSlam(robot: string, on = true): Slam {
  const [s, setS] = useState(blank), live = useLive(robot).state;
  const ok = on && live?.connection === 'ONLINE' && !bodyFault(live.devices);
  useEffect(() => {
    if (!ok) return;
    let cur = blank(), st: ReturnType<typeof stack> | null = null, pend: Head | null = null, alive = true, retry: ReturnType<typeof setTimeout> | undefined;
    let epoch: number | null = null, top: Record<Ch, number> = { slam: -1, slam_pose: -1 }, tPts: ReturnType<typeof setTimeout> | undefined, tPose = tPts;
    const gone = new Set<number>(), socks = new Map<Ch, WebSocket>();
    const emit = (p: Partial<Slam>) => { cur = { ...cur, ...p }; setS(cur); };
    const wipe = () => { st = null; pend = null; emit({ ...blank(), ver: cur.ver + 1 }); };
    const dropPts = () => { st = null; pend = null; emit({ xyz: new Float32Array(0), n: 0, at: 0, ver: cur.ver + 1 }); };
    const dropPose = () => emit({ pose: null, poseAt: 0, path: [] });   // 위치가 없으면 지나온 길도 비움
    /** 검증을 통과한 판만 부른다: 지난 epoch·이미 본 순번이면 false, 새 epoch 면 그때 바꾸고 비움(틀린 판 하나로 지도·epoch 가 바뀌지 않게) */
    const take = (ep: number, ch: Ch, seq: number) => {
      if (gone.has(ep) || (ep === epoch && seq <= top[ch])) return false;
      if (ep !== epoch) { if (epoch !== null) gone.add(epoch); epoch = ep; top = { slam: -1, slam_pose: -1 }; wipe(); }
      top[ch] = seq;
      return true;
    };
    const close = () => { clearTimeout(retry); socks.forEach((w) => { w.onmessage = w.onclose = null; w.close(1000); }); socks.clear(); };
    const hidden = () => document.visibilityState === 'hidden';
    const again = () => { close(); wipe(); if (alive && !hidden()) retry = setTimeout(open, RETRY_MS); };
    const frame = (ch: Ch, data: unknown) => {
      if (typeof data !== 'string') {   // 점군 본문: 바로 앞 머리와 짝일 때만. 길이·유한·범위가 어긋나거나 이미 본 판이면 버림
        const h = pend; pend = null;
        const xyz = ch === 'slam' && h && data instanceof ArrayBuffer ? pointsBody(data, h) : null;
        if (!xyz || !take(h!.epoch, 'slam', h!.seq)) return;
        const at = performance.now();
        clearTimeout(tPts); tPts = setTimeout(dropPts, GONE_MS);   // 마지막 수신 뒤 2.5 s 면 비움
        if (!SLAM_STACK) return emit({ xyz, n: h!.count, at, ver: cur.ver + 1 });
        const k = (st ??= stack()); k.add(xyz, cur.pose ?? { x: 0, y: 0, z: 0, yaw: 0 });
        return emit({ xyz: k.xyz, n: k.n, at, ver: cur.ver + 1 });
      }
      if (ch === 'slam') pend = null;   // 머리 뒤 본문 없이 글이 오면 그 머리는 버림
      let m: Record<string, unknown>;
      try { m = JSON.parse(data); } catch { return; }
      if (!m || m.version !== 'media/1' || m.channel !== ch || m.robot !== robot || !count(m.epoch)) return;
      const ep = m.epoch as number;
      if (m.t === 'media.status') {   // 서버가 붙자마자 보내는 epoch 0 «최근 자료 없음» 은 새 시작이 아님
        if (m.state !== 'NO_SLAM' || gone.has(ep)) return;
        if (ep !== 0 && ep !== epoch) take(ep, ch, -1);
        return (ch === 'slam' ? dropPts : dropPose)();
      }
      if (ch === 'slam') { pend = slamHeader(m); return; }   // epoch·순번은 본문까지 맞을 때 take
      const p = slamPose(m);
      if (!p || !take(ep, ch, m.seq as number)) return;
      clearTimeout(tPose); tPose = setTimeout(dropPose, GONE_MS);
      const [pose, making] = p, q = cur.path, j = q.length;
      // 지나온 길은 만드는 동안만(저장 지도 위로 바뀌면 지움). 5 cm 넘게 움직였을 때만 꼭짓점, PATH_MAX 상한
      const path = !making ? [] : j && Math.hypot(pose.x - q[j - 2], pose.y - q[j - 1]) < CELL_M ? q : [...q.slice(j >= PATH_MAX * 2 ? 2 : 0), pose.x, pose.y];
      emit({ pose, poseAt: performance.now(), making, path });
    };
    function open() {
      clearTimeout(retry);
      if (!alive || socks.size || hidden()) return;
      for (const ch of ['slam', 'slam_pose'] as const) {
        const w = new WebSocket(slamUrl(robot, ch));
        w.binaryType = 'arraybuffer'; socks.set(ch, w);
        w.onmessage = (e: { data?: unknown }) => { if (socks.get(ch) === w) frame(ch, e.data); };
        w.onclose = () => { if (socks.get(ch) === w) again(); };
      }
    }
    const vis = () => { if (hidden()) { close(); wipe(); } else open(); };
    document.addEventListener('visibilitychange', vis);
    open();
    return () => { alive = false; close(); clearTimeout(tPts); clearTimeout(tPose); document.removeEventListener('visibilitychange', vis); setS(blank()); };
  }, [robot, ok]);
  return s;
}

/** 점 크기(CSS px) · 어두운 고정 바탕(screens/voxel3d.tsx DARK.bg 와 같은 값) · 길 색(lidar3d 색표 청록 — 높이 색과 겹치지 않게) */
const DOT_PX = 1.5, BG = '#0B0E11', PATH_COLOR = 0x19e3c8;
const BAND = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `hsl(${hueAt(t * Z_TOP)} 75% 50%)`).join(', ')})`;

/** 받은 점·위치를 three 로(점은 판이 바뀔 때만 다시 채움). 처음엔 지도 전체가 들어오게 따라 맞추고, 손으로 돌리면 그 시점 그대로 — «전체 보기»로 되돌림 */
function Slam3D({ s, small }: { s: Slam; small: boolean }) {
  const host = useRef<HTMLDivElement>(null), cur = useRef(s), api = useRef<{ load: (pts: boolean) => void; fit: () => void } | null>(null);
  const [auto, setAuto] = useState(true), [fail, setFail] = useState(false);
  cur.current = s;
  useEffect(() => {
    const el = host.current!;
    let g: THREE.WebGLRenderer;
    try { g = new THREE.WebGLRenderer({ antialias: !small }); } catch { setFail(true); return; }
    const ratio = 1, cap = SLAM_STACK ? STACK_MAX : SLAM_MAX;   // 화소 비율 1 — 조종 화면에서 다시 그리는 비용이 명령 주기를 막지 않게(lidar3d 직결 조종과 같은 까닭, RV-455 1)
    g.setPixelRatio(ratio);
    const canvas = g.domElement;
    canvas.style.cssText = `display:block;width:100%;height:100%;touch-action:${small ? 'auto' : 'none'}`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `로봇이 만드는 지도 — 높이별 색 점${small ? '' : ' · 끌어서 돌리기, 휠 확대'}`);
    el.prepend(canvas);
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    cam.up.set(0, 0, 1); scene.background = new THREE.Color(BG);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
    const geo = new THREE.BufferGeometry(), P = new Float32Array(cap * 3), C = new Float32Array(cap * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3)); geo.setAttribute('color', new THREE.BufferAttribute(C, 3)); geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({ size: DOT_PX * ratio, sizeAttenuation: false, vertexColors: true });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
    const lg = new THREE.BufferGeometry(), L = new Float32Array(PATH_MAX * 3);
    lg.setAttribute('position', new THREE.BufferAttribute(L, 3)); lg.setDrawRange(0, 0);
    const lm = new THREE.LineBasicMaterial({ color: PATH_COLOR }), line = new THREE.Line(lg, lm); line.frustumCulled = false;
    const grid = new THREE.GridHelper(40, 40, 0x8a94a6, 0x8a94a6);   // 1 m 칸
    grid.rotation.x = Math.PI / 2;
    for (const m of [grid.material].flat()) { m.transparent = true; m.opacity = 0.14; m.depthWrite = false; }
    const skin = new THREE.MeshLambertMaterial({ color: 0xb4bac4, transparent: true, opacity: 0.7, depthWrite: false }), bot = new THREE.Group();
    const dress = (m: Parameters<typeof go2Standing>[0]) => { bot.children.slice().forEach((c) => { bot.remove(c); c.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); }); bot.add(go2Standing(m, skin)); };
    dress(null);
    let live = true, autoFit = true;
    scene.add(pts, line, grid, bot);
    const orbit = new OrbitControls(cam, canvas);
    orbit.enabled = !small; orbit.maxDistance = 300; orbit.screenSpacePanning = true;
    const draw = () => { if (document.visibilityState !== 'hidden' && el.clientWidth && el.clientHeight) g.render(scene, cam); };
    const size = () => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; g.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); draw(); };
    const frameAll = () => {   // 점 + 로봇이 다 들어오게 비스듬히 위에서
      const n = geo.drawRange.count, b = new THREE.Box3(), v = new THREE.Vector3(), r = cur.current.pose;
      for (let i = 0; i < n; i++) b.expandByPoint(v.fromArray(P, i * 3));
      if (r) b.expandByPoint(v.set(r.x, r.y, r.z));
      if (b.isEmpty()) return;
      const c = b.getCenter(new THREE.Vector3()), dir = new THREE.Vector3(-0.25, -0.8, 0.7).normalize();
      let d = Math.max(3, b.getSize(v).length());
      orbit.target.copy(c);
      for (let k = 0; k < 4; k++) {   // 상자 여덟 모서리를 화면에 비춰 칸(넓고 낮은 칸 포함)에 꽉 차게 — 거리만 고침
        cam.position.copy(c).addScaledVector(dir, d); cam.lookAt(c); cam.updateMatrixWorld();
        let m = 0;
        for (let i = 0; i < 8; i++) { v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(cam); m = Math.max(m, Math.abs(v.x), Math.abs(v.y)); }
        d = Math.max(1, d * (0.4 + 0.6 * m / 0.92));
      }
      cam.position.copy(c).addScaledVector(dir, d); orbit.update();
    };
    /** pts = 점 판이 바뀜(점·색 다시 채우고 시점 맞춤). 위치만 바뀌면 로봇·길·격자만 옮긴다(점 4,000개를 위치마다 다시 칠하지 않게) */
    const load = (pts: boolean) => {
      const c = cur.current, n = Math.min(c.n, cap), floor = c.pose ? c.pose.z + FLOOR_DZ : 0, col = new THREE.Color();
      if (pts) {
        for (let i = 0; i < n * 3; i += 3) {
          P[i] = c.xyz[i]; P[i + 1] = c.xyz[i + 1]; P[i + 2] = c.xyz[i + 2];
          col.setHSL(hueAt(c.xyz[i + 2] - floor) / 360, 0.75, 0.5); C[i] = col.r; C[i + 1] = col.g; C[i + 2] = col.b;
        }
        geo.setDrawRange(0, n); geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
      }
      const k = c.making ? Math.min(c.path.length / 2, PATH_MAX) : 0;
      for (let i = 0; i < k; i++) { L[i * 3] = c.path[i * 2]; L[i * 3 + 1] = c.path[i * 2 + 1]; L[i * 3 + 2] = floor + 0.02; }
      lg.setDrawRange(0, k); lg.attributes.position.needsUpdate = true; line.visible = k > 1;
      bot.visible = !!c.pose;
      if (c.pose) { bot.position.set(c.pose.x, c.pose.y, c.pose.z); bot.rotation.z = c.pose.yaw; }
      grid.position.set(Math.round(c.pose?.x ?? 0), Math.round(c.pose?.y ?? 0), floor);
      if (pts && autoFit) frameAll();
      draw();
    };
    loadGo2().then((m) => { if (live && m) { dress(m); draw(); } });
    orbit.addEventListener('change', draw);
    orbit.addEventListener('start', () => { autoFit = false; setAuto(false); });
    api.current = { load, fit: () => { autoFit = true; setAuto(true); frameAll(); draw(); } };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size);
    ro?.observe(el);
    document.addEventListener('visibilitychange', draw);
    size(); load(true);
    return () => {
      live = false; api.current = null; ro?.disconnect(); document.removeEventListener('visibilitychange', draw); orbit.dispose();
      geo.dispose(); mat.dispose(); lg.dispose(); lm.dispose(); grid.dispose(); skin.dispose(); bot.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      g.dispose(); g.forceContextLoss(); canvas.remove();
    };
  }, [small]);
  useEffect(() => api.current?.load(true), [s.ver]);
  useEffect(() => api.current?.load(false), [s.pose, s.path]);
  return <div ref={host} style={{ position: 'absolute', inset: 0, background: BG }} data-slam-view={s.n} data-slam-robot={s.pose ? '' : undefined} data-slam-path={s.making ? s.path.length / 2 : 0}>
    {fail && <QEmpty text="이 브라우저는 3D 를 그릴 수 없어 로봇 지도를 보여 줄 수 없습니다" />}
    {!small && <div className="qd-legend" aria-label="높이 색 범례" data-slam-legend>
      <div style={{ height: 8, borderRadius: 2, background: BAND }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>바닥</span><span>높음</span></div></div>}
    {!auto && !small && <button type="button" className="btn" data-slam-fit style={{ position: 'absolute', left: 8, bottom: 8 }} onClick={() => api.current?.fit()}>전체 보기</button>}
  </div>;
}

/** 로봇 지도 칸(부모를 채움) — 받은 점이 없으면(아직 한 판도 안 옴·자료 없음·2.5초 무자료) 비우고 안내만 */
export const SlamView = ({ s, small = false }: { s: Slam; small?: boolean }) =>
  s.n ? <Slam3D s={s} small={small} /> : <div style={{ position: 'absolute', inset: 0, background: BG }} data-slam-empty><QEmpty text={SLAM_HINT} /></div>;

/** «우리 지도» / «로봇 지도» 고르기 + 그 보기(부모를 채움, 단추는 오른쪽 위 top px — left 를 주면 왼쪽 위). ours = 우리 지도 그림(없으면 로봇 지도만 — 단추 없음). 로봇 지도 단추는 받은 점이 있을 때만 */
export function MapPick({ robot, ours, small = false, top = 52, left }: { robot: string; ours: ReactNode | null; small?: boolean; top?: number; left?: number }) {
  const s = useSlam(robot), [pick, setPick] = useState<'ours' | 'robot'>('ours'), show = ours && pick === 'ours' ? 'ours' : 'robot';
  return <div style={{ position: 'absolute', inset: 0 }} data-map-pick={show}>
    {show === 'ours' ? ours : <SlamView s={s} small={small} />}
    {ours && <div className="fh-row" role="group" aria-label="지도 고르기" style={{ position: 'absolute', ...(left == null ? { right: 8 } : { left }), top, zIndex: 1 }}>
      <button type="button" className="btn" aria-pressed={show === 'ours'} data-pick="ours" onClick={() => setPick('ours')}>우리 지도</button>
      <button type="button" className="btn" aria-pressed={show === 'robot'} data-pick="robot" disabled={!s.n} title={s.n ? undefined : SLAM_HINT} onClick={() => setPick('robot')}>로봇 지도</button>
    </div>}
  </div>;
}

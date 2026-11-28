// 지도 탭 실내 3D (W3 · MAP3D): 층 지도판에 3D 모형(model_sha256)이 있으면 «2D / 3D» 전환, /model 한 번만 받기, 404 면 2D 로 + 한 줄, glTF → 지도 좌표 변환.
// jsdom 엔 WebGL 이 없어 그리기는 실패 문구로 남는다(그리기는 headless Chrome 사진으로 확인).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapVersion, RobotSummary, SiteTree, User } from '../../../contracts/ts';
import { Root } from '../session';
import { kept } from '../screens/mapedit';
import { clearPlans } from '../screens/missions';
import * as THREE from 'three';
import { api, expireAuth } from '../api';
import { floorZ, gltfToWorld, modelBytes, onBoard, resetModels, robotMark, worldGroup, worldToGltf } from '../screens/map3d';
import { FakeWS } from './fakeWs';

// 그리기까지 가는 시험만: WebGL · GLB 읽기를 가짜로(fake.on). 그 밖은 진짜(jsdom 은 WebGL 이 없어 실패 경로)
const fake = vi.hoisted(() => ({ on: false, scene: null as unknown, drawn: null as unknown }));
vi.mock('three', async (orig) => {
  const t = await orig<typeof import('three')>();
  class GL { domElement = document.createElement('canvas'); outputColorSpace = ''; setPixelRatio() {} setSize() {} dispose() {} forceContextLoss() {} render(s: unknown) { fake.drawn = s; } }
  return { ...t, WebGLRenderer: function (this: unknown, ...a: unknown[]) { return fake.on ? new GL() : new (t.WebGLRenderer as unknown as new (...x: unknown[]) => object)(...a); } };
});
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', async (orig) => {
  const m = await orig<typeof import('three/examples/jsm/loaders/GLTFLoader.js')>();
  class L extends m.GLTFLoader { parseAsync(...a: Parameters<InstanceType<typeof m.GLTFLoader>['parseAsync']>) { return fake.on ? Promise.resolve({ scene: fake.scene } as never) : super.parseAsync(...a); } }
  return { ...m, GLTFLoader: L };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name }, simulation: false, server_drive_allowed: false,
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
const floor = (id: string, name: string, level: number, approved: string | null) => ({ id, building_id: 'b1', name, level, approved_version_id: approved, pending_count: 0 });
const tree = (approved: string | null) => ({ items: [{ id: 's1', name: '본관', purpose: 'REAL', buildings: [{ id: 'b1', site_id: 's1', name: '본동', floors: [floor('f1', '1층', 1, approved)] }] }], next_cursor: null }) as unknown as SiteTree;
const EMPTY = { zones: [], waypoints: [], connectors: [], edits: [] };
const ver = (id: string, number: number, p: Partial<MapVersion> = {}): MapVersion => ({ upload_id: `up-${id}`, id, floor_id: 'f1', number, base_version_id: null, copied_from_id: null, status: 'APPROVED', image_sha256: 'ab'.repeat(32),
  width: 100, height: 80, resolution: 0.1, origin: [-5, -4, 0], features: EMPTY, reason: `이유 ${number}`, source: 'IMPORT', created_by: KIM.id, created_at: '2026-11-11T05:00:00Z', ...p });
const SHA = 'cd'.repeat(32), V1 = ver('v1', 1), V2 = ver('v2', 2, { model_sha256: SHA, model_floor_z: 0 });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Route = Reply | ((q: URLSearchParams, body?: unknown) => Reply | Promise<Reply>);
type Call = { method: string; path: string; q: URLSearchParams; body?: unknown; type?: string; signal?: AbortSignal | null };
let calls: Call[] = [];
function serve(routes: Record<string, Route>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    const body = init.body instanceof Blob ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, q, body, type: (init.headers as Record<string, string> | undefined)?.['Content-Type'], signal: init.signal });
    const hit = routes[`${method} ${path}`];
    const rep = typeof hit === 'function' ? await hit(q, body) : hit ?? err(404, 'NOT_FOUND', '장소·지도 자료를 찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, approved: string | null, more: Record<string, Route> = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: [RA], next_cursor: null } },
  'GET /dashboard': { status: 200, body: { robots_total: 1, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } },
  'GET /notifications': { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } },
  'GET /events': { status: 200, body: { items: [], next_cursor: null } },
  'GET /approvals': { status: 200, body: { items: [], next_cursor: null } },
  'GET /users': { status: 200, body: { items: [KIM, LEE], next_cursor: null } },
  'GET /sites': { status: 200, body: tree(approved) },
  'GET /map-versions/v1': { status: 200, body: V1 }, 'GET /map-versions/v2': { status: 200, body: V2 },
  'GET /floors/f1/map-versions': { status: 200, body: { items: approved === 'v2' ? [V2, V1] : approved ? [V1] : [], next_cursor: null } },
  ...more,
});

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(pick = true) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('WebSocket', FakeWS);
  location.hash = '#/map';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
  const b = box.querySelector<HTMLButtonElement>('[aria-label="지도 고르기"] [data-building]');
  if (pick && b) { act(() => b.click()); await flush(); }
  if (pick) { const o = box.querySelector<HTMLButtonElement>('[data-open-map]'); if (o) { act(() => o.click()); await flush(); } }   // 시안 u7_1: 건물 = 고르기, «지도 열기»로 연다
}
afterEach(() => { fake.on = false; fake.scene = null; fake.drawn = null; act(() => root?.unmount()); root = null; box?.remove(); kept.d = null; kept.job = null; clearPlans(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetModels(); });

const $ = (s: string) => box.querySelector<HTMLElement>(s);
const click = async (el: Element | null) => { expect(el).toBeTruthy(); act(() => (el as HTMLElement).click()); await flush(); };
const pick = (t: '2D' | '3D') => box.querySelector<HTMLButtonElement>(`[data-model-toggle="${t}"]`);
const models = () => calls.filter((c) => c.path.endsWith('/model'));

describe('glTF → 지도 좌표', () => {
  it('(x, y, z)gltf → (x, −z, y) · 1층 C-1 중심 (28, 3, 0) · 2층 바닥 높이 3.375, 되돌리기', () => {
    expect(gltfToWorld([28, 0, -3])).toEqual([28, 3, 0]);
    expect(gltfToWorld([14, 3.375, -15.5])).toEqual([14, 15.5, 3.375]);
    expect(worldToGltf([28, 3, 0])).toEqual([28, 0, -3]);
    expect(gltfToWorld(worldToGltf([7, 3.2, 3.375]))).toEqual([7, 3.2, 3.375]);
  });
  it('그리기의 모형 무리도 같은 변환', () => {
    const g = worldGroup(); g.updateMatrixWorld(true);
    for (const p of [[28, 0, -3], [14, 3.375, -15.5]] as [number, number, number][]) {
      const w = new THREE.Vector3(...p).applyMatrix4(g.matrixWorld);
      expect([w.x, w.y, w.z].map((x) => +x.toFixed(6) + 0)).toEqual(gltfToWorld(p));
    }
  });
  it('바닥 높이 = 판의 model_floor_z (실서버 floor_id 는 UUID 라 노드 이름으로 찾지 않음), 없으면 모형 맨 아래', () => {
    const scene = new THREE.Group();
    for (const [id, top] of [['l1', 0], ['l2', 3.375], ['l3', 6.75]] as const) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(36, 0.175, 20)); slab.name = `${id}_floor`; slab.position.set(18, top - 0.0875, -10); scene.add(slab);
    }
    const uuid = '3f1c2a9e-7b4d-4e21-9a0c-5d6e7f809a1b';
    expect(floorZ(scene, ver('v9', 1, { floor_id: uuid, model_floor_z: 3.375 }))).toBe(3.375);
    expect(floorZ(scene, ver('v9', 1, { floor_id: uuid, model_floor_z: 0 }))).toBe(0);
    expect(floorZ(scene, ver('v9', 1, { floor_id: uuid, model_floor_z: null }))).toBeCloseTo(-0.175, 6);
    expect(floorZ(scene, ver('v9', 1, { floor_id: 'l3' }))).toBeCloseTo(-0.175, 6);   // 이름이 맞아도 노드는 보지 않음
  });
});

describe('3D 에 얹는 로봇 거르기', () => {
  it('이 판(map_version_id) 위치가 있는 로봇만 · 다른 판 · 좌표 없음은 빠짐', () => {
    type R = { id: string; l: Parameters<typeof onBoard>[2] extends (x: never) => infer L ? L : never };
    const at = (id: string, l: object | null) => ({ id, l }) as R;
    const list: R[] = [at('a', { map_version_id: 'v2', x: 1, y: 2, yaw: 0.5 }), at('b', { map_version_id: 'v1', x: 1, y: 2 }), at('c', { map_version_id: 'v2', x: null, y: 2 }), at('d', null)];
    const got = onBoard(list, 'v2', (x) => x.l);
    expect(got.map((g) => g.x.id)).toEqual(['a']);
    expect(got[0].l).toEqual({ x: 1, y: 2, yaw: 0.5 });
  });
});

describe('지도 탭 층 지도판 «2D / 3D»', () => {
  it('model_sha256 이 없으면 3D 단추 없음', async () => {
    serve(signedIn(KIM, 'v1')); await open();
    expect($('[data-map]')).toBeTruthy();
    expect(pick('3D')).toBeNull();
  });
  it('있으면 단추 · 누르면 /model 한 번, 2D 로 갔다 다시 3D 여도 같은 sha 면 다시 받지 않음', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': { status: 200, body: {} } })); await open();
    expect(pick('2D')!.getAttribute('aria-pressed')).toBe('true');
    expect(models()).toHaveLength(1);   // 지도 탭 첫 화면 미리 보기(시안 u7_1 · 실제 현장 = 서버 모형)가 이미 받음 · 층 화면 3D 는 같은 sha 라 다시 받지 않음
    await click(pick('3D'));
    expect(pick('3D')!.getAttribute('aria-pressed')).toBe('true');
    expect($('[data-map3d]')).toBeTruthy();
    expect(models().map((c) => c.path)).toEqual(['/map-versions/v2/model']);
    await click(pick('2D'));
    expect($('[data-map]')).toBeTruthy(); expect($('[data-map3d]')).toBeNull();
    await click(pick('3D'));
    expect(models()).toHaveLength(1);
  });
  it('계약 model_sha256 = null(거절된 모형 · #543 N1) → model_floor_z 가 남아 있어도 2D 만, /model 을 묻지 않음', async () => {
    const N = ver('v2', 2, { model_sha256: null, model_floor_z: 3.375 });
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2': { status: 200, body: N }, 'GET /floors/f1/map-versions': { status: 200, body: { items: [N, V1], next_cursor: null } } })); await open();
    expect($('[data-map]')).toBeTruthy();
    expect(pick('3D')).toBeNull(); expect(pick('2D')).toBeNull();
    expect($('[data-map3d]')).toBeNull();
    expect(models()).toHaveLength(0);
  });
  it('404 MODEL_NOT_FOUND → 2D 로 돌아가고 서버가 준 까닭 한 줄 + «2D 지도로 봅니다»', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': err(404, 'MODEL_NOT_FOUND', '이 층은 3D 모형이 없습니다.') })); await open();
    await click(pick('3D'));
    expect($('[data-map3d]')).toBeNull();
    expect($('[data-map]')).toBeTruthy();
    expect(pick('2D')!.getAttribute('aria-pressed')).toBe('true');
    const line = [...box.querySelectorAll('.mx-over .fh-msg')].map((e) => e.textContent);
    expect(line).toEqual(['이 층은 3D 모형이 없습니다. 2D 지도로 봅니다.']);
  });
  it('404 다른 까닭(판이 없음 · 다른 조직) → 그 까닭을 한 줄로(«모형이 없습니다» 로 바꿔 말하지 않음)', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': err(404, 'NOT_FOUND', '장소·지도 자료를 찾을 수 없습니다.') })); await open();
    await click(pick('3D'));
    expect($('[data-map3d]')).toBeNull();
    const line = [...box.querySelectorAll('.mx-over .fh-msg')].map((e) => e.textContent);
    expect(line).toEqual(['장소·지도 자료를 찾을 수 없습니다. 2D 지도로 봅니다.']);
  });
});

describe('3D 표식 위치(순수 함수)', () => {
  it('로봇 = 지도 (x, y) · 층 바닥 높이, 방향 선 끝 = yaw 쪽 1 m. yaw 없으면 선 없음', () => {
    const m = robotMark({ x: 10, y: 4, yaw: Math.PI / 2 }, 3.375);
    expect(m.at).toEqual([10, 4, 3.375]);
    expect(m.tip!.map((v) => +v.toFixed(6) + 0)).toEqual([10, 5, 3.375]);
    expect(robotMark({ x: 22, y: 15.5, yaw: null }, 3.375)).toEqual({ at: [22, 15.5, 3.375], tip: null });
  });
});

describe('3D 모형 받기 · 실패 경로', () => {
  it('같은 로그인 세션 · 같은 sha 는 한 번, 세션이 바뀌면 다시 받음, 최근 3 개만 기억', async () => {
    let mark = 'csrf-1';
    serve({ 'GET /auth/session': () => ({ status: 200, body: { client: 'web', csrf_token: mark } }),
      'POST /auth/logout': { status: 204 }, 'GET /map-versions/a/model': { status: 200, body: {} }, 'GET /map-versions/b/model': { status: 200, body: {} },
      'GET /map-versions/c/model': { status: 200, body: {} }, 'GET /map-versions/d/model': { status: 200, body: {} } });
    await api.session();
    await modelBytes('a', SHA); await modelBytes('a', SHA);
    expect(models()).toHaveLength(1);
    mark = 'csrf-2'; await api.session();
    await modelBytes('a', SHA);
    expect(models()).toHaveLength(2);
    mark = 'csrf-1'; await api.session();   // 같은 표식으로 돌아와도 바뀐 사이 버렸으니 다시 받음
    await modelBytes('a', SHA);
    expect(models()).toHaveLength(3);
    expireAuth(); await api.session();   // 만료 · 로그아웃은 바로 비움
    await modelBytes('a', SHA);
    expect(models()).toHaveLength(4);
    await api.logout(); await api.session();   // 로그아웃도
    await modelBytes('a', SHA);
    expect(models()).toHaveLength(5);
    for (const id of ['b', 'c', 'd']) await modelBytes(id, SHA);
    await modelBytes('a', SHA);   // 넷째 앞이라 밀려남
    expect(models().map((c) => c.path)).toEqual(['/map-versions/a/model', '/map-versions/a/model', '/map-versions/a/model', '/map-versions/a/model', '/map-versions/a/model', '/map-versions/b/model', '/map-versions/c/model', '/map-versions/d/model', '/map-versions/a/model']);
  });
  it('500 → 실패 문구 + 다시 불러오기(다시 요청), 멈춰 있지 않음', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': err(500, 'INTERNAL_ERROR', '서버 오류입니다.') })); await open();
    await click(pick('3D'));
    expect($('[data-map3d-bad]')!.textContent).toContain('3D 모형을 불러오지 못했습니다');
    expect($('[data-map3d-bad]')!.textContent).toContain('서버 오류입니다');
    expect($('[data-map3d-wait]')).toBeNull();
    const n = models().length;   // 미리 보기 한 번 + 층 화면 한 번(실패는 기억하지 않음)
    await click([...box.querySelectorAll('[data-map3d-bad] button')].find((b) => b.textContent === '다시 불러오기')!);
    expect(models()).toHaveLength(n + 1);
  });
  it('네트워크 끊김 → 연결 문구(500 과 다른 문구) · 2D 로 돌아가면 받던 요청을 거둠', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': () => { throw new TypeError('down'); } })); await open();
    await click(pick('3D'));
    expect($('[data-map3d-bad]')!.textContent).toContain('서버에 연결하지 못했습니다');
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': () => new Promise<Reply>(() => {}) })); await open();
    await click(pick('3D'));
    const sig = models()[models().length - 1].signal!;
    expect(sig.aborted).toBe(false);
    await click(pick('2D'));
    expect(sig.aborted).toBe(true);
  });
  it('받은 본문이 GLB 가 아니면(읽기 예외) 실패 문구, «불러오는 중» 에 멈추지 않음', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': { status: 200, body: { not: 'glb' } } })); await open();
    await click(pick('3D'));
    await flush();
    expect($('[data-map3d-wait]')).toBeNull();
    expect($('[data-map3d-bad]')).toBeTruthy();
  });
  it('401 → 로그인 화면으로(세션 만료 처리, «네트워크 확인» 아님)', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': err(401, 'UNAUTHENTICATED', '로그인이 필요합니다.') })); await open(false);   // 미리 보기 3D 가 받다 401
    expect(box.querySelector('input[type="password"]')).toBeTruthy();
  });
  it('실제 현장 미리 보기(시안 u7_1 「3D 보기 · 미리 보기」) = 서버 모형 · still: 시점 단추 · 범례 없음, 층 화면 3D 는 그대로 있음', async () => {
    fake.on = true; fake.scene = new THREE.Group();
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': { status: 200, body: {} } })); await open(false);
    const pv = box.querySelector('[aria-label="미리 보기"]')!;
    expect(pv.querySelector('[data-map3d]')).not.toBeNull(); expect(pv.querySelector('canvas')).not.toBeNull();
    expect([pv.querySelector('.vx-tools'), pv.querySelector('[data-map3d-legend]')]).toEqual([null, null]);
    expect(pv.querySelector('[data-tag3d]')!.textContent).toBe('3D 보기 · 미리 보기');
    await click($('[data-open-map]')); await click(pick('3D'));
    expect($('[data-map3d] .vx-tools')).not.toBeNull(); expect($('[data-map3d-legend]')).not.toBeNull();
  });
  it('미리 보기 서버 모형이 404 면 그 판은 2D 그림', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': err(404, 'MODEL_NOT_FOUND', '모형이 없습니다.') })); await open(false);
    const pv = box.querySelector('[aria-label="미리 보기"]')!;
    expect(pv.querySelector('[data-map3d]')).toBeNull(); expect(pv.querySelector('[data-clay]')).not.toBeNull();   // 모형이 없으면 판 2D 그림을 세운 점토(시안 u7_1 · 팀장 22:37)
  });
  it('3D 칸은 키 안내를 가진 보기(화살표로 옮기기)', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/model': { status: 200, body: {} } })); await open();
    await click(pick('3D'));
    expect($('[data-map3d] [role="application"]')!.getAttribute('aria-label')).toContain('화살표');
  });
});

describe('3D 바닥 높이 = 받은 model_floor_z (그리기까지, WebGL · GLB 가짜)', () => {
  // 모형 바닥(맨 아래)은 −0.175, 받은 값은 웹에 적어 둔 적 없는 4.2(공정동 A 의 0 · 3.375 · 6.75 가 아님)
  const slab = () => { const g = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(36, 0.175, 20)); m.position.set(18, -0.0875, -10); g.add(m); return g; };
  const marks = () => {
    const out: Record<string, number[]> = { robot: [], ring: [], waypoint: [] };
    (fake.drawn as THREE.Scene | null)?.traverse((o) => {
      if (o.userData.robot) out.robot.push(o.position.z);
      else if (o.userData.waypoint) out.waypoint.push(o.position.z);
      else if ((o as THREE.Mesh).geometry instanceof THREE.RingGeometry) out.ring.push(o.position.z);
    });
    return out;
  };
  const at = (fz: number | null) => {
    const R = { ...RA, connection: 'ONLINE', location: { floor_id: 'f1', map_version_id: 'v2', x: 3, y: 2, yaw: 0, confidence: 1, updated_at: '2026-11-28T05:40:00Z' } } as RobotSummary;
    const V = ver('v2', 2, { model_sha256: SHA, model_floor_z: fz, features: { ...EMPTY, waypoints: [{ id: 'w1', name: '압력계', x: 5, y: 5, yaw: 0 }] } as MapVersion['features'] });
    return signedIn(KIM, 'v2', { 'GET /robots': { status: 200, body: { items: [R], next_cursor: null } }, 'GET /map-versions/v2': { status: 200, body: V },
      'GET /floors/f1/map-versions': { status: 200, body: { items: [V, V1], next_cursor: null } }, 'GET /map-versions/v2/model': { status: 200, body: {} } });
  };
  const near = (got: number[], want: number) => { expect(got.length).toBeGreaterThan(0); for (const z of got) expect(Math.abs(z - want)).toBeLessThanOrEqual(0.01); };   // ±1 cm
  it('받은 4.2 → 로봇 · 고리 · 점검 지점이 그 바닥 위(±1 cm), 칸의 data-floor-z 도 받은 값', async () => {
    fake.on = true; fake.scene = slab();
    serve(at(4.2)); await open();
    await click(pick('3D')); await flush();
    expect($('[data-map3d]')!.getAttribute('data-floor-z')).toBe('4.2');
    const m = marks();
    near(m.robot, 4.2 + 0.55); near(m.ring, 4.2 + 0.02); near(m.waypoint, 4.2 + 0.6);
  });
  it('받은 값이 0 이면 0(없는 값으로 보지 않음), null 이면 모형 맨 아래(−0.175)', async () => {
    fake.on = true; fake.scene = slab();
    serve(at(0)); await open();
    await click(pick('3D')); await flush();
    expect($('[data-map3d]')!.getAttribute('data-floor-z')).toBe('0');
    near(marks().robot, 0.55);
    act(() => root?.unmount()); root = null; box.remove(); resetModels();
    fake.scene = slab(); fake.drawn = null;
    serve(at(null)); await open();
    await click(pick('3D')); await flush();
    expect(+$('[data-map3d]')!.getAttribute('data-floor-z')!).toBeCloseTo(-0.175, 6);
    near(marks().robot, -0.175 + 0.55);
  });
});

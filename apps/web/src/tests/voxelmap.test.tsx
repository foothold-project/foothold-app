// 3D 지도(RB-VOXEL-VIEW): 지도 탭 «3D 지도 파일» 올리기(요청 모양·성공 결과·경고·오류) + «3D 로 보기» 묶음 받기·빈 지도 + 목록·상세 «3D» 표시 + «시뮬 지형 수정하기» → 그 지형 열기.
// jsdom 엔 WebGL 이 없어 3D 그리기는 받은 props 를 기록하는 가짜로 바꿔 본다(그리기는 headless Chrome 캡처 tmp/voxel-qa).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapVersion, RobotSummary, SiteTree, Terrain as ServerTerrain, User, VoxelMapSummary } from '../../../contracts/ts';
import { Root } from '../session';
import { api } from '../api';
import { Terrain, terrainAsk } from '../screens/terrain';
import { hueAt } from '../screens/voxelmap';
import { centerOf, type Props } from '../screens/voxel3d';
import { kept } from '../screens/mapedit';
import { clearPlans } from '../screens/missions';
import { FakeWS } from './fakeWs';

let last: Props | null = null;
vi.mock('../screens/voxel3d', async (orig) => ({ ...(await orig<object>()), default: (p: Props) => { last = p; return <div data-fake3d={p.n} />; } }));

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
const SUM = (id: string, n: number, warnings: string[] = []): VoxelMapSummary => ({ map_version_id: id, terrain_id: 'vox-abc', voxel_size: 0.1, point_count: 9000, voxel_count: n, origin: [-5, -4, 0],
  source_translation: [0, 0, 0], estimated_floor_z: 0, source_sha256: 'cd'.repeat(32), cells_sha256: 'ef'.repeat(32), warnings });
const V1 = ver('v1', 1), V2 = ver('v2', 2, { source: 'SLAM', voxel_map: SUM('v2', 3) });
const WARN = ['30 m를 넘는 구역은 가운데 30 m만 지도·지형으로 만들었습니다. 원본 파일은 보관됩니다.', '바닥부터 이어진 지형 높이는 1 m까지만 만들었습니다.'];
const TER: ServerTerrain = { spec: { schema: 'fh_custom_terrain/1', id: 'vox-abc', name: '본동 1층', size: [10, 8], spawn: [0, 0, 0], items: [{ kind: 'box', x: 1, y: 1, yaw: 0, sx: 0.5, sy: 0.5, h: 0.4 }] },
  version: 1, floor_id: null, map_version_id: null, archived_at: null, updated_at: '2026-11-11T05:00:00Z' };
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Route = Reply | ((q: URLSearchParams, body?: unknown) => Reply | Promise<Reply>);
type Call = { method: string; path: string; q: URLSearchParams; body?: unknown; type?: string };
let calls: Call[] = [];
function serve(routes: Record<string, Route>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    const body = init.body instanceof Blob ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, q, body, type: (init.headers as Record<string, string> | undefined)?.['Content-Type'] });
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
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); kept.d = null; kept.job = null; clearPlans(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); last = null; terrainAsk.id = ''; });

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const form = () => $('[aria-label="3D 지도 올리기"]')!;
const field = (label: string) => [...form().querySelectorAll('label')].find((l) => l.textContent!.startsWith(label))!.querySelector('input') as HTMLInputElement;
const pick = async (f: File) => { const el = field('3D 지도 파일'); act(() => { Object.defineProperty(el, 'files', { value: [f], configurable: true }); el.dispatchEvent(new Event('change', { bubbles: true })); }); await flush(); };
const setVal = async (el: HTMLInputElement, v: string) => { act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }); await flush(); };
/** «더 보기 › 새 지도 올리기…» → «3D 지도 파일» 고르기 */
const openVoxel = async () => { await click(btn('새 지도 올리기…')); await click(btn('3D 지도 파일(.pcd·.ply)')); };
const PLY = () => new File(['ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n'], 'room.ply');
const pages = (n: number, per: number) => (q: URLSearchParams) => { const c = Number(q.get('cursor')), cells = Array.from({ length: Math.min(per, n - c) }, (_, i) => [c + i, 0, i % 5]);
  return { status: 200, body: { summary: SUM('v2', n), cells, next_cursor: c + cells.length < n ? c + cells.length : null, max_page_size: 20000 } }; };

describe('3D 지도 올리기', () => {
  it('성공: 파일 바이트 그대로(octet-stream)·이름·형식·base → 결과 칸에 경고·«3D 로 보기»·«시뮬 지형 수정하기»', async () => {
    let made = false;   // 저장 뒤 나무·판 목록은 새 판을 가리킨다
    serve(signedIn(KIM, 'v1', {
      'POST /floors/f1/voxel-maps': () => { made = true; return { status: 201, body: { map: V2, terrain: TER, voxels: SUM('v2', 3, WARN) } }; },
      'GET /sites': () => ({ status: 200, body: tree(made ? 'v2' : 'v1') }),
      'GET /floors/f1/map-versions': () => ({ status: 200, body: { items: made ? [V2, V1] : [V1], next_cursor: null } }),
      'GET /map-versions/v2/voxels': pages(3, 20000) }));
    await open();
    await openVoxel();
    expect(field('지도 이름').value).toBe('본동 1층');
    expect(form().textContent).toContain('구역, 지점, 연결점은 새 지도로 옮겨지지 않습니다');   // 지금 지도가 있으면 알림
    const f = PLY();
    await pick(f);
    await click(btn('올리기', form()));
    const up = calls.filter((c) => c.method === 'POST');
    expect(up.map((c) => c.path)).toEqual(['/floors/f1/voxel-maps']);
    expect(Object.fromEntries(up[0].q)).toEqual({ name: '본동 1층', format: 'ply', base_version_id: 'v1' });
    expect(up[0].type).toBe('application/octet-stream');
    expect(up[0].body).toBe(f);                                              // 고른 파일 그대로(이름·경로는 본문·주소에 없음)
    expect(up[0].q.toString()).not.toContain('room');
    const done = $('[data-voxel-done]')!;
    expect(done.textContent).toContain('3D 지도로 이 층의 지도와 시뮬 지형을 만들었습니다.');
    expect([...done.querySelectorAll('[data-voxel-warnings] li')].map((l) => l.textContent)).toEqual(WARN);
    expect(done.querySelector('[data-voxel-terrain]')!.getAttribute('href')).toBe('#/terrain');
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/sites').length).toBeGreaterThan(1);   // 지도 다시 받기
    await click(btn('3D 로 보기', done));
    expect($('[data-voxel-done]')).toBeNull();
    expect(last?.n).toBe(1);
    expect(last?.pages.flat()).toHaveLength(3);
  });
  it('보내기 전 막기: 다른 파일 형식·빈 이름·50 MB 넘음 → 요청 없음', async () => {
    serve(signedIn(KIM, null));
    await open();
    await openVoxel();
    expect(form().textContent).not.toContain('옮겨지지 않습니다');   // 새 층(지도 없음)은 바꿈 알림 없음
    await click(btn('올리기', form()));
    expect(form().textContent).toContain('3D 지도 파일(.pcd·.ply)을 고르세요.');
    await pick(new File(['x'], 'room.obj'));
    await click(btn('올리기', form()));
    expect(form().textContent).toContain('.pcd 또는 .ply 파일이어야 합니다.');
    const big = new File(['x'], 'big.pcd'); Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    await pick(big);
    await click(btn('올리기', form()));
    expect(form().textContent).toContain('50 MB 까지');
    await pick(PLY()); await setVal(field('지도 이름'), '  ');
    await click(btn('올리기', form()));
    expect(form().textContent).toContain('지도 이름을 입력하세요.');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
  it('서버 오류는 서버 문구 그대로, 바뀐 지도(409)는 «새로 불러오기», 새 층은 base 없이', async () => {
    let n = 0;
    serve(signedIn(KIM, null, { 'POST /floors/f1/voxel-maps': () => (++n === 1 ? err(422, 'INVALID_POINT_CLOUD', '압축 PCD는 지원하지 않습니다. ASCII 또는 binary로 내보내 주세요.')
      : n === 2 ? err(503, 'UPLOAD_BUSY', '다른 점 지도를 처리하고 있습니다. 잠시 뒤 다시 올려 주세요.') : err(409, 'STALE', '승인된 지도 판이 바뀌었습니다.')) }));
    await open();
    await openVoxel();
    await pick(new File(['x'], 'scan.PCD'));
    await click(btn('올리기', form()));
    expect(form().querySelector('[role=alert]')!.textContent).toBe('올리지 못했습니다. 압축 PCD는 지원하지 않습니다. ASCII 또는 binary로 내보내 주세요.');
    expect(calls.find((c) => c.method === 'POST')!.q.has('base_version_id')).toBe(false);
    expect(calls.find((c) => c.method === 'POST')!.q.get('format')).toBe('pcd');
    await click(btn('올리기', form()));
    expect(form().textContent).toContain('다른 점 지도를 처리하고 있습니다.');
    await click(btn('올리기', form()));
    expect(form().textContent).toContain('다른 사람이 먼저 이 층의 지도를 바꿨습니다.');
    expect(btn('새로 불러오기', form())).toBeTruthy();
    expect($('[data-voxel-done]')).toBeNull();
  });
  it('운영 관리자: 3D 파일 고르기 없음(총괄 권한) — 그림·yaml 올리기만', async () => {
    serve(signedIn(LEE, 'v1'));
    await open();
    await click(btn('새 지도 올리기…'));
    expect($('[data-up-kind]')).toBeNull();
    expect($('[aria-label="3D 지도 올리기"]')).toBeNull();
    expect(btn('올리기')).toBeTruthy();
  });
});

describe('3D 로 보기', () => {
  it('묶음을 cursor 순서로 끝까지 받아 그린다(묶음마다 붙임)·높이 범례', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/voxels': pages(45000, 20000), 'GET /map-versions/v2': { status: 200, body: { ...V2, voxel_map: SUM('v2', 45000) } } }));
    await open();
    expect($('[data-voxel-summary]')!.textContent).toContain('3D 지도 파일에서 만든 지도');
    await click($('[data-voxel-toggle]'));
    const got = calls.filter((c) => c.path === '/map-versions/v2/voxels');
    expect(got.map((c) => [c.q.get('cursor'), c.q.get('limit')])).toEqual([['0', '20000'], ['20000', '20000'], ['40000', '20000']]);
    expect(last?.n).toBe(3);
    expect(last?.pages.reduce((a, p) => a + p.length, 0)).toBe(45000);
    expect($('[data-voxel-loading]')).toBeNull();
    expect($('[data-voxel-legend]')!.textContent).toContain('높이바닥 0 m2 m 이상· 끌어서 돌리기 · 휠로 확대');
    expect($('[data-voxel-toggle]')!.textContent).toBe('지도 보기');
    await click($('[data-voxel-toggle]'));
    expect($('[data-voxel-view]')).toBeNull();
  });
  it('중간 묶음 실패 → 받은 데까지 두고 «이어 받기»는 실패한 자리부터', async () => {
    let fail = true;
    const ok = pages(30000, 20000);
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/voxels': (q) => (q.get('cursor') === '20000' && fail ? (fail = false, err(503, 'FILE_STORAGE_ERROR', '3D 칸 자료를 읽을 수 없습니다.')) : ok(q)) }));
    await open();
    await click($('[data-voxel-toggle]'));
    expect($('[data-voxel-view] [role=alert]')!.textContent).toContain('20,000칸까지');
    expect(last?.n).toBe(1);
    await click(btn('이어 받기'));
    expect(calls.filter((c) => c.path === '/map-versions/v2/voxels').map((c) => c.q.get('cursor'))).toEqual(['0', '20000', '20000']);
    expect(last?.n).toBe(2);
    expect($('[data-voxel-view] [role=alert]')).toBeNull();
  });
  it('빈 지도: 칸 자료 없음(404)·빈 묶음 → «3D 자료가 없습니다», 그리지 않음', async () => {
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/voxels': err(404, 'NOT_FOUND', '이 지도 판에는 3D 칸 자료가 없습니다.') }));
    await open();
    await click($('[data-voxel-toggle]'));
    expect($('[data-voxel-empty]')!.textContent).toBe('이 지도에는 3D 자료가 없습니다.');
    expect($('[data-fake3d]')).toBeNull();
    act(() => root?.unmount()); box.remove();
    serve(signedIn(KIM, 'v2', { 'GET /map-versions/v2/voxels': { status: 200, body: { summary: SUM('v2', 0), cells: [], next_cursor: null, max_page_size: 20000 } } }));
    await open();
    await click($('[data-voxel-toggle]'));
    expect($('[data-voxel-empty]')).toBeTruthy();
  });
  it('3D 아닌 지도: «3D 로 보기»·3D 표시 없음', async () => {
    serve(signedIn(KIM, 'v1'));
    await open();
    expect($('[data-voxel-toggle]')).toBeNull();
    expect($('[data-voxel-summary]')).toBeNull();
  });
});

describe('3D 표시·지형 수정하기 길', () => {
  it('지도 고르기 카드에 «3D», 저장 기록 줄에도', async () => {
    serve(signedIn(KIM, 'v2'));
    await open(false);
    expect($('[data-building="b1"] [data-voxel-chip]')!.textContent).toBe('3D');
    act(() => root?.unmount()); box.remove();
    serve(signedIn(KIM, 'v1'));
    await open(false);
    expect($('[data-voxel-chip]')).toBeNull();
  });
  it('«시뮬 지형 수정하기» → 지형 화면이 서버 목록을 받은 뒤 그 지형을 연다', async () => {
    serve(signedIn(KIM, 'v2'));
    await open();
    const a = $('[data-voxel-summary] [data-voxel-terrain]')!;
    expect(a.getAttribute('href')).toBe('#/terrain');
    act(() => { a.addEventListener('click', (e) => e.preventDefault(), { once: true }); a.click(); });
    expect(terrainAsk.id).toBe('vox-abc');
    act(() => root?.unmount()); box.remove();
    vi.spyOn(api, 'me').mockResolvedValue(KIM);
    vi.spyOn(api, 'terrains').mockResolvedValue([TER]);
    const one = vi.spyOn(api, 'terrain').mockResolvedValue(TER);
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<Terrain />); });
    await flush();
    expect(one).toHaveBeenCalledWith('vox-abc', expect.anything());
    expect(box.querySelector<HTMLInputElement>('[data-terrain-name]')!.value).toBe('본동 1층');
    expect(terrainAsk.id).toBe('');
  });
});

describe('높이색·좌표', () => {
  it('바닥 주황(30°) → 2 m 이상 자주(300°), 음수는 바닥색', () => {
    expect([hueAt(-1), hueAt(0), hueAt(1), hueAt(2), hueAt(5)]).toEqual([30, 30, 165, 300, 300]);
  });
  it('칸 중심 = origin + (index + .5) × 0.1', () => {
    const [x, y, z] = centerOf([-5, -4, 0], 0.1, [0, 10, -1]);
    expect([x, y, z].map((n) => +n.toFixed(3))).toEqual([-4.95, -2.95, -0.05]);
  });
});

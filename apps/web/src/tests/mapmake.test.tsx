// RB-SLAM-WEB 지도 탭 «지도 만들기»(apps/server/MAPPING.md → 11-25 RB-SLAM-WEB2 apps/server/SLAM-CONTRACT.md) — 가짜 서버 응답으로: 담당 아님 숨김, 연결 안 됨 막힘,
// source=point_lio 시작, 1초 조회, 2D 조각 cursor 따라가기·판 바뀜·409, 3D 칸 증분, 받은 범위만(RECEIVED_ONLY), 시작이 오래 걸림 안내, 취소,
// 저장 성공 뒤 새 판 선택, FAILED 다시 저장·STALE, 창 닫으면 조회 멈춤, 다른 층 세션 안내. 화면 글에 «SLAM» 없음.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MappingProgress, MapVersion, RobotSummary, SiteTree, User } from '../../../contracts/ts';
import { Root } from '../session';
import { clearPlans } from '../screens/missions';
import { kept } from '../screens/mapedit';
import { RECEIVED_TEXT, SLOW_START_S, SLOW_TEXT, STALE_TEXT } from '../screens/mapmake';
import { FakeWS, state } from './fakeWs';
import { FakeVox } from './fakeVox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const PARK: User = { ...LEE, id: 'o2', username: 'park', display_name: '박운영', robot_ids: [] };
let allowed = false;   // 서버가 이 PC 조종을 허용함(server_drive_allowed)
const robot = (online: boolean): RobotSummary => ({ id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name }, simulation: false, server_drive_allowed: allowed,
  connection: online ? 'ONLINE' : 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] });
const floor = (id: string, name: string, level: number, approved: string | null) => ({ id, building_id: 'b1', name, level, approved_version_id: approved, pending_count: 0 });
const tree = (approved: string) => ({ items: [{ id: 's1', name: '본관', purpose: 'REAL', buildings: [{ id: 'b1', site_id: 's1', name: '본동', floors: [floor('f1', '1층', 1, approved), floor('f2', '2층', 2, null)] }] }], next_cursor: null } as unknown as SiteTree);
const EMPTY = { zones: [], waypoints: [], connectors: [], edits: [] };
const ver = (id: string, number: number, p: Partial<MapVersion> = {}): MapVersion => ({ upload_id: `up-${id}`, id, floor_id: 'f1', number, base_version_id: null, copied_from_id: null, status: 'APPROVED', image_sha256: 'ab'.repeat(32),
  width: 100, height: 80, resolution: 0.05, origin: [-1, -2, 0], features: EMPTY, reason: `이유 ${number}`, source: 'IMPORT', created_by: KIM.id, created_at: '2026-10-20T05:00:00Z', ...p });
const V2 = ver('v2', 2), V3 = ver('v3', 3, { source: 'SLAM', base_version_id: 'v2', reason: '로봇으로 만든 지도', created_at: '2026-11-12T05:00:00Z' });
const SID = '11111111-1111-4111-8111-111111111111';
/** 진행 자료(Point-LIO 판 1): 첫 3D 증분(reset, 5칸)·로봇 위치 */
const CELLS: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [2, 0, 1], [0, 5, 2], [10, 5, 3]];
const vox = (seq: number, p: Partial<NonNullable<MappingProgress['voxels']>> = {}) => ({ revision: 1, seq, frame_id: 'map', resolution: 0.05 as const, ...p });
const ODOM = { provider: 'point_lio' as const, source: '/aft_mapped_to_init', frame_id: 'map', stamp: { sec: 1, nanosec: 0 }, x: 0.5, y: 0.2, z: 0.3, yaw: 0.1 };
const prog = (status: MappingProgress['status'], p: Partial<MappingProgress> = {}): MappingProgress => ({ session_id: SID, floor_id: 'f1', status, source: 'point_lio', pipeline: 'point_lio+glim',
  revision: 1, update_seq: 3, voxels: vox(0, { reset: true, added: CELLS }), odom: ODOM, ...p });
/** 2D 조각(64×64칸, 벽 한 칸) */
const tile = (x: number, y: number, tile_seq = 1, revision = 1) => ({ revision, tile_seq, x, y, frame_id: 'map', floor_z: 0, resolution: 0.05, size: 64, cells: Array.from({ length: 4096 }, (_, i) => (i === 0 ? 2 : 1)) });
const page = (tiles: unknown[], next_cursor: number | null, update_seq = 3, revision = 1) => ({ status: 200, body: { session_id: SID, revision, update_seq, tiles, next_cursor } });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown; raw?: ArrayBuffer };
type Route = Reply | ((body?: unknown, q?: URLSearchParams) => Reply);
type Call = { method: string; path: string; body?: unknown; q: string };
let calls: Call[] = [];
function serve(routes: Record<string, Route>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, q = ''] = url.replace(/^\/api\/v1/, '').split('?'), body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, q });
    const hit = routes[`${method} ${path}`], rep = typeof hit === 'function' ? hit(body, new URLSearchParams(q)) : hit ?? err(404, 'NOT_FOUND', '없음');
    return new Response(rep.raw ?? (rep.status === 204 ? null : JSON.stringify(rep.body ?? null)), { status: rep.status, headers: { 'Content-Type': rep.raw ? 'application/octet-stream' : 'application/json' } });
  });
}
/** slam = GET /robots/r-a/slam 이 돌려줄 값(함수면 부를 때마다) */
const signedIn = (me: User, online: boolean, slam: () => MappingProgress | null, more: Record<string, Route> = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: [robot(online)], next_cursor: null } },
  'GET /robots/r-a': { status: 200, body: robot(online) },
  'GET /dashboard': { status: 200, body: { robots_total: 1, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } },
  'GET /notifications': { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } },
  'GET /events': { status: 200, body: { items: [], next_cursor: null } },
  'GET /approvals': { status: 200, body: { items: [], next_cursor: null } },
  'GET /users': { status: 200, body: { items: [KIM, LEE, PARK], next_cursor: null } },
  'GET /sites': { status: 200, body: tree('v2') },
  'GET /map-versions/v2': { status: 200, body: V2 }, 'GET /map-versions/v3': { status: 200, body: V3 },
  'GET /floors/f1/map-versions': { status: 200, body: { items: [V2], next_cursor: null } },
  'GET /scenarios': { status: 200, body: { items: [], next_cursor: null } },
  'GET /robots/r-a/slam': () => ({ status: 200, body: fed(slam()) }),
  [`GET /robots/r-a/slam/${SID}/tiles`]: page([tile(0, 0)], null),
  [`GET /robots/r-a/slam/${SID}/voxels`]: (_b?: unknown, q?: URLSearchParams) => { fed(slam()); return VS.reply(q!); },
  ...more,
});

/** 가짜 서버 3D 칸 저장 — 진행 자료에 실린 agent 보고(voxels)를 받은 대로 쌓는다(웹은 voxels API 로만 3D 를 받음, 11-25 RB-SLAM-WEB4) */
let VS = new FakeVox(SID);
const fed = (x: MappingProgress | null) => { if (x?.voxels && x.session_id === SID) VS.report(x.voxels); return x; };
const voxQ = () => calls.filter((c) => c.path === `/robots/r-a/slam/${SID}/voxels`).map((c) => c.q);
let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function open() {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/map';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
  const b = box.querySelector<HTMLButtonElement>('[aria-label="지도 고르기"] [data-building]');
  if (b) { act(() => b.click()); await flush(); }
}
/** 실시간 연결로 로봇 상태(연결됨/끊김)를 받는다 — 화면의 «연결됨»은 실시간 state 만 믿는다 */
const live = async (online: boolean) => { act(() => { FakeWS.last.open(); FakeWS.last.recv(state('r-a', { connection: online ? 'ONLINE' : 'OFFLINE' })); }); await flush(); };
beforeEach(() => { VS = new FakeVox(SID); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
afterEach(() => { allowed = false; act(() => root?.unmount()); root = null; box?.remove(); kept.d = null; clearPlans(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const dlg = () => $('dialog[open][aria-labelledby]')!;
const gets = () => calls.filter((c) => c.method === 'GET' && c.path === '/robots/r-a/slam');
const posts = () => calls.filter((c) => c.method === 'POST' && c.path.startsWith('/robots/r-a/slam'));
const openMake = async () => { await click($('[data-make-open]')); expect(dlg().textContent).toContain('로봇으로 지도 만들기'); };

describe('지도 만들기 — 보이는 조건', () => {
  it('담당 운영자에게만 단추: 총괄·다른 운영자는 숨김', async () => {
    for (const me of [KIM, PARK]) {
      serve(signedIn(me, true, () => null)); await open();
      expect($('[aria-label="지도 보기"]')).toBeTruthy();
      expect($('[data-make-open]')).toBeNull();
      act(() => root?.unmount()); box.remove();
    }
    serve(signedIn(LEE, true, () => null)); await open();
    expect(btn('지도 만들기')).toBeTruthy();
    expect(btn('새 지도 올리기…')).toBeTruthy();
  });

  it('고르기 화면 «+ 지도 만들기»(담당 운영자만) → «어느 층에?» → 층을 고르면 그 층에서 로봇으로 지도 만들기 창', async () => {
    for (const me of [KIM, PARK]) {
      serve(signedIn(me, true, () => null)); await open(); await click($('[data-to-chooser]'));
      expect($('[data-make-robot]')).toBeNull(); expect($('[data-make-file]')).toBeTruthy();
      act(() => root?.unmount()); box.remove();
    }
    serve(signedIn(LEE, true, () => null)); await open(); await click($('[data-to-chooser]'));
    await click($('[data-make-robot]'));
    expect(dlg().textContent).toContain('지도 만들기 — 어느 층에?');
    expect(btn('이름 바꾸기', dlg())).toBeUndefined();
    await click(dlg().querySelector('ul[aria-label] button'));
    expect(dlg().textContent).toContain('로봇으로 지도 만들기');
    expect(dlg().querySelector('select')).toBeTruthy();
    expect(box.querySelectorAll('dialog[open]')).toHaveLength(1);
  });

  it('연결 안 된 로봇은 고를 수 있되 이유를 보이고 시작을 막는다', async () => {
    serve(signedIn(LEE, false, () => null)); await open(); await live(false); await openMake();
    expect(dlg().querySelector('select')!.textContent).toContain('Go2-A (연결 안 됨)');
    expect($('[data-offline]')!.textContent).toBe('로봇이 연결되어 있지 않습니다.');
    expect(btn('지도 만들기', dlg())!.disabled).toBe(true);
    expect(posts()).toEqual([]);
  });
});

describe('지도 만들기 — 진행', () => {
  it('«지도 만들기» = POST start {floor_id, source: point_lio}, 뒤로 1초마다 조회 + 받은 3D 칸·2D 조각·로봇, 화면 글에 SLAM 없음', async () => {
    let now: MappingProgress | null = null;
    serve(signedIn(LEE, true, () => now, { 'POST /robots/r-a/slam/start': () => { now = prog('RUNNING'); return { status: 202, body: now }; } }));
    await open(); await live(true); await openMake();
    expect(gets().length).toBe(1);   // 열 때 한 번(진행 중 세션이 있으면 이어서)
    await click(btn('지도 만들기', dlg()));
    expect(posts().map((c) => [c.path, c.body])).toEqual([['/robots/r-a/slam/start', { floor_id: 'f1', source: 'point_lio' }]]);
    expect($('[data-slam-boxes]')!.dataset.slamBoxes).toBe('5');
    expect($('canvas[data-slam-tiles]')!.dataset.slamTiles).toBe('1');
    expect($('canvas[data-slam-robot]')).toBeTruthy();
    expect($('[data-progress]')!.textContent).toContain('5받은 3D 칸');
    expect($('[data-progress]')!.textContent).toContain('1받은 2D 조각');
    expect($('[data-gap]')).toBeNull();
    expect(dlg().textContent).toContain('폰 조종 화면으로 로봇을 천천히 움직이세요');
    const n = gets().length;
    await wait(1100); await flush();
    expect(gets().length).toBe(n + 1);
    await wait(1100); await flush();
    expect(gets().length).toBe(n + 2);
    expect(box.textContent).not.toMatch(/SLAM/);
  });

  it('지도 저장 → SAVING 표시 → SAVED 면 창 닫고 층 판 목록을 다시 받아 새 지도 선택 + 완료 알림, 기록에 «로봇으로 만든 지도»', async () => {
    let now: MappingProgress | null = prog('RUNNING'), saved = false;
    serve(signedIn(LEE, true, () => now, {
      'POST /robots/r-a/slam/save': (b) => { expect(b).toEqual({ session_id: SID }); now = prog('SAVING'); return { status: 202, body: now }; },
      'GET /sites': () => ({ status: 200, body: tree(saved ? 'v3' : 'v2') }),
      'GET /floors/f1/map-versions': () => ({ status: 200, body: { items: saved ? [V3, { ...V2, status: 'SUPERSEDED' }] : [V2], next_cursor: null } }),
    }));
    await open(); await openMake();
    await click(btn('지도 저장', dlg()));
    expect($('[data-saving]')).toBeTruthy();
    now = prog('SAVED', { map_version_id: 'v3', terrain_id: 't-1' }); saved = true;
    await wait(1100); await flush(); await flush();
    expect($('dialog[open][aria-labelledby]')?.textContent ?? '').not.toContain('로봇으로 지도 만들기');
    expect(box.textContent).toContain('로봇으로 만든 지도와 시뮬 지형을 만들었습니다.');
    const row = $('[data-save="v3"] button')!;
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.querySelector('[data-slam-chip]')!.textContent).toBe('로봇으로 만든 지도');
    // 다시 열면 이미 알린 SAVED 는 다시 알리지 않고 새로 시작할 수 있다
    await openMake();
    expect(btn('지도 만들기', dlg())).toBeTruthy();
  });

  /** 시험마다 다른 세션(완료 알림은 세션마다 한 번 — 화면 메모리) */
  const mine = (session_id: string) => (s: MappingProgress['status'], p: Partial<MappingProgress> = {}) => prog(s, { session_id, ...p });
  /** 저장된 서버(1층 v3 승인) — saved 전에는 옛 지도 */
  const savedServer = (get: () => MappingProgress | null, save: () => Reply, s: { saved: boolean }) => signedIn(LEE, true, get, {
    'POST /robots/r-a/slam/save': save,
    'GET /floors/f1/map-versions': () => ({ status: 200, body: { items: s.saved ? [V3, { ...V2, status: 'SUPERSEDED' }] : [V2], next_cursor: null } }),
    'GET /floors/f2/map-versions': { status: 200, body: { items: [], next_cursor: null } },
  });
  const madeV3 = () => {
    expect(box.textContent).toContain('로봇으로 만든 지도와 시뮬 지형을 만들었습니다.');
    expect($('[data-save="v3"] button')!.getAttribute('aria-pressed')).toBe('true');
  };

  it('회귀: 1층 저장 중 창을 닫고 2층 창에서 SAVED 를 받아도, 1층으로 돌아와 열면 완료 알림 + 새 지도 선택', async () => {
    const prog = mine('22222222-2222-4222-8222-222222222222');
    const s = { saved: false };
    let now: MappingProgress | null = prog('RUNNING');
    serve(savedServer(() => now, () => { now = prog('SAVING'); return { status: 202, body: now }; }, s));
    await open(); await openMake();
    await click(btn('지도 저장', dlg()));
    await click($('[aria-label="로봇으로 지도 만들기 닫기"]'));
    now = prog('SAVED', { map_version_id: 'v3', terrain_id: 't-1' }); s.saved = true;
    await click($('[data-floor="f2"]'));
    await openMake();
    expect(btn('지도 만들기', dlg())).toBeTruthy();   // 2층에서는 1층 저장을 알리지 않는다
    expect(box.textContent).not.toContain('로봇으로 만든 지도와 시뮬 지형을 만들었습니다.');
    await click($('[aria-label="로봇으로 지도 만들기 닫기"]'));
    await click($('[data-floor="f1"]'));
    await click($('[data-make-open]')); await flush();   // 열자마자 이 층 SAVED 를 받아 완료 처리(창 닫힘)
    madeV3();
  });

  it('회귀: 서버는 저장했는데 save 응답이 끊겨도 다음 조회의 SAVED 로 완료 알림 + 새 지도 선택', async () => {
    const prog = mine('33333333-3333-4333-8333-333333333333');
    const s = { saved: false };
    let now: MappingProgress | null = prog('RUNNING');
    // 저장이 빨리 끝나 다음 조회부터 SAVED(SAVING 을 한 번도 못 봄)
    serve(savedServer(() => now, () => { now = prog('SAVED', { map_version_id: 'v3', terrain_id: 't-1' }); s.saved = true; throw new TypeError('network'); }, s));
    await open(); await openMake();
    await click(btn('지도 저장', dlg())); await flush();
    madeV3();
  });

  it('지난 SAVED(그 뒤 지도가 바뀌어 v3 가 지난 저장)는 다시 알리지 않는다', async () => {
    const prog = mine('44444444-4444-4444-8444-444444444444');
    serve(signedIn(LEE, true, () => prog('SAVED', { map_version_id: 'v3', terrain_id: 't-1' }), {
      'GET /sites': { status: 200, body: tree('v4') },
      'GET /map-versions/v4': { status: 200, body: ver('v4', 4) },
      'GET /floors/f1/map-versions': { status: 200, body: { items: [ver('v4', 4), { ...V3, status: 'SUPERSEDED' }], next_cursor: null } },
    }));
    await open(); await openMake(); await flush();
    expect(box.textContent).not.toContain('로봇으로 만든 지도와 시뮬 지형을 만들었습니다.');
    expect(btn('지도 만들기', dlg())).toBeTruthy();
  });

  it('FAILED: 쉬운 이유 + «다시 저장»(FAILED 에서 save), LINK_LOST 는 정해진 문구, 409 STALE 이면 취소하고 다시 시작 안내', async () => {
    let now: MappingProgress | null = prog('FAILED', { error_code: 'LINK_LOST', reason: '연결 끊김' }), stale = false;
    serve(signedIn(LEE, true, () => now, {
      'POST /robots/r-a/slam/save': () => (stale ? err(409, 'STALE', 'stale') : (now = prog('FAILED', { error_code: 'CONVERT', reason: '점이 너무 적어 지도를 만들지 못했습니다.' }), { status: 202, body: now })),
      'POST /robots/r-a/slam/cancel': () => (now = prog('CANCELLED'), { status: 200, body: now }),
    }));
    await open(); await openMake();
    expect($('[data-failed]')!.textContent).toBe('연결이 끊겨 그리기를 멈췄습니다. 지금까지 그린 것을 저장하거나 취소하세요.');
    await click(btn('다시 저장', dlg()));
    expect(posts().map((c) => c.path)).toEqual(['/robots/r-a/slam/save']);
    expect($('[data-failed]')!.textContent).toBe('점이 너무 적어 지도를 만들지 못했습니다.');
    stale = true;
    await click(btn('다시 저장', dlg()));
    expect(dlg().textContent).toContain(STALE_TEXT);
    expect(btn('다시 저장', dlg())).toBeUndefined();
    // 취소는 확인 한 번
    await click(btn('취소', dlg()));
    expect(posts().filter((c) => c.path.endsWith('/cancel'))).toEqual([]);
    await click(btn('취소하기', dlg()));
    expect(posts().filter((c) => c.path.endsWith('/cancel')).map((c) => c.body)).toEqual([{ session_id: SID }]);
    expect(dlg().textContent).toContain('지도 만들기를 취소했습니다.');
  });

  it('창을 닫으면(언마운트) 조회가 멈추고 다시 열면 GET 으로 이어서 보인다', async () => {
    serve(signedIn(LEE, true, () => prog('RUNNING')));
    await open(); await openMake();
    expect($('[data-progress="RUNNING"]')).toBeTruthy();
    await click($('[aria-label="로봇으로 지도 만들기 닫기"]'));
    const n = gets().length;
    await wait(2300); await flush();
    expect(gets().length).toBe(n);
    await openMake();
    expect(gets().length).toBe(n + 1);
    expect($('[data-progress="RUNNING"]')).toBeTruthy();
  });

  it('같은 로봇이 다른 층에서 만드는 중이면 그 층 이름과 안내, 시작 없음', async () => {
    serve(signedIn(LEE, true, () => prog('RUNNING', { floor_id: 'f2' })));
    await open(); await openMake();
    expect($('[data-elsewhere]')!.textContent).toContain('«본동 2층»');
    expect(btn('지도 만들기', dlg())).toBeUndefined();
  });
});

describe('지도 만들기 — 받은 칸 놓기(11-25 RB-SLAM-WEB2, 브라우저 계산 없음)', () => {
  const tiles = () => calls.filter((c) => c.path === `/robots/r-a/slam/${SID}/tiles`).map((c) => c.q);
  const shown = () => [$('[data-slam-boxes]')!.dataset.slamBoxes, $('canvas[data-slam-tiles]')?.dataset.slamTiles];

  it('2D 조각: cursor 를 null 까지 따라가고, 다음 번은 첫 쪽 update_seq 이후만 · 3D 는 voxels API(since 이어 받기, 조회 사이 지나간 증분도 빠짐없이)', async () => {
    let now = prog('RUNNING');
    serve(signedIn(LEE, true, () => now, {
      [`GET /robots/r-a/slam/${SID}/tiles`]: (_b, q) => q!.get('cursor') === '0' && q!.get('since') === '0' ? page([tile(0, 0), tile(1, 0), tile(0, 1), tile(1, 1)], 99)
        : q!.get('cursor') === '99' ? page([tile(2, 0)], null, 4) : page([tile(0, 0, 2), tile(3, 3)], null, 5),
    }));
    await open(); await openMake();
    expect(tiles()).toEqual(['revision=1&cursor=0&since=0', 'revision=1&cursor=99&since=0']);
    expect(shown()).toEqual(['5', '5']);
    now = prog('RUNNING', { update_seq: 6, voxels: vox(1, { added: [[7, 7, 7]], removed: [[0, 0, 0], [1, 0, 0]] }) });
    await wait(1100); await flush();
    expect(tiles().slice(2)).toEqual(['revision=1&cursor=0&since=3']);   // 첫 쪽 update_seq(3) 이후 바뀐 것만
    expect(shown()).toEqual(['4', '6']);   // 칸 5 − 2 + 1, 조각 (0,0) 은 새 판 번호로 바뀌고 (3,3) 추가
    expect($('[data-gap]')).toBeNull();
    VS.report(vox(2, { added: [[9, 9, 9]], removed: [[2, 0, 1]] }));   // 조회 사이에 지나간 증분(진행 자료엔 안 보임)
    now = prog('RUNNING', { update_seq: 7, voxels: vox(3, { added: [[8, 8, 8]] }) });
    await wait(1100); await flush();
    expect(shown()[0]).toBe('5');   // 4 + 9,9,9 − 2,0,1 + 8,8,8 — 놓친 seq 2 도 서버에서 받음
    expect($('[data-gap]')).toBeNull();
    expect(voxQ().slice(-1)[0]).toBe('revision=1&since=1');   // 앞 번 첫 쪽 seq 이후만
    expect(calls.some((c) => /occ|grid/i.test(c.path))).toBe(false);
  });

  it('판(revision)이 바뀌면 3D·2D 를 비우고 새 판을 처음부터 · 조각 409(판 바뀜)면 조각을 비운다', async () => {
    let now = prog('RUNNING'), conflict = false;
    serve(signedIn(LEE, true, () => now, {
      [`GET /robots/r-a/slam/${SID}/tiles`]: (_b, q) => (q!.get('revision') === '2' ? page([tile(5, 5, 1, 2)], null, 9, 2)
        : conflict ? err(409, 'MAPPING_REVISION_CONFLICT', '지도 판이 바뀌었습니다.') : page([tile(0, 0), tile(1, 0)], null)),
    }));
    await open(); await openMake();
    expect(shown()).toEqual(['5', '2']);
    conflict = true; now = prog('RUNNING', { update_seq: 8, voxels: null });
    await wait(1100); await flush();
    expect(shown()).toEqual(['5', '0']);
    now = prog('SAVING', { revision: 2, update_seq: 9, source: 'glim', voxels: vox(0, { revision: 2, reset: true, added: [[1, 1, 1], [2, 2, 2]] }), odom: { ...ODOM, provider: 'glim' } });
    await wait(1100); await flush();
    expect(tiles().slice(-1)[0]).toBe('revision=2&cursor=0&since=0');
    expect(shown()).toEqual(['2', '1']);
    expect($('[data-saving]')).toBeTruthy();
  });

  it('진행 조회가 끊겼다 이어지면 3D 를 처음부터(since=0) 받아, 끊긴 동안 reset 된 옛 칸이 남지 않음 (RB-SLAM-WEB4)', async () => {
    let now = prog('RUNNING'), down = false;
    serve(signedIn(LEE, true, () => now, { 'GET /robots/r-a/slam': () => (down ? err(503, 'UNAVAILABLE', '잠시 뒤') : { status: 200, body: fed(now) }) }));
    await open(); await openMake();
    expect(shown()[0]).toBe('5');
    now = prog('RUNNING', { update_seq: 4, voxels: vox(1, { added: [[7, 7, 7]] }) });
    await wait(1100); await flush();
    expect(voxQ().slice(-1)[0]).toBe('revision=1&since=0');
    expect(shown()[0]).toBe('6');
    down = true;
    await wait(1100); await flush();
    expect(dlg().textContent).toContain('진행 상황을 받지 못했습니다.');
    VS.report(vox(2, { reset: true, added: [[1, 1, 1]] }));   // 끊긴 동안 판 안 reset
    now = prog('RUNNING', { update_seq: 5, voxels: vox(2, { reset: true, added: [[1, 1, 1]] }) }); down = false;
    await wait(1100); await flush();
    expect(voxQ().slice(-1)[0]).toBe('revision=1&since=0');
    expect(shown()[0]).toBe('1');
  });

  it('RECEIVED_ONLY: 창을 닫지 않고 «받은 범위만 — 저장 확인 안 됨» + 서버가 받지 않은 자료 이유, «받은 지도 보기»로 그 판', async () => {
    const V9 = ver('v9', 9, { source: 'SLAM', status: 'PENDING', reason: 'SLAM 저장 미확인 · 받은 범위' });
    serve(signedIn(LEE, true, () => prog('RECEIVED_ONLY', { session_id: '55555555-5555-4555-8555-555555555555', map_version_id: 'v9', terrain_status: 'SKIPPED_UNCONFIRMED_SAVE',
      last_report_rejection: { code: 'MAPPING_SOURCE_CONFLICT', reason: '지도 출처를 확인해 주세요.', received_at: '2026-11-25T01:00:00Z' } }), {
      'GET /floors/f1/map-versions': { status: 200, body: { items: [V9, V2], next_cursor: null } }, 'GET /map-versions/v9': { status: 200, body: V9 },
    }));
    await open(); await openMake(); await flush();
    expect($('[data-received]')!.textContent).toContain(RECEIVED_TEXT);
    expect($('[data-rejected]')!.textContent).toContain('지도 출처를 확인해 주세요.');
    expect(btn('지도 만들기', dlg())).toBeTruthy();   // 끝난 세션 — 새로 시작할 수 있다
    await click(btn('받은 지도 보기', dlg()));
    expect($('dialog[open][aria-labelledby]')?.textContent ?? '').not.toContain('로봇으로 지도 만들기');
    expect(box.textContent).toContain(RECEIVED_TEXT);
    expect($('[data-save="v9"] button')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('시작 중이 오래 가면 로봇 프로그램 업데이트 안내, 취소 = POST cancel {session_id} → 취소됨', async () => {
    let now: MappingProgress = prog('STARTING', { voxels: null, odom: null, update_seq: 0 });
    serve(signedIn(LEE, true, () => now, { 'POST /robots/r-a/slam/cancel': (b) => { expect(b).toEqual({ session_id: SID }); now = prog('CANCELLED'); return { status: 200, body: now }; } }));
    await open(); await openMake();
    expect($('[data-starting]')).toBeTruthy();
    expect($('[data-slow]')).toBeNull();
    expect(btn('지도 저장', dlg())).toBeUndefined();
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + (SLOW_START_S + 1) * 1000);
    await wait(1100); await flush();
    expect($('[data-slow]')!.textContent).toBe(SLOW_TEXT);
    await click(btn('취소', dlg())); await click(btn('취소하기', dlg()));
    expect(dlg().textContent).toContain('지도 만들기를 취소했습니다.');
    expect(btn('지도 만들기', dlg())).toBeTruthy();
  });
});

describe('로봇으로 만든 지도 다시 열기(bundle voxels·grid)', () => {
  const B = { session_id: SID, source: 'glim' as const, robot_id: 'r-a', map_version_id: 'v3', revision: 2, resolution: 0.05 as const, slam_save: 'SLAM_SAVED' as const, completeness: 'SLAM_CONFIRMED' as const };
  const V3B = { ...V3, slam_bundle: B };
  const manifest = (voxel_count: number) => ({ status: 200, body: { map_version_id: 'v3', terrain_id: null, bundle: { ...B, voxel_count, floor_z: -0.3, odom: ODOM,
    grid: { revision: 2, resolution: 0.05, frame_id: 'map', origin: [-1, -2, 0], floor_z: -0.3, width: 4, height: 2 } } } });
  const bytes = (a: ArrayLike<number>, T: typeof Int32Array | typeof Uint8Array) => new T(Array.from(a)).buffer as ArrayBuffer;
  const server = (count: number) => signedIn(LEE, true, () => null, {
    'GET /floors/f1/map-versions': { status: 200, body: { items: [V3B, V2], next_cursor: null } }, 'GET /map-versions/v3': { status: 200, body: V3B },
    [`GET /robots/r-a/slam/${SID}/bundle`]: manifest(count),
    [`GET /robots/r-a/slam/${SID}/bundle/voxels`]: { status: 200, raw: bytes([0, 0, 0, 1, 2, 3, -4, -5, 6], Int32Array) },
    [`GET /robots/r-a/slam/${SID}/bundle/grid`]: { status: 200, raw: bytes([2, 1, 1, 0, 0, 1, 2, 2], Uint8Array) },
  });
  const view3d = async () => { await click($('[data-save="v3"] button')); await click($('[data-voxel-toggle]')); await flush(); };

  it('담당 운영자: «3D 로 보기» = 저장 묶음의 3D 칸·2D 격자를 같은 그리기로(3D 를 못 그리는 브라우저면 위에서 보기)', async () => {
    serve(server(3)); await open(); await view3d();
    expect(calls.filter((c) => c.path.includes('/bundle')).map((c) => c.path).sort()).toEqual([`/robots/r-a/slam/${SID}/bundle`, `/robots/r-a/slam/${SID}/bundle/grid`, `/robots/r-a/slam/${SID}/bundle/voxels`]);
    expect($('[data-slam-saved] [data-slam-boxes]')!.dataset.slamBoxes).toBe('3');
    expect($('[data-slam-saved] canvas[data-slam-tiles]')!.dataset.slamTiles).toBe('1');
    expect($('[data-slam-saved] [data-slam-pick="3d"]')!.hasAttribute('disabled')).toBe(true);   // jsdom 은 WebGL2 없음
  });

  it('칸 수와 파일 길이가 어긋나면 그리지 않고 알림 · 담당이 아니면 단추 없음', async () => {
    serve(server(4)); await open(); await view3d();
    expect($('[data-slam-saved] [role="alert"]')!.textContent).toContain('형식이 맞지 않습니다');
    act(() => root?.unmount()); root = null; box.remove();
    serve({ ...server(3), 'GET /me': { status: 200, body: PARK } }); await open();
    await click($('[data-save="v3"] button'));
    expect($('[data-voxel-toggle]')).toBeNull();
  });
});

describe('지도 만들기 — 창 안에서 조종(11-13 RB-MAP-VIEW-WEB)', () => {
  it('그리는 중 + 서버가 이 PC 조종을 허용한 내 로봇: 실시간 지도 아래 같은 조종 패널(STOP·조종 시작), 저장 중이 되면 사라진다 · 개발 용어 없음', async () => {
    allowed = true;
    let now: MappingProgress | null = null;
    serve(signedIn(LEE, true, () => now, { 'POST /robots/r-a/slam/start': () => { now = prog('RUNNING'); return { status: 202, body: now }; },
      'POST /robots/r-a/slam/save': () => { now = prog('SAVING'); return { status: 202, body: now }; } }));
    await open(); await live(true); await openMake();
    expect(dlg().textContent).toContain('«지도 만들기»를 누른 뒤 이 창의 조종 단추나 키보드로 로봇을 움직이고');
    expect($('[data-make-drive]')).toBeNull();   // 시작 전에는 조종 없음
    await click(btn('지도 만들기', dlg()));
    const d = $('[data-make-drive] [data-server-drive]')!;
    expect($('[data-slam-boxes]')!.dataset.slamBoxes).toBe('5');
    expect(d.querySelector('[data-sd-stop="panel"]')).toBeTruthy();
    expect(btn('조종 시작', d)).toBeTruthy();
    expect(dlg().textContent).toContain('만드는 중 — 이 창의 조종 단추나 키보드로 로봇을 천천히 움직이세요.');
    expect(dlg().textContent).not.toMatch(/SLAM|odom|deskew/i);
    await click(btn('지도 저장', dlg()));
    expect($('[data-saving]')).toBeTruthy();
    expect($('[data-make-drive]')).toBeNull();
  });

  it('서버가 허용하지 않은 로봇은 지금처럼 폰 조종 안내만 — 조종·STOP 패널 없음', async () => {
    serve(signedIn(LEE, true, () => prog('RUNNING')));
    await open(); await live(true); await openMake();
    expect($('[data-progress="RUNNING"]')).toBeTruthy();
    expect($('[data-make-drive]')).toBeNull();
    expect(dlg().querySelector('[data-sd-stop]')).toBeNull();
    expect(dlg().textContent).toContain('폰 조종 화면으로 로봇을 천천히 움직이세요');
  });

  it('담당이 아닌 운영자·총괄은 허용된 로봇이어도 창을 열 단추가 없어 조종이 붙지 않는다', async () => {
    allowed = true;
    for (const me of [KIM, PARK]) {
      serve(signedIn(me, true, () => prog('RUNNING')));
      await open();
      expect($('[data-make-open]')).toBeNull();
      expect($('[data-make-drive]')).toBeNull();
      act(() => root?.unmount()); root = null; box.remove();
    }
  });
});

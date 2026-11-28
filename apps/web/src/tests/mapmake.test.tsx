// RB-SLAM-WEB 지도 탭 «지도 만들기»(apps/server/MAPPING.md → 11-25 RB-SLAM-WEB2 apps/server/SLAM-CONTRACT.md) — 가짜 서버 응답으로: 담당 아님 숨김, 연결 안 됨 막힘,
// source=point_lio 시작, 1초 조회, 2D 조각 cursor 따라가기·판 바뀜·409, 3D 칸 증분, 받은 범위만(RECEIVED_ONLY), 시작이 오래 걸림 안내, 취소,
// 저장 성공 뒤 새 판 선택, FAILED 다시 저장·STALE, 창 닫으면 조회 멈춤, 다른 층 세션 안내. 화면 글에 «SLAM» 없음.
// 11-27 RB-MAP-LIVE-WEB: Point-LIO·GLIM 상태 두 줄(이유 코드·단계), GLIM 미리보기 겹침·토글(기준 다르면 따로), 옛 서버 그대로.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MappingGlimStatus, MappingPointLioStatus, MappingProgress, MappingSources, MapVersion, RobotSummary, SiteTree, User } from '../../../contracts/ts';
import { Root } from '../session';
import { clearPlans } from '../screens/missions';
import { kept } from '../screens/mapedit';
import { BEFORE, GLIM_STAGE, LIO_WHY, MapBox, RECEIVED_TEXT, SLOW_START_S, SLOW_TEXT, STALE_TEXT, Sources } from '../screens/mapmake';
import { OVER_MAX, SlamView } from '../screens/slammap';
import { COL } from '../occmap';
import { api } from '../api';
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
  { const o = box.querySelector<HTMLButtonElement>('[data-open-map]'); if (o) { act(() => o.click()); await flush(); } }   // 시안 u7_1: 건물 = 고르기, «지도 열기»로 연다
}
/** 실시간 연결로 로봇 상태(연결됨/끊김)를 받는다 — 화면의 «연결됨»은 실시간 state 만 믿는다 */
const live = async (online: boolean) => { act(() => { FakeWS.last.open(); FakeWS.last.recv(state('r-a', { connection: online ? 'ONLINE' : 'OFFLINE' })); }); await flush(); };
beforeEach(() => { VS = new FakeVox(SID); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
afterEach(() => { allowed = false; act(() => root?.unmount()); root = null; box?.remove(); kept.d = null; clearPlans(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button, [role=button]')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
/** 꺼짐: button 은 disabled, 시안 단추(div role=button)는 aria-disabled */
const off = (b: Element | undefined) => !!b && ((b as HTMLButtonElement).disabled === true || b.getAttribute('aria-disabled') === 'true');
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
/** 지도 만들기 화면 = 시안 u7_6 · u7_7 · u7_8 (옛 창 없음) */
const dlg = () => $('[data-u7="u7_6_scan"],[data-u7="u7_7_lost"],[data-u7="u7_8_process"]')!;
const gets = () => calls.filter((c) => c.method === 'GET' && c.path === '/robots/r-a/slam');
const posts = () => calls.filter((c) => c.method === 'POST' && c.path.startsWith('/robots/r-a/slam'));
const openMake = async () => { await click($('[data-make-open]')); expect(dlg()).toBeTruthy(); };

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

  it('고르기 화면 «+ 지도 만들기»(담당 운영자만) → 바로 시안 u7_6(옛 «어느 층에?» 창 없음) · 층 칩에서 고르기 전에는 스캔 시작 막힘 · 고르면 그 층의 u7_6', async () => {
    for (const me of [KIM, PARK]) {
      serve(signedIn(me, true, () => null)); await open(); await click($('[data-to-chooser]'));
      expect($('[data-make-robot]')!.getAttribute('aria-disabled')).toBe('true');   // 담당 실기 없음 = 누르면 까닭 한 줄 · u7_6 안 열림
      await click($('[data-make-robot]')); expect($('[data-u7="u7_6_scan"]')).toBeNull();
      act(() => root?.unmount()); box.remove();
    }
    serve(signedIn(LEE, true, () => null)); await open(); await live(true); await click($('[data-to-chooser]'));
    await click($('[data-make-robot]'));
    expect(box.querySelectorAll('dialog[open]')).toHaveLength(0);
    expect(dlg().getAttribute('data-u7')).toBe('u7_6_scan');
    expect(dlg().querySelector('.head .ttl')!.textContent).toBe('새 지도');
    const sel = dlg().querySelector<HTMLSelectElement>('[data-chip="floor"] select')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['층 고르기', '본관 본동 1층', '본관 본동 2층']);
    expect(off(btn('스캔 시작', dlg()))).toBe(true);
    expect($('[data-nofloor]')!.textContent).toBe('머리줄에서 지도 만들 층을 고르세요.');
    act(() => { sel.value = 'f2'; sel.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(dlg().getAttribute('data-u7')).toBe('u7_6_scan');
    expect(dlg().querySelector('.head .ttl')!.textContent).toBe('새 지도 · 본동 2층');
    expect($('[data-chip="floor"]')).toBeNull();
    expect(dlg().querySelector('[data-chip="robot"] select')).toBeTruthy();
    expect(off(btn('스캔 시작', dlg()))).toBe(false);
    expect(posts()).toEqual([]);
  });

  it('연결 안 된 로봇은 고를 수 있되 이유를 보이고 시작을 막는다', async () => {
    serve(signedIn(LEE, false, () => null)); await open(); await live(false); await openMake();
    expect(dlg().querySelector('select')!.textContent).toContain('Go2-A (연결 안 됨)');
    expect($('[data-offline]')!.textContent).toBe('로봇이 연결되어 있지 않습니다.');
    expect(off(btn('스캔 시작', dlg()))).toBe(true);
    expect(posts()).toEqual([]);
  });
});

describe('지도 만들기 — 진행', () => {
  it('«지도 만들기» = POST start {floor_id, source: point_lio}, 뒤로 1초마다 조회 + 받은 3D 칸·2D 조각·로봇, 화면 글에 SLAM 없음', async () => {
    let now: MappingProgress | null = null;
    serve(signedIn(LEE, true, () => now, { 'POST /robots/r-a/slam/start': () => { now = prog('RUNNING'); return { status: 202, body: now }; } }));
    await open(); await live(true); await openMake();
    expect(gets().length).toBe(1);   // 열 때 한 번(진행 중 세션이 있으면 이어서)
    await click(btn('스캔 시작', dlg()));
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
    await click(btn('스캔 끝내기', dlg()));
    expect($('[data-saving]')).toBeTruthy();
    now = prog('SAVED', { map_version_id: 'v3', terrain_id: 't-1' }); saved = true;
    await wait(1100); await flush(); await flush();
    expect(dlg()).toBeNull();   // 시안 화면을 닫고 층 화면으로
    expect(box.textContent).toContain('로봇으로 만든 지도와 시뮬 지형을 만들었습니다.');
    const kv = $('[aria-label="이 지도"]')!.textContent!;   // 층 화면 「이 지도」 = 새 지도(v3 · 로봇으로 그림)
    expect(kv).toContain('v3'); expect(kv).toContain('로봇으로 그림');
    // 다시 열면 이미 알린 SAVED 는 다시 알리지 않고 새로 시작할 수 있다
    await openMake();
    expect(btn('스캔 시작', dlg())).toBeTruthy();
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
    expect($('[aria-label="이 지도"]')!.textContent).toContain('v3');
  };

  it('회귀: 1층 저장 중 창을 닫고 2층 창에서 SAVED 를 받아도, 1층으로 돌아와 열면 완료 알림 + 새 지도 선택', async () => {
    const prog = mine('22222222-2222-4222-8222-222222222222');
    const s = { saved: false };
    let now: MappingProgress | null = prog('RUNNING');
    serve(savedServer(() => now, () => { now = prog('SAVING'); return { status: 202, body: now }; }, s));
    await open(); await openMake();
    await click(btn('스캔 끝내기', dlg()));
    await click($('[data-u7-back]'));
    now = prog('SAVED', { map_version_id: 'v3', terrain_id: 't-1' }); s.saved = true;
    await click($('[data-floor="f2"]'));
    await openMake();
    expect(btn('스캔 시작', dlg())).toBeTruthy();   // 2층에서는 1층 저장을 알리지 않는다
    expect(box.textContent).not.toContain('로봇으로 만든 지도와 시뮬 지형을 만들었습니다.');
    await click($('[data-u7-back]'));
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
    await click(btn('스캔 끝내기', dlg())); await flush();
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
    expect(btn('스캔 시작', dlg())).toBeTruthy();
  });

  it('FAILED: 쉬운 이유 + «다시 저장»(FAILED 에서 save), LINK_LOST 는 정해진 문구, 409 STALE 이면 취소하고 다시 시작 안내', async () => {
    let now: MappingProgress | null = prog('FAILED', { error_code: 'LINK_LOST', reason: '연결 끊김' }), stale = false;
    serve(signedIn(LEE, true, () => now, {
      'POST /robots/r-a/slam/save': () => (stale ? err(409, 'STALE', 'stale') : (now = prog('FAILED', { error_code: 'CONVERT', reason: '점이 너무 적어 지도를 만들지 못했습니다.' }), { status: 202, body: now })),
      'POST /robots/r-a/slam/cancel': () => (now = prog('CANCELLED'), { status: 200, body: now }),
    }));
    await open(); await openMake();
    expect($('[data-failed]')!.textContent).toBe('연결이 끊겨 지도 기록은 로봇에서 계속합니다');
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
    await click(btn('버리고 취소', dlg()));
    expect(posts().filter((c) => c.path.endsWith('/cancel')).map((c) => c.body)).toEqual([{ session_id: SID }]);
    expect(dlg().textContent).toContain('지도 만들기를 취소했습니다.');
  });

  it('창을 닫으면(언마운트) 조회가 멈추고 다시 열면 GET 으로 이어서 보인다', async () => {
    serve(signedIn(LEE, true, () => prog('RUNNING')));
    await open(); await openMake();
    expect($('[data-progress="RUNNING"]')).toBeTruthy();
    await click($('[data-u7-back]'));
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
    expect(btn('스캔 시작', dlg())).toBeUndefined();
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
    expect(btn('스캔 시작', dlg())).toBeTruthy();   // 끝난 세션 — 새로 시작할 수 있다
    await click(btn('받은 지도 보기', dlg()));
    expect(dlg()).toBeNull();   // 시안 화면을 닫고 층 화면으로
    expect(box.textContent).toContain(RECEIVED_TEXT);
    expect($('[aria-label="이 지도"]')!.textContent).toContain('v9');
  });

  it('요청을 보내는 동안 회색인 단추 아래 «요청을 보내는 중» 한 줄, 답이 오면 사라짐 (U11-02)', async () => {
    serve(signedIn(LEE, true, () => null));
    await open(); await live(true); await openMake();
    let done: (x: MappingProgress) => void = () => {};
    vi.spyOn(api, 'slamDo').mockReturnValue(new Promise((r) => { done = r; }));
    expect($('[data-make-busy]')).toBeNull();
    act(() => btn('스캔 시작', dlg())!.click());
    expect(off(btn('스캔 시작', dlg()))).toBe(true);
    expect($('[data-make-busy]')!.textContent).toBe('요청을 보내는 중… 답이 오면 단추가 다시 켜집니다.');
    await act(async () => { done(prog('RUNNING')); }); await flush();
    expect($('[data-make-busy]')).toBeNull();
  });
  it('시작 중이 오래 가면 로봇 프로그램 업데이트 안내, 취소 = POST cancel {session_id} → 취소됨', async () => {
    let now: MappingProgress = prog('STARTING', { voxels: null, odom: null, update_seq: 0 });
    serve(signedIn(LEE, true, () => now, { 'POST /robots/r-a/slam/cancel': (b) => { expect(b).toEqual({ session_id: SID }); now = prog('CANCELLED'); return { status: 200, body: now }; } }));
    await open(); await openMake();
    expect($('[data-starting]')).toBeTruthy();
    expect($('[data-slow]')).toBeNull();
    expect(off(btn('스캔 끝내기', dlg()))).toBe(true);   // 켜는 중엔 끝내기 꺼짐
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + (SLOW_START_S + 1) * 1000);
    await wait(1100); await flush();
    expect($('[data-slow]')!.textContent).toBe(SLOW_TEXT);
    await click(btn('취소', dlg())); await click(btn('버리고 취소', dlg()));
    expect(dlg().textContent).toContain('지도 만들기를 취소했습니다.');
    expect(btn('스캔 시작', dlg())).toBeTruthy();
  });
});

describe('로봇으로 만든 지도 다시 열기(bundle voxels·grid)', () => {
  const B = { session_id: SID, source: 'glim' as const, robot_id: 'r-a', map_version_id: 'v3', revision: 2, resolution: 0.05 as const, slam_save: 'SLAM_SAVED' as const, completeness: 'SLAM_CONFIRMED' as const };
  const V3B = { ...V3, slam_bundle: B };
  const manifest = (voxel_count: number) => ({ status: 200, body: { map_version_id: 'v3', terrain_id: null, bundle: { ...B, voxel_count, floor_z: -0.3, odom: ODOM,
    grid: { revision: 2, resolution: 0.05, frame_id: 'map', origin: [-1, -2, 0], floor_z: -0.3, width: 4, height: 2 } } } });
  const bytes = (a: ArrayLike<number>, T: typeof Int32Array | typeof Uint8Array) => new T(Array.from(a)).buffer as ArrayBuffer;
  const server = (count: number) => signedIn(LEE, true, () => null, { 'GET /sites': { status: 200, body: tree('v3') },
    'GET /floors/f1/map-versions': { status: 200, body: { items: [V3B, V2], next_cursor: null } }, 'GET /map-versions/v3': { status: 200, body: V3B },
    [`GET /robots/r-a/slam/${SID}/bundle`]: manifest(count),
    [`GET /robots/r-a/slam/${SID}/bundle/voxels`]: { status: 200, raw: bytes([0, 0, 0, 1, 2, 3, -4, -5, 6], Int32Array) },
    [`GET /robots/r-a/slam/${SID}/bundle/grid`]: { status: 200, raw: bytes([2, 1, 1, 0, 0, 1, 2, 2], Uint8Array) },
  });
  const view3d = async () => { await click($('[data-voxel-toggle]')); await flush(); };

  it('담당 운영자: «3D 로 보기» = 저장 묶음의 3D 칸·2D 격자를 같은 그리기로(3D 를 못 그리는 브라우저면 위에서 보기)', async () => {
    serve(server(3)); await open(); await view3d();
    expect(calls.filter((c) => c.path.includes('/bundle')).map((c) => c.path).sort()).toEqual([`/robots/r-a/slam/${SID}/bundle`, `/robots/r-a/slam/${SID}/bundle/grid`, `/robots/r-a/slam/${SID}/bundle/voxels`]);
    expect($('[data-slam-saved] [data-slam-boxes]')!.dataset.slamBoxes).toBe('3');
    expect($('[data-slam-saved] canvas[data-slam-tiles]')!.dataset.slamTiles).toBe('1');
    expect($('[data-slam-saved] [data-slam-pick="3d"]')!.hasAttribute('disabled')).toBe(true);   // jsdom 은 WebGL2 없음
    // RB-MAP-LIVE-WEB: 저장 지도 보기는 겹침·고르기 단추·상태 줄 없음(SlamView 선택 prop 를 주지 않음 = 그대로)
    expect($('[data-slam-saved] canvas[data-over-cells]')).toBeNull();
    expect($('[data-layer]')).toBeNull(); expect($('[data-sources]')).toBeNull();
  });

  it('칸 수와 파일 길이가 어긋나면 그리지 않고 알림 · 담당이 아니면 단추 없음', async () => {
    serve(server(4)); await open(); await view3d();
    expect($('[data-slam-saved] [role="alert"]')!.textContent).toContain('형식이 맞지 않습니다');
    act(() => root?.unmount()); root = null; box.remove();
    serve({ ...server(3), 'GET /me': { status: 200, body: PARK } }); await open();
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
    expect(dlg().textContent).toContain('오른쪽 조종 칸이나 리모컨으로 로봇을 천천히 걷게 하세요.');
    expect($('[data-make-drive]')).toBeNull();   // 시작 전에는 조종 없음
    await click(btn('스캔 시작', dlg()));
    const d = $('[data-make-drive] [data-server-drive]')!;
    expect($('[data-slam-boxes]')!.dataset.slamBoxes).toBe('5');
    expect(d.querySelector('[data-sd-stop="panel"]')).toBeTruthy();
    expect(btn('조종 시작', d)).toBeTruthy();
    expect(dlg().textContent).toContain('만드는 중 · 이 창의 조종 단추나 키보드로 로봇을 천천히 움직이세요.');
    expect(dlg().textContent).not.toMatch(/SLAM|odom|deskew/i);
    await click(btn('스캔 끝내기', dlg()));
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

describe('지도 만들기 — Point-LIO·GLIM 상태와 GLIM 미리보기(11-27 RB-MAP-LIVE-WEB)', () => {
  const PL: MappingPointLioStatus = { active: true, fresh: true, pose_age_s: 0.1, cloud_age_s: 0.08, position_valid: true, reason_code: null, reason: null, position_m: [1.234, -2.345, 0.3], pose_hz: 10, cloud_hz: 10 };
  const GL: MappingGlimStatus = { stage: 'RECEIVING', data_age_s: 0.4, processed_chunks: null, gpu: null, reason: null };
  const src = (pl: Partial<MappingPointLioStatus> = {}, gl: Partial<MappingGlimStatus> = {}) => ({ sources: { reported_at: '2026-11-27T06:00:00Z', point_lio: { ...PL, ...pl }, glim: { ...GL, ...gl } } });
  const GP = (frame_id: string, cells: [number, number, number][] = [[-5, 16, 1], [0, 0, 0], [3, 2, 1]]) => ({ glim_preview: { source: 'glim' as const, seq: 1, frame_id, stamp: { sec: 42, nanosec: 0 }, resolution: 0.25 as const, cells } });
  const line = (k: string) => $(`[data-src="${k}"]`)!;
  const shown = async (x: MappingProgress) => { serve(signedIn(LEE, true, () => x)); await open(); await live(true); await openMake(); };
  const again = () => { act(() => root?.unmount()); root = null; box.remove(); };

  it('시안 u7_6 · u7_7 · u7_8: 위치 맞춤 정상 = 스캔 화면, 이유 코드 = 위치 잃음 화면, 저장 중 = 처리 화면 · 서버에 없는 값은 «확인 안 됨»', async () => {
    await shown(prog('RUNNING', { elapsed_s: 402, distance_m: 182, ...src() }));
    expect(dlg().dataset.u7).toBe('u7_6_scan');
    expect($('[data-chip="lio"]')!.textContent).toBe('위치 잡힘Point-LIO');
    expect($('[data-scan-walk="time"]')!.textContent).toBe('걸은 시간06:42분 : 초');
    expect($('[data-scan-walk="points"]')!.textContent).toContain('확인 안 됨');   // point_count 없음
    expect($('[data-chip="mode"]')!.textContent).toContain('확인 안 됨');
    again();
    await shown(prog('RUNNING', src({ fresh: false, position_valid: false, reason_code: 'POSITION_JUMP' })));
    expect(dlg().dataset.u7).toBe('u7_7_lost');
    expect($('[data-lost]')!.textContent).toContain(LIO_WHY.POSITION_JUMP);
    expect($('[data-chip="lio"]')!.textContent).toBe('위치 잃음Point-LIO');
    again();
    await shown(prog('SAVING', src({}, { stage: 'SAVING', processed_chunks: 1200 })));
    expect(dlg().dataset.u7).toBe('u7_8_process');
    expect(dlg().textContent).toContain('남은 시간 확인 안 됨');
    expect(btn('지도 목록으로', dlg())).toBeTruthy();
  });

  it('시작 전: 두 줄 모두 «스캔 시작을 누르면 켜집니다»(노랑)', async () => {
    serve(signedIn(LEE, true, () => null)); await open(); await live(true); await openMake();
    for (const k of ['point_lio', 'glim']) { expect(line(k).textContent).toContain(BEFORE); expect(line(k).dataset.lamp).toBe('warn'); }
  });

  it('정상: «실시간 위치 정상 · 0.1초 전 · 10Hz» + 위치 x,y m(초록) · GLIM 받는 중 + 마지막 자료 나이', async () => {
    await shown(prog('RUNNING', src()));
    expect(line('point_lio').dataset.lamp).toBe('ok');
    expect(line('point_lio').textContent).toBe('● Point-LIO 실시간 위치 정상 · 0.1초 전 · 10Hz · x 1.23 · y -2.35 m');
    expect(line('glim').dataset.lamp).toBe('ok');
    expect(line('glim').textContent).toContain('받는 중 · 마지막 자료 0.4초 전');
    expect(box.textContent).not.toMatch(/SLAM/);
  });

  it('이유 코드마다 쉬운 한국어(빨강) · 켜는 중의 자료 없음은 기다림(노랑)', async () => {
    expect(LIO_WHY.POSITION_OUT_OF_RANGE).toBe('위치가 비정상적으로 멀리 튀었습니다(발산)');
    expect(LIO_WHY.MISSING_DATA).toBe('위치 자료가 들어오지 않습니다');
    const codes = ['POSITION_OUT_OF_RANGE', 'MISSING_DATA', 'POSITION_JUMP', 'STAMP_REGRESSION', 'FRAME_MISMATCH', 'STAMP_SKEW', 'STALE', 'INVALID_DATA'] as const;
    for (const code of codes) {
      let x = prog('RUNNING', src({ fresh: false, position_valid: code === 'POSITION_OUT_OF_RANGE' ? false : true, reason_code: code, reason: 'raw', pose_age_s: 3.2 }));
      serve(signedIn(LEE, true, () => x)); await open(); await live(true); await openMake();
      expect(line('point_lio').dataset.lamp).toBe('bad');
      expect(line('point_lio').textContent).toContain(`${LIO_WHY[code]} · 3.2초 전`);
      expect(line('point_lio').textContent).not.toContain('raw');
      again();
    }
    await shown(prog('STARTING', src({ fresh: false, active: null, reason_code: 'MISSING_DATA', pose_age_s: null, position_m: null }, { stage: 'STARTING', data_age_s: null })));
    expect(line('point_lio').dataset.lamp).toBe('warn');
    expect(line('point_lio').textContent).toBe('● Point-LIO 기다리는 중');
    expect(line('glim').textContent).toBe('● GLIM 켜는 중');
  });

  it('GLIM 단계 글: 꺼짐·켜는 중·받는 중·저장 중(처리 조각)·모름, 만드는 중 꺼짐은 빨강', async () => {
    expect(GLIM_STAGE).toEqual({ OFF: '꺼짐', STARTING: '켜는 중', RECEIVING: '받는 중', SAVING: '저장 중', UNKNOWN: '상태를 알 수 없습니다' });
    await shown(prog('RUNNING', src({}, { stage: 'OFF', data_age_s: 75, reason: 'GLIM 이 응답하지 않습니다' })));
    expect(line('glim').dataset.lamp).toBe('bad');
    expect(line('glim').textContent).toBe('● GLIM 꺼짐 · 마지막 자료 1분 전 · GLIM 이 응답하지 않습니다');
    again();
    await shown(prog('SAVING', src({}, { stage: 'SAVING', data_age_s: 1.5, processed_chunks: 1200 })));
    expect(line('glim').dataset.lamp).toBe('warn');
    expect(line('glim').textContent).toBe('● GLIM 저장 중 · 마지막 자료 1.5초 전 · 1,200조각 처리');
  });

  it('시작이 거절돼도(FAILED) 두 줄로 원인이 보인다', async () => {
    await shown(prog('FAILED', { error_code: 'START_REJECTED', reason: '지도 기능을 켜지 못했습니다.', ...src({ fresh: false, position_valid: false, reason_code: 'POSITION_OUT_OF_RANGE' }, { stage: 'OFF', data_age_s: null }) }));
    expect($('[data-failed]')!.textContent).toBe('지도 기능을 켜지 못했습니다.');
    expect(line('point_lio').textContent).toContain('발산');
    expect(line('glim').dataset.lamp).toBe('bad');
  });

  it('옛 서버(sources·glim_preview 없음): 상태 줄·겹침 단추 없이 지금 화면 그대로', async () => {
    await shown(prog('RUNNING'));
    expect($('[data-sources]')).toBeNull(); expect($('[data-layer]')).toBeNull(); expect($('[data-glim-preview]')).toBeNull();
    expect($('canvas[data-slam-tiles]')!.dataset.slamTiles).toBe('1');
    expect($('canvas[data-over-cells]')).toBeNull();
    expect(dlg().textContent).toContain('만드는 중');
  });

  it('같은 기준(frame_id)이면 Point-LIO 위에 GLIM 칸을 겹치고, 두 단추로 각각 켜고 끈다(기본 둘 다) · «GLIM 미리보기, 저장 전»', async () => {
    await shown(prog('RUNNING', { ...src(), ...GP('map') }));   // 시험 Point-LIO 그림 frame = map
    const cv = () => $('canvas[data-slam-tiles]')!, on = (k: string) => $(`[data-layer="${k}"]`)!.getAttribute('aria-pressed');
    expect($('[data-glim-preview]')!.dataset.glimPreview).toBe('over');
    expect($('[data-glim-preview]')!.textContent).toContain('GLIM 미리보기, 저장 전');
    expect($('[data-glim-preview]')!.textContent).not.toContain('좌표 맞춤 전');
    expect([on('point_lio'), on('glim'), cv().dataset.slamTiles, cv().dataset.overCells]).toEqual(['true', 'true', '1', '3']);
    await click($('[data-layer="glim"]'));
    expect([on('glim'), cv().dataset.slamTiles, cv().dataset.overCells]).toEqual(['false', '1', undefined]);
    await click($('[data-layer="glim"]')); await click($('[data-layer="point_lio"]'));
    expect([on('point_lio'), cv().dataset.slamTiles, cv().dataset.overCells]).toEqual(['false', '0', '3']);
    expect($('[data-slam-pick="3d"]')!.hasAttribute('disabled')).toBe(true);   // Point-LIO 를 끄면 3D 상자도 막음
    expect(cv().hasAttribute('data-slam-robot')).toBe(true);   // 같은 기준이라 로봇 위치는 그대로
    await click($('[data-layer="glim"]'));
    expect($('[data-slam-view]')!.textContent).toContain('보이게 고른 지도에 아직 받은 칸이 없습니다.');
  });

  it('기준이 다르면(glim_map ≠ Point-LIO) 겹치지 않고 «좌표 맞춤 전» + 하나만 보기: 기본 Point-LIO, GLIM 을 누르면 GLIM 만(로봇 화살표 뺌)', async () => {
    await shown(prog('RUNNING', { ...src(), ...GP('glim_map') }));
    const cv = () => $('canvas[data-slam-tiles]')!, on = (k: string) => $(`[data-layer="${k}"]`)!.getAttribute('aria-pressed');
    expect($('[data-glim-preview]')!.dataset.glimPreview).toBe('apart');
    expect($('[data-glim-preview]')!.textContent).toContain('GLIM 미리보기, 저장 전 · 좌표 맞춤 전이라 겹치지 않고 따로 봅니다');
    expect([on('point_lio'), on('glim'), cv().dataset.slamTiles, cv().dataset.overCells]).toEqual(['true', 'false', '1', undefined]);
    await click($('[data-layer="glim"]'));
    expect([on('point_lio'), on('glim'), cv().dataset.slamTiles, cv().dataset.overCells]).toEqual(['false', 'true', '0', '3']);
    expect(cv().hasAttribute('data-slam-robot')).toBe(false);
    await click($('[data-layer="point_lio"]'));
    expect([on('point_lio'), on('glim'), cv().dataset.slamTiles, cv().dataset.overCells]).toEqual(['true', 'false', '1', undefined]);
    expect(cv().hasAttribute('data-slam-robot')).toBe(true);
  });

  it('그리기: GLIM 칸은 0.25 m 칸 하나마다 사각형, Point-LIO 를 끄면 조각은 그리지 않는다', async () => {
    const ops: string[] = [];
    const ctx = { setTransform() {}, fillRect: () => ops.push('rect'), drawImage: () => ops.push('tile'), save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, imageSmoothingEnabled: true, globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1 };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    await shown(prog('RUNNING', { ...src(), ...GP('map') }));
    expect(ops.filter((o) => o === 'tile').length).toBeGreaterThan(0);
    ops.length = 0; await click($('[data-layer="point_lio"]'));
    expect(ops).toEqual(['rect', 'rect', 'rect', 'rect']);   // 배경 + GLIM 3칸, 조각 없음
  });
});

describe('지도 만들기 — 받은 상태·미리보기 모양 검사(RV-519)', () => {
  const PL: MappingPointLioStatus = { active: true, fresh: true, pose_age_s: 0.1, cloud_age_s: 0.1, position_valid: true, reason_code: null, reason: null, position_m: [1, 2, 3], pose_hz: 10, cloud_hz: 10 };
  const GL: MappingGlimStatus = { stage: 'RECEIVING', data_age_s: 0.1, processed_chunks: null, gpu: null, reason: null };
  const html = (s: unknown) => renderToStaticMarkup(<Sources st="RUNNING" s={s as MappingSources} />);
  const mount = () => { box = document.createElement('div'); document.body.append(box); root = createRoot(box); };
  const draw = async (el: React.ReactElement) => { await act(async () => { root!.render(el); }); };
  const tiles = (frame: (rev: number) => string, fill: (rev: number) => number) => vi.spyOn(api, 'slamTiles').mockImplementation(async (_r, sid, revision) => ({ session_id: sid, revision, update_seq: 1, next_cursor: null,
    tiles: [{ revision, tile_seq: 1, x: 0, y: 0, frame_id: frame(revision), floor_z: 0, cells: Array(4096).fill(fill(revision)) }] }) as never);
  const noVox = () => vi.spyOn(api, 'slamVoxels').mockImplementation(async (_r, sid, revision) => ({ session_id: sid, revision, seq: 0, reset: true, reset_seq: 0, added: [], removed: [], next_cursor: null }) as never);
  const live = (revision: number, frame: string, gp: unknown = { frame_id: frame, resolution: 0.25, cells: [[revision, 0, 0]] }) => ({ session_id: 'session', floor_id: 'floor', status: 'RUNNING', source: 'point_lio',
    revision, update_seq: revision, voxels: { revision, seq: 1, frame_id: frame }, glim_preview: gp }) as unknown as MappingProgress;

  it('sources 일부·null·잘못된 모양이어도 예외 없이 «기다리는 중»(노랑), 옛 서버(없음)는 그대로 안 그림', () => {
    expect(html(undefined)).toBe(''); expect(html(null)).toBe('');
    const lamp = (h: string, k: string) => new RegExp(`data-src="${k}" data-lamp="(\\w+)"`).exec(h)![1];
    // [보낸 sources, Point-LIO 점, GLIM 점] — 없거나 틀린 쪽은 «기다리는 중»(노랑)
    for (const [s, pl, gl] of [[{}, 'warn', 'warn'], ['x', 'warn', 'warn'], [{ point_lio: null, glim: GL }, 'warn', 'ok'], [{ point_lio: PL }, 'ok', 'warn'], [{ point_lio: PL, glim: null }, 'ok', 'warn'],
      [{ point_lio: 'x', glim: 5 }, 'warn', 'warn'], [{ point_lio: { ...PL, position_m: [1] }, glim: GL }, 'warn', 'ok']] as const) {
      let h = '';
      expect(() => { h = html(s); }).not.toThrow();
      expect([lamp(h, 'point_lio'), lamp(h, 'glim')]).toEqual([pl, gl]);
      expect(h).toContain('기다리는 중'); expect(h).not.toContain('NaN');
    }
    expect(html({ point_lio: { ...PL, fresh: false, reason_code: 'constructor' }, glim: { ...GL, stage: 'toString' } })).toContain('위치 자료에 문제가 있습니다');
  });

  it('음수·NaN 나이, NaN 위치, position_valid 누락, fresh 만 있음 → 초록 «정상» 아님', () => {
    const lamp = (h: string) => /data-src="point_lio" data-lamp="(\w+)"/.exec(h)![1];
    expect(lamp(html({ point_lio: PL, glim: GL }))).toBe('ok');
    for (const pl of [{ ...PL, pose_age_s: -3 }, { ...PL, pose_age_s: Number.NaN }, { ...PL, position_m: [Number.NaN, 2, 3] }, { ...PL, position_valid: undefined }, { ...PL, pose_hz: Number.NaN }, { fresh: true }]) {
      const h = html({ point_lio: pl, glim: GL });
      expect(lamp(h)).toBe('warn'); expect(h).not.toContain('실시간 위치 정상'); expect(h).not.toContain('NaN'); expect(h).not.toContain('-3.0초');
    }
  });

  it('긴 이유 글은 200자까지, GLIM 칸은 1024칸까지만 그린다', async () => {
    expect(html({ point_lio: { ...PL, fresh: false, reason_code: 'NEW_REASON', reason: 'x'.repeat(100000) }, glim: GL }).length).toBeLessThan(2000);
    let rects = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, fillRect() { rects++; }, save() {}, restore() {}, imageSmoothingEnabled: false, globalAlpha: 1, fillStyle: '' } as never);
    mount();
    const pic = { xyz: new Float32Array(), n: 0, ver: 1, patches: [], tver: 1, pose: null, gap: false };
    const cells = Array.from({ length: 50000 }, (_, i) => [i % 1000, Math.floor(i / 1000), 0] as [number, number, number]);
    await draw(<SlamView pic={pic} over={{ cells, res: 0.25 }} empty="empty" />);
    expect(rects).toBe(OVER_MAX + 1);   // 배경 + 1024칸
    expect(box.querySelector('canvas')!.dataset.overCells).toBe(String(OVER_MAX));
  });

  it('잘못된 GLIM 칸(NaN·글자)·해상도는 그 칸만 빼고, Point-LIO 그림은 지우지 않는다', async () => {
    let drawn = 0, rects = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, fillRect() { rects++; }, drawImage() { drawn++; }, save() {}, restore() {},
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} } as never);
    mount();
    const pic = { xyz: new Float32Array(), n: 0, ver: 1, patches: [{ key: 'tile', seq: 1, x0: 0, y0: 0, w: 1, h: 1, cells: [1] }], tver: 1, pose: null, gap: false };
    for (const [i, over] of [{ cells: [[NaN, 0, 0], [1, 1, 0]], res: 0.25 }, { cells: [['bad', 0, 0], [1, 1, 0], [1, 1], 7], res: 0.25 }, { cells: [[1, 1, 0]], res: NaN }, { cells: 'bad', res: 0.25 }].entries()) {
      drawn = rects = 0;
      await draw(<SlamView key={i} pic={pic} over={over as never} empty="empty" />);
      expect(drawn).toBe(1);
      expect(rects).toBe(Number.isNaN(over.res) || !Array.isArray(over.cells) ? 1 : 2);   // 배경 (+ 맞는 칸 하나)
    }
  });

  it('판·frame 이 old→new 로 바뀌는 사이 지난 판 그림 위에 새 GLIM 칸을 겹치지 않는다', async () => {
    const images = new Map<HTMLCanvasElement, number>(), frames: { base: number[]; overlays: number }[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const cv = this;
      return { globalAlpha: 1, setTransform() {}, fillRect(this: { globalAlpha: number }) { if (this.globalAlpha === 0.55) frames[frames.length - 1].overlays++; else frames.push({ base: [], overlays: 0 }); },
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData(d: ImageData) { images.set(cv, new Uint32Array(d.data.buffer)[0]); },
        drawImage(img: HTMLCanvasElement) { frames[frames.length - 1].base.push(images.get(img)!); }, save() {}, restore(this: { globalAlpha: number }) { this.globalAlpha = 1; } } as never;
    });
    tiles((r) => (r === 1 ? 'old' : 'new'), (r) => r); noVox(); mount();
    await draw(<MapBox robot="r" p={live(1, 'old')} link={0} />);
    expect(frames.some((f) => f.base.includes(COL[1]) && f.overlays > 0)).toBe(true);
    frames.length = 0;
    await draw(<MapBox robot="r" p={live(2, 'new')} link={0} />);
    expect(frames.some((f) => f.base.includes(COL[1]) && f.overlays > 0)).toBe(false);
    expect(frames.some((f) => f.base.includes(COL[2]) && f.overlays > 0)).toBe(true);   // 새 판 조각이 오면 다시 겹침
  });

  it('GLIM 만 보다가 미리보기가 사라지면 Point-LIO 보기로 돌아간다(같은 기준·다른 기준 모두)', async () => {
    tiles(() => 'map', () => 1); noVox(); mount();
    for (const frame of ['map', 'glim_map']) {
      const p = live(1, 'map', { frame_id: frame, resolution: 0.25, cells: [[1, 0, 0]] });
      await draw(<MapBox key={frame} robot="r" p={p} link={0} />);
      if (frame === 'map') await act(async () => { box.querySelector<HTMLButtonElement>('[data-layer="point_lio"]')!.click(); });
      else await act(async () => { box.querySelector<HTMLButtonElement>('[data-layer="glim"]')!.click(); });
      expect(box.querySelector('canvas')!.dataset.slamTiles).toBe('0');
      await draw(<MapBox key={frame} robot="r" p={{ ...p, glim_preview: null }} link={0} />);
      expect(box.querySelector('canvas')!.dataset.slamTiles).toBe('1');
      expect(box.textContent).not.toContain('아직 받은 칸이 없습니다');
    }
  });

  // RV-521: 초록은 세 좌표 모두 유한수 · 점군 나이도 유한 ≥0 일 때만
  it('정상 상태는 0Hz 포함 «실시간 위치 정상»(초록)', () => {
    for (const pose_hz of [0, 10, 4096]) expect(html({ point_lio: { ...PL, pose_hz }, glim: GL })).toContain('실시간 위치 정상');
  });
  for (const position_m of [[1, 2], [1, 2, 'bad'], [1, 2, null], [1, 2, Number.NaN]]) {
    it(`위치 [${position_m.map(String).join(",")}] → 초록 아님, «기다리는 중»(노랑)`, () => {
      const h = html({ point_lio: { ...PL, position_m }, glim: GL });
      expect(h).not.toContain('실시간 위치 정상'); expect(h).toContain('data-src="point_lio" data-lamp="warn"');
    });
  }
  for (const cloud_age_s of [-3, Number.NaN]) {
    it(`점군 나이 ${cloud_age_s} → 초록 아님, «기다리는 중»(노랑)`, () => {
      const h = html({ point_lio: { ...PL, cloud_age_s }, glim: GL });
      expect(h).not.toContain('실시간 위치 정상'); expect(h).toContain('data-src="point_lio" data-lamp="warn"');
    });
  }
  it('같은 frame 정상 미리보기는 겹치고, 미리보기가 사라지면 Point-LIO 로 돌아간다', async () => {
    tiles(() => 'map', () => 1); noVox(); mount();
    const p = live(1, 'map');
    await draw(<MapBox robot="r" p={p} link={0} />);
    expect(box.querySelector('[data-glim-preview="over"]')).not.toBeNull();
    await act(async () => { box.querySelector<HTMLButtonElement>('[data-layer="point_lio"]')!.click(); });
    expect(box.querySelector('canvas')!.dataset.slamTiles).toBe('0');
    await draw(<MapBox robot="r" p={{ ...p, glim_preview: null }} link={0} />);
    expect(box.querySelector('canvas')!.dataset.slamTiles).toBe('1');
  });
  it('실제 조각 frame 이 진행 보고의 voxel frame 보다 우선', async () => {
    tiles(() => 'map', () => 1); noVox(); mount();
    await draw(<MapBox robot="r" p={live(1, 'voxel', { frame_id: 'map', resolution: 0.25, cells: [[1, 0, 0]] })} link={0} />);
    expect(box.querySelector('[data-glim-preview="over"]')).not.toBeNull();
  });
  it('조각이 없어도 진행 보고 frame 이 같으면 GLIM 미리보기를 겹친다', async () => {
    vi.spyOn(api, 'slamTiles').mockImplementation(async (_r, sid, revision) => ({ session_id: sid, revision, update_seq: 1, next_cursor: null, tiles: [] }) as never);
    noVox(); mount();
    await draw(<MapBox robot="r" p={live(1, 'map')} link={0} />);
    expect(box.querySelector('[data-glim-preview="over"]')).not.toBeNull();
    expect(box.querySelector('canvas')).not.toBeNull();
  });
});

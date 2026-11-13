// RB-SLAM-WEB 지도 탭 «지도 만들기»(apps/server/MAPPING.md) — 가짜 서버 응답으로: 담당 아님 숨김, 연결 안 됨 막힘, 1초 조회, 저장 성공 뒤 새 판 선택,
// FAILED 다시 저장·STALE, 창 닫으면 조회 멈춤, 다른 층 세션 안내. 화면 글에 «SLAM» 없음.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MappingProgress, MapVersion, RobotSummary, SiteTree, User } from '../../../contracts/ts';
import { Root } from '../session';
import { clearPlans } from '../screens/missions';
import { kept } from '../screens/mapedit';
import { STALE_TEXT } from '../screens/mapmake';
import { FakeWS, state } from './fakeWs';

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
const PREVIEW = { resolution: 0.1, cells: [[0, 0], [1, 0], [2, 0], [0, 5], [10, 5]] as [number, number][], robot: [0.5, 0.2, 0.3] as [number, number, number], path: [[0, 0], [0.5, 0.2]] as [number, number][] };
const prog = (status: MappingProgress['status'], p: Partial<MappingProgress> = {}): MappingProgress => ({ session_id: SID, floor_id: 'f1', status, distance_m: 12.34, point_count: 4567, elapsed_s: 75, preview: PREVIEW, ...p });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Route = Reply | ((body?: unknown) => Reply);
type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [];
function serve(routes: Record<string, Route>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '').split('?')[0], body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const hit = routes[`${method} ${path}`], rep = typeof hit === 'function' ? hit(body) : hit ?? err(404, 'NOT_FOUND', '없음');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body ?? null), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
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
  'GET /robots/r-a/slam': () => ({ status: 200, body: slam() }),
  ...more,
});

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
beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
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
    expect(btn('시작', dlg())!.disabled).toBe(true);
    expect(posts()).toEqual([]);
  });
});

describe('지도 만들기 — 진행', () => {
  it('시작 = POST start {floor_id}, 뒤로 1초마다 조회 + 위에서 본 그림·거리·점 수·시간, 화면 글에 SLAM 없음', async () => {
    let now: MappingProgress | null = null;
    serve(signedIn(LEE, true, () => now, { 'POST /robots/r-a/slam/start': () => { now = prog('RUNNING'); return { status: 202, body: now }; } }));
    await open(); await live(true); await openMake();
    expect(gets().length).toBe(1);   // 열 때 한 번(진행 중 세션이 있으면 이어서)
    await click(btn('시작', dlg()));
    expect(posts().map((c) => [c.path, c.body])).toEqual([['/robots/r-a/slam/start', { floor_id: 'f1' }]]);
    expect($('canvas[data-preview]')!.dataset.preview).toBe('5');
    expect($('[data-progress]')!.textContent).toContain('12.3 m');
    expect($('[data-progress]')!.textContent).toContain('4,567');
    expect($('[data-progress]')!.textContent).toContain('1분 15초');
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
    expect(btn('시작', dlg())).toBeTruthy();
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
    now = prog('SAVED', { map_version_id: 'v3' }); s.saved = true;
    await click($('[data-floor="f2"]'));
    await openMake();
    expect(btn('시작', dlg())).toBeTruthy();   // 2층에서는 1층 저장을 알리지 않는다
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
    serve(savedServer(() => now, () => { now = prog('SAVED', { map_version_id: 'v3' }); s.saved = true; throw new TypeError('network'); }, s));
    await open(); await openMake();
    await click(btn('지도 저장', dlg())); await flush();
    madeV3();
  });

  it('지난 SAVED(그 뒤 지도가 바뀌어 v3 가 지난 저장)는 다시 알리지 않는다', async () => {
    const prog = mine('44444444-4444-4444-8444-444444444444');
    serve(signedIn(LEE, true, () => prog('SAVED', { map_version_id: 'v3' }), {
      'GET /sites': { status: 200, body: tree('v4') },
      'GET /map-versions/v4': { status: 200, body: ver('v4', 4) },
      'GET /floors/f1/map-versions': { status: 200, body: { items: [ver('v4', 4), { ...V3, status: 'SUPERSEDED' }], next_cursor: null } },
    }));
    await open(); await openMake(); await flush();
    expect(box.textContent).not.toContain('로봇으로 만든 지도와 시뮬 지형을 만들었습니다.');
    expect(btn('시작', dlg())).toBeTruthy();
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
    expect(btn('시작', dlg())).toBeUndefined();
  });
});

describe('지도 만들기 — 창 안에서 조종(11-13 RB-MAP-VIEW-WEB)', () => {
  it('그리는 중 + 서버가 이 PC 조종을 허용한 내 로봇: 실시간 지도 아래 같은 조종 패널(STOP·조종 시작), 저장 중이 되면 사라진다 · 개발 용어 없음', async () => {
    allowed = true;
    let now: MappingProgress | null = null;
    serve(signedIn(LEE, true, () => now, { 'POST /robots/r-a/slam/start': () => { now = prog('RUNNING'); return { status: 202, body: now }; },
      'POST /robots/r-a/slam/save': () => { now = prog('SAVING'); return { status: 202, body: now }; } }));
    await open(); await live(true); await openMake();
    expect(dlg().textContent).toContain('시작한 뒤 이 창의 조종 단추나 키보드로 로봇을 움직이고');
    expect($('[data-make-drive]')).toBeNull();   // 시작 전에는 조종 없음
    await click(btn('시작', dlg()));
    const d = $('[data-make-drive] [data-server-drive]')!;
    expect($('canvas[data-preview]')!.dataset.preview).toBe('5');
    expect(d.querySelector('[data-sd-stop="panel"]')).toBeTruthy();
    expect(btn('조종 시작', d)).toBeTruthy();
    expect(dlg().textContent).toContain('그리는 중 — 이 창의 조종 단추나 키보드로 로봇을 천천히 움직이세요.');
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

// 폰 지도 스캔 입구(u2_3 · u14_2): 붙이기 끝 화면 «이 현장 지도 스캔하기», 폰 로봇 연결 화면 ⋯ «지도 스캔». 둘 다 PhoneScan(screens/phonescan.tsx)을 연다.
// 권한은 PhoneScan 과 같은 makers()(운영자 · 자기 담당 실기). 권한이 없으면 단추 대신 까닭 한 줄. 조종 중(#/drive/<id>) ⋯ 에는 두지 않는다.
// fetch 는 가짜 서버(/api/v1 만), WebSocket 은 FakeWS · 8810 · 실기 없음.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RobotSummary, User } from '../../../contracts/ts';
import { Root } from '../session';
import { SCAN_NO } from '../screens/scanentry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR' };
const PARK: User = { ...KIM, id: 'o2', username: 'park', display_name: '박운영', role: 'OPERATOR' };
const robot = (id: string, name: string, owner: User | null, p: Partial<RobotSummary> = {}): RobotSummary => ({ id, name, model: 'unitree_go2',
  simulation: false, server_drive_allowed: false, owner: owner && { id: owner.id, display_name: owner.display_name }, connection: 'OFFLINE', status: null,
  battery: null, location: null, lease: null, current_run: null, devices: [], attention: [], ...p });
const RA = robot('r-a', 'Go2-A', LEE, { robot_serial: '1234-56785678' });
const RB = robot('r-b', 'Go2-B', LEE);
const TREE = { items: [
  { id: 's1', name: '인공지능사관학교', purpose: 'REAL', buildings: [{ id: 'b1', site_id: 's1', name: '본관', floors: [{ id: 'f1', building_id: 'b1', name: '1층', approved_version_id: null }] }] },
  { id: 's2', name: '시뮬 마을', purpose: 'SIM', buildings: [{ id: 'b2', site_id: 's2', name: '가상동', floors: [{ id: 'f9', building_id: 'b2', name: '9층', approved_version_id: null }] }] },
] };
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [], routes: Record<string, Reply> = {};
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (!url.startsWith('/api/v1/')) throw new Error(`밖으로 나가는 요청: ${url}`);
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const rep = routes[`${method} ${path.split('?')[0]}`] ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, robots: RobotSummary[], more: typeof routes = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: robots, next_cursor: null } },
  'GET /users': { status: 200, body: { items: [KIM, LEE, PARK], next_cursor: null } },
  'GET /dashboard': { status: 200, body: { robots_total: robots.length, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } },
  'GET /sites': { status: 200, body: TREE },
  ...Object.fromEntries(robots.map((r) => [`GET /robots/${r.id}`, { status: 200, body: r }])),
  ...Object.fromEntries(robots.map((r) => [`GET /robots/${r.id}/slam`, { status: 200, body: null }])),
  ...more,
});

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string) {
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const setVal = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const submit = async (form: Element) => { act(() => { (form as HTMLFormElement).requestSubmit(); }); await flush(); };
const slamGets = (id: string) => calls.filter((c) => c.method === 'GET' && c.path === `/robots/${id}/slam`);
const more = () => $('details.fh-more')!, pair = () => $('[aria-label="새 로봇 추가"]')!;
/** 폰 브라우저: «로봇 연결»(로봇 0대 = 시안 u13_4) → 6자리 → 이름 → 등록(confirm 답 = done) */
async function pairTo(done: RobotSummary) {
  await click($('[data-robot-connect]'));   // 로봇 0대 폰 = 시안 u13_4 «로봇 연결»
  setVal($<HTMLInputElement>('[data-pair-code]')!, '123456');
  await submit($('[data-pair-code]')!.closest('form')!);
  routes['POST /pairing/p1/confirm'] = { status: 200, body: done };
  await submit($('[aria-label="새 로봇 추가"] input[name="name"]')!.closest('form')!);
  expect($('[data-pair-done]')).toBeTruthy();
}
const claim = { 'POST /pairing/claim': { status: 200, body: { pairing_id: 'p1', robot_serial: '1234-56785678', expires_at: inMin(9) } }, 'GET /robots/r-a/slam': { status: 200, body: null } };

describe('붙이기 끝 화면 · 이 현장 지도 스캔하기 (u2_3)', () => {
  it('내가 담당이 된 실기 → 단추 → 그 로봇의 PhoneScan(실기 현장 층만)', async () => {
    serve(signedIn(LEE, [], claim));
    await open('#/drive');
    await pairTo(RA);
    expect($('[data-scan-no]', pair())).toBeNull();
    expect(slamGets('r-a')).toHaveLength(0);   // 누르기 전에는 스캔 조회 없음
    await click(btn('이 현장 지도 스캔하기'));
    await flush();   // 층 목록 → PhoneScan 첫 조회
    const scan = $('[data-scan]')!;
    expect(scan).toBeTruthy();
    expect(slamGets('r-a').length).toBeGreaterThan(0);
    expect(btn('스캔 시작', scan)).toBeTruthy();
    expect(scan.textContent).toContain('본관');
    expect(scan.textContent).not.toContain('가상동');   // 시뮬 현장 층은 고르지 않음
    expect($('[data-pair-done]')).toBeNull();
    expect($('[aria-label="새 로봇 추가"]')).toBeNull();   // 카드 안 카드 없이 스캔 칸으로 바뀜
    await click($('[data-scan-close]'));
    expect($('[data-scan]')).toBeNull();
    expect($('[data-u13="no-robot"]')).toBeTruthy();   // 로봇 연결 화면으로 돌아옴(이 시험의 서버 목록은 아직 0대라 시안 u13_4)
  });

  it('담당이 내가 아니게 돌아오면 단추 대신 까닭 한 줄', async () => {
    serve(signedIn(LEE, [], claim));
    await open('#/drive');
    await pairTo(robot('r-a', 'Go2-A', PARK));
    expect(btn('이 현장 지도 스캔하기')).toBeUndefined();
    expect($('[data-scan-no]', pair())!.textContent).toBe(SCAN_NO);
    expect(slamGets('r-a')).toHaveLength(0);
  });

  it('시뮬로 돌아오면 단추 대신 까닭 한 줄', async () => {
    serve(signedIn(LEE, [], claim));
    await open('#/drive');
    await pairTo(robot('r-a', 'Go2-A', LEE, { simulation: true }));
    expect(btn('이 현장 지도 스캔하기')).toBeUndefined();
    expect($('[data-scan-no]', pair())!.textContent).toBe(SCAN_NO);
  });
});

describe('폰 로봇 연결 화면 ⋯ · 지도 스캔 (u14_2 입구)', () => {
  it('담당 실기가 있으면 ⋯ «지도 스캔» → PhoneScan, 닫기로 로봇 연결', async () => {
    serve(signedIn(LEE, [RA]));
    await open('#/drive');
    expect($('[data-scan]')).toBeNull();
    await click(btn('지도 스캔', more()));
    expect(more().hasAttribute('open')).toBe(false);   // 메뉴는 닫힘
    expect($('[data-scan]')).toBeTruthy();
    expect(slamGets('r-a').length).toBeGreaterThan(0);
    expect($('[aria-label="내 로봇"]')).toBeNull();
    await click($('[data-scan-close]'));
    expect($('[data-scan]')).toBeNull();
    expect($('[aria-label="내 로봇"]')).toBeTruthy();
  });

  it('담당 실기가 둘이면 고르기 → 고른 로봇으로 조회', async () => {
    serve(signedIn(LEE, [RA, RB]));
    await open('#/drive');
    await click(btn('지도 스캔', more()));
    const sel = $<HTMLSelectElement>('[data-scan-robot]')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Go2-A', 'Go2-B']);
    expect(slamGets('r-b')).toHaveLength(0);
    act(() => { sel.value = 'r-b'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(slamGets('r-b').length).toBeGreaterThan(0);
  });

  it('담당 실기가 없으면(총괄 · 남의 로봇) ⋯ 에 단추 대신 까닭 한 줄', async () => {
    for (const [me, list] of [[KIM, [RA]], [PARK, [RA]]] as const) {
      serve(signedIn(me, [...list]));
      await open('#/drive');
      expect(btn('지도 스캔', more())).toBeUndefined();
      expect($('[data-scan-no]', more())!.textContent).toBe(SCAN_NO);
      act(() => root?.unmount()); root = null; box.remove();
    }
  });

  it('조종 중(#/drive/<id>) ⋯ 에는 지도 스캔이 없다', async () => {
    serve(signedIn(LEE, [RA]));
    await open('#/drive/r-a');
    expect(more()).toBeTruthy();
    expect(btn('지도 스캔', more())).toBeUndefined();
    expect($('[data-scan-no]', more())).toBeNull();
  });

  it('기록으로 가면 스캔 화면은 내려간다', async () => {
    serve(signedIn(LEE, [RA]));
    await open('#/drive');
    await click(btn('지도 스캔', more()));
    await click(btn('기록', more()));
    expect($('[data-scan]')).toBeNull();
  });
});

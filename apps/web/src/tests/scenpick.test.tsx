// RB-MAP-NO-SCEN 11-18: 배정 화면을 없애고 «실기 조종할 때 시나리오를 고른다». 폰 조종 화면 시나리오 시트 = 이 로봇이 있는 층의 실기 시나리오(층 모르면 실기 장소 전체 + 안내),
// 실행은 실기 실행기 전이라 «준비 중» 비활성. 로봇 상세 «배정» 단추·지도 탭 시나리오 창은 없고, 어디서도 /assignments 를 부르지 않는다. STOP 은 그대로.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RobotSummary, Scenario, User } from '../../../contracts/ts';
import { Root } from '../session';
import { clearPlans } from '../screens/missions';
import { FakeWS } from './fakeWs';
import { fleetRow } from './fleetRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEE: User = { id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', locked: false, password_must_change: false, robot_ids: ['r-a'], created_at: '2026-10-19T00:00:00Z' };
const at = (floor_id: string | null) => ({ floor_id, map_version_id: null, x: 1, y: 2, yaw: 0, confidence: 1, updated_at: '2026-11-18T00:00:00Z' });
let RA: RobotSummary;
const robotA = (loc: RobotSummary['location']): RobotSummary => ({ id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name }, simulation: false, server_drive_allowed: false,
  connection: 'OFFLINE', status: null, battery: null, location: loc, lease: null, current_run: null, devices: [], attention: [] });
const scen = (id: string, name: string, floor_ids: string[], p: Partial<Scenario> = {}): Scenario => ({ id, name, waypoints: [], finish: { mode: 'STAY', target: null }, notes: '', number: 1, latest_version: 1, version: 1,
  floor_ids, map_version_ids: [], required_devices: [], est_distance_m: 0, created_by: LEE.id, created_at: '2026-10-20T00:00:00Z', version_created_by: LEE.id, version_created_at: '2026-10-20T00:00:00Z', archived_at: null, ...p });
const SCENS = [scen('s1', '1층 순찰', ['f1']), scen('s2', '2층 점검', ['f2']), scen('s3', '시뮬 순찰', ['g1']), scen('s4', '지운 순찰', ['f1'], { archived_at: '2026-11-01T00:00:00Z' })];
const fl = (id: string, building_id: string, name: string, level: number) => ({ id, building_id, name, level, approved_version_id: null, pending_count: 0 });
const SITES = [{ id: 'st1', name: '본관', purpose: 'REAL', buildings: [{ id: 'b1', site_id: 'st1', name: '본동', floors: [fl('f1', 'b1', '1층', 1), fl('f2', 'b1', '2층', 2)] }] },
  { id: 'st2', name: '시뮬 공장', purpose: 'SIM', buildings: [{ id: 'b2', site_id: 'st2', name: '공장', floors: [fl('g1', 'b2', '1층', 1)] }] }];

let calls: string[] = [];
function serve() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    calls.push(`${init.method ?? 'GET'} ${path}`);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/auth/session') return ok({ client: 'web', csrf_token: 'csrf-1' });
    if (path === '/me') return ok(LEE);
    if (path === '/robots') return ok({ items: [RA], next_cursor: null });
    if (path.startsWith('/robots/')) return ok(RA);
    if (path === '/dashboard') return ok({ robots_total: 1, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] });
    if (path === '/notifications') return ok({ items: [], next_cursor: null, unread_count: 0 });
    if (path === '/events') return ok({ items: [], next_cursor: null });
    if (path === '/sites') return ok({ items: SITES, next_cursor: null });
    if (path === '/scenarios') return ok({ items: SCENS.filter((s) => q.get('archived') === 'true' || !s.archived_at), next_cursor: null });
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
}

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string, phone = false) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); clearPlans(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const sheet = async () => {
  await click([...$('[aria-label="조종 메뉴"]')!.querySelectorAll('button')].find((b) => b.textContent === '시나리오'));
  return $('[data-sheet]')!;
};
const names = (s: Element) => [...s.querySelectorAll('[data-scen-pick] b')].map((b) => b.textContent);
const runBtn = (s: Element) => [...s.querySelectorAll('button')].find((b) => b.textContent === '▶ 실행(준비 중)')!;

describe('폰 조종 시나리오 시트 — 조종할 때 고르기', () => {
  it('로봇이 있는 층(1층)의 실기 시나리오만(다른 층·시뮬 장소·휴지통 제외), 고르면 눌림 표시, 실행은 «준비 중» 비활성, STOP 그대로', async () => {
    RA = robotA(at('f1'));
    serve();
    await open('#/drive/r-a', true);
    const s = await sheet();
    expect(s.textContent).toContain('본관 › 본동 › 1층의 시나리오입니다.');
    expect(names(s)).toEqual(['1층 순찰']);
    expect(runBtn(s).disabled).toBe(true);
    await click($('[data-scen-pick="s1"]', s));
    expect($('[data-scen-pick="s1"]', s)!.getAttribute('aria-pressed')).toBe('true');
    expect(runBtn(s).disabled).toBe(true);
    expect(runBtn(s).getAttribute('aria-label')).toBe('1층 순찰 실행(준비 중)');
    expect(s.textContent).toContain('실기 시나리오 실행은 준비 중입니다');
    expect(calls.some((c) => c.includes('/assignments'))).toBe(false);
    act(() => FakeWS.last.open());
    await click($('[data-stop]'));
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['r-a']);
  });

  it('층을 모름: 실기 장소 시나리오 전체(층 이름 함께) + 안내 한 줄, 시뮬 장소 시나리오는 없음', async () => {
    RA = robotA(null);
    serve();
    await open('#/drive/r-a', true);
    const s = await sheet();
    expect(s.textContent).toContain('로봇이 있는 층을 아직 모릅니다');
    expect(names(s)).toEqual(['1층 순찰', '2층 점검']);
    expect($('[data-scen-pick="s2"]', s)!.textContent).toContain('본동 2층');
  });

  it('그 층에 시나리오가 없음 = 없다는 안내 + 시뮬 탭에서 만든다는 말', async () => {
    RA = robotA(at('f2'));
    SCENS.splice(1, 1);
    try {
      serve();
      await open('#/drive/r-a', true);
      const s = await sheet();
      expect(names(s)).toEqual([]);
      expect(s.textContent).toContain('이 층에는 시나리오가 없습니다. 시나리오는 PC «시뮬» 탭에서 만듭니다.');
    } finally { SCENS.splice(1, 0, scen('s2', '2층 점검', ['f2'])); }
  });
});

describe('배정 화면 없음', () => {
  it('로봇 탭 상세에 «배정» 단추가 없고 /assignments 를 부르지 않는다', async () => {
    RA = robotA(at('f1'));
    serve();
    await open('#/fleet');
    await click(fleetRow(box, 'Go2-A'));
    expect($('[data-assign-robot]')).toBeNull();
    expect([...box.querySelectorAll('button')].some((b) => b.textContent === '배정')).toBe(false);
    expect(calls.some((c) => c.includes('/assignments'))).toBe(false);
  });

  it('지도 탭: 지도 고르기 카드에 시나리오 수 없음, 층 화면 오른쪽 창은 «지도 요소»만(시나리오 탭·목록·시뮬 탭 단추 없음), 시나리오를 받지 않는다', async () => {
    RA = robotA(at('f1'));
    serve();
    await open('#/map');
    expect($('[data-building]')!.textContent).not.toContain('시나리오');
    await click($('[data-building]'));
    expect($('[data-side="map"]')!.textContent).toBe('지도 요소 0');
    expect($('[data-side="scen"]')).toBeNull();
    expect($('[data-plan]')).toBeNull();
    expect($('[data-to-sim]')).toBeNull();
    expect($('[data-to-scen]')).toBeNull();
    expect(box.textContent).not.toContain('시나리오 없음');
    expect(calls.filter((c) => c.endsWith('/scenarios'))).toEqual([]);
    expect(calls.some((c) => c.includes('/assignments'))).toBe(false);
  });
});
